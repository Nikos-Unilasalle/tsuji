---
titre: "Motion Design avec Tsuji — De zéro à ta première animation présentable"
duree_totale: "6h"
public: "Aucune expérience 3D requise"
---

# Motion Design avec Tsuji

> Créer des animations 3D pour présenter un objet, un scan, un process — sans avoir jamais touché à la 3D.

## Pourquoi ce cours

Tu vas soutenir un projet, présenter un prototype, montrer un scan 3D, expliquer un process. Une capture d'écran statique ne rend jamais justice au travail. Une **animation propre — un objet qui tourne, une caméra qui se déplace, un rendu exporté en vidéo** — change complètement l'impact d'une présentation.

Tsuji est l'outil qu'on va utiliser : un studio 3D **à nœuds** (node graph), gratuit, qui tourne dans le navigateur ou en application. Pas de ligne de code, pas de menu à onze niveaux : on branche des cases entre elles et on voit le résultat en temps réel.

Ce cours ne fait pas de toi un artiste 3D. Il te donne un chemin court et solide vers un livrable : **une vidéo de 10 à 20 secondes qui présente bien quelque chose**.

## Objectifs pédagogiques

À la fin des 6 heures, tu sais :

1. Te repérer dans l'interface de Tsuji et comprendre la logique du graphe de nœuds.
2. Importer un objet 3D (par exemple un scan au format `.obj`) et l'éclairer correctement.
3. Cadrer une caméra et créer un mouvement de caméra ou d'objet fluide.
4. Animer dans le temps avec la timeline et les images-clés (keyframes).
5. Ajouter une touche de style avec le post-traitement (bloom, vignette, grain...).
6. Exporter un rendu final en vidéo (MP4/WebM) prêt à intégrer dans une présentation.

## Comment suivre ce cours

- **En autonomie, à ton rythme.** Chaque module a une durée indicative ; tu peux t'arrêter et reprendre entre deux.
- **Fais les manipulations en même temps que tu lis.** Ce cours n'est pas fait pour être lu d'une traite — ouvre Tsuji à côté.
- **Chaque module se termine par un mini-livrable.** Ne passe pas au suivant tant que le tien ne fonctionne pas : chaque module s'appuie sur le graphe du précédent.
- Les encarts `> 🎬` contiennent une vidéo ou un GIF de démonstration à regarder avant de manipuler.
- Les encarts `> 🧩` contiennent un schéma du graphe de nœuds à reproduire.

## Sommaire

| # | Module | Durée | Lien |
|---|--------|-------|------|
| 1 | Découverte de l'interface et du graphe | 45 min | [[01-Decouverte-de-Tsuji]] |
| 2 | Premiers nœuds et transformations | 45 min | [[02-Premiers-Nodes-et-Transformations]] |
| 3 | Importer et habiller un scan 3D | 1h00 | [[03-Importer-et-Habiller-un-Scan-3D]] |
| 4 | Cadrage et mouvement de caméra | 45 min | [[04-Cadrage-et-Camera]] |
| 5 | Animer dans le temps (timeline, keyframes) | 1h00 | [[05-Animer-dans-le-Temps]] |
| 6 | Post-traitement et style visuel | 30 min | [[06-Post-Traitement-et-Style]] |
| 7 | Exporter son rendu final | 45 min | [[07-Exporter-son-Rendu]] |
| 8 | Projet final et auto-évaluation | 30 min | [[08-Projet-Final]] |

**Total : 6h00**

## Prérequis matériel

- Tsuji ouvert dans un navigateur récent (Chrome/Edge/Safari) — [version en ligne](https://nikos-unilasalle.github.io/tsuji/) — ou l'application desktop.
- Un fichier `.obj` à toi si tu veux animer ton propre scan/objet (sinon, une primitive fournie par Tsuji suffit pour suivre le cours).
- Rien d'autre. Pas de carte graphique dédiée nécessaire, pas d'installation lourde.

## Note pour la personne qui prépare les médias de ce cours

Chaque module référence des emplacements `![[...]]` pour une vidéo/GIF de démonstration et un schéma de graphe. Les schémas (`assets/schema-*.svg`) sont déjà en place : générés directement depuis de vrais graphes Tsuji via `npm run export:graph-svg` (voir [tools/export-graph-svg.ts](../../tools/export-graph-svg.ts)) ou le bouton **Export Graph (SVG)** du menu Share dans l'app (`Cmd`/`Ctrl`+`Shift`+`E`) — pas une capture d'écran ni une reconstruction externe, donc ils restent fidèles si un nœud change de nom ou de socket. Il reste seulement les vidéos/GIF de démonstration à tourner : vise des exports courts (5-15s, boucle silencieuse) pour les GIF de mouvement, et une vidéo complète avec son uniquement pour l'export final du module 7.

---
Suivant → [[01-Decouverte-de-Tsuji]]
