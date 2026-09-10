import * as THREE from "three";

export type TerrainResolution = "32x32" | "64x64" | "128x128" | "256x256";

export interface TerrainGridConfig {
  width: number;
  depth: number;
  segmentsX: number;
  segmentsZ: number;
  heightScale: number;
  heightOffset: number;
  slopeShading: boolean;
  flatShading: boolean;
}

export function parseResolution(res: unknown): { segmentsX: number; segmentsZ: number } {
  switch (res) {
    case "32x32":
      return { segmentsX: 32, segmentsZ: 32 };
    case "64x64":
      return { segmentsX: 64, segmentsZ: 64 };
    case "256x256":
      return { segmentsX: 256, segmentsZ: 256 };
    case "128x128":
    default:
      return { segmentsX: 128, segmentsZ: 128 };
  }
}

/**
 * Extracts raw pixel buffer from a THREE.Texture (DataTexture, Image, or Canvas).
 */
export function getTexturePixels(
  texture: THREE.Texture,
): { data: Uint8ClampedArray | Uint8Array | Float32Array; width: number; height: number } | null {
  const image = texture.image as any;
  if (!image) return null;

  // 1. DataTexture with typed array buffer
  if (image.data && image.width && image.height) {
    return { data: image.data, width: image.width, height: image.height };
  }

  // 2. HTML Canvas or Image element in browser environment
  if (
    typeof document !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    (image instanceof HTMLCanvasElement ||
      (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) ||
      (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap))
  ) {
    const canvas = document.createElement("canvas");
    const w = Math.max(1, Math.min(2048, image.width || 256));
    const h = Math.max(1, Math.min(2048, image.height || 256));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    return { data: imgData.data, width: w, height: h };
  }

  return null;
}

/**
 * Samples height from a texture's pixel buffer at normalized UV [0, 1].
 * Returns a normalized elevation in [0, 1].
 */
export function samplePixelHeight(
  pixels: { data: Uint8ClampedArray | Uint8Array | Float32Array; width: number; height: number } | null,
  u: number,
  v: number,
): number {
  if (!pixels) return 0;
  const { data, width, height } = pixels;

  let su = u % 1.0;
  if (su < 0) su += 1.0;
  let sv = (1.0 - v) % 1.0; // Invert V to match Three.js texture coordinate system
  if (sv < 0) sv += 1.0;

  const px = Math.min(width - 1, Math.max(0, Math.floor(su * width)));
  const py = Math.min(height - 1, Math.max(0, Math.floor(sv * height)));
  const idx = (py * width + px) * 4;

  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? r;
  const b = data[idx + 2] ?? r;

  // Luminance or Red channel
  if (data instanceof Float32Array) {
    return r;
  }
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
}

/**
 * Builds or updates the base PlaneGeometry oriented along the XZ plane.
 */
export function createTerrainGeometry(
  width: number,
  depth: number,
  segmentsX: number,
  segmentsZ: number,
): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(width, depth, segmentsX, segmentsZ);
  // Rotate plane so Y is UP (world up vector in Three.js and Tsuji)
  geo.rotateX(-Math.PI / 2);
  if (geo.attributes.position instanceof THREE.BufferAttribute) {
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
  }
  if (geo.attributes.normal instanceof THREE.BufferAttribute) {
    geo.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  }
  return geo;
}

/**
 * Recomputes all terrain vertex elevations and analytical normals.
 * Total height = Base Heightmap (Texture) + Sculpt Offsets.
 */
