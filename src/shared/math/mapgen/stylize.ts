import { MapMesh } from "./mesh";
import { RiverData } from "./rivers";
import { rasterize } from "./raster";

/**
 * The mapgen4 look, baked into an image.
 *
 * Red Blob Games' map is not a lit 3D scene: it is a flat colour map
 * (elevation × moisture), darkened and lightened by a fixed light acting on
 * the slope, outlined where terrain steps up, with flat blue ribbons for
 * rivers and an ocean that goes black with depth. This ports those formulas
 * (render.ts, colormap.ts and the default render sliders in mapgen4.ts,
 * Apache 2.0) so the result can be shown on a shadeless Terrain.
 */
export interface StyleParams {
  size: number;
  /** Degrees; mapgen4's default is 80. */
  lightAngle: number;
  slope: number;
  flat: number;
  ambient: number;
  overhead: number;
  outlineStrength: number;
  outlineDepth: number;
  outlineThreshold: number;
  /** How far the land is raised off the sea and carved around rivers, in 1/256ths. */
  outlineWater: number;
  /** 0 = neutral beige/blue, 1 = full biome colours. */
  biomeColors: number;
  /** Multiplier on river ribbon width. */
  riverWidth: number;
}

export const MAPGEN4_STYLE: Omit<StyleParams, "size"> = {
  lightAngle: 80,
  slope: 2,
  flat: 2.5,
  ambient: 0.25,
  overhead: 30,
  outlineStrength: 15,
  outlineDepth: 1,
  outlineThreshold: 0,
  outlineWater: 13,
  biomeColors: 1,
  riverWidth: 1,
};

export interface StyleInput {
  mesh: MapMesh;
  elevation: Float32Array;
  moisture?: Float32Array;
  rivers?: RiverData;
}

const smoothstep = (a: number, b: number, x: number): number => {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Soft-edged ribbons, wider where more water flows. Returns coverage 0..1 per pixel, row 0 = map y = 0. */
export function riverCoverage(mesh: MapMesh, rivers: RiverData, size: number, widthScale: number): Float32Array {
  const out = new Float32Array(size * size);
  const P = mesh.points;
  for (const path of rivers.paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const ax = P[a * 2] * size - 0.5;
      const ay = P[a * 2 + 1] * size - 0.5;
      const bx = P[b * 2] * size - 0.5;
      const by = P[b * 2 + 1] * size - 0.5;
      // Full width in pixels at 512: about 5.6 for the biggest river, thin streams below 1.
      const half = 0.5 * widthScale * (size / 512) * 5.6 * Math.sqrt(Math.max(0, rivers.flow[a]));
      const reach = half + 1;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + reach));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by) + reach));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
          const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
          const cov = smoothstep(half + 0.75, Math.max(0, half - 0.75), d);
          if (cov > out[y * size + x]) out[y * size + x] = cov;
        }
      }
    }
  }
  return out;
}

/** mapgen4's colormap: signed elevation and moisture to an sRGB colour, 0..255. */
export function colormap(e: number, m: number): [number, number, number] {
  if (e < 0) {
    const k = Math.max(-1, e);
    return [48 + 48 * k, 64 + 64 * k, 127 + 127 * k];
  }
  const wet = m * (1 - e);
  const c: [number, number, number] = [210 - 100 * wet, 185 - 45 * wet, 139 - 45 * wet];
  // Higher land is bleached towards white.
  return [255 * e + c[0] * (1 - e), 255 * e + c[1] * (1 - e), 255 * e + c[2] * (1 - e)];
}

/** Separable box blur, `passes` times, clamped at the edges. Returns a new array. */
function blurHeights(src: Float32Array, n: number, radius: number, passes: number): Float32Array {
  const cur = Float32Array.from(src);
  const tmp = new Float32Array(src.length);
  const w = radius * 2 + 1;
  const clampIdx = (v: number): number => Math.min(n - 1, Math.max(0, v));
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += cur[y * n + clampIdx(x + k)];
        tmp[y * n + x] = sum / w;
      }
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += tmp[clampIdx(y + k) * n + x];
        cur[y * n + x] = sum / w;
      }
    }
  }
  return cur;
}

