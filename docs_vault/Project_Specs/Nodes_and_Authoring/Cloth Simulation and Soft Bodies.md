# Cloth Simulation & Soft Body Dynamics

*Emplacement dans le code : `src/shared/graph/nodes/cloth.ts`, `src/shared/three/physics/clothSolver.ts`*

Ce document détaille l'implémentation du solveur de simulation de tissu physique (`physics/cloth`), les contraintes de sommets, les collisions et le couplage avec les champs de force environnementaux dans Tsuji.

---

## 1. Pourquoi un Solveur Dédié sur CPU ?

L'intégration d'une simulation de tissu posait un dilemme d'architecture :
1. **Solveur GPGPU (compute / textures de positions)** : Conserve les positions dans une texture flottante. Cela requiert soit un *readback* GPU $\rightarrow$ CPU à chaque frame (ce qui ruine le framerate), soit un vertex shader personnalisé qui échantillonne la texture. Or cette approche brise le **contrat d'apparence** de Tsuji, selon lequel n'importe quel matériau amont (PBR, Hologram, Liquid Metal, Cel-Shade, etc.) doit pouvoir habiller la géométrie déformée sans être réécrit.
2. **Bibliothèques WebGPU/TSL externes (ex. `three-simplecloth`)** : Conçues pour du calcul compute sur maillages skinnés, incompatibles avec le runtime WebGL standard de Tsuji sans squelette.

**Le Choix Tsuji** : Un solveur physique **masse-ressort-amortisseur sur CPU** haute performance (`clothSolver.ts`), calculant le déplacement de grille particulaire à chaque pas de temps et injectant les positions directement dans un `THREE.BufferAttribute` dynamique.

---

## 2. Architecture du Solveur (`clothSolver.ts`)

Le solveur opère sur un ensemble de particules discrètes reliées par des ressorts structurels et de cisaillement :

```
       (p0) ───[ressort]─── (p1)
        │ ╲               ╱  │
        │   ╲           ╱    │
     [ressort] [ressort]  [ressort]
        │   ╱           ╲    │
        │ ╱               ╲  │
       (p2) ───[ressort]─── (p3)
```

- **Intégration Temporelle** : Intégration de Verlet ou semi-implicite avec sous-pas (`substeps` ou itérations de relaxation de contraintes `iterations`).
- **Forces Appliquées à Chaque Particule** :
  $$\mathbf{F}_{\text{total}} = m \mathbf{g} - c_{\text{air}} \mathbf{v} + \sum \mathbf{F}_{\text{ressorts}} + \mathbf{F}_{\text{ext}}$$
  où $\mathbf{F}_{\text{ext}}$ intègre les champs de force externes connectés au graphe.
- **Résistance de l'Air & Amortissement** : `airResistance` et `damping` évitent l'emballement des vibrations élastiques.

---

## 3. Épinglage & Fixation de Points (`pins`)

Pour créer des bannières, drapeaux, voiles ou rideaux suspendus :
- Le paramètre `pins` permet de déclarer les sommets fixes (masse infinie $\rightarrow$ déplacement nul).
- Méthodes de sélection :
  - Par coordonnées (ex. bord supérieur : $Y \ge Y_{\max} - \epsilon$).
  - Par liste explicite d'indices de sommets.
  - Par connecteur filaire amont (sélection de points).
- Les points épinglés conservent rigidement leur position tout en transmettant les tensions élastiques au reste de la toile.

---

## 4. Couplage avec les Champs de Force (`particles/force-field`)

Le solveur de tissu écoute activement les champs de force connectés à son port d'entrée `forceFields` :
- **Vent (`physics/wind-field`)** : Pousse la voile dans la direction des rafales.
- **Turbulence & Curl Noise (`particles/curl-noise`, `particles/force-field`)** : Génère des flottements, plis et ondulations chaotiques hautement réalistes.
- Chaque champ de force présent est évalué pour chaque particule à sa position tridimensionnelle courante et ajouté au vecteur d'accélération.

---

## 5. Shading & Continuité des Normales sur Coutures UV

Un maillage 3D importé ou une géométrie Three.js possède souvent des sommets dupliqués au niveau des raccords de textures (UV seams) :
- `three.computeVertexNormals()` calcule les normales en se basant sur le buffer d'index. Aux coutures UV, les sommets n'étant pas partagés dans le buffer d'index, un calcul standard produisait une arête sombre / pli marqué le long de la couture.
- **Lissage par Particule** : En mode `smooth`, Tsuji moyenne les normales de surface par **particule physique sous-jacente** et non par index de sommet Three.js, éliminant totalement les discontinuités de lumière sur les coutures.
- **Mode Facetté (`flat`)** : Génère une géométrie non-indexée une seule fois à l'initialisation pour les esthétiques low-poly sans réallocation par frame.

---

## 6. Réinitialisation & Cohérence Temporelle

- Le solveur conserve ses vitesses et positions dans un cache persistant par nœud (`nodeId`).
- Lors d'un saut de tête de lecture arrière ou d'un `Shift+Space` (**Simulation Reset**, voir [[Simulation Reset and Epoch Architecture]]), le tissu se réinitialise instantanément à sa forme d'origine non déformée, garantissant des rendus d'export rigoureusement reproductibles.

---

## 🔗 Notes Associées
- [[Node Catalog]]
- [[Parametric Geometry and Modifiers]]
- [[Simulation Reset and Epoch Architecture]]
- [[Creative FX and Stage Nodes]]
- [[Vegetation_and_Wind_Nodes_Catalog]]
