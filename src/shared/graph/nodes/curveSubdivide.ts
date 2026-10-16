import * as THREE from "three";
import { NodeDefinition } from "../types";
import { asVector3 } from "./transform";

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Curve Subdivide — inserts new points between each pair of consecutive
 * input points, the list-level counterpart of subdividing an edge loop: the
 * original points stay exactly where they were, only the gaps get denser.
 *
 * "Linear" inserts are a straight lerp per segment. "Catmull" samples a
 * CatmullRomCurve3 built through the whole input list instead of lerping —
 * a new point then lands *on* the smooth curve between its two neighbours,
 * not on the straight chord, which is what "subdivide" should mean for a
 * curve that isn't actually straight. This relies on CatmullRomCurve3's own
 * uniform per-segment parameterization (segment i of an open n-point curve
 * spans exactly t in [i/(n-1), (i+1)/(n-1)], or [i/n, (i+1)/n] closed) — the
 * one guarantee that makes "sample between two known anchors" reliable
 * without needing the curve to expose its own segment boundaries.
 */
export const CURVE_SUBDIVIDE_NODE: NodeDefinition = {
  type: "curve/subdivide",
  label: "Curve Subdivide",
  category: "curve",
  pure: true,
  inputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "subdivisions", label: "Subdivisions", type: "value" },
  ],
  outputs: [{ id: "points", label: "Points", type: "list" }],
  defaultParams: {
    subdivisions: 1,
    closed: false,
    type: "catmull",
    tension: 0.5,
  },
  paramFields: [
    { id: "subdivisions", label: "Subdivisions per Segment", kind: "number", step: 1 },
    { id: "type", label: "Type", kind: "select", options: ["catmull", "linear"] },
    { id: "tension", label: "Tension", kind: "number", step: 0.05 },
    { id: "closed", label: "Closed (also subdivide the last -> first gap)", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const pts = Array.isArray(inputs.points) ? (inputs.points as unknown[]).map((p) => asVector3(p, new THREE.Vector3())) : [];
    const subdivisions = Math.max(
      0,
      Math.round(inputs.subdivisions !== undefined ? asNumber(inputs.subdivisions, 1) : asNumber(params.subdivisions, 1)),
    );
    const closed = Boolean(params.closed);
    const type = String(params.type || "catmull");
    const n = pts.length;

    if (n < 2 || subdivisions === 0) return { points: pts };

    const segmentCount = closed ? n : n - 1;
    const denom = closed ? n : n - 1;
    const curve = type === "linear" ? null : new THREE.CatmullRomCurve3(pts, closed, "catmullrom", asNumber(params.tension, 0.5));

    const out: THREE.Vector3[] = [];
    for (let i = 0; i < segmentCount; i++) {
      out.push(pts[i]);
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const t0 = i / denom;
      const t1 = (i + 1) / denom;
      for (let k = 1; k <= subdivisions; k++) {
        const f = k / (subdivisions + 1);
        out.push(curve ? curve.getPoint(t0 + f * (t1 - t0)) : a.clone().lerp(b, f));
      }
    }
    if (!closed) out.push(pts[n - 1]);

    return { points: out };
  },
};
