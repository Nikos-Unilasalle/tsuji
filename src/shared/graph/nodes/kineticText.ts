import * as THREE from "three";
import { Font, FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import { BUILTIN_FONTS, FONT_NAMES } from "../../three/fonts/fonts";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition, ParamFieldDef } from "../types";
import { composeNativeMatrix } from "./transform";
import {
  applyMaterialParams,
  buildPrimitiveDynamicParamFields,
  COMMON_DEFAULT_PARAMS,
  COMMON_PRIMITIVE_INPUTS,
  extractMaterialParams,
  extractTextureParams,
  MaterialParams,
  numberInput,
  prepareGeometryForMaterial,
  TextureParams,
} from "./object";
import {
  computeRangeWeights,
  RangeSelectorShape,
  RANGE_SELECTOR_SHAPES,
} from "../../three/typography/rangeSelector";
import {
  computeTextLayout,
  TextAlignment,
  TextAnchor,
} from "../../three/typography/textLayout";

const defaultFont = BUILTIN_FONTS["Helvetiker"] ?? Object.values(BUILTIN_FONTS)[0];

interface TextAnimatorState {
  group: THREE.Group;
  font?: Font;
  lastText?: string;
  lastFont?: Font;
  lastFontSize?: number;
  lastDepth?: number;
  lastTracking?: number;
  lastLineHeight?: number;
  lastAlign?: string;
  lastAnchor?: string;
  lastBevelEnabled?: boolean;
  charGeometries: THREE.BufferGeometry[];
  charMeshes: THREE.Mesh[];
  dummyMesh: THREE.Mesh;
}

const animatorCache = createNodeCache<TextAnimatorState>((s) => disposeObject3D(s.group));

function getOrCreateAnimatorState(nodeId: string): TextAnimatorState {
  let state = animatorCache.get(nodeId);
  if (!state) {
    const group = new THREE.Group();
    group.name = `TextAnimator_${nodeId}`;
    const dummyMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.4,
        metalness: 0.1,
      })
    );
    state = {
      group,
      charGeometries: [],
      charMeshes: [],
      dummyMesh,
    };
    animatorCache.set(nodeId, state);
  }
  return state;
}

/** Align and center a glyph geometry based on anchor type. */
function applyAnchorToGeometry(geom: THREE.BufferGeometry, anchor: TextAnchor): void {
  geom.computeBoundingBox();
  const box = geom.boundingBox;
  if (!box) return;

  const midX = (box.min.x + box.max.x) / 2;
  const midZ = (box.min.z + box.max.z) / 2;

  switch (anchor) {
    case "glyph_center":
      geom.center();
      break;
    case "baseline_center":
      geom.translate(-midX, 0, -midZ);
      break;
    case "bottom_center":
      geom.translate(-midX, -box.min.y, -midZ);
      break;
    case "top_center":
      geom.translate(-midX, -box.max.y, -midZ);
      break;
    default:
      geom.center();
  }
}

function updateCharMeshesMaterial(
  meshes: THREE.Mesh[],
  dummyMesh: THREE.Mesh,
  matParams: MaterialParams,
  texParams?: TextureParams
): void {
  const primary = meshes.length > 0 ? meshes[0] : dummyMesh;
  applyMaterialParams(primary, matParams, THREE.FrontSide, texParams);
  const activeMat = primary.material;

  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    if (m.material !== activeMat) {
      m.material = activeMat;
    }
    m.castShadow = true;
    m.receiveShadow = true;
    if (matParams.customMaterial) {
      prepareGeometryForMaterial(m, matParams.customMaterial);
    }
  }
}

function parseVec3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (v instanceof THREE.Vector3) {
    return [v.x, v.y, v.z];
  }
  if (Array.isArray(v)) {
    return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  }
  if (v && typeof v === "object") {
    const obj = v as { x?: unknown; y?: unknown; z?: unknown };
    return [Number(obj.x) || 0, Number(obj.y) || 0, Number(obj.z) || 0];
  }
  return fallback;
}

