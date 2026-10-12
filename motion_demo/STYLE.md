# Style notes — « Goodboy » title sequence (JTBC, 2026)

Source : `~/Desktop/goodboy generique.mp4` — 1276×718, 30 fps, 50.2 s, stéréo AAC.
Analyse : 100 images (2 i/s) + détection du tempo audio. Les timecodes sont ceux de la vidéo.

## 1. En une phrase

Un générique de série **« collage de papier imprimé »** : photos réalistes écrasées en
**noir & blanc demi-teinte**, découpées comme des autocollants, posées sur des **éclats
(bursts) en aplats de 5 couleurs**, le tout rythmé à la beat sur une **grille de
papier vieilli, grain et rayures de pellicule**. Chaque plan = un objet/personnage,
une explosion de couleur derrière, un nom qui claque à côté. Esprit **affiche de boxe
soviétique × comics pop-art × sérigraphie**.

## 2. Format

- Cadre **2.39:1 letterboxé** dans du 16:9 (bandes noires haut/bas ≈ 90 px sur 718).
  → dans Tsuji : nœud `Render` en résolution **Custom 1912×800** (2.39:1) ; la vue lettrebox le reste en noir. (`utility/frame` n'est qu'un cadre de rangement dans l'éditeur de graphe, pas un cadre de rendu.)
- 30 fps. Tout est « step » : le mouvement est saccadé/frappé, jamais lisse.
- Durée 50 s ≈ **103 BPM** (un battement ≈ 0,58 s). Les coupes tombent sur les temps et
  demi-temps (0,29 s).

## 3. Palette (approx. échantillonnée)

| Rôle | Hex approx. | Usage |
| :-- | :-- | :-- |
| Encre / nuit | `#121c1f` | fond principal « sombre », ombres des photos |
| Papier crème | `#dcd8c4` | fond clair, cartouche titre, lumières des photos |
| Bleu pétrole | `#2c85a5` | bursts, contours « sticker », fond scène 1/5 |
| Moutarde | `#e8a91f` | bursts, médaille, badges, texte nom |
| Cramoisi | `#c4123a` | fonds pleins scène « cible », bursts, talon, voiture |
| Vert jade | `#15a864` | fonds pleins scène « badges/fusil », gant, podium |
| Rose vif | `#e0245e` | micro-étoiles (accent rare) |

Règles : **jamais plus de 3 couleurs + encre/crème par plan**. Un plan = un fond plein
dominant (rouge, vert, bleu **ou** sombre) ; les autres couleurs n'apparaissent que dans
les bursts. Les photos sont **toujours N&B** ; seuls les objets-accessoires (médaille,
gant, voiture, talon, montre) reçoivent **un aplat de couleur** (bichromie encre → couleur).

## 4. Traitement des photos (le « look »)

1. **Noir & blanc à fort contraste**, noirs bouchés, blancs cramés (levels agressifs).
2. **Trame demi-teinte** visible (grain de points / lignes) surtout dans les gris moyens et
   sur les accessoires monochromes (médaille jaune+encre, gant vert+encre).
3. Parfois **dessin / gravure** (portraits « hachurés » façon encre) : bord de visage
   gravé, cheveux en traits. → Halftone + Threshold + léger Dry Brush.
4. **Détourage « sticker »** : contour crème épais irrégulier (ou bleu pétrole) autour du
   sujet, bord dentelé comme du papier déchiré (scène 2, portrait du policier, jambes).
5. **Bichromie de lumière** (scène 1) : la photo large passe bleu/jaune → N&B → crème
   (animation de rampe de couleurs sur ~2 s).
6. Aucune ombre portée réaliste ; le relief vient du **décalage de misregistration**
   (halo décalé de 2–4 px, bords sales).

## 5. Fonds & matière

- **Papier** : texture crème tachetée, grain fin, petites taches rouille, bords usés.
- **Fond sombre** : encre bleu-noir granuleuse avec poussière blanche.
- **Rayures verticales de film** blanches fines (scènes vertes), flashs, poussière.
- **Bursts / éclats** : polygones en étoile à pointes irrégulières (7–12 pointes),
  **empilés en 2–3 couches décalées** (bleu + moutarde + crème ; rouge + moutarde).
  Ils pivotent, grossissent par à-coups, bord rugueux imprimé.
- **Papier déchiré** : fenêtre irrégulière (polygone à bords cassés) qui révèle l'image :
  scène 1 (cadre penché), scène « visage » (déchirure noire), cartouche titre.
- **Étoiles à 4/8 branches** (scintillement) : rouge, bleu, crème, moutarde, jade — petites,
  qui apparaissent/disparaissent à chaque temps ; grosse étoile qui traverse l'écran au
  début.
- **Lignes de vitesse** (speed lines) blanches/grises convergentes derrière les objets
  rapides (balle, voiture, visage de la scène 4).
- **Fissures** blanches fines qui se propagent sur fond noir (impact du poing, 12–20 s).

## 6. Typographie

- **Noms de casting** : gras compact, sans empattement, style affiche (Hangul bold),
  **200–260 px de large**, alignés à côté du sujet, **jamais centrés**. Entrée en
  **« slot-machine »** : les caractères défilent/clignotent avant de se fixer
  (`김소` → `김소현`) en ~0,3 s. Couleurs : crème sur sombre, **encre sur crème/rouge/bleu**,
  **moutarde sur rouge**.
- **Titre final** : lettres massives noires sur cartouche papier crème déchiré, avec
  petit surtitre (logo chaîne + « Saturday-Sunday drama ») et frise de **pictogrammes de
  sports** colorés (escrime, boxe, tir…) glissés dans la barre sous le titre.
- Micro-texte typographique : chiffres de cible (7 8 9 X), `1` sur le podium, minuscules,
  fins, blanc.

## 7. Mouvement (la grammaire)

| Geste | Description | Durée |
| :-- | :-- | :-- |
| **Smash-in** | un objet entre par un bord à grande vitesse + flou de mouvement directionnel, freine net | 0,2–0,3 s |
| **Pop & hold** | burst arrive en scale-pop (0 → 110 % → 100 %), le sujet se cale dessus | 0,3 s |
| **Slide-through** | un plan « pousse » le précédent (swipe diagonal sur fond couleur) | 0,3 s |
| **Zoom cut** | recadrage serré brutal (gros plan visage / poing) | 1 frame |
| **Color-flip** | le fond passe d'une couleur pleine à une autre sur le temps | 1 frame |
| **Flicker** | scintillement de rayures/lueurs 2-3 frames avant un cut | 0,1 s |
| **Stack/fan** | n copies décalées en éventail (5 badges accrochés avec petit balancement) | 1 s |
| **Hang-sway** | objet pendu (médaille, badge) qui oscille comme un pendule amorti | 1,5 s |
| **Crack grow** | fissures qui se propagent depuis l'impact | 1,5 s |
| **Hold final** | titre immobile ~3 s, scintillement d'étoiles seul | 3 s |

Ritmique : **un nouveau « beat visuel » tous les 2 temps (≈ 1,15 s)**, une coupe franche
toutes les 4 temps (≈ 2,3 s). Presque toutes les entrées se font **sur le temps**.

## 8. Découpage par séquences (50 s)

| # | Temps | Contenu | Fond dominant |
| :-- | :-- | :-- | :-- |
| A | 0–4 s | Arène large, symétrique, personnage de dos au centre, 3 bannières ; lavis bleu/jaune → N&B ; étoiles qui scintillent ; cadre papier penché | bleu/jaune → N&B |
| B | 4–10 s | Boxeur bras levés sur burst bleu/jaune ; plan serré visage + burst rouge ; policier gravé avec contour bleu, nom à droite | encre sombre |
| C | 10–15 s | Médaille pendue sur burst blanc ; transition vert ; badge unique → 5 badges en éventail | encre → vert/blanc |
| D | 15–22 s | Voiture rouge traverse (vert) ; poing vert frappe voiture sur crème avec bursts ; poing perce le sol noir, fissures | crème → noir |
| E | 22–31 s | Fissures → visage de femme dans déchirure + speed lines + nom ; silhouette rouge qui tire ; balle ; montre dorée ; homme en costume + gros X ; cible concentrique | noir → **rouge** |
| F | 31–40 s | Bleu, lunettes, bras tendu ; boule de bowling ; jambes talons ; nom ; burst bleu/rouge/jaune, personnages comiques qui courent/lèvent les bras | rouge → bleu/jaune |
| G | 40–44 s | Fond vert : visage choqué, poing, deux visages + fusil, scooter | **vert** |
| H | 44–50 s | Podium : 5 silhouettes sur burst bleu/jaune/rouge devant 3 bannières → noir → cartouche papier → **titre** + étoiles ; hold | rouge/bleu → crème |

## 9. Son (pour la musique à fournir)

- ≈ **103 BPM**, 50 s, tonalité mineure, énergie **funk/big-band stompy** : basse
  slappée, cuivres staccato, caisse claire sèche, clappements, coups de gong/« hits »
  sur chaque coupe.
- Structure : intro de 2 mesures (arène, tension) → groove principal → montée à 40 s →
  **stop net** avant le titre → accord final tenu 3 s avec cymbale.
- Pour Tsuji : un `Sound Player` + `Peak Detector` / `Spectrum` pilotent les pops sur
  les hits ; sinon cut sur grille de 0,58 s.

## 10. Traduction Tsuji (outillage identifié dans le repo)

| Besoin | Nœud Tsuji |
| :-- | :-- |
| Photo → plan 3D à ratio juste | `texture/image` → `texture/plane` (alpha PNG géré) |
| Contraste dur / seuil | `texture/levels`, `texture/threshold`, `texture/hue-sat-val` |
| Trame demi-teinte | `modifier/halftone` / `postprocess/halftone` |
| Bichromie encre→couleur | `modifier/duotone`, `texture/color-ramp` |
| Gravure / pinceau sec | `modifier/dry-brush` |
| Contour « sticker » papier | `modifier/outline` / `curve/stroke-outline` sur masque (blur→threshold) ; `mask/roto` pour détourer à la main |
| Fenêtre de papier déchiré | `object/polygon` + `texture/apply-mask` |
| Bursts / étoiles | `object/polygon` + `curve/array` / `structure/array` |
| Grain, poussière, rayures | `postprocess/film-grain`, `film-texture`, `super8` |
| Noms « slot-machine » | `text/animator` + `text/range-selector` |
| Fissures + impact | `modifier/fracture` + `logic/collision` (demo_physics_fracture_collision) |
| Balancement médaille/badge | `physics/chain` + `physics/constraint` (demo_physics_chain) |
| Enchaînement des 6 scènes | **6 canvases** + `canvas/goto` piloté par `time/sequence` / `time/marker` |
| Cadre 2.39:1 | `render` → Aspect/Resolution `Custom` 1912×800 |
| Musique | `sound/player` → `sound/peak-detector` |
