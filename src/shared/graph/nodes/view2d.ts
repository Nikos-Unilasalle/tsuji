import * as THREE from "three";
import { Graph, NodeDefinition } from "../types";

/**
 * Terminal node for the 2D View window (see View2DWindow.tsx) — the texture
 * equivalent of `render` for the 3D Viewport/Output window. Whatever
 * `texture` socket is wired in gets displayed full-bleed in that window;
 * with nothing wired, the window shows nothing rather than erroring.
 *
 * Passes its input straight through as its own output so a 2D View node can
 * sit mid-chain (e.g. feed a Plane's material *and* the 2D View from the
 * same wire) without forcing a T-split at the source.
 */
export const VIEW2D_NODE: NodeDefinition = {
  type: "view2d",
  label: "2D View",
  category: "structure",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: {},
  evaluate: (inputs) => {
    const texture = inputs.texture instanceof THREE.Texture ? inputs.texture : null;
    return { texture };
  },
};

/** First `view2d`-type node in the graph — mirrors findRenderNodeId. Multiple 2D View nodes: first one wins, arbitrary order, not an error. */
export function findView2DNodeId(graph: Graph): string | undefined {
  return graph.nodes.find((n) => n.type === VIEW2D_NODE.type)?.id;
}
