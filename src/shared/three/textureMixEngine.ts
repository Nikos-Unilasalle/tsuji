import * as THREE from "three";

export type TextureMixTool = "paint" | "erase" | "smooth" | "fill";
export type TextureMixFalloff = "smooth" | "linear" | "flat";

export interface TextureMixStrokeParams {
  tool: TextureMixTool;
  activeLayer: number;
  radius: number;
  strength: number;
  falloff: TextureMixFalloff;
  uv: { x: number; y: number };
  prevUv?: { x: number; y: number } | null;
  pressure?: number;
  prevPressure?: number | null;
  pressureAffects?: "both" | "size" | "opacity" | "none";
}

export interface LayerSource {
  texture?: THREE.Texture | null;
  canvas?: HTMLCanvasElement | null;
  imageData?: ImageData | null;
  uvScale?: number;
  color?: string; // fallback color if no texture is wired
}

export function calculateMixFalloff(distNorm: number, type: TextureMixFalloff): number {
  if (distNorm >= 1.0) return 0;
  if (distNorm <= 0) return 1;
  switch (type) {
    case "linear":
      return 1.0 - distNorm;
    case "flat":
      return 1.0;
    case "smooth":
    default:
      return (1.0 + Math.cos(Math.PI * distNorm)) * 0.5;
  }
}

/**
 * Creates a normalized multi-layer weight buffer.
 * Layer 0 initialized to 1.0 (100%), other layers to 0.0.
 */
export function createSplatBuffer(width: number, height: number, layerCount: number): Float32Array {
  const count = Math.max(1, layerCount);
  const total = width * height * count;
  const weights = new Float32Array(total);
  // Default: layer 0 has 100% weight everywhere
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i++) {
    weights[i * count] = 1.0;
  }
  return weights;
}

/**
 * Resizes or ensures the weight buffer matches the target width, height, and layer count.
 */
export function ensureSplatBuffer(
  existing: Float32Array | null | undefined,
  width: number,
  height: number,
  layerCount: number,
): Float32Array {
  const count = Math.max(1, layerCount);
  const expectedSize = width * height * count;
  if (existing && existing.length === expectedSize) {
    return existing;
  }
  return createSplatBuffer(width, height, count);
}

/**
 * Applies a splat painting stroke to the weight buffer.
 * Normalizes all layer weights per pixel so that sum(weights) = 1.0.
 */
