import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { readPositionsSync, textureSizeFor } from "../particleRuntime";
import { findFirstMesh } from "../meshRequired";
import { isAlive } from "./particleTrails";
import { toBoolean } from "../sockets";
import {
  applyMaterialParams,
  buildPrimitiveDynamicParamFields,
  COMMON_DEFAULT_PARAMS,
  COMMON_PRIMITIVE_INPUTS,
  COMMON_PRIMITIVE_OUTPUTS,
  extractMaterialParams,
  extractTextureParams,
  primitiveOutputs,
} from "./object";
import { composeNativeMatrix } from "./transform";

function numberInput(input: unknown, param: unknown, fallback: number): number {
  const raw = input !== undefined ? input : param;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** GLSL's fract() — the JS side of the hash shared with POSITION_SHADER's myLifetime. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * Ceiling on instances built in one frame. An InstancedMesh is one draw call
 * whatever the count, but each frame still walks the readback and writes a
 * Matrix4 per live particle on the CPU, so this is a frame-time guard rather
 * than a GPU one. Well above the "handful of particles" this node's mesh
 * sources realistically pair with.
 */
const MAX_INSTANCES = 20000;

interface InstanceState {
  mesh?: THREE.InstancedMesh;
  /** The geometry the instances were built from — swapping the Shape input rebuilds. */
  sourceGeometryId?: string;
  capacity?: number;
}

const instanceCache = createNodeCache<InstanceState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

/**
 * Injects a per-instance alpha into MeshStandardMaterial/MeshBasicMaterial/
 * MeshPhysicalMaterial — three.js instancing has no built-in per-instance
 * opacity (only `instanceColor`, which is RGB), so the birth/death opacity
 * fade multiplies this in via onBeforeCompile instead. Always present, not
 * only when the fade is toggled on: keeping the shader shape constant means
 * toggling Fade Opacity never forces a recompile, only a different value in
 * the attribute (1.0 when the fade is off).
 */
function withInstanceAlpha(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "attribute float instanceAlpha;\nvarying float vInstanceAlpha;\n#include <common>")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "varying float vInstanceAlpha;\n#include <common>")
    .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vInstanceAlpha;");
}

/**
 * The Shape mesh's rotation and scale, as seen from the Shape node's output
 * root — every matrix from the mesh up to and including `root` composed, then
 * stripped of translation. Translation stays out on purpose: each instance
 * sits on its particle, and a Shape node merely moved aside in the scene
 * shouldn't push every copy off its particle by the same offset.
 */
function shapeBasisMatrix(mesh: THREE.Object3D, root: THREE.Object3D): THREE.Matrix4 {
  const basis = new THREE.Matrix4();
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    if (node.matrixAutoUpdate) node.updateMatrix();
    basis.premultiply(node.matrix);
    if (node === root) break;
  }
  return basis.setPosition(0, 0, 0);
}

/**
 * The side the instance material should render — the Shape's own material's,
 * so a flat Disc or Plane (DoubleSide on its node) stays visible from below
 * instead of vanishing whenever its back faces the camera. A closed solid
 * keeps FrontSide; with no Shape, the default box is closed too.
 */
function shapeSide(mesh: THREE.Mesh | null): THREE.Side {
  const material = mesh ? (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) : null;
  return material?.side ?? THREE.FrontSide;
}

function getState(nodeId: string): InstanceState {
  let state = instanceCache.get(nodeId);
  if (!state) {
    state = {};
    instanceCache.set(nodeId, state);
  }
  return state;
}

/**
 * Flattens an InstancedMesh's live instances into one ordinary Mesh — each
 * instance's matrix baked into a copy of the source geometry, all merged into
 * a single BufferGeometry. The result has no tie to the simulation, the
 * InstancedMesh, or this node's per-frame work: it is exactly what a Box or
 * an imported .obj hands downstream.
 */
