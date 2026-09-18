# Node Catalog (Tsuji)

*Emplacement dans le code : `src/shared/graph/nodes/index.ts`*

Ce document référence l'ensemble des plus de 145 nœuds disponibles dans le moteur Tsuji, classés par domaine fonctionnel.

---

## 1. Mathématiques, Logique & Signaux
- **`value/math`**, **`value/map-range`**, **`value/clamp`**, **`value/constant`**
- **`vector/compose`**, **`vector/decompose`**, **`vector/math`**
- **`color/compose`**, **`color/decompose`**, **`color/math`**
- **`logic/compare`**, **`logic/boolean`**, **`logic/trigger`**, **`logic/toggle`**, **`logic/gate`**, **`logic/bridge`**
- **`time/time`**, **`time/frame`**, **`oscillator`**, **`envelope`**, **`pulse`**, **`animation/wiggle`**

## 1.bis. Variables Nommées & Routage de Données
- **`variable/set`** (*Set Variable*) : Écrit une valeur typée (`Float`, `Int`, `String`) ou sa valeur de repli `initial` sous un identifiant déclaré, et la transmet en sortie en transparence (*inline pass-through*). Déclaration enregistrée avec double-buffering par step (`ctx.step`) pour éviter la pollution de fragments de saisie. Réinitialisé lors d'un simulation reset.
- **`variable/get`** (*Get Variable*) : Lit la valeur écrite par le `Set Variable` correspondant via une liste déroulante dynamique de tous les noms enregistrés. Global à la session et multi-canvas (survit à `Go To Canvas`). Renvoie la valeur zéro de son type si non encore évalué, ou `undefined` si inexistant.
- **`routing/reroute`** (*Reroute*) : Nœud passe-plat de routage filaire pour clarifier les faisceaux de connexions complexes sans modifier la donnée.

## 1.ter. Sous-Graphes & Groupes de Nœuds (`structure/group`)
- **`structure/group`** (*Group*) : Encapsule une sélection de nœuds dans un sous-graphe hiérarchique réutilisable (`Cmd+G` pour grouper, `Cmd+Shift+G` pour dissocier).
  - **Navigation & Vue** : Double-clic pour plonger dans le sous-graphe avec cadrage automatique du niveau, barre de fil d'Ariane (*breadcrumb*) pour remonter à l'arbre parent.
  - **Intégrité de Session** : Les nœuds groupés conservent leurs identifiants uniques (`node.id`), préservant les pistes d'animation `KeyframeStore`, les caches GPU par nœud, les paramètres épinglés au HUD et la pile Undo/Redo.
  - **Gizmo de Groupe** : Support interactif complet du gizmo de manipulation 3D au niveau du groupe.
- **`structure/group-input`** (*Group Input*) & **`structure/group-output`** (*Group Output*) : Bornes d'interface interne du sous-graphe. Chaque borne présente un connecteur dynamique `+` : déposer un fil matérialise instantanément un port typé correspondant sur le nœud groupe extérieur.

