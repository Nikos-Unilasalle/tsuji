import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DISTANCE_GRADIENT_LIST_NODE, GET_LIST_ITEM_NODE, GRADIENT_LIST_NODE, LIST_MAP_RANGE_NODE, RANDOM_SAMPLE_LIST_NODE } from "./list";
import { CURVE_FROM_POINTS_NODE } from "./curve";
import { EvalContext } from "../types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "list-item-test" };

describe("GET_LIST_ITEM_NODE with a list of lists (Capture Trails' Point Lists shape)", () => {
  const listOfLists = [
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)],
    [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 3, 0)],
  ];

  it("extracts the sub-list at the given index, not a flattened value", () => {
    const res = GET_LIST_ITEM_NODE.evaluate({ list: listOfLists, index: 1 }, GET_LIST_ITEM_NODE.defaultParams, CTX);
    expect(Array.isArray(res.item)).toBe(true);
    expect((res.item as THREE.Vector3[]).length).toBe(3);
    expect((res.item as THREE.Vector3[])[2]).toEqual(new THREE.Vector3(0, 3, 0));
  });

  it("feeds straight into Curve from Points as one curve", () => {
    const sub = GET_LIST_ITEM_NODE.evaluate({ list: listOfLists, index: 0 }, GET_LIST_ITEM_NODE.defaultParams, CTX).item;
    const curveRes = CURVE_FROM_POINTS_NODE.evaluate({ points: sub }, CURVE_FROM_POINTS_NODE.defaultParams, CTX);
    expect(curveRes.curve).toBeDefined();
  });

  it("wraps out-of-range indices rather than throwing (existing Get List Item behavior)", () => {
    const res = GET_LIST_ITEM_NODE.evaluate({ list: listOfLists, index: 5 }, GET_LIST_ITEM_NODE.defaultParams, CTX);
    expect(res.item).toBe(listOfLists[5 % listOfLists.length]);
  });
});

describe("RANDOM_SAMPLE_LIST_NODE", () => {
  const sourceList = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

  it("samples count distinct items without replacement", () => {
    const res = RANDOM_SAMPLE_LIST_NODE.evaluate(
      { list: sourceList, count: 4, seed: 123 },
      { ...RANDOM_SAMPLE_LIST_NODE.defaultParams, withReplacement: false },
      CTX,
    );

    const sampledList = res.list as string[];
    const indices = res.indices as number[];

    expect(sampledList.length).toBe(4);
    expect(indices.length).toBe(4);

    // Ensure all sampled elements are distinct
    const uniqueElements = new Set(sampledList);
    expect(uniqueElements.size).toBe(4);

    // Verify indices match items
    for (let i = 0; i < 4; i++) {
      expect(sourceList[indices[i]]).toBe(sampledList[i]);
    }
  });

  it("samples items with replacement allowing duplicates if requested", () => {
    const res = RANDOM_SAMPLE_LIST_NODE.evaluate(
      { list: sourceList, count: 15, seed: 42 },
      { ...RANDOM_SAMPLE_LIST_NODE.defaultParams, withReplacement: true },
      CTX,
    );

    const sampledList = res.list as string[];
    const indices = res.indices as number[];

    expect(sampledList.length).toBe(15);
    expect(indices.length).toBe(15);
  });

  it("handles empty input list gracefully", () => {
    const res = RANDOM_SAMPLE_LIST_NODE.evaluate({ list: [], count: 5 }, RANDOM_SAMPLE_LIST_NODE.defaultParams, CTX);
    expect((res.list as unknown[]).length).toBe(0);
    expect((res.indices as unknown[]).length).toBe(0);
  });
});

