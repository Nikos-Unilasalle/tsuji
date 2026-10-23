import { edgeTable, triTable } from "./marchingCubesTables";

/**
 * Metaballs → triangle soup, as a plain function over typed arrays: no THREE
 * objects in or out, so the same code runs on the main thread, in a Web
 * Worker, or is replaced by the Rust/WASM build of it (wasm/kernels) without
 * the node noticing.
 *
 * A port of three's MarchingCubes (examples/jsm/objects) — same field, same
 * edge interpolation, same gradient normals, same tables — so its output
 * matches the class the node used to call, vertex for vertex (see
 * marchingCubes.test.ts). Dropped from the original: the per-cell colour
 * palette, which addBall fills (a sqrt and a smoothstep per touched cell)
 * whether or not colours are enabled; the node never enabled them.
 */

/** One ball: centre in the field's [0, 1] cube, then strength and subtract as MarchingCubes.addBall takes them. */
export const BALL_STRIDE = 5;

export interface MetaballsJob {
  resolution: number;
  isolation: number;
  /** BALL_STRIDE doubles per ball — Float64 so the centres reach the kernel exactly as the node computed them. */
  balls: Float64Array;
  /** The field cube in node-local space: [-1, 1] maps to centre ± size/2. */
  centerX: number;
  centerY: number;
  centerZ: number;
  size: number;
  /** Vertices past this are dropped (three's class silently overran its buffers instead). */
  maxVertices: number;
  /** projectGeometryUVs' density — passed in so the kernel imports nothing from the app. */
  uvDensity: number;
}

export interface MeshBuffers {
  /** Vertex count; every array is exactly this long (× its item size). */
  count: number;
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** min xyz, max xyz, then bounding-sphere centre xyz and radius — what Box3/Sphere would compute from `position`. */
  bounds: Float64Array;
  /** Triangles as vertex triples — set by the Surface Nets kernel, whose vertices are shared; absent means a triangle soup. */
  index?: Uint32Array;
  /** Per-vertex RGB, when the job asked for blended element colours. */
  color?: Float32Array;
}

interface Scratch {
  resolution: number;
  field: Float32Array;
  normalCache: Float32Array;
  /** Grown on demand, reused between jobs: the surface is written here, then sliced to its real size. */
  position: Float32Array;
  normal: Float32Array;
}

let scratch: Scratch | null = null;

function scratchFor(resolution: number, maxVertices: number): Scratch {
  const size3 = resolution * resolution * resolution;
  if (!scratch || scratch.resolution !== resolution) {
    scratch = {
      resolution,
      field: new Float32Array(size3),
      normalCache: new Float32Array(size3 * 3),
      position: scratch?.position ?? new Float32Array(0),
      normal: scratch?.normal ?? new Float32Array(0),
    };
  } else {
    scratch.field.fill(0);
    scratch.normalCache.fill(0);
  }
  const want = Math.min(maxVertices, 1 << 16) * 3;
  if (scratch.position.length < want) {
    scratch.position = new Float32Array(want);
    scratch.normal = new Float32Array(want);
  }
  return scratch;
}

function grow(s: Scratch, minFloats: number): void {
  let length = Math.max(s.position.length * 2, 3 * 1024);
  while (length < minFloats) length *= 2;
  const position = new Float32Array(length);
  position.set(s.position);
  const normal = new Float32Array(length);
  normal.set(s.normal);
  s.position = position;
  s.normal = normal;
}

/** MarchingCubes.addBall without the palette. */
function addBall(field: Float32Array, size: number, bx: number, by: number, bz: number, strength: number, subtract: number): void {
  const sign = Math.sign(strength);
  strength = Math.abs(strength);
  const size2 = size * size;
  const radius = size * Math.sqrt(strength / subtract);
  const zs = bz * size;
  const ys = by * size;
  const xs = bx * size;
  const minZ = Math.max(1, Math.floor(zs - radius));
  const maxZ = Math.min(size - 1, Math.floor(zs + radius));
  const minY = Math.max(1, Math.floor(ys - radius));
  const maxY = Math.min(size - 1, Math.floor(ys + radius));
  const minX = Math.max(1, Math.floor(xs - radius));
  const maxX = Math.min(size - 1, Math.floor(xs + radius));
  for (let z = minZ; z < maxZ; z++) {
    const zOffset = size2 * z;
    const fz = z / size - bz;
    const fz2 = fz * fz;
    for (let y = minY; y < maxY; y++) {
      const yOffset = zOffset + size * y;
      const fy = y / size - by;
      const fy2 = fy * fy;
      for (let x = minX; x < maxX; x++) {
        const fx = x / size - bx;
        const val = strength / (0.000001 + fx * fx + fy2 + fz2) - subtract;
        if (val > 0.0) field[yOffset + x] += val * sign;
      }
    }
  }
}

