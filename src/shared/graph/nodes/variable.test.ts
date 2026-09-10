import { afterEach, describe, expect, test } from "vitest";
import { GET_VARIABLE_NODE, SET_VARIABLE_NODE, knownVariableNames, resetVariablesForTesting } from "./variable";
import { EvalContext } from "../types";

function ctx(step = 0, epoch = 0): EvalContext {
  return { nodeId: "n", time: 0, step, simulationEpoch: epoch };
}

afterEach(() => {
  resetVariablesForTesting();
});

describe("Set/Get Variable", () => {
  test("Get reads back whatever Set last wrote under that name", () => {
    SET_VARIABLE_NODE.evaluate({ value: 42 }, { name: "score", type: "Float" }, ctx(0));
    const result = GET_VARIABLE_NODE.evaluate({}, { name: "score" }, ctx(0));
    expect(result.value).toBe(42);
  });

  test("Set passes its coerced value straight through", () => {
    const result = SET_VARIABLE_NODE.evaluate({ value: "hi" }, { name: "x", type: "String" }, ctx(0));
    expect(result.value).toBe("hi");
  });

  test("with nothing wired, Set falls back to Initial Value", () => {
    const result = SET_VARIABLE_NODE.evaluate({}, { name: "lives", type: "Int", initial: 3 }, ctx(0));
    expect(result.value).toBe(3);
  });

  test("Int coerces and rounds; String stringifies", () => {
    const intResult = SET_VARIABLE_NODE.evaluate({ value: 2.7 }, { name: "n", type: "Int" }, ctx(0));
    expect(intResult.value).toBe(3);
    const stringResult = SET_VARIABLE_NODE.evaluate({ value: 5 }, { name: "s", type: "String" }, ctx(0));
    expect(stringResult.value).toBe("5");
  });

  test("an unset, never-declared name reads back undefined, not a guessed zero", () => {
    const result = GET_VARIABLE_NODE.evaluate({}, { name: "neverSet" }, ctx(0));
    expect(result.value).toBeUndefined();
  });

  test("every name a Set Variable used this or the previous step shows up for Get Variable's dropdown", () => {
    SET_VARIABLE_NODE.evaluate({ value: 1 }, { name: "health", type: "Float" }, ctx(0));
    SET_VARIABLE_NODE.evaluate({ value: 2 }, { name: "score", type: "Float" }, ctx(0));
    expect(knownVariableNames()).toEqual(["health", "score"]);
  });

  test("typing a name letter by letter does not leave the fragments behind", () => {
    // Each keystroke is a live evaluate() at a later step — "T" is stale by
    // the time "Toto" has been evaluating for a couple of frames.
    SET_VARIABLE_NODE.evaluate({}, { name: "T", type: "Float" }, ctx(0));
    SET_VARIABLE_NODE.evaluate({}, { name: "To", type: "Float" }, ctx(1));
    SET_VARIABLE_NODE.evaluate({}, { name: "Tot", type: "Float" }, ctx(2));
    SET_VARIABLE_NODE.evaluate({}, { name: "Toto", type: "Float" }, ctx(3));
    SET_VARIABLE_NODE.evaluate({}, { name: "Toto", type: "Float" }, ctx(4));

    expect(knownVariableNames()).toEqual(["Toto"]);
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

  test("a simulation reset clears the values but keeps the known names, defaulting by type", () => {
    SET_VARIABLE_NODE.evaluate({ value: 10 }, { name: "score", type: "Int" }, ctx(0, 0));
    const afterReset = GET_VARIABLE_NODE.evaluate({}, { name: "score" }, ctx(1, 1));
    expect(afterReset.value).toBe(0);
    expect(knownVariableNames()).toContain("score");
  });

  test("survives a Go To Canvas switch — the store is not per-canvas", () => {
    // Modeling two canvases: nothing here ties the value to a graph or
    // canvas id, which is the point — see variable.ts's module doc.
    SET_VARIABLE_NODE.evaluate({ value: "playing" }, { name: "gameState", type: "String" }, ctx(0));
    const readFromElsewhere = GET_VARIABLE_NODE.evaluate({}, { name: "gameState" }, ctx(0));
    expect(readFromElsewhere.value).toBe("playing");
  });

  test("Set Variable's editor fields switch with Type", () => {
    const stringFields = SET_VARIABLE_NODE.dynamicParamFields!({
      id: "s1",
      type: "variable/set",
      params: { name: "x", type: "String" },
      position: { x: 0, y: 0 },
    });
    expect(stringFields.find((f) => f.id === "initial")?.kind).toBe("text");

    const intFields = SET_VARIABLE_NODE.dynamicParamFields!({
      id: "s2",
      type: "variable/set",
      params: { name: "x", type: "Int" },
      position: { x: 0, y: 0 },
    });
    expect(intFields.find((f) => f.id === "initial")?.kind).toBe("number");
  });
});
