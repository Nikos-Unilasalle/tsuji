import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { growingSockets } from "../dynamicInputs";
import { STEP_SECONDS, stepsSince } from "../clock";
import { toBoolean } from "../sockets";
import { asColor, numberInput } from "./object";
import { composeNativeMatrix } from "./transform";
import { LAYER_VOLUMETRIC } from "../../three/volumetricPass";

import {
  createFluidSimulationState,
  DEFAULT_GRID_CONFIG,
  DEFAULT_FLUID_PARAMS,
  FluidEmitterDescriptor,
  FluidForceField,
  FluidGridConfig,
  FluidSimulationState,
  stepFluidSimulation,
  createVolumetricShaderMaterial,
  generateCurlNoiseField3D,
} from "../../three/fluid/fluidRuntime3D";
import {
  createFluidGPUState,
  FluidGPUState,
  isFluidGPUSupported,
  stepFluidSimulationGPU,
} from "../../three/fluid/fluidRuntimeGPU";

/**
 * Le solveur GPU est ~un ordre de grandeur plus rapide mais exige WebGL2 et le
 * rendu vers cible demi-flottante. "auto" prend le GPU quand il est disponible et
 * retombe silencieusement sur le CPU sinon (tests headless, export, WebGL1).
 */
type SolverBackend = "auto" | "gpu" | "cpu";

/**
 * Le repli GPU -> CPU est silencieux par conception, ce qui rend un mauvais
 * backend indétectable : la sim tourne, juste beaucoup plus lentement. Une ligne
 * par transition (pas par frame) suffit à lever le doute.
 */
let lastLoggedBackend: string | null = null;

function resolveBackend(
  params: Record<string, unknown>,
  renderer: THREE.WebGLRenderer | undefined
): "gpu" | "cpu" {
  const requested = (params.solver as SolverBackend) ?? "auto";
  const supported = isFluidGPUSupported(renderer);
  const backend = requested === "cpu" || !supported ? "cpu" : "gpu";

  const signature = `${requested}:${backend}:${supported}`;
  if (renderer && signature !== lastLoggedBackend) {
    lastLoggedBackend = signature;
    console.info(
      `[fluid] solveur ${backend.toUpperCase()} (demandé: ${requested}, GPU disponible: ${supported})`
    );
  }
  return backend;
}

/**
 * Rattrapage maximal après une pause ou un scrub, volontairement à 1 : sur le
 * backend CPU un pas coûte ~37 ms sur le thread principal, donc rattraper le
 * temps perdu rendrait la frame suivante encore plus lente, qui demanderait
 * encore plus de rattrapage — spirale garantie. La simulation prend du retard
 * sur l'horloge quand la machine sature, ce qui est le bon compromis pour un
 * éditeur interactif ; Simulation Speed est là pour compenser.
 */
const MAX_CATCHUP_STEPS = 1;

/** Préfixe des sockets Force Field croissants, même convention que particles/simulate. */
const FIELD_PREFIX = "field";

/**
 * Récupère les champs de force branchés sur les sockets croissants, triés par
 * index de socket — l'ordre des clés d'un objet ne garantit pas "field10" > "field9".
 */
function collectForceFields(inputs: Record<string, unknown>): FluidForceField[] {
  return Object.entries(inputs)
    .filter(([key, value]) => key.startsWith(FIELD_PREFIX) && value)
    .sort(([a], [b]) => Number(a.slice(FIELD_PREFIX.length)) - Number(b.slice(FIELD_PREFIX.length)))
    .map(([, value]) => value as FluidForceField)
    .filter((f) => f && typeof f === "object" && f.position instanceof THREE.Vector3);
}

/** Sockets Force Field croissants — toujours exactement un vide en fin de liste. */
function forceFieldSockets(connections: Parameters<typeof growingSockets>[0]) {
  return growingSockets(connections, FIELD_PREFIX, (i) => ({
    id: `${FIELD_PREFIX}${i}`,
    label: `Force Field ${i + 1}`,
    type: "any" as const,
  }));
}

/**
 * Construit la config de grille depuis les entrées du node.
 *
 * Le solveur tourne en JS sur le thread principal : une grille non bornée fige
 * l'éditeur sans le moindre message d'erreur. Bornes calées sur des mesures
 * réelles du coût d'un pas complet (advection + Jacobi + projection) :
 *
 *   32x64x32 =  66k cellules -> ~26 ms/pas
 *   40x80x40 = 128k cellules -> ~67 ms/pas
 *   48x96x48 = 221k cellules -> ~106 ms/pas
 *   64x64x64 = 262k cellules -> ~127 ms/pas
 *
 * Le défaut (66k) consomme déjà la quasi-totalité d'un budget de frame à 60 Hz
 * sur CPU, d'où un plafond bas. Mesuré côté GPU sur la même machine (M1) :
 *
 *    32x64x32  =   66k cellules ->  1.13 ms/pas   (54.8 ms en CPU, soit 26x)
 *    64x128x64 =  524k cellules ->  1.84 ms/pas
 *    96x192x96 = 1769k cellules ->  9.95 ms/pas
 *   100x100x200 = 2000k cellules -> 91.92 ms/pas
 *
 * Le dernier point est l'enseignement majeur : il a MOINS de cellules que rien
 * de plus que le précédent mais coûte 9x, parce qu'il a 200 tranches Z au lieu
 * de 96. Chaque passe émet un draw call par tranche, donc le coût est piloté par
 * gridZ, pas par le nombre de cellules. Une grille large et peu profonde est
 * bien plus rapide qu'une grille fine et profonde à volume égal — d'où un
 * plafond distinct, et plus bas, sur l'axe Z.
 */
const MAX_AXIS_RESOLUTION_CPU = 64;
const MAX_CELL_COUNT_CPU = 150_000;
const MAX_AXIS_RESOLUTION_GPU = 256;
/** Le coût GPU est linéaire en nombre de tranches : cet axe se borne à part. */
const MAX_DEPTH_RESOLUTION_GPU = 128;
const MAX_CELL_COUNT_GPU = 2_000_000;

function resolveGridConfig(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  backend: "gpu" | "cpu" = "cpu"
): FluidGridConfig {
  const MAX_AXIS_RESOLUTION = backend === "gpu" ? MAX_AXIS_RESOLUTION_GPU : MAX_AXIS_RESOLUTION_CPU;
  const MAX_CELL_COUNT = backend === "gpu" ? MAX_CELL_COUNT_GPU : MAX_CELL_COUNT_CPU;
  const size = asVector3(inputs.boxSize, asVector3(params.boxSize, DEFAULT_GRID_CONFIG.worldSize));
  const res = asVector3(inputs.resolution, asVector3(params.resolution, new THREE.Vector3(32, 64, 32)));

  const axis = (v: number, fallback: number, cap = MAX_AXIS_RESOLUTION) => {
    const n = Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.max(4, Math.min(cap, n));
  };
  let gridX = axis(res.x, 32);
  let gridY = axis(res.y, 64);
  let gridZ = axis(
    res.z,
    32,
    backend === "gpu" ? MAX_DEPTH_RESOLUTION_GPU : MAX_AXIS_RESOLUTION
  );

  // Réduction proportionnelle plutôt que rejet : l'utilisateur voit une grille
  // plus grossière, pas un éditeur bloqué.
  const total = gridX * gridY * gridZ;
  if (total > MAX_CELL_COUNT) {
    const k = Math.cbrt(MAX_CELL_COUNT / total);
    gridX = Math.max(4, Math.floor(gridX * k));
    gridY = Math.max(4, Math.floor(gridY * k));
    gridZ = Math.max(4, Math.floor(gridZ * k));
  }

  return {
    gridX,
    gridY,
    gridZ,
    worldSize: new THREE.Vector3(
      Math.max(0.01, size.x),
      Math.max(0.01, size.y),
      Math.max(0.01, size.z)
    ),
  };
}

