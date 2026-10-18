import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { POINTS_INFLUENCE_NODE, influenceStroke, sampleInfluences } from "./pointsInfluence";

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
