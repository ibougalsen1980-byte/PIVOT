// PIVOT, verification serveur d'un abonnement Google Play et ecriture de l'acces dans Supabase.
// Ajoutee le 2026-10-07 avec l'activation de Google Play Billing dans l'application Android (TWA).
//
// Fonctionnement :
//   1. L'application Android achete un abonnement via la Digital Goods API, Google lui remet un purchaseToken.
//   2. L'application envoie ce jeton ici, avec le jeton de connexion Supabase du coach.
//   3. Cette fonction interroge directement l'API Google Play Developer (jamais de confiance au navigateur),
//      verifie que l'abonnement est actif, l'acquitte aupres de Google (sans acquittement sous 3 jours,
//      Google rembourse automatiquement l'achat), puis ecrit la date de fin dans coach_data.sub_until.
//   4. Un jeton Google Play se lie au premier compte PIVOT qui le presente (table play_purchases).
//      Un meme abonnement ne peut pas ouvrir l'acces a plusieurs comptes.
//
// Renouvellements : a chaque ouverture de l'app Android, listPurchases() renvoie les abonnements en cours
// et l'app repasse ici. La date de fin suit donc le renouvellement automatique.
//
// Variables d'environnement Netlify necessaires :
//   GOOGLE_PLAY_SA_JSON     contenu complet du fichier JSON du compte de service Google Cloud
//                           (a coller tel quel, ou encode en base64)
//   PLAY_PACKAGE_NAME       facultatif, par defaut app.netlify.pivotcoach.twa
//   SUPABASE_URL            deja configuree
//   SUPABASE_SERVICE_ROLE   deja configuree

const crypto = require('crypto');

const DEFAULT_PACKAGE = 'app.netlify.pivotcoach.twa';
// Identifiants des abonnements a creer a l'identique dans la Play Console (Monetiser, Abonnements).
const PRODUCTS = {
  pivot_semaine: 'semaine',
  pivot_mois: 'mois',
  pivot_annee: 'annee'
};
// Un abonnement resilie reste valable jusqu'a sa date de fin : on regarde la date, pas seulement l'etat.
const OK_STATES = [
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED'
];

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

function svcHeaders(extra) {
  return Object.assign({
    'apikey': process.env.SUPABASE_SERVICE_ROLE,
    'authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE,
    'content-type': 'application/json'
  }, extra || {});
}

async function rateLimited(id) {
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/pivot_check_rate_limit', {
      method: 'POST',
      headers: svcHeaders(),
      body: JSON.stringify({ p_client_id: id, p_window_seconds: RATE_LIMIT_WINDOW_SECONDS, p_max: RATE_LIMIT_MAX })
    });
    if (!r.ok) return false;
    return (await r.json()) === false;
  } catch (e) {
    return false;
  }
}

