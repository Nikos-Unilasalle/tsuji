import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { EDIT_MESH_NODE } from "./editMesh";
import { EvalContext } from "../types";
import { cloneQuadMesh, createQuadBox, quadMeshToBufferGeometry } from "../quadMesh";

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

  it("exports EDIT_MESH_DELETE_FACES_ACTION and EDIT_MESH_SEPARATE_FACES_ACTION", async () => {
    const { EDIT_MESH_DELETE_FACES_ACTION, EDIT_MESH_SEPARATE_FACES_ACTION } = await import("./editMesh");
    expect(EDIT_MESH_DELETE_FACES_ACTION).toBe("edit-mesh/delete-faces");
    expect(EDIT_MESH_SEPARATE_FACES_ACTION).toBe("edit-mesh/separate-faces");
  });

  it("evaluates a mesh after face deletion and face separation", async () => {
    const { deleteFaces, extractFaces } = await import("../quadMesh");
    const box = createQuadBox(1, 1, 1);
    const selectedFaces = [0, 2];

    const remainingMesh = deleteFaces(box, selectedFaces);
    const separatedMesh = extractFaces(box, selectedFaces);

    const resRemaining = EDIT_MESH_NODE.evaluate(
      {},
      { ...EDIT_MESH_NODE.defaultParams, meshData: remainingMesh },
      { nodeId: "remaining-mesh-test" } as EvalContext,
    );
    const meshRemaining = resRemaining.geometry as THREE.Mesh;
    expect(meshRemaining.geometry.userData.quadMesh.faces.length).toBe(4);

    const resSeparated = EDIT_MESH_NODE.evaluate(
      {},
      { ...EDIT_MESH_NODE.defaultParams, meshData: separatedMesh },
      { nodeId: "separated-mesh-test" } as EvalContext,
    );
    const meshSeparated = resSeparated.geometry as THREE.Mesh;
    expect(meshSeparated.geometry.userData.quadMesh.faces.length).toBe(2);
  });

  describe("geometry cache", () => {
    const evaluate = (meshData: unknown, nodeId: string) =>
      EDIT_MESH_NODE.evaluate({}, { ...EDIT_MESH_NODE.defaultParams, meshData }, { nodeId } as EvalContext)
        .geometry as THREE.Mesh;

    it("reuses its geometry when nothing changed, and rebuilds when something did", () => {
      // Both halves matter. The cache used to store a clone and compare it with
      // ===, so it never hit: the geometry was rebuilt and re-uploaded every
      // frame. A signature that is too coarse would be the opposite bug — an
      // edit that never reaches the screen.
      const box = createQuadBox(1, 1, 1);
      const first = evaluate(box, "cache-node").geometry;
      const second = evaluate(box, "cache-node").geometry;
      expect(second).toBe(first);

      const moved = cloneQuadMesh(box);
      moved.positions[0] = [moved.positions[0][0] + 0.25, moved.positions[0][1], moved.positions[0][2]];
      const third = evaluate(moved, "cache-node").geometry;
      expect(third).not.toBe(first);
    });

    it("rebuilds when only the UVs changed, which is all Recalculate UVs touches", () => {
      const box = createQuadBox(1, 1, 1);
      const withUVs = cloneQuadMesh(box);
      withUVs.faceUVs = withUVs.faces.map((face) => face.map((_, i) => [i * 0.1, 0] as [number, number]));

      const before = evaluate(box, "uv-node").geometry;
      const after = evaluate(withUVs, "uv-node").geometry;
      expect(after).not.toBe(before);
    });
  });

  describe("native pose", () => {
    const pose = (params: Record<string, unknown>, inputs: Record<string, unknown> = {}, nodeId = "pose-" + Math.random()) => {
      const res = EDIT_MESH_NODE.evaluate(inputs, { ...EDIT_MESH_NODE.defaultParams, ...params }, { nodeId } as EvalContext);
      const m = (res.geometry as THREE.Mesh).matrix;
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      m.decompose(p, q, s);
      return { matrix: m, pos: p, quat: q, scale: s, out: res };
    };

    it("applies its own location/rotation/scale like any geometry node", () => {
      const { pos, scale } = pose({
        location: new THREE.Vector3(1, 2, 3),
        scale: new THREE.Vector3(2, 2, 2),
      });
      expect(pos.toArray()).toEqual([1, 2, 3]);
      expect(scale.x).toBeCloseTo(2, 6);
    });

    it("rotates about its own Pivot Offset, not the node origin", () => {
      // A pivot one unit down the X axis: a quarter turn about Y swings the
      // origin round it instead of spinning in place.
      const { pos } = pose({
        pivot: new THREE.Vector3(1, 0, 0),
        rotation: new THREE.Vector3(0, Math.PI / 2, 0),
      });
      expect(pos.x).toBeCloseTo(1, 6);
      expect(pos.z).toBeCloseTo(1, 6);
    });

    it('inheritRotation "self" spins in place instead of orbiting a wired matrix', () => {
      const turn = new THREE.Matrix4().makeRotationY(Math.PI / 2);
      const orbiting = pose({ location: new THREE.Vector3(3, 0, 0) }, { matrix: turn });
      expect(orbiting.pos.x).toBeCloseTo(0, 6);
      expect(orbiting.pos.z).toBeCloseTo(-3, 6);

      const spinning = pose(
        { location: new THREE.Vector3(3, 0, 0), inheritRotation: "self" },
        { matrix: turn },
      );
      expect(spinning.pos.x).toBeCloseTo(3, 6);
      expect(spinning.pos.z).toBeCloseTo(0, 6);
    });

    it("composes its pose on top of the source geometry's world matrix", () => {
      const inputMesh = new THREE.Mesh(quadMeshToBufferGeometry(createQuadBox(1, 1, 1)));
      inputMesh.position.set(10, 0, 0);
      inputMesh.updateMatrixWorld(true);

      const passthrough = pose({}, { geometry: inputMesh });
      expect(passthrough.pos.toArray()).toEqual([10, 0, 0]);

      const offset = pose({ location: new THREE.Vector3(0, 5, 0) }, { geometry: inputMesh });
      expect(offset.pos.toArray()).toEqual([10, 5, 0]);
    });

    it("publishes the parent frame the gizmo has to solve against", () => {
      // The viewport solves `own pose = dragged world matrix × parent⁻¹`. The
      // source geometry's world matrix is part of this node's parent and is
      // invisible from the graph, so it is published on the object; feeding
      // the solve the identity instead is what made a grabbed gizmo jump.
      const inputMesh = new THREE.Mesh(quadMeshToBufferGeometry(createQuadBox(1, 1, 1)));
      inputMesh.position.set(10, 0, 0);
      inputMesh.updateMatrixWorld(true);

      const { matrix, out } = pose({ location: new THREE.Vector3(0, 5, 0) }, { geometry: inputMesh });
      const parent = (out.geometry as THREE.Mesh).userData.poseParent as THREE.Matrix4;
      expect(parent).toBeInstanceOf(THREE.Matrix4);

      const solved = matrix.clone().multiply(parent.clone().invert());
      const solvedPos = new THREE.Vector3();
      solved.decompose(solvedPos, new THREE.Quaternion(), new THREE.Vector3());
      expect(solvedPos.toArray()).toEqual([0, 5, 0]); // the node's own location, not 10,5,0
    });

    it("publishes its pivot on the output object, for the viewport marker and gizmo", () => {
      const { out } = pose({ pivot: new THREE.Vector3(0, 1, 0) });
      expect((out.geometry as THREE.Mesh).userData.pivot.toArray()).toEqual([0, 1, 0]);
    });
  });
});
