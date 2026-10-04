---
module: 2
duree: "45 min"
---

# Module 2 — Premiers nœuds et transformations

← [[01-Decouverte-de-Tsuji]] · Suivant → [[03-Importer-et-Habiller-un-Scan-3D]]

## Ce que tu vas apprendre

Construire une petite scène à plusieurs objets, comprendre comment positionner les choses dans l'espace, et découvrir le nœud **Empty** — le "point de repère invisible" que tu vas utiliser dans presque tous tes projets.

## 2.1 — Les primitives disponibles

Tsuji fournit un jeu de formes de base, toutes paramétriques (tu régles leurs dimensions après coup, sans jamais "casser" la forme) :

| Node | Ce que c'est |
|---|---|
| **Box** | Pavé — largeur / hauteur / profondeur |
| **Sphere** | Sphère — rayon, résolution |
| **Cylinder** | Cylindre — rayons haut/bas, segments |
| **Cone** | Cône |
| **Plane** | Plan — un sol, un mur, un écran |
| **Disc** | Disque |
| **Text 3D** | Texte en volume, extrudé — utile pour un titre à l'écran |
| **Empty** | Repère invisible, sans géométrie — un pivot, une cible |

## 2.2 — Empty : le nœud le plus utile que tu ne verras jamais

Un **Empty** n'apparaît pas dans le rendu final — c'est un point dans l'espace, invisible, qui sert de **référence**. Deux usages qu'on utilisera tout de suite :

- **Pivot de rotation** : au lieu de faire tourner un objet sur lui-même, tu le fais tourner autour d'un Empty placé ailleurs — ça donne une orbite plutôt qu'une rotation sur place.
- **Cible de caméra** : une caméra qui "regarde" un Empty reste cadrée sur un point précis même quand elle bouge (module 4).

## 2.3 — Position, rotation, échelle : les trois gizmos

Sélectionne un objet dans la vue 3D et utilise :

- `T` → déplacer (Translate)
- `R` → tourner (Rotate)
- `S` → mettre à l'échelle (Scale)

Appuie sur `X`, `Y` ou `Z` pendant la manipulation pour verrouiller le mouvement sur un seul axe — indispensable dès que la scène a plus d'un objet, sinon on décale tout par erreur sur les deux autres axes en visant mal à la souris.

> 🎬 `![[demo-gizmos-transform.mp4]]`
> *Déplacement, rotation et mise à l'échelle d'une box avec verrouillage d'axe.*

## 2.4 — Assembler une petite scène

L'exercice de ce module : construire une scène à trois objets qui donne déjà un peu de profondeur.

1. Un **Plane** à l'échelle agrandie, pour servir de sol.
2. Un **Box** posé dessus.
3. Une **Sphere** posée à côté, à une autre hauteur.
4. Un **Empty** placé au centre du groupe (au niveau des yeux, à peu près).

> 🧩 ![[schema-02-scene-trois-objets.svg]]
> *Le graphe correspondant, avec les deux lumières du 2.5 déjà posées : six nœuds, aucun lien entre eux — c'est normal, chacun est sa propre racine de scène et ils partagent juste le même espace 3D.*

## 2.5 — Lumière minimale pour voir quelque chose de propre

Sans lumière, une scène 3D rend plat et sans relief. Ajoute :

- Un **Directional Light** (lumière type soleil, avec ombres portées) — incline-le pour que les ombres ne tombent pas à la verticale.
- Un **Ambient Light** à faible intensité, pour que les zones d'ombre ne soient jamais totalement noires.

C'est la combinaison la plus simple qui donne un rendu lisible en toutes circonstances : une lumière principale qui sculpte les formes, une lumière d'ambiance qui rattrape le reste.

## Exercice guidé (15 min)

1. Construis la scène du 2.4 (sol + box + sphère + empty).
2. Ajoute la paire de lumières du 2.5.
3. Décale légèrement chaque objet en `T`, verrouille sur un axe à chaque fois, jusqu'à obtenir une composition qui te plaît à l'œil dans la vue 3D.
4. Change la couleur des deux objets pour qu'ils contrastent avec le sol.

## ✅ Mini-livrable du module

Une scène à trois objets + un Empty + deux lumières, avec une composition volontaire (pas juste posée au hasard). Tu réutiliseras cette scène — ou son principe — dans les modules suivants.

---
← [[01-Decouverte-de-Tsuji]] · Suivant → [[03-Importer-et-Habiller-un-Scan-3D]]
