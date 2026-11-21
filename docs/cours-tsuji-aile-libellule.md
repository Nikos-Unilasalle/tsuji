# Cours Tsuji — Modéliser une aile de libellule paramétrique

> Démo correspondante : **Browse Demos → « Dragonfly Wing (Voronoi 2D) »**
> (`public/demos/demo_dragonfly_wing.tsuji`, générée par `tools/gen_dragonfly_wing.py`).
> Fiche technique et sources : [dragonfly-wing.md](dragonfly-wing.md).

**Objectif.** Comprendre la structure d'une aile de libellule, puis la reconstruire dans Tsuji
comme un modèle **paramétrique** : chaque nervure, chaque cellule et chaque pli se recalcule quand
on change une valeur. On y apprend une méthode biomimétique générale : **observer → relever →
abstraire en règles → générer → vérifier**.

**Prérequis.** Aucun en programmation. Savoir ce qu'est une courbe et un nuage de points suffit.

**Durée indicative.** 3 h 30 : 45 min d'anatomie, 15 min de prise en main, 2 h 30 de construction,
de soufflerie et d'exploration.

---

## Sommaire

1. [Anatomie de l'aile de libellule](#partie-1--anatomie-de-laile-de-libellule)
2. [Prise en main de Tsuji](#partie-2--prise-en-main-de-tsuji)
3. [Construire l'aile, frame par frame](#partie-3--construire-laile-frame-par-frame)
4. [Explorer et détourner le modèle](#partie-4--explorer-et-détourner-le-modèle)
5. [Ce qui se passe sous le capot](#partie-5--ce-qui-se-passe-sous-le-capot)
6. [Glossaire](#glossaire) · [Sources](#sources)

---

## Partie 1 — Anatomie de l'aile de libellule

### 1.1 Une aile, deux matériaux

L'aile d'une libellule (ordre des **Odonates**, sous-ordre des **Anisoptères** pour les
« vraies » libellules, aux ailes postérieures plus larges que les antérieures) est un composite
très léger :

- une **membrane** de cuticule de quelques micromètres (≈ 2 à 4 µm) ;
- un réseau de **nervures** : tubes creux de cuticule, plus épais près de l'emplanture, qui
  portent la membrane comme les baguettes d'un cerf-volant. Certaines articulations de nervures
  contiennent de la **résiline**, une protéine très élastique.

Ordres de grandeur retenus pour le modèle (aile antérieure d'*Anax junius*, ~5 cm) : costa de
≈ 175 µm de diamètre à l'emplanture, module d'Young ≈ 6 GPa pour les nervures, ≈ 3,75 GPa pour
la membrane.

### 1.2 Orientation et vocabulaire

```
              bord d'attaque (costal)
   emplanture ───────────────────────────────▶ apex
   (base)     bord de fuite (marge postérieure)
```

- **Emplanture / base** : l'attache au thorax. **Apex** : la pointe.
- **Bord d'attaque** : le bord avant, rigide, qui fend l'air. **Bord de fuite** : le bord arrière,
  souple.
- **Envergure** (*span*) : de la base à l'apex. **Corde** : du bord d'attaque au bord de fuite.

Dans Tsuji, on travaille en **cm** (1 unité = 1 cm), l'aile posée dans le plan XZ, la hauteur en Y.

### 1.3 Les nervures longitudinales

Elles partent de la base et courent vers l'apex ou la marge. On les nomme selon le système de
Comstock-Needham, adapté aux Odonates. Du bord d'attaque vers le bord de fuite :

| Sigle | Nom | Rôle / repère |
|---|---|---|
| **C** | costa | Le bord d'attaque lui-même ; la nervure la plus épaisse. |
| **Sc** | sous-costale | Court juste sous la costa et **s'arrête au nodus**. |
| **R1** | radiale 1 | Longe le bord d'attaque jusqu'à l'apex, passe sous le ptérostigma. |
| **RP** (R2) | radiale postérieure | Se ramifie vers l'arrière en R2, R3, R4. |
| **IR2, IR3** | intercalaires radiales | Nervures « insérées » entre les radiales, sans attache directe à la base. |
| **R3, R4** | radiales 3 et 4 | Branches de RP qui rejoignent la marge en éventail. |
| **MA** | médiane antérieure | Au milieu de la corde. |
| **CuA** | cubitale antérieure | Vers le bord de fuite. |
| **A1** | anale | Près de la base, côté bord de fuite. |

À retenir : **plus on va vers l'apex et le bord de fuite, plus le réseau se ramifie**, et de
nouvelles nervures (les intercalaires) apparaissent entre les anciennes. Vu de loin, le réseau des
grosses nervures ressemble lui-même à un **pavage de Voronoi étiré** le long de l'envergure : des
panneaux allongés, qui se séparent et se rejoignent.

### 1.4 Les repères remarquables

- **Nodus** — à ≈ 45 % de l'envergure, sur le bord d'attaque. C'est là que la Sc rejoint la costa ;
  une **nervure nodale** épaisse relie costa, Sc et R1, prolongée par le **subnodus** oblique
  vers RP. Le bord d'attaque y forme une petite **encoche**. Rôle : charnière renforcée, qui
  absorbe les chocs et laisse l'aile se tordre en vol (la partie externe peut vriller).
- **Ptérostigma** — cellule épaissie et pigmentée près de l'apex (≈ 85 % de l'envergure), sur
  le bord d'attaque. Plus lourde que le reste, elle agit comme une **masse d'équilibrage** qui
  retarde le flottement (*flutter*) aux grandes vitesses.
- **Arculus, triangle, supratriangle** — structures près de la base, propres aux Anisoptères
  (non modélisées ici : à ajouter en exercice).

### 1.5 Les nervures transverses et les cellules

Entre les longitudinales, des milliers de **nervures transverses** (*cross veins*) découpent la
membrane en **cellules**. Leur organisation n'est pas quelconque :

- **Irrégularité** : les cellules ne forment pas un Voronoi régulier ; leur taille et leur forme
  varient.
- **Échelles et grilles** : quand deux longitudinales sont proches et parallèles, les transverses
  forment une **échelle** (une rangée de cellules rectangulaires) ou une petite **grille**.
- **Gradient de densité** : les cellules sont **grandes près du bord d'attaque** et **petites
  vers le bord de fuite** (et un peu vers l'apex).
- **Une seule rangée par panneau étroit**, des cellules polygonales dans les panneaux larges.

Hoffmann et al. (2018) ont montré qu'un modèle très simple reproduit ces motifs : des **centres
d'inhibition** placés dans chaque panneau, et des parois de Voronoi entre eux. C'est exactement ce
que fera Tsuji. Les cellules ont un rôle mécanique : elles **arrêtent la propagation des fissures**
et répartissent les efforts.

### 1.6 La corrugation

Vue en coupe, l'aile n'est pas plate : elle est **plissée comme un éventail**. Les nervures
longitudinales sont alternativement en **crête (+, convexe)** et en **vallée (−, concave)** :

```
 C+   Sc−   R1+   RP−   IR2+   R3−   IR3+   R4−   MA+   CuA−   A1+
  ╱╲    ╱╲    ╱╲    ╱╲  ...
 ╱  ╲  ╱  ╲  ╱  ╲  ╱  ╲
     ╲╱    ╲╱    ╲╱
```

La corrugation est **forte à l'emplanture** et s'atténue vers l'apex. Elle donne une grande
rigidité en flexion le long de l'envergure pour très peu de matière, tout en laissant l'aile se
cambrer sous la charge (Jongerius & Lentink 2010). Le schéma de signes ci-dessus est simplifié ;
voir la fiche technique.

### 1.7 Ce que l'on retient pour le modèle

| Observation | Règle de génération |
|---|---|
| Grosses nervures en éventail qui se ramifient | Voronoi **lâche** et **étiré** le long de l'écoulement des nervures relevées |
| Sc, R1, nodus, ptérostigma : structure du bord d'attaque | Courbes dessinées, utilisées comme **murs** infranchissables |
| Cellules dans chaque panneau | Voronoi **dense**, calculé **panneau par panneau** |
| Échelles le long des nervures | Rangées de cellules collées aux bords de panneau (**Wall Rows**) |
| Cellules plus petites vers le bord de fuite | **Formule d'espacement** qui dépend de la position |
| Plis crête/vallée | **Hauteur interpolée** depuis les nervures signées |

---

## Partie 2 — Prise en main de Tsuji

### 2.1 Les notions de base

- **Node** : une boîte qui calcule quelque chose (une courbe, des points, un maillage…). Ses
  réglages sont ses **paramètres**, visibles dans le panneau de paramètres quand on clique dessus.
- **Socket** : une prise d'entrée (à gauche) ou de sortie (à droite). La couleur indique le type
  de donnée.
- **Wire** (fil) : relie une sortie à une entrée. Tout est recalculé à chaque modification.
- **Canvas** : la surface du graphe (en bas). Le **viewport** 3D est en haut.

### 2.2 Gestes utiles

| Geste | Effet |
|---|---|
| `Shift` + `A` ou clic droit sur le canvas | Palette de création de nodes (avec recherche) |
| Clic sur un node | Affiche ses paramètres |
| Clic sur un node *Curve from Points* | Affiche ses points de contrôle dans le viewport, éditables au gizmo |
| `A` / `D` (point sélectionné) | Ajouter / supprimer un point de contrôle |
| `Y` dans le viewport | Vue de dessus (`X` droite, `Z` face) |
| Glisser gauche / molette dans le viewport | Orbiter / zoomer |
| `⌘/Ctrl` + `D` | Dupliquer le node sélectionné |

### 2.3 Organiser le canvas : noms et frames

Un graphe de 40 nodes devient vite illisible. Deux outils :

- **Name** (premier champ du panneau de paramètres) : un nom libre affiché sous le node. Dans la
  démo, chaque node porte son nom anatomique : *« Sc — sous-costale (finit au nodus) »*,
  *« Cellules alaires (membrane) »*…
- **Frame** (catégorie *Utility*, via `Shift` + `A` → « Frame ») : un rectangle coloré, titré,
  dessiné derrière les nodes. On le déplace par sa barre de titre ; il se règle en **Title**,
  **Color**, **Width**, **Height**. Il ne calcule rien : il sert à raconter le graphe.

La démo est rangée en **sept frames**, dans l'ordre de la Partie 3.

---

## Partie 3 — Construire l'aile, frame par frame

Ouvre la démo et suis les frames. Pour chacune : ce qu'elle représente biologiquement, les nodes
qu'elle contient, les réglages qui comptent, puis un petit exercice.

### Frame 1 · Anatomie dessinée — contour, costa, Sc, R1, nodus, ptérostigma

**Biologie.** Le bord d'attaque est la partie la plus rigide et la plus constante de l'aile :
on la dessine directement, à partir d'une photo de référence
([Dragonfly_wing_structure.png](https://commons.wikimedia.org/wiki/File:Dragonfly_wing_structure.png)).

**Nodes.** Des *Curve from Points* (`curve/from_points`) :

| Node (Name) | Contenu |
|---|---|
| Contour de l'aile | Courbe fermée : bord d'attaque (avec l'**encoche du nodus**) puis bord de fuite |
| C — costa | Juste sous le bord d'attaque |
| Sc — sous-costale | De la base jusqu'au nodus |
| R1 — radiale 1 | De la base à l'apex |
| Nodus — nervure nodale | Segment court costa → Sc → R1 (type *linear*) |
| Subnodus | R1 → RP, oblique |
| Ptérostigma | Quadrilatère fermé près de l'apex |

Puis un *Group* (`list/group`) **« Murs : Sc, R1, nodus, ptérostigma »** rassemble ces courbes
en une seule liste : ce sont les **murs** que les Voronoi ne traverseront jamais.

**Astuce.** Les courbes ont *Visible* à 0 : elles dépassent volontairement du contour (les
Voronoi les coupent proprement au bord) et ce sont les tubes de la frame 6 qui les dessinent.
Clique sur l'une d'elles pour voir et déplacer ses points.

**Exercice 1.** Sélectionne *Nodus*, déplace ses points de 2 mm vers l'apex. Observe : les
panneaux voisins se recalculent, aucune cellule ne traverse la nouvelle position.

### Frame 2 · Veines relevées (cachées) — guides d'écoulement et de corrugation

**Biologie.** Les autres longitudinales (RP, IR2, R3, IR3, R4, MA, CuA, A1) ne seront **pas**
dessinées telles quelles : sur une vraie aile, leur tracé varie d'un individu à l'autre. On les
relève quand même, pour deux informations seulement :

1. **la direction locale** du réseau (par où « coule » l'aile) ;
2. **le signe de corrugation** (crête + ou vallée −).

**Nodes.** Huit *Curve from Points* nommées par leur sigle, et un *Group*
**« Guides : écoulement + signes de corrugation »** qui les rassemble avec la costa.

Le signe est porté par la **hauteur** des points : une crête est relevée de +0,35 mm à la base,
une vallée abaissée d'autant, et l'amplitude décroît vers l'apex (75 % de perte au bout).

**Exercice 2.** Déplace la nervure *MA* vers le bord de fuite. Les panneaux de la frame 3
s'orientent autrement : la direction d'étirement suit les guides.

### Frame 3 · Nervures longitudinales — Voronoi lâche, étiré le long des veines

**Biologie.** C'est le cœur du modèle : le réseau **épais**, en éventail, qui part de la base,
se ramifie et rejoint la marge. On ne le dessine pas : on le **génère**.

**Nodes.**

1. **Poisson Disk 2D** — *« Graines des nervures longitudinales »*. Sème des points à l'intérieur
   du contour, à distance minimale les uns des autres :
   - *Boundary* ← contour ; *Direction Guides* ← groupe des guides ;
   - **Spacing s** = 0,12 cm, **Spacing Formula** `s * (0.7 + 0.5 * v)` ;
   - **Stretch** = 6 avec **Stretch Follows Guides** : les points sont 6 fois plus espacés le long
     de l'écoulement qu'en travers.
2. **Voronoi 2D** — *« Nervures longitudinales (panneaux) »*. Découpe le contour en cellules
   autour de chaque graine :
   - *Seed Points* ← graines ; *Boundary* ← contour ; *Walls* ← murs ; *Direction Guides* ← guides ;
   - **Stretch** = 6, **Stretch Follows Guides** activé : les cellules sont allongées dans la
     direction des guides, qui tourne d'un endroit à l'autre ;
   - **Follow Guides: Grid Resolution** = 500 : finesse du calcul (voir Partie 5) ;
   - **Relax (Lloyd iterations)** = 1 : un pas de régularisation.

**Sorties utilisées.** *Cells* (≈ 40 **panneaux** fermés), *Cross Edges* (≈ 80 tronçons de
**nervures épaisses**), *Walls in Outline* (Sc, R1, nodus… coupés au contour), *Outline* (la
**nervure marginale**).

**Exercice 3.** Fais varier **Stretch** des deux nodes de 2 à 10. À 2, le réseau ressemble à un
nid d'abeille ; à 10, à des rayures. La vraie aile est autour de 5–7. Change ensuite le **Seed**
des graines : chaque valeur donne un « individu » différent de la même espèce.

### Frame 4 · Cellules + nervures transverses — Voronoi dense, panneau par panneau

**Biologie.** Dans chaque panneau, des transverses découpent la membrane : échelles dans les
panneaux étroits, cellules polygonales dans les larges, de plus en plus petites vers le bord de
fuite.

**Nodes.**

1. **Poisson Disk 2D** — *« Centres des cellules (gradient de densité) »* :
   - **Spacing s** = 0,05 cm ;
   - **Spacing Formula** `s * (0.5 + 2.5 * (1 - v)) * (1.1 - 0.3 * u)`.
     `u` va de 0 (base) à 1 (apex), `v` de 0 (bord d'attaque) à 1 (bord de fuite). L'écart vaut
     donc 3 × s au bord d'attaque et 0,5 × s au bord de fuite : **six fois plus serré** en bas
     de l'aile, et un peu plus serré vers l'apex.
2. **Voronoi 2D** — *« Cellules alaires (membrane) »* :
   - *Seed Points* ← centres ; **Regions** ← *Cells* de la frame 3. Avec *Regions*, le node fait
     **un pavage indépendant par panneau**, et le bord de chaque panneau devient un mur ;
   - **Wall Rows** = 2 : une ou deux rangées de cellules alignées le long des bords de panneau.
     C'est ce qui crée les **échelles** et **grilles** ;
   - **Relax** = 2, membrane semi-transparente (opacité 0,32).

**Sorties utilisées.** *Geometry* (la membrane, maillée cellule par cellule), *Cross Edges* (les
**nervures transverses**), *Cell Areas* (pour l'analyse).

**Exercice 4.** Remplace la formule par `s` (densité uniforme), puis par
`s * (0.5 + 4 * (1 - v))`. Compare avec la photo de référence. Mets **Wall Rows** à 1, puis 3 :
les échelles deviennent des grilles.

### Frame 5 · Corrugation — crêtes (+) et vallées (−)

**Biologie.** Les nervures épaisses alternent crête et vallée ; la membrane et les transverses
sont tendues entre elles.

**Nodes.** Des *Height from Lines* (`geometry/height-from-lines`) : chacun donne une hauteur à un
maillage, des points ou des polylignes en interpolant celle des **lignes guides** les plus proches
(pondération par l'inverse de la distance).

1. *« Hauteur des nervures longitudinales »* : les nervures générées prennent la hauteur des
   **guides relevés** (frame 2) — **Lines Blended** = 4, **Falloff Power** = 2.
2. *Group* *« Plis : nervures épaisses + C, Sc, R1 »* : les nervures maintenant en relief.
3. *« Pli de la membrane »*, *« Pli des nervures transverses »*, *« Pli de la nervure
   marginale »*, *« Pli du nodus »* : tout le reste prend sa hauteur **entre les plis**
   (6 lignes, puissance 2 : pas de marche d'escalier).
4. *« Hauteur de la costa »* : la costa suit sa propre hauteur, échantillonnée finement.

**Exercice 5.** Passe **Height Scale** de *« Pli de la membrane »* à 3 et regarde l'aile de profil
(touche `X`) : les plis apparaissent nettement. Remets 1.

### Frame 6 · Tubes et ptérostigma

**Biologie.** Chaque nervure est un tube ; son diamètre décroît de la base vers l'apex.

**Nodes.** Des *Profiled Tubes* (`curve/profiled-tubes`), un par famille de nervures, et un
*Curve Fill* (`curve/fill`) pour le ptérostigma :

| Node (Name) | Rayon (cm) | Profil |
|---|---|---|
| Tubes — nervures longitudinales | 0,0050 | constant |
| Tubes — Sc, R1, ptérostigma | 0,0065 | effilé vers l'apex |
| Tube — nodus | 0,0120 | constant, brun plus sombre |
| Tubes — nervures transverses | 0,0020 | constant |
| Tube — nervure marginale | 0,0035 | constant |
| Tube — costa | 0,0090 | effilé vers l'apex |
| Ptérostigma (rempli) | — | surface pleine brun foncé |

**Exercice 6.** Le nodus doit se lire au premier coup d'œil : c'est le tube le plus gros. Essaie
un rayon de 0,02, puis reviens à 0,012. Repère aussi l'**encoche** du contour au même endroit.

### Frame 7 · Soufflerie 2D — l'aile dans le vent

**Biologie.** À l'échelle d'une libellule (corde ≈ 1 cm, quelques m/s), le **nombre de Reynolds**
Re = U·c/ν (vitesse × corde / viscosité de l'air) vaut environ 10³ à 10⁴ : l'air est « visqueux » à
cette échelle. Les plis de la corrugation piègent de petits tourbillons qui lissent le profil vu par
l'écoulement : l'aile plissée porte aussi bien qu'un profil lisse, pour beaucoup moins de matière.

**Nodes.**

1. *Group* *« Obstacle : membrane + nervures »* : la membrane pliée et les tubes des nervures.
2. Un *Wind Tunnel 2D (Lattice Boltzmann)* (`physics/wind-tunnel-2d`), *« Soufflerie — 7 coupes,
   15 → 85 % de l'envergure »*. Il :
   - **coupe** l'obstacle par des plans perpendiculaires à l'envergure (**Slice Normal Axis** = X) :
     **Slice Count** = 7 coupes réparties de **Station From** à **Station To** (ou une seule coupe
     à **Station** quand Slice Count = 1, ou la liste de positions branchée sur l'entrée
     *Stations*) ;
   - fait souffler le vent selon **Wind Direction** (+Z : du bord d'attaque vers le bord de fuite),
     incliné de **Angle of Attack** (5°) ;
   - résout, dans chaque coupe, son propre écoulement 2D. Avec **Several Slices = Same
     Airspeed**, toutes les coupes sont dans le même vent : le **Reynolds Number** (2000) est celui
     de la corde moyenne, et chaque coupe a un Re proportionnel à sa corde locale ;
   - **redessine en 3D, dans la coupe** : le champ (**Field** : vorticité, vitesse ou coefficient de
     pression Cp), les lignes de courant, des **barres de pression** sur le profil (bleu =
     dépression, rouge = surpression), les flèches de **portance** (verte) et de **traînée**
     (rouge), et la **courbe de portance** qui relie les pointes des flèches le long de l'envergure.

**Calculer.** Dans le panneau du node, groupe *Solver* : **Compute**. Toutes les coupes avancent
jusqu'à ce que l'air ait parcouru **8 cordes** (*Compute Length*), environ 7 s pour les 7 coupes sur
GPU, sans toucher à la timeline. **Compute All Tunnels** lance tous les nodes Wind Tunnel du canvas. On peut aussi lancer la
lecture (▶) pour voir le sillage se former en direct (*Simulate While Playing*).

**Filmer.** *Share → Export Video* filme la soufflerie : l'écoulement avance de *Steps per Frame*
pas à chaque image. Avec *Video Export: Settle the Flow Before Frame 1* (coché par défaut), il est
d'abord calculé jusqu'à stabilisation, et la vidéo s'ouvre sur l'allée de tourbillons déjà formée ;
décoché, elle montre le sillage qui naît de l'air immobile.

**Lire le résultat.**
- **Vorticité** : derrière la coupe, des tourbillons alternés rouges et bleus — l'**allée de Kármán**.
  L'air calme est transparent (*Fade Calm Air*) ; *Calm Air Opacity* règle le voile qui reste
  (0 = plus que les couleurs de l'écoulement, pratique quand les coupes s'empilent).
- **Sorties** : *Cl* et *Cd* de toute l'aile (moyenne des coupes pondérée par leur corde), *Cl per
  Slice* et *Cd per Slice* (une valeur par coupe, moyennée sur la seconde moitié du calcul),
  *Lift Curve*, *Airspeed* — la vitesse réelle que représente ce Reynolds pour cette corde, dans l'air,
  avec 1 unité = 1 cm (*Real World*).

**Exercice 7.** Passe **Slice Count** à 12 et regarde la courbe de portance : où l'aile
porte-t-elle le plus ? Puis calcule à 0°, 5°, 10°, 20° d'incidence et note Cl et Cd : la portance monte, puis la
traînée explose quand l'écoulement **décroche**. Recommence à Re = 500 puis Re = 10 000. Enfin,
mets **Height Scale** des plis à 0 (aile plate) et compare : que gagne-t-on avec la corrugation ?

> **Limites.** Écoulement 2D coupe par coupe : pas de tourbillon de bout d'aile, pas d'écoulement
> le long de l'envergure, aile rigide, membrane épaissie à 1,5 cellule. Bon pour comprendre et
> comparer des variantes ; pour des chiffres d'ingénierie, passer par un solveur 3D (FluidX3D,
> OpenFOAM, WaterLily.jl…) en exportant la géométrie.

### Bilan

Résultat par défaut : ≈ 40 panneaux, ≈ 80 nervures épaisses, ≈ 1 200 cellules, corrugation
±0,35 mm à l'emplanture, ≈ 0,8 s de calcul. Tout vient de **10 courbes relevées, 4 courbes
dessinées et une poignée de nombres**.

---

## Partie 4 — Explorer et détourner le modèle

### 4.1 Dans le graphe (en direct)

| Pour… | Régler |
|---|---|
| un autre individu | **Seed** des deux Poisson Disk 2D |
| un réseau épais plus dense / plus lâche | **Spacing s** des graines longitudinales |
| des panneaux plus ou moins allongés | **Stretch** (graines + Voronoi longitudinal) |
| plus ou moins de cellules | **Spacing s** des centres |
| un autre gradient | **Spacing Formula** des centres |
| des échelles / des grilles | **Wall Rows** des cellules |
| des ouvertures (découpe laser, impression) | **Cell Inset** des cellules |
| un pli plus marqué | **Height Scale** des *Height from Lines* |

### 4.2 Dans le script (régénération)

`tools/gen_dragonfly_wing.py` contient tous les relevés et constantes : `SPAN` (envergure, tout
suit), `CORRUGATION`, `TIP_FADE`, `CELL`, `CELL_FORMULA`, `VEIN_GAP`, `VEIN_STRETCH`, `NODUS_X`,
`NODUS_NOTCH`, et le tracé de chaque nervure en (envergure, fraction de corde). Après
modification :

```bash
python3 tools/gen_dragonfly_wing.py
```

puis recharge la démo.

### 4.3 Exercices de transfert

1. **Aile postérieure.** Élargis le bord de fuite près de la base, ajoute une nervure anale et une
   *boucle anale* (un mur fermé) : le Voronoi dense la remplira de petites cellules.
2. **Demoiselle (Zygoptère).** Ailes étroites et pétiolées : rétrécis le contour à la base, passe
   **Wall Rows** à 1 (cellules surtout rectangulaires), réduis le gradient de densité.
3. **Arculus et triangle.** Ajoute-les comme courbes dans la frame 1 et branche-les dans le groupe
   des murs.
4. **Panneau architectural.** Remplace le contour par une façade, les nervures par des lignes de
   charge : même graphe, autre échelle.
5. **Fabrication.** Mets **Cell Inset** à 0,003 et exporte la membrane : tu obtiens un gabarit de
   découpe ou d'impression.

---

## Partie 5 — Ce qui se passe sous le capot

- **Échantillonnage de Poisson (Poisson disk).** Placer des points au hasard, mais jamais plus
  près qu'une distance donnée : on obtient un semis **irrégulier mais homogène**, comme les
  centres d'inhibition biologiques. La distance peut varier selon la position (formule) et selon la
  direction (étirement).
- **Diagramme de Voronoi.** Chaque point de l'aile appartient à la graine la plus proche ; les
  frontières entre zones forment les cellules. Les Voronoi sont partout dans le vivant (cellules,
  écailles, girafe) parce qu'ils résultent de croissances qui démarrent de points et s'arrêtent en
  se touchant.
- **Relaxation de Lloyd.** On déplace chaque graine au centre de sa cellule et on recommence :
  les cellules se régularisent un peu, comme une mousse qui se détend.
- **Voronoi étiré qui suit des guides.** On mesure la distance avec une **métrique** qui compte
  moins le long de l'écoulement que de travers ; comme la direction change d'un endroit à l'autre,
  le calcul se fait sur une **grille fine** (500 pas sur l'envergure), puis les frontières sont
  lissées et simplifiées. Résultat : pas de trou, pas de chevauchement aux jonctions.
- **Murs et régions.** Un mur est un obstacle que la « croissance » des cellules ne franchit pas.
  Avec *Regions*, chaque panneau est un petit monde fermé : ses cellules ne débordent jamais sur
  une nervure épaisse.
- **Boltzmann sur réseau (LBM, D2Q9).** Au lieu de résoudre directement les équations de
  Navier-Stokes, on fait vivre sur chaque cellule de la grille 9 populations de « particules d'air »
  (une immobile, quatre axiales, quatre diagonales). À chaque pas elles **se déplacent** vers la
  cellule voisine puis **se mélangent** (collision) en tendant vers un équilibre ; la vitesse de
  relaxation fixe la viscosité, donc le Reynolds : τ = 3·U·L/Re + ½. Sur une cellule d'obstacle,
  elles **rebondissent** ; la quantité de mouvement qu'elles y laissent donne la force sur l'aile.
  Un modèle de **Smagorinsky** ajoute la viscosité des petits tourbillons non résolus, ce qui
  garde le calcul stable à Re 10⁴. Chaque cellule ne dépend que de ses voisines : le calcul tourne
  sur la carte graphique, un pixel par cellule. Vérifié sur l'écoulement autour d'un cylindre (Re 100 : Strouhal ≈ 0,18, contre 0,165 en milieu infini ; l'écart vient des parois du tunnel).
- **Interpolation par inverse de distance (IDW).** Pour la corrugation, la hauteur d'un point est
  une moyenne des hauteurs des lignes les plus proches, chacune pesant 1 / distance^p.

---

## Glossaire

| Terme | Définition |
|---|---|
| Anisoptère | Libellule « vraie » ; ailes postérieures plus larges que les antérieures, tenues à plat au repos. |
| Apex | Pointe de l'aile. |
| Corde | Largeur de l'aile, du bord d'attaque au bord de fuite. |
| Corrugation | Plissement de l'aile en crêtes et vallées le long des nervures. |
| Costa (C) | Nervure du bord d'attaque. |
| Emplanture | Base de l'aile, attachée au thorax. |
| Frame (Tsuji) | Cadre coloré et titré qui regroupe visuellement des nodes. |
| Intercalaire | Nervure longitudinale insérée entre deux autres, sans départ à la base. |
| Lloyd (relaxation de) | Itération qui recentre chaque graine dans sa cellule de Voronoi. |
| Nombre de Reynolds | Re = U·c/ν : rapport entre l'inertie et la viscosité de l'air ; ≈ 10³–10⁴ pour une libellule. |
| Nodus | Charnière renforcée du bord d'attaque, à mi-envergure, où finit la Sc. |
| Poisson disk | Semis aléatoire de points avec distance minimale entre eux. |
| Ptérostigma | Cellule épaissie et pigmentée près de l'apex, masse anti-flottement. |
| Résiline | Protéine élastique présente dans certaines articulations de nervures. |
| Subnodus | Nervure oblique qui prolonge le nodus de R1 vers RP. |
| Voronoi | Partition du plan en zones les plus proches de chaque graine. |
| Vorticité | Rotation locale de l'air ; rouge et bleu = sens opposés. |
| Cl, Cd | Coefficients de portance et de traînée : forces rapportées à ½ρU²·corde. |
| Wall Rows (Tsuji) | Nombre de rangées de cellules alignées le long des murs d'un Voronoi 2D. |

---

## Sources

- Hoffmann J., Donoughe S., Li K., Salcedo M. K., Rycroft C. H. (2018). *A simple developmental
  model recapitulates complex insect wing venation patterns.* PNAS 115(40):9905–9910.
- Salcedo M. K., Hoffmann J., Donoughe S., Mahadevan L. (2019). *Computational analysis of size,
  shape and structure of insect wings.* Biology Open 8(10):bio040774.
- Jongerius S. R., Lentink D. (2010). *Structural analysis of a dragonfly wing.* Experimental
  Mechanics.
- Appel E., Heepe L., Lin C.-P., Gorb S. N. (2015). *Ultrastructure of dragonfly wing veins.*
  Journal of Anatomy.
- Blanke A. et al. (2018). *Analysis of modularity and integration suggests evolution of dragonfly
  wing venation mainly in response to functional demands.* J. R. Soc. Interface 15:20180277.
- Norberg R. Å. (1972). *The pterostigma of insect wings an inertial regulator of wing pitch.*
  Journal of Comparative Physiology.
- Krüger T. et al. (2017). *The Lattice Boltzmann Method — Principles and Practice.* Springer.
- Kesel A. B. (2000). *Aerodynamic characteristics of dragonfly wing sections compared with
  technical aerofoils.* Journal of Experimental Biology 203:3125–3135.
- Image de référence : *Dragonfly_wing_structure.png*, Wikimedia Commons.

Liens complets, données chiffrées et limites du modèle : [dragonfly-wing.md](dragonfly-wing.md).

> **Avertissement.** Le tracé des nervures est relevé à la main sur une photo (précision ≈ 2–3 %
> de la corde) et le schéma de corrugation est simplifié. Le modèle sert à comprendre et à
> concevoir ; pour une étude d'ingénierie, valider sur des données de spécimen.
