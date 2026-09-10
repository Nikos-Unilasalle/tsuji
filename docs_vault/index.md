# Tsuji Knowledge Base & Project Specifications — Agentic RAG Vault

> 🎛️ **Accès Rapide :** Consultez le **[[Dashboard]]** pour une vue synoptique, les métriques en temps réel, les alertes de failles et le cockpit développeur.

Bienvenue dans le coffre de connaissances (Obsidian Vault). Ce système est structuré en **notes atomiques hautement spécialisées et interconnectées** selon 4 grands domaines :

---

## 🗺️ 1. 🧠 Base de Connaissances Générique (`Knowledge_Base/`)

### 🌟 Synthèses Maîtresses
- [[ThreeJS GPU Optimization Synthesis and Production Playbook]] — **Synthèse GPU & Rendu**
- [[Browser Memory Management, Caching and WebGL Performance]] — **Synthèse Mémoire, Caches & Navigateurs**
- [[ThreeJS Creative Showcase Synthesis and Node Ideas]] — **Synthèse Créative Three.js & Dérivations Nodales**

### ⚡ Optimisation Three.js (`Knowledge_Base/ThreeJS_Optimization/`)
- [[ThreeJS r185 Release and Migration Deep Dive]] — Synthèse de la version r185, WebGPU, TSL et nouveaux exemples.
- [[Draw Call Reduction Strategies]] — Principes de regroupement et budgets de draw calls.
- [[InstancedMesh Usage and Best Practices]] — Instanciation de maillages identiques et gestion de buffers.
- [[Advanced Instancing and Attribute-Driven Shading]] — Instanciation avancée, orientation sur normales et textures canvas.
- [[BatchedMesh Usage and Tradeoffs]] — Rendu par lots de géométries hétérogènes.
- [[GPU Memory and VRAM Leak Prevention]] — Déconnexion GC/VRAM et cycle de vie.
- [[Recursive ThreeJS Disposal Protocol]] — Fonction standard de libération récursive.
- [[Shader Prewarming and Async Compilation]] — Élimination des gels de compilation via `compileAsync`.
- [[Matrix Auto-Update Optimization]] — Désactivation de `matrixAutoUpdate` pour les objets fixes.
- [[Frustum Culling and Bounding Volumes]] — Culling de caméra et sphères englobantes.

### 📦 Assets & Compression (`Knowledge_Base/Assets_and_Compression/`)
- [[KTX2 and Basis Universal Texture Compression]] — Formats de textures GPU natifs (BC7/ASTC).
- [[Meshopt Geometry Compression and gltfpack]] — Optimisation du cache de sommets et quantization.
- [[Draco vs Meshopt Comparison]] — Comparatif débit réseau vs décompression CPU.
- [[GLTF Asset Ingestion Pipeline]] — Pipeline industriel d'ingestion et chargeurs Three.js.

### 🌐 Mémoire & Runtime Navigateurs (`Knowledge_Base/Browser_Memory_and_Runtime/`)
- [[JavaScript Heap vs GPU VRAM Dual-Stack]] — Modèle des deux mémoires disjointes.
- [[Garbage Collection Pauses and Mitigation]] — Évitement des saccades de *Major GC*.
- [[Object Pooling in 60 FPS Render Loops]] — Pattern zéro-allocation en rendu.
- [[IndexedDB and Cache API Storage Patterns]] — Caching binaire et proscription du Base64.
- [[Web Workers and OffscreenCanvas Multi-Threading]] — Découplage du rendu WebGL hors du thread UI.
- [[Zero-Copy Data Transfer via Transferables]] — Transfert instantané de mémoire sans duplication.
- [[Safari and iOS WebKit Memory Limits]] — Limites mémoires strictes, canvas hoarding et watchdog Jetsam.
- [[Chromium ANGLE and TDR Timeouts]] — Couche ANGLE et timeouts de pilote graphique.
- [[WebGL Context Loss and Restoration Lifecycle]] — Gestion et résilience aux pertes de contexte.
- [[Chrome DevTools Memory Profiling Playbook]] — Guide pratique de diagnostic Heap & Timeline.

