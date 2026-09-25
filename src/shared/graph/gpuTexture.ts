import * as THREE from "three";
import type { ParamFieldDef } from "./types";

/**
 * Shared plumbing for GPU texture passes: every texture-tool node (Blur,
 * Levels, Mix, …) renders a fullscreen quad with its own fragment shader into
 * a render target sized in real pixels, instead of round-tripping through a
 * 2D canvas on the CPU.
 *
 * Render targets are shared across viewports (three.js keeps one GL copy per
 * renderer), but "is this pass up to date" is tracked per renderer — each
 * viewport has to fill its own copy.
 */

export const OUTPUT_SIZE_INHERIT = "Same as input";
export const OUTPUT_SIZE_CUSTOM = "Custom";

export const OUTPUT_SIZE_PRESETS: Record<string, [number, number] | null> = {
  [OUTPUT_SIZE_INHERIT]: null,
  "1920 × 1080 (Full HD)": [1920, 1080],
  "1280 × 720 (HD)": [1280, 720],
  "3840 × 2160 (4K UHD)": [3840, 2160],
  "1080 × 1920 (Vertical)": [1080, 1920],
  "1080 × 1080 (Square)": [1080, 1080],
  "2048 × 2048": [2048, 2048],
  "1024 × 1024": [1024, 1024],
  "512 × 512": [512, 512],
  [OUTPUT_SIZE_CUSTOM]: null,
};

const MAX_SIZE = 8192;

export function outputSizeFields(params: Record<string, unknown>, allowInherit = true): ParamFieldDef[] {
  const options = Object.keys(OUTPUT_SIZE_PRESETS).filter((k) => allowInherit || k !== OUTPUT_SIZE_INHERIT);
  const fields: ParamFieldDef[] = [{ id: "size", label: "Output Size", kind: "select", options }];
  if (String(params.size ?? "") === OUTPUT_SIZE_CUSTOM) {
    fields.push(
      { id: "width", label: "Width (px)", kind: "number", step: 1 },
      { id: "height", label: "Height (px)", kind: "number", step: 1 },
    );
  }
  return fields;
}

/** Pixel dimensions of whatever backs a texture — image, canvas, video or render target — or null when not known yet. */
export function textureSize(texture: THREE.Texture | null | undefined): [number, number] | null {
  const img = texture?.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
  if (!img) return null;
  const w = img.videoWidth || img.width || 0;
  const h = img.videoHeight || img.height || 0;
  return w > 0 && h > 0 ? [w, h] : null;
}

const clampSize = (v: unknown, fallback: number) => Math.max(1, Math.min(MAX_SIZE, Math.round(Number(v) || fallback)));

/**
 * Output size from a node's `size` param. "Same as input" (also the default
 * when the param is absent, e.g. graphs saved with the old square
 * `resolution` field) follows the first input with known dimensions.
 */
export function resolveOutputSize(
  params: Record<string, unknown>,
  inputs: (THREE.Texture | null)[],
  fallback: [number, number] = [1024, 1024],
): [number, number] {
  const key = String(params.size ?? OUTPUT_SIZE_INHERIT);
  if (key === OUTPUT_SIZE_CUSTOM) return [clampSize(params.width, 1920), clampSize(params.height, 1080)];
  const preset = OUTPUT_SIZE_PRESETS[key];
  if (preset) return preset;
  for (const t of inputs) {
    const s = textureSize(t);
    if (s) return [Math.min(MAX_SIZE, s[0]), Math.min(MAX_SIZE, s[1])];
  }
  return fallback;
}

interface GpuTextureEntry {
  target: THREE.WebGLRenderTarget;
  renderer?: THREE.WebGLRenderer;
  revision: number;
  canvas?: HTMLCanvasElement;
  canvasRevision?: number;
  buffer?: Uint8Array;
}

const gpuTextures = new WeakMap<THREE.Texture, GpuTextureEntry>();

/** Changes whenever a texture's pixels do — render-target textures never bump `version`, so they carry their own counter. */
export function textureRevision(texture: THREE.Texture | null | undefined): string {
  if (!texture) return "";
  const entry = gpuTextures.get(texture);
  return `${texture.uuid}:${entry ? `r${entry.revision}` : texture.version}`;
}

export function registerGpuTexture(target: THREE.WebGLRenderTarget): void {
  if (!gpuTextures.has(target.texture)) gpuTextures.set(target.texture, { target, revision: 0 });
}

export function markGpuTextureRendered(target: THREE.WebGLRenderTarget, renderer: THREE.WebGLRenderer): void {
  registerGpuTexture(target);
  const entry = gpuTextures.get(target.texture)!;
  entry.renderer = renderer;
  entry.revision += 1;
}

function isDrawableSource(image: unknown): image is CanvasImageSource {
  return (
    (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement) ||
    (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement && image.complete) ||
    (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) ||
    (typeof HTMLVideoElement !== "undefined" && image instanceof HTMLVideoElement)
  );
}

