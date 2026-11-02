// PIVOT, ouverture de l'espace Stripe du coach : resiliation, changement de carte, factures (ajoute le 02/11/2026).
//
// Securite : la fonction n'agit que pour le compte proprietaire du jeton de session (verifie aupres de
// Supabase). Aucun identifiant n'est accepte depuis le corps de la requete.
//
// Le portail client doit etre active une fois dans Stripe (Parametres, Billing, Portail client).

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': 'https://pivotcoach.netlify.app',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method' }) };

  const base = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE;
  if (!base || !svc || !process.env.STRIPE_SECRET_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'serveur non configure' }) };
  }

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'connexion requise' }) };

  try {
    const who = await fetch(base + '/auth/v1/user', { headers: { 'apikey': svc, 'authorization': 'Bearer ' + token } });
    if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'session invalide' }) };
    const user = await who.json();
    if (!user || !user.id) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'session invalide' }) };

    const rows = await fetch(base + '/rest/v1/stripe_subscriptions?user_id=eq.' + encodeURIComponent(user.id) +
      '&select=customer_id&order=updated_at.desc&limit=1', { headers: { 'apikey': svc, 'authorization': 'Bearer ' + svc } });
    const list = rows.ok ? await rows.json() : [];
    const customer = list[0] && list[0].customer_id;
    if (!customer) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'aucun abonnement trouve' }) };

    const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ customer, return_url: 'https://pivotcoach.netlify.app/' }).toString()
    });
    const session = await r.json().catch(() => null);
    if (!r.ok || !session || !session.url) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'espace abonnement indisponible' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, url: session.url }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'serveur' }) };
  }
};
