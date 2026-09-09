import * as THREE from "three";
import { WIND_GLSL, WIND_UNIFORM_DECL, createWindUniforms } from "./windField";
import { createRandom } from "./grassField";

/**
 * A parametric tree: recursive branches swept into one tube mesh, plus a
 * cloud of instanced leaf cards.
 *
 * Deliberately *not* an L-system with its own grammar. What an author wants to
 * turn is "how tall", "how bushy", "how much does it droop" — so the parameters
 * are those, and the recursion is a plain one: a branch is a curved spine that
 * spawns a few children along its upper part, each shorter and thinner, until
 * the level budget runs out. Everything is driven from one seed, so a tree is
 * reproducible: the same graph exports the same tree on every machine and every
 * frame, which a `Math.random()` scatter would not be.
 *
 * The generation (`generateTreeSkeleton`) is separated from the meshing
 * (`buildBranchGeometry`, `buildLeafMatrices`) because the skeleton is the part
 * worth testing and the part other nodes may eventually want — branch tips are
 * exactly where you hang fruit, lanterns or particles.
 */

/**
 * Growth habit, not a preset.
 *
 * The distinction matters: a preset would overwrite the numbers the author has
 * already dialled in, and they would have no way of knowing which of their
 * edits survived. A species instead changes *how the recursion behaves* — does
 * the trunk keep a leader or fork into equals, do branches rise or hang, is
 * there any branching at all — and every numeric parameter still scales that
 * behaviour on top. Pick Willow and turn Branch Angle up and you get a wilder
 * willow, not a willow silently replaced by whatever the preset said.
 */
export const TREE_SPECIES = [
  "oak",
  "cherry",
  "conifer",
  "willow",
  "birch",
  "palm",
  "bush",
  "dead",
] as const;
export type TreeSpecies = (typeof TREE_SPECIES)[number];

interface SpeciesProfile {
  /**
   * How strongly the parent continues as a central leader rather than forking
   * into equal branches. 0 = a spreading, decurrent crown (oak); 1 = a single
   * trunk running to the tip with laterals off it (conifer).
   */
  leaderStrength: number;
  /** Extra rotation of laterals toward the ground, in radians at the deepest level. */
  droop: number;
  /** Multiplies the author's Branch Angle. */
  angleScale: number;
  /** Multiplies the author's Length Falloff — below 1 makes a denser, twiggier crown. */
  lengthScale: number;
  /** Multiplies the author's Branches / Node. 0 = no branching at all (palm). */
  branchScale: number;
  /** Where along a branch its children start, overriding Branch Start when set. */
  branchStart?: number;
  /** How strongly branch tips turn back toward the sky as they grow, in radians. */
  phototropism: number;
  /** Leaves only appear past this fraction of a branch's length. */
  leafAnchor: number;
  /** Multiplies the author's Leaves / Branch. 0 = bare. */
  leafScale: number;
  /** Multiplies the author's Leaf Size. */
  leafSizeScale: number;
  /** The leaf shape used when Leaf Shape is "auto". */
  leafShape: Exclude<LeafShape, "auto">;
  /** How foliage is distributed when Foliage Mode is "auto". */
  foliage: FoliageMode;
}

/**
 * Scattered leaves read as a thin veil on the twigs; clumped ones read as the
 * solid puffs of a cherry or a stylised oak, where the silhouette is carried
 * by the mass and individual leaves only texture its surface. Two different
 * looks, one placement switch.
 */
export const FOLIAGE_MODES = ["scattered", "clumps"] as const;
export type FoliageMode = (typeof FOLIAGE_MODES)[number];

export const FOLIAGE_MODE_OPTIONS = ["auto", ...FOLIAGE_MODES] as const;
export type FoliageModeOption = (typeof FOLIAGE_MODE_OPTIONS)[number];

export function resolveFoliageMode(mode: FoliageModeOption, species: TreeSpecies): FoliageMode {
  if (mode !== "auto") return mode;
  return SPECIES_PROFILES[species].foliage;
}

export const LEAF_SHAPES = [
  "auto",
  "almond",
  "oval",
  "round",
  "needle",
  "lance",
  "heart",
  "maple",
] as const;
export type LeafShape = (typeof LEAF_SHAPES)[number];

/** Shape ids as the fragment shader sees them — "auto" is resolved before it gets there. */
const LEAF_SHAPE_IDS: Record<Exclude<LeafShape, "auto">, number> = {
  almond: 0,
  oval: 1,
  round: 2,
  needle: 3,
  lance: 4,
  heart: 5,
  maple: 6,
};