export const TEXT_ANIMATOR_PARAM_FIELDS: ParamFieldDef[] = [
  // Text and Typography Group
  { id: "text", label: "Text", kind: "text", group: "Typography" },
  { id: "fontPreset", label: "Font", kind: "select", options: FONT_NAMES, group: "Typography" },
  {
    id: "fontPath",
    label: "Custom Font (.json)",
    kind: "file",
    accept: [".json"],
    group: "Typography",
    onLoaded: (nodeId, _path, content) => {
      const state = getOrCreateAnimatorState(nodeId);
      try {
        state.font = new FontLoader().parse(JSON.parse(String(content)));
      } catch (err) {
        console.error("Failed to parse font:", err);
        state.font = undefined;
      }
    },
  },
  { id: "fontSize", label: "Font Size (px)", kind: "number", step: 4, group: "Typography" },
  { id: "depth", label: "Depth / Relief", kind: "number", step: 0.05, group: "Typography" },
  { id: "bevelEnabled", label: "Bevel Edge", kind: "boolean", group: "Typography" },
  { id: "tracking", label: "Tracking (Spacing)", kind: "number", step: 0.5, group: "Typography" },
  { id: "lineHeight", label: "Line Height", kind: "number", step: 0.1, group: "Typography" },
  {
    id: "align",
    label: "Align",
    kind: "select",
    options: ["center", "left", "right"],
    group: "Typography",
  },
  {
    id: "anchor",
    label: "Glyph Anchor",
    kind: "select",
    options: ["glyph_center", "baseline_center", "bottom_center", "top_center"],
    group: "Typography",
  },

  // Range Selector Group
  {
    id: "basedOn",
    label: "Based On",
    kind: "select",
    options: ["characters", "words", "lines"],
    group: "Range Selector",
  },
  {
    id: "selectorShape",
    label: "Shape",
    kind: "select",
    options: RANGE_SELECTOR_SHAPES,
    group: "Range Selector",
  },
  { id: "start", label: "Start", kind: "number", step: 0.05, percent: true, group: "Range Selector" },
  { id: "end", label: "End", kind: "number", step: 0.05, percent: true, group: "Range Selector" },
  { id: "offset", label: "Offset", kind: "number", step: 0.05, group: "Range Selector" },
  { id: "invert", label: "Invert Selection", kind: "boolean", group: "Range Selector" },
  { id: "randomize", label: "Randomize Order", kind: "boolean", group: "Range Selector" },
  { id: "randomSeed", label: "Random Seed", kind: "number", step: 1, group: "Range Selector" },
  { id: "easeHigh", label: "Ease High", kind: "number", step: 0.1, group: "Range Selector" },
  { id: "easeLow", label: "Ease Low", kind: "number", step: 0.1, group: "Range Selector" },
  { id: "wiggleAmount", label: "Wiggle Amount", kind: "number", step: 0.05, group: "Range Selector" },
  { id: "wiggleSpeed", label: "Wiggle Speed", kind: "number", step: 0.2, group: "Range Selector" },

  // Transform Deltas
  { id: "positionDelta", label: "Position Δ", kind: "vector", group: "Transform Deltas" },
  { id: "rotationDelta", label: "Rotation Δ (°)", kind: "vector", degrees: true, step: 5, group: "Transform Deltas" },
  { id: "scaleDelta", label: "Scale Δ", kind: "vector", group: "Transform Deltas" },

  // Path Options
  { id: "alignToPath", label: "Align to Path", kind: "boolean", group: "Path Options" },
  { id: "pathOffset", label: "Path Offset", kind: "number", step: 0.02, group: "Path Options" },
  { id: "fitToCurve", label: "Fit to Curve", kind: "boolean", group: "Path Options" },
];

// ---------------------------------------------------------------------------
// 1. TEXT ANIMATOR NODE (Kinetic 3D Typography)
// ---------------------------------------------------------------------------

