# Parametric Geometry and Modifiers (Tsuji)

*Emplacement dans le code : `src/shared/graph/nodes/weld.ts`, `contourScan.ts`, `metaballs.ts`, `geometryDeform.ts`, `boolean.ts`, `lattice.ts`, `subdivide.ts`*

Ce document détaille les modificateurs de géométrie paramétrique, les opérateurs de déformation continue, la génération de surfaces implicites et les garanties d'intégrité de chaîne dans le pipeline Three.js de Tsuji.

---

## 1. Fusion Douce & Congé de Raccordement : `geometry/weld` (*Weld / Soft Fillet*)

Le nœud **`geometry/weld`** calcule l'union douce de géométries en intersection en générant un congé de raccordement (*fillet*) continu et organique :

```
Maillage A ──┐
             ├──▶ [ geometry/weld ] ──▶ Maillage Solide Fusionné (Surface Nets)
Maillage B ──┘      (fillet, res)
```

- **Voxelisation SDF (`meshSdf.ts`)** :
  - Calcule un champ de distance signé (SDF) discret dans une grille 3D régulière englobant la boîte englobante commune des maillages en entrée.
  - Utilise une accélération BVH (`three-mesh-bvh`) pour évaluer rapidement la distance signée point-polygone avec parité d'enroulement (*winding number*).
  - Applique l'opérateur de minimum adouci (polynomial smooth minimum $smin$) avec rayon de congé paramétrable `filletRadius`.
- **Extraction Isosurface par Surface Nets (`surfaceNets.ts`)** :
  - Contrairement au Marching Cubes classique qui génère plusieurs triangles par cellule au bord tranchant, l'algorithme des **Surface Nets** (Dual Contouring sur grille cartésienne) place un sommet unique par voxel traversé par l'isosurface $f(x,y,z) = 0$.
  - Les sommets sont relaxés vers le gradient du champ de distance, produisant un maillage régulier, d'excellente topologie et particulièrement fluide sur les zones de raccordement.
- **Porte de Signature (`geometrySignature.ts`)** :
  - Le calcul volumique étant coûteux en CPU, une signature géométrique hachée (somme des coordonnées et transformations locales) préserve le maillage en cache tant que les formes et poses amont demeurent inchangées.

---

## 2. Tranchage Topographique & Rubans : `geometry/contour-scan` (*Contour Scan*)

Le nœud **`geometry/contour-scan`** applique un plan de coupe régulier balayant le maillage selon l'axe $X$, $Y$ ou $Z$ :

- **Extraction d'Isolignes (`meshScanlines.ts`)** :
  - Interpole les arêtes des triangles traversées par la suite de plans de coupe équidistants $d_i = \text{offset} + i \times \text{spacing}$.
  - Reconnecte les segments d'intersection en chaînes de contours fermées ou ouvertes.
- **Sorties Doubles** :
  - **`geometry`** : Génère des rubans tridimensionnels polygonaux extrudés selon l'épaisseur `ribbonWidth`. Les normales de rubans sont calculées le long du plan de tranche pour éviter les inversions de face brusques.
  - **`curves`** : Expose les contours bruts sous forme d'une liste de courbes splines Three.js (`THREE.Curve<THREE.Vector3>[]`), directement compatibles avec `curve/to-mesh`, `curve/array` ou les émetteurs de particules.
- **Paramètres de Morphing & Animation** :
  - `axis` ('x', 'y', 'z'), `spacing` (pas de coupe), `offset` (phase temporelle animable pour balayage dynamique), `ribbonWidth`, `morph` (transition continue entre maillage plein et contours).

---

## 3. Surfaces Implicites : `object/metaballs` (*Metaballs*)

Le nœud **`object/metaballs`** reconstruit une surface fluide autour d'un ensemble de centres :

- **Entrées Flexibles** :
  - Accepte une liste de positions vectorielles (`Mesh to Points`, `Instance Positions`) ou un nœud géométrique complet (`geometry`, avec `owns: true`).
  - Extrait automatiquement les centres de tous les enfants de la hiérarchie et de chaque instance d'`InstancedMesh` (ex. sortie d'un `structure/array`).
