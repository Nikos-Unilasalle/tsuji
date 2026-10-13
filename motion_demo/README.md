# Démo « Title Sequence » — état

Projet : `motion_demo/motion_title_sequence.tsuji` — **hors du catalogue des démos** (images et son trop lourds pour le dépôt de l'app).
À ouvrir dans l'**app desktop** (Load project) : images, police et musique sont nommées `assets/<fichier>` et lues à côté du
`.tsuji` (dossier `assets/` voisin). Le projet et son dossier `assets/` peuvent être déplacés ensemble.

6 canvases = 6 scènes, enchaînées par `Go To Canvas` sur le dernier frame (la 6 reboucle sur la 1). 1912×800 (2.39:1), 30 fps, 50,2 s.
Chaque objet est posé sur le canvas, rangé en chaînes dans un `Frame` par plan (Frame = titre du plan). Un `Merge` n'apparaît que là où il sert : regrouper des objets qu'un seul `Appear` (Stagger) ou un seul `Pivot Transform` doit animer ensemble.

| Canvas | Scène | Frames | Fin (s) |
| :-- | :-- | :-- | :-- |
| 1 | L'Arène — arène, champion, adversaire, coach | 236 | 7,87 |
| 2 | Le Casting — médaille, badges, voiture | 279 | 17,17 |
| 3 | L'Impact — poing, fissures, visage | 261 | 25,87 |
| 4 | La Cible — lanceuse, fléchette, montre, costume, cible | 279 | 35,17 |
| 5 | Le Chaos — lunettes, boule de bowling 3D, jambes, bursts, visages | 226 | 42,70 |
| 6 | Podium & titre | 225 | 50,20 |

Musique : `assets/music.m4a` (103 BPM, 1er temps à 0,91 s), un seul fichier : chaque canvas a un `Audio Player` ancré à la frame 0 dont
`Start in File` / `Stop in File` valent le début et la fin de la scène dans le morceau. Les frontières de scènes tombent sur des mesures. Chaque scène est retimée par une table `warp=[(frame écrite, frame finale)…]` pour que ses coupes tombent sur les temps.

## Régénérer

```bash
python3 tools/prep_goodboy_assets.py ~/Desktop/motion/img   # photos → motion_demo/assets/ (détourage conservé, rognage, 1100 px)
python3 tools/gen_goodboy_demo.py                           # écrit le .tsuji + le sous-ensemble de police (Noto Sans SC Black)
```

Le texte (chinois simplifié) est dans `tools/gen_goodboy_demo.py`; les glyphes utilisés sont extraits automatiquement.

## À savoir (Tsuji)

- Une keyframe porte l'easing **avec lequel on arrive** sur elle : le premier segment est toujours façonné par l'easing de la 2ᵉ clé.
  (Avant, l'easing de la 1ʳᵉ clé façonnait le 1ᵉʳ segment : un `hold` sur la 1ʳᵉ clé figeait toute l'animation. Corrigé ; les anciens
  fichiers sont migrés à l'ouverture.)
- `Channel Mask` sort sur le socket `mask` (pas `texture`) : un câble vers un socket inexistant est ignoré sans message.
- Les nœuds texture qui conservent l'alpha (Levels, Blur, Color Ramp…) le déclarent maintenant : `Outline` et `Dual Tone` voient
  le détourage même après eux.
- Le nœud Text accepte un `.ttf`/`.otf` directement (glyphes convertis à la demande) ; le sous-ensemble JSON reste utilisable.
- `Audio Player` : `Start in File` / `Stop in File` (s) découpent la zone jouée — un seul morceau pour tous les canvases ; le son suit la timeline (silence en pause, reprise au point de départ quand la timeline revient).
- `GB_MODE=served` écrit des chemins `demos/goodboy/…` (test web jetable : lien symbolique `public/demos/goodboy` → `motion_demo/assets`).

## Nœuds natifs utilisés (et ce qu'ils remplacent)

| Besoin | Nœuds | Remplace |
| :-- | :-- | :-- |
| Entrée « pop » de chaque élément | `Appear` (progress animé 0→1, Overshoot, Stagger) | 3 keyframes de scale par élément |
| Cinq badges / chiffres de la cible qui sortent l'un après l'autre | `Merge` → un seul `Appear` avec `Stagger` | une entrée décalée à la main par élément |
| Traits (sillage de la voiture, éclair, éclat) | `Curve from Points` → `Curve to Line` | des `Texture to Plane` étirées en barres |
| Rayons de vitesse | un trait + `Array` (circulaire) | N barres posées une à une |
| Cible (anneaux) | `Curve Primitive` → `Curve Array` → `Curves to Lines` | polygones à 72 côtés |
| Fissures | `Curve from Points` (segments droits) → `Curve to Mesh`, paramètre `End` animé : elles se propagent du point d'impact vers le bas, une branche partant quand la pointe de sa mère l'atteint | — |
| Croix, soulignement, étoile gribouillée | `Grease Pencil` (frames dessinées) | barres de plans étirées |
| Balancement médaille, badges, bannières, montre | `Oscillator` → `Pivot Transform` | une keyframe de rotation toutes les 3 images |
| Tremblement du papier découpé | `Wiggle` (temps par pas de 2 images) → Matrix | — |
| Glissades d'entrée | `Compose Matrix` animé (+ `Matrix Math` pour cumuler avec Wiggle) | keyframes de location par élément |
| Boule de bowling | `Rolling` (rotation déduite de la position) | rotation calculée en Python |
| Projecteur Super 8 sur la plaque N&B | `Super 8` | flash keyframé à la main |

Keyframes : 2763 → 681.
