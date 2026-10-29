import * as THREE from "three";
import { CONTROL, wigglePose } from "./humanPose";

/**
 * The groove of a dancing body: what it does on the beat when no pose holds
 * it — the pelvis bouncing and swaying, the shoulders following, the head
 * nodding, the hands pumping, the feet stepping. A pure function of the beat
 * (and, for Groove, of the time), so a dance scrubs and exports the same.
 *
 * Every part is a handful of oscillators on the beat. The body rides on the
 * pelvis, the head and arms on the shoulders: what moves the pelvis carries
 * them along, so the arms do not stretch when the hips drop. The shoulders
 * have no control of their own — moving the head and both arms together
 * bends the spine under them (the head is an effector of the solve).
 *
 * Feet step only: each step lifts one foot, carries it and puts it down on
 * the beat; between steps it stays planted, so nothing slides. The pelvis
 * follows the feet, halfway between them.
 *
 * The head also turns on its neck — nods, looks aside, tilts (`look`, in
 * radians): the turn is applied after the solve (see turnHead), the look
 * aside as a twist the skin follows.
 *
 * Amplitudes are fractions of the body's height (pelvis, shoulder and head
 * turns in radians), so a groove carries over to any body.
 */

/** sine: smooth back and forth · pulse: a beat that hits and recovers (0..1, peak on the beat) · snap: robot, held then snapped. */
export type GrooveWave = "sine" | "pulse" | "snap";

export interface GrooveOsc {
  amp: number;
  /** Cycles per beat: 1 every beat, 0.5 over two beats (left on one, right on the next), 2 on the eighths. */
  rate: number;
  /** In beats: how late this one moves after the beat. */
  phase?: number;
  wave?: GrooveWave;
}

type Axes = { x?: GrooveOsc; y?: GrooveOsc; z?: GrooveOsc };

/** One step: `foot` (0 left, 1 right) moved to (dx, dz) from where it stands at rest, landing on the beat. */
export interface FootStep {
  foot: 0 | 1;
  dx: number;
  dz: number;
}

export interface GrooveStyle {
  /** The hips: x sway, y bounce, z thrust; twist turns them, tilt drops one hip. */
  pelvis?: Axes & { twist?: GrooveOsc; tilt?: GrooveOsc };
  /** The shoulders, with the head and arms riding on them; twist turns them about the spine. */
  chest?: Axes & { twist?: GrooveOsc };
  head?: Axes;
  /** The head turning on its neck, radians: x nods (+ down), y looks aside (+ to its left), z tilts (+ toward its right shoulder). */
  look?: Axes;
  /** Both hands, the right half a cycle behind the left when `alternate`. */
  hands?: Axes & { alternate?: boolean };
  /** One step per beat, round and round; null holds the beat. Empty: the feet stay planted. */
  steps?: (FootStep | null)[];
  /** How high a stepping foot lifts. */
  lift?: number;
}

export interface GrooveSettings {
  /** × every movement: 0 still, 1 as styled, more is wilder. Steps keep their length. */
  energy: number;
  /** 0 a metronome, 1 human — every part a little off and alive, more is loose. */
  groove: number;
  /** 0 straight, 1 full triplet swing: the off-beat pushed late. */
  swing: number;
  seed: number;
}

export const NATURAL_GROOVE: GrooveSettings = { energy: 1, groove: 0, swing: 0, seed: 0 };

