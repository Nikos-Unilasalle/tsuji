import { MapMesh } from "./mesh";

export interface RiverParams {
  /** Fraction of land points that carry a river (0..0.2). */
  density: number;
}

export interface RiverData {
  /** Elevation after depression filling: lakes are the flat bits. */
  filled: Float32Array;
  /** Next point downhill, or -1 for sea/edge outlets. */
  downstream: Int32Array;
  /** Accumulated discharge, 0..1 relative to the biggest river. */
  flow: Float32Array;
  isRiver: Uint8Array;
  isLake: Uint8Array;
  /** Each river as an ordered list of point indices, source to mouth. */
  paths: number[][];
}

/** Binary min-heap of (key, id) pairs; ties break on id so output is deterministic. */
class MinHeap {
  private keys: number[] = [];
  private ids: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  private less(a: number, b: number): boolean {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.ids[a] < this.ids[b]);
  }
  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
  }
  push(key: number, id: number): void {
    this.keys.push(key);
    this.ids.push(id);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): number {
    const top = this.ids[0];
    const lastKey = this.keys.pop()!;
    const lastId = this.ids.pop()!;
    if (this.ids.length > 0) {
      this.keys[0] = lastKey;
      this.ids[0] = lastId;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.less(l, m)) m = l;
        if (r < this.ids.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

const EPS = 1e-5;

/**
 * Priority-flood drainage: flood inwards from the sea and map edge, always
 * visiting the lowest unvisited point next. Every point gets a downstream
 * neighbour that is already drained, so water can never get stuck in a pit —
 * pits become lakes. Discharge then accumulates from the headwaters down.
 */
export function generateRivers(mesh: MapMesh, elevation: Float32Array, rainfall: Float32Array, p: RiverParams): RiverData {
  const n = mesh.numPoints;
  const filled = new Float32Array(n);
  const downstream = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  const heap = new MinHeap();
  const popOrder: number[] = [];

  for (let i = 0; i < n; i++) {
    if (elevation[i] <= 0 || mesh.isBoundary[i]) {
      filled[i] = elevation[i];
      visited[i] = 1;
      heap.push(filled[i], i);
    }
  }
  while (heap.size > 0) {
    const cur = heap.pop();
    popOrder.push(cur);
    for (let k = mesh.adjStart[cur]; k < mesh.adjStart[cur + 1]; k++) {
      const nb = mesh.adjList[k];
      if (visited[nb]) continue;
      visited[nb] = 1;
      filled[nb] = Math.max(elevation[nb], filled[cur] + EPS);
      downstream[nb] = cur;
      heap.push(filled[nb], nb);
    }
  }

  // Walk the flood order backwards (highest first) so each point's discharge is final before it passes it on.
  const raw = new Float32Array(n);
  for (let idx = popOrder.length - 1; idx >= 0; idx--) {
    const i = popOrder[idx];
    if (elevation[i] > 0) raw[i] += 0.02 + rainfall[i];
    const d = downstream[i];
    if (d >= 0) raw[d] += raw[i];
  }
  let max = 0;
  for (let i = 0; i < n; i++) if (elevation[i] > 0 && !mesh.isBoundary[i]) max = Math.max(max, raw[i]);
  const flow = new Float32Array(n);
  for (let i = 0; i < n; i++) flow[i] = max > 0 ? Math.min(1, raw[i] / max) : 0;

  const isLake = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (elevation[i] > 0 && filled[i] - elevation[i] > 1e-3) isLake[i] = 1;

  // Rivers: the busiest `density` fraction of land points.
  const landFlows: number[] = [];
  for (let i = 0; i < n; i++) if (elevation[i] > 0 && !mesh.isBoundary[i]) landFlows.push(flow[i]);
  landFlows.sort((a, b) => a - b);
  const q = Math.min(landFlows.length - 1, Math.floor(landFlows.length * (1 - Math.max(0, Math.min(0.5, p.density)))));
  const threshold = landFlows.length > 0 ? landFlows[Math.max(0, q)] : Infinity;
  const isRiver = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (elevation[i] > 0 && !mesh.isBoundary[i] && flow[i] >= threshold && threshold > 0) isRiver[i] = 1;

  // Trace polylines: start at river points nothing river-ish drains into, follow downstream to the sea or a river already traced.
  const hasUpstream = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (isRiver[i] && downstream[i] >= 0 && isRiver[downstream[i]]) hasUpstream[downstream[i]] = 1;
  const seen = new Uint8Array(n);
  const paths: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (!isRiver[s] || hasUpstream[s]) continue;
    const path = [s];
    seen[s] = 1;
    let cur = s;
    for (;;) {
      const d = downstream[cur];
      if (d < 0) break;
      path.push(d);
      if (!isRiver[d] || seen[d]) break;
      seen[d] = 1;
      cur = d;
    }
    if (path.length >= 2) paths.push(path);
  }

  return { filled, downstream, flow, isRiver, isLake, paths };
}
