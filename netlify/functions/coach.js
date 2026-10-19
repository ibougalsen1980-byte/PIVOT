// PIVOT, fonction serveur qui parle à l'IA Claude.
// Version Netlify de api/coach.js (celui-ci était écrit pour Vercel et ne fonctionne pas sur Netlify).
// Même logique, même prompt, même comportement. Rien n'a été retiré, juste adapté au format attendu par Netlify Functions.
// La clé vit ici, côté serveur, jamais dans l'application. Elle lit ANTHROPIC_API_KEY (et PIVOT_MODEL si besoin) dans les variables d'environnement Netlify.
//
// Garde-fou ajouté le 2026-09-03 : cette adresse n'a jamais vérifié qui appelle (ni compte, ni abonnement),
// elle ne fait que vérifier qu'il y a un message. C'est voulu, le mode "Découvrir sans compte" de PIVOT doit
// pouvoir parler à l'IA sans compte. Le risque, c'est qu'un script appelle cette adresse en boucle, directement,
// sans jamais passer par l'application, et fasse grimper la facture. La limite ci-dessous coupe ce scénario :
// un même visiteur (identifié par son adresse IP) ne peut pas dépasser un nombre de questions par fenêtre de temps.
// Limite volontairement large pour ne jamais gêner un coach qui discute normalement dans l'app.
// Le compteur vit dans Supabase (table api_rate_limit, fonction pivot_check_rate_limit), pas en mémoire :
// une première version gardait ça en mémoire de la fonction, mais Netlify ne garantit pas le même conteneur
// d'un appel à l'autre, donc ce compteur-là pouvait se réinitialiser n'importe quand. Celui-ci survit vraiment.
// Verrouillage ajouté le 19/10/2026 (audit du 18/10) : cette adresse ne vérifiait pas qui appelait.
// N'importe quel script pouvait s'en servir comme d'une IA gratuite aux frais du compte Anthropic,
// en changeant d'adresse IP pour contourner la limite par IP. Le mode découverte n'appelle plus
// l'IA depuis la version 18 (askAI répond localement), donc on exige désormais un compte connecté :
//  1. jeton Supabase obligatoire, vérifié côté serveur ;
//  2. limite par compte (12 questions / 10 min, 60 / 24 h) en plus de la limite par IP ;
//  3. si la vérification du quota est impossible, on refuse (avant, on laissait passer) ;
//  4. appels acceptés seulement depuis le domaine de l'app ;
//  5. textes de contexte tronqués, erreurs Anthropic gardées dans les journaux serveur.
const RATE_LIMIT_MAX = 12;                   // questions autorisées...
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;   // ...par tranche de 10 minutes
const DAILY_MAX = 60;                        // et au plus 60 par compte sur 24 h
const ALLOWED_ORIGINS = ['https://pivotcoach.netlify.app'];

// Renvoie true si autorisé, false si quota atteint, null si la vérification a échoué.
async function _allowed(id, windowSeconds, max) {
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/pivot_check_rate_limit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE,
        'authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE
      },
      body: JSON.stringify({ p_client_id: id, p_window_seconds: windowSeconds, p_max: max })
    });
    if (!r.ok) return null;
    const allowed = await r.json();
    return allowed === false ? false : true;
  } catch (e) {
    return null;
  }
}

