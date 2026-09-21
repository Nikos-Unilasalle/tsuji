import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { asColor, numberInput, textureHasAlpha } from "./object";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { worldMatrixOf } from "../objectPosition";
import { preserveModifierUserData } from "./transform";

export function hasAlphaCutout(mesh: THREE.Mesh): boolean {
  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as any;
  if (!mat) return false;
  const tex = mat.map || mat.uniforms?.baseMap?.value || mat.uniforms?.map?.value;
  if (!tex || !(tex instanceof THREE.Texture)) return false;
  if (!mat.transparent) return false;
  if (tex.image && (typeof document !== "undefined" || "data" in (tex.image as any))) {
    return textureHasAlpha(tex);
  }
  return true;
}
import {
  createModifierDuotoneMaterial,
  createModifierHalftoneMaterial,
  createModifierFilmTextureMaterial,
  createModifierDryBrushMaterial,
  createModifierSuper8Material,
  createModifierOutlineMaterial,
} from "../../three/shaders/modifiersFilmShaders";

interface StyleTarget {
  sourceMesh: THREE.Mesh;
  outputMesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

interface ModifierState {
  object?: THREE.Object3D;
  targets?: StyleTarget[];
  signature?: string;
}

function createModifierCache() {
  return createNodeCache<ModifierState>((state) => {
    if (state.targets) {
      for (const t of state.targets) {
        t.material.dispose();
      }
      state.targets = undefined;
    }
    state.object = undefined;
  });
}

function reuseStyleTargets(
  state: ModifierState,
  meshes: THREE.Mesh[],
  createMat: () => THREE.ShaderMaterial,
): StyleTarget[] {
  const signature = meshes.map((m) => `${m.uuid}:${m.geometry.uuid}`).join("|");

  if (state.targets && state.signature === signature) {
    for (const t of state.targets) {
      if (t.outputMesh.geometry !== t.sourceMesh.geometry) {
        t.outputMesh.geometry = t.sourceMesh.geometry;
      }
      t.outputMesh.castShadow = t.sourceMesh.castShadow;
      t.outputMesh.receiveShadow = t.sourceMesh.receiveShadow;
    }
    return state.targets;
  }

  if (state.targets) {
    for (const t of state.targets) {
      t.material.dispose();
    }
  }

  state.targets = meshes.map((sourceMesh) => {
    const material = createMat();
    (material as any).__isModifierMaterial = true;
    const outputMesh = new THREE.Mesh(sourceMesh.geometry, material);
    outputMesh.castShadow = sourceMesh.castShadow;
    outputMesh.receiveShadow = sourceMesh.receiveShadow;
    outputMesh.renderOrder = sourceMesh.renderOrder;
    return {
      sourceMesh,
      outputMesh,
      material,
    };
  });
  state.signature = signature;
  state.object = undefined;
  return state.targets;
}

function styledObject(state: ModifierState, targets: StyleTarget[], raw: THREE.Object3D): THREE.Object3D {
  const single = raw instanceof THREE.Mesh && targets.length === 1;
  if (state.object && (single ? state.object === targets[0].outputMesh : state.object.children.length === targets.length)) {
    return state.object;
  }

  if (single) {
    state.object = targets[0].outputMesh;
    return state.object;
  }

  const group = new THREE.Group();
  for (const target of targets) group.add(target.outputMesh);
  state.object = group;
  return group;
}

function resolveObjectMatrix(
  inputs: Record<string, unknown>,
  _raw: THREE.Object3D,
  srcMesh: THREE.Mesh,
): THREE.Matrix4 {
  if (inputs.matrix instanceof THREE.Matrix4) {
    return inputs.matrix.clone();
  }
  return worldMatrixOf(srcMesh);
}

function applyResultTransform(
  resultObj: THREE.Object3D,
  matrix: THREE.Matrix4,
  nodeId: string,
  raw: THREE.Object3D,
  srcMesh: THREE.Mesh,
) {
  resultObj.castShadow = srcMesh.castShadow;
  resultObj.receiveShadow = srcMesh.receiveShadow;
  preserveModifierUserData(resultObj, raw, srcMesh, nodeId);
  resultObj.matrixAutoUpdate = false;
  resultObj.matrix.copy(matrix);
  matrix.decompose(resultObj.position, resultObj.quaternion, resultObj.scale);
  resultObj.matrixWorldNeedsUpdate = true;
  resultObj.updateMatrixWorld(true);
}

function syncBaseMaterialProps(target: StyleTarget) {
  const origMat = (Array.isArray(target.sourceMesh.material)
    ? target.sourceMesh.material[0]
    : target.sourceMesh.material) as any;

  // If the upstream mesh already has a film modifier material, inherit all its active stages!
  if (origMat && origMat.__isModifierMaterial && origMat.uniforms) {
    for (const [key, uniform] of Object.entries(origMat.uniforms)) {
      if (target.material.uniforms[key] && uniform && (uniform as any).value !== undefined) {
        const val = (uniform as any).value;
        if (val instanceof THREE.Color) {
          target.material.uniforms[key].value.copy(val);
        } else if (val instanceof THREE.Vector2) {
          target.material.uniforms[key].value.copy(val);
        } else if (val instanceof THREE.Vector3) {
          target.material.uniforms[key].value.copy(val);
        } else {
          target.material.uniforms[key].value = val;
        }
      }
    }
  } else {
    const color = origMat?.color instanceof THREE.Color ? origMat.color : new THREE.Color(0xffffff);
    const map = origMat?.map instanceof THREE.Texture ? origMat.map : null;
    const opacity = typeof origMat?.opacity === "number" ? origMat.opacity : 1.0;

    target.material.uniforms.baseColor.value.copy(color);
    target.material.uniforms.baseOpacity.value = opacity;
    target.material.uniforms.baseMap.value = map;
    target.material.uniforms.hasMap.value = map ? 1.0 : 0.0;
  }

  const isTransparent = Boolean(origMat?.transparent || (origMat?.opacity !== undefined && origMat.opacity < 0.999) || origMat?.map);
  if (target.material.transparent !== isTransparent) {
    target.material.transparent = isTransparent;
    target.material.needsUpdate = true;
  }
  if (origMat?.side !== undefined && target.material.side !== origMat.side) {
    target.material.side = origMat.side;
    target.material.needsUpdate = true;
  }
  if (origMat?.depthWrite !== undefined && target.material.depthWrite !== origMat.depthWrite) {
    target.material.depthWrite = origMat.depthWrite;
  }
}

// ---------------------------------------------------------------------------
// 1. DUAL TONE MODIFIER NODE
// ---------------------------------------------------------------------------
const duotoneCache = createModifierCache();

export const MODIFIER_DUOTONE_NODE: NodeDefinition = {
  type: "modifier/duotone",
  label: "Dual Tone",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "shadowColor", label: "Shadow Color", type: "color" },
    { id: "highlightColor", label: "Highlight Color", type: "color" },
    { id: "balance", label: "Balance", type: "value" },
    { id: "softness", label: "Softness", type: "value" },
    { id: "amount", label: "Amount", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    shadowColor: new THREE.Color(0x1b2a4a),
    highlightColor: new THREE.Color(0xffd9a0),
    balance: 0.5,
    softness: 0.5,
    amount: 1.0,
  },
  paramFields: [
    { id: "shadowColor", label: "Shadow Color", kind: "color" },
    { id: "highlightColor", label: "Highlight Color", kind: "color" },
    { id: "balance", label: "Balance", kind: "number", step: 0.02 },
    { id: "softness", label: "Softness", kind: "number", step: 0.02 },
    { id: "amount", label: "Amount", kind: "number", percent: true, step: 5 },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      return { geometry: raw, matrix: (raw as any)?.matrix ?? new THREE.Matrix4() };
    }

    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Dual Tone", raw);
      return { geometry: raw, matrix: raw.matrix.clone() };
    }
    clearMeshWarning(ctx.nodeId);

    let state = duotoneCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      duotoneCache.set(ctx.nodeId, state);
    }

    const targets = reuseStyleTargets(state, meshes, createModifierDuotoneMaterial);
    const shadowColor = asColor(inputs.shadowColor, asColor(params.shadowColor, new THREE.Color(0x1b2a4a)));
    const highlightColor = asColor(inputs.highlightColor, asColor(params.highlightColor, new THREE.Color(0xffd9a0)));
    const balance = Math.max(0, Math.min(1, numberInput(inputs.balance, params.balance, 0.5)));
    const softness = Math.max(0, Math.min(1, numberInput(inputs.softness, params.softness, 0.5)));
    const amount = Math.max(0, Math.min(1, numberInput(inputs.amount, params.amount, 1.0)));

    for (const target of targets) {
      syncBaseMaterialProps(target);
      target.material.uniforms.enableDuotone.value = 1.0;
      target.material.uniforms.shadowColor.value.copy(shadowColor);
      target.material.uniforms.highlightColor.value.copy(highlightColor);
      target.material.uniforms.balance.value = balance;
      target.material.uniforms.softness.value = softness;
      target.material.uniforms.amount.value = amount;
    }

    const resultObj = styledObject(state, targets, raw);
    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    applyResultTransform(resultObj, objMatrix, ctx.nodeId, raw, meshes[0]);

    return { geometry: resultObj, matrix: resultObj.matrix.clone() };
  },
};

