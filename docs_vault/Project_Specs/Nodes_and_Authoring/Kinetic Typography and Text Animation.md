# Typographie Cinétique & Animation de Texte Avancée (Kinetic 3D Typography)

*Emplacement dans le code :*
- Modèles et Mathématiques : `src/shared/three/typography/rangeSelector.ts`, `src/shared/three/typography/textLayout.ts`
- Définition des Nœuds : `src/shared/graph/nodes/kineticText.ts`
- Enregistrement & Export : `src/shared/graph/nodes/index.ts`
- Tests Unitaires : `src/shared/graph/nodes/kineticText.test.ts`
- Démo Interactive : `public/demos/demo_text_animator.tsuji`

---

## 1. Vision et Philosophie

Dans After Effects, le **Text Animator** (avec son *Range Selector* et *Wiggly Selector*) est l'un des outils les plus puissants pour le motion design. Cependant, dans les logiciels traditionnels de compositing 2D, l'animation typographique souffre de limitations fondamentales :
1. **Nature plane ou faux 3D (2.5D)** : Les glyphes ne sont pas de véritables solides extrudés interagissant avec l'éclairage physique, les ombres portées et les réflexions PBR.
2. **Chemins de trajectoire limités** : La projection sur chemin reste généralement contrainte à des courbes de Bézier 2D sans torsion tridimensionnelle (*Frenet framing*).
3. **Absence de modularité nodale** : Impossible d'extraire la matrice 3D de chaque glyphe individuel pour y greffer des émetteurs de particules, des champs de force physique, ou des colliders Rapier.

Le set d'outils **Kinetic Typography** de Tsuji résout ces limites en transposant la flexibilité du Range Selector dans un paradigme **3D natif, temps réel (60/144 FPS) et intégralement modulaire**.

---

## 2. Les 4 Nœuds du Toolkit

Le toolkit introduit **4 nouveaux nœuds** spécialisés :

| Nœud | Type | Catégorie | Rôle Principal |
| :--- | :--- | :--- | :--- |
| **Text Animator** | `text/animator` | `text` | Nœud autonome all-in-one : composition typographique multi-ligne 3D, sélecteur de plage (Range Selector), deltas de transformation, jitter wiggly et déformation le long d'une spline 3D. |
| **Text Decompose** | `text/decompose` | `text` | Découpeur modulaire : segmente un texte en caractères, mots, lignes, positions d'ancrage et matrices d'origine 3D. |
| **Text Range Selector** | `text/range-selector` | `text` | Modulateur universel : calcule un tableau de poids $[0, 1]$ pour $N$ éléments avec formes d'atténuation, offset, easing et randomisation déterministe. |
| **Curve Text on Path** | `curve/text-on-path` | `curve` | Conforme directement un texte extrudé le long d'une courbe 3D (`THREE.Curve`) avec orientation par tangentes et repère de Frenet. |

---

## 3. Architecture & Moteur Mathématique

### 3.1. Range Selector Engine (`rangeSelector.ts`)

Le sélecteur de plage convertit un intervalle normalisé $[s, e] = [\text{start} + \text{offset}, \text{end} + \text{offset}]$ en un poids d'influence $w_i \in [0, 1]$ pour chaque glyphe $i \in \{0, \dots, N-1\}$.

