import { describe, expect, it } from "vitest";
import { NodeDefinition, EvalContext } from "../types";
import {
  MUSIC_CHIP_ECHO_NODE,
  MUSIC_EUCLID_NODE,
  MUSIC_ORNAMENT_NODE,
  MUSIC_SCALE_NODE,
  MUSIC_SHIFT_REGISTER_NODE,
  MUSIC_TONNETZ_NODE,
  MUSIC_TUNING_NODE,
} from "./musicAlgo";
import { MUSIC_PATTERN_NODE } from "./music";
import { euclid, tonnetzMove, voiceTriad } from "../../music/seq/generators";
import { SCALES, scaleSpec, snapNote, stackedChord } from "../../music/seq/scales";
import { TUNING_SYSTEMS, parseScala, tunedPitch } from "../../music/seq/tuning";
import { ornamentParts } from "../../music/seq/ornament";
import { Sequence, notesStartingIn } from "../../music/seq/sequencer";

const ctx: EvalContext = { time: 0, step: 0, nodeId: "n1", fps: 30 };
function run(def: NodeDefinition, inputs: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return def.evaluate!(inputs, { ...def.defaultParams, ...params }, ctx) as Record<string, any>;
}
const pattern = (steps: string, length = 16) => run(MUSIC_PATTERN_NODE, {}, { steps, length: String(length) }).sequence;
const SR = 48_000;
/** Every note of the first loop (120 BPM, 16ths: a step is 6000 samples). */
const notesOf = (seq: Sequence) => notesStartingIn(seq, SR, 0, seq.pattern.length * 6000);

describe("scales", () => {
  const cMinor = scaleSpec("minor", 0);
  it("snaps to the nearest tone, ties down, or up / down", () => {
    expect(snapNote(cMinor, 64)).toBe(63); // E → E♭
    expect(snapNote(cMinor, 66)).toBe(65); // F♯, between F and G: down
    expect(snapNote(cMinor, 66, "up")).toBe(67);
    expect(snapNote(cMinor, 71)).toBe(70); // B, between B♭ and C: down
    expect(snapNote(cMinor, 71.5)).toBe(72);
    expect(snapNote(scaleSpec("minor", 9), 61)).toBe(60); // A minor: C♯ → C
  });
  it("stacks the scale's own chords", () => {
    const cMajor = scaleSpec("major", 0);
    expect(stackedChord(cMajor, 62, 3).chord).toBe("min"); // ii
    expect(stackedChord(cMajor, 67, 4).chord).toBe("7"); // V7
    expect(stackedChord(cMajor, 71, 3).chord).toBe("dim"); // vii°
    // Not in the chord table: given as notes.
    const rast = stackedChord(scaleSpec("maqam rast ¼", 0), 60, 3);
    expect(rast.chord).toBeNull();
    expect(rast.notes).toEqual([60, 63.5, 67]);
  });
  it("every scale starts on 0 and rises within the octave", () => {
    for (const s of Object.values(SCALES)) {
      expect(s[0]).toBe(0);
      for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
      expect(s[s.length - 1]).toBeLessThan(12);
    }
  });
});

