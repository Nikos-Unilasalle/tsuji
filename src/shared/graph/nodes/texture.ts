import * as THREE from "three";
import { NodeDefinition } from "../types";
import { toBoolean } from "../sockets";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrix, getSourcePivot } from "./transform";
import { COMMON_PRIMITIVE_OUTPUTS, primitiveOutputs } from "./object";
import { InstancedItemSpec, renderInstanced } from "./instancedRender";

/**
 * Points a CanvasTexture at `canvas`, forcing a fresh texture object rather
 * than reusing the old one.
 *
 * Reusing a CanvasTexture across a canvas *resize* and only flipping
 * `needsUpdate` looks fine on the CPU side — the canvas itself always has
 * the right pixels — but Chrome's fast path for canvas-source textures
 * (`glCopySubTextureCHROMIUM`) assumes the destination GPU texture's storage
 * still matches the size it was *first* allocated at. A resized canvas
 * overflows that copy; the browser logs "Offset overflows texture
 * dimensions" and drops or truncates the upload, leaving stale or
 * partially-drawn pixels on screen even though the source canvas is correct
 * — and every redraw after that keeps hitting the same broken copy, so nothing
 * ever recovers. A new texture object makes three.js allocate GPU storage
 * sized for the canvas as it is now, every time.
 */
export function replaceCanvasTexture(
  existing: THREE.CanvasTexture | undefined,
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
): THREE.CanvasTexture {
  existing?.dispose();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colorSpace;
  return texture;
}

interface TextureNodeState {
  texture?: THREE.Texture;
  mesh?: THREE.Mesh;
  aspectRatio: number;
  lastPath?: string;
  /** Last wrap/repeat/offset signature — avoid re-uploading the texture every frame. */
  lastSig?: string;
}

const textureCache = createNodeCache<TextureNodeState>((s) => s.texture?.dispose());

const textureTransformCache = createNodeCache<{ texture?: THREE.Texture; lastSig?: string }>((s) => s.texture?.dispose());

function getState(nodeId: string): TextureNodeState {
  let state = textureCache.get(nodeId);
  if (!state) {
    state = { aspectRatio: 1.0 };
    textureCache.set(nodeId, state);
  }
  return state;
}

function createTextureBlob(content: unknown, path: string): Blob {
  const ext = path.split(".").pop()?.toLowerCase() ?? "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  const mime = mimeMap[ext] || "image/png";
  return content instanceof Uint8Array ? new Blob([content], { type: mime }) : new Blob([content as any], { type: mime });
}

