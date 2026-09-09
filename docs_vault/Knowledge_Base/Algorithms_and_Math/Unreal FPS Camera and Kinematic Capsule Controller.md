# Unreal FPS Camera and Kinematic Capsule Controller

*Emplacement : `docs_vault/Knowledge_Base/Algorithms_and_Math/`*

Ce document détaille l'architecture algorithmique du **Chantier 3** de Tsuji : le contrôleur de caméra à la première personne cinématique (*First-Person Shooter*) inspiré des standards d'Unreal Engine et de l'exemple Three.js `games_fps`.

---

## 1. Philosophie et Exigences d'un Contrôleur FPS Moderne

Un contrôleur FPS d'aspect "Unreal-like" se distingue d'un simple `PointerLockControls` par :
1. **Une capsule de collision cinématique** : Déplacement physique avec masse, friction et gravité, plutôt qu'une téléportation de coordonnées.
2. **Le franchissement d'obstacles et marches (*Step-Up Algorithm*)** : Capacité à gravir les escaliers et trottoirs sans accroc ni blocage.
3. **Le glissement le long des parois (*Slide along Walls*)** : Décomposition du vecteur vitesse sur le plan tangent lors des impacts obliques.
4. **L'oscillation naturelle de marche (*Head Bobbing*)** : Balancement harmonique sinusoïdal de la tête synchronisé avec la vitesse au sol.
5. **Le découplage Yaw / Pitch** : Rotation horizontale appliquée au corps (orientation spatiale) et rotation verticale appliquée à la tête (visée angulaire restreinte à $\pm 85^\circ$).

---

## 2. Détection de Collision : Capsule vs Maillage BVH

Pour garantir 60 FPS sur des scènes complexes, le contrôleur utilise une **capsule géométrique** testée contre l'arbre BVH (`three-mesh-bvh`) du décor :
- Une capsule est définie par un segment vertical $[A, B]$ et un rayon $R$.
- La distance minimale entre le segment de capsule et chaque triangle du maillage est résolue analytiquement.
- En cas de pénétration ($d < R$), un vecteur de répulsion $\mathbf{n} \cdot (R - d)$ est appliqué immédiatement à la position de la capsule.

### Algorithme de Franchissement de Marches (Step-Up)
Lorsqu'un mouvement horizontal rencontre un mur vertical inférieur à la hauteur maximale franchissable $h_{\text{step}}$ (ex. 0.35m) :
1. La capsule est projetée verticalement de $+h_{\text{step}}$.
2. Le déplacement horizontal vers l'avant est testé à cette nouvelle hauteur.
3. Si le déplacement réussit sans collision, la capsule redescend au contact du sol de la marche.
4. Dans le cas contraire (mur trop haut), le déplacement est annulé et la vitesse est projetée le long du mur.

---

## 3. Dynamique de la Caméra et Head Bobbing

La position finale de la caméra combine la position du sommet de la capsule avec deux termes oscillatoires :
$$x_{\text{bob}} = A_x \cdot \cos(\omega_{\text{walk}} \cdot t) \cdot v_{\text{norm}}$$
$$y_{\text{bob}} = A_y \cdot \sin(2 \omega_{\text{walk}} \cdot t) \cdot v_{\text{norm}}$$

où $v_{\text{norm}} = \min(1, \|\mathbf{v}_{\text{xz}}\| / v_{\text{max}})$ module l'amplitude en fonction de la vitesse effective au sol.

---

## 4. Spécification des Nœuds Tsuji pour le Chantier 3

- **`camera/fps-controller`** : Contrôleur universel première personne avec entrées clavier/souris/manette, gravité, saut et paramétrage de capsule.
- **`physics/capsule-collider`** : Nœud de collision géométrique pour décors statiques ou dynamiques.

---

## 🔗 Notes Associées
- [[ThreeJS r185 Release and Migration Deep Dive]]
- [[Spatial Indexing and BVH Acceleration]]
- [[Universal_Nodes_Catalog_3_Chantiers]]
- [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]]
