import { describe, expect, it } from "vitest";
import type { Graph } from "../../graph/types";
import { barBeat, clockLabel, consoleStrips, dbLabel, faderLevel, faderTravel, panLabel } from "./strips";

const seq = { clock: { bpm: 120, swing: 0, stepsPerBeat: 4 }, pattern: { length: 1, steps: [null] } };

describe("the fader's taper", () => {
  it("puts unity at 80 % of the travel, +6 dB at the top and silence at the bottom", () => {
    expect(faderLevel(0.8)).toBeCloseTo(1, 9);
    expect(faderLevel(1)).toBeCloseTo(2, 9);
    expect(faderLevel(0)).toBe(0);
    expect(faderLevel(0.45)).toBeCloseTo(0.1, 6);
  });

  it("is its own inverse, and never decreases", () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const l = faderLevel(t);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
      expect(faderTravel(l)).toBeCloseTo(Math.min(1, t), 6);
    }
  });
});

describe("readouts", () => {
  it("prints levels, pans, bars and times as a console does", () => {
    expect(dbLabel(1)).toBe("0.0");
    expect(dbLabel(2)).toBe("+6.0");
    expect(dbLabel(0.5)).toBe("-6.0");
    expect(dbLabel(0)).toBe("-INF");
    expect(panLabel(0)).toBe("C");
    expect(panLabel(-0.4)).toBe("L40");
    expect(panLabel(1)).toBe("R100");
    expect(barBeat(0)).toEqual({ bar: 1, beat: 1 });
    expect(barBeat(9.5)).toEqual({ bar: 3, beat: 2 });
    expect(barBeat(-1)).toEqual({ bar: 0, beat: 0 });
    expect(clockLabel(83.456)).toBe("01:23.46");
  });
});

describe("consoleStrips", () => {
  it("gives one strip per track Music Out mixes, in socket order, with the params a wire holds", () => {
    const graph = {
      nodes: [
        { id: "out", type: "music/out", params: {} },
        { id: "fm", type: "music/fm-voice", params: { preset: "Bass", name: "" } },
        { id: "dk", type: "music/drum-kit", params: {} },
        { id: "lfo", type: "math/sin", params: {} },
      ],
      connections: [
        { fromNode: "dk", fromSocket: "track", toNode: "out", toSocket: "track1" },
        { fromNode: "fm", fromSocket: "track", toNode: "out", toSocket: "track0" },
        { fromNode: "fm", fromSocket: "track", toNode: "out", toSocket: "track2" },
        { fromNode: "lfo", fromSocket: "value", toNode: "fm", toSocket: "pan" },
      ],
    } as unknown as Graph;
    const tracks: Record<string, Record<string, unknown>> = {
      fm: { track: { id: "fm", kind: "fm", voices: 8, patch: {}, seq, level: 0.8, pan: 0, mute: false } },
      dk: { track: { id: "dk", kind: "drums", drums: {}, seq, level: 0.9, pan: 0, mute: false } },
    };
    const { out, strips } = consoleStrips(graph, { get: (id) => tracks[id] });
    expect(out?.id).toBe("out");
    expect(strips.map((s) => [s.trackId, s.name, s.kind])).toEqual([
      ["fm", "Bass", "FM"],
      ["dk", "Drums", "DRUM"],
      ["fm#2", "Bass", "FM"],
    ]);
    expect([...strips[0].wired]).toEqual(["pan"]);
    expect(strips[1].node?.id).toBe("dk");
  });

  it("has nothing to show without a Music Out or before the first evaluation", () => {
    expect(consoleStrips({ nodes: [], connections: [] } as unknown as Graph, { get: () => undefined }).strips).toEqual([]);
    expect(consoleStrips({ nodes: [{ id: "out", type: "music/out", params: {} }], connections: [] } as unknown as Graph, null).strips).toEqual([]);
  });
});