/** Une grille de résolution différente impose de tout réallouer ; la taille monde non. */
function gridResolutionChanged(a: FluidGridConfig, b: FluidGridConfig): boolean {
  return a.gridX !== b.gridX || a.gridY !== b.gridY || a.gridZ !== b.gridZ;
}

/**
 * Position monde de la lumière clé qui éclaire et auto-ombre le volume.
 *
 * L'uniforme uKeyLightPos existait depuis le début mais AUCUN node ne l'écrivait :
 * il gardait la valeur (0, 10, 5) de son constructeur, donc la direction
 * d'ombrage de la fumée n'avait aucun rapport avec l'éclairage réel de la scène.
 * Un objet branché (une Light est de type `geometry` dans ce graphe) donne sa
 * position monde ; sinon le vecteur du paramètre sert de repli.
 */
function resolveKeyLightPos(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>
): THREE.Vector3 {
  if (inputs.keyLight instanceof THREE.Object3D) {
    inputs.keyLight.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(inputs.keyLight.matrixWorld);
  }
  return asVector3(inputs.keyLightPos, asVector3(params.keyLightPos, new THREE.Vector3(0, 10, 5))).clone();
}

/**
 * Matrice du volume. L'ancrage au sol translate la boîte d'une demi-hauteur
 * vers le haut *après* la matrice de l'utilisateur, si bien que l'origine du
 * node est la base du feu et non son centre — c'est ce qu'on veut pour un foyer,
 * et ça reproduit l'ancien `mesh.position.y = worldSize.y / 2` codé en dur.
 */
function composeVolumeMatrix(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  worldSize: THREE.Vector3
): THREE.Matrix4 {
  const base = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);
  if (params.groundAnchor === false) return base;
  return base.multiply(new THREE.Matrix4().makeTranslation(0, worldSize.y / 2, 0));
}

// -----------------------------------------------------------------
// Caches avec libération automatique conforme P0 VRAM Protocol
// -----------------------------------------------------------------
const simStateCache = createNodeCache<FluidSimulationState>((s) => s.dispose());
const volumeMeshCache = createNodeCache<THREE.Mesh>(disposeObject3D);
const macroSimCache = createNodeCache<{
  /**
   * Solveur CPU. Nul quand le backend GPU est actif : ses buffers pèsent
   * cellCount * 15 flottants plus deux Data3DTexture, alloués pour rien si le
   * GPU fait le travail.
   */
  sim: FluidSimulationState | null;
  /** Miroir GPU du solveur ; présent seulement quand le backend GPU est actif. */
  gpu: FluidGPUState | null;
  /** Config de grille en vigueur, quel que soit le backend. */
  config: FluidGridConfig;
  /** Backend effectivement utilisé au dernier pas — un changement force la reconstruction. */
  backend: "gpu" | "cpu";
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  /** Dernière taille monde appliquée à la géométrie de boîte, pour ne la reconstruire qu'au changement. */
  boxSize: THREE.Vector3;
  /** Position monde de l'émetteur au pas précédent, source de sa vélocité. */
  prevEmitterPos: THREE.Vector3 | null;
  /** Temps de simulation accumulé, découplé de ctx.time par la vitesse de simulation. */
  simTime: number;
  /** Dernier ctx.step simulé, pour le rattrapage borné après un scrub. */
  lastStep: number;
  /** Cylindre de repli, alloué une seule fois quand aucun maillage n'est branché. */
  fallbackEmitter?: THREE.BufferGeometry;
}>((s) => {
  s.sim?.dispose();
  s.gpu?.dispose();
  disposeObject3D(s.mesh);
  disposeObject3D(s.light);
  s.fallbackEmitter?.dispose();
});
const curlCache = createNodeCache<{ texture: THREE.Data3DTexture }>((c) => c.texture.dispose());
/** Position monde de l'émetteur au pas précédent, pour en dériver sa vitesse. */
const emitterMotionCache = createNodeCache<THREE.Vector3>();

function asVector3(v: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (v instanceof THREE.Vector3) return v;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const x = Number(obj.x);
    const y = Number(obj.y);
    const z = Number(obj.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return new THREE.Vector3(x, y, z);
    }
  }
  return fallback;
}

