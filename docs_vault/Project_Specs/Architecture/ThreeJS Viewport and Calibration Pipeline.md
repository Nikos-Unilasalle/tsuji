# ThreeJS Viewport and Calibration Pipeline

*Emplacement dans le code : `src/shared/three/Viewport.tsx`, `src/shared/graph/calibration/dlt.ts`*

Ce document détaille le pipeline de rendu Three.js, la gestion des vues multiples et la calibration spatiale par DLT dans Tsuji.

---

## 1. Pipeline 3D Unifié

- Tous les éléments 2D (formes, textes) sont générés comme de la géométrie 3D plane positionnée à $z = 0$.
- Les projections, déformations et décalages d'angle s'exécutent au sein du même pipeline Three.js sans surcouche 2D externe.

---

## 2. Calibration Spatiale : Nœud `Room Corner` et Solveur DLT

- **Principe** : L'opérateur définit les dimensions physiques de la pièce et ajuste les poignées 2D sur les coins visibles de la salle.
- **Calcul DLT (`dlt.ts`)** : La résolution matricielle estime simultanément la position $(x, y, z)$, l'orientation tridimensionnelle et la matrice de projection asymétrique intégrant le *lens shift* du vidéoprojecteur.
- **Erreur de Reprojection** : Le résidu numérique est renvoyé en temps réel pour valider la précision de l'alignement.

---

## 3. Chaîne de Post-Traitement (`postProcessChain.ts`)

Passe de rendu en espace écran combinant :
- Passes Optiques : Bloom (`postprocess/bloom`), Profondeur de champ DOF (`postprocess/dof`), Vignettage, aberrations chromatiques (RGB shift) et occlusion ambiante SSAO.
- Passes Pellicule & Imprimerie : Dual Tone (`postprocess/duotone`), Trame d'imprimerie (`postprocess/halftone`), Grain argentique (`postprocess/film-texture`), Super 8 (`postprocess/super8`), Brosse sèche (`postprocess/dry-brush`). Voir [[Vintage Film Post Processing]].

---

## 4. Modes de Vue (2D / 3D) & Automatismes d'Ergonomie

- **Transition 2D $\rightarrow$ 3D Automatisée** :
  - Lorsqu'un utilisateur bascule de la vue 2D à la vue 3D dans le Viewport, l'application réinitialise dynamiquement l'état pour une reprise en main immédiate :
    1. Déverrouillage de la caméra (`setIsViewLocked(false)`).
    2. Désactivation du dôme d'environnement 3D (`setIsEnvEnabled(false)`).
    3. Réinitialisation complète des coordonnées et de la cible de la caméra 3D (`resetCameraRef.current()`).
- **Initialisation de la Timeline** :
  - La timeline démarre en mode **Pause** par défaut (`isPlaying = false`) afin de préserver les cycles GPU/CPU lors de l'ouverture d'un projet volumineux ou de la conception d'un graphe complexe.
- **Bascule Plein Écran (`Fullscreen`)** :
  - Intégration d'un bouton de passage en plein écran natif / web à l'extrême droite de la barre supérieure, maximisant la visibilité scénographique en régie ou lors de tests de projection.

---

## 5. Résolution Ciblée du Gizmo de Transformation (`resolveGizmoTarget`)

Lors de la sélection d'un nœud dans l'éditeur de graphe :
- **Modificateurs Purs (Twist, Wave, Subdivide, etc.)** : Le gizmo est physiquement positionné sur l'objet affiché, mais ses deltas d'interaction sont réinjectés vers l'amont sur le nœud générateur d'origine (`objectNodeId`) qui détient les propriétés `location`, `rotation`, `scale`.
- **Sous-Graphes et Groupes (`structure/group`)** : Prise en charge native du gizmo de manipulation 3D pour translater et orienter un groupe entier comme un conteneur unique.

---

## 🔗 Notes Associées
- [[ThreeJS Optimization and Performance Guide]]
- [[Projective Geometry and DLT Calibration]]
- [[State Management and Multi-Canvas]]
- [[P4_Gizmo_Modifier_Resolution_and_Deform_Sync]]
- [[Vintage Film Post Processing]]
- [[Parametric Geometry and Modifiers]]

