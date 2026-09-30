import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { EDIT_MESH_NODE, EDIT_MESH_RESEED_ACTION, editMeshFreezeStatus, editMeshModeSwitchParams, editMeshSelectionParams, readEditMeshSelection, resolveEditMeshData } from "./editMesh";
import { EvalContext } from "../types";
import { cloneQuadMesh, createQuadBox, quadMeshToBufferGeometry, QuadMesh, transformSelection } from "../quadMesh";

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

  it("a texture wired into one of two nodes sharing a source leaves the source's material alone", () => {
    // Separate: both halves read the same source mesh and borrow its material.
    const srcMat = new THREE.MeshStandardMaterial({ color: 0x336699 });
    const src = new THREE.Mesh(quadMeshToBufferGeometry(createQuadBox(2, 2, 2)), srcMat);
    const params = { ...EDIT_MESH_NODE.defaultParams, meshData: null };
    const evaluate = (inputs: Record<string, unknown>, nodeId: string) =>
      EDIT_MESH_NODE.evaluate({ geometry: src, ...inputs }, params, { nodeId } as EvalContext).geometry as THREE.Mesh;

    const kept = evaluate({}, "sep-kept");
    expect(evaluate({}, "sep-textured").material).toBe(srcMat);

    const texture = new THREE.Texture({} as any);
    texture.image = { width: 16, height: 16 } as any;
    const textured = evaluate({ texture }, "sep-textured");

    expect((textured.material as THREE.MeshStandardMaterial).map).toBe(texture);
    expect(textured.material).not.toBe(srcMat);
    expect(srcMat.map).toBeNull();
    expect(srcMat.color.getHex()).toBe(0x336699);
    expect(evaluate({}, "sep-kept").material).toBe(srcMat);
    expect(kept.material).toBe(srcMat);
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

  describe("resolveEditMeshData and geometry freezing", () => {
    it("includes a Freeze / Reset from Input button in paramFields", () => {
      const reseedField = EDIT_MESH_NODE.paramFields?.find((f) => f.id === "reseedButton");
      expect(reseedField).toBeDefined();
      if (reseedField && reseedField.kind === "button") {
        expect(reseedField.action).toBe(EDIT_MESH_RESEED_ACTION);
      }
    });

    it("returns existing meshData if already set (frozen)", () => {
      const frozenMesh: QuadMesh = {
        positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
        faces: [[0, 1, 2, 3]],
      };
      const node = { id: "edit-1", params: { meshData: frozenMesh } };
      const resolved = resolveEditMeshData(node);
      expect(resolved).toBe(frozenMesh);
    });

    it("extracts QuadMesh from evaluated results when meshData is not set", () => {
      const inputQuad = createQuadBox(2, 4, 6);
      const inputGeom = quadMeshToBufferGeometry(inputQuad);
      const inputMesh = new THREE.Mesh(inputGeom);

      const evaluatedResults = new Map<string, Record<string, unknown>>([
        ["edit-1", { geometry: inputMesh }],
      ]);
      const node = { id: "edit-1", params: { meshData: null } };
      const resolved = resolveEditMeshData(node, evaluatedResults);

      expect(resolved.positions.length).toBe(inputQuad.positions.length);
      expect(resolved.faces.length).toBe(inputQuad.faces.length);
    });

    it("extracts QuadMesh when input geometry is inside a THREE.Group", () => {
      const cylinderGeom = new THREE.CylinderGeometry(1, 1, 2, 8);
      const group = new THREE.Group();
      group.add(new THREE.Mesh(cylinderGeom));

      const evaluatedResults = new Map<string, Record<string, unknown>>([
        ["edit-1", { __evaluatedInputs: { geometry: group } }],
      ]);
      const node = { id: "edit-1", params: { meshData: null } };
      const resolved = resolveEditMeshData(node, evaluatedResults);

      expect(resolved.positions.length).toBeGreaterThan(0);
      expect(resolved.faces.length).toBeGreaterThan(0);
    });

    it("preserves frozen meshData even if evaluated input geometry changes", () => {
      const frozenMesh: QuadMesh = {
        positions: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]],
        faces: [[0, 1, 2, 3]],
      };
      const node = { id: "edit-1", params: { meshData: frozenMesh } };

      // Upstream changes to an entirely different sphere or box
      const sphereGeom = new THREE.SphereGeometry(5, 8, 8);
      const evaluatedResults = new Map<string, Record<string, unknown>>([
        ["edit-1", { __evaluatedInputs: { geometry: new THREE.Mesh(sphereGeom) } }],
      ]);

      const resolved = resolveEditMeshData(node, evaluatedResults);
      expect(resolved).toBe(frozenMesh);
      expect(resolved.positions.length).toBe(4);
    });
  });

  describe("selection params", () => {
    const sel = (patch: Partial<{ points: number[]; edges: [number, number][]; faces: number[] }>) => ({
      points: [], edges: [], faces: [], ...patch,
    });

    it("freezes a live Edit Mesh on its first non-empty selection, and only then", () => {
      const quad = createQuadBox();
      const live = { type: EDIT_MESH_NODE.type, params: { meshData: null } };
      const patch = editMeshSelectionParams(live, "faces", sel({ faces: [2] }), quad);
      expect(patch.selectedFaces).toEqual([2]);
      expect(patch.meshData).toEqual(quad);
      expect(patch.meshData).not.toBe(quad);
      // Clearing a selection is not an edit: nothing to freeze.
      expect(editMeshSelectionParams(live, "faces", sel({}), quad)).toEqual({ selectedFaces: [] });

      const frozen = { type: EDIT_MESH_NODE.type, params: { meshData: quad } };
      expect(editMeshSelectionParams(frozen, "edges", sel({ edges: [[1, 2]] }), quad)).toEqual({ selectedEdges: [[1, 2]] });
      const points = { type: "object/edit_points", params: {} };
      expect(editMeshSelectionParams(points, "points", sel({ points: [1] }), quad)).toEqual({ selectedPoints: [1] });
    });

    it("reads the mode and selection, defaulting to faces", () => {
      const read = readEditMeshSelection({
        type: EDIT_MESH_NODE.type,
        params: { selectMode: "edges", selectedEdges: [[3, 1], [1, 3]], selectedPoints: [1, -1, "x"] },
      });
      expect(read.mode).toBe("edges");
      expect(read.selection.edges).toEqual([[1, 3]]);
      expect(read.selection.points).toEqual([1]);
      expect(readEditMeshSelection({ type: EDIT_MESH_NODE.type, params: { selectMode: "bogus" } }).mode).toBe("faces");
      expect(readEditMeshSelection({ type: "object/edit_points", params: { selectMode: "faces" } }).mode).toBe("points");
    });

    it("converts the selection when the mode changes", () => {
      const quad = createQuadBox();
      const node = { type: EDIT_MESH_NODE.type, params: { meshData: quad, selectMode: "faces", selectedFaces: [2] } };
      const patch = editMeshModeSwitchParams(node, "points", quad);
      expect(patch.selectMode).toBe("points");
      expect(patch.selectedPoints).toEqual([...quad.faces[2]].sort((a, b) => a - b));
    });
  });

  describe("freeze status", () => {
    const noteIds = (id: string, params: Record<string, unknown>) =>
      EDIT_MESH_NODE.dynamicParamFields!({ id, type: EDIT_MESH_NODE.type, position: { x: 0, y: 0 }, params } as never)
        .filter((f) => f.kind === "note")
        .map((f) => f.id);

    it("flags a frozen mesh once its input changes, and only then", () => {
      const id = "freeze-status";
      const ctx = { nodeId: id } as EvalContext;
      const input = new THREE.Mesh(quadMeshToBufferGeometry(createQuadBox(1, 1, 1)));

      const live = EDIT_MESH_NODE.evaluate({ geometry: input }, { ...EDIT_MESH_NODE.defaultParams }, ctx);
      expect(editMeshFreezeStatus(id)).toEqual({ frozen: false, inputChanged: false });
      expect(noteIds(id, {})).toEqual([]);

      // What the viewport does on the first edit: clone the evaluated quad mesh.
      const meshData = cloneQuadMesh((live.geometry as THREE.Mesh).geometry.userData.quadMesh as QuadMesh);
      expect(meshData.sourceSignature).toBeTruthy();
      const params = { ...EDIT_MESH_NODE.defaultParams, meshData };

      EDIT_MESH_NODE.evaluate({ geometry: input }, params, ctx);
      expect(editMeshFreezeStatus(id)).toEqual({ frozen: true, inputChanged: false });
      expect(noteIds(id, params)).toEqual(["frozenNote"]);

      const changed = new THREE.Mesh(quadMeshToBufferGeometry(createQuadBox(2, 1, 1)));
      EDIT_MESH_NODE.evaluate({ geometry: changed }, params, ctx);
      expect(editMeshFreezeStatus(id)).toEqual({ frozen: true, inputChanged: true });
      expect(noteIds(id, params)).toEqual(["inputChangedNote"]);
    });

    it("never flags a copy frozen before signatures existed", () => {
      const id = "freeze-legacy";
      const input = new THREE.Mesh(quadMeshToBufferGeometry(createQuadBox(2, 1, 1)));
      EDIT_MESH_NODE.evaluate(
        { geometry: input },
        { ...EDIT_MESH_NODE.defaultParams, meshData: createQuadBox(1, 1, 1) },
        { nodeId: id } as EvalContext,
      );
      expect(editMeshFreezeStatus(id)).toEqual({ frozen: true, inputChanged: false });
    });
  });

  describe("Proportional Editing", () => {
    it("hides Influence Diameter when proportionalEditing is false, and shows it when true", () => {
      const instanceOff = {
        id: "edit-test",
        type: EDIT_MESH_NODE.type,
        position: { x: 0, y: 0 },
        params: { proportionalEditing: false },
      } as any;
      const fieldsOff = EDIT_MESH_NODE.dynamicParamFields?.(instanceOff);
      expect(fieldsOff?.find((f) => f.id === "proportionalEditing")).toBeDefined();
      expect(fieldsOff?.find((f) => f.id === "proportionalDiameter")).toBeUndefined();

      const instanceOn = {
        id: "edit-test",
        type: EDIT_MESH_NODE.type,
        position: { x: 0, y: 0 },
        params: { proportionalEditing: true },
      } as any;
      const fieldsOn = EDIT_MESH_NODE.dynamicParamFields?.(instanceOn);
      expect(fieldsOn?.find((f) => f.id === "proportionalEditing")).toBeDefined();
      expect(fieldsOn?.find((f) => f.id === "proportionalDiameter")).toBeDefined();
    });

    it("proportionalEditing transforms nearby unselected vertices with smooth falloff", () => {
      // Mesh with 3 points along the X axis: 0, 0.5, 1.5
      const lineMesh: QuadMesh = {
        positions: [
          [0, 0, 0],   // index 0: selected
          [0.5, 0, 0], // index 1: at distance 0.5 (within radius 1.0)
          [1.5, 0, 0], // index 2: at distance 1.5 (beyond radius 1.0)
        ],
        faces: [[0, 1, 2, 2]],
      };

      // Move point 0 by +2 in Y with diameter 2.0 (radius 1.0)
      const res = transformSelection(
        lineMesh,
        "points",
        [0],
        {
          position: new THREE.Vector3(0, 2, 0),
          rotation: new THREE.Quaternion(),
          scale: new THREE.Vector3(1, 1, 1),
        },
        new THREE.Vector3(0, 0, 0),
        { enabled: true, diameter: 2.0 },
      );

      // Point 0 (selected) moved fully by +2
      expect(res.positions[0][1]).toBeCloseTo(2, 4);

      // Point 1 (distance 0.5 from point 0, radius 1.0 -> t = 0.5, u = 0.5, weight = 0.5)
      // Moved by 2 * 0.5 = 1
      expect(res.positions[1][1]).toBeCloseTo(1, 4);

      // Point 2 (distance 1.5 >= radius 1.0)
      // Untouched: Y remains 0
      expect(res.positions[2][1]).toBeCloseTo(0, 4);
    });

    it("without proportionalEditing, unselected vertices remain completely untouched", () => {
      const lineMesh: QuadMesh = {
        positions: [
          [0, 0, 0],
          [0.5, 0, 0],
        ],
        faces: [[0, 1, 1, 0]],
      };

      const res = transformSelection(
        lineMesh,
        "points",
        [0],
        {
          position: new THREE.Vector3(0, 2, 0),
          rotation: new THREE.Quaternion(),
          scale: new THREE.Vector3(1, 1, 1),
        },
        new THREE.Vector3(0, 0, 0),
        { enabled: false, diameter: 2.0 },
      );

      expect(res.positions[0][1]).toBeCloseTo(2, 4);
      expect(res.positions[1][1]).toBe(0);
    });
  });
});


