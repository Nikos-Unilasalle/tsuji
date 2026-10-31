import * as THREE from "three";
import { HUMAN_DEFAULTS, type HumanParams } from "./skeletons";
import { SkinWeights } from "./skinning";

/**
 * A model's own rig, as an FBX (or any skinned file) brings it: the skeleton
 * its weights were painted for, read off a THREE.SkinnedMesh.
 *
 * Two uses, both for driving the model with Tsuji's Human Skeleton:
 * - fitHumanParams: the Human Skeleton's proportions, so its joints land
 *   where the model's are (Mixamo names, which Tripo, Mixamo and most
 *   auto-riggers export);
 * - importSkinWeights: the file's weights, carried over from its bones to the
 *   Skin's (each file bone to the Skin bone that moves the same part, by name
 *   for a Human Skeleton, else by where the bones lie).
 */

export interface ImportedSkeleton {
  names: string[];
  /** Parent bone per bone, -1 for a root. */
  parents: number[];
  /** Where each bone sat when the weights were painted, in the mesh's own space. */
  positions: THREE.Vector3[];
}

/** The skeleton of the first skinned mesh inside `object`, or null. */
export function findSkinnedMesh(object: unknown): THREE.SkinnedMesh | null {
  if (!(object instanceof THREE.Object3D)) return null;
  let found: THREE.SkinnedMesh | null = null;
  object.traverse((child) => {
    if (!found && child instanceof THREE.SkinnedMesh && child.skeleton && child.geometry.attributes.skinIndex) found = child;
  });
  return found;
}

/** The bones of `mesh` at bind time, in the mesh's own space (where its vertices are). */
export function readImportedSkeleton(mesh: THREE.SkinnedMesh): ImportedSkeleton {
  const bones = mesh.skeleton.bones;
  const toMesh = mesh.bindMatrixInverse;
  const positions = mesh.skeleton.boneInverses.map((inverse) => new THREE.Vector3().setFromMatrixPosition(toMesh.clone().multiply(inverse.clone().invert())));
  return {
    names: bones.map((b) => b.name),
    parents: bones.map((b) => bones.indexOf(b.parent as THREE.Bone)),
    positions,
  };
}

