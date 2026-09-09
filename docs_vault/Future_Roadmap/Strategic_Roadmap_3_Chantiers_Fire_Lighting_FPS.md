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
| **Chantier 3** | **Entrées, Personnage & Physique** | **Terminé & Validé** | `io/gamepad`<br>`io/action-map`<br>`math/integrate`, `vector/integrate`<br>`physics/capsule-controller`<br>`physics/world`, `physics/rigid-body`<br>`physics/character`, `physics/vehicle` | `gamepadRuntime.ts`, `nodes/input.ts`<br>`nodes/integrate.ts`<br>`three/controls/capsuleController.ts`<br>`three/physics/rapierRuntime.ts`, `nodes/rapier.ts` |
| **Chantier 4** | **Végétation & Vent** | **Terminé & Validé** | `physics/wind-field`<br>`structure/grass-field`<br>`object/tree`<br>`geometry/wind-sway`<br>`texture/interaction-map` | `three/vegetation/*`<br>`nodes/vegetation.ts` |

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

## 5. Chantier 3 (Complété) — et son changement de cap

Livré tel que planifié pour les entrées et la capsule BVH, puis **élargi à un vrai moteur physique** en cours de route :

1. **Entrées** — `io/gamepad` (zone morte radiale, gâchettes analogiques) et `io/action-map` (plusieurs sources → une action nommée, sockets Positive/Negative croissants). Le reste du graphe ignore d'où vient la commande.
2. **Intégrateurs** — `math/integrate` et `vector/integrate`. La moitié manquante de tout schéma de contrôle : une entrée dit à quelle force on pousse *maintenant*, l'intégrateur en fait un déplacement qui persiste au relâchement.
3. **Capsule cinématique BVH** — `physics/capsule-controller`, sans dépendance, collision en espace monde (voir la note sur les colliders à échelle non uniforme dans le [[Node Catalog]]).
4. **Moteur physique** — Rapier (`@dimforge/rapier3d-compat`) : `physics/world`, `physics/rigid-body`, `physics/character` (marche automatique, accrochage au sol, poussée des corps dynamiques) et `physics/vehicle` (voiture raycast). Chargé par `import()` dynamique, donc découpé en chunk séparé et téléchargé seulement si la physique est utilisée.

**Non retenu** : le nœud `camera/fps-controller`. La caméra top-down existante couvre le besoin, et un contrôleur de caméra dédié aurait doublonné avec `calibration/camera` sans rien apporter au déplacement.

---

## 🔗 Notes Associées
- [[Universal_Nodes_Catalog_3_Chantiers]]
- [[ThreeJS r185 Release and Migration Deep Dive]]
- [[WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics]]
- [[WebGPU Volumetric Lighting and TRAA Integration]]
- [[Unreal FPS Camera and Kinematic Capsule Controller]]
- [[Node Catalog]]
