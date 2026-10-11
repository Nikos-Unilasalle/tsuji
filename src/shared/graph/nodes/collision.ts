import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { getBoundsTree, initBvhRaycast } from "../../three/bvh";
import { isRealMesh } from "../../three/objectKinds";
import { createNodeCache } from "../nodeCaches";
import { fromBoolean } from "../sockets";
import { NodeDefinition } from "../types";
import { worldMatrixOf } from "../objectPosition";

const MODES = ["mesh", "bounds"] as const;
type CollisionMode = (typeof MODES)[number];

interface Part {
  mesh: THREE.Mesh;
  /** World pose, taken now through the local chain (matrixWorld is stale mid-evaluation). */
  matrix: THREE.Matrix4;
  /** World-space bounding box. */
  box: THREE.Box3;
}

interface CollisionState {
  colliding: boolean;
  lastTime: number;
  epoch: number;
}

const stateCache = createNodeCache<CollisionState>();

function collectParts(root: unknown): Part[] {
  if (!(root instanceof THREE.Object3D)) return [];
  const parts: Part[] = [];
  root.traverse((child) => {
    if (!isRealMesh(child) || !child.visible) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    if (!geometry?.attributes?.position || geometry.attributes.position.count < 3) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const matrix = worldMatrixOf(child);
    parts.push({ mesh: child, matrix, box: geometry.boundingBox!.clone().applyMatrix4(matrix) });
  });
  return parts;
}

const _toA = new THREE.Matrix4();

/** Does any part of A touch any part of B? */
export function partsCollide(a: Part[], b: Part[], mode: CollisionMode): boolean {
  if (mode === "mesh") initBvhRaycast();
  for (const pa of a) {
    for (const pb of b) {
      // Cheap reject first — with a Group of pieces on one side this skips almost every pair.
      if (!pa.box.intersectsBox(pb.box)) continue;
      if (mode === "bounds") return true;
      const bvh: MeshBVH = getBoundsTree(pa.mesh.geometry);
      // B's local space -> A's local space.
      _toA.copy(pa.matrix).invert().multiply(pb.matrix);
      if (bvh.intersectsGeometry(pb.mesh.geometry, _toA)) return true;
    }
  }
  return false;
}

/**
 * Collision — tells you when two objects touch.
 *
 * `trigger` pulses for one frame at the moment they start touching (wire it to
 * an Explosion, a Spawner, a Counter…); `colliding` stays 1 for as long as they
 * overlap. Either input can be a whole Group, an Array or a Merge — it counts as
 * touching when *any* piece of A meets *any* piece of B.
 *
 * - **mesh** tests the actual triangles, so a ball passing beside a ring does
 *   not count. Surfaces that cross count; one object sitting entirely inside a
 *   closed other, without its surface ever reaching it, does not.
 * - **bounds** tests bounding boxes only: instant, but it also fires for
 *   corners that merely share a box.
 *
 * The test is geometric, on the poses the graph gives — it works the same for a
 * hand-animated object as for one a Rigid Body is moving, and needs no physics
 * world.
 */
export const COLLISION_NODE: NodeDefinition = {
  type: "logic/collision",
  label: "Collision",
  category: "logic",
  inputs: [
    { id: "a", label: "Geometry A", type: "geometry" },
    { id: "b", label: "Geometry B", type: "geometry" },
  ],
  outputs: [
    { id: "trigger", label: "Trigger (on hit)", type: "value" },
    { id: "colliding", label: "Colliding", type: "value" },
  ],
  defaultParams: { mode: "mesh" },
  paramFields: [
    { id: "mode", label: "Test", kind: "select", options: [...MODES] },
    {
      id: "note",
      label:
        "mesh: exact triangle test. bounds: bounding boxes only — instant but approximate. " +
        "Trigger pulses once when contact starts; Colliding holds while it lasts.",
      kind: "note",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    let state = stateCache.get(ctx.nodeId);
    if (!state) {
      state = { colliding: false, lastTime: ctx.time, epoch: ctx.simulationEpoch ?? 0 };
      stateCache.set(ctx.nodeId, state);
    }

    // A rewind or Reset Simulation re-arms the edge, so the next contact triggers again.
    const epoch = ctx.simulationEpoch ?? 0;
    if (ctx.time < state.lastTime || state.epoch !== epoch) state.colliding = false;
    state.lastTime = ctx.time;
    state.epoch = epoch;

    const mode: CollisionMode = (MODES as readonly string[]).includes(String(params.mode)) ? (params.mode as CollisionMode) : "mesh";
    const a = collectParts(inputs.a);
    const b = collectParts(inputs.b);
    const colliding = a.length > 0 && b.length > 0 && partsCollide(a, b, mode);

    const hit = colliding && !state.colliding;
    state.colliding = colliding;
    return { trigger: fromBoolean(hit), colliding: fromBoolean(colliding) };
  },
};
