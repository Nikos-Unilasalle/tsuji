/**
 * GPU compositor for the layered texture nodes.
 *
 * Blending N tiled layers through a per-pixel weight map is embarrassingly
 * parallel, and doing it in JavaScript cost ~160 ms per pass at 1024² with
 * four layers — per frame before the caching pass, and still per brush sample
 * after it. Here the weights live in a DataTexture, the layers stay as plain
 * textures, and a single full-screen pass blends them into a render target.
 *
 * The render target's texture is what the node hands downstream, so the
 * `texture` output keeps working exactly as before; only the arithmetic moved.
 *
 * Everything degrades to the CPU path (see layeredTexture.compositeLayers)
 * when there is no renderer — headless tests, or a context that was lost.
 */

import * as THREE from "three";
import { LayerSource } from "./textureMixEngine";
import { DirtyRect } from "./layeredTexture";

/** Layers carried per weight texture (one per RGBA channel). */
export const LAYERS_PER_SPLAT_TEXTURE = 4;
/** Hard ceiling, matching the two weight textures the shader binds. */
export const MAX_GPU_LAYERS = 8;

export interface SplatGpuState {
  /** Weights for layers 0-3 and 4-7, as RGBA8. */
  splatTextures?: THREE.DataTexture[];
  /** Backing byte arrays, kept so partial repacks do not reallocate. */
  splatBytes?: Uint8Array[];
  target?: THREE.WebGLRenderTarget;
  material?: THREE.ShaderMaterial;
  scene?: THREE.Scene;
  camera?: THREE.OrthographicCamera;
  quad?: THREE.Mesh;
  /** 1x1 white stand-in bound to the sampler slots of absent layers. */
  blankTexture?: THREE.DataTexture;
  res?: number;
  layerCount?: number;
}

/**
 * Quantizes the float weight buffer into the RGBA8 arrays the shader reads.
 *
 * `region` repacks only the rows a brush touched; 8-bit weights are what the
 * project format already stores, so this loses nothing that was kept anyway.
 */
export function packSplatBytes(
  weights: Float32Array,
  width: number,
  height: number,
  layerCount: number,
  targets: Uint8Array[],
  region?: DirtyRect | null,
): void {
  const count = Math.max(1, layerCount);
  const minX = region ? Math.max(0, Math.floor(region.minX)) : 0;
  const maxX = region ? Math.min(width - 1, Math.ceil(region.maxX)) : width - 1;
  const minY = region ? Math.max(0, Math.floor(region.minY)) : 0;
  const maxY = region ? Math.min(height - 1, Math.ceil(region.maxY)) : height - 1;

  for (let t = 0; t < targets.length; t++) {
    const bytes = targets[t];
    const layerBase = t * LAYERS_PER_SPLAT_TEXTURE;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const pixel = y * width + x;
        const src = pixel * count;
        const dst = pixel * 4;
        for (let c = 0; c < LAYERS_PER_SPLAT_TEXTURE; c++) {
          const layer = layerBase + c;
          const w = layer < count ? weights[src + layer] : 0;
          bytes[dst + c] = w <= 0 ? 0 : w >= 1 ? 255 : Math.round(w * 255);
        }
      }
    }
  }
}

/** How many weight textures a layer count needs. */
export function splatTextureCount(layerCount: number): number {
  return Math.min(2, Math.max(1, Math.ceil(Math.max(1, layerCount) / LAYERS_PER_SPLAT_TEXTURE)));
}

/**
 * Builds the fragment shader, unrolled over the layer slots.
 *
 * Unrolled rather than looped over a sampler array: dynamic indexing into
 * sampler arrays is only legal under narrow rules across GLSL versions, and
 * an unrolled chain is both portable and just as fast.
 */
