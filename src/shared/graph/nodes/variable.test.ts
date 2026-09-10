import { afterEach, describe, expect, test } from "vitest";
import { GET_VARIABLE_NODE, SET_VARIABLE_NODE, knownVariableNames, resetVariablesForTesting } from "./variable";
import { EvalContext } from "../types";

function ctx(epoch = 0): EvalContext {
  return { nodeId: "n", time: 0, step: 0, simulationEpoch: epoch };
}

afterEach(() => {
  resetVariablesForTesting();
});

describe("Set/Get Variable", () => {
  test("Get reads back whatever Set last wrote under that name", () => {
    SET_VARIABLE_NODE.evaluate({ value: 42 }, { name: "score" }, ctx());
    const result = GET_VARIABLE_NODE.evaluate({}, { name: "score" }, ctx());
    expect(result.value).toBe(42);
  });

  test("Set passes its value straight through", () => {
    const result = SET_VARIABLE_NODE.evaluate({ value: "hi" }, { name: "x" }, ctx());
    expect(result.value).toBe("hi");
  });

  test("an unset name reads back undefined, not a guessed zero", () => {
    const result = GET_VARIABLE_NODE.evaluate({}, { name: "neverSet" }, ctx());
    expect(result.value).toBeUndefined();
  });

  test("every name a Set Variable has used shows up for Get Variable's dropdown", () => {
    SET_VARIABLE_NODE.evaluate({ value: 1 }, { name: "health" }, ctx());
    SET_VARIABLE_NODE.evaluate({ value: 2 }, { name: "score" }, ctx());
    expect(knownVariableNames()).toEqual(["health", "score"]);
  });

  test("a name typed into Get Variable that no Set has used yet still appears as an option", () => {
    const fields = GET_VARIABLE_NODE.dynamicParamFields!({
      id: "g1",
      type: "variable/get",
      params: { name: "notYetSet" },
      position: { x: 0, y: 0 },
    });
    const nameField = fields.find((f) => f.id === "name") as { options: string[] };
    expect(nameField.options).toContain("notYetSet");
  });

  test("a simulation reset clears the values but keeps the known names", () => {
    SET_VARIABLE_NODE.evaluate({ value: 10 }, { name: "score" }, ctx(0));
    const afterReset = GET_VARIABLE_NODE.evaluate({}, { name: "score" }, ctx(1));
    expect(afterReset.value).toBeUndefined();
    expect(knownVariableNames()).toContain("score");
  });

  test("survives a Go To Canvas switch — the store is not per-canvas", () => {
    // Modeling two canvases: nothing here ties the value to a graph or
    // canvas id, which is the point — see variable.ts's module doc.
    SET_VARIABLE_NODE.evaluate({ value: "playing" }, { name: "gameState" }, ctx());
    const readFromElsewhere = GET_VARIABLE_NODE.evaluate({}, { name: "gameState" }, ctx());
    expect(readFromElsewhere.value).toBe("playing");
  });
});
