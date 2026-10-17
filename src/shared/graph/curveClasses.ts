import * as THREE from "three";

/**
 * The curve classes tsuji's curve nodes build, and the way back from their
 * toJSON(): Curve to Mesh hands `curve.toJSON()` to the geometry worker
 * (offthread/curveTube.ts), which rebuilds the curve here and sweeps it.
 * No node registry imports — the worker loads this module.
 */

export const WORLD_DOWN = new THREE.Vector3(0, -1, 0);

/**
 * A straight segment between two points that droops under its own weight,
 * like a slack wire strung pole-to-pole — a parabolic approximation of a
 * catenary (exact enough at the sag depths this is used for, and far
 * cheaper than solving one). `sag` is a world-unit droop depth, peaking at
 * the segment's midpoint (t=0.5) and zero at both endpoints, so the two
 * points the segment was built from are exactly where the curve still meets
 * them — only the interior sags. Real gravity doesn't care which way a wire
 * happens to run, so this always droops toward world -Y, never a direction
 * derived from the segment itself — but the curve's own points are defined
 * in the node's LOCAL space, evaluated before its pose (location/rotation/
 * scale) is applied downstream. `down` is world -Y pre-rotated into that
 * local space (see the two curve-producing nodes' evaluate()), so the droop
 * still lands on world -Y once the node's own transform is applied — a web
 * tilted 90° sags sideways in its own local frame precisely so it sags
 * *down* once rendered, instead of drooping along whatever local axis -Y
 * happened to rotate onto.
 */
export class SaggedLineCurve3 extends THREE.Curve<THREE.Vector3> {
  constructor(
    private v1: THREE.Vector3,
    private v2: THREE.Vector3,
    private sag: number,
    private down: THREE.Vector3 = WORLD_DOWN,
  ) {
    super();
    // toJSON() carries this, so curveFromJSON can tell the subclass apart from a bare Curve.
    (this as { type: string }).type = "SaggedLineCurve3";
  }

  getPoint(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    target.lerpVectors(this.v1, this.v2, t);
    target.addScaledVector(this.down, this.sag * 4 * t * (1 - t));
    return target;
  }

  // THREE.Curve's own toJSON() only ever serializes {metadata, arcLengthDivisions}
  // — v1/v2/sag/down are unknown to it, since it has no idea a subclass exists.
  // Curve to Mesh's rebuild guard is keyed on JSON.stringify(curve.toJSON())
  // (see CURVE_TO_MESH_NODE's `signature`), so without this override every
  // frame's sag value produced byte-identical JSON: the tube mesh never
  // rebuilt while animating Sag (or Rotation, which now also feeds `down`),
  // even though the curve itself (and its own preview line, which resamples
  // fresh every frame instead of diffing a signature) visibly moved.
  toJSON(): THREE.CurveJSON & { v1: number[]; v2: number[]; sag: number; down: number[] } {
    return { ...super.toJSON(), v1: this.v1.toArray(), v2: this.v2.toArray(), sag: this.sag, down: this.down.toArray() };
  }
}

/**
 * Wraps a base curve, radially rescaling every sampled point around the
 * curve's own local origin: a point at distance d along direction u becomes
 * u * (d*scale + offset) — the curve-space equivalent of Instance
 * Transform's per-instance Scale/Position, but applied *before* a tube gets
 * built around it instead of after. Scaling/offsetting a curve keeps
 * whatever Thickness Curve to Mesh / Curves to Meshes gives it untouched,
 * since the tube is built fresh from the already-moved points; transforming
 * a finished tube MESH stretches its cross-section right along with its
 * radius — see CURVE_ARRAY_NODE, built precisely to avoid that coupling.
 * `offset` is a world-unit push along each point's own direction from the
 * origin, independent of the base curve's own size — unlike `scale`, it
 * doesn't need dividing by the base radius by hand to get an exact spacing.
 */
export class RadialOffsetCurve3 extends THREE.Curve<THREE.Vector3> {
  constructor(
    private base: THREE.Curve<THREE.Vector3>,
    private scale: number,
    private offset: number,
  ) {
    super();
    (this as { type: string }).type = "RadialOffsetCurve3";
  }

  getPoint(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    this.base.getPoint(t, target);
    const d = target.length();
    // A point sitting on the curve's own origin has no direction to push
    // along — leave it there rather than dividing by zero.
    if (d < 1e-9) return target;
    target.multiplyScalar((d * this.scale + this.offset) / d);
    return target;
  }

  // Same reasoning as SaggedLineCurve3's own override above: the rebuild
  // guard downstream (Curves to Meshes' `signature`) is keyed on
  // JSON.stringify(curve.toJSON()), and the default toJSON() has no idea
  // `base`/`scale`/`offset` exist.
  toJSON(): THREE.CurveJSON & { base: unknown; scale: number; offset: number } {
    return { ...super.toJSON(), base: this.base.toJSON(), scale: this.scale, offset: this.offset };
  }
}

type CurveJSON = { type?: string; arcLengthDivisions?: number; [key: string]: unknown };

const vec3 = (a: unknown) => new THREE.Vector3().fromArray(a as number[]);

/** Three's own curves whose fromJSON restores everything getPoint reads. */
const BUILT_IN: Record<string, () => THREE.Curve<THREE.Vector3>> = {
  LineCurve3: () => new THREE.LineCurve3(),
  QuadraticBezierCurve3: () => new THREE.QuadraticBezierCurve3(),
  CubicBezierCurve3: () => new THREE.CubicBezierCurve3(),
  CatmullRomCurve3: () => new THREE.CatmullRomCurve3(),
};

/**
 * Whether `curveFromJSON` can rebuild this exactly. False for any curve class
 * it does not know (a bare `Curve` subclass serializes only its metadata), so
 * the caller can sweep the live curve instead.
 */
export function canRebuildCurve(json: unknown): boolean {
  const j = json as CurveJSON | null;
  if (!j || typeof j.type !== "string") return false;
  if (j.type in BUILT_IN || j.type === "SaggedLineCurve3") return true;
  if (j.type === "RadialOffsetCurve3") return canRebuildCurve(j.base);
  if (j.type === "CurvePath") return Array.isArray(j.curves) && (j.curves as unknown[]).every(canRebuildCurve);
  return false;
}

/** The curve `json` (a `curve.toJSON()`) was serialized from; throws on a type canRebuildCurve rejects. */
export function curveFromJSON(json: unknown): THREE.Curve<THREE.Vector3> {
  const j = json as CurveJSON;
  let curve: THREE.Curve<THREE.Vector3>;
  const make = j.type ? BUILT_IN[j.type] : undefined;
  if (make) {
    curve = make().fromJSON(j as never);
  } else if (j.type === "SaggedLineCurve3") {
    curve = new SaggedLineCurve3(vec3(j.v1), vec3(j.v2), j.sag as number, vec3(j.down));
  } else if (j.type === "RadialOffsetCurve3") {
    curve = new RadialOffsetCurve3(curveFromJSON(j.base), j.scale as number, j.offset as number);
  } else if (j.type === "CurvePath") {
    // Not CurvePath.fromJSON: that only knows three's own classes.
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.autoClose = Boolean(j.autoClose);
    for (const part of j.curves as unknown[]) path.add(curveFromJSON(part));
    curve = path;
  } else {
    throw new Error(`curveFromJSON: cannot rebuild a ${String(j.type)}`);
  }
  if (typeof j.arcLengthDivisions === "number") curve.arcLengthDivisions = j.arcLengthDivisions;
  return curve;
}
