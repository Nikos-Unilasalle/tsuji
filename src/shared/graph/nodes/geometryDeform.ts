import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { numberInput } from "./object";

interface DeformTarget {
  source: THREE.Mesh;
  output: THREE.Mesh;
  /** The undeformed positions every frame's deformation starts from. */
  base: Float32Array;
}

interface DeformState {
  object?: THREE.Object3D;
  targets?: DeformTarget[];
  /** What the cached targets were built from — see reuseDeformTargets. */
  signature?: string;
}

/**
 * Disposes only the geometries owned by this deformer.
 * NEVER dispose materials: they are shared with and owned by upstream nodes.
 */
function disposeDeformedObject(obj?: THREE.Object3D) {
  if (!obj) return;
  obj.traverse((child: any) => {
    if (child.geometry && typeof child.geometry.dispose === "function") {
      child.geometry.dispose();
    }
  });
}

const twistCache = createNodeCache<DeformState>((s) => {
  if (s.object) disposeDeformedObject(s.object);
});
const waveCache = createNodeCache<DeformState>((s) => {
  if (s.object) disposeDeformedObject(s.object);
});
const explodeCache = createNodeCache<DeformState>((s) => {
  if (s.object) disposeDeformedObject(s.object);
});

/**
 * The meshes this deformer writes its result into, reused across frames.
 *
 * These nodes used to dispose their whole output and rebuild it from
 * `srcGeom.clone()` on every single evaluate — a new BufferGeometry, and so a
 * full GPU re-upload, sixty times a second even while nothing moved. It cost
 * nothing visible, which is why it survived; it also broke every downstream
 * cache that keys on geometry identity, physics included, back when physics
 * did.
 *
 * So: one output geometry per source, kept, with the undeformed positions held
 * alongside it. Each frame copies those back in and deforms them in place —
 * the deformation is still recomputed from scratch, it just stops reallocating
 * the buffer it writes into. Rebuilt only when the input is a different set of
 * meshes, or the same ones with a different topology.
 */
function reuseDeformTargets(
  state: DeformState,
  meshes: THREE.Mesh[],
  nonIndexed: boolean,
): DeformTarget[] {
  const signature = meshes
    .map((mesh) => {
      const geometry = mesh.geometry;
      return `${geometry.uuid}:${geometry.attributes.position?.count ?? 0}:${geometry.getIndex()?.count ?? -1}`;
    })
    .join("|");

  if (state.targets && state.signature === signature) {
    for (const target of state.targets) {
      const position = target.output.geometry.attributes.position as THREE.BufferAttribute;
      (position.array as Float32Array).set(target.base);
      position.needsUpdate = true;
    }
    return state.targets;
  }

  disposeDeformedObject(state.object);
  state.object = undefined;

  state.targets = meshes.map((source) => {
    const geometry = nonIndexed && source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone();
    const output = new THREE.Mesh(geometry, source.material);
    output.castShadow = source.castShadow;
    output.receiveShadow = source.receiveShadow;
    output.renderOrder = source.renderOrder;
    return {
      source,
      output,
      base: new Float32Array((geometry.attributes.position as THREE.BufferAttribute).array),
    };
  });
  state.signature = signature;
  return state.targets;
}

/** The deformed meshes as one object: the mesh itself for a single one, a Group for several. */
function deformedObject(state: DeformState, targets: DeformTarget[], raw: THREE.Object3D): THREE.Object3D {
  const single = raw instanceof THREE.Mesh && targets.length === 1;
  if (state.object && (single ? state.object === targets[0].output : state.object.children.length === targets.length)) {
    return state.object;
  }

  if (single) {
    state.object = targets[0].output;
    return state.object;
  }

  const group = new THREE.Group();
  for (const target of targets) group.add(target.output);
  state.object = group;
  return group;
}

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Resolves the effective transformation matrix of an input geometry,
 * preferring explicit `inputs.matrix`, then the source object's world matrix or local matrix.
 */
function resolveObjectMatrix(
  inputs: Record<string, unknown>,
  raw: unknown,
  srcMesh: THREE.Mesh,
): THREE.Matrix4 {
  if (inputs.matrix instanceof THREE.Matrix4) {
    return inputs.matrix.clone();
  }
  const inputObj = raw instanceof THREE.Object3D ? raw : srcMesh;
  inputObj.updateMatrixWorld(true);
  return inputObj.matrixWorld?.clone() ?? inputObj.matrix?.clone() ?? srcMesh.matrix?.clone() ?? new THREE.Matrix4();
}

/**
 * Applies transform and metadata to the deformed result object (Mesh or Group).
 */