export const GROOVE_PRESETS = {
  bounce: {
    label: "Bounce",
    hint: "Knees on the beat, head nodding, shoulders rolling, feet tapping",
    style: {
      pelvis: { y: { amp: -0.025, rate: 1, wave: "pulse" }, twist: { amp: 0.05, rate: 0.5 } },
      chest: { y: { amp: -0.008, rate: 1, phase: 0.05, wave: "pulse" }, twist: { amp: -0.06, rate: 0.5, phase: 0.1 } },
      head: { z: { amp: 0.012, rate: 1, phase: 0.08, wave: "pulse" } },
      look: { x: { amp: 0.16, rate: 1, phase: 0.1, wave: "pulse" }, y: { amp: 0.12, rate: 0.25, phase: 0.5 } },
      hands: { y: { amp: -0.02, rate: 1, phase: 0.1, wave: "pulse" }, x: { amp: 0.01, rate: 0.5, phase: 0.2 } },
      steps: [{ foot: 0, dx: 0, dz: 0 }, { foot: 1, dx: 0, dz: 0 }],
      lift: 0.02,
    },
  },
  sway: {
    label: "Sway",
    hint: "Slow side to side, hips first, shoulders after, head leaning in",
    style: {
      pelvis: { x: { amp: 0.03, rate: 0.5 }, tilt: { amp: 0.06, rate: 0.5 }, y: { amp: -0.008, rate: 1, wave: "pulse" } },
      chest: { x: { amp: 0.015, rate: 0.5, phase: 0.25 }, twist: { amp: 0.05, rate: 0.5, phase: 0.3 } },
      head: { x: { amp: 0.008, rate: 0.5, phase: 0.4 } },
      look: { z: { amp: -0.14, rate: 0.5, phase: 0.45 }, y: { amp: 0.18, rate: 0.125, phase: 1 }, x: { amp: 0.05, rate: 1, phase: 0.2, wave: "pulse" } },
      hands: { x: { amp: 0.03, rate: 0.5, phase: 0.3 }, y: { amp: 0.012, rate: 0.5, phase: 0.55 } },
    },
  },
  stepTouch: {
    label: "Step-Touch",
    hint: "Step out, close, step back, close — the party two-step, looking where it goes",
    style: {
      pelvis: { y: { amp: -0.02, rate: 1, wave: "pulse" }, twist: { amp: -0.06, rate: 0.25, phase: 0.5 } },
      chest: { x: { amp: 0.01, rate: 0.25, phase: 0.5 }, twist: { amp: -0.05, rate: 0.25, phase: 0.6 } },
      head: { z: { amp: 0.008, rate: 1, phase: 0.1, wave: "pulse" } },
      look: { y: { amp: -0.3, rate: 0.25, phase: 0.4 }, x: { amp: 0.08, rate: 1, phase: 0.1, wave: "pulse" } },
      hands: { z: { amp: 0.05, rate: 0.5 }, y: { amp: -0.015, rate: 1, wave: "pulse" }, x: { amp: -0.02, rate: 0.25, phase: 0.5 }, alternate: true },
      steps: [
        { foot: 1, dx: -0.12, dz: 0 },
        { foot: 0, dx: -0.12, dz: 0 },
        { foot: 0, dx: 0, dz: 0 },
        { foot: 1, dx: 0, dz: 0 },
      ],
      lift: 0.04,
    },
  },
  disco: {
    label: "Disco",
    hint: "Hips turning, one hand up and the other down, in turns",
    style: {
      pelvis: { x: { amp: 0.02, rate: 0.5 }, twist: { amp: 0.15, rate: 0.5 }, y: { amp: -0.012, rate: 1, wave: "pulse" } },
      chest: { twist: { amp: -0.1, rate: 0.5, phase: 0.1 } },
      head: { x: { amp: 0.006, rate: 0.5, phase: 0.2 } },
      // The head follows the hand going up, chin lifting with it.
      look: { y: { amp: 0.35, rate: 0.5, phase: 0.08 }, x: { amp: -0.08, rate: 1, phase: 0.5, wave: "pulse" }, z: { amp: -0.06, rate: 0.5, phase: 0.1 } },
      hands: { y: { amp: 0.12, rate: 0.5 }, x: { amp: 0.04, rate: 0.5 }, alternate: true },
      steps: [{ foot: 0, dx: 0, dz: 0 }, { foot: 1, dx: 0, dz: 0 }],
      lift: 0.015,
    },
  },
  hipHop: {
    label: "Hip-Hop",
    hint: "Deep knee drop, chest popping, heavy head",
    style: {
      pelvis: { y: { amp: -0.04, rate: 1, wave: "pulse" }, z: { amp: -0.01, rate: 1, wave: "pulse" } },
      chest: { z: { amp: 0.02, rate: 1, phase: 0.1, wave: "pulse" } },
      head: { z: { amp: 0.02, rate: 1, phase: 0.15, wave: "pulse" }, y: { amp: -0.008, rate: 1, phase: 0.15, wave: "pulse" } },
      look: { x: { amp: 0.3, rate: 1, phase: 0.12, wave: "pulse" }, y: { amp: 0.2, rate: 0.25, wave: "snap" }, z: { amp: 0.08, rate: 0.5, phase: 0.2 } },
      hands: { z: { amp: 0.04, rate: 0.5 }, y: { amp: -0.02, rate: 1, wave: "pulse" }, alternate: true },
      steps: [{ foot: 0, dx: 0, dz: 0 }, null, { foot: 1, dx: 0, dz: 0 }, null],
      lift: 0.03,
    },
  },
  robot: {
    label: "Robot",
    hint: "Snapped, held, snapped again",
    style: {
      pelvis: { y: { amp: -0.01, rate: 1, wave: "pulse" } },
      chest: { twist: { amp: 0.25, rate: 0.25, wave: "snap" } },
      head: { x: { amp: 0.015, rate: 0.25, phase: 0.5, wave: "snap" } },
      // Snapped aside half a beat after the chest, then the other way: the head leads the next turn.
      look: { y: { amp: 0.6, rate: 0.25, phase: 0.5, wave: "snap" }, x: { amp: 0.15, rate: 0.5, phase: 0.25, wave: "snap" } },
      hands: { y: { amp: 0.08, rate: 0.5, wave: "snap" }, alternate: true },
    },
  },
  headbang: {
    label: "Headbang",
    hint: "Stomping, chest pumping, the head thrown down on every beat",
    style: {
      pelvis: { y: { amp: -0.03, rate: 1, wave: "pulse" }, z: { amp: -0.008, rate: 1, wave: "pulse" } },
      chest: { z: { amp: 0.03, rate: 1, phase: 0.05, wave: "pulse" }, y: { amp: -0.012, rate: 1, phase: 0.05, wave: "pulse" } },
      look: { x: { amp: 0.55, rate: 1, phase: 0.08, wave: "pulse" }, z: { amp: 0.1, rate: 0.25, phase: 0.5 } },
      hands: { y: { amp: -0.03, rate: 1, phase: 0.08, wave: "pulse" }, z: { amp: 0.02, rate: 1, phase: 0.08, wave: "pulse" }, alternate: true },
      steps: [{ foot: 0, dx: 0, dz: 0 }, null, { foot: 1, dx: 0, dz: 0 }, null],
      lift: 0.05,
    },
  },
} satisfies Record<string, { label: string; hint: string; style: GrooveStyle }>;