/** RGBA8 image, `size` × `size`, row 0 at v = 0 (the map's far edge from the default camera), ready for a texture. */
export function stylizeMap(input: StyleInput, p: StyleParams): Uint8Array {
  const N = p.size;
  const { mesh } = input;
  const e = rasterize(mesh, input.elevation, 1, N, N, false);
  const moisture = input.moisture
    ? rasterize(mesh, input.moisture, 1, N, N, false)
    : new Float32Array(N * N);
  const river = input.rivers ? riverCoverage(mesh, input.rivers, N, p.riverWidth) : new Float32Array(N * N);

  // Height used for shading: land is lifted off the sea, then pulled back down around rivers so they sit in a channel.
  const bump = p.outlineWater / 256;
  const z = new Float32Array(N * N);
  const depth = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const et = 0.5 * (1 + e[i]);
    if (e[i] >= 0) {
      const l1 = et + bump;
      const l2 = (et - 0.5) * (bump * 100) + 0.5;
      z[i] = Math.min(l1, l1 + (l2 - l1) * river[i]);
      depth[i] = e[i];
    } else {
      z[i] = et;
    }
  }

  // Interpolating over triangles leaves visible facets once it is lit; a light blur of the lighting height hides them without softening the colours.
  const lit = blurHeights(z, N, Math.max(1, Math.round(N / 512)), 2);

  const at = (arr: Float32Array, x: number, y: number): number =>
    arr[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))];

  const la = (p.lightAngle * Math.PI) / 180;
  const lx = Math.cos(la);
  const ly = Math.sin(la);
  // The slope differences are defined on mapgen4's 2048 grid; rescale so any size shades the same.
  const diffScale = (N * 3) / (2 * 2048);
  const overheadZ = p.overhead * (2 / 2048);
  const offset = Math.max(1, Math.round(p.outlineDepth * 1.04 * (N / 2048)));
  const threshold = p.outlineThreshold / 1000;

  const neutralLand = [0.9 * 255, 0.8 * 255, 0.7 * 255];
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let [r, g, b] = colormap(e[i], moisture[i]);
      // Biome colours fade towards a neutral beige (water: a darker, bluer one).
      const neutral = e[i] < 0 ? neutralLand.map((v) => v * 0.8) : neutralLand;
      r = neutral[0] + (r - neutral[0]) * p.biomeColors;
      g = neutral[1] + (g - neutral[1]) * p.biomeColors;
      b = neutral[2] + (b - neutral[2]) * p.biomeColors;

      // Rivers are flat blue ribbons laid over the land.
      const a = river[i];
      r = r * (1 - a) + 0.2 * 255 * a;
      g = g * (1 - a) + 0.5 * 255 * a;
      b = b * (1 - a) + 0.7 * 255 * a;

      // North is up on screen, which is -y in the map.
      const zE = at(lit, x + 1, y);
      const zW = at(lit, x - 1, y);
      const zN = at(lit, x, y - 1);
      const zS = at(lit, x, y + 1);
      let sx = (zS - zN) * diffScale;
      let sy = (zE - zW) * diffScale;
      let sz = overheadZ;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const lz = p.slope + (p.flat - p.slope) * sz;
      const ll = Math.hypot(lx, ly, lz) || 1;
      const light = p.ambient + Math.max(0, (lx * sx + ly * sy + lz * sz) / ll);

      // Outline: terrain a step further towards the viewer that is higher than this pixel.
      const d0 = depth[i];
      let d1 = 0;
      for (let k = 1; k <= 3; k++) d1 = Math.max(d1, at(depth, x, y + k * offset));
      const outline = 1 + p.outlineStrength * (Math.max(threshold, d1 - d0) - threshold);

      const o = ((N - 1 - y) * N + x) * 4;
      const f = light / outline;
      out[o] = Math.min(255, Math.max(0, Math.round(r * f)));
      out[o + 1] = Math.min(255, Math.max(0, Math.round(g * f)));
      out[o + 2] = Math.min(255, Math.max(0, Math.round(b * f)));
      out[o + 3] = 255;
    }
  }
  return out;
}