export function updateTerrainHeightsAndNormals(
  geometry: THREE.BufferGeometry,
  config: TerrainGridConfig,
  heightmapPixels: { data: Uint8ClampedArray | Uint8Array | Float32Array; width: number; height: number } | null,
  sculptOffsets?: Record<number, number> | Float32Array | null,
): Float32Array {
  const { width, depth, segmentsX, segmentsZ, heightScale, heightOffset, slopeShading } = config;
  const cols = segmentsX + 1;
  const rows = segmentsZ + 1;
  const vertexCount = cols * rows;

  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  const posArray = posAttr.array as Float32Array;

  let normAttr = geometry.attributes.normal as THREE.BufferAttribute | undefined;
  if (!normAttr || normAttr.count !== vertexCount) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    normAttr = geometry.attributes.normal as THREE.BufferAttribute;
  }
  const normArray = normAttr.array as Float32Array;

  let colorAttr = geometry.attributes.color as THREE.BufferAttribute | undefined;
  if (slopeShading && (!colorAttr || colorAttr.count !== vertexCount)) {
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    colorAttr = geometry.attributes.color as THREE.BufferAttribute;
  }
  const colorArray = colorAttr ? (colorAttr.array as Float32Array) : null;

  const heights = new Float32Array(vertexCount);
  const isSculptArray = sculptOffsets instanceof Float32Array;

  // Step 1: Compute height for every vertex
  for (let j = 0; j < rows; j++) {
    const v = 1.0 - j / segmentsZ;
    for (let i = 0; i < cols; i++) {
      const u = i / segmentsX;
      const idx = j * cols + i;

      let baseH = 0;
      if (heightmapPixels) {
        baseH = samplePixelHeight(heightmapPixels, u, v) * heightScale + heightOffset;
      }

      let sculptH = 0;
      if (sculptOffsets) {
        if (isSculptArray) {
          sculptH = (sculptOffsets as Float32Array)[idx] || 0;
        } else {
          sculptH = (sculptOffsets as Record<number, number>)[idx] || 0;
        }
      }

      const totalH = baseH + sculptH;
      heights[idx] = totalH;

      // Update position Y
      posArray[idx * 3 + 1] = totalH;
    }
  }

  // Step 2: Analytical Normal computation via finite differences O(N)
  const dx = width / segmentsX;
  const dz = depth / segmentsZ;
  const invTwoDx = 1.0 / (2.0 * dx);
  const invTwoDz = 1.0 / (2.0 * dz);

  // Palette colors for slope shading
  const grassColor = [0.24, 0.49, 0.22];
  const dirtColor = [0.45, 0.38, 0.26];
  const rockColor = [0.42, 0.44, 0.47];
  const snowColor = [0.94, 0.96, 0.98];

  const maxH = heightScale > 0 ? heightOffset + heightScale : 10;
  const snowLine = heightOffset + heightScale * 0.75;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;

      const leftIdx = j * cols + Math.max(0, i - 1);
      const rightIdx = j * cols + Math.min(cols - 1, i + 1);
      const downIdx = Math.max(0, j - 1) * cols + i;
      const upIdx = Math.min(rows - 1, j + 1) * cols + i;

      const hL = heights[leftIdx];
      const hR = heights[rightIdx];
      const hD = heights[downIdx];
      const hU = heights[upIdx];

      // Slopes along X and Z
      const dhdx = (hR - hL) * invTwoDx;
      const dhdz = (hU - hD) * invTwoDz;

      // Normal = normalize(-dhdx, 1, -dhdz)
      const nx = -dhdx;
      const ny = 1.0;
      const nz = -dhdz;
      const len = 1.0 / Math.hypot(nx, ny, nz);

      const normX = nx * len;
      const normY = ny * len;
      const normZ = nz * len;

      normArray[idx * 3] = normX;
      normArray[idx * 3 + 1] = normY;
      normArray[idx * 3 + 2] = normZ;

      // Step 3: Slope / Elevation Shading
      if (slopeShading && colorArray) {
        // Slope metric: 0 is flat horizontal ground, 1 is steep vertical cliff
        const slope = 1.0 - normY;
        const h = heights[idx];

        let r = grassColor[0];
        let g = grassColor[1];
        let b = grassColor[2];

        if (slope > 0.4) {
          // Transition to rock on steep slopes
          const t = Math.min(1.0, (slope - 0.4) / 0.25);
          r = r + (rockColor[0] - r) * t;
          g = g + (rockColor[1] - g) * t;
          b = b + (rockColor[2] - b) * t;
        } else if (slope > 0.18) {
          // Transition to dirt / earth
          const t = Math.min(1.0, (slope - 0.18) / 0.22);
          r = r + (dirtColor[0] - r) * t;
          g = g + (dirtColor[1] - g) * t;
          b = b + (dirtColor[2] - b) * t;
        }

        // High peaks transition to snow
        if (h > snowLine && slope < 0.6) {
          const snowT = Math.min(1.0, (h - snowLine) / Math.max(1, maxH - snowLine));
          r = r + (snowColor[0] - r) * snowT;
          g = g + (snowColor[1] - g) * snowT;
          b = b + (snowColor[2] - b) * snowT;
        }

        colorArray[idx * 3] = r;
        colorArray[idx * 3 + 1] = g;
        colorArray[idx * 3 + 2] = b;
      }
    }
  }

  posAttr.needsUpdate = true;
  normAttr.needsUpdate = true;
  if (colorAttr) colorAttr.needsUpdate = true;

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return heights;
}