// =================================================================
// 1. physics/curl-noise-3d (Bruit Vectoriel 3D sans Divergence)
// =================================================================
export const CURL_NOISE_FIELD_3D_NODE: NodeDefinition = {
  type: "physics/curl-noise-3d",
  label: "Curl Noise 3D (Fluid Turbulence)",
  category: "physics",
  inputs: [
    { id: "frequency", label: "Frequency", type: "value" },
    { id: "amplitude", label: "Amplitude", type: "value" },
    { id: "speed", label: "Speed", type: "value" },
  ],
  outputs: [
    { id: "texture", label: "Vector Texture 3D", type: "texture" },
    { id: "field", label: "Force Field", type: "any" },
  ],
  defaultParams: {
    frequency: 10.0,
    amplitude: 3.2,
    speed: 0.5,
  },
  paramFields: [
    { id: "frequency", label: "Frequency", kind: "number", step: 0.5 },
    { id: "amplitude", label: "Amplitude", kind: "number", step: 0.2 },
    { id: "speed", label: "Speed", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const frequency = Math.max(0.1, numberInput(inputs.frequency, params.frequency, 10.0));
    const amplitude = numberInput(inputs.amplitude, params.amplitude, 3.2);
    const speed = numberInput(inputs.speed, params.speed, 0.5);

    let cached = curlCache.get(ctx.nodeId);
    if (!cached) {
      const grid = { gridX: 32, gridY: 32, gridZ: 32, worldSize: new THREE.Vector3(10, 10, 10) };
      const rawData = generateCurlNoiseField3D(grid, frequency, amplitude);
      const rgbaData = new Float32Array(grid.gridX * grid.gridY * grid.gridZ * 4);
      let idx3 = 0;
      let idx4 = 0;
      const count = grid.gridX * grid.gridY * grid.gridZ;
      for (let i = 0; i < count; i++) {
        rgbaData[idx4] = rawData[idx3];
        rgbaData[idx4 + 1] = rawData[idx3 + 1];
        rgbaData[idx4 + 2] = rawData[idx3 + 2];
        rgbaData[idx4 + 3] = 1.0;
        idx3 += 3;
        idx4 += 4;
      }
      const texture = new THREE.Data3DTexture(rgbaData, grid.gridX, grid.gridY, grid.gridZ);
      texture.format = THREE.RGBAFormat;
      texture.type = THREE.FloatType;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      cached = { texture };
      curlCache.set(ctx.nodeId, cached);
    }

    return {
      texture: cached.texture,
      field: {
        type: "curl_noise_3d",
        frequency,
        amplitude,
        speed,
        time: ctx.time,
      },
    };
  },
};

// =================================================================
// 2. physics/mesh-fluid-emitter (Émetteur Géométrique)
// =================================================================
export const MESH_FLUID_EMITTER_NODE: NodeDefinition = {
  type: "physics/mesh-fluid-emitter",
  label: "Mesh Fluid Emitter (Fire & Smoke)",
  category: "physics",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "density", label: "Density Rate", type: "value" },
    { id: "temperature", label: "Temperature", type: "value" },
    { id: "motionBoost", label: "Movement Boost", type: "value" },
    { id: "windStrength", label: "Movement Wind Strength", type: "value" },
    { id: "normalizeEmission", label: "Normalize Emission", type: "value" },
    { id: "radius", label: "Radius", type: "value" },
  ],
  outputs: [{ id: "emitter", label: "Fluid Emitter", type: "any" }],
  defaultParams: {
    density: 7.0,
    temperature: 5.5,
    motionBoost: 0.25,
    windStrength: 6.5,
    windRadius: 1.0,
    radius: 0.3,
    normalizeEmission: true,
  },
  paramFields: [
    { id: "density", label: "Density Rate", kind: "number", step: 0.5 },
    { id: "temperature", label: "Temperature Rate", kind: "number", step: 0.5 },
    { id: "radius", label: "Radius", kind: "number", step: 0.1 },
    { id: "motionBoost", label: "Movement Boost", kind: "number", step: 0.01, group: "Movement" },
    { id: "windStrength", label: "Movement Wind Strength", kind: "number", step: 0.5, group: "Movement" },
    { id: "windRadius", label: "Movement Wind Radius", kind: "number", step: 0.1, group: "Movement" },
    { id: "normalizeEmission", label: "Normalize Emission (mesh-independent)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const geo = inputs.geometry instanceof THREE.Object3D || inputs.geometry instanceof THREE.BufferGeometry
      ? inputs.geometry
      : new THREE.SphereGeometry(0.5, 16, 16);

    const density = Math.max(0, numberInput(inputs.density, params.density, 7.0));
    const temperature = Math.max(0, numberInput(inputs.temperature, params.temperature, 5.5));
    const motionBoost = numberInput(inputs.motionBoost, params.motionBoost, 0.25);
    const windStrength = numberInput(inputs.windStrength, params.windStrength, 6.5);
    const windRadius = Math.max(0.01, numberInput(inputs.windRadius, params.windRadius, 1.0));
    const radius = Math.max(0, numberInput(inputs.radius, params.radius, 0.3));

    // Position et vitesse monde, comme la macro. Sans elles, motionBoost et le
    // vent de déplacement restaient morts sur le chemin modulaire
    // (mesh-fluid-emitter -> fluid-solver-3d) alors qu'ils vivaient sur la macro.
    const position = new THREE.Vector3();
    if (inputs.geometry instanceof THREE.Object3D) {
      inputs.geometry.updateWorldMatrix(true, false);
      position.setFromMatrixPosition(inputs.geometry.matrixWorld);
    }

    const prev = emitterMotionCache.get(ctx.nodeId);
    const velocity = prev
      ? position.clone().sub(prev).divideScalar(STEP_SECONDS)
      : new THREE.Vector3();
    emitterMotionCache.set(ctx.nodeId, position.clone());

    const emitter: FluidEmitterDescriptor = {
      geometry: geo,
      density,
      temperature,
      motionBoost,
      radius,
      position,
      velocity,
      speed: velocity.length(),
      windStrength,
      windRadius,
      normalizeEmission: inputs.normalizeEmission !== undefined
        ? toBoolean(inputs.normalizeEmission)
        : params.normalizeEmission !== false,
    };

    return { emitter };
  },
};

// =================================================================
// 3. physics/fluid-solver-3d (Solveur Navier-Stokes 3D)
// =================================================================
const SOLVER_FIXED_INPUTS = [
  { id: "emitter", label: "Emitter", type: "any" as const },
  { id: "matrix", label: "Matrix", type: "matrix" as const },
  { id: "boxSize", label: "Box Size", type: "vector" as const },
  { id: "resolution", label: "Resolution", type: "vector" as const },
  { id: "buoyancy", label: "Buoyancy", type: "value" as const },
  { id: "cooling", label: "Cooling Rate", type: "value" as const },
  { id: "dissipation", label: "Dissipation", type: "value" as const },
  { id: "wind", label: "Wind Vector", type: "vector" as const },
  { id: "jacobiSteps", label: "Pressure Iterations", type: "value" as const },
];