### 🎨 Shading & Rendu Écran (`Knowledge_Base/Shading_and_Rendering/`)
- [[Early-Z and Depth Pre-Pass Techniques]] — Élimination de l'overdraw en 2 passes.
- [[Overdraw Reduction and Pixel Ratio Capping]] — Plafonnement du DPR sur écrans Retina.
- [[GLSL Branchless Programming and Optimization]] — Élimination des `if/else` divergents.
- [[Cook-Torrance BRDF and Metallic-Roughness Model]] — Formulations optiques du rendu PBR.
- [[Post-Processing Uber-Shader Passes]] — Compilation fusionnée d'effets plein écran.
- [[Creative WebGL Shaders and Distortion Techniques]] — Distorsions liquides, aberrations chromatiques, Voronoi et ondes de choc.
- [[Optical Glass Refraction and Dispersion Shaders]] — Réfraction physique de verre, dispersion de Cauchy et passes FBO.
- [[Stylized Procedural SDFs and NPR Anime Rendering]] — Champs de distance signés (SDF), soustraction lissée polynomiale, flammes cartoon et nuages Ghibli.
- [[Shadow Map Optimization and Baking]] — Gestion et caching des ombres portées.
- [[WebGPU Architecture and TSL Shaders]] — Moteur WebGPU et shaders TSL.
- [[WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics]] — Solveur fluide eulérien 3D et raymarching de corps noir.
- [[WebGPU Volumetric Lighting and TRAA Integration]] — Éclairage volumétrique, milieux participants et antialiasing temporel (TRAA).

### 📐 Algorithmique & Mathématiques (`Knowledge_Base/Algorithms_and_Math/`)
- [[Unreal FPS Camera and Kinematic Capsule Controller]] — Contrôleur de caméra première personne cinématique et franchissement de marches.
- [[Node Graph Evaluation Models Push vs Pull]] — Modèles d'exécution de graphes.
- [[Kahn Algorithm and DAG Topological Sorting]] — Tri topologique linéaire $\mathcal{O}(V+E)$.
- [[Cycle Detection and Feedback Resolution]] — Résolution des boucles temporelles ($t - 1$).
- [[Bounding Volume Hierarchy and Raycasting]] — Arbres BVH pour le raycasting en $\mathcal{O}(\log N)$.
- [[Arrival Easing and Segment Interpolation Math]] — Modèle d'atténuation d'arrivée sur les images-clés.
- [[Cubic Bezier Root Bisection Solvers]] — Résolution de courbes Bézier par bissection.
- [[Spring-Damper Harmonic Dynamics]] — Équations différentielles de ressorts amortis.
- [[Direct Linear Transform (DLT) Projector Calibration]] — Résolution SVD pour la calibration 3D.
- [[Asymmetric Projection Frustums and Lens Shift]] — Modélisation du décentrement optique.
- [[GPGPU Ping-Pong Texture Simulation]] — Simulation de particules par double-buffer flottant.
- [[Fast Fourier Transform (FFT) Audio Analysis]] — Décomposition spectrale par bandes d'énergie.
- [[Audio Transient and Onset Beat Detection]] — Détection de transitoires par flux spectral.

---

## 🗺️ 2. 🛠️ Spécifications du Projet Tsuji (`Project_Specs/`)

### 🏛️ Architecture & Runtime
- [[Graph Evaluation Runtime]] — Évaluateur eager synchrone 60fps (`src/shared/graph/evaluate.ts`).
- [[Simulation Reset and Epoch Architecture]] — Remise à zéro universelle (`Shift+Space`), époque scalaire `simulationEpoch` et synchronisation d'état des simulations.
- [[Input Subsystem and Playback Keys]] — Schéma de contrôle unifié `io/move-input`, layouts ZQSD/manette et réservation contextuelle des raccourcis éditeur.
- [[State Management and Multi-Canvas]] — Gestion multi-arbres (`CANVAS_COUNT = 6`), communication inter-canvas, autosave et IPC.
- [[Socket Type System and Ownership]] — Typage des 12 ports et sémantique `owns: true`.
- [[ThreeJS Viewport and Calibration Pipeline]] — Architecture de `Viewport.tsx` et solveur DLT.
- [[Keyframe Store and Timeline]] — Pistes d'animation `KeyframeStore`, priorité filaire et timeline débrayable (`timelineEnabled`).

