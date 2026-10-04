import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import { getCurveNodePose } from "../curvePoseStore";
import { createPRNG } from "../../math/random";
import { valueNoise3 } from "../../math/valueNoise";
import { Curve3, curvePlane, curvesSignature, flattenCurves, fromPlane, strokeSamples, toPlane } from "../curveLists";
import { asColor, COMMON_DEFAULT_PARAMS, extractMaterialParams, NATIVE_TRANSFORM_PARAM_FIELDS, primitiveOutputs } from "./object";
import { composeNativeMatrix } from "./transform";

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

interface InkState {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  curvesRef?: unknown;
  curvesSig?: string;
  signature?: string;
}

const disposeInk = (s: InkState) => {
  s.mesh.geometry.dispose();
  s.mesh.material.dispose();
};

function getInkState(cache: Map<string, InkState>, nodeId: string, transparent: boolean): InkState {
  let state = cache.get(nodeId);
  if (!state) {
    // Flat ink is unlit and drawn from both sides: a drawing seen from behind
    // is still the drawing. Fills write depth so they hide what lies behind
    // them; strokes are translucent washes that only test it.
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent, depthWrite: !transparent, vertexColors: true });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.matrixAutoUpdate = false;
    mesh.userData.nodeId = nodeId;
    state = { mesh };
    cache.set(nodeId, state);
  }
  return state;
}

/**
 * The curves to draw, and a signature that only changes when they do. An
 * upstream node that rebuilds its list every frame (a Random List feeding a
 * Curve from Points, say) hands over a new array each time; comparing values
 * rather than references keeps that from rebuilding the mesh 60 times a
 * second. The reference check comes first because it is free.
 */
function readCurves(state: InkState, inputs: Record<string, unknown>): { curves: Curve3[]; sig: string } {
  const ref = [inputs.curve, inputs.curves];
  const sameRef = Array.isArray(state.curvesRef) && state.curvesRef[0] === ref[0] && state.curvesRef[1] === ref[1];
  const curves = flattenCurves(inputs.curve, inputs.curves);
  if (sameRef && state.curvesSig !== undefined) return { curves, sig: state.curvesSig };
  state.curvesRef = ref;
  state.curvesSig = curvesSignature(curves);
  return { curves, sig: state.curvesSig };
}

/**
 * Native pose × the pose of the curve node wired into `curve`, the same
 * composition as Curve to Line: the ink follows its curve's gizmo while its
 * geometry stays in the curve's local space. Skipped while the gizmo is
 * dragging this node, so the drag is not fought every frame.
 */
function placeMesh(
  mesh: THREE.Object3D,
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: { nodeId: string; liveEditNodeId?: string | null; inputSources?: ReadonlyMap<string, string> },
) {
  if (ctx.nodeId === ctx.liveEditNodeId) return;
  mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
  const source = ctx.inputSources?.get("curve");
  const pose = source ? getCurveNodePose(source) : undefined;
  if (pose) mesh.matrix.multiply(pose);
  mesh.matrixWorldNeedsUpdate = true;
}

const TRANSFORM_DEFAULTS = {
  visible: COMMON_DEFAULT_PARAMS.visible,
  location: COMMON_DEFAULT_PARAMS.location,
  rotation: COMMON_DEFAULT_PARAMS.rotation,
  scale: COMMON_DEFAULT_PARAMS.scale,
  showPivot: COMMON_DEFAULT_PARAMS.showPivot,
  pivot: COMMON_DEFAULT_PARAMS.pivot,
  inheritRotation: COMMON_DEFAULT_PARAMS.inheritRotation,
  inheritScale: COMMON_DEFAULT_PARAMS.inheritScale,
};

const INK_INPUTS = [
  { id: "curve", label: "Curve", type: "curve" as const },
  { id: "curves", label: "Curves (List)", type: "list" as const },
  { id: "material", label: "Material", type: "material" as const },
  { id: "color", label: "Color", type: "color" as const },
  { id: "opacity", label: "Opacity", type: "value" as const },
];

