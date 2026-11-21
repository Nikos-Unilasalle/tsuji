# Aile de libellule paramétrique — `demo_dragonfly_wing.tsuji`

Modèle paramétrique d'une aile antérieure d'Anisoptère (type Aeshnidae / *Anax junius*),
construit avec trois nodes génériques ajoutées pour l'occasion :

| Node | Rôle | Réutilisable pour |
|---|---|---|
| **Poisson Disk 2D** (`list/poisson-disk-2d`) | Points aléatoires uniformément espacés dans un contour fermé ; espacement = formule `f(x, y, u, v, s, a…d)`, étirement anisotrope | graines de Voronoi, semis, pores, implantation |
| **Voronoi 2D** (`curve/voronoi-2d`) | Pavage de Voronoi découpé par un contour quelconque (concave accepté), avec **murs** (courbes à longer), **rangées le long des murs** (échelles/grilles), **étirement** fixe ou **qui suit des guides** (pavage exact sur grille fine, murs infranchissables), **régions** (un pavage par région fermée), **chaînes d'arêtes**, relaxation de Lloyd, retrait de cellules | treillis, panneaux ajourés, motifs cellulaires, réseaux hiérarchiques |
| **Height from Lines** (`geometry/height-from-lines`) | Donne une hauteur à un mesh / des points / des polylignes par interpolation depuis des lignes guides (k plus proches, IDW) | plis, toitures, terrain depuis courbes de niveau |

Unité : **1 unité de scène = 1 cm**. Aile dans le plan XZ, hauteur Y.

## Chaîne du graphe — deux niveaux de nervures

Le canvas est rangé en sept **frames** colorées, dans l'ordre de construction
(1 anatomie dessinée → 2 veines relevées → 3 nervures longitudinales → 4 cellules → 5 corrugation
→ 6 tubes → 7 soufflerie), et chaque node porte son **nom anatomique** (champ *Name*). Cours pas à pas :
[cours-tsuji-aile-libellule.md](cours-tsuji-aile-libellule.md).