export function bakeInstances(source: THREE.InstancedMesh, nodeId: string): THREE.Mesh {
  const matrix = new THREE.Matrix4();
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < source.count; i++) {
    source.getMatrixAt(i, matrix);
    parts.push(source.geometry.clone().applyMatrix4(matrix));
  }
  const merged = parts.length > 0 ? mergeGeometries(parts, false) ?? new THREE.BufferGeometry() : new THREE.BufferGeometry();
  for (const part of parts) part.dispose();

  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xffffff }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  return mesh;
}

/** Action id the Bake button sends up to App.tsx's onAction — see bakeInstancesToGeometryData. */
export const BAKE_INSTANCES_ACTION = "particles/bake-instances-to-node";

const EXTRA_FIELDS = [
  { id: "instanceScale", label: "Instance Scale", kind: "number" as const, step: 0.01, group: "Geometry" },
  { id: "freeze", label: "Freeze (keep current instances)", kind: "boolean" as const, group: "Geometry" },
  { id: "bakeButton", label: "Bake to Mesh (new node)", kind: "button" as const, action: BAKE_INSTANCES_ACTION, group: "Geometry" },
  { id: "fadeSize", label: "Fade Size (birth/death)", kind: "boolean" as const, group: "Geometry" },
  { id: "fadeOpacity", label: "Fade Opacity (birth/death)", kind: "boolean" as const, group: "Geometry" },
  { id: "fadeFraction", label: "Fade Envelope", kind: "number" as const, step: 0.01, group: "Geometry" },
  { id: "lifetimeVariance", label: "Lifetime Variation (%)", kind: "number" as const, step: 5, group: "Geometry" },
];

/**
 * Reads the node's own live InstancedMesh straight out of the module cache
 * and flattens it into plain, JSON-serializable arrays — this is what the
 * Bake button (via App.tsx's onAction) hands to a freshly created
 * "object/frozen" node, so the result is a real graph node with no tie back
 * to this one, the simulation, or the InstancedMesh it was read from.
 * Returns null with nothing live to bake (no mesh yet, or zero instances).
 */
export function bakeInstancesToGeometryData(
  nodeId: string,
): { positions: number[]; normals: number[]; uvs: number[]; index: number[] | null } | null {
  const state = instanceCache.get(nodeId);
  if (!state?.mesh || state.mesh.count === 0) return null;
  const baked = bakeInstances(state.mesh, nodeId);
  const geometry = baked.geometry;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const index = geometry.getIndex();
  const data = {
    positions: Array.from(position.array as ArrayLike<number>),
    normals: normal ? Array.from(normal.array as ArrayLike<number>) : [],
    uvs: uv ? Array.from(uv.array as ArrayLike<number>) : [],
    index: index ? Array.from(index.array as ArrayLike<number>) : null,
  };
  disposeObject3D(baked);
  return data;
}

/**
 * Particle Render (Instances) Node — draws each particle as a real mesh
 * instead of a sprite.
 *
 * particles/render is a THREE.Points with a bespoke shader: fast, but the
 * particles can only ever be flat camera-facing sprites, and they sit outside
 * the material system every other object node shares — no PBR, no shadows, no
 * chosen geometry. That gap is what kept particles feeling like a separate
 * world rather than another kind of object. This node closes it: wire any
 * mesh into Shape and every live particle becomes a copy of it, through one
 * InstancedMesh (one draw call) carrying the same standard material params as
 * Box, Sphere and the rest.
 *
 * Positions come from the same CPU readback connect-nearby, capture-trails
 * and particles/to-points already use, rather than a GPU instancing shader:
 * it keeps the node inside the app's ordinary material/geometry machinery
 * (a real THREE.InstancedMesh that shadows, raycasts and accepts a Material
 * input) instead of a second bespoke shader that would have to reimplement
 * all of it. The tradeoff is a per-frame matrix write per particle, bounded
 * by MAX_INSTANCES.
 */