export const TEXT_ANIMATOR_NODE: NodeDefinition = {
  type: "text/animator",
  label: "Text Animator",
  category: "text",
  inputs: [
    { id: "text", label: "Text", type: "text" },
    { id: "progress", label: "Progress", type: "value" },
    { id: "curve", label: "Curve Path", type: "curve" },
    { id: "fontSize", label: "Font Size", type: "value" },
    { id: "depth", label: "Depth", type: "value" },
    { id: "tracking", label: "Tracking", type: "value" },
    { id: "lineHeight", label: "Line Height", type: "value" },
    { id: "positionDelta", label: "Position Δ", type: "vector" },
    { id: "rotationDelta", label: "Rotation Δ", type: "vector" },
    { id: "scaleDelta", label: "Scale Δ", type: "vector" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrices", label: "Matrices", type: "list" },
    { id: "positions", label: "Positions", type: "list" },
    { id: "characters", label: "Characters", type: "list" },
    { id: "weights", label: "Weights", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    text: "TSUJI",
    fontPreset: "Helvetiker",
    fontPath: "",
    fontSize: 64,
    depth: 0.15,
    bevelEnabled: true,
    tracking: 0,
    lineHeight: 1.2,
    align: "center",
    anchor: "glyph_center",
    // Range selector
    basedOn: "characters",
    selectorShape: "smooth",
    start: 0,
    end: 1,
    offset: 0,
    invert: false,
    randomize: false,
    randomSeed: 42,
    easeHigh: 0,
    easeLow: 0,
    wiggleAmount: 0,
    wiggleSpeed: 1,
    // Transform deltas
    positionDelta: [0, 0, 0],
    rotationDelta: [0, 0, 0],
    scaleDelta: [1, 1, 1],
    // Path options
    alignToPath: true,
    pathOffset: 0,
    fitToCurve: false,
    ...COMMON_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields(TEXT_ANIMATOR_PARAM_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(TEXT_ANIMATOR_PARAM_FIELDS),
  evaluate: (inputs, params, ctx) => {
    const state = getOrCreateAnimatorState(ctx.nodeId);
    const group = state.group;

    const textStr = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "TSUJI");
    const fontSize = Math.max(8, numberInput(inputs.fontSize, params.fontSize, 64));
    const depth = Math.max(0.001, numberInput(inputs.depth, params.depth, 0.15));
    const tracking = numberInput(inputs.tracking, params.tracking, 0);
    const lineHeight = Math.max(0.5, numberInput(inputs.lineHeight, params.lineHeight, 1.2));
    const bevelEnabled = Boolean(params.bevelEnabled ?? true);
    const align = (String(params.align ?? "center")) as TextAlignment;
    const anchor = (String(params.anchor ?? "glyph_center")) as TextAnchor;

    const curve = (inputs.curve as THREE.Curve<THREE.Vector3>) || null;
    const pathOffset = Number(params.pathOffset ?? 0);
    const alignToPath = Boolean(params.alignToPath ?? true);
    const fitToCurve = Boolean(params.fitToCurve ?? false);

    const font = state.font ?? BUILTIN_FONTS[String(params.fontPreset ?? "Helvetiker")] ?? defaultFont;

    // Detect structural text / layout rebuild
    const needsGeometryRebuild =
      state.lastText !== textStr ||
      state.lastFont !== font ||
      state.lastFontSize !== fontSize ||
      state.lastDepth !== depth ||
      state.lastTracking !== tracking ||
      state.lastLineHeight !== lineHeight ||
      state.lastAlign !== align ||
      state.lastAnchor !== anchor ||
      state.lastBevelEnabled !== bevelEnabled;

    const layout = computeTextLayout(textStr, font, {
      fontSize,
      tracking,
      lineHeight,
      align,
      anchor,
      curve,
      pathOffset,
      alignToPath,
      fitToCurve,
    });

    const glyphs = layout.glyphs;
    const count = glyphs.length;

    if (needsGeometryRebuild) {
      // Clean up previous geometries
      for (const geom of state.charGeometries) {
        geom.dispose();
      }
      state.charGeometries = [];

      // Clear child meshes from group
      while (group.children.length > 0) {
        const child = group.children[group.children.length - 1];
        group.remove(child);
      }
      state.charMeshes = [];

      // Generate extruded 3D meshes per non-whitespace character
      for (let i = 0; i < count; i++) {
        const gInfo = glyphs[i];
        let geom: THREE.BufferGeometry;

        if (gInfo.shapes.length > 0) {
          geom = new THREE.ExtrudeGeometry(gInfo.shapes, {
            depth,
            bevelEnabled,
            bevelThickness: Math.min(0.02, depth * 0.2),
            bevelSize: Math.min(0.01, depth * 0.1),
            bevelSegments: 3,
            curveSegments: 8,
          });
          applyAnchorToGeometry(geom, anchor);
        } else {
          geom = new THREE.BufferGeometry();
        }

        state.charGeometries.push(geom);

        const charMesh = new THREE.Mesh(geom, state.dummyMesh.material);
        charMesh.name = `Glyph_${i}_${gInfo.char}`;
        charMesh.matrixAutoUpdate = false;
        group.add(charMesh);
        state.charMeshes.push(charMesh);
      }

      state.lastText = textStr;
      state.lastFont = font;
      state.lastFontSize = fontSize;
      state.lastDepth = depth;
      state.lastTracking = tracking;
      state.lastLineHeight = lineHeight;
      state.lastAlign = align;
      state.lastAnchor = anchor;
      state.lastBevelEnabled = bevelEnabled;
    }

    // Material and texture updates
    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    updateCharMeshesMaterial(state.charMeshes, state.dummyMesh, matParams, texParams);

    // Apply native group root transform
    const baseRootMatrix = composeNativeMatrix(
      inputs.matrix,
      params.location,
      params.rotation,
      params.scale,
      params
    );
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(baseRootMatrix);
    }

    // Determine Range Selector units & weights
    const basedOn = String(params.basedOn ?? "characters");
    let selectorItemCount = count;
    if (basedOn === "words") {
      selectorItemCount = Math.max(1, layout.words.length);
    } else if (basedOn === "lines") {
      selectorItemCount = Math.max(1, layout.lines.length);
    }

    // Progress input drives offset if provided
    let effectiveOffset = Number(params.offset ?? 0);
    if (inputs.progress !== undefined) {
      const p = Number(inputs.progress);
      effectiveOffset += p;
    }

    const itemWeights = computeRangeWeights(selectorItemCount, {
      start: Number(params.start ?? 0),
      end: Number(params.end ?? 1),
      offset: effectiveOffset,
      shape: (String(params.selectorShape ?? "smooth")) as RangeSelectorShape,
      invert: Boolean(params.invert ?? false),
      randomize: Boolean(params.randomize ?? false),
      randomSeed: Number(params.randomSeed ?? 42),
      easeHigh: Number(params.easeHigh ?? 0),
      easeLow: Number(params.easeLow ?? 0),
      wiggleAmount: Number(params.wiggleAmount ?? 0),
      wiggleSpeed: Number(params.wiggleSpeed ?? 1),
      time: ctx.time,
    });

    // Transform delta parsing (rotDelta is in radians, matching Tsuji vector rotation convention)
    const posDelta = parseVec3(inputs.positionDelta ?? params.positionDelta, [0, 0, 0]);
    const rotDelta = parseVec3(inputs.rotationDelta ?? params.rotationDelta, [0, 0, 0]);
    const scaleDelta = parseVec3(inputs.scaleDelta ?? params.scaleDelta, [1, 1, 1]);

    const outMatrices: THREE.Matrix4[] = [];
    const outPositions: THREE.Vector3[] = [];
    const outCharacters: string[] = [];
    const outWeights: number[] = [];

    // Per-glyph transform application
    for (let i = 0; i < count; i++) {
      const gInfo = glyphs[i];
      const mesh = state.charMeshes[i];

      // Lookup weight based on characters, words, or lines
      let w = 0;
      if (basedOn === "words") {
        const wIdx = Math.min(gInfo.wordIndex, itemWeights.length - 1);
        w = itemWeights[wIdx] ?? 0;
      } else if (basedOn === "lines") {
        const lIdx = Math.min(gInfo.lineIndex, itemWeights.length - 1);
        w = itemWeights[lIdx] ?? 0;
      } else {
        w = itemWeights[i] ?? 0;
      }

      outWeights.push(w);
      outCharacters.push(gInfo.char);

      // Interpolate transform: w = 0 means fully at delta; w = 1 means arrived at base
      const invW = 1 - w;

      const posX = gInfo.basePosition.x + (posDelta[0] || 0) * invW;
      const posY = gInfo.basePosition.y + (posDelta[1] || 0) * invW;
      const posZ = gInfo.basePosition.z + (posDelta[2] || 0) * invW;

      const rotX = gInfo.baseRotation.x + (rotDelta[0] || 0) * invW;
      const rotY = gInfo.baseRotation.y + (rotDelta[1] || 0) * invW;
      const rotZ = gInfo.baseRotation.z + (rotDelta[2] || 0) * invW;

      const scX = 1 + ((scaleDelta[0] ?? 1) - 1) * invW;
      const scY = 1 + ((scaleDelta[1] ?? 1) - 1) * invW;
      const scZ = 1 + ((scaleDelta[2] ?? 1) - 1) * invW;

      const localMat = new THREE.Matrix4().compose(
        new THREE.Vector3(posX, posY, posZ),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ)),
        new THREE.Vector3(Math.max(0, scX), Math.max(0, scY), Math.max(0, scZ))
      );

      if (mesh) {
        mesh.matrix.copy(localMat);
        mesh.visible = scX > 0.001 && scY > 0.001 && scZ > 0.001 && gInfo.shapes.length > 0;
      }

      // World matrix taking group pose into account
      const worldMat = new THREE.Matrix4().multiplyMatrices(group.matrix, localMat);
      const worldPos = new THREE.Vector3().setFromMatrixPosition(worldMat);

      outMatrices.push(worldMat);
      outPositions.push(worldPos);
    }

    const isVisible = inputs.visible !== undefined ? Boolean(inputs.visible) : params.visible !== false;
    group.visible = isVisible;

    return {
      geometry: group,
      matrices: outMatrices,
      positions: outPositions,
      characters: outCharacters,
      weights: outWeights,
      count,
      matrix: group.matrix,
    };
  },
};