export function resolveLeafShape(shape: LeafShape, species: TreeSpecies): Exclude<LeafShape, "auto"> {
  if (shape !== "auto") return shape;
  return SPECIES_PROFILES[species].leafShape;
}

export function leafShapeId(shape: Exclude<LeafShape, "auto">): number {
  return LEAF_SHAPE_IDS[shape];
}

export const SPECIES_PROFILES: Record<TreeSpecies, SpeciesProfile> = {
  // Broad, spreading, forking crown — the default idea of "a tree".
  oak: {
    leaderStrength: 0.15,
    droop: 0.1,
    angleScale: 1,
    lengthScale: 1,
    branchScale: 1,
    phototropism: 0.25,
    leafAnchor: 0.35,
    leafScale: 1,
    leafSizeScale: 1,
    leafShape: "oval",
    foliage: "scattered",
  },
  // The blossom tree: a spreading crown whose foliage is carried as dense
  // puffs at the branch ends rather than as a veil of separate leaves.
  cherry: {
    leaderStrength: 0.1,
    droop: 0.18,
    angleScale: 1.1,
    lengthScale: 0.92,
    branchScale: 1.1,
    branchStart: 0.4,
    phototropism: 0.3,
    leafAnchor: 0.55,
    leafScale: 1,
    leafSizeScale: 0.42,
    leafShape: "round",
    foliage: "clumps",
  },
  // Excurrent: one trunk to the tip, short laterals in whorls, angled down.
  conifer: {
    leaderStrength: 0.92,
    droop: 0.55,
    angleScale: 1.5,
    lengthScale: 0.62,
    branchScale: 1.4,
    branchStart: 0.12,
    phototropism: 0,
    leafAnchor: 0.05,
    leafScale: 1.8,
    leafSizeScale: 0.55,
    leafShape: "needle",
    foliage: "scattered",
  },
  // Everything hangs: long thin laterals pulled hard toward the ground.
  willow: {
    leaderStrength: 0.3,
    droop: 1.5,
    angleScale: 1.15,
    lengthScale: 1.12,
    branchScale: 1,
    phototropism: -0.35,
    leafAnchor: 0.15,
    leafScale: 1.5,
    leafSizeScale: 0.75,
    leafShape: "lance",
    foliage: "scattered",
  },
  // Slender, upright, high crown — a leader with fine ascending laterals.
  birch: {
    leaderStrength: 0.6,
    droop: 0.15,
    angleScale: 0.8,
    lengthScale: 0.85,
    branchScale: 0.9,
    branchStart: 0.55,
    phototropism: 0.5,
    leafAnchor: 0.3,
    leafScale: 1.1,
    leafSizeScale: 0.7,
    leafShape: "heart",
    foliage: "scattered",
  },
  // No branching whatsoever: a bare stem with a crown of fronds at the top.
  palm: {
    leaderStrength: 0,
    droop: 0,
    angleScale: 1,
    lengthScale: 1,
    branchScale: 0,
    phototropism: 0,
    leafAnchor: 0.93,
    leafScale: 2.4,
    leafSizeScale: 3.4,
    leafShape: "lance",
    foliage: "scattered",
  },
  // Barely a trunk, branching immediately from the base.
  bush: {
    leaderStrength: 0,
    droop: 0.05,
    angleScale: 1.25,
    lengthScale: 0.9,
    branchScale: 1.3,
    branchStart: 0.02,
    phototropism: 0.35,
    leafAnchor: 0.2,
    leafScale: 1.6,
    leafSizeScale: 0.75,
    leafShape: "round",
    foliage: "clumps",
  },
  // The winter silhouette: full branching, no foliage at all.
  dead: {
    leaderStrength: 0.2,
    droop: 0.35,
    angleScale: 1.2,
    lengthScale: 0.95,
    branchScale: 1.1,
    phototropism: -0.1,
    leafAnchor: 0.5,
    leafScale: 0,
    leafSizeScale: 0,
    leafShape: "almond",
    foliage: "scattered",
  },
};