export const FLUID_SOLVER_3D_NODE: NodeDefinition = {
  type: "physics/fluid-solver-3d",
  label: "Fluid Solver 3D (Fire & Smoke)",
  category: "physics",
  inputs: [
    ...SOLVER_FIXED_INPUTS,
    { id: `${FIELD_PREFIX}0`, label: "Force Field 1", type: "any" },
  ],
  dynamicInputs: (connections) => [...SOLVER_FIXED_INPUTS, ...forceFieldSockets(connections)],
  outputs: [
    { id: "velocityField", label: "Velocity Field", type: "texture" },
    { id: "dyeField", label: "Dye Field (RGBA)", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    boxSize: DEFAULT_GRID_CONFIG.worldSize.clone(),
    resolution: new THREE.Vector3(32, 64, 32),
    groundAnchor: true,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    buoyancy: 3.0,
    cooling: 1.0,
    dissipation: 0.4,
    wind: new THREE.Vector3(0, 0, 0),
    jacobiSteps: 4,
  },
  paramFields: [
    { id: "boxSize", label: "Box Size (world)", kind: "vector", group: "Simulation Box" },
    { id: "resolution", label: "Resolution (voxels)", kind: "vector", group: "Simulation Box" },
    { id: "groundAnchor", label: "Anchor To Ground", kind: "boolean", group: "Simulation Box" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
    { id: "buoyancy", label: "Buoyancy", kind: "number", step: 0.2 },
    { id: "cooling", label: "Cooling Rate", kind: "number", step: 0.1 },
    { id: "dissipation", label: "Dissipation", kind: "number", step: 0.05 },
    { id: "wind", label: "Wind Vector", kind: "vector" },
    { id: "jacobiSteps", label: "Pressure Iterations", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const config = resolveGridConfig(inputs, params);

    let state = simStateCache.get(ctx.nodeId);
    if (state && gridResolutionChanged(state.config, config)) {
      state.dispose();
      simStateCache.delete(ctx.nodeId);
      state = undefined;
    }
    if (!state) {
      state = createFluidSimulationState(config);
      simStateCache.set(ctx.nodeId, state);
    }
    state.config.worldSize.copy(config.worldSize);

    const volumeMatrix = composeVolumeMatrix(inputs, params, config.worldSize);
    const worldToVolume = new THREE.Matrix4().copy(volumeMatrix).invert();

    const buoyancy = numberInput(inputs.buoyancy, params.buoyancy, 3.0);
    const cooling = Math.max(0, numberInput(inputs.cooling, params.cooling, 1.0));
    const dissipation = Math.max(0, numberInput(inputs.dissipation, params.dissipation, 0.4));
    const wind = asVector3(inputs.wind, asVector3(params.wind, new THREE.Vector3()));
    const jacobiIterations = Math.max(1, Math.min(16, numberInput(inputs.jacobiSteps, params.jacobiSteps, 4)));

    const simParams = {
      ...DEFAULT_FLUID_PARAMS,
      dt: 0.016,
      time: ctx.time,
      buoyancy,
      cooling,
      dissipation,
      wind,
      jacobiIterations,
      worldToVolume,
      volumeToWorld: volumeMatrix,
    };

    // Récupérer les émetteurs
    const emitters: FluidEmitterDescriptor[] = [];
    if (inputs.emitter && typeof inputs.emitter === "object") {
      if ("geometry" in (inputs.emitter as Record<string, unknown>)) {
        emitters.push(inputs.emitter as FluidEmitterDescriptor);
      }
    }

    stepFluidSimulation(state, simParams, emitters, collectForceFields(inputs));

    return {
      velocityField: state.velTexture,
      dyeField: state.dyeTexture,
      matrix: volumeMatrix.clone(),
    };
  },
};

// =================================================================
// 4. texture/volume-material-3d (Matériau Volumétrique Raymarché)
// =================================================================
export const VOLUME_MATERIAL_3D_NODE: NodeDefinition = {
  type: "material/volume-3d",
  label: "Volume Material 3D (Fire Raymarcher)",
  category: "physics",
  inputs: [
    { id: "dyeField", label: "Dye Field (3D Texture)", type: "texture" },
    { id: "velocityField", label: "Velocity Field (3D Texture)", type: "texture" },
    { id: "keyLight", label: "Key Light", type: "geometry" },
    { id: "keyLightPos", label: "Key Light Position", type: "vector" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "boxSize", label: "Box Size", type: "vector" },
    { id: "fireIntensity", label: "Fire Intensity", type: "value" },
    { id: "shadowAbsorption", label: "Shadow Absorption", type: "value" },
    { id: "powderStrength", label: "Powder Strength", type: "value" },
    { id: "glowSpread", label: "Glow Spread", type: "value" },
    { id: "rampScale", label: "Fire Ramp Scale", type: "value" },
    { id: "steps", label: "Raymarch Steps", type: "value" },
    { id: "exposure", label: "Exposure", type: "value" },
    { id: "startColor", label: "Fire Start Color", type: "color" },
    { id: "midColor", label: "Fire Mid Color", type: "color" },
    { id: "endColor", label: "Fire End Color", type: "color" },
  ],
  outputs: [
    { id: "geometry", label: "Volume Mesh", type: "geometry" },
    { id: "material", label: "Material", type: "material" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    boxSize: DEFAULT_GRID_CONFIG.worldSize.clone(),
    groundAnchor: true,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    keyLightPos: new THREE.Vector3(0, 10, 5),
    shadowSteps: 2,
    keyLightIntensity: 100.0,
    colorRetention: 0.85,
    fireIntensity: 20.0,
    shadowAbsorption: 2.0,
    powderStrength: 0.59,
    glowSpread: 5.0,
    rampScale: 8.0,
    steps: 48,
    exposure: 1.4,
    startColor: new THREE.Color(0xffe68c),
    midColor: new THREE.Color(0xff7305),
    endColor: new THREE.Color(0xff0000),
  },
  paramFields: [
    { id: "boxSize", label: "Box Size (world)", kind: "vector", group: "Simulation Box" },
    { id: "groundAnchor", label: "Anchor To Ground", kind: "boolean", group: "Simulation Box" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
    { id: "keyLightPos", label: "Key Light Position", kind: "vector", group: "Lighting" },
    { id: "shadowSteps", label: "Shadow Steps", kind: "number", step: 1, group: "Lighting" },
    { id: "keyLightIntensity", label: "Key Light Intensity", kind: "number", step: 10, group: "Lighting" },
    { id: "fireIntensity", label: "Fire Intensity", kind: "number", step: 5.0 },
    { id: "shadowAbsorption", label: "Shadow Absorption", kind: "number", step: 0.2 },
    { id: "powderStrength", label: "Powder Strength", kind: "number", step: 0.05 },
    { id: "glowSpread", label: "Glow Spread", kind: "number", step: 0.5 },
    { id: "rampScale", label: "Fire Ramp Scale (temp)", kind: "number", step: 0.5 },
    { id: "steps", label: "Raymarch Steps", kind: "number", step: 4 },
    { id: "exposure", label: "Exposure", kind: "number", step: 0.1 },
    { id: "colorRetention", label: "Color Retention (anti-white)", kind: "number", step: 0.05 },
    { id: "startColor", label: "Fire Start Color", kind: "color" },
    { id: "midColor", label: "Fire Mid Color", kind: "color" },
    { id: "endColor", label: "Fire End Color", kind: "color" },
  ],
  evaluate: (inputs, params, ctx) => {
    const boxSize = asVector3(inputs.boxSize, asVector3(params.boxSize, DEFAULT_GRID_CONFIG.worldSize));
    const size = new THREE.Vector3(
      Math.max(0.01, boxSize.x),
      Math.max(0.01, boxSize.y),
      Math.max(0.01, boxSize.z)
    );

    let mesh = volumeMeshCache.get(ctx.nodeId);
    if (!mesh) {
      const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
      const dummyTex = new THREE.Data3DTexture(new Float32Array(32 * 32 * 32 * 4), 32, 32, 32);
      dummyTex.needsUpdate = true;
      const mat = createVolumetricShaderMaterial(dummyTex, { ...DEFAULT_GRID_CONFIG, worldSize: size.clone() });
      mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      volumeMeshCache.set(ctx.nodeId, mesh);
    }

    const mat = mesh.material as THREE.ShaderMaterial;
    if (!(mat.uniforms.uVolumeSize.value as THREE.Vector3).equals(size)) {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
      (mat.uniforms.uVolumeSize.value as THREE.Vector3).copy(size);
    }

    if (inputs.dyeField instanceof THREE.Data3DTexture) {
      mat.uniforms.uDyeTexture.value = inputs.dyeField;
    }
    if (inputs.velocityField instanceof THREE.Data3DTexture) {
      mat.uniforms.uVelTexture.value = inputs.velocityField;
    }

    mat.uniforms.uTime.value = ctx.time;
    mat.uniforms.uFrameId.value = ctx.step;
    mat.uniforms.uExposure.value = numberInput(inputs.exposure, params.exposure, 1.4);
    mesh.matrix.copy(composeVolumeMatrix(inputs, params, size));
    mesh.updateMatrixWorld(true);
    mat.uniforms.uInvModelMatrix.value.copy(mesh.matrixWorld).invert();

    mat.uniforms.uFireIntensity.value = numberInput(inputs.fireIntensity, params.fireIntensity, 20.0);
    mat.uniforms.uKeyLightPos.value.copy(resolveKeyLightPos(inputs, params));
    mat.uniforms.uShadowSteps.value = Math.max(0, Math.min(8, Math.round(numberInput(inputs.shadowSteps, params.shadowSteps, 2))));
    mat.uniforms.uShadowAbsorption.value = numberInput(inputs.shadowAbsorption, params.shadowAbsorption, 2.0);
    mat.uniforms.uKeyLightIntensity.value = Math.max(0, numberInput(inputs.keyLightIntensity, params.keyLightIntensity, 100.0));
    mat.uniforms.uColorRetention.value = numberInput(inputs.colorRetention, params.colorRetention, 0.85);
    mat.uniforms.uPowderStrength.value = numberInput(inputs.powderStrength, params.powderStrength, 0.59);
    mat.uniforms.uFireGlowSpread.value = numberInput(inputs.glowSpread, params.glowSpread, 5.0);
    mat.uniforms.uFireRampScale.value = Math.max(0.05, numberInput(inputs.rampScale, params.rampScale, 8.0));
    mat.uniforms.uSteps.value = Math.max(8, Math.min(128, numberInput(inputs.steps, params.steps, 48)));
    mat.uniforms.uFireStartColor.value = asColor(inputs.startColor, params.startColor as THREE.Color);
    mat.uniforms.uFireMidColor.value = asColor(inputs.midColor, params.midColor as THREE.Color);
    mat.uniforms.uFireEndColor.value = asColor(inputs.endColor, params.endColor as THREE.Color);

    return {
      geometry: mesh,
      material: {
        color: new THREE.Color(0xff7305),
        emissive: new THREE.Color(0xff0000),
        emissiveIntensity: 1.0,
        shadeless: true,
        roughness: 1.0,
        metalness: 0.0,
        wireframe: false,
        opacity: 0.8,
        transmission: 0.0,
        thickness: 0.0,
      },
      matrix: mesh.matrixWorld.clone(),
    };
  },
};

// =================================================================
// 5. simulation/fire-fluid-volume (Macro Tout-en-Un : Brasier Volumétrique)
// =================================================================
const MACRO_FIXED_INPUTS = [
  { id: "emitterMesh", label: "Emitter Mesh", type: "geometry" as const },
  { id: "keyLight", label: "Key Light", type: "geometry" as const },
  { id: "keyLightPos", label: "Key Light Position", type: "vector" as const },
  { id: "matrix", label: "Matrix", type: "matrix" as const },
  { id: "boxSize", label: "Box Size", type: "vector" as const },
  { id: "resolution", label: "Resolution", type: "vector" as const },
  { id: "simulate", label: "Simulate", type: "value" as const },
  { id: "simSpeed", label: "Simulation Speed", type: "value" as const },
  { id: "density", label: "Density Rate", type: "value" as const },
  { id: "temperature", label: "Temperature Rate", type: "value" as const },
  { id: "emitterRadius", label: "Emitter Radius", type: "value" as const },
  { id: "motionBoost", label: "Movement Boost", type: "value" as const },
  { id: "windStrength", label: "Movement Wind Strength", type: "value" as const },
  { id: "normalizeEmission", label: "Normalize Emission", type: "value" as const },
  { id: "buoyancy", label: "Buoyancy", type: "value" as const },
  { id: "smokeWeight", label: "Smoke Weight", type: "value" as const },
  { id: "velocityDamping", label: "Velocity Damping", type: "value" as const },
  { id: "fireLifespan", label: "Fire Lifespan", type: "value" as const },
  { id: "smokeLifespan", label: "Smoke Lifespan", type: "value" as const },
  { id: "turbulence", label: "Turbulence Strength", type: "value" as const },
  { id: "turbulenceDecay", label: "Turbulence Decay", type: "value" as const },
  { id: "turbFrequency", label: "Turbulence Frequency", type: "value" as const },
  { id: "cooling", label: "Cooling Rate (override)", type: "value" as const },
  { id: "dissipation", label: "Dissipation (override)", type: "value" as const },
  { id: "wind", label: "Wind Vector", type: "vector" as const },
  { id: "fireIntensity", label: "Fire Intensity", type: "value" as const },
  { id: "glowSpread", label: "Glow Spread", type: "value" as const },
  { id: "rampScale", label: "Fire Ramp Scale", type: "value" as const },
  { id: "fireHue", label: "Fire Hue Shift", type: "value" as const },
  { id: "saturation", label: "Saturation", type: "value" as const },
  { id: "startColor", label: "Fire Start Color", type: "color" as const },
  { id: "midColor", label: "Fire Mid Color", type: "color" as const },
  { id: "endColor", label: "Fire End Color", type: "color" as const },
  { id: "asymmetry", label: "Phase Asymmetry (g)", type: "value" as const },
  { id: "powderStrength", label: "Powder Effect", type: "value" as const },
  { id: "multiScattering", label: "Multi Scattering", type: "value" as const },
  { id: "shadowAbsorption", label: "Shadow Absorption", type: "value" as const },
  { id: "shadowAmbient", label: "Shadow Ambient", type: "value" as const },
  { id: "keyLightIntensity", label: "Key Light Intensity", type: "value" as const },
  { id: "colorRetention", label: "Color Retention", type: "value" as const },
  { id: "smokeAmbient", label: "Smoke Ambient", type: "value" as const },
  { id: "steps", label: "Raymarch Steps", type: "value" as const },
  { id: "substeps", label: "Substeps", type: "value" as const },
  { id: "renderResolution", label: "Render Resolution", type: "value" as const },
  { id: "denoise", label: "Denoise Strength", type: "value" as const },
  { id: "exposure", label: "Exposure", type: "value" as const },
];

/**
 * Sous-pas par pas de graphe. L'exemple three.js simule à 1/120 s contre 1/60
 * pour notre horloge (clock.ts), donc 2 sous-pas reproduisent sa cadence.
 *
 * Défaut à 1 malgré tout : mesuré à résolution par défaut, passer de 1 à 2
 * double le coût (37 -> 77 ms/frame) pour un gain quasi nul une fois le bord
 * zéro en place (densité max 1.19 -> 1.16, étalement 7922 -> 7596 cellules).
 * Le nombre de Courant vaut 0.67 à 1/60, donc l'advection reste stable. Monter
 * ce paramètre n'a d'intérêt qu'avec une flottabilité ou un vent très forts,
 * qui feraient passer le CFL au-dessus de 1.
 */
const DEFAULT_SUBSTEPS = 1;
const MAX_SUBSTEPS = 8;

export const FIRE_FLUID_VOLUME_NODE: NodeDefinition = {
  type: "simulation/fire-fluid-volume",
  label: "Volumetric Fire Sim (Macro)",
  category: "physics",
  inputs: [
    ...MACRO_FIXED_INPUTS,
    { id: `${FIELD_PREFIX}0`, label: "Force Field 1", type: "any" },
  ],
  dynamicInputs: (connections) => [...MACRO_FIXED_INPUTS, ...forceFieldSockets(connections)],
  outputs: [
    { id: "geometry", label: "Fire Mesh", type: "geometry" },
    { id: "velocityField", label: "Velocity Field (3D)", type: "texture" },
    { id: "light", label: "Fire Light", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    boxSize: DEFAULT_GRID_CONFIG.worldSize.clone(),
    resolution: new THREE.Vector3(32, 64, 32),
    groundAnchor: true,
    solver: "auto",
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    // ~1 voxel de rayon sur la boîte par défaut : adoucit la source sans étaler
    // la densité sur un noyau de 7^3 cellules, qui écrase le pic de température.
    emitterRadius: 0.3,
    normalizeEmission: true,
    simulate: true,
    simSpeed: 1.2,
    motionBoost: 0.25,
    windStrength: 6.5,
    density: 7.0,
    temperature: 5.5,
    buoyancy: 3.0,
    smokeWeight: 0.15,
    velocityDamping: 0.25,
    fireLifespan: 1.3,
    smokeLifespan: 3.5,
    turbulence: 3.2,
    turbulenceDecay: 0.1,
    turbFrequency: 10.0,
    wind: new THREE.Vector3(0, 0, 0),
    fireIntensity: 20.0,
    glowSpread: 5.0,
    // Température qui correspond au haut de la rampe de couleur. Le champ monte
    // bien au-dessus de 1, donc à 1 toute la flamme prenait la couleur haute
    // (jaune pâle) et blanchissait ; 4 étale la rampe rouge -> orange -> jaune.
    rampScale: 8.0,
    fireHue: 0,
    saturation: 1.1,
    startColor: new THREE.Color(0xffe68c),
    midColor: new THREE.Color(0xff7305),
    endColor: new THREE.Color(0xff0000),
    asymmetry: 0.0,
    powderStrength: 0.59,
    multiScattering: 1.0,
    shadowAbsorption: 2.0,
    shadowAmbient: 0.5,
    smokeAmbient: 1.0,
    // Conservation de teinte au tone mapping : 0 = ACES par canal (cœur blanc),
    // 1 = teinte préservée même surexposée.
    colorRetention: 0.85,
    // Intensité de la lumière clé sur la fumée, atténuée en 1/d². À ~10 unités
    // du volume elle vaut 1.0 : le gain fixe de 8.5 qui la précédait éclairait
    // tout le panache à fond et le rendait blanc.
    keyLightIntensity: 100.0,
    shadowSteps: 2,
    keyLightPos: new THREE.Vector3(0, 10, 5),
    steps: 64,
    substeps: DEFAULT_SUBSTEPS,
    // 1 = volume rendu inline dans la scène (chemin historique). En dessous, le
    // volume passe sur son propre layer et une passe séparée le rend en réduit.
    renderResolution: 1.0,
    denoise: 0.5,
    // 2.0 poussait l'accumulation HDR au-delà du coude de l'ACES sur presque tout
    // le panache : la fumée comme le cœur clippaient en blanc.
    exposure: 1.4,
  },
  paramFields: [
    { id: "boxSize", label: "Box Size (world)", kind: "vector", group: "Simulation Box" },
    { id: "resolution", label: "Resolution (voxels)", kind: "vector", group: "Simulation Box" },
    { id: "groundAnchor", label: "Anchor To Ground", kind: "boolean", group: "Simulation Box" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },

    { id: "solver", label: "Solver", kind: "select", options: ["auto", "gpu", "cpu"], group: "Simulation" },
    { id: "simulate", label: "Simulate Fluid", kind: "boolean", group: "Simulation" },
    { id: "simSpeed", label: "Simulation Speed", kind: "number", step: 0.05, group: "Simulation" },
    { id: "substeps", label: "Substeps / frame", kind: "number", step: 1, group: "Simulation" },

    { id: "temperature", label: "Temperature Rate", kind: "number", step: 0.5, group: "Emitter" },
    { id: "density", label: "Density Rate", kind: "number", step: 0.5, group: "Emitter" },
    { id: "emitterRadius", label: "Emitter Radius", kind: "number", step: 0.1, group: "Emitter" },
    { id: "motionBoost", label: "Movement Boost", kind: "number", step: 0.01, group: "Emitter" },
    { id: "windStrength", label: "Movement Wind Strength", kind: "number", step: 0.5, group: "Emitter" },
    { id: "normalizeEmission", label: "Normalize Emission (mesh-independent)", kind: "boolean", group: "Emitter" },

    { id: "buoyancy", label: "Buoyancy (Rise)", kind: "number", step: 0.2, group: "Fluid Physics" },
    { id: "smokeWeight", label: "Smoke Weight", kind: "number", step: 0.01, group: "Fluid Physics" },
    { id: "velocityDamping", label: "Velocity Damping", kind: "number", step: 0.05, group: "Fluid Physics" },
    { id: "fireLifespan", label: "Fire Lifespan (s)", kind: "number", step: 0.1, group: "Fluid Physics" },
    { id: "smokeLifespan", label: "Smoke Lifespan (s)", kind: "number", step: 0.5, group: "Fluid Physics" },
    { id: "turbulence", label: "Turbulence Strength", kind: "number", step: 0.2, group: "Fluid Physics" },
    { id: "turbulenceDecay", label: "Turbulence Decay", kind: "number", step: 0.01, group: "Fluid Physics" },
    { id: "turbFrequency", label: "Turbulence Frequency", kind: "number", step: 0.5, group: "Fluid Physics" },
    { id: "wind", label: "Wind Vector", kind: "vector", group: "Fluid Physics" },

    { id: "fireIntensity", label: "Fire Intensity", kind: "number", step: 5.0, group: "Volume Visuals" },
    { id: "glowSpread", label: "Glow Spread", kind: "number", step: 0.1, group: "Volume Visuals" },
    { id: "rampScale", label: "Fire Ramp Scale (temp)", kind: "number", step: 0.5, group: "Volume Visuals" },
    { id: "fireHue", label: "Fire Hue Shift (°)", kind: "number", step: 1, group: "Volume Visuals" },
    { id: "saturation", label: "Saturation", kind: "number", step: 0.05, group: "Volume Visuals" },
    { id: "colorRetention", label: "Color Retention (anti-white)", kind: "number", step: 0.05, group: "Volume Visuals" },
    { id: "startColor", label: "Fire Start Color", kind: "color", group: "Volume Visuals" },
    { id: "midColor", label: "Fire Mid Color", kind: "color", group: "Volume Visuals" },
    { id: "endColor", label: "Fire End Color", kind: "color", group: "Volume Visuals" },

    { id: "asymmetry", label: "Phase Asymmetry (g)", kind: "number", step: 0.01, group: "Scattering & Shadows" },
    { id: "powderStrength", label: "Powder Effect", kind: "number", step: 0.01, group: "Scattering & Shadows" },
    { id: "multiScattering", label: "Multi Scattering", kind: "number", step: 0.01, group: "Scattering & Shadows" },
    { id: "shadowAbsorption", label: "Shadow Absorption", kind: "number", step: 0.1, group: "Scattering & Shadows" },
    { id: "shadowAmbient", label: "Shadow Ambient", kind: "number", step: 0.05, group: "Scattering & Shadows" },
    { id: "keyLightIntensity", label: "Key Light Intensity", kind: "number", step: 10, group: "Scattering & Shadows" },
    { id: "smokeAmbient", label: "Smoke Ambient", kind: "number", step: 0.1, group: "Scattering & Shadows" },
    { id: "shadowSteps", label: "Shadow Steps", kind: "number", step: 1, group: "Scattering & Shadows" },
    { id: "keyLightPos", label: "Key Light Position", kind: "vector", group: "Scattering & Shadows" },

    { id: "steps", label: "Raymarch Steps", kind: "number", step: 4, group: "Quality" },
    { id: "renderResolution", label: "Render Resolution", kind: "number", step: 0.05, group: "Quality" },
    { id: "denoise", label: "Denoise Strength", kind: "number", step: 0.05, group: "Quality" },
    { id: "exposure", label: "Exposure", kind: "number", step: 0.1, group: "Quality" },
  ],
  evaluate: (inputs, params, ctx) => {
    const backend = resolveBackend(params, ctx.renderer);
    const config = resolveGridConfig(inputs, params, backend);

    let state = macroSimCache.get(ctx.nodeId);
    // Changer la résolution réalloue tous les buffers ; changer la taille monde
    // ne fait que redimensionner la boîte, la sim continue sans être coupée.
    // Changer de backend impose aussi de repartir de zéro.
    if (state && (gridResolutionChanged(state.config, config) || state.backend !== backend)) {
      // createNodeCache renvoie une Map nue : un delete() seul saute le disposer
      // et laisse les Data3DTexture sur le GPU. Libération explicite.
      state.sim?.dispose();
      state.gpu?.dispose();
      disposeObject3D(state.mesh);
      macroSimCache.delete(ctx.nodeId);
      state = undefined;
    }
    if (!state) {
      const useGPU = backend === "gpu" && ctx.renderer;
      const sim = useGPU ? null : createFluidSimulationState(config);
      const geo = new THREE.BoxGeometry(config.worldSize.x, config.worldSize.y, config.worldSize.z);
      const mat = createVolumetricShaderMaterial(
        sim ? sim.dyeTexture : new THREE.Data3DTexture(new Float32Array(4), 1, 1, 1),
        config,
        sim?.velTexture
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      const light = new THREE.PointLight(0xff7305, 3.5, 25);
      state = {
        sim,
        gpu: useGPU ? createFluidGPUState(ctx.renderer!, config) : null,
        backend,
        config,
        mesh, light,
        boxSize: config.worldSize.clone(),
        prevEmitterPos: null,
        simTime: 0,
        // -1 pour que la toute première évaluation simule un pas : initialiser à
        // ctx.step donnerait stepsSince() = 0 et la frame d'apparition du node
        // serait figée.
        lastStep: ctx.step - 1,
      };
      macroSimCache.set(ctx.nodeId, state);
    }

    // Redimensionnement de la boîte sans réallocation : géométrie + uniforme
    if (!state.boxSize.equals(config.worldSize)) {
      state.mesh.geometry.dispose();
      state.mesh.geometry = new THREE.BoxGeometry(config.worldSize.x, config.worldSize.y, config.worldSize.z);
      state.boxSize.copy(config.worldSize);
      state.config.worldSize.copy(config.worldSize);
      state.sim?.config.worldSize.copy(config.worldSize);
      (state.mesh.material as THREE.ShaderMaterial).uniforms.uVolumeSize.value.copy(config.worldSize);
    }

    const density = Math.max(0, numberInput(inputs.density, params.density, 7.0));
    const temperature = Math.max(0, numberInput(inputs.temperature, params.temperature, 5.5));
    const buoyancy = numberInput(inputs.buoyancy, params.buoyancy, 3.0);
    const smokeWeight = numberInput(inputs.smokeWeight, params.smokeWeight, 0.15);
    const velocityDamping = Math.max(0, numberInput(inputs.velocityDamping, params.velocityDamping, 0.25));
    const wind = asVector3(inputs.wind, asVector3(params.wind, new THREE.Vector3()));
    const fireIntensity = numberInput(inputs.fireIntensity, params.fireIntensity, 20.0);
    const steps = Math.max(8, Math.min(128, numberInput(inputs.steps, params.steps, 64)));
    const exposure = Math.max(0.01, numberInput(inputs.exposure, params.exposure, 1.4));
    const turbulenceDecay = Math.max(0, numberInput(inputs.turbulenceDecay, params.turbulenceDecay, 0.1));
    const turbFrequency = Math.max(0.1, numberInput(inputs.turbFrequency, params.turbFrequency, 10.0));
    const emitterRadius = Math.max(0, numberInput(inputs.emitterRadius, params.emitterRadius, 0.3));
    const motionBoost = numberInput(inputs.motionBoost, params.motionBoost, 0.25);
    const windStrength = numberInput(inputs.windStrength, params.windStrength, 6.5);
    const normalizeEmission = inputs.normalizeEmission !== undefined
      ? toBoolean(inputs.normalizeEmission)
      : params.normalizeEmission !== false;

    const simulate = inputs.simulate !== undefined ? toBoolean(inputs.simulate) : params.simulate !== false;
    const simSpeed = Math.max(0, numberInput(inputs.simSpeed, params.simSpeed, 1.2));
    const substeps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.round(numberInput(inputs.substeps, params.substeps, DEFAULT_SUBSTEPS))));

    // Durées de vie -> taux de décroissance, comme l'exemple : une durée est bien
    // plus lisible qu'un taux, et 1 / durée est la relation exacte. Les sockets
    // cooling / dissipation restent des surcharges directes quand ils sont câblés.
    const fireLifespan = Math.max(0.05, numberInput(inputs.fireLifespan, params.fireLifespan, 1.3));
    const smokeLifespan = Math.max(0.05, numberInput(inputs.smokeLifespan, params.smokeLifespan, 3.5));
    const cooling = inputs.cooling !== undefined
      ? Math.max(0, Number(inputs.cooling))
      : 1 / fireLifespan;
    // Convention de l'exemple : au-delà de 100 s la fumée ne se dissipe plus du tout.
    const dissipation = inputs.dissipation !== undefined
      ? Math.max(0, Number(inputs.dissipation))
      : smokeLifespan >= 100 ? 0 : 1 / smokeLifespan;

    // La turbulence est compensée par la racine de la vitesse de simulation :
    // sans ça, ralentir la sim renforce visuellement le brassage (l'exemple fait
    // exactement ce calcul).
    const turbulenceRaw = numberInput(inputs.turbulence, params.turbulence, 3.2);
    const turbulence = simSpeed > 0 ? turbulenceRaw / Math.sqrt(simSpeed) : 0;

    // Matrice du volume : elle pilote à la fois le rendu (le raymarcher travaille
    // déjà en espace local via uInvModelMatrix) et le placement des émetteurs.
    const volumeMatrix = composeVolumeMatrix(inputs, params, config.worldSize);
    state.mesh.matrix.copy(volumeMatrix);
    state.mesh.updateMatrixWorld(true);

    const worldToVolume = new THREE.Matrix4().copy(state.mesh.matrixWorld).invert();

    // Préparer l'émetteur. Le fallback n'a de sens que sans maillage branché.
    // Densité de maillage volontairement élevée (427 sommets contre 100) : chaque
    // sommet est une source indépendante, donc le pic de température atteint dans
    // un voxel est proportionnel au nombre de sommets qui l'arrosent. Avec un
    // cylindre à 16 segments la température plafonnait à ~0.9 et le foyer n'avait
    // pas de cœur incandescent — la théière de l'exemple three.js compte des
    // milliers de sommets. Mis en cache : le recréer à chaque frame allouait une
    // BufferGeometry jamais libérée.
    const emitterGeometry =
      inputs.emitterMesh instanceof THREE.Object3D || inputs.emitterMesh instanceof THREE.BufferGeometry
        ? inputs.emitterMesh
        : (state.fallbackEmitter ??= new THREE.CylinderGeometry(0.3, 0.45, 0.35, 32, 8));

    // Une BufferGeometry nue n'a pas de transform : on la pose au pied du volume.
    // Un Object3D porte la sienne, et collectEmitterSources lit celle de chaque
    // enfant — la worldMatrix de la racine ne servirait à rien ici.
    const emitterMatrix = inputs.emitterMesh instanceof THREE.Object3D
      ? undefined
      : new THREE.Matrix4().multiplyMatrices(state.mesh.matrixWorld, new THREE.Matrix4().makeTranslation(0, -config.worldSize.y / 2 + 0.35, 0));

    // Vitesse de l'émetteur par différence entre pas : c'est elle qui alimente
    // motionBoost, resté inerte jusqu'ici faute de quiconque pour la calculer.
    const emitterPos = new THREE.Vector3();
    if (inputs.emitterMesh instanceof THREE.Object3D) {
      inputs.emitterMesh.updateWorldMatrix(true, false);
      emitterPos.setFromMatrixPosition(inputs.emitterMesh.matrixWorld);
    } else if (emitterMatrix) {
      emitterPos.setFromMatrixPosition(emitterMatrix);
    }
    // Vitesse de l'émetteur par différence entre pas de graphe : c'est elle qui
    // alimente motionBoost et le vent de déplacement, restés inertes jusqu'ici
    // faute de quiconque pour la calculer.
    const emitterVelocity = state.prevEmitterPos
      ? emitterPos.clone().sub(state.prevEmitterPos).divideScalar(STEP_SECONDS)
      : new THREE.Vector3();
    state.prevEmitterPos = emitterPos.clone();

    const emitter: FluidEmitterDescriptor = {
      geometry: emitterGeometry,
      worldMatrix: emitterMatrix,
      density,
      temperature,
      motionBoost,
      radius: emitterRadius,
      velocity: emitterVelocity,
      speed: emitterVelocity.length(),
      position: emitterPos,
      windStrength,
      windRadius: 1.0,
      normalizeEmission,
    };

    // Sous-pas à pas fixe. L'exemple simule à 1/120 s et avance `delta * simSpeed`
    // de temps de simulation par frame ; avec une horloge fixée à 1/60, deux
    // sous-pas de simSpeed/120 reproduisent exactement sa cadence.
    const forces = collectForceFields(inputs);
    const subDt = (STEP_SECONDS * simSpeed) / substeps;

    if (simulate && simSpeed > 0) {
      // Rattrapage borné après un scrub ou une pause, comme les autres nodes
      // à simulation du graphe (voir stepsSince dans clock.ts).
      const graphSteps = stepsSince(state.lastStep, ctx.step, MAX_CATCHUP_STEPS);
      for (let g = 0; g < graphSteps; g++) {
        for (let s = 0; s < substeps; s++) {
          state.simTime += subDt;
          const simParams = {
            ...DEFAULT_FLUID_PARAMS,
            dt: subDt,
            time: state.simTime,
            buoyancy,
            smokeWeight,
            velocityDamping,
            turbulence,
            turbulenceDecay,
            turbFrequency,
            cooling,
            dissipation,
            wind,
            worldToVolume,
            volumeToWorld: state.mesh.matrixWorld.clone(),
          };
          if (state.gpu && ctx.renderer) {
            stepFluidSimulationGPU(ctx.renderer, state.gpu, simParams, [emitter], forces);
          } else if (state.sim) {
            stepFluidSimulation(state.sim, simParams, [emitter], forces);
          }
        }
      }
    }
    state.lastStep = ctx.step;

    // Mettre à jour le matériau
    const mat = state.mesh.material as THREE.ShaderMaterial;
    // Les cibles de rendu 3D exposent une Data3DTexture, exactement comme le
    // chemin CPU : le raymarcher échantillonne les deux sans distinction.
    mat.uniforms.uDyeTexture.value = state.gpu ? state.gpu.dyeTexture : state.sim!.dyeTexture;
    mat.uniforms.uVelTexture.value = state.gpu ? state.gpu.velTexture : state.sim!.velTexture;
    mat.uniforms.uFireIntensity.value = fireIntensity;
    mat.uniforms.uSteps.value = steps;
    mat.uniforms.uTime.value = state.simTime;
    mat.uniforms.uFrameId.value = ctx.step;
    mat.uniforms.uExposure.value = exposure;
    mat.uniforms.uInvModelMatrix.value.copy(worldToVolume);
    mat.uniforms.uFireGlowSpread.value = numberInput(inputs.glowSpread, params.glowSpread, 5.0);
    mat.uniforms.uAsymmetry.value = numberInput(inputs.asymmetry, params.asymmetry, 0.0);
    mat.uniforms.uPowderStrength.value = numberInput(inputs.powderStrength, params.powderStrength, 0.59);
    mat.uniforms.uMultiScattering.value = numberInput(inputs.multiScattering, params.multiScattering, 1.0);
    mat.uniforms.uShadowAbsorption.value = numberInput(inputs.shadowAbsorption, params.shadowAbsorption, 2.0);
    mat.uniforms.uShadowAmbient.value = numberInput(inputs.shadowAmbient, params.shadowAmbient, 0.5);
    mat.uniforms.uKeyLightIntensity.value = Math.max(0, numberInput(inputs.keyLightIntensity, params.keyLightIntensity, 100.0));
    mat.uniforms.uColorRetention.value = numberInput(inputs.colorRetention, params.colorRetention, 0.85);
    mat.uniforms.uSmokeAmbient.value = numberInput(inputs.smokeAmbient, params.smokeAmbient, 1.0);
    mat.uniforms.uFireRampScale.value = Math.max(0.05, numberInput(inputs.rampScale, params.rampScale, 8.0));
    mat.uniforms.uShadowSteps.value = Math.max(0, Math.min(8, Math.round(numberInput(inputs.shadowSteps, params.shadowSteps, 2))));
    mat.uniforms.uKeyLightPos.value.copy(resolveKeyLightPos(inputs, params));
    mat.uniforms.uSaturation.value = numberInput(inputs.saturation, params.saturation, 1.1);
    mat.uniforms.uFireHue.value = THREE.MathUtils.degToRad(numberInput(inputs.fireHue, params.fireHue, 0));
    mat.uniforms.uFireStartColor.value = asColor(inputs.startColor, params.startColor as THREE.Color);
    mat.uniforms.uFireMidColor.value = asColor(inputs.midColor, params.midColor as THREE.Color);
    mat.uniforms.uFireEndColor.value = asColor(inputs.endColor, params.endColor as THREE.Color);
    // Montée sur 3 s, comme l'exemple
    mat.uniforms.uFadeIn.value = THREE.MathUtils.smoothstep(state.simTime, 0, 3);

    // Résolution de rendu du volume. À 1 le maillage reste sur le layer par
    // défaut et est rendu inline comme avant ; en dessous il bascule sur le layer
    // volumétrique et VolumetricPass le rend en réduit puis le compose.
    const renderResolution = Math.max(0.05, Math.min(1, numberInput(inputs.renderResolution, params.renderResolution, 1)));
    const denoise = Math.max(0, Math.min(1, numberInput(inputs.denoise, params.denoise, 0.5)));
    if (renderResolution < 1) {
      state.mesh.layers.set(LAYER_VOLUMETRIC);
      state.mesh.userData.volumetric = { resolutionScale: renderResolution, denoise };
    } else {
      state.mesh.layers.set(0);
      delete state.mesh.userData.volumetric;
    }

    // La lumière suit la base du volume, pas son centre
    state.light.position.setFromMatrixPosition(state.mesh.matrixWorld);
    state.light.position.y += -config.worldSize.y / 2 + 1.2;
    // Scintillement de la lumière dynamique du foyer
    state.light.intensity = 2.5 + 0.8 * Math.sin(ctx.time * 12.0) * Math.cos(ctx.time * 7.5);

    return {
      geometry: state.mesh,
      velocityField: state.gpu ? state.gpu.velTexture : state.sim!.velTexture,
      light: state.light,
      matrix: state.mesh.matrixWorld.clone(),
    };
  },
};
