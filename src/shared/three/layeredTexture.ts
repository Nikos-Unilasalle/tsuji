/**
 * Shared core for the three layered-texture nodes: Texture Paint, Texture Mix
 * and Topography Texture Mix.
 *
 * All three used to carry their own copy of the same lifecycle — discover the
 * connected texture layers, keep a backing canvas, wrap it in a CanvasTexture,
 * push that texture onto the incoming geometry's materials — which meant a fix
 * had to be written three times and, in practice, was not. This module owns
 * that lifecycle once; the nodes keep only what is genuinely theirs (which
 * weights to compute, and which brush edits them).
 *
 * The graph evaluates every node every frame (see evaluate.ts), so everything
 * here is built around doing nothing when nothing changed:
 * - layer bitmaps are cached per texture, not re-read per frame;
 * - the CanvasTexture is reused rather than rebuilt (a rebuild costs a full
 *   GPU upload plus a dispose);
 * - the output ImageData is allocated once and reused;
 * - compositing accepts the dirty rect a brush stroke already computes.
 */

import * as THREE from "three";
import { LayerSource } from "./textureMixEngine";
import { MAX_GPU_LAYERS, SplatGpuState, compositeOnGpu, disposeSplatGpu } from "./splatCompositorGPU";

export interface DirtyRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LayeredTextureState {
  /** Per-pixel, per-layer weights. Length = res * res * layerCount. */
  splatBuffer?: Float32Array;
  outCanvas?: HTMLCanvasElement;
  /** Reused across frames: createImageData at 1024² costs 4 MB a call. */
  outImage?: ImageData;
  splatCanvas?: HTMLCanvasElement;
  /**
   * What the node publishes: a CanvasTexture on the CPU path, a render
   * target's texture on the GPU one.
   */
  texture?: THREE.Texture;
  splatTexture?: THREE.CanvasTexture;
  material?: THREE.MeshStandardMaterial;
  group?: THREE.Group;
  /**
   * The layers resolved by the last evaluation.
   *
   * The viewport's brush needs them to recomposite mid-stroke, between two
   * graph evaluations. This field existed before but was never assigned, so
   * live painting composited against an empty layer list and fell back to the
   * debug palette until the next frame redrew it.
   */
  layers?: LayerSource[];
  layerCount?: number;
  res?: number;
  /**
   * Bumped by whoever edits `splatBuffer` outside the graph — the viewport's
   * brush. It is what lets the node's signature guard tell "nothing changed"
   * from "the artist just painted", without hashing a megabyte of weights
   * every frame.
   */
  splatVersion?: number;
  /** GPU compositing resources, allocated the first time a renderer shows up. */
  gpu?: SplatGpuState;
  /** True while the node's output texture comes from the GPU pass. */
  gpuActive?: boolean;
  lastSignature?: string;
  lastSplatData?: string;
  lastRes?: number;
  lastLayerCount?: number;
}

/**
 * Bitmaps extracted from layer textures, keyed by the texture itself.
 *
 * Deliberately a WeakMap and deliberately not registered in nodeCaches: it is
 * keyed by texture, not by node, so several nodes sharing one texture share
 * the extraction, and entries die with the texture.
 */
const layerBitmapCache = new WeakMap<THREE.Texture, { version: number; width: number; data: ImageData }>();

/**
 * Reads a texture's pixels, reusing the previous read when the texture has not
 * changed. Re-extracting means an offscreen canvas, a drawImage and a
 * getImageData — per layer, per frame, before this cache existed.
 */
export function getLayerBitmap(texture: THREE.Texture, size: number): ImageData | null {
  if (typeof document === "undefined") return null;

  const cached = layerBitmapCache.get(texture);
  if (cached && cached.version === texture.version && cached.width === size) {
    return cached.data;
  }

  const image = texture.image as CanvasImageSource & { width?: number; height?: number };
  if (!image || !image.width || !image.height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size);
    layerBitmapCache.set(texture, { version: texture.version, width: size, data });
    return data;
  } catch {
    // Cross-origin or not yet decoded.
    return null;
  }
}