describe("Scale node", () => {
  it("moves notes and adds into the scale, keeps rests and offs", () => {
    const seq = run(MUSIC_SCALE_NODE, { sequence: pattern("E4 . off F#4+B4") }, { root: "C", scale: "minor" }).sequence.seq;
    expect(seq.pattern.steps.slice(0, 4)).toEqual([{ note: 63 }, null, { note: "off" }, { note: 65, add: [70] }]);
  });
  it("drops what is outside", () => {
    const seq = run(MUSIC_SCALE_NODE, { sequence: pattern("C4 E4") }, { scale: "minor", outside: "drop" }).sequence.seq;
    expect(seq.pattern.steps.slice(0, 2)).toEqual([{ note: 60 }, null]);
  });
  it("harmonizes with the scale's triads", () => {
    const seq = run(MUSIC_SCALE_NODE, { sequence: pattern("C4 D4 E4") }, { scale: "major", chords: "triads" }).sequence.seq;
    expect(seq.pattern.steps.slice(0, 3).map((c: any) => c.chord)).toEqual(["maj", "min", "min"]);
  });
  it("fits a written chord's tones into the scale", () => {
    const seq = run(MUSIC_SCALE_NODE, { sequence: pattern("C4:maj") }, { scale: "minor", chords: "fit" }).sequence.seq;
    expect(seq.pattern.steps[0]).toMatchObject({ note: 60, chord: null, add: [63, 67] });
  });
  it("takes a wired scale number and root", () => {
    const seq = run(MUSIC_SCALE_NODE, { sequence: pattern("F4 C4"), root: 2, scale: 0 }, { snap: "up" }).sequence.seq;
    expect(seq.pattern.steps.slice(0, 2).map((c: any) => c.note)).toEqual([66, 61]); // D major: F → F♯, C → C♯
  });
  it("makes an ornament's neighbours the scale's", () => {
    const orn = run(MUSIC_ORNAMENT_NODE, { sequence: pattern("E4 . . .") }, { type: "trill", chance: 1, minSteps: 0, up: 1 }).sequence;
    const seq = run(MUSIC_SCALE_NODE, { sequence: orn }, { scale: "major" }).sequence.seq;
    expect(seq.pattern.steps[0].orn).toMatchObject({ up: 1, down: 2 }); // E: up to F, down to D
  });
});

describe("tuning", () => {
  it("leaves 12-TET as it is", () => {
    const t = { ...TUNING_SYSTEMS["12-TET"], map: "retune" as const, root: 60 };
    for (const n of [0, 59, 60, 61.5, 69, 127]) expect(tunedPitch(t, n)).toBeCloseTo(n, 9);
  });
  it("retunes the twelve keys to just intonation, around the root", () => {
    const t = { ...TUNING_SYSTEMS["Just (5-limit)"], map: "retune" as const, root: 60 };
    expect(tunedPitch(t, 60)).toBe(60);
    expect(tunedPitch(t, 64)).toBeCloseTo(60 + 3.8631, 3); // a pure major third, 13.7 cents flat
    expect(tunedPitch(t, 55)).toBeCloseTo(48 + 7.01955, 4); // the G below: a pure fifth, an octave down
  });
  it("lays an EDO's steps on the keys", () => {
    const t = { steps: Array.from({ length: 19 }, (_, i) => (i * 1200) / 19), period: 1200, map: "steps" as const, root: 60 };
    expect(tunedPitch(t, 79)).toBeCloseTo(72, 9); // 19 keys up: an octave
    expect(tunedPitch(t, 61)).toBeCloseTo(60 + 12 / 19, 9);
  });
  it("retunes to the nearest pitch of a system with no twelve steps", () => {
    const t = { steps: Array.from({ length: 24 }, (_, i) => i * 50), period: 1200, map: "retune" as const, root: 60 };
    expect(tunedPitch(t, 63.5)).toBeCloseTo(63.5, 9); // a maqam's quarter tone is in 24-EDO
  });
  it("reads cents, ratios and .scl files", () => {
    expect(parseScala("9/8 5/4 3/2 2/1")!.steps.map((c) => Math.round(c))).toEqual([0, 204, 386, 702]);
    const scl = "! test.scl\nMy scale\n 3\n!\n 200.0\n 5/4  ! a third\n 2\n";
    expect(parseScala(scl)).toEqual({ steps: [0, 200, expect.closeTo(386.31, 2)], period: 1200 });
    expect(parseScala("hello")).toBeNull();
  });
  it("is applied to the notes as they are played", () => {
    const seq = run(MUSIC_TUNING_NODE, { sequence: pattern("C4:maj") }, { system: "Just (5-limit)" }).sequence.seq;
    expect(notesOf(seq).map((e) => e.note)).toEqual([60, expect.closeTo(63.863, 3), expect.closeTo(67.0196, 3)]);
    const edo = run(MUSIC_TUNING_NODE, { sequence: pattern("C4 D4") }, { system: "EDO", edo: 24 }).sequence.seq;
    expect(notesOf(edo).map((e) => e.note)).toEqual([60, 61]);
  });
});

