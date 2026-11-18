import * as THREE from "three";
import { growingSockets } from "../dynamicInputs";
import { clearMeshWarning, findFirstMesh, warnMeshRequired } from "../meshRequired";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";

const TARGET_PREFIX = "target";
const LABEL = "Make Morph Targets";

interface Built {
  /** What the cache was built from: each input's position attribute and its version, basis first. */
  sources: (THREE.BufferAttribute | null)[];
  versions: number[];
  names: string;
  output: THREE.Object3D;
  geometry: THREE.BufferGeometry;
  matched: number;
}

const builtCache = createNodeCache<Built>((built) => built.geometry.dispose());
/** Mismatches already reported, so a skipped target warns once rather than every frame. */
const warned = new Set<string>();

function targetKeysOf(inputs: Record<string, unknown>): string[] {
  return Object.keys(inputs)
    .filter((k) => k.startsWith(TARGET_PREFIX) && Number.isInteger(Number(k.slice(TARGET_PREFIX.length))))
    .sort((a, b) => Number(a.slice(TARGET_PREFIX.length)) - Number(b.slice(TARGET_PREFIX.length)));
}

function positionOf(mesh: THREE.Mesh | null): THREE.BufferAttribute | null {
  const attr = mesh?.geometry?.attributes.position;
  return attr instanceof THREE.BufferAttribute ? attr : null;
}

/** The same node in a clone: clone() copies children in order, so the traversal index lines up. */
function counterpart(root: THREE.Object3D, copy: THREE.Object3D, node: THREE.Object3D): THREE.Object3D {
  const path: THREE.Object3D[] = [];
  root.traverse((o) => path.push(o));
  const index = path.indexOf(node);
  let found: THREE.Object3D = copy;
  let i = 0;
  copy.traverse((o) => {
    if (i++ === index) found = o;
  });
  return found;
}

/**
 * Make Morph Targets — turns a basis mesh and N reshaped copies of it (Sculpt, Lattice, any
 * deformer that keeps the vertex count) into one mesh carrying real, named shape keys: three's
 * morph targets, blended on the GPU, which Morph Targets drives by name and a glTF export keeps.
 *
 * Each target is stored as the difference from the basis, in the basis mesh's own space, so a
 * target moved or scaled by a transform upstream lands where it is seen. Normals get their delta
 * too, or the shading would stay that of the rest pose while the shape moves.
 *
 * A target whose vertex count differs from the basis's (a Sculpt with dyntopo on, a different
 * subdivision) cannot be paired vertex to vertex and is skipped, with a warning.
 */
