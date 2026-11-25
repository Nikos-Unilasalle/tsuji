import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createQuadPlane } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { readAttribute, setGroup } from "../mesh/polyAttributes";
import { GEOMETRY_TWIST_BEND_TAPER_NODE, GEOMETRY_WAVE_RIPPLE_NODE } from "./geometryDeform";

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

  it("Twist re-cuts the mesh into triangles, and face groups still come through", () => {
    const plane = createQuadPlane(2, 6, 2, 6);
    const top = plane.faces.map((f) => (f.every((v) => plane.positions[v][1] > 0) ? 1 : 0));
    const mesh = new THREE.Mesh(polyMeshToGeometry(setGroup(plane, "face", "top", top)), new THREE.MeshStandardMaterial());
    const params = { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, twist: 90, axis: "y" };
    const out = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate({ geometry: mesh }, params, { time: 0, step: 0, nodeId: "twist-g" }).geometry as THREE.Object3D;
    const read = readPolyMesh(out)!.mesh;
    expect(read.faces.length).toBeGreaterThan(plane.faces.length);
    const group = readAttribute(read, "face", "top");
    expect(group).toBeTruthy();
    expect(Array.from(group!.values).some((x) => x > 0)).toBe(true);
  });
});