/** Default swatches used when a layer has no texture wired yet. */
export const LAYER_FALLBACK_COLORS = [
  "#4ade80", // 0 grass
  "#78716c", // 1 rock
  "#f8fafc", // 2 snow
  "#fef08a", // 3 sand
  "#38bdf8", // 4 water
  "#c084fc",
  "#fb7185",
  "#facc15",
];

/** Default names, matching the fallback swatches. */
export const LAYER_DEFAULT_NAMES = [
  "Grass",
  "Rock",
  "Snow",
  "Sand",
  "Water",
  "Layer 6",
  "Layer 7",
  "Layer 8",
];

/**
 * What a layer is called in the UI.
 *
 * Layers are addressed by index everywhere in the data — that is what the
 * weight buffer is indexed by — but an index is not something an artist can
 * hold in their head across a dozen params ("Slope Texture Layer: 1"). Names
 * are stored per layer and shown wherever a layer has to be picked.
 */
export function layerName(params: Record<string, unknown>, index: number): string {
  const custom = params[`layerName${index}`];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  return LAYER_DEFAULT_NAMES[index] ?? `Layer ${index + 1}`;
}

/** Layer names for a whole stack, for select fields. */
export function layerNames(params: Record<string, unknown>, count: number): string[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => layerName(params, i));
}

export interface ResolveLayersOptions {
  /** Socket id prefix, e.g. "texture" for texture0, texture1, … */
  prefix: string;
  /** Minimum number of layer slots to report even when nothing is wired. */
  minLayers?: number;
  /** Hard cap, to keep a malformed graph from allocating forever. */
  maxLayers?: number;
  /** Bitmap extraction size; layers are sampled from this, not from the source resolution. */
  bitmapSize?: number;
}

/**
 * Collects the layer sources wired into a node, with their cached bitmaps.
 *
 * `uvScale{i}` is read here so per-layer tiling keeps working once the param
 * is actually exposed in the UI.
 */
export function resolveLayers(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  opts: ResolveLayersOptions,
): LayerSource[] {
  const prefix = opts.prefix;
  const minLayers = Math.max(1, opts.minLayers ?? 1);
  const maxLayers = Math.max(minLayers, opts.maxLayers ?? 16);
  const bitmapSize = Math.max(16, Math.min(1024, opts.bitmapSize ?? 512));

  const layers: LayerSource[] = [];
  for (let idx = 0; idx < maxLayers; idx++) {
    const wired = inputs[`${prefix}${idx}`] !== undefined;
    if (!wired && idx >= minLayers) break;

    const tex = inputs[`${prefix}${idx}`];
    const validTex = tex instanceof THREE.Texture ? tex : null;
    layers.push({
      texture: validTex,
      imageData: validTex ? getLayerBitmap(validTex, bitmapSize) : null,
      uvScale: Number(params[`uvScale${idx}`] ?? 1.0),
      color: LAYER_FALLBACK_COLORS[idx % LAYER_FALLBACK_COLORS.length],
    });
  }

  return layers;
}

/**
 * Identity of the resolved layers, for change detection.
 *
 * Texture identity plus version, so replacing an image or editing an upstream
 * canvas re-composites, while an unchanged frame does not.
 */
export function layersSignature(layers: LayerSource[]): string {
  return layers
    .map((l) => `${l.texture ? `${l.texture.uuid}:${l.texture.version}` : "-"}@${l.uvScale ?? 1}`)
    .join("|");
}

/**
 * Change key for an incoming geometry.
 *
 * Object3D.id is stable for the lifetime of the object, so a node keyed on it
 * never noticed a terrain being sculpted in place and kept serving a stale
 * bake. Position and normal attribute versions do change on edit.
 */
export function geometryVersionKey(object: THREE.Object3D | null | undefined): string {
  if (!object) return "none";
  const parts: string[] = [object.uuid];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const norm = mesh.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
    parts.push(
      `${mesh.geometry.uuid}:${pos ? `${pos.count}.${pos.version ?? 0}` : "-"}:${norm ? norm.version ?? 0 : "-"}`,
    );
  });
  return parts.join(",");
}

