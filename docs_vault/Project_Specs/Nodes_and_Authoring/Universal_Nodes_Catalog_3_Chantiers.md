# Universal Nodes Catalog : Les 3 Grands Chantiers

*Emplacement : `docs_vault/Project_Specs/Nodes_and_Authoring/`*

Ce document détaille la spécification complète, les signatures de sockets, les paramètres par défaut et les responsabilités atomiques de chaque nœud conçu pour les **3 Grands Chantiers** (Fluide 3D & Feu, Éclairage Volumétrique & TRAA, Caméra FPS Unreal-Like).

---

## 1. Chantier 1 : Simulation Fluide 3D & Feu Volumétrique

### Nœud 1.1 : `physics/curl-noise-3d` (*Curl Noise 3D*)
- **Rôle** : Génère un champ vectoriel 3D sans divergence $(\nabla \cdot \mathbf{u} = 0)$ pour animer les micro-turbulences.
- **Catégorie** : `physics`
- **Entrées** :
  - `frequency` (`value`, défaut: 10.0)
  - `amplitude` (`value`, défaut: 3.2)
  - `speed` (`value`, défaut: 0.5)
- **Sorties** :
  - `texture` (`texture`) : `THREE.Data3DTexture` (champ de vecteurs RGBA Float)
  - `field` (`any`) : descripteur d'évaluation pure

### Nœud 1.2 : `physics/mesh-fluid-emitter` (*Mesh Fluid Emitter*)
- **Rôle** : Transforme une géométrie Three.js en source d'émission de fluide / feu / fumée.
- **Catégorie** : `physics`
- **Entrées** :
  - `geometry` (`geometry`) : maillage source
  - `density` (`value`, défaut: 7.0)
  - `temperature` (`value`, défaut: 5.5)
  - `motionBoost` (`value`, défaut: 0.25)
  - `radius` (`value`, défaut: 1.0)
- **Sorties** :
  - `emitter` (`any`) : descripteur d'émetteur pour le solveur

### Nœud 1.3 : `physics/fluid-solver-3d` (*Fluid Solver 3D*)
- **Rôle** : Solveur eulérien Navier-Stokes incompressibles sur grille 3D.
- **Catégorie** : `physics`
- **Entrées** :
  - `forces` (`any`) : champ vectoriel externe (ex. Curl Noise)
  - `emitter` (`any`) : source d'injection issue d'un Mesh Fluid Emitter
  - `buoyancy` (`value`, défaut: 3.0) : poussée thermique verticale
  - `cooling` (`value`, défaut: 1.0) : vitesse de dissipation thermique
  - `dissipation` (`value`, défaut: 0.4) : atténuation de la densité
  - `wind` (`vector`, défaut: $(0,0,0)$) : vent global
  - `jacobiSteps` (`value`, défaut: 4) : nombre d'itérations de pression
- **Sorties** :
  - `velocityField` (`texture`) : `THREE.Data3DTexture` des vitesses
  - `dyeField` (`texture`) : `THREE.Data3DTexture` de densité / température

### Nœud 1.4 : `material/volume-3d` (*Volume Material 3D*)
- **Rôle** : Shader de raymarching volumétrique pour textures 3D avec rayonnement de corps noir.
- **Catégorie** : `physics`
- **Entrées** :
  - `dyeField` (`texture`) : texture 3D de densité/température
  - `fireIntensity` (`value`, défaut: 40.0)
  - `shadowAbsorption` (`value`, défaut: 2.0)
  - `powderStrength` (`value`, défaut: 0.59)
  - `glowSpread` (`value`, défaut: 5.0)
  - `steps` (`value`, défaut: 48)
  - `startColor` / `midColor` / `endColor` (`color`) : rampe de couleur thermique
- **Sorties** :
  - `geometry` (`geometry`) : maillage cube de volume avec matériau appliqué
  - `material` (`material`) : descripteur de matériau Tsuji

### Nœud 1.5 : `simulation/fire-fluid-volume` (*Volumetric Fire Sim - Macro*)
- **Rôle** : Nœud macro "tout-en-un" prêt à l'emploi pour feux volumétriques avec lumière synchrone.
- **Catégorie** : `physics`
- **Entrées** : `emitterMesh`, `density`, `temperature`, `buoyancy`, `turbulence`, `cooling`, `dissipation`, `wind`, `fireIntensity`, `steps`.
- **Sorties** :
  - `geometry` (`geometry`) : maillage du volume de flammes
  - `velocityField` (`texture`) : champ de vitesse 3D
  - `light` (`geometry`) : source `THREE.PointLight` dynamique synchronisée

---

## 2. Chantier 2 : Éclairage Volumétrique & TRAA (Spécification)

### Nœud 2.1 : `lighting/volumetric-fog` (*Volumetric Fog*)
- **Rôle** : Évalue le scattering lumineux volumétrique le long des rayons de la caméra.
- **Catégorie** : `lighting`
- **Entrées** :
  - `density` (`value`, défaut: 0.05) : densité du brouillard
  - `anisotropy` (`value`, défaut: 0.6) : paramètre $g$ de Henyey-Greenstein
  - `color` (`color`, défaut: blanc) : albédo de diffusion
  - `maxDistance` (`value`, défaut: 50.0) : portée maximale d'échantillonnage
  - `steps` (`value`, défaut: 32) : pas de raymarching
- **Sorties** :
  - `volume` (`geometry`) : objet volumétrique injecté dans la scène