export const PARTICLE_RENDER_INSTANCES_NODE: NodeDefinition = {
  type: "particles/render-instances",
  label: "Particle Instances",
  category: "particles",
  inputs: [
    { id: "positions", label: "Positions", type: "texture" },
    { id: "count", label: "Count", type: "value" },
    { id: "lifetime", label: "Lifetime", type: "value" },
    { id: "lifetimeVariance", label: "Lifetime Variation (%)", type: "value" },
    { id: "shape", label: "Shape (Mesh)", type: "geometry" },
    { id: "instanceScale", label: "Instance Scale", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    instanceScale: 0.1,
    freeze: false,
    fadeSize: false,
    fadeOpacity: false,
    fadeFraction: 0.15,
    // Matches Particle Simulate's own field — enter the same % here as on
    // the Simulate node feeding this one, so the fade envelope (below) knows
    // each particle's *actual* randomized lifetime instead of the mean.
    lifetimeVariance: 0,
  },
  paramFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS),
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);

    const texture = inputs.positions instanceof THREE.Texture ? inputs.positions : null;
    const capacity = Math.max(0, Math.min(MAX_INSTANCES, Math.round(numberInput(inputs.count, params.count, 0))));
    const instanceScale = Math.max(0.0001, numberInput(inputs.instanceScale, params.instanceScale, 0.1));
    // A boolean rather than a "bake" button on purpose: a button press is a
    // moment, and nothing would carry it across a save/reload, whereas this
    // is state the .tsuji stores — reopen the file and the frozen pose is
    // still frozen. Freezing keeps the instance matrices exactly as they were
    // on the last live frame, so the node becomes an ordinary static object
    // downstream (Merge, Transform, Boolean, export) while the simulation
    // behind it keeps running or not, indifferently.
    const freeze = toBoolean(params.freeze);
    const lifetime = typeof inputs.lifetime === "number" ? inputs.lifetime : 0;
    const lifetimeVariance =
      Math.max(0, Math.min(100, numberInput(inputs.lifetimeVariance, params.lifetimeVariance, 0))) / 100;
    const fadeFraction = Math.min(0.5, Math.max(0.001, Number(params.fadeFraction) || 0.15));
    const fadeSize = toBoolean(params.fadeSize);
    const fadeOpacity = toBoolean(params.fadeOpacity);

    // Fall back to a small box so the node shows something the moment it is
    // added, before a Shape is wired — same "useful with nothing connected"
    // contract every primitive node has.
    const shapeObject = inputs.shape instanceof THREE.Object3D ? inputs.shape : null;
    const shapeMesh = shapeObject ? findFirstMesh(shapeObject) : null;
    const sourceGeometry = shapeMesh?.geometry ?? null;
    const shapeBasis = shapeMesh && shapeObject ? shapeBasisMatrix(shapeMesh, shapeObject) : null;
    // The basis is part of the key: re-orienting or re-scaling the Shape node
    // has to rebuild, exactly like swapping its geometry does.
    const sourceGeometryId = sourceGeometry
      ? `${sourceGeometry.uuid}:${shapeBasis!.elements.map((e) => e.toFixed(6)).join(",")}`
      : "__default_box__";

    // Rebuilding allocates a fresh InstancedMesh, which would discard the
    // very matrices freezing exists to preserve — so once frozen, never
    // rebuild, even if Shape or Count changes underneath.
    const mustRebuild = !state.mesh || state.sourceGeometryId !== sourceGeometryId || state.capacity !== capacity;
    if (mustRebuild && !(freeze && state.mesh)) {
      if (state.mesh) disposeObject3D(state.mesh);
      // Cloned, not shared: InstancedMesh takes ownership of its geometry for
      // disposal, and the Shape node still owns and draws the original.
      // The Shape's own rotation/scale is baked in so a flat primitive (Disc,
      // Plane — XY geometry laid down only by its node's default rotation)
      // instances the way it looks, not edge-on and upright.
      const geometry = sourceGeometry ? sourceGeometry.clone().applyMatrix4(shapeBasis!) : new THREE.BoxGeometry(1, 1, 1);
      // See withInstanceAlpha — always present so toggling Fade Opacity never
      // needs a shader recompile, just different values in this attribute.
      geometry.setAttribute("instanceAlpha", new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity)).fill(1), 1));
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff }), Math.max(1, capacity));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.userData.nodeId = ctx.nodeId;
      state.mesh = mesh;
      state.sourceGeometryId = sourceGeometryId;
      state.capacity = capacity;
    }
    // Always set: the rebuild guard above only skips when a mesh already
    // exists to preserve (`freeze && state.mesh`), so a missing one is still
    // built even with freeze on.
    const mesh = state.mesh!;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const alphaAttr = mesh.geometry.getAttribute("instanceAlpha") as THREE.InstancedBufferAttribute | undefined;

    let live = mesh.count;
    if (!freeze && texture && capacity > 0 && ctx.renderer) {
      live = 0;
      const size = textureSizeFor(capacity);
      const buffer = readPositionsSync(ctx.renderer, texture, size, ctx.nodeId);
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const position = new THREE.Vector3();
      for (let i = 0; i < capacity; i++) {
        // Same age >= 0 aliveness test particles/render's vertex shader uses —
        // a dead or still-pre-spawn texel is parked at the world origin, and
        // instancing those would stack a pile of meshes at (0,0,0).
        const age = buffer[i * 4 + 3];
        if (!isAlive(age)) continue;
        // Same 0->1->0 birth/death envelope as particles/render's vertex
        // shader (see POINT_VERTEX_SHADER) — lifetime <= 0 (unwired) holds it
        // at a constant 1, i.e. no fade.
        let envelope = 1;
        if (lifetime > 0) {
          // Same per-texel hash as particleRuntime.ts's POSITION_SHADER
          // myLifetime — has to match exactly, or the fade here (computed
          // from the mean Lifetime) finishes before or after the particle's
          // *actual* randomized death, popping it out mid-fade or leaving it
          // fully faded but still alive for a while.
          const lifeRand = fract(Math.sin(i * 78.233) * 43758.5453);
          const myLifetime = Math.max(0.0001, lifetime * (1 + lifetimeVariance * (lifeRand * 2 - 1)));
          const lifeT = Math.min(1, Math.max(0, age / myLifetime));
          const fadeIn = Math.min(1, Math.max(0, lifeT / fadeFraction));
          const fadeOut = Math.min(1, Math.max(0, (1 - lifeT) / fadeFraction));
          envelope = Math.min(fadeIn, fadeOut);
        }
        const sizeMul = fadeSize ? envelope : 1;
        position.set(buffer[i * 4], buffer[i * 4 + 1], buffer[i * 4 + 2]);
        scale.set(instanceScale * sizeMul, instanceScale * sizeMul, instanceScale * sizeMul);
        mesh.setMatrixAt(live, matrix.compose(position, quaternion, scale));
        if (alphaAttr) alphaAttr.setX(live, fadeOpacity ? envelope : 1);
        live++;
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (alphaAttr) alphaAttr.needsUpdate = true;
    } else if (!freeze) {
      // Live, but nothing to read (no texture / no renderer) — draw nothing
      // rather than leaving the previous frame's instances on screen.
      live = 0;
    }
    // Only the live prefix is drawn; the rest of the allocated capacity keeps
    // whatever stale matrices it had, unread. Frozen, `live` is simply
    // whatever the last live frame left here.
    mesh.count = live;

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);

    applyMaterialParams(mesh as unknown as THREE.Mesh, matParams, shapeSide(shapeMesh), texParams);
    // applyMaterialParams swaps in a brand-new material when Shadeless or
    // Transmission changes class (MeshBasicMaterial / MeshPhysicalMaterial),
    // which would silently drop the per-instance alpha chunk — reattach
    // whenever the material isn't already ours. Comparing the function
    // reference (not just truthiness) keeps this from forcing a recompile
    // every frame in the steady state.
    const mat = mesh.material as THREE.Material & { onBeforeCompile?: unknown };
    if (mat.onBeforeCompile !== withInstanceAlpha) {
      mat.onBeforeCompile = withInstanceAlpha;
      mat.needsUpdate = true;
    }

    return primitiveOutputs(mesh);
  },
};
