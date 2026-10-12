# Prompts d'images — démo « TSUJI vs AFTER EFFECTS »

## Concept

Un **faux générique de série** (même grammaire que Goodboy) : un **combat de boxe** entre
le motion designer et **After Effects** (la boule de chargement, le rendu de 40 minutes).
Le casting = les features de Tsuji (Fracture, Physics, Halftone…) : chaque « acteur »
apparaît avec son nom. Fin : le designer monte sur le podium, **titre TSUJI**.
Slogan final : *« 告别时间轴，来玩吧。 »* (Quittez le timeline. Jouez.). Tous les textes sont en **chinois simplifié** (voir section Textes).

Les 6 scènes = les **6 canvases** d'un seul `.tsuji` (`canvas/goto` les enchaîne) :

| Canvas | Scène | Durée | Images utilisées |
| :-- | :-- | :-- | :-- |
| 1 | **L'Arène** | 0–8 s | 01, 02, 03 |
| 2 | **Le Casting** (médaille, badges) | 8–17 s | 04, 05, 06, 07a–e, 08 |
| 3 | **L'Impact** (poing + fissures) | 17–26 s | 09, 10 |
| 4 | **La Cible** (rouge) | 26–35 s | 11, 12, 13, 14 |
| 5 | **Le Chaos** (bleu/rouge/jaune) | 35–43 s | 15, 17, 18 (+ boule de bowling 3D) |
| 6 | **Le Podium + Titre** | 43–50 s | 19, 20, 21 |

## Règles pour TOUTES les images

- **Réalistes** (photo), PAS stylisées : la stylisation (demi-teinte, bichromie, contours,
  grain) est faite dans Tsuji.
- **Contraste dur**, lumière directionnelle franche, détails nets, **aucun texte, logo,
  filigrane**.