function asColor(v: unknown, fallback: THREE.Color): THREE.Color {
  if (v instanceof THREE.Color) return v;
  if (typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v) {
    const { r, g, b } = v as { r: number; g: number; b: number };
    return new THREE.Color(r, g, b);
  }
  if (typeof v === "string" || typeof v === "number") {
    try {
      return new THREE.Color(v as any);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** Image Texture node — loads image files (.png, .jpg, .webp) into a THREE.Texture socket output. */
export const TEXTURE_IMAGE_NODE: NodeDefinition = {
  type: "texture/image",
  label: "Image Texture",
  category: "texture",
  inputs: [
    { id: "uvScale", label: "UV Scale", type: "vector" },
    { id: "uvOffset", label: "UV Offset", type: "vector" },
  ],
  outputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "aspectRatio", label: "Aspect Ratio", type: "value" },
  ],
  defaultParams: {
    filePath: "",
    wrapS: "repeat",
    wrapT: "repeat",
  },
  dynamicParamFields: () => [
    {
      id: "filePath",
      label: "Image File",
      kind: "file",
      accept: [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"],
      onLoaded: (nodeId, path, content) => {
        const state = getState(nodeId);
        state.lastPath = path;
        try {
          const blob = createTextureBlob(content, path);
          const url = URL.createObjectURL(blob);
          const texture = new THREE.TextureLoader().load(
            url,
            (loaded) => {
              URL.revokeObjectURL(url);
              if (loaded.image?.width && loaded.image?.height) {
                state.aspectRatio = loaded.image.width / loaded.image.height;
              }
              loaded.needsUpdate = true;
            },
            undefined,
            () => URL.revokeObjectURL(url)
          );
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          // Re-picking a file used to strand the previous texture's GPU upload:
          // the cache disposer only ever sees the last one.
          state.texture?.dispose();
          state.texture = texture;
        } catch (err) {
          console.error("Failed to load image texture:", err);
        }
      },
    },
    { id: "wrapS", label: "Wrap S", kind: "select", options: ["repeat", "clamp", "mirror"] },
    { id: "wrapT", label: "Wrap T", kind: "select", options: ["repeat", "clamp", "mirror"] },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    const texture = state.texture;

    if (texture) {
      const wrapMap: Record<string, THREE.Wrapping> = {
        repeat: THREE.RepeatWrapping,
        clamp: THREE.ClampToEdgeWrapping,
        mirror: THREE.MirroredRepeatWrapping,
      };
      texture.wrapS = wrapMap[String(params.wrapS || "repeat")] ?? THREE.RepeatWrapping;
      texture.wrapT = wrapMap[String(params.wrapT || "repeat")] ?? THREE.RepeatWrapping;

      const sig = [
        texture.wrapS,
        texture.wrapT,
        inputs.uvScale instanceof THREE.Vector3 ? inputs.uvScale.toArray().join(",") : "",
        inputs.uvOffset instanceof THREE.Vector3 ? inputs.uvOffset.toArray().join(",") : "",
      ].join("|");
      if (sig !== state.lastSig) {
        state.lastSig = sig;
        if (inputs.uvScale instanceof THREE.Vector3) {
          texture.repeat.set(inputs.uvScale.x, inputs.uvScale.y);
        }
        if (inputs.uvOffset instanceof THREE.Vector3) {
          texture.offset.set(inputs.uvOffset.x, inputs.uvOffset.y);
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
      }
    }

    return {
      texture: texture ?? new THREE.Texture(),
      aspectRatio: state.aspectRatio,
    };
  },
};

/**
 * Texture to Plane node — turns an image texture (or direct file pick) into a 3D Plane object
 * pre-mapped with proper aspect ratio, shadows, double-sided rendering, and PBR controls.
 */
export const TEXTURE_PLANE_NODE: NodeDefinition = {
  type: "texture/plane",
  label: "Texture to Plane",
  category: "texture",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "texture", label: "Texture", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "uvScale", label: "UV Scale", type: "vector" },
    { id: "uvOffset", label: "UV Offset", type: "vector" },
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(-Math.PI / 2, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    filePath: "",
    color: new THREE.Color(0xffffff),
    transparent: true,
    alphaCutoff: 0.001,
    doubleSided: true,
    keepAspect: true,
    roughness: 0.5,
    metalness: 0.1,
  },
  dynamicParamFields: () => [
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
    {
      id: "filePath",
      label: "Image File (Fallback)",
      kind: "file",
      accept: [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"],
      onLoaded: (nodeId, path, content) => {
        const state = getState(nodeId);
        state.lastPath = path;
        try {
          const blob = createTextureBlob(content, path);
          const url = URL.createObjectURL(blob);
          const texture = new THREE.TextureLoader().load(
            url,
            (loaded) => {
              URL.revokeObjectURL(url);
              if (loaded.image?.width && loaded.image?.height) {
                state.aspectRatio = loaded.image.width / loaded.image.height;
              }
              loaded.needsUpdate = true;
              if (state.mesh?.material) {
                (state.mesh.material as THREE.Material).needsUpdate = true;
              }
            },
            undefined,
            () => URL.revokeObjectURL(url)
          );
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          // Re-picking a file used to strand the previous texture's GPU upload:
          // the cache disposer only ever sees the last one.
          state.texture?.dispose();
          state.texture = texture;
        } catch (err) {
          console.error("Failed to load texture for plane:", err);
        }
      },
    },
    { id: "color", label: "Color Tint", kind: "color" },
    { id: "transparent", label: "Transparent (Alpha)", kind: "boolean" },
    { id: "alphaCutoff", label: "Alpha Cutoff", kind: "number", step: 0.01 },
    { id: "doubleSided", label: "Double Sided", kind: "boolean" },
    { id: "keepAspect", label: "Keep Aspect Ratio", kind: "boolean" },
    { id: "roughness", label: "Roughness", kind: "number", step: 0.05 },
    { id: "metalness", label: "Metalness", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);

    // Create or retrieve 3D Plane Mesh
    if (!state.mesh) {
      const geom = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.001,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state.mesh = mesh;
    }

    const mesh = state.mesh;
    mesh.renderOrder = 0;
    const isVisible = inputs.visible !== undefined ? toBoolean(inputs.visible) : toBoolean(params.visible ?? 1);
    mesh.visible = isVisible;

    // Determine active texture (from input socket or param file fallback)
    const inputTexture = inputs.texture instanceof THREE.Texture ? inputs.texture : null;
    const activeTexture = inputTexture || state.texture;

    // Calculate aspect ratio scaling
    const keepAspect = Boolean(params.keepAspect ?? true);
    let aspect = 1.0;
    if (activeTexture && activeTexture.image?.width && activeTexture.image?.height) {
      aspect = activeTexture.image.width / activeTexture.image.height;
    } else if (state.aspectRatio) {
      aspect = state.aspectRatio;
    }

    // Apply Matrix transformation
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      const wiredMatrix = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix.clone() : new THREE.Matrix4();
      if (keepAspect && aspect !== 1.0) {
        wiredMatrix.multiply(new THREE.Matrix4().makeScale(aspect, 1.0, 1.0));
      }
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(wiredMatrix, params.location, params.rotation, params.scale, params));
    }

    // Update material properties
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0xffffff)));

    let scaleX = 1;
    let scaleY = 1;
    if (inputs.uvScale instanceof THREE.Vector3) {
      scaleX = inputs.uvScale.x;
      scaleY = inputs.uvScale.y;
    }
    let offsetX = 0;
    let offsetY = 0;
    if (inputs.uvOffset instanceof THREE.Vector3) {
      offsetX = inputs.uvOffset.x;
      offsetY = inputs.uvOffset.y;
    }

    // Only touch the material (and re-upload its map) when something changed —
    // doing it every frame recompiles the shader and re-uploads the texture.
    const planeSig = [
      color.getHex(),
      Boolean(params.doubleSided ?? true),
      Number(params.roughness) ?? 0.5,
      Number(params.metalness) ?? 0.1,
      Boolean(params.transparent ?? true),
      Number(params.alphaCutoff) ?? 0.001,
      activeTexture?.uuid ?? "",
      scaleX,
      scaleY,
      offsetX,
      offsetY,
    ].join("|");
    if (state.lastSig !== planeSig) {
      state.lastSig = planeSig;
      mat.color.copy(color);
      mat.side = Boolean(params.doubleSided ?? true) ? THREE.DoubleSide : THREE.FrontSide;
      mat.roughness = Math.max(0, Math.min(1, Number(params.roughness) ?? 0.5));
      mat.metalness = Math.max(0, Math.min(1, Number(params.metalness) ?? 0.1));

      const isTransparent = Boolean(params.transparent ?? true);
      mat.transparent = isTransparent;
      mat.alphaTest = isTransparent ? Math.max(0, Number(params.alphaCutoff ?? 0.001)) : 0;
      mat.depthWrite = !isTransparent || mat.alphaTest > 0;

      if (activeTexture) {
        mat.map = activeTexture;
        mat.map.colorSpace = THREE.SRGBColorSpace;
        mat.map.repeat.set(scaleX, scaleY);
        mat.map.offset.set(offsetX, offsetY);
        mat.map.needsUpdate = true;
      } else {
        mat.map = null;
      }
      mat.needsUpdate = true;
    }

    return primitiveOutputs(mesh);
  },
};

