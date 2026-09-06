import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { HEX_GRID_NODE } from "./hexGrid";
import { SET_INSTANCE_TRANSFORM_NODE } from "./instance";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "hex-test-1" };

function getChildPosition(wrapper: THREE.Object3D): THREE.Vector3 {
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  wrapper.matrix.decompose(pos, rot, scale);
  return pos;
}

describe("HEX_GRID_NODE", () => {
  it("generates correct number of positions and coordinate lists", () => {
    const res = HEX_GRID_NODE.evaluate({}, { cols: 4, rows: 3 }, CTX);
    expect(res.count).toBe(12);
    expect((res.positions as THREE.Vector3[]).length).toBe(12);
    expect((res.xValues as number[]).length).toBe(12);
    expect((res.yValues as number[]).length).toBe(12);
    expect((res.zValues as number[]).length).toBe(12);
  });

  it("staggers rows in pointy-topped orientation", () => {
    const radius = 2.0;
    const dx = Math.sqrt(3) * radius; // ~3.464
    const dz = 1.5 * radius; // 3.0

    const res = HEX_GRID_NODE.evaluate(
      {},
      { cols: 2, rows: 2, radius, spacing: 1.0, orientation: "pointy", center: false, plane: "XZ" },
      CTX,
    );

    const positions = res.positions as THREE.Vector3[];
    // Row 0: c=0, c=1 (no offset)
    expect(positions[0].x).toBeCloseTo(0);
    expect(positions[0].z).toBeCloseTo(0);
    expect(positions[1].x).toBeCloseTo(dx);
    expect(positions[1].z).toBeCloseTo(0);

    // Row 1: c=0, c=1 (offset by 0.5 * dx)
    expect(positions[2].x).toBeCloseTo(0.5 * dx);
    expect(positions[2].z).toBeCloseTo(dz);
    expect(positions[3].x).toBeCloseTo(1.5 * dx);
    expect(positions[3].z).toBeCloseTo(dz);
  });

  it("staggers columns in flat-topped orientation", () => {
    const radius = 2.0;
    const dx = 1.5 * radius; // 3.0
    const dz = Math.sqrt(3) * radius; // ~3.464

    const res = HEX_GRID_NODE.evaluate(
      {},
      { cols: 2, rows: 2, radius, spacing: 1.0, orientation: "flat", center: false, plane: "XZ" },
      CTX,
    );

    const positions = res.positions as THREE.Vector3[];
    // r=0, c=0 (col 0: no offset)
    expect(positions[0].x).toBeCloseTo(0);
    expect(positions[0].z).toBeCloseTo(0);
    // r=0, c=1 (col 1: offset by 0.5 * dz)
    expect(positions[1].x).toBeCloseTo(dx);
    expect(positions[1].z).toBeCloseTo(0.5 * dz);
    // r=1, c=0
    expect(positions[2].x).toBeCloseTo(0);
    expect(positions[2].z).toBeCloseTo(dz);
    // r=1, c=1
    expect(positions[3].x).toBeCloseTo(dx);
    expect(positions[3].z).toBeCloseTo(1.5 * dz);
  });

  it("centers the grid around (0, 0, 0) when center is true", () => {
    const res = HEX_GRID_NODE.evaluate(
      {},
      { cols: 4, rows: 4, radius: 1.0, center: true, plane: "XZ" },
      CTX,
    );

    const positions = res.positions as THREE.Vector3[];
    const xs = positions.map((p) => p.x);
    const zs = positions.map((p) => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);

    expect(minX + maxX).toBeCloseTo(0, 4);
    expect(minZ + maxZ).toBeCloseTo(0, 4);
  });

  it("supports XY and YZ planes", () => {
    const resXY = HEX_GRID_NODE.evaluate({}, { cols: 2, rows: 2, plane: "XY" }, CTX);
    for (const p of resXY.positions as THREE.Vector3[]) {
      expect(p.z).toBe(0);
    }

    const resYZ = HEX_GRID_NODE.evaluate({}, { cols: 2, rows: 2, plane: "YZ" }, CTX);
    for (const p of resYZ.positions as THREE.Vector3[]) {
      expect(p.x).toBe(0);
    }
  });

  it("instantiates template geometry at each hex center", () => {
    const hexMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6));
    const res = HEX_GRID_NODE.evaluate(
      { geometry: hexMesh },
      { cols: 3, rows: 2 },
      CTX,
    );

    const group = res.geometry as THREE.Group;
    expect(group.children.length).toBe(6);
    for (const wrapper of group.children) {
      expect(wrapper.children[0]).toBeInstanceOf(THREE.Mesh);
      expect(wrapper.children[0]).not.toBe(hexMesh); // Cloned
    }
  });

  it("supports GPU instancing via InstancedMesh", () => {
    const hexMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6));
    const res = HEX_GRID_NODE.evaluate(
      { geometry: hexMesh },
      { cols: 5, rows: 5, gpuInstancing: true },
      { nodeId: "hex-gpu-1" } as EvalContext,
    );

    const group = res.geometry as THREE.Group;
    expect(group.children.length).toBe(1);
    expect(group.children[0]).toBeInstanceOf(THREE.InstancedMesh);
    const instMesh = group.children[0] as THREE.InstancedMesh;
    expect(instMesh.count).toBe(25);
  });

  it("renders a Point Cloud preview when no geometry is wired", () => {
    const res = HEX_GRID_NODE.evaluate({}, { cols: 3, rows: 3 }, { nodeId: "hex-preview-1" } as EvalContext);
    const group = res.geometry as THREE.Group;
    expect(group.children.length).toBe(1);
    expect(group.children[0]).toBeInstanceOf(THREE.Points);
  });

  it("composes seamlessly with Set Instance Transform to modulate heights", () => {
    const hexMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6));
    const gridRes = HEX_GRID_NODE.evaluate(
      { geometry: hexMesh },
      { cols: 2, rows: 2, center: false, plane: "XZ" },
      { nodeId: "hex-mod-1" } as EvalContext,
    );

    // Apply heights via Set Instance Transform using posY list
    const heights = [1.5, 3.0, 4.5, 6.0];
    const transRes = SET_INSTANCE_TRANSFORM_NODE.evaluate(
      { geometry: gridRes.geometry, posY: heights },
      { mode: "relative" },
      { nodeId: "inst-trans-1" } as EvalContext,
    );

    const transformedGroup = transRes.geometry as THREE.Group;
    expect(transformedGroup.children.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      const p = getChildPosition(transformedGroup.children[i]);
      expect(p.y).toBeCloseTo(heights[i]);
    }
  });

  it("respects source geometry pivot in standard scene-graph instancing", () => {
    const hexMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2, 6));
    // Set pivot at the base of the cylinder (y = -1)
    hexMesh.userData.pivot = new THREE.Vector3(0, -1, 0);

    const gridRes = HEX_GRID_NODE.evaluate(
      { geometry: hexMesh },
      { cols: 2, rows: 2, plane: "XZ" },
      { nodeId: "hex-piv-1" } as EvalContext,
    );

    const group = gridRes.geometry as THREE.Group;
    expect(group.children.length).toBe(4);

    for (const wrapper of group.children) {
      const child = wrapper.children[0] as THREE.Mesh;
      // Child mesh matrix should have translation (0, 1, 0) compensating for the pivot (0, -1, 0)
      const childPos = new THREE.Vector3();
      child.matrix.decompose(childPos, new THREE.Quaternion(), new THREE.Vector3());
      expect(childPos.y).toBeCloseTo(1);

      // Total transform of local point (0, -1, 0) should land exactly on wrapper's position (ground y = 0)
      const worldMat = new THREE.Matrix4().multiplyMatrices(wrapper.matrix, child.matrix);
      const pivotWorld = new THREE.Vector3(0, -1, 0).applyMatrix4(worldMat);
      expect(pivotWorld.y).toBeCloseTo(0);
    }
  });

  it("respects source geometry pivot in GPU instancing", () => {
    const hexMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2, 6));
    hexMesh.userData.pivot = new THREE.Vector3(0, -1, 0);

    const gridRes = HEX_GRID_NODE.evaluate(
      { geometry: hexMesh },
      { cols: 2, rows: 2, plane: "XZ", gpuInstancing: true },
      { nodeId: "hex-piv-gpu" } as EvalContext,
    );

    const group = gridRes.geometry as THREE.Group;
    const instMesh = group.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) {
      instMesh.getMatrixAt(i, m);
      // Under this matrix, local pivot point (0, -1, 0) must land at y = 0
      const pivotWorld = new THREE.Vector3(0, -1, 0).applyMatrix4(m);
      expect(pivotWorld.y).toBeCloseTo(0);
    }
  });
});