/** "mixamorig:LeftUpLeg", "mixamorigLeftUpLeg", "Armature|mixamorig_LeftUpLeg" -> "leftupleg". */
export function canonicalBoneName(name: string): string {
  return name.split(/[|:]/).pop()!.toLowerCase().replace(/^mixamorig/, "").replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Fit

/** World positions of the Mixamo joints fitHumanParams needs, by canonical name; null when any is missing. */
function mixamoJoints(skeleton: ImportedSkeleton, toWorld: THREE.Matrix4) {
  const at = new Map<string, THREE.Vector3>();
  skeleton.names.forEach((n, i) => at.set(canonicalBoneName(n), skeleton.positions[i].clone().applyMatrix4(toWorld)));
  const need = ["hips", "neck", "head", "leftupleg", "leftleg", "leftfoot", "rightupleg", "rightleg", "rightfoot", "leftarm", "leftforearm", "lefthand", "rightarm", "rightforearm", "righthand"];
  if (need.some((n) => !at.has(n))) return null;
  return at;
}

/**
 * Human Skeleton params that put its joints on the model's (see
 * buildHumanSkeleton for what each one sets): its height from the top of the
 * head to the ground under the feet, its location under the hips, then each
 * proportion from the matching bones, both sides averaged. `toWorld` takes
 * the skeleton's positions into the space the Human Skeleton stands in.
 * Null when the skeleton has no Mixamo-named limbs to fit to.
 */
export function fitHumanParams(skeleton: ImportedSkeleton, toWorld = new THREE.Matrix4()): Partial<HumanParams> & Record<string, unknown> | null {
  const j = mixamoJoints(skeleton, toWorld);
  if (!j) return null;
  const g = (n: string) => j.get(n)!;
  const avg = (a: number, b: number) => (a + b) / 2;
  const both = (f: (side: "left" | "right") => number) => avg(f("left"), f("right"));
  const dist = (a: string, b: string) => g(a).distanceTo(g(b));

  const footY = both((s) => g(`${s}foot`).y);
  const ground = Math.min(...["lefttoeend", "righttoeend", "lefttoebase", "righttoebase", "leftfoot", "rightfoot"].filter((n) => j.has(n)).map((n) => g(n).y));
  const top = j.get("headtopend")?.y ?? g("head").y + 1.2 * (g("head").y - g("neck").y);
  const H = Math.max(0.05, top - Math.min(ground, footY));
  // The Human Skeleton's ankle is 0.04 H above its own ground; its origin goes where that puts the model's ankles.
  const origin = new THREE.Vector3(g("hips").x, footY - 0.04 * H, both((s) => g(`${s}upleg`).z));
  const local = (n: string) => g(n).clone().sub(origin);

  const legLength = both((s) => dist(`${s}upleg`, `${s}leg`) + dist(`${s}leg`, `${s}foot`));
  const legs = legLength / (0.49 * H);
  const hipY = 0.04 * H + legLength * Math.cos((6 * Math.PI) / 180);
  const pelvisY = hipY + 0.03 * H;
  const chestY = both((s) => local(`${s}arm`).y);
  const torso = Math.max(0.05, (chestY - pelvisY) / (0.26 * H));
  const neckY = local("neck").y;
  const neck = Math.max(0.05, (neckY - chestY) / (0.05 * H * torso));
  const headSize = Math.max(0.05, (local("head").y - neckY) / (0.08 * H * torso));
  const shoulderWidth = both((s) => Math.abs(local(`${s}arm`).x)) / (0.11 * H);
  const hipWidth = both((s) => Math.abs(local(`${s}upleg`).x)) / (0.09 * H);
  const arms = both((s) => dist(`${s}arm`, `${s}forearm`) + dist(`${s}forearm`, `${s}hand`)) / (0.325 * H);
  const armAngle = both((s) => {
    const d = g(`${s}forearm`).clone().sub(g(`${s}arm`)).normalize();
    return (Math.acos(Math.max(-1, Math.min(1, -d.y))) * 180) / Math.PI;
  });
  const legSpread = both((s) => {
    const d = g(`${s}foot`).clone().sub(g(`${s}upleg`));
    return (Math.atan2(Math.abs(d.x), Math.max(1e-6, -d.y)) * 180) / Math.PI;
  });
  // The hand's length: to the furthest fingertip, when the file has fingers.
  const handLength = both((s) => {
    let reach = 0;
    for (const [name, p] of j) if (name.startsWith(`${s}hand`) && name !== `${s}hand`) reach = Math.max(reach, p.distanceTo(g(`${s}hand`)));
    return reach;
  });
  const hands = handLength > 0 ? handLength / (0.1 * H * arms) : HUMAN_DEFAULTS.hands;
  const toeReach = both((s) => (j.has(`${s}toeend`) ? Math.abs(g(`${s}toeend`).z - g(`${s}foot`).z) : 0));
  const feet = toeReach > 0 ? toeReach / (0.78 * 0.15 * H) : HUMAN_DEFAULTS.feet;
  const torsoForward = Math.max(-0.3, Math.min(0.3, (both((s) => local(`${s}arm`).z) - 0) / H));

  const round = (x: number) => Math.round(x * 1000) / 1000;
  const bindArmAngle = Math.round(Math.max(0, Math.min(150, armAngle)));
  const bindLegAngle = legSpread < 3 ? 0 : Math.round(Math.min(60, legSpread));
  return {
    height: round(H),
    legs: round(legs),
    torso: round(torso),
    torsoForward: round(torsoForward),
    neck: round(neck),
    headSize: round(headSize),
    shoulderWidth: round(shoulderWidth),
    hipWidth: round(hipWidth),
    arms: round(arms),
    hands: round(hands),
    feet: round(feet),
    armAngle: bindArmAngle,
    bindArmAngle,
    bindLegAngle,
    location: new THREE.Vector3(round(origin.x), round(origin.y), round(origin.z)),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    // Back to the rest stance on the new proportions.
    pointsList: [],
  };
}

// ---------------------------------------------------------------------------
// Weights

/**
 * The Skin bone of a Human Skeleton that moves what each Mixamo bone moves. A
 * Skin bone runs from a joint's parent to the joint, so the file's upper arm
 * (LeftArm, from shoulder to elbow) is the Skin's "Left Elbow"; the spine is
 * matched by where it lies (the two skeletons split it differently).
 */
const MIXAMO_TO_HUMAN: Record<string, string> = {
  hips: "Pelvis",
  neck: "Head",
  head: "Head",
  headtopend: "Head",
};
for (const [side, Side] of [["left", "Left"], ["right", "Right"]] as const) {
  Object.assign(MIXAMO_TO_HUMAN, {
    [`${side}upleg`]: `${Side} Knee`,
    [`${side}leg`]: `${Side} Foot`,
    [`${side}foot`]: `${Side} Ball`,
    [`${side}toebase`]: `${Side} Toes`,
    [`${side}toeend`]: `${Side} Toes`,
    [`${side}shoulder`]: `${Side} Shoulder`,
    [`${side}arm`]: `${Side} Elbow`,
    [`${side}forearm`]: `${Side} Hand`,
    [`${side}hand`]: `${Side} Fingers`,
  });
}

function humanBoneFor(canonical: string, side: "left" | "right" | null): string | null {
  if (MIXAMO_TO_HUMAN[canonical]) return MIXAMO_TO_HUMAN[canonical];
  // Fingers: all of them go with the hand.
  if (side && canonical.startsWith(`${side}hand`)) return `${side === "left" ? "Left" : "Right"} Fingers`;
  return null;
}

/**
 * For each bone of the file, the Skin bone (an index into `rig`'s joints) that
 * takes its weights. By name where both sides are named (a Mixamo file on a
 * Human Skeleton); otherwise the Skin bone whose segment lies nearest the file
 * bone's own, on the same side of the body. `file` positions and `rig` joints
 * are in the same space.
 */
export function mapImportedBones(
  file: ImportedSkeleton,
  filePositions: THREE.Vector3[],
  rig: { parents: number[]; joints: THREE.Vector3[]; names?: string[] },
): number[] {
  const rigIndex = new Map<string, number>();
  rig.names?.forEach((n, i) => rigIndex.set(n, i));
  const children = file.parents.map(() => [] as number[]);
  file.parents.forEach((p, i) => p >= 0 && children[p].push(i));

  // A file bone's segment: to the child that carries on its line, or from its parent for an end bone.
  const segment = (i: number): [THREE.Vector3, THREE.Vector3] => {
    const head = filePositions[i];
    const p = file.parents[i];
    const along = p >= 0 ? head.clone().sub(filePositions[p]) : new THREE.Vector3(0, 1, 0);
    let best = -1;
    let bestDot = -Infinity;
    for (const c of children[i]) {
      const d = filePositions[c].clone().sub(head);
      const dot = d.lengthSq() > 0 ? d.normalize().dot(along.clone().normalize()) : -2;
      if (dot > bestDot) {
        bestDot = dot;
        best = c;
      }
    }
    return best >= 0 ? [head, filePositions[best]] : p >= 0 ? [filePositions[p], head] : [head, head];
  };
  const rigSegment = (j: number): [THREE.Vector3, THREE.Vector3] => [rig.joints[rig.parents[j] >= 0 ? rig.parents[j] : j], rig.joints[j]];
  const midpoint = ([a, b]: [THREE.Vector3, THREE.Vector3]) => a.clone().add(b).multiplyScalar(0.5);
  let size = 1e-6;
  for (const p of rig.joints) size = Math.max(size, p.length());
  const sideOf = (x: number) => (x > 0.02 * size ? 1 : x < -0.02 * size ? -1 : 0);

  const nearest = (i: number, among: number[]) => {
    const [a, b] = segment(i);
    const mid = midpoint([a, b]);
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len > 0) dir.divideScalar(len);
    let best = among[0] ?? 0;
    let bestCost = Infinity;
    for (const j of among) {
      const [c, d] = rigSegment(j);
      const rdir = d.clone().sub(c);
      const rlen = rdir.length();
      const turn = len > 0 && rlen > 0 ? 1 - Math.abs(rdir.divideScalar(rlen).dot(dir)) : 0.5;
      const side = sideOf(mid.x) !== 0 && sideOf(midpoint([c, d]).x) !== 0 && sideOf(mid.x) !== sideOf(midpoint([c, d]).x) ? size : 0;
      const cost = mid.distanceTo(midpoint([c, d])) + 0.25 * Math.max(len, rlen) * turn + side;
      if (cost < bestCost) {
        bestCost = cost;
        best = j;
      }
    }
    return best;
  };

  const allRig = rig.joints.map((_, j) => j);
  const spineRig = (rig.names ?? []).map((n, j) => (/^(Spine \d+|Chest|Neck)$/.test(n) ? j : -1)).filter((j) => j >= 0);
  return file.names.map((name, i) => {
    const canonical = canonicalBoneName(name);
    const side = canonical.startsWith("left") ? "left" : canonical.startsWith("right") ? "right" : null;
    const human = humanBoneFor(canonical, side);
    if (human && rigIndex.has(human)) return rigIndex.get(human)!;
    if (/^spine\d*$/.test(canonical) && spineRig.length > 0) return nearest(i, spineRig);
    return nearest(i, allRig);
  });
}

