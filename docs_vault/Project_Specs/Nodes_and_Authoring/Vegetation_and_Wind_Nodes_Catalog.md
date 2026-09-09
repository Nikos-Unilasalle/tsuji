# Vegetation & Wind Nodes Catalog

*Emplacement : `docs_vault/Project_Specs/Nodes_and_Authoring/`*
*Code : `src/shared/three/vegetation/`, `src/shared/graph/nodes/vegetation.ts`*

Spécification complète des cinq nœuds de végétation temps réel, conçus selon les principes d'atomicité du [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]] : aucune brique n'est réservée à un seul effet visuel, chacune est réutilisable seule.

Inspiration technique : le folio 2025 de Bruno Simon (`brunosimon/folio-2025`, MIT). Les *algorithmes* sont transposés — pas le code, qui est écrit en WebGPU/TSL alors que Tsuji rend en WebGL. Les shaders ci-dessous sont des réécritures GLSL.

---

## 1. Principe directeur : un seul vent

Le piège d'une bibliothèque de végétation est de donner à chaque nœud ses propres paramètres de vent. Deux bruits différents dans une même scène se lisent instantanément comme faux : l'herbe penche à gauche pendant que les feuilles au-dessus penchent à droite.

D'où la décomposition retenue :

```
                   ┌──────────────────────┐
                   │  physics/wind-field  │
                   └──────────┬───────────┘
                    field(any)│      wind(vector) ──▶ Force Field, Transform, logique…
        ┌──────────────┬──────┴───────┬──────────────┐
        ▼              ▼              ▼              ▼
 structure/       object/tree    geometry/      (tout futur nœud
 grass-field      (tronc+feuilles) wind-sway     ployant au vent)
     ▲
     │ trampleMap (texture)
     │
 texture/interaction-map ◀── source (objet en mouvement) / positions (liste)
```

Le vent dit **comment ça bouge** ; la carte d'interaction dit **où l'on est passé**. Les deux sont des champs partagés, produits par un nœud et lus par plusieurs — c'est la même forme architecturale appliquée deux fois.

Le champ est décrit **une seule fois** et implémenté **deux fois à l'identique** : `sampleWind()` en TypeScript, `windOffset()` en GLSL. Les deux implémentations sont volontairement des jumelles ligne à ligne, et un test unitaire vérifie que tout uniform déclaré côté GLSL possède son entrée côté CPU — un renommage d'un seul côté est exactement le bug que ce test attrape.

---

## 2. Nœud 2.1 : `physics/wind-field` (*Wind Field*)

- **Rôle** : Champ de vent global de la scène. Ne rend rien.
- **Catégorie** : `physics`
- **Algorithme** : deux octaves de bruit de valeur bilinéaire (fade smoothstep), défilant le long de la direction du vent. L'octave rapide donne la rafale, l'octave lente le houle long qui fait qu'un champ d'herbe a l'air d'avoir de la météo au-dessus plutôt qu'une vibration.
- **Entrées** :
  - `angle` (`value`, défaut : `0.6π`) — stocké en radians, affiché en degrés
  - `strength` (`value`, défaut : 0.5) — déplacement crête en unités monde
  - `positionFrequency` (`value`, défaut : 0.5) — taille d'une rafale ; bas = vent large et roulant
  - `timeFrequency` (`value`, défaut : 0.1) — vitesse de défilement
  - `gustiness` (`value`, défaut : 1.0) — poids de l'octave lente
  - `samplePosition` (`vector`) — point d'échantillonnage CPU
- **Sorties** :
  - `field` (`any`) — descripteur `WindFieldDescriptor` consommé par les nœuds de végétation
  - `wind` (`vector`) — le vent échantillonné en `samplePosition`, dans le plan XZ (`y = 0`)
  - `speed` (`value`) — norme du vecteur
- **Déterminisme** : la phase temporelle est repliée côté nœud (`phase = time × timeFrequency`) et transmise au shader, qui n'a donc aucune horloge propre. Une frame exportée ne dépend que de son numéro de frame.

---

## 3. Nœud 2.2 : `structure/grass-field` (*Grass Field*)