describe("Euclid", () => {
  it("spreads hits evenly", () => {
    const s = (k: number, n: number, r = 0) => euclid(k, n, r).map((b) => (b ? "x" : ".")).join("");
    expect(s(3, 8)).toBe("x..x..x.");
    expect(s(4, 16)).toBe("x...x...x...x...");
    expect(s(5, 8).split("x").length - 1).toBe(5);
    expect(s(3, 8, 1)).toBe(".x..x..x");
  });
  it("cycles its notes over the hits, long enough to come round", () => {
    const seq = run(MUSIC_EUCLID_NODE, {}, { pulses: 3, steps: 8, notes: "C4 E4" }).sequence.seq;
    expect(seq.pattern.length).toBe(16);
    expect(seq.pattern.steps.map((c: any) => c?.note ?? null)).toEqual([60, null, null, 64, null, null, 60, null, 64, null, null, 60, null, null, 64, null]);
  });
  it("restrikes a wired sequence's held notes", () => {
    const seq = run(MUSIC_EUCLID_NODE, { input: pattern("C4 . . . G4:min . . .", 8) }, { pulses: 4, steps: 8 }).sequence.seq;
    expect(seq.pattern.steps.map((c: any) => c?.note ?? null)).toEqual([60, null, 60, null, 67, null, 67, null]);
    expect(seq.pattern.steps[4].chord).toBe("min");
  });
});

describe("Shift Register", () => {
  const notes = (p: Record<string, unknown>) => run(MUSIC_SHIFT_REGISTER_NODE, {}, { density: 1, ...p }).sequence.seq.pattern.steps.map((c: any) => c?.note ?? null);
  it("locked, it loops every `bits` steps", () => {
    const n = notes({ change: 0, bits: 5, length: 20 });
    expect(n.slice(0, 5)).toEqual(n.slice(5, 10));
    expect(n.slice(0, 5)).toEqual(n.slice(15, 20));
  });
  it("stays in its scale and range, the same on every run", () => {
    const n = notes({ change: 0.5, length: 64, scale: "minor pentatonic", root: "A", low: 57, range: 10 });
    const s = scaleSpec("minor pentatonic", 9);
    for (const x of n) {
      expect(snapNote(s, x)).toBe(x);
      expect(x).toBeGreaterThanOrEqual(57);
      expect(x).toBeLessThanOrEqual(57 + 24);
    }
    expect(notes({ change: 0.5, length: 64 })).toEqual(notes({ change: 0.5, length: 64 }));
    expect(notes({ change: 0.5, seed: 1 })).not.toEqual(notes({ change: 0.5, seed: 2 }));
  });
  it("density rests some steps", () => {
    const steps = run(MUSIC_SHIFT_REGISTER_NODE, {}, { density: 0.3, length: 256, change: 0.5 }).sequence.seq.pattern.steps;
    const played = steps.filter(Boolean).length / steps.length;
    expect(played).toBeGreaterThan(0.15);
    expect(played).toBeLessThan(0.45);
  });
});

