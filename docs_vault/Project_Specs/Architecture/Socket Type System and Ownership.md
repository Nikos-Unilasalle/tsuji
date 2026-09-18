# Socket Type System and Ownership

*Emplacement dans le code : `src/shared/graph/sockets.ts`*

Ce document détaille le système de types de ports (sockets) et la sémantique de propriété géométrique dans Tsuji.

---

## 1. Les 12 Types de Sockets

| Type | Type Three.js Sous-Jacent | Couleur UI | Description |
| :--- | :--- | :--- | :--- |
| `value` | `number` | `#f2c14e` (Jaune) | Nombres, échelles, angles et booléens (0/1). |
| `vector` | `THREE.Vector3` | `#38bdf8` (Bleu) | Positions 3D, rotations (radians), facteurs d'échelle. |
| `matrix` | `THREE.Matrix4` | `#a855f7` (Violet) | Matrices affines 4×4 combinées. |
| `color` | `THREE.Color` | `#ec4899` (Rose) | Couleurs linéaires RGB. |
| `geometry` | `THREE.Object3D` | `#22c55e` (Vert) | Maillages, groupes, nuages de points. |
| `texture` | `THREE.Texture` | `#2dd4bf` (Turquoise) | Textures bitmap, vidéo, procédurales. |
| `curve` | `THREE.Curve<THREE.Vector3>` | `#84cc16` (Citron) | Courbes paramétriques 3D. |
| `material` | `MaterialValue` | `#d97706` (Ambre) | Descripteurs légers de matériaux PBR. |
| `list` | `unknown[]` | `#94a3b8` (Gris) | Collections dynamiques de données. |
| `text` | `string` | `#f97316` (Orange) | Chaînes de caractères et étiquettes. |
| `postprocess` | `unknown[]` | `#c084fc` (Lavande) | Passes de post-traitement shader. |
| `any` | `unknown` | `#e2e8f0` (Blanc) | Connexions polymorphiques (Reroute, Bridge). |

---

## 2. Propriété Géométrique (`owns?: boolean`)

Sur les sockets d'entrée `geometry`, la propriété `owns: true` indique que le nœud aval prend en charge l'affichage exclusif du maillage :
- Le maillage amont est masqué du graphe de scène global (`sceneRoots.ts`) pour éviter les rendus en double (ex. après un modificateur `Transform` ou `Subdivide`).

---

## 3. Sockets Dynamiques & Réactivité Immédiate

- **`dynamicInputs`** : Permet l'auto-génération de nouveaux ports libres au fur et à mesure des branchements (ex. `Merge`, `Force Fields`).
- **`dynamicOutputs`** : Permet d'adapter le type de sortie au type branché en entrée (ex. `Logic Bridge`).
- **Ports Frontières de Sous-Graphes (`Group Input` / `Group Output`)** : Présentent un port `+` terminal. Déposer une connexion sur ce connecteur matérialise instantanément une prise typée sur le bloc groupe parent.
- **Enregistrement Réactif React Flow (`useUpdateNodeInternals`)** :
  - Dès qu'un socket dynamique apparaît, disparaît ou change de type, le composant invoque `useUpdateNodeInternals(node.id)`.
  - Cela force la mise à jour immédiate du cache de positionnement des poignées (*handles*) dans le DOM virtuel de React Flow, permettant à l'utilisateur de cliquer et glisser un câble instantanément sans devoir zoomer ou déplacer la vue.

---

## 🔗 Notes Associées
- [[Graph Evaluation Runtime]]
- [[Node Creation Guide]]
- [[Parametric Geometry and Modifiers]]
- [[P4_Gizmo_Modifier_Resolution_and_Deform_Sync]]
- [[Node_Groups_Implementation_Plan]]