export const MAKE_MORPH_TARGETS_NODE: NodeDefinition = {
  type: "object/make-morph-targets",
  label: LABEL,
  category: "object",
  inputs: [
    { id: "basis", label: "Basis", type: "geometry" },
    { id: `${TARGET_PREFIX}0`, label: "Target 1", type: "geometry" },
  ],
  dynamicInputs: (connections) => [
    { id: "basis", label: "Basis", type: "geometry" as const },
    ...growingSockets(connections, TARGET_PREFIX, (i) => ({
      id: `${TARGET_PREFIX}${i}`,
      label: `Target ${i + 1}`,
      type: "geometry" as const,
    })),
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "count", label: "Shape Keys", type: "value" },
  ],
  defaultParams: { names: "open, wide, round" },
  paramFields: [
    {
      id: "names",
      label: "Shape key names, comma-separated, one per target (unnamed: target4, target5 …)",
      kind: "text",
    },
    {
      id: "morphNote",
      label: "Targets must keep the basis's vertex count: turn dyntopo off in a Sculpt used as a target.",
      kind: "note",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const root = inputs.basis;
    if (!(root instanceof THREE.Object3D)) return { geometry: undefined, count: 0 };
    const basisMesh = findFirstMesh(root);
    const basisPos = positionOf(basisMesh);
    if (!basisMesh || !basisPos) {
      warnMeshRequired(ctx.nodeId, LABEL, root);
      return { geometry: root, count: 0 };
    }
    clearMeshWarning(ctx.nodeId);

    const keys = targetKeysOf(inputs);
    const targetRoots = keys.map((k) => (inputs[k] instanceof THREE.Object3D ? (inputs[k] as THREE.Object3D) : null));
    const targetMeshes = targetRoots.map((t) => (t ? findFirstMesh(t) : null));
    const sources = [basisPos, ...targetMeshes.map(positionOf)];
    const versions = sources.map((s) => s?.version ?? -1);
    const names = String(params.names ?? "");

    const cached = builtCache.get(ctx.nodeId);
    if (
      cached &&
      cached.names === names &&
      cached.sources.length === sources.length &&
      cached.sources.every((s, i) => s === sources[i] && cached.versions[i] === versions[i])
    ) {
      return { geometry: cached.output, count: cached.matched };
    }

    const nameList = names.split(",").map((s) => s.trim());
    const geometry = basisMesh.geometry.clone();
    geometry.morphAttributes = {};
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const basisNormal = geometry.attributes.normal as THREE.BufferAttribute;
    const count = basisPos.count;

    root.updateMatrixWorld(true);
    const toBasis = basisMesh.matrixWorld.clone().invert();
    const positions: THREE.BufferAttribute[] = [];
    const normals: THREE.BufferAttribute[] = [];
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();

    targetMeshes.forEach((mesh, t) => {
      const pos = positionOf(mesh);
      if (!mesh || !pos) return;
      // A deformer that unshares vertices (one copy per triangle corner) keeps the shape's order:
      // corner k of the target is basis vertex index[k], so each basis vertex reads its first corner.
      const basisIndex = basisMesh.geometry.index;
      const unshared = pos.count !== count && !!basisIndex && pos.count === basisIndex.count;
      if (pos.count !== count && !unshared) {
        const key = `${ctx.nodeId}:${t}:${pos.count}:${count}`;
        if (!warned.has(key)) {
          warned.add(key);
          console.warn(
            `[${LABEL}] Target ${t + 1} has ${pos.count} vertices, the basis has ${count} — skipped: shape keys pair vertices one to one. ` +
              `Something upstream re-cut the mesh (Sculpt with dyntopo, Twist/Bend with a bend or twist, a subdivision).`,
          );
        }
        return;
      }
      targetRoots[t]!.updateMatrixWorld(true);
      const toLocal = toBasis.clone().multiply(mesh.matrixWorld);

      // The target's shape, one position per basis vertex, in the basis mesh's space.
      const shape = new Float32Array(count * 3);
      const corner = new Int32Array(count).map((_, i) => i);
      if (unshared) for (let k = basisIndex!.count - 1; k >= 0; k--) corner[basisIndex!.getX(k)] = k;
      for (let i = 0; i < count; i++) {
        p.fromBufferAttribute(pos, corner[i]).applyMatrix4(toLocal);
        shape[i * 3] = p.x;
        shape[i * 3 + 1] = p.y;
        shape[i * 3 + 2] = p.z;
      }

      // Its normals: the target's own when they line up with the basis's vertices, otherwise
      // recomputed over the basis's triangles (an unshared target's are flat, one per face).
      let shapeNormal: THREE.BufferAttribute;
      const ownNormal = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined;
      if (!unshared && ownNormal && ownNormal.count === count) {
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(toLocal);
        shapeNormal = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
        for (let i = 0; i < count; i++) {
          n.fromBufferAttribute(ownNormal, i).applyMatrix3(normalMatrix).normalize();
          shapeNormal.setXYZ(i, n.x, n.y, n.z);
        }
      } else {
        const scratch = new THREE.BufferGeometry();
        scratch.setAttribute("position", new THREE.BufferAttribute(shape, 3));
        if (basisIndex) scratch.setIndex(basisIndex);
        scratch.computeVertexNormals();
        shapeNormal = scratch.attributes.normal as THREE.BufferAttribute;
      }

      const dPos = new Float32Array(count * 3);
      const dNor = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        dPos[i * 3] = shape[i * 3] - basisPos.getX(i);
        dPos[i * 3 + 1] = shape[i * 3 + 1] - basisPos.getY(i);
        dPos[i * 3 + 2] = shape[i * 3 + 2] - basisPos.getZ(i);
        dNor[i * 3] = shapeNormal.getX(i) - basisNormal.getX(i);
        dNor[i * 3 + 1] = shapeNormal.getY(i) - basisNormal.getY(i);
        dNor[i * 3 + 2] = shapeNormal.getZ(i) - basisNormal.getZ(i);
      }
      const name = nameList[t] || `target${t + 1}`;
      const posDelta = new THREE.BufferAttribute(dPos, 3);
      posDelta.name = name;
      const norDelta = new THREE.BufferAttribute(dNor, 3);
      norDelta.name = name;
      positions.push(posDelta);
      normals.push(norDelta);
    });

    if (positions.length > 0) {
      geometry.morphAttributes.position = positions;
      geometry.morphAttributes.normal = normals;
      geometry.morphTargetsRelative = true;
    }

    const output = root.clone();
    const mesh = counterpart(root, output, basisMesh) as THREE.Mesh;
    mesh.geometry = geometry;
    // updateMorphTargets builds the name → slot dictionary and the zeroed influences from the attribute names.
    mesh.morphTargetInfluences = undefined;
    mesh.morphTargetDictionary = undefined;
    mesh.updateMorphTargets();

    cached?.geometry.dispose();
    builtCache.set(ctx.nodeId, { sources, versions, names, output, geometry, matched: positions.length });
    return { geometry: output, count: positions.length };
  },
};