// ---------------------------------------------------------------------------
// 2. HALFTONE MODIFIER NODE
// ---------------------------------------------------------------------------
const halftoneCache = createModifierCache();
const HALFTONE_SHAPES = ["dot", "ellipse", "line", "square"];

export const MODIFIER_HALFTONE_NODE: NodeDefinition = {
  type: "modifier/halftone",
  label: "Halftone",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "radius", label: "Dot Radius (px)", type: "value" },
    { id: "screenAngle", label: "Screen Angle (°)", type: "value" },
    { id: "scatter", label: "Scatter", type: "value" },
    { id: "amount", label: "Amount", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    radius: 4,
    screenAngle: 15,
    scatter: 0,
    amount: 1.0,
    shape: "dot",
    greyscale: 0,
    space: "screen",
  },
  paramFields: [
    { id: "shape", label: "Shape", kind: "select", options: HALFTONE_SHAPES },
    { id: "space", label: "Coordinate Space", kind: "select", options: ["screen", "uv"] },
    { id: "radius", label: "Dot Radius (px)", kind: "number", step: 1 },
    { id: "screenAngle", label: "Screen Angle (°)", kind: "number", step: 5 },
    { id: "scatter", label: "Scatter", kind: "number", step: 0.05 },
    { id: "amount", label: "Amount", kind: "number", percent: true, step: 5 },
    { id: "greyscale", label: "Greyscale", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      return { geometry: raw, matrix: (raw as any)?.matrix ?? new THREE.Matrix4() };
    }

    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Halftone", raw);
      return { geometry: raw, matrix: raw.matrix.clone() };
    }
    clearMeshWarning(ctx.nodeId);

    let state = halftoneCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      halftoneCache.set(ctx.nodeId, state);
    }

    const targets = reuseStyleTargets(state, meshes, createModifierHalftoneMaterial);
    const radius = Math.max(1, numberInput(inputs.radius, params.radius, 4));
    const screenAngle = numberInput(inputs.screenAngle, params.screenAngle, 15);
    const scatter = Math.max(0, numberInput(inputs.scatter, params.scatter, 0));
    const amount = Math.max(0, Math.min(1, numberInput(inputs.amount, params.amount, 1.0)));
    const shapeStr = String(params.shape ?? "dot");
    const shapeIdx = HALFTONE_SHAPES.indexOf(shapeStr) >= 0 ? HALFTONE_SHAPES.indexOf(shapeStr) : 0;
    const greyscale = toBoolean(params.greyscale ?? 0) ? 1.0 : 0.0;
    const space = String(params.space ?? "screen") === "uv" ? 1.0 : 0.0;

    for (const target of targets) {
      syncBaseMaterialProps(target);
      target.material.uniforms.enableHalftone.value = 1.0;
      target.material.uniforms.shape.value = shapeIdx;
      target.material.uniforms.radius.value = radius;
      target.material.uniforms.screenAngle.value = (screenAngle * Math.PI) / 180;
      target.material.uniforms.scatter.value = scatter;
      target.material.uniforms.halftoneAmount.value = amount;
      target.material.uniforms.greyscale.value = greyscale;
      target.material.uniforms.space.value = space;
    }

    const resultObj = styledObject(state, targets, raw);
    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    applyResultTransform(resultObj, objMatrix, ctx.nodeId, raw, meshes[0]);

    return { geometry: resultObj, matrix: resultObj.matrix.clone() };
  },
};

