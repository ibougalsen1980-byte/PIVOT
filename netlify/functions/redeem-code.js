// PIVOT, verification serveur d'un code d'acces manuel (code proprietaire, code testeur, etc.)
//
// Pourquoi cette fonction existe : la liste des codes vivait avant en clair dans index.html, donc
// visible par n'importe qui via "Afficher le code source", sans meme ouvrir la console du navigateur.
// Elle vit maintenant uniquement dans une variable d'environnement Netlify, jamais envoyee au navigateur.
// L'identite de la personne qui redeem le code est verifiee aupres de Supabase a partir de son jeton de
// connexion, jamais a partir d'un identifiant que le navigateur pourrait fournir lui-meme.
//
// Garde-fou ajoute le 2026-09-13 : avant, rien ne limitait le nombre d'essais. Un compte gratuit pouvait
// tester des milliers de codes par script tant qu'il restait connecte. On reutilise ici le meme compteur
// persistant que coach.js (table api_rate_limit, fonction pivot_check_rate_limit), avec un espace de noms
// different ("redeem:") pour ne pas partager le quota avec les questions posees a l'assistant IA.
// Limite volontairement large : un coach qui se trompe deux ou trois fois en tapant son code ne doit
// jamais etre bloque, seul un script qui enchaine les essais l'est.
const RATE_LIMIT_MAX = 8;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

async function _rateLimited(id) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) return false; // pas de Supabase configure, on n'en fait pas dependre l'app
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/pivot_check_rate_limit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE,
        'authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE
      },
      body: JSON.stringify({ p_client_id: id, p_window_seconds: RATE_LIMIT_WINDOW_SECONDS, p_max: RATE_LIMIT_MAX })
    });
    if (!r.ok) return false; // en cas de souci Supabase, on laisse passer plutot que de bloquer tout le monde
    const allowed = await r.json();
    return allowed === false;
  } catch (e) {
    return false;
  }
}
//
// Variables d'environnement Netlify necessaires :
//   PIVOT_ACCESS_CODES      JSON, ex: {"PIVOT-OWNER-2026":3650,"PIVOT-TESTEUR-2026":21}
//   SUPABASE_URL            deja configuree
//   SUPABASE_SERVICE_ROLE   deja configuree

exports.handler = async (event) => {
const headers = {
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Headers': 'Content-Type, Authorization',
'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method' }) };

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Supabase non configure cote serveur' }) };
}
let codes = {};
try { codes = JSON.parse(process.env.PIVOT_ACCESS_CODES || '{}'); } catch (e) { codes = {}; }

let body = {};
try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
const code = String(body.code || '').trim();
if (!code) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'code manquant' }) };

const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
const token = authHeader.replace(/^Bearer\s+/i, '');
if (!token) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'connexion requise' }) };

try {
const who = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE, 'authorization': 'Bearer ' + token }
});
if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'session invalide, reconnecte-toi' }) };
const user = await who.json();
const userId = user && user.id;
if (!userId) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'session invalide, reconnecte-toi' }) };

if (await _rateLimited('redeem:' + userId)) {
return { statusCode: 429, headers, body: JSON.stringify({ ok: false, error: 'trop de tentatives, reessaie dans quelques minutes' }) };
}

const days = codes[code];
if (!days) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'code invalide' }) };

const grant = await grantServerAccess(userId, days, 'code');
if (!grant.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'ecriture Supabase impossible' }) };
return { statusCode: 200, headers, body: JSON.stringify({ ok: true, days, plan: 'code' }) };
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
