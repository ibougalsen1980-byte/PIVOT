# Corriger PIVOT sur GitHub, sans ligne de commande

Ces 7 fichiers corrigent les quatre problèmes trouvés dans l'audit, sans rien enlever à ce qui existe. Une fois envoyés sur GitHub, Netlify redéploie tout seul en quelques minutes.

## Ce que contient ce dossier

- `manifest.json` : rend l'installation de l'app propre sur un téléphone (n'existait pas avant).
- `sw.js` : active le mode hors ligne et les notifications (n'existait pas avant).
- `logo.png` et `logo-192.png` : l'icône de l'app, recadrée depuis ton logo validé (n'existait pas avant).
- `netlify.toml` : dit à Netlify où trouver la fonction IA et garde l'adresse `/api/coach` que l'application utilise déjà, pour ne rien changer côté application.
- `netlify/functions/coach.js` : la même fonction IA que `api/coach.js`, adaptée au format Netlify. `api/coach.js` reste en place, rien n'est supprimé.
- `package.json` : identique à l'actuel, une seule ligne ajoutée pour fixer la version de Node.

## Étapes, sur github.com

1. Va sur `github.com/ibougalsen1980-byte/PIVOT`.
2. Clique sur **Add file** puis **Upload files**.
3. Glisse `manifest.json`, `sw.js`, `logo.png`, `logo-192.png`, `netlify.toml` et le nouveau `package.json` dans la zone de dépôt.
4. Pour `netlify/functions/coach.js`, GitHub ne crée pas le dossier automatiquement en glisser-déposer : clique **Create new file** en haut de la page d'upload, tape dans le nom du fichier `netlify/functions/coach.js` (les deux `/` créent les dossiers tout seuls), colle le contenu du fichier fourni ici, puis **Commit changes**.
5. Descends en bas de page, laisse le message de commit par défaut ou écris "correctifs manifest, service worker, logo, fonction IA Netlify", puis clique **Commit changes**.
6. Va sur ton tableau de bord Netlify. Le déploiement se déclenche seul. Attends le badge vert "Published".

## Vérifier que ça a marché

- Ouvre `pivotcoach.netlify.app` sur ton téléphone : la proposition d'installation doit apparaître proprement, avec l'icône du ballon.
- Dans l'app, touche l'assistant IA et pose une question de coach. Si tu obtiens une vraie réponse construite (pas une phrase toute faite), la clé `ANTHROPIC_API_KEY` est déjà configurée sur Netlify et l'IA répond pour de vrai.
- Si l'assistant répond encore en mode générique, il manque la variable d'environnement `ANTHROPIC_API_KEY` (et éventuellement `PIVOT_MODEL`) dans Netlify, Site settings puis Environment variables. Dis-le-moi, je te guide pour cette étape aussi.

## Important

L'ajout du logo ne remplace ni ne supprime le fichier storyboard d'animation présent dans le projet. C'est une icône recadrée, exploitable tout de suite. Si tu veux une version vectorielle plus nette plus tard, on pourra la refaire proprement.
