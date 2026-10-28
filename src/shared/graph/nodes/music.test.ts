import { describe, expect, it } from "vitest";
import {
  MUSIC_ARP_NODE,
  MUSIC_CLOCK_NODE,
  MUSIC_DRUM_KIT_NODE,
  MUSIC_FM_VOICE_NODE,
  MUSIC_NOTE_PROBE_NODE,
  MUSIC_OUT_NODE,
  MUSIC_PATTERN_NODE,
  gatherTracks,
} from "./music";
import { EvalContext, NodeDefinition } from "../types";
import { FM_PRESETS } from "../../music/dsp/presets";
import type { DrumTrackDescription, FmTrackDescription, MusicValue } from "../../music/engine/description";

const ctx = (extra: Partial<EvalContext> = {}): EvalContext => ({ time: 0, step: 0, nodeId: "n1", fps: 30, ...extra });

function run(def: NodeDefinition, inputs: Record<string, unknown> = {}, params: Record<string, unknown> = {}, c = ctx()) {
  return def.evaluate!(inputs, { ...def.defaultParams, ...params }, c) as Record<string, any>;
}

describe("Clock", () => {
  it("describes tempo, swing and grid, clamped", () => {
    const { clock } = run(MUSIC_CLOCK_NODE, { bpm: 1000 }, { swing: 0.4, stepsPerBeat: "3" });
    expect(clock).toEqual({ kind: "clock", clock: { bpm: 400, swing: 0.4, stepsPerBeat: 3 } });
  });
});

describe("Pattern", () => {
  it("reads its steps and takes its clock from the wire", () => {
    const clock = run(MUSIC_CLOCK_NODE, {}, { bpm: 90 }).clock;
    const { sequence } = run(MUSIC_PATTERN_NODE, { clock }, { steps: "C4:min . off", length: "16" });
    expect(sequence.kind).toBe("sequence");
    expect(sequence.seq.clock.bpm).toBe(90);
    expect(sequence.seq.pattern.length).toBe(16);
    expect(sequence.seq.pattern.steps.slice(0, 3)).toEqual([{ note: 60, chord: "min" }, null, { note: "off" }]);
  });

  it("transposes, forces a chord and scales velocity — from wires too", () => {
    const { sequence } = run(MUSIC_PATTERN_NODE, { transpose: 2, chord: 1, velocity: 0.5 }, { steps: "C4:min7 off", length: "16" });
    expect(sequence.seq.pattern.steps[0]).toEqual({ note: 62, chord: "maj", velocity: 0.4 });
    expect(sequence.seq.pattern.steps[1]).toEqual({ note: "off" });
  });

  it("plays on a 120 BPM clock when none is wired", () => {
    expect(run(MUSIC_PATTERN_NODE).sequence.seq.clock).toEqual({ bpm: 120, swing: 0, stepsPerBeat: 4 });
  });
});

describe("Arp", () => {
  const seq = () => run(MUSIC_PATTERN_NODE).sequence;

  it("adds its settings to the sequence", () => {
    const out = run(MUSIC_ARP_NODE, { sequence: seq() }, { mode: "updown", rate: "1/32", octaves: 9 }).sequence;
    expect(out.seq.arp).toMatchObject({ mode: "updown", rate: "1/32", octaves: 4, sync: "grid" });
  });

  it("passes the sequence through untouched when off, and nothing when nothing is wired", () => {
    expect(run(MUSIC_ARP_NODE, { sequence: seq(), on: 0 }).sequence.seq.arp).toBe(null);
    expect(run(MUSIC_ARP_NODE).sequence).toBe(null);
  });
});

describe("FM Voice", () => {
  const seq = () => run(MUSIC_PATTERN_NODE).sequence;

  it("turns a sequence into a track named after the node, with its preset's patch", () => {
    const track = run(MUSIC_FM_VOICE_NODE, { sequence: seq() }, {}, ctx({ nodeId: "voice7" })).track as FmTrackDescription;
    expect(track.id).toBe("voice7");
    expect(track.kind).toBe("fm");
    expect(track.patch).toEqual(FM_PRESETS["E. Piano"]);
  });

  it("loads every operator setting when a preset is picked", () => {
    const field = MUSIC_FM_VOICE_NODE.paramFields!.find((f) => f.id === "preset");
    const bell = field && field.kind === "select" ? field.presets!.Bell : {};
    const track = run(MUSIC_FM_VOICE_NODE, { sequence: seq() }, { preset: "Bell", ...bell }).track as FmTrackDescription;
    expect(track.patch).toEqual(FM_PRESETS.Bell);
  });

  it("fills a saved voice that only names its preset with that preset's settings", () => {
    const up = MUSIC_FM_VOICE_NODE.upgradeParams!({ preset: "Organ", level: 0.5 });
    expect(up.algorithm).toBe("8");
    expect(up.level).toBe(0.5);
    const kept = { preset: "Organ", op1_ratio: 7 };
    expect(MUSIC_FM_VOICE_NODE.upgradeParams!(kept)).toBe(kept);
    const track = run(MUSIC_FM_VOICE_NODE, { sequence: seq() }, up).track as FmTrackDescription;
    expect(track.patch).toEqual(FM_PRESETS.Organ);
  });

  it("loads an FM-1 firmware sound with its voice count and transposition", () => {
    const field = MUSIC_FM_VOICE_NODE.paramFields!.find((f) => f.id === "preset");
    const bass = field && field.kind === "select" ? field.presets!["SLOOP · FM BASS"] : {};
    expect(bass).toMatchObject({ voices: 1, transpose: -24, algorithm: "1" });
    const track = run(MUSIC_FM_VOICE_NODE, { sequence: seq() }, { preset: "SLOOP · FM BASS", ...bass }).track as FmTrackDescription;
    expect(track.voices).toBe(1);
    expect(track.seq.pattern.steps[0]).toMatchObject({ note: 60 - 24, chord: "maj7" });
  });

  it("brightens the modulators only", () => {
    const plain = run(MUSIC_FM_VOICE_NODE, { sequence: seq() }).track as FmTrackDescription;
    const bright = run(MUSIC_FM_VOICE_NODE, { sequence: seq(), brightness: 2 }).track as FmTrackDescription;
    // E. Piano is algorithm 5: operators 1 and 3 are heard, 2 and 4 modulate.
    expect(bright.patch.ops[0].level).toBe(plain.patch.ops[0].level);
    expect(bright.patch.ops[1].level).toBeCloseTo(plain.patch.ops[1].level * 2, 9);
  });

  it("outputs nothing without a sequence", () => {
    expect(run(MUSIC_FM_VOICE_NODE).track).toBe(null);
  });
});