/** Texture Transform node — modifies UV repeat, offset, and rotation of a THREE.Texture. */
export const TEXTURE_TRANSFORM_NODE: NodeDefinition = {
  type: "texture/transform",
  label: "Texture Transform",
  category: "texture",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "scale", label: "Scale", type: "vector" },
    { id: "offset", label: "Offset", type: "vector" },
    { id: "rotation", label: "Rotation (°)", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: {
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
  },
  paramFields: [
    { id: "scaleX", label: "Scale X", kind: "number", step: 0.1 },
    { id: "scaleY", label: "Scale Y", kind: "number", step: 0.1 },
    { id: "offsetX", label: "Offset X", kind: "number", step: 0.05 },
    { id: "offsetY", label: "Offset Y", kind: "number", step: 0.05 },
    { id: "rotation", label: "Rotation (°)", kind: "number", step: 5 },
  ],
  evaluate: (inputs, params, ctx) => {
    const source = inputs.texture instanceof THREE.Texture ? inputs.texture : new THREE.Texture();

    let scaleX = Number(params.scaleX) || 1;
    let scaleY = Number(params.scaleY) || 1;
    if (inputs.scale instanceof THREE.Vector3) {
      scaleX = inputs.scale.x;
      scaleY = inputs.scale.y;
    }

    let offsetX = Number(params.offsetX) || 0;
    let offsetY = Number(params.offsetY) || 0;
    if (inputs.offset instanceof THREE.Vector3) {
      offsetX = inputs.offset.x;
      offsetY = inputs.offset.y;
    }

    const rotDeg = inputs.rotation !== undefined ? Number(inputs.rotation) : Number(params.rotation) || 0;

    // Cache the transformed clone per node: re-cloning + re-uploading the source
    // image every frame (needsUpdate) is wasted GPU traffic for an unchanged input.
    const sig = [
      source.uuid,
      source.image?.width ?? 0,
      source.image?.height ?? 0,
      scaleX,
      scaleY,
      offsetX,
      offsetY,
      rotDeg,
    ].join("|");

    let state = textureTransformCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      textureTransformCache.set(ctx.nodeId, state);
    }
    if (state.lastSig !== sig) {
      state.lastSig = sig;
      if (state.texture) state.texture.dispose();
      const texture = source.clone();
      texture.repeat.set(scaleX, scaleY);
      texture.offset.set(offsetX, offsetY);
      texture.rotation = (rotDeg * Math.PI) / 180;
      texture.center.set(0.5, 0.5);
      texture.needsUpdate = true;
      state.texture = texture;
    }

    return { texture: state.texture! };
  },
};

interface ProcTextureState {
  texture?: THREE.CanvasTexture;
  canvas?: HTMLCanvasElement;
  signature?: string;
}

const procTextureCache = createNodeCache<ProcTextureState>((s) => s.texture?.dispose());

function getProcState(nodeId: string): ProcTextureState {
  let state = procTextureCache.get(nodeId);
  if (!state) {
    state = {};
    procTextureCache.set(nodeId, state);
  }
  return state;
}

