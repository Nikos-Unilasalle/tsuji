import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createQuadBox, createQuadPlane, gizmoWorldDelta, proportionalWeight, QuadMesh, transformVertexGroups } from "../quadMesh";
import { emptySelection, selectionIslands, selectionOrientation } from "./selection";

describe("gizmoWorldDelta", () => {
  it("scales along the gizmo's own axes when it's oriented", () => {
    // Gizmo turned 90° about Z: its X axis is world Y. Scaling its X by 2
    // must stretch along world Y.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const origin = new THREE.Vector3();
    const d = gizmoWorldDelta(origin, q, new THREE.Vector3(1, 1, 1), origin, q, new THREE.Vector3(2, 1, 1));
    const p = new THREE.Vector3(0, 1, 0).applyMatrix4(d);
    expect(p.y).toBeCloseTo(2, 9);
    const r = new THREE.Vector3(1, 0, 0).applyMatrix4(d);
    expect(r.x).toBeCloseTo(1, 9);
  });

  it("reduces to rotation about the pivot for an identity start", () => {
    const start = new THREE.Vector3(1, 0, 0);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const d = gizmoWorldDelta(start, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1), start, q, new THREE.Vector3(1, 1, 1));
    const p = new THREE.Vector3(2, 0, 0).applyMatrix4(d);
    expect(p.x).toBeCloseTo(0, 9);
  });
});

describe("proportional editing", () => {
  it("offers Blender's falloff curves", () => {
    expect(proportionalWeight(0, "smooth")).toBe(1);
    expect(proportionalWeight(1, "smooth")).toBe(0);
    expect(proportionalWeight(0.5, "linear")).toBeCloseTo(0.5, 9);
    expect(proportionalWeight(0.5, "sharp")).toBeCloseTo(0.25, 9);
    expect(proportionalWeight(0.9, "constant")).toBe(1);
    expect(proportionalWeight(0.5, "sphere")).toBeCloseTo(Math.sqrt(0.75), 9);
  });

  it("in connected mode, leaves separate pieces alone", () => {
    // Two unit quads side by side with a small gap: close in space, not connected.
    const a = createQuadPlane(1, 1, 1, 1);
    const two: QuadMesh = {
      positions: [...a.positions, ...a.positions.map(([x, y, z]) => [x + 1.2, y, z] as [number, number, number])],
      faces: [...a.faces, ...a.faces.map((f) => f.map((v) => v + 4))],
    };
    const up = new THREE.Matrix4().makeTranslation(0, 0, 1);
    const straight = transformVertexGroups(two, [{ vertices: [1], matrix: up }], { enabled: true, diameter: 3 });
    const connected = transformVertexGroups(two, [{ vertices: [1], matrix: up }], { enabled: true, diameter: 3, connected: true });
    // Vertex 4 (the other quad's corner, 0.2 away) follows in straight mode only.
    expect(straight.positions[4][2]).toBeGreaterThan(0);
    expect(connected.positions[4][2]).toBe(0);
    // Its own neighbour still follows in connected mode.
    expect(connected.positions[0][2]).toBeGreaterThan(0);
  });

  it("applies one matrix per group (individual origins)", () => {
    const plane = createQuadPlane(3, 1, 3, 1); // 4×2 vertices
    const scaleAbout = (cx: number) =>
      new THREE.Matrix4().makeTranslation(cx, 0, 0).multiply(new THREE.Matrix4().makeScale(0.5, 0.5, 1)).multiply(new THREE.Matrix4().makeTranslation(-cx, 0, 0));
    const out = transformVertexGroups(plane, [
      { vertices: [0, 1, 4, 5], matrix: scaleAbout(-1) },
      { vertices: [2, 3, 6, 7], matrix: scaleAbout(1) },
    ]);
    expect(out.positions[0][0]).toBeCloseTo(-1.25, 9);
    expect(out.positions[3][0]).toBeCloseTo(1.25, 9);
  });
});

describe("selection frame and islands", () => {
  it("orients Z along the selected face's normal", () => {
    const box = createQuadBox();
    const q = selectionOrientation(box, "faces", { ...emptySelection(), faces: [2] }); // top
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    expect(z.y).toBeCloseTo(1, 9);
  });

  it("splits the selection into islands", () => {
    const box = createQuadBox();
    expect(selectionIslands(box, "faces", { ...emptySelection(), faces: [2, 3] })).toHaveLength(2); // top, bottom
    expect(selectionIslands(box, "faces", { ...emptySelection(), faces: [0, 2] })).toHaveLength(1); // share an edge
    expect(selectionIslands(box, "points", { ...emptySelection(), points: [0, 6] })).toHaveLength(2);
  });
});