export interface TreeParams {
  seed: number;
  species: TreeSpecies;
  /**
   * Master size. Scales trunk height, trunk radius and leaf size together, so
   * "the same tree but bigger" is one number rather than three that have to be
   * kept in proportion by hand.
   */
  sizeScale: number;
  /** Recursion depth beyond the trunk. 0 = a bare pole, 3–4 = a tree. */
  levels: number;
  trunkHeight: number;
  trunkRadius: number;
  /** How much wider the very base of the trunk is than the trunk itself. */
  trunkFlare: number;
  /**
   * Shape of the radius falloff along a branch. 1 = a straight cone; above 1
   * holds the thickness then drops away near the tip, which is what a real
   * limb does.
   */
  taper: number;
  /** Children spawned by each branch. */
  childCount: number;
  /** Child length as a fraction of its parent's. */
  lengthFalloff: number;
  /** Child radius as a fraction of its parent's end radius. */
  radiusFalloff: number;
  /** Angle a child leaves its parent at, in radians. */
  branchAngle: number;
  /** Where along the parent the first child appears, 0–1. */
  branchStart: number;
  /** Total bend of a branch along its length, in radians. Positive arcs upward. */
  curvature: number;
  /** Extra pull of every lateral toward the ground, in radians. Negative lifts them. */
  droop: number;
  /** How strongly branches turn back toward the sky as they grow, in radians. */
  phototropism: number;
  /** Random wobble per segment, in radians — the difference between a pipe and a branch. */
  gnarl: number;
  /** Spine segments per branch. */
  segments: number;
  /** Sides of the tube cross-section. */
  radialSegments: number;
  leavesPerBranch: number;
  leafSize: number;
  /** Leaf width as a fraction of its length. */
  leafAspect: number;
  /** How many of the deepest levels carry leaves. */
  leafLevels: number;
  /** Rotation of each leaf toward the ground, 0–1. */
  leafDroop: number;
  leafShape: LeafShape;
  /** Sharpness of the leaf tip — low is blunt, high draws it to a point. */
  leafTip: number;
  /** Scattered leaves, or dense puffs at the branch ends. */
  foliageMode: FoliageModeOption;
  /** Puffs placed along each leaf-bearing branch, in clump mode. */
  clumpsPerBranch: number;
  /** Radius of one puff, as a multiple of leaf size. */
  clumpRadius: number;
}

export const DEFAULT_TREE_PARAMS: TreeParams = {
  seed: 1,
  species: "oak",
  sizeScale: 1,
  levels: 3,
  trunkHeight: 4,
  trunkRadius: 0.22,
  trunkFlare: 0.35,
  taper: 1.3,
  childCount: 3,
  lengthFalloff: 0.72,
  radiusFalloff: 0.62,
  branchAngle: Math.PI * 0.28,
  branchStart: 0.45,
  curvature: 0.25,
  droop: 0,
  phototropism: 0,
  gnarl: 0.12,
  segments: 5,
  radialSegments: 6,
  leavesPerBranch: 5,
  leafSize: 0.45,
  leafAspect: 0.62,
  leafLevels: 2,
  leafDroop: 0.35,
  leafShape: "auto",
  leafTip: 0.5,
  foliageMode: "auto",
  clumpsPerBranch: 2,
  clumpRadius: 3.2,
};

export interface TreeBranch {
  level: number;
  radiusStart: number;
  radiusEnd: number;
  /** Spine points, `segments + 1` of them, in the tree's local space. */
  points: THREE.Vector3[];
  /** Unit tangent at each spine point. */
  tangents: THREE.Vector3[];
  /** True for the one child that continues its parent — the central leader. */
  isLeader: boolean;
}

/** The golden angle, so successive children spiral instead of stacking. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Hard ceiling on branches, because the recursion is `childCount ^ levels`:
 * six children over six levels is 56k branches and several million vertices
 * from two innocuous-looking spinners. Clamping the two inputs separately is
 * not enough — only their product is dangerous — so growth simply stops here.
 */
export const MAX_TREE_BRANCHES = 4000;

/**
 * Ceiling on leaf cards, for the same reason as the branch budget: clump mode
 * multiplies branches × clumps × leaves, and three modest-looking spinners can
 * ask for a million quads.
 */
