import * as THREE from "three";

/**
 * Any geometry as a metaball: its inside filled with a lattice of small bumps whose sum is the
 * shape, blurred at the scale of a Softness. Over a flat face the field reaches the iso level
 * exactly on the face (the weight is calibrated on a half-space, below); edges and corners round
 * off with a radius about the Softness, parts thinner than it melt away, and two volumes closer
 * than it flow into each other — the metaball look, for a cube, a torus, a letter, a scanned model.
 *
 * Inside is found by casting rays along all three axes through every lattice cell and counting the
 * signed crossings (winding number: overlapping closed parts, a Merge of primitives, stay one solid).
 * Each cell gets the fraction of it the rays found inside, averaged over the three axes, so a face
 * that falls between two lattice points sits where it is rather than snapping to one of them.
 *
 * A mesh with no inside (a plane, an unextruded letter) becomes a sheet of bumps on its surface.
 *
 * Nothing here touches the field kernels: a volume is only more elements, so the JS, wasm and
 * raymarched meshers all draw it as they are.
 */

/** Reach over lattice spacing: at 2.5 a half-space's surface wobbles by 0.2% of a cell (see the tests). */
export const LATTICE_RATIO = 2.5;
/** Past this the lattice is coarsened (and the reach with it) rather than handing the kernel more. */
export const MAX_VOLUME_ELEMENTS = 40000;
/** Cells per axis, whatever the softness: bounds the voxel pass's memory on a huge object. */
const MAX_CELLS_PER_AXIS = 96;

/** One bump of a volume, in the space the geometry was given in: centre and its share of the field. */
export interface VolumeBlobs {
  /** xyz per bump. */
  points: Float32Array;
  /** Fraction of the calibrated weight per bump (0..1, the cell's inside fraction). */
  fill: Float32Array;
  count: number;
  /** The reach actually used — the Softness, or more if the element cap coarsened the lattice. */
  reach: number;
  /** Calibrated weight for a bump of fill 1 at this reach ratio, before the iso level is applied. */
  unitWeight: number;
  /** True when the geometry had no inside and was turned into a sheet. */
  sheet: boolean;
}

const bump = (d2: number, r2: number) => {
  if (d2 >= r2) return 0;
  const q = 1 - d2 / r2;
  return q * q * q;
};

/**
 * The field of a half-space filled with unit bumps (spacing 1, reach `ratio`), measured on its
 * boundary plane and averaged over a cell — what one bump's weight must divide the iso level by
 * for the surface to land on the face.
 */
function halfSpaceField(ratio: number): number {
  const n = Math.ceil(ratio) + 1;
  const r2 = ratio * ratio;
  let sum = 0;
  let samples = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sz = 0; sz < 4; sz++) {
      const y0 = (sy + 0.5) / 4;
      const z0 = (sz + 0.5) / 4;
      for (let i = 0; i <= n; i++) {
        const x = i + 0.5;
        for (let j = -n; j <= n + 1; j++) {
          for (let k = -n; k <= n + 1; k++) sum += bump(x * x + (j - y0) ** 2 + (k - z0) ** 2, r2);
        }
      }
      samples++;
    }
  }
  return sum / samples;
}

/** Same for a single layer of bumps (a sheet), measured `t` lattice units off its plane. */
function sheetField(ratio: number, t: number): number {
  const n = Math.ceil(ratio) + 1;
  const r2 = ratio * ratio;
  let sum = 0;
  let samples = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sz = 0; sz < 4; sz++) {
      const y0 = (sy + 0.5) / 4;
      const z0 = (sz + 0.5) / 4;
      for (let j = -n; j <= n + 1; j++) {
        for (let k = -n; k <= n + 1; k++) sum += bump(t * t + (j - y0) ** 2 + (k - z0) ** 2, r2);
      }
      samples++;
    }
  }
  return sum / samples;
}

const calibration = new Map<string, number>();
function calibrated(key: string, compute: () => number): number {
  let v = calibration.get(key);
  if (v === undefined) {
    v = compute();
    calibration.set(key, v);
  }
  return v;
}

