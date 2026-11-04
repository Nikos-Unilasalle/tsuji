import { NodeDefinition } from "../types";
import { numberInput } from "./object";
import { MusicValue, clockOf, sequenceOf } from "../../music/engine/description";
import { chordNotes } from "../../music/seq/chords";
import { euclid, lcm, parseTonnetzPath, randomTonnetzPath, shiftRegister, tonnetzMove, voiceTriad, Triad } from "../../music/seq/generators";
import { hash01 } from "../../music/seq/hash";
import { parsePattern } from "../../music/seq/notation";
import { ORNAMENT_TYPES, Ornament, OrnamentType } from "../../music/seq/ornament";
import { PITCH_CLASSES, SCALE_NAMES, ScaleSpec, SnapMode, degreeNote, degreeOf, inScale, scaleSpec, snapNote, stackedChord } from "../../music/seq/scales";
import { Cell, Clock, Sequence } from "../../music/seq/sequencer";
import { TUNING_SYSTEMS, TUNING_SYSTEM_NAMES, Tuning, TuningSystem, edoSystem, parseScala } from "../../music/seq/tuning";

/**
 * Algorithmic music nodes: they make or rework sequences, on the same `music` socket as the others (music.ts), and
 * like them only describe — the sequencer plays.
 *
 *   Clock → Euclid / Shift Register / Tonnetz Walk ─┐
 *   Pattern ───────────────────────────────────────┴→ Ornament → Scale → Tuning → a voice   (Chip Echo → a 2nd voice)
 *
 * Order matters for two of them: a Scale after an Ornament turns its neighbours into the scale's; a Tuning goes last
 * but anywhere works — it rides along on the sequence and is applied as the notes are played.
 */

const DEFAULT_CLOCK: Clock = { bpm: 120, swing: 0, stepsPerBeat: 4 };
const MAX_STEPS = 16384;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pcOf = (v: unknown) => {
  const i = PITCH_CLASSES.indexOf(String(v));
  return i >= 0 ? i : 0;
};
/** A pitch class from a wire (0–11, any number wraps) or the param's name. */
const rootOf = (input: unknown, param: unknown) => (input !== undefined && Number.isFinite(Number(input)) ? (((Math.round(Number(input)) % 12) + 12) % 12) : pcOf(param));
const seqOut = (seq: Sequence): MusicValue => ({ kind: "sequence", seq });
const withSteps = (seq: Sequence, steps: (Cell | null)[]): Sequence => {
  const { bank: _bank, ...rest } = seq;
  return { ...rest, pattern: { length: steps.length, steps } };
};
const ROOT_FIELD = { id: "root", label: "Root", kind: "select" as const, options: PITCH_CLASSES };

// ── Scale ──────────────────────────────────────────────────────────────────

const CHORD_MODES = ["keep", "fit", "triads", "sevenths"];

/** The cell moved into the scale (see the Scale node's fields). */
export function scaleCell(c: Cell, s: ScaleSpec, snap: SnapMode, drop: boolean, chords: string): Cell | null {
  if (c.note === "off") return c;
  if (drop && !inScale(s, c.note)) return null;
  const q = snapNote(s, c.note, snap);
  const cell: Cell = { ...c, note: q };
  const adds = (c.add ?? []).map((n) => snapNote(s, n, snap));
  if (c.add) cell.add = adds;
  if (chords === "fit" && c.chord) {
    const tones = [...chordNotes(c.note, c.chord, c.inversion ?? 0, c.spread ?? false).slice(1), ...(c.add ?? [])].map((n) => snapNote(s, n, snap));
    cell.chord = null;
    cell.add = [...new Set(tones.filter((n) => n !== q))];
    delete cell.addVelocity;
    delete cell.inversion;
    delete cell.spread;
  } else if (chords === "triads" || chords === "sevenths") {
    const { chord, notes } = stackedChord(s, q, chords === "triads" ? 3 : 4);
    if (chord) cell.chord = chord;
    else {
      cell.chord = null;
      cell.add = [...new Set([...notes.slice(1), ...adds])];
      delete cell.addVelocity;
    }
  }
  if (c.orn) {
    const k = degreeOf(s, q);
    cell.orn = { ...c.orn, up: degreeNote(s, k + 1) - q, down: q - degreeNote(s, k - 1) };
  }
  return cell;
}