export const MAX_TREE_LEAVES = 24000;

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/** A direction leaving `parentDirection` at `angle`, rotated to `azimuth` around it. */
function branchDirection(parentDirection: THREE.Vector3, angle: number, azimuth: number): THREE.Vector3 {
  const reference = Math.abs(parentDirection.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : UP;
  const axis = new THREE.Vector3().crossVectors(parentDirection, reference).normalize();
  axis.applyAxisAngle(parentDirection, azimuth);
  return parentDirection.clone().applyAxisAngle(axis, angle).normalize();
}

/**
 * Rotates `direction` toward the ground (or the sky, for a negative amount),
 * never past straight down — overshooting would curl a branch back on itself.
 */
function bendVertically(direction: THREE.Vector3, amount: number): THREE.Vector3 {
  if (Math.abs(amount) < 1e-6) return direction;
  const target = amount > 0 ? DOWN : UP;
  const axis = new THREE.Vector3().crossVectors(direction, target);
  if (axis.lengthSq() < 1e-10) return direction;
  axis.normalize();
  const available = direction.angleTo(target);
  return direction.applyAxisAngle(axis, Math.min(Math.abs(amount), available));
}

/**
 * Grows the branch skeleton. Pure: same params in, same branches out.
 * Branch count is bounded (`childCount ^ levels`) and both are clamped by the
 * node, so this cannot run away.
 */
export function generateTreeSkeleton(params: TreeParams): TreeBranch[] {
  const profile = SPECIES_PROFILES[params.species] ?? SPECIES_PROFILES.oak;
  const random = createRandom(params.seed);
  const branches: TreeBranch[] = [];

  const segments = Math.max(1, Math.floor(params.segments));
  const levels = Math.max(0, Math.floor(params.levels));
  const childCount = Math.max(0, Math.floor(params.childCount * profile.branchScale));
  const branchStart = profile.branchStart ?? params.branchStart;
  const phototropism = params.phototropism + profile.phototropism;
  const size = Math.max(0.001, params.sizeScale);

  const grow = (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    length: number,
    radiusStart: number,
    level: number,
    isLeader: boolean,
  ): void => {
    if (branches.length >= MAX_TREE_BRANCHES) return;

    const radiusEnd = radiusStart * params.radiusFalloff;
    const step = length / segments;

    const points: THREE.Vector3[] = [origin.clone()];
    const tangents: THREE.Vector3[] = [];

    // One bend axis per branch: bending about a fresh random axis each segment
    // gives noise, not an arc.
    const bendReference = Math.abs(direction.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : UP;
    const bendAxis = new THREE.Vector3().crossVectors(direction, bendReference).normalize();
    bendAxis.applyAxisAngle(direction, random() * Math.PI * 2);

    const current = direction.clone().normalize();
    const cursor = origin.clone();
    tangents.push(current.clone());

    for (let i = 0; i < segments; i++) {
      current.applyAxisAngle(bendAxis, params.curvature / segments);
      // Reaching for the light: a steady turn back toward vertical along the
      // branch, which is what stops a drooping species from simply falling
      // over and gives an upright one its lift.
      bendVertically(current, -phototropism / segments);
      if (params.gnarl > 0) {
        current.applyAxisAngle(UP, (random() - 0.5) * params.gnarl);
        current.applyAxisAngle(bendAxis, (random() - 0.5) * params.gnarl);
      }
      current.normalize();
      cursor.addScaledVector(current, step);
      points.push(cursor.clone());
      tangents.push(current.clone());
    }

    branches.push({ level, radiusStart, radiusEnd, points, tangents, isLeader });

    if (level >= levels || childCount === 0) return;

    // The leader is the child that *is* the parent continuing: nearly straight
    // on, barely shorter, barely thinner. It is what separates a fir (one trunk
    // to the tip) from an oak (a trunk that stops existing once it forks).
    const leaderStrength = THREE.MathUtils.clamp(profile.leaderStrength, 0, 1);
    const hasLeader = leaderStrength > 0.01;

    for (let c = 0; c < childCount; c++) {
      const childIsLeader = hasLeader && c === 0;

      const t = childIsLeader ? 1 : branchStart + (1 - branchStart) * ((c + 1) / (childCount + 1));
      const spineIndex = Math.min(points.length - 1, Math.round(t * segments));
      const childOrigin = points[spineIndex];
      const parentTangent = tangents[spineIndex];

      const azimuth = c * GOLDEN_ANGLE + random() * 0.6;
      const spread = params.branchAngle * profile.angleScale * (0.7 + random() * 0.6);
      const angle = childIsLeader ? spread * (1 - leaderStrength) * 0.35 : spread;

      const childDirection = branchDirection(parentTangent, angle, azimuth);
      if (!childIsLeader) {
        // Droop grows with depth: a trunk is rigid, a twig hangs.
        const depth = levels > 0 ? (level + 1) / levels : 1;
        bendVertically(childDirection, (params.droop + profile.droop) * depth);
      }

      const falloff = params.lengthFalloff * profile.lengthScale;
      const childLength = childIsLeader
        ? length * THREE.MathUtils.lerp(falloff, 0.94, leaderStrength)
        : length * falloff * (0.8 + random() * 0.4);

      const parentRadiusHere = THREE.MathUtils.lerp(radiusStart, radiusEnd, t);
      const childRadius = childIsLeader
        ? parentRadiusHere * THREE.MathUtils.lerp(params.radiusFalloff, 0.92, leaderStrength)
        : parentRadiusHere * params.radiusFalloff;

      grow(childOrigin, childDirection, childLength, childRadius, level + 1, childIsLeader);
    }
  };

  grow(
    new THREE.Vector3(0, 0, 0),
    UP.clone(),
    Math.max(0.001, params.trunkHeight * size),
    Math.max(0.0005, params.trunkRadius * size),
    0,
    true,
  );

  return branches;
}

/**
 * Sweeps a ring along every branch spine and welds them into one geometry —
 * one draw call for the whole woody part of the tree.
 *
 * Frames are parallel-transported down the spine rather than rebuilt from a
 * fixed up-vector, which is what stops the tube from twisting violently where
 * a branch passes through vertical.
 */
export function buildBranchGeometry(
  branches: TreeBranch[],
  radialSegments: number,
  taper = 1,
  trunkFlare = 0,
): THREE.BufferGeometry {
  const sides = Math.max(3, Math.floor(radialSegments));
  const taperExponent = Math.max(0.05, taper);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const branch of branches) {
    const ringCount = branch.points.length;
    const baseVertex = positions.length / 3;

    // Initial frame: any vector perpendicular to the first tangent.
    const normal = new THREE.Vector3(1, 0, 0);
    if (Math.abs(branch.tangents[0].dot(normal)) > 0.9) normal.set(0, 0, 1);
    normal.crossVectors(branch.tangents[0], normal).normalize();

    for (let i = 0; i < ringCount; i++) {
      const tangent = branch.tangents[i];

      if (i > 0) {
        // Parallel transport: rotate the previous frame by the same rotation
        // that took the previous tangent to this one.
        const previous = branch.tangents[i - 1];
        const axis = new THREE.Vector3().crossVectors(previous, tangent);
        const sin = axis.length();
        if (sin > 1e-6) {
          axis.divideScalar(sin);
          normal.applyAxisAngle(axis, Math.asin(Math.min(1, sin)));
        }
      }
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
      const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();

      const v = i / (ringCount - 1);
      // A limb holds its thickness then drops away near the tip; a straight
      // lerp gives a cone, which reads as a pencil rather than a branch.
      const profile = Math.pow(1 - v, taperExponent);
      let radius = branch.radiusEnd + (branch.radiusStart - branch.radiusEnd) * profile;
      // The trunk swells where it meets the ground.
      if (branch.level === 0 && trunkFlare > 0) {
        radius *= 1 + trunkFlare * Math.pow(1 - v, 4);
      }
      const point = branch.points[i];

      for (let j = 0; j <= sides; j++) {
        const angle = (j / sides) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin2 = Math.sin(angle);
        const outward = new THREE.Vector3()
          .addScaledVector(normal, cos)
          .addScaledVector(binormal, sin2);

        positions.push(
          point.x + outward.x * radius,
          point.y + outward.y * radius,
          point.z + outward.z * radius,
        );
        normals.push(outward.x, outward.y, outward.z);
        uvs.push(j / sides, v);
      }
    }

    for (let i = 0; i < ringCount - 1; i++) {
      for (let j = 0; j < sides; j++) {
        const a = baseVertex + i * (sides + 1) + j;
        const b = a + 1;
        const c = a + (sides + 1);
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}

/**
 * Leaf card placements, on the outer part of the outermost branches.
 *
 * `leafLevels` decides how far back from the tips foliage reaches: 1 is a thin
 * shell of leaves on the twigs only, 3 fills the crown. Species moves the
 * anchor too — a palm's fronds sit at the very top of its single stem, a
 * conifer's needles run the whole length of every lateral.
 *
 * Each card's pivot is its stem (the geometry is built with its origin at the
 * bottom edge), so the wind — and Leaf Droop — rotate it about where it is
 * actually attached.
 */
export function buildLeafMatrices(branches: TreeBranch[], params: TreeParams): THREE.Matrix4[] {
  const profile = SPECIES_PROFILES[params.species] ?? SPECIES_PROFILES.oak;
  const random = createRandom(params.seed + 977);
  const matrices: THREE.Matrix4[] = [];

  const perBranch = Math.max(0, Math.floor(params.leavesPerBranch * profile.leafScale));
  const size = Math.max(0, params.leafSize * profile.leafSizeScale * Math.max(0.001, params.sizeScale));
  if (perBranch === 0 || size <= 0) return matrices;

  const deepest = branches.reduce((max, branch) => Math.max(max, branch.level), 0);
  const levelsWithLeaves = Math.max(1, Math.floor(params.leafLevels));
  const minLevel = Math.max(0, deepest - levelsWithLeaves + 1);
  const anchor = THREE.MathUtils.clamp(profile.leafAnchor, 0, 0.99);
  const aspect = Math.max(0.02, params.leafAspect);
  const droop = THREE.MathUtils.clamp(params.leafDroop, -1, 1);
  const mode = resolveFoliageMode(params.foliageMode, params.species);
  const clumps = Math.max(1, Math.floor(params.clumpsPerBranch));
  const clumpRadius = Math.max(0, params.clumpRadius) * size;

  /** Interpolated along the spine rather than snapped to the nearest ring:
   * with a handful of segments, snapping drags a palm's crown a quarter of
   * the way back down its own trunk. */
  const pointAt = (branch: TreeBranch, t: number): THREE.Vector3 => {
    const span = branch.points.length - 1;
    const exact = THREE.MathUtils.clamp(t, 0, 1) * span;
    const index = Math.min(span, Math.floor(exact));
    const next = Math.min(span, index + 1);
    return branch.points[index].clone().lerp(branch.points[next], exact - index);
  };

  const addCard = (position: THREE.Vector3, outward: THREE.Vector3 | null): void => {
    if (matrices.length >= MAX_TREE_LEAVES) return;

    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        (random() - 0.5) * Math.PI,
        random() * Math.PI * 2,
        (random() - 0.5) * Math.PI * 0.5,
      ),
    );

    // In a clump, a card mostly faces out of the ball: that is what makes the
    // puff read as a solid volume with a leafy skin instead of a cloud of
    // confetti that happens to be round.
    if (outward && outward.lengthSq() > 1e-8) {
      const facing = new THREE.Quaternion().setFromUnitVectors(UP, outward.clone().normalize());
      quaternion.slerp(facing, 0.65);
    }

    if (Math.abs(droop) > 1e-3) {
      const cardUp = UP.clone().applyQuaternion(quaternion);
      const drooped = bendVertically(cardUp.clone(), droop * Math.PI * 0.45);
      quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(cardUp, drooped));
    }

    const scale = size * (0.7 + random() * 0.6);
    matrices.push(
      new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(scale * aspect, scale, scale)),
    );
  };

  for (const branch of branches) {
    if (branch.level < minLevel) continue;

    if (mode === "clumps") {
      for (let c = 0; c < clumps; c++) {
        // Puffs sit on the outer part of the branch, the last one at its tip.
        const t = clumps === 1 ? 1 : anchor + (1 - anchor) * ((c + 1) / clumps);
        const centre = pointAt(branch, t);

        for (let i = 0; i < perBranch; i++) {
          // Uniform in the ball would pile leaves at the centre where they are
          // never seen; biasing outward spends them on the surface, which is
          // the only part of a puff that shows.
          const radius = clumpRadius * (0.45 + 0.55 * Math.cbrt(random()));
          const theta = random() * Math.PI * 2;
          const cosPhi = random() * 2 - 1;
          const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
          const offset = new THREE.Vector3(
            Math.cos(theta) * sinPhi,
            cosPhi,
            Math.sin(theta) * sinPhi,
          ).multiplyScalar(radius);

          addCard(centre.clone().add(offset), offset);
        }
      }
      continue;
    }

    for (let i = 0; i < perBranch; i++) {
      const point = pointAt(branch, anchor + (1 - anchor) * random());
      const jitter = new THREE.Vector3(
        (random() - 0.5) * size * 0.6,
        (random() - 0.5) * size * 0.6,
        (random() - 0.5) * size * 0.6,
      );
      addCard(point.add(jitter), null);
    }
  }

  return matrices;
}

