import * as THREE from "three";

/**
 * From 3D geometry to a 2D wind-tunnel obstacle: slice meshes with a plane,
 * express the cut in the tunnel's 2D frame, join the pieces into polylines,
 * and rasterise them into the lattice's obstacle mask.
 *
 * A thin surface (a wing membrane) slices into open polylines, drawn as a
 * stroke at least one cell thick; a solid (a tube, a cylinder) slices into
 * closed loops, which are also filled.
 */

export type V2 = [number, number];

/** The tunnel's frame in the world: origin, flow direction, "up" (lift) direction, plane normal. */
export interface TunnelFrame {
  origin: THREE.Vector3;
  flow: THREE.Vector3;
  up: THREE.Vector3;
  normal: THREE.Vector3;
}

export function toFrame(p: THREE.Vector3, f: TunnelFrame): V2 {
  const dx = p.x - f.origin.x, dy = p.y - f.origin.y, dz = p.z - f.origin.z;
  return [dx * f.flow.x + dy * f.flow.y + dz * f.flow.z, dx * f.up.x + dy * f.up.y + dz * f.up.z];
}

export function fromFrame(q: V2, f: TunnelFrame, target = new THREE.Vector3()): THREE.Vector3 {
  return target.copy(f.origin).addScaledVector(f.flow, q[0]).addScaledVector(f.up, q[1]);
}

/**
 * Segments where the meshes under `root` cross the plane through `f.origin`
 * with normal `f.normal`, in frame coordinates.
 */
export function sliceObject(root: THREE.Object3D | THREE.BufferGeometry, f: TunnelFrame, worldMatrixOf: (o: THREE.Object3D) => THREE.Matrix4): [V2, V2][] {
  const out: [V2, V2][] = [];
  const slice = (geometry: THREE.BufferGeometry, m: THREE.Matrix4 | null) => {
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const nv = pos.count;
    const w = new Float64Array(nv * 3);
    const d = new Float64Array(nv);
    const v = new THREE.Vector3();
    const e = m?.elements;
    for (let i = 0; i < nv; i++) {
      v.fromBufferAttribute(pos, i);
      if (e) v.applyMatrix4(m!);
      w[3 * i] = v.x; w[3 * i + 1] = v.y; w[3 * i + 2] = v.z;
      d[i] = (v.x - f.origin.x) * f.normal.x + (v.y - f.origin.y) * f.normal.y + (v.z - f.origin.z) * f.normal.z;
    }
    const index = geometry.getIndex();
    const tri = index ? index.count / 3 : nv / 3;
    const p = new THREE.Vector3();
    const cut = (a: number, b: number): V2 => {
      const t = d[a] / (d[a] - d[b]);
      p.set(w[3 * a] + t * (w[3 * b] - w[3 * a]), w[3 * a + 1] + t * (w[3 * b + 1] - w[3 * a + 1]), w[3 * a + 2] + t * (w[3 * b + 2] - w[3 * a + 2]));
      return toFrame(p, f);
    };
    for (let k = 0; k < tri; k++) {
      const a = index ? index.getX(3 * k) : 3 * k;
      const b = index ? index.getX(3 * k + 1) : 3 * k + 1;
      const c = index ? index.getX(3 * k + 2) : 3 * k + 2;
      const sa = d[a] >= 0, sb = d[b] >= 0, sc = d[c] >= 0;
      if (sa === sb && sb === sc) continue;
      // The lone vertex on its side, and the edges leaving it.
      const [o, x, y] = sa !== sb && sa !== sc ? [a, b, c] : sb !== sa && sb !== sc ? [b, a, c] : [c, a, b];
      out.push([cut(o, x), cut(o, y)]);
    }
  };
  if (root instanceof THREE.BufferGeometry) {
    slice(root, null);
  } else {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // Fat lines (Line2, LineSegments2: a function's grid, a drawn outline) are
      // meshes of screen-space quads, not surfaces: cutting them walls off the flow.
      if (!mesh.isMesh || !o.visible || (o as { isLineSegments2?: boolean }).isLineSegments2) return;
      slice(mesh.geometry, worldMatrixOf(o));
    });
  }
  return out;
}

