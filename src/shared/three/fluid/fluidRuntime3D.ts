import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";

/**
 * Configuration de la grille discrétisée de voxels 3D
 */
export interface FluidGridConfig {
  gridX: number;
  gridY: number;
  gridZ: number;
  worldSize: THREE.Vector3;
}

export const DEFAULT_GRID_CONFIG: FluidGridConfig = {
  gridX: 32,
  gridY: 64,
  gridZ: 32,
  worldSize: new THREE.Vector3(8, 14, 8),
};

/**
 * Paramètres physiques de la simulation Navier-Stokes 3D
 */
export interface FluidSimParams {
  dt: number;
  time: number;
  buoyancy: number;       // Force ascensionnelle de l'air chaud
  smokeWeight: number;    // Gravité tirant la fumée froide vers le bas
  turbulence: number;     // Amplitude du brassage tourbillonnaire (Curl Noise)
  turbulenceDecay: number;// Décroissance de la turbulence thermique avec l'âge
  turbFrequency: number;  // Fréquence spatiale des volutes
  cooling: number;        // Vitesse d'extinction de la température
  dissipation: number;    // Vitesse d'évanouissement de la fumée
  velocityDamping: number;// Amortissement de vélocité par seconde
  wind: THREE.Vector3;    // Vecteur vent global
  jacobiIterations: number;// Résolution de pression de Jacobi
  /**
   * Passage monde -> espace local de la boîte de simulation (inverse de la
   * matrice du volume). L'identité laisse le volume centré sur l'origine.
   * Sert à la fois à situer les émetteurs et à évaluer les champs de force.
   */
  worldToVolume: THREE.Matrix4;
  /** Espace local de la boîte -> monde. Doit être l'inverse exact du précédent. */
  volumeToWorld: THREE.Matrix4;
}

/**
 * Champ de force à la Blender, structurellement identique au ForceFieldDescriptor
 * du système de particules (graph/particleRuntime.ts). Volontairement redéclaré
 * ici plutôt qu'importé : `three/fluid` est une couche runtime en dessous du
 * graphe, elle ne doit pas dépendre de lui. Les deux types s'unifient
 * structurellement, un ForceFieldDescriptor se passe donc tel quel.
 */
export interface FluidForceField {
  type: "attractor" | "vortex" | "wind" | "turbulence";
  /** Monde. */
  position: THREE.Vector3;
  /** Axe de rotation (vortex) ou direction de poussée (wind). */
  axis: THREE.Vector3;
  strength: number;
  /** 0 = portée infinie, sinon atténuation linéaire jusqu'à 0 à cette distance. */
  radius: number;
  /** Turbulence uniquement — échelle du bruit. */
  scale: number;
  /** Turbulence uniquement — vitesse de dérive du bruit. */
  speed: number;
}

export const DEFAULT_FLUID_PARAMS: FluidSimParams = {
  dt: 0.016,
  time: 0,
  buoyancy: 3.2,
  smokeWeight: 0.12,
  turbulence: 3.5,
  turbulenceDecay: 0.1,
  turbFrequency: 10.0,
  cooling: 0.85,
  dissipation: 0.25,
  velocityDamping: 0.2,
  wind: new THREE.Vector3(0, 0, 0),
  jacobiIterations: 4,
  worldToVolume: new THREE.Matrix4(),
  volumeToWorld: new THREE.Matrix4(),
};

/**
 * Descripteur d'émetteur de fluide dérivé d'un maillage
 */
export interface FluidEmitterDescriptor {
  geometry: THREE.BufferGeometry | THREE.Object3D;
  worldMatrix?: THREE.Matrix4;
  density: number;
  temperature: number;
  /** Facteur d'émission supplémentaire proportionnel à la vitesse de l'émetteur. */
  motionBoost: number;
  /** Rayon de dépôt de la matière, en unités monde. */
  radius: number;
  previousPosition?: THREE.Vector3;
  velocity?: THREE.Vector3;
  /** Norme de `velocity`, précalculée — pilote le boost d'émission et le vent de déplacement. */
  speed?: number;
  /** Position monde, centre de la sphère de vent induite par le déplacement. */
  position?: THREE.Vector3;
  /** Intensité du vent induit par le déplacement de l'émetteur. */
  windStrength?: number;
  /** Rayon monde de la sphère de vent autour de l'émetteur. */
  windRadius?: number;
  /**
   * Rend le débit indépendant de la densité de maillage. Chaque sommet étant une
   * source, un maillage low-poly donne un feu chétif et un maillage dense un
   * brasier, à réglages identiques — c'est le comportement de l'exemple three.js,
   * mais dans un éditeur à nodes c'est un piège : remplacer l'émetteur par le
   * même objet subdivisé change tout. Activé, le débit est rapporté à
   * REFERENCE_EMITTER_SAMPLES sommets.
   */
  normalizeEmission?: boolean;
}

/**
 * Nombre de sommets auquel le débit d'émission est rapporté quand
 * `normalizeEmission` est actif. Calé sur le cylindre de repli (427 sommets
 * échantillonnés) pour que l'activer ne bouleverse pas le rendu par défaut.
 */
export const REFERENCE_EMITTER_SAMPLES = 427;

/**
 * État interne complet de la simulation de fluide
 */
export interface FluidSimulationState {
  config: FluidGridConfig;
  cellCount: number;
  texelSize: THREE.Vector3;
  
  // Buffers de vélocité (Ping-Pong 3 composantes XYZ par cellule)
  velA: Float32Array;
  velB: Float32Array;
  
  // Buffers scalaires Dye (4 composantes RGBA : R=densité, G=température, B=âge, A=réservé)
  dyeA: Float32Array;
  dyeB: Float32Array;
  
  // Buffers de pression et divergence
  divergence: Float32Array;
  pressA: Float32Array;
  pressB: Float32Array;
  
  // Champ de Curl Noise 3D sans divergence
  curlNoise: Float32Array;
  /** Fréquence avec laquelle `curlNoise` a été généré — le champ est recalculé si elle change. */
  curlFrequency: number;
  
  // Textures GPU 3D exposables aux shaders et aux autres nœuds
  velTexture: THREE.Data3DTexture;
  dyeTexture: THREE.Data3DTexture;
  
  stepCount: number;
  dispose: () => void;
}

const perlin = new ImprovedNoise();

/** Plafond de sommets d'émetteur traités par pas de simulation (budget CPU) */
const MAX_EMITTER_SAMPLES = 512;

/**
 * Calcule l'indice 1D à partir des coordonnées entières (x, y, z) de voxel
 */
export function getVoxelIndex(x: number, y: number, z: number, config: FluidGridConfig): number {
  const cx = Math.max(0, Math.min(config.gridX - 1, x));
  const cy = Math.max(0, Math.min(config.gridY - 1, y));
  const cz = Math.max(0, Math.min(config.gridZ - 1, z));
  return cx + cy * config.gridX + cz * (config.gridX * config.gridY);
}

/**
 * Génère un champ vectoriel 3D sans divergence (Curl Noise)
 * par dérivation analytique centrée du rotationnel d'un bruit de Perlin.
 */
