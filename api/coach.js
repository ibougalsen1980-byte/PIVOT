// PIVOT, fonction serveur qui parle à l'IA Claude.
// La clé vit ici, côté serveur, jamais dans l'application. Déployée sur Vercel.
// Elle lit la variable d'environnement ANTHROPIC_API_KEY (et PIVOT_MODEL si tu veux choisir le modèle).

module.exports = async (req, res) => {
  // CORS de base, au cas où l'app est servie depuis un autre domaine
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

  try {
    // Lecture du corps, robuste
    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
    }
    const message = (body.message || '').toString().slice(0, 4000);
    const level = body.level === 'beg' ? 'debutant' : 'professionnel';
    const team = body.team || {};

    if (!message) { res.status(400).json({ error: 'message vide' }); return; }
    if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: 'cle absente' }); return; }

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
      res.status(502).json({ error: 'ia', detail: (data && data.error) ? data.error : data });
      return;
    }
    const reply = (data && data.content && data.content[0] && data.content[0].text)
      ? data.content[0].text
      : "Je n'ai pas pu formuler de réponse.";
    res.status(200).json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'serveur' });
  }
};
