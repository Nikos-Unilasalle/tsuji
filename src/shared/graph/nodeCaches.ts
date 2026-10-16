import * as THREE from "three";

/**
 * Registry of every per-node cache, so deleting a node can actually drop the
 * state it owned.
 *
 * Nodes that own something a pure `evaluate` can't hand back fresh each frame
 * — a THREE.Mesh the viewport keeps in its scene, a loaded texture, a
 * flip-flop's remembered state — keep it in a module-level Map keyed by the
 * node's id (see the `EvalContext.nodeId` doc). Nothing used to clear those
 * on deletion, which was more than the memory leak it was filed as: node ids
 * are *stable*, saved into .ovm files and restored identically by undo, so a
 * node that came back with its old id silently picked its old mesh, texture
 * or toggle state back out of the cache. Deleting a node and re-adding it
 * looked like it "remembered" the previous values because it genuinely did.
 *
 * Caches keyed by anything other than a node id (a sprite name, a file path)
 * must NOT be registered here — they are shared across nodes on purpose.
 */

type NodeCacheDisposer = (nodeId: string) => void;

const disposers: NodeCacheDisposer[] = [];

/**
 * A Map keyed by node id that cleans up after itself. `disposeValue` is for
 * entries holding GPU resources that need an explicit release (geometry,
 * material, render target); omit it for plain state.
 */
export function createNodeCache<T>(disposeValue?: (value: T) => void): Map<string, T> {
  const cache = new Map<string, T>();
  disposers.push((nodeId) => {
    const value = cache.get(nodeId);
    if (value === undefined) return;
    if (disposeValue) {
      try {
        disposeValue(value);
      } catch {
        // A failed release must not stop the other caches from clearing.
      }
    }
    cache.delete(nodeId);
  });
  return cache;
}

/** Drops every cached resource belonging to these nodes. Call when nodes are deleted from the graph. */
export function disposeNodeCaches(nodeIds: Iterable<string>): void {
  for (const nodeId of nodeIds) {
    for (const dispose of disposers) dispose(nodeId);
  }
}

/** Frees a mesh-like object's GPU resources — the common disposer for scene-object caches. */
export function disposeObject3D(object: { traverse: (cb: (o: any) => void) => void }): void {
  object.traverse((child: any) => {
    child.geometry?.dispose?.();
    const material = child.material;
    if (Array.isArray(material)) material.forEach((m: any) => m?.dispose?.());
    else material?.dispose?.();
  });
}

/**
 * Keeps a cached group's editor helper (camera body + frustum lines, …) and
 * rebuilds it only when `key` — whatever its shape depends on, fov and the
 * like — changes, disposing the one it replaces.
 *
 * Rebuilding every frame behind a bare `group.clear()` leaked: clear() only
 * detaches, so each frame's geometries and materials were left behind, and
 * once one had been drawn the renderer kept its GPU buffers for good. Every
 * camera in a scene leaked 2–3 geometries per frame that way.
 */
export function syncHelperContent(
  group: THREE.Group,
  nodeId: string,
  key: string,
  build: () => THREE.Object3D,
): void {
  if (group.userData.helperKey === key && group.children.length === 1) return;
  for (const child of group.children) disposeObject3D(child);
  group.clear();
  const helper = build();
  helper.traverse((child) => {
    child.userData.nodeId = nodeId;
  });
  group.add(helper);
  group.userData.helperKey = key;
}
