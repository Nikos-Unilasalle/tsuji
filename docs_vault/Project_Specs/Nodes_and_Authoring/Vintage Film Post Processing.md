# Vintage Film & Print Post-Processing (Tsuji)

*Emplacement dans le code : `src/shared/graph/nodes/postprocessingFilm.ts`, `src/shared/three/postShaders.ts`, `postProcessChain.ts`*

Ce document détaille la suite de passes de post-traitement dédiée à l'émulation de tirages d'art, de films argentiques des années 70 et de techniques d'impression traditionnelles dans Tsuji.

---

## 1. Philosophie : Du Numérique à l'Émulsion

Les passes optiques standard (`postprocess/bloom`, `postprocess/dof`, `postprocess/ssao`) modélisent les comportements physiques d'un objectif de caméra numérique.
La suite argentique vise une transformation matérialiste du rendu : donner l'illusion d'une image imprimée sur papier texturé ou passée à travers une émulsion photographique rétro.

Trois principes fondateurs guident l'implémentation de ces shaders :
1. **Quantification Temporelle (`Rate`)** : Un grain qui change à 60 Hz produit un bruit numérique de capteur CMOS, et un scintillement d'obturateur à 60 Hz fatigue l'œil comme un écran défectueux. Les imperfections argentiques sont ancrées dans la cadence physique de la pellicule (16 ou 18 images par seconde). Les passes quantifient le temps selon un paramètre `rate`.
2. **Aléatoire Déterministe Sans Effet de Bord** : Le bruit et les poussières proviennent d'un hachage spatial des coordonnées d'écran et du numéro de frame quantifié, jamais d'une graine d'état globale réallouée par draw call. Une seconde donnée s'affiche à l'identique dans le Viewport principal, dans un second moniteur et lors de l'export vidéo.
3. **Pénétration de Matière vs Surimpression** : Les défauts organiques (grains, brosse sèche) ne se contentent pas de superposer un calque blanc ; ils modulent l'image sous-jacente ou percent jusqu'à la couleur du papier.

---

## 2. Inventaire des 5 Passes Argentiques & Imprimerie

### 2.1 `postprocess/duotone` (*Dual Tone*)
Mappe les luminances de l'image sur une rampe chromatique bicolore :
- **Paramètres** : `shadowColor` (teinte des ombres profondes), `highlightColor` (teinte des hautes lumières), `contrast` (pente de la courbe de transfert sigmoïde).
- Idéal pour les affiches sérigraphiées, les tirages bichromiques et les identités graphiques audacieuses.

### 2.2 `postprocess/halftone` (*Halftone Print*)
Simule la trame de points photomécanique de l'impression offset de journaux et bandes dessinées :
- Décompose l'image en cellules régulières selon un motif en grille orienté d'un angle $\theta$ (`angle`).
- Dans chaque cellule, le diamètre du point d'encre est proportionnel à la densité de luminance locale.
- Contrôles : `scale` (taille de la trame), `softness` (netteté du bord des points), `color` et inversion.

### 2.3 `postprocess/film-texture` (*Film Texture*)
Générateur de texture argentique combinant grain photo-chimique et particules de poussière :
- **Grain Temporellement Cadencé** : Le grain évolue par paliers discrets définis par `rate` (par défaut 16 ou 18 fps).
- **Poussières et Fibres** : Dispersion rare de micro-taches de poussière et poils de couloir de projection (`dustIntensity`, `dustCount`). Un seuil de filtrage strict empêche la poussière de saturer le rendu en champ d'étoiles.

### 2.4 `postprocess/super8` (*Super 8 Projector*)
Émulation complète de la projection d'un film Super 8 amateur :
- **Saut d'Obturateur (*Gate Weave*)** : Micro-déplacements horizontaux et verticaux oscillants simulant le jeu mécanique de la griffe d'entraînement de la pellicule.
- **Scintillement (*Flicker*)** : Fluctuations périodiques d'exposition lumineuse de la lampe du projecteur.
- **Abrasion & Rayures Verticales** : Lignes de défilement fugaces simulant l'usure de l'émulsion le long des couloirs de défilement.

### 2.5 `postprocess/dry-brush` (*Dry Brush*)
Simule une technique d'aquarelle ou de peinture à sec sur papier texturé :
- **Percée du Papier Sous-Jacent** : L'effet ne dépose pas de pigment blanc ; il fait resurgir la texture et la teinte du support papier (`paperColor`) dans les aspérités où la brosse n'a pas appuyé.
- **Pondération par l'Encre (`followInk`)** : Les manques de matière n'apparaissent que là où de l'encre a été déposée (une brosse ne peut rater son trait que là où elle a peint). Le masque est dérivé des crêtes de bruit de texture plutôt que de la moyenne, évitant de noyer la moitié de l'image.

---

## 3. Chaîne d'Intégration (`postProcessChain.ts`)

Dans le pipeline de rendu, les passes de film s'insèrent harmonieusement après les passes optiques (Bloom, DOF, AO) et avant la correction colorimétrique terminale :

$$\text{Scène 3D} \longrightarrow \text{Bloom / DOF} \longrightarrow \text{Film Texture / Super 8} \longrightarrow \text{Dry Brush / Duotone} \longrightarrow \text{Sortie Écran}$$

Toutes les passes respectent le contrat de shader composable de Tsuji avec destruction récursive propre des RenderTargets associées.

---

## 🔗 Notes Associées
- [[Post-Processing Uber-Shader Passes]]
- [[Creative WebGL Shaders and Distortion Techniques]]
- [[Node Catalog]]
- [[ThreeJS Viewport and Calibration Pipeline]]