export function buildSplatFragmentShader(maxLayers = MAX_GPU_LAYERS): string {
  const samplers: string[] = [];
  const blocks: string[] = [];

  for (let i = 0; i < maxLayers; i++) {
    samplers.push(`uniform sampler2D uLayer${i};`);
    samplers.push(`uniform float uTiling${i};`);
    samplers.push(`uniform vec3 uColor${i};`);
    samplers.push(`uniform float uHasTex${i};`);

    const weightExpr = i < LAYERS_PER_SPLAT_TEXTURE ? `w0[${i}]` : `w1[${i - LAYERS_PER_SPLAT_TEXTURE}]`;
    blocks.push(
      [
        `  if (uLayerCount > ${i}) {`,
        `    float w = ${weightExpr};`,
        `    if (w > 0.002) {`,
        `      vec3 c = mix(uColor${i}, texture2D(uLayer${i}, vUv * uTiling${i}).rgb, uHasTex${i});`,
        `      acc += c * w;`,
        `      total += w;`,
        `    }`,
        `  }`,
      ].join("\n"),
    );
  }

  return [
    "precision highp float;",
    "varying vec2 vUv;",
    "uniform sampler2D uSplat0;",
    "uniform sampler2D uSplat1;",
    "uniform int uLayerCount;",
    ...samplers,
    "void main() {",
    "  vec4 w0 = texture2D(uSplat0, vUv);",
    "  vec4 w1 = texture2D(uSplat1, vUv);",
    "  vec3 acc = vec3(0.0);",
    "  float total = 0.0;",
    ...blocks,
    // Normalizing by the accumulated weight keeps the result stable even if
    // the weights drifted away from summing to one.
    "  vec3 color = total > 0.0001 ? acc / total : vec3(0.5);",
    "  gl_FragColor = vec4(color, 1.0);",
    "}",
  ].join("\n");
}

const VERTEX_SHADER = [
  "varying vec2 vUv;",
  "void main() {",
  "  vUv = uv;",
  "  gl_Position = vec4(position.xy, 0.0, 1.0);",
  "}",
].join("\n");

function makeBlankTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/** Allocates (or resizes) the GPU resources for one node. */
export function ensureSplatGpu(state: SplatGpuState, res: number, layerCount: number): SplatGpuState {
  const texCount = splatTextureCount(layerCount);
  const sizeChanged = state.res !== res;
  const layersChanged = state.layerCount !== layerCount;

  if (sizeChanged || !state.splatTextures || state.splatTextures.length !== texCount) {
    state.splatTextures?.forEach((t) => t.dispose());
    state.splatBytes = [];
    state.splatTextures = [];
    for (let i = 0; i < texCount; i++) {
      const bytes = new Uint8Array(res * res * 4);
      const tex = new THREE.DataTexture(bytes, res, res, THREE.RGBAFormat);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      // packSplatBytes fills row 0 with the top of the stroke (same
      // convention applyMixStroke uses for the CPU/CanvasTexture path, which
      // defaults to flipY=true) — DataTexture defaults to flipY=false, so
      // without this the GPU path samples weights upside down and paint
      // lands mirrored vertically from where the stylus actually is.
      tex.flipY = true;
      tex.needsUpdate = true;
      state.splatBytes.push(bytes);
      state.splatTextures.push(tex);
    }
  }

  if (sizeChanged || !state.target) {
    state.target?.dispose();
    state.target = new THREE.WebGLRenderTarget(res, res, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    state.target.texture.colorSpace = THREE.SRGBColorSpace;
    state.target.texture.wrapS = THREE.RepeatWrapping;
    state.target.texture.wrapT = THREE.RepeatWrapping;
    state.target.texture.generateMipmaps = false;
    state.target.texture.minFilter = THREE.LinearFilter;
  }

  if (!state.blankTexture) state.blankTexture = makeBlankTexture();

  if (!state.material) {
    const uniforms: Record<string, THREE.IUniform> = {
      uSplat0: { value: null },
      uSplat1: { value: null },
      uLayerCount: { value: layerCount },
    };
    for (let i = 0; i < MAX_GPU_LAYERS; i++) {
      uniforms[`uLayer${i}`] = { value: state.blankTexture };
      uniforms[`uTiling${i}`] = { value: 1 };
      uniforms[`uColor${i}`] = { value: new THREE.Color(0.5, 0.5, 0.5) };
      uniforms[`uHasTex${i}`] = { value: 0 };
    }
    state.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: buildSplatFragmentShader(),
      depthTest: false,
      depthWrite: false,
    });
  }

  if (!state.scene || !state.camera || !state.quad) {
    state.scene = new THREE.Scene();
    state.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // Clip-space triangle pair; the vertex shader passes positions straight
    // through, so no camera matrices are involved.
    state.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), state.material);
    state.quad.frustumCulled = false;
    state.scene.add(state.quad);
  } else {
    state.quad.material = state.material;
  }

  if (layersChanged) {
    state.material.uniforms.uLayerCount.value = layerCount;
  }

  state.res = res;
  state.layerCount = layerCount;
  return state;
}

