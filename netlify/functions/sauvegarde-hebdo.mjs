// PIVOT, sauvegarde hebdomadaire de la base (ajoutée le 14/11/2026).
//
// Pourquoi : l'offre gratuite de Supabase n'inclut aucune sauvegarde. Une erreur d'écriture ou un incident
// effacerait les équipes, séances et abonnements de tous les coachs, sans retour possible.
//
// Comment : chaque lundi, Netlify lance cette fonction. Elle lit toutes les tables de PIVOT et la liste des
// comptes (identifiant, mail, dates) avec la clé de service déjà configurée sur Netlify, puis range le tout
// dans un fichier JSON du stockage privé du site (Netlify Blobs, magasin « sauvegardes-pivot »). Ce stockage
// n'est pas accessible depuis le site public. Les 12 dernières sauvegardes sont gardées (environ 3 mois).
// Aucun mot de passe supplémentaire : variables SUPABASE_URL et SUPABASE_SERVICE_ROLE, déjà présentes.
//
// Lancer à la main : Netlify > Logs > Functions > sauvegarde-hebdo > « Run now ».
// Lire une sauvegarde : Netlify > Blobs > sauvegardes-pivot.

import { getStore } from '@netlify/blobs';

const TABLES = ['coach_data', 'stripe_subscriptions', 'play_purchases', 'stripe_sessions_used', 'code_redemptions', 'push_subscriptions'];
const GARDER = 12;

export default async () => {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!base || !key) { console.error('sauvegarde: variables Supabase absentes'); return new Response('config', { status: 500 }); }
  const h = { apikey: key, Authorization: 'Bearer ' + key };

  const out = { version: 1, date: new Date().toISOString(), tables: {}, comptes: [] };
  for (const t of TABLES) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetch(`${base}/rest/v1/${t}?select=*`, { headers: { ...h, Range: `${from}-${from + 999}` } });
      if (!r.ok) throw new Error(`table ${t} : HTTP ${r.status}`);
      const page = await r.json();
      rows.push(...page);
      if (page.length < 1000) break;
    }
    out.tables[t] = rows;
  }
  for (let page = 1; ; page++) {
    const r = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: h });
    if (!r.ok) throw new Error(`comptes : HTTP ${r.status}`);
    const users = (await r.json()).users || [];
    out.comptes.push(...users.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at, email_confirmed_at: u.email_confirmed_at })));
    if (users.length < 1000) break;
  }

  const store = getStore('sauvegardes-pivot');
  const nom = `pivot-${out.date.slice(0, 10)}.json`;
  await store.set(nom, JSON.stringify(out));

  const { blobs } = await store.list();
  const anciennes = blobs.map(b => b.key).filter(k => /^pivot-\d{4}-\d{2}-\d{2}\.json$/.test(k)).sort().slice(0, -GARDER);
  for (const k of anciennes) await store.delete(k);

  const resume = `sauvegarde ${nom} : ${out.comptes.length} comptes, ` + TABLES.map(t => `${t}=${out.tables[t].length}`).join(', ');
  console.log(resume);
  return new Response(resume);
};

export const config = { schedule: '17 3 * * 1' };
