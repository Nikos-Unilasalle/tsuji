import { requestCanvasSwitch } from "../canvasSwitchStore";
import { createNodeCache } from "../nodeCaches";
import { fromBoolean, toBoolean } from "../sockets";
import { CANVAS_COUNT, NodeDefinition } from "../types";

/** Previous trigger state per node id — the same rising-edge bookkeeping TRIGGER_NODE does. */
const triggerStateCache = createNodeCache<boolean>();

/**
 * Go To Canvas — switches the editor to another canvas on the rising edge of
 * its Trigger input. Wire a Keyboard node (or a Compare on a beat, or
 * anything else that goes true) into it and the whole document flips to
 * another tree: the `caller` idea from BIBLE.md's scene model.
 *
 * A "go to", never a "come here": only the active canvas is evaluated, so a
 * node sitting in canvas 3 isn't running and could not pull anything towards
 * it. The node that switches is always in the canvas you're leaving.
 *
 * Rising edge rather than level, deliberately — a held-down key or a
 * permanently-true condition would otherwise re-request the same switch every
 * frame, and pin the document there by making every other switch impossible.
 */
export const CANVAS_GOTO_NODE: NodeDefinition = {
  type: "canvas/goto",
  label: "Go To Canvas",
  category: "utility",
  inputs: [
    { id: "trigger", label: "Trigger", type: "value" },
    { id: "canvas", label: "Canvas (1-6)", type: "value" },
  ],
  outputs: [{ id: "switched", label: "Switched", type: "value" }],
  defaultParams: { canvas: 1, trigger: 0 },
  paramFields: [
    { id: "canvas", label: "Canvas (fallback)", kind: "number", step: 1 },
    { id: "trigger", label: "Trigger (fallback)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const current = toBoolean(inputs.trigger !== undefined ? inputs.trigger : params.trigger);
    const previous = triggerStateCache.get(ctx.nodeId) ?? false;
    triggerStateCache.set(ctx.nodeId, current);

    if (!current || previous) return { switched: fromBoolean(false) };

    // An export renders this canvas's frames; it never moves the document.
    // A film chained across canvases hands over on its last frame, and an
    // export reaching that frame would otherwise leave the editor sitting on
    // the next canvas once it finished.
    if (ctx.capturing) return { switched: fromBoolean(false) };

    // 1-based in the UI (it reads as "Canvas 3", matching the selector's own
    // numbering), 0-based everywhere in the code.
    const raw = Number(inputs.canvas !== undefined ? inputs.canvas : params.canvas);
    const target = Math.round(Number.isFinite(raw) ? raw : 1) - 1;
    if (target < 0 || target >= CANVAS_COUNT) return { switched: fromBoolean(false) };

    requestCanvasSwitch(target);
    return { switched: fromBoolean(true) };
  },
};