/** A render-target texture's pixels, top-down rows, as stored (sRGB bytes for sRGB targets). Null for anything that isn't one. */
function readGpuTexturePixels(texture: THREE.Texture): ImageData | null {
  const entry = gpuTextures.get(texture);
  if (!entry?.renderer || typeof ImageData === "undefined") return null;
  const { width, height } = entry.target;
  if (!entry.buffer || entry.buffer.length !== width * height * 4) entry.buffer = new Uint8Array(width * height * 4);
  entry.renderer.readRenderTargetPixels(entry.target, 0, 0, width, height, entry.buffer);
  const img = new ImageData(width, height);
  const rowBytes = width * 4;
  // GL rows are bottom-up; canvas rows are top-down.
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    img.data.set(entry.buffer.subarray(src, src + rowBytes), y * rowBytes);
  }
  return img;
}

/**
 * Something `drawImage` accepts for this texture. Render-target textures are
 * read back on demand (and cached until they change), so CPU-side consumers
 * like Pixel Spawner or Sample Texture keep working on a GPU chain's output.
 */
export function getDrawableImage(texture: THREE.Texture | null | undefined): CanvasImageSource | null {
  if (!texture) return null;
  if (isDrawableSource(texture.image)) return texture.image;
  const entry = gpuTextures.get(texture);
  if (!entry?.renderer || typeof document === "undefined") return null;
  const { width, height } = entry.target;
  if (entry.canvas && entry.canvasRevision === entry.revision && entry.canvas.width === width && entry.canvas.height === height) {
    return entry.canvas;
  }
  const img = readGpuTexturePixels(texture);
  if (!img) return null;
  if (!entry.canvas) entry.canvas = document.createElement("canvas");
  entry.canvas.width = width;
  entry.canvas.height = height;
  const ctx2d = entry.canvas.getContext("2d");
  if (!ctx2d) return null;
  ctx2d.putImageData(img, 0, 0);
  entry.canvasRevision = entry.revision;
  return entry.canvas;
}

/**
 * Copies a texture into `canvas` at its native size, for export. Render
 * targets hold premultiplied color (MSAA edges and blurs average against the
 * transparent clear), so it is divided back out here — a PNG stores straight
 * alpha, and skipping this leaves a dark fringe around every soft edge.
 */
export function copyTextureToCanvas(texture: THREE.Texture, canvas: HTMLCanvasElement): boolean {
  const size = textureSize(texture);
  const ctx2d = canvas.getContext("2d");
  if (!size || !ctx2d) return false;
  if (canvas.width !== size[0] || canvas.height !== size[1]) {
    canvas.width = size[0];
    canvas.height = size[1];
  }
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  if (isDrawableSource(texture.image)) {
    ctx2d.drawImage(texture.image, 0, 0, canvas.width, canvas.height);
    return true;
  }
  const img = readGpuTexturePixels(texture);
  if (!img) return false;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a > 0 && a < 255) {
      const k = 255 / a;
      d[i] = Math.min(255, d[i] * k);
      d[i + 1] = Math.min(255, d[i + 1] * k);
      d[i + 2] = Math.min(255, d[i + 2] * k);
    }
  }
  ctx2d.putImageData(img, 0, 0);
  return true;
}

const PASS_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Prepended to every pass. Inputs arrive as tA..tD with per-input flags:
 * sX = 1 when the texture is sRGB (sampling returns linear, so it gets
 * re-encoded — pass math runs on display-referred values, like image
 * editors do), hX = 1 when an input is actually wired.
 */
const PASS_HEADER = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tA; uniform sampler2D tB; uniform sampler2D tC; uniform sampler2D tD;
uniform float sA; uniform float sB; uniform float sC; uniform float sD;
uniform float hA; uniform float hB; uniform float hC; uniform float hD;
uniform vec2 texelA;
uniform vec2 outTexel;
uniform float outSRGB;