export function applyMixStroke(
  weights: Float32Array,
  width: number,
  height: number,
  layerCount: number,
  params: TextureMixStrokeParams,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const count = Math.max(1, layerCount);
  const active = Math.max(0, Math.min(count - 1, params.activeLayer));

  // UV to pixel coordinates
  const normU = ((params.uv.x % 1.0) + 1.0) % 1.0;
  const normV = ((params.uv.y % 1.0) + 1.0) % 1.0;
  const currX = Math.round(normU * width);
  const currY = Math.round((1.0 - normV) * height);

  // Fill tool
  if (params.tool === "fill") {
    const pixelCount = width * height;
    for (let i = 0; i < pixelCount; i++) {
      for (let l = 0; l < count; l++) {
        weights[i * count + l] = l === active ? 1.0 : 0.0;
      }
    }
    return { minX: 0, minY: 0, maxX: width, maxY: height };
  }

  const pStart = params.prevPressure ?? params.pressure ?? 1.0;
  const pEnd = params.pressure ?? 1.0;
  const pressureMode = params.pressureAffects ?? "both";

  // Line interpolation between prevUv and uv
  const stampPoints: { x: number; y: number; r: number; strength: number }[] = [];
  if (params.prevUv) {
    const prevNormU = ((params.prevUv.x % 1.0) + 1.0) % 1.0;
    const prevNormV = ((params.prevUv.y % 1.0) + 1.0) % 1.0;
    const prevX = Math.round(prevNormU * width);
    const prevY = Math.round((1.0 - prevNormV) * height);

    const dist = Math.hypot(currX - prevX, currY - prevY);
    const step = Math.max(1, params.radius * 0.25);
    const n = Math.ceil(dist / step);
    for (let i = 0; i <= n; i++) {
      const t = n === 0 ? 1 : i / n;
      const p = pStart + (pEnd - pStart) * t;
      const r = pressureMode === "size" || pressureMode === "both" ? Math.max(1, Math.round(params.radius * p)) : Math.max(1, Math.round(params.radius));
      const str =
        pressureMode === "opacity" || pressureMode === "both"
          ? Math.max(0.01, params.strength * (0.15 + 0.85 * p))
          : params.strength;
      stampPoints.push({
        x: Math.round(prevX + (currX - prevX) * t),
        y: Math.round(prevY + (currY - prevY) * t),
        r,
        strength: str,
      });
    }
  } else {
    const p = pEnd;
    const r = pressureMode === "size" || pressureMode === "both" ? Math.max(1, Math.round(params.radius * p)) : Math.max(1, Math.round(params.radius));
    const str =
      pressureMode === "opacity" || pressureMode === "both"
        ? Math.max(0.01, params.strength * (0.15 + 0.85 * p))
        : params.strength;
    stampPoints.push({ x: currX, y: currY, r, strength: str });
  }

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (const pt of stampPoints) {
    const r = pt.r;
    const x0 = Math.max(0, pt.x - r);
    const x1 = Math.min(width - 1, pt.x + r);
    const y0 = Math.max(0, pt.y - r);
    const y1 = Math.min(height - 1, pt.y + r);

    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);

    if (params.tool === "smooth") {
      // Local weight smoothing
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dist = Math.hypot(x - pt.x, y - pt.y);
          if (dist > r) continue;
          const falloff = calculateMixFalloff(dist / r, params.falloff);
          const blendRate = pt.strength * falloff * 0.3;

          // Average with 4-neighborhood
          const left = Math.max(0, x - 1);
          const right = Math.min(width - 1, x + 1);
          const top = Math.max(0, y - 1);
          const bottom = Math.min(height - 1, y + 1);

          const idx = (y * width + x) * count;
          const leftIdx = (y * width + left) * count;
          const rightIdx = (y * width + right) * count;
          const topIdx = (top * width + x) * count;
          const bottomIdx = (bottom * width + x) * count;

          let sumWeights = 0;
          for (let l = 0; l < count; l++) {
            const avg = (weights[leftIdx + l] + weights[rightIdx + l] + weights[topIdx + l] + weights[bottomIdx + l]) * 0.25;
            weights[idx + l] += (avg - weights[idx + l]) * blendRate;
            sumWeights += weights[idx + l];
          }

          if (sumWeights > 1e-5) {
            for (let l = 0; l < count; l++) {
              weights[idx + l] /= sumWeights;
            }
          }
        }
      }
    } else {
      // Paint or Erase tool
      const isErase = params.tool === "erase";
      const deltaSign = isErase ? -1 : 1;

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dist = Math.hypot(x - pt.x, y - pt.y);
          if (dist > r) continue;
          const falloff = calculateMixFalloff(dist / r, params.falloff);
          const delta = pt.strength * falloff * deltaSign * 0.35;

          const idx = (y * width + x) * count;
          const oldActive = weights[idx + active];
          const newActive = Math.max(0, Math.min(1, oldActive + delta));
          const change = newActive - oldActive;

          if (Math.abs(change) > 1e-6) {
            weights[idx + active] = newActive;
            const remaining = 1.0 - newActive;
            const oldOthersSum = 1.0 - oldActive;

            if (oldOthersSum > 1e-5) {
              for (let l = 0; l < count; l++) {
                if (l === active) continue;
                weights[idx + l] = (weights[idx + l] / oldOthersSum) * remaining;
              }
            } else {
              // If others were 0, distribute to layer 0 (or first other)
              const fallbackIdx = active === 0 ? 1 : 0;
              for (let l = 0; l < count; l++) {
                if (l === active) continue;
                weights[idx + l] = l === fallbackIdx ? remaining : 0;
              }
            }
          }
        }
      }
    }
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Extracts ImageData from a THREE.Texture using an internal canvas.
 */