describe("Edit Mesh material slots", () => {
  it("grows material inputs as they're wired, keeping the old ids", async () => {
    const { materialInputSockets, materialSlotOfSocket, materialSocketOfSlot } = await import("./editMesh");
    expect(materialInputSockets([]).map((s) => s.id)).toEqual(["material", "material2"]);
    expect(materialInputSockets([{ toSocket: "material4" }]).map((s) => s.id)).toEqual([
      "material", "material2", "material3", "material4", "material5",
    ]);
    expect(materialSlotOfSocket("material")).toBe(0);
    expect(materialSlotOfSocket("material3")).toBe(2);
    expect(materialSlotOfSocket("materialX")).toBeNull();
    expect(materialSocketOfSlot(4)).toBe("material5");
  });

  it("gives faces in slot 2 the Material 3 input", () => {
    const box = createQuadBox();
    box.faceMaterials = [0, 0, 2, 0, 0, 0];
    const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const res = EDIT_MESH_NODE.evaluate(
      { material3: red },
      { ...EDIT_MESH_NODE.defaultParams, meshData: box },
      { nodeId: "slots-test" } as EvalContext,
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(Array.isArray(mesh.material)).toBe(true);
    const mats = mesh.material as THREE.Material[];
    expect(mats).toHaveLength(3);
    expect(mats[1]).toBe(mats[0]); // slot 1 unwired: slot 0's material
    expect(mesh.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 2]);
  });
});

