/**
 * Node types that own a `location` but have no viewport object the gizmo can
 * grab — the explosion's fireball only exists for a moment after a trigger,
 * the impulse blast and the fluid solver never draw anything — so Viewport.tsx
 * stands in a marker proxy at the param's pose and drags that instead.
 *
 * - "location": a point in space; only translate makes sense (rotation and
 *   scale are not parameters), so the gizmo is held in translate mode.
 * - "trs": a full pose (location / rotation / scale), like the Decal's box.
 *
 * `radiusParam` names a numeric param drawn as a wire sphere around the
 * marker; `box` draws the node's `boxSize` as a wire box (lifted by half its
 * height when `groundAnchor` is on, matching the solver's own placement).
 */
export interface PoseProxyConfig {
  channels: "location" | "trs";
  radiusParam?: string;
  box?: boolean;
}

export const POSE_PROXY_NODES: Readonly<Record<string, PoseProxyConfig>> = {
  "object/explosion": { channels: "location", radiusParam: "fireRadius" },
  "physics/explosion": { channels: "location", radiusParam: "radius" },
  "physics/fluid-solver-3d": { channels: "trs", box: true },
};