/**
 * The file's weights as Skin weights: each vertex's bones mapped to Skin bones
 * (several file bones landing on one add up), its strongest `influences`
 * kept and renormalised.
 */
export function importSkinWeights(geometry: THREE.BufferGeometry, boneMap: number[], influences: number): SkinWeights | null {
  const skinIndex = geometry.attributes.skinIndex as THREE.BufferAttribute | undefined;
  const skinWeight = geometry.attributes.skinWeight as THREE.BufferAttribute | undefined;
  if (!skinIndex || !skinWeight) return null;
  const count = geometry.attributes.position.count;
  const n = Math.max(1, Math.min(8, influences));
  const indices = new Uint16Array(count * n);
  const weights = new Float32Array(count * n);
  const share = new Map<number, number>();
  for (let v = 0; v < count; v++) {
    share.clear();
    for (let k = 0; k < skinIndex.itemSize; k++) {
      const w = skinWeight.getComponent(v, k);
      if (!(w > 0)) continue;
      const bone = boneMap[skinIndex.getComponent(v, k)];
      if (bone === undefined) continue;
      share.set(bone, (share.get(bone) ?? 0) + w);
    }
    const kept = [...share].sort((a, b) => b[1] - a[1]).slice(0, n);
    const total = kept.reduce((s, [, w]) => s + w, 0);
    kept.forEach(([bone, w], k) => {
      indices[v * n + k] = bone;
      weights[v * n + k] = total > 0 ? w / total : 0;
    });
  }
  return { influences: n, indices, weights };
}