// ---------------------------------------------------------------------------
// 3. FILM TEXTURE MODIFIER NODE
// ---------------------------------------------------------------------------
const filmTextureCache = createModifierCache();

export const MODIFIER_FILM_TEXTURE_NODE: NodeDefinition = {
  type: "modifier/film-texture",
  label: "Film Texture",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "grain", label: "Grain", type: "value" },
    { id: "dust", label: "Dust", type: "value" },
    { id: "scratches", label: "Scratches", type: "value" },
    { id: "blotches", label: "Blotches", type: "value" },
    { id: "rate", label: "Rate (fps)", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    grain: 0.15,
    dust: 0.2,
    scratches: 0.15,
    blotches: 0.15,
    rate: 16,
    seed: 0,
  },
  paramFields: [
    { id: "grain", label: "Grain", kind: "number", step: 0.02 },
    { id: "dust", label: "Dust", kind: "number", step: 0.05 },
    { id: "scratches", label: "Scratches", kind: "number", step: 0.05 },
    { id: "blotches", label: "Blotches", kind: "number", step: 0.05 },
    { id: "rate", label: "Rate (fps)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      return { geometry: raw, matrix: (raw as any)?.matrix ?? new THREE.Matrix4() };
    }

    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Film Texture", raw);
      return { geometry: raw, matrix: raw.matrix.clone() };
    }
    clearMeshWarning(ctx.nodeId);

    let state = filmTextureCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      filmTextureCache.set(ctx.nodeId, state);
    }

    const targets = reuseStyleTargets(state, meshes, createModifierFilmTextureMaterial);
    const grain = Math.max(0, Math.min(1, numberInput(inputs.grain, params.grain, 0.15)));
    const dust = Math.max(0, Math.min(1, numberInput(inputs.dust, params.dust, 0.2)));
    const scratches = Math.max(0, Math.min(1, numberInput(inputs.scratches, params.scratches, 0.15)));
    const blotches = Math.max(0, Math.min(1, numberInput(inputs.blotches, params.blotches, 0.15)));
    const rate = Math.max(1, numberInput(inputs.rate, params.rate, 16));
    const seed = numberInput(undefined, params.seed, 0);

    for (const target of targets) {
      syncBaseMaterialProps(target);
      target.material.uniforms.enableFilmTexture.value = 1.0;
      target.material.uniforms.time.value = ctx.time ?? 0;
      target.material.uniforms.filmRate.value = rate;
      target.material.uniforms.grain.value = grain;
      target.material.uniforms.dust.value = dust;
      target.material.uniforms.scratches.value = scratches;
      target.material.uniforms.blotches.value = blotches;
      target.material.uniforms.filmSeed.value = seed;
    }

    const resultObj = styledObject(state, targets, raw);
    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    applyResultTransform(resultObj, objMatrix, ctx.nodeId, raw, meshes[0]);

    return { geometry: resultObj, matrix: resultObj.matrix.clone() };
  },
};