export function generateCurlNoiseField3D(
  config: FluidGridConfig,
  frequency = 10.0,
  amplitude = 1.0
): Float32Array {
  const { gridX, gridY, gridZ, worldSize } = config;
  const count = gridX * gridY * gridZ;
  const data = new Float32Array(count * 3);

  // Différentiation centrée dans l'espace pré-multiplié par la fréquence :
  // le pas effectif vaut eps * frequency = 0.1, d'où un facteur 1 / (2 * 0.1) = 5.
  const eps = 0.1 / Math.max(0.1, frequency);
  const CURL_SCALE = 5.0;

  // Correction d'anisotropie de la boîte pour garder des tourbillons isotropes
  const aspectX = worldSize.x / worldSize.y;
  const aspectZ = worldSize.z / worldSize.y;

  const sampleNoiseVec3 = (x: number, y: number, z: number, out: THREE.Vector3) => {
    const fx = x * frequency;
    const fy = y * frequency;
    const fz = z * frequency;
    out.set(
      perlin.noise(fx, fy, fz),
      perlin.noise(fx + 31.41, fy + 47.82, fz + 12.93),
      perlin.noise(fx + 92.17, fy + 14.28, fz + 73.55)
    );
  };

  const pX0 = new THREE.Vector3(), pX1 = new THREE.Vector3();
  const pY0 = new THREE.Vector3(), pY1 = new THREE.Vector3();
  const pZ0 = new THREE.Vector3(), pZ1 = new THREE.Vector3();

  let idx = 0;
  for (let z = 0; z < gridZ; z++) {
    const pz = ((z + 0.5) / gridZ) * aspectZ;
    for (let y = 0; y < gridY; y++) {
      const py = (y + 0.5) / gridY;
      for (let x = 0; x < gridX; x++) {
        const px = ((x + 0.5) / gridX) * aspectX;

        sampleNoiseVec3(px - eps, py, pz, pX0);
        sampleNoiseVec3(px + eps, py, pz, pX1);
        sampleNoiseVec3(px, py - eps, pz, pY0);
        sampleNoiseVec3(px, py + eps, pz, pY1);
        sampleNoiseVec3(px, py, pz - eps, pZ0);
        sampleNoiseVec3(px, py, pz + eps, pZ1);

        // Rotationnel curl = (dFz/dy - dFy/dz, dFx/dz - dFz/dx, dFy/dx - dFx/dy)
        const cx = (pY1.z - pY0.z) - (pZ1.y - pZ0.y);
        const cy = (pZ1.x - pZ0.x) - (pX1.z - pX0.z);
        const cz = (pX1.y - pX0.y) - (pY1.x - pY0.x);

        const k = CURL_SCALE * amplitude;
        data[idx] = cx * k;
        data[idx + 1] = cy * k;
        data[idx + 2] = cz * k;
        idx += 3;
      }
    }
  }

  return data;
}

/**
 * Accumule l'accélération monde produite par une liste de champs de force en un
 * point monde donné. Même sémantique que forceFieldContribution() du shader de
 * vélocité des particules, réimplémentée en CPU : un champ branché sur le solveur
 * de fluide et sur une simulation de particules doit pousser dans le même sens
 * avec la même intensité, sinon les deux systèmes divergent visuellement.
 */
export function accumulateForceFields(
  worldPos: THREE.Vector3,
  forces: FluidForceField[],
  time: number,
  out: THREE.Vector3
): void {
  out.set(0, 0, 0);
  if (forces.length === 0) return;

  for (const f of forces) {
    _ffDelta.subVectors(f.position, worldPos);
    const dist = _ffDelta.length();

    // radius 0 = portée infinie, sinon atténuation linéaire jusqu'à 0
    let falloff = 1;
    if (f.radius > 0) {
      if (dist >= f.radius) continue;
      falloff = 1 - dist / f.radius;
    }
    const gain = f.strength * falloff;

    switch (f.type) {
      case "attractor": {
        // strength > 0 attire, < 0 repousse. Le epsilon évite la singularité au centre.
        if (dist < 1e-4) break;
        out.addScaledVector(_ffDelta, gain / dist);
        break;
      }
      case "vortex": {
        // Rotation autour de l'axe : composante tangentielle du rayon projeté
        _ffRadial.subVectors(worldPos, f.position);
        _ffRadial.addScaledVector(f.axis, -_ffRadial.dot(f.axis));
        if (_ffRadial.lengthSq() < 1e-8) break;
        _ffTangent.crossVectors(f.axis, _ffRadial).normalize();
        out.addScaledVector(_ffTangent, gain);
        break;
      }
      case "wind": {
        out.addScaledVector(f.axis, gain);
        break;
      }
      case "turbulence": {
        const s = Math.max(1e-3, f.scale);
        const drift = time * f.speed;
        const nx = perlin.noise(worldPos.x * s + drift, worldPos.y * s, worldPos.z * s);
        const ny = perlin.noise(worldPos.x * s, worldPos.y * s + drift, worldPos.z * s + 41.3);
        const nz = perlin.noise(worldPos.x * s + 17.7, worldPos.y * s, worldPos.z * s + drift);
        out.x += nx * gain;
        out.y += ny * gain;
        out.z += nz * gain;
        break;
      }
    }
  }
}

const _ffDelta = new THREE.Vector3();
const _ffRadial = new THREE.Vector3();
const _ffTangent = new THREE.Vector3();

/**
 * Crée les textures 3D Three.js pour transporter les données fluides
 */
export function createFluidData3DTextures(config: FluidGridConfig): {
  velTexture: THREE.Data3DTexture;
  dyeTexture: THREE.Data3DTexture;
  velData: Float32Array;
  dyeData: Float32Array;
} {
  const { gridX, gridY, gridZ } = config;
  const count = gridX * gridY * gridZ;

  // RGBA Float32 pour vélocité (xyz + 0)
  const velData = new Float32Array(count * 4);
  const velTexture = new THREE.Data3DTexture(velData, gridX, gridY, gridZ);
  velTexture.format = THREE.RGBAFormat;
  velTexture.type = THREE.FloatType;
  velTexture.minFilter = THREE.LinearFilter;
  velTexture.magFilter = THREE.LinearFilter;
  velTexture.wrapS = THREE.ClampToEdgeWrapping;
  velTexture.wrapT = THREE.ClampToEdgeWrapping;
  velTexture.wrapR = THREE.ClampToEdgeWrapping;
  velTexture.needsUpdate = true;

  // RGBA Float32 pour dye (R: densité, G: température, B: âge, A: 1)
  const dyeData = new Float32Array(count * 4);
  const dyeTexture = new THREE.Data3DTexture(dyeData, gridX, gridY, gridZ);
  dyeTexture.format = THREE.RGBAFormat;
  dyeTexture.type = THREE.FloatType;
  dyeTexture.minFilter = THREE.LinearFilter;
  dyeTexture.magFilter = THREE.LinearFilter;
  dyeTexture.wrapS = THREE.ClampToEdgeWrapping;
  dyeTexture.wrapT = THREE.ClampToEdgeWrapping;
  dyeTexture.wrapR = THREE.ClampToEdgeWrapping;
  dyeTexture.needsUpdate = true;

  return { velTexture, dyeTexture, velData, dyeData };
}

/**
 * Alloue et initialise un état complet de simulation de fluide 3D
 */
export function createFluidSimulationState(config: FluidGridConfig = DEFAULT_GRID_CONFIG): FluidSimulationState {
  const cellCount = config.gridX * config.gridY * config.gridZ;
  const texelSize = new THREE.Vector3(1 / config.gridX, 1 / config.gridY, 1 / config.gridZ);

  const velA = new Float32Array(cellCount * 3);
  const velB = new Float32Array(cellCount * 3);
  const dyeA = new Float32Array(cellCount * 4);
  const dyeB = new Float32Array(cellCount * 4);
  const divergence = new Float32Array(cellCount);
  const pressA = new Float32Array(cellCount);
  const pressB = new Float32Array(cellCount);

  // Amplitude 1.0 : le gain est appliqué une seule fois via params.turbulence au moment de l'usage
  const curlNoise = generateCurlNoiseField3D(config, DEFAULT_FLUID_PARAMS.turbFrequency, 1.0);
  const { velTexture, dyeTexture } = createFluidData3DTextures(config);

  return {
    config,
    cellCount,
    texelSize,
    velA,
    velB,
    dyeA,
    dyeB,
    divergence,
    pressA,
    pressB,
    curlNoise,
    curlFrequency: DEFAULT_FLUID_PARAMS.turbFrequency,
    velTexture,
    dyeTexture,
    stepCount: 0,
    dispose: () => {
      velTexture.dispose();
      dyeTexture.dispose();
    },
  };
}