interface Crossing {
  at: number;
  sign: number;
  /** |normal| of the crossed triangle, unit length. */
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Inside fraction of every cell along one axis: rays parallel to `axis` through the centres of
 * the cells' other two coordinates, each crossing signed by which way the triangle faces.
 */
function axisOccupancy(
  pos: Float32Array,
  tris: Uint32Array,
  axis: 0 | 1 | 2,
  origin: THREE.Vector3,
  h: number,
  dims: [number, number, number],
  out: Float32Array,
  moment: Float32Array,
  normals: Float32Array,
): void {
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const nu = dims[u];
  const nv = dims[v];
  const na = dims[axis];
  const o = [origin.x, origin.y, origin.z];
  // Ray (iu, iv) sits at the centre of its cell, nudged off any lattice-aligned edge or vertex so
  // a ray never grazes one exactly and counts it twice or not at all.
  const ru = (iu: number) => o[u] + (iu + 0.5 + 1.37e-4) * h;
  const rv = (iv: number) => o[v] + (iv + 0.5 + 2.91e-4) * h;
  const columns: (Crossing[] | undefined)[] = new Array(nu * nv);

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3;
    const b = tris[t + 1] * 3;
    const c = tris[t + 2] * 3;
    const au = pos[a + u], av = pos[a + v], aa = pos[a + axis];
    const bu = pos[b + u], bv = pos[b + v], ba = pos[b + axis];
    const cu = pos[c + u], cv = pos[c + v], ca = pos[c + axis];
    const area = (bu - au) * (cv - av) - (cu - au) * (bv - av);
    if (Math.abs(area) < 1e-20) continue;
    const sign = area > 0 ? 1 : -1;
    // The triangle's facing, in world axes, so a cell knows which of its rays saw the face square on.
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx = Math.abs(nx) / nl;
    ny = Math.abs(ny) / nl;
    nz = Math.abs(nz) / nl;
    const iu0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - o[u]) / h - 0.5 - 1.37e-4));
    const iu1 = Math.min(nu - 1, Math.floor((Math.max(au, bu, cu) - o[u]) / h - 0.5 - 1.37e-4));
    const iv0 = Math.max(0, Math.ceil((Math.min(av, bv, cv) - o[v]) / h - 0.5 - 2.91e-4));
    const iv1 = Math.min(nv - 1, Math.floor((Math.max(av, bv, cv) - o[v]) / h - 0.5 - 2.91e-4));
    for (let iu = iu0; iu <= iu1; iu++) {
      const pu = ru(iu);
      for (let iv = iv0; iv <= iv1; iv++) {
        const pv = rv(iv);
        // Barycentric weights of (pu, pv) in the projected triangle; all one sign inside.
        const w0 = ((bu - pu) * (cv - pv) - (cu - pu) * (bv - pv)) / area;
        const w1 = ((cu - pu) * (av - pv) - (au - pu) * (cv - pv)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const col = iu * nv + iv;
        (columns[col] ??= []).push({ at: w0 * aa + w1 * ba + w2 * ca, sign, nx, ny, nz });
      }
    }
  }

  const stride = (i: number, iu: number, iv: number) => {
    const idx = [0, 0, 0];
    idx[axis] = i;
    idx[u] = iu;
    idx[v] = iv;
    return (idx[0] * dims[1] + idx[1]) * dims[2] + idx[2];
  };
  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      const list = columns[iu * nv + iv];
      if (!list || list.length < 2) continue;
      list.sort((p, q) => p.at - q.at);
      for (const crossing of list) {
        const k = Math.floor((crossing.at - o[axis]) / h);
        if (k < 0 || k >= na) continue;
        const cell = stride(k, iu, iv) * 3;
        normals[cell] += crossing.nx;
        normals[cell + 1] += crossing.ny;
        normals[cell + 2] += crossing.nz;
      }
      let winding = 0;
      for (let n = 0; n < list.length - 1; n++) {
        winding += list[n].sign;
        if (winding === 0) continue;
        // Inside from this crossing to the next: credit each cell it overlaps with its share.
        const lo = (list[n].at - o[axis]) / h;
        const hi = (list[n + 1].at - o[axis]) / h;
        const k0 = Math.max(0, Math.floor(lo));
        const k1 = Math.min(na - 1, Math.floor(hi));
        for (let k = k0; k <= k1; k++) {
          const from = Math.max(lo, k);
          const to = Math.min(hi, k + 1);
          if (to <= from) continue;
          const cell = stride(k, iu, iv);
          out[cell] += to - from;
          // First moment about the cell's centre, to place the bump at the centroid of what is inside.
          moment[cell] += (to - from) * ((from + to) / 2 - (k + 0.5));
        }
      }
    }
  }
}