// ---------------------------------------------------------------------------
// 4. DRY BRUSH MODIFIER NODE
// ---------------------------------------------------------------------------
const dryBrushCache = createModifierCache();

export const MODIFIER_DRY_BRUSH_NODE: NodeDefinition = {
  type: "modifier/dry-brush",
  label: "Dry Brush",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "coverage", label: "Coverage", type: "value" },
    { id: "speckSize", label: "Speck Size", type: "value" },
    { id: "softness", label: "Softness", type: "value" },
    { id: "stretch", label: "Stroke Length", type: "value" },
    { id: "strokeAngle", label: "Stroke Angle (°)", type: "value" },
    { id: "paperColor", label: "Paper Color", type: "color" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    coverage: 0.25,
    speckSize: 60,
    softness: 0.25,
    stretch: 3,
    strokeAngle: 0,
    paperColor: new THREE.Color(0xffffff),
    followInk: 1,
    animate: 0,
    rate: 12,
    seed: 0,
  },
  paramFields: [
    { id: "coverage", label: "Coverage", kind: "number", percent: true, step: 2 },
    { id: "speckSize", label: "Speck Size", kind: "number", step: 5 },
    { id: "softness", label: "Softness", kind: "number", step: 0.05 },
    { id: "stretch", label: "Stroke Length", kind: "number", step: 0.5 },
    { id: "strokeAngle", label: "Stroke Angle (°)", kind: "number", step: 5 },
    { id: "paperColor", label: "Paper Color", kind: "color" },
    { id: "followInk", label: "Only Where Painted", kind: "boolean" },
    { id: "animate", label: "Animate (boil)", kind: "boolean" },
    { id: "rate", label: "Rate (fps)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      return { geometry: raw, matrix: (raw as any)?.matrix ?? new THREE.Matrix4() };
    }

    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Dry Brush", raw);
      return { geometry: raw, matrix: raw.matrix.clone() };
    }
    clearMeshWarning(ctx.nodeId);

    let state = dryBrushCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      dryBrushCache.set(ctx.nodeId, state);
    }

    const targets = reuseStyleTargets(state, meshes, createModifierDryBrushMaterial);
    const coverage = Math.max(0, Math.min(1, numberInput(inputs.coverage, params.coverage, 0.25)));
    const size = Math.max(1, Math.min(400, numberInput(inputs.speckSize, params.speckSize, 60)));
    const softness = Math.max(0, Math.min(1, numberInput(inputs.softness, params.softness, 0.25)));
    const stretch = Math.max(0.1, Math.min(20, numberInput(inputs.stretch, params.stretch, 3)));
    const strokeAngle = numberInput(inputs.strokeAngle, params.strokeAngle, 0);
    const paperColor = asColor(inputs.paperColor, asColor(params.paperColor, new THREE.Color(0xffffff)));
    const followInk = toBoolean(params.followInk ?? 1) ? 1.0 : 0.0;
    const animate = toBoolean(params.animate ?? 0) ? 1.0 : 0.0;
    const rate = Math.max(1, numberInput(undefined, params.rate, 12));
    const seed = numberInput(undefined, params.seed, 0);

    for (const target of targets) {
      syncBaseMaterialProps(target);
      target.material.uniforms.enableDryBrush.value = 1.0;
      target.material.uniforms.time.value = ctx.time ?? 0;
      target.material.uniforms.dryBrushRate.value = rate;
      target.material.uniforms.dryBrushAnimate.value = animate;
      target.material.uniforms.coverage.value = coverage;
      target.material.uniforms.dryBrushScale.value = size;
      target.material.uniforms.dryBrushSoftness.value = softness;
      target.material.uniforms.stretch.value = stretch;
      target.material.uniforms.dryBrushAngle.value = (strokeAngle * Math.PI) / 180;
      target.material.uniforms.followInk.value = followInk;
      target.material.uniforms.paperColor.value.copy(paperColor);
      target.material.uniforms.dryBrushSeed.value = seed;
    }

    const resultObj = styledObject(state, targets, raw);
    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    applyResultTransform(resultObj, objMatrix, ctx.nodeId, raw, meshes[0]);

    return { geometry: resultObj, matrix: resultObj.matrix.clone() };
  },
};

