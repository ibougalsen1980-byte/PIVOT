// PIVOT, reception des evenements Stripe (ajoute le 02/11/2026).
//
// C'est cette fonction qui prolonge l'acces a chaque renouvellement automatique, et qui le ferme apres
// une resiliation, y compris quand le coach n'ouvre pas l'application.
//
// Securite : le contenu recu n'est jamais pris pour vrai. Seul l'identifiant de l'evenement sert : on
// relit l'evenement chez Stripe avec la cle secrete, puis l'abonnement lui-meme (voir lib/stripe-sub.js).
// Un faux appel ne peut donc rien provoquer d'autre qu'une relecture de l'etat reel.
//
// Evenements a activer sur la destination Stripe : checkout.session.completed, invoice.paid,
// customer.subscription.updated, customer.subscription.deleted.

const { syncSubscription, stripeGet } = require('../lib/stripe-sub');

function subscriptionIdOf(event) {
  const o = event.data && event.data.object;
  if (!o) return null;
  if (event.type.indexOf('customer.subscription.') === 0) return o.id;
  if (event.type === 'checkout.session.completed') return o.mode === 'subscription' ? o.subscription : null;
  if (event.type === 'invoice.paid') {
    // Selon la version de l'API Stripe, le lien vers l'abonnement n'est pas au meme endroit.
    return o.subscription ||
      (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) ||
      null;
  }
  return null;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{"ok":false}' };

  if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
    return { statusCode: 500, headers, body: '{"ok":false,"error":"serveur non configure"}' };
  }

  let eventId = null;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    eventId = JSON.parse(raw || '{}').id;
  } catch (e) {}
  if (!/^evt_[A-Za-z0-9]+$/.test(String(eventId || ''))) {
    return { statusCode: 400, headers, body: '{"ok":false,"error":"evenement invalide"}' };
  }

  try {
    const got = await stripeGet('events/' + eventId);
    // Evenement inconnu de Stripe : faux appel, ou evenement du mode test. Rien a faire.
    if (got.status === 404) return { statusCode: 200, headers, body: '{"ok":true,"ignored":true}' };
    if (!got.ok || !got.body) return { statusCode: 500, headers, body: '{"ok":false,"error":"lecture Stripe"}' };

    const subId = subscriptionIdOf(got.body);
    if (!subId) return { statusCode: 200, headers, body: '{"ok":true,"ignored":true}' };

    const hint = got.body.type === 'checkout.session.completed'
      ? got.body.data.object.client_reference_id
      : null;
    const res = await syncSubscription(subId, hint);
    if (!res.ok && res.error === 'compte non identifie') {
      // Reessayer ne changera rien : on le laisse visible dans les journaux Netlify et Stripe.
      console.error('PIVOT webhook : abonnement sans compte', subId);
      return { statusCode: 200, headers, body: JSON.stringify(res) };
    }
    // Une autre erreur renvoie 500 : Stripe represente l'evenement plus tard.
    return { statusCode: res.ok ? 200 : 500, headers, body: JSON.stringify(res) };
  } catch (e) {
    return { statusCode: 500, headers, body: '{"ok":false,"error":"serveur"}' };
  }
};
