// PIVOT, suppression d'un compte coach et de ses donnees (ajoutee le 2026-09-30).
//
// Pourquoi cette fonction existe : Google Play exige qu'un utilisateur puisse demander la suppression
// de son compte depuis l'application. La suppression d'un utilisateur Supabase demande la cle de
// service, qui ne doit jamais etre envoyee au navigateur : elle se fait donc ici, cote serveur.
//
// Securite : la fonction n'agit que sur le compte proprietaire du jeton de session envoye par
// l'application (verifie aupres de Supabase). Aucun identifiant n'est accepte depuis le corps de la requete.
//
// Ce qui est efface : la ligne coach_data (effectif, seances, matchs, acces), l'abonnement aux
// notifications, les achats Google Play, les codes d'acces utilises, puis l'utilisateur Supabase lui-meme.
// stripe_sessions_used garde l'identifiant de paiement (anti-reutilisation) mais perd le lien au compte.
//
// Variables d'environnement Netlify : SUPABASE_URL, SUPABASE_SERVICE_ROLE (deja configurees).

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
  if (!base || !svc) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'serveur non configure' }) };

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'connexion requise' }) };

  try {
    const who = await fetch(base + '/auth/v1/user', { headers: { 'apikey': svc, 'authorization': 'Bearer ' + token } });
    if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'session invalide' }) };
    const user = await who.json();
    const userId = user && user.id;
    if (!userId) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'session invalide' }) };

    const svcHeaders = { 'apikey': svc, 'authorization': 'Bearer ' + svc, 'Prefer': 'return=minimal' };
    const uid = encodeURIComponent(userId);

    const d1 = await fetch(base + '/rest/v1/coach_data?user_id=eq.' + uid, { method: 'DELETE', headers: svcHeaders });
    if (!d1.ok) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'donnees non effacees' }) };

    // L'abonnement aux notifications peut ne pas exister : un echec ici ne bloque pas la suite.
    try { await fetch(base + '/rest/v1/push_subscriptions?user_id=eq.' + uid, { method: 'DELETE', headers: svcHeaders }); } catch (e) {}

    // Ajoute le 19/10/2026 (audit du 18/10) : ces lignes restaient apres la suppression du compte.
    // Achats Google Play et codes d'acces utilises : effaces. Paiements Stripe deja traites : on garde
    // l'identifiant de session (protection contre la reutilisation d'un paiement) mais on retire le lien
    // avec le compte. Un echec ici ne bloque pas la suppression du compte.
    try { await fetch(base + '/rest/v1/play_purchases?user_id=eq.' + uid, { method: 'DELETE', headers: svcHeaders }); } catch (e) {}
    try { await fetch(base + '/rest/v1/code_redemptions?user_id=eq.' + uid, { method: 'DELETE', headers: svcHeaders }); } catch (e) {}
    try { await fetch(base + '/rest/v1/stripe_sessions_used?user_id=eq.' + uid, { method: 'PATCH', headers: Object.assign({ 'content-type': 'application/json' }, svcHeaders), body: JSON.stringify({ user_id: null }) }); } catch (e) {}

    const d3 = await fetch(base + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'apikey': svc, 'authorization': 'Bearer ' + svc } });
    if (!d3.ok) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'compte non supprime' }) };

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'serveur' }) };
  }
};
