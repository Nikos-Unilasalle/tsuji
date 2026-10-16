import { NodeDefinition } from "../types";

/**
 * Reroute Node — Blender-style reroute dot node.
 * Passes input straight through to output while allowing wire routing and multi-branching.
 */
export const REROUTE_NODE: NodeDefinition = {
  type: "utility/reroute",
  label: "Reroute",
  category: "utility",
  pure: true,
  inputs: [{ id: "in", label: "", type: "any", owns: true }],
  outputs: [{ id: "out", label: "", type: "any" }],
  defaultParams: {},
  paramFields: [],
  dynamicInputs: (_connections, connectionsWithTypes) => {
    const conn = connectionsWithTypes?.find((c) => c.connection.toSocket === "in");
    const socketType = conn?.sourceSocketType || "any";
    return [{ id: "in", label: "", type: socketType, owns: true }];
  },
  dynamicOutputs: (_connections, connectionsWithTypes) => {
    const conn = connectionsWithTypes?.find((c) => c.connection.toSocket === "in");
    const socketType = conn?.sourceSocketType || "any";
    return [{ id: "out", label: "", type: socketType }];
  },
  evaluate: (inputs) => {
    return { out: inputs.in };
  },
};
