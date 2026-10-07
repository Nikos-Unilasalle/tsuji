import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { createPRNG } from "../../math/random";
import { vectorsSignature } from "../curveLists";
import { isRealMesh } from "../../three/objectKinds";

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

interface SourcePart {
  mesh: THREE.Mesh;
  /** The part's pose relative to the source as a whole, the source's own pose included. */
  local: THREE.Matrix4;
}

/**
 * Every real mesh under `root` with its pose relative to the root's parent.
 * Fat lines are skipped: their position attribute is a quad template, not
 * the line (see objectKinds.ts), so merging copies of it draws nothing useful.
 */
function collectParts(root: THREE.Object3D): SourcePart[] {
  const parts: SourcePart[] = [];
  root.traverse((child) => {
    if (!isRealMesh(child) || !child.visible) return;
    const chain: THREE.Object3D[] = [];
    for (let o: THREE.Object3D | null = child; o; o = o === root ? null : o.parent) chain.push(o);
    const local = new THREE.Matrix4();
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].matrixAutoUpdate) chain[i].updateMatrix();
      local.multiply(chain[i].matrix);
    }
    parts.push({ mesh: child, local });
  });
  return parts;
}

/** `source` repeated once per matrix, as one geometry: Geometry Nodes' Realize Instances. */
export function mergeInstances(source: THREE.BufferGeometry, matrices: THREE.Matrix4[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const count = matrices.length;
  const vertexCount = source.getAttribute("position")?.count ?? 0;
  if (count === 0 || vertexCount === 0) return out;

  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const a = attribute as THREE.BufferAttribute;
    const size = a.itemSize;
    const data = new Float32Array(vertexCount * size * count);
    for (let k = 0; k < count; k++) {
      const offset = k * vertexCount * size;
      if (name === "normal") normalMatrix.getNormalMatrix(matrices[k]);
      for (let i = 0; i < vertexCount; i++) {
        const at = offset + i * size;
        if ((name === "position" || name === "normal") && size === 3) {
          v.set(a.getX(i), a.getY(i), a.getZ(i));
          if (name === "position") v.applyMatrix4(matrices[k]);
          else v.applyMatrix3(normalMatrix).normalize();
          data[at] = v.x;
          data[at + 1] = v.y;
          data[at + 2] = v.z;
        } else {
          for (let c = 0; c < size; c++) data[at + c] = a.getComponent(i, c);
        }
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(data, size, a.normalized));
  }

  const index = source.getIndex();
  if (index) {
    const indexCount = index.count;
    const indices = new Uint32Array(indexCount * count);
    for (let k = 0; k < count; k++) {
      for (let i = 0; i < indexCount; i++) indices[k * indexCount + i] = index.getX(i) + k * vertexCount;
    }
    out.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  const stride = index ? index.count : vertexCount;
  for (let k = 0; k < count; k++) {
    for (const g of source.groups) out.addGroup(g.start + k * stride, g.count, g.materialIndex);
  }
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * Rewrites the positions and normals of a geometry built by mergeInstances
 * for new matrices, in place. For copies that only move — floating,
 * drifting, swaying — this replaces allocating a whole new merged geometry
 * every frame with one pass over the same buffers.
 */
function rewriteInstances(target: THREE.BufferGeometry, source: THREE.BufferGeometry, matrices: THREE.Matrix4[]): void {
  const vertexCount = source.getAttribute("position")?.count ?? 0;
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const name of ["position", "normal"] as const) {
    const src = source.getAttribute(name) as THREE.BufferAttribute | undefined;
    const dst = target.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!src || !dst || src.itemSize !== 3) continue;
    const data = dst.array as Float32Array;
    for (let k = 0; k < matrices.length; k++) {
      if (name === "normal") normalMatrix.getNormalMatrix(matrices[k]);
      const offset = k * vertexCount * 3;
      for (let i = 0; i < vertexCount; i++) {
        v.set(src.getX(i), src.getY(i), src.getZ(i));
        if (name === "position") v.applyMatrix4(matrices[k]);
        else v.applyMatrix3(normalMatrix).normalize();
        data[offset + i * 3] = v.x;
        data[offset + i * 3 + 1] = v.y;
        data[offset + i * 3 + 2] = v.z;
      }
    }
    dst.needsUpdate = true;
  }
  target.computeBoundingSphere();
  target.computeBoundingBox();
}

interface InstanceState {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  signature?: string;
  /** What the merged buffers' sizes depend on: the source parts and the copy count. Matrices alone can be rewritten in place. */
  layout?: string;
}

const instanceCache = createNodeCache<InstanceState>((s) => {
  for (const m of s.meshes) m.geometry.dispose();
});

const DEG = Math.PI / 180;

// Once per node, not per frame — the same "log once, then stay quiet" contract as meshRequired.ts.
const noMeshWarned = new Set<string>();
function warnNoMesh(nodeId: string): void {
  if (noMeshWarned.has(nodeId)) return;
  noMeshWarned.add(nodeId);
  console.warn("Instance on Points: the geometry wired in has no mesh to copy (a line, points or an empty) — nothing is drawn.");
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function instanceMatrices(
  points: THREE.Vector3[],
  scales: unknown[],
  rotations: unknown[],
  ups: unknown[],
  params: Record<string, unknown>,
  seed: number,
): THREE.Matrix4[] {
  const scaleMin = num(undefined, params.scaleMin, 1);
  const scaleMax = num(undefined, params.scaleMax, 1);
  const spin = num(undefined, params.rotationJitter, 0) * DEG;
  const axisName = String(params.axis ?? "Z");
  const axis = axisName === "X" ? new THREE.Vector3(1, 0, 0) : axisName === "Y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const flip = Boolean(params.randomFlip);
  const rng = createPRNG(seed * 7919 + 5);
  return points.map((p, i) => {
    const s = scales[i];
    const scale = s instanceof THREE.Vector3 ? s.clone() : new THREE.Vector3().setScalar(Number.isFinite(Number(s)) && s !== undefined ? Number(s) : 1);
    scale.multiplyScalar(scaleMin + (scaleMax - scaleMin) * rng());
    if (flip && rng() < 0.5) scale.x = -scale.x;
    const r = rotations[i];
    // A number turns about Axis; a vector is Euler angles — both in degrees,
    // the same as Instance Transform's Rotations list.
    const jitter = new THREE.Quaternion().setFromAxisAngle(axis, spin * (rng() * 2 - 1));
    const q = r instanceof THREE.Vector3
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x * DEG, r.y * DEG, r.z * DEG))
      : new THREE.Quaternion().setFromAxisAngle(axis, Number.isFinite(Number(r)) && r !== undefined ? Number(r) * DEG : 0);
    q.multiply(jitter);
    // Tilt last, so the copy turns about its own up first and then leans with
    // the surface it rests on — a leaf spun at random, then riding a wave.
    const up = ups[i];
    if (up instanceof THREE.Vector3 && up.lengthSq() > 1e-12) {
      q.premultiply(new THREE.Quaternion().setFromUnitVectors(WORLD_UP, up.clone().normalize()));
    }
    return new THREE.Matrix4().compose(p, q, scale);
  });
}