export const MUSIC_SCALE_NODE: NodeDefinition = {
  type: "music/scale",
  label: "Scale",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Sequence", type: "music" },
    { id: "root", label: "Root (0 = C … 11 = B)", type: "value" },
    { id: "scale", label: "Scale (number in the list, from 0)", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { root: "C", scale: "minor", snap: "nearest", outside: "snap", chords: "keep" },
  paramFields: [
    ROOT_FIELD,
    { id: "scale", label: "Scale (¼: maqam quarter tones)", kind: "select", options: SCALE_NAMES },
    { id: "snap", label: "Snap", kind: "select", options: ["nearest", "up", "down"], optionLabels: ["To the nearest", "Up", "Down"] },
    { id: "outside", label: "Notes Outside", kind: "select", options: ["snap", "drop"], optionLabels: ["Snap into the scale", "Drop (a rest)"] },
    {
      id: "chords",
      label: "Chords",
      kind: "select",
      options: CHORD_MODES,
      optionLabels: ["Keep as written (only the root moves)", "Fit every chord tone into the scale", "The scale's triad on each note", "The scale's seventh chord on each note"],
    },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    const idx = inputs.scale !== undefined ? Math.round(Number(inputs.scale)) : -1;
    const name = idx >= 0 && idx < SCALE_NAMES.length ? SCALE_NAMES[idx] : params.scale;
    const s = scaleSpec(name, rootOf(inputs.root, params.root));
    const snap = (["up", "down"].includes(String(params.snap)) ? params.snap : "nearest") as SnapMode;
    const drop = params.outside === "drop";
    const chords = CHORD_MODES.includes(String(params.chords)) ? String(params.chords) : "keep";
    const steps = seq.pattern.steps.map((c) => (c ? scaleCell(c, s, snap, drop, chords) : c));
    return { sequence: seqOut({ ...seq, pattern: { ...seq.pattern, steps } }) };
  },
};

// ── Tuning ─────────────────────────────────────────────────────────────────

export function tuningSystemOf(params: Record<string, unknown>): TuningSystem {
  const name = String(params.system);
  if (name === "EDO") return edoSystem(Number(params.edo) || 12);
  if (name === "custom") return parseScala(String(params.custom ?? "")) ?? TUNING_SYSTEMS["12-TET"];
  return TUNING_SYSTEMS[name] ?? TUNING_SYSTEMS["12-TET"];
}

/** The Tuning a Tuning node's params (and a wired detune) describe. */
export function tuningOf(params: Record<string, unknown>, offsetInput?: unknown): Tuning {
  const sys = tuningSystemOf(params);
  const twelve = sys.steps.length === 12 && Math.abs(sys.period - 1200) < 1e-6;
  const map = params.map === "retune" || params.map === "steps" ? params.map : twelve ? "retune" : "steps";
  return { steps: sys.steps, period: sys.period, map, root: 60 + pcOf(params.root), offset: clamp(numberInput(offsetInput, params.offset, 0), -1200, 1200) };
}

export const MUSIC_TUNING_NODE: NodeDefinition = {
  type: "music/tuning",
  label: "Tuning",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Sequence", type: "music" },
    { id: "offset", label: "Detune (cents)", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { system: "Just (5-limit)", edo: 19, custom: "9/8 5/4 4/3 3/2 5/3 15/8 2/1", map: "auto", root: "C", offset: 0 },
  paramFields: [
    { id: "system", label: "System", kind: "select", options: TUNING_SYSTEM_NAMES, optionLabels: TUNING_SYSTEM_NAMES.map((n) => (n === "EDO" ? "EDO (equal divisions of the octave)" : n === "custom" ? "Custom (cents, ratios or a pasted .scl)" : n)) },
    { id: "edo", label: "EDO — steps per octave (19, 24, 31, 53…)", kind: "number", step: 1 },
    { id: "custom", label: "Custom — 386.3 or 5/4 per step, the last the period (2/1)", kind: "text" },
    {
      id: "map",
      label: "Keys",
      kind: "select",
      options: ["auto", "retune", "steps"],
      optionLabels: ["Auto (12 a period: retune; else steps)", "Retune — each key to its pitch in the system", "Steps — each key the next step"],
    },
    { id: "root", label: "Root (keeps its usual pitch)", kind: "select", options: PITCH_CLASSES },
    { id: "offset", label: "Detune (cents)", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    return { sequence: seqOut({ ...seq, tuning: tuningOf(params, inputs.offset) }) };
  },
};

// ── Euclid ─────────────────────────────────────────────────────────────────

/** The last cell at or before step i (searched back one loop), or null. */
function heldCell(steps: readonly (Cell | null)[], i: number): Cell | null {
  const L = steps.length;
  for (let k = 0; k < L; k++) {
    const c = steps[(((i - k) % L) + L) % L];
    if (c) return c;
  }
  return null;
}

export const MUSIC_EUCLID_NODE: NodeDefinition = {
  type: "music/euclid",
  label: "Euclid",
  category: "music",
  pure: true,
  inputs: [
    { id: "input", label: "Clock, or a Sequence to restrike", type: "music" },
    { id: "pulses", label: "Pulses", type: "value" },
    { id: "steps", label: "Steps", type: "value" },
    { id: "rotation", label: "Rotation", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { pulses: 5, steps: 8, rotation: 0, notes: "C4", gate: 0, velocity: 0.8, accent: 0 },
  paramFields: [
    { id: "pulses", label: "Pulses (hits)", kind: "number", step: 1 },
    { id: "steps", label: "Steps (its own loop: 5 or 7 against a 16 is a polymeter)", kind: "number", step: 1 },
    { id: "rotation", label: "Rotation", kind: "number", step: 1 },
    { id: "notes", label: "Notes — taken in turn, one per hit (C4 Eb4 G4:min, kick snare…); a wired Sequence's notes instead", kind: "text" },
    { id: "gate", label: "Gate (steps; 0 = until the next hit)", kind: "number", step: 1 },
    { id: "velocity", label: "Velocity", kind: "number", step: 0.05 },
    { id: "accent", label: "Accent (velocity of each loop's first hit; 0 = none)", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params) => {
    const n = clamp(Math.round(numberInput(inputs.steps, params.steps, 8)), 1, 64);
    const k = clamp(Math.round(numberInput(inputs.pulses, params.pulses, 5)), 0, n);
    const hits = euclid(k, n, numberInput(inputs.rotation, params.rotation, 0));
    const gate = Math.max(0, numberInput(undefined, params.gate, 0));
    const velocity = clamp(numberInput(undefined, params.velocity, 0.8), 0, 1);
    const accent = clamp(numberInput(undefined, params.accent, 0), 0, 1);
    const shape = (c: Cell, first: boolean): Cell => {
      const { fx: _fx, length: _len, ...rest } = c;
      const cell: Cell = { ...rest };
      if (first && accent > 0) cell.velocity = accent;
      if (gate > 0) cell.length = gate;
      return cell;
    };

    // A sequence wired in: its notes, struck again on every hit.
    const src = (inputs.input as MusicValue | undefined)?.kind === "clock" ? null : sequenceOf(inputs.input);
    if (src) {
      const L = Math.max(1, src.pattern.length);
      const length = Math.min(MAX_STEPS, lcm(n, L));
      const steps = Array.from({ length }, (_, i): Cell | null => {
        if (!hits[i % n]) return null;
        const held = heldCell(src.pattern.steps.slice(0, L), i % L);
        return held && held.note !== "off" ? shape(held, i % n === hits.indexOf(true)) : null;
      });
      return { sequence: seqOut(withSteps(src, steps)) };
    }

    const notes = parsePattern(String(params.notes ?? ""), 256).filter((c): c is Cell => !!c && c.note !== "off");
    if (notes.length === 0) notes.push({ note: 60 });
    // Long enough for the notes to come round to the first hit again.
    const loops = k === 0 ? 1 : lcm(notes.length, k) / k;
    const length = Math.min(MAX_STEPS, n * loops);
    let hit = 0;
    const steps = Array.from({ length }, (_, i): Cell | null => {
      if (!hits[i % n]) return null;
      const c = notes[hit % notes.length];
      const cell = shape({ velocity, ...c }, hit % Math.max(1, k) === 0);
      hit++;
      return cell;
    });
    const seq: Sequence = { clock: clockOf(inputs.input) ?? DEFAULT_CLOCK, pattern: { length, steps } };
    return { sequence: seqOut(seq) };
  },
};

// ── Shift Register ─────────────────────────────────────────────────────────

export const MUSIC_SHIFT_REGISTER_NODE: NodeDefinition = {
  type: "music/shift-register",
  label: "Shift Register",
  category: "music",
  pure: true,
  inputs: [
    { id: "clock", label: "Clock", type: "music" },
    { id: "change", label: "Change (0 loop – 1 random)", type: "value" },
    { id: "density", label: "Density", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { bits: 8, change: 0.1, density: 0.75, length: 64, scale: "minor pentatonic", root: "A", low: 57, range: 10, gate: 0, velocity: 0.8, seed: 0 },
  paramFields: [
    { id: "bits", label: "Bits — the loop's length while nothing changes (2–16)", kind: "number", step: 1 },
    { id: "change", label: "Change — chance a bit flips (0 locked loop · 0.5 random)", kind: "number", step: 0.05 },
    { id: "density", label: "Density (share of steps that play)", kind: "number", step: 0.05 },
    { id: "length", label: "Length (steps before the whole evolution starts over)", kind: "number", step: 16 },
    { id: "scale", label: "Scale", kind: "select", options: SCALE_NAMES },
    ROOT_FIELD,
    { id: "low", label: "Lowest Note (MIDI)", kind: "number", step: 1 },
    { id: "range", label: "Range (scale degrees above it)", kind: "number", step: 1 },
    { id: "gate", label: "Gate (steps; 0 = until the next note)", kind: "number", step: 1 },
    { id: "velocity", label: "Velocity", kind: "number", step: 0.05 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const length = clamp(Math.round(Number(params.length) || 64), 1, MAX_STEPS);
    const steps = shiftRegister({
      bits: numberInput(undefined, params.bits, 8),
      change: clamp(numberInput(inputs.change, params.change, 0.1), 0, 1),
      density: clamp(numberInput(inputs.density, params.density, 0.75), 0, 1),
      length,
      scale: scaleSpec(params.scale, pcOf(params.root)),
      low: clamp(numberInput(undefined, params.low, 57), 0, 120),
      range: clamp(numberInput(undefined, params.range, 10), 1, 48),
      gate: Math.max(0, numberInput(undefined, params.gate, 0)),
      velocity: clamp(numberInput(undefined, params.velocity, 0.8), 0, 1),
      seed: Math.round(numberInput(inputs.seed, params.seed, 0)),
    });
    return { sequence: seqOut({ clock: clockOf(inputs.clock) ?? DEFAULT_CLOCK, pattern: { length, steps } }) };
  },
};

// ── Tonnetz Walk ───────────────────────────────────────────────────────────

export const MUSIC_TONNETZ_NODE: NodeDefinition = {
  type: "music/tonnetz",
  label: "Tonnetz Walk",
  category: "music",
  pure: true,
  inputs: [
    { id: "clock", label: "Clock", type: "music" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "chords", label: "Chords", type: "music" },
    { id: "bass", label: "Bass", type: "music" },
  ],
  defaultParams: { root: "C", quality: "maj", path: "R L R L P L R L", random: false, count: 8, seed: 0, chordLength: 16, center: 60, voicing: "lead", velocity: 0.7 },
  paramFields: [
    ROOT_FIELD,
    { id: "quality", label: "Starting Chord", kind: "select", options: ["maj", "min"], optionLabels: ["Major", "Minor"] },
    { id: "path", label: "Path — one move per chord: P (parallel) L (leading tone) R (relative) S N H; LP = two at once; . holds", kind: "text" },
    { id: "random", label: "Random Walk (instead of the path)", kind: "boolean" },
    { id: "count", label: "Chords (random walk)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "chordLength", label: "Chord Length (steps)", kind: "number", step: 4 },
    { id: "center", label: "Center (MIDI — the voicing stays near it)", kind: "number", step: 1 },
    { id: "voicing", label: "Voicing", kind: "select", options: ["lead", "root"], optionLabels: ["Voice leading (fewest semitones moved)", "Root position"] },
    { id: "velocity", label: "Velocity", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params) => {
    const clock = clockOf(inputs.clock) ?? DEFAULT_CLOCK;
    const seed = Math.round(numberInput(inputs.seed, params.seed, 0));
    const moves = params.random
      ? randomTonnetzPath(clamp(Math.round(Number(params.count) || 8), 1, 256) - 1, seed)
      : parseTonnetzPath(String(params.path ?? ""));
    const chordLength = clamp(Math.round(Number(params.chordLength) || 16), 1, 256);
    const center = clamp(numberInput(undefined, params.center, 60), 24, 100);
    const velocity = clamp(numberInput(undefined, params.velocity, 0.7), 0, 1);
    const lead = params.voicing !== "root";
    const total = Math.min(MAX_STEPS, (moves.length + 1) * chordLength);
    const chords: (Cell | null)[] = new Array(total).fill(null);
    const bass: (Cell | null)[] = new Array(total).fill(null);
    let t: Triad = { root: pcOf(params.root), minor: params.quality === "min" };
    let prev: number[] | null = null;
    for (let i = 0; i * chordLength < total; i++) {
      const group = i === 0 ? null : moves[i - 1];
      if (group && group.length === 0) continue; // "." holds the chord
      if (group) for (const m of group) t = tonnetzMove(t, m);
      const v = voiceTriad(t, lead ? prev : null, center);
      prev = v.notes;
      chords[i * chordLength] = { note: v.root, chord: t.minor ? "min" : "maj", ...(v.inversion ? { inversion: v.inversion } : {}), velocity };
      bass[i * chordLength] = { note: t.root + 12 * Math.floor((center - 18) / 12), velocity };
    }
    const seq = (steps: (Cell | null)[]): MusicValue => seqOut({ clock, pattern: { length: total, steps } });
    return { chords: seq(chords), bass: seq(bass) };
  },
};

// ── Ornament ───────────────────────────────────────────────────────────────

const ORNAMENT_RATES: Record<string, number> = { "1/16": 0.25, "1/24": 1 / 6, "1/32": 0.125, "1/48": 1 / 12, "1/64": 0.0625 };
const ORN_SALT = 0x4f524e;

/** How many steps the note at i lasts: its own length, or up to the next cell (across the loop). */
function stepsHeld(steps: readonly (Cell | null)[], i: number): number {
  const c = steps[i];
  if (c?.length) return c.length;
  const L = steps.length;
  for (let k = 1; k < L; k++) if (steps[(i + k) % L]) return k;
  return L;
}

export const MUSIC_ORNAMENT_NODE: NodeDefinition = {
  type: "music/ornament",
  label: "Ornament",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Sequence", type: "music" },
    { id: "chance", label: "Chance", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { type: "mordent", chance: 0.5, minSteps: 2, rate: "1/32", up: 2, down: 1, seed: 0 },
  paramFields: [
    { id: "type", label: "Ornament", kind: "select", options: [...ORNAMENT_TYPES, "mix"], optionLabels: [...ORNAMENT_TYPES.map((t) => t[0].toUpperCase() + t.slice(1)), "Mix (a different one each time)"] },
    { id: "chance", label: "Chance (per note, seeded)", kind: "number", step: 0.05 },
    { id: "minSteps", label: "Only Notes Lasting (steps or more)", kind: "number", step: 1 },
    { id: "rate", label: "Ornament Note", kind: "select", options: Object.keys(ORNAMENT_RATES) },
    { id: "up", label: "Upper Neighbour (semitones — a Scale after makes it the scale's)", kind: "number", step: 1 },
    { id: "down", label: "Lower Neighbour (semitones)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    const chance = clamp(numberInput(inputs.chance, params.chance, 0.5), 0, 1);
    const minSteps = Math.max(0, numberInput(undefined, params.minSteps, 2));
    const beats = ORNAMENT_RATES[String(params.rate)] ?? 0.125;
    const up = clamp(numberInput(undefined, params.up, 2), 0, 12);
    const down = clamp(numberInput(undefined, params.down, 1), 0, 12);
    const seed = Math.round(Number(params.seed) || 0);
    const mix = params.type === "mix";
    const fixed = (ORNAMENT_TYPES as readonly string[]).includes(String(params.type)) ? (params.type as OrnamentType) : "mordent";
    const src = seq.pattern.steps;
    const steps = src.map((c, i): Cell | null => {
      if (!c || c.note === "off" || c.orn || c.fx?.type === "RTG") return c;
      if (stepsHeld(src, i) < minSteps || hash01(i, seed, ORN_SALT) >= chance) return c;
      const type = mix ? ORNAMENT_TYPES[Math.floor(hash01(i, seed, ORN_SALT + 1) * ORNAMENT_TYPES.length)] : fixed;
      const orn: Ornament = { type, up, down, beats };
      return { ...c, orn };
    });
    return { sequence: seqOut({ ...seq, pattern: { ...seq.pattern, steps } }) };
  },
};

// ── Chip Echo ──────────────────────────────────────────────────────────────

export const MUSIC_CHIP_ECHO_NODE: NodeDefinition = {
  type: "music/chip-echo",
  label: "Chip Echo",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Sequence", type: "music" },
    { id: "delay", label: "Delay (steps)", type: "value" },
    { id: "level", label: "Level", type: "value" },
  ],
  outputs: [{ id: "echo", label: "Echo (wire it to a second voice)", type: "music" }],
  defaultParams: { delay: 3, level: 0.45, transpose: 0, detune: 8 },
  paramFields: [
    { id: "delay", label: "Delay (steps)", kind: "number", step: 1 },
    { id: "level", label: "Level (× velocity)", kind: "number", step: 0.05 },
    { id: "transpose", label: "Transpose (semitones)", kind: "number", step: 12 },
    { id: "detune", label: "Detune (cents — a few make the two channels beat)", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { echo: null };
    const L = Math.max(1, seq.pattern.length);
    const d = ((Math.round(numberInput(inputs.delay, params.delay, 3)) % L) + L) % L;
    const level = clamp(numberInput(inputs.level, params.level, 0.45), 0, 1);
    const shift = numberInput(undefined, params.transpose, 0) + clamp(numberInput(undefined, params.detune, 0), -100, 100) / 100;
    const move = (n: number) => clamp(n + shift, 0, 127);
    const src = seq.pattern.steps;
    const steps = Array.from({ length: L }, (_, i): Cell | null => {
      const c = src[(i - d + L) % L] ?? null;
      if (!c || c.note === "off") return c;
      const cell: Cell = { ...c, note: move(c.note), velocity: (c.velocity ?? 0.8) * level };
      if (c.add) cell.add = c.add.map(move);
      if (c.addVelocity) cell.addVelocity = c.addVelocity.map((v) => v * level);
      return cell;
    });
    return { echo: seqOut(withSteps(seq, steps)) };
  },
};

export const MUSIC_ALGO_NODES = [MUSIC_EUCLID_NODE, MUSIC_SHIFT_REGISTER_NODE, MUSIC_TONNETZ_NODE, MUSIC_ORNAMENT_NODE, MUSIC_SCALE_NODE, MUSIC_TUNING_NODE, MUSIC_CHIP_ECHO_NODE];
/** The ones that take a sequence and pass it on reworked: the Pattern HUD follows the wires through them to the voice. */
export const MUSIC_SEQUENCE_PASS_TYPES = ["music/arp", "music/scale", "music/tuning", "music/ornament", "music/euclid"];
