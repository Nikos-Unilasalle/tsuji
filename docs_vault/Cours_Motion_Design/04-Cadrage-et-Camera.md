---
module: 4
duree: "45 min"
---

# Module 4 — Cadrage et mouvement de caméra

← [[03-Importer-et-Habiller-un-Scan-3D]] · Suivant → [[05-Animer-dans-le-Temps]]

## Ce que tu vas apprendre

Une belle scène mal cadrée passe inaperçue. Ce module couvre le nœud **Camera**, les règles de cadrage de base, et le mouvement de caméra le plus utile pour présenter un objet : **l'orbite**.

## 4.1 — Le nœud Camera

Le nœud **Camera** (`calibration/camera`) a deux modes :

- **Manuel** : tu positionnes et orientes la caméra comme n'importe quel objet — c'est celui qu'on utilise ici.
- **Calibré** : un solveur DLT pour aligner une caméra virtuelle sur une caméra physique (vidéo-mapping) — hors sujet pour ce cours, tu peux l'ignorer.

En mode Manuel, une Camera se comporte comme un objet normal : position (`T`), rotation (`R`), plus des réglages propres (champ de vision / focale).

## 4.2 — Cadrer : trois règles simples

Pas besoin de connaître la photographie pour cadrer correctement un objet de présentation :

1. **Ne centre pas l'objet au pixel près.** Un léger décalage (règle des tiers) donne un cadrage plus naturel qu'un centrage parfait, qui a tendance à paraître statique.
2. **Laisse de l'air autour de l'objet.** Un objet qui touche les bords du cadre donne une impression d'étouffement, même à l'écran.
3. **Baisse légèrement la caméra en dessous de la hauteur de l'objet**, puis pointe-la vers le haut — un angle en légère contre-plongée valorise presque toujours un objet, alors qu'une vue strictement de face l'aplatit.

Utilise l'**Empty** placé au centre de ta scène (module 2) comme cible : oriente la caméra vers lui plutôt qu'à l'œil, tu garderas ce cadrage stable même après avoir bougé la caméra.

> 🎬 `![[demo-cadrage-regles.mp4]]`
> *Trois cadrages du même objet : centré/collé au bord (à éviter), cadrage aéré et décalé (correct), légère contre-plongée (valorisant).*

## 4.3 — Le mouvement qui fonctionne à tous les coups : l'orbite

Pour présenter un objet (scan, prototype, pièce), le mouvement de caméra le plus lisible et le plus systématiquement efficace est l'**orbite** : la caméra tourne autour de l'objet à distance et hauteur constantes, sans jamais couper le regard.

Le nœud **Orbit** (`transform/orbit`) génère ce mouvement circulaire ou elliptique autour d'un pivot :

1. Branche le pivot de l'Orbit sur ton **Empty** central.
2. Branche la sortie position de l'Orbit sur la position de ta **Camera**.
3. Règle le rayon de l'orbite pour retrouver le cadrage défini en 4.2.
4. Oriente en permanence la caméra vers l'Empty (via une contrainte de visée si le nœud le permet, sinon en gardant la rotation calculée manuellement au rayon choisi).

> 🧩 ![[schema-04-camera-orbit.svg]]
> *Empty → Orbit (via Target) → Camera : la Position de l'Orbit alimente la Location de la Camera, et l'Empty sert aussi directement de Target à la Camera pour qu'elle le vise en permanence.*

**Pourquoi l'orbite et pas un travelling complexe :** un mouvement d'orbite ne présente jamais de risque de cadrage cassé — la distance et l'angle par rapport au sujet restent constants du début à la fin. C'est le choix par défaut fiable ; les mouvements plus ambitieux (travelling, `Fly To` entre deux caméras) sont amusants à explorer une fois celui-ci maîtrisé, mais pas nécessaires pour un rendu propre.

## 4.4 — Pour aller plus loin (optionnel) : transition entre deux caméras

Si tu veux présenter un objet sous deux angles distincts avec une transition élégante plutôt qu'une coupe sèche, le nœud **Fly To** (`camera/fly_to`) crée une transition cinématique avec un arc parabolique entre deux caméras. À réserver pour une deuxième itération de ton projet — pas nécessaire pour un premier rendu réussi.

## Exercice guidé (20 min)

1. Ajoute une Camera à ta scène du module 3.
2. Applique les trois règles de cadrage du 4.2 en mode statique d'abord (sans mouvement).
3. Ajoute le nœud Orbit, branche-le comme décrit en 4.3.
4. Appuie sur `Espace` pour lancer la lecture et observe l'orbite en temps réel dans la vue 3D.
5. Ajuste le rayon et la hauteur de l'orbite jusqu'à ce qu'aucun angle de la rotation ne casse le cadrage.

## ✅ Mini-livrable du module

Une caméra en orbite autour de ton objet, à un cadrage constant et satisfaisant sur les 360° de la rotation.

---
← [[03-Importer-et-Habiller-un-Scan-3D]] · Suivant → [[05-Animer-dans-le-Temps]]
