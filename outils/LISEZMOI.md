# Outils d'audit PIVOT

Méthode imposée pour chaque audit (demande du fondateur, 13/11/2026) : audit **intégral**,
chaque bouton de chaque écran et de chaque fenêtre est actionné, pas seulement des parcours choisis.

1. `python3 -m http.server 8765` à la racine du dépôt (ou passer l'URL de production en argument).
2. `python3 outils/audit-integral.py [URL]` : actionne tous les éléments cliquables des 6 écrans et
   des fenêtres jusqu'à 4 niveaux, données de test remises à zéro avant chaque clic. Rapport :
   `/tmp/audit/crawl/crawl.json` (erreurs JS, console, réseau, rechargements, actions sans effet).
   Durée : 10 à 15 minutes.
3. `python3 outils/audit-transverse.py [URL]` : textes non traduits (EN, ES, PT), images cassées,
   boutons sans nom, cibles trop petites au doigt, champs sans libellé, liens externes.
4. Contrôle des données d'exercices (champs, liens entre exercices, âges, durées) : voir le
   rapport `claude/pivot-audit-integral-2026-11-13.md` du projet.

Les « actions sans effet visible » sont à trier à la main : un compteur qui passe de 2 à 3 ou un
outil déjà sélectionné ne change pas la page, ce ne sont pas des défauts.
Actions jamais déclenchées : paiement, suppression de compte, réinitialisation, import de fichier.
Pré-requis : `pip install playwright && playwright install chromium`.
