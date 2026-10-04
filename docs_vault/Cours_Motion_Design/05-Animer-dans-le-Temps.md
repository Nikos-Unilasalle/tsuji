---
module: 5
duree: "1h00"
---

# Module 5 — Animer dans le temps (timeline, keyframes)

← [[04-Cadrage-et-Camera]] · Suivant → [[06-Post-Traitement-et-Style]]

## Ce que tu vas apprendre

Jusqu'ici, l'Orbit du module 4 tournait tout seul, en continu. Ce module t'apprend à **contrôler précisément ce qui se passe à quel moment** : une durée fixe, une pause, une accélération — le vocabulaire de base du motion design.

## 5.1 — La timeline et les images-clés (keyframes)

Une **image-clé** (keyframe) fixe la valeur d'un paramètre à un instant donné. Entre deux images-clés, Tsuji interpole automatiquement — c'est ce qui crée le mouvement.

Le geste est le même **sur n'importe quel paramètre de n'importe quel nœud** :

1. Place le curseur de la timeline à l'instant de départ.
2. Survole le paramètre à animer (par exemple la rotation d'un objet, ou le rayon d'une Orbit).
3. Appuie sur **`K`** → une image-clé est créée avec la valeur actuelle.
4. Déplace le curseur de la timeline à un autre instant.
5. Change la valeur du paramètre, appuie de nouveau sur `K`.

Appuie sur `Espace` pour lire l'animation entre les deux images-clés.

> 🎬 `![[demo-keyframe-k.mp4]]`
> *Pose d'une image-clé sur la rotation d'un objet à t=0, changement de valeur à t=2s, nouvelle image-clé, lecture du mouvement interpolé.*

## 5.2 — Remplacer l'orbite infinie par une durée maîtrisée

L'Orbit du module 4 tourne sans fin — parfait pour explorer, mais une présentation a besoin d'une **durée précise et reproductible** (typiquement 10 à 20 secondes). Deux façons d'y arriver, de la plus simple à la plus contrôlée :

- **Animer directement l'angle de l'Orbit** avec des images-clés : une clé à l'angle de départ en `t=0`, une clé à l'angle de départ + 360° à la fin souhaitée. Une rotation complète, sans à-coup au raccord.
- **Passer par un nœud Time Remap** (`time/remap`) pour recadrer le temps et appliquer une courbe d'assouplissement — utile si tu veux que le mouvement démarre et s'arrête en douceur plutôt qu'à vitesse constante.

## 5.3 — L'easing : pourquoi la vitesse constante a l'air fausse

Dans le monde réel, rien ne démarre ni ne s'arrête à vitesse constante — tout accélère puis ralentit. Un mouvement à vitesse strictement constante (linéaire) se reconnaît immédiatement comme "un mouvement d'ordinateur" et donne une impression artificielle.

Le nœud **Time Remap** applique des courbes d'*easing* (assouplissement) à un signal temporel : la valeur progresse lentement au départ, accélère au milieu, ralentit à l'arrivée (*ease-in-out*). C'est un seul réglage qui améliore instantanément la perception de qualité d'une animation.

> 🧩 ![[schema-05-timeremap-easing.svg]]
> *Time → Time Remap → Orbit : Time Remap recadre les secondes brutes avant de les passer à l'entrée Time de l'Orbit, c'est là que se règle la courbe d'assouplissement.*

## 5.4 — Un mouvement de bonus : Spring pour un rendu vivant

Si tu veux qu'un objet paraisse "réagir" plutôt que suivre une trajectoire figée — utile pour un élément secondaire de la scène, pas pour le sujet principal — le nœud **Spring Vector** (`motion/spring_vector`) simule un ressort physique sur une position : l'objet suit sa cible avec un léger retard élastique, masse/raideur/amortissement réglables. Effet subtil, à utiliser avec parcimonie — un Spring sur ton objet principal casserait la lisibilité du cadrage travaillé au module 4.

## 5.5 — Vérifier avant d'avancer

Avant de passer au post-traitement, relis la timeline dans son ensemble et vérifie :

- L'animation a un début et une fin nets (pas de coupure abrupte ni de saut de valeur).
- La durée totale est cohérente avec un usage de présentation (10-20 secondes, rarement plus pour ce type de rendu).
- Le mouvement ne casse jamais le cadrage défini au module 4 — regarde image par image aux instants où le mouvement change de direction ou de vitesse.

## Exercice guidé (30 min)

1. Reprends ta scène du module 4 (caméra en orbite continue).
2. Remplace la rotation infinie par une animation par images-clés : 0° à `t=0`, 360° à `t=15s`.
3. Ajoute un Time Remap en ease-in-out sur l'angle.
4. Lis l'animation en entier avec `Espace`, ajuste la durée si le rythme te semble trop lent ou trop rapide.
5. (Optionnel) Ajoute un Spring Vector sur un élément secondaire de la scène pour observer l'effet.

## ✅ Mini-livrable du module

Une animation de durée fixe (10-20s), avec easing, qui boucle proprement du début à la fin sans casser le cadrage.

---
← [[04-Cadrage-et-Camera]] · Suivant → [[06-Post-Traitement-et-Style]]
