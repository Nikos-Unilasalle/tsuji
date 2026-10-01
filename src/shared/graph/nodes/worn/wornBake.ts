import * as THREE from "three";
import { advanceWornAO } from "./wornAO";
import type { WornEntry } from "./wornGeometry";
import { SimpleZipBuilder } from "../../../export/zip";

/*
 * Export: the weathering baked into textures, to take out of Tsuji — each
 * Worn-drawn mesh drawn flat in its own UV layout (the Worn shader with
 * WORN_BAKE defined), one pass per map, unlit:
 *
 *   albedo (sRGB) · roughness · metalness · height · normal (from the height)
 *   · wear mask · dirt mask
 *
 * Texels no triangle covers are filled from their neighbours a few pixels
 * out, so mip-mapping and filtering don't pull the background in along the
 * UV seams.
 */

export const WORN_BAKE_ACTION = "material/worn-bake";
export const WORN_BAKE_SIZES = ["512", "1024", "2048", "4096"] as const;

/** Passes, in uBakeChannel order (see materialWorn.ts WORN_BAKE_CHANNELS). */
const PASSES = ["albedo", "roughness", "metalness", "height", "wear", "dirt"] as const;
/** How far (texels) coverage is grown past the UV islands. */
const DILATE = 8;

/**
 * For every texel no triangle covered, the covered texel nearest it (within
 * `rings` texels; -1 beyond): a breadth-first spread out of the UV islands,
 * computed once per mesh and applied to each of its maps.
 */
export function dilationSources(pixels: Uint8Array, width: number, height: number, rings = DILATE): Int32Array {
  const source = new Int32Array(width * height).fill(-1);
  let frontier: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (pixels[i * 4 + 3] > 127) {
      source[i] = i;
      frontier.push(i);
    }
  }
  for (let ring = 0; ring < rings && frontier.length > 0; ring++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % width, y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (source[j] >= 0) continue;
          source[j] = source[i];
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  return source;
}

/** Fills the uncovered texels of an RGBA image from `sources` (see dilationSources), in place. */
export function applyDilation(pixels: Uint8Array, sources: Int32Array): void {
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s < 0 || s === i) continue;
    pixels[i * 4] = pixels[s * 4];
    pixels[i * 4 + 1] = pixels[s * 4 + 1];
    pixels[i * 4 + 2] = pixels[s * 4 + 2];
    pixels[i * 4 + 3] = 255;
  }
}

/** Both at once, for one image. */
export function dilate(pixels: Uint8Array, width: number, height: number, rings = DILATE): void {
  applyDilation(pixels, dilationSources(pixels, width, height, rings));
}

/**
 * A tangent-space normal map (OpenGL convention, green up) from a height map
 * (its red channel), by central differences; `strength` scales the slopes.
 */
export function normalFromHeight(height: Uint8Array, width: number, h: number, strength = 4): Uint8Array {
  const out = new Uint8Array(width * h * 4);
  const at = (x: number, y: number) => height[(Math.min(h - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      // Rows run top-down here (image order): +y in the image is −v.
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * width + x) * 4;
      out[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

/** GL rows run bottom-up (v = 0 first); images top-down. */
function flipRows(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(pixels.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) out.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return out;
}

async function encodePng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const image = new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height);
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")!.putImageData(image, 0, 0);
    blob = await canvas.convertToBlob({ type: "image/png" });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.putImageData(image, 0, 0);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  }
  if (!blob) throw new Error("PNG encoding failed");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The meshes a Worn material (by its uniforms) draws, among `roots`. Those
 * actually on stage (under a Scene) when there are any: the graph's results
 * also hold every intermediate object a modifier started from.
 */
export function collectWornMeshes(roots: Iterable<unknown>, uniforms: object): THREE.Mesh[] {
  const found = new Set<THREE.Mesh>();
  for (const root of roots) {
    if (!(root instanceof THREE.Object3D)) continue;
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (materials.some((m) => (m as any)?.__wornUniforms === uniforms) && mesh.geometry?.userData?.__wornEntry) found.add(mesh);
    });
  }
  const onStage = [...found].filter((mesh) => {
    let top: THREE.Object3D = mesh;
    while (top.parent) top = top.parent;
    return (top as THREE.Scene).isScene === true;
  });
  return onStage.length > 0 ? onStage : [...found];
}

