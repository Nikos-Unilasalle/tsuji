import * as THREE from "three";

/**
 * Procedural walk, "circle" technique: each foot has a home — its resting
 * spot, carried along by the body — and a circle of `stepRadius` around it.
 * A planted foot stays put in the world while the body moves; once the home
 * has drifted out of the circle (the foot is left behind) the leg steps: the
 * foot lifts and lands on the far side of the circle, ahead of the home in the
 * direction the home went, so it has the whole circle to cover before the
 * next step. Turning in place works the same way — the homes swing round and
 * the feet follow.
 *
 * A leg only lifts while none of its neighbours is in the air, which settles
 * into the alternating gait of a real walker without a fixed pattern — until
 * a foot is left so far behind (`stepRadius` × URGENT) that waiting would
 * stretch the leg out of shape, then it goes anyway.
 *
 * Everything is in world space; time comes in as `dt`, so the walk runs on
 * whatever clock the caller has (wall clock live, graph time on export).
 */

export interface GaitParams {
  /** Radius of the circle around each home. */
  stepRadius: number;
  /** Seconds a step takes. */
  stepDuration: number;
  /** How high a foot lifts mid-step. */
  stepHeight: number;
  /** Where a step lands: 0 on the home, 1 on the far edge of the circle. */
  overshoot: number;
}

export const GAIT_DEFAULTS: GaitParams = {
  stepRadius: 0.3,
  stepDuration: 0.22,
  stepHeight: 0.18,
  overshoot: 0.75,
};

/** A foot this many step radii from home steps even with a neighbour in the air. */
const URGENT = 1.8;
/** A foot this many step radii from home (a jump, a teleport) is put straight back home. */
const SNAP = 5;

interface LegState {
  planted: THREE.Vector3;
  stepping: boolean;
  from: THREE.Vector3;
  /** Step progress, 0..1. */
  t: number;
}

export interface GaitState {
  legs: LegState[];
}

export function createGait(homes: THREE.Vector3[]): GaitState {
  return { legs: homes.map((h) => ({ planted: h.clone(), stepping: false, from: h.clone(), t: 0 })) };
}

/** Distance between two points, ignoring the `up` component. */
function flatDistance(a: THREE.Vector3, b: THREE.Vector3, up: THREE.Vector3): number {
  const d = a.clone().sub(b);
  d.addScaledVector(up, -d.dot(up));
  return d.length();
}

/** Where a step that started at `from` lands for this home. */
function landing(from: THREE.Vector3, home: THREE.Vector3, up: THREE.Vector3, params: GaitParams): THREE.Vector3 {
  const dir = home.clone().sub(from);
  dir.addScaledVector(up, -dir.dot(up));
  if (dir.lengthSq() < 1e-12) return home.clone();
  return home.clone().addScaledVector(dir.normalize(), params.stepRadius * Math.max(0, Math.min(1, params.overshoot)));
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Advances the walk by `dt` seconds for the current `homes` (world) and
 * returns where each foot is now. `neighbors[i]` lists the legs that may not
 * be in the air together with leg i.
 */
export function stepGait(
  state: GaitState,
  homes: THREE.Vector3[],
  up: THREE.Vector3,
  neighbors: number[][],
  params: GaitParams,
  dt: number,
): THREE.Vector3[] {
  const radius = Math.max(1e-4, params.stepRadius);
  const duration = Math.max(1e-3, params.stepDuration);
  const legs = state.legs;

  legs.forEach((leg, i) => {
    const home = homes[i];
    if (!home) return;
    if (flatDistance(leg.stepping ? leg.from : leg.planted, home, up) > radius * SNAP) {
      leg.planted.copy(home);
      leg.from.copy(home);
      leg.stepping = false;
    }
  });

  // Steps in flight move on; a finished one plants where it landed.
  legs.forEach((leg, i) => {
    if (!leg.stepping || !homes[i]) return;
    leg.t += Math.max(0, dt) / duration;
    if (leg.t >= 1) {
      leg.planted.copy(landing(leg.from, homes[i], up, params));
      leg.stepping = false;
    }
  });

  // Feet left behind start a step, the furthest behind first.
  const behind = legs
    .map((leg, i) => ({ i, d: homes[i] && !leg.stepping ? flatDistance(leg.planted, homes[i], up) : 0 }))
    .filter((c) => c.d > radius)
    .sort((a, b) => b.d - a.d);
  for (const { i, d } of behind) {
    const neighbourUp = (neighbors[i] ?? []).some((n) => legs[n]?.stepping);
    if (neighbourUp && d < radius * URGENT) continue;
    const leg = legs[i];
    leg.stepping = true;
    leg.t = 0;
    leg.from.copy(leg.planted);
  }

  return legs.map((leg, i) => {
    if (!leg.stepping || !homes[i]) return leg.planted.clone();
    const s = smooth(Math.min(1, leg.t));
    return leg.from
      .clone()
      .lerp(landing(leg.from, homes[i], up, params), s)
      .addScaledVector(up, Math.sin(Math.PI * Math.min(1, leg.t)) * params.stepHeight);
  });
}

/**
 * Neighbours for legs ordered front to back, left then right in each pair
 * (buildPolypedeSkeleton's order): the legs in front of and behind on the same
 * side, and the opposite leg of the same pair.
 */
export function polypedeNeighbors(pairs: number): number[][] {
  const out: number[][] = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (let side = 0; side < 2; side++) {
      const n: number[] = [pair * 2 + (1 - side)];
      if (pair > 0) n.push((pair - 1) * 2 + side);
      if (pair < pairs - 1) n.push((pair + 1) * 2 + side);
      out.push(n);
    }
  }
  return out;
}