// ---------------------------------------------------------------------------
// 2. TEXT DECOMPOSE NODE (Glyph & Word Metrics)
// ---------------------------------------------------------------------------

export const TEXT_DECOMPOSE_NODE: NodeDefinition = {
  type: "text/decompose",
  label: "Text Decompose",
  category: "text",
  inputs: [
    { id: "text", label: "Text", type: "text" },
    { id: "fontSize", label: "Font Size", type: "value" },
    { id: "tracking", label: "Tracking", type: "value" },
    { id: "lineHeight", label: "Line Height", type: "value" },
  ],
  outputs: [
    { id: "characters", label: "Characters", type: "list" },
    { id: "words", label: "Words", type: "list" },
    { id: "lines", label: "Lines", type: "list" },
    { id: "positions", label: "Positions", type: "list" },
    { id: "matrices", label: "Matrices", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "width", label: "Total Width", type: "value" },
    { id: "height", label: "Total Height", type: "value" },
  ],
  defaultParams: {
    text: "Hello Tsuji",
    fontPreset: "Helvetiker",
    fontSize: 64,
    tracking: 0,
    lineHeight: 1.2,
    align: "center",
  },
  paramFields: [
    { id: "text", label: "Text", kind: "text" },
    { id: "fontPreset", label: "Font", kind: "select", options: FONT_NAMES },
    { id: "fontSize", label: "Font Size (px)", kind: "number", step: 4 },
    { id: "tracking", label: "Tracking", kind: "number", step: 0.5 },
    { id: "lineHeight", label: "Line Height", kind: "number", step: 0.1 },
    { id: "align", label: "Align", kind: "select", options: ["center", "left", "right"] },
  ],
  evaluate: (inputs, params) => {
    const textStr = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "");
    const fontSize = Math.max(8, numberInput(inputs.fontSize, params.fontSize, 64));
    const tracking = numberInput(inputs.tracking, params.tracking, 0);
    const lineHeight = Math.max(0.5, numberInput(inputs.lineHeight, params.lineHeight, 1.2));
    const align = (String(params.align ?? "center")) as TextAlignment;

    const font = BUILTIN_FONTS[String(params.fontPreset ?? "Helvetiker")] ?? defaultFont;

    const layout = computeTextLayout(textStr, font, {
      fontSize,
      tracking,
      lineHeight,
      align,
    });

    const characters = layout.glyphs.map((g) => g.char);
    const positions = layout.glyphs.map((g) => g.basePosition.clone());
    const matrices = layout.glyphs.map((g) => g.baseMatrix.clone());

    return {
      characters,
      words: layout.words,
      lines: layout.lines,
      positions,
      matrices,
      count: characters.length,
      width: layout.totalWidth,
      height: layout.totalHeight,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. TEXT RANGE SELECTOR NODE (Nodal Range Modulator)
// ---------------------------------------------------------------------------

export const TEXT_RANGE_SELECTOR_NODE: NodeDefinition = {
  type: "text/range-selector",
  label: "Range Selector",
  category: "text",
  inputs: [
    { id: "count", label: "Count", type: "value" },
    { id: "progress", label: "Progress", type: "value" },
    { id: "start", label: "Start", type: "value" },
    { id: "end", label: "End", type: "value" },
    { id: "offset", label: "Offset", type: "value" },
  ],
  outputs: [
    { id: "weights", label: "Weights", type: "list" },
    { id: "activeCount", label: "Active Count", type: "value" },
  ],
  defaultParams: {
    count: 10,
    shape: "smooth",
    start: 0,
    end: 1,
    offset: 0,
    invert: false,
    randomize: false,
    randomSeed: 42,
    easeHigh: 0,
    easeLow: 0,
    wiggleAmount: 0,
    wiggleSpeed: 1,
  },
  paramFields: [
    { id: "count", label: "Item Count", kind: "number", step: 1 },
    {
      id: "shape",
      label: "Shape",
      kind: "select",
      options: RANGE_SELECTOR_SHAPES,
    },
    { id: "start", label: "Start (0..1)", kind: "number", step: 0.05, percent: true },
    { id: "end", label: "End (0..1)", kind: "number", step: 0.05, percent: true },
    { id: "offset", label: "Offset (-1..1)", kind: "number", step: 0.05 },
    { id: "invert", label: "Invert", kind: "boolean" },
    { id: "randomize", label: "Randomize Order", kind: "boolean" },
    { id: "randomSeed", label: "Random Seed", kind: "number", step: 1 },
    { id: "easeHigh", label: "Ease High", kind: "number", step: 0.1 },
    { id: "easeLow", label: "Ease Low", kind: "number", step: 0.1 },
    { id: "wiggleAmount", label: "Wiggle Amount", kind: "number", step: 0.05 },
    { id: "wiggleSpeed", label: "Wiggle Speed", kind: "number", step: 0.2 },
  ],
  evaluate: (inputs, params, ctx) => {
    const rawCount = inputs.count !== undefined ? Number(inputs.count) : Number(params.count ?? 10);
    const count = Math.max(0, Math.floor(rawCount));

    let offset = inputs.offset !== undefined ? Number(inputs.offset) : Number(params.offset ?? 0);
    if (inputs.progress !== undefined) {
      offset += Number(inputs.progress);
    }

    const start = inputs.start !== undefined ? Number(inputs.start) : Number(params.start ?? 0);
    const end = inputs.end !== undefined ? Number(inputs.end) : Number(params.end ?? 1);

    const weights = computeRangeWeights(count, {
      start,
      end,
      offset,
      shape: (String(params.shape ?? "smooth")) as RangeSelectorShape,
      invert: Boolean(params.invert ?? false),
      randomize: Boolean(params.randomize ?? false),
      randomSeed: Number(params.randomSeed ?? 42),
      easeHigh: Number(params.easeHigh ?? 0),
      easeLow: Number(params.easeLow ?? 0),
      wiggleAmount: Number(params.wiggleAmount ?? 0),
      wiggleSpeed: Number(params.wiggleSpeed ?? 1),
      time: ctx.time,
    });

    const activeCount = weights.filter((w) => w > 0.001).length;

    return {
      weights,
      activeCount,
    };
  },
};

// ---------------------------------------------------------------------------
// 4. CURVE TEXT ON PATH NODE (3D Text along Spline)
// ---------------------------------------------------------------------------

interface TextOnPathState {
  group: THREE.Group;
  charGeometries: THREE.BufferGeometry[];
  charMeshes: THREE.Mesh[];
  dummyMesh: THREE.Mesh;
  lastText?: string;
  lastFont?: Font;
  lastFontSize?: number;
  lastDepth?: number;
}

const pathTextCache = createNodeCache<TextOnPathState>((s) => disposeObject3D(s.group));

export const CURVE_TEXT_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "text", label: "Text", kind: "text", group: "Typography" },
  { id: "fontPreset", label: "Font", kind: "select", options: FONT_NAMES, group: "Typography" },
  { id: "fontSize", label: "Font Size (px)", kind: "number", step: 4, group: "Typography" },
  { id: "depth", label: "Depth / Relief", kind: "number", step: 0.05, group: "Typography" },
  { id: "offset", label: "Path Offset (0..1)", kind: "number", step: 0.02, percent: true, group: "Path" },
  { id: "tracking", label: "Tracking", kind: "number", step: 0.5, group: "Typography" },
  { id: "fitToCurve", label: "Fit to Curve Length", kind: "boolean", group: "Path" },
];

