import * as THREE from "three";

/**
 * Where a graph object actually *is*, for the nodes that only want to read a
 * position off one.
 *
 * Two things make `setFromMatrixPosition(object.matrixWorld)` the wrong
 * answer here, and both are properties of how this graph builds objects
 * rather than anything three.js does wrong:
 *
 *  - `matrixWorld` is stale during evaluation. Instancing nodes write
 *    `object.matrix` directly on wrapper Groups with `matrixAutoUpdate` off
 *    and never raise `matrixWorldNeedsUpdate`; the renderer papers over it
 *    with its own `scene.updateMatrixWorld(true)`, which runs *after* the
 *    graph has already been evaluated.
 *
 *  - The object handed down a wire is usually a wrapper. Geometry Transform,
 *    Set Instance Transform and Squash & Stretch all return a Group sitting
 *    at the origin whose *child* carries the pose. Reading the root gives
 *    (0,0,0) every frame — which is not obviously wrong, it just silently
 *    pins whatever asked to the origin.
 */

/**
 * World matrix walked from local matrices, since the cached `matrixWorld` is
 * stale mid-evaluation.
 *
 * The one implementation in the project, and the physics runtime re-exports
 * it: there used to be a second copy there that skipped the `updateMatrix()`
 * below, so an object posed through `.position`/`.quaternion` rather than by
 * writing `.matrix` — anything out of the OBJ loader, anything three itself
 * built — reported (0, 0, 0) and had its rigid body created at the origin.
 *
 * `target` is for the physics loop, which does this per body per frame and
 * would rather not allocate.
 */
export function worldMatrixOf(object: THREE.Object3D, target = new THREE.Matrix4()): THREE.Matrix4 {
  const chain: THREE.Object3D[] = [];
  for (let current: THREE.Object3D | null = object; current; current = current.parent) chain.push(current);

  target.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    if (node.matrixAutoUpdate) node.updateMatrix();
    target.multiply(node.matrix);
  }
  return target;
}

/**
 * The object's world position, descending through wrapper Groups to the first
 * real payload so the answer is the object's own pose rather than the
 * (usually identity) wrapper's.
 */
export function objectWorldPosition(object: THREE.Object3D): THREE.Vector3 {
  const world = worldMatrixOf(object);

  let target: THREE.Object3D = object;
  while (target instanceof THREE.Group && target.children.length > 0) {
    target = target.children[0];
    if (target.matrixAutoUpdate) target.updateMatrix();
    world.multiply(target.matrix);
  }

  return new THREE.Vector3().setFromMatrixPosition(world);
}