const INK_TRAILING_INPUTS = [
  { id: "matrix", label: "Matrix", type: "matrix" as const },
  { id: "visible", label: "Visible", type: "value" as const },
];

const INK_OUTPUTS = [
  { id: "geometry", label: "Geometry", type: "geometry" as const },
  { id: "matrix", label: "Matrix", type: "matrix" as const },
];

/** Colour and opacity: a wired Material node wins, as on every other drawn object. */
function applyInk(material: THREE.MeshBasicMaterial, inputs: Record<string, unknown>, params: Record<string, unknown>) {
  const matParams = extractMaterialParams(inputs, params);
  material.color.copy(matParams.color);
  material.opacity = matParams.opacity;
}

/* -------------------------------------------------------------------------- */
/* Ink Stroke                                                                 */
/* -------------------------------------------------------------------------- */

const PROFILES = ["sine", "blob", "taper", "uniform"] as const;

function profileAt(kind: string, t: number): number {
  if (kind === "uniform") return 1;
  if (kind === "taper") return Math.cos((t * Math.PI) / 2);
  const s = Math.max(0, Math.sin(t * Math.PI));
  return kind === "blob" ? Math.sqrt(s) : s;
}

interface StrokeOptions {
  width: number;
  minWidth: number;
  profile: string;
  widthNoise: number;
  wobble: number;
  wobbleScale: number;
  alphaJitter: number;
  zOffset: number;
  seed: number;
}

/**
 * Every curve as a flat ribbon whose half-width follows the profile and
 * breathes with noise — Shan Shui's stroke(), which is what makes a polyline
 * read as a brush mark. Each ribbon lies in its own curve's drawing plane, and
 * Depth Offset lifts it towards the viewer of that plane, so ink drawn over a
 * Curve Fill of the same curve sits in front of it.
 */
