# WebGPU Volumetric Lighting and TRAA Integration

*Emplacement : `docs_vault/Knowledge_Base/Shading_and_Rendering/`*

Ce document détaille l'architecture du **Chantier 2** de Tsuji : l'éclairage volumétrique dans les milieux participants (*Volumetric Lighting / God Rays*) et l'antialiasing temporel avec reprojection (*Temporal Reprojection Anti-Aliasing - TRAA*), inspiré de l'exemple Three.js r185 `webgpu_volume_lighting_traa`.

---

## 1. Principes Physiques des Milieux Participants

Dans une atmosphère chargée de particules (brouillard, poussière, fumée), la lumière incidente subit :
1. **L'Absorption** : Perte d'énergie lumineuse convertie en chaleur.
2. **La Diffusion Hors-Axe (*Out-Scattering*)** : Déviation de photons hors de la ligne de visée.
3. **La Diffusion Vers l'Axe (*In-Scattering*)** : Photons provenant d'une source lumineuse déviés vers la caméra par les particules du milieu.

L'équation de transfert radiatif le long d'un rayon de vue $\mathbf{x}(t) = \mathbf{o} + t\mathbf{d}$ est formulée ainsi :

$$L(\mathbf{x}, \mathbf{d}) = L_0 e^{-\tau(0, d)} + \int_0^d e^{-\tau(0, t)} \sigma_s(\mathbf{x}(t)) p(\mathbf{d}, \mathbf{l}) L_{\text{in}}(\mathbf{x}(t), \mathbf{l}) \, dt$$

où :
- $\tau(0, t) = \int_0^t \sigma_t(s) \, ds$ est la profondeur optique.
- $\sigma_s$ est le coefficient de diffusion.
- $p(\mathbf{d}, \mathbf{l})$ est la **fonction de phase de Henyey-Greenstein** :
  $$p(\theta) = \frac{1}{4\pi} \frac{1 - g^2}{(1 + g^2 - 2g\cos\theta)^{3/2}}$$
  avec $g \in (-1, 1)$ désignant le facteur d'anisotropie ($g > 0$ favorise la diffusion avant / *forward scattering*).

---

## 2. Échantillonnage Volumétrique et Shadow Mapping

Pour évaluer $L_{\text{in}}(\mathbf{x}(t), \mathbf{l})$, le raymarcher interroge la carte d'ombres (*Shadow Map*) de chaque source de lumière active :
- Si le point voxel $\mathbf{x}(t)$ est dans l'ombre, l'in-scattering direct est nul.
- Si le point est éclairé, la contribution lumineuse pondérée par la fonction de phase est accumulée.

Pour maintenir un framerate de 60 FPS, le raymarching est réalisé à **basse résolution temporelle** (ex. quart ou demi-résolution avec 16 à 32 pas) couplé à un jittering bleu (*blue noise*).

---

## 3. TRAA : Temporal Reprojection Anti-Aliasing

Pour éliminer le bruit haute fréquence du raymarching à faible échantillonnage sans flouter l'image, le pipeline utilise le **TRAA** :
1. **Vecteurs de Mouvement (*Motion Vectors / Velocity Buffer*)** :
   Chaque pixel calcule son déplacement $\Delta \mathbf{u}$ entre la frame précédente $t-1$ et la frame actuelle $t$.
2. **Reprojection Temporelle** :
   L'échantillon de la frame précédente est recherché à la position $\mathbf{u} - \Delta \mathbf{u}$ dans l'historique.
3. **Clamping / Clipping dans l'Espace Couleur (YCoCg)** :
   Pour éviter le *ghosting* lors des occultations rapides, la couleur reprojectée est restreinte (*clamped*) à la boîte englobante des voisins $3 \times 3$ de la frame courante.
4. **Mélange Exponentiel** :
   $$C_{\text{final}} = \alpha C_{\text{current}} + (1 - \alpha) C_{\text{history}} \quad (\alpha \approx 0.05 - 0.1)$$

---

## 4. Spécification des Nœuds Tsuji pour le Chantier 2

- **`lighting/volumetric-fog`** : Nœud de milieu participant universel (densité, anisotropie $g$, couleur d'absorption, portée).
- **`postprocess/traa`** : Passe de post-traitement temporelle avec velocity buffer et rejet d'historique.

---

## 🔗 Notes Associées
- [[ThreeJS r185 Release and Migration Deep Dive]]
- [[WebGPU Volumetric Fire Simulation and 3D Fluid Dynamics]]
- [[Universal_Nodes_Catalog_3_Chantiers]]
- [[Strategic_Roadmap_3_Chantiers_Fire_Lighting_FPS]]