### Nœud 2.2 : `postprocess/traa` (*Temporal Reprojection Anti-Aliasing*)
- **Rôle** : Lisse temporellement les passes volumétriques bruitées via velocity buffer et clamping d'historique.
- **Catégorie** : `postprocess`
- **Entrées** :
  - `feedback` (`value`, défaut: 0.9) : poids de l'historique
  - `clampingRadius` (`value`, défaut: 1.0) : rayon de contrainte dans l'espace couleur
- **Sorties** :
  - `postprocess` (`postprocess`) : passe chaînable dans le nœud `render`

---

## 3. Chantier 3 : Entrées Interactives & Moteur Physique Rapier (Réalisé & Élargi)

*Note d'évolution : Le projet initial prévoyait un nœud unique `camera/fps-controller`. Il a été abandonné au profit d'une architecture modulaire bien plus puissante : séparation stricte entre la commande d'entrée, la cinématique du personnage et un véritable moteur physique 3D temps réel (Rapier).*

### Nœud 3.1 : `io/move-input` (*Move Input*)
- **Rôle** : Schéma de contrôle complet clavier + manette en un seul nœud, directement projeté dans le plan du sol (Y-up, avant = $-Z$).
- **Catégorie** : `io`
- **Entrées** : `speed` (`value`), `enabled` (`value`).
- **Sorties** : `move` (`vector` XZ), `x` (`value`), `z` (`value`), `forward` (`value`, $+1$ = avance), `magnitude` (`value`), `jump` (`value`), `jumpPressed` (`value`), `sprint` (`value`).
- **Fonctionnalités** : Layouts multiples (`zqsd`, `wasd`, `arrows`, `zqsd+arrows`, `wasd+arrows`, `custom`), repli stick gamepad (`strongest wins`), réservation des touches en cours de lecture pour inhiber les raccourcis éditeur (voir [[Input Subsystem and Playback Keys]]).

### Nœud 3.2 : `physics/world` (*Physics World*)
- **Rôle** : Monde physique de corps rigides basé sur **Rapier 3D** (`@dimforge/rapier3d-compat`).
- **Catégorie** : `physics`
- **Entrées** : `gravity` (`vector`), `time` (`value`), `paused` (`value`), `reset` (`value`).
- **Sorties** : `world` (`any`), `ready` (`value`), `bodies` (`value`), `steps` (`value`).
- **Fonctionnalités** : Pas de temps fixe déterministe avec report du reste, chargement WASM asynchrone sans blocage, gestion des sous-pas plafonnés, invalidation par `simulationEpoch`.

### Nœud 3.3 : `physics/rigid-body` (*Rigid Body*)
- **Rôle** : Enregistre des géométries comme corps rigides physiques (dynamiques, fixes ou cinématiques).
- **Catégorie** : `physics`
- **Entrées** : `geometry` (`geometry`), `world` (`any`), `mass`, `friction`, `restitution`, `linearDamping`, `angularDamping`.
- **Sorties** : `geometry` (`geometry`), `matrix` (`matrix`), `count` (`value`).
- **Fonctionnalités** : Paramètre `Split` (`per-child` par défaut / `whole`), prise en charge transparente des `THREE.InstancedMesh` (un nœud simule 100 instances d'un `Array`), dérivation des matrices monde par chaîne de matrices locales (`worldMatrixOf`) éliminant les bugs de reparenting, identité persistante par géométrie.

### Nœud 3.4 : `physics/character` (*Character (Physics)*)
- **Rôle** : Contrôleur cinématique de personnage sur Rapier.
- **Catégorie** : `physics`
- **Fonctionnalités** : Franchissement automatique de marches (*auto-step*), adhérence au sol dans les pentes (*ground snapping*), impulsion dynamique sur les caisses et débris.

### Nœud 3.5 : `physics/vehicle` (*Raycast Vehicle*)
- **Rôle** : Véhicule à 4 roues sur contrôleur raycast Rapier.
- **Catégorie** : `physics`
- **Fonctionnalités** : Centre de masse bas paramétrable, suspension et friction calculées par rayon, hook de pré-pas, sortie `wheels` en liste de matrices monde incluant braquage et rotation.

### Nœuds 3.6 & 3.7 : `math/integrate` & `vector/integrate` (*Integrators*)
- **Rôle** : Intégration temporelle $\int v \, dt$ avec amortissement par seconde et réinitialisation sur scrub arrière / epoch.

### Nœud 3.8 : `physics/capsule-controller` (*Capsule Controller*)
- **Rôle** : Contrôleur de personnage cinématique autonome sur arbre BVH (`three-mesh-bvh`), insensible à l'échelle non-uniforme des colliders.

---

## 4. Chantier 4 : Végétation & Vent (Réalisé)
*Spécification complète détaillée dans [[Vegetation_and_Wind_Nodes_Catalog]] :*
- `physics/wind-field` : champ de vent partagé 2 octaves CPU/GLSL.
- `structure/grass-field` : herbe sans instanciation, repliement torique, ombrage des brins et sortie texture `groundShadow`.
- `object/tree` : arbre procédural récursif par espèce et silhouette de feuille.
- `texture/interaction-map` : traces d'écrasement top-down défilantes avec estompage en demi-vie.
- `geometry/wind-sway` : déformation de vent GPU par injection shader `onBeforeCompile`.

---

## 🔗 Notes Associées
- [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]]
- [[Vegetation_and_Wind_Nodes_Catalog]]
- [[Node Catalog]]
- [[Simulation Reset and Epoch Architecture]]
- [[Input Subsystem and Playback Keys]]
- [[Named Variables System]]
- [[WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics]]
- [[WebGPU Volumetric Lighting and TRAA Integration]]
- [[Unreal FPS Camera and Kinematic Capsule Controller]]