#### Profils d'Atténuation (`selectorShape`)
- **Smooth** : Interpolation cubique Hermite $3u^2 - 2u^3$ (transition douce sans rupture d'accélération).
- **Linear / Ramp Up** : Rampe ascendante droite $u = \text{clamp}\left(\frac{t - s}{e - s}, 0, 1\right)$.
- **Ramp Down** : Rampe descendante $1 - u$.
- **Triangle** : Pic symétrique en chapeau au centre de l'intervalle.
- **Round** : Demi-ellipse douce $\sqrt{1 - (2u - 1)^2}$.
- **Square** : Échelon binaire net ($u \ge 0.5$).

#### Easing Asymétrique (`easeHigh` & `easeLow`)
Modulation non linéaire des poids sans altérer les bornes :
- `easeLow` comprime ou dilate la dynamique des valeurs faibles ($w < 0.5$).
- `easeHigh` contrôle la courbure d'arrivée des valeurs fortes ($w \ge 0.5$).

#### Randomisation Déterministe (`randomize`, `randomSeed`)
Mélange de Fisher-Yates basé sur un générateur congruentiel linéaire (LCG) garantissant une reproductibilité exacte à la frame près sans bruit aléatoire non contrôlé.

#### Wiggle Harmonique Intégré (`wiggleAmount`, `wiggleSpeed`)
Superposition d'ondes sinusoïdales à phases différenciées par élément :
$$\Delta w_i = A \cdot \sin\left(t \cdot \text{speed} \cdot 2\pi + i \cdot 1.618\right)$$

---

### 3.2. Typesetting & Layout 3D (`textLayout.ts`)

Le moteur de composition typographique gère :
- **Multi-lignes automatiques** : Découpage par retours chariots (`\n`) avec calcul dynamique du saut de ligne (`lineHeight`).
- **Approche / Tracking** : Espacement additionnel entre caractères en unités relatives.
- **Alignement Horizontal** : `left`, `center`, `right` (centrage indépendant par ligne).
- **Points de Pivot / Ancrage (`anchor`)** :
  - `glyph_center` : Pivot au centre exact de la boîte englobante 3D de chaque lettre (idéal pour rotations individuelles en vrille).
  - `baseline_center` : Pivot sur la ligne de base typographique.
  - `bottom_center` : Pivot à la base inférieure (idéal pour effets de pop vertical).
  - `top_center` : Pivot en haut de glyphe (idéal pour pendule suspendu).
- **Projection sur Spline 3D (`curve`)** :
  - Calcul du point de passage $\mathbf{P}(t) = \text{Curve.getPointAt}(t)$.
  - Calcul du vecteur tangent unitaire $\mathbf{T}(t) = \text{Curve.getTangentAt}(t)$.
  - Calcul de la normale et construction du quaternion d'orientation $\mathbf{Q}$ sans torsion parasite.

---

## 4. Performance & Gestion Mémoire Zéro-Allocation

1. **Recyclage de Géométrie & Cache de Nœud** :
   - Les géométries extrudées (`ExtrudeGeometry`) ne sont reconstruites que lorsque la chaîne de texte, la police, la taille, l'extrusion ou le tracking changent.
   - En phase de lecture continue à 60 ou 144 FPS, **seules les matrices locales des enfants du groupe (`mesh.matrix`) sont recalculées et injectées**.
   - Temps d'évaluation moyen en cache-hit : **$< 0.15$ ms par frame**.
2. **Cycle de Vie GPU Impeccable** :
   - Enregistrement dans le système de cache de nœud Tsuji (`createNodeCache`).
   - Nettoyage rigoureux lors de la suppression ou réinitialisation du nœud via `geom.dispose()` et `disposeObject3D()`.

---

## 5. Exemples d'Utilisation

### Exemple A : Effet d'Onde Cinétique Pop-In (Démo Officielle)
1. Créer un nœud **`text/animator`**.
2. Paramétrer :
   - `text` : `"KINETIC TYPE"`
   - `start` : `0`, `end` : `0.45`
   - `positionDelta` : `[0, 1.4, 0]`
   - `rotationDelta` : `[35, 0, 0]`
   - `scaleDelta` : `[0.2, 0.2, 0.2]`
3. Ajouter un nœud **`animation/oscillator`** (mode `sine`, fréquence `0.35 Hz`, amplitude `1.2`).
4. Câbler `oscillator.out` $\rightarrow$ `text/animator.progress`.
5. Résultat : Les lettres flottent et plongent en vague rythmée continue avec une souplesse cinématographique.

### Exemple B : Texte sur Trajectoire Orbitaire 3D
1. Créer un nœud **`curve/circle`** ou **`curve/spiral`**.
2. Câbler la sortie `curve` dans l'entrée `curve` du nœud **`text/animator`** ou **`curve/text-on-path`**.
3. Cocher `alignToPath` et animer `pathOffset` pour faire glisser le texte sur la trajectoire tridimensionnelle.