describe("Drum Kit", () => {
  it("makes a drum track, with no arpeggio", () => {
    const pat = run(MUSIC_PATTERN_NODE, {}, { steps: "kick . snare hat" }).sequence;
    const arped = run(MUSIC_ARP_NODE, { sequence: pat }).sequence;
    const track = run(MUSIC_DRUM_KIT_NODE, { sequence: arped, tune: 3 }).track as DrumTrackDescription;
    expect(track.kind).toBe("drums");
    expect(track.seq.arp).toBe(null);
    expect(track.drums).toEqual({ tune: 3, decay: 1 });
    expect(track.seq.pattern.steps[0]).toEqual({ note: 36 });
  });
});

describe("Note Probe", () => {
  // 120 BPM: a sixteenth is 1/8 s, so at 30 fps a step lasts 3.75 frames.
  const seq = () => run(MUSIC_PATTERN_NODE, {}, { steps: "C4:maj . . . off . . . A3", length: "16" }).sequence;

  it("reads gate, pitch, chord and step at the playhead", () => {
    const at = (frame: number) => run(MUSIC_NOTE_PROBE_NODE, { music: seq() }, {}, ctx({ currentFrame: frame }));
    const start = at(0);
    expect(start).toMatchObject({ gate: 1, trigger: 1, pitch: 60, count: 3, step: 0, notes: [60, 64, 67] });
    expect(start.envelope).toBeCloseTo(1, 9);
    const later = at(5);
    expect(later).toMatchObject({ gate: 1, trigger: 0, step: 1 });
    expect(later.envelope).toBeLessThan(1);
    expect(at(16)).toMatchObject({ gate: 0, count: 0, step: 4 }); // after the OFF on step 4
    expect(at(30)).toMatchObject({ gate: 1, trigger: 1, pitch: 57, step: 8 });
  });

  it("is silent before its start frame and without a sequence", () => {
    expect(run(MUSIC_NOTE_PROBE_NODE, { music: seq() }, { startFrame: 10 }, ctx({ currentFrame: 5 })).gate).toBe(0);
    expect(run(MUSIC_NOTE_PROBE_NODE).step).toBe(-1);
  });

  it("reads a track's sequence too", () => {
    const track = run(MUSIC_FM_VOICE_NODE, { sequence: seq() }).track;
    expect(run(MUSIC_NOTE_PROBE_NODE, { music: track }, {}, ctx({ currentFrame: 0 })).pitch).toBe(60);
  });
});

describe("Music Out", () => {
  const seq = () => run(MUSIC_PATTERN_NODE).sequence as MusicValue;

  it("gathers tracks in socket order, plays a bare sequence on the electric piano, and splits a track wired twice", () => {
    const voice = run(MUSIC_FM_VOICE_NODE, { sequence: seq() }, {}, ctx({ nodeId: "v" })).track;
    const tracks = gatherTracks({ track1: voice, track0: seq(), track2: voice, master: 0.5 }, "out");
    expect(tracks.map((t) => t.id)).toEqual(["out:track0", "v", "v#2"]);
    expect(tracks[0].kind).toBe("fm");
  });

  it("reports song time, beat and step from the playhead, silent before Start Frame", () => {
    const voice = run(MUSIC_FM_VOICE_NODE, { sequence: seq() }).track;
    const out = run(MUSIC_OUT_NODE, { track0: voice }, { startFrame: 30 }, ctx({ currentFrame: 60, isPlaying: true }));
    expect(out.time).toBe(1);
    expect(out.beat).toBe(2);
    expect(out.step).toBe(8);
    expect(out.playing).toBe(1);
    expect(run(MUSIC_OUT_NODE, { track0: voice }, { startFrame: 30 }, ctx({ currentFrame: 10, isPlaying: true })).playing).toBe(0);
  });
});