export interface WornBakeResult {
  zip: Blob;
  baked: string[];
  /** Meshes skipped, and why. */
  skipped: string[];
}

/**
 * Bakes every map for each mesh, with `material` (a Worn material: its
 * uniforms drive the look) at `size` × `size`, into one ZIP of PNGs.
 */
export async function bakeWornTextures(meshes: readonly THREE.Mesh[], material: THREE.Material, size: number): Promise<WornBakeResult> {
  const create = (material as any).clone as () => THREE.MeshStandardMaterial;
  const uniforms = (material as any).__wornUniforms as { uBakeChannel: { value: number }; uDebugView: { value: number } };
  const bakeMaterial = create.call(material);
  bakeMaterial.defines = { ...(bakeMaterial.defines ?? {}), WORN_BAKE: "" };
  bakeMaterial.side = THREE.DoubleSide;
  bakeMaterial.needsUpdate = true;

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: false });
  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
  const camera = new THREE.OrthographicCamera();
  const zip = new SimpleZipBuilder();
  // Encoded side by side: the browser takes its time over each one, not over the lot.
  const files: Promise<[string, Uint8Array]>[] = [];
  const baked: string[] = [];
  const skipped: string[] = [];
  const names = new Map<string, number>();
  const debugView = uniforms.uDebugView.value;
  uniforms.uDebugView.value = 0;

  try {
    for (const [index, mesh] of meshes.entries()) {
      const base = (mesh.name || `mesh_${index + 1}`).replace(/[^\w.-]+/g, "_");
      const seen = names.get(base) ?? 0;
      names.set(base, seen + 1);
      const name = seen ? `${base}_${seen + 1}` : base;
      const geometry = mesh.geometry;
      if (!geometry.getAttribute("uv")) {
        skipped.push(`${name}: no UVs (unwrap it in Edit Mesh first)`);
        continue;
      }
      // The occlusion (grime, dust) finished, not half-way through its frames.
      const entry = geometry.userData.__wornEntry as WornEntry;
      while (!advanceWornAO(entry, Infinity));

      mesh.updateWorldMatrix(true, false);
      const flat = new THREE.Mesh(geometry, bakeMaterial);
      flat.frustumCulled = false;
      flat.matrixAutoUpdate = false;
      flat.matrix.copy(mesh.matrixWorld);
      flat.matrixWorld.copy(mesh.matrixWorld);
      const scene = new THREE.Scene();
      scene.matrixWorldAutoUpdate = false;
      scene.add(flat);

      const maps = new Map<string, Uint8Array>();
      let sources: Int32Array | null = null;
      for (const [channel, pass] of PASSES.entries()) {
        uniforms.uBakeChannel.value = channel;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(scene, camera);
        const pixels = new Uint8Array(size * size * 4);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
        const image = flipRows(pixels, size, size);
        // Every pass covers the same texels: one spread serves them all.
        sources ??= dilationSources(image, size, size);
        applyDilation(image, sources);
        maps.set(pass, image);
      }
      maps.set("normal", normalFromHeight(maps.get("height")!, size, size));
      for (const [pass, pixels] of maps) {
        const file = `${name}_${pass}.png`;
        files.push(encodePng(pixels, size, size).then((png) => [file, png]));
      }
      baked.push(name);
    }
    for (const [file, png] of await Promise.all(files)) zip.addFile(file, png);
  } finally {
    uniforms.uBakeChannel.value = 0;
    uniforms.uDebugView.value = debugView;
    renderer.setRenderTarget(null);
    target.dispose();
    bakeMaterial.dispose();
    renderer.dispose();
    // Browsers keep only a handful of WebGL contexts: give this one back now.
    renderer.forceContextLoss();
  }
  return { zip: zip.buildBlob(), baked, skipped };
}
