import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { STEP_SECONDS, stepsSince } from "../clock";
import { toBoolean } from "../sockets";
import { createPRNG } from "../../math/random";
import { asVector3, composeNativeMatrix } from "./transform";
import { perSession, sessionKey } from "../sessionState";
import {
  applyMaterialParams,
  buildPrimitiveDynamicParamFields,
  COMMON_DEFAULT_PARAMS,
  COMMON_PRIMITIVE_INPUTS,
  COMMON_PRIMITIVE_OUTPUTS,
  extractMaterialParams,
  extractTextureParams,
  numberInput,
  primitiveOutputs,
} from "./object";
import { collectObstacles, makeAvoider, ObstacleMesh, obstaclesSignature } from "../obstacles";
import {
  createWaveField,
  disturb,
  EDGE_MODES,
  EdgeMode,
  gridSize,
  sampleHeight,
  setSolid,
  slopeAt,
  surfaceHeights,
  stepWaveField,
  WaveField,
} from "../ripples/waveField";

/** Same catch-up ceiling as the other step-driven simulations. */
const MAX_CATCHUP_STEPS = 10;

/** One render loop's water — see sessionState.ts for why each viewport keeps its own. */
interface RippleRun {
  field: WaveField;
  fieldKey: string;
  epoch: number;
  lastStep: number;
  prevDrop: boolean;
  /** Each source's position last frame, in the field's own space, to measure how far it moved. */
  sourcePrev: Float64Array;
  sourceCount: number;
  rainCarry: number;
  rng: () => number;
}

interface RippleState {
  sessions: Map<string, RippleRun>;
  /** The surface and maps are shared: each loop writes its own water into them just before it draws. */
  layoutKey?: string;
  /** Cells blocked by obstacles; depends only on where they are, so every loop shares it. */
  maskKey?: string;
  mask: Uint8Array | null;
  /** The drawn surface — see surfaceHeights. */
  surface?: Float32Array;
  mesh?: THREE.Mesh;
  heightMap?: THREE.DataTexture;
  normalMap?: THREE.DataTexture;
}

const rippleCache = createNodeCache<RippleState>((state) => {
  if (state.mesh) disposeObject3D(state.mesh);
  state.heightMap?.dispose();
  state.normalMap?.dispose();
});

function freshRun(field: WaveField, fieldKey: string, epoch: number, step: number, seed: number): RippleRun {
  // lastStep one behind so the very first evaluation advances a step.
  return { field, fieldKey, epoch, lastStep: step - 1, prevDrop: false, sourcePrev: new Float64Array(0), sourceCount: 0, rainCarry: 0, rng: createPRNG(seed * 7919 + 11) };
}