export type GroovePresetKey = keyof typeof GROOVE_PRESETS;
export const GROOVE_PRESET_KEYS = Object.keys(GROOVE_PRESETS) as GroovePresetKey[];

/** The beat with the off-beats pushed late: 0 straight, 1 the second eighth on the last triplet. */
export function swingBeat(beat: number, swing: number): number {
  const s = Number.isFinite(swing) ? Math.max(0, Math.min(1, swing)) : 0;
  if (s === 0) return beat;
  const whole = Math.floor(beat);
  const f = beat - whole;
  const mid = 0.5 + s / 6;
  return whole + (f < mid ? (0.5 * f) / mid : 0.5 + (0.5 * (f - mid)) / (1 - mid));
}

/** A slow wander in −1..1, phased by seed and channel (as the wiggle's). */
function drift(t: number, rate: number, seed: number, channel: number): number {
  const phase = (k: number) => {
    const x = Math.sin((seed + 1) * 12.9898 + channel * 78.233 + k * 37.719) * 43758.5453;
    return (x - Math.floor(x)) * Math.PI * 2;
  };
  const tau = Math.PI * 2 * rate * t;
  return (Math.sin(tau + phase(1)) + 0.5 * Math.sin(tau * 2.17 + phase(2))) / 1.5;
}

const SNAP = Math.tanh(5);

function wave(kind: GrooveWave | undefined, theta: number): number {
  switch (kind) {
    case "pulse": {
      const p = (1 + Math.cos(theta)) / 2;
      return p * p;
    }
    case "snap":
      return Math.tanh(5 * Math.sin(theta)) / SNAP;
    default:
      return Math.sin(theta);
  }
}

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/** Where each foot stands (offsets from rest, fractions of the height) at `beat`, and how high it is lifted. */
export function footwork(steps: readonly (FootStep | null)[] | undefined, beat: number): { offset: THREE.Vector2[]; lift: number[] } {
  const offset = [new THREE.Vector2(), new THREE.Vector2()];
  const lift = [0, 0];
  const n = steps?.length ?? 0;
  if (!steps || n === 0 || !Number.isFinite(beat)) return { offset, lift };
  // A step takes the half beat before the one it lands on.
  const u = beat + 0.5;
  const k = ((Math.floor(u) % n) + n) % n;
  const f = Math.min(1, (u - Math.floor(u)) / 0.5);
  // Where the feet stand when the cycle comes round, then the steps already taken in this one.
  for (const s of steps) if (s) offset[s.foot].set(s.dx, s.dz);
  for (let i = 0; i < k; i++) {
    const s = steps[i];
    if (s) offset[s.foot].set(s.dx, s.dz);
  }
  const step = steps[k];
  if (step) {
    offset[step.foot].lerp(new THREE.Vector2(step.dx, step.dz), smooth(f));
    lift[step.foot] = Math.sin(Math.PI * f);
  }
  return { offset, lift };
}