export function polygonizeMetaballs(job: MetaballsJob): MeshBuffers {
  const size = job.resolution;
  const s = scratchFor(size, job.maxVertices);
  const field = s.field;
  const nc = s.normalCache;
  for (let i = 0; i + BALL_STRIDE <= job.balls.length; i += BALL_STRIDE) {
    const b = job.balls;
    addBall(field, size, b[i], b[i + 1], b[i + 2], b[i + 3], b[i + 4]);
  }

  const yd = size;
  const zd = size * size;
  const half = size / 2;
  const delta = 2 / size;
  const isol = job.isolation;
  const maxFloats = job.maxVertices * 3;
  // Float32 like the class's own vlist/nlist: every intermediate rounds where it did.
  const vlist = new Float32Array(36);
  const nlist = new Float32Array(36);
  let floats = 0;

  const compNorm = (q: number) => {
    const q3 = q * 3;
    if (nc[q3] === 0.0) {
      nc[q3] = field[q - 1] - field[q + 1];
      nc[q3 + 1] = field[q - yd] - field[q + yd];
      nc[q3 + 2] = field[q - zd] - field[q + zd];
    }
  };
  // a/b are cell indices; `axis` 0/1/2 is which coordinate the edge runs along.
  const vInt = (offset: number, axis: number, a: number, b: number, x: number, y: number, z: number, v1: number, v2: number) => {
    compNorm(a);
    compNorm(b);
    const mu = (isol - v1) / (v2 - v1);
    vlist[offset] = axis === 0 ? x + mu * delta : x;
    vlist[offset + 1] = axis === 1 ? y + mu * delta : y;
    vlist[offset + 2] = axis === 2 ? z + mu * delta : z;
    const a3 = a * 3;
    const b3 = b * 3;
    nlist[offset] = nc[a3] + (nc[b3] - nc[a3]) * mu;
    nlist[offset + 1] = nc[a3 + 1] + (nc[b3 + 1] - nc[a3 + 1]) * mu;
    nlist[offset + 2] = nc[a3 + 2] + (nc[b3 + 2] - nc[a3 + 2]) * mu;
  };

  const smin2 = size - 2;
  for (let z = 1; z < smin2; z++) {
    const zOffset = zd * z;
    const fz = (z - half) / half;
    for (let y = 1; y < smin2; y++) {
      const yOffset = zOffset + size * y;
      const fy = (y - half) / half;
      for (let x = 1; x < smin2; x++) {
        const fx = (x - half) / half;
        const q = yOffset + x;
        const q1 = q + 1;
        const qy = q + yd;
        const qz = q + zd;
        const q1y = q1 + yd;
        const q1z = q1 + zd;
        const qyz = q + yd + zd;
        const q1yz = q1 + yd + zd;
        const f0 = field[q];
        const f1 = field[q1];
        const f2 = field[qy];
        const f3 = field[q1y];
        const f4 = field[qz];
        const f5 = field[q1z];
        const f6 = field[qyz];
        const f7 = field[q1yz];
        let cube = 0;
        if (f0 < isol) cube |= 1;
        if (f1 < isol) cube |= 2;
        if (f2 < isol) cube |= 8;
        if (f3 < isol) cube |= 4;
        if (f4 < isol) cube |= 16;
        if (f5 < isol) cube |= 32;
        if (f6 < isol) cube |= 128;
        if (f7 < isol) cube |= 64;
        const bits = edgeTable[cube];
        if (bits === 0) continue;
        const fx2 = fx + delta;
        const fy2 = fy + delta;
        const fz2 = fz + delta;
        if (bits & 1) vInt(0, 0, q, q1, fx, fy, fz, f0, f1);
        if (bits & 2) vInt(3, 1, q1, q1y, fx2, fy, fz, f1, f3);
        if (bits & 4) vInt(6, 0, qy, q1y, fx, fy2, fz, f2, f3);
        if (bits & 8) vInt(9, 1, q, qy, fx, fy, fz, f0, f2);
        if (bits & 16) vInt(12, 0, qz, q1z, fx, fy, fz2, f4, f5);
        if (bits & 32) vInt(15, 1, q1z, q1yz, fx2, fy, fz2, f5, f7);
        if (bits & 64) vInt(18, 0, qyz, q1yz, fx, fy2, fz2, f6, f7);
        if (bits & 128) vInt(21, 1, qz, qyz, fx, fy, fz2, f4, f6);
        if (bits & 256) vInt(24, 2, q, qz, fx, fy, fz, f0, f4);
        if (bits & 512) vInt(27, 2, q1, q1z, fx2, fy, fz, f1, f5);
        if (bits & 1024) vInt(30, 2, q1y, q1yz, fx2, fy2, fz, f3, f7);
        if (bits & 2048) vInt(33, 2, qy, qyz, fx, fy2, fz, f2, f6);
        const t = cube << 4;
        for (let i = 0; triTable[t + i] !== -1; i += 3) {
          if (floats + 9 > maxFloats) break;
          if (floats + 9 > s.position.length) grow(s, floats + 9);
          const pos = s.position;
          const nor = s.normal;
          for (let k = 0; k < 3; k++) {
            const o = 3 * triTable[t + i + k];
            pos[floats] = vlist[o];
            pos[floats + 1] = vlist[o + 1];
            pos[floats + 2] = vlist[o + 2];
            nor[floats] = nlist[o];
            nor[floats + 1] = nlist[o + 1];
            nor[floats + 2] = nlist[o + 2];
            floats += 3;
          }
        }
      }
    }
  }

  return finishMesh(s.position, s.normal, floats / 3, job);
}