/** A flat grid of nx × nz vertices over the area, one per cell centre, facing +Y. */
function gridGeometry(field: WaveField): THREE.BufferGeometry {
  const { nx, nz, area } = field;
  const positions = new Float32Array(nx * nz * 3);
  const normals = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      positions[k * 3] = area.centerX - area.sizeX / 2 + ((i + 0.5) / nx) * area.sizeX;
      positions[k * 3 + 2] = area.centerZ - area.sizeZ / 2 + ((j + 0.5) / nz) * area.sizeZ;
      normals[k * 3 + 1] = 1;
      // Same orientation as a Plane laid flat: u along +X, v towards -Z.
      uvs[k * 2] = (i + 0.5) / nx;
      uvs[k * 2 + 1] = 1 - (j + 0.5) / nz;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + nx, c = a + 1, d = b + 1;
      index.push(a, b, c, c, b, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nx * nz * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(index);
  return geometry;
}

function dataTexture(nx: number, nz: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array(nx * nz * 4), nx, nz, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Heights and normals are data, not colour: no sRGB decode on the way in.
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Writes the field into the mesh (heights and normals) and both maps. Texture
 * row 0 is the +Z edge, so the maps line up with the mesh's own UVs and with
 * a Plane primitive laid over the same area.
 */
function publish(state: RippleState, field: WaveField, heightScale: number, mapRange: number, normalStrength: number, crest: number): void {
  const { nx, nz } = field;
  const mesh = state.mesh!;
  const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const nrm = mesh.geometry.getAttribute("normal") as THREE.BufferAttribute;
  const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
  const hData = state.heightMap!.image.data as Uint8Array;
  const nData = state.normalMap!.image.data as Uint8Array;
  const range = Math.max(1e-6, mapRange);
  if (!state.surface || state.surface.length !== nx * nz) state.surface = new Float32Array(nx * nz);
  const surface = surfaceHeights(field, state.surface);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = surface[k];
      pos.setY(k, h * heightScale);
      const { sx, sz } = slopeAt(field, i, j, surface);
      let ux = -sx * heightScale, uz = -sz * heightScale;
      let len = Math.hypot(ux, 1, uz);
      nrm.setXYZ(k, ux / len, 1 / len, uz / len);
      const t = ((nz - 1 - j) * nx + i) * 4;
      // Crests lighter, troughs darker: rings that read under any light, even straight from above.
      const shade = 1 + crest * Math.max(-1, Math.min(1, h / range));
      col.setXYZ(k, shade, shade, shade);
      const g = Math.round(Math.max(0, Math.min(1, 0.5 + h / (2 * range))) * 255);
      hData[t] = hData[t + 1] = hData[t + 2] = g;
      hData[t + 3] = 255;
      // Tangent space: x along +u (+X), y along +v (-Z), z out of the surface.
      ux = -sx * normalStrength;
      const vy = sz * normalStrength;
      len = Math.hypot(ux, vy, 1);
      nData[t] = Math.round((ux / len * 0.5 + 0.5) * 255);
      nData[t + 1] = Math.round((vy / len * 0.5 + 0.5) * 255);
      nData[t + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      nData[t + 3] = 255;
    }
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  col.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
  state.heightMap!.needsUpdate = true;
  state.normalMap!.needsUpdate = true;
}

/**
 * Which cells an obstacle blocks: those whose centre, on the surface, is
 * inside a closed obstacle or within half a cell of an open one (a plank
 * floating flat, a wall with no back).
 */
function obstacleMask(field: WaveField, pose: THREE.Matrix4, meshes: ObstacleMesh[]): Uint8Array {
  const { nx, nz, area } = field;
  const scale = new THREE.Vector3().setFromMatrixScale(pose);
  const cell = Math.max(area.sizeX / nx, area.sizeZ / nz) * Math.max(Math.abs(scale.x), Math.abs(scale.z), 1e-6);
  // Unbounded search: a cell deep inside a rock is far from every surface,
  // and only the nearest one, wherever it is, says whether it is inside.
  // Costly per cell, but done only when the obstacles or the field change.
  const avoid = makeAvoider(meshes, Infinity)!;
  const hit = { x: 0, y: 0, z: 0, weight: 0, inside: false, distance: 0 };
  const p = new THREE.Vector3();
  const mask = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      p.set(area.centerX - area.sizeX / 2 + ((i + 0.5) / nx) * area.sizeX, 0, area.centerZ - area.sizeZ / 2 + ((j + 0.5) / nz) * area.sizeZ).applyMatrix4(pose);
      if (avoid(p.x, p.y, p.z, hit) && (hit.inside || hit.distance < cell * 0.5)) mask[j * nx + i] = 1;
    }
  }
  return mask;
}