describe("Tonnetz", () => {
  it("moves P, L, R and their compounds", () => {
    const C = { root: 0, minor: false };
    expect(tonnetzMove(C, "P")).toEqual({ root: 0, minor: true });
    expect(tonnetzMove(C, "R")).toEqual({ root: 9, minor: true });
    expect(tonnetzMove(C, "L")).toEqual({ root: 4, minor: true });
    expect(tonnetzMove(C, "S")).toEqual({ root: 1, minor: true });
    expect(tonnetzMove(C, "N")).toEqual({ root: 5, minor: true });
    expect(tonnetzMove(C, "H")).toEqual({ root: 8, minor: true });
    for (const m of ["P", "L", "R", "S"] as const) expect(tonnetzMove(tonnetzMove(C, m), m)).toEqual(C);
  });
  it("voices each chord close to the last", () => {
    const a = voiceTriad({ root: 0, minor: false }, null, 60);
    const b = voiceTriad({ root: 9, minor: true }, a.notes, 60);
    expect(a.notes).toEqual([60, 64, 67]);
    expect(b.notes).toEqual([60, 64, 69]); // C E A: one note moved, a tone
  });
  it("walks a path, one chord per Chord Length, with a bass", () => {
    const { chords, bass } = run(MUSIC_TONNETZ_NODE, {}, { path: "R L . P", chordLength: 4 });
    const steps = chords.seq.pattern.steps;
    expect(chords.seq.pattern.length).toBe(20);
    expect([0, 4, 8, 12, 16].map((i) => steps[i] && `${steps[i].note % 12}${steps[i].chord}`)).toEqual(["0maj", "9min", "5maj", null, "5min"]);
    expect(bass.seq.pattern.steps[4].note).toBe(45);
  });
  it("walks at random, never straight back", () => {
    const { chords } = run(MUSIC_TONNETZ_NODE, {}, { random: true, count: 12, chordLength: 1 });
    expect(chords.seq.pattern.steps.filter(Boolean)).toHaveLength(12);
  });
});

describe("Ornament", () => {
  it("figures fit the note, the written note last", () => {
    expect(ornamentParts({ type: "turn", up: 2, down: 1, beats: 0.125 }, 0, 6000, 1000, SR).map((p) => [p.on, p.offset])).toEqual([[0, 2], [1000, 0], [2000, -1], [3000, 0]]);
    // Too short for its figure: played faster.
    expect(ornamentParts({ type: "mordent", up: 2, down: 1, beats: 0.125 }, 0, 600, 1000, SR).map((p) => p.on)).toEqual([0, 200, 400]);
    const trill = ornamentParts({ type: "trill", up: 2, down: 1, beats: 0.125 }, 0, 6000, 1000, SR);
    expect(trill.map((p) => p.offset)).toEqual([0, 2, 0, 2, 0]);
    expect(trill[trill.length - 1].off).toBe(6000);
  });
  it("is played by the sequencer, chords in parallel", () => {
    const seq = run(MUSIC_ORNAMENT_NODE, { sequence: pattern("C4 . . . . . . . . . . . . . . .") }, { type: "upper mordent", chance: 1, rate: "1/32" }).sequence.seq;
    // A 32nd at 120 BPM: 3000 samples.
    expect(notesOf(seq).map((e) => [e.on, e.note])).toEqual([[0, 60], [3000, 62], [6000, 60]]);
  });
  it("leaves short notes and lost draws alone", () => {
    const seq = run(MUSIC_ORNAMENT_NODE, { sequence: pattern("C4 D4 E4 . . .", 6) }, { chance: 1, minSteps: 2 }).sequence.seq;
    expect(seq.pattern.steps.map((c: any) => !!c?.orn)).toEqual([false, false, true, false, false, false]);
    const none = run(MUSIC_ORNAMENT_NODE, { sequence: pattern("C4 . . .", 4) }, { chance: 0 }).sequence.seq;
    expect(none.pattern.steps[0].orn).toBeUndefined();
  });
  it("a scoop glides up into the note", () => {
    const seq = run(MUSIC_ORNAMENT_NODE, { sequence: pattern("C4 . . .", 4) }, { type: "scoop", chance: 1, down: 3 }).sequence.seq;
    expect(notesOf(seq)[0]).toMatchObject({ note: 60, glideFrom: 57 });
  });
});

describe("Chip Echo", () => {
  it("is the line later, softer and a little detuned", () => {
    const echo = run(MUSIC_CHIP_ECHO_NODE, { sequence: pattern("C4@1 . E4 .", 4) }, { delay: 1, level: 0.5, detune: 10 }).echo.seq;
    expect(echo.pattern.steps).toEqual([null, { note: 60.1, velocity: 0.5 }, null, { note: 64.1, velocity: 0.4 }]);
  });
});
