import * as THREE from "three";

/**
 * Cache signatures for the nodes whose work is far too expensive to redo every
 * frame (Boolean's CSG, Weld's voxel pass): what they hash has to detect every
 * change that would alter the result, and nothing else.
 */

/**
 * A cheap FNV-1a over the raw bytes of a position attribute. Animating a source
 * mesh at the *vertex* level (a deform feeding the node) mutates positions in
 * place and keeps the same geometry uuid, so a uuid-only cache signature would
 * wrongly reuse the stale result and freeze the animation. Hashing the
 * positions detects that change for a small per-evaluate cost (still far
 * cheaper than re-running the operation).
 */
export function hashPositions(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined): string {
  const arr = attr?.array as ArrayLike<number> | undefined;
  if (!arr) return "none";
  const view = new DataView(
    (arr as Float32Array).buffer,
    (arr as Float32Array).byteOffset,
    (arr as Float32Array).byteLength,
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.byteLength; i++) {
    hash ^= view.getUint8(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * One side of a two-input geometry operation, as something JSON.stringify can
 * compare: every mesh's geometry identity, vertex hash and world pose.
 *
 * The hashPositions memo is per-call, never across frames. Array instances are
 * clones that SHARE one geometry, so a side of 200 instances would otherwise
 * hash the same buffer 200 times every frame — but a longer-lived cache would
 * go stale, since positions mutate in place under a stable uuid (the whole
 * reason hashPositions exists).
 */
export function sideSignature(meshes: THREE.Mesh[]): unknown[] {
  const hashes = new Map<string, string>();
  return meshes.map((mesh) => {
    const geometry = mesh.geometry;
    let hash = hashes.get(geometry.uuid);
    if (hash === undefined) {
      hash = hashPositions(geometry.attributes.position);
      hashes.set(geometry.uuid, hash);
    }
    return [geometry.uuid, hash, [...mesh.matrixWorld.elements]];
  });
}