function loadServiceAccount() {
  const raw = (process.env.GOOGLE_PLAY_SA_JSON || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Jeton d'acces OAuth du compte de service, signe localement (RS256), sans dependance externe.
let _cachedToken = null;
async function googleAccessToken(sa) {
  if (_cachedToken && _cachedToken.exp > Date.now() + 60000) return _cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claims);
  const signature = signer.sign(sa.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + header + '.' + claims + '.' + signature
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('jeton Google refuse');
  _cachedToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return d.access_token;
}

function reply(statusCode, headers, obj) {
  return { statusCode, headers, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return reply(200, headers, {});
  if (event.httpMethod !== 'POST') return reply(405, headers, { ok: false, error: 'method' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
    return reply(500, headers, { ok: false, error: 'Supabase non configure cote serveur' });
  }
  const sa = loadServiceAccount();
  if (!sa || !sa.client_email || !sa.private_key) {
    return reply(500, headers, { ok: false, error: 'Google Play non configure cote serveur' });
  }
  const pkg = process.env.PLAY_PACKAGE_NAME || DEFAULT_PACKAGE;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const purchaseToken = String(body.purchaseToken || '').trim();
  const productId = String(body.productId || '').trim();
  if (!purchaseToken || purchaseToken.length > 2000) return reply(400, headers, { ok: false, error: 'jeton d\'achat manquant' });
  if (!PRODUCTS[productId]) return reply(400, headers, { ok: false, error: 'produit inconnu' });

  // Identite du coach : uniquement depuis son jeton de connexion Supabase.
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return reply(401, headers, { ok: false, error: 'connexion requise' });

  try {
    const who = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE, 'authorization': 'Bearer ' + token }
    });
    if (!who.ok) return reply(401, headers, { ok: false, error: 'session invalide, reconnecte-toi' });
    const user = await who.json();
    const userId = user && user.id;
    if (!userId) return reply(401, headers, { ok: false, error: 'session invalide, reconnecte-toi' });

    if (await rateLimited('play:' + userId)) {
      return reply(429, headers, { ok: false, error: 'trop de tentatives, reessaie dans quelques minutes' });
    }

    // 1. Lecture de l'abonnement chez Google.
    const accessToken = await googleAccessToken(sa);
    const gUrl = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
      encodeURIComponent(pkg) + '/purchases/subscriptionsv2/tokens/' + encodeURIComponent(purchaseToken);
    const gr = await fetch(gUrl, { headers: { 'authorization': 'Bearer ' + accessToken } });
    if (!gr.ok) return reply(200, headers, { ok: false, error: 'abonnement introuvable chez Google Play' });
    const sub = await gr.json();

    const items = (sub.lineItems || []).filter(li => PRODUCTS[li.productId]);
    if (!items.length) return reply(200, headers, { ok: false, error: 'produit non reconnu' });
    const expiry = Math.max.apply(null, items.map(li => new Date(li.expiryTime || 0).getTime()));
    const plan = PRODUCTS[items[0].productId];
    if (OK_STATES.indexOf(sub.subscriptionState) < 0 || !(expiry > Date.now())) {
      return reply(200, headers, { ok: false, error: 'abonnement inactif ou expire' });
    }

    // 2. Lien jeton -> compte : le premier compte qui presente le jeton le garde.
    const ex = await fetch(process.env.SUPABASE_URL + '/rest/v1/play_purchases?purchase_token=eq.' +
      encodeURIComponent(purchaseToken) + '&select=user_id', { headers: svcHeaders() });
    const exRows = ex.ok ? await ex.json() : null;
    if (!exRows) return reply(500, headers, { ok: false, error: 'verification du lien de compte impossible' });
    if (exRows[0] && exRows[0].user_id !== userId) {
      return reply(200, headers, { ok: false, error: 'cet abonnement est deja lie a un autre compte PIVOT' });
    }
    const link = await fetch(process.env.SUPABASE_URL + '/rest/v1/play_purchases', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{
        purchase_token: purchaseToken,
        user_id: userId,
        product_id: items[0].productId,
        expiry: new Date(expiry).toISOString(),
        state: sub.subscriptionState,
        updated_at: new Date().toISOString()
      }])
    });
    if (!link.ok) return reply(500, headers, { ok: false, error: 'enregistrement de l\'achat impossible' });

    // 3. Acquittement aupres de Google (obligatoire sous 3 jours, sinon remboursement automatique).
    if (sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      const ackUrl = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
        encodeURIComponent(pkg) + '/purchases/subscriptions/' + encodeURIComponent(items[0].productId) +
        '/tokens/' + encodeURIComponent(purchaseToken) + ':acknowledge';
      const ack = await fetch(ackUrl, {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + accessToken, 'content-type': 'application/json' },
        body: JSON.stringify({ developerPayload: 'pivot:' + userId })
      });
      if (!ack.ok) return reply(200, headers, { ok: false, error: 'acquittement Google impossible, reessaie' });
    }

    // 4. Ecriture de l'acces. On garde la date la plus lointaine (un pass Stripe en cours n'est pas raccourci).
    const cur = await fetch(process.env.SUPABASE_URL + '/rest/v1/coach_data?user_id=eq.' +
      encodeURIComponent(userId) + '&select=sub_until', { headers: svcHeaders() });
    const rows = cur.ok ? await cur.json() : [];
    const currentUntil = (rows && rows[0] && rows[0].sub_until) ? new Date(rows[0].sub_until).getTime() : 0;
    const newUntil = Math.max(currentUntil, expiry);
    const w = await fetch(process.env.SUPABASE_URL + '/rest/v1/coach_data', {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ user_id: userId, sub_until: new Date(newUntil).toISOString(), sub_plan: 'play_' + plan }])
    });
    if (!w.ok) return reply(200, headers, { ok: false, error: 'ecriture Supabase impossible' });

    return reply(200, headers, { ok: true, plan: 'play_' + plan, until: newUntil });
  } catch (e) {
    return reply(500, headers, { ok: false, error: 'serveur' });
  }
};
