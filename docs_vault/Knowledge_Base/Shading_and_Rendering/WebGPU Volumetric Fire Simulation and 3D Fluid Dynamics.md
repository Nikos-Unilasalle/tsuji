# WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics

*Emplacement : `docs_vault/Knowledge_Base/Shading_and_Rendering/`*

Ce document détaille l'implémentation mathématique et logicielle du **solveur fluide eulérien 3D** et du **moteur de rendu volumétrique par raymarching** avec rayonnement de corps noir, inspiré de l'exemple Three.js r185 `webgpu_volume_fire`.

---

## 1. Modélisation Mathématique : Équations de Navier-Stokes Incompressibles

La dynamique des fluides dans une grille 3D voxel de dimensions $N_x 	imes N_y 	imes N_z$ est régie par :

$$\frac{\partial \mathbf{u}}{\partial t} + (\mathbf{u} \cdot \nabla)\mathbf{u} = -\frac{1}{\rho}\nabla p + \nu \nabla^2 \mathbf{u} + \mathbf{f}$$

$$\nabla \cdot \mathbf{u} = 0 \quad \text{(Incompressibilité)}$$

où :
- $\mathbf{u} = (u, v, w)$ est le champ vectoriel des vitesses dans l'espace 3D.
- $p$ est le champ scalaire de pression.
- $\rho$ est la densité volumique du fluide.
- $\nu$ est la viscosité cinématique.
- $\mathbf{f}$ représente la somme des forces externes (flottabilité thermique, vent, turbulences de curl).

---

## 2. Décomposition Fractionnaire de l'Étape de Simulation

Chaque frame d'évaluation temporelle $\Delta t$ procède en 5 phases successives :

1. **Advection Semi-Lagrangienne** :
   Pour chaque voxel de coordonnées $\mathbf{x}$, on remonte la trajectoire du fluide dans le temps :
   $$\mathbf{x}_{\text{prev}} = \mathbf{x} - \mathbf{u}(\mathbf{x}, t) \cdot \Delta t$$
   La nouvelle valeur est obtenue par interpolation trilinéaire aux coordonnées $\mathbf{x}_{\text{prev}}$.

2. **Injection des Forces et Émetteurs** :
   - **Flottabilité thermique** (*Buoyancy*) : $\mathbf{f}_{\text{buoyancy}} = (0, \beta \cdot (T - T_0), 0)^T$ où $T$ est la température.
   - **Vent global** : addition directe du vecteur $\mathbf{w}$.
   - **Émetteur maillé** : échantillonnage des sommets d'un `THREE.BufferGeometry` avec injection de densité, température et vitesse inertielle (`motionBoost`).

3. **Micro-turbulences sans divergence (Curl Noise 3D)** :
   Un champ de potentiel vectoriel $\mathbf{\Psi} = (\psi_x, \psi_y, \psi_z)$ est échantillonné à partir d'un bruit Perlin/Simplex 3D. Le champ de vitesse turbulent sans divergence est calculé via le rotationnel :
   $$\mathbf{u}_{\text{turb}} = \nabla \times \mathbf{\Psi} = \left( \frac{\partial \psi_z}{\partial y} - \frac{\partial \psi_y}{\partial z}, \; \frac{\partial \psi_x}{\partial z} - \frac{\partial \psi_z}{\partial x}, \; \frac{\partial \psi_y}{\partial x} - \frac{\partial \psi_x}{\partial y} \right)$$
   Par identité vectorielle, $\nabla \cdot (\nabla \times \mathbf{\Psi}) \equiv 0$, ce qui garantit qu'aucune divergence artificielle n'est introduite.

4. **Résolution de Pression (Poisson Solver via Jacobi)** :
   Calcul de la divergence discrète :
   $$\nabla \cdot \mathbf{u}^* = \frac{u^*_{i+1, j, k} - u^*_{i-1, j, k}}{2 \Delta x} + \frac{v^*_{i, j+1, k} - v^*_{i, j-1, k}}{2 \Delta y} + \frac{w^*_{i, j, k+1} - w^*_{i, j, k-1}}{2 \Delta z}$$
   Résolution de $\nabla^2 p = \nabla \cdot \mathbf{u}^*$ par $k$ itérations de relaxation de Jacobi :
   $$p^{(n+1)}_{i,j,k} = \frac{1}{6} \left( p^{(n)}_{i+1} + p^{(n)}_{i-1} + p^{(n)}_{j+1} + p^{(n)}_{j-1} + p^{(n)}_{k+1} + p^{(n)}_{k-1} - \Delta x^2 (\nabla \cdot \mathbf{u}^*) \right)$$

5. **Projection Divergence-Free** :
   Soustraction du gradient de pression :
   $$\mathbf{u} = \mathbf{u}^* - \nabla p$$

---

## 3. Rendu Volumétrique par Raymarching

Le volume est rendu sur un cube englobant avec un shader personnalisé :
- **Intersection Rayon-Boîte (AABB)** : Détermination des points d'entrée $t_{\text{near}}$ et de sortie $t_{\text{far}}$.
- **Raymarching avec Jittering** : Pas réguliers $dt = (t_{\text{far}} - t_{\text{near}}) / N_{\text{steps}}$ avec offset aléatoire par pixel pour briser les artefacts de banding.
- **Rayonnement de corps noir (Blackbody)** : La température $T$ pilote la couleur d'émission thermique via une rampe spectrale :
  $$\text{Braise sombre} \to \text{Rouge} \to \text{Orange vif} \to \text{Jaune incandescent} \to \text{Blanc}$$
- **Atténuation de Beer-Lambert** : La transmittance $T_r$ décroît exponentiellement selon la densité accumulée :
  $$T_r(s) = \exp\left(-\sigma_a \int_0^s \rho(x)\,dx\right)$$

---

## 🔗 Notes Associées
- [[ThreeJS r185 Release and Migration Deep Dive]]
- [[GPGPU Simulation and Particle Dynamics]]
- [[Universal_Nodes_Catalog_3_Chantiers]]
- [[Node Catalog]]
