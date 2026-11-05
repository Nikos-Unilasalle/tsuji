import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "./index";
import { paramFromInput, socketableFields } from "./paramInputs";
import type { EvalContext } from "../types";

const def = (type: string) => DEFAULT_REGISTRY.get(type)!;

describe("params opened as inputs", () => {
  it("every music node can open its number, on/off and choice params — none it already has a socket for, nor its preset", () => {
    for (const d of DEFAULT_REGISTRY.values()) {
      // The Music Viewer and the Mixing Console evaluate nothing: they draw from their params, so they have none to open.
      if (d.category !== "music" || d.type === "music/viewer" || d.type === "music/mixing-console") continue;
      const ids = d.paramInputs ?? [];
      const own = new Set(d.inputs.map((s) => s.id));
      for (const f of d.paramFields ?? []) {
        if (["number", "boolean", "select"].includes(f.kind) && !own.has(f.id) && f.id !== "preset") expect(ids, `${d.type}.${f.id}`).toContain(f.id);
      }
      expect(ids).not.toContain("preset");
    }
    expect(socketableFields(def("music/euclid")).map((f) => f.id)).toEqual(["gate", "velocity", "accent"]);
  });

  it("only the opened ones become sockets", () => {
    const d = def("music/euclid");
    expect(d.dynamicInputs!([], [], { ...d.defaultParams }).map((s) => s.id)).toEqual(["input", "pulses", "steps", "rotation"]);
    const open = d.dynamicInputs!([], [], { ...d.defaultParams, paramInputs: ["accent"] });
    expect(open.map((s) => s.id)).toEqual(["input", "pulses", "steps", "rotation", "accent"]);
    expect(open[4]).toMatchObject({ type: "value", label: "Accent" });
  });

  it("a wired value replaces the param: numbers as they come, on/off above 0, a choice by its index, wrapping", () => {
    const d = def("music/shift-register");
    const field = (id: string) => d.paramFields!.find((f) => f.id === id)!;
    expect(paramFromInput(field("low"), 48.5)).toBe(48.5);
    expect(paramFromInput(field("scale"), 0)).toBe((field("scale") as { options: string[] }).options[0]);
    const scales = (field("scale") as { options: string[] }).options;
    expect(paramFromInput(field("scale"), -1)).toBe(scales[scales.length - 1]);
    expect(paramFromInput(def("music/sections").paramFields!.find((f) => f.id === "restart")!, 0)).toBe(false);
    expect(paramFromInput(field("low"), "x")).toBeUndefined();
  });

  it("drives the evaluation only when wired", () => {
    const d = def("music/voice-leading");
    const chords = { kind: "sequence", seq: { clock: { bpm: 120, swing: 0, stepsPerBeat: 4 }, pattern: { length: 1, steps: [{ note: 60, chord: "maj" }] } } };
    const ctx = (wired: string[]): EvalContext => ({ time: 0, step: 0, nodeId: "n", fps: 30, connectedInputs: new Set(wired) }) as EvalContext;
    const params = { ...d.defaultParams, paramInputs: ["voices"] };
    const count = (r: any) => 1 + (r.sequence.seq.pattern.steps[0].add?.length ?? 0);
    expect(count(d.evaluate({ sequence: chords, voices: 2 }, params, ctx([])))).toBe(4);
    expect(count(d.evaluate({ sequence: chords, voices: 2 }, params, ctx(["voices"])))).toBe(2);
  });
});
