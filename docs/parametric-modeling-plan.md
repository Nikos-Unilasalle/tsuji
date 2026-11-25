# Plan — sélection et modélisation paramétrique

Statut : validé, branche `feat/parametric-modeling`. Décisions en §5.
Références : Houdini SOPs (Group, Attribute, Poly*, VDB, For-Each) et Blender
Geometry Nodes (fields, Mesh/Curve/Volume operations, zones).

---

## 0. Constat

Tsuji a déjà, sans le savoir, la moitié d'un Houdini — mais enfermée dans Edit Mesh.

**Le noyau existe** (`src/shared/graph/quadMesh.ts` + `src/shared/graph/mesh/`) :

| Domaine | Déjà écrit (interne) |
|---|---|
| Structure | `QuadMesh` : n-gons, UV par coin, couleurs par coin, matériau par face, arêtes vives / coutures / plis, arêtes libres ; `buildTopology` |
| Opérations | extrude (région / individuel / arêtes / sommets), inset, loop cut, bevel, bridge, spin, knife, dissolve (faces/arêtes/sommets), fill, merge / merge by distance, duplicate, flip, subdivide faces, Catmull-Clark avec plis, triangulate, mirror map, delete / extract, compact |
| Sélection | point/arête/face, conversion entre domaines, grow / shrink, linked, flat faces (angle), islands, edge loop / ring, combine (add/toggle/remove), soft selection (falloffs proportionnels) |
| UV | smart unwrap, LSCM, projections cube/cylindre/sphère/vue, pack |

**Mais le graphe n'en voit presque rien :**

- Seuls Edit Mesh, Solidify, Subdivide, Object (primitives) et Points↔Mesh lisent ou écrivent `userData.quadMesh`.
- Face Selection / Extrude / Delete Geometry travaillent sur les **triangles** d'une BufferGeometry ressoudée, avec 3 modes codés en dur (all / normal / height). Une « face » de Face Selection n'est pas une face du QuadMesh.
- Aucune notion d'**attribut nommé** ni de **groupe** qui voyage avec la géométrie. Les masques (Points Selection, Points Influence, Spring, Wiggle) sont des `list` alignées par index, valables tant que la topologie ne bouge pas.
- Chaque modificateur porte ses propres paramètres de sélection au lieu d'en recevoir une.

**Objectif :** un seul modèle de géométrie, des attributs et groupes qui survivent à chaque opération, une sélection branchable partout, et les opérations du noyau exposées en nodes.

---

## 1. Décisions d'architecture (à valider)

### D1 — Le PolyMesh est la vérité de la géométrie maillée
- Toute sortie `geometry` maillée porte un `PolyMesh` (le `QuadMesh` actuel, renommé ; alias de type conservé) dans `geometry.userData.quadMesh` (nom de clé conservé pour compat des projets).
- Deux helpers uniques, utilisés par **tous** les nodes de modélisation :
  - `readPolyMesh(object)` → `userData.quadMesh` sinon `importBufferGeometry` (soudure), avec cache par signature ;
  - `writePolyMesh(mesh, target)` → BufferGeometry + `userData.quadMesh`, matériaux/pivot/`nodeId` préservés (logique de `primitiveOutputs` / `preserveModifierUserData`).
- Les imports (glTF, OBJ, FBX, PLY) et les primitives émettent un PolyMesh.

### D2 — Attributs nommés par domaine, à la Houdini
Ajout à `PolyMesh` :

```ts
attributes?: {
  point?:  Record<string, Attr>;   // parallèle à positions
  face?:   Record<string, Attr>;   // parallèle à faces
  corner?: Record<string, Attr>;   // parallèle aux coins (comme faceUVs)
  edge?:   Record<string, Attr>;   // clé edgeKey(a,b), comme sharpEdges aujourd'hui
};
type Attr = { type: "float" | "int" | "bool" | "vec3" | "color"; data: Float32Array | Int32Array | Uint8Array };
```

