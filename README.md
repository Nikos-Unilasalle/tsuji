# Tsuji

Moteur de Studio 3D et Node Graph Temps Réel pour le Vidéo-Mapping, la Data-Visualisation, l'Animation Paramétrique et les Arts Numériques.

Disponible directement en ligne sur le Web et en application Desktop haute performance (Tauri 2, React 19, Three.js, Vite 7, TypeScript).

* **Version en ligne (Web App)** : [https://nikos-unilasalle.github.io/tsuji/](https://nikos-unilasalle.github.io/tsuji/)
* **Version Desktop** : macOS, Windows, Linux via Tauri v2.

---

## Sommaire

1. [Présentation du Logiciel](#présentation-du-logiciel)
2. [Stack Technique](#stack-technique)
3. [Architecture et Moteur d'Évaluation](#architecture-et-moteur-dévaluation)
4. [Types de Sockets et Données](#types-de-sockets-et-données)
5. [Catalogue Exhaustif des Nœuds (Nodes)](#catalogue-exhaustif-des-nœuds-nodes)
   - [Structure et Primitives 3D](#structure-et-primitives-3d)
   - [Édition Géométrique et Opérations CSG](#édition-géométrique-et-opérations-csg)
   - [Import Vectoriel et SVG](#import-vectoriel-et-svg)
   - [Points, Sélection et Connectivité](#points-sélection-et-connectivité)
   - [Physique et Raycasting](#physique-et-raycasting)
   - [Animation, Mouvement et Dynamique (Spring, Trail, Orbit)](#animation-mouvement-et-dynamique-spring-trail-orbit)
   - [Courbes, Morphing et Shape Keys](#courbes-morphing-et-shape-keys)
   - [Lumières, Matériaux et Environnement](#lumières-matériaux-et-environnement)
   - [Instanciation et Formations (Array & Spawner)](#instanciation-et-formations-array--spawner)
   - [Système de Particules, Champs de Forces et Trajectoires](#système-de-particules-champs-de-forces-et-trajectoires)
   - [Caméra et Calibration Vidéo-Mapping (DLT)](#caméra-et-calibration-vidéo-mapping-dlt)
   - [Data-Visualisation et Graphiques](#data-visualisation-et-graphiques)
   - [Post-Traitement et Shaders GPU](#post-traitement-et-shaders-gpu)
   - [Audio et Analyse Spectrale (FFT)](#audio-et-analyse-spectrale-fft)
   - [Mathématiques, Vecteurs et Logique](#mathématiques-vecteurs-et-logique)
   - [Listes et Manipulation de Données](#listes-et-manipulation-de-données)
   - [Texte, Typographie et Entrées/Sorties](#texte-typographie-et-entrées-sorties)
   - [Utilitaires et Organisation](#utilitaires-et-organisation)
6. [Moteur d'Animation Paramétrique et Studio 3D](#moteur-danimation-paramétrique-et-studio-3d)
7. [Raccourcis Clavier](#raccourcis-clavier)
8. [Installation, Tests et Déploiement](#installation-tests-et-déploiement)
9. [Licence](#licence)

---

## Présentation du Logiciel

Tsuji est un environnement de création nodale temps réel dédié à la scénographie numérique, au vidéo-mapping architectural, à la data-visualisation 3D et aux installations interactives.

Accessible instantanément depuis un navigateur web moderne ou compilé en application desktop native avec Tauri v2, Tsuji combine la puissance de rendu Three.js avec la réactivité d'un graphe de flux de données acyclique (DAG). Chaque élément visuel, transformation spatiale, comportement physique, modulation sonore et passe de post-traitement est piloté de manière déclarative par les interconnexions de nœuds.

---

## Stack Technique

- **Core UI & Logic** : React 19, TypeScript, Vite 7
- **Rendu 3D & Moteur Graphique** : Three.js (r185), `three-mesh-bvh`, `three-bvh-csg`
- **Physique** : Rapier (`@dimforge/rapier3d-compat`, WASM) pour les corps rigides ; contrôleur de personnage cinématique maison sur BVH
- **Graphe Nodal & Éditeur** : `@xyflow/react` v12
- **Gestion d'État** : Zustand v5
- **Application Native** : Tauri 2 (Rust)
- **Suite de Tests** : Vitest v4
- **Parsing & Format** : PapaParse (CSV), Opentype.js, UUID

---

## Architecture et Moteur d'Évaluation

Le graphe de Tsuji fonctionne selon un pipeline d'évaluation trié topologiquement et exécuté à chaque rafraîchissement d'image (60 FPS) :

1. **Résolution des Dépendances** : Le graphe trie les nœuds de la source vers les puits. Les cycles sont détectés et traités sans bloquer l'exécution.
2. **Propagations et Fallbacks** : Si une prise d'entrée n'est pas connectée, la valeur provient du paramètre local du nœud ou de sa valeur par défaut.
3. **Caches de Géométrie et GPU Hygiene** : Les géométries, textures, frames de Frenet, shaders et simulateurs de particules sont mis en cache par identifiant de nœud (`nodeId`) et recyclés intelligemment pour éviter les allocations mémoire superflues.
4. **Isolation Live-Edit** : Pendant la manipulation d'un gizmo dans la vue 3D, la matrice de l'objet manipulé est préservée temporairement pour permettre l'écriture inverse sans écrasement par le graphe.

---

## Types de Sockets et Données

Les prises de connexion (sockets) sont identifiées par des codes couleur normalisés :

| Type de Socket | Identifiant | Description | Format de Donnée |
| :--- | :--- | :--- | :--- |
| **Scalaire** | `value` | Nombre flottant ou entier, booleen (0/1) | `number` |
| **Vecteur** | `vector` | Coordonnées 3D (X, Y, Z) | `THREE.Vector3` |
| **Matrice** | `matrix` | Matrice de transformation 4x4 | `THREE.Matrix4` |
| **Couleur** | `color` | Valeur chromatique RGB/RGBA | `THREE.Color` |
| **Géométrie** | `geometry` | Objet 3D, Mesh, Group ou Line Three.js | `THREE.Object3D` |
| **Texture** | `texture` | Texture bitmap, carte de normale ou canvas | `THREE.Texture` |
| **Courbe** | `curve` | Trajectoire 3D continue paramétrable | `THREE.Curve<THREE.Vector3>` |
| **Liste** | `list` | Tableau ordonné d'éléments | `Array<unknown>` |
| **Texte** | `text` | Chaîne de caractères | `string` |
| **Polymorphe** | `any` | Socket adaptatif acceptant tout format | `unknown` |

---

## Catalogue Exhaustif des Nœuds (Nodes)

### Structure et Primitives 3D

| Node | Type | Description |
| :--- | :--- | :--- |
| **Box** | `object/box` | Pavé 3D paramétrable (largeur, hauteur, profondeur) avec matériaux PBR et textures. |
| **Plane** | `object/plane` | Plan 2D dans l'espace 3D avec plaquage UV et options double face. |
| **Sphere** | `object/sphere` | Sphère 3D avec contrôle du rayon et des segments de résolution. |
| **Cylinder** | `object/cylinder` | Cylindre 3D avec rayons haut/bas configurables et facettes radiales. |
| **Cone** | `object/cone` | Cône 3D avec ajustement du rayon de base et de la hauteur. |
| **Disc** | `object/disc` | Disque circulaire 2D avec rayon et nombre de segments. |
| **Text 3D** | `object/text` | Typographie vectorielle extrudée en 3D avec biseau configurable. |
| **Empty** | `object/empty` | Repère spatial invisible, pivot ou cible d'éclairage. |
| **OBJ Model** | `object/obj` | Importateur de fichiers 3D au format Wavefront `.obj`. |
| **Frozen Geometry** | `object/frozen` | Géométrie figée en mémoire pour optimisation du rendu. |
| **3D Grid** | `calibration/grid` | Grille de repère spatial 3D manipulable au gizmo. |
| **Merge** | `structure/merge` | Fusionne plusieurs flux géométriques en une seule hiérarchie. |
| **Render** | `render` | Sortie terminale et configuration globale du rendu. |
| **Tree (Parametric)** | `object/tree` | Arbre paramétrique récursif : tronc et branches tubés en un seul maillage, feuillage en cartes instanciées découpées procéduralement, le tout ployant dans le vent. **8 ports de croissance** (chêne, cerisier en touffes, conifère, saule, bouleau, palmier, buisson, arbre mort) qui modifient le comportement de la récursion — flèche centrale, retombée, absence de ramification — sans jamais écraser les réglages de l'auteur. **7 formes de feuilles** paramétriques (amande, ovale, ronde, aiguille, lancéolée, cordée, érable) avec largeur, acuité de pointe et retombée, découpées dans le fragment shader. Deux modes de feuillage : dispersé, ou en **touffes sphériques** aux extrémités (biais vers la surface + orientation sortante, pour une masse crédible). **Rampe saisonnière** été → or → rouge avec décalage par feuille, et **dégradé vertical de canopée** (chaque feuille connaît sa hauteur dans le houppier). Échelle maîtresse (`Size`), empattement, profil d'effilement, profondeur de feuillage, phototropisme. |
| **Grass Field** | `structure/grass-field` | Champ d'herbe dense en un seul draw call : 3 sommets par brin reconstruits dans le vertex shader, repliement torique autour d'un centre mobile (champ infini à coût constant) et carte de densité pour peindre les zones enherbées. |
| **Interaction Map** | `texture/interaction-map` | Carte top-down persistante de ce qui est passé au sol : rendu orthographique zénithal en ping-pong, pinceau instancié, estompage en demi-vie (indépendant du framerate) et défilement suivant un centre mobile. Se branche sur `Trample Map` de Grass Field, ou sur n'importe quel nœud consommant une texture. |
| **Wind Sway** | `geometry/wind-sway` | Fait ployer n'importe quelle géométrie du graphe dans le vent, par injection shader (`onBeforeCompile`) — aucun sommet n'est recalculé sur CPU. Masque vertical ancré (Anchor Y / Height / Stiffness). |

### Édition Géométrique et Opérations CSG

| Node | Type | Description |
| :--- | :--- | :--- |
| **Boolean CSG** | `geometry/boolean` | Opérations booléennes 3D (Union, Difference, Intersection) via BVH-CSG. |
| **Subdivide** | `geometry/subdivide` | Subdivise le maillage pour augmenter la résolution des sommets. |
| **Extrude Mesh** | `geometry/extrude` | Extrude les faces ou arêtes d'une géométrie selon un vecteur ou une normale. |
| **Delete Geometry** | `geometry/delete` | Supprime des sommets/faces selon des critères ou des masques de sélection. |
| **Shade** | `geometry/shade` | Modifie le mode d'ombrage (Flat Shading vs Smooth Shading) et recalcule les normales. |
| **Visual Slice** | `geometry/visual_slice` | Découpe visuelle 3D de la scène par des plans de coupe animables. |
| **Edit Mesh Points**| `geometry/edit_points` | Édition directe des coordonnées de sommets d'un maillage. |

### Import Vectoriel et SVG

| Node | Type | Description |
| :--- | :--- | :--- |
| **SVG to Curves** | `svg/to_curves` | Importe des fichiers vectoriels SVG et les convertit en trajectoires 3D. |
| **SVG to Mesh** | `svg/to_mesh` | Convertit un tracé SVG en surface 2D planifiée. |
| **SVG to Solid** | `svg/to_solid` | Extrude un tracé SVG vectoriel en objet 3D volumétrique. |

### Points, Sélection et Connectivité

| Node | Type | Description |
| :--- | :--- | :--- |
| **Mesh to Points** | `points/from_mesh` | Convertit les sommets d'un maillage 3D en liste de points. |
| **Points to Mesh** | `points/to_mesh` | Reconstruit un maillage ou nuage à partir de points 3D. |
| **Points Selection**| `points/selection` | Sélectionne des points par masque, sphère d'influence ou bruit. |
| **Points Influence**| `points/influence` | Calcule le facteur d'attraction/répulsion par rapport à des cibles. |
| **Connect Nearby** | `connectivity/nearby` | Interconnecte les points proches par un réseau de lignes/segments filaires. |

### Physique et Raycasting

| Node | Type | Description |
| :--- | :--- | :--- |
| **Raycast** | `physics/raycast` | Lance un rayon unique et détecte les intersections (point, normale, distance). |
| **Ray Burst** | `physics/ray-burst` | Émet un champ de rayons (burst) 3D et produit les lignes d'impacts et endpoints. |
| **Sample Surface** | `physics/sample` | Échantillonne des points et normales aléatoires à la surface d'un maillage (Surface Scatter). |
| **Physics World** | `physics/world` | Monde de corps rigides **Rapier** (WASM). Pas de simulation à la main : empilement, contacts au repos, frottement et articulations sont chacun difficiles et collectivement un projet de recherche. Pas de temps **fixe** avec report du reste entre les frames — un pas variable fait qu'une pile de caisses se stabilise différemment à 60 et à 144 fps, et qu'un export ne ressemble pas à la preview dans laquelle il a été composé. Nombre de sous-pas plafonné pour qu'une frame longue soit abandonnée plutôt que rattrapée en spirale. |
| **Rigid Body** | `physics/rigid-body` | Confie une géométrie au monde et la déplace selon le solveur. Types `dynamic` / `fixed` / `kinematic`, formes `auto` (enveloppe convexe pour un corps dynamique, maillage de triangles pour un corps fixe), `box`, `sphere`, `capsule`, `hull`, `trimesh`. Masse, frottement, rebond, amortissements, échelle de gravité, CCD. **L'échelle de l'objet est intégrée au collider** — un corps Rapier ne porte que position et rotation. |
| **Character (Physics)** | `physics/character` | Capsule cinématique déplacée par le contrôleur de personnage de Rapier. Apporte les trois choses qu'un balayage maison n'a pas gratuitement : **marche automatique** (escaliers et bordures franchis sans modéliser de rampes invisibles), **accrochage au sol** (descendre une pente garde le contact au lieu de sauter à chaque rupture) et **impulsions aux corps dynamiques** (le personnage pousse les caisses). Entre en collision avec tout ce qui est dans le monde : pas d'entrée collider séparée à garder synchronisée avec ce qui est à l'écran. |
| **Capsule Controller** | `physics/capsule-controller` | Personnage cinématique à capsule : marche sur les sols, glisse le long des murs, saute, tombe des rebords. Collision CPU contre un BVH (`three-mesh-bvh`), test mené en espace monde pour rester correct sur les colliders à échelle non uniforme. Sorties position, matrice, vitesse, `grounded` et normale du sol. |
| **Volume Scatter** | `physics/volume_scatter` | Échantillonne des points et directions aléatoires à l'intérieur du volume 3D d'une géométrie. |
| **Wind Field** | `physics/wind-field` | Champ de vent global (deux octaves de bruit défilant selon une direction) partagé par toute la scène. Sortie `field` pour les shaders de végétation, sortie `wind` (vecteur, échantillonné CPU) pour piloter transforms, champs de force et logique. |

### Animation, Mouvement et Dynamique (Spring, Trail, Orbit)

| Node | Type | Description |
| :--- | :--- | :--- |
| **Orbit** | `motion/orbit` | Génère un mouvement orbital circulaire ou elliptique autour d'un pivot. |
| **Stagger** | `motion/stagger` | Décale temporellement l'animation de multiples éléments ou instances. |
| **Time Remap** | `motion/time_remap` | Recadre et applique des courbes d'assouplissement (easing) au temps. |
| **Spring** | `motion/spring` | Simulation physique de ressort scalaire avec masse, raideur et amortissement. |
| **Spring Vector** | `motion/spring_vector` | Simulation de ressort 3D sur un vecteur position (effet de suivi fluide). |
| **Velocity** | `motion/velocity` | Calcule les déltas de vitesse et d'orientation d'un objet en mouvement. |
| **Trail** | `motion/trail` | Génère une traînée ou un ruban persistant derrière un objet en déplacement. |
| **Squash & Stretch**| `motion/squash` | Effet d'écrasement et d'étirement préservant le volume selon la vitesse. |
| **Wiggle** | `animation/wiggle` | Bruit fractal (fBm) pilotant simultanément position, rotation, scale et matrice. |
| **Wiggle Number** | `math/wiggle-number` | Oscillations scalaires continues basées sur du bruit de gradient. |
| **Wiggle Vector** | `vector/wiggle-vector` | Bruit 3D vectoriel décorrélé pour déplacements procéduraux. |
| **Pulse** | `time/pulse` | Génère une impulsion physique qui décroît exponentiellement après un déclenchement (front montant), les redéclenchements s'additionnent. |

### Courbes, Morphing et Shape Keys

| Node | Type | Description |
| :--- | :--- | :--- |
| **Curve from Points**| `curve/from_points` | Génère une courbe 3D à partir d'une liste de points (Catmull-Rom, Bézier). |
| **Curve Primitive** | `curve/primitive` | Génère des courbes géométriques (Hélice, Cercle, Ligne, Rectangle). |
| **Curve Array** | `curve/array` | Duplique une courbe en N copies concentriques, espacées en unités monde (Spacing) et/ou mises à l'échelle (Start + i×Step), pour des cercles concentriques à épaisseur de tube constante via Curves to Meshes. |
| **Curve to Mesh** | `curve/to_mesh` | Génère un tube 3D balayé avec profil d'épaisseur variable. |
| **Follow Path** | `curve/sample` | Échantillonne position, tangente et matrice d'orientation le long d'une courbe. |
| **Curve Deform** | `curve/deform` | Curve-deform pliant un maillage le long d'une trajectoire. |
| **Curve Shape Key** | `curve/shape_key` | Interpolation fluide (morphing) entre différentes formes de courbes. |
| **Mesh Shape Key** | `mesh/shape_key` | Interpolation volumétrique (morphing) entre deux maillages 3D compatibles. |
| **Lattice Deform** | `modifier/lattice` | Cage de déformation volumétrique FFD (Free-Form Deformation) 3D. |

### Lumières, Matériaux et Environnement

| Node | Type | Description |
| :--- | :--- | :--- |
| **Directional Light**| `light/directional` | Source lumineuse directionnelle (type soleil) avec ombres portées. |
| **Point Light** | `light/point` | Source omnidirectionnelle ponctuelle avec atténuation physique. |
| **Spot Light** | `light/spot` | Projecteur conique orientable avec angle et adoucissement. |
| **Ambient Light** | `light/ambient` | Lumière d'ambiance globale uniforme. |
| **Environment HDRI**| `environment/hdri` | Carte d'environnement HDR/EXR 32-bit pour illumination PBR. |
| **Material PBR** | `material/pbr` | Créateur de matériau PBR complet (roughness, metalness, emissive, normal map). |
| **Image Texture** | `texture/image` | Chargeur de textures bitmap (PNG, JPEG, WebP). |
| **Texture Transform**| `texture/transform` | Transformation des coordonnées UV (scale, offset, rotation). |

### Instanciation et Formations (Array & Spawner)

| Node | Type | Description |
| :--- | :--- | :--- |
| **Array** | `instance/array` | Duplication matricielle Linear (1D), Circular (2D), Grid ou 3D Grid. |
| **Set Instance Transform** | `instance/set_transform` | Modifie les matrices de transformation d'un groupe d'instances. |
| **Set Instance Color** | `instance/set_color` | Applique des variations de couleurs aux instances. |
| **Get Instance** | `instance/get` | Extrait la géométrie et la matrice d'une instance ciblée. |
| **Spawner** | `structure/spawn` | Distribue des objets 3D de manière aléatoire sur la surface d'un maillage. |
| **Texture Pixel Spawner** | `texture/pixel-spawner` | Génère une instance de géométrie 3D par pixel d'une texture (orientation XY, XZ, YZ), avec sorties couleurs, positions et intensités lumineuses (0-1). |

### Système de Particules, Champs de Forces et Trajectoires

| Node | Type | Description |
| :--- | :--- | :--- |
| **Particle Emitter**| `particles/emitter` | Configure l'émission de particules (débit, vitesse, dispersion, durée). |
| **Emitter From Surface**| `particles/emitter_surface` | Émet des particules depuis les sommets ou la surface d'un maillage. |
| **Particle Simulate**| `particles/simulate` | Moteur physique calculant les trajectoires, gravité et vent. |
| **Force Field** | `particles/force_field` | Attracteurs, répulseurs et vortex influençant les particules. |
| **Particle Render** | `particles/render` | Rendu graphique sous forme de sprites 2D ou billboard. |
| **Render Instances** | `particles/render_instances` | Rendu des particules sous forme de géométries 3D instanciées. |
| **Capture Trails** | `particles/capture_trails` | Capture et génère les rubans de trajectoires des particules. |

### Caméra et Calibration Vidéo-Mapping (DLT)

| Node | Type | Description |
| :--- | :--- | :--- |
| **Camera** | `calibration/camera` | Caméra avec modes Manuel et Calibré (solveur DLT pour vidéo-mapping). |
| **Fly To** | `camera/fly_to` | Transition cinématique fluide entre deux caméras avec arc parabolique. |
| **Room Corner** | `calibration/room_corner` | Générateur de repères de calage 3D pour la pièce physique. |

### Data-Visualisation et Graphiques

| Node | Type | Description |
| :--- | :--- | :--- |
| **Bar Graph** | `chart/bar` | Histogramme 3D paramétrique généré depuis une liste de données. |
| **Line Graph** | `chart/line` | Graphique linéaire continu en tube ou ruban 3D. |
| **Scatter Plot** | `chart/scatter` | Nuage de points 3D avec marqueurs volumétriques à coordonnées (X, Y, Z). |
| **Pie Chart** | `chart/pie` | Camembert ou anneau 3D extrudé avec secteurs proportionnels. |
| **Point Cloud** | `chart/point_cloud` | Rendu hautement optimisé de nuages de points massifs. |

### Post-Traitement et Shaders GPU

| Node | Type | Description |
| :--- | :--- | :--- |
| **Bloom** | `postprocess/bloom` | Effet d'émanation lumineuse et halo sur les zones émissives. |
| **Depth of Field** | `postprocess/dof` | Flou de profondeur de champ optique avec focus paramétrable. |
| **Outline** | `postprocess/outline` | Détection de contours géométriques pour rendu cel-shading. |
| **Film Grain** | `postprocess/film_grain` | Grain de pellicule cinéma analogique. |
| **Vignette** | `postprocess/vignette` | Assombrissement progressif des bords de l'image. |
| **Pixelate** | `postprocess/pixelate` | Effet rétro pixel-art par réduction de résolution. |
| **Glitch** | `postprocess/glitch` | Artefacts de désynchronisation vidéo et décalages RGB. |
| **Kaleidoscope** | `postprocess/kaleidoscope` | Répétition radiale en miroir de la scène. |
| **RGB Shift** | `postprocess/rgb_shift` | Aberration chromatique séparant les canaux R, G, B. |
| **Color Correction**| `postprocess/color_correction` | Étalonnage des couleurs (luminosité, contraste, saturation). |
| **Fog** | `postprocess/fog` | Brume volumétrique basée sur le tampon de profondeur. |

### Audio et Analyse Spectrale (FFT)

| Node | Type | Description |
| :--- | :--- | :--- |
| **Microphone Input**| `sound/microphone` | Capture le flux du microphone ou de la carte son en temps réel. |
| **Audio Spectrum** | `sound/spectrum` | Analyseur de spectre FFT (Basses, Médiums, Aigus). |
| **Peak Detector** | `sound/peak_detector` | Détecteur d'attaques percussives (beats, kicks) avec seuil. |
| **Audio Player** | `sound/player` | Lecteur de fichiers audio (.mp3, .wav) avec contrôle de transport. |
| **Audio Synth** | `sound/synth` | Synthétiseur générateur d'ondes audio pures. |

### Mathématiques, Vecteurs et Logique

| Node | Type | Description |
| :--- | :--- | :--- |
| **Value Math** | `math/value_math` | Opérations scalaires (Add, Subtract, Multiply, Divide, Sin, Cos...). |
| **Integrate** | `math/integrate` | Accumule un taux dans un total courant : `total += taux × dt`. La moitié manquante de tout schéma de contrôle — une entrée dit à quelle force on pousse *maintenant*, l'intégrateur en fait un déplacement qui persiste au relâchement. Amortissement exprimé par seconde (indépendant du framerate), bornes optionnelles, reset, et réinitialisation au scrub arrière de la timeline. |
| **Integrate Vector** | `vector/integrate` | Même accumulation sur trois axes : une vitesse entre, une position sort. Bornage **radial** (`Max Length`) et non par axe, pour qu'une zone limitée soit ronde et non carrée. |
| **Clamp** | `math/clamp` | Borne une valeur dans l'intervalle [min, max]. |
| **Map Range** | `math/map_range` | Remappe une valeur entre une plage source et une cible. |
| **Vector Math** | `math/vector_math` | Opérations vectorielles 3D (Dot product, Cross product, Normalize...). |
| **Distance** | `math/distance` | Calcule la distance euclidienne entre 2 objets, positions ou listes. |
| **Distances** | `math/distances` | Calcule la liste complète des distances entre une liste/groupe d'instances et une cible (Vector/Object/Matrix). |
| **Proximity Object** | `object/proximity` | Trouve l'instance ou l'objet le plus proche d'une cible parmi une liste ou un groupe d'instances. |
| **Random Value** | `math/random-value` | Nombres aléatoires (uniforme, gaussien, bruit 1D). |
| **Boolean Logic** | `logic/boolean` | Portes logiques booléennes (AND, OR, NOT, XOR). |
| **Compare** | `logic/compare` | Comparateurs (Egal, Différent, Supérieur, Inférieur). |

### Listes et Manipulation de Données

| Node | Type | Description |
| :--- | :--- | :--- |
| **Generate List** | `list/generate` | Génère une suite arithmétique de nombres. |
| **Get List Item** | `list/get_item` | Extrait l'élément situé à un index spécifique. |
| **List Math** | `list/math` | Opérations mathématiques terme à terme entre deux listes (A et B) ou une liste et un scalaire (Add, Multiply, Min, Max, Power...). |
| **Color Palette** | `list/palette` | Collections de palettes chromatiques sous forme de listes. |
| **Random Sample List**| `list/random-sample` | Échantillonne aléatoirement N éléments d'une liste (avec ou sans remise) et extrait leurs indices. |

### Entrées Interactives (Clavier, Souris, Manette)

| Node | Type | Description |
| :--- | :--- | :--- |
| **Keyboard** | `io/keyboard` | Détecte l'appui d'une touche : `isDown` (maintenu) et `pressed` (front montant). |
| **Mouse** | `io/mouse` | Position et déplacement du pointeur. |
| **Gamepad** | `io/gamepad` | Manette lue par polling (`getGamepads`), mapping standard W3C. Deux sticks (scalaires bruts **et** vecteurs pré-mappés dans le plan XZ, où pousser vers le haut = avancer en −Z), gâchettes analogiques, D-pad plié en vecteur, boutons nommés. **Zone morte radiale** et non par axe. |
| **Action Map** | `io/action-map` | Plusieurs sources d'entrée → une action nommée. Sockets **Positive** et **Negative** croissants : câbler D en positif et Q en négatif donne un axe −1…1 à partir de deux touches. Combinaison (le plus fort / somme / moyenne), échelle, inversion, zone morte, lissage exprimé en secondes, seuil d'activation, et sorties `pressed` / `released`. |
| **Inspector** | `io/inspector` | Moniteur de débogage affichant en temps réel la valeur circulant dans un câble. |

### Utilitaires et Organisation

| Node | Type | Description |
| :--- | :--- | :--- |
| **Reroute** | `utility/reroute` | Point de dérivation compact pour organiser le câblage du graphe. |
| **Canvas Go To** | `canvas/goto` | Bascule vers l'un des canevas du projet lors d'un trigger. |

---

## Moteur d'Animation Paramétrique et Studio 3D

Tsuji intègre un studio complet avec timeline et gizmos interactifs :

- **Timeline & Keyframing** : Pressez la touche `K` sur n'importe quel paramètre pour créer une image-clé.
- **Gizmos 3D** : Manipulez la position (`T`), la rotation (`R`) ou l'échelle (`S`) directement dans la vue 3D.
- **Marquee Selection** : `Cmd` (ou `Ctrl`) + Clic gauche & Glisser pour sélectionner plusieurs points de contrôle de courbe ou de cage Lattice.

---

## Raccourcis Clavier

| Raccourci | Action |
| :--- | :--- |
| `Espace` | Lancer / Mettre en pause la lecture de la timeline |
| `Cmd` + `Espace` / `Ctrl` + `Espace` | Recherche rapide de nœuds au curseur |
| `T` / `R` / `S` | Gizmos de Translation / Rotation / Échelle |
| `X` / `Y` / `Z` | Verrouiller le Gizmo sur l'axe X, Y ou Z |
| `Cmd` + Clic & Glisser | Sélection rectangulaire 2D de points 3D (Courbes, Lattice) |
| `K` | Enregistrer / Supprimer une image-clé sur le paramètre survolé |
| `Tab` | Masquer / Afficher les aides visuelles de la scène 3D |
| `Shift` + `Tab` | Basculer entre vue scindée et vue pleine |
| `Cmd` + `C` / `Cmd` + `V` | Copier / Coller les nœuds sélectionnés |
| `Cmd` + `Z` / `Ctrl` + `Z` | Annuler la dernière action |

---

## Installation, Tests et Déploiement

### 1. Cloner le dépôt
```bash
git clone https://github.com/Nikos-Unilasalle/tsuji.git
cd tsuji
```

### 2. Installer les dépendances
```bash
npm install
```

### 3. Lancer en mode développement (Web)
```bash
npm run dev
```

### 4. Lancer en mode application Desktop (Tauri)
```bash
npm run tauri dev
```

### 5. Exécuter la suite de tests unitaires
```bash
npm test
```

### 6. Compiler pour la production
```bash
npm run build
```

---

## Licence

Ce projet est distribué sous licence MIT. Consultez le fichier `LICENSE` pour plus de détails.
