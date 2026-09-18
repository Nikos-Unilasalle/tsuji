# Graph Editor and Canvas

*Emplacement dans le code : `src/windows/GraphEditor.tsx`, `src/windows/GraphNode.tsx`*

Ce document détaille l'implémentation de l'interface utilisateur de l'éditeur de graphe.

---

## 1. Génération Dynamique des Nœuds
- Le composant `GraphNode.tsx` affiche l'en-tête, les poignées d'entrée/sortie et les libellés en se basant uniquement sur la `NodeDefinition`.
- Aucun code React spécifique n'est requis par nœud.

---

## 2. Câblage et Interaction
- **Câbles SVG Bézier** : Câblage interactif coloré selon le type de socket.
- **Validation à la Connexion** : Empêche le branchement entre types incompatibles.
- **Insertion sur Câble (`insertOnWire.ts`)** : Déposer un nœud sur un fil compatible l'intercale automatiquement.
- **Sous-Graphes et Groupes (`Cmd+G` / `Cmd+Shift+G`)** :
  - Sélectionner plusieurs nœuds et presser `Cmd+G` les replie dans un bloc `structure/group`.
  - Double-cliquer plonge dans le sous-graphe avec recadrage automatique ; une barre de fil d'Ariane (*breadcrumb*) en haut du canvas permet de remonter aux niveaux parents.
- **Réactivité Immédiate des Poignées (`useUpdateNodeInternals`)** :
  - Tout ajout dynamique de socket (ex. port `+` de groupe ou entrée auto de `Merge`) informe immédiatement React Flow pour rendre la poignée saisissable sans latence.

---

## 3. Barre Supérieure d'Actions (`TopBar.tsx`) & Commandes de Lecture

- **Épuration Visuelle (Boutons Icon-Only)** :
  - Les commandes standards (`New`, `Load`, `Save`, `Demos`, `Undo`, `Redo`) utilisent une interface compacte avec infobulle native (`title`).
- **Regroupement de la Lecture et Simulation Reset** :
  - Les boutons **Play / Pause** et **Reset Simulations** (`Shift+Space`) ont été déplacés de la mini-timeline vers la barre supérieure, à côté des actions Undo/Redo.
- **Indicateur de Contrôleur & Mode Plein Écran** :
  - Badge visuel dynamique de connexion manette (`Gamepad`).
  - Bouton **Fullscreen** positionné à l'extrême droite (après Share).

---

## 4. Mini-Timeline Débarrassée de Surcharge (`TimelineBar.tsx`)

- **Bandeau Débrayé et Épuré** :
  - Retrait des boutons de transport en doublon (déportés sur la barre supérieure).
  - Curseur de tête de lecture rendu visuellement discret / transparent tout en conservant sa zone de saisie interactive pour le scrub manuel.

---

## 🔗 Notes Associées
- [[Socket Type System and Ownership]]
- [[Param Panel and Inspector]]
- [[State Management and Multi-Canvas]]
- [[ThreeJS Viewport and Calibration Pipeline]]
- [[Node_Groups_Implementation_Plan]]
- [[P4_Gizmo_Modifier_Resolution_and_Deform_Sync]]

