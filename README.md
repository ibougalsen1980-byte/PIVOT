# PIVOT sur Netlify, avec la vraie IA Claude

Ce dossier contient tout pour mettre PIVOT en ligne avec l'assistant IA réel.
La clé Claude vit dans la fonction serveur `netlify/functions/coach.js`, jamais dans l'application. C'est le montage sûr.
Le site en production est `pivotcoach.netlify.app`, déployé depuis ce dépôt GitHub.

## Ce qu'il y a dedans
- `index.html` : l'application PIVOT complète (un seul fichier).
- `netlify/functions/coach.js` : la fonction serveur qui parle à l'IA Claude et garde la clé cachée. C'est celle qui tourne réellement en production.
- `api/coach.js` : une ancienne version écrite pour Vercel, gardée dans le dépôt à titre d'historique mais jamais exécutée sur Netlify.
- `netlify.toml` : la configuration Netlify. Elle redirige `/api/coach` (l'adresse que l'application appelle) vers la fonction Netlify, et définit les en-têtes de sécurité (Content-Security-Policy, etc.).
- `exercices-bibliotheque.json` et `exercices-i18n.json` : la bibliothèque d'exercices et ses traductions, chargées par l'application au démarrage.
- `manifest.json`, `sw.js`, `logo.png`, `logo-192.png` : les fichiers de l'application installable (PWA).

## Étapes, sans développeur

### 1. Prépare ta clé Claude dédiée à PIVOT
Dans la Console Claude, crée un Workspace nommé PIVOT. Dans ce Workspace, crée une clé API et note-la.
Mets aussi une limite de dépense mensuelle sur ce Workspace, pour ne jamais être surpris.

### 2. Mets le dossier sur Netlify
Le plus simple : pousse ce dossier sur un dépôt GitHub, puis dans Netlify, New site from Git, importe le dépôt.
Netlify détecte automatiquement `netlify.toml` et sait où trouver les fonctions.

### 3. Ajoute ta clé dans Netlify
Dans Netlify, ouvre le site, Site configuration, Environment variables. Ajoute :
- `ANTHROPIC_API_KEY` = la clé du Workspace PIVOT (celle de l'étape 1).
- `PIVOT_MODEL` = le modèle que tu veux utiliser, par exemple `claude-sonnet-4-5-20250929`. Optionnel : si tu ne mets rien, un modèle économique (Haiku) est pris par défaut.

### 4. Déploie
Chaque dépôt sur la branche `main` déclenche normalement un nouveau déploiement automatique. Ouvre `pivotcoach.netlify.app` pour vérifier.

### 5. Teste
Ouvre l'application, touche le bouton étoile de l'assistant, pose une question de coach.
C'est la vraie IA Claude qui répond, avec la clé, côté serveur.

## Bon à savoir
- Ne mets jamais la clé dans `index.html`. Elle doit rester dans les variables d'environnement de Netlify, c'est ce que fait ce montage.
- Le fichier `netlify/functions/coach.js` limite le nombre de questions par visiteur sur une fenêtre de dix minutes (garde-fou anti-abus), pour que le mode "Découvrir sans compte" reste ouvert sans exposer la facture à un usage détourné.
- Si un déploiement Netlify semble bloqué ou en retard par rapport aux derniers commits, vérifie d'abord que le crédit du compte Netlify n'est pas épuisé : c'est ce qui a causé un vrai incident de déploiement début septembre 2026.