- **Personnages originaux, fictifs** (pas de ressemblance à des personnes réelles).
- Sujets isolés : **fond blanc pur uni (#FFFFFF)**, sujet entier, aucune ombre au sol.
  → Ensuite **détourez** (aperçu macOS « Supprimer l'arrière-plan », rembg, remove.bg…) et
  enregistrez en **PNG avec transparence**. Si votre outil sort déjà du PNG transparent,
  parfait. Gardez aussi l'original blanc si possible (`_white.png`).
- Format : 16:9 pour les scènes larges, **3:4 vertical** pour portraits/corps, **1:1** pour
  objets. Résolution mini 2048 px sur le grand côté.
- Nom de fichier **exactement** celui indiqué (sinon je ne retrouve pas).
- Dossier : `motion_demo/assets/` + musique `motion_demo/assets/music.mp3` (ou .wav).

### Préfixes à coller devant chaque prompt

**`[PHOTO]`** = `Photorealistic editorial photograph, shot on 85mm lens, hard directional key light, deep blacks, high contrast, crisp detail, no text, no logo, no watermark.`

**`[CUTOUT]`** = `[PHOTO] Subject fully isolated on a pure flat white seamless background (#FFFFFF), no floor shadow, no gradient, clean edges, the whole subject visible and not cropped.`

---

## CANVAS 1 — L'Arène

**01_arena_wide.png** — 16:9
> [PHOTO] Wide symmetrical shot of a dark boxing arena seen from the edge of the ring: white ring ropes in the foreground at the bottom, three large blank rectangular banners hanging from a steel lighting truss (one center, one far left, one far right, all completely blank and plain), a dark crowd in the background, two bright stage lights glowing at the bottom left and right corners, haze in the air. In the exact center of the ring, a lone boxer seen from behind in a hooded robe, standing still, facing the empty arena. Perfectly centered composition, cinematic, moody, no text on banners.

**02_boxer_victory.png** — 3:4 — `[CUTOUT]`
> [CUTOUT] Upper body of a young male boxer with short curly dark hair, mouth wide open in a triumphant scream, both arms raised high in the air in victory, wearing a plain dark sleeveless boxing singlet without any text or logo, sweat on skin, viewed from slightly below, wrapped fists.

**03_boxer_face_clinch.png** — 3:4
> [PHOTO] Extreme close-up of a boxer's face with curly dark hair pressed against the shoulder of his opponent in a clinch, eyes shut tight in pain and effort, a black boxing glove covering the lower part of the frame, sweat, strong side light, dark background, no text.

## CANVAS 2 — Le Casting

**04_coach_cap.png** — 3:4 — `[CUTOUT]`
> [CUTOUT] Upper body of a handsome young man in a dark double-breasted peaked captain's cap and dark uniform jacket with white shirt and tie, head turned in three-quarter view looking off to the side with a calm cold expression, one arm extended pointing diagonally, blank cap badge, no text.

**05_gold_medal.png** — 1:1 — `[CUTOUT]`
> [CUTOUT] A large heavy gold medal hanging from a wide dark ribbon, front view, embossed circular relief with abstract wave patterns (no text, no numbers), slightly worn metal, strong specular highlights, ribbon going straight up out of frame.

**06_id_badge_blank.png** — 3:4 — `[CUTOUT]`
> [CUTOUT] A rigid black plastic ID badge holder with a bright yellow lanyard strap going up, front view, vertical card with a blank rectangular photo area in the upper middle (empty light gray) and two blank text lines at the bottom, hexagonal pattern on the card background, no text, no logos.

**07a_headshot_a.png … 07e_headshot_e.png** — 5 images, 1:1 — `[CUTOUT]`
> [CUTOUT] Passport-style frontal headshot and shoulders of {A: a young man with short black hair and a sharp jaw / B: a young woman with a straight black bob and bangs / C: a man with round glasses and a messy side-parted haircut / D: a smiling man with short hair and a round face / E: a young man with soft wavy hair}, wearing a dark plain jacket and white shirt, neutral serious expression, looking straight at camera, flat even lighting. (Generate five separate images, one per description.)

**08_red_sports_car.png** — 16:9 — `[CUTOUT]`
> [CUTOUT] Side profile of a low red sports coupe car seen from the left side, perfectly horizontal, glossy paint with sharp reflections, black wheels, no license plate, no badges, no text.

## CANVAS 3 — L'Impact

**09_fist_wrapped.png** — 16:9 — `[CUTOUT]`
> [CUTOUT] A clenched fist in hand wraps (boxing hand-wraps, plain cloth, no text) punching toward the left of the frame, forearm coming in from the right edge, seen straight from the side, extreme foreshortened knuckles, dramatic hard light, visible fabric texture and veins.

**10_woman_face_intense.png** — 16:9
> [PHOTO] Close-up of a young woman's face, head tilted slightly, short black bob haircut with long wispy bangs hanging over her eyes, piercing direct stare at the camera, dark smudged eye makeup, a small mole on the cheek, lips closed, one bare shoulder, hard side light, plain mid-gray background, no text.

## CANVAS 4 — La Cible (fond rouge)

**11_woman_throwing_pose.png** — 3:4 — `[CUTOUT]`
> [CUTOUT] Full-body side view of a woman in dark wide trousers and a sleeveless top, standing in a stable athletic stance with her right arm fully extended horizontally forward as if throwing, left leg back, short dark hair, strongly backlit so the silhouette reads clearly.

**12_dart_flying.png** — 16:9 — `[CUTOUT]`
> [CUTOUT] A single steel dart with a brass barrel, flight tail and sharp tip, seen from the side, angled slightly downward to the right, polished metal highlights, extremely sharp macro detail, no text, no markings.

**13_gold_watch.png** — 1:1 — `[CUTOUT]`
> [CUTOUT] Front view of a luxury gold sports wristwatch with an octagonal bezel and visible screws, intricate guilloche rosette dial, no brand name, no text, no numerals, hands pointing at ten past ten, no strap visible, macro.

**14_suit_torso.png** — 3:4 — `[CUTOUT]`
> [CUTOUT] Torso of a man in a black suit, black tie and white shirt, head cropped out of frame above the collar, both hands in front of the belly buttoning the jacket, a gold wristwatch on the left wrist (no brand text), dark fabric texture, hard light.

## CANVAS 5 — Le Chaos

**15_man_glasses_pointing.png** — 3:4 — `[CUTOUT]`
> [CUTOUT] Upper body of a young man with black round glasses and wet slicked-back dark hair, wearing a black polo shirt, one arm fully extended forward pointing, intense serious expression, three-quarter view.

**16_bowling_ball** — ~~supprimée~~ : la boule est faite en **3D dans Tsuji** (sphère marbrée + 3 trous, qui roule via `physics/rolling`). Ne pas générer.

**17_legs_red_heels.png** — 3:4 — `[CUTOUT]`
> [CUTOUT] Woman's crossed legs from the thigh down in black tights and bright red stiletto high heels, seated, one foot lifted, seen from the side, fashion photography, hard light, no face.

**18_man_arms_up_joy.png** — 3:4 — `[CUTOUT]`
> [CUTOUT] Full body of a short stocky man in a striped t-shirt and dark trousers, both arms raised above his head, mouth wide open screaming with comic joy, standing on his toes, front view.

## CANVAS 6 — Le Podium + Titre

**19_five_lineup.png** — 16:9 — `[CUTOUT]`
> [CUTOUT] Five people standing in a perfectly straight horizontal line, full body, seen from the front, evenly spaced, arms along the body, in dark casual clothes (different heights: one woman, four men), neutral posture, strongly backlit so each body reads as a clean dark silhouette.

**20_paper_cream.jpg** — 16:9 (texture, no cutout)
> Flat scan of an old cream-colored paper sheet, very fine speckled grain, tiny rust-brown stains, slightly worn edges, even lighting, no folds, no text, top-down view.

**21_paper_dark_grain.jpg** — 16:9 (texture, no cutout)
> Flat top-down texture of a dark blue-black charcoal paper with coarse grain, scattered white dust particles and very faint scratches, even lighting, no text.

### Bonus (optionnel, si le temps le permet)

**22_film_scratches.png** — 16:9
> Black background with thin vertical white film scratches, dust specks and hair fibers, 35mm film damage overlay, no other content.

**23_stamp_ink_texture.jpg** — 1:1
> Close-up of distressed black ink on rough paper, uneven coverage with speckled gaps, for use as a print texture, no text.

---

## Textes (tout en chinois simplifié)

Les images restent **sans texte** : tout le texte est généré dans Tsuji (`object/text`,
`text/animator`). Police : une **gras compact CJK** (ex. Alibaba PuHuiTi Heavy, Source Han
Sans Heavy, ZCOOL KuaiLe) → à déposer dans `motion_demo/assets/font.ttf|otf` si vous en
avez une préférée ; sinon je prends une libre.

| Scène | Texte | Sens |
| :-- | :-- | :-- |
| 1 | `第一回合` | Round 1 |
| 1 | `后期特效` (bannière, barré/fissuré) | After Effects |
| 2 | `节点` · `实时` · `物理` · `粒子` · `半调` (noms de casting, 1 par badge/portrait) | Nodes · Temps réel · Physique · Particules · Halftone |
| 2 | `演职员表` | Générique / Casting |
| 3 | `碎裂` | Fracture |
| 4 | `渲染中… 40:00` → `0.016 秒` | Rendu 40 min → 16 ms |
| 5 | `没有时间轴` | Pas de timeline |
| 6 (podium) | `冠军` | Champion |
| 6 (titre) | `TSUJI` + sous-titre `节点动画工作室` | Studio d'animation nodal |
| 6 (slogan) | `告别时间轴，来玩吧。` | Quittez le timeline. Jouez. |

Si l'un de ces mots ne vous plaît pas, dites-le avant que je construise le document.

## Musique

`motion_demo/assets/music.mp3` — **50 s** (±3), **≈ 103 BPM**, mineur, funk/big-band
staccato (basse, cuivres, claps, gros hits sur les coupes), montée vers 38 s, **stop net**
à 43 s, accord final tenu. Prompt Suno/Udio :

> Retro funk big-band title sequence theme, 103 BPM, minor key, slapped bass, staccato brass stabs, dry snare and hand claps, stompy cinematic hits on every cut, 8-bar tense intro, build-up with snare roll, sudden full stop, final held brass chord with cymbal swell, instrumental, 50 seconds, vintage 1970s spy-film energy.
