import * as THREE from "three";

/**
 * Linear blend skinning for any rig.
 *
 * A rig is just joints with parents, once at rest and once posed — nothing
 * here knows about FABRIK, humans or polypedes. Every joint that has a parent
 * is the tip of one bone (parent joint -> joint); a joint without one (a root,
 * or a bone of no length) is a point bone that rides on the joint and turns
 * with the bones leaving it. So there is exactly one bone per joint.
 *
 * Rigs hand their joints over as positions, so a bone is a segment: its pose
 * is the smallest rotation taking the rest segment onto the posed one, plus
 * the translation of its head, plus optionally a stretch along its length.
 * Twist around the bone axis is not in the positions: a rig that turns a
 * bone about itself (a head looking aside) hands it over in `twist`.
 */

/** What every rig node publishes on its geometry's `userData.rig`; what Skin reads. */
export interface RigData {
  /** Parent joint index per joint; -1 for a root. */
  parents: number[];
  /** Joint positions at rest, in the rig's own space. */
  rest: THREE.Vector3[];
  /** Joint positions as posed now, in the rig's own space. */
  pose: THREE.Vector3[];
  /** Rig space -> world. */
  matrix: THREE.Matrix4;
  /** A name per joint, for editing UIs. */
  names?: string[];
  /** Radians per joint: how far its bone turns about itself (+ counter-clockwise looking down the bone from its tip). Absent: none. */
  twist?: number[];
}

export function publishRig(target: THREE.Object3D, parents: number[], rest: THREE.Vector3[], pose: THREE.Vector3[], matrix: THREE.Matrix4, names?: string[], twist?: number[]) {
  const data: RigData = { parents, rest, pose, matrix: matrix.clone(), names, twist };
  target.userData.rig = data;
}

export function readRig(source: unknown): RigData | null {
  if (!(source instanceof THREE.Object3D)) return null;
  const data = source.userData.rig as RigData | undefined;
  if (!data || !Array.isArray(data.parents) || data.rest.length !== data.parents.length || data.pose.length !== data.parents.length) return null;
  return data;
}

export interface SkinBone {
  /** The joint this bone ends at; also its index. */
  joint: number;
  /** Joint the bone starts at, or -1 for a point bone. */
  parent: number;
  /** Rest segment, in the space the rest positions were given in. */
  head: THREE.Vector3;
  tail: THREE.Vector3;
  /** Unit rest direction (zero for a point bone). */
  dir: THREE.Vector3;
  length: number;
}

const EPS = 1e-9;

export function buildBones(parents: number[], rest: THREE.Vector3[]): SkinBone[] {
  return rest.map((tail, joint) => {
    const p = parents[joint];
    const valid = p >= 0 && p < rest.length && p !== joint;
    const head = valid ? rest[p] : tail;
    const delta = tail.clone().sub(head);
    const length = delta.length();
    if (!valid || length < EPS) {
      return { joint, parent: -1, head: tail.clone(), tail: tail.clone(), dir: new THREE.Vector3(), length: 0 };
    }
    return { joint, parent: p, head: head.clone(), tail: tail.clone(), dir: delta.multiplyScalar(1 / length), length };
  });
}

export interface PoseOptions {
  /** Scale each bone along its length to the posed length. */
  stretch: boolean;
  /** 0 = rest, 1 = fully posed. */
  amount: number;
}

/** Per-bone matrices, ready for `applySkin`: 3x4 (row-major) for positions, 3x3 (row-major) for normals. */
export interface PosedBones {
  pos: Float32Array;
  nrm: Float32Array;
}

/** How each bone turned from rest to the posed segment; the same for every mesh bound to the rig. */
export interface BoneRotations {
  rotations: THREE.Quaternion[];
  /** Whether the bone has a posed segment to turn to (a point bone or a collapsed bone does not). */
  real: boolean[];
}

