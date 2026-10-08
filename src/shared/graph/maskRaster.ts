import { decodeBitmap } from "./maskBitmap";
import { MaskLayer, flattenPath, layerHasContent } from "./maskShapes";

/**
 * Mask shapes → pixels, on the CPU and with no DOM: this runs inside a node's
 * `evaluate`, and has to work headless (tests, export) as well as in the
 * viewport. Only redone when a shape or a setting changes, never per frame.
 *
 * Row 0 is the image's **bottom** (v = 0), the layout a DataTexture without
 * flipY has, so the result lines up with a plane's own UVs.
 */

/** Sub-scanlines per pixel row; horizontal coverage within each is exact. */
const SUBSAMPLES = 4;

/**
 * Anti-aliased coverage of a polygon (`[x, y, x, y, …]` in pixels), with the
 * non-zero winding rule — a shape that crosses itself stays filled.
 */
export function fillPolygon(polygon: readonly number[], width: number, height: number): Float32Array {
  const coverage = new Float32Array(width * height);
  const n = polygon.length / 2;
  if (n < 3) return coverage;

  // Crossings per sub-scanline: x and winding direction.
  const lines = height * SUBSAMPLES;
  const crossings: number[][] = new Array(lines);
  for (let i = 0; i < n; i++) {
    const x0 = polygon[i * 2];
    const y0 = polygon[i * 2 + 1];
    const x1 = polygon[((i + 1) % n) * 2];
    const y1 = polygon[((i + 1) % n) * 2 + 1];
    if (y0 === y1) continue;
    const dir = y1 > y0 ? 1 : -1;
    const [ya, yb, xa, xb] = y0 < y1 ? [y0, y1, x0, x1] : [y1, y0, x1, x0];
    // Sub-scanline k samples y = (k + 0.5) / SUBSAMPLES.
    const first = Math.max(0, Math.ceil(ya * SUBSAMPLES - 0.5));
    const last = Math.min(lines - 1, Math.ceil(yb * SUBSAMPLES - 0.5) - 1);
    for (let k = first; k <= last; k++) {
      const y = (k + 0.5) / SUBSAMPLES;
      const x = xa + ((y - ya) / (yb - ya)) * (xb - xa);
      (crossings[k] ??= []).push(x, dir);
    }
  }

  const weight = 1 / SUBSAMPLES;
  for (let k = 0; k < lines; k++) {
    const list = crossings[k];
    if (!list || list.length < 4) continue;
    const pairs: [number, number][] = [];
    for (let i = 0; i < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
    pairs.sort((a, b) => a[0] - b[0]);

    const row = Math.floor(k / SUBSAMPLES) * width;
    let winding = 0;
    for (let i = 0; i < pairs.length - 1; i++) {
      winding += pairs[i][1];
      if (winding === 0) continue;
      const xa = Math.max(0, pairs[i][0]);
      const xb = Math.min(width, pairs[i + 1][0]);
      if (xb <= xa) continue;
      const pa = Math.floor(xa);
      const pb = Math.min(width - 1, Math.floor(xb));
      if (pa === pb) {
        coverage[row + pa] += (xb - xa) * weight;
      } else {
        coverage[row + pa] += (pa + 1 - xa) * weight;
        for (let x = pa + 1; x < pb; x++) coverage[row + x] += weight;
        coverage[row + pb] += (xb - pb) * weight;
      }
    }
  }
  for (let i = 0; i < coverage.length; i++) if (coverage[i] > 1) coverage[i] = 1;
  return coverage;
}

const INF = 1e20;

/** One row/column of Felzenszwalb & Huttenlocher's squared distance transform. */
function distance1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Euclidean distance from every pixel to the nearest `true` one, in pixels (0
 * on those pixels). Exact, and linear in the pixel count.
 */
export function distanceTransform(on: Uint8Array, width: number, height: number): Float32Array {
  // Double precision: with "infinity" at 1e20, single precision cannot tell
  // 1e20 + 9 from 1e20, and the parabola intersections go wrong.
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = on[i] ? 0 : INF;

  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    distance1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    distance1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) grid[y * width + x] = Math.sqrt(d[x]);
  }
  return Float32Array.from(grid);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A bitmap resampled to `width × height` (bilinear), as 0..1. Same size is a straight copy. */
export function resampleBitmap(bytes: Uint8Array, bw: number, bh: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  if (bw === width && bh === height) {
    for (let i = 0; i < out.length; i++) out[i] = bytes[i] / 255;
    return out;
  }
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(bh - 1, ((y + 0.5) / height) * bh - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(bw - 1, ((x + 0.5) / width) * bw - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const top = bytes[y0 * bw + x0] * (1 - tx) + bytes[y0 * bw + x1] * tx;
      const bottom = bytes[y1 * bw + x0] * (1 - tx) + bytes[y1 * bw + x1] * tx;
      out[y * width + x] = (top * (1 - ty) + bottom * ty) / 255;
    }
  }
  return out;
}

