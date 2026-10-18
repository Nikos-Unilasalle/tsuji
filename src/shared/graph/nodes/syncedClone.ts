import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";

/**
 * Copies a node hands out every frame, kept and re-synced instead of
 * re-cloned.
 *
 * The structure nodes (Set Instance Color/Transform, Get Instance, Geometry
 * Transform, Spawn) used to `clone(true)` their source on every evaluate:
 * thousands of Object3Ds (plus their vectors, matrices and an empty
 * placeholder geometry per Mesh) allocated and dropped every frame, and a
 * new identity each time for everything downstream that caches by object.
 *
 * A kept copy is brought back in line with its source by `Object3D.copy(src,
 * false)` down the two trees in step — the very copy `clone()` itself runs on
 * a fresh object — so the result is what a fresh clone would be. Only when
 * the source's shape changed (another kind of object somewhere, children
 * added or removed) is a real clone taken.
 *
 * Unlike instancePool.ts (Array), which only re-syncs the root matrix of a
 * copy keyed by source identity, this keeps every per-object property in
 * step — materials, child transforms, visibility, userData — because these
 * nodes patch exactly those on their copies.
 */

let reuseEnabled = true;

/** Off: every call is a fresh clone(true), the old behaviour — for tests comparing the two. */
export function setSyncedCloneEnabled(enabled: boolean): void {
  reuseEnabled = enabled;
}

/** A node's kept copies, by node id; slot `i` is the copy it handed out i-th. */
const slotsByNode = createNodeCache<THREE.Object3D[]>();

export function cloneSlots(nodeId: string): THREE.Object3D[] {
  let slots = slotsByNode.get(nodeId);
  if (!slots) {
    slots = [];
    slotsByNode.set(nodeId, slots);
  }
  return slots;
}

function sameShape(source: THREE.Object3D, copy: THREE.Object3D): boolean {
  if (source.constructor !== copy.constructor) return false;
  const a = source.children;
  const b = copy.children;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameShape(a[i], b[i])) return false;
  }
  return true;
}

function copyInto(source: THREE.Object3D, copy: THREE.Object3D): void {
  copy.copy(source, false);
  const instanced = copy as THREE.InstancedMesh;
  if (instanced.isInstancedMesh) {
    // BufferAttribute.copy swaps in a new array without bumping the version,
    // so the GPU would keep drawing the old instance matrices.
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  }
  for (let i = 0; i < source.children.length; i++) copyInto(source.children[i], copy.children[i]);
}

/**
 * A copy of `source` as `clone(true)` would make it, reusing the one in
 * `slots[index]` when it has the same shape.
 */
export function syncedClone(slots: THREE.Object3D[], index: number, source: THREE.Object3D): THREE.Object3D {
  const kept = slots[index];
  if (reuseEnabled && kept && sameShape(source, kept)) {
    copyInto(source, kept);
    return kept;
  }
  const fresh = source.clone(true);
  slots[index] = fresh;
  return fresh;
}

/** Drops kept copies past `count` — a source that shrank should not pin its old instances. */
export function trimSlots(slots: THREE.Object3D[], count: number): void {
  if (slots.length > count) slots.length = count;
}