export const CURVE_TEXT_ON_PATH_NODE: NodeDefinition = {
  type: "curve/text-on-path",
  label: "Text on Path",
  category: "curve",
  inputs: [
    { id: "text", label: "Text", type: "text" },
    { id: "curve", label: "Curve", type: "curve" },
    { id: "fontSize", label: "Font Size", type: "value" },
    { id: "depth", label: "Depth", type: "value" },
    { id: "offset", label: "Offset", type: "value" },
    { id: "tracking", label: "Tracking", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrices", label: "Matrices", type: "list" },
    { id: "positions", label: "Positions", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    text: "FLOW ALONG CURVE",
    fontPreset: "Montserrat",
    fontSize: 48,
    depth: 0.1,
    offset: 0,
    tracking: 0,
    fitToCurve: false,
    ...COMMON_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields(CURVE_TEXT_PARAM_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(CURVE_TEXT_PARAM_FIELDS),
  evaluate: (inputs, params, ctx) => {
    let state = pathTextCache.get(ctx.nodeId);
    if (!state) {
      const group = new THREE.Group();
      group.name = `TextOnPath_${ctx.nodeId}`;
      const dummyMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.3,
          metalness: 0.2,
        })
      );
      state = {
        group,
        charGeometries: [],
        charMeshes: [],
        dummyMesh,
      };
      pathTextCache.set(ctx.nodeId, state);
    }

    const group = state.group;
    const textStr = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "FLOW ALONG CURVE");
    const fontSize = Math.max(8, numberInput(inputs.fontSize, params.fontSize, 48));
    const depth = Math.max(0.001, numberInput(inputs.depth, params.depth, 0.1));
    const offset = numberInput(inputs.offset, params.offset, 0);
    const tracking = numberInput(inputs.tracking, params.tracking, 0);
    const fitToCurve = Boolean(params.fitToCurve ?? false);

    const curve = (inputs.curve as THREE.Curve<THREE.Vector3>) || null;
    const font = BUILTIN_FONTS[String(params.fontPreset ?? "Montserrat")] ?? defaultFont;

    const layout = computeTextLayout(textStr, font, {
      fontSize,
      tracking,
      curve,
      pathOffset: offset,
      alignToPath: true,
      fitToCurve,
      anchor: "glyph_center",
    });

    const glyphs = layout.glyphs;
    const count = glyphs.length;

    const needsRebuild =
      state.lastText !== textStr ||
      state.lastFont !== font ||
      state.lastFontSize !== fontSize ||
      state.lastDepth !== depth;

    if (needsRebuild) {
      for (const geom of state.charGeometries) {
        geom.dispose();
      }
      state.charGeometries = [];
      while (group.children.length > 0) {
        group.remove(group.children[group.children.length - 1]);
      }
      state.charMeshes = [];

      for (let i = 0; i < count; i++) {
        const g = glyphs[i];
        let geom: THREE.BufferGeometry;
        if (g.shapes.length > 0) {
          geom = new THREE.ExtrudeGeometry(g.shapes, {
            depth,
            bevelEnabled: true,
            bevelThickness: Math.min(0.02, depth * 0.2),
            bevelSize: Math.min(0.01, depth * 0.1),
            bevelSegments: 3,
            curveSegments: 8,
          });
          applyAnchorToGeometry(geom, "glyph_center");
        } else {
          geom = new THREE.BufferGeometry();
        }

        state.charGeometries.push(geom);
        const mesh = new THREE.Mesh(geom, state.dummyMesh.material);
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
        state.charMeshes.push(mesh);
      }

      state.lastText = textStr;
      state.lastFont = font;
      state.lastFontSize = fontSize;
      state.lastDepth = depth;
    }

    // Material and texture updates
    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    updateCharMeshesMaterial(state.charMeshes, state.dummyMesh, matParams, texParams);

    // Root pose
    const baseRootMatrix = composeNativeMatrix(
      inputs.matrix,
      params.location,
      params.rotation,
      params.scale,
      params
    );
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(baseRootMatrix);
    }

    const outMatrices: THREE.Matrix4[] = [];
    const outPositions: THREE.Vector3[] = [];

    for (let i = 0; i < count; i++) {
      const g = glyphs[i];
      const mesh = state.charMeshes[i];
      if (mesh) {
        mesh.matrix.copy(g.baseMatrix);
        mesh.visible = g.shapes.length > 0;
      }
      const worldMat = new THREE.Matrix4().multiplyMatrices(group.matrix, g.baseMatrix);
      outMatrices.push(worldMat);
      outPositions.push(new THREE.Vector3().setFromMatrixPosition(worldMat));
    }

    return {
      geometry: group,
      matrices: outMatrices,
      positions: outPositions,
      count,
      matrix: group.matrix,
    };
  },
};