const cut = (v, n) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').slice(0, n);

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method' }) };
  }
  // Un navigateur sur un autre site envoie toujours son Origin : on le refuse. Les appels de l'app
  // elle-même (même domaine) passent, avec ou sans Origin selon le navigateur.
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'origine' }) };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
    console.error('coach: SUPABASE_URL ou SUPABASE_SERVICE_ROLE absent, appel refusé');
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'indisponible' }) };
  }

  // 1. Compte connecté obligatoire
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'connexion requise' }) };
  let userId = '';
  try {
    const who = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE, 'authorization': 'Bearer ' + token }
    });
    if (who.ok) { const u = await who.json(); userId = (u && u.id) || ''; }
  } catch (e) { userId = ''; }
  if (!userId) return { statusCode: 401, headers, body: JSON.stringify({ error: 'session invalide' }) };

  // 2. et 3. Quotas par IP et par compte, refus si la vérification échoue
  const ip = String((event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || event.headers['client-ip'])) || 'inconnu').split(',')[0].trim();
  const checks = await Promise.all([
    _allowed(ip, RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_MAX),
    _allowed('ai:' + userId, RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_MAX),
    _allowed('aiday:' + userId, 24 * 3600, DAILY_MAX)
  ]);
  if (checks.includes(null)) {
    console.error('coach: vérification du quota impossible, appel refusé');
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'indisponible' }) };
  }
  if (checks.includes(false)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'trop de questions, réessaie plus tard' }) };
  }

  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }

    const message = (body.message || '').toString().slice(0, 4000);
    const level = body.level === 'beg' ? 'debutant' : 'professionnel';
    const t0 = body.team || {};
    const c0 = body.coach || {};
    // 5. Contexte tronqué : ces champs arrivent du navigateur et partent dans le prompt système.
    const team = { name: cut(t0.name, 60), category: cut(t0.category, 30), level: cut(t0.level, 30), opponent: cut(t0.opponent, 60), players: Math.max(0, Math.min(99, parseInt(t0.players, 10) || 0)) };
    const coach = { nom: cut(c0.nom, 60), experience: cut(c0.experience, 10), diplomes: cut(c0.diplomes, 160), niveau: cut(c0.niveau, 30) };

    if (!message) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'message vide' }) };
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'cle absente' }) };
    }

    const registre = level === 'debutant'
      ? "Registre simple, concret, pédagogique. Explique le jargon. Donne une piste claire, pas dix."
      : "Registre technique et dense, sans détour. Plusieurs options avec leurs compromis. Jargon assumé.";

    const system = [
      "Tu es l'assistant de PIVOT, une application pour les entraîneurs de basket, du Baby Basket aux U18.",
      "Tu es un adjoint expert, honnête et utile. Tu proposes, tu n'imposes pas.",
      "Structure ta réponse quand c'est utile : lecture de la situation, analyse, propositions concrètes, prochain pas, réserve.",
      "Appuie-toi sur des principes reconnus de pédagogie, de tactique, de préparation physique et de psychologie du sport.",
      "Adapte-toi au niveau du coach. " + registre,
      "Ne te fais jamais passer pour un professionnel de santé. Tu ne poses aucun diagnostic.",
      "Sujet sensible : si un mal-être dépasse la performance, surtout chez un mineur, oriente vers un adulte de confiance et un professionnel, et rappelle qu'en cas de danger on protège et on alerte.",
      "N'utilise pas de tirets cadratins. Reste direct et humain.",
      "Contexte de l'équipe : nom " + (team.name || 'inconnu') + ", catégorie " + (team.category || 'inconnue') + ", niveau " + (team.level || 'inconnu') + ", effectif " + (team.players || 0) + " joueurs, prochain adversaire " + (team.opponent || 'inconnu') + "."
    ];
    // Profil du coach ajouté le 20/09/2026 : le navigateur envoyait déjà ce profil (body.coach) à
    // chaque question, mais cette fonction ne le lisait jamais, donc l'IA ne savait rien de
    // l'expérience ou des diplômes du coach qui pose la question, alors que l'app le lui promettait.
    if (coach.nom || coach.experience || coach.diplomes || coach.niveau) {
      const parts = [];
      if (coach.nom) parts.push("nom " + coach.nom);
      if (coach.experience) parts.push("expérience " + coach.experience + " ans");
      if (coach.diplomes) parts.push("diplômes " + coach.diplomes);
      if (coach.niveau) parts.push("niveau déclaré dans l'app " + coach.niveau);
      system.push("Profil du coach qui pose la question : " + parts.join(', ') + ".");
    }
    const systemPrompt = system.join('\n');

    const model = process.env.PIVOT_MODEL || 'claude-haiku-4-5-20251001';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 700,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('coach: erreur Anthropic', r.status, JSON.stringify((data && data.error) || data).slice(0, 500));
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'ia' }) };
    }
    const reply = (data && data.content && data.content[0] && data.content[0].text)
      ? data.content[0].text
      : "Je n'ai pas pu formuler de réponse.";
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (e) {
    console.error('coach: exception', e && e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'serveur' }) };
  }
};
