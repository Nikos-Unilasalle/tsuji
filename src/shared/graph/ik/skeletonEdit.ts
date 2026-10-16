import * as THREE from "three";

/**
 * Editing a generic skeleton: joints with positions, parents and names, as the
 * Skeleton node stores them. Every function returns a new skeleton and leaves
 * its argument alone; the viewport writes the result straight back into the
 * node's params, one undo step per edit.
 *
 * Parents may come in any order — the Skeleton node does not need parents
 * before children — but a joint is never its own ancestor.
 */
export interface SkeletonData {
  points: THREE.Vector3[];
  /** Parent joint per joint, -1 for a root. */
  parents: number[];
  names: string[];
}

const ZERO = new THREE.Vector3();

function toVector(v: unknown): THREE.Vector3 {
  if (v instanceof THREE.Vector3) return v.clone();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return new THREE.Vector3(x, y, z);
  }
  if (Array.isArray(v)) return new THREE.Vector3(Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0);
  return ZERO.clone();
}

/** A skeleton out of raw params: lengths made to agree, parents that point nowhere or loop made roots. */
export function readSkeleton(raw: { pointsList?: unknown; parents?: unknown; names?: unknown }): SkeletonData {
  const points = Array.isArray(raw.pointsList) ? raw.pointsList.map(toVector) : [];
  const n = points.length;
  const given = Array.isArray(raw.parents) ? raw.parents : [];
  const parents = points.map((_, i) => {
    const p = Math.round(Number(given[i]));
    return Number.isFinite(p) && p >= 0 && p < n && p !== i ? p : -1;
  });
  // A loop has no root to hang from: cut it at the joint that closes it.
  parents.forEach((_, i) => {
    const seen = new Set<number>();
    let at = i;
    while (at >= 0 && !seen.has(at)) {
      seen.add(at);
      at = parents[at];
    }
    if (at >= 0) parents[at] = -1;
  });
  const givenNames = Array.isArray(raw.names) ? raw.names : [];
  const names = points.map((_, i) => (typeof givenNames[i] === "string" && givenNames[i] ? (givenNames[i] as string) : `Joint ${i + 1}`));
  return { points, parents, names };
}

/** The params a skeleton is stored as. */
export function skeletonParams(data: SkeletonData) {
  return { pointsList: data.points.map((p) => p.clone()), parents: [...data.parents], names: [...data.names] };
}

/** Where a new child of `parent` goes: further along its own bone, or straight up from a root. */
export function defaultChildPosition(data: SkeletonData, parent: number): THREE.Vector3 {
  const from = data.points[parent];
  const grand = data.parents[parent];
  if (grand >= 0) {
    const along = from.clone().sub(data.points[grand]);
    const length = along.length();
    if (length > 1e-6) return from.clone().addScaledVector(along, 0.8);
  }
  return from.clone().add(new THREE.Vector3(0, 0.25, 0));
}