- **Rôle** : Champ d'herbe dense, fini en mémoire et infini à l'écran.
- **Catégorie** : `structure`
- **Deux idées portent tout le nœud** :
  1. **Aucune instanciation.** Un brin fait trois sommets ; un `InstancedMesh` dépenserait plus en matrice par instance qu'en brin. Le champ entier est **une** `BufferGeometry` de triangles libres, et la forme du brin est reconstruite dans le vertex shader depuis un index de coin (pointe / gauche / droite) et un aléa par brin. Un draw call, zéro matrice.
  2. **Repliement torique.** Les bases sont dispersées une fois dans un carré de côté `size`, puis repliées chaque frame modulo ce carré autour de `Center`. Avancez : les brins derrière vous réapparaissent devant. 30 k brins couvrent un monde illimité à coût fixe et sans réallocation. La dispersion est jittée par cellule, donc le repli n'a ni couture visible ni motif de grille.
- **Entrées** : `wind` (`any`), `matrix` (`matrix`), `center` (`vector`), `densityMap` (`texture`), `size`, `bladeHeight`, `bladeWidth`, `windInfluence` (`value`)
- **Sorties** : `geometry` (`geometry`), `matrix` (`matrix`), `bladeCount` (`value`), `groundShadow` (`texture`)
- **Paramètres notables** :
  - `subdivisions` (défaut 160) — nombre de brins = le carré de cette valeur
  - `seed` — même graine, même champ, à chaque rechargement et à chaque frame exportée (PRNG mulberry32)
  - `densityThreshold`, `densitySize`, `densityCenter` — mapping monde → UV de la carte de densité. Hors carte, rien ne pousse.
  - `baseColor` / `tipColor`, `lightDirection`, `ambient`
  - `groundShadowIntensity` / `groundShadowSoftness` / `groundShadowResolution` — voir **Ombre au sol** ci-dessous.
  - `shadowColor` / `shadowIntensity` — **ombre au sol sous les brins**. La lumière qui atteint la base d'un brin a traversé tous ses voisins : la base se teinte donc vers `shadowColor` et la pointe garde la sienne, le dégradé suivant la hauteur du triangle. Les brins foulés s'enfoncent 1,5× plus dans cette ombre. Défauts `#000000` / `0.55`, qui reproduisent exactement l'AO verticale câblée en dur auparavant.
- **Ombre au sol (sortie `groundShadow`)** : les brins ne peuvent pas projeter d'ombre — trois sommets ne portent aucune normale, et une shadow map de 30 000 triangles coûterait plus cher que le champ lui-même. Un quad sombre posé sur le sol n'est pas la réponse non plus : c'est une surface transparente de plus à trier, et elle se bat contre le matériau du sol.
  Ce qui se lit comme une ombre d'herbe, c'est un assombrissement **flou** qui suit *où l'herbe est* — ce que la carte de densité dit déjà. La sortie est donc cette carte, **floutée** (box blur séparable, trois passes) et **teintée** de `shadowColor` : **blanc là où rien ne pousse** — l'élément neutre d'un multiply — et la couleur d'ombre sous l'herbe dense.
  **Câblage** : `Grass Field ▸ Ground Shadow` → `texture/mix` (*Blend Mode* = **multiply**, *Factor* = 1) avec la texture du sol sur l'autre entrée, puis la sortie dans le `Texture Map` du plan. Le sol garde **un** matériau et **un** draw call, et sa texture se compose dans le graphe comme n'importe quelle autre.
  `groundShadowSoftness` est une fraction de la largeur de la carte, donc une vraie distance au sol : le flou ne change pas de largeur avec la résolution. La texture porte le `mapPlacement` de la carte de densité dont elle sort, et n'est **recalculée que lorsque ses entrées changent** — un flou sur 256² n'est pas un coût par frame.
- **Carte de densité** : c'est ce qui transforme le nœud d'une texture en une scène — le canal rouge pilote la hauteur du brin, et sous le seuil rien ne pousse. Chemins, berges et zones pelées se **peignent** au lieu de se modéliser.
- **Limites assumées** :
  - Les brins se dressent toujours selon l'axe Y du monde ; la matrice du nœud positionne la base, elle n'incline pas le champ.
  - Éclairage propre au shader (lambert plat + ombre au sol paramétrée), non intégré au pipeline d'éclairage Three.js : trois sommets ne portent aucune normale honnête.
  - `frustumCulled = false` et bounding sphere manuelle, puisque le shader relocalise chaque sommet.

---

