# Bilan — modélisation et sélection paramétriques

Branche `feat/parametric-modeling`, poussée sur GitHub. Tout le plan (`docs/parametric-modeling-plan.md`) est implémenté : **environ 78 nouveaux nodes**.

- Suite complète : 5 211 tests verts.
- Typecheck et build de production propres.
- Trois démos ajoutées (catégorie « Parametric Modeling »), vérifiées dans l'app, sans erreur console.

## Le socle
- `QuadMesh` est devenu **`PolyMesh`**. L'ancien nom reste en alias et les projets sauvegardés sont inchangés.
- Le PolyMesh porte des **attributs nommés** par point, arête, face et coin. Un **groupe** est un attribut booléen.
- Des attributs intégrés sont lisibles partout : P, N, area, angle, piece…
- **Expressions de groupe** dans un champ Group : `top`, `a & !b`, `rim_*`, `0-10:2`, `@P.y>0`.
- **Les attributs survivent** à toutes les opérations :
  - aux déformeurs historiques (Twist, Wave, Lattice), grâce à une table « sommet du buffer → sommet du PolyMesh » ;
  - aux nodes qui reconstruisent leur géométrie de zéro (Boolean, Weld…), par proximité.
- `definePolyNode` : le socle commun de tous les nouveaux nodes. Il fournit le champ Group, le cache, les notes de statut et la sortie correcte du mesh.
- **Geometry Spreadsheet** : un tableau éléments × attributs, affiché dans le corps du node.

## Les nodes
- **Sélection** : Select (box, sphere, plane, normal, random, noise, inside-object, expression…), Select Topology, Select Measure, Select Distance (sélection douce, éventuellement le long de la surface), Select Manual (clic dans le viewport), Group Combine, Group Expand, Group Path, Group to Points.
- **Attributs** : Attribute Expression (wrangle vectoriel avec `P`, `N`, `noise()`, `cross()`…), Create, Delete, Rename, Copy, Promote, Noise, Blur, Transfer, From Texture, Measure, To List, From List, Visualize, Randomize.
- **Modélisation** : Bevel, Inset, Bridge, Revolve, Mirror/Symmetrize, Fuse, Dissolve, Fill Holes, Clip, Triangulate, Quadrangulate, Split Edges, Extract, Subdivide Faces, Flip, Smooth, Displace, Transform Elements, Scale Elements, Dual Mesh, Poke, Divide, Convex Hull, Bounding Box, Decimate, Sort, Keep Group, Edge Mark, Join, Material by Group.
- **Nodes existants repensés** :
  - Extrude et Delete fonctionnent sur les vraies faces et lisent un champ Group ; Extrude écrit les groupes `extrude_top` et `extrude_side`.
  - Subdivide accepte un Group (mode Simple).
  - Twist, Wave et Lattice acceptent un Group et un Weight Attribute.
  - Les anciennes scènes gardent leur comportement.
- **Courbes** : rayon et inclinaison par point, Resample, Trim, Reverse, Fillet, Offset 2D, Sweep, Mesh Edges to Curves, Curve Info.
- **Boucles** : le node Group gagne un mode Loop (Repeat avec feedback, For Each Piece, For Each Count) et un node Loop Info.
- **Volumes SDF** : Mesh/Points to SDF, Combine (lissé), Offset, Smooth, Noise, SDF to Mesh, Voxel Remesh.
- **Procédural** : Ray/Project (shrinkwrap), Copy to Points, L-System, HeightField Erode, Geodesic Distance.

## Ce qui reste à savoir
- La liste détaillée des limites est au §7 du plan. Les principales :
  - Catmull-Clark s'applique à tout le mesh (le Group ne sert qu'en mode Simple) ;
  - Decimate et les SDF tournent sur le thread principal (grilles plafonnées à 128³) ;
  - Select Manual pique des points, pas directement des faces ;
  - Bridge exige le même nombre de points des deux côtés.
- Corrigé au passage : `flipFaces` remettait mal les couleurs de coins.
- Le travail a été parallélisé sur 5 agents, chacun dans son worktree ; tout a été fusionné et les worktrees supprimés.
- `public/_tmp_expression.tsuji` et `yaolanyao_midi/` (non suivis) n'ont pas été touchés.
- Rien n'est fusionné dans `main`.
