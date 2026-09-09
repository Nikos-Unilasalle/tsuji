# Strategic Roadmap : Les 3 Grands Chantiers (Fire Sim, Volumetric Lighting, Unreal FPS)

*Emplacement : `docs_vault/Future_Roadmap/`*

Ce document constitue la feuille de route stratégique majeure pour l'évolution du moteur Tsuji suite à la sortie de **Three.js r185**, découpée en 3 chantiers prioritaires conçus dans un esprit d'**universalité**, de **générisme** et d'**atomicité**.

---

## 1. Principes Fondateurs de Conception

Pour chaque chantier, nous appliquons rigoureusement les principes architecturaux de Tsuji :
1. **Atomicité & Responsabilité Unique** : Ne jamais concevoir un "gros nœud monolithique" réservé à un seul effet visuel. Décomposer chaque mécanisme en briques élémentaires réutilisables.
2. **Respect des 12 Sockets Natifs** : `value`, `vector`, `matrix`, `color`, `geometry`, `texture`, `curve`, `material`, `list`, `text`, `postprocess`, `any`.
3. **Protocole P0 VRAM & Cycle de Vie** : Toutes les allocations GPU (`Data3DTexture`, `ShaderMaterial`, géométries dynamiques) doivent être strictement encapsulées dans `createNodeCache<T>` avec fonction de libération explicite lors des démontages.
4. **Compatibilité Double Moteur (WebGL & WebGPU)** : Implémenter des cœurs algorithmiques robustes exploitant les formats standards Three.js afin de faciliter la migration transparente vers WebGPU.

---

## 2. Tableau de Suivi des 3 Chantiers

| Chantier | Thématique | Statut | Nœuds Clés Associés | Fichiers Implémentés |
| :--- | :--- | :--- | :--- | :--- |
| **Chantier 1** | **Simulation Fluide 3D & Feu Volumétrique** | **Terminé & Validé** | `physics/curl-noise-3d`<br>`physics/mesh-fluid-emitter`<br>`physics/fluid-solver-3d`<br>`material/volume-3d`<br>`simulation/fire-fluid-volume` | `fluidRuntime3D.ts`<br>`fluidSim.ts`<br>`fluidSim.test.ts` |
| **Chantier 2** | **Éclairage Volumétrique & TRAA** | **Prêt à Lancer** | `lighting/volumetric-fog`<br>`postprocess/traa`<br>`lighting/light-shafts` | `src/shared/three/lighting/`<br>`src/shared/graph/nodes/volumetricLighting.ts` |
| **Chantier 3** | **Caméra FPS & Navigation Unreal-Like** | **Prêt à Lancer** | `camera/fps-controller`<br>`physics/capsule-collider`<br>`io/gamepad-input` | `src/shared/three/controls/`<br>`src/shared/graph/nodes/fpsCamera.ts` |

---

## 3. Détail du Chantier 1 (Complété)

- **Moteur Navier-Stokes 3D** : Advection semi-Lagrangienne, itérations de Jacobi pour la pression de Poisson, flottabilité thermique, vent et génération de Curl Noise sans divergence.
- **Rendu Volumétrique** : Raymarching 3D avec palette de corps noir et loi de Beer-Lambert.
- **Validation** : 100% de tests unitaires réussis, 0 erreur TypeScript, suite globale de 1895 tests au vert.

---

## 4. Plan d'Exécution du Chantier 2 (Volumetric Lighting & TRAA)

1. Implémenter le module de calcul de diffusion volumétrique (`src/shared/three/lighting/volumetricFogRuntime.ts`).
2. Créer le nœud de milieu participant `lighting/volumetric-fog` et la passe de post-traitement temporelle `postprocess/traa`.
3. Mettre en place un test de non-régression et un projet de démonstration interactif.

---

## 5. Plan d'Exécution du Chantier 3 (Unreal FPS Camera)

1. Développer le moteur cinématique de capsule (`src/shared/three/controls/fpsCapsuleController.ts`) avec gestion des pentes et marches.
2. Créer le nœud `camera/fps-controller` universel avec contrôle souris/clavier et head bobbing.
3. Intégrer la détection de sol sur maillages complexes via BVH.

---

## 🔗 Notes Associées
- [[Universal_Nodes_Catalog_3_Chantiers]]
- [[ThreeJS r185 Release and Migration Deep Dive]]
- [[WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics]]
- [[WebGPU Volumetric Lighting and TRAA Integration]]
- [[Unreal FPS Camera and Kinematic Capsule Controller]]
- [[Node Catalog]]
