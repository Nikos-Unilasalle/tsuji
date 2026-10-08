import { beforeEach, describe, expect, test } from "vitest";
import { consumeCanvasSwitchRequest } from "../canvasSwitchStore";
import { EvalContext } from "../types";
import { CANVAS_GOTO_NODE } from "./canvas";

function ctx(nodeId: string): EvalContext {
  return { time: 0, step: 0, nodeId };
}

describe("CANVAS_GOTO_NODE", () => {
  beforeEach(() => {
    consumeCanvasSwitchRequest();
  });

  test("a rising trigger asks for the canvas, converting 1-based UI to a 0-based index", () => {
    const node = ctx("goto-rising");

    expect(CANVAS_GOTO_NODE.evaluate({ trigger: 0 }, { canvas: 3 }, node).switched).toBe(0);
    expect(consumeCanvasSwitchRequest()).toBeNull();

    expect(CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 3 }, node).switched).toBe(1);
    expect(consumeCanvasSwitchRequest()).toBe(2);
  });

  test("a held trigger fires once, not every frame", () => {
    // Otherwise a key held down would re-request the same canvas forever and
    // pin the document there, making every other switch impossible.
    const node = ctx("goto-held");

    CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 2 }, node);
    expect(consumeCanvasSwitchRequest()).toBe(1);

    expect(CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 2 }, node).switched).toBe(0);
    expect(consumeCanvasSwitchRequest()).toBeNull();
  });

  test("releasing and pressing again fires a second time", () => {
    const node = ctx("goto-repeat");

    CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 2 }, node);
    consumeCanvasSwitchRequest();

    CANVAS_GOTO_NODE.evaluate({ trigger: 0 }, { canvas: 2 }, node);
    expect(CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 2 }, node).switched).toBe(1);
    expect(consumeCanvasSwitchRequest()).toBe(1);
  });

  test("a wired canvas input beats the param, so the target itself can be computed", () => {
    const node = ctx("goto-wired");

    CANVAS_GOTO_NODE.evaluate({ trigger: 1, canvas: 5 }, { canvas: 1 }, node);

    expect(consumeCanvasSwitchRequest()).toBe(4);
  });

  test("a target outside the document asks for nothing", () => {
    expect(CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 0 }, ctx("goto-low")).switched).toBe(0);
    expect(consumeCanvasSwitchRequest()).toBeNull();

    expect(CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 99 }, ctx("goto-high")).switched).toBe(0);
    expect(consumeCanvasSwitchRequest()).toBeNull();
  });

  test("an export frame never switches the document", () => {
    // A chained film hands over on its last frame — exporting one canvas of
    // it must not leave the editor on the next one afterwards.
    const exporting = { ...ctx("goto-export"), capturing: true };

    expect(CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 2 }, exporting).switched).toBe(0);
    expect(consumeCanvasSwitchRequest()).toBeNull();
  });

  test("two nodes keep their own edge state", () => {
    CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 2 }, ctx("goto-a"));
    expect(consumeCanvasSwitchRequest()).toBe(1);

    // A different node id starts from its own "not pressed" state, so this is
    // a rising edge too rather than inheriting the first node's.
    CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 4 }, ctx("goto-b"));
    expect(consumeCanvasSwitchRequest()).toBe(3);
  });
});

describe("canvasSwitchStore", () => {
  test("a request is delivered once — consuming clears it", () => {
    CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 2 }, ctx("goto-once"));

    expect(consumeCanvasSwitchRequest()).toBe(1);
    expect(consumeCanvasSwitchRequest()).toBeNull();
  });

  test("the latest request wins when two land before anything collects", () => {
    CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 2 }, ctx("goto-first"));
    CANVAS_GOTO_NODE.evaluate({ trigger: 1 }, { canvas: 6 }, ctx("goto-second"));

    expect(consumeCanvasSwitchRequest()).toBe(5);
  });
});