// ---------------------------------------------------------------------------
// 5. SUPER 8 PROJECTOR MODIFIER NODE
// ---------------------------------------------------------------------------
const super8Cache = createModifierCache();

export const MODIFIER_SUPER8_NODE: NodeDefinition = {
  type: "modifier/super8",
  label: "Super 8 Projector",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "softness", label: "Softness (px)", type: "value" },
    { id: "flicker", label: "Flicker", type: "value" },
    { id: "weave", label: "Gate Weave", type: "value" },
    { id: "warmth", label: "Warmth", type: "value" },
    { id: "rate", label: "Rate (fps)", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    softness: 1.0,
    flicker: 0.12,
    weave: 0.25,
    warmth: 0.35,
    rate: 18,
    seed: 0,
  },
  paramFields: [
    { id: "softness", label: "Softness", kind: "number", step: 0.1 },
    { id: "flicker", label: "Flicker", kind: "number", step: 0.02 },
    { id: "weave", label: "Gate Weave", kind: "number", step: 0.05 },
    { id: "warmth", label: "Warmth", kind: "number", percent: true, step: 5 },
    { id: "rate", label: "Rate (fps)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      return { geometry: raw, matrix: (raw as any)?.matrix ?? new THREE.Matrix4() };
    }

    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Super 8", raw);
      return { geometry: raw, matrix: raw.matrix.clone() };
    }
    clearMeshWarning(ctx.nodeId);

    let state = super8Cache.get(ctx.nodeId);
    if (!state) {
      state = {};
      super8Cache.set(ctx.nodeId, state);
    }

    const targets = reuseStyleTargets(state, meshes, createModifierSuper8Material);
    const softness = Math.max(0, Math.min(8, numberInput(inputs.softness, params.softness, 1.0)));
    const flicker = Math.max(0, Math.min(1, numberInput(inputs.flicker, params.flicker, 0.12)));
    const weave = Math.max(0, Math.min(3, numberInput(inputs.weave, params.weave, 0.25)));
    const warmth = Math.max(0, Math.min(1, numberInput(inputs.warmth, params.warmth, 0.35)));
    const rate = Math.max(1, numberInput(inputs.rate, params.rate, 18));
    const seed = numberInput(undefined, params.seed, 0);

    for (const target of targets) {
      syncBaseMaterialProps(target);
      target.material.uniforms.enableSuper8.value = 1.0;
      target.material.uniforms.time.value = ctx.time ?? 0;
      target.material.uniforms.super8Rate.value = rate;
      target.material.uniforms.super8Softness.value = softness;
      target.material.uniforms.flicker.value = flicker;
      target.material.uniforms.weave.value = weave;
      target.material.uniforms.warmth.value = warmth;
      target.material.uniforms.super8Seed.value = seed;
    }

    const resultObj = styledObject(state, targets, raw);
    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    applyResultTransform(resultObj, objMatrix, ctx.nodeId, raw, meshes[0]);

    return { geometry: resultObj, matrix: resultObj.matrix.clone() };
  },
};

