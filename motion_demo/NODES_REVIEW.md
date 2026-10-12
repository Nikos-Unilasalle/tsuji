# Tour des nodes — ce qui sert la démo (lecture du code, rien encore testé à l'écran)

Source : `src/shared/graph/nodes/*.ts`. Les socket `postprocess` se chaînent
(`effect` → `effect`) jusqu'à l'entrée **Post-Process** du nœud `render`.

## 1. Deux familles d'effets de style

| Famille | Cible | Nœuds | Pour nous |
| :-- | :-- | :-- | :-- |
| **Modifier** (`modifier/*`) | **une géométrie** (un plan d'image) | `duotone`, `halftone`, `outline`, `dry-brush`, `film-texture`, `super8` | **Look par image** : chaque photo a sa bichromie, sa trame, son contour sticker |
| **Post-process** (`postprocess/*`) | **tout le rendu** | mêmes 5 + `bloom` `vignette` `rgb-shift` `dof` `outline` `film-grain` `glitch` `pixelate` `kaleidoscope` `color-correction` `antialias` `ambient-occlusion` `fog` | **Look global** : grain, poussière, rayures, color-flip de scène |

### Modifiers (par plan d'image) — paramètres clés

| Nœud | Paramètres | Usage dans la démo |
| :-- | :-- | :-- |
| `modifier/duotone` | `shadowColor`, `highlightColor`, `balance`, `softness`, `amount` | photo → encre `#121c1f` / crème `#dcd8c4`, ou encre → moutarde/vert/rouge pour les accessoires (médaille, gant, voiture) |
| `modifier/halftone` | `shape` dot/ellipse/line/square, `space` screen/**uv**, `radius`, `screenAngle`, `scatter`, `amount`, `greyscale` | trame demi-teinte. `uv` = trame collée à l'image (suit le mouvement), `screen` = trame fixe écran |
| `modifier/outline` | `edgeColor`, `edgeThickness`, `sharpness`, `outlineSide` outside/inside/center, `alphaThreshold`, **`alphaEdge` (Alpha Cutout)** | **contour « sticker » crème/bleu autour du PNG détouré** — exactement le look du policier gravé |
| `modifier/dry-brush` | `coverage`, `speckSize`, `softness`, `stretch`, `strokeAngle`, `paperColor`, `followInk`, `animate (boil)`, `rate` | grain de papier/encre sec sur les aplats ; `animate` = boil à 12 fps (sensation pellicule) |
| `modifier/film-texture` | `grain`, `dust`, `scratches`, `blotches`, `rate`, `seed` | poussière + rayures de film **sur un seul plan** |
| `modifier/super8` | `softness`, `flicker`, `weave`, `warmth`, `rate` | léger tremblement/flicker — à n'utiliser que pour la scène 1 |

Tous les modifiers : entrée `geometry` + `matrix` optionnelle, sortie `geometry` + `matrix` → se **chaînent** directement derrière un `texture/plane`.

### Post-process (global) — paramètres clés

| Nœud | Défauts / paramètres | Usage |
| :-- | :-- | :-- |
| `postprocess/film-grain` | `noiseIntensity` 0.35, `scanlines…`, `grayscale` | grain global |
| `postprocess/film-texture` | `grain`, `dust`, `scratches`, `blotches`, `rate` 16 | rayures verticales + poussière (les « filets blancs » des scènes vertes) |
| `postprocess/dry-brush` | `coverage`, `speckSize`, `paperColor` | papier tacheté global |
| `postprocess/duotone` | `shadowColor`, `highlightColor`, `balance` | **color-flip plein écran** (scène 1 : bleu/jaune → N&B) en animant `balance`/couleurs |
| `postprocess/halftone` | `radius` 4, `screenAngle` 15, `shape` | trame globale (alternative aux modifiers) |
| `postprocess/rgb-shift` | — | **misregistration** d'impression (halo décalé) |
| `postprocess/glitch` | `active`, `wild` | flicker 2-3 frames avant une coupe |
| `postprocess/color-correction` | `brightness` 0, `contrast` 1, `saturation` 1 | écraser les noirs, pousser les crèmes |
| `postprocess/vignette`, `bloom` | — | bloom sur les lueurs de projecteur (scène 1) ; vignette légère |
| `postprocess/pixelate` | `pixelSize` | éventuel « slot-machine » visuel |
| `postprocess/super8` | `flicker`, `weave`, `warmth`… | scène 1 uniquement |

## 2. Textures & masques

| Nœud | Rôle | Usage |
| :-- | :-- | :-- |
| `texture/image` → `texture/plane` | plan 3D au bon ratio, alpha géré (`transparent`, `alphaCutoff`), entrée **`mask`** | chaque image du dossier |
| **`mask/roto`** | masque dessiné (Bézier, ellipse, rectangle, main levée, pinceau) ; calques avec modes **Add / Subtract / Intersect / Difference**, `feather`, `expansion`, `opacity`, `invert` ; coordonnées **UV**, sortie texture grise | **fenêtres de papier déchiré** (scène 1 cadre penché, scène « visage » déchirure) |
| `texture/apply-mask` | alpha de la texture × masque (+ `invert`) | découpe d'image pour tout ce qui prend une texture |
| `texture/mask` (Channel Mask) | extrait un canal / combine deux textures (and/or/…) | clé de luminance pour les images non détourées |
| `texture/threshold` | `cutoff`, `smoothing`, `invert` | seuil dur → silhouettes noires (podium, lineup, femme rouge) |
| `texture/levels` | in/out black/white, `gamma` | **écraser les noirs / cramer les blancs** avant demi-teinte |
| `texture/color-ramp` | luminance → rampe de couleurs (tri/quadri-chromie) | alternative au duotone : encre → couleur → crème |
| `texture/blur`, `texture/mix` (9 modes dont multiply/screen/overlay), `texture/transform`, `texture/map-range`, `texture/hue-sat-val`, `texture/rgb-curves`, `texture/invert`, `texture/math` | opérateurs | dilatation de masque (blur → threshold), collage de grain de papier en multiply, décalage UV |
| `texture/noise`, `voronoi`, `wave`, `tileable-noise`, `film-grain`, `bloom` | générateurs/filtres | papier bruité / fond sombre procédural si les JPG manquent |

**Astuce « sticker »** : `modifier/outline` (alphaEdge, outside, épaisseur 6–12, couleur crème) suffit sur un PNG détouré. Pour un contour *irrégulier/déchiré*, faire `texture/image` → `texture/threshold` → `blur` → `threshold` (dilate) → `texture/plane` crème derrière.

## 3. Autres briques utiles

- `object/polygon` (bursts, étoiles, cadres déchirés, podium), `curve/array` / `structure/array` (empilements de bursts).
- `modifier/appear` : `drive: trigger`, `mode`, `overshoot` (pop & hold), `stagger` — **l'entrée « pop » sur le temps**.
- `modifier/fracture` + `logic/collision` : **fissures** (scène 3). `physics/chain` + `constraint` : badges/médaille qui se balancent.
- `time/sequence` (steps nommés, ease, timeline exportable) + `time/marker` + `canvas/goto` : enchaînement des 6 canvases ; export vidéo suit les switches.
- `camera` : projection **orthographic** possible → rendu 2D plat des plans.
- `render` : `Aspect/Resolution` dont `Custom` ; `fps`, `frameCount`. → **Custom 1912×800, 30 fps, 1500 images** (50 s).
- Pipeline de génération existant : `tools/gen_*.py` (helpers `node`, `wire`, `v3`, `write`, `merge`) → je produirai la démo par un script `tools/gen_goodboy_demo.py`, y compris les calques `mask/roto` (points Bézier en UV).

## 4. ⚠️ Point bloquant : le chinois

Les polices intégrées (`object/text`, `text/animator`) sont des **JSON three.js
typeface en Latin seulement** (`scripts/convertFonts.mjs` ne garde que ASCII + Latin‑1).
Les caractères chinois ne s'afficheront pas. Il faut **générer un typeface JSON
contenant uniquement nos ~45 caractères** à partir d'une police CJK (`opentype.js` est
déjà une dépendance) puis la charger via `Custom Font (.json)`.

Polices candidates (déjà sur le Mac) : `Songti SC Black` (très gras, empattement),
`Hiragino Sans GB W6` (gras, sans empattement), `STHeiti Medium`. Ce sont des polices
système Apple → OK en local, **à ne pas redistribuer** dans le dépôt. Pour un rendu
« affiche » et un fichier distribuable : **Noto Sans SC Black / Source Han Sans Heavy**
(licence OFL) ou **ZCOOL KuaiLe / Alibaba PuHuiTi Heavy**.

## 5. Plan de test (dès que les images arrivent)

1. 1 image détourée → `plane` → `halftone` → `duotone` → `outline` : valider l'ordre et le rendu.
2. Masque `roto` en papier déchiré sur `plane`.
3. Chaîne post : `film-texture` + `rgb-shift` + `color-correction` + `film-grain`.
4. Texte chinois via typeface JSON maison.
5. Seulement ensuite : les 6 canvases.
