import { describe, it, expect } from "vitest";
import { SkinWeights } from "./skinning";
import { applyPaintLayer, cloneSkin, jointWeight, paintDab, PaintLayer, paintNeighbours, readPaintLayer, storePaintLayers } from "./weightPaint";

/** Two influences per vertex: (joint, weight) pairs. */
function skinOf(rows: [number, number, number, number][]): SkinWeights {
  const indices = new Uint16Array(rows.length * 2);
  const weights = new Float32Array(rows.length * 2);
  rows.forEach(([a, wa, b, wb], v) => {
    indices.set([a, b], v * 2);
    weights.set([wa, wb], v * 2);
  });
  return { influences: 2, indices, weights };
}

const sumOf = (skin: SkinWeights, v: number) => skin.weights[v * 2] + skin.weights[v * 2 + 1];
// Chain 0 -> 1 -> 2.
const parents = [-1, 0, 1];

describe("weight paint", () => {
  it("leaves unpainted vertices on their automatic weights", () => {
    const auto = skinOf([[0, 0.7, 1, 0.3], [1, 1, 0, 0]]);
    const skin = cloneSkin(auto);
    applyPaintLayer(auto, new Map(), parents, skin);
    expect(Array.from(skin.weights)).toEqual(Array.from(auto.weights));
  });

  it("raises one joint and scales the others to keep the total at 1", () => {
    const auto = skinOf([[0, 0.6, 1, 0.4]]);
    const layer: PaintLayer = new Map([[1, new Map([[0, 0.4]])]]);
    const skin = cloneSkin(auto);
    applyPaintLayer(auto, layer, parents, skin);
    expect(jointWeight(skin, 0, 1)).toBeCloseTo(0.8);
    expect(jointWeight(skin, 0, 0)).toBeCloseTo(0.2);
    expect(sumOf(skin, 0)).toBeCloseTo(1);
  });

  it("brings in a joint the vertex did not follow, dropping the weakest", () => {
    const auto = skinOf([[0, 0.9, 1, 0.1]]);
    const layer: PaintLayer = new Map([[2, new Map([[0, 0.5]])]]);
    const skin = cloneSkin(auto);
    applyPaintLayer(auto, layer, parents, skin);
    expect(jointWeight(skin, 0, 2)).toBeCloseTo(0.5 / (0.5 + 0.45));
    expect(jointWeight(skin, 0, 1)).toBe(0);
    expect(sumOf(skin, 0)).toBeCloseTo(1);
  });

  it("gives what a lone joint loses to its parent", () => {
    const auto = skinOf([[2, 1, 0, 0]]);
    const layer: PaintLayer = new Map([[2, new Map([[0, -0.75]])]]);
    const skin = cloneSkin(auto);
    applyPaintLayer(auto, layer, parents, skin);
    expect(jointWeight(skin, 0, 2)).toBeCloseTo(0.25);
    expect(jointWeight(skin, 0, 1)).toBeCloseTo(0.75);
  });

  it("stores and reads back, and drops paint made on another vertex count", () => {
    const layer: PaintLayer = new Map([[3, new Map([[1, 0.25], [4, -0.5]])]]);
    const stored = storePaintLayers([layer, new Map()], [10, 5]);
    expect(stored).toEqual([{ vertices: 10, joints: { 3: [1, 0.25, 4, -0.5] } }]);
    const back = readPaintLayer(JSON.parse(JSON.stringify(stored)), 0, 10);
    expect(back.get(3)?.get(4)).toBeCloseTo(-0.5);
    expect(readPaintLayer(stored, 0, 11).size).toBe(0);
    expect(readPaintLayer(stored, 1, 5).size).toBe(0);
  });

  it("paints under the brush only, more at the centre, and erases back to the automatic weights", () => {
    // Three vertices on a line, all on joint 0.
    const positions = new Float32Array([0, 0, 0, 0.5, 0, 0, 2, 0, 0]);
    const auto = skinOf([[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 1, 0]]);
    const skin = cloneSkin(auto);
    const layer: PaintLayer = new Map();
    const dab = { joint: 1, tool: "Add" as const, center: { x: 0, y: 0, z: 0 }, radius: 1, strength: 0.5 };
    const touched = paintDab(layer, auto, skin, parents, positions, null, dab);
    expect(touched).toEqual([0, 1]);
    expect(jointWeight(skin, 0, 1)).toBeCloseTo(0.5);
    expect(jointWeight(skin, 1, 1)).toBeGreaterThan(0);
    expect(jointWeight(skin, 1, 1)).toBeLessThan(0.5);
    expect(jointWeight(skin, 2, 1)).toBe(0);
    for (let i = 0; i < 40; i++) paintDab(layer, auto, skin, parents, positions, null, { ...dab, tool: "Subtract", strength: 1 });
    expect(jointWeight(skin, 0, 1)).toBeCloseTo(0, 3);
    expect(jointWeight(skin, 0, 0)).toBeCloseTo(1, 3);
  });

  it("smooths towards the neighbours, across a welded seam", () => {
    // A strip of two triangles, vertex 3 a split copy of vertex 1.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0]);
    const index = [0, 1, 2, 3, 4, 2];
    const auto = skinOf([[0, 1, 1, 0], [1, 1, 0, 0], [0, 1, 1, 0], [1, 1, 0, 0], [0, 1, 1, 0]]);
    const skin = cloneSkin(auto);
    const neighbours = paintNeighbours(positions, index);
    expect(neighbours.weldOf[3]).toBe(neighbours.weldOf[1]);
    paintDab(new Map(), auto, skin, parents, positions, neighbours, { joint: 1, tool: "Smooth", center: { x: 1, y: 0, z: 0 }, radius: 0.01, strength: 1 });
    // Its neighbours (0, 2, 4) are all joint 0: smoothed fully at the centre.
    expect(jointWeight(skin, 1, 1)).toBeCloseTo(0);
    expect(jointWeight(skin, 3, 1)).toBeCloseTo(0);
  });
});