/** Deterministic PRNG so a pattern stays stable for a given seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded 2D lattice hash → 0..1, used for value noise / voronoi sites. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

function colorAt(a: THREE.Color, b: THREE.Color, t: number): [number, number, number] {
  return [
    Math.round(lerpN(a.r, b.r, t) * 255),
    Math.round(lerpN(a.g, b.g, t) * 255),
    Math.round(lerpN(a.b, b.b, t) * 255),
  ];
}

/** Fills the canvas from a per-pixel RGB function via an ImageData buffer (fast for noise/voronoi). */
function drawPerPixel(canvas: HTMLCanvasElement, fn: (x: number, y: number) => [number, number, number]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = canvas.width;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * size + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawProcedural(
  canvas: HTMLCanvasElement,
  type: string,
  colorA: THREE.Color,
  colorB: THREE.Color,
  scale: number,
  seed: number,
  octaves: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = canvas.width;
  const cells = Math.max(1, Math.round(scale));
  const cell = size / cells;
  const hex = (c: THREE.Color) => `#${c.getHexString()}`;

  if (type === "perlin" || type === "voronoi" || type === "wave" || type === "noise") {
    if (type === "perlin") {
      const o = Math.max(1, Math.round(octaves));
      drawPerPixel(canvas, (x, y) => colorAt(colorA, colorB, fbm(x / cell, y / cell, seed, o)));
    } else if (type === "voronoi") {
      const rand = mulberry32(seed);
      const sites: { x: number; y: number }[] = [];
      for (let i = 0; i < cells * cells; i++) sites.push({ x: rand() * size, y: rand() * size });
      drawPerPixel(canvas, (x, y) => {
        let minD = Infinity;
        for (const s of sites) {
          const dx = x - s.x;
          const dy = y - s.y;
          const dd = dx * dx + dy * dy;
          if (dd < minD) minD = dd;
        }
        return colorAt(colorB, colorA, Math.min(1, Math.sqrt(minD) / cell));
      });
    } else if (type === "wave") {
      drawPerPixel(canvas, (x, y) => {
        const n = 0.5 + 0.5 * Math.sin((x / cell) * Math.PI * 2) * Math.sin((y / cell) * Math.PI * 2);
        return colorAt(colorA, colorB, n);
      });
    } else {
      // noise — deterministic sprinkled dots
      const rand = mulberry32(seed);
      drawPerPixel(canvas, () => colorAt(colorA, colorB, rand()));
    }
    return;
  }

  ctx.fillStyle = hex(colorA);
  ctx.fillRect(0, 0, size, size);

  if (type === "checker") {
    ctx.fillStyle = hex(colorB);
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        if ((i + j) % 2 === 1) ctx.fillRect(i * cell, j * cell, cell + 1, cell + 1);
      }
    }
  } else if (type === "stripes") {
    ctx.fillStyle = hex(colorB);
    for (let i = 1; i < cells; i += 2) ctx.fillRect(i * cell, 0, cell + 1, size);
  } else if (type === "grid") {
    ctx.strokeStyle = hex(colorB);
    ctx.lineWidth = Math.max(1, cell * 0.12);
    for (let i = 0; i <= cells; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * cell);
      ctx.lineTo(size, i * cell);
      ctx.stroke();
    }
  } else if (type === "gradient") {
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, hex(colorA));
    g.addColorStop(1, hex(colorB));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  } else if (type === "rings") {
    const c = size / 2;
    ctx.strokeStyle = hex(colorB);
    ctx.lineWidth = Math.max(1, cell * 0.25);
    for (let r = 1; r <= cells; r++) {
      ctx.beginPath();
      ctx.arc(c, c, (r / cells) * c, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** Procedural Texture node — generates a checker/gradient/stripe/… texture on a canvas. */
export const TEXTURE_PROCEDURAL_NODE: NodeDefinition = {
  type: "texture/procedural",
  label: "Procedural Texture",
  category: "texture",
  inputs: [
    { id: "scale", label: "Scale", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "uvScale", label: "UV Scale", type: "vector" },
    { id: "uvOffset", label: "UV Offset", type: "vector" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: {
    type: "checker",
    colorA: new THREE.Color(0xffffff),
    colorB: new THREE.Color(0x222222),
    scale: 8,
    seed: 1,
    octaves: 3,
    resolution: 256,
    uvScaleX: 1,
    uvScaleY: 1,
    uvOffsetX: 0,
    uvOffsetY: 0,
  },
  dynamicParamFields: (instance) => {
    const type = String(instance.params.type || "checker");
    return [
      { id: "type", label: "Pattern", kind: "select", options: ["checker", "gradient", "stripes", "grid", "rings", "wave", "perlin", "voronoi", "noise"] },
      { id: "colorA", label: "Color A", kind: "color" },
      { id: "colorB", label: "Color B", kind: "color" },
      { id: "scale", label: "Scale / Density", kind: "number", step: 1 },
      ...(type === "perlin" ? [{ id: "octaves", label: "Octaves", kind: "number", step: 1 } as const] : []),
      { id: "seed", label: "Seed", kind: "number", step: 1 },
      { id: "resolution", label: "Resolution (px)", kind: "number", step: 64 },
    ];
  },
  evaluate: (inputs, params, ctx) => {
    const state = getProcState(ctx.nodeId);
    if (typeof document === "undefined") return { texture: null };

    const type = String(params.type || "checker");
    const resolution = Math.max(16, Math.min(1024, Math.round(Number(params.resolution) || 256)));
    const rawScale = inputs.scale !== undefined ? inputs.scale : params.scale;
    const scale = Math.max(0.0001, Number(rawScale) || 8);
    const rawSeed = inputs.seed !== undefined ? inputs.seed : params.seed;
    const seed = Math.floor(Number(rawSeed) || 1);
    const octaves = Math.max(1, Math.round(Number(params.octaves) || 3));
    const colorA = asColor(params.colorA, new THREE.Color(0xffffff));
    const colorB = asColor(params.colorB, new THREE.Color(0x222222));

    if (!state.canvas) state.canvas = document.createElement("canvas");
    const sig = JSON.stringify([type, resolution, scale, seed, octaves, colorA.getHexString(), colorB.getHexString()]);
    if (sig !== state.signature) {
      state.signature = sig;
      state.canvas.width = resolution;
      state.canvas.height = resolution;
      drawProcedural(state.canvas, type, colorA, colorB, scale, seed, octaves);
      state.texture = replaceCanvasTexture(state.texture, state.canvas, THREE.SRGBColorSpace);
    }

    // UV tiling / offset, like the image texture node.
    if (inputs.uvScale instanceof THREE.Vector3) state.texture!.repeat.set(inputs.uvScale.x, inputs.uvScale.y);
    else state.texture!.repeat.set(Number(params.uvScaleX) || 1, Number(params.uvScaleY) || 1);
    if (inputs.uvOffset instanceof THREE.Vector3) state.texture!.offset.set(inputs.uvOffset.x, inputs.uvOffset.y);
    else state.texture!.offset.set(Number(params.uvOffsetX) || 0, Number(params.uvOffsetY) || 0);

    return { texture: state.texture };
  },
};

interface MixTextureState {
  texture?: THREE.CanvasTexture;
  canvas?: HTMLCanvasElement;
  aCanvas?: HTMLCanvasElement;
  bCanvas?: HTMLCanvasElement;
  signature?: string;
}

const mixTextureCache = createNodeCache<MixTextureState>((s) => s.texture?.dispose());

function getMixState(nodeId: string): MixTextureState {
  let state = mixTextureCache.get(nodeId);
  if (!state) {
    state = {};
    mixTextureCache.set(nodeId, state);
  }
  return state;
}

/** Per-channel blend, 0..1 in, 0..1 out — same formulas as Blender's Mix Color node. */
function blendChannel(mode: string, a: number, b: number): number {
  switch (mode) {
    case "add":
      return a + b;
    case "multiply":
      return a * b;
    case "screen":
      return 1 - (1 - a) * (1 - b);
    case "overlay":
      return a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b);
    case "subtract":
      return a - b;
    case "difference":
      return Math.abs(a - b);
    case "darken":
      return Math.min(a, b);
    case "lighten":
      return Math.max(a, b);
    default: // mix
      return b;
  }
}

/** Draws `source` (any drawable texture image, or flat white if absent) into `canvas` at `resolution`. */
export function drawSourceToCanvas(canvas: HTMLCanvasElement, source: THREE.Texture | null, resolution: number): void {
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (source && isDrawable(source.image)) {
    ctx.drawImage(source.image as CanvasImageSource, 0, 0, resolution, resolution);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, resolution, resolution);
  }
}

interface ToNormalState {
  texture?: THREE.CanvasTexture;
  canvas?: HTMLCanvasElement;
  heightCanvas?: HTMLCanvasElement;
  signature?: string;
}

const toNormalCache = createNodeCache<ToNormalState>((s) => s.texture?.dispose());

function getToNormalState(nodeId: string): ToNormalState {
  let state = toNormalCache.get(nodeId);
  if (!state) {
    state = {};
    toNormalCache.set(nodeId, state);
  }
  return state;
}

function isDrawable(v: unknown): boolean {
  return (
    (typeof HTMLCanvasElement !== "undefined" && v instanceof HTMLCanvasElement) ||
    (typeof HTMLImageElement !== "undefined" && v instanceof HTMLImageElement) ||
    (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap) ||
    (typeof HTMLVideoElement !== "undefined" && v instanceof HTMLVideoElement)
  );
}

/** Texture to Normal node — derives a tangent-space normal map from a texture's luminance. */
export const TEXTURE_TO_NORMAL_NODE: NodeDefinition = {
  type: "texture/to_normal",
  label: "Texture to Normal",
  category: "texture",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "normal", label: "Normal Map", type: "texture" }],
  defaultParams: { strength: 1, resolution: 256 },
  dynamicParamFields: () => [
    { id: "strength", label: "Strength", kind: "number", step: 0.1 },
    { id: "resolution", label: "Resolution (px)", kind: "number", step: 64 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getToNormalState(ctx.nodeId);
    if (typeof document === "undefined") return { normal: null };
    const source = inputs.texture instanceof THREE.Texture ? inputs.texture : null;
    if (!source || !isDrawable(source.image)) return { normal: null };

    const strength = Math.max(0, Number(params.strength) || 1);
    const resolution = Math.max(16, Math.min(1024, Math.round(Number(params.resolution) || 256)));
    const sig = JSON.stringify([strength, resolution, source.uuid, source.version]);
    if (sig !== state.signature) {
      state.signature = sig;
      if (!state.heightCanvas) state.heightCanvas = document.createElement("canvas");
      if (!state.canvas) state.canvas = document.createElement("canvas");

      const hc = state.heightCanvas;
      hc.width = resolution;
      hc.height = resolution;
      const hctx = hc.getContext("2d");
      if (!hctx) return { normal: null };
      hctx.drawImage(source.image as CanvasImageSource, 0, 0, resolution, resolution);
      const hData = hctx.getImageData(0, 0, resolution, resolution).data;

      // Grayscale height map.
      const height = new Float32Array(resolution * resolution);
      for (let i = 0; i < height.length; i++) {
        height[i] = (0.299 * hData[i * 4] + 0.587 * hData[i * 4 + 1] + 0.114 * hData[i * 4 + 2]) / 255;
      }

      const nc = state.canvas;
      nc.width = resolution;
      nc.height = resolution;
      const nctx = nc.getContext("2d");
      if (!nctx) return { normal: null };
      const nImg = nctx.createImageData(resolution, resolution);
      const nd = nImg.data;
      const at = (x: number, y: number) =>
        (((y + resolution) % resolution) * resolution) + ((x + resolution) % resolution);
      const n = new THREE.Vector3();
      for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
          const dx = (height[at(x + 1, y)] - height[at(x - 1, y)]) * 0.5;
          const dy = (height[at(x, y + 1)] - height[at(x, y - 1)]) * 0.5;
          n.set(-dx * strength, -dy * strength, 1).normalize();
          const i = (y * resolution + x) * 4;
          nd[i] = (n.x * 0.5 + 0.5) * 255;
          nd[i + 1] = (n.y * 0.5 + 0.5) * 255;
          nd[i + 2] = (n.z * 0.5 + 0.5) * 255;
          nd[i + 3] = 255;
        }
      }
      nctx.putImageData(nImg, 0, 0);

      // normal maps stay linear, not sRGB
      state.texture = replaceCanvasTexture(state.texture, nc, THREE.LinearSRGBColorSpace);
    }

    return { normal: state.texture };
  },
};