/** In-place separable box blur of radius `r` px, edges clamped. Three passes of it approximate a Gaussian. */
export function boxBlur(data: Float32Array, width: number, height: number, r: number): void {
  const radius = Math.max(0, Math.floor(r));
  if (radius === 0) return;
  const size = Math.max(width, height);
  const line = new Float32Array(size);
  const window = radius * 2 + 1;
  const pass = (length: number, stride: number, count: number, step: number) => {
    for (let k = 0; k < count; k++) {
      const base = k * step;
      for (let i = 0; i < length; i++) line[i] = data[base + i * stride];
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += line[Math.max(0, Math.min(length - 1, i))];
      for (let i = 0; i < length; i++) {
        data[base + i * stride] = sum / window;
        sum += line[Math.min(length - 1, i + radius + 1)] - line[Math.max(0, i - radius)];
      }
    }
  };
  pass(width, 1, height, width);
  pass(height, width, width, 1);
}

/**
 * A painted layer as 0..1 alpha. Its soft edges are the brush's own; the
 * layer's Feather blurs on top of them (a paint layer has no outline to
 * measure a distance from, so it is a blur rather than the shapes' signed
 * distance — close enough, and it keeps the brush's falloff intact).
 */
export function paintLayerAlpha(layer: MaskLayer, width: number, height: number): Float32Array {
  const bitmap = layer.bitmap;
  const alpha = bitmap ? resampleBitmap(decodeBitmap(bitmap), bitmap.w, bitmap.h, width, height) : new Float32Array(width * height);
  const blur = (layer.feather * Math.max(width, height)) / 2;
  if (blur >= 1) for (let i = 0; i < 3; i++) boxBlur(alpha, width, height, blur / 1.7);
  return finishLayer(alpha, layer);
}

function finishLayer(alpha: Float32Array, layer: MaskLayer): Float32Array {
  const opacity = layer.opacity;
  for (let i = 0; i < alpha.length; i++) {
    let a = alpha[i];
    if (layer.invert) a = 1 - a;
    alpha[i] = a * opacity;
  }
  return alpha;
}

/**
 * One layer as 0..1 alpha: its shape, grown or shrunk by `expansion`, with
 * the edge softened by `feather` — both centred on the outline, so a feather
 * of 20 px fades from 10 px inside to 10 px outside, like After Effects.
 *
 * Opacity and Invert are applied here too; how the layer *combines* with the
 * others is `compositeMasks`' business.
 */
export function layerAlpha(layer: MaskLayer, width: number, height: number): Float32Array {
  if (layer.kind === "paint") return paintLayerAlpha(layer, width, height);
  const longSide = Math.max(width, height);
  const feather = layer.feather * longSide;
  const expansion = layer.expansion * longSide;
  const polygon = flattenPath(layer.points, width, height);
  let alpha = fillPolygon(polygon, width, height);

  if (feather > 0.5 || Math.abs(expansion) > 0.25) {
    // Signed distance to the edge, negative inside: from the nearest pixel of
    // the other kind, less half a pixel (the edge sits between two centres).
    const inside = new Uint8Array(alpha.length);
    const outside = new Uint8Array(alpha.length);
    for (let i = 0; i < alpha.length; i++) {
      const covered = alpha[i] >= 0.5;
      inside[i] = covered ? 1 : 0;
      outside[i] = covered ? 0 : 1;
    }
    const toInside = distanceTransform(inside, width, height);
    const toOutside = distanceTransform(outside, width, height);
    const half = Math.max(0.5, feather) / 2;
    for (let i = 0; i < alpha.length; i++) {
      const signed = inside[i] ? -(toOutside[i] - 0.5) : toInside[i] - 0.5;
      alpha[i] = 1 - smoothstep(-half, half, signed - expansion);
    }
  }

  return finishLayer(alpha, layer);
}

/**
 * Every visible layer stacked, bottom to top.
 *
 *  - **add** is a union that stays soft where two feathered edges meet
 *    (`a + b − ab`);
 *  - **subtract** cuts the layer out of what is below it;
 *  - **intersect** keeps only where both are;
 *  - **difference** keeps where exactly one is.
 *
 * A stack that opens with subtract or intersect starts from a full image, so
 * "cut a hole" works as the first and only layer. No visible layer at all
 * leaves the image whole — a mask node nothing has been drawn on must not
 * make the picture vanish.
 */
export function compositeMasks(layers: readonly MaskLayer[], width: number, height: number): Float32Array {
  const visible = layers.filter((l) => l.visible && layerHasContent(l));
  const out = new Float32Array(width * height);
  if (visible.length === 0) {
    out.fill(1);
    return out;
  }
  if (visible[0].mode === "subtract" || visible[0].mode === "intersect") out.fill(1);

  for (const layer of visible) {
    const b = layerAlpha(layer, width, height);
    switch (layer.mode) {
      case "add":
        for (let i = 0; i < out.length; i++) out[i] = out[i] + b[i] - out[i] * b[i];
        break;
      case "subtract":
        for (let i = 0; i < out.length; i++) out[i] = out[i] * (1 - b[i]);
        break;
      case "intersect":
        for (let i = 0; i < out.length; i++) out[i] = out[i] * b[i];
        break;
      case "difference":
        for (let i = 0; i < out.length; i++) out[i] = out[i] + b[i] - 2 * out[i] * b[i];
        break;
    }
  }
  return out;
}

/** 0..1 coverage → RGBA8 grey (alpha 255), what a mask texture is made of. */
export function maskToRgba(mask: Float32Array, target?: Uint8Array): Uint8Array {
  const data = target && target.length === mask.length * 4 ? target : new Uint8Array(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = Math.round(Math.max(0, Math.min(1, mask[i])) * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return data;
}
