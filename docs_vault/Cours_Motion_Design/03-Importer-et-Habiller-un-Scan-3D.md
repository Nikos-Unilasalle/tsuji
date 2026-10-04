---
module: 3
duree: "1h00"
---

# Module 3 — Importer et habiller un scan 3D

← [[02-Premiers-Nodes-et-Transformations]] · Suivant → [[04-Cadrage-et-Camera]]

## Ce que tu vas apprendre

C'est le module clé si ton objectif est de présenter **ton propre objet** — un scan 3D, une pièce mécanique modélisée ailleurs, un prototype. Importer un fichier `.obj`, corriger son échelle/orientation, et lui donner un matériau qui rend justice au détail scanné.

Si tu n'as pas de fichier à toi pour l'instant, continue avec une primitive du module 2 — tout ce qui suit s'applique de la même façon.

## 3.1 — Le format `.obj`

Tsuji importe les fichiers **Wavefront `.obj`** via le nœud **OBJ Model** (`object/obj`). C'est le format d'export le plus universel : la quasi-totalité des logiciels de scan 3D, de CAO et de modélisation savent exporter en `.obj`.

Deux points de vigilance à l'export depuis ton outil de scan :

- **Exporte aussi la texture/couleur** si ton scan en a une (souvent un fichier `.mtl` + une image associée) — sinon Tsuji affichera la géométrie brute, sans couleur.
- Un scan brut peut être **très lourd** (des millions de triangles) — si le logiciel de scan propose une option de décimation/simplification à l'export, une résolution "moyenne" suffit largement pour une animation de présentation et évite les ralentissements.

## 3.2 — Importer et corriger l'échelle

1. `Cmd`/`Ctrl` + `Espace` → cherche **OBJ Model**.
2. Charge ton fichier `.obj`.
3. **Vérifie l'échelle immédiatement** : beaucoup d'exports de scan arrivent en millimètres, ce qui donne un objet minuscule ou (à l'inverse) gigantesque dans la scène. Utilise `S` pour ajuster jusqu'à ce que l'objet ait une taille cohérente avec le reste (compare-le à un Box de test à 1 unité).
4. Recentre l'objet sur l'origine avec `T` si l'import le place loin du centre — ça te simplifiera tout le cadrage caméra du module suivant.

> 🎬 `![[demo-import-obj-echelle.mp4]]`
> *Import d'un scan, correction d'échelle par comparaison avec un cube de référence, recentrage.*

## 3.3 — Le nœud Material : donner du réalisme

Le nœud **Material** (`material/standard`) contrôle l'apparence de surface. PBR = *Physically Based Rendering* : au lieu de réglages arbitraires, tu joues sur des propriétés physiques qui se comportent de façon prévisible sous n'importe quel éclairage.

Les deux réglages qui changent tout, dans l'ordre où les tester :

- **Roughness** (rugosité) : `0` = surface miroir, `1` = surface totalement mate. Un scan d'objet physique est presque toujours entre `0.4` et `0.8` — un miroir parfait a l'air faux.
- **Metalness** (métallique) : `0` pour la plupart des matériaux (plastique, pierre, tissu, peau...), proche de `1` uniquement pour un métal brut non peint.

Branche le nœud **Material** sur l'entrée matériau de ton objet, puis ajuste ces deux valeurs en observant le rendu en direct sous ta lumière du module 2.

Si ton scan a sa propre texture couleur, branche-la via **Image Texture** (`texture/image`) dans l'entrée couleur du matériau plutôt que de choisir une couleur unie.

## 3.4 — Éclairage d'ambiance : Environment & HDRI

Pour un objet destiné à être présenté (contrairement à une scène de jeu), un éclairage d'environnement fait une différence énorme pour un effort minimal. Le nœud **Environment & HDRI** (`lighting/environment`) charge une carte d'environnement HDR qui éclaire ta scène de façon homogène et réaliste, comme si l'objet était posé dans un vrai studio photo.

Combine :
- **Environment & HDRI** pour la lumière d'ambiance globale et les reflets,
- ta **Directional Light** du module 2 pour une ombre nette et une direction de lumière lisible,
- une **Ambient Light** faible ou nulle (l'HDRI la remplace déjà en grande partie).

> 🧩 ![[schema-03-import-materiau-hdri.svg]]
> *Material (roughness/metalness) branché sur l'entrée matériau d'OBJ Model. Environment & HDRI et Directional Light restent à part : ce sont des racines de scène indépendantes, elles n'ont rien à brancher sur l'objet pour l'éclairer.*

## 3.5 — Cas particulier : pas de fichier à importer

Si tu présentes un **process** plutôt qu'un objet scanné (un pipeline, une chaîne d'étapes), tu peux très bien construire ta scène avec des primitives du module 2 disposées en séquence, chacune représentant une étape, reliées par des courbes (**Curve from Points**) — c'est une approche de schématisation qui fonctionne aussi bien qu'un scan pour une présentation claire, et qu'on retrouvera en filigrane dans le projet final.

## Exercice guidé (25 min)

1. Importe ton `.obj` (ou reprends ta scène du module 2).
2. Corrige échelle et position.
3. Applique un Material, règle roughness/metalness jusqu'à un rendu convaincant.
4. Ajoute un Environment & HDRI et observe l'effet sur les reflets.
5. Compare le rendu avant/après HDRI — c'est le genre de détail qui distingue une présentation soignée d'un rendu brut.

## ✅ Mini-livrable du module

Un objet (importé ou construit) correctement éclairé, avec un matériau ajusté et un Environment & HDRI actif. C'est la scène que tu vas cadrer et animer dans les deux modules suivants.

---
← [[02-Premiers-Nodes-et-Transformations]] · Suivant → [[04-Cadrage-et-Camera]]