/** Allocates (or resizes) the canvases a layered node draws into. */
export function ensureLayeredCanvases(
  state: LayeredTextureState,
  res: number,
  createCanvas: (w: number, h: number, baseColor?: string) => HTMLCanvasElement,
  opts: { splatPreview?: boolean } = {},
): void {
  // Compared against the *requested* resolution, not the canvas width: the
  // canvas factory enforces a minimum size, so a small request would never
  // match its own canvas and would rebuild it on every single frame.
  const changed = state.res !== res;

  if (changed || !state.outCanvas) {
    state.outCanvas = createCanvas(res, res);
    state.outImage = undefined;
    // The old texture wrapped the old canvas; drop it so it is rebuilt.
    state.texture?.dispose();
    state.texture = undefined;
  }
  if (opts.splatPreview !== false && (changed || !state.splatCanvas)) {
    state.splatCanvas = createCanvas(res, res);
    state.splatTexture?.dispose();
    state.splatTexture = undefined;
  }
  state.res = res;
}

/**
 * Returns the CanvasTexture for a canvas, creating it only the first time.
 *
 * Rebuilding a CanvasTexture every frame (the previous behaviour) disposes a
 * live GPU texture and uploads a new one each time; flagging `needsUpdate` on
 * the existing one is the same picture for none of the cost.
 */
export function syncCanvasTexture(
  existing: THREE.Texture | undefined,
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
): THREE.CanvasTexture {
  if (existing instanceof THREE.CanvasTexture && existing.image === canvas) {
    existing.colorSpace = colorSpace;
    existing.needsUpdate = true;
    return existing;
  }
  existing?.dispose();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colorSpace;
  return texture;
}