describe("Edit Mesh Face Side", () => {
  const evaluate = (inputs: Record<string, unknown>, faceSide: string, nodeId: string) =>
    EDIT_MESH_NODE.evaluate(
      inputs,
      { ...EDIT_MESH_NODE.defaultParams, meshData: null, faceSide },
      { nodeId } as EvalContext,
    ).geometry as THREE.Mesh;

  it("draws both sides by default, and one side on request", () => {
    expect((evaluate({}, "both", "side-own").material as THREE.Material).side).toBe(THREE.DoubleSide);
    expect((evaluate({}, "out", "side-own").material as THREE.Material).side).toBe(THREE.FrontSide);
    expect((evaluate({}, "in", "side-own").material as THREE.Material).side).toBe(THREE.BackSide);
  });

  it("gives a borrowed material's side to a copy, and keeps that copy in step with the source", () => {
    const srcMat = new THREE.MeshStandardMaterial({ color: 0x336699, side: THREE.DoubleSide });
    const src = new THREE.Mesh(quadMeshToBufferGeometry(createQuadBox(2, 2, 2)), srcMat);

    const out = evaluate({ geometry: src }, "out", "side-borrow").material as THREE.MeshStandardMaterial;
    expect(out).not.toBe(srcMat);
    expect(out.side).toBe(THREE.FrontSide);
    expect(srcMat.side).toBe(THREE.DoubleSide);

    srcMat.color.set(0xff0000);
    const again = evaluate({ geometry: src }, "out", "side-borrow").material as THREE.MeshStandardMaterial;
    expect(again).toBe(out);
    expect(again.color.getHex()).toBe(0xff0000);
    expect(again.side).toBe(THREE.FrontSide);

    expect(evaluate({ geometry: src }, "both", "side-borrow").material).toBe(srcMat);
  });
});