## 4. Nœud 2.3 : `object/tree` (*Tree (Parametric)*)

- **Rôle** : Un arbre complet depuis une graine, une espèce et un jeu de nombres.
- **Catégorie** : `object`
- **Ce n'est délibérément pas un L-système** avec sa grammaire propre. Ce qu'un auteur veut régler, c'est « quelle hauteur », « quelle densité », « combien ça retombe » — les paramètres sont donc ceux-là, et la récursion est simple : une branche est une épine courbée qui engendre quelques enfants sur sa partie haute, plus courts et plus fins, jusqu'à épuisement du budget de niveaux.
- **Structure du code** : la génération (`generateTreeSkeleton`) est séparée du maillage (`buildBranchGeometry`, `buildLeafMatrices`). Le squelette est la partie testable, et la partie que d'autres nœuds voudront : les extrémités de branches sont exactement là où l'on accroche fruits, lanternes ou particules — d'où la sortie `tips`.
- **Rendu** : deux draw calls.
  - Branches : balayage d'un anneau le long de chaque épine, soudé en une géométrie unique. Les repères sont **transportés parallèlement** le long de l'épine plutôt que reconstruits depuis un vecteur *up* fixe, ce qui empêche le tube de vriller violemment au passage à la verticale.
  - Feuilles : `InstancedMesh` de cartes dont le pivot est la tige (origine sur l'arête basse), découpées en amande dans le fragment shader — aucune texture à charger, aucun tri alpha à rater, et une silhouette nette à n'importe quel zoom.
- **Espèce = port de croissance, pas préréglage.** Un préréglage écraserait les nombres déjà réglés par l'auteur, sans moyen de savoir quelles modifications ont survécu. L'espèce change **le comportement de la récursion** — le tronc garde-t-il une flèche centrale ou fourche-t-il en branches égales, les latérales montent-elles ou retombent-elles, y a-t-il seulement des ramifications — et chaque paramètre numérique continue de moduler ce comportement par-dessus. Choisir *Willow* puis augmenter Branch Angle donne un saule plus ample, pas un saule silencieusement remplacé.

| Espèce | Port | Marqueurs |
| :--- | :--- | :--- |
| `oak` | Décurrent, couronne large et fourchue | flèche faible (0.15), phototropisme léger, feuille ovale |
| `cherry` | Arbre à floraison, houppier en **touffes** | feuillage en puffs denses aux extrémités, feuille ronde ×0.42 |
| `conifer` | Excurrent : un tronc jusqu'à la cime | flèche 0.92, latérales courtes en verticilles inclinées vers le bas, aiguilles |
| `willow` | Tout retombe | droop 1.5, latérales longues et fines, phototropisme négatif, feuille lancéolée |
| `birch` | Élancé, houppier haut | flèche 0.6, première branche haute (0.55), fort phototropisme, feuille cordée |
| `palm` | **Aucune ramification** | stipe nu, couronne de frondes à 93 % de la hauteur, feuilles ×3.4 |
| `bush` | À peine un tronc | ramification dès la base (0.02), dense, feuille ronde |
| `dead` | Silhouette d'hiver | ramification complète, zéro feuillage |

- **Entrées (sockets)** : `wind` (`any`), `matrix`, `seed`, `sizeScale`, `trunkHeight`, `trunkRadius`, `levels`, `childCount`, `branchAngle`, `curvature`, `droop`, `lengthFalloff`, `radiusFalloff`, `leavesPerBranch`, `leafSize`, `leafAspect`, `leafDroop`
- **Sorties** : `geometry` (`geometry`), `matrix` (`matrix`), `tips` (`list` de `Vector3`), `branchCount` (`value`)
- **Paramètres, par groupe** :
  - **Species** — `species`, `seed`, `sizeScale`. **Size est une échelle maîtresse** : hauteur de tronc, rayon et taille de feuille bougent ensemble, parce que « le même arbre en plus grand » doit être un nombre et non trois à garder en proportion à la main.
  - **Structure** — `levels`, `childCount`, `branchStart`, `branchAngle`, `lengthFalloff`, `radiusFalloff`, `curvature`, `droop` (négatif = relève), `phototropism` (le retour vers la lumière le long de la branche), `gnarl`.
  - **Trunk** — `trunkHeight`, `trunkRadius`, `trunkFlare` (empattement au sol), `taper`. Le profil de rayon suit `(1-v)^taper` : à 1 c'est un cône — un crayon —, au-dessus le membre tient son épaisseur puis s'effile près de la pointe, ce que fait une vraie branche.
  - **Mesh** — `segments`, `radialSegments`.
  - **Foliage** — `foliageMode`, `clumpsPerBranch`, `clumpRadius`, `leafShape` (`auto` suit l'espèce, sinon *almond, oval, round, needle, lance, heart, maple*), `leavesPerBranch`, `leafLevels` (sur combien de niveaux depuis les pointes le feuillage descend : 1 = une coque de feuilles sur les brindilles, 3 = houppier plein), `leafSize`, `leafAspect` (largeur relative), `leafTip` (acuité de la pointe), `leafDroop` (bascule de chaque carte vers le sol — c'est ce qui donne le poids : une feuille pend de son pétiole, elle ne flotte pas), `leafColorA/B`.
  - **Shading** — `barkColor`, `barkRoughness`, `lightDirection`, `ambient`.
  - **Wind** — `windInfluence`, `trunkStiffness`.
- **Deux modes de feuillage** (`foliageMode` : `auto` suit l'espèce, sinon `scattered` / `clumps`) :
  - **`scattered`** — feuilles dispersées le long des brindilles. Se lit comme un voile ; c'est le mode d'un bouleau ou d'un saule.
  - **`clumps`** — le feuillage est porté en **puffs sphériques** aux extrémités des branches. La silhouette est alors portée par la masse, les feuilles ne texturent que sa surface : c'est le rendu des cerisiers stylisés et des chênes de jeu. Deux réglages : `clumpsPerBranch` (puffs par branche, le dernier à la pointe) et `clumpRadius` (rayon en multiples de la taille de feuille).
  - Deux détails font la différence entre une boule crédible et un nuage de confettis rond : le rayon est **biaisé vers la surface** (`0.45 + 0.55·∛u`), parce qu'une feuille au centre d'une touffe n'est jamais vue et gaspille un quad ; et chaque carte est **orientée vers l'extérieur à 65 %** (slerp), ce qui donne une peau feuillue plutôt qu'un semis d'orientations aléatoires.
  - Plafond `MAX_TREE_LEAVES = 24000` : le mode touffes multiplie branches × puffs × feuilles, et trois curseurs d'apparence anodine peuvent demander un million de quads.

- **Rampe saisonnière** (`season` 0 → 1, socket câblable) : rampe à trois arrêts, `été → or → rouge tardif`, avec **décalage par feuille** (`seasonVariance`). Une canopée ne tourne pas d'un bloc, et une saison uniforme est le tell. Le décalage est l'aléa propre de la feuille, donc une feuille donnée garde sa place dans le virement pendant toute l'animation au lieu de scintiller d'une couleur à l'autre. Couleurs `autumnColorA` (mi-saison) et `autumnColorB` (tardive) réglables.

- **Dégradé vertical de canopée** (`canopyShade`, `canopyShadePower`) : chaque feuille porte sa hauteur normalisée dans le houppier (attribut instancié `aLeafHeight`, calculé depuis les placements et non depuis le Y monde, donc juste quel que soit le transform de l'arbre). Le sommet est éclairé, le dessous est dans sa propre ombre. **C'est le détail qui empêche un feuillage stylisé de se lire comme un autocollant plat.**

- **Le vent fait pivoter la feuille, il ne la déforme pas.** Le champ est échantillonné **une fois par feuille, à son pétiole** (l'origine de l'instance), puis appliqué comme une **rotation de Rodrigues autour de ce pétiole**. Deux raisons, et la première est un bug corrigé : échantillonner à la position de chaque sommet donnait aux quatre coins d'une même carte quatre déplacements différents, ce qui cisaillait et étirait la feuille — le décalage *par feuille* fait frissonner une grappe, le décalage *par sommet* ne fait que déchirer le quad. Et une rotation ne peut pas changer la forme de la carte, quelle que soit la force du vent : `src/shared/graph/nodes/vegetation.test.ts` vérifie que toutes les arêtes et la diagonale sont conservées jusqu'à une influence de 40, et reproduit l'étirement de l'ancienne formule. La normale tourne avec la feuille, donc l'éclairage suit la rafale.

- **Silhouette de feuille = uniform, pas géométrie.** `leafShape` et `leafTip` sont volontairement **exclus de la clé de reconstruction** : parcourir les formes de feuilles ne coûte rien, alors que tirer `Levels` reconstruit l'arbre. Le profil de demi-largeur est une fonction GLSL par forme, découpée dans la carte au fragment.
- **Coût maîtrisé** :
  - La géométrie n'est reconstruite que si un paramètre de **forme** change ; couleur, vent et transform sont des uniforms, donc tirer un curseur de couleur est gratuit là où tirer `Levels` ne l'est pas.
  - `MAX_TREE_BRANCHES = 4000`. Borner `levels` et `childCount` séparément ne suffit pas — c'est leur **produit** qui explose (6 niveaux × 6 enfants = 56 000 branches). La croissance s'arrête donc net au budget.
- **Forêt** : un seul nœud, un `Array`/`Spawner` et une graine par instance.

---

## 5. Nœud 2.4 : `texture/interaction-map` (*Interaction Map*)

- **Rôle** : Carte top-down de ce qui est passé par là. C'est la brique qui fait qu'un monde paraît **foulé** plutôt que décoré.
- **Catégorie** : `texture`
- **Mécanisme** : une caméra orthographique regarde à la verticale un carré de monde ; ce qui s'y déplace peint dans une cible de rendu ; la cible se réinjecte dans elle-même chaque frame, légèrement atténuée. L'herbe la lit et se couche là où vous êtes passé. Le nœud **peint** ; ce que la marque *signifie* regarde le consommateur.
- **Entrées** : `source` (`geometry`), `positions` (`list`), `center` (`vector`), `size`, `radius`, `strength`, `recovery` (`value`)
- **Sorties** : `texture` (`texture`), `center` (`vector`), `size` (`value`), `count` (`value`)
- **Trois décisions structurantes** :
  1. **Elle défile avec son centre.** Câblez la position d'un personnage : la carte le suit, son contenu se décalant du même delta en UV pour que les marques restent fixes en coordonnées monde. Une carte fixe couvrirait soit le monde entier à une résolution inutilisable, soit s'épuiserait sous les pieds du joueur.
  2. **Ping-pong, pas lecture-écriture.** Une cible de rendu ne peut être échantillonnée et écrite dans la même passe : l'estompage lit A et écrit B, les pinceaux dessinent dans B, puis on échange. L'alternative — relire vers le CPU — coûterait un blocage de pipeline par frame.
  3. **Estompage en demi-vie, pas en facteur par frame.** Une marque dure le même temps *réel* que la machine tourne à 30 ou à 144 fps. Un multiplicateur par frame ferait disparaître les traces plus vite sur une machine rapide — c'est précisément le bug que le test de « deux demi-pas = un pas entier » verrouille.
- **Coût par frame** : un quad plein écran plus un `InstancedMesh` d'autant de pinceaux qu'il y a de sources. La carte ne devient **pas** plus coûteuse à mesure que le monde se remplit de marques.
- **Convention monde↔carte** : `mapUv()` (dans `interactionMap.ts`), partagée par tous les shaders qui lisent une carte — v est inversé parce qu'une caméra zénithale miroite nécessairement un axe, et ce choix-là fait que `v = 1` est le nord, comme se lit une carte. La carte de densité de l'herbe utilise la même fonction, donc une carte peinte à la main et une carte d'interaction vivante se superposent exactement.
- **Sans renderer** (évaluation headless, tests) : renvoie `null` plutôt que de lever — un consommateur traite déjà une carte absente comme « aucune marque ».
- **Consommation côté herbe** : socket `Trample Map` sur `structure/grass-field`. L'herbe foulée est **pliée, pas supprimée** — la pointe du brin se rabat dans une direction propre à chaque brin et la couleur s'assombrit vers la base ; une zone écrasée se lit comme de l'herbe couchée, pas comme de l'herbe plus courte.
- **Placement transmis par la texture** : la carte bouge à chaque frame, son centre ne peut donc pas vivre dans les paramètres du consommateur. Le nœud producteur estampille `center` et `size` dans `texture.userData.mapPlacement`, et chaque consommateur les y lit (`readMapPlacement`), avec repli sur ses propres paramètres pour une image fixe non estampillée. **Un fil, pas trois qui ne doivent jamais diverger.**

---

## 6. Nœud 2.5 : `geometry/wind-sway` (*Wind Sway*)

- **Rôle** : Faire ployer n'importe quoi qui existe déjà dans le graphe.
- **Catégorie** : `structure`
- **Ce n'est pas un déformeur** : il ne touche à aucune donnée de sommet, il patche le matériau (`onBeforeCompile`) pour que le GPU fasse le ployage. C'est toute la différence entre un modificateur qu'on peut poser sur un import de 200 k sommets et un qu'on ne peut pas.
- **Conséquence à connaître** : les nœuds en aval qui lisent des sommets (Mesh to Points, Raycast) voient le maillage **non ployé**. Le sway est un rendu, pas une simulation.
- **Entrées** : `geometry` (`geometry`, `owns: true`), `wind` (`any`), `influence`, `anchorY`, `height`, `stiffness` (`value`)
- **Sorties** : `geometry`, `matrix`
- **Masque vertical** : `Anchor Y` reste planté, tout ce qui est au-dessus ploie selon une courbe puissance jusqu'à `Height`. Réglez l'ancre à la base d'un tronc et la hauteur à sa cime, et l'arbre ploie comme un arbre ploie. `autoHeight` (défaut activé) mesure ces deux valeurs sur la bounding box : la question « quelle hauteur fait cette chose » a déjà sa réponse dans la géométrie.
- **Hygiène** :
  - Le matériau amont est **cloné** avant patch. Il peut être partagé avec des maillages auxquels ce nœud n'a jamais été câblé, et patcher en place ferait ployer toute la scène.
  - `customProgramCacheKey` est surchargé, sinon Three réutilise silencieusement le programme non patché.
  - Le déplacement est calculé en espace monde (le vent est une propriété du monde, pas du modèle) puis reconverti via un uniform `mat4` inverse — une inversion CPU par frame plutôt qu'une par sommet, et aucune dépendance à `inverse()` GLSL.

---

## 7. Protocole P0 — VRAM & cycle de vie

Conforme au protocole du roadmap : chaque nœud possède son `createNodeCache<T>` avec libération explicite.

| Cache | Contenu | Libération |
| :--- | :--- | :--- |
| `grassCache` | `Mesh` + `ShaderMaterial` | `geometry.dispose()`, `material.dispose()` |
| `treeCache` | `Group` (bark + leaves), matériaux, squelette | `disposeObject3D`, `dispose()` des deux matériaux |
| `swayCache` | uniforms partagés + clones patchés par uuid source | `dispose()` de chaque clone |
| `interactionCache` | `Map<WebGLRenderer, InteractionMapState>` (deux cibles de rendu, quad, pinceaux) | `state.dispose()` par renderer |

Sur changement de forme, les **buffers** sont libérés mais les **matériaux** sont conservés d'un rebuild à l'autre : le programme compilé est cher, les buffers ne le sont pas.

---

## 8. Couverture de tests

`src/shared/graph/nodes/vegetation.test.ts` — 68 tests : parité CPU/GLSL des uniforms, déterminisme et linéarité du champ, topologie de la géométrie d'herbe (coins 0/1/2, base partagée, brins dans le carré), reproductibilité par graine, réutilisation du cache et rebuild sélectif, comptage de branches et de feuilles, normales unitaires du transport parallèle, plafond de branches, clonage du matériau au sway et idempotence sur re-évaluation, convention `mapUv` (centre, bords, inversion de v), indépendance de l'estompage au framerate, collecte et dédoublonnage des points de peinture, dégradation sans renderer, priorité du placement estampillé sur les paramètres.

---

## 9. Démonstration

`public/demos/demo_vegetation_wind.tsuji` — un `Wind Field` unique pilotant un champ d'herbe de 220² brins et trois arbres de graines différentes, plus une sphère en orbite dont l'`Interaction Map` couche l'herbe dans son sillage.

Chaîne : `transform/orbit` → `object/sphere` → `texture/interaction-map` → socket `Trample Map` de `structure/grass-field`.

---

## 🔗 Notes Associées
- [[Node Catalog]]
- [[Universal_Nodes_Catalog_3_Chantiers]]
- [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]]
- [[Node Creation Guide]]
- [[Socket Type System and Ownership]]
- [[Parametric Geometry and Modifiers]]
