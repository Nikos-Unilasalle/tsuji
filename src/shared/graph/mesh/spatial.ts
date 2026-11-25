/**
 * A static 3-D k-d tree over a point set: nearest neighbour, k nearest and
 * radius queries. Built once per point set (O(n log n)), queried many times —
 * attribute propagation, Attribute Transfer, Select by Distance and Fuse all
 * ask "which source point is closest to this one" thousands of times a build.
 *
 * Points are copied into one Float64Array, the tree is an index permutation
 * (median split, implicit layout), so a tree costs ~12 bytes per point and no
 * per-node objects.
 */
export class PointTree {
  readonly count: number;
  private readonly xyz: Float64Array;
  private readonly order: Int32Array;
  private readonly axis: Uint8Array;

  constructor(points: ArrayLike<readonly number[]> | Float64Array | Float32Array, stride3 = false) {
    if (stride3 || points instanceof Float64Array || points instanceof Float32Array) {
      const flat = points as ArrayLike<number>;
      this.count = Math.floor(flat.length / 3);
      this.xyz = Float64Array.from(flat as ArrayLike<number>);
    } else {
      const list = points as ArrayLike<readonly number[]>;
      this.count = list.length;
      this.xyz = new Float64Array(this.count * 3);
      for (let i = 0; i < this.count; i++) {
        const p = list[i];
        this.xyz[i * 3] = p[0];
        this.xyz[i * 3 + 1] = p[1];
        this.xyz[i * 3 + 2] = p[2];
      }
    }
    this.order = new Int32Array(this.count);
    for (let i = 0; i < this.count; i++) this.order[i] = i;
    this.axis = new Uint8Array(this.count);
    this.build(0, this.count);
  }

  private build(lo: number, hi: number): void {
    // Iterative over a manual stack: deep recursion on 100k+ points is fine
    // in V8 but cheap to avoid.
    const stack: number[] = [lo, hi];
    while (stack.length) {
      const h = stack.pop()!;
      const l = stack.pop()!;
      if (h - l <= 1) continue;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = l; i < h; i++) {
        const j = this.order[i] * 3;
        const x = this.xyz[j], y = this.xyz[j + 1], z = this.xyz[j + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
      const ax = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
      const mid = (l + h) >> 1;
      this.select(l, h - 1, mid, ax);
      this.axis[mid] = ax;
      stack.push(l, mid, mid + 1, h);
    }
  }

  /** Quickselect on `order[l..r]` so `order[k]` is the k-th smallest along `ax`. */
  private select(l: number, r: number, k: number, ax: number): void {
    const o = this.order;
    const v = (i: number) => this.xyz[o[i] * 3 + ax];
    while (r > l) {
      const pivot = v((l + r) >> 1);
      let i = l, j = r;
      while (i <= j) {
        while (v(i) < pivot) i++;
        while (v(j) > pivot) j--;
        if (i <= j) {
          const t = o[i];
          o[i] = o[j];
          o[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) r = j;
      else if (k >= i) l = i;
      else return;
    }
  }

  point(i: number): [number, number, number] {
    return [this.xyz[i * 3], this.xyz[i * 3 + 1], this.xyz[i * 3 + 2]];
  }

  /** Index of the nearest point (-1 when empty), and its squared distance. */
  nearest(x: number, y: number, z: number): { index: number; distSq: number } {
    let best = -1;
    let bestD = Infinity;
    const visit = (lo: number, hi: number) => {
      if (hi <= lo) return;
      const mid = (lo + hi) >> 1;
      const j = this.order[mid];
      const px = this.xyz[j * 3], py = this.xyz[j * 3 + 1], pz = this.xyz[j * 3 + 2];
      const d = (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
      if (hi - lo === 1) return;
      const ax = this.axis[mid];
      const diff = (ax === 0 ? x : ax === 1 ? y : z) - (ax === 0 ? px : ax === 1 ? py : pz);
      const [first, second] = diff < 0 ? [[lo, mid], [mid + 1, hi]] : [[mid + 1, hi], [lo, mid]];
      visit(first[0], first[1]);
      if (diff * diff < bestD) visit(second[0], second[1]);
    };
    visit(0, this.count);
    return { index: best, distSq: bestD };
  }

  /** Up to `k` nearest points, closest first. */
  kNearest(x: number, y: number, z: number, k: number, maxDist = Infinity): { index: number; distSq: number }[] {
    const found: { index: number; distSq: number }[] = [];
    const limit = maxDist * maxDist;
    const worst = () => (found.length < k ? limit : found[found.length - 1].distSq);
    const insert = (index: number, distSq: number) => {
      let i = found.length;
      found.push({ index, distSq });
      while (i > 0 && found[i - 1].distSq > distSq) {
        found[i] = found[i - 1];
        i--;
      }
      found[i] = { index, distSq };
      if (found.length > k) found.pop();
    };
    const visit = (lo: number, hi: number) => {
      if (hi <= lo) return;
      const mid = (lo + hi) >> 1;
      const j = this.order[mid];
      const px = this.xyz[j * 3], py = this.xyz[j * 3 + 1], pz = this.xyz[j * 3 + 2];
      const d = (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z);
      if (d <= worst()) insert(j, d);
      if (hi - lo === 1) return;
      const ax = this.axis[mid];
      const diff = (ax === 0 ? x : ax === 1 ? y : z) - (ax === 0 ? px : ax === 1 ? py : pz);
      const [first, second] = diff < 0 ? [[lo, mid], [mid + 1, hi]] : [[mid + 1, hi], [lo, mid]];
      visit(first[0], first[1]);
      if (diff * diff <= worst()) visit(second[0], second[1]);
    };
    if (k > 0) visit(0, this.count);
    return found;
  }

  /** Every point within `radius` (unordered). */
  within(x: number, y: number, z: number, radius: number): number[] {
    const out: number[] = [];
    const r2 = radius * radius;
    const visit = (lo: number, hi: number) => {
      if (hi <= lo) return;
      const mid = (lo + hi) >> 1;
      const j = this.order[mid];
      const px = this.xyz[j * 3], py = this.xyz[j * 3 + 1], pz = this.xyz[j * 3 + 2];
      const d = (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z);
      if (d <= r2) out.push(j);
      if (hi - lo === 1) return;
      const ax = this.axis[mid];
      const diff = (ax === 0 ? x : ax === 1 ? y : z) - (ax === 0 ? px : ax === 1 ? py : pz);
      if (diff < 0 || diff * diff <= r2) visit(lo, mid);
      if (diff >= 0 || diff * diff <= r2) visit(mid + 1, hi);
    };
    visit(0, this.count);
    return out;
  }
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5), with barycentrics. */
export function closestPointOnTriangle(
  p: readonly number[],
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): { point: [number, number, number]; u: number; v: number; w: number } {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (u: number, v: number, w: number) => ({
    point: [a[0] * u + b[0] * v + c[0] * w, a[1] * u + b[1] * v + c[1] * w, a[2] * u + b[2] * v + c[2] * w] as [number, number, number],
    u,
    v,
    w,
  });
  if (d1 <= 0 && d2 <= 0) return at(1, 0, 0);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at(1 - v, v, 0);
  }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at(1 - w, 0, w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(0, 1 - w, w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return at(1 - v - w, v, w);
}