function trianglesOf(geometry: THREE.BufferGeometry): Uint32Array {
  const index = geometry.index;
  const count = geometry.attributes.position.count;
  if (index) {
    const tris = new Uint32Array(index.count - (index.count % 3));
    for (let i = 0; i < tris.length; i++) tris[i] = index.getX(i);
    return tris;
  }
  const tris = new Uint32Array(count - (count % 3));
  for (let i = 0; i < tris.length; i++) tris[i] = i;
  return tris;
}

/**
 * The bumps filling `geometry` once `matrix` has placed it, for a blend reach of `softness`
 * (world units, in the space `matrix` maps to).
 */
export function volumeBlobs(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, softness: number): VolumeBlobs | null {
  const source = geometry.attributes.position;
  if (!source || source.count < 3 || !(softness > 0)) return null;

  const pos = new Float32Array(source.count * 3);
  const p = new THREE.Vector3();
  const box = new THREE.Box3();
  for (let i = 0; i < source.count; i++) {
    p.fromBufferAttribute(source, i).applyMatrix4(matrix);
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    box.expandByPoint(p);
  }
  if (box.isEmpty()) return null;
  const tris = trianglesOf(geometry);
  const size = box.getSize(new THREE.Vector3());

  let reach = softness;
  let h = reach / LATTICE_RATIO;
  // Coarsen until the lattice fits: by the box first (cheap), then by what was actually filled.
  const longest = Math.max(size.x, size.y, size.z);
  if (longest / h > MAX_CELLS_PER_AXIS) {
    h = longest / MAX_CELLS_PER_AXIS;
    reach = h * LATTICE_RATIO;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = fill(pos, tris, box, size, h, reach);
    if (result.count <= MAX_VOLUME_ELEMENTS) return result;
    h *= Math.cbrt(result.count / MAX_VOLUME_ELEMENTS) * 1.05;
    reach = h * LATTICE_RATIO;
  }
  return null;
}

function fill(pos: Float32Array, tris: Uint32Array, box: THREE.Box3, size: THREE.Vector3, h: number, reach: number): VolumeBlobs {
  const dims: [number, number, number] = [
    Math.max(1, Math.ceil(size.x / h)),
    Math.max(1, Math.ceil(size.y / h)),
    Math.max(1, Math.ceil(size.z / h)),
  ];
  // Centre the lattice on the box, so a cube's faces sit symmetrically between lattice planes.
  const origin = new THREE.Vector3(
    box.min.x - (dims[0] * h - size.x) / 2,
    box.min.y - (dims[1] * h - size.y) / 2,
    box.min.z - (dims[2] * h - size.z) / 2,
  );
  const cells = dims[0] * dims[1] * dims[2];
  const occ = [new Float32Array(cells), new Float32Array(cells), new Float32Array(cells)];
  const moment = [new Float32Array(cells), new Float32Array(cells), new Float32Array(cells)];
  const normals = new Float32Array(cells * 3);
  for (const axis of [0, 1, 2] as const) axisOccupancy(pos, tris, axis, origin, h, dims, occ[axis], moment[axis], normals);

  let count = 0;
  for (let i = 0; i < cells; i++) if (occ[0][i] + occ[1][i] + occ[2][i] > 0.01) count++;
  if (count > 0) {
    const points = new Float32Array(count * 3);
    const fillOut = new Float32Array(count);
    const o = [origin.x, origin.y, origin.z];
    let n = 0;
    for (let x = 0; x < dims[0]; x++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let z = 0; z < dims[2]; z++) {
          const i = (x * dims[1] + y) * dims[2] + z;
          const total = occ[0][i] + occ[1][i] + occ[2][i];
          if (total <= 0.01) continue;
          const idx = [x, y, z];
          // Along each axis, the bump moves to the centroid its own ray measured inside the cell: a
          // cell half full is half the mass, half a cell nearer the inside.
          for (let a = 0; a < 3; a++) {
            const shift = occ[a][i] > 1e-6 ? moment[a][i] / occ[a][i] : 0;
            points[n * 3 + a] = o[a] + (idx[a] + 0.5 + shift) * h;
          }
          // How full the cell is: each axis's measure weighted by how squarely the surface faces it —
          // a ray running along a face only says whether the cell's centre is in, not how much.
          const wx = normals[i * 3], wy = normals[i * 3 + 1], wz = normals[i * 3 + 2];
          const wsum = wx + wy + wz;
          const f = wsum > 1e-6 ? (wx * occ[0][i] + wy * occ[1][i] + wz * occ[2][i]) / wsum : total / 3;
          if (f <= 0.003) continue;
          fillOut[n] = Math.min(1, f);
          n++;
        }
      }
    }
    const ratio = reach / h;
    const unitWeight = 1 / calibrated(`half|${ratio.toFixed(3)}`, () => halfSpaceField(ratio));
    if (n > 0) return { points: points.subarray(0, n * 3), fill: fillOut.subarray(0, n), count: n, reach, unitWeight, sheet: false };
  }
  return sheet(pos, tris, h, reach);
}