### 🧩 Nœuds & Création
- [[Node Creation Guide]] — Guide auteur et contrat de développement.
- [[Node Catalog]] — Inventaire des plus de 135 nœuds disponibles (fluide 3D, Rapier, végétation, variables).
- [[Named Variables System]] — Variables globales typées (`variable/set`, `variable/get`), double-buffering par step et communication multi-canvas.
- [[Universal_Nodes_Catalog_3_Chantiers]] — Spécification complète des nœuds pour les 3 chantiers (Fluide 3D, Éclairage, Entrées & Moteur Rapier).
- [[Vegetation_and_Wind_Nodes_Catalog]] — Catalogue complet de végétation et vent temps réel (champ de vent, herbe torique, arbres, interaction, sway).
- [[Creative FX and Stage Nodes]] — Shaders créatifs (Hologram, Iridescent, Cel-Shade, Fire SDF, Ghibli Clouds) et nœuds scéniques.
- [[Parametric Geometry and Modifiers]] — Modificateurs de maillage (Lattice, Subdivide, Boolean CSG).


### 🖥️ Composants UI & UX
- [[Graph Editor and Canvas]] — Éditeur de graphe `@xyflow/react` et câblage SVG.
- [[Param Panel and Inspector]] — Panneau d'inspection déclaratif et widgets interactifs.

### 🛠️ Maintenance & Qualité
- [[System Invariants and Coding Rules]] — Invariants de pureté et conventions TypeScript.
- [[Testing Harness and Vitest Suites]] — Organisation des tests unitaires Vitest.

---

## 🗺️ 3. 🚀 Évolutions Futures & Roadmap (`Future_Roadmap/`)

- [[Roadmap Overview and Strategic Vision]] — Vue d'ensemble stratégique.
- [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]] — Feuille de route des 3 Chantiers (Feu & Fluide 3D, Éclairage Volumétrique TRAA, Caméra FPS).

### ⚡ 01 - WebGPU & Calcul Parallèle
- [[WebGPURenderer Architecture Migration]] — Transition vers `WebGPURenderer`.
- [[TSL Compute Shaders for Particle Simulation]] — Compute shaders WGSL pour particules ($>2\text{M}$).
- [[Web Worker OffscreenCanvas Pipeline]] — Découplage du rendu sur Worker dédié.

### 🧹 02 - Mémoire & Cycle de Vie
- [[Centralized ResourceLifecycleManager Design]] — Registre central de libération de ressources.
- [[FinalizationRegistry and WeakRef Tracking]] — Filet de sécurité automatique par finalizers.
- [[RenderTarget and Buffer Pooling System]] — Pool réutilisable de render targets.

### 🧩 03 - Sous-Graphes & Modularité
- [[GroupNodeDefinition and Exposed Ports Schema]] — Nœuds groupes et ports exposés.
- [[Hierarchical Subgraph Evaluation Runtime]] — Évaluateur hiérarchique récursif.
- [[User Preset Export and .tsujigroup Library]] — Exportation et bibliothèque de présets macros.

### 📽️ 04 - Vidéo-Mapping Avancé
- [[Soft-Edge Blending Shader Specification]] — Raccord lumineux entre projecteurs voisins.
- [[Non-Linear 3D Mesh Warping Grids]] — Déformation géométrique sur surfaces courbes.
- [[Multi-Screen Native Windowing in Tauri]] — Sorties multi-écrans fenêtrées natives.

### 🎛️ 05 - Protocoles & Entrées/Sorties
- [[MIDI 2.0 Integration and MIDI Learn Mode]] — Contrôle matériel et mode apprentissage rapide.
- [[OSC Network Ingestion and Dispatch]] — Communication réseau UDP avec TouchOSC/Max.
- [[Spout and Syphon Shared GPU Memory Streaming]] — Partage vidéo temps réel inter-applications.
- [[WebCodecs Hardware Video Export at 4K60]] — Exportation matérielle ultra-rapide en 4K 60fps.

