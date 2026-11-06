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
import { MOTIF_OPS, MotifOp, contourMelody, eventsOf, markov, parseProgression, randomProgression, transformMotif, voiceLead } from "../../music/seq/compose";
import { counterpoint } from "../../music/seq/counterpoint";
import { FitMode, PassingNotes, chordTimeline, fitToChords } from "../../music/seq/chordFit";
import { bestRoot } from "../../music/seq/justIntonation";
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

// ── Fit to Chords ──────────────────────────────────────────────────────────

const FIT_MODES: FitMode[] = ["strong", "tones", "scale"];
const PASSING: PassingNotes[] = ["pentatonic", "modes", "chromatic"];

/**
 * A Scale that follows the harmony: each note of a melody moved onto the chord sounding under it (Tonnetz Walk,
 * Progression, Voice Leading…). The two are lined up by beats; the melody can be looped along the whole chord grid so
 * each pass meets its own chords.
 */
export const MUSIC_FIT_CHORDS_NODE: NodeDefinition = {
  type: "music/fit-chords",
  label: "Fit to Chords",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Melody", type: "music" },
    { id: "chords", label: "Chords", type: "music" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { mode: "strong", passing: "pentatonic", snap: "nearest", strongEvery: 4, length: "chords", tieRepeats: false },
  paramFields: [
    {
      id: "mode",
      label: "Fit",
      kind: "select",
      options: FIT_MODES,
      optionLabels: ["Strong steps on chord tones, the others in the chord's scale", "Every note on a chord tone", "Every note in the chord's scale"],
    },
    {
      id: "passing",
      label: "Chord's Scale (passing notes)",
      kind: "select",
      options: PASSING,
      optionLabels: ["Its pentatonic (no clash)", "Its mode (maj → ionian, min → dorian, 7 → mixolydian…)", "Chromatic (any note)"],
    },
    { id: "snap", label: "Snap", kind: "select", options: ["nearest", "up", "down"], optionLabels: ["To the nearest", "Up", "Down"] },
    { id: "strongEvery", label: "Strong Every (melody steps; 0 = only the first note under each chord)", kind: "number", step: 1 },
    {
      id: "length",
      label: "Length",
      kind: "select",
      options: ["chords", "melody", "lcm"],
      optionLabels: ["The chord grid's (the melody loops along it)", "The melody's", "Both, until they meet again"],
    },
    { id: "tieRepeats", label: "Tie Repeats (a note the same as the last one holds it)", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    const grid = sequenceOf(inputs.chords);
    if (!grid || grid.pattern.length === 0) return { sequence: seqOut(seq) };
    const passing = PASSING.includes(params.passing as PassingNotes) ? (params.passing as PassingNotes) : "pentatonic";
    const timeline = chordTimeline(grid.pattern.steps.slice(0, grid.pattern.length), passing);
    const Lm = Math.max(1, seq.pattern.length);
    const Lc = grid.pattern.length;
    // The grid's steps per melody step (both in beats), and the grid's length in melody steps.
    const ratio = grid.clock.stepsPerBeat / Math.max(1e-9, seq.clock.stepsPerBeat);
    const gridLen = Math.max(1, Math.round(Lc / ratio));
    const length = Math.min(MAX_STEPS, params.length === "melody" ? Lm : params.length === "lcm" ? lcm(Lm, gridLen) : gridLen);
    const melody = Array.from({ length }, (_, i) => seq.pattern.steps[i % Lm] ?? null);
    const steps = fitToChords(melody, (i) => timeline[Math.floor(i * ratio + 1e-9) % Lc], {
      mode: FIT_MODES.includes(params.mode as FitMode) ? (params.mode as FitMode) : "strong",
      passing,
      snap: (["nearest", "up", "down"] as const).includes(params.snap as SnapMode) ? (params.snap as SnapMode) : "nearest",
      strongEvery: clamp(Math.round(numberInput(undefined, params.strongEvery, 4)), 0, 256),
      tieRepeats: Boolean(params.tieRepeats),
    });
    return { sequence: seqOut(withSteps(seq, steps)) };
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

// ── Progression ────────────────────────────────────────────────────────────

/** The MIDI note of a pitch class near a center: in [center − 6, center + 6). */
const near = (pc: number, center: number) => pc + 12 * Math.ceil((center - 6 - pc) / 12);

export const MUSIC_PROGRESSION_NODE: NodeDefinition = {
  type: "music/progression",
  label: "Progression",
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
  defaultParams: { root: "C", mode: "major", source: "written", numerals: "I vi ii7 V7", count: 8, sevenths: false, tension: 0.3, cadence: true, seed: 0, chordLength: 16, center: 60, velocity: 0.7 },
  paramFields: [
    ROOT_FIELD,
    { id: "mode", label: "Key", kind: "select", options: ["major", "minor"], optionLabels: ["Major", "Minor"] },
    { id: "source", label: "Chords", kind: "select", options: ["written", "random"], optionLabels: ["As written (numerals)", "Random walk (functional harmony)"] },
    { id: "numerals", label: "Numerals — I vi ii7 V7 · IVmaj7 iiø7 V7/V bVII i° · :2 doubles a chord's length", kind: "text" },
    { id: "count", label: "Chords (random walk)", kind: "number", step: 1 },
    { id: "sevenths", label: "Sevenths (random walk)", kind: "boolean" },
    { id: "tension", label: "Tension (random walk: 0 the usual paths · 1 anything goes)", kind: "number", step: 0.05 },
    { id: "cadence", label: "End V → I (random walk)", kind: "boolean" },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "chordLength", label: "Chord Length (steps)", kind: "number", step: 4 },
    { id: "center", label: "Center (MIDI — chord roots near it; a Voice Leading after voices them)", kind: "number", step: 1 },
    { id: "velocity", label: "Velocity", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params) => {
    const clock = clockOf(inputs.clock) ?? DEFAULT_CLOCK;
    const minor = params.mode === "minor";
    const key = pcOf(params.root);
    const chords =
      params.source === "random"
        ? randomProgression(clamp(Math.round(Number(params.count) || 8), 1, 256), minor, Boolean(params.sevenths), clamp(numberInput(undefined, params.tension, 0.3), 0, 1), Boolean(params.cadence), Math.round(numberInput(inputs.seed, params.seed, 0)))
        : parseProgression(String(params.numerals ?? ""), minor);
    const chordLength = clamp(Math.round(Number(params.chordLength) || 16), 1, 256);
    const center = clamp(numberInput(undefined, params.center, 60), 24, 100);
    const velocity = clamp(numberInput(undefined, params.velocity, 0.7), 0, 1);
    const total = clamp(chords.reduce((a, c) => a + Math.max(1, Math.round(c.beats * chordLength)), 0), 1, MAX_STEPS);
    const top: (Cell | null)[] = new Array(total).fill(null);
    const bass: (Cell | null)[] = new Array(total).fill(null);
    let t = 0;
    for (const c of chords) {
      if (t >= total) break;
      const root = near((key + c.root) % 12, center);
      top[t] = { note: root, chord: c.chord, velocity };
      bass[t] = { note: near((key + c.root) % 12, center - 18), velocity };
      t += Math.max(1, Math.round(c.beats * chordLength));
    }
    const seq = (steps: (Cell | null)[]): MusicValue => seqOut({ clock, pattern: { length: total, steps } });
    return { chords: seq(top), bass: seq(bass) };
  },
};

// ── Voice Leading ──────────────────────────────────────────────────────────

export const MUSIC_VOICE_LEADING_NODE: NodeDefinition = {
  type: "music/voice-leading",
  label: "Voice Leading",
  category: "music",
  pure: true,
  inputs: [{ id: "sequence", label: "Chords", type: "music" }],
  outputs: [
    { id: "sequence", label: "Voiced", type: "music" },
    { id: "bass", label: "Bass (the roots)", type: "music" },
  ],
  defaultParams: { voices: 4, low: 52, high: 76 },
  paramFields: [
    { id: "voices", label: "Voices (notes a chord; 0 = as many as it has)", kind: "number", step: 1 },
    { id: "low", label: "Lowest Note (MIDI)", kind: "number", step: 1 },
    { id: "high", label: "Highest Note (MIDI)", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null, bass: null };
    const { voiced, bass } = voiceLead(seq.pattern.steps, {
      voices: clamp(Math.round(numberInput(undefined, params.voices, 4)), 0, 6),
      low: clamp(numberInput(undefined, params.low, 52), 12, 108),
      high: clamp(numberInput(undefined, params.high, 76), 24, 120),
    });
    // The voiced chords keep the source's arp (it walks the voicing); the bass is plain roots.
    return {
      sequence: seqOut({ ...seq, pattern: { ...seq.pattern, steps: voiced } }),
      bass: seqOut({ ...seq, arp: null, pattern: { ...seq.pattern, steps: bass } }),
    };
  },
};

// ── Motif ──────────────────────────────────────────────────────────────────

export const MUSIC_MOTIF_NODE: NodeDefinition = {
  type: "music/motif",
  label: "Motif Transform",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Motif", type: "music" },
    { id: "interval", label: "Interval", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { op: "retrograde", output: "both", axis: -1, repeats: 3, interval: 2, amount: 2, inScale: false, scale: "major", root: "C" },
  paramFields: [
    {
      id: "op",
      label: "Transform",
      kind: "select",
      options: [...MOTIF_OPS],
      optionLabels: ["Retrograde (backwards)", "Inversion (upside down)", "Retrograde inversion", "Augmentation (slower)", "Diminution (faster)", "Sequence (repeated, moved each time)", "Rotation (steps later)"],
    },
    { id: "output", label: "Output", kind: "select", options: ["both", "transformed"], optionLabels: ["The motif, then the transform", "The transform alone"] },
    { id: "axis", label: "Inversion Axis (MIDI; −1 = the first note)", kind: "number", step: 1 },
    { id: "repeats", label: "Sequence: Copies", kind: "number", step: 1 },
    { id: "interval", label: "Sequence: Interval (semitones, or degrees in the scale)", kind: "number", step: 1 },
    { id: "amount", label: "Augmentation / Diminution ×, Rotation steps", kind: "number", step: 1 },
    { id: "inScale", label: "In a Scale (inversion and sequence move by its degrees)", kind: "boolean" },
    { id: "scale", label: "Scale", kind: "select", options: SCALE_NAMES },
    ROOT_FIELD,
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    const L = Math.max(1, seq.pattern.length);
    const op = (MOTIF_OPS as readonly string[]).includes(String(params.op)) ? (params.op as MotifOp) : "retrograde";
    const axis = numberInput(undefined, params.axis, -1);
    const out = transformMotif(seq.pattern.steps, L, {
      op,
      axis: axis >= 0 ? axis : NaN,
      repeats: numberInput(undefined, params.repeats, 3),
      interval: numberInput(inputs.interval, params.interval, 2),
      amount: numberInput(undefined, params.amount, 2),
      scale: params.inScale ? scaleSpec(params.scale, pcOf(params.root)) : null,
    });
    const steps = params.output === "transformed" ? out : [...seq.pattern.steps.slice(0, L), ...out].slice(0, MAX_STEPS);
    return { sequence: seqOut(withSteps(seq, steps)) };
  },
};

// ── Markov ─────────────────────────────────────────────────────────────────

export const MUSIC_MARKOV_NODE: NodeDefinition = {
  type: "music/markov",
  label: "Markov",
  category: "music",
  pure: true,
  inputs: [
    { id: "source", label: "Learn From", type: "music" },
    { id: "source2", label: "Learn From (2)", type: "music" },
    { id: "novelty", label: "Novelty", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { order: 2, length: 64, learn: "both", novelty: 0.1, seed: 0 },
  paramFields: [
    { id: "order", label: "Memory (1–4 notes back: higher sounds closer to the source)", kind: "number", step: 1 },
    { id: "length", label: "Length (steps)", kind: "number", step: 16 },
    { id: "learn", label: "Learn", kind: "select", options: ["both", "pitch"], optionLabels: ["Notes and rhythm", "Notes only (the source's rhythm kept)"] },
    { id: "novelty", label: "Novelty (0 faithful – 1 forgetful)", kind: "number", step: 0.05 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const a = sequenceOf(inputs.source);
    const b = sequenceOf(inputs.source2);
    const base = a ?? b;
    if (!base) return { sequence: null };
    const sources = [a, b].filter((x): x is Sequence => !!x).map((x) => eventsOf(x.pattern.steps, x.pattern.length));
    const length = clamp(Math.round(Number(params.length) || 64), 1, MAX_STEPS);
    const steps = markov(sources, {
      order: numberInput(undefined, params.order, 2),
      length,
      learn: params.learn === "pitch" ? "pitch" : "both",
      novelty: clamp(numberInput(inputs.novelty, params.novelty, 0.1), 0, 1),
      seed: Math.round(numberInput(inputs.seed, params.seed, 0)),
    });
    return { sequence: seqOut(withSteps(base, steps)) };
  },
};

// ── Contour → Melody ───────────────────────────────────────────────────────

const AXES = ["x", "y", "z"] as const;
/** Numbers from a curve (sampled along it), or a list of numbers or points (one axis of each). */
export function contourValues(curve: unknown, list: unknown, axis: (typeof AXES)[number]): number[] {
  const pick = (p: unknown) => (typeof p === "number" ? p : p && typeof p === "object" ? Number((p as Record<string, unknown>)[axis]) : NaN);
  const sampler = curve as { getSpacedPoints?: (n: number) => unknown[] } | null;
  if (sampler && typeof sampler.getSpacedPoints === "function") return sampler.getSpacedPoints(127).map(pick).filter(Number.isFinite);
  if (Array.isArray(list)) return list.map(pick).filter(Number.isFinite);
  return [];
}

export const MUSIC_CONTOUR_NODE: NodeDefinition = {
  type: "music/contour",
  label: "Contour → Melody",
  category: "music",
  pure: true,
  inputs: [
    { id: "clock", label: "Clock", type: "music" },
    { id: "curve", label: "Curve", type: "curve" },
    { id: "values", label: "Values or Points", type: "list" },
    { id: "velocities", label: "Velocities (0–1)", type: "list" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { axis: "y", steps: 16, scale: "major pentatonic", root: "C", low: 60, range: 10, rhythm: "change", invert: false, velocity: 0.8, gate: 0 },
  paramFields: [
    { id: "axis", label: "Axis (of a curve or points)", kind: "select", options: [...AXES] },
    { id: "steps", label: "Steps (the contour resampled to)", kind: "number", step: 4 },
    { id: "scale", label: "Scale", kind: "select", options: SCALE_NAMES },
    ROOT_FIELD,
    { id: "low", label: "Lowest Note (MIDI — the lowest value)", kind: "number", step: 1 },
    { id: "range", label: "Range (scale degrees up to the highest value)", kind: "number", step: 1 },
    { id: "rhythm", label: "Rhythm", kind: "select", options: ["change", "every"], optionLabels: ["A note when the pitch changes", "A note every step"] },
    { id: "invert", label: "Upside Down", kind: "boolean" },
    { id: "velocity", label: "Velocity (when no list is wired)", kind: "number", step: 0.05 },
    { id: "gate", label: "Gate (steps; 0 = until the next note)", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const axis = (AXES as readonly string[]).includes(String(params.axis)) ? (params.axis as (typeof AXES)[number]) : "y";
    const values = contourValues(inputs.curve, inputs.values, axis);
    const velocities = Array.isArray(inputs.velocities) ? (inputs.velocities as unknown[]).map(Number).filter(Number.isFinite) : undefined;
    const length = clamp(Math.round(Number(params.steps) || 16), 1, MAX_STEPS);
    const gate = Math.max(0, numberInput(undefined, params.gate, 0));
    const steps = contourMelody(
      values,
      {
        steps: length,
        scale: scaleSpec(params.scale, pcOf(params.root)),
        low: clamp(numberInput(undefined, params.low, 60), 0, 120),
        range: clamp(numberInput(undefined, params.range, 10), 0, 48),
        rhythm: params.rhythm === "every" ? "every" : "change",
        invert: Boolean(params.invert),
        velocity: clamp(numberInput(undefined, params.velocity, 0.8), 0, 1),
      },
      velocities,
    ).map((c) => (c && gate > 0 ? { ...c, length: gate } : c));
    return { sequence: seqOut({ clock: clockOf(inputs.clock) ?? DEFAULT_CLOCK, pattern: { length, steps } }) };
  },
};

// ── Phase ──────────────────────────────────────────────────────────────────

/**
 * Steve Reich's phasing: the same line twice, one copy slipping against the other. "steps" (Piano Phase): the copy is
 * a step further on every few loops, until it comes round; "tempo" (It's Gonna Rain): the copy runs a little faster,
 * and drifts continuously.
 */
export const MUSIC_PHASE_NODE: NodeDefinition = {
  type: "music/phase",
  label: "Phase",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Sequence", type: "music" },
    { id: "drift", label: "Drift (%)", type: "value" },
  ],
  outputs: [
    { id: "a", label: "A (as it is)", type: "music" },
    { id: "b", label: "B (phasing)", type: "music" },
  ],
  defaultParams: { mode: "steps", loops: 4, direction: "ahead", drift: 1 },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["steps", "tempo"], optionLabels: ["Step by step (Piano Phase)", "Tempo drift (It's Gonna Rain)"] },
    { id: "loops", label: "Loops Before Each Step", kind: "number", step: 1 },
    { id: "direction", label: "Direction", kind: "select", options: ["ahead", "behind"], optionLabels: ["B gets ahead", "B falls behind"] },
    { id: "drift", label: "Tempo Drift (% faster)", kind: "number", step: 0.25 },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { a: null, b: null };
    const a = seqOut(seq);
    if (params.mode === "tempo") {
      const drift = clamp(numberInput(inputs.drift, params.drift, 1), -50, 50);
      return { a, b: seqOut({ ...seq, clock: { ...seq.clock, bpm: seq.clock.bpm * (1 + drift / 100) } }) };
    }
    const L = Math.max(1, seq.pattern.length);
    const loops = clamp(Math.round(numberInput(undefined, params.loops, 4)), 1, 64);
    const dir = params.direction === "behind" ? -1 : 1;
    // The whole process: every shift from 0 to L − 1, `loops` times each (as much of it as fits).
    const shifts = Math.max(1, Math.min(L, Math.floor(MAX_STEPS / (L * loops))));
    const steps: (Cell | null)[] = [];
    for (let k = 0; k < shifts * loops; k++) {
      const shift = Math.floor(k / loops) * dir;
      for (let i = 0; i < L; i++) steps.push(seq.pattern.steps[(((i + shift) % L) + L) % L] ?? null);
    }
    return { a, b: seqOut(withSteps(seq, steps)) };
  },
};

// ── Counterpoint ───────────────────────────────────────────────────────────

export const MUSIC_COUNTERPOINT_NODE: NodeDefinition = {
  type: "music/counterpoint",
  label: "Counterpoint",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Cantus Firmus", type: "music" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Counter-voice", type: "music" }],
  defaultParams: { species: "1", position: "above", scale: "major", root: "C", low: 60, high: 79, velocity: 0.75, seed: 0 },
  paramFields: [
    { id: "species", label: "Species", kind: "select", options: ["1", "2"], optionLabels: ["First — note against note", "Second — two notes against one (passing notes)"] },
    { id: "position", label: "Voice", kind: "select", options: ["above", "below"], optionLabels: ["Above the cantus", "Below the cantus"] },
    { id: "scale", label: "Scale", kind: "select", options: SCALE_NAMES },
    ROOT_FIELD,
    { id: "low", label: "Lowest Note (MIDI)", kind: "number", step: 1 },
    { id: "high", label: "Highest Note (MIDI)", kind: "number", step: 1 },
    { id: "velocity", label: "Velocity", kind: "number", step: 0.05 },
    { id: "seed", label: "Seed (another line, as correct)", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    const L = Math.max(1, seq.pattern.length);
    const steps = counterpoint(eventsOf(seq.pattern.steps, L), L, {
      species: params.species === "2" ? 2 : 1,
      above: params.position !== "below",
      scale: scaleSpec(params.scale, pcOf(params.root)),
      low: clamp(numberInput(undefined, params.low, 60), 0, 127),
      high: clamp(numberInput(undefined, params.high, 79), 0, 127),
      velocity: clamp(numberInput(undefined, params.velocity, 0.75), 0, 1),
      seed: Math.round(numberInput(inputs.seed, params.seed, 0)),
    });
    return { sequence: seqOut({ ...withSteps(seq, steps), arp: null }) };
  },
};

// ── Adaptive JI ────────────────────────────────────────────────────────────

export const MUSIC_ADAPTIVE_JI_NODE: NodeDefinition = {
  type: "music/adaptive-ji",
  label: "Adaptive Just Intonation",
  category: "music",
  pure: true,
  inputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { limit: "5", center: true, root: "auto" },
  paramFields: [
    { id: "limit", label: "Ratios", kind: "select", options: ["5", "7"], optionLabels: ["5-limit (pure 3rds and 5ths)", "7-limit (the harmonic 7th too: barbershop)"] },
    { id: "center", label: "Centred (each chord stays where 12-TET has it: no drift)", kind: "boolean" },
    { id: "root", label: "Root", kind: "select", options: ["auto", "written"], optionLabels: ["Found in each chord (its simplest ratios)", "As written (the cell's note)"] },
    { id: "help", label: "Retunes chords (cells of two notes or more) while they sound. Instead of a Tuning node, not after one.", kind: "note" },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    const limit = params.limit === "7" ? 7 : 5;
    const center = params.center !== false;
    const steps = seq.pattern.steps.map((c): Cell | null => {
      if (!c || c.note === "off") return c;
      const tones = [...chordNotes(c.note, c.chord, 0, false), ...(c.add ?? [])];
      if (tones.length < 2) return c;
      const root = params.root === "written" ? ((Math.round(c.note) % 12) + 12) % 12 : bestRoot(tones.map((n) => ((Math.round(n) % 12) + 12) % 12));
      return { ...c, ji: { root, limit, center } };
    });
    return { sequence: seqOut({ ...seq, pattern: { ...seq.pattern, steps } }) };
  },
};

// ── Sections ───────────────────────────────────────────────────────────────

/** A bar mask (x plays, . rests, x*4 / .*8 for runs) → one boolean per bar. */
export function parseBars(text: string): boolean[] {
  const bars: boolean[] = [];
  for (const w of String(text ?? "").split(/\s+/)) {
    const m = /^([xX1.\-0_])(?:\*(\d+))?$/.exec(w);
    if (!m) continue;
    const on = /[xX1]/.test(m[1]);
    for (let k = Math.min(4096, m[2] === undefined ? 1 : Number(m[2])); k > 0; k--) bars.push(on);
  }
  return bars;
}

/** The inverse of parseBars: runs written x*N / .*N. */
export function formatBars(bars: readonly boolean[]): string {
  const out: string[] = [];
  for (let i = 0; i < bars.length; ) {
    let j = i;
    while (j < bars.length && bars[j] === bars[i]) j++;
    out.push((bars[i] ? "x" : ".") + (j - i > 1 ? `*${j - i}` : ""));
    i = j;
  }
  return out.join(" ");
}

/**
 * A sequence brought in and out by the bar, so a looping generator can have a form: it plays in the bars marked x and
 * rests in the others, over a song as long as the mask. With Restart, each entry starts it from its first step.
 */
export const MUSIC_SECTIONS_NODE: NodeDefinition = {
  type: "music/sections",
  label: "Sections",
  category: "music",
  pure: true,
  inputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { bars: "x*4 .*4", barLength: 16, restart: true },
  paramFields: [
    { id: "bars", label: "Bars — one per bar: x plays, . rests (x*8 .*4 for runs); the song is this long", kind: "text" },
    { id: "barLength", label: "Bar Length (steps)", kind: "number", step: 4 },
    { id: "restart", label: "Restart at Each Entry (off: it loops on underneath)", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    const bars = parseBars(String(params.bars ?? ""));
    if (bars.length === 0) return { sequence: seqOut(seq) };
    const bl = clamp(Math.round(Number(params.barLength) || 16), 1, 256);
    const restart = params.restart !== false;
    const L = Math.max(1, seq.pattern.length);
    const total = Math.min(MAX_STEPS, bars.length * bl);
    const steps: (Cell | null)[] = new Array(total).fill(null);
    let entry = 0;
    for (let i = 0; i < total; i++) {
      const bar = Math.floor(i / bl);
      if (!bars[bar]) {
        // Leaving: whatever was still sounding stops at the section's end.
        if (i % bl === 0 && bar > 0 && bars[bar - 1]) steps[i] = { note: "off" };
        continue;
      }
      if (i % bl === 0 && (bar === 0 || !bars[bar - 1])) entry = i;
      steps[i] = seq.pattern.steps[(restart ? i - entry : i) % L] ?? null;
    }
    return { sequence: seqOut(withSteps(seq, steps)) };
  },
};

export const MUSIC_ALGO_NODES = [
  MUSIC_EUCLID_NODE,
  MUSIC_SHIFT_REGISTER_NODE,
  MUSIC_CONTOUR_NODE,
  MUSIC_MARKOV_NODE,
  MUSIC_TONNETZ_NODE,
  MUSIC_PROGRESSION_NODE,
  MUSIC_VOICE_LEADING_NODE,
  MUSIC_MOTIF_NODE,
  MUSIC_COUNTERPOINT_NODE,
  MUSIC_PHASE_NODE,
  MUSIC_ORNAMENT_NODE,
  MUSIC_SCALE_NODE,
  MUSIC_FIT_CHORDS_NODE,
  MUSIC_TUNING_NODE,
  MUSIC_ADAPTIVE_JI_NODE,
  MUSIC_CHIP_ECHO_NODE,
  MUSIC_SECTIONS_NODE,
];
/** The ones that take a sequence and pass it on reworked: the Pattern HUD follows the wires through them to the voice. */
export const MUSIC_SEQUENCE_PASS_TYPES = ["music/arp", "music/scale", "music/fit-chords", "music/tuning", "music/ornament", "music/euclid", "music/voice-leading", "music/motif", "music/markov", "music/phase", "music/adaptive-ji", "music/sections"];
