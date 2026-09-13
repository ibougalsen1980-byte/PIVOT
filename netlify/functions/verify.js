// PIVOT, confirmation serveur d'un paiement Stripe et ecriture de l'acces dans Supabase.
//
// Pourquoi cette fonction existe : avant elle, l'application faisait confiance a une valeur
// stockee dans le navigateur (DB.sub.until) pour savoir si le coach avait un acces paye actif.
// N'importe qui pouvait modifier cette valeur depuis la console du navigateur et obtenir un acces
// illimite, y compris replique sur ses autres appareils via la synchronisation cloud. Cette fonction
// verifie le paiement directement aupres de Stripe, puis ecrit l'acces dans une colonne Supabase que
// le navigateur ne peut jamais modifier lui-meme (cle de service, jamais envoyee au client).
//
// Variables d'environnement Netlify necessaires :
//   STRIPE_SECRET_KEY       cle secrete Stripe (Dashboard Stripe, Developpeurs, Cles API)
//   SUPABASE_URL            deja configuree (utilisee par coach.js pour la limite anti-abus)
//   SUPABASE_SERVICE_ROLE   deja configuree (idem)
//
// Garde-fou ajoute le 2026-09-13 : avant, rien n'empechait de rejouer la meme URL de retour Stripe pour
// obtenir a nouveau des jours d'abonnement. Le seul frein etait cote client (DB.lastSession), une donnee
// que le navigateur controle librement, donc facilement contournable (autre appareil, stockage local vide,
// URL resauvegardee avant paiement). Chaque session_id deja traite est maintenant enregistre dans la table
// Supabase stripe_sessions_used (cle primaire sur session_id, ecrite uniquement par cette fonction avec la
// cle de service). Un meme session_id ne peut plus jamais crediter des jours une seconde fois.
async function _alreadyProcessed(sessionId, userId) {
  const base = process.env.SUPABASE_URL;
  const svcHeaders = {
    'apikey': process.env.SUPABASE_SERVICE_ROLE,
    'authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE,
    'content-type': 'application/json',
    'Prefer': 'return=minimal'
  };
  const w = await fetch(base + '/rest/v1/stripe_sessions_used', {
    method: 'POST',
    headers: svcHeaders,
    body: JSON.stringify([{ session_id: sessionId, user_id: userId }])
  });
  if (w.status === 409) return true; // deja present : ce paiement a deja ete credite
  if (!w.ok) throw new Error('ecriture stripe_sessions_used impossible');
  return false;
}

// Correspondance prix -> duree, a mettre a jour si les prix de STRIPE_LINKS changent dans index.html.
const PRICE_TO_DAYS = {
299: { days: 7, plan: 'semaine' },
899: { days: 30, plan: 'mois' },
7999: { days: 365, plan: 'annee' }
};

exports.handler = async (event) => {
const headers = {
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Headers': 'Content-Type',
'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method' }) };

const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;
if (!sessionId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'session_id manquant' }) };

if (!process.env.STRIPE_SECRET_KEY) {
return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Stripe non configure cote serveur' }) };
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Supabase non configure cote serveur' }) };
}

try {
const sr = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), {
headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
});
const session = await sr.json();
if (!sr.ok || !session) {
return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'session Stripe introuvable' }) };
}
if (session.payment_status !== 'paid') {
return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'paiement non confirme' }) };
}
const userId = session.client_reference_id;
if (!userId) {
return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'compte non identifie, contacte le support' }) };
}
const mapping = PRICE_TO_DAYS[session.amount_total];
if (!mapping) {
return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'montant non reconnu' }) };
}

try {
if (await _alreadyProcessed(sessionId, userId)) {
return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'ce paiement a deja ete credite' }) };
}
} catch (e) {
return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'verification anti-rejeu impossible' }) };
}

const grant = await grantServerAccess(userId, mapping.days, mapping.plan);
if (!grant.ok) {
return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'ecriture Supabase impossible' }) };
}
return { statusCode: 200, headers, body: JSON.stringify({ ok: true, days: mapping.days, plan: mapping.plan }) };
} catch (e) {
return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'serveur' }) };
}
};

async function grantServerAccess(userId, days, plan) {
const base = process.env.SUPABASE_URL;
const svcHeaders = {
'apikey': process.env.SUPABASE_SERVICE_ROLE,
'authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE,
'content-type': 'application/json'
};
try {
const cur = await fetch(base + '/rest/v1/coach_data?user_id=eq.' + encodeURIComponent(userId) + '&select=sub_until', { headers: svcHeaders });
const rows = cur.ok ? await cur.json() : [];
const currentUntil = (rows && rows[0] && rows[0].sub_until) ? new Date(rows[0].sub_until).getTime() : 0;
const newUntil = (currentUntil > Date.now() ? currentUntil : Date.now()) + days * 86400000;
const w = await fetch(base + '/rest/v1/coach_data', {
method: 'POST',
headers: Object.assign({}, svcHeaders, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
body: JSON.stringify([{ user_id: userId, sub_until: new Date(newUntil).toISOString(), sub_plan: plan }])
});
return { ok: w.ok };
} catch (e) {
return { ok: false };
}
}