export function boneRotations(bones: SkinBone[], pose: THREE.Vector3[], twist?: number[]): BoneRotations {
  const rotations: THREE.Quaternion[] = bones.map(() => new THREE.Quaternion());
  const real: boolean[] = bones.map(() => false);
  const dir = new THREE.Vector3();

  bones.forEach((bone, i) => {
    if (bone.parent < 0) return;
    dir.copy(pose[bone.joint]).sub(pose[bone.parent]);
    if (dir.lengthSq() < EPS * EPS) return;
    dir.normalize();
    rotations[i].setFromUnitVectors(bone.dir, dir);
    const angle = twist?.[bone.joint];
    if (angle && Number.isFinite(angle)) rotations[i].premultiply(new THREE.Quaternion().setFromAxisAngle(dir, angle));
    real[i] = true;
  });

  // A point bone turns with the bones leaving its joint.
  const sums = bones.map(() => new THREE.Quaternion(0, 0, 0, 0));
  const used: number[] = bones.map(() => 0);
  bones.forEach((bone, i) => {
    if (!real[i]) return;
    const sum = sums[bone.parent];
    const q = rotations[i];
    const sign = used[bone.parent] > 0 && sum.dot(q) < 0 ? -1 : 1;
    sum.set(sum.x + sign * q.x, sum.y + sign * q.y, sum.z + sign * q.z, sum.w + sign * q.w);
    used[bone.parent]++;
  });
  bones.forEach((bone, i) => {
    if (bone.parent >= 0) return;
    if (used[i] > 0 && sums[i].lengthSq() > EPS) rotations[i].copy(sums[i]).normalize();
  });
  return { rotations, real };
}

/**
 * The bone matrices for a pose, in the frame of `frame` (a mesh's bind matrix:
 * the mesh's local space -> the space `rest` and `pose` are given in), so they
 * apply straight to the mesh's own vertices. `turns` can be shared between
 * meshes: the rotations do not depend on the mesh.
 */
