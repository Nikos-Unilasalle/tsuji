import * as THREE from "three";

/**
 * FABRIK — Forward And Backward Reaching Inverse Kinematics (Aristidou &
 * Lasenby, 2011) — over a tree of joints, with several end effectors.
 *
 * Positions only: no angles, no matrices. A backward pass drags every chain
 * from its target back toward the root keeping bone lengths, a forward pass
 * pins the root again and walks back out; a few rounds converge. A joint where
 * several targeted branches meet (a sub-base: the chest, with the neck and
 * both arms hanging off it) takes the weighted centroid of where each branch
 * wants it, which is the paper's multi-end-effector extension.
 *
 * Three additions on top:
 *
 * - **Rigid joints** keep a fixed offset in their parent's frame instead of a
 *   free bone — a shoulder sits where the chest's frame puts it, it does not
 *   swing down to the hand. The parent's frame is the rotation taking its
 *   rest bone direction onto its current one (swing only, no twist); the root
 *   has no bone, its frame is the identity.
 * - **Pole targets** choose which way a joint bends. A joint is rotated about
 *   the line through its two neighbours until it lies on the pole's side:
 *   a rotation about that line moves neither neighbour, so bone lengths are
 *   untouched. Applied before solving too, because FABRIK cannot bend a chain
 *   that starts out perfectly straight along its target — every direction it
 *   reads is the same line — and again each round, before the forward pass.
 * - **Joint limits** keep a bone's direction inside an elliptical cone
 *   around a reference axis carried by the parent's frame (see IkLimit). The
 *   forward pass enforces them and is the last thing each round does, so the
 *   returned pose always respects them — at the price of not reaching a
 *   target the limits put out of reach.
 */

export interface IkJoint {
  /** Index of the parent joint; -1 for the root. Parents always come before their children. */
  parent: number;
  /** Rigid: kept at its rest offset in the parent's frame rather than at a free bone length. */
  rigid?: boolean;
}

/**
 * Keeps the bone from `joint`'s parent to `joint` within an angle of `axis`.
 *
 * `axis` is given in the rig's rest space and turns with the parent's frame
 * (the swing of the parent's bone from rest, or the root's identity), so:
 *
 * - a **hinge** (knee, elbow) uses the parent bone's own rest direction as
 *   axis: the angle is then the bend, `minAngle`..`maxAngle`, and the pole
 *   decides which side it bends to;
 * - a **ball joint** (hip, shoulder, spine) uses a fixed rest direction, and
 *   `side` makes the cone elliptical: `side.maxAngle` toward `side.axis`,
 *   `maxAngle` across it.
 *
 * Angles in radians.
 */
export interface IkLimit {
  joint: number;
  axis: THREE.Vector3;
  maxAngle: number;
  minAngle?: number;
  side?: { axis: THREE.Vector3; maxAngle: number };
}

export interface IkRig {
  joints: IkJoint[];
  /** Rest positions, one per joint, in the rig's own space. Bone lengths and rigid offsets come from these. */
  rest: THREE.Vector3[];
  limits?: IkLimit[];
}

export interface IkEffector {
  /** A leaf joint. */
  joint: number;
  target: THREE.Vector3;
  /** Pull on shared sub-bases relative to the other effectors (default 1). 0 follows without pulling. */
  weight?: number;
}

export interface IkPole {
  /** A joint with a parent and exactly one child. */
  joint: number;
  pole: THREE.Vector3;
}

export interface FabrikOptions {
  /** Distance under which every effector counts as reached. */
  tolerance?: number;
  maxIterations?: number;
}

export interface FabrikResult {
  positions: THREE.Vector3[];
  iterations: number;
  /** Largest distance left between an effector and its target. */
  error: number;
}

interface Prepared {
  children: number[][];
  lengths: number[];
  /** Rest offset from the parent, in the parent's rest frame (rigid joints only). */
  offsets: THREE.Vector3[];
  /** Rest bone direction of each joint (from its parent); null for the root. */
  restDirs: (THREE.Vector3 | null)[];
}

const prepared = new WeakMap<IkRig, Prepared>();

function prepare(rig: IkRig): Prepared {
  const cached = prepared.get(rig);
  if (cached) return cached;
  const n = rig.joints.length;
  const children: number[][] = Array.from({ length: n }, () => []);
  const lengths = new Array<number>(n).fill(0);
  const offsets: THREE.Vector3[] = [];
  const restDirs: (THREE.Vector3 | null)[] = [];
  rig.joints.forEach((joint, i) => {
    if (joint.parent >= i) throw new Error(`IK rig: joint ${i}'s parent must come before it`);
    if (joint.parent >= 0) children[joint.parent].push(i);
    const offset = joint.parent >= 0 ? rig.rest[i].clone().sub(rig.rest[joint.parent]) : new THREE.Vector3();
    lengths[i] = offset.length();
    offsets.push(offset);
    restDirs.push(joint.parent >= 0 && lengths[i] > 1e-9 ? offset.clone().divideScalar(lengths[i]) : null);
  });
  const result = { children, lengths, offsets, restDirs };
  prepared.set(rig, result);
  return result;
}

