import * as THREE from "three";
import { wornPool } from "./wornPool";
import type { WornEntry } from "./wornGeometry";

/*
 * Impacts: where a physics body was hit hard enough to chip. The Rigid Body
 * node records them (a point on the mesh and how hard) and hands them here;
 * each prepared geometry keeps its own in the shared pool, as a range of
 * "edges" of a different kind — (point, radius), (speed, –) — that every
 * vertex points to, so the shader can loop over them.
 *
 * Kept per geometry: a crate that fell down the stairs is chipped wherever it
 * was knocked, not where its neighbour was. (Copies sharing one geometry
 * share their dents too; instances aren't recorded at all.)
 */

/** Impacts one geometry keeps: the shader's loop bound. */
export const MAX_IMPACTS = 24;
/** Below this change of speed (m/s) a contact is resting, not a knock. */
export const MIN_IMPACT_SPEED = 0.8;

export interface WornImpact {
  /** Where, in the mesh's own space. */
  x: number;
  y: number;
  z: number;
  /** How hard: the change of speed the hit caused, m/s. */
  speed: number;
}

/** Chip radius in rest space (a fraction of the object's size): wider for harder knocks, levelling off. */
export function impactRadius(speed: number): number {
  return 0.05 * Math.sqrt(Math.min(Math.max(speed, 0), 12) / 3);
}

/**
 * Adds a knock to a list, merging it into one already close by (the same
 * collision reported over several steps, a box rocking on one corner) and
 * dropping the softest once the list is full. Positions in mesh space, `size`
 * the mesh's largest extent. Returns whether anything changed.
 */
export function addImpact(list: WornImpact[], hit: WornImpact, size: number): boolean {
  if (!(hit.speed >= MIN_IMPACT_SPEED)) return false;
  for (const other of list) {
    const d = Math.hypot(other.x - hit.x, other.y - hit.y, other.z - hit.z) / Math.max(size, 1e-9);
    if (d < impactRadius(Math.max(other.speed, hit.speed)) * 0.6) {
      if (hit.speed <= other.speed) return false;
      other.speed = hit.speed;
      return true;
    }
  }
  list.push({ ...hit });
  if (list.length > MAX_IMPACTS) {
    let softest = 0;
    for (let i = 1; i < list.length; i++) if (list[i].speed < list[softest].speed) softest = i;
    list.splice(softest, 1);
  }
  return true;
}

/**
 * Shows `impacts` on a prepared geometry (one that went through a Worn
 * material). `key` names this state of the list: the same key again costs
 * nothing, so it is fine to call every frame. Returns false for a geometry
 * that isn't a prepared one.
 */
export function setWornImpacts(geometry: THREE.BufferGeometry, impacts: readonly WornImpact[], key: string): boolean {
  const entry = geometry.userData?.__wornEntry as WornEntry | undefined;
  if (!entry) return false;
  if (entry.impactKey === key) return true;
  entry.impactKey = key;
  entry.releaseImpacts?.();
  entry.releaseImpacts = undefined;

  const attribute = entry.prepared.getAttribute("aWornImpacts") as THREE.BufferAttribute | undefined;
  if (!attribute) return false;
  const array = attribute.array as Float32Array;
  const list = impacts.slice(-MAX_IMPACTS);
  if (list.length === 0) {
    array.fill(0);
    attribute.needsUpdate = true;
    return true;
  }
  const data = new Float32Array(list.length * 8);
  list.forEach((hit, i) => {
    data.set([hit.x / entry.size, hit.y / entry.size, hit.z / entry.size, impactRadius(hit.speed), hit.speed, 0, 0, 0], i * 8);
  });
  entry.releaseImpacts = wornPool.add(data, new Float32Array(0), (edgeBase) => {
    for (let i = 0; i < attribute.count; i++) {
      array[i * 2] = edgeBase;
      array[i * 2 + 1] = list.length;
    }
    attribute.needsUpdate = true;
  });
  return true;
}

/** Whether a mesh draws with a Worn material — only those are worth recording impacts for. */
export function drawsWorn(mesh: THREE.Object3D): mesh is THREE.Mesh {
  const material = (mesh as THREE.Mesh).isMesh ? (mesh as THREE.Mesh).material : null;
  if (!material) return false;
  return (Array.isArray(material) ? material : [material]).some((m) => (m as any)?.__isWornMaterial);
}
