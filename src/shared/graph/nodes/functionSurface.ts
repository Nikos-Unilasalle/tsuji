import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { NodeDefinition, NodeInstance, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { asColor, clockInput, numberInput } from "./object";
import { readSpace } from "../mathSpace";
import { ExpressionError } from "../../math/expression";
import { cachedExpression, formulaErrorField } from "./expression";

const MODES = ["height", "parametric"] as const;
type Mode = (typeof MODES)[number];

const VARIABLES: Record<Mode, string[]> = {
  height: ["x", "y", "t", "a", "b", "c", "d"],
  parametric: ["u", "v", "t", "a", "b", "c", "d"],
};

interface SurfaceState {
  root: THREE.Group;
  mesh: THREE.Mesh;
  grid: LineSegments2;
  gridMaterial: LineMaterial;
  signature?: string;
  /** Grid size the buffers were allocated for. */
  layout?: string;
  points: THREE.Vector3[];
}

const surfaceCache = createNodeCache<SurfaceState>((s) => disposeObject3D(s.root));

function surfaceState(nodeId: string): SurfaceState {
  let state = surfaceCache.get(nodeId);
  if (state) return state;
  const root = new THREE.Group();
  root.userData.nodeId = nodeId;
  const mesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  );
  const gridMaterial = new LineMaterial({ color: 0x2b3440, linewidth: 1 });
  const grid = new LineSegments2(new LineSegmentsGeometry(), gridMaterial);
  for (const o of [mesh, grid]) {
    o.userData.nodeId = nodeId;
    o.frustumCulled = false;
    root.add(o);
  }
  state = { root, mesh, grid, gridMaterial, points: [] };
  surfaceCache.set(nodeId, state);
  return state;
}

export interface SurfaceSamples {
  nu: number;
  nv: number;
  /** Math-space points, (nu+1)(nv+1), u fastest. NaN where undefined or cut. */
  math: Float64Array;
}

/** Evaluates the surface on its grid, marking points outside the z window or not numbers as NaN. */
export function sampleSurface(
  mode: Mode,
  evaluate: (scope: Record<string, number>, out: number[]) => number[],
  scope: Record<string, number>,
  u0: number, u1: number, v0: number, v1: number,
  nu: number, nv: number,
  zMin: number, zMax: number,
): SurfaceSamples {
  const math = new Float64Array((nu + 1) * (nv + 1) * 3);
  const out = [0, 0, 0];
  for (let j = 0; j <= nv; j++) {
    const v = v0 + ((v1 - v0) * j) / nv;
    for (let i = 0; i <= nu; i++) {
      const u = u0 + ((u1 - u0) * i) / nu;
      out[0] = out[1] = out[2] = 0;
      let x: number, y: number, z: number;
      if (mode === "height") {
        scope.x = u;
        scope.y = v;
        x = u; y = v; z = evaluate(scope, out)[0];
      } else {
        scope.u = u;
        scope.v = v;
        const r = evaluate(scope, out);
        x = r[0] ?? 0; y = r[1] ?? 0; z = r[2] ?? 0;
      }
      const k = (j * (nu + 1) + i) * 3;
      const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && z >= zMin && z <= zMax;
      math[k] = ok ? x : NaN;
      math[k + 1] = ok ? y : NaN;
      math[k + 2] = ok ? z : NaN;
    }
  }
  return { nu, nv, math };
}

const low = new THREE.Color();
const high = new THREE.Color();
const tint = new THREE.Color();
const p = new THREE.Vector3();

