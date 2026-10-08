import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NodeDefinition, NodeInstance, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { asColor, COMMON_DEFAULT_PARAMS, NATIVE_TRANSFORM_PARAM_FIELDS, numberInput } from "./object";
import { asVector3, composeNativeMatrix } from "./transform";
import { polylineCurve } from "../curveLists";
import { readSpace } from "../mathSpace";
import { faceCamera } from "../billboard";
import { Typeset, typeset } from "../../math/latex";

const ALIGN = ["left", "center", "right"] as const;
const VALIGN = ["baseline", "middle", "top", "bottom"] as const;

interface LatexState {
  mesh: THREE.Mesh;
  signature?: string;
  /** Glyph outlines in the mesh's own space, for the Curves output. */
  outlines: THREE.Vector3[][];
  /** The Curves output, rebuilt only when the outlines or the placement change. */
  curves: THREE.CatmullRomCurve3[];
  curvesKey?: string;
}

const latexCache = createNodeCache<LatexState>((s) => disposeObject3D(s.mesh));

function latexState(nodeId: string): LatexState {
  let state = latexCache.get(nodeId);
  if (state) return state;
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.DoubleSide }));
  mesh.matrixAutoUpdate = false;
  mesh.userData.nodeId = nodeId;
  mesh.frustumCulled = false;
  state = { mesh, outlines: [], curves: [] };
  latexCache.set(nodeId, state);
  return state;
}

/** Where the formula's anchor sits in its own box, in ems. */
function anchor(ts: Typeset, align: string, valign: string): THREE.Vector2 {
  const { box } = ts;
  const x = align === "left" ? box.minX : align === "right" ? box.maxX : (box.minX + box.maxX) / 2;
  const y = valign === "baseline" ? 0 : valign === "top" ? box.maxY : valign === "bottom" ? box.minY : (box.minY + box.maxY) / 2;
  return new THREE.Vector2(x, y);
}

/**
 * The first `count` glyphs, left to right, as one geometry scaled to `size`
 * per em and moved so the anchor sits at the origin.
 */
function build(state: LatexState, ts: Typeset, count: number, size: number, origin: THREE.Vector2): void {
  const order = [...ts.glyphs].sort((p, q) => p.box.minX - q.box.minX).slice(0, count);
  const parts: THREE.BufferGeometry[] = [];
  state.outlines = [];
  const place = (p: THREE.Vector2) => new THREE.Vector3((p.x - origin.x) * size, (p.y - origin.y) * size, 0);
  for (const glyph of order) {
    const g = new THREE.ShapeGeometry(glyph.shapes, 8);
    g.translate(-origin.x, -origin.y, 0);
    g.scale(size, size, 1);
    // ShapeGeometry adds uvs; drop them so every part merges alike.
    g.deleteAttribute("uv");
    parts.push(g);
    for (const shape of glyph.shapes) {
      state.outlines.push(shape.getPoints(8).map(place));
      for (const hole of shape.holes) state.outlines.push(hole.getPoints(8).map(place));
    }
  }
  state.mesh.geometry.dispose();
  state.mesh.geometry = parts.length ? (mergeGeometries(parts, false) ?? new THREE.BufferGeometry()) : new THREE.BufferGeometry();
  for (const g of parts) g.dispose();
}

function formulaError(tex: unknown, inline: boolean): ParamFieldDef[] {
  const ts = typeset(String(tex ?? ""), inline);
  return ts.error ? [{ id: "texError", label: `⚠ ${ts.error}`, kind: "note", tone: "warn" }] : [];
}

const FIELDS: ParamFieldDef[] = [
  ...NATIVE_TRANSFORM_PARAM_FIELDS,
  { id: "tex", label: "LaTeX", kind: "text", group: "Formula" },
  { id: "inline", label: "Inline Style", kind: "boolean", group: "Formula" },
  { id: "size", label: "Size", kind: "number", step: 0.05, group: "Formula" },
  { id: "align", label: "Align", kind: "select", options: [...ALIGN], optionLabels: ["Left", "Center", "Right"], group: "Formula" },
  { id: "valign", label: "Vertical Align", kind: "select", options: [...VALIGN], optionLabels: ["Baseline", "Middle", "Top", "Bottom"], group: "Formula" },
  { id: "at", label: "At", kind: "vector", group: "Formula" },
  { id: "progress", label: "Drawn", kind: "number", step: 0.05, group: "Style" },
  { id: "color", label: "Color", kind: "color", group: "Style" },
  { id: "opacity", label: "Opacity", kind: "number", step: 0.05, group: "Style" },
  { id: "faceCamera", label: "Face Camera", kind: "boolean", group: "Style" },
  { id: "onTop", label: "On Top", kind: "boolean", group: "Style" },
];

