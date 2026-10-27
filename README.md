# Salle d'analyse

Bilans de parties d'échecs illimités pour un groupe d'amis, façon chess.com, gratuits et
partagés.

- Chaque joueur enregistre son pseudo chess.com et/ou Lichess : l'appli récupère seule ses
  parties récentes (API publiques, appelées depuis le navigateur).
- Le bilan est calculé dans le navigateur par Stockfish 18 (WebAssembly, dans un Web Worker) :
  précision par coup et par partie, classement des coups avec les noms de chess.com (brillant, excellent, meilleur,
  très bien, bon, théorique, imprécision, erreur, manqué, gaffe) et une phrase d'explication, courbe d'évaluation, meilleur coup.
- Un bilan calculé une fois est enregistré dans Firestore et visible par tout le groupe.
- Page Groupe : classement par précision moyenne, Elo estimé, gaffes par partie, coups
  brillants, victoires, nulles et défaites sur 7 jours, 30 jours ou depuis le début.
- Plusieurs groupes possibles sur un même appareil, avec un menu pour passer de l'un à l'autre.
- File d'analyse : chacun dit qui il est sur son appareil (« Je suis »), puis lance d'un coup le
  bilan de toutes ses parties qui n'en ont pas. Chacun ne calcule que les siennes.
- Gazette du club (onglet Gazette) : la semaine du groupe (le plus acharné, meilleure précision,
  coup et gaffe de la semaine, remontée, craquage, progression Elo, duels), 3 défis tirés au sort
  chaque lundi et comptés tout seuls, et les records du club. Calculs dans `gazette.js`.

## Elo estimé

Calé sur des parties rapides chess.com (voir `core.js` et `calibrage/`). Sur la moyenne des
20 derniers bilans d'un joueur (8 minimum), l'erreur est d'environ 220 points. Sur une seule
partie, elle dépasse 500 points : cette valeur est affichée comme « indicative ». Les valeurs
sont sur l'échelle chess.com (les classements Lichess sont plus hauts à niveau égal).

## Accès

Le groupe est identifié par un code dans le lien (`?g=XXXXX-XXXXX`). Toute personne qui a le
lien peut lire et compléter le groupe : il faut le garder entre amis. Les règles de sécurité
Firestore sont dans `firestore.rules`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css`, `app.js` | Interface |
| `core.js` | Calcul du bilan (probabilité de gain, précision, classement des coups) |
| `sources.js` | Récupération des parties chess.com et Lichess |
| `gazette.js` | Gazette, records et défis de la semaine (calculs) |
| `partage.js`, `firebase-config.js` | Partage dans Firestore |
| `moteur/` | Stockfish 18 lite single-threaded |
| `chess.js` | Règles des échecs et lecture des PGN |

## Lancer en local

Les modules JavaScript ne marchent pas en ouvrant le fichier directement : il faut un petit
serveur.

```
python -m http.server 5175
```

Puis ouvrir http://localhost:5175.

## Licence

GPL v3 (voir `LICENSE`), car le projet embarque Stockfish. Composants tiers et leurs
licences : `LICENCES-TIERS.md`.
