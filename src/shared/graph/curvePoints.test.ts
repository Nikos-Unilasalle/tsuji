import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { insertCurvePointAfter, offsetCurvePoints, offsetsForMovedPoints, removeCurvePoint, toPointVectors } from "./curvePoints";
import { CURVE_FROM_POINTS_NODE } from "./nodes/curve";

const LINE = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(4, 0, 0)];

describe("toPointVectors", () => {
  test("accepts the plain objects a saved file or the IPC bridge hands back", () => {
    const points = toPointVectors([{ x: 1, y: 2, z: 3 }, new THREE.Vector3(4, 5, 6)]);

    expect(points).toHaveLength(2);
    expect(points[0]).toBeInstanceOf(THREE.Vector3);
    expect(points[0].toArray()).toEqual([1, 2, 3]);
  });

  test("copies rather than aliasing — the param must not be mutable through the result", () => {
    const source = new THREE.Vector3(1, 1, 1);

    toPointVectors([source])[0].set(9, 9, 9);

    expect(source.toArray()).toEqual([1, 1, 1]);
  });

  test("a missing or malformed list is empty, not a crash", () => {
    expect(toPointVectors(undefined)).toEqual([]);
    expect(toPointVectors("nonsense")).toEqual([]);
  });
});

describe("insertCurvePointAfter", () => {
  test("inserts halfway to the next point", () => {
    const result = insertCurvePointAfter(LINE, 0)!;

    expect(result).toHaveLength(4);
    expect(result[1].toArray()).toEqual([1, 0, 0]);
    expect(result[2].toArray()).toEqual([2, 0, 0]);
  });

  test("past the last point it extends the path instead of stacking on the tip", () => {
    const result = insertCurvePointAfter(LINE, 2)!;

    expect(result).toHaveLength(4);
    expect(result[3].toArray()).toEqual([6, 0, 0]);
  });

  test("two identical points still produce a distinct new one", () => {
    const doubled = [new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1)];

    const result = insertCurvePointAfter(doubled, 1)!;

    expect(result[2].distanceTo(result[1])).toBeGreaterThan(0);
  });

  test("leaves the original list untouched", () => {
    insertCurvePointAfter(LINE, 0);

    expect(LINE).toHaveLength(3);
  });

  test("an index outside the list is rejected", () => {
    expect(insertCurvePointAfter(LINE, 7)).toBeNull();
    expect(insertCurvePointAfter(LINE, -1)).toBeNull();
  });
});

describe("removeCurvePoint", () => {
  test("removes the point at the index", () => {
    const result = removeCurvePoint(LINE, 1)!;

    expect(result.map((p) => p.x)).toEqual([0, 4]);
  });

  test("refuses to drop below two points — there would be no curve left", () => {
    const pair = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];

    expect(removeCurvePoint(pair, 0)).toBeNull();
  });

  test("an index outside the list is rejected", () => {
    expect(removeCurvePoint(LINE, 3)).toBeNull();
  });
});

describe("wired points offsets", () => {
  test("a dragged point keeps its offset when the incoming points change", () => {
    const offsets = offsetsForMovedPoints(LINE, [], new Map([[1, new THREE.Vector3(2, 1, 0)]]));
    expect(offsets.map((o) => o.toArray())).toEqual([[0, 0, 0], [0, 1, 0], [0, 0, 0]]);

    const scaled = LINE.map((p) => p.clone().multiplyScalar(2));
    expect(offsetCurvePoints(scaled, offsets)[1].toArray()).toEqual([4, 1, 0]);
  });

  test("missing offsets leave the points where they came in", () => {
    expect(offsetCurvePoints(LINE, [{ x: 0, y: 0, z: 1 }]).map((p) => p.toArray())).toEqual([[0, 0, 1], [2, 0, 0], [4, 0, 0]]);
  });

  test("Curve from Points applies them to its wired Points", () => {
    const out = CURVE_FROM_POINTS_NODE.evaluate!(
      { points: LINE },
      { ...CURVE_FROM_POINTS_NODE.defaultParams, type: "linear", pointOffsets: [new THREE.Vector3(), new THREE.Vector3(0, 1, 0)] },
      { nodeId: "wired-offsets", time: 0, frame: 0 } as never,
    ) as { curve: THREE.Curve<THREE.Vector3> };
    const mid = out.curve.getPoint(0.5);
    expect(mid.x).toBeCloseTo(2);
    expect(mid.y).toBeCloseTo(1);
    expect(mid.z).toBeCloseTo(0);
  });
});