Contour et veines principales relevés sur l'aile antérieure de
[Dragonfly_wing_structure.png](https://commons.wikimedia.org/wiki/File:Dragonfly_wing_structure.png)
(Wikimedia Commons), ramenés à 5 cm d'envergure. Les veines sont décrites en (position en
envergure, fraction de corde 0 = bord d'attaque → 1 = bord de fuite).

1. **Veines dessinées** (Curve from Points) : costa, Sc (jusqu'au nodus), R1 (jusqu'à l'apex),
   **nodus** (nervure nodale costa → Sc → R1, au fond d'une encoche du bord d'attaque) et subnodus
   (R1 → RP), ptérostigma. Les autres veines relevées (RP/R2, IR2, R3, IR3, R4, MA, CuA, A1) sont **cachées** :
   elles ne servent qu'à orienter l'étirement et à donner la corrugation (crête + / vallée −).
2. **Nervures épaisses** : Voronoi **lâche et étiré** (`vein_seeds` + `veins`, Stretch = 6) qui
   **suit l'écoulement** des veines relevées (Stretch Follows Guides). Ses cellules sont les
   panneaux de l'aile ; ses arêtes, les nervures épaisses qui partent de la base, se ramifient,
   fusionnent et rejoignent la marge, comme sur la photo. Sc, R1, nodus, subnodus et ptérostigma sont des murs :
   aucun panneau ne les traverse. Le pavage est calculé sur une grille fine, donc sans trou ni
   chevauchement aux jonctions.
3. **Nervures transverses** : Voronoi dense (`centres` + `cells`) calculé **panneau par panneau**
   (entrée *Regions* = cellules de `veins`), le bord de chaque panneau servant de mur avec
   **Wall Rows = 2** : un panneau étroit devient une **échelle** ou une **grille**, un panneau large
   garde des cellules irrégulières. Aucune cellule ne chevauche une nervure épaisse.
   Densité : `s * (0.5 + 2.5*(1 - v)) * (1.1 - 0.3*u)` — écart 6× plus grand au bord d'attaque
   (v = 0) qu'au bord de fuite (v = 1), un peu plus serré vers l'apex.
4. **Corrugation** : les nervures épaisses prennent leur hauteur des veines relevées
   (`fold_veins`), puis membrane, transverses et marge sont pliées entre elles, Sc, R1 et la costa
   (`creases` → `fold_*`, 6 lignes les plus proches, puissance 2 : pas de saut de hauteur).
5. **Tubes** : costa, Sc/R1 effilées, nodus (le plus gros, 0,12 mm, plus sombre), nervures épaisses,
   transverses, marge ; ptérostigma rempli.
6. **Soufflerie 2D** (`physics/wind-tunnel-2d`, frame 7) : un seul node, **7 coupes** de 15 à 85 %
   de l'envergure (*Slice Count*, *Station From / To*, ou une liste branchée sur *Stations*). Chaque
   coupe tranche la membrane et les nervures par un plan et fait passer son propre écoulement 2D
   (Boltzmann sur réseau D2Q9, Smagorinsky), 5° d'incidence, même vent pour toutes : Re = 2000 sur
   la corde moyenne, proportionnel à la corde locale (*Same Airspeed*). Le résultat est redessiné en
   3D dans chaque coupe : vorticité (l'air calme est transparent), lignes de
   courant, barres de pression (bleu = dépression, rouge = surpression), flèches de portance et de
   traînée, et la **courbe de portance** le long de l'envergure qui relie les pointes des flèches.
   Bouton **Compute** : calcule toutes les coupes jusqu'à ce que l'air ait parcouru 8 cordes
   (≈ 1 s par coupe à 64 cellules par corde, sur GPU), sans lancer la lecture ; **Compute All
   Tunnels** fait de même pour tous les nodes du canvas. Sorties : *Cl*, *Cd* (pondérés par la
   corde), *Cl / Cd per Slice*, *Stations*, *Lift Curve*, *Airspeed* (m/s, pour de l'air et
   1 unité = 1 cm), *Section*, *Streamlines*.

## Paramètres

Dans le graphe (modifiables en direct) :

- `vein_seeds` → **Spacing s** (écart des nervures épaisses), formule, **Stretch**, seed ;
  `veins` → **Stretch**, **Stretch Follows Guides**, **Grid Resolution** (finesse du tracé),
  **Relax**.
- `centres` → **Spacing s** (0,05 cm à mi-corde), formule du gradient de densité, seed.
- `cells` → **Wall Rows** (1 = échelles seulement, 2-3 = grilles le long des nervures), **Relax**,
  **Cell Inset** (ouvertures pour la fabrication : découpe laser, impression), matériau de la
  membrane. Sorties utiles à l'analyse : *Cell Areas*, *Cells*, *Cross Edges*.
- `fold_*` → **Height Scale** (amplitude de corrugation globale).
- `*_veins` → **Radius** (rayon des tubes, cm) et profils d'effilement.
- Chaque veine relevée : sélectionner sa node Curve from Points pour éditer ses points dans le
  viewport (Sc et R1 déplacent les murs ; les autres réorientent le réseau épais).

Dans [`tools/gen_dragonfly_wing.py`](../tools/gen_dragonfly_wing.py) (puis
`python3 tools/gen_dragonfly_wing.py`) : `SPAN` (5 cm, tout suit), `CORRUGATION` (0,35 mm à
l'emplanture), `TIP_FADE`, `CELL`, `CELL_FORMULA`, `VEIN_GAP`, `VEIN_STRETCH`, `NODUS_X`, `NODUS_NOTCH`,
tracé des veines et signes de corrugation.

Résultat par défaut : ~40 panneaux, ~80 tronçons de nervures épaisses, ~1 200 cellules,
corrugation ±0,35 mm, ≈ 0,8 s de calcul (au chargement et à chaque modification).

**Limites** :
- Soufflerie : écoulement 2D par coupe (pas de tourbillon de bout d'aile ni d'écoulement le long de
  l'envergure), aile rigide, membrane épaissie à ≥ 1,5 cellule (≈ 0,15 mm au lieu de quelques µm),
  turbulence modélisée (Smagorinsky). Valeurs de Cl / Cd à prendre comme ordres de grandeur et
  pour comparer des variantes, pas comme mesures.
- Les nervures épaisses viennent d'une grille (500 pas sur l'envergure, 0,1 mm) puis sont lissées :
  tracé précis à ~0,02 mm près, pas exactement « Voronoi » au sens analytique.
- Dans un panneau très concave (encoche à une jonction), une cellule découpée peut se recroiser ;
  elle est alors réduite à sa plus grande boucle (perte < 0,01 % de surface).
- La corrugation est forte à l'emplanture, là où les veines sont serrées : souvent 30 à 50° de pente
  locale entre une crête et une vallée voisines, davantage par endroits.

## Données morphologiques et mécaniques retenues

| Grandeur | Valeur | Source |
|---|---|---|
| Nodus (fin de Sc sur la costa) | ≈ 45 % de l'envergure | Jongerius & Lentink 2010 |
| Ptérostigma | ≈ 85 % de l'envergure, bord d'attaque | Jongerius & Lentink 2010 |
| Charge aérodynamique max. | ≈ 65 % de l'envergure | Jongerius & Lentink 2010 |
| Corrugation | forte à l'emplanture, décroît vers l'apex | Jongerius & Lentink 2010 (micro-CT *Sympetrum*) |
| Longueur d'aile Odonata (ex.) | 52 mm | Salcedo et al. 2019 |
| Diamètre costa à l'emplanture | ≈ 175 µm | Biomimetics 2025 (FEM paramétrique) |
| Épaisseur membrane | ≈ 1,6–4,3 µm (médiane 4,31 µm *S. vulgatum*) | Appel et al. 2015 |
| E veines | ≈ 6 GPa (6,1 GPa selon les modèles) | Jongerius & Lentink 2010 ; FEM aile postérieure |
| E membrane | ≈ 3,75 GPa | étude FSI (J. Mechanics) |
| Masse volumique cuticule | ≈ 1200 kg/m³ | repris dans Biomimetics 2025 |
| Cellules Odonata | petites et arrondies (vs. Diptères : grandes, rectangulaires) | Salcedo et al. 2019 |

**À vérifier avant usage d'ingénierie** : le schéma de signes de corrugation utilisé
(C+, Sc−, R1+, RP−, IR2+, R3−, IR3+, R4−, MA+, CuA−, A1+) suit Riek & Kukalová-Peck de façon simplifiée,
non confirmé par les sources ci-dessus ; le tracé des veines est relevé à la main sur une photo
(précision de l'ordre de 2-3 % de la corde), pas une numérisation de spécimen.

## Sources

- Hoffmann J., Donoughe S., Li K., Salcedo M. K., Rycroft C. H. (2018). *A simple developmental model
  recapitulates complex insect wing venation patterns.* PNAS 115(40):9905–9910.
  doi:10.1073/pnas.1721248115 — accès libre : <https://www.osti.gov/pages/biblio/1471162>,
  code : `hoffmannjordan/insect-wing-venation-patterns`.
- Salcedo M. K., Hoffmann J., Donoughe S., Mahadevan L. (2019). *Computational analysis of size, shape
  and structure of insect wings.* Biology Open 8(10):bio040774.
  <https://journals.biologists.com/bio/article/8/10/bio040774/224129>
- Jongerius S. R., Lentink D. (2010). *Structural analysis of a dragonfly wing.* Experimental Mechanics.
  <https://lentinklab.com/wp-content/uploads/2022/06/1354400272_2010-dragonfly-lentink.pdf>
- Appel E., Heepe L., Lin C.-P., Gorb S. N. (2015). *Ultrastructure of dragonfly wing veins: composite
  structure of fibrous material supplemented by resilin.* J. Anatomy. <https://onlinelibrary.wiley.com/doi/10.1111/joa.12362>
- Blanke A. et al. (2018). *Analysis of modularity and integration suggests evolution of dragonfly wing
  venation mainly in response to functional demands.* J. R. Soc. Interface 15:20180277.
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC6127186>
- *Parametric FEM-based analysis on adaptive vein morphology of dragonfly wings toward material
  efficiency* (2025). Biomimetics 10(12):799. <https://doi.org/10.3390/biomimetics10120799>
- *Fluid–structure interaction simulation on flight performance of a dragonfly wing under different
  pterostigma weights.* J. Mechanics. <https://academic.oup.com/jom/article/doi/10.1093/jom/ufaa013/6121959>
- Algorithme Voronoi : d'après Voro++ (C. H. Rycroft), cf. `src/shared/graph/voronoi.ts`.