/**
 * Échantillonne trilinéairement un champ vectoriel 3D (3 composantes par cellule)
 */
function sampleTrilinearVec3(data: Float32Array, u: number, v: number, w: number, config: FluidGridConfig, out: THREE.Vector3): void {
  const gx = THREE.MathUtils.clamp(u * config.gridX - 0.5, 0, config.gridX - 1);
  const gy = THREE.MathUtils.clamp(v * config.gridY - 0.5, 0, config.gridY - 1);
  const gz = THREE.MathUtils.clamp(w * config.gridZ - 0.5, 0, config.gridZ - 1);

  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const z0 = Math.floor(gz);
  const x1 = Math.min(config.gridX - 1, x0 + 1);
  const y1 = Math.min(config.gridY - 1, y0 + 1);
  const z1 = Math.min(config.gridZ - 1, z0 + 1);

  const fx = gx - x0;
  const fy = gy - y0;
  const fz = gz - z0;

  const getVal = (x: number, y: number, z: number, c: number) => {
    return data[(x + y * config.gridX + z * config.gridX * config.gridY) * 3 + c];
  };

  for (let c = 0; c < 3; c++) {
    const c000 = getVal(x0, y0, z0, c);
    const c100 = getVal(x1, y0, z0, c);
    const c010 = getVal(x0, y1, z0, c);
    const c110 = getVal(x1, y1, z0, c);
    const c001 = getVal(x0, y0, z1, c);
    const c101 = getVal(x1, y0, z1, c);
    const c011 = getVal(x0, y1, z1, c);
    const c111 = getVal(x1, y1, z1, c);

    const c00 = c000 * (1 - fx) + c100 * fx;
    const c10 = c010 * (1 - fx) + c110 * fx;
    const c01 = c001 * (1 - fx) + c101 * fx;
    const c11 = c011 * (1 - fx) + c111 * fx;

    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;

    const res = c0 * (1 - fz) + c1 * fz;
    if (c === 0) out.x = res;
    else if (c === 1) out.y = res;
    else out.z = res;
  }
}

/**
 * Échantillonne trilinéairement un champ vectoriel 3D en mode RepeatWrapping.
 * Indispensable pour lire le Curl Noise à des coordonnées défilant avec l'âge ou le temps
 * (équivalent CPU de la texture curlNoise en RepeatWrapping de l'exemple three.js).
 */
function sampleTrilinearVec3Repeat(data: Float32Array, u: number, v: number, w: number, config: FluidGridConfig, out: THREE.Vector3): void {
  const { gridX, gridY, gridZ } = config;

  const gx = u * gridX - 0.5;
  const gy = v * gridY - 0.5;
  const gz = w * gridZ - 0.5;

  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const z0 = Math.floor(gz);

  const fx = gx - x0;
  const fy = gy - y0;
  const fz = gz - z0;

  const wrap = (i: number, n: number) => ((i % n) + n) % n;

  const wx0 = wrap(x0, gridX), wx1 = wrap(x0 + 1, gridX);
  const wy0 = wrap(y0, gridY), wy1 = wrap(y0 + 1, gridY);
  const wz0 = wrap(z0, gridZ), wz1 = wrap(z0 + 1, gridZ);

  const getVal = (x: number, y: number, z: number, c: number) =>
    data[(x + y * gridX + z * gridX * gridY) * 3 + c];

  for (let c = 0; c < 3; c++) {
    const c00 = getVal(wx0, wy0, wz0, c) * (1 - fx) + getVal(wx1, wy0, wz0, c) * fx;
    const c10 = getVal(wx0, wy1, wz0, c) * (1 - fx) + getVal(wx1, wy1, wz0, c) * fx;
    const c01 = getVal(wx0, wy0, wz1, c) * (1 - fx) + getVal(wx1, wy0, wz1, c) * fx;
    const c11 = getVal(wx0, wy1, wz1, c) * (1 - fx) + getVal(wx1, wy1, wz1, c) * fx;

    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;

    const res = c0 * (1 - fz) + c1 * fz;
    if (c === 0) out.x = res;
    else if (c === 1) out.y = res;
    else out.z = res;
  }
}

/**
 * Échantillonne trilinéairement un champ scalaire Dye RGBA
 */
function sampleTrilinearDye(data: Float32Array, u: number, v: number, w: number, config: FluidGridConfig, out: THREE.Vector4): void {
  const gx = u * config.gridX - 0.5;
  const gy = v * config.gridY - 0.5;
  const gz = w * config.gridZ - 0.5;

  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const z0 = Math.floor(gz);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;

  const fx = gx - x0;
  const fy = gy - y0;
  const fz = gz - z0;

  // Bord ZÉRO, surtout pas ClampToEdge. Un clamp fait que toutes les cellules qui
  // rétro-tracent hors de la boîte relisent la même rangée de bord et la
  // dupliquent : l'advection semi-lagrangienne se met à FABRIQUER de la masse.
  // Avec l'émetteur posé au ras du plancher (uvw.y ~ 0.025) c'est la source de
  // masse dominante — mesurée à +84 par pas contre 4,5 injectés. Hors du volume
  // il n'y a pas de fumée : la bonne valeur est 0.
  const gridX = config.gridX;
  const gridY = config.gridY;
  const gridZ = config.gridZ;
  const getVal = (x: number, y: number, z: number, c: number) => {
    if (x < 0 || x >= gridX || y < 0 || y >= gridY || z < 0 || z >= gridZ) return 0;
    return data[(x + y * gridX + z * gridX * gridY) * 4 + c];
  };

  for (let c = 0; c < 4; c++) {
    const c000 = getVal(x0, y0, z0, c);
    const c100 = getVal(x1, y0, z0, c);
    const c010 = getVal(x0, y1, z0, c);
    const c110 = getVal(x1, y1, z0, c);
    const c001 = getVal(x0, y0, z1, c);
    const c101 = getVal(x1, y0, z1, c);
    const c011 = getVal(x0, y1, z1, c);
    const c111 = getVal(x1, y1, z1, c);

    const c00 = c000 * (1 - fx) + c100 * fx;
    const c10 = c010 * (1 - fx) + c110 * fx;
    const c01 = c001 * (1 - fx) + c101 * fx;
    const c11 = c011 * (1 - fx) + c111 * fx;

    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;

    const res = c0 * (1 - fz) + c1 * fz;
    if (c === 0) out.x = res;
    else if (c === 1) out.y = res;
    else if (c === 2) out.z = res;
    else out.w = res;
  }
}

/** Un maillage émetteur résolu : ses sommets et la matrice qui les met en monde. */
interface EmitterSource {
  positions: THREE.BufferAttribute;
  matrixWorld: THREE.Matrix4;
}

/**
 * Résout un descripteur d'émetteur en une liste de sources de sommets.
 *
 * Un socket `geometry` transporte un Object3D, qui dans ce graphe est très
 * souvent un Group (Merge, Instance, import glTF, Array…) et non un Mesh nu.
 * La version précédente testait `instanceof THREE.Mesh` sur la racine
 * uniquement : tout ce qui arrivait enveloppé n'émettait rien, en silence.
 * Même convention que list/points-from-geometry — traverse, accepte Mesh ET
 * Points, et applique la matrice monde de CHAQUE enfant, pas celle de la racine.
 */
