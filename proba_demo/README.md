# Démos de probabilités — pile ou face, et des dés à la courbe en cloche

Deux projets **hors du catalogue des démos** (usage personnel, pas listés dans l'app), à ouvrir dans l'app (Load project).
Aucun fichier externe : les polices (Poppins) sont celles de l'app. Les nœuds `List Histogram` et la Cumulative Sum de
`List Math` qu'ils utilisent font partie de l'app.

## Loi des grands nombres — `large_numbers_coins.tsuji`

2 canvases, enchaînés par `Go To Canvas`.

| Canvas | Scène | Durée (s) |
| :-- | :-- | :-- |
| 1 | Introduction — l'expérience posée en cinq lignes de texte | 10,0 |
| 2 | Graphe — 5 séries de lancers, proportion de piles en fonction de n (axe log 1…1000), bande p ± 2σ/√n ; les pièces de la série bleue s'empilent, piles à gauche, faces à droite | 13,0 |

`p` est exposé dans le panneau de la scène 2 : le changer puis Lecture.

```bash
python3 proba_demo/gen_lln.py proba_demo/large_numbers_coins.tsuji
```

## Le hasard a-t-il une forme ? — `bell_curve_dice.tsuji`

6 canvases = 6 scènes, enchaînées par `Go To Canvas` sur la dernière frame. Environ 1 min 50 s ; tout est déterministe
(les tirages viennent de `Random List` à graine fixe), donc la timeline se scrube et s'exporte à l'identique.

| Canvas | Scène | Durée (s) |
| :-- | :-- | :-- |
| 1 | Titre — un dé tourne sous « Le hasard a-t-il une forme ? » | 7,0 |
| 2 | Un dé — 8 lancers lents puis 600 en accéléré ; six colonnes de blocs au niveau du 1/6 | 20,4 |
| 3 | Deux dés — les 36 couples pivotent de 45° et tombent en triangle ; 1 200 lancers le remplissent | 26,0 |
| 4 | Cinq dés — 3 000 lancers sous la loi exacte (escalier blanc) | 16,5 |
| 5 | Dix dés — 4 000 lancers, puis la courbe N(35 ; 350/12) | 19,0 |
| 6 | Finale — lois exactes de 1, 2, 5, 10 dés centrées-réduites sur φ(z) ; « Théorème central limite » | 19,0 |

Chaque dé se pose sur la face réellement tirée et les histogrammes comptent ces mêmes tirages. Les lois exactes
(`exact_pmf`, inclusion–exclusion) sont vérifiées : somme 1, moyenne 3,5k, variance 35k/12.

```bash
python3 proba_demo/gen_dice.py proba_demo/bell_curve_dice.tsuji
```

`dicelib.py` (utilisé par `gen_dice.py`) porte les briques communes : `Canvas` (nœuds, câbles, keyframes), décor de nuit (brouillard, bloom,
vignette, rideau noir), textes, dé, rotations de repos par face, moteur de lancer, loi exacte.

## À savoir (Tsuji)

- `object/text` : `fontSize` en px (hauteur monde ≈ fontSize × 0,015, minimum 8) ; le texte est centré sur sa position.
- Helvetiker n'a pas les accents ; Poppins oui, mais ni σ ni √ : les mettre dans `math/latex`.
- `list/math` : une valeur `b: 0` dans le panneau compte comme une entrée B câblée ; mettre le facteur dans `b`.
- Les textes projettent des ombres : titres loin derrière (z ≈ −6).
- Fondu au noir : un plan noir sans ombrage devant la caméra, opacité animée (Color Correction teinte l'image).
- Rotations de repos (Euler XYZ, degrés) — face 1 : (0, w, 0) ; 6 : (180, w, 0) ; 2 : (0, w, 90) ; 5 : (0, w, −90) ;
  3 : (−90, 0, w) ; 4 : (90, 0, w).
