// PIVOT, synchronisation d'un abonnement Stripe vers Supabase (ajoute le 02/11/2026).
//
// Utilise par verify.js (retour de paiement), stripe-webhook.js (renouvellements, resiliations).
// Principe : on ne se fie jamais au contenu recu. On relit toujours l'abonnement chez Stripe, puis on
// ecrit son etat. L'operation donne le meme resultat si elle est rejouee ou si les evenements arrivent
// dans le desordre, donc un renouvellement ne peut pas crediter deux fois.
//
// Le compte Stripe sert aussi a Repere : seuls les trois produits ci-dessous concernent PIVOT, tout
// autre abonnement est ignore.
//
// Variables d'environnement Netlify (deja configurees) : STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE.

const PRODUCTS = {
  prod_UtLFfeyUtaAJ9H: 'semaine',
  prod_UtLWVSh44pleMx: 'mois',
  prod_UtLXWXwKxmj7pY: 'annee'
};

// Stripe finalise la facture de renouvellement dans l'heure qui suit la fin de periode : un jour de marge
// evite de couper l'acces d'un abonne dont le prelevement est simplement en cours.
const GRACE_MS = 86400000;
const ACTIVE = ['active', 'trialing'];

async function stripeGet(path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body };
}

function svcHeaders(extra) {
  return Object.assign({
    'apikey': process.env.SUPABASE_SERVICE_ROLE,
    'authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE,
    'content-type': 'application/json'
  }, extra || {});
}

function db(path) { return process.env.SUPABASE_URL + '/rest/v1/' + path; }

async function dbRows(path) {
  const r = await fetch(db(path), { headers: svcHeaders() });
  if (!r.ok) throw new Error('lecture Supabase impossible');
  return r.json();
}

function periodEndOf(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  // Selon la version de l'API Stripe, la fin de periode est sur la ligne ou sur l'abonnement.
  const s = (item && item.current_period_end) || sub.current_period_end;
  return s ? s * 1000 : 0;
}

function planOf(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const product = item && item.price && item.price.product;
  const id = product && product.id ? product.id : product;
  return PRODUCTS[id] || null;
}

async function resolveUserId(subId, hint) {
  if (hint) return hint;
  const rows = await dbRows('stripe_subscriptions?subscription_id=eq.' + encodeURIComponent(subId) + '&select=user_id');
  if (rows[0] && rows[0].user_id) return rows[0].user_id;
  const s = await stripeGet('checkout/sessions?limit=1&subscription=' + encodeURIComponent(subId));
  const session = s.ok && s.body && s.body.data && s.body.data[0];
  return (session && session.client_reference_id) || null;
}

// Renvoie { ok, ignored?, plan?, until?, status?, error? }.
async function syncSubscription(subId, hintUserId) {
  const got = await stripeGet('subscriptions/' + encodeURIComponent(subId));
  if (!got.ok || !got.body) return { ok: false, error: 'abonnement introuvable', status: got.status };
  const sub = got.body;

  const plan = planOf(sub);
  if (!plan) return { ok: true, ignored: true };

  const userId = await resolveUserId(subId, hintUserId);
  if (!userId) return { ok: false, error: 'compte non identifie' };

  const periodEnd = periodEndOf(sub);
  const isActive = ACTIVE.indexOf(sub.status) >= 0;
  const customer = sub.customer && sub.customer.id ? sub.customer.id : sub.customer;

  const up = await fetch(db('stripe_subscriptions'), {
    method: 'POST',
    headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([{
      subscription_id: subId,
      user_id: userId,
      customer_id: customer,
      plan,
      status: sub.status,
      current_period_end: periodEnd ? new Date(periodEnd).toISOString() : null,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      updated_at: new Date().toISOString()
    }])
  });
  // Echec sur un abonnement termine : le compte vient d'etre supprime, il n'y a plus rien a tenir a jour.
  if (!up.ok) return isActive ? { ok: false, error: 'ecriture Supabase impossible' } : { ok: true, ignored: true };

  const uid = encodeURIComponent(userId);
  const rows = await dbRows('coach_data?user_id=eq.' + uid + '&select=sub_until');
  const current = rows[0] && rows[0].sub_until ? new Date(rows[0].sub_until).getTime() : 0;
  const paidUntil = periodEnd + GRACE_MS;

  if (isActive) {
    // On garde la date la plus lointaine : un essai ou un code d'acces plus long n'est jamais raccourci.
    const until = Math.max(current, paidUntil);
    const w = await fetch(db('coach_data'), {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ user_id: userId, sub_until: new Date(until).toISOString(), sub_plan: plan }])
    });
    if (!w.ok) return { ok: false, error: 'ecriture Supabase impossible' };
    return { ok: true, plan, until, status: sub.status };
  }

  if (sub.status === 'canceled') {
    // L'acces s'arrete a la date de fin, sauf s'il vient d'autre chose que cet abonnement
    // (code d'acces plus long) ou si le coach a un autre abonnement encore actif.
    const endedAt = (sub.ended_at || sub.canceled_at || 0) * 1000 || Date.now();
    const others = await dbRows('stripe_subscriptions?user_id=eq.' + uid +
      '&status=in.(active,trialing)&subscription_id=neq.' + encodeURIComponent(subId) + '&select=subscription_id');
    if (!others.length && current > endedAt && current <= paidUntil) {
      await fetch(db('coach_data?user_id=eq.' + uid), {
        method: 'PATCH',
        headers: svcHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ sub_until: new Date(endedAt).toISOString() })
      });
    }
  }
  // past_due, unpaid, incomplete : on ne prolonge pas. L'acces se ferme seul a l'echeance, et rouvre
  // si Stripe reussit le prelevement lors d'une nouvelle tentative (invoice.paid).
  return { ok: true, plan, status: sub.status };
}

module.exports = { syncSubscription, stripeGet };
