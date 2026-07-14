# PIVOT sur Vercel, avec la vraie IA Claude

Ce dossier contient tout pour mettre PIVOT en ligne avec l'assistant IA réel, comme pour Repia.
La clé Claude vit dans la fonction serveur `api/coach.js`, jamais dans l'application. C'est le montage sûr.

## Ce qu'il y a dedans
- `index.html` : l'application PIVOT complète.
- `api/coach.js` : la petite fonction serveur qui parle à l'IA Claude et garde ta clé cachée.
- `package.json` : le minimum pour Vercel.

## Étapes, sans développeur

### 1. Prépare ta clé Claude dédiée à PIVOT
Dans la Console Claude, crée un Workspace nommé PIVOT (à côté de celui de Repia).
Dans ce Workspace, crée une clé API et note-la. Mets aussi une limite de dépense mensuelle sur ce Workspace, pour ne jamais être surpris.
Ainsi la facture reste sur ton compte unique, mutualisée avec Repia, mais le coût de PIVOT est suivi et plafonné à part.

### 2. Mets le dossier sur Vercel
Comme pour Repia. Deux façons, au choix :
- Le plus simple : pousse ce dossier sur un dépôt GitHub, puis dans Vercel, New Project, importe le dépôt.
- Ou en ligne de commande : installe l'outil Vercel, place-toi dans ce dossier, tape `vercel`, laisse-toi guider.

### 3. Ajoute ta clé dans Vercel
Dans Vercel, ouvre le projet, Settings, Environment Variables. Ajoute :
- `ANTHROPIC_API_KEY` = la clé du Workspace PIVOT (celle de l'étape 1).
- `PIVOT_MODEL` = le modèle que tu veux. Optionnel. Si tu utilises déjà un modèle précis pour Repia, mets le même ici. Sinon, laisse vide, un modèle économique est pris par défaut.

### 4. Déploie
Clique Deploy, ou attends le déploiement automatique. Ouvre l'adresse que Vercel te donne.

### 5. Teste
Ouvre l'application, touche le bouton étoile de l'assistant, pose une question de coach.
Cette fois, c'est la vraie IA Claude qui répond, avec ta clé, côté serveur.

## Bon à savoir
- Sur pika.me, il n'y a pas de fonction serveur, donc l'assistant reste en mode démonstration. C'est normal. La vraie IA marche sur l'adresse Vercel.
- Ne mets jamais ta clé dans `index.html`. Elle doit rester dans les variables d'environnement de Vercel, c'est ce que fait ce montage.
- Le coût de l'IA suit le modèle économique du fichier Excel. Garde la limite de dépense du Workspace comme garde-fou.
