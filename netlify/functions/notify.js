// PIVOT, envoi des notifications push aux coachs abonnés.
//
// Pourquoi cette fonction n'existait pas : le bouton "Diffuser une notification" dans les réglages
// admin appelait déjà fetch('/api/notify') côté navigateur, et le service worker (sw.js) savait déjà
// afficher une notification reçue, mais rien côté serveur ne savait fabriquer et envoyer cet envoi.
// C'est ce qui provoquait l'erreur 404 : l'adresse /api/notify ne menait nulle part.
//
// Sécurité : seul le compte administrateur (ADMIN_EMAIL) peut déclencher un envoi. L'identité de
// l'appelant est vérifiée auprès de Supabase à partir de son jeton de connexion, jamais à partir
// d'un champ que le navigateur pourrait fournir lui-même.
//
// Variables d'environnement Netlify nécessaires (à ajouter, voir README) :
//   VAPID_PUBLIC_KEY    clé publique VAPID (doit correspondre à VAPID_PUBLIC dans index.html)
//   VAPID_PRIVATE_KEY   clé privée VAPID, ne doit jamais être exposée au navigateur
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE : déjà configurées pour les autres fonctions
const webpush = require('web-push');

const ADMIN_EMAIL = 'ibougalsen1980@gmail.com';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Supabase non configuré côté serveur' }) };
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Clés VAPID non configurées côté serveur' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const title = String(body.title || 'PIVOT').trim() || 'PIVOT';
  const msg = String(body.body || '').trim();
  if (!msg) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'message manquant' }) };

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'connexion requise' }) };

  const svcHeaders = {
    'apikey': process.env.SUPABASE_SERVICE_ROLE,
    'authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE,
    'content-type': 'application/json'
  };

  try {
    const who = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE, 'authorization': 'Bearer ' + token }
    });
    if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'session invalide, reconnecte-toi' }) };
    const user = await who.json();
    const email = user && user.email ? String(user.email).toLowerCase() : '';
    if (email !== ADMIN_EMAIL) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'réservé à l\'administrateur' }) };

    webpush.setVapidDetails('mailto:' + ADMIN_EMAIL, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

    const subsRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/push_subscriptions?select=user_id,sub,endpoint', { headers: svcHeaders });
    if (!subsRes.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'lecture des abonnements impossible' }) };
    const subs = await subsRes.json();

    const payload = JSON.stringify({ title, body: msg });
    let sent = 0;
    const deadEndpoints = [];
    await Promise.all((subs || []).map(async (row) => {
      const sub = row.sub;
      if (!sub || !sub.endpoint) return;
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (e) {
        // 404/410 = abonnement expiré ou révoqué côté navigateur, on le retire pour ne pas réessayer sans fin.
        if (e && (e.statusCode === 404 || e.statusCode === 410)) deadEndpoints.push(row.endpoint);
      }
    }));

    if (deadEndpoints.length) {
      try {
        await fetch(process.env.SUPABASE_URL + '/rest/v1/push_subscriptions?endpoint=in.(' + deadEndpoints.map(encodeURIComponent).join(',') + ')', {
          method: 'DELETE', headers: svcHeaders
        });
      } catch (e) { /* nettoyage best-effort, ne doit pas faire échouer l'envoi */ }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent, total: (subs || []).length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'serveur' }) };
  }
};
