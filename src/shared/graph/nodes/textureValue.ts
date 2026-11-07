import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { getPixelBuffer, type TextureSampleState } from "./sampleTexture";

/**
 * Texture → Value: a 2D noise (Procedural Texture's perlin, voronoi, turbulence…, a Tileable Noise, any texture) read
 * as one number that moves in time — to drive a yellow input, a voice's level or brightness, a send…
 *
 * A point travels across the texture and the node reads it there:
 * - `circle`: round a circle about the centre — it comes back to where it started, so the value loops every
 *   1 / Speed seconds, without a seam.
 * - `line`: across the texture, left to right, at a height (Row); wraps at the edge.
 * Read bilinear, so the value glides between texels instead of stepping.
 *
 * Then shaped: × Multiply, + Offset, clamped to 0–1 if asked. With no texture wired, the Value input is shaped the
 * same way — a remap for a number that is not 0–1.
 *
 * Time is the graph clock (seconds), or the Time input when wired (a song position, say). Pure in it: the same time
 * gives the same value, in an export as live.
 */

const pixelCache = createNodeCache<TextureSampleState>();

export type ScanPath = "circle" | "line";
export type ScanChannel = "luminance" | "red" | "green" | "blue" | "alpha";

export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** Where the point is at `time`: u, v in 0–1 (unwrapped). */
export function scanPoint(path: ScanPath, time: number, speed: number, radius: number, row: number): [number, number] {
  const phase = time * speed;
  if (path === "line") return [phase, row];
  const a = phase * Math.PI * 2;
  return [0.5 + radius * Math.cos(a), 0.5 + radius * Math.sin(a)];
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/** The channel at (u, v), 0–1, bilinear, the texture repeated. */
export function sampleBilinear(px: Pixels, u: number, v: number, channel: ScanChannel): number {
  const { data, width: w, height: h } = px;
  // A float texture holds 0–1 already; a byte one 0–255.
  const scale = data instanceof Float32Array ? 1 : 1 / 255;
  const read = (x: number, y: number): number => {
    const i = (wrap(y, h) * w + wrap(x, w)) * 4;
    const r = (data[i] ?? 0) * scale;
    const g = (data[i + 1] ?? 0) * scale;
    const b = (data[i + 2] ?? 0) * scale;
    switch (channel) {
      case "red":
        return r;
      case "green":
        return g;
      case "blue":
        return b;
      case "alpha":
        return (data[i + 3] ?? 0) * scale;
      default:
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }
  };
  // Texel centres at (i + 0.5) / size.
  const x = u * w - 0.5;
  const y = v * h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const top = read(x0, y0) * (1 - fx) + read(x0 + 1, y0) * fx;
  const bottom = read(x0, y0 + 1) * (1 - fx) + read(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

export function shapeValue(raw: number, multiply: number, offset: number, clamp: boolean): number {
  const v = raw * multiply + offset;
  return clamp ? Math.max(0, Math.min(1, v)) : v;
}

const PATHS: readonly ScanPath[] = ["circle", "line"];
const CHANNELS: readonly ScanChannel[] = ["luminance", "red", "green", "blue", "alpha"];

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

export const TEXTURE_VALUE_NODE: NodeDefinition = {
  type: "math/texture-value",
  label: "Texture → Value",
  category: "math",
  inputs: [
    { id: "texture", label: "Texture (a noise)", type: "texture" },
    { id: "value", label: "Value (no texture: remapped)", type: "value" },
    { id: "time", label: "Time (blank: the clock)", type: "value" },
    { id: "speed", label: "Speed", type: "value" },
    { id: "multiply", label: "Multiply", type: "value" },
    { id: "offset", label: "Offset", type: "value" },
  ],
  outputs: [{ id: "value", label: "Value", type: "value" }],
  defaultParams: { path: "circle", speed: 0.1, radius: 0.3, row: 0.5, channel: "luminance", multiply: 1, offset: 0, clamp: true },
  dynamicParamFields: (instance) => {
    const path = instance.params.path === "line" ? "line" : "circle";
    return [
      { id: "path", label: "Path (circle: loops without a seam)", kind: "select", options: [...PATHS] },
      { id: "speed", label: path === "circle" ? "Speed (turns per second)" : "Speed (widths per second)", kind: "number" },
      path === "circle"
        ? { id: "radius", label: "Radius (0–0.5: bigger, more change per turn)", kind: "number" }
        : { id: "row", label: "Row (0–1)", kind: "number" },
      { id: "channel", label: "Channel", kind: "select", options: [...CHANNELS] },
      { id: "multiply", label: "Multiply", kind: "number" },
      { id: "offset", label: "Offset", kind: "number" },
      { id: "clamp", label: "Clamp 0–1", kind: "boolean" },
    ];
  },
  evaluate: (inputs, params, ctx) => {
    const multiply = num(inputs.multiply, params.multiply, 1);
    const offset = num(inputs.offset, params.offset, 0);
    const clamp = params.clamp !== false && params.clamp !== 0;
    const texture = inputs.texture instanceof THREE.Texture ? inputs.texture : null;
    if (!texture) return { value: shapeValue(num(inputs.value, 0, 0), multiply, offset, clamp) };

    let state = pixelCache.get(ctx.nodeId);
    if (!state) pixelCache.set(ctx.nodeId, (state = {}));
    const px = getPixelBuffer(state, texture);
    if (!px) return { value: shapeValue(0, multiply, offset, clamp) };

    const path: ScanPath = params.path === "line" ? "line" : "circle";
    const channel: ScanChannel = (CHANNELS as readonly string[]).includes(String(params.channel)) ? (params.channel as ScanChannel) : "luminance";
    const time = num(inputs.time, ctx.time, 0);
    const [u, v] = scanPoint(path, time, num(inputs.speed, params.speed, 0.1), num(undefined, params.radius, 0.3), num(undefined, params.row, 0.5));
    return { value: shapeValue(sampleBilinear(px, u, v, channel), multiply, offset, clamp) };
  },
};