export function buildStrokeGeometry(curves: Curve3[], o: StrokeOptions): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rng = createPRNG(o.seed * 7919 + 11);
  for (const curve of curves) {
    const pts = strokeSamples(curve);
    const n = pts.length;
    if (n < 2) continue;
    const plane = curvePlane(pts);
    const flat = pts.map((p) => toPlane(plane, p));
    const n0 = rng() * 100;
    const alpha = 1 - o.alphaJitter * rng();
    const base = positions.length / 3;
    for (let i = 0; i < n; i++) {
      const prev = flat[Math.max(0, i - 1)];
      const next = flat[Math.min(n - 1, i + 1)];
      let tu = next[0] - prev[0];
      let tv = next[1] - prev[1];
      const len = Math.hypot(tu, tv) || 1;
      tu /= len;
      tv /= len;
      const t = i / (n - 1);
      let w = o.width * profileAt(o.profile, t);
      w = w * (1 - o.widthNoise) + w * o.widthNoise * valueNoise3(i * 0.5, n0);
      w += o.minWidth;
      const shift = o.wobble * 2 * (valueNoise3(i * o.wobbleScale, n0 + 7) - 0.47);
      const [u, v, depth] = flat[i];
      const cu = u - tv * shift;
      const cv = v + tu * shift;
      const left = fromPlane(plane, cu - tv * w, cv + tu * w, depth + o.zOffset);
      const right = fromPlane(plane, cu + tv * w, cv - tu * w, depth + o.zOffset);
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
      colors.push(1, 1, 1, alpha, 1, 1, 1, alpha);
      if (i > 0) {
        const a = base + (i - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const strokeCache = createNodeCache<InkState>(disposeInk);

const STROKE_FIELDS: ParamFieldDef[] = [
  ...NATIVE_TRANSFORM_PARAM_FIELDS,
  { id: "width", label: "Width (half, world units)", kind: "number", step: 0.005, group: "Stroke" },
  { id: "minWidth", label: "Min Width", kind: "number", step: 0.001, group: "Stroke" },
  {
    id: "profile",
    label: "Width Profile",
    kind: "select",
    options: [...PROFILES],
    optionLabels: ["Sine (pointed ends)", "Blob (full belly)", "Taper (thick to thin)", "Uniform"],
    group: "Stroke",
  },
  { id: "widthNoise", label: "Width Noise", kind: "number", step: 0.05, percent: true, group: "Stroke" },
  { id: "wobble", label: "Wobble", kind: "number", step: 0.005, group: "Stroke" },
  { id: "wobbleScale", label: "Wobble Frequency", kind: "number", step: 0.05, group: "Stroke" },
  { id: "seed", label: "Seed", kind: "number", step: 1, group: "Stroke" },
  { id: "color", label: "Ink Color", kind: "color", group: "Material" },
  { id: "opacity", label: "Opacity", kind: "number", step: 0.05, percent: true, group: "Material" },
  { id: "alphaJitter", label: "Opacity Jitter (per stroke)", kind: "number", step: 0.05, percent: true, group: "Material" },
  { id: "zOffset", label: "Depth Offset", kind: "number", step: 0.001, group: "Material" },
];

export const INK_STROKE_NODE: NodeDefinition = {
  type: "curve/ink-stroke",
  label: "Ink Stroke",
  category: "curve",
  inputs: [
    ...INK_INPUTS,
    { id: "width", label: "Width", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    ...INK_TRAILING_INPUTS,
  ],
  outputs: INK_OUTPUTS,
  defaultParams: {
    ...TRANSFORM_DEFAULTS,
    width: 0.03,
    minWidth: 0.004,
    profile: "sine",
    widthNoise: 0.5,
    wobble: 0,
    wobbleScale: 0.3,
    color: new THREE.Color(0x646464),
    opacity: 0.3,
    alphaJitter: 0,
    zOffset: 0.002,
    seed: 0,
  },
  paramFields: STROKE_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const state = getInkState(strokeCache, ctx.nodeId, true);
    const { mesh } = state;
    const { curves, sig } = readCurves(state, inputs);
    const options: StrokeOptions = {
      width: Math.max(0, num(inputs.width, params.width, 0.03)),
      minWidth: Math.max(0, num(undefined, params.minWidth, 0.004)),
      profile: String(params.profile ?? "sine"),
      widthNoise: Math.max(0, Math.min(1, num(undefined, params.widthNoise, 0.5))),
      wobble: num(undefined, params.wobble, 0),
      wobbleScale: num(undefined, params.wobbleScale, 0.3),
      alphaJitter: Math.max(0, Math.min(1, num(undefined, params.alphaJitter, 0))),
      zOffset: num(undefined, params.zOffset, 0.002),
      seed: Math.round(num(inputs.seed, params.seed, 0)),
    };
    const signature = `${sig}|${JSON.stringify(options)}`;
    if (signature !== state.signature) {
      state.signature = signature;
      mesh.geometry.dispose();
      mesh.geometry = buildStrokeGeometry(curves, options);
    }
    applyInk(mesh.material, inputs, params);
    placeMesh(mesh, inputs, params, ctx);
    return primitiveOutputs(mesh, params);
  },
};

/* -------------------------------------------------------------------------- */
/* Curve Fill                                                                 */
/* -------------------------------------------------------------------------- */

interface FillOptions {
  baseDrop: number;
  zOffset: number;
  gradient: boolean;
  top: THREE.Color;
  bottom: THREE.Color;
}

/**
 * Each curve as a filled flat shape in its own drawing plane. An open curve
 * is closed by a straight edge, or — with Base Drop — by a skirt hanging
 * below its ends, which is how a mountain silhouette becomes a solid that
 * hides what lies behind it. "Below" and the gradient's top and bottom are
 * read in the plane as it is normally looked at.
 */
export function buildFillGeometry(curves: Curve3[], o: FillOptions): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Color();
  for (const curve of curves) {
    const pts = strokeSamples(curve, 0.05);
    if (pts.length > 2 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-10) pts.pop();
    if (pts.length < 3) continue;
    const plane = curvePlane(pts);
    const flat = pts.map((p) => toPlane(plane, p));
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [, v] of flat) {
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    if (o.baseDrop > 0) {
      const first = flat[0];
      const last = flat[flat.length - 1];
      const floor = Math.min(first[1], last[1]) - o.baseDrop;
      flat.push([last[0], floor, last[2]], [first[0], floor, first[2]]);
      minV = Math.min(minV, floor);
    }
    const faces = THREE.ShapeUtils.triangulateShape(flat.map(([u, v]) => new THREE.Vector2(u, v)), []);
    const base = positions.length / 3;
    const span = Math.max(1e-6, maxV - minV);
    for (const [u, v, w] of flat) {
      const p = fromPlane(plane, u, v, w + o.zOffset);
      positions.push(p.x, p.y, p.z);
      if (o.gradient) c.copy(o.bottom).lerp(o.top, Math.max(0, Math.min(1, (v - minV) / span)));
      else c.setRGB(1, 1, 1);
      colors.push(c.r, c.g, c.b);
    }
    for (const [a, b, d] of faces) indices.push(base + a, base + b, base + d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const fillCache = createNodeCache<InkState>(disposeInk);

const FILL_FIELDS: ParamFieldDef[] = [
  ...NATIVE_TRANSFORM_PARAM_FIELDS,
  { id: "baseDrop", label: "Base Drop (skirt below ends)", kind: "number", step: 0.05, group: "Fill" },
  { id: "zOffset", label: "Depth Offset", kind: "number", step: 0.001, group: "Fill" },
  { id: "color", label: "Color (top)", kind: "color", group: "Material" },
  { id: "opacity", label: "Opacity", kind: "number", step: 0.05, percent: true, group: "Material" },
  { id: "gradient", label: "Vertical Gradient", kind: "boolean", group: "Material" },
  { id: "bottomColor", label: "Color (bottom)", kind: "color", group: "Material" },
];

export const CURVE_FILL_NODE: NodeDefinition = {
  type: "curve/fill",
  label: "Curve Fill",
  category: "curve",
  inputs: [...INK_INPUTS, ...INK_TRAILING_INPUTS],
  outputs: INK_OUTPUTS,
  defaultParams: {
    ...TRANSFORM_DEFAULTS,
    color: new THREE.Color(0xffffff),
    opacity: 1,
    baseDrop: 0,
    gradient: false,
    bottomColor: new THREE.Color(0xffffff),
    zOffset: 0,
  },
  paramFields: FILL_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const state = getInkState(fillCache, ctx.nodeId, false);
    const { mesh } = state;
    const { curves, sig } = readCurves(state, inputs);
    const gradient = Boolean(params.gradient);
    const matParams = extractMaterialParams(inputs, params);
    const bottom = asColor(params.bottomColor, new THREE.Color(0xffffff));
    const options: FillOptions = {
      baseDrop: Math.max(0, num(undefined, params.baseDrop, 0)),
      zOffset: num(undefined, params.zOffset, 0),
      gradient,
      top: matParams.color,
      bottom,
    };
    const signature = `${sig}|${options.baseDrop}|${options.zOffset}|${gradient ? matParams.color.getHex() + ":" + bottom.getHex() : ""}`;
    if (signature !== state.signature) {
      state.signature = signature;
      mesh.geometry.dispose();
      mesh.geometry = buildFillGeometry(curves, options);
    }
    const material = mesh.material;
    // With a gradient the colours live in the vertices; the material only multiplies them.
    if (gradient) material.color.setRGB(1, 1, 1);
    else material.color.copy(matParams.color);
    const transparent = matParams.opacity < 1;
    if (material.transparent !== transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
    material.opacity = matParams.opacity;
    placeMesh(mesh, inputs, params, ctx);
    return primitiveOutputs(mesh, params);
  },
};