function uniqueName(names: string[], base: string): string {
  if (!names.includes(base)) return base;
  let n = 2;
  while (names.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** A new joint hanging from `parent`. With no parent (-1) a new root. */
export function addJoint(data: SkeletonData, parent: number, position?: THREE.Vector3): { data: SkeletonData; index: number } {
  const valid = parent >= 0 && parent < data.points.length ? parent : -1;
  const at = position?.clone() ?? (valid >= 0 ? defaultChildPosition(data, valid) : new THREE.Vector3());
  return {
    data: {
      points: [...data.points.map((p) => p.clone()), at],
      parents: [...data.parents, valid],
      names: [...data.names, uniqueName(data.names, "Joint")],
    },
    index: data.points.length,
  };
}

/**
 * Deletes joints; their children move up to the nearest joint that stays. The
 * last joint cannot be deleted — a skeleton always has one. `remap[old]` is the
 * new index of a surviving joint, -1 for a deleted one.
 */
export function removeJoints(data: SkeletonData, indices: number[]): { data: SkeletonData; remap: number[] } | null {
  const doomed = new Set(indices.filter((i) => i >= 0 && i < data.points.length));
  if (doomed.size === 0 || doomed.size >= data.points.length) return null;
  const remap = data.points.map(() => -1);
  let next = 0;
  data.points.forEach((_, i) => {
    if (!doomed.has(i)) remap[i] = next++;
  });
  const survivingParent = (i: number) => {
    let p = data.parents[i];
    while (p >= 0 && doomed.has(p)) p = data.parents[p];
    return p;
  };
  const keep = data.points.map((_, i) => i).filter((i) => !doomed.has(i));
  return {
    data: {
      points: keep.map((i) => data.points[i].clone()),
      parents: keep.map((i) => {
        const p = survivingParent(i);
        return p >= 0 ? remap[p] : -1;
      }),
      names: keep.map((i) => data.names[i]),
    },
    remap,
  };
}

/** A joint halfway along the bone that ends at `joint`; the bone is split in two. */
export function subdivideBone(data: SkeletonData, joint: number): { data: SkeletonData; index: number } | null {
  const parent = data.parents[joint];
  if (joint < 0 || joint >= data.points.length || parent < 0) return null;
  const mid = data.points[parent].clone().add(data.points[joint]).multiplyScalar(0.5);
  const index = data.points.length;
  const parents = [...data.parents, parent];
  parents[joint] = index;
  return {
    data: { points: [...data.points.map((p) => p.clone()), mid], parents, names: [...data.names, uniqueName(data.names, "Joint")] },
    index,
  };
}

/** Left <-> Right, or a trailing .L / _R style suffix; a name with no side gets "mirror". */
function mirroredName(name: string): string {
  if (/Left|Right/.test(name)) return name.replace(/Left|Right/g, (m) => (m === "Left" ? "Right" : "Left"));
  const suffix = name.match(/[._ -]([LR])$/);
  if (suffix) return name.slice(0, -1) + (suffix[1] === "L" ? "R" : "L");
  return `${name} mirror`;
}

/**
 * Copies `indices` mirrored across the plane `axis` = `center` (axis 0 is X). A
 * copy hangs from the mirror of its parent when that parent was copied too,
 * otherwise from the original parent (a limb off the spine).
 */
export function mirrorJoints(data: SkeletonData, indices: number[], axis = 0, center = 0): { data: SkeletonData; added: number[] } | null {
  const chosen = [...new Set(indices.filter((i) => i >= 0 && i < data.points.length))].sort((a, b) => a - b);
  if (chosen.length === 0) return null;
  const copyOf = new Map<number, number>();
  chosen.forEach((joint, k) => copyOf.set(joint, data.points.length + k));
  const points = data.points.map((p) => p.clone());
  const parents = [...data.parents];
  const names = [...data.names];
  for (const joint of chosen) {
    const p = data.points[joint].clone();
    p.setComponent(axis, 2 * center - p.getComponent(axis));
    points.push(p);
    const parent = data.parents[joint];
    parents.push(copyOf.get(parent) ?? parent);
    names.push(uniqueName(names, mirroredName(data.names[joint])));
  }
  return { data: { points, parents, names }, added: chosen.map((j) => copyOf.get(j)!) };
}

/** Joints below `joint`, children first level then deeper. */
export function descendantsOf(data: SkeletonData, joint: number): number[] {
  const out: number[] = [];
  const queue = [joint];
  while (queue.length) {
    const at = queue.shift()!;
    data.parents.forEach((p, i) => {
      if (p === at && !out.includes(i)) {
        out.push(i);
        queue.push(i);
      }
    });
  }
  return out;
}

export function childrenOf(data: SkeletonData, joint: number): number[] {
  return data.parents.map((p, i) => (p === joint ? i : -1)).filter((i) => i >= 0);
}

/** Moves `joint` and everything below it by `delta`. */
export function moveWithDescendants(data: SkeletonData, joint: number, delta: THREE.Vector3): SkeletonData {
  const moving = new Set([joint, ...descendantsOf(data, joint)]);
  return { points: data.points.map((p, i) => (moving.has(i) ? p.clone().add(delta) : p.clone())), parents: [...data.parents], names: [...data.names] };
}
