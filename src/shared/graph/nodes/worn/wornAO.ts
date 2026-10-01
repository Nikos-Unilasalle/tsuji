import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { WornEntry } from "./wornGeometry";

/*
 * Ambient occlusion per vertex, for grime: how much of the sky each point of
 * the surface sees, from rays cast over its hemisphere against the mesh
 * itself (a BVH makes each ray cheap). Where the cloth doesn't reach and the
 * rain doesn't rinse — under a lip, deep in a joint, between two parts — is
 * where dirt settles, whatever the edge angles say.
 *
 * Progressive: each call spends a small time budget and resumes where it
 * stopped, so a big mesh fills its occlusion in over a few frames instead of
 * freezing one. It runs in the rest space, so it is baked once per shape.
 */

/** Rays per vertex. */
const RAYS = 16;
/** How far an occluder counts, in rest space (fractions of the mesh's size). */
export const AO_REACH = 0.25;

export interface WornAOJob {
  weldedPositions: { x: number[]; y: number[]; z: number[] };
  vertexNormals: Float32Array;
  triangles: Int32Array;
  valid: Uint8Array;
  weldOf: Int32Array;
  sourceOf: Int32Array;
  next: number;
  done: boolean;
  bvh?: MeshBVH;
  /** Prepared vertices of each welded vertex (CSR). */
  offsets?: Int32Array;
  members?: Int32Array;
}

/** Cosine-weighted directions over the +Z hemisphere (a Fibonacci spiral: even, deterministic). */
const SAMPLES: THREE.Vector3[] = Array.from({ length: RAYS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / RAYS);
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - r * r)));
});

function setUp(job: WornAOJob) {
  const { x, y, z } = job.weldedPositions;
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(x.length * 3);
  for (let i = 0; i < x.length; i++) {
    pos[i * 3] = x[i]; pos[i * 3 + 1] = y[i]; pos[i * 3 + 2] = z[i];
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const index: number[] = [];
  for (let t = 0; t < job.valid.length; t++) {
    if (job.valid[t]) index.push(job.triangles[t * 3], job.triangles[t * 3 + 1], job.triangles[t * 3 + 2]);
  }
  if (index.length === 0) {
    job.done = true;
    return;
  }
  geometry.setIndex(index);
  job.bvh = new MeshBVH(geometry);

  const W = x.length;
  const counts = new Int32Array(W + 1);
  for (let i = 0; i < job.sourceOf.length; i++) counts[job.weldOf[job.sourceOf[i]] + 1]++;
  for (let w = 0; w < W; w++) counts[w + 1] += counts[w];
  const members = new Int32Array(job.sourceOf.length);
  const fill = counts.slice(0, W);
  for (let i = 0; i < job.sourceOf.length; i++) members[fill[job.weldOf[job.sourceOf[i]]]++] = i;
  job.offsets = counts;
  job.members = members;
}

const ray = new THREE.Ray();
const tangent = new THREE.Vector3();
const bitangent = new THREE.Vector3();
const normal = new THREE.Vector3();

/** Spends up to `budgetMs` on the entry's occlusion; returns true once it is complete. */
export function advanceWornAO(entry: WornEntry, budgetMs: number): boolean {
  const job = entry.ao;
  if (job.done) return true;
  if (!job.bvh) {
    setUp(job);
    if (job.done) return true;
  }
  const surface = entry.prepared.getAttribute("aWornSurface") as THREE.BufferAttribute;
  const array = surface.array as Float32Array;
  const { x, y, z } = job.weldedPositions;
  const W = x.length;
  const start = performance.now();
  let touched = false;
  while (job.next < W) {
    const v = job.next++;
    normal.set(job.vertexNormals[v * 3], job.vertexNormals[v * 3 + 1], job.vertexNormals[v * 3 + 2]);
    let open = 1;
    if (normal.lengthSq() > 1e-18) {
      normal.normalize();
      // Any basis around the normal will do: the samples are rotationally even.
      tangent.set(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0).cross(normal).normalize();
      bitangent.crossVectors(normal, tangent);
      let hits = 0;
      for (const s of SAMPLES) {
        ray.origin.set(x[v], y[v], z[v]).addScaledVector(normal, 1e-4);
        ray.direction.set(0, 0, 0).addScaledVector(tangent, s.x).addScaledVector(bitangent, s.y).addScaledVector(normal, s.z).normalize();
        if (job.bvh!.raycastFirst(ray, THREE.DoubleSide, 1e-4, AO_REACH)) hits++;
      }
      open = 1 - hits / RAYS;
    }
    for (let k = job.offsets![v]; k < job.offsets![v + 1]; k++) array[job.members![k] * 2 + 1] = open;
    touched = true;
    if ((job.next & 31) === 0 && performance.now() - start > budgetMs) break;
  }
  if (touched) surface.needsUpdate = true;
  if (job.next >= W) {
    job.done = true;
    job.bvh = undefined;
  }
  return job.done;
}
