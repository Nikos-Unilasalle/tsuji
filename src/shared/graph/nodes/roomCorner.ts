import * as THREE from "three";
import {
  DEFAULT_ROOM_CORNER,
  RoomCornerDimensions,
  roomCornerEdges,
  roomCornerReferencePoints,
} from "../calibration/roomCorner";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";

const DEFAULT_SUBDIVISIONS = 4;
const DEFAULT_COLOR = 0x22c55e;

/**
 * Like GridHelper in grid.ts, the wireframe's dimensions are baked into its
 * geometry at construction — a size change needs a rebuild, not a mutation.
 * Cached per node id, rebuilt only when a dimension actually changes, old
 * buffers disposed on replacement.
 */
interface CachedCorner {
  lines: THREE.LineSegments;
  key: string;
}

const cornerCache = createNodeCache<CachedCorner>((c) => disposeObject3D(c.lines));

export function clearRoomCornerCache(nodeId?: string) {
  if (nodeId) {
    const cached = cornerCache.get(nodeId);
    if (cached) {
      cached.lines.geometry.dispose();
      (cached.lines.material as THREE.Material).dispose();
      cornerCache.delete(nodeId);
    }
  } else {
    cornerCache.forEach((cached) => {
      cached.lines.geometry.dispose();
      (cached.lines.material as THREE.Material).dispose();
    });
    cornerCache.clear();
  }
}

function getCornerLines(
  nodeId: string,
  dimensions: RoomCornerDimensions,
  subdivisions: number,
  color: THREE.Color,
): THREE.LineSegments {
  const key = `${dimensions.width}|${dimensions.height}|${dimensions.depth}|${subdivisions}`;
  const cached = cornerCache.get(nodeId);
  if (cached && cached.key === key) {
    (cached.lines.material as THREE.LineBasicMaterial).color.copy(color);
    return cached.lines;
  }
  if (cached) {
    cached.lines.geometry.dispose();
    (cached.lines.material as THREE.Material).dispose();
  }

  const points: THREE.Vector3[] = [];
  for (const [a, b] of roomCornerEdges(dimensions, subdivisions)) points.push(a, b);
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color }),
  );
  cornerCache.set(nodeId, { lines, key });
  return lines;
}

export function readRoomCornerDimensions(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
): RoomCornerDimensions {
  const read = (key: keyof RoomCornerDimensions) => {
    const value = Number(inputs[key] ?? params[key]);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_ROOM_CORNER[key];
  };
  return { width: read("width"), height: read("height"), depth: read("depth") };
}

/**
 * The calibration target: the corner of the real room, measured with a tape
 * and typed in. Wire it into Merge alongside the scene to see the reference
 * wireframe over the content, then use the Camera node's calibration overlay
 * to drag each corner handle onto the matching physical corner.
 *
 * Three tape measurements is the whole setup cost, and it is what turns the
 * dragged handles into *known* 3D coordinates — which is the difference
 * between a solve that recovers the projector's real position and one that
 * can only guess at its orientation (see dlt.ts).
 */
export const ROOM_CORNER_NODE: NodeDefinition = {
  type: "calibration/room_corner",
  label: "Room Corner",
  category: "camera",
  inputs: [
    { id: "width", label: "Width (m)", type: "value" },
    { id: "height", label: "Height (m)", type: "value" },
    { id: "depth", label: "Depth (m)", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "points", label: "Ref Points", type: "list" },
  ],
  defaultParams: {
    width: DEFAULT_ROOM_CORNER.width,
    height: DEFAULT_ROOM_CORNER.height,
    depth: DEFAULT_ROOM_CORNER.depth,
    subdivisions: DEFAULT_SUBDIVISIONS,
    color: new THREE.Color(DEFAULT_COLOR),
  },
  paramFields: [
    { id: "width", label: "Wall A width (m)", kind: "number", step: 0.05 },
    { id: "height", label: "Ceiling height (m)", kind: "number", step: 0.05 },
    { id: "depth", label: "Wall B width (m)", kind: "number", step: 0.05 },
    { id: "subdivisions", label: "Grid divisions", kind: "number", step: 1 },
    { id: "color", label: "Color", kind: "color" },
  ],
  evaluate: (inputs, params, ctx) => {
    const dimensions = readRoomCornerDimensions(inputs, params);
    const subdivisions = Math.max(0, Math.floor(Number(params.subdivisions) || DEFAULT_SUBDIVISIONS));
    const color = params.color instanceof THREE.Color ? params.color : new THREE.Color(DEFAULT_COLOR);
    return {
      geometry: getCornerLines(ctx.nodeId, dimensions, subdivisions, color),
      // Wire this into the Camera node's Ref Points — it is what turns each
      // dragged handle into a known 3D coordinate, and so what makes the
      // solve recover position rather than only orientation.
      points: roomCornerReferencePoints(dimensions),
    };
  },
};