## 2. Géométrie 3D & Modificateurs
- **Primitives 3D** : Box, Sphere, Cylinder, Cone, Disc, Plane, Polygon, Text 3D, Empty, **`object/raccoon`** *(avec Gizmo interactif)*.
- **Surfaces Implicites** :
  - **`object/metaballs`** (*Metaballs*) : Générateur de surface implicite fluide par échantillonnage Marching Cubes sur un nuage de centres.
    - **Entrées Polyvalentes** : Accepte une liste explicite de points (`Mesh to Points`, `Instance Positions`) ou directement un maillage géométrique (`geometry`, avec `owns: true`) dont il extrait les centres de chaque enfant et de chaque instance d'`InstancedMesh` (permettant de brancher directement un `structure/array` ou `spawner`).
    - **Paramètres Clés** : Rayon (`radius`), lissage d'influence (`smooth`), résolution de grille (`resolution` 16 à 128) et matériau.
    - **Optimisation** : Le résultat du sampler Marching Cubes est copié dans la géométrie en cache du nœud hors de la boîte unité $[-1, 1]$ (évitant l'empreinte du buffer scratch de 60k polys), et une porte de signature skip le recalcul tant que les centres demeurent immobiles (7.4 ms/frame à résolution 64).
- **`object/terrain`** (*Terrain Maker*) : Générateur de terrain optimisé pour jeux vidéo et simulations physiques (compatible Rapier / `physics/rigid-body`).
  - **Entrées** : `heightmap` (texture de relief), `material`, `texture` (albedo), `normal`, `roughnessMap`, `matrix`, `visible`.
  - **Sorties** : `geometry` (Mesh Three.js sur le plan XZ avec Y pour hauteur), `matrix`, `heightmap` (Texture générée / mise à jour).
  - **Relief & Dimensions** : Largeur (`width`), Profondeur (`depth`), Résolution maillée (`resolution` : 32x32 à 256x256), Amplitude (`heightScale`) et Décalage vertical (`heightOffset`).
  - **Ombrage Automatique par Pente & Altitude** : Coloration procédurale par sommets (`slopeShading`) avec transition continue vert prairie (plateau), brun/gris falaise rocheuse (pente raide) et blanc névé (hauts sommets). Support du Flat Shading basse fidélité et Wireframe.
  - **Palette de Sculpture Temps Réel (HUD Viewport)** : Barre discrète d'outils de sculpture inspirée d'Unreal Landscape et Grease Pencil au bas du Viewport dès qu'un nœud Terrain est sélectionné.
    - Outils : **Sculpt** (hausser / creuser avec Invert ou touche Alt), **Smooth** (lissage Laplacien local), **Flatten** (aplanissement vers altitude cible), **Noise** (bruit perlin procédural), **Erode** (érosion hydraulique / thermique simplifiée).
    - Atténuations (*Falloff*) : `smooth`, `linear`, `sphere`, `flat`.
    - Gizmo de brosse 3D projeté sur le maillage avec orientation selon la normale de surface. Raccourcis `[` et `]` pour redimensionner le rayon.
  - **Optimisation & Physique** :
    - Calcul analytique des normales en $O(N)$ par différences finies sans réallocation de maillage.
    - Attributs configurés en `THREE.DynamicDrawUsage` pour un streaming GPU sans saccade.
    - Compatibilité directe avec Rapier (`physics/rigid-body`) : dérivation automatique en collider trimesh statique pour véhicules (`physics/vehicle`), personnages (`physics/character`) et corps rigides.
- **Importateurs** : OBJ (`objLoader.ts`), GLTF (`gltfLoader.ts`), PLY (`plyLoader.ts`).
- **Modificateurs Paramétriques & Topologiques** :
  - **`geometry/weld`** (*Weld / Soft Fillet*) : Fusion booléenne douce et congé de raccordement par champ de distance signé (SDF) volumique 3D voxelisé et extraction Surface Nets. Fusionne des maillages en intersection en un solide continu et lisse avec rayon de congé (`filletRadius`) et résolution paramétrables.
  - **`geometry/contour-scan`** (*Contour Scan*) : Tranchage de maillage 3D par plans parallèles réguliers selon l'axe X, Y ou Z. Génère des rubans polygonaux orientés avec normales stables ou un ensemble de courbes splines (`curves`) pour effets de balayage topographique, morphing et rendu vectoriel.
  - **`geometry/twist-bend-taper`** : Torsion axiale (*Twist*), flexion circulaire (*Bend*) et effilement conique (*Taper*).
  - **`geometry/wave-ripple`** : Ondulations concentriques (*Ripple* avec point d'impact $X/Z$) et ondes planes (*Linear*).
  - **`geometry/facet-explode`** : Éclatement polygonal le long des normales de faces.
  - **Synchronisation Dynamique des Déformateurs Chaînés** : Les déformateurs successifs (ex. Wave $\rightarrow$ Twist) synchronisent leur géométrie de base (`base`) depuis le buffer de positions live du maillage source à chaque frame en cache-hit, garantissant la propagation continue de l'animation d'onde.
  - `lattice/deform`, `subdivide`, `solidify`, `mesh/extrude`, `mesh/delete`, `boolean`, `shade`, `visualSlice`, `squash`.
- **Courbes & Lignes** : Catmull-Rom splines, SVG import, shape keys, curve to mesh, curve deform.

### 3. Particules & Simulation GPGPU / Chaos
- **Émetteurs** : `particles/emitter`, `emitter-from-points`, `emitter-from-surface`.
  - **Améliorations Émetteurs & Rafales** : Support de la vélocité initiale (`initialVelocity`), gigue de diamètre (`diameterJitter`), et émission en rafale complète (`burstPopulation`) assurant le peuplement immédiat de la population voulue sans sous-échantillonnage de frame.
- **Moteur GPU & Champs de Force** :
  - `particles/simulate` (shaders de turbulence, gravité, vortex, rebond sol).
  - `particles/force-field` : attracteur, vortex, vent, turbulence. Proxy de sélection 3D dans le viewport aligné sur le design visuel des émetteurs.
  - **`particles/curl-noise`** : champ de force vectoriel à rotationnel incompressible (volutes de fumée / encre) avec proxy Gizmo 3D dans le viewport.
- **Dynamique Chaotique** :
  - **`particles/strange-attractor`** : solveur RK4 de systèmes non-linéaires (**Lorenz**, **Aizawa**, **Thomas**) avec transform, gizmo natif et sortie points list.
- **Rendu** : `particles/render` (points), `particles/render-instances` (`THREE.InstancedMesh`), `particles/trails`.

## 4. Matériaux Procéduraux & Shaders FX
Tous ces matériaux se branchent directement sur la prise `material` des maillages Three.js et disposent de contrôles créatifs temps réel (sockets modulables et inspecteur GUI) :
- **`material/hologram`** : Scanlines 3D animées en coordonnées monde, contour Fresnel néon (`rimColor`), tranches de glitchs temporels (`glitchFrequency`), grain cathodique (`noiseIntensity`) et toggles individuels d'effets (`enableScanlines`, `enableGlitch`, `enableNoise`, `enableFlicker`).
- **`material/liquid-metal`** : Mercure et chrome en fusion avec bruit Simplex et **Domain Warping** imbriqué multi-octaves, brillance et teinte spéculaire (`specularColor`, `metalness`, `iridescence`), exposant de Fresnel (`fresnelPower`), et toggle de déformation géométrique (`enableDisplacement`).
- **`material/cel-shade`** : Shading cartoon / BD, bandes de lumière échelonnées (2 à 10), contrôle continu de netteté des bandes (`bandSoftness`), trame de demi-teinte personnalisable (`halftoneDotColor`, `halftoneScale`), éclat spéculaire et toggles d'éléments (`enableHalftone`, `enableRim`, `enableSpecular`).
- **`material/iridescent`** : Simulation physique d'interférence en couches minces (*thin-film*) avec déphasage spectral nanométrique, réfraction (`refractiveIndex`), couleur spéculaire (`specularColor`), dosage arc-en-ciel (`rainbowMix`) et moirages animés (`rippleSpeed`, `rippleFrequency`).
- **`material/wireframe-pulse`** : Filaire vectoriel dérivé à largeur constante à l'écran avec onde de choc lumineuse pulsée (*pulse wave*), fréquence d'impulsion (`pulseFrequency`), lueur d'impact (`glowIntensity`), et toggles de remplissage et de pulsation (`enableFill`, `enablePulse`).
- **`material/thermal`** : Caméra thermique / vision infrarouge (FLIR) avec gradient spectral physique, bornes chromatiques configurables (`coldColor`, `hotColor`), vitesse de chatoiement (`shimmerSpeed`), bascule White Hot / Black Hot (`invert`) et toggle de mirage thermique (`enableDistortion`).
- **`material/xray`** : Scanner radiologique et tomographie médicale avec transparence frontale, densité interne (`coreColor`), condensation tangentielle, intensité de bruit radiologique (`noiseIntensity`) et toggle de grain argentique (`enableGrain`).
- **`material/energy-shield`** : Bouclier de force hexagonal cyberpunk avec onde d'impact réactive, lueurs Fresnel, netteté des alvéoles (`edgeSharpness`, `fresnelPower`), et toggles de grille et de pulsation (`enableGrid`, `enablePulse`).
- **`material/stylized_fire`** : Flamme 2D stylisée haute performance (style Ivan Boyko) basée sur un champ de distance signé (**SDF**) avec soustraction booléenne douce (paramètre $k$ / `smoothness`), double harmonique sinusoïdale, perforations internes (`internalHoles`), courbure de profil de base (`baseCurvature`), descente et masquage d'arche du cœur blanc (`coreOffsetY`, `coreBaseMask`), lissage des couleurs (`colorSoftness`) et checkboxes d'activation de chaque composante couleur (`enableCore`, `enableInner`, `enableDark`, `enableOutline`).
- **`material/miyazaki_cloud`** : Nuage cumulus stylisé (style Hayao Miyazaki / Studio Ghibli, 入道雲) sur **fond transparent sans animation**, basé sur un empilement hiérarchique de 12 dômes SDF combinés avec `smin`, festonnage périphérique par champ de Voronoi cellulaire inversé (`detail`, `puffiness`), méplat de condensation (`baseFlatness`), normales pseudo-3D avec éclairage solaire directionnel (`sunAngle`, `sunElevation`), et palette aquarelle/cel-shading 4 nuances (`highlightColor`, `bodyColor`, `shadowColor`, `deepShadowColor`) avec transitions modulables (`bandSoftness`).

## 5. Scénographie & Éclairage Volumétrique
- **`object/laser-beam`** : Projecteur scénographique motorisé avec tête rotative **Pan / Tilt**, faisceau laser volumétrique transparent simulant la brume d'ambiance, stroboscope / pulsation BPM (`pulseFrequency`), divergence conique (`coneAngle`), spot d'impact lumineux au sol (`spotSize`) et support complet du transform/gizmo natif.
- **Lumières Standard** : Directional, Point, Spot, Ambient, Environment, Light Probe.

## 6. Audio & Signaux Interactifs
- **`sound/audio-player`**, **`sound/spectrum`**, **`sound/peak-detector`**, **`sound/synth`**, **`sound/microphone`**.
- **`keyboard`**, **`mouse`**, **`click`**, **`csv-reader`**.

## 7. Rendu, Textures & Post-Traitement
- **`render`** (*Render*) : Nœud terminal du pipeline de rendu de la scène.
  - Sockets : `geometry` (`owns: true`), `environment`, `postprocess`, `motionBlur`.
  - Sorties : `geometry`, `environment`, `postprocess`.
  - **`timelineEnabled` (*Timeline / Frame Count*)** : Bascule permettant de désactiver la durée fixe et la barre de scrub pour les scènes interactives, jeux et simulations physiques infinies. Si décoché, la tête de lecture ne défile plus automatiquement et la réinitialisation se fait via `Shift+Space` (voir [[Simulation Reset and Epoch Architecture]]).
  - Paramètres de format : `resolutionPreset`, `width`, `height`, `fps`, `frameCount`, `motionBlur`.
- **Textures Vidéo MP4 (`texture/image`, `object/texture-plane`)** :
  - Décodage et streaming GPU via `THREE.VideoTexture` pour fichiers vidéo `.mp4`.
  - Modes de lecture synchronisés : `startFrame` et `loop` permettant la lecture libre (*free-run*) ou asservie à la tête de lecture de la timeline (reproductibilité d'export), avec prise en charge binaire directe dans `ParamPanel`.
- **Post-Process Optique Standard** : Bloom, DOF, RGB Shift, Vignette, Outline, Grain & CRT Scanlines (animés à 60 FPS), Glitch, SSAO, Fog.
- **Post-Process Vintage & Look Pellicule / Imprimerie (`src/shared/graph/nodes/postprocessingFilm.ts`)** :
  - **`postprocess/duotone`** (*Dual Tone*) : Rampe chromatique bicolore mappant les ombres et hautes lumières vers deux teintes d'encrage personnalisées (`shadowColor`, `highlightColor`, `contrast`).
  - **`postprocess/halftone`** (*Halftone Print*) : Simulation de trame d'imprimerie offset / sérigraphie avec points en grille orientée (`angle`), fréquence (`scale`) et netteté (`softness`).
  - **`postprocess/film-texture`** (*Film Texture*) : Grain argentique et poussières quantifiés temporellement par un paramètre `rate` (cadence pellicule 16 ou 18 fps évitant le bruit numérique à 60 Hz) et hachage spatial déterministe identique en export et prévisualisation.
  - **`postprocess/super8`** (*Super 8 Projector*) : Émulation complète de projecteur argentique combinant saut d'obturateur (*gate weave*), scintillement d'intensité (*flicker*) et salissures avec cadence cadencée.
  - **`postprocess/dry-brush`** (*Dry Brush*) : Effet de brosse sèche et estompe où la couleur du papier sous-jacent transparaît dans les creux de la matière en fonction de l'encre déposée (`followInk`).

## 8. Simulation Fluide 3D & Volumes (Chantier 1 Three.js r185)
Nœuds universels de simulation eulérienne 3D et de raymarching volumétrique pour feu, fumée et fluides :
- **`physics/curl-noise-3d`** (*Curl Noise 3D*) : Champ de force vectoriel sans divergence pour micro-turbulences incompressibles, générant une texture volumétrique `THREE.Data3DTexture`.
- **`physics/mesh-fluid-emitter`** (*Mesh Fluid Emitter*) : Transforme n'importe quel maillage 3D en source de fluide avec injection de densité, température et vitesse inertielle (`motionBoost`).
- **`physics/fluid-solver-3d`** (*Fluid Solver 3D*) : Solveur Navier-Stokes 3D modulaire (advection semi-Lagrangienne, diffusion thermique, poussée d'Archimède, solveur de pression de Poisson / itérations Jacobi).
- **`material/volume-3d`** (*Volume Material 3D*) : Shader de rendu volumétrique raymarché avec rayonnement de corps noir (*blackbody emission*), absorption Beer-Lambert et jittering anti-banding.
- **`simulation/fire-fluid-volume`** (*Volumetric Fire Sim*) : Nœud macro autonome "all-in-one" créant un brasier volumétrique interactif avec maillage englobant, texture 3D de vitesse et lumière dynamique synchrone (`PointLight`).

## 9. Végétation & Vent (Chantier Folio — Herbe, Arbres, Ployage)
Briques atomiques de végétation temps réel, conçues autour d'**un seul champ de vent partagé** : herbe, feuillage et maillages quelconques ploient selon la même source, sans quoi la scène se disloque visuellement (l'herbe penche à gauche pendant que les feuilles penchent à droite).
- **`physics/wind-field`** (*Wind Field*) : Champ de vent global, deux octaves de bruit de valeur défilant selon une direction. Implémenté **deux fois à l'identique** (TypeScript et GLSL) afin d'être échantillonnable par les shaders *et* par le graphe (sortie `wind` vectorielle). La phase temporelle est repliée côté CPU (`time × speed`) pour que chaque frame exportée soit reproductible.
- **`structure/grass-field`** (*Grass Field*) : Champ d'herbe dense, **un seul draw call, sans instanciation** — un brin = 3 sommets, sa forme est reconstruite dans le vertex shader depuis un index de coin et une graine par brin. **Repliement torique** (`mod`) autour du socket `Center` : un champ illimité au prix d'un carré fixe, sans réallocation. Carte de densité optionnelle (canal rouge) pour peindre chemins, berges et zones pelées.
  - **Ombrage des brins** : paramètres `shadowColor` et `shadowIntensity` teintant la base des brins vers une couleur d'ombre pour simuler l'occlusion ambiante dense au sol.
  - **Sortie `groundShadow` (texture)** : carte de densité brute floutée par box-blur séparable 3 passes et teintée de `shadowColor`. Branchée dans un `texture/mix` (multiply, factor 1) avec la texture du sol, elle projette une ombre d'herbe douce et fidèle directement sur le sol sans draw call supplémentaire ni coût de shadow map.
- **`object/tree`** (*Tree (Parametric)*) : Arbre récursif complet depuis une graine, une **espèce** et un jeu de nombres. L'espèce (chêne, conifère, saule, bouleau, palmier, buisson, arbre mort) est un **port de croissance et non un préréglage** — elle change le comportement de la récursion (flèche centrale contre fourche, latérales montantes contre retombantes, absence totale de ramification pour le palmier) pendant que chaque paramètre numérique continue de la moduler, sans écraser les réglages de l'auteur. Silhouette de feuille paramétrique en 7 profils, exclue de la clé de reconstruction : parcourir les formes est gratuit. Feuillage **dispersé ou en touffes sphériques** (`foliageMode`), **rampe saisonnière** été → or → rouge à décalage par feuille, et **dégradé vertical de canopée** via un attribut instancié de hauteur dans le houppier. Deux draw calls : branches balayées en un maillage tubulaire unique (repères par transport parallèle, pas de vrille), feuilles en `InstancedMesh` de cartes découpées en amande dans le fragment shader (aucune texture, aucun tri alpha). Géométrie reconstruite uniquement quand un paramètre de *forme* change ; budget de branches plafonné (`MAX_TREE_BRANCHES`) car la récursion est en `childCount ^ levels`.
- **`texture/interaction-map`** (*Interaction Map*) : Carte top-down de ce qui est passé par là — caméra orthographique zénithale, cible de rendu persistante en ping-pong, estompage exprimé en **demi-vie (secondes)** et non en facteur par frame, afin qu'une trace dure le même temps réel à 30 comme à 144 fps. La carte **défile avec son centre** : câblez la position d'un personnage et elle le suit, son contenu se décalant d'autant en UV pour que les marques restent fixes dans le monde. Rien n'y est spécifique à l'herbe : neige, sable, chaleur, humidité, effacement.
- **`geometry/wind-sway`** (*Wind Sway*) : Ployage de n'importe quelle géométrie du graphe **par injection shader** (`onBeforeCompile`) et non par déformation de sommets — donc applicable à un import de 200 k sommets. Le matériau amont est cloné avant patch, jamais modifié en place.

## 10. Entrées Interactives & Physique Rigide (Rapier)
Briques d'entrée conçues pour que le reste du graphe **ignore d'où vient la commande** :
- **`physics/world`** (*Physics World*) : Monde de corps rigides **Rapier**.
  - Pas de temps fixe avec report du reste entre les frames.
  - Plafond de sous-pas : évite les spirales de lag après suspension d'onglet.
  - Intégration WASM `-compat` asynchrone sans top-level await.
- **`physics/rigid-body`** (*Rigid Body*) : Confie une géométrie au monde.
  - `Split: per-child` par défaut (corps par maillage et par instance `InstancedMesh`).
  - Dérivation des matrices monde par chaîne locale (`worldMatrixOf`) éliminant les effondrements à l'origine.
  - Édition manuelle de pose préservée en mode pause (`isPlaying === false`).
- **`physics/vehicle`** (*Vehicle*) : Véhicule à quatre roues sur le contrôleur raycast de Rapier.
  - Centre de gravité ajustable, publication continue des poses de roues (`wheels`) même à l'arrêt, et préservation d'échelle locale.
- **`physics/character`** (*Character (Physics)*) : Personnage cinématique Rapier avec franchissement automatique de marches, accrochage au sol et poussée sur corps dynamiques.
- **`physics/capsule-controller`** (*Capsule Controller*) : Contrôleur cinématique CPU contre arbre BVH (`three-mesh-bvh`) insensible aux échelles non uniformes.
- **`io/gamepad`** (*Gamepad*) : Manette multi-plateforme.
  - **Passerelle Native Desktop (`gilrs`)** : Bridge Tauri en Rust pour capture matérielle directe des manettes sous Windows/macOS/Linux avec réactivité maximale, et repli transparent sur l'API HTML5 `navigator.getGamepads()` dans le navigateur.
  - Zone morte radiale, gâchettes analogiques et D-pad en vecteur.
- **`math/integrate`** / **`vector/integrate`** (*Integrate*, *Integrate Vector*) : Accumulation continue $v \times dt$ avec amortissement par seconde et remise à zéro à l'époque de simulation.
- **`io/move-input`** (*Move Input*) : Schéma de contrôle complet en un nœud (ZQSD, WASD, flèches, manette, sprint, saut).
- **`io/action-map`** (*Action Map*) : Multiplexeur d'axes et de boutons vers actions nommées avec lissage temporel invariant.

## 11. Simulation Physique Souple & Tissus (`physics/cloth`)
- **`physics/cloth`** (*Cloth Simulation*) : Solveur de tissu physique masse-ressort-amortisseur haute performance sur CPU (`clothSolver.ts`).
  - **Comportement & Dynamique** : Simulation réaliste de drapé, gravité, amortissement d'air (`airResistance`), rigidité structurelle et de cisaillement (`stiffness`, `iterations`).
  - **Épinglage & Contraintes (`pins`)** : Fixation de sommets par sélection explicite, bordures ou seuil de coordonnées pour drapeaux, rideaux, bannières et voiles.
  - **Collisions Intégrées** : Détection et répulsion continue contre des obstacles géométriques (sphères d'évitement, plans et sol).
  - **Couplage avec les Champs de Force** : Les forces environnementales du graphe (**`particles/force-field`**, vent, vortex, turbulence curl noise) sont sommées directement dans l'accélération de chaque particule de tissu.
  - **Shading & Intégrité Visuelle** : Respecte scrupuleusement le matériau d'origine du maillage amont (`owns: true`). Mode `smooth` calculant la moyenne des normales par particule plutôt que par index Three.js (éliminant la cicatrice visuelle sur les coutures UV) ou mode `flat` non-indexé pour maillages low-poly.
  - **Cycle de Vie & Reset** : Réinitialisation instantanée de l'état particulaire lors d'un saut de tête de lecture ou d'un `Shift+Space` (Epoch reset).

---

## 🔗 Notes Associées
- [[Cloth Simulation and Soft Bodies]]
- [[Vintage Film Post Processing]]
- [[Parametric Geometry and Modifiers]]
- [[Node_Groups_Implementation_Plan]]
- [[Input Subsystem and Playback Keys]]
- [[ThreeJS Viewport and Calibration Pipeline]]
- [[Simulation Reset and Epoch Architecture]]
- [[Creative FX and Stage Nodes]]
- [[Universal_Nodes_Catalog_3_Chantiers]]
- [[Vegetation_and_Wind_Nodes_Catalog]]
- [[Named Variables System]]