describe("GRADIENT_LIST_NODE", () => {
  it("samples the ramp using 'values' input", () => {
    const res = GRADIENT_LIST_NODE.evaluate(
      { values: [0, 3, 10] },
      { ...GRADIENT_LIST_NODE.defaultParams, radius: 5 },
      CTX,
    );
    const colors = res.list as THREE.Color[];
    expect(colors.length).toBe(3);
    expect(colors[0].getHex()).toBe(new THREE.Color(0x38bdf8).getHex());
    expect(colors[2].getHex()).toBe(new THREE.Color(0xec4899).getHex());
    expect(colors[1].getHex()).not.toBe(colors[0].getHex());
    expect(colors[1].getHex()).not.toBe(colors[2].getHex());
  });

  it("supports legacy 'distances' input seamlessly", () => {
    const res = GRADIENT_LIST_NODE.evaluate(
      { distances: [0, 3, 10] },
      { ...GRADIENT_LIST_NODE.defaultParams, radius: 5 },
      CTX,
    );
    const colors = res.list as THREE.Color[];
    expect(colors.length).toBe(3);
    expect(colors[0].getHex()).toBe(new THREE.Color(0x38bdf8).getHex());
  });

  it("exposes dynamicInputs including legacy distances when connected", () => {
    expect(GRADIENT_LIST_NODE.dynamicInputs!([])).toEqual([
      { id: "values", label: "Values", type: "list" },
      { id: "radius", label: "Radius / Max", type: "value" },
    ]);
    expect(
      GRADIENT_LIST_NODE.dynamicInputs!([
        { id: "c1", fromNode: "a", fromSocket: "out", toNode: "b", toSocket: "distances" },
      ]),
    ).toContainEqual({ id: "distances", label: "Distances (Legacy)", type: "list" });
  });

  it("returns an empty list when given no values", () => {
    const res = GRADIENT_LIST_NODE.evaluate({ values: [] }, GRADIENT_LIST_NODE.defaultParams, CTX);
    expect((res.list as unknown[]).length).toBe(0);
  });
});

describe("DISTANCE_GRADIENT_LIST_NODE alias", () => {
  it("points to list/distance-gradient with identical behavior", () => {
    expect(DISTANCE_GRADIENT_LIST_NODE.type).toBe("list/distance-gradient");
    const res = DISTANCE_GRADIENT_LIST_NODE.evaluate(
      { distances: [0, 3, 10] },
      { ...DISTANCE_GRADIENT_LIST_NODE.defaultParams, radius: 5 },
      CTX,
    );
    const colors = res.list as THREE.Color[];
    expect(colors.length).toBe(3);
    expect(colors[0].getHex()).toBe(new THREE.Color(0x38bdf8).getHex());
  });
});

describe("LIST_MAP_RANGE_NODE", () => {
  it("remaps a fixed input span to a fixed output span, clamped", () => {
    const res = LIST_MAP_RANGE_NODE.evaluate(
      { list: [-5, 0, 2.5, 5, 50] },
      { ...LIST_MAP_RANGE_NODE.defaultParams, inMin: 0, inMax: 5, outMin: 1, outMax: 3 },
      CTX,
    );
    expect(res.list).toEqual([1, 1, 2, 3, 3]);
  });

  it("does not refit to the data — same fixed span regardless of which items are present", () => {
    const params = { ...LIST_MAP_RANGE_NODE.defaultParams, inMin: 0, inMax: 10, outMin: 0, outMax: 1 };
    const a = LIST_MAP_RANGE_NODE.evaluate({ list: [2] }, params, CTX).list as number[];
    const b = LIST_MAP_RANGE_NODE.evaluate({ list: [2, 9] }, params, CTX).list as number[];
    expect(a[0]).toBeCloseTo(0.2);
    expect(b[0]).toBeCloseTo(0.2);
  });

  it("power reshapes the falloff without changing the endpoints", () => {
    const res = LIST_MAP_RANGE_NODE.evaluate(
      { list: [0, 5, 10] },
      { ...LIST_MAP_RANGE_NODE.defaultParams, inMin: 0, inMax: 10, outMin: 0, outMax: 1, power: 2 },
      CTX,
    );
    const [lo, mid, hi] = res.list as number[];
    expect(lo).toBeCloseTo(0);
    expect(hi).toBeCloseTo(1);
    expect(mid).toBeCloseTo(0.25); // 0.5^2
  });

  it("returns an empty list when given no input", () => {
    const res = LIST_MAP_RANGE_NODE.evaluate({ list: [] }, LIST_MAP_RANGE_NODE.defaultParams, CTX);
    expect((res.list as unknown[]).length).toBe(0);
  });
});

