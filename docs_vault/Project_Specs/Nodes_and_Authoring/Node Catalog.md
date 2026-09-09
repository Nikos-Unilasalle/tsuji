# Node Catalog (Tsuji)

*Emplacement dans le code : `src/shared/graph/nodes/index.ts`*

Ce document référence l'ensemble des plus de 128 nœuds disponibles dans le moteur Tsuji, classés par domaine fonctionnel.

---

## 1. Mathématiques, Logique & Signaux
- **`value/math`**, **`value/map-range`**, **`value/clamp`**, **`value/constant`**
- **`vector/compose`**, **`vector/decompose`**, **`vector/math`**
- **`color/compose`**, **`color/decompose`**, **`color/math`**
- **`logic/compare`**, **`logic/boolean`**, **`logic/trigger`**, **`logic/toggle`**, **`logic/gate`**
- **`time/time`**, **`time/frame`**, **`oscillator`**, **`envelope`**, **`pulse`**, **`animation/wiggle`**

## 2. Géométrie 3D & Modificateurs
- **Primitives 3D** : Box, Sphere, Cylinder, Cone, Disc, Plane, Polygon, Text 3D, Empty, **`object/raccoon`** *(avec Gizmo interactif)*.
- **Importateurs** : OBJ (`objLoader.ts`), GLTF (`gltfLoader.ts`), PLY (`plyLoader.ts`).
- **Modificateurs Paramétriques** :
  - **`geometry/twist-bend-taper`** : Torsion axiale (*Twist*), flexion circulaire (*Bend*) et effilement conique (*Taper*).
  - **`geometry/wave-ripple`** : Ondulations concentriques (*Ripple* avec point d'impact $X/Z$) et ondes planes (*Linear*).
  - **`geometry/facet-explode`** : Éclatement polygonal le long des normales de faces.
  - `lattice/deform`, `subdivide`, `mesh/extrude`, `mesh/delete`, `boolean`, `shade`, `visualSlice`, `squash`.
- **Courbes & Lignes** : Catmull-Rom splines, SVG import, shape keys, curve to mesh, curve deform.

## 3. Particules & Simulation GPGPU / Chaos
- **Émetteurs** : `particles/emitter`, `emitter-from-points`, `emitter-from-surface`.
- **Moteur GPU & Champs de Force** :
  - `particles/simulate` (shaders de turbulence, gravité, vortex, rebond sol).
  - `particles/force-field` : attracteur, vortex, vent, turbulence.
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

## 7. Post-Traitement
- **Post-Process** : Bloom, DOF, RGB Shift, Vignette, Outline, Grain & CRT Scanlines (animés à 60 FPS), Glitch, SSAO, Fog.

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
- **`object/tree`** (*Tree (Parametric)*) : Arbre récursif complet depuis une graine, une **espèce** et un jeu de nombres. L'espèce (chêne, conifère, saule, bouleau, palmier, buisson, arbre mort) est un **port de croissance et non un préréglage** — elle change le comportement de la récursion (flèche centrale contre fourche, latérales montantes contre retombantes, absence totale de ramification pour le palmier) pendant que chaque paramètre numérique continue de la moduler, sans écraser les réglages de l'auteur. Silhouette de feuille paramétrique en 7 profils, exclue de la clé de reconstruction : parcourir les formes est gratuit. Feuillage **dispersé ou en touffes sphériques** (`foliageMode`), **rampe saisonnière** été → or → rouge à décalage par feuille, et **dégradé vertical de canopée** via un attribut instancié de hauteur dans le houppier. Deux draw calls : branches balayées en un maillage tubulaire unique (repères par transport parallèle, pas de vrille), feuilles en `InstancedMesh` de cartes découpées en amande dans le fragment shader (aucune texture, aucun tri alpha). Géométrie reconstruite uniquement quand un paramètre de *forme* change ; budget de branches plafonné (`MAX_TREE_BRANCHES`) car la récursion est en `childCount ^ levels`.
- **`texture/interaction-map`** (*Interaction Map*) : Carte top-down de ce qui est passé par là — caméra orthographique zénithale, cible de rendu persistante en ping-pong, estompage exprimé en **demi-vie (secondes)** et non en facteur par frame, afin qu'une trace dure le même temps réel à 30 comme à 144 fps. La carte **défile avec son centre** : câblez la position d'un personnage et elle le suit, son contenu se décalant d'autant en UV pour que les marques restent fixes dans le monde. Rien n'y est spécifique à l'herbe : neige, sable, chaleur, humidité, effacement.
- **`geometry/wind-sway`** (*Wind Sway*) : Ployage de n'importe quelle géométrie du graphe **par injection shader** (`onBeforeCompile`) et non par déformation de sommets — donc applicable à un import de 200 k sommets. Le matériau amont est cloné avant patch, jamais modifié en place.

## 10. Entrées Interactives (Chantier 3 — amorce FPS)
Briques d'entrée conçues pour que le reste du graphe **ignore d'où vient la commande** :
- **`physics/world`** (*Physics World*) : Monde de corps rigides **Rapier**. Pourquoi un moteur et pas un solveur maison : empilement, contacts au repos, frottement et articulations sont chacun individuellement difficiles et collectivement un projet de recherche. Le contrôleur à capsule couvre déjà le seul cas où un solveur est le mauvais outil (un personnage, qui veut du contrôle exact plutôt que de l'inertie) ; celui-ci est pour tout le reste — caisses, débris, ragdolls, véhicules.
  - **Pas de temps fixe** avec report du reste entre les frames. Un pas variable fait qu'une pile de caisses se stabilise différemment à 60 et à 144 fps, et qu'un export ne ressemble pas à la preview dans laquelle il a été composé.
  - **Plafond de sous-pas** : cinq secondes d'onglet en arrière-plan valent 300 pas ; le surplus est **abandonné et non mis en banque**, car le mettre en banque garantit que la frame suivante dépasse aussi son budget, en spirale.
  - Build **`-compat`** délibéré : il embarque le WASM et s'initialise de façon asynchrone — pas de `vite-plugin-wasm`, pas de top-level await dans le bundle, pas d'asset séparé à égarer dans un build Tauri. Tant qu'il compile, `Ready` vaut 0 et les corps laissent passer leur géométrie : rien ne bloque, rien ne lève.
- **`physics/rigid-body`** (*Rigid Body*) : Confie une géométrie au monde. Forme par défaut selon le type : **enveloppe convexe** pour un corps dynamique (économique, toujours fermée, s'empile de façon prévisible), **maillage de triangles** pour un corps fixe (la seule forme qui représente un niveau exactement, et son absence de volume ne gêne que ce qui bouge). Le corps est reconstruit quand sa *forme* change et laissé tranquille sinon, donc régler le frottement ne redémarre jamais la simulation.
  - **L'échelle de l'objet est intégrée aux sommets du collider**, parce qu'un corps Rapier ne porte que position et rotation. L'oublier transforme un sol construit en cube unité mis à l'échelle 30 × 1 × 30 — ce dont tous les niveaux sont faits ici — en collider 1 × 1 × 1, et tout atterrit à côté. Même piège que celui rencontré sur le contrôleur à capsule, à l'autre bout du code.
- **`physics/character`** (*Character (Physics)*) : Le frère du contrôleur à capsule, et celui vers lequel se tourner dès qu'un Physics World est dans le graphe. Les deux sont cinématiques — un personnage veut du contrôle exact, pas de l'inertie — mais celui-ci est déplacé par le contrôleur de personnage de Rapier, qui apporte trois choses qu'un balayage maison n'obtient pas gratuitement :
  - **Marche automatique** : escaliers et bordures franchis au lieu de bloquer, sans que l'auteur modélise une rampe invisible par-dessus chaque marche.
  - **Accrochage au sol** : descendre une pente garde le contact au lieu de partir en petite parabole à chaque rupture de surface.
  - **Impulsions aux corps dynamiques** : le personnage bouscule les caisses, ce qui est tout l'intérêt d'avoir un solveur dans la scène.
  - Il entre en collision avec **tout ce qui est dans le monde**, donc son niveau est simplement l'ensemble des `physics/rigid-body` ajoutés : pas d'entrée collider séparée à garder synchronisée avec ce qui est à l'écran.
- **`physics/capsule-controller`** (*Capsule Controller*) : Personnage cinématique à capsule. Transforme « dans quelle direction on pousse » en « où on est » — ce qu'aucune combinaison des nœuds existants ne sait faire, un intégrateur accumulant un déplacement sans rien connaître du monde traversé. Marche sur les sols, glisse le long des murs, tombe des rebords. Collision CPU contre un BVH (`three-mesh-bvh`) : coût nul sur le GPU, résultat identique en export et dans le viewport.
  - **Cinématique et non corps rigide** : un solveur donnerait l'inertie gratuitement au prix du contrôle exact, or le déplacement de personnage est précisément l'endroit où l'auteur veut du contrôle exact — cette vitesse, ce saut, aucun rebond sur les murs, aucun basculement.
  - **Test de collision en espace monde**, chaque triangle candidat y étant amené. L'alternative tentante — emmener la capsule dans l'espace local du mesh, une transformation au lieu de trois par triangle — casse silencieusement sur tout collider à **échelle non uniforme**, c'est-à-dire la plupart : un sol `object/box` est un cube unité mis à l'échelle 16 × 1 × 16 par sa matrice. Dans cet espace la capsule n'est plus une capsule, aucun rayon unique ne la décrit, et le personnage traverse le sol.
  - Pas de reconstruction du BVH par frame (voir `getBoundsTree`), pas de solveur, et un `dt` borné pour qu'une frame longue ne téléporte jamais le personnage à travers un mur.
- **`io/gamepad`** (*Gamepad*) : Manette lue par **polling** (`navigator.getGamepads()` rend un instantané, pas un objet vivant — ce qui correspond exactement au modèle d'évaluation par frame du graphe, donc aucun état global à resynchroniser, contrairement au nœud Keyboard). Mapping standard W3C. Sticks disponibles en scalaires bruts **et** en vecteurs pré-mappés dans le plan XZ `(x, 0, y)` : dans un monde Y-up / −Z-avant, pousser le stick vers le haut fait avancer, ce qui évite de refaire l'erreur de signe à chaque câblage. Gâchettes lues par `value` (donc analogiques, pas binaires), D-pad plié en vecteur pour être interchangeable avec un stick.
  - **Zone morte radiale, pas par axe** : une zone morte appliquée séparément à X et Y découpe un carré dans un stick rond, et une diagonale douce ne déclenche alors ni l'un ni l'autre — le personnage refuse de marcher en diagonale. La magnitude est traitée d'abord, puis le vecteur entier est remis à l'échelle.
  - **Remise à l'échelle après seuil** : annuler simplement sous le seuil laisse une marche à la sortie de la zone morte (rien, puis un saut à 0.15), ce qui se ressent comme un contrôle nerveux.
- **`math/integrate`** / **`vector/integrate`** (*Integrate*, *Integrate Vector*) : **La moitié manquante de tout schéma de contrôle.** Un nœud d'entrée dit à quelle force on pousse *maintenant* ; le câbler directement dans une position fait du stick une coordonnée absolue — on relâche, l'objet retourne à l'origine, puisque « pousser zéro » veut dire « position zéro ». Ce qu'il faut, c'est l'accumulation dans le temps : `position += vitesse × dt`. Générique par construction : la même brique intègre une accélération en vitesse, un taux en angle, un débit en niveau.
  - **Amortissement par seconde, pas par frame** — sinon un objet roule plus loin sur une machine lente que sur une rapide.
  - **Attention au sens de l'amortissement** : il fait décroître *la valeur accumulée*. Sur une vitesse c'est du frottement ; sur une position, c'est un aimant vers l'origine. Chaîner deux intégrateurs — amorti pour la vitesse, non amorti pour la position — donne à la fois de la traînée et un endroit où s'arrêter.
  - **Réinitialisation au scrub arrière** : ce que l'intégrateur contient est la somme de tout ce qui s'est passé depuis son démarrage, somme qui n'a plus de sens dès qu'on saute ailleurs dans le temps. Le retour à `Initial` est ce qui rend une frame exportée reproductible.
  - `Max Length` borne le vecteur accumulé **radialement**, pour qu'une zone de jeu limitée soit ronde et non carrée.
- **`io/action-map`** (*Action Map*) : Plusieurs sources → une action nommée. C'est la brique qui **sort le schéma de contrôle du reste du graphe** : « avancer » est un seul fil, et savoir si ça vient de Z, du stick gauche, du D-pad ou d'un contrôle tactile ne regarde que ce nœud. Sans lui, chaque consommateur doit connaître chaque périphérique, et ajouter une manette veut dire éditer tout le graphe au lieu d'un nœud.
  - Sockets **Positive** et **Negative** croissants, parce que la plupart des actions sont en réalité des axes : avancer *moins* reculer. Câbler D en positif et Q en négatif donne un axe −1…1 à partir de deux touches numériques — le cas qu'un nœud « additionne les entrées » ne sait pas exprimer.
  - Combinaison par défaut **le plus fort** : tenir Z *et* pousser le stick doit marcher à une seule vitesse, pas à deux.
  - **Lissage exprimé en secondes** (comme la demi-vie de l'Interaction Map), donc indépendant du framerate : un lerp par frame rend un contrôle plus vif sur une machine rapide, bug qui n'apparaît que sur le matériel de quelqu'un d'autre.
  - Ne lit aucun matériel : il ne fait que combiner, et marche donc aussi bien sur un oscillateur, un pic audio ou un flux réseau.

---

## 🔗 Notes Associées
- [[Creative FX and Stage Nodes]]
- [[Creative WebGL Shaders and Distortion Techniques]]
- [[Node Creation Guide]]
- [[Parametric Geometry and Modifiers]]
- [[Socket Type System and Ownership]]
- [[WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics]]
- [[Universal_Nodes_Catalog_3_Chantiers]]
- [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]]
- [[Vegetation_and_Wind_Nodes_Catalog]]
