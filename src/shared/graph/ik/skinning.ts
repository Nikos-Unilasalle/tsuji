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
 * (Twist around the bone axis is not in the data, and so not in the result.)
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
}

export function publishRig(target: THREE.Object3D, parents: number[], rest: THREE.Vector3[], pose: THREE.Vector3[], matrix: THREE.Matrix4) {
  const data: RigData = { parents, rest, pose, matrix: matrix.clone() };
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

/**
 * The bone matrices for a pose, in the frame of `frame` (a mesh's bind matrix:
 * the mesh's local space -> the space `rest` and `pose` are given in), so they
 * apply straight to the mesh's own vertices.
 */
export function poseBones(bones: SkinBone[], pose: THREE.Vector3[], frame: THREE.Matrix4, options: PoseOptions, into?: PosedBones): PosedBones {
  const count = bones.length;
  const out = into && into.pos.length === count * 12 ? into : { pos: new Float32Array(count * 12), nrm: new Float32Array(count * 9) };
  const rotations: THREE.Quaternion[] = bones.map(() => new THREE.Quaternion());
  const real: boolean[] = bones.map(() => false);
  const dir = new THREE.Vector3();

  bones.forEach((bone, i) => {
    if (bone.parent < 0) return;
    dir.copy(pose[bone.joint]).sub(pose[bone.parent]);
    if (dir.lengthSq() < EPS * EPS) return;
    dir.normalize();
    rotations[i].setFromUnitVectors(bone.dir, dir);
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
}

/** Above this many weld x bone weights, smoothing is skipped rather than allocate a huge table. */
const MAX_DENSE = 12_000_000;

function segmentDistanceSq(p: THREE.Vector3, bone: SkinBone): number {
  if (bone.length === 0) return p.distanceToSquared(bone.head);
  const dx = p.x - bone.head.x;
  const dy = p.y - bone.head.y;
  const dz = p.z - bone.head.z;
  const t = Math.max(0, Math.min(bone.length, dx * bone.dir.x + dy * bone.dir.y + dz * bone.dir.z));
  const cx = dx - bone.dir.x * t;
  const cy = dy - bone.dir.y * t;
  const cz = dz - bone.dir.z * t;
  return cx * cx + cy * cy + cz * cz;
}

/**
 * Weights from distance to the rest bones. `positions` are the mesh's own
 * vertices; `frame` takes them into the space of the bones' rest segments.
 * `index` is the mesh's triangle list, or null for an unindexed one: it only
 * serves to find neighbours for smoothing, through welded positions so that
 * the seams of a split mesh smooth together.
 */
export function computeSkinWeights(positions: ArrayLike<number>, index: ArrayLike<number> | null, frame: THREE.Matrix4, bones: SkinBone[], options: WeightOptions): SkinWeights {
  const vertexCount = Math.floor(positions.length / 3);
  const boneCount = bones.length;
  const influences = Math.max(1, Math.min(8, Math.round(options.influences), Math.max(1, boneCount)));
  const indices = new Uint16Array(vertexCount * influences);
  const weights = new Float32Array(vertexCount * influences);
  if (vertexCount === 0 || boneCount === 0) return { influences, indices, weights };

  // Weld coincident vertices: one weight set per position.
  const weldOf = new Int32Array(vertexCount);
  const reps: number[] = [];
  const seen = new Map<string, number>();
  for (let v = 0; v < vertexCount; v++) {
    const key = `${Math.round(positions[v * 3] * 1e5)},${Math.round(positions[v * 3 + 1] * 1e5)},${Math.round(positions[v * 3 + 2] * 1e5)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = reps.length;
      reps.push(v);
      seen.set(key, id);
    }
    weldOf[v] = id;
  }
  const welds = reps.length;

  let meanLength = 0;
  let real = 0;
  for (const bone of bones) {
    if (bone.length > 0) {
      meanLength += bone.length;
      real++;
    }
  }
  const eps = 1e-9 + 0.01 * (real > 0 ? meanLength / real : 1);
  const falloff = Math.max(0.1, options.falloff);

  const dense = new Float32Array(welds * boneCount);
  const p = new THREE.Vector3();
  const dist = new Float64Array(boneCount);
  for (let w = 0; w < welds; w++) {
    const v = reps[w];
    p.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]).applyMatrix4(frame);
    let nearest = Infinity;
    for (let b = 0; b < boneCount; b++) {
      dist[b] = Math.sqrt(segmentDistanceSq(p, bones[b]));
      if (dist[b] < nearest) nearest = dist[b];
    }
    let total = 0;
    for (let b = 0; b < boneCount; b++) {
      const k = Math.pow((nearest + eps) / (dist[b] + eps), falloff);
      dense[w * boneCount + b] = k;
      total += k;
    }
    for (let b = 0; b < boneCount; b++) dense[w * boneCount + b] /= total;
  }

  let table = dense;
  if (options.smooth > 0 && welds * boneCount <= MAX_DENSE) {
    // Neighbours as a CSR list over weld ids.
    const triangleCorners = index ? index.length : vertexCount - (vertexCount % 3);
    const corner = (c: number) => weldOf[index ? index[c] : c];
    const degree = new Int32Array(welds + 1);
    for (let c = 0; c + 2 < triangleCorners; c += 3) {
      const a = corner(c);
      const b = corner(c + 1);
      const d = corner(c + 2);
      degree[a] += 2;
      degree[b] += 2;
      degree[d] += 2;
    }
    const start = new Int32Array(welds + 1);
    for (let w = 0; w < welds; w++) start[w + 1] = start[w] + degree[w];
    const fill = start.slice(0, welds);
    const neighbours = new Int32Array(start[welds]);
    for (let c = 0; c + 2 < triangleCorners; c += 3) {
      const tri = [corner(c), corner(c + 1), corner(c + 2)];
      for (let e = 0; e < 3; e++) {
        const a = tri[e];
        neighbours[fill[a]++] = tri[(e + 1) % 3];
        neighbours[fill[a]++] = tri[(e + 2) % 3];
      }
    }
    let from = dense;
    let to = new Float32Array(dense.length);
    for (let pass = 0; pass < Math.min(20, Math.round(options.smooth)); pass++) {
      for (let w = 0; w < welds; w++) {
        const n = start[w + 1] - start[w];
        for (let b = 0; b < boneCount; b++) {
          let sum = 0;
          for (let k = start[w]; k < start[w + 1]; k++) sum += from[neighbours[k] * boneCount + b];
          const own = from[w * boneCount + b];
          to[w * boneCount + b] = n > 0 ? 0.5 * own + 0.5 * (sum / n) : own;
        }
      }
      [from, to] = [to, from];
    }
    table = from;
  }

  // Keep the strongest `influences` per weld, renormalised.
  const keptIndex = new Uint16Array(welds * influences);
  const keptWeight = new Float32Array(welds * influences);
  for (let w = 0; w < welds; w++) {
    const o = w * influences;
    let filled = 0;
    for (let b = 0; b < boneCount; b++) {
      const value = table[w * boneCount + b];
      if (filled === influences && value <= keptWeight[o + influences - 1]) continue;
      let slot = filled < influences ? filled++ : influences - 1;
      while (slot > 0 && keptWeight[o + slot - 1] < value) {
        keptWeight[o + slot] = keptWeight[o + slot - 1];
        keptIndex[o + slot] = keptIndex[o + slot - 1];
        slot--;
      }
      keptWeight[o + slot] = value;
      keptIndex[o + slot] = b;
    }
    let total = 0;
    for (let k = 0; k < influences; k++) total += keptWeight[o + k];
    if (total > 0) for (let k = 0; k < influences; k++) keptWeight[o + k] /= total;
  }
  for (let v = 0; v < vertexCount; v++) {
    const from = weldOf[v] * influences;
    const to = v * influences;
    for (let k = 0; k < influences; k++) {
      indices[to + k] = keptIndex[from + k];
      weights[to + k] = keptWeight[from + k];
    }
  }
  return { influences, indices, weights };
}

// ---------------------------------------------------------------------------
// Skinning

/** Blends the bone matrices into each vertex of `base`, writing `out`. */
export function skinPositions(out: Float32Array, base: ArrayLike<number>, skin: SkinWeights, mats: Float32Array) {
  const { influences, indices, weights } = skin;
  const count = Math.floor(base.length / 3);
  for (let v = 0; v < count; v++) {
    const x = base[v * 3];
    const y = base[v * 3 + 1];
    const z = base[v * 3 + 2];
    let ox = 0;
    let oy = 0;
    let oz = 0;
    let total = 0;
    for (let k = 0; k < influences; k++) {
      const w = weights[v * influences + k];
      if (w === 0) continue;
      const m = indices[v * influences + k] * 12;
      ox += w * (mats[m] * x + mats[m + 1] * y + mats[m + 2] * z + mats[m + 3]);
      oy += w * (mats[m + 4] * x + mats[m + 5] * y + mats[m + 6] * z + mats[m + 7]);
      oz += w * (mats[m + 8] * x + mats[m + 9] * y + mats[m + 10] * z + mats[m + 11]);
      total += w;
    }
    if (total === 0) {
      out[v * 3] = x;
      out[v * 3 + 1] = y;
      out[v * 3 + 2] = z;
    } else {
      out[v * 3] = ox;
      out[v * 3 + 1] = oy;
      out[v * 3 + 2] = oz;
    }
  }
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
      if (w === 0) continue;
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