vec3 lin2srgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 srgb2lin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec4 decodeIn(vec4 c, float srgb) { return srgb > 0.5 ? vec4(lin2srgb(c.rgb), c.a) : c; }
vec4 readA(vec2 uv) { return decodeIn(texture2D(tA, clamp(uv, texelA * 0.5, 1.0 - texelA * 0.5)), sA); }
vec4 readB(vec2 uv) { return decodeIn(texture2D(tB, uv), sB); }
vec4 readC(vec2 uv) { return decodeIn(texture2D(tC, uv), sC); }
vec4 readD(vec2 uv) { return decodeIn(texture2D(tD, uv), sD); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec4 encodeOut(vec4 c) {
  c = clamp(c, 0.0, 1.0);
  return outSRGB > 0.5 ? vec4(srgb2lin(c.rgb), c.a) : c;
}
`;

let whiteTexture: THREE.DataTexture | null = null;
function getWhiteTexture(): THREE.DataTexture {
  if (!whiteTexture) {
    whiteTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteTexture.needsUpdate = true;
  }
  return whiteTexture;
}

/** `body` must define `vec4 process(vec2 uv)` returning display-referred 0..1 values. */
export function createPassMaterial(body: string, extraUniforms: Record<string, THREE.IUniform> = {}): THREE.ShaderMaterial {
  const white = getWhiteTexture();
  return new THREE.ShaderMaterial({
    vertexShader: PASS_VERTEX,
    fragmentShader: `${PASS_HEADER}\n${body}\nvoid main() { gl_FragColor = encodeOut(process(vUv)); }`,
    uniforms: {
      tA: { value: white }, tB: { value: white }, tC: { value: white }, tD: { value: white },
      sA: { value: 0 }, sB: { value: 0 }, sC: { value: 0 }, sD: { value: 0 },
      hA: { value: 0 }, hB: { value: 0 }, hC: { value: 0 }, hD: { value: 0 },
      texelA: { value: new THREE.Vector2(1, 1) },
      outTexel: { value: new THREE.Vector2(1, 1) },
      outSRGB: { value: 1 },
      ...extraUniforms,
    },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

const SLOTS = ["A", "B", "C", "D"] as const;

export function bindPassInputs(material: THREE.ShaderMaterial, inputs: (THREE.Texture | null)[]): void {
  const white = getWhiteTexture();
  SLOTS.forEach((slot, i) => {
    const tex = inputs[i] ?? null;
    material.uniforms[`t${slot}`].value = tex ?? white;
    material.uniforms[`s${slot}`].value = tex && tex.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
    material.uniforms[`h${slot}`].value = tex ? 1 : 0;
  });
  const size = textureSize(inputs[0]) ?? [1, 1];
  (material.uniforms.texelA.value as THREE.Vector2).set(1 / size[0], 1 / size[1]);
}

/**
 * A pass output (or scratch) target at exactly `width`×`height`. Recreated
 * rather than resized on change so downstream signatures (keyed on the
 * texture uuid) notice.
 *
 * `mipmaps` defaults to false: every pass in this pipeline reads its input
 * at the same resolution it renders its output (a fullscreen quad, 1:1 UV
 * sampling) — nothing here ever minifies, so a mip chain is pure waste. It
 * used to default true, which meant `gl.generateMipmap` ran on essentially
 * every pass target, every frame a live source (a `texture/camera`, say)
 * changed — dozens of GPU-side mip regenerations a second for a 1800×1800+
 * chain that were never once sampled, measured as the actual cause of a
 * "3D viewport laggy while nothing changed" report (12fps, no JS long
 * tasks — the frame time was going into these on the GPU). Passed `true`
 * explicitly by anything that actually resamples across resolutions.
 */
export function ensurePassTarget(
  existing: THREE.WebGLRenderTarget | undefined,
  width: number,
  height: number,
  colorSpace: THREE.ColorSpace,
  mipmaps = false,
  type: THREE.TextureDataType = THREE.UnsignedByteType,
): THREE.WebGLRenderTarget {
  if (
    existing &&
    existing.width === width &&
    existing.height === height &&
    existing.texture.colorSpace === colorSpace &&
    existing.texture.type === type
  ) {
    return existing;
  }
  existing?.dispose();
  const target = new THREE.WebGLRenderTarget(width, height, {
    colorSpace,
    type,
    depthBuffer: false,
    generateMipmaps: mipmaps,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.wrapS = THREE.RepeatWrapping;
  target.texture.wrapT = THREE.RepeatWrapping;
  registerGpuTexture(target);
  return target;
}

let passScene: THREE.Scene | null = null;
let passQuad: THREE.Mesh | null = null;
const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export function renderPass(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
  if (!passScene || !passQuad) {
    passQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    passQuad.frustumCulled = false;
    passScene = new THREE.Scene();
    passScene.add(passQuad);
  }
  passQuad.material = material;
  (material.uniforms.outTexel.value as THREE.Vector2).set(1 / target.width, 1 / target.height);
  material.uniforms.outSRGB.value = target.texture.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
  const previous = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  renderer.setRenderTarget(target);
  renderer.render(passScene, passCamera);
  renderer.setRenderTarget(previous);
  renderer.autoClear = previousAutoClear;
  markGpuTextureRendered(target, renderer);
}

/** Per-node pass state: materials/targets shared across viewports, freshness tracked per renderer. */
export interface GpuPassState {
  materials: Record<string, THREE.ShaderMaterial>;
  targets: Record<string, THREE.WebGLRenderTarget>;
  luts: Record<string, THREE.DataTexture>;
  signatures: WeakMap<THREE.WebGLRenderer, string>;
}

export function createGpuPassState(): GpuPassState {
  return { materials: {}, targets: {}, luts: {}, signatures: new WeakMap() };
}

export function disposeGpuPassState(state: GpuPassState): void {
  Object.values(state.materials).forEach((m) => m.dispose());
  Object.values(state.targets).forEach((t) => t.dispose());
  Object.values(state.luts).forEach((t) => t.dispose());
}

/** 256×1 lookup texture, sampled at `(v * 255 + 0.5) / 256` so each byte hits its own texel. */
export function updateLut(state: GpuPassState, key: string, data: Uint8Array): THREE.DataTexture {
  let lut = state.luts[key];
  if (!lut) {
    lut = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1);
    lut.magFilter = THREE.LinearFilter;
    lut.minFilter = THREE.LinearFilter;
    state.luts[key] = lut;
  }
  (lut.image.data as Uint8Array).set(data);
  lut.needsUpdate = true;
  return lut;
}