const EXTRA_FIELDS: ParamFieldDef[] = [
  { id: "size", label: "Size (X, —, Z)", kind: "vector", group: "Field" },
  { id: "resolution", label: "Resolution (cells, long side)", kind: "number", step: 8, group: "Field" },
  { id: "waveSpeed", label: "Wave Speed (units/s)", kind: "number", step: 0.1, group: "Field" },
  { id: "damping", label: "Damping (per second)", kind: "number", step: 0.05, group: "Field" },
  { id: "edges", label: "Edges", kind: "select", options: [...EDGE_MODES], optionLabels: ["Reflect (a pond's banks)", "Absorb (open water)"], group: "Field" },
  { id: "dropRadius", label: "Drop Radius", kind: "number", step: 0.05, group: "Drops" },
  { id: "dropStrength", label: "Drop Depth", kind: "number", step: 0.01, group: "Drops" },
  { id: "rainRate", label: "Rain (drops per second)", kind: "number", step: 1, group: "Drops" },
  { id: "rainStrength", label: "Rain Drop Depth", kind: "number", step: 0.005, group: "Drops" },
  { id: "seed", label: "Rain Seed", kind: "number", step: 1, group: "Drops" },
  { id: "sourceRadius", label: "Source Radius", kind: "number", step: 0.05, group: "Sources" },
  { id: "sourceStrength", label: "Wake Strength (per unit moved)", kind: "number", step: 0.01, group: "Sources" },
  { id: "depthFalloff", label: "Depth Falloff (0 = any depth)", kind: "number", step: 0.05, group: "Sources" },
  { id: "heightScale", label: "Mesh Height Scale", kind: "number", step: 0.1, group: "Output" },
  { id: "mapRange", label: "Height Map Range (±)", kind: "number", step: 0.01, group: "Output" },
  { id: "normalStrength", label: "Normal Map Strength", kind: "number", step: 0.1, group: "Output" },
  { id: "crestContrast", label: "Crest Contrast (0 = off)", kind: "number", step: 0.05, group: "Output" },
  { id: "castShadow", label: "Cast Shadow (off for water)", kind: "boolean", group: "Output" },
];

/**
 * Ripple Field — a surface that ripples. Drops dent it (a click, rain), and
 * Sources leave wakes as they move through it (fish, boats, fingers, a
 * cursor); rings spread at Wave Speed, pass through each other, fade with
 * Damping and bounce off or vanish at the Edges. Water, a drum skin, a
 * trampoline, a jelly floor.
 *
 * Obstacles (any geometry) block the surface where they cross it — rocks,
 * piers, a wading leg: the water there stays still, and waves bounce off
 * their outline and bend round them.
 *
 * The field lies flat in the node's own XZ plane, placed by its transform,
 * so it can be moved with the gizmo or tilted. Out come the rippling surface
 * itself, a Height Map and a Normal Map for any other material, and the
 * surface height and normal at each Probe point — to make things float.
 */