function applyResultTransform(
  resultObj: THREE.Object3D,
  matrix: THREE.Matrix4,
  nodeId: string,
  srcObj: THREE.Object3D,
) {
  resultObj.castShadow = srcObj.castShadow;
  resultObj.receiveShadow = srcObj.receiveShadow;
  resultObj.userData = { ...srcObj.userData, nodeId };
  resultObj.matrixAutoUpdate = false;
  resultObj.matrix.copy(matrix);
  matrix.decompose(resultObj.position, resultObj.quaternion, resultObj.scale);
  resultObj.matrixWorldNeedsUpdate = true;
}

/**
 * 1. Twist, Bend & Taper Parametric Geometry Modifier
 */
export const GEOMETRY_TWIST_BEND_TAPER_NODE: NodeDefinition = {
  type: "geometry/twist-bend-taper",
  label: "Twist / Bend / Taper",
  category: "structure",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "twist", label: "Twist (°)", type: "value" },
    { id: "bend", label: "Bend (°)", type: "value" },
    { id: "taper", label: "Taper", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    twist: 0,
    bend: 0,
    taper: 0,
    axis: "y",
  },
  paramFields: [
    { id: "twist", label: "Twist (°)", kind: "number", step: 5.0 },
    { id: "bend", label: "Bend (°)", kind: "number", step: 5.0 },
    { id: "taper", label: "Taper", kind: "number", step: 0.1 },
    {
      id: "axis",
      label: "Deform Axis",
      kind: "select",
      options: ["y", "x", "z"],
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      if (raw) warnMeshRequired(ctx.nodeId, "Twist/Bend/Taper", null);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Twist/Bend/Taper", raw);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    clearMeshWarning(ctx.nodeId);

    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    const twistDeg = numberInput(inputs.twist, params.twist, 0);
    const bendDeg = numberInput(inputs.bend, params.bend, 0);
    const taperVal = numberInput(inputs.taper, params.taper, 0);
    const axis = String(params.axis || "y").toLowerCase();

    // Fast pass-through if no deformation is requested — leaves upstream hierarchy untouched
    if (Math.abs(twistDeg) < 1e-4 && Math.abs(bendDeg) < 1e-4 && Math.abs(taperVal) < 1e-4) {
      return { geometry: raw, matrix: objMatrix };
    }

    let state = twistCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      twistCache.set(ctx.nodeId, state);
    }
    const targets = reuseDeformTargets(state, meshes, false);

    const twistRad = (twistDeg * Math.PI) / 180;
    const bendRad = (bendDeg * Math.PI) / 180;

    const axisIdx = axis === "x" ? 0 : axis === "z" ? 2 : 1;
    const uIdx = (axisIdx + 1) % 3;
    const vIdx = (axisIdx + 2) % 3;

    // Determine overall bounds along chosen axis
    let minAxis = Infinity;
    let maxAxis = -Infinity;
    for (const mesh of meshes) {
      const pos = mesh.geometry?.attributes?.position;
      if (!pos) continue;
      for (let i = 0; i < pos.count; i++) {
        const val = pos.getComponent(i, axisIdx);
        if (val < minAxis) minAxis = val;
        if (val > maxAxis) maxAxis = val;
      }
    }
    if (!Number.isFinite(minAxis) || !Number.isFinite(maxAxis)) {
      return { geometry: raw, matrix: objMatrix };
    }
    const diff = maxAxis - minAxis;
    const height = Math.max(1e-4, diff);

    function deformMesh(target: DeformTarget): THREE.Mesh {
      const geom = target.output.geometry;
      const pos = geom.attributes.position;
      const count = pos.count;

      for (let i = 0; i < count; i++) {
        let hVal = pos.getComponent(i, axisIdx);
        let uVal = pos.getComponent(i, uIdx);
        let vVal = pos.getComponent(i, vIdx);

        const normH = diff > 1e-6 ? (hVal - minAxis) / height : 0.5;

        // 1. Taper: scale cross-section
        if (Math.abs(taperVal) > 1e-4) {
          const s = Math.max(0.001, 1.0 + taperVal * normH);
          uVal *= s;
          vVal *= s;
        }

        // 2. Twist: rotate cross-section
        if (Math.abs(twistRad) > 1e-4) {
          const angle = twistRad * normH;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);
          const nextU = uVal * cosA - vVal * sinA;
          const nextV = uVal * sinA + vVal * cosA;
          uVal = nextU;
          vVal = nextV;
        }

        // 3. Bend: curve along axis
        if (Math.abs(bendRad) > 1e-4 && diff > 1e-6) {
          const radius = height / bendRad;
          const alpha = bendRad * normH;
          hVal = minAxis + radius * Math.sin(alpha);
          uVal += radius * (1.0 - Math.cos(alpha));
        }

        if (!Number.isFinite(hVal)) hVal = 0;
        if (!Number.isFinite(uVal)) uVal = 0;
        if (!Number.isFinite(vVal)) vVal = 0;

        pos.setComponent(i, axisIdx, hVal);
        pos.setComponent(i, uIdx, uVal);
        pos.setComponent(i, vIdx, vVal);
      }

      pos.needsUpdate = true;
      geom.computeVertexNormals();

      return target.output;
    }

    for (const target of targets) deformMesh(target);
    const resultObject = deformedObject(state, targets, raw);
    applyResultTransform(resultObject, objMatrix, ctx.nodeId, raw);

    return {
      geometry: resultObject,
      matrix: resultObject.matrix,
    };
  },
};