interface ToRoughnessState {
  texture?: THREE.CanvasTexture;
  canvas?: HTMLCanvasElement;
  signature?: string;
}

const toRoughnessCache = createNodeCache<ToRoughnessState>((s) => s.texture?.dispose());

function getToRoughnessState(nodeId: string): ToRoughnessState {
  let state = toRoughnessCache.get(nodeId);
  if (!state) {
    state = {};
    toRoughnessCache.set(nodeId, state);
  }
  return state;
}

/**
 * Texture to Roughness node — approximates a roughness map from a texture's
 * luminance: darker areas read as rougher (or the reverse, when inverted).
 * Contrast pushes mid-tones away from 0.5 so flat-looking source textures
 * still produce a usable range of roughness values.
 */
export const TEXTURE_TO_ROUGHNESS_NODE: NodeDefinition = {
  type: "texture/to_roughness",
  label: "Texture to Roughness",
  category: "texture",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "roughness", label: "Roughness Map", type: "texture" }],
  defaultParams: { invert: false, contrast: 1, minRoughness: 0, maxRoughness: 1, resolution: 256 },
  dynamicParamFields: () => [
    { id: "invert", label: "Invert", kind: "boolean" },
    { id: "contrast", label: "Contrast", kind: "number", step: 0.1 },
    { id: "minRoughness", label: "Min Roughness", kind: "number", step: 0.05 },
    { id: "maxRoughness", label: "Max Roughness", kind: "number", step: 0.05 },
    { id: "resolution", label: "Resolution (px)", kind: "number", step: 64 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getToRoughnessState(ctx.nodeId);
    if (typeof document === "undefined") return { roughness: null };
    const source = inputs.texture instanceof THREE.Texture ? inputs.texture : null;
    if (!source || !isDrawable(source.image)) return { roughness: null };

    const invert = Boolean(params.invert);
    const contrast = Math.max(0, Number(params.contrast) || 1);
    const minRoughness = Math.max(0, Math.min(1, Number(params.minRoughness) ?? 0));
    const maxRoughness = Math.max(0, Math.min(1, Number(params.maxRoughness) ?? 1));
    const resolution = Math.max(16, Math.min(1024, Math.round(Number(params.resolution) || 256)));

    const sig = JSON.stringify([invert, contrast, minRoughness, maxRoughness, resolution, source.uuid, source.version]);
    if (sig !== state.signature) {
      state.signature = sig;
      if (!state.canvas) state.canvas = document.createElement("canvas");
      const canvas = state.canvas;
      canvas.width = resolution;
      canvas.height = resolution;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return { roughness: null };
      ctx2d.drawImage(source.image as CanvasImageSource, 0, 0, resolution, resolution);
      const img = ctx2d.getImageData(0, 0, resolution, resolution);
      const data = img.data;
      const lo = Math.min(minRoughness, maxRoughness);
      const hi = Math.max(minRoughness, maxRoughness);
      for (let i = 0; i < data.length; i += 4) {
        let l = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        if (invert) l = 1 - l;
        l = Math.max(0, Math.min(1, (l - 0.5) * contrast + 0.5));
        const v = Math.round((lo + l * (hi - lo)) * 255);
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
      ctx2d.putImageData(img, 0, 0);

      // roughness maps stay linear, not sRGB
      state.texture = replaceCanvasTexture(state.texture, canvas, THREE.LinearSRGBColorSpace);
    }

    return { roughness: state.texture };
  },
};

/**
 * Mix Texture node — blends two textures per-pixel by a factor (scalar or a
 * third texture's luminance as a mask), same blend modes as Blender's Mix
 * Color node. A missing A or B input reads as flat white, so wiring only one
 * side still previews something instead of a blank/black result.
 */
export const TEXTURE_MIX_NODE: NodeDefinition = {
  type: "texture/mix",
  label: "Mix Texture",
  category: "texture",
  inputs: [
    { id: "textureA", label: "Texture A", type: "texture" },
    { id: "textureB", label: "Texture B", type: "texture" },
    { id: "factor", label: "Factor", type: "value" },
    { id: "factorTexture", label: "Factor (Texture)", type: "texture" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: {
    blendMode: "mix",
    factor: 0.5,
    resolution: 256,
  },
  dynamicParamFields: () => [
    {
      id: "blendMode",
      label: "Blend Mode",
      kind: "select",
      options: ["mix", "add", "multiply", "screen", "overlay", "subtract", "difference", "darken", "lighten"],
    },
    { id: "factor", label: "Factor (fallback)", kind: "number", step: 0.05 },
    { id: "resolution", label: "Resolution (px)", kind: "number", step: 64 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getMixState(ctx.nodeId);
    if (typeof document === "undefined") return { texture: null };

    const sourceA = inputs.textureA instanceof THREE.Texture ? inputs.textureA : null;
    const sourceB = inputs.textureB instanceof THREE.Texture ? inputs.textureB : null;
    const factorTexture = inputs.factorTexture instanceof THREE.Texture ? inputs.factorTexture : null;
    const blendMode = String(params.blendMode || "mix");
    const factor = Math.max(0, Math.min(1, inputs.factor !== undefined ? Number(inputs.factor) : Number(params.factor) ?? 0.5));
    const resolution = Math.max(16, Math.min(1024, Math.round(Number(params.resolution) || 256)));

    const sig = [
      blendMode,
      factor,
      resolution,
      sourceA?.uuid ?? "",
      sourceA?.version ?? 0,
      sourceB?.uuid ?? "",
      sourceB?.version ?? 0,
      factorTexture?.uuid ?? "",
      factorTexture?.version ?? 0,
    ].join("|");

    if (sig !== state.signature) {
      state.signature = sig;
      if (!state.aCanvas) state.aCanvas = document.createElement("canvas");
      if (!state.bCanvas) state.bCanvas = document.createElement("canvas");
      if (!state.canvas) state.canvas = document.createElement("canvas");

      drawSourceToCanvas(state.aCanvas, sourceA, resolution);
      drawSourceToCanvas(state.bCanvas, sourceB, resolution);

      const aCtx = state.aCanvas.getContext("2d");
      const bCtx = state.bCanvas.getContext("2d");
      if (!aCtx || !bCtx) return { texture: state.texture ?? null };
      const aData = aCtx.getImageData(0, 0, resolution, resolution).data;
      const bData = bCtx.getImageData(0, 0, resolution, resolution).data;

      let maskData: Uint8ClampedArray | null = null;
      if (factorTexture) {
        const maskCanvas = document.createElement("canvas");
        drawSourceToCanvas(maskCanvas, factorTexture, resolution);
        maskData = maskCanvas.getContext("2d")?.getImageData(0, 0, resolution, resolution).data ?? null;
      }

      const out = state.canvas;
      out.width = resolution;
      out.height = resolution;
      const outCtx = out.getContext("2d");
      if (!outCtx) return { texture: state.texture ?? null };
      const outImg = outCtx.createImageData(resolution, resolution);
      const outData = outImg.data;

      for (let i = 0; i < outData.length; i += 4) {
        const t = maskData ? (0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255 : factor;
        for (let c = 0; c < 3; c++) {
          const a = aData[i + c] / 255;
          const b = bData[i + c] / 255;
          const blended = blendChannel(blendMode, a, b);
          const mixed = a + (blended - a) * t;
          outData[i + c] = Math.round(Math.max(0, Math.min(1, mixed)) * 255);
        }
        outData[i + 3] = 255;
      }
      outCtx.putImageData(outImg, 0, 0);

      state.texture = replaceCanvasTexture(state.texture, out, THREE.SRGBColorSpace);
    }

    return { texture: state.texture ?? null };
  },
};

interface PixelSpawnerState {
  group?: THREE.Group;
  materials?: THREE.Material[];
  defaultBox?: THREE.Mesh;
}

const pixelSpawnerCache = createNodeCache<PixelSpawnerState>((s) => {
  if (s.group) disposeObject3D(s.group);
  s.materials?.forEach((m) => m.dispose());
  s.defaultBox?.geometry.dispose();
});

function getPixelSpawnerState(nodeId: string): PixelSpawnerState {
  let state = pixelSpawnerCache.get(nodeId);
  if (!state) {
    state = { group: new THREE.Group(), materials: [] };
    pixelSpawnerCache.set(nodeId, state);
  }
  if (!state.group) state.group = new THREE.Group();
  state.group.clear();
  state.materials?.forEach((m) => m.dispose());
  state.materials = [];
  return state;
}

/**
 * Texture Pixel Spawner node — spawns an instance geometry per pixel of an input texture.
 * Each instance carries the RGB color of its corresponding pixel.
 * Supports percentage density limiting (e.g., 50% = 1 in 2 pixels).
 */
export const TEXTURE_PIXEL_SPAWNER_NODE: NodeDefinition = {
  type: "texture/pixel-spawner",
  label: "Texture Pixel Spawner",
  category: "instance",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "geometry", label: "Instance Geometry", type: "geometry", owns: true },
    { id: "density", label: "Density (%)", type: "value" },
    { id: "scale", label: "Pixel Scale", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "colors", label: "Colors", type: "list" },
    { id: "positions", label: "Positions", type: "list" },
    { id: "intensities", label: "Intensities", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    density: 100,
    maxResolution: 64,
    gridWidth: 10,
    gridHeight: 10,
    instanceScale: 1.0,
    orientation: "xy",
    sampleMode: "uniform_step",
    seed: 1,
    skipAlpha: true,
    alphaThreshold: 0.1,
    gpuInstancing: false,
  },
  dynamicParamFields: () => [
    { id: "density", label: "Density (%)", kind: "number", step: 5 },
    { id: "orientation", label: "Orientation", kind: "select", options: ["xy", "xz", "yz"] },
    { id: "sampleMode", label: "Sample Mode", kind: "select", options: ["uniform_step", "random_seed"] },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "maxResolution", label: "Max Resolution (px)", kind: "number", step: 16 },
    { id: "gridWidth", label: "Grid Width", kind: "number", step: 0.5 },
    { id: "gridHeight", label: "Grid Height", kind: "number", step: 0.5 },
    { id: "instanceScale", label: "Instance Scale", kind: "number", step: 0.1 },
    { id: "skipAlpha", label: "Skip Transparent Pixels", kind: "boolean" },
    { id: "alphaThreshold", label: "Alpha Cutoff", kind: "number", step: 0.05 },
    { id: "gpuInstancing", label: "GPU Instancing (1 draw call — disables Get/Set Instance)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getPixelSpawnerState(ctx.nodeId);
    const group = state.group!;

    const texture = inputs.texture instanceof THREE.Texture ? inputs.texture : null;
    if (!texture || !isDrawable(texture.image) || typeof document === "undefined") {
      return { geometry: group, colors: [], positions: [], intensities: [], count: 0 };
    }

    // Default template box if no geometry is connected
    if (!state.defaultBox) {
      state.defaultBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    }

    const template = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : state.defaultBox;

    const maxRes = Math.max(8, Math.min(256, Math.round(Number(params.maxResolution) || 64)));
    const canvas = document.createElement("canvas");
    drawSourceToCanvas(canvas, texture, maxRes);
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return { geometry: group, colors: [], positions: [], intensities: [], count: 0 };

    const imgData = ctx2d.getImageData(0, 0, maxRes, maxRes);
    const data = imgData.data;

    const rawDensity = inputs.density !== undefined ? Number(inputs.density) : Number(params.density);
    const density = Math.max(0, Math.min(100, Number.isFinite(rawDensity) ? rawDensity : 100));

    if (density <= 0) return { geometry: group, colors: [], positions: [], intensities: [], count: 0 };

    const gridW = Math.max(0.1, Number(params.gridWidth) || 10);
    const gridH = Math.max(0.1, Number(params.gridHeight) || 10);
    const userScale = inputs.scale !== undefined ? Number(inputs.scale) : Number(params.instanceScale) || 1.0;
    const sampleMode = String(params.sampleMode || "uniform_step");
    const orientation = String(params.orientation || "xy").toLowerCase();
    const skipAlpha = Boolean(params.skipAlpha ?? true);
    const alphaCutoff = Math.max(0, Math.min(1, Number(params.alphaThreshold) ?? 0.1));

    const step = sampleMode === "uniform_step" && density < 100 ? Math.max(1, Math.round(100 / density)) : 1;
    const prng = mulberry32(Number(params.seed) || 1);

    const cellW = (gridW / maxRes) * userScale;
    const cellH = (gridH / maxRes) * userScale;

    const colors: THREE.Color[] = [];
    const positions: THREE.Vector3[] = [];
    const intensities: number[] = [];

    const gpuInstancing = Boolean(params.gpuInstancing);
    const instancedItems: InstancedItemSpec[] = [];
    const sourcePivot = getSourcePivot(template);
    const hasPivot = sourcePivot.lengthSq() > 1e-9;
    const pivotInv = hasPivot ? new THREE.Matrix4().makeTranslation(-sourcePivot.x, -sourcePivot.y, -sourcePivot.z) : null;

    let pixelCounter = 0;

    for (let y = 0; y < maxRes; y++) {
      for (let x = 0; x < maxRes; x++) {
        pixelCounter++;

        if (sampleMode === "uniform_step") {
          if (step > 1 && pixelCounter % step !== 0) continue;
        } else {
          if (density < 100 && prng() > density / 100) continue;
        }

        const i = (y * maxRes + x) * 4;
        const a = data[i + 3] / 255;

        if (skipAlpha && a < alphaCutoff) continue;

        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;

        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

        const u = (x + 0.5) / maxRes;
        const v = 1.0 - (y + 0.5) / maxRes;

        const p1 = (u - 0.5) * gridW;
        const p2 = (v - 0.5) * gridH;

        let pos: THREE.Vector3;
        let matScale: THREE.Matrix4;

        if (orientation === "xz") {
          pos = new THREE.Vector3(p1, 0, p2);
          matScale = new THREE.Matrix4().makeScale(cellW, cellW, cellH);
        } else if (orientation === "yz") {
          pos = new THREE.Vector3(0, p2, p1);
          matScale = new THREE.Matrix4().makeScale(cellW, cellH, cellW);
        } else {
          pos = new THREE.Vector3(p1, p2, 0);
          matScale = new THREE.Matrix4().makeScale(cellW, cellH, cellW);
        }

        const color = new THREE.Color(r, g, b);

        const instanceMatrix = new THREE.Matrix4();
        const matPos = new THREE.Matrix4().setPosition(pos);
        instanceMatrix.copy(matPos.multiply(matScale));

        if (gpuInstancing) {
          instancedItems.push({ template, matrix: instanceMatrix, color });
        } else {
          const clone = template.clone(true);
          if (pivotInv) {
            clone.matrixAutoUpdate = false;
            clone.matrix.copy(template.matrix).multiply(pivotInv);
          }

          clone.traverse((child) => {
            if (child instanceof THREE.Mesh && child.material) {
              const mat = (child.material as THREE.Material).clone();
              if ("color" in mat) {
                (mat as THREE.MeshStandardMaterial).color.copy(color);
              }
              state.materials!.push(mat);
              child.material = mat;
            }
          });

          const wrapper = new THREE.Group();
          wrapper.matrixAutoUpdate = false;
          wrapper.matrix.copy(instanceMatrix);
          if (hasPivot) wrapper.userData.pivot = sourcePivot.clone();
          wrapper.add(clone);

          group.add(wrapper);
        }
        colors.push(color);
        positions.push(pos);
        intensities.push(luminance);
      }
    }

    if (gpuInstancing) renderInstanced(ctx.nodeId, group, instancedItems);

    return { geometry: group, colors, positions, intensities, count: colors.length };
  },
};

