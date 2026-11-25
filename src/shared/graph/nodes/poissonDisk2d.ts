import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import { ExpressionError } from "../../math/expression";
import { bounds, directionField, poissonDisk } from "../voronoi2dLayout";
import { cachedExpression, formulaErrorField } from "./expression";
import { numberInput } from "./object";
import { asPlane, GUIDES_INPUT, hashNumbers, makeStretch, readPolylines, PLANE_FIELD, sampleOutline, STRETCH_FIELDS, to2, to3, vectorNumbers } from "./voronoi2dShared";

/** What a spacing formula may read: the point (x, y in the plane; u, v as 0–1 across the outline), s and a–d. */
const SPACING_VARIABLES = ["x", "y", "u", "v", "s", "a", "b", "c", "d"] as const;

const FIELDS: ParamFieldDef[] = [
  { ...PLANE_FIELD, group: "Scatter" },
  { id: "spacing", label: "Spacing s", kind: "number", step: 0.01, group: "Scatter" },
  { id: "formula", label: "Spacing Formula", kind: "text", group: "Scatter" },
  { id: "a", label: "a", kind: "number", step: 0.1, group: "Parameters" },
  { id: "b", label: "b", kind: "number", step: 0.1, group: "Parameters" },
  { id: "c", label: "c", kind: "number", step: 0.1, group: "Parameters" },
  { id: "d", label: "d", kind: "number", step: 0.1, group: "Parameters" },
  { id: "seed", label: "Seed", kind: "number", step: 1, group: "Scatter" },
  ...STRETCH_FIELDS.map((f) => ({ ...f, group: "Scatter" })),
  { id: "maxPoints", label: "Max Points", kind: "number", step: 500, group: "Scatter" },
  { id: "boundarySamples", label: "Boundary Samples", kind: "number", step: 16, group: "Scatter" },
  {
    id: "formulaHelp",
    label: "Spacing between points at (x, y). u, v run 0–1 across the outline's width and height; s is Spacing. E.g. s·(1 − 0.6u) packs points tighter toward u = 1.",
    kind: "note",
  },
];

interface PoissonState {
  signature?: string;
  points?: THREE.Vector3[];
}

const poissonCache = createNodeCache<PoissonState>();

/**
 * Poisson Disk 2D — evenly spread random points filling a closed outline, no
 * two closer than the spacing: the even-but-not-gridded scatter of cells,
 * pores, trees in a field or inhibitory centres in a growing wing. The
 * spacing is a formula of position, so the points can thin out or crowd in
 * across the shape. Same seed, same points.
 */
export const POISSON_DISK_2D_NODE: NodeDefinition = {
  type: "list/poisson-disk-2d",
  label: "Poisson Disk 2D",
  category: "instance",
  ownershipPassThrough: true,
  pure: true,
  inputs: [
    { id: "boundary", label: "Boundary (closed curve)", type: "curve" },
    { id: "spacing", label: "Spacing s", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "a", label: "a", type: "value" },
    { id: "b", label: "b", type: "value" },
    GUIDES_INPUT,
  ],
  outputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    plane: "XY",
    spacing: 0.1,
    formula: "s",
    a: 1,
    b: 1,
    c: 0,
    d: 0,
    seed: 1,
    stretch: 1,
    stretchAngle: 0,
    stretchFollow: false,
    maxPoints: 5000,
    boundarySamples: 160,
  },
  paramFields: FIELDS,
  dynamicParamFields: (instance) => [...FIELDS, ...formulaErrorField("formula", instance.params.formula, SPACING_VARIABLES)],
  evaluate: (inputs, params, ctx) => {
    let state = poissonCache.get(ctx.nodeId);
    if (!state) poissonCache.set(ctx.nodeId, (state = {}));
    const plane = asPlane(params.plane);
    const s = Math.max(1e-6, numberInput(inputs.spacing, params.spacing, 0.1));
    const seed = Math.round(numberInput(inputs.seed, params.seed, 1));
    const maxPoints = Math.max(1, Math.min(50000, Math.round(numberInput(undefined, params.maxPoints, 5000))));
    const samples = Math.max(8, Math.min(4096, Math.round(numberInput(undefined, params.boundarySamples, 160))));
    const coeffs = ["a", "b", "c", "d"].map((k) => numberInput(inputs[k], params[k], 0));
    const formula = String(params.formula ?? "s").trim() || "s";
    const outline3 = sampleOutline(inputs.boundary, samples);
    const stretchK = Math.max(0.05, Math.min(20, numberInput(undefined, params.stretch, 1)));
    const stretchAngle = numberInput(undefined, params.stretchAngle, 0);
    const guides3 = readPolylines(inputs.guides, 64);
    const follow = Boolean(params.stretchFollow) && guides3.length > 0;

    const signature = `${plane}|${s}|${seed}|${maxPoints}|${coeffs.join(",")}|${formula}|${stretchK}|${stretchAngle}|${follow}|${hashNumbers(vectorNumbers(guides3))}|${hashNumbers(vectorNumbers([outline3]))}`;
    if (signature !== state.signature || !state.points) {
      state.signature = signature;
      const outline = outline3.map((p) => to2(p, plane));
      const compiled = cachedExpression(formula, SPACING_VARIABLES);
      let spacing: (x: number, y: number) => number = () => s;
      if (!(compiled instanceof ExpressionError) && outline.length >= 3) {
        const box = bounds(outline);
        const w = Math.max(1e-9, box.x1 - box.x0);
        const h = Math.max(1e-9, box.y1 - box.y0);
        const scope: Record<string, number> = { s, a: coeffs[0], b: coeffs[1], c: coeffs[2], d: coeffs[3], x: 0, y: 0, u: 0, v: 0 };
        const out: number[] = [];
        spacing = (x, y) => {
          scope.x = x;
          scope.y = y;
          scope.u = (x - box.x0) / w;
          scope.v = (y - box.y0) / h;
          return compiled.evaluate(scope, out)[0];
        };
      }
      // Laid out evenly in a squeezed copy of the plane, then mapped back: gaps
      // come out `stretch` times longer along the direction. The formula still
      // reads true positions.
      const st = makeStretch(follow ? 1 : stretchK, stretchAngle);
      const inPlane = spacing;
      const squeezed = (x: number, y: number) => {
        const [rx, ry] = st.inv([x, y]);
        return inPlane(rx, ry);
      };
      const aniso = follow ? { k: stretchK, angleAt: directionField(guides3.map((g) => g.map((p) => to2(p, plane)))) } : undefined;
      state.points = poissonDisk(outline.map(st.fwd), squeezed, seed, maxPoints, 24, aniso).map((p) => to3(st.inv(p), 0, plane));
    }
    return { points: state.points, count: state.points.length };
  },
};
