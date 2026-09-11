import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { EDIT_MESH_NODE } from "./nodes/editMesh";
import { OBJECT_BOX_NODE } from "./nodes/object";
import { TERRAIN_NODE } from "./nodes/terrain";
import { ENVIRONMENT_NODE } from "./nodes/environment";
import { EvalContext } from "./types";
import { createQuadBox, quadMeshToBufferGeometry } from "./quadMesh";

function makeDummyTexture(name = "test"): THREE.Texture {
  const tex = new THREE.Texture({} as any);
  tex.name = name;
  tex.image = { width: 16, height: 16 } as any;
  return tex;
}

describe("Disconnection Reactivity", () => {
  describe("Edit Mesh node", () => {
    it("immediately removes texture when texture input is disconnected", () => {
      const ctx: EvalContext = { nodeId: "edit-mesh-disconnect-tex" } as EvalContext;
      const tex = makeDummyTexture("diffuse");

      // 1. Connect texture
      const connectedRes = EDIT_MESH_NODE.evaluate(
        { texture: tex },
        { ...EDIT_MESH_NODE.defaultParams },
        ctx,
      );
      const mesh1 = connectedRes.geometry as THREE.Mesh;
      const mat1 = mesh1.material as THREE.MeshStandardMaterial;
      expect(mat1.map).toBe(tex);

      // 2. Disconnect texture
      const disconnectedRes = EDIT_MESH_NODE.evaluate(
        {},
        { ...EDIT_MESH_NODE.defaultParams },
        ctx,
      );
      const mesh2 = disconnectedRes.geometry as THREE.Mesh;
      const mat2 = mesh2.material as THREE.MeshStandardMaterial;
      expect(mat2.map).toBeNull();
      expect(mat2.color.getHex()).toBe(0xcccccc);
    });

    it("immediately reconnects texture after disconnection", () => {
      const ctx: EvalContext = { nodeId: "edit-mesh-reconnect-tex" } as EvalContext;
      const tex = makeDummyTexture("diffuse-reconnect");

      // Connect -> Disconnect -> Reconnect
      EDIT_MESH_NODE.evaluate({ texture: tex }, { ...EDIT_MESH_NODE.defaultParams }, ctx);
      const mid = EDIT_MESH_NODE.evaluate({}, { ...EDIT_MESH_NODE.defaultParams }, ctx);
      expect((mid.geometry as THREE.Mesh).material).toHaveProperty("map", null);

      const reconnected = EDIT_MESH_NODE.evaluate(
        { texture: tex },
        { ...EDIT_MESH_NODE.defaultParams },
        ctx,
      );
      const mat = (reconnected.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(mat.map).toBe(tex);
    });

    it("immediately removes normal and roughness maps when disconnected", () => {
      const ctx: EvalContext = { nodeId: "edit-mesh-disconnect-maps" } as EvalContext;
      const normalTex = makeDummyTexture("normal");
      const roughTex = makeDummyTexture("rough");

      // 1. Connect normal and roughness
      const conn = EDIT_MESH_NODE.evaluate(
        { normal: normalTex, roughnessMap: roughTex },
        { ...EDIT_MESH_NODE.defaultParams },
        ctx,
      );
      const matConn = (conn.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(matConn.normalMap).toBe(normalTex);
      expect(matConn.roughnessMap).toBe(roughTex);

      // 2. Disconnect both
      const disconn = EDIT_MESH_NODE.evaluate({}, { ...EDIT_MESH_NODE.defaultParams }, ctx);
      const matDisconn = (disconn.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(matDisconn.normalMap).toBeNull();
      expect(matDisconn.roughnessMap).toBeNull();
    });

    it("immediately reverts to default clay when Material input is disconnected", () => {
      const ctx: EvalContext = { nodeId: "edit-mesh-disconnect-mat" } as EvalContext;
      const customMat = {
        color: new THREE.Color(0xff0000),
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 1,
        shadeless: false,
        roughness: 0.12,
        metalness: 0.85,
        wireframe: false,
        opacity: 1,
        transmission: 0,
        thickness: 0,
      };

      // 1. Connect custom material
      const conn = EDIT_MESH_NODE.evaluate(
        { material: customMat },
        { ...EDIT_MESH_NODE.defaultParams },
        ctx,
      );
      const matConn = (conn.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(matConn.color.getHex()).toBe(0xff0000);
      expect(matConn.roughness).toBeCloseTo(0.12);

      // 2. Disconnect material
      const disconn = EDIT_MESH_NODE.evaluate({}, { ...EDIT_MESH_NODE.defaultParams }, ctx);
      const matDisconn = (disconn.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(matDisconn.color.getHex()).toBe(0xcccccc);
      expect(matDisconn.roughness).toBeCloseTo(0.5);
    });

    it("immediately resets transform and reverts material when upstream geometry is disconnected", () => {
      const ctx: EvalContext = { nodeId: "edit-mesh-disconnect-geom" } as EvalContext;

      // Upstream mesh with custom transform and material
      const inputGeom = quadMeshToBufferGeometry(createQuadBox(2, 2, 2));
      const upstreamMat = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
      const inputMesh = new THREE.Mesh(inputGeom, upstreamMat);
      inputMesh.position.set(10, 20, 30);
      inputMesh.updateMatrixWorld(true);

      // 1. Connected
      const conn = EDIT_MESH_NODE.evaluate(
        { geometry: inputMesh },
        { ...EDIT_MESH_NODE.defaultParams, meshData: null },
        ctx,
      );
      const meshConn = conn.geometry as THREE.Mesh;
      expect(meshConn.matrix.elements[12]).toBe(10);
      expect(meshConn.matrix.elements[13]).toBe(20);
      expect(meshConn.matrix.elements[14]).toBe(30);
      expect((meshConn.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x00ff00);

      // 2. Disconnected
      const disconn = EDIT_MESH_NODE.evaluate(
        {},
        { ...EDIT_MESH_NODE.defaultParams, meshData: null },
        ctx,
      );
      const meshDisconn = disconn.geometry as THREE.Mesh;
      // Matrix and positions are cleanly reset to identity
      expect(meshDisconn.matrix.elements[12]).toBe(0);
      expect(meshDisconn.matrix.elements[13]).toBe(0);
      expect(meshDisconn.matrix.elements[14]).toBe(0);
      // The node drives its own matrix (its native location/rotation/scale/
      // pivot pose), so matrixAutoUpdate stays off — connected or not.
      expect(meshDisconn.matrixAutoUpdate).toBe(false);
      // Material reverts from upstream to default clay
      expect((meshDisconn.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xcccccc);
    });
  });

  describe("Object primitive node", () => {
    it("immediately clears texture map on primitive Box when texture input is disconnected", () => {
      const ctx: EvalContext = { nodeId: "box-disconnect-tex" } as EvalContext;
      const tex = makeDummyTexture("box-diffuse");

      const conn = OBJECT_BOX_NODE.evaluate({ texture: tex }, { ...OBJECT_BOX_NODE.defaultParams }, ctx);
      const matConn = (conn.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(matConn.map).toBe(tex);

      const disconn = OBJECT_BOX_NODE.evaluate({}, { ...OBJECT_BOX_NODE.defaultParams }, ctx);
      const matDisconn = (disconn.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(matDisconn.map).toBeNull();
    });
  });

  describe("Terrain node", () => {
    it("immediately clears texture map when texture is disconnected", () => {
      const ctx: EvalContext = { nodeId: "terrain-disconnect-tex" } as EvalContext;
      const tex = makeDummyTexture("terrain-diffuse");

      const conn = TERRAIN_NODE.evaluate({ texture: tex }, { ...TERRAIN_NODE.defaultParams }, ctx);
      const matConn = (conn.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(matConn.map).toBe(tex);

      const disconn = TERRAIN_NODE.evaluate({}, { ...TERRAIN_NODE.defaultParams }, ctx);
      const matDisconn = (disconn.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(matDisconn.map).toBeNull();
    });
  });

  describe("Environment node", () => {
    it("immediately clears texture when texture input is disconnected", () => {
      const ctx: EvalContext = { nodeId: "env-disconnect-tex" } as EvalContext;
      const envTex = makeDummyTexture("env-hdri");

      const conn = ENVIRONMENT_NODE.evaluate({ texture: envTex }, { ...ENVIRONMENT_NODE.defaultParams }, ctx);
      expect((conn.environment as any).texture).toBe(envTex);

      const disconn = ENVIRONMENT_NODE.evaluate({}, { ...ENVIRONMENT_NODE.defaultParams }, ctx);
      expect((disconn.environment as any).texture).toBeNull();
    });
  });
});
