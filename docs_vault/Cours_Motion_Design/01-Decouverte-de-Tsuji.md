---
module: 1
duree: "45 min"
---

# Module 1 — Découverte de l'interface et du graphe

← [[00-Index]] · Suivant → [[02-Premiers-Nodes-et-Transformations]]

## Ce que tu vas apprendre

Comprendre comment Tsuji "pense" avant de toucher à quoi que ce soit. Un logiciel 3D classique (Blender, Cinema 4D...) te fait cliquer dans des menus et des panneaux empilés. Tsuji fonctionne différemment : **tout est un nœud, et tout se branche.**

## 1.1 — Le principe du node graph

Un **nœud** (node) est une case qui fait une chose précise : créer une sphère, appliquer une couleur, déplacer un objet dans le temps... Chaque nœud a :

- des **entrées** à gauche (ce dont il a besoin pour fonctionner),
- des **sorties** à droite (ce qu'il produit),
- parfois des **paramètres** réglables directement dans la case (un curseur, un nombre, une couleur).

Tu construis une scène en **branchant des nœuds entre eux** : la sortie d'un nœud alimente l'entrée d'un autre. L'ensemble forme un **graphe** qui se recalcule en temps réel, 60 fois par seconde — dès que tu changes un réglage, tout ce qui est branché derrière se met à jour instantanément.

> 🎬 `![[demo-node-graph-principe.mp4]]`
> *Une sphère dont on change la couleur en direct : le changement se propage dans tout le graphe sans rien recalculer manuellement.*

**Pourquoi c'est puissant pour toi :** tu n'as pas besoin de tout comprendre du 3D pour obtenir un résultat. Tu apprends une dizaine de nœuds, tu les combines, et la complexité (les maths, la géométrie, le rendu GPU) reste cachée dans chaque case.

## 1.2 — Les types de branchements (sockets)

Toutes les entrées/sorties ne se ressemblent pas — chacune a une couleur qui indique le type de donnée qui y circule. Tu ne peux brancher que des types compatibles entre eux, ce qui t'évite la plupart des erreurs :

| Type | Ce que ça transporte |
|---|---|
| **Valeur** (`value`) | Un nombre, un booléen |
| **Vecteur** (`vector`) | Une position ou une direction (X, Y, Z) |
| **Couleur** (`color`) | Une couleur RGB/RGBA |
| **Géométrie** (`geometry`) | Un objet 3D complet |
| **Texture** (`texture`) | Une image appliquée en surface |
| **Matrice** (`matrix`) | Une transformation complète (position + rotation + échelle) |

Retiens surtout **Géométrie** (le fil principal qui porte ton objet 3D d'un bout à l'autre du graphe) et **Vecteur** (toute position ou mouvement).

## 1.3 — Repères de l'interface

Ouvre Tsuji et repère ces quatre zones :

1. **Le graphe de nœuds** (généralement au centre ou en bas) — ton espace de travail principal, où tu poses et branches les nœuds.
2. **La vue 3D (viewport)** — ce que "voit" la scène, en temps réel.
3. **Le panneau de paramètres** — apparaît quand tu sélectionnes un nœud, pour régler ses valeurs finement.
4. **La timeline** — en bas, pour la lecture et l'animation (on y revient au module 5).

> 🧩 ![[schema-01-premier-node.svg]]
> *Un nœud Sphere isolé : un en-tête (son nom), un corps, des entrées à gauche, des sorties à droite. C'est la brique de base — tout le reste du cours consiste à en poser plusieurs et à les relier.*

## 1.4 — Raccourcis à connaître dès maintenant

Tu n'as pas besoin de tout mémoriser, mais ces raccourcis reviennent à chaque session :

| Raccourci | Action |
|---|---|
| `Espace` | Lancer / mettre en pause la lecture |
| `Cmd`/`Ctrl` + `Espace` | Recherche rapide de nœuds au curseur — **le plus utile pour aller vite** |
| `T` / `R` / `S` | Déplacer / Tourner / Redimensionner (gizmos) dans la vue 3D |
| `Cmd`/`Ctrl` + `C` / `V` | Copier / coller des nœuds |
| `Cmd`/`Ctrl` + `Z` | Annuler |
| `Échap` | Stopper la lecture (sortie de secours si une scène capte le clavier) |

Le raccourci le plus important à automatiser tout de suite : **`Cmd`/`Ctrl` + `Espace`** pour faire apparaître un nouveau nœud sans fouiller dans un menu.

## Exercice guidé (10 min)

1. Ouvre Tsuji, crée un nouveau projet vide.
2. Avec `Cmd`/`Ctrl` + `Espace`, cherche et pose un nœud **Sphere**.
3. Regarde-la apparaître dans la vue 3D.
4. Clique sur le nœud, ouvre son panneau de paramètres, change son rayon et sa couleur. Observe la mise à jour en direct.
5. Supprime la sphère, refais l'exercice avec un **Box** puis un **Cylinder**.

## ✅ Mini-livrable du module

Une scène avec une primitive 3D de ton choix, dont tu as modifié au moins deux paramètres (taille et couleur). Pas besoin de sauvegarder — l'objectif est le geste, pas le fichier.

---
← [[00-Index]] · Suivant → [[02-Premiers-Nodes-et-Transformations]]
