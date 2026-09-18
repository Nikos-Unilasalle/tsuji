# Param Panel and Inspector

*Emplacement dans le code : `src/windows/ParamPanel.tsx`*

Ce document décrit le panneau d'inspection des paramètres de nœud et ses widgets interactifs.

---

## 1. Description Déclarative (`ParamFieldDef`)

Les champs de réglage sont décrits par des types unions dans `types.ts` :
- `number` (avec support de l'affichage en degrés ou en pourcentages)
- `vector`
- `color` (avec palette HSV/Hex)
- `color_ramp` (dégradé multi-points)
- `curve_profile` (courbe Bézier interactive)
- `file` (avec callback `onLoaded` et gestion binaire sécurisée)

### 1.1 Ingestion de Fichiers Binaires & Vidéos (`.mp4`)
- Le sélecteur de fichiers gère une liste blanche stricte de formats binaires (`.glb`, `.gltf`, `.ply`, `.obj`, audio et désormais vidéo **`.mp4`** pour les nœuds `texture/image` et `object/texture-plane`).
- Les fichiers binaires sont lus directement sous forme d'ArrayBuffer / Blob URL afin d'éviter la corruption fatale par conversion textuelle UTF-8.

---

## 2. Raccourci d'Animation Clé ("K")
- Le survol d'une propriété avec la touche `K` crée une image-clé dans `KeyframeStore` à la frame actuelle de la timeline.

---

## 3. Paramètres de Groupes & Épinglage HUD
- Les nœuds de type `structure/group` exposent dynamiquement dans l'inspecteur les paramètres publiés par leurs nœuds internes.
- Prise en charge intégrale de l'épinglage HUD (`ViewportParamHUD.tsx`) pour piloter des paramètres de groupe directement dans la vue 3D.

---

## 🔗 Notes Associées
- [[Keyframe Store and Timeline]]
- [[Graph Editor and Canvas]]
- [[Node Creation Guide]]
- [[Node_Groups_Implementation_Plan]]
