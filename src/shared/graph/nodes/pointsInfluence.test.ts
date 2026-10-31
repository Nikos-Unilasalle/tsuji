import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import {
  POINTS_INFLUENCE_NODE,
  blurInfluenceMap,
  blurInfluenceOnSurface,
  prepareSurfaceBlur,
  gradientInfluences,
  influenceStroke,
  rasterizeVertexValues,
  sampleInfluences,
} from "./pointsInfluence";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "influence-test" };

describe("POINTS_INFLUENCE_NODE", () => {
  it("defaults every point to 0 influence when nothing has been painted", () => {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];
    const res = POINTS_INFLUENCE_NODE.evaluate({ points, matrix: new THREE.Matrix4() }, POINTS_INFLUENCE_NODE.defaultParams, CTX);
    expect(res.influence).toEqual([0, 0]);
    expect(res.count).toBe(0);
  });

  it("reads painted influence by index and clamps to 0-1", () => {
    const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const res = POINTS_INFLUENCE_NODE.evaluate(
      { points, matrix: new THREE.Matrix4() },
      { ...POINTS_INFLUENCE_NODE.defaultParams, influences: { 0: 0.3, 2: 5 } },
      CTX,
    );
    expect(res.influence).toEqual([0.3, 0, 1]);
    expect(res.count).toBe(2);
  });

  it("the Geometry shortcut extracts points itself, same as Points Selection", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = POINTS_INFLUENCE_NODE.evaluate({ geometry: box }, POINTS_INFLUENCE_NODE.defaultParams, CTX);
    expect(Array.isArray(res.points)).toBe(true);
    expect((res.points as unknown[]).length).toBe(box.geometry.attributes.position.count);
    expect(res.geometry).toBe(box);
  });
});

/** A width×height RGBA map, every pixel the gray `fill(x, y)` (0-255), opaque. */
function grayMap(width: number, height: number, fill: (x: number, y: number) => number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const g = fill(x, y);
      pixels[o] = pixels[o + 1] = pixels[o + 2] = g;
      pixels[o + 3] = 255;
    }
  }
  return pixels;
}

describe("sampleInfluences", () => {
  it("reads the gray under each UV, V up like the painter (top canvas row is V=1)", () => {
    // Top half white, bottom half black.
    const pixels = grayMap(8, 8, (_, y) => (y < 4 ? 255 : 0));
    const uv = new THREE.Float32BufferAttribute([0.5, 0.9, 0.5, 0.1], 2);
    expect(sampleInfluences(pixels, 8, 8, uv)).toEqual({ 0: 1 });
  });

  it("interpolates between pixels and drops zero entries", () => {
    // Left column black, right column white: the middle reads half.
    const pixels = grayMap(2, 1, (x) => (x === 0 ? 0 : 255));
    const uv = new THREE.Float32BufferAttribute([0.5, 0.5, 0.25, 0.5], 2);
    expect(sampleInfluences(pixels, 2, 1, uv)).toEqual({ 0: 0.5 });
  });

  it("weights the gray by its alpha", () => {
    const pixels = grayMap(1, 1, () => 255);
    pixels[3] = 51;
    const uv = new THREE.Float32BufferAttribute([0.5, 0.5], 2);
    expect(sampleInfluences(pixels, 1, 1, uv)).toEqual({ 0: 0.2 });
  });

  it("gives every copy of a seam-split vertex the strongest of their samples", () => {
    const pixels = grayMap(8, 8, (x) => (x < 4 ? 255 : 0));
    // Vertices 0 and 1 share a position but sit on either side of the map.
    const uv = new THREE.Float32BufferAttribute([0.1, 0.5, 0.9, 0.5, 0.9, 0.5], 2);
    const position = new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 1, 0, 0], 3);
    expect(sampleInfluences(pixels, 8, 8, uv, position)).toEqual({ 0: 1, 1: 1 });
  });
});

describe("influenceStroke", () => {
  it("paints the chosen influence as its gray", () => {
    expect(influenceStroke({ brushTool: "paint", brushValue: 0.6 })).toEqual({ tool: "paint", color: "#999999" });
    expect(influenceStroke({ brushTool: "fill", brushValue: 1 })).toEqual({ tool: "fill", color: "#ffffff" });
  });

  it("erases by painting 0, so the map stays opaque", () => {
    expect(influenceStroke({ brushTool: "erase", brushValue: 0.6 })).toEqual({ tool: "paint", color: "#000000" });
  });

  it("falls back to Paint at 100% for unknown values", () => {
    expect(influenceStroke({ brushTool: "watercolor", brushValue: "x" })).toEqual({ tool: "paint", color: "#ffffff" });
  });
});