/**
 * The body grooving at `beat` (beats since the start, fractional) — the
 * controls in the skeleton's own space and the pelvis turn. `time` is in
 * seconds, for Groove's drift.
 */
export function grooveControls(
  rest: THREE.Vector3[],
  height: number,
  beat: number,
  time: number,
  style: GrooveStyle,
  settings: GrooveSettings = NATURAL_GROOVE,
): { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion; look: THREE.Vector3 } {
  const H = Math.max(0.05, height);
  const energy = Number.isFinite(settings.energy) ? Math.max(0, settings.energy) : 1;
  const groove = Number.isFinite(settings.groove) ? Math.max(0, settings.groove) : 0;
  const seed = Number.isFinite(settings.seed) ? settings.seed : 0;
  const b = swingBeat(Number.isFinite(beat) ? beat : 0, settings.swing);
  const t = Number.isFinite(time) ? time : 0;

  // Groove: every oscillator a little more or less, a little late or early, each its own way.
  let channel = 0;
  // `half`: half a cycle behind, for the second of two alternating hands.
  const osc = (o: GrooveOsc | undefined, half = false): number => {
    channel++;
    if (!o || !Number.isFinite(o.amp) || !Number.isFinite(o.rate) || o.rate === 0) return 0;
    const amp = o.amp * energy * (1 + 0.5 * groove * drift(t, 0.13, seed, channel));
    const late = (o.phase ?? 0) + (half ? 0.5 / o.rate : 0) + 0.06 * groove * drift(t, 0.21, seed, channel + 50);
    return amp * wave(o.wave, 2 * Math.PI * o.rate * (b - late));
  };
  const vec = (a: Axes | undefined, half = false) => new THREE.Vector3(osc(a?.x, half), osc(a?.y, half), osc(a?.z, half)).multiplyScalar(H);

  const out = rest.map((c) => c.clone());
  const upper = [CONTROL.head, ...CONTROL.hand, ...CONTROL.elbowPole];

  // Feet first: the pelvis follows them.
  const feet = footwork(style.steps, b);
  const lift = Math.max(0, style.lift ?? 0) * energy * H;
  for (const s of [0, 1] as const) {
    const f = out[CONTROL.foot[s]];
    f.x += feet.offset[s].x * H;
    f.z += feet.offset[s].y * H;
    f.y += lift * feet.lift[s];
  }
  const centre = new THREE.Vector3((feet.offset[0].x + feet.offset[1].x) / 2, 0, (feet.offset[0].y + feet.offset[1].y) / 2).multiplyScalar(H);

  const pelvis = vec(style.pelvis).add(centre);
  out[CONTROL.pelvis].add(pelvis);
  for (const i of upper) out[i].add(pelvis);
  // A knee pole stays ahead of its knee, halfway between the hip and the foot.
  for (const s of [0, 1] as const) {
    const pole = out[CONTROL.kneePole[s]];
    pole.x += 0.5 * (pelvis.x + feet.offset[s].x * H);
    pole.z += 0.5 * (pelvis.z + feet.offset[s].y * H);
  }

  const twist = osc(style.pelvis?.twist);
  const tilt = osc(style.pelvis?.tilt);
  const pelvisRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, twist, tilt, "YXZ"));

  // The shoulders: the head and arms moved together, then turned about the spine.
  const chest = vec(style.chest);
  const chestTwist = osc(style.chest?.twist);
  const spine = out[CONTROL.pelvis];
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), chestTwist);
  for (const i of upper) out[i].add(chest).sub(spine).applyQuaternion(turn).add(spine);

  out[CONTROL.head].add(vec(style.head));
  for (const s of [0, 1] as const) {
    const hand = vec(style.hands, s === 1 && !!style.hands?.alternate);
    out[CONTROL.hand[s]].add(hand);
    out[CONTROL.elbowPole[s]].add(hand.multiplyScalar(0.5));
  }

  // Groove's drift on top: the breathing, shifting body of the wiggle, feet left planted.
  const controls = groove > 0 ? wigglePose(out, H, t, { amount: groove, speed: 1, breathing: 0.5, seed }) : out;
  // The head turns last (so the other parts keep their drift), wandering a little with Groove: a dancer looks around.
  const look = new THREE.Vector3(osc(style.look?.x), osc(style.look?.y), osc(style.look?.z));
  look.x += 0.04 * groove * drift(t, 0.19, seed, 97);
  look.y += 0.15 * groove * drift(t, 0.11, seed, 98);
  look.z += 0.04 * groove * drift(t, 0.15, seed, 99);
  return { controls, pelvisRotation, look };
}