export function poseBones(bones: SkinBone[], pose: THREE.Vector3[], frame: THREE.Matrix4, options: PoseOptions, into?: PosedBones, turns?: BoneRotations): PosedBones {
  const count = bones.length;
  const out = into && into.pos.length === count * 12 ? into : { pos: new Float32Array(count * 12), nrm: new Float32Array(count * 9) };
  const { rotations, real } = turns ?? boneRotations(bones, pose);

  const toWorld = frame;
  const toLocal = frame.clone().invert();
  const amount = Math.max(0, Math.min(1, options.amount));
  const translate = new THREE.Matrix4();
  const untranslate = new THREE.Matrix4();
  const rotate = new THREE.Matrix4();
  const stretch = new THREE.Matrix4();
  const full = new THREE.Matrix4();
  const turn = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const identity = new THREE.Matrix4();

  bones.forEach((bone, i) => {
    const head1 = bone.parent >= 0 ? pose[bone.parent] : pose[bone.joint];
    translate.makeTranslation(head1.x, head1.y, head1.z);
    untranslate.makeTranslation(-bone.head.x, -bone.head.y, -bone.head.z);
    rotate.makeRotationFromQuaternion(rotations[i]);

    stretch.identity();
    if (options.stretch && real[i]) {
      const length1 = pose[bone.joint].distanceTo(pose[bone.parent]);
      const k = length1 / bone.length - 1;
      const d = bone.dir;
      stretch.set(
        1 + k * d.x * d.x, k * d.x * d.y, k * d.x * d.z, 0,
        k * d.y * d.x, 1 + k * d.y * d.y, k * d.y * d.z, 0,
        k * d.z * d.x, k * d.z * d.y, 1 + k * d.z * d.z, 0,
        0, 0, 0, 1,
      );
    }

    // Rotation-only version, for normals (a stretch must not skew them).
    turn.copy(translate).multiply(rotate).multiply(untranslate);
    full.copy(translate).multiply(rotate).multiply(stretch).multiply(untranslate);

    for (const [matrix, isPos] of [[full, true], [turn, false]] as const) {
      matrix.premultiply(toLocal).multiply(toWorld);
      if (amount < 1) {
        const e = matrix.elements;
        const id = identity.elements;
        for (let k = 0; k < 16; k++) e[k] = id[k] + amount * (e[k] - id[k]);
      }
      const e = matrix.elements;
      if (isPos) {
        const o = i * 12;
        for (let r = 0; r < 3; r++) {
          out.pos[o + r * 4] = e[r];
          out.pos[o + r * 4 + 1] = e[4 + r];
          out.pos[o + r * 4 + 2] = e[8 + r];
          out.pos[o + r * 4 + 3] = e[12 + r];
        }
      } else {
        normalMatrix.getNormalMatrix(matrix);
        const n = normalMatrix.elements;
        const o = i * 9;
        for (let r = 0; r < 3; r++) {
          out.nrm[o + r * 3] = n[r];
          out.nrm[o + r * 3 + 1] = n[3 + r];
          out.nrm[o + r * 3 + 2] = n[6 + r];
        }
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Weights

export interface SkinWeights {
  /** Bones per vertex. */
  influences: number;
  /** `influences` bone indices per vertex. */
  indices: Uint16Array;
  /** `influences` weights per vertex, summing to 1 (a vertex nothing influences is all 0). */
  weights: Float32Array;
}

export interface WeightOptions {
  /** Most bones one vertex follows; 1 is rigid. */
  influences: number;
  /** How sharply the nearest bone wins: weight = (nearest / distance)^falloff. */
  falloff: number;
  /** Passes of averaging a vertex's weights with its neighbours', softening the joints. */
  smooth: number;
  /**
   * Per bone (by joint index, missing = 1): how strongly it pulls, 0 switching it off, and how far it
   * reaches, 2 meaning twice as far.
   */
  strength?: ArrayLike<number | undefined>;
  radius?: ArrayLike<number | undefined>;
}

/** Bones kept per vertex while smoothing: enough to blend across a joint without a table of every bone. */
const WORKING_BONES = 8;

/**
 * Welds coincident vertices (a mesh split along seams or flat-shaded still has
 * one weight set per position): the weld id of each vertex, and a vertex
 * standing for each weld. Open addressing over quantised integer coordinates,
 * no string keys.
 */
export function weldVertices(positions: ArrayLike<number>, vertexCount: number): { weldOf: Int32Array; reps: Int32Array; welds: number } {
  const qx = new Int32Array(vertexCount);
  const qy = new Int32Array(vertexCount);
  const qz = new Int32Array(vertexCount);
  let size = 16;
  while (size < vertexCount * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const weldOf = new Int32Array(vertexCount);
  const reps = new Int32Array(vertexCount);
  let welds = 0;
  for (let v = 0; v < vertexCount; v++) {
    const x = (qx[v] = Math.round(positions[v * 3] * 1e5));
    const y = (qy[v] = Math.round(positions[v * 3 + 1] * 1e5));
    const z = (qz[v] = Math.round(positions[v * 3 + 2] * 1e5));
    let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;;) {
      const other = table[slot];
      if (other < 0) {
        table[slot] = v;
        weldOf[v] = welds;
        reps[welds++] = v;
        break;
      }
      if (qx[other] === x && qy[other] === y && qz[other] === z) {
        weldOf[v] = weldOf[other];
        break;
      }
      slot = (slot + 1) & mask;
    }
  }
  return { weldOf, reps, welds };
}

/** Zeroes weights too small to show, renormalises the rest. `wt` is sorted strongest first. */
function pruneAndNormalise(wt: Float32Array, o: number, keep: number) {
  let total = 0;
  for (let k = 0; k < keep; k++) total += wt[o + k];
  if (total <= 0) return;
  let kept = 0;
  const floor = total * 1e-3;
  for (let k = 0; k < keep; k++) {
    if (wt[o + k] < floor) wt[o + k] = 0;
    else kept += wt[o + k];
  }
  for (let k = 0; k < keep; k++) wt[o + k] /= kept;
}

/**
 * Weights from distance to the rest bones. `positions` are the mesh's own
 * vertices; `frame` takes them into the space of the bones' rest segments.
 * `index` is the mesh's triangle list, or null for an unindexed one: it only
 * serves to find neighbours for smoothing, through welded positions so that
 * the seams of a split mesh smooth together.
 *
 * Cost is vertices x bones for the distances, then vertices x a handful for
 * everything else: smoothing works on each vertex's strongest few bones, never
 * on a table of every bone, so a rig of hundreds of joints costs no more to
 * smooth than one of ten.
 */
export function computeSkinWeights(positions: ArrayLike<number>, index: ArrayLike<number> | null, frame: THREE.Matrix4, bones: SkinBone[], options: WeightOptions): SkinWeights {
  const vertexCount = Math.floor(positions.length / 3);
  const boneCount = bones.length;
  const influences = Math.max(1, Math.min(8, Math.round(options.influences), Math.max(1, boneCount)));
  const indices = new Uint16Array(vertexCount * influences);
  const weights = new Float32Array(vertexCount * influences);
  if (vertexCount === 0 || boneCount === 0) return { influences, indices, weights };

  const { weldOf, reps, welds } = weldVertices(positions, vertexCount);

  let meanLength = 0;
  let real = 0;
  for (const bone of bones) {
    if (bone.length > 0) {
      meanLength += bone.length;
      real++;
    }
  }
  const eps = 1e-9 + 0.01 * (real > 0 ? meanLength / real : 1);
  const eps2 = eps * eps;
  // weight = (nearest / distance)^falloff = ((nearest² + e²) / (distance² + e²))^(falloff / 2):
  // a whole power is a few multiplications, no pow, no sqrt.
  const half = Math.max(0.05, options.falloff) / 2;
  const wholeHalf = Number.isInteger(half) && half <= 8;
  const negligible = Math.pow(1e-3, 1 / half);

  // Flat copies of the segments, and the frame, for the hot loop.
  const hx = new Float64Array(boneCount);
  const hy = new Float64Array(boneCount);
  const hz = new Float64Array(boneCount);
  const dx = new Float64Array(boneCount);
  const dy = new Float64Array(boneCount);
  const dz = new Float64Array(boneCount);
  const len = new Float64Array(boneCount);
  bones.forEach((bone, b) => {
    hx[b] = bone.head.x;
    hy[b] = bone.head.y;
    hz[b] = bone.head.z;
    dx[b] = bone.dir.x;
    dy[b] = bone.dir.y;
    dz[b] = bone.dir.z;
    len[b] = bone.length;
  });
  const m = frame.elements;
  const strengths = new Float64Array(boneCount);
  const reach2 = new Float64Array(boneCount);
  for (let b = 0; b < boneCount; b++) {
    const strength = Number(options.strength?.[bones[b].joint]);
    const radius = Number(options.radius?.[bones[b].joint]);
    strengths[b] = Number.isFinite(strength) ? Math.max(0, strength) : 1;
    // Distance is divided by the radius: squared, and inverted here once so the loop only multiplies.
    reach2[b] = Number.isFinite(radius) && radius > 0 ? 1 / (radius * radius) : 1;
  }

  const keep = Math.min(boneCount, Math.max(Math.min(WORKING_BONES, influences + 2), influences));
  let idx = new Uint16Array(welds * keep);
  let wt = new Float32Array(welds * keep);
  const dist2 = new Float64Array(boneCount);

  for (let w = 0; w < welds; w++) {
    const v = reps[w];
    const lx = positions[v * 3];
    const ly = positions[v * 3 + 1];
    const lz = positions[v * 3 + 2];
    const px = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const py = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
    const pz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    let nearest = Infinity;
    for (let b = 0; b < boneCount; b++) {
      const ox = px - hx[b];
      const oy = py - hy[b];
      const oz = pz - hz[b];
      let t = ox * dx[b] + oy * dy[b] + oz * dz[b];
      if (t < 0) t = 0;
      else if (t > len[b]) t = len[b];
      const cx = ox - dx[b] * t;
      const cy = oy - dy[b] * t;
      const cz = oz - dz[b] * t;
      // A wider reach counts as being nearer; a bone switched off is never nearest.
      const d2 = (cx * cx + cy * cy + cz * cz) * reach2[b];
      dist2[b] = d2;
      if (strengths[b] > 0 && d2 < nearest) nearest = d2;
    }
    const near = nearest + eps2;
    const o = w * keep;
    // Strongest `keep` bones by insertion, weight computed only when it can make the cut.
    let filled = 0;
    // A bone weighing under a thousandth of the nearest is pruned anyway: skip its power.
    const farthest = near / negligible;
    for (let b = 0; b < boneCount; b++) {
      if (strengths[b] <= 0) continue;
      const d2 = dist2[b] + eps2;
      if (d2 > farthest) continue;
      const r = near / d2;
      let value: number;
      if (wholeHalf) {
        value = 1;
        for (let k = 0; k < half; k++) value *= r;
      } else {
        value = Math.pow(r, half);
      }
      value *= strengths[b];
      if (filled === keep && value <= wt[o + keep - 1]) continue;
      let slot = filled < keep ? filled++ : keep - 1;
      while (slot > 0 && wt[o + slot - 1] < value) {
        wt[o + slot] = wt[o + slot - 1];
        idx[o + slot] = idx[o + slot - 1];
        slot--;
      }
      wt[o + slot] = value;
      idx[o + slot] = b;
    }
    pruneAndNormalise(wt, o, keep);
  }

  if (options.smooth > 0 && welds > 1) {
    const passes = Math.min(20, Math.round(options.smooth));
    // Neighbours as a CSR list over weld ids.
    const corners = index ? index.length - (index.length % 3) : vertexCount - (vertexCount % 3);
    const corner = (c: number) => weldOf[index ? index[c] : c];
    const start = new Int32Array(welds + 1);
    for (let c = 0; c < corners; c++) start[corner(c) + 1] += 2;
    for (let w = 0; w < welds; w++) start[w + 1] += start[w];
    const fill = start.slice(0, welds);
    const neighbours = new Int32Array(start[welds]);
    for (let c = 0; c < corners; c += 3) {
      const a = corner(c);
      const b = corner(c + 1);
      const d = corner(c + 2);
      neighbours[fill[a]++] = b;
      neighbours[fill[a]++] = d;
      neighbours[fill[b]++] = d;
      neighbours[fill[b]++] = a;
      neighbours[fill[d]++] = a;
      neighbours[fill[d]++] = b;
    }

    let nextIdx = new Uint16Array(idx.length);
    let nextWt = new Float32Array(wt.length);
    // One dense row, cleared by undoing what was written.
    const row = new Float32Array(boneCount);
    const touchedList: number[] = [];
    for (let pass = 0; pass < passes; pass++) {
      for (let w = 0; w < welds; w++) {
        const first = start[w];
        const last = start[w + 1];
        const n = last - first;
        const o = w * keep;
        // Far from any joint a vertex and all its neighbours follow one bone alone: nothing to blend.
        if (wt[o] >= 0.9999) {
          const only = idx[o];
          let alone = true;
          for (let e = first; e < last; e++) {
            const q = neighbours[e] * keep;
            if (idx[q] !== only || wt[q] < 0.9999) {
              alone = false;
              break;
            }
          }
          if (alone) {
            for (let k = 0; k < keep; k++) {
              nextWt[o + k] = wt[o + k];
              nextIdx[o + k] = idx[o + k];
            }
            continue;
          }
        }
        touchedList.length = 0;
        const own = n > 0 ? 0.5 : 1;
        for (let k = 0; k < keep; k++) {
          const value = wt[o + k];
          if (value === 0) break;
          const b = idx[o + k];
          if (row[b] === 0) touchedList.push(b);
          row[b] += own * value;
        }
        if (n > 0) {
          const share = 0.5 / n;
          for (let e = first; e < last; e++) {
            const q = neighbours[e] * keep;
            for (let k = 0; k < keep; k++) {
              const value = wt[q + k];
              if (value === 0) break;
              const b = idx[q + k];
              if (row[b] === 0) touchedList.push(b);
              row[b] += share * value;
            }
          }
        }
        // Keep the strongest `keep`, clearing the row as it is read.
        let filled = 0;
        for (let t = 0; t < touchedList.length; t++) {
          const b = touchedList[t];
          const value = row[b];
          row[b] = 0;
          if (value === 0) continue;
          if (filled === keep && value <= nextWt[o + keep - 1]) continue;
          let slot = filled < keep ? filled++ : keep - 1;
          while (slot > 0 && nextWt[o + slot - 1] < value) {
            nextWt[o + slot] = nextWt[o + slot - 1];
            nextIdx[o + slot] = nextIdx[o + slot - 1];
            slot--;
          }
          nextWt[o + slot] = value;
          nextIdx[o + slot] = b;
        }
        for (let k = filled; k < keep; k++) {
          nextWt[o + k] = 0;
          nextIdx[o + k] = 0;
        }
        pruneAndNormalise(nextWt, o, keep);
      }
      [idx, nextIdx] = [nextIdx, idx];
      [wt, nextWt] = [nextWt, wt];
    }
  }

  // The strongest `influences` of each weld (already sorted), renormalised, per vertex.
  for (let v = 0; v < vertexCount; v++) {
    const from = weldOf[v] * keep;
    const to = v * influences;
    let total = 0;
    for (let k = 0; k < influences; k++) total += wt[from + k];
    for (let k = 0; k < influences; k++) {
      indices[to + k] = idx[from + k];
      weights[to + k] = total > 0 ? wt[from + k] / total : 0;
    }
  }
  return { influences, indices, weights };
}

// ---------------------------------------------------------------------------
// Skinning

export interface SkinBounds {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/**
 * Blends the bone matrices into each vertex of `base`, writing `out` — and,
 * when given, the normals likewise — in one pass over the weights. Returns the
 * skinned bounds, so nobody has to walk the vertices again for them.
 */
export function skinVertices(
  out: Float32Array,
  base: ArrayLike<number>,
  skin: SkinWeights,
  mats: Float32Array,
  normals?: { out: Float32Array; base: ArrayLike<number>; mats: Float32Array },
  bounds?: SkinBounds,
) {
  const { influences, indices, weights } = skin;
  const count = Math.floor(base.length / 3);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const nOut = normals?.out;
  const nBase = normals?.base;
  const nMats = normals?.mats;
  for (let v = 0; v < count; v++) {
    const x = base[v * 3];
    const y = base[v * 3 + 1];
    const z = base[v * 3 + 2];
    const o = v * influences;
    let px = 0;
    let py = 0;
    let pz = 0;
    let total = 0;
    for (let k = 0; k < influences; k++) {
      const w = weights[o + k];
      if (w === 0) break; // weights are sorted: nothing follows a zero
      const b = indices[o + k] * 12;
      px += w * (mats[b] * x + mats[b + 1] * y + mats[b + 2] * z + mats[b + 3]);
      py += w * (mats[b + 4] * x + mats[b + 5] * y + mats[b + 6] * z + mats[b + 7]);
      pz += w * (mats[b + 8] * x + mats[b + 9] * y + mats[b + 10] * z + mats[b + 11]);
      total += w;
    }
    if (total === 0) {
      px = x;
      py = y;
      pz = z;
    }
    out[v * 3] = px;
    out[v * 3 + 1] = py;
    out[v * 3 + 2] = pz;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;

    if (nOut && nBase && nMats) {
      const nx = nBase[v * 3];
      const ny = nBase[v * 3 + 1];
      const nz = nBase[v * 3 + 2];
      let ox = 0;
      let oy = 0;
      let oz = 0;
      for (let k = 0; k < influences; k++) {
        const w = weights[o + k];
        if (w === 0) break;
        const b = indices[o + k] * 9;
        ox += w * (nMats[b] * nx + nMats[b + 1] * ny + nMats[b + 2] * nz);
        oy += w * (nMats[b + 3] * nx + nMats[b + 4] * ny + nMats[b + 5] * nz);
        oz += w * (nMats[b + 6] * nx + nMats[b + 7] * ny + nMats[b + 8] * nz);
      }
      const length = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (length < 1e-12) {
        nOut[v * 3] = nx;
        nOut[v * 3 + 1] = ny;
        nOut[v * 3 + 2] = nz;
      } else {
        const inv = 1 / length;
        nOut[v * 3] = ox * inv;
        nOut[v * 3 + 1] = oy * inv;
        nOut[v * 3 + 2] = oz * inv;
      }
    }
  }
  if (bounds && count > 0) {
    bounds.min.set(minX, minY, minZ);
    bounds.max.set(maxX, maxY, maxZ);
  }
}

/** Positions only; kept for callers (and tests) that have no normals to carry. */
export function skinPositions(out: Float32Array, base: ArrayLike<number>, skin: SkinWeights, mats: Float32Array) {
  skinVertices(out, base, skin, mats);
}

export function skinNormals(out: Float32Array, base: ArrayLike<number>, skin: SkinWeights, mats: Float32Array) {
  const { influences, indices, weights } = skin;
  const count = Math.floor(base.length / 3);
  for (let v = 0; v < count; v++) {
    const x = base[v * 3];
    const y = base[v * 3 + 1];
    const z = base[v * 3 + 2];
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (let k = 0; k < influences; k++) {
      const w = weights[v * influences + k];
      if (w === 0) break;
      const m = indices[v * influences + k] * 9;
      ox += w * (mats[m] * x + mats[m + 1] * y + mats[m + 2] * z);
      oy += w * (mats[m + 3] * x + mats[m + 4] * y + mats[m + 5] * z);
      oz += w * (mats[m + 6] * x + mats[m + 7] * y + mats[m + 8] * z);
    }
    const length = Math.hypot(ox, oy, oz);
    if (length < 1e-12) {
      out[v * 3] = x;
      out[v * 3 + 1] = y;
      out[v * 3 + 2] = z;
    } else {
      out[v * 3] = ox / length;
      out[v * 3 + 1] = oy / length;
      out[v * 3 + 2] = oz / length;
    }
  }
}