/**
 * 2. Wave & Ripple Parametric Geometry Modifier
 */
export const GEOMETRY_WAVE_RIPPLE_NODE: NodeDefinition = {
  type: "geometry/wave-ripple",
  label: "Wave / Ripple",
  category: "structure",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "amplitude", label: "Amplitude", type: "value" },
    { id: "frequency", label: "Frequency", type: "value" },
    { id: "speed", label: "Speed", type: "value" },
    { id: "decay", label: "Decay (Ripple)", type: "value" },
    { id: "centerX", label: "Center X", type: "value" },
    { id: "centerZ", label: "Center Z", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    amplitude: 0.3,
    frequency: 3.0,
    speed: 2.0,
    decay: 0.2,
    centerX: 0,
    centerZ: 0,
    mode: "ripple",
    space: "local",
  },
  paramFields: [
    { id: "amplitude", label: "Amplitude", kind: "number", step: 0.05 },
    { id: "frequency", label: "Frequency", kind: "number", step: 0.2 },
    { id: "speed", label: "Speed", kind: "number", step: 0.2 },
    { id: "decay", label: "Decay (Ripple)", kind: "number", step: 0.05 },
    { id: "centerX", label: "Center X", kind: "number", step: 0.5 },
    { id: "centerZ", label: "Center Z", kind: "number", step: 0.5 },
    {
      id: "mode",
      label: "Pattern Mode",
      kind: "select",
      options: ["ripple", "linear"],
    },
    {
      id: "space",
      label: "Deform Space",
      kind: "select",
      options: ["local", "world"],
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      if (raw) warnMeshRequired(ctx.nodeId, "Wave/Ripple", null);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Wave/Ripple", raw);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    clearMeshWarning(ctx.nodeId);

    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    const objScale = new THREE.Vector3();
    const objQuat = new THREE.Quaternion();
    const objPos = new THREE.Vector3();
    objMatrix.decompose(objPos, objQuat, objScale);

    const amp = numberInput(inputs.amplitude, params.amplitude, 0.3);
    const freq = numberInput(inputs.frequency, params.frequency, 3.0);
    const speed = numberInput(inputs.speed, params.speed, 2.0);
    const decay = numberInput(inputs.decay, params.decay, 0.2);
    const cx = numberInput(inputs.centerX, params.centerX, 0);
    const cz = numberInput(inputs.centerZ, params.centerZ, 0);
    const mode = String(params.mode || "ripple").toLowerCase();
    const space = String(params.space || "local").toLowerCase();
    const time = ctx.time ?? 0;

    // Fast pass-through if amplitude is negligible
    if (Math.abs(amp) < 1e-4) {
      return { geometry: raw, matrix: objMatrix };
    }

    let state = waveCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      waveCache.set(ctx.nodeId, state);
    }
    const targets = reuseDeformTargets(state, meshes, false);

    const invMatrix = space === "world" ? objMatrix.clone().invert() : null;
    const sx = Math.abs(objScale.x) > 1e-4 ? objScale.x : 1;
    const sz = Math.abs(objScale.z) > 1e-4 ? objScale.z : 1;

    function deformMesh(target: DeformTarget): THREE.Mesh {
      const geom = target.output.geometry;
      const pos = geom.attributes.position;
      const count = pos.count;

      for (let i = 0; i < count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);

        if (space === "world") {
          const worldPt = new THREE.Vector3(x, y, z).applyMatrix4(objMatrix);
          let displacement = 0;
          if (mode === "ripple") {
            const dx = worldPt.x - cx;
            const dz = worldPt.z - cz;
            const dist = Math.sqrt(dx * dx + dz * dz);
            const attenuation = Math.exp(-dist * decay);
            displacement = amp * Math.sin(dist * freq - time * speed) * attenuation;
          } else {
            displacement = amp * Math.sin(worldPt.x * freq - time * speed);
          }
          worldPt.y += displacement;
          const localPt = worldPt.applyMatrix4(invMatrix!);
          pos.setXYZ(i, localPt.x, localPt.y, localPt.z);
        } else {
          let displacement = 0;
          if (mode === "ripple") {
            const dx = x * sx - cx;
            const dz = z * sz - cz;
            const dist = Math.sqrt(dx * dx + dz * dz);
            const attenuation = Math.exp(-dist * decay);
            displacement = amp * Math.sin(dist * freq - time * speed) * attenuation;
          } else {
            displacement = amp * Math.sin(x * sx * freq - time * speed);
          }
          pos.setY(i, y + displacement);
        }
      }

      pos.needsUpdate = true;
      geom.computeVertexNormals();

      return target.output;
    }

    for (const target of targets) deformMesh(target);
    const resultObject = deformedObject(state, targets, raw);
    applyResultTransform(resultObject, objMatrix, ctx.nodeId, raw);

    return {
      geometry: resultObject,
      matrix: resultObject.matrix,
    };
  },
};

