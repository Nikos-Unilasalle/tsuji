# Fiche de Correctif : Résolution Gizmo Modificateurs, Déformations Chaînées & Réactivité des Sockets

*Date de clôture : 18 Septembre 2026*  
*Commits associés : `b0e02a4`, `81dd1d4`, `bfa98c5`, `16ce153`, `2ad0b77`*

---

## 1. Contexte & Problématiques Identifiées

Plusieurs anomalies subtiles de chaîne de traitement et d'ergonomie ont été corrigées pour fiabiliser la manipulation 3D, l'animation continue et la réactivité du graphe :

### 1.1 Faille A : Gizmo Inopérant sur les Modificateurs de Géométrie (`b0e02a4`)
- **Symptôme** : Sélectionner un nœud modificateur pur (`geometry/twist-bend-taper`, `geometry/wave-ripple`, `subdivide`) inséré entre un générateur 3D (ex. `Box`) et le viewport affichait un gizmo 3D opérationnel. Cependant, faire glisser les poignées du gizmo ne déplaçait rien à l'écran.
- **Cause Racine** : `resolveGizmoTarget` remontait bien la chaîne géométrique jusqu'au nœud racine porteur de pose (`objectNodeId`), mais le chemin d'attache du proxy de pivot dans `Viewport.tsx` persistait à écrire les deltas de translation/rotation/échelle sur l'ID du *nœud sélectionné* (`selectedNodeId`). Comme un nœud modificateur ne possède aucun paramètre `location`, `rotation` ou `scale`, ces écritures tombaient dans le vide.
- **Résolution** : Le callback de mise à jour du gizmo écrit désormais strictement dans `target.objectNodeId`, transmettant immédiatement les transformations au générateur réel.

### 1.2 Faille B : Gel d'Animation sur Déformateurs Chaînés (`81dd1d4`)
- **Symptôme** : Enchaîner deux déformateurs successifs (ex. `geometry/wave-ripple` $\rightarrow$ `geometry/twist-bend-taper`) gelait l'animation de l'onde amont.
- **Cause Racine** : Chaque déformateur modifie sa géométrie de sortie en place pour minimiser les allocations à 60 FPS. L'UUID de la géométrie ne changeant jamais, la signature de cache du déformateur aval considérait la géométrie amont comme statique (*cache-hit*) et réutilisait le snapshot `base` capturé lors de la première frame de compilation, ignorant les oscillations ultérieures.
- **Résolution** : Dans `geometryDeform.ts`, à chaque frame validée en *cache-hit*, `base` est explicitement resynchronisé depuis le buffer de position live du maillage source (`sourceGeom.attributes.position.array`), propageant le mouvement en aval sans perte de performance.

### 1.3 Faille C : Impossibilité de Connecter Immédiatement des Sockets Dynamiques (`bfa98c5`)
- **Symptôme** : Lorsqu'un nœud modifiait dynamiquement ses sockets (ex. ajout automatique d'entrées `Merge` ou bascule d'un port contour scan), les nouvelles poignées ne pouvaient pas être saisies à la souris sans déclencher un zoom ou déplacement de caméra dans l'éditeur.
- **Cause Racine** : La couche interne de React Flow (`@xyflow/react`) maintient un cache DOM des handles qui n'était pas notifié de la mutation des sockets.
- **Résolution** : Appel systématique de `useUpdateNodeInternals(node.id)` lors de tout ajout ou morphisme de socket, rendant les nouvelles poignées immédiatement cliquables et connectables.

### 1.4 Faille D : Latence et Perte d'Événements Manette sur Desktop (`16ce153`)
- **Symptôme** : L'API standard Web `navigator.getGamepads()` présente des disparités de polling et de reconnexion selon les navigateurs et environnements Tauri.
- **Résolution** : Intégration d'un pont natif Rust avec la bibliothèque `gilrs` dans le backend Tauri, transmettant l'état instantané du contrôleur à l'UI sans intermédiaire et basculant automatiquement sur l'API navigateur sur le web.

---

## 2. Synthèse des Fichiers Modifiés

- `src/shared/three/Viewport.tsx` : Écriture ciblée sur `resolved.objectNodeId`.
- `src/shared/graph/nodes/geometryDeform.ts` : Synchronisation continue du buffer `base`.
- `src/windows/GraphEditor.tsx`, `GraphNode.tsx` : Enregistrement réactif avec `useUpdateNodeInternals`.
- `src-tauri/src/gamepad.rs`, `src/shared/graph/gamepadRuntime.ts` : Pont natif `gilrs`.
- `src/windows/TopBar.tsx`, `TimelineBar.tsx` : Regroupement Play/Pause/Reset dans la barre supérieure.

---

## 🔗 Notes Associées
- [[Parametric Geometry and Modifiers]]
- [[ThreeJS Viewport and Calibration Pipeline]]
- [[Input Subsystem and Playback Keys]]
- [[Graph Editor and Canvas]]
