import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { clearMeshWarning, warnMeshRequired } from "../meshRequired";
import { worldMatrixOf } from "../objectPosition";
import { nearestOnSegment, P2 } from "../voronoi2d";
import { findFirstMesh } from "./curve";
import { createModifierMesh, emitModifiedMesh, numberInput } from "./object";
import { asPlane, asVec, axisIndex, isCurve, hashNumbers, heightOf, Plane, PLANE_FIELD, readPolylines, to2, vectorNumbers } from "./voronoi2dShared";

interface Guide {
  pts: P2[];
  h: number[];
}

/**
 * The height at p read off the guide lines: each line gives the height of its
 * nearest point, and the `count` nearest lines are blended by inverse distance
 * to the power `power`. With two lines and power 1 the result is exactly
 * linear across the strip between them — flat panels folded along every line,
 * which is what a corrugated insect wing (or a roof, or a terrain from contour
 * lines) is.
 */
export function heightAt(p: P2, guides: Guide[], count: number, power: number): number {
  const near: { d: number; h: number }[] = [];
  for (const g of guides) {
    let best = { d2: Infinity, h: 0 };
    for (let i = 0; i + 1 < g.pts.length; i++) {
      const hit = nearestOnSegment(p, g.pts[i], g.pts[i + 1]);
      if (hit.d2 < best.d2) best = { d2: hit.d2, h: g.h[i] + (g.h[i + 1] - g.h[i]) * hit.t };
    }
    if (g.pts.length === 1) best = { d2: (p[0] - g.pts[0][0]) ** 2 + (p[1] - g.pts[0][1]) ** 2, h: g.h[0] };
    if (Number.isFinite(best.d2)) near.push({ d: Math.sqrt(best.d2), h: best.h });
  }
  if (near.length === 0) return 0;
  near.sort((a, b) => a.d - b.d);
  if (near[0].d < 1e-9) return near[0].h;
  let sw = 0;
  let sh = 0;
  for (const n of near.slice(0, Math.max(1, count))) {
    const w = 1 / Math.pow(n.d, power);
    sw += w;
    sh += w * n.h;
  }
  return sh / sw;
}

const FIELDS: ParamFieldDef[] = [
  PLANE_FIELD,
  { id: "scale", label: "Height Scale", kind: "number", step: 0.1 },
  { id: "offset", label: "Height Offset", kind: "number", step: 0.01 },
  { id: "count", label: "Lines Blended (nearest)", kind: "number", step: 1 },
  { id: "power", label: "Falloff Power", kind: "number", step: 0.25 },
  { id: "curveSamples", label: "Samples per Guide Curve", kind: "number", step: 16 },
];

interface HeightState {
  mesh?: THREE.Mesh;
  signature?: string;
  pointsSignature?: string;
  points?: unknown;
}

const heightCache = createNodeCache<HeightState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

/** Points, point lists or curves (sampled into point lists) with the height axis replaced. */
function liftPoints(value: unknown, at: (p: THREE.Vector3) => THREE.Vector3, curveSamples: number): unknown {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (isCurve(item)) return item.getSpacedPoints(curveSamples).map(at);
    if (Array.isArray(item)) return item.map((p) => { const v = asVec(p); return v ? at(v) : p; });
    const v = asVec(item);
    return v ? at(v) : item;
  });
}

/**
 * Height from Lines — sets the height of a mesh, of points or of point lists
 * from guide lines that carry their own height: each point takes the blended
 * height of the nearest lines. Folds a flat cut-out along a set of creases (a
 * corrugated dragonfly wing from its main veins, a pleated fan, a roof from
 * its ridges and valleys), or builds terrain from contour lines.
 *
 * The plane is read in world space and only the height axis moves: a mesh
 * keeps its pose and material, the points keep their order.
 */
export const HEIGHT_FROM_LINES_NODE: NodeDefinition = {
  type: "geometry/height-from-lines",
  label: "Height from Lines",
  category: "deform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "points", label: "Points / Point Lists / Curves", type: "list" },
    { id: "guides", label: "Guide Lines (curves / point lists)", type: "list" },
    { id: "scale", label: "Height Scale", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "points", label: "Points / Point Lists", type: "list" },
  ],
  defaultParams: { plane: "XY", scale: 1, offset: 0, count: 2, power: 1, curveSamples: 64 },
  paramFields: FIELDS,
  evaluate: (inputs, params, ctx) => {
    let state = heightCache.get(ctx.nodeId);
    if (!state) heightCache.set(ctx.nodeId, (state = {}));
    const plane: Plane = asPlane(params.plane);
    const scale = numberInput(inputs.scale, params.scale, 1);
    const offset = numberInput(undefined, params.offset, 0);
    const count = Math.max(1, Math.min(16, Math.round(numberInput(undefined, params.count, 2))));
    const power = Math.max(0.1, Math.min(8, numberInput(undefined, params.power, 1)));
    const samples = Math.max(2, Math.min(2048, Math.round(numberInput(undefined, params.curveSamples, 64))));
    const lines = readPolylines(inputs.guides, samples);
    const guides: Guide[] = lines.map((l) => ({ pts: l.map((p) => to2(p, plane)), h: l.map((p) => heightOf(p, plane)) }));
    const fieldSig = `${plane}|${scale}|${offset}|${count}|${power}|${hashNumbers(vectorNumbers(lines))}`;
    const at = (p: THREE.Vector3): THREE.Vector3 => {
      const h = guides.length > 0 ? heightAt(to2(p, plane), guides, count, power) * scale + offset : heightOf(p, plane);
      const out = p.clone();
      out.setComponent(axisIndex(plane), h);
      return out;
    };

    let points = state.points;
    const rawPoints = Array.isArray(inputs.points) ? (inputs.points as unknown[]) : [];
    const pointsSig = `${fieldSig}|${samples}|${hashNumbers(vectorNumbers(readPolylines(rawPoints, samples)))}|${rawPoints.length}`;
    if (pointsSig !== state.pointsSignature || points === undefined) {
      state.pointsSignature = pointsSig;
      points = state.points = liftPoints(rawPoints, at, samples);
    }

    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) return { geometry: null, points };
    const srcMesh = findFirstMesh(inputObj);
    const srcGeom = srcMesh?.geometry;
    if (!srcMesh || !srcGeom?.attributes.position) {
      warnMeshRequired(ctx.nodeId, "Height from Lines", inputObj);
      return { geometry: inputObj, matrix: inputObj.matrix.clone(), points };
    }
    clearMeshWarning(ctx.nodeId);

    const world = worldMatrixOf(srcMesh);
    const signature = `${fieldSig}|${srcGeom.uuid}|${(srcGeom.attributes.position as THREE.BufferAttribute).version ?? 0}|${world.elements.join(",")}`;
    let geometry: THREE.BufferGeometry | undefined;
    if (signature !== state.signature || !state.mesh) {
      state.signature = signature;
      geometry = srcGeom.clone();
      if (guides.length > 0) {
        const pos = geometry.attributes.position as THREE.BufferAttribute;
        const inv = world.clone().invert();
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(world);
          const lifted = at(v).applyMatrix4(inv);
          pos.setXYZ(i, lifted.x, lifted.y, lifted.z);
        }
        pos.needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
      }
    }
    if (!state.mesh) state.mesh = createModifierMesh();
    return { ...emitModifiedMesh(state.mesh, { inputObj, srcMesh, geometry, nodeId: ctx.nodeId }), points };
  },
};