/**
 * Places a copy of the geometry on every point and merges the copies into
 * one mesh per source part — one draw call however many there are, so a
 * hillside of a few hundred painted trees stays cheap. Each part keeps its
 * own material, shared with the source by reference. With no points wired
 * there is a single copy at the origin.
 */
export const INSTANCE_ON_POINTS_NODE: NodeDefinition = {
  type: "structure/instance-on-points",
  label: "Instance on Points",
  category: "instance",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "points", label: "Points (Vector List)", type: "list" },
    { id: "scales", label: "Scales (List)", type: "list" },
    { id: "rotations", label: "Rotations (List, °: angles or Euler vectors)", type: "list" },
    // A surface normal per point (Ripple Field's Probe Normals, Mesh to
    // Points' normals): each copy's own up leans to match it.
    { id: "ups", label: "Ups (Direction List)", type: "list" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { visible: 1, scaleMin: 1, scaleMax: 1, rotationJitter: 0, axis: "Z", randomFlip: false, seed: 0 },
  paramFields: [
    { id: "visible", label: "Visible", kind: "boolean" },
    { id: "scaleMin", label: "Random Scale Min", kind: "number", step: 0.05 },
    { id: "scaleMax", label: "Random Scale Max", kind: "number", step: 0.05 },
    { id: "rotationJitter", label: "Random Rotation (±°)", kind: "number", step: 1 },
    { id: "axis", label: "Rotation Axis", kind: "select", options: ["X", "Y", "Z"] },
    { id: "randomFlip", label: "Random Mirror (X)", kind: "boolean" },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    let state = instanceCache.get(ctx.nodeId);
    if (!state) {
      const group = new THREE.Group();
      group.userData.nodeId = ctx.nodeId;
      state = { group, meshes: [] };
      instanceCache.set(ctx.nodeId, state);
    }
    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const points = Array.isArray(inputs.points)
      ? inputs.points.filter((p): p is THREE.Vector3 => p instanceof THREE.Vector3)
      : [new THREE.Vector3()];
    const scales = Array.isArray(inputs.scales) ? inputs.scales : [];
    const rotations = Array.isArray(inputs.rotations) ? inputs.rotations : [];
    const ups = Array.isArray(inputs.ups) ? inputs.ups : [];
    const seed = Math.round(num(inputs.seed, params.seed, 0));
    const parts = source ? collectParts(source) : [];
    if (source && parts.length === 0) warnNoMesh(ctx.nodeId);
    else noMeshWarned.delete(ctx.nodeId);

    const partsSignature = parts.map((p) => `${p.mesh.geometry.uuid}:${(p.mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined)?.version ?? 0}:${p.local.elements.map((e) => e.toFixed(5)).join(",")}`);
    const signature = JSON.stringify([
      partsSignature,
      vectorsSignature(points),
      vectorsSignature(scales),
      vectorsSignature(rotations),
      vectorsSignature(ups),
      params.scaleMin, params.scaleMax, params.rotationJitter, params.axis, params.randomFlip, seed,
    ]);
    const layout = JSON.stringify([partsSignature, points.length]);

    if (signature !== state.signature && layout === state.layout && state.meshes.length === parts.length) {
      state.signature = signature;
      const matrices = instanceMatrices(points, scales, rotations, ups, params, seed);
      parts.forEach((part, i) => rewriteInstances(state!.meshes[i].geometry, part.mesh.geometry, matrices.map((m) => m.clone().multiply(part.local))));
    } else if (signature !== state.signature) {
      state.signature = signature;
      state.layout = layout;
      const matrices = instanceMatrices(points, scales, rotations, ups, params, seed);
      while (state.meshes.length > parts.length) {
        const gone = state.meshes.pop()!;
        gone.geometry.dispose();
        state.group.remove(gone);
      }
      parts.forEach((part, i) => {
        let mesh = state!.meshes[i];
        if (!mesh) {
          mesh = new THREE.Mesh();
          mesh.matrixAutoUpdate = false;
          state!.meshes.push(mesh);
          state!.group.add(mesh);
        }
        mesh.geometry.dispose();
        mesh.geometry = mergeInstances(part.mesh.geometry, matrices.map((m) => m.clone().multiply(part.local)));
      });
    }

    parts.forEach((part, i) => {
      const mesh = state!.meshes[i];
      if (mesh.material !== part.mesh.material) mesh.material = part.mesh.material;
      mesh.castShadow = part.mesh.castShadow;
      mesh.receiveShadow = part.mesh.receiveShadow;
      mesh.renderOrder = part.mesh.renderOrder;
      mesh.userData.pivot = part.mesh.userData.pivot;
      mesh.userData.nodeId = ctx.nodeId;
    });
    return { geometry: state.group, count: source ? points.length : 0 };
  },
};