- **Échantillonnage Marching Cubes & Normalisation** :
  - Évalue le potentiel scalaire $V(p) = \sum \frac{r_i^2}{\|p - c_i\|^2}$ sur une grille cubique résolue de 16 à 128 voxels.
  - Le maillage résultant est extrait et reprojeté depuis l'espace normalisé $[-1, 1]$ vers l'espace monde des centres, éliminant le buffer d'échange de 60 000 polygones.
  - Optimisation par signature d'immobilité des centres pour garantir un taux de rafraîchissement stable à 60 FPS (7.4 ms à résolution 64).

---

## 4. Synchronisation Dynamique des Déformateurs Chaînés (`geometryDeform.ts`)

Dans une chaîne de déformateurs successifs (ex. `Wave` $\rightarrow$ `Twist` $\rightarrow$ `Bend`) :
- Chaque nœud de déformation modifie sa géométrie en place afin de minimiser les allocations mémoire. Par conséquent, son `geometry.uuid` ne varie pas d'une frame à l'autre.
- **Problème résolu** : Le déformateur aval (ex. Twist), testant sa signature de cache, considérait la géométrie amont comme inchangée et conservait le snapshot capturé lors de la première frame, gelant ainsi les animations d'ondes générées en amont.
- **Solution Tsuji (`geometryDeform.ts`)** :
  - À chaque frame validée en *cache-hit*, le déformateur synchronise explicitement son buffer de référence `base` depuis les positions courantes du maillage source (`sourceGeom.attributes.position.array`).
  - L'animation de propagation d'onde (`Wave`) traverse ainsi fluidement tous les étages de déformation avals sans réallocation de maillage.

---

## 5. Résolution du Gizmo sur Chaînes de Modificateurs (`Viewport.tsx`)

Lorsqu'un utilisateur sélectionne un nœud modificateur pur (`Twist`, `Wave`, `Subdivide`) dans le graphe :
- Le modificateur ne possède aucun paramètre intrinsèque de translation, rotation ou échelle (les transformations appartiennent au générateur amont, ex. `Box` ou `Sphere`).
- Auparavant, le gizmo du viewport écrivait les deltas de manipulation sur l'identifiant du nœud sélectionné (`selectedNodeId`), ce qui était silencieusement ignoré.
- **Résolution Automatique (`resolveGizmoTarget`)** :
  - Le Viewport parcourt récursivement la chaîne géométrique vers l'amont pour identifier le nœud source réel détenteur de la pose (`objectNodeId`).
  - Les interactions du gizmo de manipulation 3D écrivent directement dans les propriétés `location`, `rotation`, `scale` du nœud générateur d'origine, tout en maintenant visuellement le gizmo ancré sur l'objet déformé.

---

## 6. Autres Modificateurs Paramétriques & Topologiques

- **Treillis 3D (`lattice.ts`)** : Déformation par grille de Bernstein $3 \times 3 \times 3$.
- **Subdivision (`subdivide.ts`)** : Lissage Catmull-Clark / Loop.
- **Booléens CSG (`boolean.ts`)** : Unions, soustractions et intersections solides via `three-bvh-csg`, avec préservation de tous les matériaux distincts sur les faces résultantes et déclenchement des hooks de matériaux custom.
- **Épaisseur (`solidify.ts`)** : Extrusion de coque à partir de surfaces ouvertes planes.
- **Tranchage Visuel (`visualSlice.ts`, `clipBox.ts`)** : Plans et boîtes d'écrêtage GPU par plans de coupe matériels (*clipping planes*).

---

## 🔗 Notes Associées
- [[ThreeJS Viewport and Calibration Pipeline]]
- [[Spatial Indexing and BVH Acceleration]]
- [[ThreeJS Optimization and Performance Guide]]
- [[P4_Gizmo_Modifier_Resolution_and_Deform_Sync]]
- [[Node Catalog]]
