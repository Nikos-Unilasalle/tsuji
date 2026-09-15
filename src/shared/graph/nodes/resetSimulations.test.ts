import { beforeEach, describe, expect, it } from "vitest";
import { TIME_RESET_SIMULATIONS_NODE } from "./resetSimulations";
import { getSimulationEpoch } from "../simulationEpoch";

function evaluate(trigger: unknown, nodeId: string, time = 0) {
  return TIME_RESET_SIMULATIONS_NODE.evaluate({ trigger }, {}, { time, step: Math.round(time * 60), nodeId }) as {
    fired: number;
    count: number;
  };
}

describe("TIME_RESET_SIMULATIONS_NODE", () => {
  let epochBefore = 0;

  beforeEach(() => {
    epochBefore = getSimulationEpoch();
  });

  it("has the expected node schema", () => {
    expect(TIME_RESET_SIMULATIONS_NODE.type).toBe("time/reset-simulations");
    expect(TIME_RESET_SIMULATIONS_NODE.category).toBe("time");
    expect(TIME_RESET_SIMULATIONS_NODE.inputs.map((i) => i.id)).toEqual(["trigger"]);
    expect(TIME_RESET_SIMULATIONS_NODE.outputs.map((o) => o.id)).toEqual(["fired", "count"]);
  });

  it("bumps the epoch on a rising edge", () => {
    expect(evaluate(0, "rise").fired).toBe(0);
    expect(getSimulationEpoch()).toBe(epochBefore);

    const res = evaluate(1, "rise", 0.1);
    expect(res.fired).toBe(1);
    expect(res.count).toBe(1);
    expect(getSimulationEpoch()).toBe(epochBefore + 1);
  });

  it("does not fire again while the trigger stays high", () => {
    evaluate(1, "held");
    const epochAfterFirst = getSimulationEpoch();

    for (let f = 1; f < 20; f++) expect(evaluate(1, "held", f / 60).fired).toBe(0);
    expect(getSimulationEpoch()).toBe(epochAfterFirst);
  });

  it("re-arms once the trigger falls", () => {
    evaluate(1, "rearm");
    evaluate(0, "rearm", 0.1);
    const before = getSimulationEpoch();

    const again = evaluate(1, "rearm", 0.2);
    expect(again.fired).toBe(1);
    expect(again.count).toBe(2);
    expect(getSimulationEpoch()).toBe(before + 1);
  });

  it("does not re-fire when the clock jumps back, which is what its own reset causes", () => {
    evaluate(1, "rewind", 2.0);
    const after = getSimulationEpoch();

    // The reset rewinds the playhead to 0 with the trigger still high: reading that as a fresh
    // edge would reset the graph forever.
    expect(evaluate(1, "rewind", 0).fired).toBe(0);
    expect(getSimulationEpoch()).toBe(after);
  });

  it("treats a missing trigger as low and never fires on its own", () => {
    const before = getSimulationEpoch();
    for (let f = 0; f < 10; f++) {
      expect(
        (TIME_RESET_SIMULATIONS_NODE.evaluate({}, {}, { time: f / 60, step: f, nodeId: "idle" }) as { fired: number })
          .fired,
      ).toBe(0);
    }
    expect(getSimulationEpoch()).toBe(before);
  });
});