/**
 * Each leaf's height within the canopy, 0 at the lowest leaf and 1 at the
 * highest.
 *
 * This is what lets the foliage carry a vertical light gradient: in a real
 * canopy the top is lit and the underside is in its own shadow, and a flat
 * fill over the whole crown is the single thing that makes stylised foliage
 * read as a sticker. Computed from the placements rather than from world Y so
 * it stays right whatever the tree's transform does.
 */
export function computeLeafHeights(matrices: THREE.Matrix4[]): Float32Array {
  const heights = new Float32Array(matrices.length);
  if (matrices.length === 0) return heights;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < matrices.length; i++) {
    const y = matrices[i].elements[13];
    heights[i] = y;
    if (y < min) min = y;
    if (y > max) max = y;
  }

  const span = max - min;
  // A single leaf, or a perfectly flat crown, is all "top" rather than a
  // division by zero.
  if (span < 1e-6) return heights.fill(1);

  // Clamped: float32 rounding can put the lowest leaf a hair below zero, and
  // the shader raises this to a power.
  for (let i = 0; i < heights.length; i++) {
    heights[i] = THREE.MathUtils.clamp((heights[i] - min) / span, 0, 1);
  }
  return heights;
}

/** Per-leaf canopy height, as an instanced attribute. */
export function createLeafHeightAttribute(matrices: THREE.Matrix4[]): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(computeLeafHeights(matrices), 1);
}

