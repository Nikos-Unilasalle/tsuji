import { canConnectSockets } from "./socketCoercion";
import type { SocketType } from "./sockets";
import { SocketDef } from "./sockets";

/**
 * Blender's "drag a node onto a wire, hold a modifier, drop" — the wire
 * splices around the dropped node instead of just sitting underneath it.
 * Split into pure geometry/matching here (easy to test without a DOM or a
 * react-flow instance) and the react-flow wiring in GraphEditor.tsx, same
 * split as transformLookup.ts/dynamicInputs.ts use for their own
 * flow-adjacent logic.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Cohen-Sutherland-style outcode clipping, specialised to "does this segment
 * cross this rect at all" rather than computing the clipped segment. A wire
 * is drawn as a curve in the UI, but its two nodes' positions are all the
 * data available here — the straight line between them is what the dragged
 * node has to land on, which matches what the operator actually sees well
 * enough for a drop heuristic.
 */
export function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;

  // Either endpoint already inside the rect.
  const inside = (p: Point) => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
  if (inside(a) || inside(b)) return true;

  // Both endpoints on the same outer side of the rect: cannot cross it.
  if ((a.x < left && b.x < left) || (a.x > right && b.x > right)) return false;
  if ((a.y < top && b.y < top) || (a.y > bottom && b.y > bottom)) return false;

  // Otherwise test the segment against each of the rect's four edges.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const crosses = (p1: Point, p2: Point): boolean => {
    const d1 = (p1.y - a.y) * dx - (p1.x - a.x) * dy;
    const d2 = (p2.y - a.y) * dx - (p2.x - a.x) * dy;
    // The rect edge's two corners fall on opposite sides of the wire line,
    // AND the wire's own two endpoints fall on opposite sides of the rect
    // edge's line — both have to hold for the segments to actually cross,
    // not just their infinite extensions.
    if ((d1 > 0 && d2 > 0) || (d1 < 0 && d2 < 0)) return false;
    const ex = p2.x - p1.x;
    const ey = p2.y - p1.y;
    const e1 = (a.y - p1.y) * ex - (a.x - p1.x) * ey;
    const e2 = (b.y - p1.y) * ex - (b.x - p1.x) * ey;
    return !((e1 > 0 && e2 > 0) || (e1 < 0 && e2 < 0));
  };

  return (
    crosses({ x: left, y: top }, { x: right, y: top }) ||
    crosses({ x: right, y: top }, { x: right, y: bottom }) ||
    crosses({ x: right, y: bottom }, { x: left, y: bottom }) ||
    crosses({ x: left, y: bottom }, { x: left, y: top })
  );
}

/**
 * The socket a wire of `type` should land on — mirrors GraphEditor's own
 * isValidConnection rule: the same type first, then "any", then a shape
 * that converts on the wire (points ↔ mesh, curve ↔ list).
 */
export function findCompatibleSocket(sockets: SocketDef[], type: string): SocketDef | null {
  return (
    sockets.find((s) => s.type === type) ??
    sockets.find((s) => s.type === "any" || type === "any") ??
    sockets.find((s) => canConnectSockets(type as SocketType, s.type) || canConnectSockets(s.type, type as SocketType)) ??
    null
  );
}