/**
 * Field cube → node-local space, object-space UVs and bounds: what the node
 * did on the main thread after `field.update()`, moved here so a finished job
 * only has to be attached. Shared by the WASM path, whose kernel stops at the
 * raw [-1, 1] triangles.
 */
export function finishMesh(fieldPosition: Float32Array, fieldNormal: Float32Array, count: number, job: MetaballsJob): MeshBuffers {
  const halfSize = job.size / 2;
  const position = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i += 3) {
    position[i] = fieldPosition[i] * halfSize + job.centerX;
    position[i + 1] = fieldPosition[i + 1] * halfSize + job.centerY;
    position[i + 2] = fieldPosition[i + 2] * halfSize + job.centerZ;
  }
  return uvAndBounds(position, fieldNormal.slice(0, count * 3), count, job.uvDensity);
}

/**
 * Object-space UVs (projectGeometryUVs' dominant-axis projection) and bounds
 * for a finished surface already in node-local space. Takes ownership of the
 * two arrays.
 */
export function uvAndBounds(position: Float32Array, normal: Float32Array, count: number, d: number): MeshBuffers {
  const uv = new Float32Array(count * 2);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0, i = 0; v < count; v++, i += 3) {
    // Read back as stored: the bounds and UVs see the Float32 values, as Box3 and projectGeometryUVs did.
    const px = position[i], py = position[i + 1], pz = position[i + 2];
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;
    const ax = Math.abs(normal[i]);
    const ay = Math.abs(normal[i + 1]);
    const az = Math.abs(normal[i + 2]);
    let u: number;
    let w: number;
    if (ax >= ay && ax >= az) {
      u = pz * d;
      w = py * d;
    } else if (ay >= az) {
      u = px * d;
      w = pz * d;
    } else {
      u = px * d;
      w = py * d;
    }
    uv[v * 2] = u + 0.5;
    uv[v * 2 + 1] = w + 0.5;
  }
  const bounds = new Float64Array(10);
  if (count > 0) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    let r2 = 0;
    for (let i = 0; i < count * 3; i += 3) {
      const dx = position[i] - cx;
      const dy = position[i + 1] - cy;
      const dz = position[i + 2] - cz;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd > r2) r2 = dd;
    }
    bounds.set([minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz, Math.sqrt(r2)]);
  }
  return { count, position, normal, uv, bounds };
}
