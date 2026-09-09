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

## 3. Chantier 3 : Caméra FPS & Navigation Unreal-Like (Spécification)

### Nœud 3.1 : `camera/fps-controller` (*Unreal FPS Controller*)
- **Rôle** : Contrôleur cinématique complet à la première personne.
- **Catégorie** : `calibration`
- **Entrées** :
  - `walkSpeed` (`value`, défaut: 5.0)
  - `runSpeed` (`value`, défaut: 9.0)
  - `jumpForce` (`value`, défaut: 7.5)
  - `gravity` (`value`, défaut: 20.0)
  - `capsuleRadius` (`value`, défaut: 0.4)
  - `capsuleHeight` (`value`, défaut: 1.8)
  - `stepHeight` (`value`, défaut: 0.35) : franchissement d'escaliers
  - `headBobAmount` (`value`, défaut: 0.05)
- **Sorties** :
  - `camera` (`any`) : caméra active pour le viewport
  - `position` (`vector`) : position monde du joueur
  - `velocity` (`vector`) : vecteur vitesse instantané
  - `isGrounded` (`value`) : booléen de contact avec le sol

---

## 🔗 Notes Associées
- [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]]
- [[Node Catalog]]
- [[Node Creation Guide]]
- [[WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics]]
- [[WebGPU Volumetric Lighting and TRAA Integration]]
- [[Unreal FPS Camera and Kinematic Capsule Controller]]