describe("gradientInfluences", () => {
  it("is 1 at the line's start, 0 at its end, linear between and clamped past both ends", () => {
    const screen = new Float32Array([0, 0, 5, 3, 10, -2, -4, 0, 20, 0]);
    const values = gradientInfluences(screen, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(Array.from(values)).toEqual([1, 0.5, 0, 1, 0]);
  });
});

describe("rasterizeVertexValues", () => {
  it("fills each triangle with its corners' values blended, readable back by sampleInfluences", () => {
    // Two triangles covering the whole square; value = u.
    const uv = new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2);
    const values = [0, 1, 1, 0, 1, 0];
    const pixels = new Uint8ClampedArray(16 * 16 * 4);
    rasterizeVertexValues(pixels, 16, 16, uv, values);
    const probe = new THREE.Float32BufferAttribute([0.25, 0.5, 0.75, 0.5], 2);
    const read = sampleInfluences(pixels, 16, 16, probe);
    expect(read[0]).toBeCloseTo(0.25, 1);
    expect(read[1]).toBeCloseTo(0.75, 1);
  });

  it("leaves texels away from every island at 0, opaque", () => {
    const uv = new THREE.Float32BufferAttribute([0, 0, 0.25, 0, 0, 0.25], 2);
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    rasterizeVertexValues(pixels, 32, 32, uv, [1, 1, 1]);
    // Top-right corner (U=1, V=1) is far from the triangle at the bottom-left.
    expect(pixels[(0 * 32 + 31) * 4]).toBe(0);
    expect(pixels[(0 * 32 + 31) * 4 + 3]).toBe(255);
    // Inside the triangle.
    expect(pixels[(30 * 32 + 1) * 4]).toBe(255);
  });
});

describe("blurInfluenceMap", () => {
  it("spreads a hard edge into a ramp and keeps a flat map flat", () => {
    const sharp = grayMap(32, 1, (x) => (x < 16 ? 0 : 255));
    const out = blurInfluenceMap(sharp, 32, 1, 6);
    expect(out[15 * 4]).toBeGreaterThan(40);
    expect(out[15 * 4]).toBeLessThan(215);
    expect(out[0]).toBe(0);
    expect(out[31 * 4]).toBe(255);
    const flat = blurInfluenceMap(grayMap(8, 8, () => 128), 8, 8, 3);
    expect(Array.from(flat.filter((_, i) => i % 4 === 0)).every((g) => g === 128)).toBe(true);
  });

  it("with a mask, an island's edge doesn't darken toward the empty texels around it", () => {
    // White island in the middle 8 texels, black gap either side.
    const pixels = grayMap(24, 1, (x) => (x >= 8 && x < 16 ? 255 : 0));
    const mask = new Uint8Array(24).map((_, x) => (x >= 8 && x < 16 ? 1 : 0));
    const out = blurInfluenceMap(pixels, 24, 1, 6, mask);
    expect(out[8 * 4]).toBe(255);
    expect(out[15 * 4]).toBe(255);
    expect(out[2 * 4]).toBe(0);
  });
});

describe("blurInfluenceOnSurface", () => {
  it("evens out a seam: the copies of a vertex split across islands read the same value afterwards", () => {
    // A square of two triangles sharing the edge (1,0,0)-(0,1,0), laid out as
    // two islands apart in UV: the left one painted white, the right one black.
    const position = new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3);
    const uv = new THREE.Float32BufferAttribute([0.05, 0.05, 0.45, 0.05, 0.05, 0.45, 0.95, 0.05, 0.95, 0.45, 0.55, 0.45], 2);
    const size = 64;
    const pixels = grayMap(size, size, (x) => (x < size / 2 ? 255 : 0));
    const setup = prepareSurfaceBlur(size, size, uv, position);
    expect(setup.weldCount).toBe(4);
    const out = blurInfluenceOnSurface(setup, pixels, 8);
    // Vertex 1 and 3 are the same corner (1,0,0) on either island; 2 and 5 are (0,1,0).
    const read = (i: number) => sampleInfluences(out, size, size, new THREE.Float32BufferAttribute([uv.getX(i), uv.getY(i)], 2))[0] ?? 0;
    expect(Math.abs(read(1) - read(3))).toBeLessThan(0.08);
    expect(Math.abs(read(2) - read(5))).toBeLessThan(0.08);
    expect(read(1)).toBeGreaterThan(0.1);
    expect(read(1)).toBeLessThan(0.9);
  });
});