/** Repacks and uploads the weight textures, optionally only a dirty rect. */
export function uploadSplatWeights(
  state: SplatGpuState,
  weights: Float32Array,
  res: number,
  layerCount: number,
  region?: DirtyRect | null,
): void {
  if (!state.splatBytes || !state.splatTextures) return;
  packSplatBytes(weights, res, res, layerCount, state.splatBytes, region);
  for (const tex of state.splatTextures) tex.needsUpdate = true;
}

/** Points the shader's layer slots at the resolved layer sources. */
export function bindLayerUniforms(state: SplatGpuState, layers: LayerSource[]): void {
  if (!state.material) return;
  const uniforms = state.material.uniforms;

  for (let i = 0; i < MAX_GPU_LAYERS; i++) {
    const layer = layers[i];
    const texture = layer?.texture ?? null;
    uniforms[`uLayer${i}`].value = texture ?? state.blankTexture;
    uniforms[`uHasTex${i}`].value = texture ? 1 : 0;
    uniforms[`uTiling${i}`].value = Math.max(0.01, layer?.uvScale ?? 1);
    if (layer?.color) (uniforms[`uColor${i}`].value as THREE.Color).set(layer.color);
  }

  uniforms.uSplat0.value = state.splatTextures?.[0] ?? state.blankTexture;
  uniforms.uSplat1.value = state.splatTextures?.[1] ?? state.blankTexture;
  uniforms.uLayerCount.value = Math.min(MAX_GPU_LAYERS, Math.max(1, layers.length));
}

/**
 * Runs the composite pass and returns the resulting texture.
 *
 * Returns null when there is nothing to render with, which is the caller's
 * signal to fall back to the CPU compositor.
 */
export function compositeOnGpu(
  renderer: THREE.WebGLRenderer | null | undefined,
  state: SplatGpuState,
  layers: LayerSource[],
  weights: Float32Array,
  res: number,
  layerCount: number,
  region?: DirtyRect | null,
): THREE.Texture | null {
  if (!renderer || layerCount > MAX_GPU_LAYERS) return null;

  ensureSplatGpu(state, res, layerCount);
  uploadSplatWeights(state, weights, res, layerCount, region);
  bindLayerUniforms(state, layers);

  if (!state.target || !state.scene || !state.camera) return null;

  // The node runs inside the app's frame, so the renderer's state belongs to
  // someone else: borrow it and put it back exactly as found.
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  renderer.setRenderTarget(state.target);
  renderer.render(state.scene, state.camera);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;

  return state.target.texture;
}

/** Frees everything this node allocated on the GPU. */
export function disposeSplatGpu(state: SplatGpuState): void {
  state.splatTextures?.forEach((t) => t.dispose());
  state.target?.dispose();
  state.material?.dispose();
  state.blankTexture?.dispose();
  state.quad?.geometry.dispose();
  state.splatTextures = undefined;
  state.splatBytes = undefined;
  state.target = undefined;
  state.material = undefined;
  state.blankTexture = undefined;
  state.quad = undefined;
  state.scene = undefined;
  state.camera = undefined;
}
