import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { EDIT_MESH_NODE } from "./editMesh";
import { EvalContext } from "../types";
import { createQuadBox, quadMeshToBufferGeometry } from "../quadMesh";

describe("EDIT_MESH_NODE", () => {
  it("defaults to a quad box when no geometry is wired", () => {
    const res = EDIT_MESH_NODE.evaluate(
      {},
      { ...EDIT_MESH_NODE.defaultParams },
      { nodeId: "test-edit-mesh" } as EvalContext,
    );

    expect(res.geometry).toBeInstanceOf(THREE.Mesh);
    const mesh = res.geometry as THREE.Mesh;
    // Auto-smooth box has 24 vertices (4 per face) with crisp sharp normals
    expect(mesh.geometry.attributes.position.count).toBe(24);
    expect(mesh.geometry.userData.quadMesh.positions.length).toBe(8);
    expect(mesh.geometry.userData.quadMesh.faces.length).toBe(6);
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xcccccc);
  });

  it("evaluates with existing meshData", () => {
    const customBox = createQuadBox(3, 3, 3);
    const res = EDIT_MESH_NODE.evaluate(
      {},
      { ...EDIT_MESH_NODE.defaultParams, meshData: customBox },
      { nodeId: "test-edit-mesh-2" } as EvalContext,
    );

    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.userData.quadMesh.positions[1][0]).toBeCloseTo(1.5, 4);
  });

  it("seeds from input geometry when meshData is null", () => {
    const inputGeom = quadMeshToBufferGeometry(createQuadBox(2, 2, 2));
    const inputMesh = new THREE.Mesh(inputGeom);

    const res = EDIT_MESH_NODE.evaluate(
      { geometry: inputMesh },
      { ...EDIT_MESH_NODE.defaultParams, meshData: null },
      { nodeId: "test-edit-mesh-3" } as EvalContext,
    );

    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.userData.quadMesh.faces.length).toBe(6);
  });

  it("applies texture inputs to the mesh material and produces valid UV attributes", () => {
    const dummyTexture = new THREE.Texture({} as any);
    dummyTexture.image = { width: 16, height: 16 } as any;
    const res = EDIT_MESH_NODE.evaluate(
      { texture: dummyTexture },
      { ...EDIT_MESH_NODE.defaultParams },
      { nodeId: "test-edit-mesh-tex" } as EvalContext,
    );

    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.map).toBe(dummyTexture);

    // Geometry should have valid UV attributes
    expect(mesh.geometry.attributes.uv).toBeDefined();
    expect(mesh.geometry.attributes.uv.count).toBe(mesh.geometry.attributes.position.count);
  });
});