/** Clamps a dirty rect to the canvas, returning null when it covers nothing. */
export function clampRegion(region: DirtyRect | null | undefined, width: number, height: number): DirtyRect | null {
  if (!region) return null;
  const minX = Math.max(0, Math.floor(region.minX));
  const minY = Math.max(0, Math.floor(region.minY));
  const maxX = Math.min(width - 1, Math.ceil(region.maxX));
  const maxY = Math.min(height - 1, Math.ceil(region.maxY));
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Blends the layers into the node's output canvas.
 *
 * Pass `region` — the rect a brush stroke reports — to repaint only what moved
 * instead of a million pixels per pointer event.
 */
export function compositeLayers(
  state: LayeredTextureState,
  layers: LayerSource[],
  region?: DirtyRect | null,
): void {
  const canvas = state.outCanvas;
  const weights = state.splatBuffer;
  if (!canvas || !weights) return;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const count = Math.max(1, layers.length);

  if (!state.outImage || state.outImage.width !== width || state.outImage.height !== height) {
    state.outImage = ctx.createImageData(width, height);
    // A fresh buffer knows nothing about what is already on the canvas, so the
    // first pass after a resize has to be a full one.
    region = null;
  }
  const out = state.outImage;
  const data = out.data;

  const area = clampRegion(region, width, height) ?? { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };

  for (let y = area.minY; y <= area.maxY; y++) {
    for (let x = area.minX; x <= area.maxX; x++) {
      const pixel = y * width + x;
      const pIdx = pixel * 4;
      const wIdx = pixel * count;

      let r = 0;
      let g = 0;
      let b = 0;

      for (let l = 0; l < count; l++) {
        const w = weights[wIdx + l];
        if (w <= 1e-4) continue;

        const layer = layers[l];
        let lr = 128;
        let lg = 128;
        let lb = 128;

        if (layer?.imageData) {
          const uvScale = Math.max(0.01, layer.uvScale ?? 1.0);
          const srcW = layer.imageData.width;
          const srcH = layer.imageData.height;
          const tx = Math.floor((((x * uvScale) % srcW) + srcW) % srcW);
          const ty = Math.floor((((y * uvScale) % srcH) + srcH) % srcH);
          const srcIdx = (ty * srcW + tx) * 4;
          lr = layer.imageData.data[srcIdx];
          lg = layer.imageData.data[srcIdx + 1];
          lb = layer.imageData.data[srcIdx + 2];
        } else if (layer?.color) {
          const c = new THREE.Color(layer.color);
          lr = c.r * 255;
          lg = c.g * 255;
          lb = c.b * 255;
        }

        r += lr * w;
        g += lg * w;
        b += lb * w;
      }

      data[pIdx] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[pIdx + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[pIdx + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      data[pIdx + 3] = 255;
    }
  }

  // putImageData's dirty-rect form uploads only the touched band.
  if (area.minX === 0 && area.minY === 0 && area.maxX === width - 1 && area.maxY === height - 1) {
    ctx.putImageData(out, 0, 0);
  } else {
    ctx.putImageData(out, 0, 0, area.minX, area.minY, area.maxX - area.minX + 1, area.maxY - area.minY + 1);
  }
}

/**
 * Composites the layers, on the GPU when a renderer is available.
 *
 * Returns the texture the node should publish: the render target's texture on
 * the GPU path, or the CanvasTexture wrapping the CPU-composited canvas.
 * Callers do not branch — they just use what comes back.
 */
export function compositeLayersAuto(
  state: LayeredTextureState,
  layers: LayerSource[],
  opts: {
    renderer?: THREE.WebGLRenderer | null;
    res: number;
    layerCount: number;
    region?: DirtyRect | null;
  },
): THREE.Texture | null {
  const { renderer, res, layerCount, region } = opts;

  if (renderer && layerCount <= MAX_GPU_LAYERS && state.splatBuffer) {
    if (!state.gpu) state.gpu = {};
    const texture = compositeOnGpu(renderer, state.gpu, layers, state.splatBuffer, res, layerCount, region);
    if (texture) {
      state.gpuActive = true;
      return texture;
    }
  }

  // No renderer (headless, tests, lost context) or too many layers: the CPU
  // path still produces exactly the same picture, just slower.
  state.gpuActive = false;
  if (!state.outCanvas) return state.texture ?? null;
  compositeLayers(state, layers, region);
  state.texture = syncCanvasTexture(state.texture, state.outCanvas, THREE.SRGBColorSpace);
  return state.texture;
}

/** Releases a node's GPU compositing resources. */
export function disposeLayeredTexture(state: LayeredTextureState): void {
  if (state.gpu) {
    disposeSplatGpu(state.gpu);
    state.gpu = undefined;
  }
  state.texture?.dispose();
  state.splatTexture?.dispose();
  state.material?.dispose();
}

/**
 * Pushes the node's texture onto the incoming geometry's materials.
 *
 * `marker` tags the meshes so the viewport can find the paint target for this
 * node (userData.isTexturePaintTarget / isTextureMixTarget).
 */
export function applyTextureToGeometry(
  inputGeom: THREE.Object3D | null,
  texture: THREE.Texture | null,
  fallbackMaterial: THREE.Material,
  nodeId: string,
  marker?: string,
): void {
  if (!inputGeom) return;

  // The map is written into the incoming material rather than into a copy.
  // Copy-on-write would stop two texture nodes on one input from overwriting
  // each other, but it also changes the material's identity — and this
  // codebase treats that identity as the thing that carries appearance
  // through a modifier chain (see nodeContracts.test.ts) and as the key an
  // instance pool reuses. Trading a documented invariant for a rare wiring
  // case is not worth it; wire a Material node if two nodes need to differ.
  inputGeom.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    if (mesh.material) {
      const apply = (m: THREE.Material) => {
        (m as THREE.MeshStandardMaterial).map = texture;
        m.needsUpdate = true;
      };
      if (Array.isArray(mesh.material)) mesh.material.forEach(apply);
      else apply(mesh.material);
    } else {
      mesh.material = fallbackMaterial;
    }

    mesh.userData.nodeId = nodeId;
    if (marker) mesh.userData[marker] = true;
  });
}

/** Creates or updates the standard material a layered node falls back to. */
export function syncLayeredMaterial(
  state: LayeredTextureState,
  params: Record<string, unknown>,
  defaults: { roughness: number; metalness: number },
): THREE.MeshStandardMaterial {
  const roughness = Number(params.roughness ?? defaults.roughness);
  const metalness = Number(params.metalness ?? defaults.metalness);

  if (!state.material) {
    state.material = new THREE.MeshStandardMaterial({
      map: state.texture ?? null,
      roughness,
      metalness,
    });
    return state.material;
  }

  const mat = state.material;
  // needsUpdate recompiles the shader program; only ask for it when the map
  // identity actually changed, not on every frame.
  const nextMap = state.texture ?? null;
  if (mat.map !== nextMap) {
    mat.map = nextMap;
    mat.needsUpdate = true;
  }
  mat.roughness = roughness;
  mat.metalness = metalness;
  return mat;
}
