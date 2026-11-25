import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createQuadPlane } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { setGroup } from "../mesh/polyAttributes";
import { GEOMETRY_WAVE_RIPPLE_NODE } from "./geometryDeform";

describe("deformer Group", () => {
  it("Wave only moves the group's points, and the output keeps the groups", () => {
    const plane = createQuadPlane(2, 2, 8, 8);
    const half = plane.positions.map((p) => (p[0] > 0 ? 1 : 0));
    const mesh = new THREE.Mesh(polyMeshToGeometry(setGroup(plane, "point", "right", half)), new THREE.MeshStandardMaterial());
    const params = { ...GEOMETRY_WAVE_RIPPLE_NODE.defaultParams, amplitude: 0.5, group: "right" };
    const out = GEOMETRY_WAVE_RIPPLE_NODE.evaluate({ geometry: mesh }, params, { time: 0.3, step: 0, nodeId: "wave-g" }).geometry as THREE.Object3D;
    const read = readPolyMesh(out)!.mesh;
    let movedLeft = 0;
    read.positions.forEach((p, i) => {
      const q = plane.positions[i];
      if (q[0] < 0 && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-6) movedLeft++;
    });
    expect(movedLeft).toBe(0);
    expect(read.attributes?.point?.right).toBeTruthy();
  });
});
