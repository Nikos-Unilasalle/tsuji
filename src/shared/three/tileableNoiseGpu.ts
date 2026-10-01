import * as THREE from "three";
import { createPassMaterial } from "../graph/gpuTexture";
import { TILEABLE_PATTERNS, TileableSettings, tileFrequency } from "../math/tileableNoise";
import { TILEABLE_NOISE_GLSL } from "./shaders/tileableNoiseGlsl";

/**
 * GPU generation of tileable noise: one fragment shader, two targets — a 2D
 * texture (a Z slice of the volume, through the regular texture-pass
 * plumbing) or a whole 3D texture filled slice by slice.
 *
 * Both run the same `tnPattern`, so a 2D slice at depth Z is exactly that
 * layer of the volume with the same settings.
 */

export interface TileableGpuSettings extends TileableSettings {
  invert: boolean;
}

const BODY = /* glsl */ `
  uniform vec3 tnFreq;
  uniform vec4 tnConfig;
  uniform float tnSeed;
  uniform float tnZ;
  uniform float tnInvert;
  ${TILEABLE_NOISE_GLSL}
  vec4 process(vec2 uv) {
    bool channels = tnConfig.y > 0.5;
    vec4 c = tnPattern(vec3(uv, tnZ), tnFreq, int(tnConfig.x), channels, int(tnConfig.z), tnConfig.w, uint(tnSeed));
    if (tnInvert > 0.5) c = channels ? 1.0 - c : vec4(1.0 - c.rgb, c.a);
    return c;
  }`;

export function createTileableMaterial(): THREE.ShaderMaterial {
  return createPassMaterial(BODY, {
    tnFreq: { value: new THREE.Vector3(4, 4, 4) },
    tnConfig: { value: new THREE.Vector4() },
    tnSeed: { value: 0 },
    tnZ: { value: 0 },
    tnInvert: { value: 0 },
  });
}

export function setTileableUniforms(material: THREE.ShaderMaterial, s: TileableGpuSettings, z: number): void {
  const u = material.uniforms;
  (u.tnFreq.value as THREE.Vector3).set(tileFrequency(s.frequency[0]), tileFrequency(s.frequency[1]), tileFrequency(s.frequency[2]));
  (u.tnConfig.value as THREE.Vector4).set(
    Math.max(0, TILEABLE_PATTERNS.indexOf(s.pattern)),
    s.channels ? 1 : 0,
    Math.max(1, Math.round(s.octaves)),
    s.gain,
  );
  u.tnSeed.value = Math.max(0, Math.min(65535, Math.round(s.seed)));
  u.tnZ.value = z - Math.floor(z);
  u.tnInvert.value = s.invert ? 1 : 0;
}

/** Every value a generated texture depends on — the regeneration key. */
export function tileableSignature(s: TileableGpuSettings): string {
  return JSON.stringify([s.pattern, s.frequency.map((f) => tileFrequency(f)), s.channels, Math.round(s.octaves), s.gain, Math.round(s.seed), s.invert]);
}

// ---------------------------------------------------------------- 3D

/**
 * Texels filled per frame per volume. A 128³ cloud shape (≈200 hash lookups
 * a texel) spreads over four frames instead of stalling one; a 32³ detail
 * volume still lands in one.
 */
export const VOLUME_TEXELS_PER_FRAME = 1 << 19;

export interface TileableVolumeState {
  material?: THREE.ShaderMaterial;
  target?: THREE.WebGL3DRenderTarget;
  /** Per renderer: each GL context holds its own copy of the target and fills it at its own pace. */
  progress: WeakMap<THREE.WebGLRenderer, { signature: string; next: number }>;
}

export function createTileableVolumeState(): TileableVolumeState {
  return { progress: new WeakMap() };
}

export function disposeTileableVolumeState(state: TileableVolumeState): void {
  state.material?.dispose();
  state.target?.dispose();
}

/**
 * Single channel when packed (R8: a quarter of the memory, and all a density
 * lookup reads), RGBA otherwise. Recreated rather than resized so the texture
 * identity changes with its layout.
 */
function ensureVolumeTarget(state: TileableVolumeState, size: number, channels: boolean): THREE.WebGL3DRenderTarget {
  const format = channels ? THREE.RGBAFormat : THREE.RedFormat;
  const existing = state.target;
  if (existing && existing.width === size && existing.texture.format === format) return existing;
  existing?.dispose();
  const target = new THREE.WebGL3DRenderTarget(size, size, size, { depthBuffer: false });
  const texture = target.texture;
  texture.format = format;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  state.target = target;
  state.progress = new WeakMap();
  return target;
}

let sliceScene: THREE.Scene | null = null;
let sliceQuad: THREE.Mesh | null = null;
const sliceCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function renderSlices(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, target: THREE.WebGL3DRenderTarget, s: TileableGpuSettings, from: number, to: number): void {
  if (!sliceScene || !sliceQuad) {
    sliceQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    sliceQuad.frustumCulled = false;
    sliceScene = new THREE.Scene();
    sliceScene.add(sliceQuad);
  }
  sliceQuad.material = material;
  material.uniforms.outSRGB.value = 0;
  (material.uniforms.outTexel.value as THREE.Vector2).set(1 / target.width, 1 / target.height);
  const previous = renderer.getRenderTarget();
  const previousLayer = renderer.getActiveCubeFace();
  const previousMip = renderer.getActiveMipmapLevel();
  const previousAutoClear = renderer.autoClear;
  // The quad covers every texel of the layer, so clearing it first is wasted bandwidth.
  renderer.autoClear = false;
  for (let z = from; z < to; z++) {
    setTileableUniforms(material, s, (z + 0.5) / target.depth);
    renderer.setRenderTarget(target, z);
    renderer.render(sliceScene, sliceCamera);
  }
  renderer.setRenderTarget(previous, previousLayer, previousMip);
  renderer.autoClear = previousAutoClear;
}

/**
 * The volume for these settings, generating whatever slices are still
 * missing within this frame's budget. Returns the texture straight away —
 * while it fills, the missing layers read as whatever was there before.
 */
export function updateTileableVolume(
  renderer: THREE.WebGLRenderer,
  state: TileableVolumeState,
  s: TileableGpuSettings,
  size: number,
): { texture: THREE.Data3DTexture; complete: boolean } {
  const target = ensureVolumeTarget(state, size, s.channels);
  const material = (state.material ??= createTileableMaterial());
  const signature = tileableSignature(s);
  let progress = state.progress.get(renderer);
  if (!progress || progress.signature !== signature) {
    progress = { signature, next: 0 };
    state.progress.set(renderer, progress);
  }
  if (progress.next < size) {
    const slices = Math.max(1, Math.floor(VOLUME_TEXELS_PER_FRAME / (size * size)));
    const to = Math.min(size, progress.next + slices);
    renderSlices(renderer, material, target, s, progress.next, to);
    progress.next = to;
  }
  return { texture: target.texture, complete: progress.next >= size };
}