/**
 * No inside: bumps one lattice step apart over the surface, weighted so the sheet comes out a
 * quarter of the reach thick on each side.
 */
function sheet(pos: Float32Array, tris: Uint32Array, h: number, reach: number): VolumeBlobs {
  // One bump per lattice cell the surface passes through, put back on the surface: a plane facing an
  // axis gets exactly one per cell; a slanted one passes through more cells per area (|nx|+|ny|+|nz|
  // times as many), so each of its bumps weighs that much less.
  const seen = new Set<string>();
  const out: number[] = [];
  const fills: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), q = new THREE.Vector3();
  const normal = new THREE.Vector3(), snapped = new THREE.Vector3();
  for (let t = 0; t < tris.length && out.length / 3 <= MAX_VOLUME_ELEMENTS; t += 3) {
    a.fromArray(pos, tris[t] * 3);
    b.fromArray(pos, tris[t + 1] * 3);
    c.fromArray(pos, tris[t + 2] * 3);
    normal.subVectors(b, a).cross(q.subVectors(c, a));
    if (normal.lengthSq() < 1e-24) continue;
    normal.normalize();
    const share = 1 / (Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z));
    const steps = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / (h * 0.25)));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        q.copy(a).multiplyScalar(1 - (i + j) / steps).addScaledVector(b, i / steps).addScaledVector(c, j / steps);
        const kx = Math.round(q.x / h), ky = Math.round(q.y / h), kz = Math.round(q.z / h);
        const key = `${kx},${ky},${kz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        snapped.set(kx * h, ky * h, kz * h);
        snapped.addScaledVector(normal, -normal.dot(q.subVectors(snapped, a)));
        out.push(snapped.x, snapped.y, snapped.z);
        fills.push(share);
      }
    }
  }
  const count = out.length / 3;
  const ratio = reach / h;
  const unitWeight = 1 / calibrated(`sheet|${ratio.toFixed(3)}`, () => sheetField(ratio, ratio / 4));
  return { points: Float32Array.from(out), fill: Float32Array.from(fills), count, reach, unitWeight, sheet: true };
}

interface CacheEntry {
  geometry: THREE.BufferGeometry;
  version: number;
  key: string;
  blobs: VolumeBlobs | null;
}
const cache = new WeakMap<THREE.BufferGeometry, CacheEntry[]>();

/** volumeBlobs, remembered per geometry, placement and softness: a still object is voxelized once. */
export function cachedVolumeBlobs(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, softness: number): VolumeBlobs | null {
  const version = (geometry.attributes.position as THREE.BufferAttribute).version ?? 0;
  const key = `${softness.toPrecision(6)}|${matrix.elements.map((e) => e.toPrecision(7)).join(",")}`;
  let entries = cache.get(geometry);
  const hit = entries?.find((e) => e.key === key && e.version === version);
  if (hit) return hit.blobs;
  const blobs = volumeBlobs(geometry, matrix, softness);
  if (!entries) cache.set(geometry, (entries = []));
  // A few placements per geometry (instances, an object moving): keep the latest handful.
  entries.push({ geometry, version, key, blobs });
  if (entries.length > 64) entries.shift();
  return blobs;
}
