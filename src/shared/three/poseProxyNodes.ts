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
 * `scaleRadii` lets the gizmo's Scale mode resize the sphere: dragging scales `radiusParam` and `innerRadiusParam` together.
 *
 * `locationParam` names the vector param the marker stands for when it is not `location` (Audio Player's `position`);
 * `innerRadiusParam` adds a second, filled sphere inside the first (a sound's full-volume zone); `when` shows the proxy only
 * while it makes sense (a sound is only spatial in local mode).
 *
 * `radiusParam` names a numeric param drawn as a wire sphere around the
 * marker; `box` draws the node's `boxSize` as a wire box (lifted by half its
 * height when `groundAnchor` is on, matching the solver's own placement).
 */
export interface PoseProxyConfig {
  channels: "location" | "trs";
  radiusParam?: string;
  innerRadiusParam?: string;
  scaleRadii?: boolean;
  locationParam?: string;
  when?: (params: Record<string, unknown>) => boolean;
  box?: boolean;
}

export const POSE_PROXY_NODES: Readonly<Record<string, PoseProxyConfig>> = {
  "object/explosion": { channels: "location", radiusParam: "fireRadius" },
  "physics/explosion": { channels: "location", radiusParam: "radius" },
  "physics/fluid-solver-3d": { channels: "trs", box: true },
  // A local sound: where it sits, the radius it is heard at full volume, and the radius where it has faded out.
  "sound/player": {
    channels: "location",
    locationParam: "position",
    radiusParam: "outerRadius",
    innerRadiusParam: "innerRadius",
    scaleRadii: true,
    when: (params) => params.spatialMode === "local",
  },
};