/**
 * Frame of each joint: the swing from its rest bone direction to its current
 * one. A rigid joint's bone does not define a frame of its own (it would just
 * reproduce its parent's), so it inherits its parent's frame.
 */
function frames(rig: IkRig, prep: Prepared, positions: THREE.Vector3[]): THREE.Quaternion[] {
  const out: THREE.Quaternion[] = [];
  const dir = new THREE.Vector3();
  rig.joints.forEach((joint, i) => {
    const restDir = prep.restDirs[i];
    if (joint.parent < 0) {
      out.push(new THREE.Quaternion());
    } else if (joint.rigid || !restDir) {
      out.push(out[joint.parent].clone());
    } else {
      dir.subVectors(positions[i], positions[joint.parent]);
      const len = dir.length();
      out.push(len > 1e-9 ? new THREE.Quaternion().setFromUnitVectors(restDir, dir.divideScalar(len)) : out[joint.parent].clone());
    }
  });
  return out;
}

/**
 * `dir` (unit) clamped into a cone around `axis` (unit), keeping its heading
 * around the axis: `side.maxAngle` toward `side.axis`, `maxAngle` across it,
 * an ellipse in between. At least `minAngle` from the axis.
 */
export function clampDirection(
  dir: THREE.Vector3,
  axis: THREE.Vector3,
  maxAngle: number,
  minAngle = 0,
  side?: { axis: THREE.Vector3; maxAngle: number },
): THREE.Vector3 {
  // u: the side direction, flattened onto the plane across the axis.
  const u = new THREE.Vector3();
  for (const candidate of [side?.axis, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)]) {
    if (!candidate) continue;
    u.copy(candidate).addScaledVector(axis, -candidate.dot(axis));
    if (u.lengthSq() > 1e-12) break;
  }
  u.normalize();
  const v = axis.clone().cross(u);

  const theta = Math.acos(Math.max(-1, Math.min(1, dir.dot(axis))));
  const x = dir.dot(u);
  const y = dir.dot(v);
  // On the axis the heading is undefined; any one does to push out to minAngle.
  const phi = Math.hypot(x, y) > 1e-9 ? Math.atan2(y, x) : 0;
  const aU = Math.max(1e-6, side ? side.maxAngle : maxAngle);
  const aV = Math.max(1e-6, maxAngle);
  const bound = 1 / Math.hypot(Math.cos(phi) / aU, Math.sin(phi) / aV);
  const t = Math.max(Math.min(theta, bound), Math.min(minAngle, bound));
  if (Math.abs(t - theta) < 1e-9) return dir.clone();
  return axis
    .clone()
    .multiplyScalar(Math.cos(t))
    .add(u.multiplyScalar(Math.cos(phi) * Math.sin(t)))
    .add(v.multiplyScalar(Math.sin(phi) * Math.sin(t)));
}

/** Moves `point` to `length` from `anchor`, along the line it is already on. */
function placeAt(point: THREE.Vector3, anchor: THREE.Vector3, length: number, fallback: THREE.Vector3): THREE.Vector3 {
  const dir = point.clone().sub(anchor);
  const len = dir.length();
  if (len < 1e-9) dir.copy(fallback);
  else dir.divideScalar(len);
  return anchor.clone().addScaledVector(dir, length);
}

/**
 * Rotates each pole's joint about the axis through its parent and its only
 * child, onto the pole's side. Distances to both neighbours are preserved.
 */
export function applyPoles(rig: IkRig, positions: THREE.Vector3[], poles: IkPole[]): void {
  const prep = prepare(rig);
  const axis = new THREE.Vector3();
  const toJoint = new THREE.Vector3();
  const toPole = new THREE.Vector3();
  for (const { joint, pole } of poles) {
    const parent = rig.joints[joint]?.parent ?? -1;
    const kids = prep.children[joint] ?? [];
    if (parent < 0 || kids.length !== 1) continue;
    const a = positions[parent];
    const b = positions[kids[0]];
    axis.subVectors(b, a);
    const axisLen = axis.length();
    if (axisLen < 1e-9) continue;
    axis.divideScalar(axisLen);
    // Both directions, flattened onto the plane perpendicular to the axis.
    toJoint.subVectors(positions[joint], a);
    toJoint.addScaledVector(axis, -toJoint.dot(axis));
    toPole.subVectors(pole, a);
    toPole.addScaledVector(axis, -toPole.dot(axis));
    // A straight limb (joint on the axis) or a pole on the axis gives no side to turn toward.
    if (toJoint.lengthSq() < 1e-12 || toPole.lengthSq() < 1e-12) continue;
    const angle = Math.atan2(toJoint.clone().cross(toPole).dot(axis), toJoint.dot(toPole));
    positions[joint].sub(a).applyAxisAngle(axis, angle).add(a);
  }
}

