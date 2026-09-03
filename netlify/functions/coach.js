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
const RATE_LIMIT_MAX = 12;                   // questions autorisées...
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;   // ...par tranche de 10 minutes, par visiteur

async function _rateLimited(id) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) return false; // pas de Supabase configuré, on n'en fait pas dépendre l'app
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
    if (!r.ok) return false; // en cas de souci Supabase, on laisse passer plutôt que de bloquer tout le monde
    const allowed = await r.json();
    return allowed === false;
  } catch (e) {
    return false;
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method' }) };
  }

  const clientId = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || event.headers['client-ip'])) || 'inconnu';
  if (await _rateLimited(String(clientId).split(',')[0].trim())) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'trop de questions, réessaie dans quelques minutes' }) };
  }

  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }

    const message = (body.message || '').toString().slice(0, 4000);
    const level = body.level === 'beg' ? 'debutant' : 'professionnel';
    const team = body.team || {};

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
    ].join('\n');

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
        system: system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'ia', detail: (data && data.error) ? data.error : data }) };
    }
    const reply = (data && data.content && data.content[0] && data.content[0].text)
      ? data.content[0].text
      : "Je n'ai pas pu formuler de réponse.";
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'serveur' }) };
  }
};