/**
 * 3. Facet Explode Geometry Modifier
 */
export const GEOMETRY_FACET_EXPLODE_NODE: NodeDefinition = {
  type: "geometry/facet-explode",
  label: "Facet Explode",
  category: "structure",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "distance", label: "Explosion Dist", type: "value" },
    { id: "randomFactor", label: "Random Spread", type: "value" },
    { id: "scale", label: "Facet Scale", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    distance: 0.5,
    randomFactor: 0.5,
    scale: 0.9,
  },
  paramFields: [
    { id: "distance", label: "Explosion Dist", kind: "number", step: 0.05 },
    { id: "randomFactor", label: "Random Spread", kind: "number", step: 0.05 },
    { id: "scale", label: "Facet Scale", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      if (raw) warnMeshRequired(ctx.nodeId, "Facet Explode", null);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Facet Explode", raw);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    clearMeshWarning(ctx.nodeId);

    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    const dist = numberInput(inputs.distance, params.distance, 0.5);
    const randFactor = numberInput(inputs.randomFactor, params.randomFactor, 0.5);
    const scale = numberInput(inputs.scale, params.scale, 0.9);

    if (dist < 1e-4 && Math.abs(scale - 1.0) < 1e-4) {
      return { geometry: raw, matrix: objMatrix };
    }

    let state = explodeCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      explodeCache.set(ctx.nodeId, state);
    }
    // Non-indexed: every face has to move away from its neighbours, which
    // means no vertex may be shared with one.
    const targets = reuseDeformTargets(state, meshes, true);

    function deformMesh(target: DeformTarget): THREE.Mesh {
      const nonIndexed = target.output.geometry;
      const pos = nonIndexed.attributes.position;
      const faceCount = Math.floor(pos.count / 3);

      const vA = new THREE.Vector3();
      const vB = new THREE.Vector3();
      const vC = new THREE.Vector3();
      const centroid = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const edge1 = new THREE.Vector3();
      const edge2 = new THREE.Vector3();

      for (let f = 0; f < faceCount; f++) {
        const idxA = f * 3;
        const idxB = f * 3 + 1;
        const idxC = f * 3 + 2;

        vA.fromBufferAttribute(pos, idxA);
        vB.fromBufferAttribute(pos, idxB);
        vC.fromBufferAttribute(pos, idxC);

        centroid.set(0, 0, 0).add(vA).add(vB).add(vC).divideScalar(3);

        edge1.subVectors(vB, vA);
        edge2.subVectors(vC, vA);
        normal.crossVectors(edge1, edge2).normalize();

        const r = pseudoRandom(f + 1);
        const faceDist = dist * (1.0 + (r - 0.5) * randFactor);
        const displacement = normal.clone().multiplyScalar(faceDist);

        vA.sub(centroid).multiplyScalar(scale).add(centroid).add(displacement);
        vB.sub(centroid).multiplyScalar(scale).add(centroid).add(displacement);
        vC.sub(centroid).multiplyScalar(scale).add(centroid).add(displacement);

        pos.setXYZ(idxA, vA.x, vA.y, vA.z);
        pos.setXYZ(idxB, vB.x, vB.y, vB.z);
        pos.setXYZ(idxC, vC.x, vC.y, vC.z);
      }

      pos.needsUpdate = true;
      nonIndexed.computeVertexNormals();
      return target.output;
    }

    for (const target of targets) deformMesh(target);
    const resultObject = deformedObject(state, targets, raw);
    applyResultTransform(resultObject, objMatrix, ctx.nodeId, raw);

    return {
      geometry: resultObject,
      matrix: resultObject.matrix,
    };
  },
};