const FIELDS: ParamFieldDef[] = [
  { id: "mode", label: "Kind", kind: "select", options: [...MODES], optionLabels: ["z = f(x, y)", "Parametric (x(u,v), y(u,v), z(u,v))"], group: "Formula" },
  { id: "formula", label: "Formula", kind: "text", group: "Formula" },
  { id: "uMin", label: "x / u from", kind: "number", step: 0.5, group: "Formula" },
  { id: "uMax", label: "x / u to", kind: "number", step: 0.5, group: "Formula" },
  { id: "vMin", label: "y / v from", kind: "number", step: 0.5, group: "Formula" },
  { id: "vMax", label: "y / v to", kind: "number", step: 0.5, group: "Formula" },
  { id: "resolution", label: "Resolution (cells per side)", kind: "number", step: 8, group: "Formula" },
  { id: "zMin", label: "Cut below z", kind: "number", step: 1, group: "Formula" },
  { id: "zMax", label: "Cut above z", kind: "number", step: 1, group: "Formula" },
  { id: "a", label: "a (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "b", label: "b (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "c", label: "c (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "d", label: "d (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "progress", label: "Drawn (0–1, row by row)", kind: "number", step: 0.05, group: "Style" },
  { id: "colorLow", label: "Color (low)", kind: "color", group: "Style" },
  { id: "colorHigh", label: "Color (high)", kind: "color", group: "Style" },
  { id: "opacity", label: "Opacity", kind: "number", step: 0.05, group: "Style" },
  { id: "gridLines", label: "Grid Lines (every n cells, 0 = none)", kind: "number", step: 1, group: "Style" },
  { id: "gridColor", label: "Grid Color", kind: "color", group: "Style" },
  { id: "gridWidth", label: "Grid Width (px)", kind: "number", step: 0.5, group: "Style" },
  { id: "visible", label: "Visible", kind: "boolean", group: "Style" },
];

/**
 * Function Surface — the surface of a formula: z = f(x, y) (a paraboloid,
 * a saddle, any function of two variables) or a parametric surface
 * (x(u,v), y(u,v), z(u,v)) — a sphere, a torus, a Möbius strip. Typed as
 * on paper, with a–d to animate and t as the timeline.
 *
 * Drawn the way a textbook draws it: a plain or low-to-high tinted skin with
 * a grid of lines over it. Wire an Axes' Space (3D) and it stands on those
 * axes, z up. Points outside the z cut, or where the formula is undefined,
 * leave a hole rather than a spike; Drawn unrolls it row by row.
 */
export const FUNCTION_SURFACE_NODE: NodeDefinition = {
  type: "math/function-surface",
  label: "Function Surface",
  category: "math",
  inputs: [
    { id: "space", label: "Space (from Axes)", type: "matrix" },
    { id: "a", label: "a", type: "value" },
    { id: "b", label: "b", type: "value" },
    { id: "c", label: "c", type: "value" },
    { id: "d", label: "d", type: "value" },
    { id: "progress", label: "Drawn (0–1)", type: "value" },
    { id: "t", label: "t (time)", type: "value" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "points", label: "Grid Points", type: "list" },
  ],
  defaultParams: {
    mode: "height",
    formula: "(x² − y²) / 4",
    uMin: -3, uMax: 3, vMin: -3, vMax: 3,
    resolution: 48,
    zMin: -10, zMax: 10,
    a: 1, b: 0, c: 0, d: 0,
    progress: 1,
    colorLow: new THREE.Color(0x4f8fd6),
    colorHigh: new THREE.Color(0xf2b84b),
    opacity: 1,
    gridLines: 4,
    gridColor: new THREE.Color(0x2b3440),
    gridWidth: 1,
    visible: true,
  },
  paramFields: FIELDS,
  dynamicParamFields: (instance: NodeInstance) => {
    const mode = instance.params.mode === "parametric" ? "parametric" : "height";
    return [...formulaErrorField("formula", instance.params.formula, VARIABLES[mode]), ...FIELDS];
  },
  evaluate: (inputs, params, ctx) => {
    const state = surfaceState(ctx.nodeId);
    const mode: Mode = params.mode === "parametric" ? "parametric" : "height";
    const compiled = cachedExpression(String(params.formula ?? ""), VARIABLES[mode]);
    const space = readSpace(inputs.space);
    const scope: Record<string, number> = {
      a: numberInput(inputs.a, params.a, 1),
      b: numberInput(inputs.b, params.b, 0),
      c: numberInput(inputs.c, params.c, 0),
      d: numberInput(inputs.d, params.d, 0),
      t: clockInput(inputs, params, ctx, "t"),
    };
    const n = Math.max(2, Math.min(256, Math.round(numberInput(undefined, params.resolution, 48))));
    const range = [params.uMin, params.uMax, params.vMin, params.vMax].map((v, i) => numberInput(undefined, v, i % 2 ? 3 : -3));
    const zMin = numberInput(undefined, params.zMin, -10);
    const zMax = numberInput(undefined, params.zMax, 10);
    const progress = Math.max(0, Math.min(1, numberInput(inputs.progress, params.progress, 1)));
    const every = Math.max(0, Math.round(numberInput(undefined, params.gridLines, 4)));
    low.copy(asColor(params.colorLow, new THREE.Color(0x4f8fd6)));
    high.copy(asColor(params.colorHigh, new THREE.Color(0xf2b84b)));

    const reads = compiled instanceof ExpressionError ? [] : compiled.variables;
    const live = Object.fromEntries(Object.entries(scope).filter(([k]) => reads.includes(k)));
    const signature = JSON.stringify([params.formula, mode, live, n, range, zMin, zMax, progress, every, space.elements, low.getHex(), high.getHex()]);
    if (state.signature !== signature) {
      state.signature = signature;
      const samples = compiled instanceof ExpressionError
        ? null
        : sampleSurface(mode, (s, out) => compiled.evaluate(s, out), scope, range[0], range[1], range[2], range[3], n, n, Math.min(zMin, zMax), Math.max(zMin, zMax));
      rebuild(state, samples, n, space, progress, every);
    }

    const material = state.mesh.material as THREE.MeshStandardMaterial;
    const opacity = Math.max(0, Math.min(1, numberInput(undefined, params.opacity, 1)));
    material.opacity = opacity;
    if (material.transparent !== opacity < 1) {
      material.transparent = opacity < 1;
      material.needsUpdate = true;
    }
    state.gridMaterial.color.copy(asColor(params.gridColor, new THREE.Color(0x2b3440)));
    state.gridMaterial.linewidth = Math.max(0.1, numberInput(undefined, params.gridWidth, 1));
    const size = new THREE.Vector2(1920, 1080);
    if (ctx.renderer) {
      ctx.renderer.getSize(size);
      if (size.x <= 0 || size.y <= 0) size.set(1920, 1080);
    }
    state.gridMaterial.resolution.copy(size);
    state.root.visible = toBoolean(inputs.visible ?? params.visible ?? true);
    return { geometry: state.root, points: state.points };
  },
};

function rebuild(state: SurfaceState, samples: SurfaceSamples | null, n: number, space: THREE.Matrix4, progress: number, every: number): void {
  const count = (n + 1) * (n + 1);
  const layout = `${n}`;
  const geometry = state.mesh.geometry;
  if (state.layout !== layout) {
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    state.layout = layout;
  }
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const col = geometry.getAttribute("color") as THREE.BufferAttribute;
  state.points.length = 0;
  if (!samples) {
    geometry.setIndex([]);
    state.grid.visible = false;
    state.mesh.visible = false;
    return;
  }

  // Tint by height across what is actually defined.
  let zLo = Infinity, zHi = -Infinity;
  for (let k = 2; k < samples.math.length; k += 3) {
    const z = samples.math[k];
    if (Number.isFinite(z)) { zLo = Math.min(zLo, z); zHi = Math.max(zHi, z); }
  }
  const span = zHi > zLo ? zHi - zLo : 1;
  const valid = new Uint8Array(count);
  for (let k = 0; k < count; k++) {
    const x = samples.math[k * 3], y = samples.math[k * 3 + 1], z = samples.math[k * 3 + 2];
    valid[k] = Number.isFinite(x) ? 1 : 0;
    if (valid[k]) {
      p.set(x, y, z).applyMatrix4(space);
      pos.setXYZ(k, p.x, p.y, p.z);
      tint.copy(low).lerp(high, (z - zLo) / span);
      col.setXYZ(k, tint.r, tint.g, tint.b);
      state.points.push(p.clone());
    } else {
      pos.setXYZ(k, 0, 0, 0);
    }
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;

  // Drawn: rows appear one after another along v.
  const rows = Math.round(n * progress);
  const index: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      if (valid[a] && valid[b] && valid[c]) index.push(a, b, c);
      if (valid[b] && valid[d] && valid[c]) index.push(b, d, c);
    }
  }
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  state.mesh.visible = index.length > 0;

  const segs: number[] = [];
  if (every > 0) {
    const seg = (a: number, b: number) => {
      if (!valid[a] || !valid[b]) return;
      segs.push(pos.getX(a), pos.getY(a), pos.getZ(a), pos.getX(b), pos.getY(b), pos.getZ(b));
    };
    for (let j = 0; j <= rows; j++) {
      if (j % every !== 0 && j !== rows) continue;
      for (let i = 0; i < n; i++) seg(j * (n + 1) + i, j * (n + 1) + i + 1);
    }
    for (let i = 0; i <= n; i += every) {
      for (let j = 0; j < rows; j++) seg(j * (n + 1) + i, (j + 1) * (n + 1) + i);
    }
  }
  state.grid.geometry.dispose();
  state.grid.geometry = new LineSegmentsGeometry().setPositions(segs.length ? segs : [0, 0, 0, 0, 0, 0]);
  state.grid.visible = segs.length > 0;
}
