import * as THREE from "three";
import { NodeDefinition } from "../types";
import { extractPositionFromInput } from "./transform";

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Instance Positions — the bridge from Array (and anything else handing back
 * a Group of instances) to a plain Vector3 list, which is what most
 * points-consuming nodes actually want. Array only outputs the instanced
 * Group itself, with no position list alongside it — this is the "poles,
 * now give me a wire between them" node: wire Array's Geometry in here, wire
 * this node's Positions into Curve from Points' Points, add Sag.
 *
 * Height Offset exists for the common case: a pole's own origin is usually
 * its base (where it plants in the ground), not its top (where a wire
 * actually attaches) — this shifts every extracted position up (or down)
 * along Y, this app's up axis, without needing a second node. It's a fixed
 * constant though, so it only lines up with the actual mesh top when every
 * instance is the same height — under per-instance random scale (poles of
 * varying height, say) a constant offset drifts off the real tip the moment
 * scale departs from 1. Anchor "top"/"bottom" sidesteps that entirely by
 * reading the instance's actual post-transform bounding box instead of
 * assuming a fixed offset from its origin — correct at any scale, with no
 * offset math to keep in sync.
 */
export const INSTANCE_POSITIONS_NODE: NodeDefinition = {
  type: "structure/instance-positions",
  label: "Instance Positions",
  category: "converter",
  pure: true,
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "heightOffset", label: "Height Offset", type: "value" },
  ],
  outputs: [
    { id: "positions", label: "Positions", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { heightOffset: 0, anchor: "origin" },
  paramFields: [
    { id: "anchor", label: "Anchor", kind: "select", options: ["origin", "top", "bottom"] },
    { id: "heightOffset", label: "Height Offset (Y)", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params) => {
    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!source) return { positions: [], count: 0 };

    // Array (and Merge, and anything else that groups multiple objects)
    // hands back a Group whose children are the individual instances; a
    // single ungrouped object is its own one-instance "list".
    const instances = source instanceof THREE.Group && source.children.length > 0 ? source.children : [source];
    const heightOffset = inputs.heightOffset !== undefined ? asNumber(inputs.heightOffset, 0) : asNumber(params.heightOffset, 0);
    const anchor = String(params.anchor || "origin");

    const positions = instances.map((instance) => {
      const pos = extractPositionFromInput(instance, new THREE.Vector3());
      if (anchor === "top" || anchor === "bottom") {
        instance.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(instance);
        if (!box.isEmpty()) pos.y = anchor === "top" ? box.max.y : box.min.y;
      }
      pos.y += heightOffset;
      return pos;
    });

    return { positions, count: positions.length };
  },
};