### 📦 06 - Virtualisation d'Assets
- [[Background Worker KTX2 Transcoding]] — Transcodage de textures en arrière-plan.
- [[Procedural LOD Mesh Generation]] — Niveaux de détails dynamiques par distance.
- [[IndexedDB Cache for Large PLY Point Clouds]] — Mise en cache binaire de nuages LiDAR.

### ✨ 07 - Effets Créatifs & Transitions Dynamiques
- [[ShaderFX Nodes and Transition Pipeline]] — Spécification des nœuds de distorsion et matériaux réfractants.
- [[Kinetic Audio and Path Dynamics]] — Traînées rubans 3D, déformation de surface audio et boucles SVG.

---

## 🗺️ 4. ⚠️ Audit Critique du Codebase (`Audits_and_Flaws/`)

- [[Audit Overview and Executive Summary]] — Matrice d'évaluation, statuts et synthèse de sévérité.
- 📁 **Plans de Correctifs Appliqués :** [[P0_VRAM_Leak_Remediation_Plan]] · [[P1_Evaluation_Loop_GC_Remediation_Plan]] · [[P2_Geometry_Ownership_and_Clone_Integrity_Plan]] · [[P3_Dynamic_Sockets_and_Math_Consolidation_Plan]]

### 🔴 Fuites Mémoire & Caches GPU *(🟢 RÉSOLU - P0)*
- [[FLAW-01a_Unmanaged Camera Group Cache in camera.ts]] — *(🟢 Résolu)* Fuite du cache de groupe caméra.
- [[FLAW-01b_Unmanaged Sprite Texture Cache in particles.ts]] — Fuite des textures de sprites de particules.
- [[FLAW-01c_Unmanaged GLTF Texture Cache in gltfLoader.ts]] — *(🟢 Résolu)* Fuite des textures éclatées GLTF.
- [[FLAW-01d_Unmanaged State Cache in particleTrails and invertNormals.ts]] — Fuite des états de traînées et normales.

### 🟠 Performance & Boucle d'Évaluation *(🟢 RÉSOLU - P1)*
- [[FLAW-02a_Per-Frame Map and Set Allocation in evaluate.ts]] — *(🟢 Résolu)* Allocations massives de Maps/Sets à 60 fps (Object Pooling).
- [[FLAW-02b_DefaultParams Object Cloning Overhead in Loop]] — *(🟢 Résolu)* Re-clonage des paramètres par défaut (WeakMap).
- [[FLAW-02c_PreviousFrame Session Leak on Viewport Unmount]] — Rétention de session lors du démontage de fenêtres.

### 🟡 Intégrité Géométrique & Clonage *(🟢 RÉSOLU - P2)*
- [[FLAW-03a_One-Hop Ownership Breakage in List Spawners]] — *(🟢 Résolu)* Double affichage sur listes (propagation multi-hop).
- [[FLAW-04a_Array Fast-Path Shallow Copy Bug in cloneGraph.ts]] — *(🟢 Résolu)* Faille de copie superficielle (clonage profond sécurisé).
- [[FLAW-04b_JSON Keyframe Serialization Type Flattening Risk]] — Aplatissement de type des classes Three.js en JSON.

### 🔵 Graphe & Nettoyage *(🟢 RÉSOLU - P3)*
- [[FLAW-06a_Dangling Wire Retention on Dynamic Socket Morphing]] — *(🟢 Résolu)* Purge proactive automatique des connexions fantômes.
- [[FLAW-07a_Duplicated Cubic Bezier Solvers across Codebase]] — *(🟢 Résolu)* Centralisation du solveur de Bézier cubique.
- [[FLAW-07b_Scattered Angle Unit Conversion Redundancies]] — *(🟢 Résolu)* Invariants d'angles stricts verrouillés par tests.

---

## ⚡ Références Rapides
- **Contrat Maître** : [`SCHEMA.md`](file:///Users/nikos/Desktop/tsuji/SCHEMA.md) à la racine du dépôt.
- **Vision Initiale** : [`BIBLE.md`](file:///Users/nikos/Desktop/tsuji/BIBLE.md) à la racine du dépôt.
- **Guide Auteur** : [`NODE_AUTHORING.md`](file:///Users/nikos/Desktop/tsuji/NODE_AUTHORING.md) à la racine du dépôt.