export const RIPPLE_FIELD_NODE: NodeDefinition = {
  type: "physics/ripple-field",
  label: "Ripple Field",
  category: "physics",
  inputs: [
    { id: "drop", label: "Drop (rising edge)", type: "value" },
    { id: "dropPoint", label: "Drop Point", type: "vector" },
    { id: "sources", label: "Sources (Points)", type: "list" },
    { id: "probes", label: "Probes (Points)", type: "list" },
    { id: "obstacles", label: "Obstacles (Geometry)", type: "geometry" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [
    ...COMMON_PRIMITIVE_OUTPUTS,
    { id: "heightMap", label: "Height Map", type: "texture" },
    { id: "normalMap", label: "Normal Map", type: "texture" },
    { id: "probeHeights", label: "Probe Heights (world Y)", type: "list" },
    { id: "probeNormals", label: "Probe Normals", type: "list" },
  ],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    color: new THREE.Color(0x2f5d62),
    roughness: 0.15,
    metalness: 0.1,
    opacity: 0.75,
    size: new THREE.Vector3(10, 0, 10),
    resolution: 128,
    waveSpeed: 1.5,
    damping: 0.6,
    edges: "reflect",
    dropRadius: 0.25,
    dropStrength: 0.06,
    rainRate: 0,
    rainStrength: 0.02,
    seed: 1,
    sourceRadius: 0.15,
    sourceStrength: 0.03,
    depthFalloff: 0,
    heightScale: 1,
    mapRange: 0.05,
    normalStrength: 1,
    crestContrast: 0.5,
    castShadow: false,
  },
  paramFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS),
  evaluate: (inputs, params, ctx) => {
    const epoch = ctx.simulationEpoch ?? 0;
    const seed = Math.round(numberInput(undefined, params.seed, 1));
    let state = rippleCache.get(ctx.nodeId);
    if (!state) {
      state = { sessions: new Map(), mask: null };
      rippleCache.set(ctx.nodeId, state);
    }

    const size = asVector3(params.size, new THREE.Vector3(10, 0, 10));
    const area = { centerX: 0, centerZ: 0, sizeX: Math.max(0.01, Math.abs(size.x)), sizeZ: Math.max(0.01, Math.abs(size.z)) };
    const resolution = Math.max(8, Math.min(256, Math.round(numberInput(undefined, params.resolution, 128))));
    const fieldKey = `${area.sizeX}:${area.sizeZ}:${resolution}`;

    const key = sessionKey(ctx);
    let run = perSession(state.sessions, key, () => freshRun(createWaveField(area, resolution), fieldKey, epoch, ctx.step, seed));
    // A scrub backwards, a reset or a new size: the ripples belong to another timeline.
    if (run.epoch !== epoch || ctx.step < run.lastStep || run.fieldKey !== fieldKey) {
      run = freshRun(createWaveField(area, resolution), fieldKey, epoch, ctx.step, seed);
      state.sessions.set(key, run);
    }
    const field = run.field;

    if (!state.mesh || state.layoutKey !== fieldKey) {
      const { nx, nz } = gridSize(area, resolution);
      if (state.mesh) {
        state.mesh.geometry.dispose();
        state.mesh.geometry = gridGeometry(field);
      } else {
        const mesh = new THREE.Mesh(gridGeometry(field), new THREE.MeshStandardMaterial());
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.userData.nodeId = ctx.nodeId;
        state.mesh = mesh;
      }
      state.heightMap?.dispose();
      state.normalMap?.dispose();
      state.heightMap = dataTexture(nx, nz);
      state.normalMap = dataTexture(nx, nz);
      state.layoutKey = fieldKey;
    }
    const mesh = state.mesh;

    const pose = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(pose);
    }
    const toLocal = pose.clone().invert();
    const local = new THREE.Vector3();

    const obstacles = collectObstacles(inputs.obstacles);
    const maskKey = obstacles.length ? `${fieldKey}|${pose.elements.map((e) => e.toFixed(4)).join(",")}|${obstaclesSignature(obstacles)}` : "";
    if (state.maskKey !== maskKey) {
      state.mask = obstacles.length ? obstacleMask(field, pose, obstacles) : null;
      state.maskKey = maskKey;
    }
    if (field.solid !== state.mask) setSolid(field, state.mask);

    const dropRadius = Math.max(0.001, numberInput(undefined, params.dropRadius, 0.25));
    const drop = toBoolean(inputs.drop);
    if (drop && !run.prevDrop) {
      local.copy(asVector3(inputs.dropPoint, new THREE.Vector3())).applyMatrix4(toLocal);
      disturb(field, local.x, local.z, dropRadius, numberInput(undefined, params.dropStrength, 0.06));
    }
    run.prevDrop = drop;

    const steps = stepsSince(run.lastStep, ctx.step, MAX_CATCHUP_STEPS);
    run.lastStep = Math.max(run.lastStep, ctx.step);

    // Wakes: a source dents the surface in proportion to how far it moved
    // since last frame, so a resting fish leaves the water still and a
    // darting one throws a trail — independent of the frame rate.
    const sources = Array.isArray(inputs.sources) ? inputs.sources : [];
    if (sources.length !== run.sourceCount) {
      run.sourceCount = sources.length;
      run.sourcePrev = new Float64Array(sources.length * 3).fill(Number.NaN);
    }
    const sourceRadius = Math.max(0.001, numberInput(undefined, params.sourceRadius, 0.15));
    const sourceStrength = numberInput(undefined, params.sourceStrength, 0.03);
    const falloff = Math.max(0, numberInput(undefined, params.depthFalloff, 0));
    sources.forEach((raw, s) => {
      const v = asVector3(raw, new THREE.Vector3(Number.NaN, 0, 0));
      if (!Number.isFinite(v.x)) return;
      local.copy(v).applyMatrix4(toLocal);
      const b = s * 3;
      const moved = Number.isFinite(run.sourcePrev[b]) ? Math.hypot(local.x - run.sourcePrev[b], local.z - run.sourcePrev[b + 2]) : 0;
      run.sourcePrev[b] = local.x;
      run.sourcePrev[b + 1] = local.y;
      run.sourcePrev[b + 2] = local.z;
      if (steps === 0 || moved === 0 || moved > sourceRadius * 20) return;
      const weight = falloff > 0 ? Math.max(0, 1 - Math.abs(local.y) / falloff) : 1;
      if (weight > 0) disturb(field, local.x, local.z, sourceRadius, sourceStrength * moved * weight);
    });

    const rainRate = Math.max(0, numberInput(undefined, params.rainRate, 0));
    const rainStrength = numberInput(undefined, params.rainStrength, 0.02);
    const stepParams = {
      speed: Math.max(0, numberInput(undefined, params.waveSpeed, 1.5)),
      damping: Math.max(0, numberInput(undefined, params.damping, 0.6)),
      edges: ((EDGE_MODES as readonly string[]).includes(String(params.edges)) ? params.edges : "reflect") as EdgeMode,
      border: Math.max(4, Math.min(field.nx, field.nz) / 8),
    };
    for (let s = 0; s < steps; s++) {
      run.rainCarry += rainRate * STEP_SECONDS;
      while (run.rainCarry >= 1) {
        run.rainCarry -= 1;
        disturb(field, (run.rng() - 0.5) * area.sizeX, (run.rng() - 0.5) * area.sizeZ, dropRadius * 0.5, rainStrength * (0.5 + run.rng()));
      }
      stepWaveField(field, STEP_SECONDS, stepParams);
    }

    const crest = Math.max(0, numberInput(undefined, params.crestContrast, 0.5));
    publish(
      state,
      field,
      numberInput(undefined, params.heightScale, 1),
      numberInput(undefined, params.mapRange, 0.05),
      numberInput(undefined, params.normalStrength, 1),
      crest,
    );
    applyMaterialParams(mesh, extractMaterialParams(inputs, params), THREE.DoubleSide, extractTextureParams(inputs, params, ctx.nodeId));
    // applyMaterialParams makes every mesh cast a shadow; a sheet of water
    // spanning the scene would drop one over everything beneath it.
    mesh.castShadow = toBoolean(params.castShadow);
    const material = mesh.material;
    if ((material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial) && material.vertexColors !== crest > 0) {
      material.vertexColors = crest > 0;
      material.needsUpdate = true;
    }

    const probeHeights: number[] = [];
    const probeNormals: THREE.Vector3[] = [];
    if (Array.isArray(inputs.probes)) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(pose);
      const eps = Math.max(area.sizeX / field.nx, area.sizeZ / field.nz);
      for (const raw of inputs.probes) {
        const v = asVector3(raw, new THREE.Vector3(Number.NaN, 0, 0));
        if (!Number.isFinite(v.x)) {
          probeHeights.push(0);
          probeNormals.push(new THREE.Vector3(0, 1, 0));
          continue;
        }
        local.copy(v).applyMatrix4(toLocal);
        const h = sampleHeight(field, local.x, local.z);
        const surface = new THREE.Vector3(local.x, h, local.z).applyMatrix4(pose);
        probeHeights.push(surface.y);
        const sx = (sampleHeight(field, local.x + eps, local.z) - sampleHeight(field, local.x - eps, local.z)) / (2 * eps);
        const sz = (sampleHeight(field, local.x, local.z + eps) - sampleHeight(field, local.x, local.z - eps)) / (2 * eps);
        probeNormals.push(new THREE.Vector3(-sx, 1, -sz).applyMatrix3(normalMatrix).normalize());
      }
    }

    return {
      ...primitiveOutputs(mesh, params),
      heightMap: state.heightMap,
      normalMap: state.normalMap,
      probeHeights,
      probeNormals,
    };
  },
};