- Les champs existants (`faceMaterials`, `faceColors`, `sharpEdges`, `seamEdges`, `edgeCreases`) deviennent des **attributs intégrés** exposés sous des noms réservés (`material_index`, `Cd`, `sharp`, `seam`, `crease`) — stockage actuel conservé dans un premier temps, vue unifiée par accesseurs.
- Attributs implicites en lecture : `P`, `N`, `uv`, `id` (index), `area`, `piece`.
- **Règle d'or :** chaque opération de `mesh/` propage les attributs. Un helper central `remapAttributes(src, out, { vertexMap, faceMap, newFaceSources, newVertexSources })` (interpolation pour les nouveaux sommets, copie pour les nouvelles faces) — `compactMesh` fournit déjà `remapFace`/`remapVertex`.

### D3 — La sélection = un groupe (attribut bool) qui voyage avec la géométrie
Choix recommandé : **groupes nommés à la Houdini**, pas les fields paresseux de Blender.
- Tsuji évalue des valeurs concrètes nœud par nœud ; les fields demanderaient un second évaluateur. Les groupes stockés sur la géométrie survivent aux changements de topologie (via D2) — exactement le défaut des masques `list` actuels.
- Un node de sélection **prend une géométrie et la ressort** avec le groupe écrit dessus (`group:<nom>` booléen) et éventuellement un poids flottant (`<nom>_w`) pour la sélection douce.
- Les modificateurs reçoivent un paramètre **Group** (texte) acceptant une mini-syntaxe : `top`, `top & !border`, `a | b`, `*`, vide = tout. Liste déroulante auto-remplie depuis les groupes présents en amont (`dynamicParamFields`).
- Compat : une entrée optionnelle `Selection (list)` reste acceptée partout (masque aligné par index, comme aujourd'hui) pour ne casser ni Spring, ni Wiggle, ni les démos.

### D4 — Pas de nouveau type de socket pour la sélection
Les groupes et attributs voyagent dans `geometry`. Ponts explicites vers l'univers `list` : **Attribute to List** / **List to Attribute**. Un éventuel socket `volume` n'est envisagé qu'en phase 7.

### D5 — Domaines explicites
Chaque node de sélection / attribut a un sélecteur **Domain** (Point / Edge / Face / Corner) et toute conversion passe par une règle claire (promote : any / all / majority / average).

---

## 2. Phases

Chaque phase est livrable seule, testée (`*.test.ts` + `demos.test.ts` vert), et se termine par une démo dans `public/`. Taille indicative : S / M / L.

### Phase 1 — Fondations (L)
1. `PolyMesh` : alias de type, `attributes`, accesseurs unifiés des attributs intégrés.
2. `readPolyMesh` / `writePolyMesh` + cache par signature ; signature incluant les attributs.
3. `remapAttributes` et passage de **toutes** les ops de `mesh/` et `quadMesh.ts` dessus (extrude, inset, bevel, bridge, knife, dissolve, subdivide, Catmull-Clark, merge, delete…). Test de propriété générique : « un attribut point/face/bool posé avant l'op existe et reste cohérent après ».
4. Primitives Object (box, sphere, plane, cylinder, cone, disc, polygon), imports et Points→Mesh émettent un PolyMesh complet.
5. Parser de groupes (`a & !b | c`) + évaluation sur un domaine.
6. **Geometry Spreadsheet** : panneau Inspector étendu listant domaines, attributs, groupes, valeurs (indispensable pour déboguer — Houdini/Blender l'ont tous deux).
7. Visualisation viewport du groupe actif du node sélectionné (points/arêtes/faces en surbrillance, réutilise le rendu de sélection d'Edit Mesh).

### Phase 2 — Sélection paramétrique (L)
Peu de nodes, beaucoup de modes (style Face Selection actuel). Tous : Domain, Group name, Invert, Mode d'écriture (replace / add / intersect / subtract), sortie géométrie + `count`.

| Node | Modes |
|---|---|
| **Select** (`select/basic`) | All · Index (plage, 1 sur N, motif) · Random (% + seed) · Position (boîte, sphère, demi-espace par plan, plage sur axe) · Normal (direction + angle de cône) · Inside Object (winding/raycast) · Attribute (expression booléenne sur attributs) · Texture (échantillonnage en UV ou triplanaire + seuil) |
| **Select Topology** | Boundary (bords ouverts) · Non-manifold · Sharp edges (angle dièdre) · Valence (nb voisins) · Face sides (tri / quad / n-gon) · UV seams · Islands (par pièce, n° de pièce → attribut `piece`) · Flat region depuis graine (`flatFaces`) |
| **Select Measure** | Aire · Longueur d'arête · Courbure · Épaisseur (raycast intérieur) · Hauteur relative · Facing camera |
| **Select Distance** (sélection douce) | Distance à un point / objet / courbe / groupe ; métrique euclidienne ou **le long de la surface** ; falloffs de `proportionalWeight` ; sortie poids `float` + seuil → bool |
| **Group Combine** | Expression libre sur groupes existants (`a & !b`), écrit un nouveau groupe |
| **Group Expand** | Grow / Shrink N pas (topologique), Linked (toute la pièce), Promote entre domaines (any / all) |
| **Group Path** | Edge loop / ring depuis arêtes graines, plus court chemin entre deux groupes de points (Dijkstra sur `buildTopology`), Boundary loop d'un groupe de faces |
| **Select Manual** | Refonte de Points Selection + Face Selection interactive : clic/rectangle dans le viewport sur points/arêtes/faces du **PolyMesh**, stocké comme groupe ; avertissement si la signature amont a changé (comme Edit Mesh) |

### Phase 3 — Attributs (M)
| Node | Rôle |
|---|---|
| **Attribute Expression** (wrangle) | Formule par élément sur un domaine, variables `P N uv id Cd` + attributs nommés + `a–d` câblables ; écrit un attribut ou modifie `P`. Étend le moteur de `math/expression` aux vecteurs (`P.y`, `length(P)`, `noise(P)`) |
| **Attribute Create / Delete / Rename** | Gestion |
| **Attribute Noise** | Bruit 3D/curl sur attribut ou position, masqué par groupe |
| **Attribute Blur** | Lissage sur la topologie (N itérations), base de Smooth |
| **Attribute Transfer** | Copie depuis une autre géométrie par plus proche voisin / surface la plus proche, rayon + falloff |
| **Attribute Promote** | Changement de domaine (moyenne, min, max, somme) |
| **Attribute from Texture** | Échantillonne une texture du graphe (UV, triplanaire, projection caméra) |
| **Measure** | Écrit aire, périmètre, courbure, `piece`, centroïde |
| **Attribute to List / List to Attribute** | Ponts avec l'univers `list` (Spring, Wiggle, charts, instances) |
| **Attribute Visualize** | Rampe de couleur sur le viewport (sans modifier le rendu final) |

### Phase 4 — Refonte des nodes existants (L)
Chaque modificateur gagne **Group** (+ `Weight` attribut optionnel pour les déformations) et passe par `readPolyMesh`/`writePolyMesh`. Anciens paramètres conservés et mappés (aucune démo cassée).

| Node | Changement |
|---|---|
| Face Selection | Devient un alias de **Select** (modes all/normal/height → Normal/Position), sur faces PolyMesh ; ancien index triangle converti à la migration |
| Extrude Mesh | Noyau `extrudeFaces`/`extrudeFacesIndividual` (vraies faces, n-gons) ; groupes de sortie `extrude_top` / `extrude_side` (comme Houdini) ; multi-pass conservé |
| Delete Geometry | Group + domaine ; « delete non sélectionné » |
| Subdivide | Group ; plis lus depuis l'attribut `crease` |
| Solidify | Group ; groupes de sortie `inner` / `outer` / `rim` |
| Twist/Bend/Taper, Wave, Lattice, Geometry Transform | Group + Weight (déformation douce) |
| Boolean | Propagation des attributs ; groupes de sortie `inside` / `outside` / `seam` |
| Fracture | Écrit `piece` ; groupes `inside` / `outside` |
| Weld | Group (quelle partie fond) |
| Invert Normals | → **Flip Faces** avec Group |
| Shade | Lit/écrit l'attribut `sharp` ; auto-smooth par angle |
| UV Unwrap | Group ; respecte l'attribut `seam` |
| Material | **Assign by Group** → écrit `material_index` |
| Merge | Union des attributs (valeur par défaut pour les manquants) |
| Mesh to Points / Points to Mesh | Conservent les attributs points |
| Instance on Points | Lit `pscale`, `orient`, `N`, `up`, `Cd` sur les points ; Group pour ne cloner que certains points |
| Spring / Wiggle / Points Selection / Points Influence | Acceptent un groupe ou un attribut poids en plus du masque `list` |
| Edit Mesh | Ses sélections nommées deviennent des groupes visibles en aval |

### Phase 5 — Opérations de modélisation exposées (L)
Essentiellement des emballages du noyau existant + quelques nouveaux algorithmes. Tous prennent Group.

| Node | Source |
|---|---|
| **Bevel** (arêtes / sommets, largeur, segments, profil) | `mesh/bevel.ts` |
| **Inset** (région / individuel, épaisseur, profondeur) | `insetFaces`, `insetRegion` |
| **Bridge** (deux groupes d'arêtes / faces) | `mesh/bridge.ts` |
| **Revolve / Spin** (profil, axe, angle, segments) | `spinEdges` |
| **Mirror / Symmetrize** (plan, soudure, flip) | `mirrorXMap` généralisé à tout plan |
| **Fuse** (merge by distance) | `mergeByDistance` |
| **Dissolve** (faces / arêtes / sommets, par angle) | `dissolve*` |
| **Fill Holes** | `fillVertices` sur boucles de bord |
| **Clip / Bisect** (plan, garder un côté, boucher) | `knifeCut` + `clipCaps.ts` |
| **Triangulate / Quadrangulate** | `triangulate.ts` + nouveau (appariement de triangles) |
| **Scale Elements** (par face / pièce, autour du centroïde) | nouveau, simple |
| **Split / Separate** (sort deux géométries : groupe / reste) ; **Split Edges** | `extractFaces`, `deleteFaces` |
| **Smooth / Relax** (Laplacien, préservation du volume, bords figés) | `relaxGeometry` (weld.ts) généralisé |
| **Displace** (le long de N, par attribut / texture / bruit) | nouveau, simple |
| **Dual Mesh**, **Poke**, **Divide** (pavages) | nouveaux |
| **Convex Hull**, **Bounding Box / Oriented Box** | algo Rapier/quickhull existant |
| **Decimate / PolyReduce** | nouveau (quadrics), hors thread |
| **Sort Elements** (par axe, distance, aléatoire, attribut) | nouveau, simple |

### Phase 6 — Courbes (M)
- Attributs par point de courbe (`radius`, `tilt`, `Cd`) dans le modèle de courbe (`curveClasses.ts`).
- **Resample** (nombre / longueur), **Trim** (début/fin en longueur ou facteur), **Reverse**, **Fillet** (rayon), **Offset 2D**, **Set Radius / Tilt**.
- Curve to Mesh : profil quelconque, échelle/torsion par attribut le long du chemin, groupes de sortie `caps` / `sides`.
- **Mesh Edges to Curves** (depuis un groupe d'arêtes ou le bord d'un groupe de faces) et **Edge Paths**.

### Phase 7 — Boucles et contrôle (L, design à part)
- **For-Each** fondé sur les sous-graphes existants (`nodes/group.ts`) : itère par pièce (`piece`), par valeur d'attribut, par point, ou N fois ; variables d'itération exposées dans le sous-graphe.
- **Repeat** avec rétroaction (sortie de l'itération i = entrée de i+1) — croissances, érosions, L-systems.
- **Switch Geometry** piloté par une valeur.
- Garde-fous : plafond d'itérations, mémoïsation par signature, profilage (`evalProfiler.ts`).

### Phase 8 — Volumes / SDF (L)
- Exposer le surface nets du Weld et des Metaballs comme pile générique : **Mesh to SDF**, **Points to SDF**, **SDF Combine** (union / soustraction / intersection, douce), **SDF Offset / Smooth**, **SDF to Mesh**, **Voxel Remesh** (= Mesh → SDF → Mesh).
- Décider alors d'un socket `volume` ou d'un transport dans `geometry`.
- Calcul hors thread (`offthread/jobs.ts`, kernels Rust/WASM).

### Phase 9 — Procédural haut niveau (M)
- **Ray / Project / Shrinkwrap** (projeter une géométrie sur une autre, BVH).
- **Copy to Points** enrichi (variantes par attribut d'index, pièces empaquetées).
- **L-System**, **HeightField Erode** pour Terrain, **Geodesic distance** (heat method) comme métrique de Select Distance.

---

## 3. Transverse

- **Performance** : attributs en tableaux typés ; signature légère (hash incrémental, pas de JSON) ; ops lourdes (Bevel, Decimate, Boolean, SDF, Remesh) via `requestJob` ; jamais `pure` pour ces nodes (cf. `docs/offthread-geometry.md`).
- **Compat projets** : clés de paramètres et `type` des nodes existants conservés ; migration par alias (comme `list/distance-gradient`). `demos.test.ts` est la garde.
- **UX** : sélecteurs Domain / Group cohérents partout ; badge du nombre d'éléments sélectionnés ; groupes et attributs amont proposés en liste.
- **Docs** : section « Groupes et attributs » dans `NODE_AUTHORING.md` (comment lire/écrire un PolyMesh, propager les attributs, accepter un Group).
- **Tests** : un test de propagation d'attributs par op ; un test de parité ancien/nouveau pour chaque node refondu.

---

## 4. Ordre de travail proposé sur la branche

1. Phase 1 (fondations) — rien de visible, mais tout en dépend.
2. Phase 2 noyau : **Select**, **Group Combine**, **Group Expand** + Spreadsheet + visualisation.
3. Phase 4 partielle : Delete, Extrude, Geometry Transform, Material by Group → première démo bout en bout (« sélectionner le haut d'un objet importé, l'extruder, le colorer »).
4. Phase 3 : Attribute Expression, Transfer, Blur, ponts List.
5. Phase 5 par lots de 3–4 nodes, du plus simple (Fuse, Mirror, Scale Elements, Displace) au plus lourd (Bevel, Decimate).
6. Reste de la phase 4, puis 6, 7, 8, 9.

---

## 5. Décisions (tranchées le 2026-11-25)

1. **Sélection = groupes / attributs stockés sur la géométrie** (Houdini), pas de fields paresseux. D3 confirmé.
2. **`QuadMesh` renommé `PolyMesh`** dans le code ; alias de type `QuadMesh` gardé pendant la transition ; clé `userData.quadMesh` inchangée (projets sauvegardés intacts).
3. **Paramètre Group** : accepte un nom simple (`top`), le mini-langage (`top & !border | rim`, `*`, vide = tout), et les mêmes combinaisons restent disponibles en nodes (**Group Combine**) pour qui préfère câbler.
4. **Attribute Expression** : extension de la syntaxe de `math/expression` (une formule par attribut écrit, + vecteurs `P.y`, `length(P)`, `noise(P)`), pas de mini-VEX.

## 6. Question reportée

- **Socket `volume`** : à décider au début de la phase 8 (nouveau type ou transport dans `geometry`).

---

## 7. État de livraison (2026-11-25)

Tout le plan est implémenté sur `feat/parametric-modeling`, environ 78 nouveaux nodes. Suite complète verte (plus de 5 200 tests), typecheck propre. Trois démos ont été ajoutées dans la catégorie « Parametric Modeling ».

| Phase | Livré |
|---|---|
| 1 Fondations | `PolyMesh` (alias `QuadMesh`), attributs nommés par domaine et groupes (`mesh/polyAttributes.ts`), expressions de groupe (`mesh/groupExpr.ts`), promotion entre domaines, propagation des attributs (`mesh/propagate.ts`), index spatial k-d, `mesh/polyIO.ts`. Le PolyMesh survit aux déformeurs grâce à la table buffer → sommet ; les attributs survivent aux nœuds qui reconstruisent leur géométrie (Boolean, Weld…). Socle `definePolyNode`. Le node **Geometry Spreadsheet** affiche son tableau dans le corps du node. |
| 2 Sélection | `select/basic` (all, expression, random, box, sphere, plane, axis-range, normal, inside-object, noise), `select/topology`, `select/measure`, `select/distance` (douce, euclidienne ou le long de la surface), `group/combine`, `group/expand` (grow, shrink, linked, promote, border), `group/path` (plus court chemin, edge loop/ring, boundary loop), `modeling/group-to-points`. |
| 3 Attributs | `attribute/expression` (wrangle vectoriel), create, delete, rename, copy, promote, noise, blur, transfer, from-texture, measure, to-list, from-list, visualize, randomize, spreadsheet. |
| 4 Refonte | Extrude Mesh et Delete Geometry : chemin PolyMesh piloté par Group (pour les nouveaux nodes ; les scènes sauvegardées gardent le chemin triangles). Subdivide lit le PolyMesh via polyIO, avec Group en mode Simple. Twist/Bend/Taper, Wave et Lattice reçoivent Group et Weight Attribute. Nouveaux : `modeling/join`, `modeling/material-by-group`. Correctif : `flipFaces` garde les couleurs aux bons coins. |
| 5 Opérations | bevel, inset, bridge, revolve, mirror/symmetrize, fuse, dissolve (+ limited), fill-holes, clip, triangulate, quadrangulate, split-edges, extract, subdivide-faces, flip-faces ; smooth, displace, transform-elements, scale-elements, dual-mesh, poke, divide, convex-hull, bounding-box, decimate (QEM), sort, keep-group, edge-mark. |
| 6 Courbes | attributs de courbe radius/tilt (`curveAttributes.ts`), set-radius/tilt/attribute, resample, trim, reverse, fillet, offset-2d, sweep (groupes `side`/`caps`, attributs `u`/`v`), mesh-edges-to-curves, info. |
| 7 Boucles | mode Loop du node Group : Repeat (feedback), For Each Piece, For Each Count ; node `structure/loop-info`. |
| 8 Volumes | Décision §6 : les SDF voyagent dans `geometry` (aperçu iso-surface + `userData.sdfGrid`). mesh-to-sdf, points-to-sdf, combine (lisse), offset, smooth, noise, sdf-to-mesh, voxel-remesh. |
| 9 Procédural | ray-project / shrinkwrap, copy-to-points (pscale, N/orient, variantes), l-system, heightfield-erode, geodesic-distance (méthode de la chaleur). |

### Limites connues
- Face Selection garde ses index de triangles (ses clics dans le viewport en dépendent). C'est le node **Select** qui le remplace pour le travail paramétrique.
- **Select Manual** pique les *points* du PolyMesh (clic ou rectangle, comme Points Selection) et les promeut en arêtes ou faces ; il n’y a pas de pique directe des faces ou arêtes dans le viewport.
- Catmull-Clark s'applique à tout le mesh (Group seulement en mode Simple). Decimate et le calcul SDF tournent sur le thread principal (plafonné à 128³).
- Les nouvelles faces sans source exacte (bandes de bevel, flancs d'inset…) héritent des groupes de la face source la plus proche, comme dans Houdini.
- Bridge exige le même nombre de points de chaque côté. Mirror n'utilise que des plans alignés sur les axes. Offset 2D ne nettoie pas les auto-intersections.
- L-System déterministe uniquement. Copy to Points n'a pas d'orient en quaternion (vec3 seulement).