export function extractTextureImageData(texture: THREE.Texture, width: number, height: number): ImageData | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const image = texture.image as any;
  if (image && image.width && image.height) {
    try {
      ctx.drawImage(image as CanvasImageSource, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Composites the multi-layer splatted texture into targetCanvas.
 */
export function compositeSplatTextures(
  targetCanvas: HTMLCanvasElement,
  weights: Float32Array,
  width: number,
  height: number,
  layers: LayerSource[],
): void {
  const ctx = targetCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  targetCanvas.width = width;
  targetCanvas.height = height;

  const outImg = ctx.createImageData(width, height);
  const outData = outImg.data;
  const count = Math.max(1, layers.length);

  // Fallback palette colors if textures are not yet loaded or wired
  const defaultColors = [
    [56, 189, 70],    // 0: Grass green
    [139, 90, 43],    // 1: Dirt brown
    [128, 128, 128],  // 2: Rock gray
    [240, 230, 200],  // 3: Sand
    [255, 255, 255],  // 4: Snow
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pIdx = (y * width + x) * 4;
      const wIdx = (y * width + x) * count;

      let r = 0;
      let g = 0;
      let b = 0;

      for (let l = 0; l < count; l++) {
        const w = weights[wIdx + l];
        if (w <= 1e-4) continue;

        const layer = layers[l];
        let lr = defaultColors[l % defaultColors.length][0];
        let lg = defaultColors[l % defaultColors.length][1];
        let lb = defaultColors[l % defaultColors.length][2];

        if (layer?.imageData) {
          const uvScale = Math.max(0.01, layer.uvScale ?? 1.0);
          const srcW = layer.imageData.width;
          const srcH = layer.imageData.height;
          // Tiled sampling
          const tx = Math.floor(((x * uvScale) % srcW + srcW) % srcW);
          const ty = Math.floor(((y * uvScale) % srcH + srcH) % srcH);
          const srcIdx = (ty * srcW + tx) * 4;
          lr = layer.imageData.data[srcIdx];
          lg = layer.imageData.data[srcIdx + 1];
          lb = layer.imageData.data[srcIdx + 2];
        }

        r += lr * w;
        g += lg * w;
        b += lb * w;
      }

      outData[pIdx] = Math.round(Math.max(0, Math.min(255, r)));
      outData[pIdx + 1] = Math.round(Math.max(0, Math.min(255, g)));
      outData[pIdx + 2] = Math.round(Math.max(0, Math.min(255, b)));
      outData[pIdx + 3] = 255;
    }
  }

  ctx.putImageData(outImg, 0, 0);
}

/**
 * Creates a debug visualization of the splat weight map (RGBA for the first 3-4 layers).
 */
export function renderSplatMapPreview(
  targetCanvas: HTMLCanvasElement,
  weights: Float32Array,
  width: number,
  height: number,
  layerCount: number,
): void {
  const ctx = targetCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  targetCanvas.width = width;
  targetCanvas.height = height;

  const outImg = ctx.createImageData(width, height);
  const outData = outImg.data;
  const count = Math.max(1, layerCount);

  for (let i = 0; i < width * height; i++) {
    const pIdx = i * 4;
    const wIdx = i * count;
    outData[pIdx] = Math.round((weights[wIdx] || 0) * 255);     // R: layer 0
    outData[pIdx + 1] = Math.round((weights[wIdx + 1] || 0) * 255); // G: layer 1
    outData[pIdx + 2] = Math.round((weights[wIdx + 2] || 0) * 255); // B: layer 2
    outData[pIdx + 3] = 255;
  }

  ctx.putImageData(outImg, 0, 0);
}

/**
 * Serializes the multi-layer splat weights to a JSON string or compact base64 representation.
 */
export function serializeSplatBuffer(weights: Float32Array): string {
  // Quantize weights to 8-bit uint8 array (0-255) for compact serialization
  const uint8 = new Uint8Array(weights.length);
  for (let i = 0; i < weights.length; i++) {
    uint8[i] = Math.round(Math.max(0, Math.min(1, weights[i])) * 255);
  }
  let binary = "";
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  if (typeof btoa !== "undefined") {
    return btoa(binary);
  }
  return "";
}

/**
 * Restores a splat weight buffer from a serialized base64 string.
 */
export function restoreSplatBuffer(
  serialized: string,
  width: number,
  height: number,
  layerCount: number,
): Float32Array | null {
  if (!serialized || typeof atob === "undefined") return null;
  try {
    const binary = atob(serialized);
    const count = Math.max(1, layerCount);
    const expected = width * height * count;
    if (binary.length !== expected) return null;

    const weights = new Float32Array(expected);
    for (let i = 0; i < expected; i++) {
      weights[i] = binary.charCodeAt(i) / 255;
    }
    return weights;
  } catch {
    return null;
  }
}

/**
 * Band weights at one normalized altitude, by the same rule the bake uses.
 *
 * Exported so the parameter editor can draw the bands it is about to produce
 * rather than an artist's impression of them: the bar in the panel and the
 * texture on the terrain come out of this one function, so a soft edge shown
 * in the panel is the soft edge that gets baked.
 */
export function heightBandWeights(
  height: number,
  rules: { shoreHeight: number; shoreBlend: number; snowHeight: number; snowBlend: number; hasShore: boolean },
): { base: number; peak: number; shore: number } {
  const smooth = (edge0: number, edge1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-4, edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };

  const peak = smooth(rules.snowHeight - rules.snowBlend * 0.5, rules.snowHeight + rules.snowBlend * 0.5, height);
  const shore = rules.hasShore
    ? 1 - smooth(rules.shoreHeight - rules.shoreBlend * 0.5, rules.shoreHeight + rules.shoreBlend * 0.5, height)
    : 0;
  const base = Math.max(0, 1 - peak - shore);

  return { base, peak, shore };
}

export interface HeightSlopeConfig {
  slopeAngle?: number; // threshold in degrees (e.g. 35)
  slopeBlend?: number; // softness in degrees (e.g. 15)
  slopeLayer?: number; // layer index for slope/cliffs (default 1)
  snowHeight?: number; // relative [0..1] altitude threshold (default 0.75)
  snowBlend?: number; // softness (default 0.15)
  snowLayer?: number; // layer index for snow (default 2)
  shoreHeight?: number; // relative [0..1] threshold (default 0.15)
  shoreBlend?: number; // softness (default 0.1)
  shoreLayer?: number; // layer index for shore (default -1, disabled)
  baseLayer?: number; // default 0 (flat/grass)
  noiseAmount?: number; // 0..1, default 0.2
  noiseFrequency?: number; // default 6.0
}

/**
 * Procedurally generates multi-layer splat weights based on geometric altitude (Y) and surface slope.
 */
export function computeHeightSlopeWeights(
  weights: Float32Array,
  width: number,
  height: number,
  layerCount: number,
  geometry: THREE.BufferGeometry | THREE.Object3D | null | undefined,
  config: HeightSlopeConfig = {},
): void {
  const count = Math.max(1, layerCount);
  const baseL = Math.max(0, Math.min(count - 1, config.baseLayer ?? 0));
  const slopeL = config.slopeLayer !== undefined ? Math.max(0, Math.min(count - 1, config.slopeLayer)) : (count > 1 ? 1 : 0);
  const snowL = config.snowLayer !== undefined && config.snowLayer >= 0 ? Math.min(count - 1, config.snowLayer) : (count > 2 ? 2 : -1);
  const shoreL = config.shoreLayer !== undefined && config.shoreLayer >= 0 ? Math.min(count - 1, config.shoreLayer) : -1;

  const slopeAngle = config.slopeAngle ?? 35;
  const slopeBlend = Math.max(0.1, config.slopeBlend ?? 15);
  const snowHeight = config.snowHeight ?? 0.75;
  const snowBlend = Math.max(0.01, config.snowBlend ?? 0.15);
  const shoreHeight = config.shoreHeight ?? 0.15;
  const shoreBlend = Math.max(0.01, config.shoreBlend ?? 0.1);
  const noiseAmount = Math.max(0, Math.min(1, config.noiseAmount ?? 0.2));
  const noiseFreq = Math.max(0.1, config.noiseFrequency ?? 6.0);

  // Initialize all pixels to 100% base layer
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i++) {
    for (let l = 0; l < count; l++) {
      weights[i * count + l] = l === baseL ? 1.0 : 0.0;
    }
  }

  if (!geometry) return;

  // Collect mesh list
  const meshList: { geom: THREE.BufferGeometry; matrixWorld: THREE.Matrix4 }[] = [];
  if (geometry instanceof THREE.Object3D) {
    geometry.updateMatrixWorld(true);
    geometry.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
        meshList.push({
          geom: (child as THREE.Mesh).geometry,
          matrixWorld: child.matrixWorld,
        });
      }
    });
  } else if (geometry instanceof THREE.BufferGeometry) {
    meshList.push({
      geom: geometry,
      matrixWorld: new THREE.Matrix4(),
    });
  }

  if (meshList.length === 0) return;

  // Compute global bounding box for height normalization
  let minY = Infinity;
  let maxY = -Infinity;
  const vTemp = new THREE.Vector3();

  for (const item of meshList) {
    const posAttr = item.geom.getAttribute("position");
    if (!posAttr) continue;
    for (let i = 0; i < posAttr.count; i++) {
      vTemp.fromBufferAttribute(posAttr, i).applyMatrix4(item.matrixWorld);
      if (vTemp.y < minY) minY = vTemp.y;
      if (vTemp.y > maxY) maxY = vTemp.y;
    }
  }

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    minY = 0;
    maxY = 1;
  }
  const heightRange = Math.max(0.001, maxY - minY);

  // Simple deterministic 2D noise helper
  const hash = (u: number, v: number) => {
    const n = Math.sin(u * 12.9898 + v * 78.233) * 43758.5453123;
    return n - Math.floor(n);
  };
  const noise2D = (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const s = fx * fx * (3 - 2 * fx);
    const t = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return (a * (1 - s) + b * s) * (1 - t) + (c * (1 - s) + d * s) * t - 0.5;
  };

  const smoothstep = (edge0: number, edge1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(0.0001, edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };

  // Process triangles in UV space
  const normalMatrix = new THREE.Matrix3();

  for (const item of meshList) {
    const geom = item.geom;
    const posAttr = geom.getAttribute("position");
    if (!posAttr) continue;

    let uvAttr = geom.getAttribute("uv");
    let normAttr = geom.getAttribute("normal");
    if (!normAttr) {
      geom.computeVertexNormals();
      normAttr = geom.getAttribute("normal");
    }

    normalMatrix.getNormalMatrix(item.matrixWorld);

    const index = geom.getIndex();
    const triCount = index ? index.count / 3 : posAttr.count / 3;

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      // Positions
      const p0 = new THREE.Vector3().fromBufferAttribute(posAttr, i0).applyMatrix4(item.matrixWorld);
      const p1 = new THREE.Vector3().fromBufferAttribute(posAttr, i1).applyMatrix4(item.matrixWorld);
      const p2 = new THREE.Vector3().fromBufferAttribute(posAttr, i2).applyMatrix4(item.matrixWorld);

      // Normals
      const n0 = normAttr ? new THREE.Vector3().fromBufferAttribute(normAttr, i0).applyMatrix3(normalMatrix).normalize() : new THREE.Vector3(0, 1, 0);
      const n1 = normAttr ? new THREE.Vector3().fromBufferAttribute(normAttr, i1).applyMatrix3(normalMatrix).normalize() : new THREE.Vector3(0, 1, 0);
      const n2 = normAttr ? new THREE.Vector3().fromBufferAttribute(normAttr, i2).applyMatrix3(normalMatrix).normalize() : new THREE.Vector3(0, 1, 0);

      // UVs
      let u0 = uvAttr ? uvAttr.getX(i0) : 0;
      let v0 = uvAttr ? uvAttr.getY(i0) : 0;
      let u1 = uvAttr ? uvAttr.getX(i1) : 0;
      let v1 = uvAttr ? uvAttr.getY(i1) : 0;
      let u2 = uvAttr ? uvAttr.getX(i2) : 0;
      let v2 = uvAttr ? uvAttr.getY(i2) : 0;

      // Normalize UV into [0..1]
      u0 = ((u0 % 1) + 1) % 1;
      v0 = ((v0 % 1) + 1) % 1;
      u1 = ((u1 % 1) + 1) % 1;
      v1 = ((v1 % 1) + 1) % 1;
      u2 = ((u2 % 1) + 1) % 1;
      v2 = ((v2 % 1) + 1) % 1;

      // Pixel coords (V inverted for canvas texture coords)
      const x0 = u0 * width, y0 = (1.0 - v0) * height;
      const x1 = u1 * width, y1 = (1.0 - v1) * height;
      const x2 = u2 * width, y2 = (1.0 - v2) * height;

      // Triangle bounding box
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));

      // If triangle wraps across UV seam, skip extreme boundary stretch
      if (maxX - minX > width * 0.75 || maxY - minY > height * 0.75) continue;

      const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(denom) < 1e-5) continue;

      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const w0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / denom;
          const w1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / denom;
          const w2 = 1.0 - w0 - w1;

          if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;

          // Interpolate height and normal
          const yVal = w0 * p0.y + w1 * p1.y + w2 * p2.y;
          const nyVal = w0 * n0.y + w1 * n1.y + w2 * n2.y;
          const nxVal = w0 * n0.x + w1 * n1.x + w2 * n2.x;
          const nzVal = w0 * n0.z + w1 * n1.z + w2 * n2.z;
          const nLen = Math.hypot(nxVal, nyVal, nzVal) || 1;
          const normNy = Math.max(-1, Math.min(1, nyVal / nLen));

          const slopeDeg = Math.acos(normNy) * (180 / Math.PI);
          const heightNorm = Math.max(0, Math.min(1, (yVal - minY) / heightRange));

          // Noise modulation
          const nSample = noiseAmount > 0 ? noise2D((px / width) * noiseFreq, (py / height) * noiseFreq) : 0;
          const effSlope = Math.max(0, Math.min(90, slopeDeg + nSample * noiseAmount * 25));
          const effHeight = Math.max(0, Math.min(1, heightNorm + nSample * noiseAmount * 0.25));

          // Calculate layer weights
          let wSlope = smoothstep(slopeAngle - slopeBlend * 0.5, slopeAngle + slopeBlend * 0.5, effSlope);
          let wSnow = snowL >= 0 ? smoothstep(snowHeight - snowBlend * 0.5, snowHeight + snowBlend * 0.5, effHeight) : 0;
          if (wSnow > 0) {
            wSnow *= 1.0 - smoothstep(55, 75, effSlope);
          }
          let wShore = shoreL >= 0 ? 1.0 - smoothstep(shoreHeight - shoreBlend * 0.5, shoreHeight + shoreBlend * 0.5, effHeight) : 0;

          const pIdx = (py * width + px) * count;

          for (let l = 0; l < count; l++) {
            weights[pIdx + l] = 0;
          }

          if (slopeL >= 0) weights[pIdx + slopeL] += wSlope;
          if (snowL >= 0) weights[pIdx + snowL] += wSnow;
          if (shoreL >= 0) weights[pIdx + shoreL] += wShore;

          const totalSpecial = (slopeL >= 0 ? weights[pIdx + slopeL] : 0) +
                               (snowL >= 0 ? weights[pIdx + snowL] : 0) +
                               (shoreL >= 0 ? weights[pIdx + shoreL] : 0);

          const wBase = Math.max(0, 1.0 - totalSpecial);
          weights[pIdx + baseL] += wBase;

          // Normalize
          let sum = 0;
          for (let l = 0; l < count; l++) sum += weights[pIdx + l];
          if (sum > 1e-4) {
            for (let l = 0; l < count; l++) weights[pIdx + l] /= sum;
          } else {
            weights[pIdx + baseL] = 1.0;
          }
        }
      }
    }
  }
}

