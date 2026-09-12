import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { toBoolean } from "../sockets";
import { resetSimulations } from "../simulationEpoch";

interface ResetState {
  prevTrigger: boolean;
  fires: number;
}

/**
 * Deliberately *not* keyed on the simulation epoch, unlike every other stateful node.
 *
 * This node's memory is the one thing a reset must not clear. Forgetting that the trigger was
 * already high would make a trigger that is still high after the rewind — a held key, a gate that
 * is open at frame 0 — read as a fresh rising edge, and the graph would reset itself forever.
 */
const resetCache = createNodeCache<ResetState>();

/**
 * Reset Simulations — the toolbar's reset button (Shift + Space) as a node.
 *
 * Throws away every simulation's accumulated state and returns to frame 0. Both halves matter: a
 * physics world or a fluid grid holds history that cannot be recomputed from the current frame,
 * and rebuilding without rewinding would leave a late frame showing a simulation that has only
 * ever run once.
 *
 * It fires on a rising edge and only on a rising edge. Holding the trigger high does not reset
 * repeatedly, and neither does the rewind the reset itself causes.
 */
export const TIME_RESET_SIMULATIONS_NODE: NodeDefinition = {
  type: "time/reset-simulations",
  label: "Reset Simulations",
  category: "time",
  inputs: [{ id: "trigger", label: "Trigger", type: "value" }],
  outputs: [
    { id: "fired", label: "Fired", type: "value" },
    { id: "count", label: "Reset Count", type: "value" },
  ],
  defaultParams: {},
  paramFields: [
    {
      id: "note",
      label:
        "Rebuilds physics, fluids and integrators and returns to frame 0 — the same thing the "
        + "toolbar's reset button and Shift + Space do. Fires on a rising edge only, so a trigger "
        + "left high does not reset the graph over and over.",
      kind: "note",
    },
  ],
  evaluate: (inputs, _params, ctx) => {
    let state = resetCache.get(ctx.nodeId);
    if (!state) {
      state = { prevTrigger: false, fires: 0 };
      resetCache.set(ctx.nodeId, state);
    }

    const trigger = toBoolean(inputs.trigger);
    const fired = trigger && !state.prevTrigger;
    state.prevTrigger = trigger;

    if (fired) {
      state.fires += 1;
      resetSimulations();
    }

    return { fired: fired ? 1 : 0, count: state.fires };
  },
};
