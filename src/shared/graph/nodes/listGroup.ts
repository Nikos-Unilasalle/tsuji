import { growingSockets } from "../dynamicInputs";
import { NodeDefinition } from "../types";

const INPUT_PREFIX = "in";

/**
 * Combines dynamic inputs into a single List array output.
 * Inputs grow dynamically: wiring socket `in0` opens `in1`, etc.
 */
export const LIST_GROUP_NODE: NodeDefinition = {
  type: "list/group",
  label: "List Group",
  category: "list",
  pure: true,
  inputs: [{ id: `${INPUT_PREFIX}0`, label: "In 1", type: "any" }],
  dynamicInputs: (connections) =>
    growingSockets(connections, INPUT_PREFIX, (i) => ({
      id: `${INPUT_PREFIX}${i}`,
      label: `In ${i + 1}`,
      type: "any",
    })),
  outputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: {},
  evaluate: (inputs) => {
    const list: unknown[] = [];
    // Sort input keys numerically in0, in1, in2...
    const sortedKeys = Object.keys(inputs)
      .filter((k) => k.startsWith(INPUT_PREFIX))
      .sort((a, b) => {
        const idxA = Number(a.slice(INPUT_PREFIX.length)) || 0;
        const idxB = Number(b.slice(INPUT_PREFIX.length)) || 0;
        return idxA - idxB;
      });

    for (const key of sortedKeys) {
      const val = inputs[key];
      if (val !== undefined && val !== null) {
        if (Array.isArray(val)) {
          list.push(...val);
        } else {
          list.push(val);
        }
      }
    }

    return { list };
  },
};