/** A card whose origin sits at its stem rather than its middle. */
export function createLeafCardGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

const LEAF_VERTEX = /* glsl */ `
  ${WIND_UNIFORM_DECL}
  uniform float uLeafWindInfluence;

  attribute float aLeafRandom;
  attribute float aLeafHeight;

  varying vec2 vLeafUv;
  varying float vLeafRandom;
  varying float vLeafHeight;
  varying vec3 vLeafNormal;

  ${WIND_GLSL}

  /** Rodrigues' rotation — a rigid turn about an arbitrary axis. */
  vec3 rotateAboutAxis(vec3 v, vec3 axis, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
  }

  void main() {
    vLeafUv = uv;
    vLeafRandom = aLeafRandom;
    vLeafHeight = aLeafHeight;

    // The stem: the instance's own origin, which is where the card is attached
    // (createLeafCardGeometry puts the quad's origin on its bottom edge).
    vec3 anchor = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);

    // Sampled ONCE per leaf, at the stem — not per vertex.
    //
    // Sampling at each vertex's own position gave the four corners of one card
    // four different displacements, which sheared and stretched the leaf
    // instead of moving it. The offset per leaf, plus the random, is what makes
    // a cluster flutter rather than slide as a slab; the offset per *vertex*
    // was just noise tearing the quad apart.
    vec2 offset = windOffset(anchor.xz + aLeafRandom * 12.0) * uLeafWindInfluence;

    // And applied as a rotation about the stem rather than a translation of the
    // vertices: a leaf pivots where it is attached, and a rotation cannot
    // change the shape of the card no matter how hard the wind blows.
    float strength = length(offset);
    if (strength > 1e-5) {
      vec3 direction = vec3(offset.x, 0.0, offset.y) / strength;
      vec3 axis = normalize(vec3(direction.z, 0.0, -direction.x));
      // Bounded so a strong gust lays the leaf flat instead of spinning it.
      float angle = atan(strength) * (0.75 + 0.5 * aLeafRandom);
      world.xyz = anchor + rotateAboutAxis(world.xyz - anchor, axis, angle);
      vLeafNormal = normalize(rotateAboutAxis(mat3(modelMatrix) * mat3(instanceMatrix) * normal, axis, angle));
    } else {
      vLeafNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    }

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const LEAF_FRAGMENT = /* glsl */ `
  uniform vec3 uLeafColorA;
  uniform vec3 uLeafColorB;
  uniform vec3 uAutumnColorA;
  uniform vec3 uAutumnColorB;
  uniform vec3 uLightDirection;
  uniform float uAmbient;
  uniform float uLeafShape;
  uniform float uLeafTip;
  uniform float uSeason;
  uniform float uSeasonVariance;
  uniform float uCanopyShade;
  uniform float uCanopyShadePower;

  varying vec2 vLeafUv;
  varying float vLeafRandom;
  varying float vLeafHeight;
  varying vec3 vLeafNormal;

  /**
   * Half-width of the blade at height y, in [0,1]. The silhouette is cut out
   * of the card procedurally rather than sampled from an alpha texture: no
   * asset to ship, no alpha sorting to get wrong, and it stays crisp at any
   * zoom.
   */
  float leafHalfWidth(float y, float shape, float tip) {
    float pointiness = mix(0.85, 0.25, clamp(tip, 0.0, 1.0));

    if (shape < 0.5) {
      // Almond — the generic broadleaf.
      return pow(sin(y * 3.14159265), pointiness);
    } else if (shape < 1.5) {
      // Oval — widest at the middle, blunt at both ends.
      return sqrt(max(0.0, 1.0 - pow(2.0 * y - 1.0, 2.0))) * 0.95;
    } else if (shape < 2.5) {
      // Round — a disc sitting on its stem.
      return sqrt(max(0.0, 1.0 - pow(2.0 * y - 1.0, 2.0)));
    } else if (shape < 3.5) {
      // Needle — near-parallel sides, drawn to a point at the very tip.
      return 0.35 * smoothstep(0.0, 0.08, y) * pow(1.0 - y, pointiness * 0.5);
    } else if (shape < 4.5) {
      // Lance — broad low, tapering the whole way up. Willow, palm frond.
      return pow(sin(y * 3.14159265), pointiness) * (1.0 - 0.45 * y);
    } else if (shape < 5.5) {
      // Heart — two lobes at the base, a point at the tip.
      float lobes = 1.0 - 0.55 * smoothstep(0.0, 0.22, y);
      return pow(sin(clamp(y * 1.05, 0.0, 1.0) * 3.14159265), pointiness) * (0.7 + 0.5 * lobes);
    }
    // Maple — a lobed palmate blade: the almond profile scalloped by a cosine.
    float base = pow(sin(y * 3.14159265), pointiness * 0.8);
    return base * (0.72 + 0.28 * cos(y * 18.84955592));
  }

  void main() {
    float x = (vLeafUv.x - 0.5) * 2.0;
    float y = clamp(vLeafUv.y, 0.0, 1.0);
    // 0.62 keeps the card narrower than it is tall: at 1.0 the mask fills the
    // quad and every leaf reads as a disc rather than a leaf.
    float halfWidth = 0.62 * leafHalfWidth(y, uLeafShape, uLeafTip);
    if (abs(x) > halfWidth) discard;

    vec3 summer = mix(uLeafColorA, uLeafColorB, vLeafRandom);

    // Autumn as a three-stop ramp, offset per leaf: a canopy does not turn all
    // at once, and a uniform season is the tell. The offset is the leaf's own
    // random, so a given leaf keeps its place in the turn across the whole
    // animation instead of flickering between colours frame to frame.
    float season = clamp(uSeason + (vLeafRandom - 0.5) * uSeasonVariance, 0.0, 1.0);
    vec3 autumn = season < 0.5
      ? mix(summer, uAutumnColorA, season * 2.0)
      : mix(uAutumnColorA, uAutumnColorB, (season - 0.5) * 2.0);
    vec3 color = autumn;

    // Vertical canopy gradient: the top of a crown is lit, its underside sits
    // in its own shadow. Without this the foliage reads as one flat sticker.
    float canopy = mix(1.0 - uCanopyShade, 1.0, pow(clamp(vLeafHeight, 0.0, 1.0), uCanopyShadePower));

    // abs(): a leaf is thin enough to be lit from behind as well as in front.
    float diffuse = abs(dot(normalize(vLeafNormal), normalize(uLightDirection)));
    // Veins, barely — enough to break the flat fill up close.
    float vein = smoothstep(0.03, 0.0, abs(x)) * 0.12;

    gl_FragColor = vec4(color * canopy * (uAmbient + diffuse * 0.8) + vein, 1.0);
  }
`;

export function createLeafMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...createWindUniforms(),
      uLeafWindInfluence: { value: 1 },
      uLeafColorA: { value: new THREE.Color(0x4d7c2a) },
      uLeafColorB: { value: new THREE.Color(0x8bbf3d) },
      uAutumnColorA: { value: new THREE.Color(0xe0a52c) },
      uAutumnColorB: { value: new THREE.Color(0xa8321f) },
      uLightDirection: { value: new THREE.Vector3(0.5, 1, 0.3).normalize() },
      uAmbient: { value: 0.4 },
      uLeafShape: { value: 0 },
      uLeafTip: { value: 0.5 },
      uSeason: { value: 0 },
      uSeasonVariance: { value: 0.35 },
      uCanopyShade: { value: 0.45 },
      uCanopyShadePower: { value: 1.4 },
    },
    vertexShader: LEAF_VERTEX,
    fragmentShader: LEAF_FRAGMENT,
    side: THREE.DoubleSide,
  });
}

/** Per-leaf random, fed to both the wind offset and the colour mix. */
export function createLeafRandomAttribute(count: number, seed: number): THREE.InstancedBufferAttribute {
  const random = createRandom(seed + 4231);
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = random();
  return new THREE.InstancedBufferAttribute(data, 1);
}
