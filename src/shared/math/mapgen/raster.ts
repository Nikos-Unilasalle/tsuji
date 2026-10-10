import { MapMesh } from "./mesh";

/**
 * Paints per-point values into a width × height grid by barycentric
 * interpolation over the triangles. `values` holds `channels` floats per
 * point; the result holds `channels` floats per pixel.
 *
 * Row 0 is the map's y = 0 edge, unless `flipY` puts it at y = 1 — the
 * Terrain node reads its heightmap with row 0 at the plane's far (-Z) edge,
 * while ordinary UV-mapped textures want row 0 at v = 0.
 */
export function rasterize(
  mesh: MapMesh,
  values: Float32Array,
  channels: number,
  width: number,
  height: number,
  flipY: boolean,
): Float32Array {
  const out = new Float32Array(width * height * channels);
  const P = mesh.points;
  const T = mesh.triangles;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t];
    const b = T[t + 1];
    const c = T[t + 2];
    const ax = P[a * 2] * width - 0.5;
    const ay = P[a * 2 + 1] * height - 0.5;
    const bx = P[b * 2] * width - 0.5;
    const by = P[b * 2 + 1] * height - 0.5;
    const cx = P[c * 2] * width - 0.5;
    const cy = P[c * 2 + 1] * height - 0.5;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        const eps = -1e-4;
        if (l1 < eps || l2 < eps || l3 < eps) continue;
        const row = flipY ? height - 1 - y : y;
        const o = (row * width + x) * channels;
        for (let ch = 0; ch < channels; ch++) {
          out[o + ch] = l1 * values[a * channels + ch] + l2 * values[b * channels + ch] + l3 * values[c * channels + ch];
        }
      }
    }
  }
  return out;
}

/** Draws river paths as 1–2 px lines of `value` into a single-channel grid (same row convention as rasterize). */
export function drawPaths(
  mesh: MapMesh,
  paths: number[][],
  weights: Float32Array,
  width: number,
  height: number,
  flipY: boolean,
  baseWidth: number,
): Float32Array {
  const out = new Float32Array(width * height);
  const P = mesh.points;
  const plot = (px: number, py: number, w: number): void => {
    const r = Math.max(0.5, w);
    const x0 = Math.max(0, Math.floor(px - r));
    const x1 = Math.min(width - 1, Math.ceil(px + r));
    const y0 = Math.max(0, Math.floor(py - r));
    const y1 = Math.min(height - 1, Math.ceil(py + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x - px, y - py) > r) continue;
        const row = flipY ? height - 1 - y : y;
        out[row * width + x] = 1;
      }
    }
  };
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const ax = P[a * 2] * width - 0.5;
      const ay = P[a * 2 + 1] * height - 0.5;
      const bx = P[b * 2] * width - 0.5;
      const by = P[b * 2 + 1] * height - 0.5;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      const w = baseWidth * (0.5 + weights[a]);
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        plot(ax + (bx - ax) * f, ay + (by - ay) * f, w);
      }
    }
  }
  return out;
}
