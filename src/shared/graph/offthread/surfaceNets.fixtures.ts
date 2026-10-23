import { UV_DENSITY } from "../mesh/uv";
import { MeshBuffers } from "./marchingCubes";
import { BLOB_POINT, BLOB_SEGMENT, BLOB_STRIDE, BlobElementSpec, blobIso, BlobsJob, writeBlobElement } from "./surfaceNets";

/** Shared by the Surface Nets tests and bench. */

/** mulberry32, so every run sees the same elements. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function blobsJob(specs: BlobElementSpec[], resolution: number, smooth = 1.6, colors = false): BlobsJob {
  const elements = new Float64Array(specs.length * BLOB_STRIDE);
  let n = 0;
  for (const spec of specs) if (writeBlobElement(elements, n, { ...spec, smooth })) n++;
  return {
    elements: elements.subarray(0, n * BLOB_STRIDE),
    iso: blobIso(smooth),
    resolution,
    maxVertices: 1_000_000,
    maxIndices: 6_000_000,
    colors,
    uvDensity: UV_DENSITY,
  };
}

/** A mix of every element kind: spheres, rotated ellipsoids, capsules, a few carving ones, all coloured. */
export function sampleBlobsJob(resolution: number, count: number, seed = 7): BlobsJob {
  const rand = seeded(seed);
  const specs: BlobElementSpec[] = [];
  for (let i = 0; i < count; i++) {
    const a = [rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2] as const;
    const radius = 0.3 + rand() * 0.5;
    const weight = i % 7 === 6 ? -0.6 : 1;
    const color = [rand(), rand(), rand()] as const;
    const kind = i % 3;
    if (kind === 1) {
      specs.push({ kind: BLOB_SEGMENT, a, b: [a[0] + rand() - 0.5, a[1] + rand() * 1.5, a[2] + rand() - 0.5], radius: radius * 0.6, smooth: 1, weight, color });
    } else if (kind === 2) {
      const t = rand() * Math.PI;
      const sx = 0.6 + rand(), sy = 0.6 + rand() * 0.5, sz = 0.6 + rand() * 0.8;
      // Rotation about z times scale.
      const c = Math.cos(t), s = Math.sin(t);
      specs.push({ kind: BLOB_POINT, a, radius, smooth: 1, weight, color, shape: [c * sx, -s * sy, 0, s * sx, c * sy, 0, 0, 0, sz] });
    } else {
      specs.push({ kind: BLOB_POINT, a, radius, smooth: 1, weight, color });
    }
  }
  // Two polylines, joined as chains: a carving one through the middle of the other.
  for (const [chain, weight, x] of [[1, 1, -1.5], [2, -0.5, 1.5]] as const) {
    for (let i = 0; i < 5; i++) {
      const y0 = -1.5 + i * 0.6;
      specs.push({ kind: BLOB_SEGMENT, a: [x + rand() * 0.4, y0, rand() * 0.4], b: [x + rand() * 0.4, y0 + 0.6, rand() * 0.4], radius: 0.25 + rand() * 0.1, smooth: 1, weight, chain });
    }
  }
  return blobsJob(specs, resolution, 1.6, true);
}

/** Signed volume enclosed by an indexed mesh (positive when it winds outward). */
export function meshVolume(mesh: MeshBuffers): number {
  const ix = mesh.index!;
  const p = mesh.position;
  let vol = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return vol / 6;
}

/** Edges not shared by exactly two triangles — zero for a closed manifold surface. */
export function openEdges(mesh: MeshBuffers): number {
  const ix = mesh.index!;
  const edges = new Map<number, number>();
  const n = mesh.count;
  for (let i = 0; i < ix.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = ix[i + k], b = ix[i + ((k + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const v of edges.values()) if (v !== 2) bad++;
  return bad;
}

/** Connected pieces of an indexed mesh. */
export function components(mesh: MeshBuffers): number {
  const parent = Int32Array.from({ length: mesh.count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const ix = mesh.index!;
  for (let i = 0; i < ix.length; i += 3) {
    parent[find(ix[i])] = find(ix[i + 1]);
    parent[find(ix[i + 1])] = find(ix[i + 2]);
  }
  let n = 0;
  for (let i = 0; i < mesh.count; i++) if (find(i) === i) n++;
  return n;
}