/** Joins segments that share end points (within `eps`) into polylines; closed ones repeat their first point. */
export function chainSegments(segments: [V2, V2][], eps: number): V2[][] {
  const key = (p: V2) => `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
  const ends = new Map<string, number[]>();
  segments.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p);
      const l = ends.get(k);
      if (l) l.push(i);
      else ends.set(k, [i]);
    }
  });
  const used = new Uint8Array(segments.length);
  const next = (p: V2): { seg: number; to: V2 } | null => {
    for (const i of ends.get(key(p)) ?? []) {
      if (used[i]) continue;
      const [a, b] = segments[i];
      return { seg: i, to: key(a) === key(p) ? b : a };
    }
    return null;
  };
  const chains: V2[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line: V2[] = [segments[i][0], segments[i][1]];
    for (let s = next(line[line.length - 1]); s; s = next(line[line.length - 1])) {
      used[s.seg] = 1;
      line.push(s.to);
    }
    for (let s = next(line[0]); s; s = next(line[0])) {
      used[s.seg] = 1;
      line.unshift(s.to);
    }
    chains.push(line);
  }
  return chains;
}

export function isClosed(line: V2[], eps: number): boolean {
  if (line.length < 4) return false;
  const a = line[0], b = line[line.length - 1];
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

/** The lattice over the tunnel: cell (i, j) has its centre at (x0 + (i + ½)·dx, y0 + (j + ½)·dx). */
export interface Grid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  dx: number;
}

export function toCell(p: V2, g: Grid): V2 {
  return [(p[0] - g.x0) / g.dx - 0.5, (p[1] - g.y0) / g.dx - 0.5];
}

export function fromCell(q: V2, g: Grid): V2 {
  return [g.x0 + (q[0] + 0.5) * g.dx, g.y0 + (q[1] + 0.5) * g.dx];
}

/**
 * Obstacle mask. Every polyline is stroked with half-width `radius` cells
 * (at least 0.75, so a diagonal line still blocks the lattice's diagonal
 * links); closed ones are filled as well (even-odd). The inflow, outflow and
 * far-field rows stay free.
 */
export function rasterise(chains: V2[][], g: Grid, radius: number, eps: number): Uint8Array {
  const { nx, ny } = g;
  const mask = new Uint8Array(nx * ny);
  const r = Math.max(0.75, radius);
  const set = (i: number, j: number) => {
    if (i >= 2 && i < nx - 2 && j >= 2 && j < ny - 2) mask[j * nx + i] = 1;
  };
  for (const line of chains) {
    const pts = line.map((p) => toCell(p, g));
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      const i0 = Math.floor(Math.min(ax, bx) - r), i1 = Math.ceil(Math.max(ax, bx) + r);
      const j0 = Math.floor(Math.min(ay, by) - r), j1 = Math.ceil(Math.max(ay, by) + r);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((i - ax) * vx + (j - ay) * vy) / len2)) : 0;
          const dx = i - (ax + t * vx), dy = j - (ay + t * vy);
          if (dx * dx + dy * dy <= r * r) set(i, j);
        }
      }
    }
  }
  const closed = chains.filter((l) => isClosed(l, eps)).map((l) => l.map((p) => toCell(p, g)));
  if (closed.length > 0) {
    for (let j = 0; j < ny; j++) {
      const xs: number[] = [];
      for (const loop of closed) {
        for (let k = 0; k + 1 < loop.length; k++) {
          const [ax, ay] = loop[k], [bx, by] = loop[k + 1];
          if ((ay <= j) !== (by <= j)) xs.push(ax + ((j - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let i = Math.ceil(xs[k]); i <= Math.floor(xs[k + 1]); i++) set(i, j);
      }
    }
  }
  return mask;
}

/** Bounding box of polylines in frame coordinates, or null when empty. */
export function bounds(chains: V2[][]): { min: V2; max: V2 } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of chains) for (const [x, y] of l) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) ? { min: [x0, y0], max: [x1, y1] } : null;
}
