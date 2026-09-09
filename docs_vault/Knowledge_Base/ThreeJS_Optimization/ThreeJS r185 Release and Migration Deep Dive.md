# ThreeJS r185 Release and Migration Deep Dive

*Emplacement : `docs_vault/Knowledge_Base/ThreeJS_Optimization/`*

Ce document synthétise les nouveautés majeures, ruptures de compatibilité (*breaking changes*) et opportunités architecturales introduites par **Three.js r185** (et la mise à niveau depuis la r184), particulièrement pour le pipeline WebGPU, les shaders TSL (*Three Shading Language*), la manipulation de textures 3D et les nouveaux exemples phares (`webgpu_volume_fire`, `webgpu_volume_lighting_traa`, `games_fps`).

---

## 1. Vue d'Ensemble de Three.js r185

Three.js r185 consolide la transition vers **WebGPURenderer** en unifiant les abstractions de shaders et de simulation sur GPU via **TSL** et les nœuds de rendu (`three/tsl`).

### Principaux points forts de la release r185 :
1. **Stabilisation de WebGPURenderer et NodeMaterial** :
   - Évolution de l'arbre de nœuds TSL pour la compilation croisée WGSL (WebGPU) et GLSL (fallback WebGL2).
   - Optimisation des uniform buffers (UBO) et des bind groups pour minimiser les allocations par frame.
2. **Support étendu des textures volumétriques (`Data3DTexture`)** :
   - Amélioration de l'échantillonnage matériel 3D (`texture3D`, filtering trilinéaire hardware).
   - Utilisation native dans les compute passes et le raymarching volumétrique.
3. **Nouveaux exemples phares de référence** :
   - `webgpu_volume_fire` : Simulation de fluide eulérien 3D temps réel couplée à un raymarching avec radiation de corps noir (*blackbody radiation*).
   - `webgpu_volume_lighting_traa` : Éclairage volumétrique avec milieux diffusants/absorbants et antialiasing temporel (TRAA).
   - `games_fps` : Contrôleur de caméra FPS cinématique inspiré des standards d'Unreal Engine (capsule de collision, saut, lissage des déplacements).

---

## 2. Breaking Changes et Guide de Migration (r184 -> r185)

### A. WebGPURenderer & Node System
- Les constructeurs de certains modules de nœuds TSL ont été unifiés sous l'espace de nom `three/tsl`.
- `renderer.computeAsync()` gère désormais les dépendances d'exécution avec un chaînage plus strict des pipelines de calcul.

### B. Textures et Formats
- Les formats internes de `Data3DTexture` et `StorageTexture` sont plus strictement typés pour assurer la parité exacte entre WebGPU (WGSL) et WebGL2 (GLSL 3.0 ES).

### C. Impact sur le Moteur Tsuji
- Tsuji tourne actuellement sur `three@^0.185.1` avec `@types/three@^0.185.4`.
- Compatibilité descendante garantie pour les modules existants WebGL (`ShaderMaterial`, `MeshStandardMaterial`, `GPUComputationRenderer`).
- Intégration transparente des primitives 3D voxel et du raymarching volumétrique.

---

## 3. Les 3 Nouveaux Chantiers Stratégiques

| Chantier | Exemple Source Three.js | Domaine Tsuji | Objectif Architectural |
| :--- | :--- | :--- | :--- |
| **Chantier 1 : Fluid & Fire Sim** | `webgpu_volume_fire` | `physics` / `texture` | Navier-Stokes 3D eulérien, advection, pression Jacobi, raymarching blackbody |
| **Chantier 2 : Volumetric Lighting** | `webgpu_volume_lighting_traa` | `lighting` / `postprocess` | Raymarching des ombres, milieu participant, TRAA temporal reprojection |
| **Chantier 3 : Unreal FPS Camera** | `games_fps` | `camera` / `calibration` | Contrôleur cinématique de capsule, franchissement d'escaliers, vue subjective |

---

## 🔗 Notes Associées
- [[WebGPU Architecture and TSL Shaders]]
- [[WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics]]
- [[WebGPU Volumetric Lighting and TRAA Integration]]
- [[Unreal FPS Camera and Kinematic Capsule Controller]]
- [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]]