// ---------------------------------------------------------------------------
// 6. OUTLINE MODIFIER NODE
// ---------------------------------------------------------------------------
const outlineCache = createModifierCache();

export const MODIFIER_OUTLINE_NODE: NodeDefinition = {
  type: "modifier/outline",
  label: "Outline",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "edgeColor", label: "Color", type: "color" },
    { id: "edgeThickness", label: "Thickness", type: "value" },
    { id: "sharpness", label: "Sharpness", type: "value" },
    { id: "outlineSide", label: "Side", type: "value" },
    { id: "edgeStrength", label: "Strength", type: "value" },
    { id: "alphaThreshold", label: "Alpha Threshold", type: "value" },
    { id: "silhouette", label: "Silhouette 3D", type: "value" },
    { id: "alphaEdge", label: "Alpha Cutout", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    edgeColor: new THREE.Color(0x000000),
    edgeThickness: 3.0,
    sharpness: 1.0,
    outlineSide: "outside",
    edgeStrength: 1.0,
    alphaThreshold: 0.1,
    silhouette: true,
    alphaEdge: true,
  },
  paramFields: [
    { id: "edgeColor", label: "Color", kind: "color" },
    { id: "edgeThickness", label: "Thickness", kind: "number", step: 0.5 },
    { id: "sharpness", label: "Sharpness (Flou/Net)", kind: "number", step: 0.05, percent: true },
    { id: "outlineSide", label: "Side", kind: "select", options: ["outside", "inside", "center"] },
    { id: "edgeStrength", label: "Strength", kind: "number", step: 0.1 },
    { id: "alphaThreshold", label: "Alpha Threshold", kind: "number", step: 0.05 },
    { id: "silhouette", label: "Silhouette 3D", kind: "boolean" },
    { id: "alphaEdge", label: "Alpha Cutout", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      return { geometry: raw, matrix: (raw as any)?.matrix ?? new THREE.Matrix4() };
    }

    const meshes = collectMeshes(raw);
    if (meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Outline", raw);
      return { geometry: raw, matrix: raw.matrix.clone() };
    }
    clearMeshWarning(ctx.nodeId);

    let state = outlineCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      outlineCache.set(ctx.nodeId, state);
    }

    const targets = reuseStyleTargets(state, meshes, createModifierOutlineMaterial);
    const edgeColor = asColor(inputs.edgeColor, asColor(params.edgeColor, new THREE.Color(0x000000)));
    const edgeThickness = Math.max(0.1, Math.min(50, numberInput(inputs.edgeThickness, params.edgeThickness, 3.0)));
    const sharpness = Math.max(0, Math.min(1, numberInput(inputs.sharpness, params.sharpness, 1.0)));
    const sideRaw = String(inputs.outlineSide ?? params.outlineSide ?? "outside").toLowerCase();
    const outlineSide = sideRaw === "inside" || sideRaw === "1" ? 1.0 : sideRaw === "center" || sideRaw === "2" ? 2.0 : 0.0;
    const edgeStrength = Math.max(0, Math.min(10, numberInput(inputs.edgeStrength, params.edgeStrength, 1.0)));
    const alphaThreshold = Math.max(0.01, Math.min(0.99, numberInput(inputs.alphaThreshold, params.alphaThreshold, 0.1)));
    const silhouette = inputs.silhouette !== undefined
      ? toBoolean(inputs.silhouette)
      : params.silhouette !== undefined
      ? toBoolean(params.silhouette)
      : true;
    const alphaEdge = inputs.alphaEdge !== undefined
      ? toBoolean(inputs.alphaEdge)
      : params.alphaEdge !== undefined
      ? toBoolean(params.alphaEdge)
      : true;

    const is3D = meshes.some((m) => !hasAlphaCutout(m)) && silhouette;

    for (const target of targets) {
      syncBaseMaterialProps(target);
      const meshHasAlpha = hasAlphaCutout(target.sourceMesh);
      target.material.uniforms.enableOutline.value = 1.0;
      target.material.uniforms.edgeColor.value.copy(edgeColor);
      target.material.uniforms.edgeThickness.value = edgeThickness;
      target.material.uniforms.sharpness.value = sharpness;
      target.material.uniforms.outlineSide.value = outlineSide;
      target.material.uniforms.edgeStrength.value = edgeStrength;
      target.material.uniforms.alphaThreshold.value = alphaThreshold;
      target.material.uniforms.outlineAlpha.value = (alphaEdge && meshHasAlpha) ? 1.0 : 0.0;
      // In-shader rim disabled: 3D silhouettes are rendered via 2D postprocess OutlinePass outside the object
      target.material.uniforms.outlineSilhouette.value = 0.0;
    }

    const resultObj = styledObject(state, targets, raw);
    const objMatrix = resolveObjectMatrix(inputs, raw, meshes[0]);
    applyResultTransform(resultObj, objMatrix, ctx.nodeId, raw, meshes[0]);

    resultObj.userData.outlineModifier = {
      is3D,
      edgeColor,
      edgeThickness,
      edgeStrength,
      sharpness,
      outlineSide,
      nodeId: ctx.nodeId,
    };
    for (const target of targets) {
      target.outputMesh.userData.outlineModifier = resultObj.userData.outlineModifier;
    }

    return { geometry: resultObj, matrix: resultObj.matrix.clone() };
  },
};