/**
 * Solves the rig for its effectors, starting from `start` (default: the rest
 * pose). The root stays where `start` has it. Returns new positions; `start`
 * is not modified.
 */
export function solveFabrik(
  rig: IkRig,
  effectors: IkEffector[],
  options: FabrikOptions & { start?: THREE.Vector3[]; poles?: IkPole[] } = {},
): FabrikResult {
  const prep = prepare(rig);
  const n = rig.joints.length;
  const tolerance = options.tolerance ?? 1e-4;
  const maxIterations = options.maxIterations ?? 20;
  const poles = options.poles ?? [];
  const positions = (options.start ?? rig.rest).map((p) => p.clone());
  const root = positions[0].clone();

  // Which joints have an effector somewhere below them, and with what weight
  // (a branch weighs what its effectors weigh together).
  const targetOf = new Map<number, THREE.Vector3>();
  const weight = new Array<number>(n).fill(0);
  for (const e of effectors) {
    if (e.joint <= 0 || e.joint >= n) continue;
    targetOf.set(e.joint, e.target);
    for (let j = e.joint; j > 0; j = rig.joints[j].parent) weight[j] += Math.max(0, e.weight ?? 1);
  }
  const active = new Array<boolean>(n).fill(false);
  for (const e of effectors) {
    if (e.joint <= 0 || e.joint >= n) continue;
    for (let j = e.joint; j >= 0; j = rig.joints[j].parent) active[j] = true;
  }

  const fallbackDir = (i: number) => prep.restDirs[i] ?? new THREE.Vector3(0, 1, 0);
  const error = () => {
    let max = 0;
    for (const [joint, target] of targetOf) max = Math.max(max, positions[joint].distanceTo(target));
    return max;
  };

  const limitOf = new Map((rig.limits ?? []).map((l) => [l.joint, l]));

  applyPoles(rig, positions, poles);

  let iterations = 0;
  let err = error();
  while (err > tolerance && iterations < maxIterations) {
    iterations++;

    // Backward: leaves first, every joint pulled toward where its targeted
    // children want it. The rigid frames are read once from the pose the
    // pass starts on — they depend on the bones this pass is moving.
    const rot = frames(rig, prep, positions);
    for (let i = n - 1; i > 0; i--) {
      if (!active[i]) continue;
      const target = targetOf.get(i);
      if (target) {
        positions[i].copy(target);
        continue;
      }
      const sum = new THREE.Vector3();
      let total = 0;
      let count = 0;
      const plain = new THREE.Vector3();
      for (const c of prep.children[i]) {
        if (!active[c]) continue;
        const candidate = rig.joints[c].rigid
          ? positions[c].clone().sub(prep.offsets[c].clone().applyQuaternion(rot[i]))
          : placeAt(positions[i], positions[c], prep.lengths[c], fallbackDir(c).clone().negate());
        sum.addScaledVector(candidate, weight[c]);
        total += weight[c];
        plain.add(candidate);
        count++;
      }
      // All-zero weights (every effector below follows without pulling): plain average.
      if (total > 1e-12) positions[i].copy(sum.divideScalar(total));
      else if (count > 0) positions[i].copy(plain.divideScalar(count));
    }

    applyPoles(rig, positions, poles);

    // Forward: root pinned, every joint put back at its length (or rigid
    // offset) from its now-final parent, inside its limit.
    positions[0].copy(root);
    const forwardRot: THREE.Quaternion[] = [new THREE.Quaternion()];
    const dir = new THREE.Vector3();
    for (let i = 1; i < n; i++) {
      const joint = rig.joints[i];
      const p = joint.parent;
      if (joint.rigid) {
        positions[i].copy(positions[p]).add(prep.offsets[i].clone().applyQuaternion(forwardRot[p]));
      } else {
        positions[i].copy(placeAt(positions[i], positions[p], prep.lengths[i], fallbackDir(i)));
        const limit = limitOf.get(i);
        if (limit) {
          const q = forwardRot[p];
          const axis = limit.axis.clone().applyQuaternion(q).normalize();
          const side = limit.side ? { axis: limit.side.axis.clone().applyQuaternion(q), maxAngle: limit.side.maxAngle } : undefined;
          const bone = positions[i].clone().sub(positions[p]).normalize();
          const clamped = clampDirection(bone, axis, limit.maxAngle, limit.minAngle ?? 0, side);
          positions[i].copy(positions[p]).addScaledVector(clamped, prep.lengths[i]);
        }
      }
      const restDir = prep.restDirs[i];
      if (joint.rigid || !restDir) {
        forwardRot.push(forwardRot[p].clone());
      } else {
        dir.subVectors(positions[i], positions[p]).normalize();
        forwardRot.push(new THREE.Quaternion().setFromUnitVectors(restDir, dir));
      }
    }
    err = error();
  }

  return { positions, iterations, error: error() };
}

/** Bone length of each joint (distance to its parent at rest; 0 for the root). */
export function boneLengths(rig: IkRig): number[] {
  return [...prepare(rig).lengths];
}
