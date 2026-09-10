# State Management and Multi-Canvas

*Emplacement dans le code : `src/App.tsx`, `src/shared/graph/types.ts`, `src/shared/graph/autosave.ts`*

Ce document décrit la gestion d'état centralisée, le découpage multi-canvas et la persistance dans Tsuji.

---

## 1. Modèle Multi-Canvas (`Project`)

```typescript
export const CANVAS_COUNT = 6;

export interface Project {
  canvases: Graph[];
  activeCanvas: number; // Index 0..5
}
```

### Principes :
- **6 Arbres Indépendants** : Chaque canvas possède son propre graphe de nœuds, ses fils, ses images-clés et ses paramètres de sortie (Render node).
- **Commutation Instantanée** : Le basculement de canvas ne détruit pas les caches GPU associés (`nodeCaches.ts`). Seul le canvas actif est évalué et affiché à l'écran.
- **Communication Inter-Canvas** : Les nœuds `variable/set` et `variable/get` partagent un registre de mémoire global à la session (au niveau du module `variable.ts`). Une valeur écrite sur le Canvas 1 est directement accessible par un `variable/get` sur le Canvas 3 sans fil, survivant aux changements de canvas (`Go To Canvas`, voir [[Named Variables System]]).

---

## 2. Flux Réactionnel React (`App.tsx`)

- Les mutations d'état (ajout de nœuds, câblage, modification de paramètres, édition de clés) génèrent de nouvelles copies immuables du graphe via `cloneGraph.ts`.
- **Isolation du Gizmo (`liveEditNodeId`)** : Pendant la manipulation d'un gizmo dans la vue 3D, le nœud ciblé ignore l'écrasement de sa matrice par le graphe pour éviter tout clignotement à 60 fps.
- **Reset Universel (`resetSimulations`)** : L'action `Shift+Space` incrémente l'époque de simulation dans `App.tsx`, propage la nouvelle époque dans le contexte de rendu et rembobine le playhead à 0 (voir [[Simulation Reset and Epoch Architecture]]).

---

## 3. Persistance & Reconstitution (`autosave.ts`, `rehydrateParams.ts`)

- **Sauvegarde Automatique Débouncée** : Enregistrement sur disque (via l'API Tauri ou le stockage local).
- **Réhydratation Typée** : Lors du chargement JSON, les structures simples représentant des vecteurs, couleurs et matrices sont automatiquement réinstanciées en objets réels `THREE.Vector3`, `THREE.Color` et `THREE.Matrix4`.

---

## 🔗 Notes Associées
- [[Graph Evaluation Runtime]]
- [[ThreeJS Viewport and Calibration Pipeline]]
- [[Keyframe Store and Timeline]]
- [[Named Variables System]]
- [[Simulation Reset and Epoch Architecture]]