/**
 * LaTeX — a formula typeset as in a paper (MathJax, offline) and drawn as
 * vector shapes: crisp at any size, in the scene like any other object.
 * \frac, \sqrt, \int, \sum, matrices, Greek, everything TeX has.
 *
 * Placed by its own transform, or at a point in math coordinates (At)
 * through an Axes' Space — to label a curve or a point. Face Camera keeps it
 * readable in 3D, On Top keeps it from being hidden behind what it labels.
 * Drawn reveals it glyph by glyph, left to right; Curves
 * hands the glyph outlines on, for Write On to trace them.
 */
export const LATEX_NODE: NodeDefinition = {
  type: "math/latex",
  label: "LaTeX",
  category: "math",
  inputs: [
    { id: "tex", label: "LaTeX", type: "text" },
    { id: "at", label: "At", type: "vector" },
    { id: "space", label: "Space", type: "matrix" },
    { id: "progress", label: "Drawn", type: "value" },
    { id: "color", label: "Color", type: "color" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "curves", label: "Curves", type: "list" },
    { id: "count", label: "Glyphs", type: "value" },
  ],
  defaultParams: {
    visible: COMMON_DEFAULT_PARAMS.visible,
    location: COMMON_DEFAULT_PARAMS.location,
    rotation: COMMON_DEFAULT_PARAMS.rotation,
    scale: COMMON_DEFAULT_PARAMS.scale,
    showPivot: COMMON_DEFAULT_PARAMS.showPivot,
    pivot: COMMON_DEFAULT_PARAMS.pivot,
    inheritRotation: COMMON_DEFAULT_PARAMS.inheritRotation,
    inheritScale: COMMON_DEFAULT_PARAMS.inheritScale,
    tex: "\\int_a^b f(x)\\,dx = F(b) - F(a)",
    inline: false,
    size: 0.6,
    align: "center",
    valign: "middle",
    at: new THREE.Vector3(0, 0, 0),
    progress: 1,
    color: new THREE.Color(0x222222),
    opacity: 1,
    faceCamera: false,
    onTop: false,
  },
  paramFields: FIELDS,
  dynamicParamFields: (instance: NodeInstance) => [...formulaError(instance.params.tex, toBoolean(instance.params.inline)), ...FIELDS],
  evaluate: (inputs, params, ctx) => {
    const state = latexState(ctx.nodeId);
    const tex = inputs.tex !== undefined ? String(inputs.tex) : String(params.tex ?? "");
    const inline = toBoolean(params.inline);
    const ts = typeset(tex, inline);
    const size = Math.max(1e-4, numberInput(undefined, params.size, 0.6));
    const align = String(params.align ?? "center");
    const valign = String(params.valign ?? "middle");
    const progress = Math.max(0, Math.min(1, numberInput(inputs.progress, params.progress, 1)));
    const count = Math.round(ts.glyphs.length * progress);

    const signature = JSON.stringify([tex, inline, size, align, valign, count]);
    if (state.signature !== signature) {
      state.signature = signature;
      build(state, ts, count, size, anchor(ts, align, valign));
    }

    // Placement: the node's own pose, carried to At — through the Axes' Space when one is wired.
    const pose = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);
    const at = asVector3(inputs.at ?? params.at, new THREE.Vector3());
    const spot = inputs.space instanceof THREE.Matrix4 ? at.clone().applyMatrix4(readSpace(inputs.space)) : at;
    const placed = new THREE.Matrix4().makeTranslation(spot.x, spot.y, spot.z).multiply(pose);
    if (ctx.nodeId !== ctx.liveEditNodeId) state.mesh.matrix.copy(placed);

    const material = state.mesh.material as THREE.MeshBasicMaterial;
    material.color.copy(asColor(inputs.color ?? params.color, new THREE.Color(0x222222)));
    const opacity = Math.max(0, Math.min(1, numberInput(undefined, params.opacity, 1)));
    material.opacity = opacity;
    if (material.transparent !== opacity < 1) {
      material.transparent = opacity < 1;
      material.needsUpdate = true;
    }
    faceCamera(state.mesh, toBoolean(params.faceCamera));
    // On Top: drawn over everything, never hidden behind what it labels.
    const onTop = toBoolean(params.onTop);
    if (material.depthTest === onTop) {
      material.depthTest = !onTop;
      material.depthWrite = !onTop;
      material.needsUpdate = true;
    }
    state.mesh.renderOrder = onTop ? 999 : 0;
    state.mesh.visible = toBoolean(inputs.visible ?? params.visible ?? true);

    const curvesKey = `${signature}|${placed.elements.join(",")}`;
    if (state.curvesKey !== curvesKey) {
      state.curvesKey = curvesKey;
      state.curves = state.outlines.map((points) => polylineCurve(points.map((p) => p.clone().applyMatrix4(placed)), true));
    }
    return { geometry: state.mesh, curves: state.curves, count };
  },
};
