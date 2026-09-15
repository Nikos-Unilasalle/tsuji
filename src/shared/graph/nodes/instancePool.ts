import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { getSourcePivot } from "./transform";

/** One reused copy of the source, and the wrapper carrying its instance matrix. */
interface PooledInstance {
  wrapper: THREE.Group;
  clone: THREE.Object3D;
}

/** The pool of copies each instancing node keeps, by node id. */
export const instancePoolCache = createNodeCache<Map<string, PooledInstance[]>>();

/** What the source is, as opposed to where it is: identity plus the geometry it draws. */
function sourceSignature(source: THREE.Object3D): string {
  const geometries: string[] = [];
  source.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) geometries.push(mesh.geometry.uuid);
  });
  return `${source.uuid}:${geometries.join(",")}`;
}


export type InstancePool = Map<string, PooledInstance[]>;

/**
 * Copies of a source object, kept across frames and handed out in order.
 *
 * `Object3D.clone(true)` per instance per frame is what the instancing nodes
 * used to do: 200 copies is 200 Groups and 200 clones allocated and thrown
 * away sixty times a second — 1.09 ms a frame on a plain box, 6.5% of the
 * frame budget for one node — and a different mesh identity every frame,
 * which misses every downstream cache keyed on it.
 *
 * Copies are keyed by what the source *is* rather than where it is (see
 * sourceSignature), so a source that swaps its geometry gets fresh copies and
 * one that merely moves gets its existing ones re-synced.
 *
 * Nothing here is ever disposed: a clone shares its geometry and material with
 * the source it was copied from, so releasing them would blank out the
 * original object.
 */
export function acquireInstance(
  pool: InstancePool,
  handedOut: Map<string, number>,
  itemSource: THREE.Object3D,
  instanceMatrix: THREE.Matrix4,
): THREE.Group {
  const sourcePivot = getSourcePivot(itemSource);
  const hasPivot = sourcePivot.lengthSq() > 1e-9;

  const key = sourceSignature(itemSource);
  const copies = pool.get(key) ?? [];
  if (!pool.has(key)) pool.set(key, copies);
  const index = handedOut.get(key) ?? 0;
  handedOut.set(key, index + 1);

  let pooled = copies[index];
  if (!pooled) {
    const wrapper = new THREE.Group();
    wrapper.matrixAutoUpdate = false;
    const clone = itemSource.clone(true);
    wrapper.add(clone);
    pooled = { wrapper, clone };
    copies[index] = pooled;
  }

  // Re-synced every frame either way: the source may have moved since the copy
  // was taken, and the pivot is folded out of the copy's own matrix so the
  // wrapper's instance matrix turns it about the pivot rather than its origin.
  pooled.clone.matrixAutoUpdate = false;
  pooled.clone.matrix.copy(itemSource.matrix);
  if (hasPivot) {
    pooled.clone.matrix.multiply(new THREE.Matrix4().makeTranslation(-sourcePivot.x, -sourcePivot.y, -sourcePivot.z));
  }
  pooled.clone.matrixWorldNeedsUpdate = true;

  pooled.wrapper.matrix.copy(instanceMatrix);
  if (hasPivot) pooled.wrapper.userData.pivot = sourcePivot.clone();
  else delete pooled.wrapper.userData.pivot;

  return pooled.wrapper;
}