function collectEmitterSources(emitter: FluidEmitterDescriptor): EmitterSource[] {
  const sources: EmitterSource[] = [];
  const geo = emitter.geometry;

  if (geo instanceof THREE.BufferGeometry) {
    const positions = geo.attributes.position as THREE.BufferAttribute | undefined;
    if (positions) {
      sources.push({ positions, matrixWorld: emitter.worldMatrix ?? new THREE.Matrix4() });
    }
    return sources;
  }

  if (!(geo instanceof THREE.Object3D)) return sources;

  geo.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Points)) return;
    const positions = child.geometry?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!positions) return;
    // updateWorldMatrix (PAS updateMatrix) : les objets pilotés par le graphe
    // portent leur pose dans `matrix` avec matrixAutoUpdate à false, et
    // updateMatrix() la recalculerait depuis des defaults vierges.
    child.updateWorldMatrix(true, false, true);
    sources.push({ positions, matrixWorld: child.matrixWorld });
  });

  return sources;
}

/**
 * Exécute un pas de calcul complet de simulation de fluide Navier-Stokes 3D
 */
export function stepFluidSimulation(
  state: FluidSimulationState,
  params: FluidSimParams = DEFAULT_FLUID_PARAMS,
  emitters: FluidEmitterDescriptor[] = [],
  forces: FluidForceField[] = []
): void {
  const { config, velA, velB, dyeA, dyeB, divergence, pressA, pressB } = state;
  const { gridX, gridY, gridZ, worldSize } = config;
  const dt = Math.max(0.0001, params.dt);

  // Le champ de curl est précalculé pour une fréquence donnée : la changer
  // impose de le régénérer, sinon le paramètre n'a aucun effet.
  if (state.curlFrequency !== params.turbFrequency) {
    state.curlNoise = generateCurlNoiseField3D(config, params.turbFrequency, 1.0);
    state.curlFrequency = params.turbFrequency;
  }
  const curlNoise = state.curlNoise;

  const sampleVel = new THREE.Vector3();
  const sampleDye = new THREE.Vector4();
  const thermalCurl = new THREE.Vector3();
  const ambientCurl = new THREE.Vector3();

  // Les champs de force raisonnent en monde, la sim en local à la boîte : on
  // convertit chaque voxel dans un sens et l'accélération résultante dans l'autre.
  // La base 3x3 (pas transformDirection) préserve l'échelle de la matrice du volume.
  const hasForces = forces.length > 0;
  const forceAccel = new THREE.Vector3();
  const voxelWorld = new THREE.Vector3();
  const worldToVolumeBasis = new THREE.Matrix3().setFromMatrix4(params.worldToVolume);
  const volumeToWorld = params.volumeToWorld;

  // Émetteurs réellement en mouvement : les immobiles ne coûtent rien par voxel
  const movingEmitters = emitters.filter(
    (e) => e.position && e.velocity && (e.speed ?? 0) > 1e-4
  );
  const hasMovingEmitters = movingEmitters.length > 0;
  const windCurl = new THREE.Vector3();
  const windAccel = new THREE.Vector3();
  const invFreqWind = 1 / Math.max(0.1, params.turbFrequency);

  // -------------------------------------------------------------
  // 1) Advection Semi-Lagrangienne de la Vélocité + Forces Externes
  // -------------------------------------------------------------
  for (let z = 0; z < gridZ; z++) {
    const uz = (z + 0.5) / gridZ;
    for (let y = 0; y < gridY; y++) {
      const uy = (y + 0.5) / gridY;
      for (let x = 0; x < gridX; x++) {
        const ux = (x + 0.5) / gridX;
        const cell = getVoxelIndex(x, y, z, config);
        const idx3 = cell * 3;
        const idx4 = cell * 4;

        // Vitesse actuelle
        const vx = velA[idx3];
        const vy = velA[idx3 + 1];
        const vz = velA[idx3 + 2];

        // Trajectoire rétrograde le long de la vitesse
        const prevU = ux - (vx / worldSize.x) * dt;
        const prevV = uy - (vy / worldSize.y) * dt;
        const prevW = uz - (vz / worldSize.z) * dt;

        sampleTrilinearVec3(velA, prevU, prevV, prevW, config, sampleVel);

        // Données scalaires locales
        const density = dyeA[idx4];
        const temperature = dyeA[idx4 + 1];
        const age = dyeA[idx4 + 2];

        // Flottabilité thermique (chaud monte, fumée froide tombe)
        const buoyancyForce = (temperature * params.buoyancy - density * params.smokeWeight) * worldSize.y;
        sampleVel.y += buoyancyForce * dt;

        // Turbulences à deux étages dérivées du Curl Noise, échantillonné à des
        // coordonnées qui défilent : sans ce défilement le champ de forces est figé
        // dans le réseau de voxels et produit des striations stationnaires.
        const invFreq = 1 / Math.max(0.1, params.turbFrequency);

        // 1) Convective / Thermique : suit le panache via l'âge, décroît avec lui
        sampleTrilinearVec3Repeat(
          curlNoise,
          ux,
          uy - age * 0.6 * invFreq,
          uz + age * 0.13 * invFreq,
          config,
          thermalCurl
        );
        const decay = Math.exp(-params.turbulenceDecay * age);
        const thermalScale = params.turbulence * temperature * decay;

        // 2) Ambiante / Atmosphérique : basse fréquence, animée par le temps,
        //    agit sur la fumée même refroidie. Curl (donc à divergence nulle).
        sampleTrilinearVec3Repeat(
          curlNoise,
          ux * 0.5,
          uy * 0.5 + params.time * 0.25 * invFreq,
          uz * 0.5 + params.time * 0.06 * invFreq,
          config,
          ambientCurl
        );
        const ambientScale = params.turbulence * 0.2 * density;

        sampleVel.x += (thermalCurl.x * thermalScale + ambientCurl.x * ambientScale) * worldSize.y * dt;
        sampleVel.y += (thermalCurl.y * thermalScale + ambientCurl.y * ambientScale) * worldSize.y * dt;
        sampleVel.z += (thermalCurl.z * thermalScale + ambientCurl.z * ambientScale) * worldSize.y * dt;

        // Injection du vent global
        sampleVel.x += params.wind.x * dt;
        sampleVel.y += params.wind.y * dt;
        sampleVel.z += params.wind.z * dt;

        // Champs de force externes (particles/force-field) et vent de déplacement
        // des émetteurs : tous deux raisonnent en monde, on n'y passe qu'une fois.
        if (hasForces || hasMovingEmitters) {
          voxelWorld
            .set((ux - 0.5) * worldSize.x, (uy - 0.5) * worldSize.y, (uz - 0.5) * worldSize.z)
            .applyMatrix4(volumeToWorld);

          if (hasForces) {
            accumulateForceFields(voxelWorld, forces, params.time, forceAccel);
            forceAccel.applyMatrix3(worldToVolumeBasis);
            sampleVel.addScaledVector(forceAccel, dt);
          }

          // Sphère de vent autour d'un émetteur en mouvement : c'est ce qui rend
          // le déplacement interactif — déplacer l'émetteur brasse le fluide au
          // lieu de simplement téléporter la source d'émission.
          for (const em of movingEmitters) {
            const wr = em.windRadius ?? 1.0;
            const dist = voxelWorld.distanceTo(em.position!);
            if (dist >= wr) continue;
            const falloff = THREE.MathUtils.smoothstep(1 - dist / wr, 0, 1);

            // Turbulence de sillage, proportionnelle à la vitesse
            sampleTrilinearVec3Repeat(
              curlNoise,
              ux,
              uy + params.time * 0.5 * invFreqWind,
              uz,
              config,
              windCurl
            );
            const speed = em.speed ?? 0;
            windAccel
              .copy(em.velocity!)
              .multiplyScalar(em.windStrength ?? 6.5)
              .addScaledVector(windCurl, params.turbulence * speed)
              .applyMatrix3(worldToVolumeBasis)
              .multiplyScalar(falloff * dt);
            sampleVel.add(windAccel);
          }
        }

        // Amortissement de vitesse
        const damp = Math.max(0, 1 - params.velocityDamping * dt);
        sampleVel.multiplyScalar(damp);

        // Conditions aux limites molles (amortissement latéral aux parois X/Z et au plafond Y)
        // Ne jamais freiner la base Y=0 pour laisser le feu aspirer l'air et s'élever
        const edgeX = Math.min(ux, 1.0 - ux);
        const edgeZ = Math.min(uz, 1.0 - uz);
        const edgeTop = 1.0 - uy;
        const sideEdge = Math.min(edgeX, edgeZ);
        const sideBoundary = THREE.MathUtils.smoothstep(sideEdge, 0.0, 0.06);
        const topBoundary = THREE.MathUtils.smoothstep(edgeTop, 0.0, 0.04);
        sampleVel.x *= sideBoundary;
        sampleVel.z *= sideBoundary;
        sampleVel.y *= sideBoundary * topBoundary;

        velB[idx3] = sampleVel.x;
        velB[idx3 + 1] = sampleVel.y;
        velB[idx3 + 2] = sampleVel.z;
      }
    }
  }

  // -------------------------------------------------------------
  // 2) Calcul de la Divergence du Champ Advecté
  // -------------------------------------------------------------
  for (let z = 0; z < gridZ; z++) {
    for (let y = 0; y < gridY; y++) {
      for (let x = 0; x < gridX; x++) {
        const cell = getVoxelIndex(x, y, z, config);

        const vR = velB[getVoxelIndex(x + 1, y, z, config) * 3];
        const vL = velB[getVoxelIndex(x - 1, y, z, config) * 3];
        const vU = velB[getVoxelIndex(x, y + 1, z, config) * 3 + 1];
        const vD = velB[getVoxelIndex(x, y - 1, z, config) * 3 + 1];
        const vF = velB[getVoxelIndex(x, y, z + 1, config) * 3 + 2];
        const vB_val = velB[getVoxelIndex(x, y, z - 1, config) * 3 + 2];

        divergence[cell] = 0.5 * ((vR - vL) + (vU - vD) + (vF - vB_val));
        // NE PAS remettre pressA à zéro : la pression de la frame précédente sert de
        // point de départ (warm start). C'est ce qui permet à l'exemple three.js de
        // converger avec seulement 2 itérations de Jacobi.
      }
    }
  }

  // -------------------------------------------------------------
  // 3) Solveur Itératif de Pression de Jacobi
  // -------------------------------------------------------------
  let readP = pressA;
  let writeP = pressB;

  const iterations = Math.max(1, Math.min(16, params.jacobiIterations));
  for (let iter = 0; iter < iterations; iter++) {
    for (let z = 0; z < gridZ; z++) {
      for (let y = 0; y < gridY; y++) {
        for (let x = 0; x < gridX; x++) {
          const cell = getVoxelIndex(x, y, z, config);

          const pR = readP[getVoxelIndex(x + 1, y, z, config)];
          const pL = readP[getVoxelIndex(x - 1, y, z, config)];
          const pU = readP[getVoxelIndex(x, y + 1, z, config)];
          const pD = readP[getVoxelIndex(x, y - 1, z, config)];
          const pF = readP[getVoxelIndex(x, y, z + 1, config)];
          const pB_val = readP[getVoxelIndex(x, y, z - 1, config)];

          writeP[cell] = (pR + pL + pU + pD + pF + pB_val - divergence[cell]) / 6.0;
        }
      }
    }
    const tmp = readP;
    readP = writeP;
    writeP = tmp;
  }

  // Le warm start de la frame suivante relit toujours pressA : si le nombre impair
  // d'itérations a laissé le résultat dans pressB, le recopier pour ne pas repartir
  // d'un champ vieux de deux frames.
  if (readP !== pressA) pressA.set(readP);

  // -------------------------------------------------------------
  // 4) Projection sans Divergence (Soustraction du Gradient)
  // -------------------------------------------------------------
  for (let z = 0; z < gridZ; z++) {
    for (let y = 0; y < gridY; y++) {
      for (let x = 0; x < gridX; x++) {
        const cell = getVoxelIndex(x, y, z, config);
        const idx3 = cell * 3;

        const pR = readP[getVoxelIndex(x + 1, y, z, config)];
        const pL = readP[getVoxelIndex(x - 1, y, z, config)];
        const pU = readP[getVoxelIndex(x, y + 1, z, config)];
        const pD = readP[getVoxelIndex(x, y - 1, z, config)];
        const pF = readP[getVoxelIndex(x, y, z + 1, config)];
        const pB_val = readP[getVoxelIndex(x, y, z - 1, config)];

        const gradX = 0.5 * (pR - pL);
        const gradY = 0.5 * (pU - pD);
        const gradZ = 0.5 * (pF - pB_val);

        velA[idx3] = velB[idx3] - gradX;
        velA[idx3 + 1] = velB[idx3 + 1] - gradY;
        velA[idx3 + 2] = velB[idx3 + 2] - gradZ;
      }
    }
  }

  // -------------------------------------------------------------
  // 5) Advection des Scalaires (Dye : Densité, Température, Âge)
  // -------------------------------------------------------------
  for (let z = 0; z < gridZ; z++) {
    const uz = (z + 0.5) / gridZ;
    for (let y = 0; y < gridY; y++) {
      const uy = (y + 0.5) / gridY;
      for (let x = 0; x < gridX; x++) {
        const ux = (x + 0.5) / gridX;
        const cell = getVoxelIndex(x, y, z, config);
        const idx3 = cell * 3;
        const idx4 = cell * 4;

        const vx = velA[idx3];
        const vy = velA[idx3 + 1];
        const vz = velA[idx3 + 2];

        const prevU = ux - (vx / worldSize.x) * dt;
        const prevV = uy - (vy / worldSize.y) * dt;
        const prevW = uz - (vz / worldSize.z) * dt;

        sampleTrilinearDye(dyeA, prevU, prevV, prevW, config, sampleDye);

        const newDensity = Math.max(0, sampleDye.x * Math.max(0, 1 - params.dissipation * dt));
        const newTemp = THREE.MathUtils.clamp(sampleDye.y * Math.max(0, 1 - params.cooling * dt), 0, 12);

        // L'âge se lit en plus proche voisin, pas en trilinéaire : interpoler un
        // âge mélange des parcelles de fluide d'histoires différentes et le
        // diffuse numériquement, ce qui brouille la décroissance de turbulence.
        const ageX = Math.min(gridX - 1, Math.max(0, Math.floor(prevU * gridX)));
        const ageY = Math.min(gridY - 1, Math.max(0, Math.floor(prevV * gridY)));
        const ageZ = Math.min(gridZ - 1, Math.max(0, Math.floor(prevW * gridZ)));
        const prevAgeCell = getVoxelIndex(ageX, ageY, ageZ, config);
        const newAge = newDensity > 0.01 ? dyeA[prevAgeCell * 4 + 2] + dt : 0;

        dyeB[idx4] = newDensity;
        dyeB[idx4 + 1] = newTemp;
        dyeB[idx4 + 2] = newAge;
        dyeB[idx4 + 3] = 1.0;
      }
    }
  }

  // Swap dyeB -> dyeA
  dyeA.set(dyeB);

  // -------------------------------------------------------------
  // 6) Injection des Émetteurs (Sommets de Maillage)
  // -------------------------------------------------------------
  const vertex = new THREE.Vector3();
  const worldPos = new THREE.Vector3();
  const localPos = new THREE.Vector3();
  const emitterVelLocal = new THREE.Vector3();

  for (const emitter of emitters) {
    const sources = collectEmitterSources(emitter);
    if (sources.length === 0) continue;

    let totalVertices = 0;
    for (const s of sources) totalVertices += s.positions.count;
    // Plafonner le nombre de sommets traités par pas pour préserver le 60 FPS.
    // Le stride ne réduit que la couverture spatiale, jamais le débit d'émission.
    const stride = Math.max(1, Math.floor(totalVertices / MAX_EMITTER_SAMPLES));

    // Rayon de dépôt exprimé en voxels sur chaque axe : sans lui `radius` était
    // un paramètre mort et chaque sommet ne touchait qu'une seule cellule.
    const radiusVox = new THREE.Vector3(
      (emitter.radius / worldSize.x) * gridX,
      (emitter.radius / worldSize.y) * gridY,
      (emitter.radius / worldSize.z) * gridZ
    );
    const rx = Math.min(3, Math.floor(radiusVox.x));
    const ry = Math.min(3, Math.floor(radiusVox.y));
    const rz = Math.min(3, Math.floor(radiusVox.z));

    // Somme des poids du noyau, pour le normaliser : sans elle un rayon de 3
    // voxels déposait ~340 fois la quantité prévue par sommet et saturait
    // instantanément la grille. Le rayon doit étaler la matière, pas la multiplier.
    let kernelSum = 0;
    for (let oz = -rz; oz <= rz; oz++) {
      for (let oy = -ry; oy <= ry; oy++) {
        for (let ox = -rx; ox <= rx; ox++) {
          const nx = rx > 0 ? ox / (rx + 1) : 0;
          const ny = ry > 0 ? oy / (ry + 1) : 0;
          const nz = rz > 0 ? oz / (rz + 1) : 0;
          const d2 = nx * nx + ny * ny + nz * nz;
          if (d2 <= 1) kernelSum += 1 - d2;
        }
      }
    }
    const invKernelSum = kernelSum > 0 ? 1 / kernelSum : 1;

    if (emitter.velocity) {
      emitterVelLocal.copy(emitter.velocity).applyMatrix3(worldToVolumeBasis);
    } else {
      emitterVelLocal.set(0, 0, 0);
    }

    // emissionFactor = 1 de base + un supplément proportionnel à la vitesse,
    // comme l'exemple. Une température d'émission nulle coupe tout.
    let emissionFactor =
      (emitter.temperature > 0 ? 1 : 0) + (emitter.speed ?? 0) * emitter.motionBoost;

    // Compensation de densité de maillage : le nombre de sommets RÉELLEMENT
    // échantillonnés (après stride) est ce qui pilote le débit total.
    if (emitter.normalizeEmission) {
      const sampled = Math.max(1, Math.ceil(totalVertices / stride));
      emissionFactor *= REFERENCE_EMITTER_SAMPLES / sampled;
    }

    for (const source of sources) {
      const positions = source.positions;
      const count = positions.count;

      for (let i = 0; i < count; i += stride) {
        vertex.fromBufferAttribute(positions, i);
        worldPos.copy(vertex).applyMatrix4(source.matrixWorld);

        // Monde -> local à la boîte -> UVW [0..1]. La boîte s'étend sur
        // [-size/2, +size/2] sur les TROIS axes, exactement comme l'espace dans
        // lequel le raymarcher travaille : c'est la matrice du volume qui porte
        // l'ancrage au sol, plus un cas particulier codé en dur sur Y.
        localPos.copy(worldPos).applyMatrix4(params.worldToVolume);
        const uvwX = localPos.x / worldSize.x + 0.5;
        const uvwY = localPos.y / worldSize.y + 0.5;
        const uvwZ = localPos.z / worldSize.z + 0.5;

        if (uvwX < 0 || uvwX > 1 || uvwY < 0 || uvwY > 1 || uvwZ < 0 || uvwZ > 1) continue;

        // Bruit de scintillation (flicker), en espace local du sommet pour rester
        // stable quand l'émetteur se déplace
        const flicker = 0.5 + 0.5 * perlin.noise(
          vertex.x * 9.0,
          vertex.y * 9.0 - params.time * 2.5,
          vertex.z * 9.0 + params.time * 0.7
        );
        const flickerGain = flicker * 0.85 + 0.15;

        // Débit par seconde, non divisé par le nombre de sommets : chaque sommet est
        // une source indépendante, exactement comme le kernel emitTeapot de l'exemple.
        // Le facteur de mouvement fait cracher davantage un émetteur qu'on déplace.
        const emission = emitter.density * dt * flickerGain * emissionFactor;
        const tempEmission = emitter.temperature * dt * flickerGain * emissionFactor;

        const cx = Math.floor(uvwX * gridX);
        const cy = Math.floor(uvwY * gridY);
        const cz = Math.floor(uvwZ * gridZ);

        for (let oz = -rz; oz <= rz; oz++) {
          for (let oy = -ry; oy <= ry; oy++) {
            for (let ox = -rx; ox <= rx; ox++) {
              // Pondération radiale normalisée par la somme du noyau : le total
              // déposé ne dépend pas du rayon, seul son étalement change.
              const nx = rx > 0 ? ox / (rx + 1) : 0;
              const ny = ry > 0 ? oy / (ry + 1) : 0;
              const nz = rz > 0 ? oz / (rz + 1) : 0;
              const d2 = nx * nx + ny * ny + nz * nz;
              if (d2 > 1) continue;
              const w = (1 - d2) * invKernelSum;

              const cell = getVoxelIndex(cx + ox, cy + oy, cz + oz, config);
              const idx4 = cell * 4;

              const prevDensity = dyeA[idx4];
              const prevAge = dyeA[idx4 + 2];
              const added = emission * w;
              const newDensity = prevDensity + added;

              dyeA[idx4] = newDensity;
              dyeA[idx4 + 1] = THREE.MathUtils.clamp(dyeA[idx4 + 1] + tempEmission * w, 0, 12);
              // Rajeunir proportionnellement à la fraction de matière fraîche, au lieu
              // de remettre l'âge brutalement à 0 (évite les sauts de turbulence)
              dyeA[idx4 + 2] = THREE.MathUtils.lerp(prevAge, 0, Math.min(1, added / Math.max(newDensity, 0.001)));

              // Traînée / vent induit par le déplacement de l'émetteur
              if (emitter.motionBoost !== 0) {
                const idx3 = cell * 3;
                velA[idx3] += emitterVelLocal.x * emitter.motionBoost * w * dt;
                velA[idx3 + 1] += emitterVelLocal.y * emitter.motionBoost * w * dt;
                velA[idx3 + 2] += emitterVelLocal.z * emitter.motionBoost * w * dt;
              }
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------
  // 7) Mise à Jour des Textures GPU
  // -------------------------------------------------------------
  const count = config.gridX * config.gridY * config.gridZ;
  const velTexData = state.velTexture.image.data as Float32Array;
  const dyeTexData = state.dyeTexture.image.data as Float32Array;

  let idx3 = 0;
  let idx4 = 0;
  for (let i = 0; i < count; i++) {
    velTexData[idx4] = velA[idx3];
    velTexData[idx4 + 1] = velA[idx3 + 1];
    velTexData[idx4 + 2] = velA[idx3 + 2];
    velTexData[idx4 + 3] = 1.0;

    dyeTexData[idx4] = dyeA[idx4];
    dyeTexData[idx4 + 1] = dyeA[idx4 + 1];
    dyeTexData[idx4 + 2] = dyeA[idx4 + 2];
    dyeTexData[idx4 + 3] = 1.0;

    idx3 += 3;
    idx4 += 4;
  }

  state.velTexture.needsUpdate = true;
  state.dyeTexture.needsUpdate = true;
  state.stepCount++;
}

/**
 * Shader GLSL universel de Raymarching volumétrique émissif
 */
export const VOLUME_RAYMARCH_VERTEX_SHADER = /* glsl */ `
  varying vec3 vLocalCamPos;
  varying vec3 vLocalPosition;
  varying vec3 vWorldPosition;

  uniform mat4 uInvModelMatrix;

  void main() {
    vLocalPosition = position;
    vec4 localCam = uInvModelMatrix * vec4(cameraPosition, 1.0);
    vLocalCamPos = localCam.xyz;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const VOLUME_RAYMARCH_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  // Borne de compilation de la boucle d'auto-ombrage : GLSL ES exige un compte
  // constant, uShadowSteps ne fait que sortir plus tôt. L'exemple three.js monte
  // jusqu'à 5 passes, réduites à 2 pour la performance.
  #define MAX_SHADOW_STEPS 8

  varying vec3 vLocalCamPos;
  varying vec3 vLocalPosition;
  varying vec3 vWorldPosition;

  uniform sampler3D uDyeTexture;
  uniform sampler3D uVelTexture;
  uniform mat4 uInvModelMatrix;
  uniform vec3 uVolumeSize;
  uniform vec3 uKeyLightPos;
  uniform float uTime;
  uniform float uFireIntensity;
  uniform float uShadowAbsorption;
  uniform float uPowderStrength;
  uniform float uFireGlowSpread;
  uniform vec3 uFireStartColor;
  uniform vec3 uFireMidColor;
  uniform vec3 uFireEndColor;
  uniform int uSteps;
  uniform int uFrameId;
  uniform float uExposure;
  uniform float uAsymmetry;
  uniform float uMultiScattering;
  uniform float uShadowAmbient;
  uniform float uFireHue;
  uniform float uSaturation;
  uniform float uSmokeAmbient;
  uniform float uFadeIn;
  uniform float uFireRampScale;
  uniform float uKeyLightIntensity;
  uniform float uColorRetention;
  uniform int uShadowSteps;

  // Ashima Arts / Stefan Gustavson Simplex 3D Noise
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  // Interleaved Gradient Noise (dither offset)
  float ign(vec2 p) {
    vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
    return fract(magic.z * fract(dot(p, magic.xy)));
  }

  // Intersection boîte englobante AABB locale [-uVolumeSize/2, uVolumeSize/2]
  vec2 intersectBox(vec3 orig, vec3 dir, vec3 bmin, vec3 bmax) {
    vec3 invDir = 1.0 / dir;
    vec3 tbot = invDir * (bmin - orig);
    vec3 ttop = invDir * (bmax - orig);
    vec3 tmin = min(ttop, tbot);
    vec3 tmax = max(ttop, tbot);
    float t0 = max(tmin.x, max(tmin.y, tmin.z));
    float t1 = min(tmax.x, min(tmax.y, tmax.z));
    return vec2(t0, t1);
  }

  // Rampe thermique corps noir avec 3 bandes lissées (Three.js official).
  // t est une température NORMALISÉE : le champ brut monte bien au-dessus de 1
  // (taux d'émission 5.5 accumulé sur plusieurs pas), donc l'indexer directement
  // saturait toute la flamme sur la couleur haute — pâle — d'où un feu blanc.
  // uFireRampScale fixe la température qui correspond au sommet de la rampe.
  vec3 fireRamp(float t) {
    vec3 color = mix(vec3(0.0), uFireEndColor, smoothstep(0.05, 0.35, t));
    color = mix(color, uFireMidColor, smoothstep(0.35, 0.65, t));
    color = mix(color, uFireStartColor, smoothstep(0.65, 1.0, t));
    return color;
  }

  // Rotation de teinte autour de l'axe des gris (matrice YIQ), équivalent GLSL
  // du node hue() de TSL utilisé par l'exemple.
  vec3 hueShift(vec3 color, float angle) {
    const vec3 k = vec3(0.57735);
    float c = cos(angle);
    return color * c + cross(k, color) * sin(angle) + k * dot(k, color) * (1.0 - c);
  }

  // Saturation autour de la luminance Rec.709, équivalent du node saturation().
  vec3 adjustSaturation(vec3 color, float amount) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(luma), color, amount);
  }

  // ACES filmic approximée (Narkowicz). Le renderer n'applique aucun tone mapping,
  // or l'émission thermique est en HDR (température non bornée à 1) : sans cette
  // courbe le cœur des flammes clippe en blanc pur.
  vec3 acesFilmic(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  /**
   * ACES appliquée par canal désature : dès que les trois canaux dépassent le
   * coude, n'importe quelle couleur devient blanche — c'est ce qui blanchissait
   * le feu quelles que soient les couleurs de la rampe. Ici la courbe est
   * appliquée au canal MAXIMUM et les rapports entre canaux sont conservés, donc
   * la teinte survit à la surexposition. uColorRetention = 0 redonne le
   * comportement par canal (cœur blanc), 1 conserve la teinte à fond.
   */
  vec3 tonemapKeepHue(vec3 c) {
    float peak = max(max(c.r, c.g), max(c.b, 1e-5));
    vec3 hueSafe = (c / peak) * acesFilmic(vec3(peak)).r;
    return mix(acesFilmic(c), hueSafe, clamp(uColorRetention, 0.0, 1.0));
  }

  void main() {
    vec3 rayDir = normalize(vLocalPosition - vLocalCamPos);
    vec3 bmin = -uVolumeSize * 0.5;
    vec3 bmax = uVolumeSize * 0.5;

    vec2 hit = intersectBox(vLocalCamPos, rayDir, bmin, bmax);

    if (hit.x > hit.y || hit.y < 0.0) {
      discard;
    }

    float tStart = max(hit.x, 0.0);
    float tEnd = hit.y;
    float dist = tEnd - tStart;

    int steps = max(8, min(128, uSteps));
    float stepSize = dist / float(steps);

    // Dithering pour éliminer le tranchage concentrique.
    // Le décalage par nombre d'or au fil des frames décorrèle le motif dans le temps
    // au lieu de figer une trame fixe par pixel.
    float dither = fract(ign(gl_FragCoord.xy) + float(uFrameId) * 0.618033988749895);
    tStart += dither * stepSize;

    vec3 localLightPos = (uInvModelMatrix * vec4(uKeyLightPos, 1.0)).xyz;

    vec4 accumColor = vec4(0.0);
    float transmittance = 1.0;

    for (int i = 0; i < 128; i++) {
      if (i >= steps || transmittance < 0.01) break;

      float t = tStart + float(i) * stepSize;
      vec3 pos = vLocalCamPos + rayDir * t;

      // Coordonnées UVW normalisées [0..1]
      vec3 uvw = (pos - bmin) / uVolumeSize;

      if (uvw.x < 0.0 || uvw.x > 1.0 || uvw.y < 0.0 || uvw.y > 1.0 || uvw.z < 0.0 || uvw.z > 1.0) {
        continue;
      }

      // 1) Domain Warping via texture de vélocité
      vec3 vel = texture(uVelTexture, uvw).xyz;
      vec3 noiseDistortion = (vel / uVolumeSize) * 0.15;
      vec3 distortedUVW = clamp(uvw + noiseDistortion, 0.0, 1.0);

      vec4 sampleVal = texture(uDyeTexture, distortedUVW);
      float density = sampleVal.r;
      float temperature = sampleVal.g;
      float age = sampleVal.b;

      // 2) Bruit de détail Simplex 3D haute fréquence pour les flammèches et volutes.
      //    Il ne défile QUE selon l'âge du fluide : ajouter un terme en uTime le ferait
      //    glisser en espace monde indépendamment du panache (bouillonnement parasite).
      float detailNoise = snoise(pos * 5.5 - vec3(0.0, age * 0.8, 0.0));
      density *= (detailNoise * 0.35 + 0.85);

      // 3) Adoucissement des bordures de la boîte
      vec3 edge = min(distortedUVW, vec3(1.0) - distortedUVW);
      density *= smoothstep(0.0, 0.06, min(edge.x, min(edge.y, edge.z)));

      if (density > 0.003 || temperature > 0.005) {
        // 4) Auto-ombrage de la lumière clé (Key-light Self-Shadowing 2 passes)
        vec3 lightDir = normalize(localLightPos - pos);
        float shadowDensitySum = 0.0;
        float shadowStepSize = 0.35;
        for (int s = 0; s < MAX_SHADOW_STEPS; s++) {
          if (s >= uShadowSteps) break;
          float stepDist = (float(s) + 0.5) * shadowStepSize;
          vec3 sPos = pos + lightDir * stepDist;
          vec3 sUVW = (sPos - bmin) / uVolumeSize;
          if (sUVW.x >= 0.0 && sUVW.x <= 1.0 && sUVW.y >= 0.0 && sUVW.y <= 1.0 && sUVW.z >= 0.0 && sUVW.z <= 1.0) {
            vec3 sEdge = min(sUVW, vec3(1.0) - sUVW);
            float sFade = smoothstep(0.0, 0.06, min(sEdge.x, min(sEdge.y, sEdge.z)));
            shadowDensitySum += texture(uDyeTexture, sUVW).r * sFade;
          }
        }

        float tau = shadowDensitySum * shadowStepSize * uShadowAbsorption;
        float beer = exp(-tau);
        float multiScatter = exp(-tau * 0.25) * 0.5;
        float baseTrans = mix(beer, beer + multiScatter, uMultiScattering);
        float powder = 1.0 - exp(-tau * 2.0);
        float finalTrans = mix(baseTrans, baseTrans * powder, uPowderStrength);
        float lightTrans = clamp(finalTrans + uShadowAmbient, 0.0, 1.0);

        // Fonction de phase Henyey-Greenstein (diffusion vers l'avant de la fumée)
        vec3 viewDir = normalize(vLocalCamPos - pos);
        float cosTheta = clamp(dot(viewDir, lightDir), -1.0, 1.0);
        float g = clamp(uAsymmetry, -0.99, 0.99);
        float denom = 1.0 + g * g - 2.0 * g * cosTheta;
        float phase = (1.0 - g * g) / pow(denom, 1.5) * 0.079577;

        // Éclairage de la fumée : lumière clé ombrée + ambiante + reflet chaud du feu.
        // L'ambiante est ATTÉNUÉE par la transmittance : une constante non ombrée
        // faisait briller en blanc le moindre voile de fumée diffusé dans la boîte.
        // Gain 8.5 constant et SANS atténuation de distance : toute la fumée de la
        // boîte recevait le même éclairage bleuté à pleine puissance, d'où le
        // panache blanc quelle que soit sa hauteur. Ici l'intensité de la lumière
        // clé est un paramètre et décroît en 1/d², comme une vraie ponctuelle.
        float lightDist = max(length(localLightPos - pos), 0.05);
        float keyFalloff = uKeyLightIntensity / (lightDist * lightDist);
        vec3 smokeKeyLight = vec3(0.9, 0.92, 0.98) * (lightTrans * phase * 12.56637 * keyFalloff);
        vec3 smokeAmbient = vec3(0.5, 0.52, 0.58) * uSmokeAmbient * lightTrans;
        vec3 smokeFireGlow = fireRamp(clamp(temperature / uFireRampScale, 0.0, 1.0)) * 2.5;
        vec3 smokeScattering = (smokeKeyLight + smokeAmbient + smokeFireGlow) * density;

        // 5) Émission thermique Corps Noir (Flammes incandescentes).
        //    Couleur ET intensité sont pilotées par la MÊME température normalisée.
        //    Avec la température brute (bornée à 12 par le solveur) l'émission
        //    atteignait plusieurs centaines : après ACES les trois canaux
        //    saturaient et la flamme entière virait au blanc quelle que soit la
        //    rampe. Normalisée, elle plafonne à uFireIntensity * (Tmax/scale)^p.
        float firePower = max(1.0, 6.0 - uFireGlowSpread);
        float tNorm = max(temperature, 0.0) / uFireRampScale;
        vec3 fire = fireRamp(clamp(tNorm, 0.0, 1.0)) * pow(tNorm, firePower) * uFireIntensity;
        fire = hueShift(adjustSaturation(fire, uSaturation), uFireHue);
        vec3 fireEmissive = fire * (density + 0.15);

        // Intégration de radiance et de transmittance
        vec3 stepRadiance = fireEmissive * 0.02 + smokeScattering * 0.018;
        float stepAbsorption = density * 0.035;
        float stepTransmittance = exp(-stepAbsorption * stepSize);

        accumColor.rgb += stepRadiance * transmittance * stepSize;
        accumColor.a += (1.0 - stepTransmittance) * transmittance;
        transmittance *= stepTransmittance;
      }
    }

    if (accumColor.r + accumColor.g + accumColor.b <= 0.001) {
      discard;
    }

    // Montée en puissance sur les premières secondes, comme l'exemple : au
    // démarrage la grille est vide et le premier souffle de matière ne doit pas
    // surgir d'un coup.
    vec3 mapped = tonemapKeepHue(accumColor.rgb * uExposure * uFadeIn);
    gl_FragColor = vec4(mapped, 1.0);
  }
`;

/**
 * Crée un matériau ShaderMaterial raymarché pour le volume
 */
export function createVolumetricShaderMaterial(
  dyeTexture: THREE.Data3DTexture,
  config: FluidGridConfig = DEFAULT_GRID_CONFIG,
  velTexture?: THREE.Data3DTexture
): THREE.ShaderMaterial {
  const dummyVel = velTexture || new THREE.Data3DTexture(new Float32Array(4), 1, 1, 1);
  dummyVel.needsUpdate = true;

  const mat = new THREE.ShaderMaterial({
    vertexShader: VOLUME_RAYMARCH_VERTEX_SHADER,
    fragmentShader: VOLUME_RAYMARCH_FRAGMENT_SHADER,
    uniforms: {
      uDyeTexture: { value: dyeTexture },
      uVelTexture: { value: dummyVel },
      uInvModelMatrix: { value: new THREE.Matrix4() },
      uTime: { value: 0 },
      uVolumeSize: { value: config.worldSize.clone() },
      uKeyLightPos: { value: new THREE.Vector3(0, 10, 5) },
      uFireIntensity: { value: 20.0 },
      uShadowAbsorption: { value: 2.0 },
      uPowderStrength: { value: 0.59 },
      uFireGlowSpread: { value: 5.0 },
      uFireStartColor: { value: new THREE.Color(0xffe68c) },
      uFireMidColor: { value: new THREE.Color(0xff7305) },
      uFireEndColor: { value: new THREE.Color(0xff0000) },
      uSteps: { value: 48 },
      uFrameId: { value: 0 },
      uExposure: { value: 1.4 },
      uFireRampScale: { value: 8.0 },
      uKeyLightIntensity: { value: 100.0 },
      uColorRetention: { value: 0.85 },
      uAsymmetry: { value: 0.0 },
      uMultiScattering: { value: 1.0 },
      uShadowAmbient: { value: 0.5 },
      uFireHue: { value: 0.0 },
      uSaturation: { value: 1.1 },
      uSmokeAmbient: { value: 1.0 },
      uFadeIn: { value: 1.0 },
      uShadowSteps: { value: 2 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide, // Permet à la caméra d'entrer à l'intérieur de la boîte
    blending: THREE.AdditiveBlending,
  });

  mat.onBeforeRender = (_renderer, _scene, _camera, _geometry, object) => {
    mat.uniforms.uInvModelMatrix.value.copy(object.matrixWorld).invert();
  };

  return mat;
}
