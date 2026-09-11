import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  createQuadBox,
  createQuadPlane,
  quadMeshToBufferGeometry,
  bufferGeometryToQuadMesh,
  getQuadMeshEdges,
  extrudeFaces,
  insetFaces,
  loopCut,
  getLoopCutPreviewSegments,
  boxProjectUVs,
  transformSelection,
} from "./quadMesh";

describe("QuadMesh", () => {
  it("creates a quad box with 8 vertices and 6 quads", () => {
    const box = createQuadBox(2, 2, 2);
    expect(box.positions.length).toBe(8);
    expect(box.faces.length).toBe(6);
    for (const f of box.faces) {
      expect(f.length).toBe(4);
    }
  });

  it("creates a quad plane with segmented grid", () => {
    const plane = createQuadPlane(2, 2, 2, 2);
    expect(plane.positions.length).toBe(9);
    expect(plane.faces.length).toBe(4);
  });

  it("extracts unique quad edges without diagonal triangulation lines", () => {
    const box = createQuadBox(1, 1, 1);
    const edges = getQuadMeshEdges(box);
    // A cube has 12 edges (not 18 triangulated edges!)
    expect(edges.length).toBe(12);
  });

  it("converts quad mesh to buffer geometry and attaches quadMesh to userData", () => {
    const box = createQuadBox(1, 1, 1);
    const geom = quadMeshToBufferGeometry(box);
    // Auto-smooth box has 24 vertices (4 per face) for sharp crease normals
    expect(geom.attributes.position.count).toBe(24);
    // 6 quads * 2 triangles = 12 triangles = 36 index entries
    expect(geom.index?.count).toBe(36);
    expect(geom.userData.quadMesh).toBeDefined();

    const smoothGeom = quadMeshToBufferGeometry({ ...box, shading: "smooth", faceUVs: undefined });
    expect(smoothGeom.attributes.position.count).toBe(8);
    expect(smoothGeom.index?.count).toBe(36);

    const roundtrip = bufferGeometryToQuadMesh(geom);
    expect(roundtrip.faces.length).toBe(6);
    expect(roundtrip.positions.length).toBe(8);
  });

  it("extrudes selected face outward, creating quad side walls", () => {
    const box = createQuadBox(1, 1, 1);
    // Top face index is 2
    const { mesh: extruded, newFaces } = extrudeFaces(box, [2], 0.5);

    // Extruding 1 face of a cube adds 4 new vertices and 4 new quad side walls
    // Original faces: 6. New walls: 4. Total faces: 10
    expect(extruded.faces.length).toBe(10);
    expect(extruded.positions.length).toBe(12);
    expect(newFaces).toEqual([2]);

    // All faces should be quads
    for (const f of extruded.faces) {
      expect(f.length).toBe(4);
    }

    // Top face should have moved up by 0.5 (+Y)
    for (const vIdx of extruded.faces[2]) {
      expect(extruded.positions[vIdx][1]).toBeCloseTo(1.0, 4);
    }
  });

  it("insets selected face into an inner quad and 4 surrounding border quads", () => {
    const box = createQuadBox(1, 1, 1);
    // Inset top face (index 2)
    const { mesh: insetMesh, newFaces } = insetFaces(box, [2], 0.5);

    // 1 face replaced with 1 inner quad + 4 border quads = 5 quads for this face, total 10 quads
    expect(insetMesh.faces.length).toBe(10);
    // 4 new vertices added
    expect(insetMesh.positions.length).toBe(12);
    expect(newFaces).toEqual([2]);

    for (const f of insetMesh.faces) {
      expect(f.length).toBe(4);
    }
  });

  it("performs loop cut across an edge loop", () => {
    const box = createQuadBox(1, 1, 1);
    // Pick an edge, e.g. [4, 5] (front bottom edge)
    const { mesh: cutMesh, newVertexIndices } = loopCut(box, [4, 5], 0.5);

    // Loop cutting a cube around 4 faces splits 4 quads into 8 quads
    // 6 - 4 + 8 = 10 quads
    expect(cutMesh.faces.length).toBe(10);
    expect(newVertexIndices.length).toBe(4);

    for (const f of cutMesh.faces) {
      expect(f.length).toBe(4);
    }
  });

  it("transforms selected points or faces around their centroid", () => {
    const box = createQuadBox(1, 1, 1);
    // Top face index 2 (Y = 0.5)
    const centroid = new THREE.Vector3(0, 0.5, 0);
    const moved = transformSelection(
      box,
      "faces",
      [2],
      {
        position: new THREE.Vector3(0, 1, 0),
        rotation: new THREE.Quaternion(),
        scale: new THREE.Vector3(2, 1, 2),
      },
      centroid,
    );

    // All top vertices should have moved from Y=0.5 to Y=1.5 and scaled in X/Z
    for (const vIdx of moved.faces[2]) {
      expect(moved.positions[vIdx][1]).toBeCloseTo(1.5, 4);
      expect(Math.abs(moved.positions[vIdx][0])).toBeCloseTo(1.0, 4);
    }
  });

  it("calculates 3D loop cut preview segments across quads", () => {
    const box = createQuadBox(1, 1, 1);
    // Edge [4, 5]
    const segments = getLoopCutPreviewSegments(box, [4, 5], 0.5);
    // Loop around 4 faces of the cube creates 4 preview segments
    expect(segments.length).toBe(4);
    for (const [pA, pB] of segments) {
      expect(pA.length).toBe(3);
      expect(pB.length).toBe(3);
    }
  });

  it("calculates coherent box projection UVs for all faces", () => {
    const box = createQuadBox(2, 2, 2);
    const unwrapped = boxProjectUVs(box);
    expect(unwrapped.faceUVs).toBeDefined();
    expect(unwrapped.faceUVs?.length).toBe(6);
    for (const fuv of unwrapped.faceUVs!) {
      expect(fuv.length).toBe(4);
      for (const [u, v] of fuv) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("performs multi-cut loop cut with N cuts", () => {
    const box = createQuadBox(1, 1, 1);
    // 2 cuts across edge loop [4, 5]
    const { mesh: cutMesh2, newVertexIndices: newVerts2 } = loopCut(box, [4, 5], 2);
    // 4 faces split into 4 * 3 = 12 faces; 2 remaining uncut faces -> total 14 faces
    expect(cutMesh2.faces.length).toBe(14);
    // 2 cuts across 4 edges -> 8 new vertices
    expect(newVerts2.length).toBe(8);
    for (const f of cutMesh2.faces) {
      expect(f.length).toBe(4);
    }

    // 3 cuts across edge loop [4, 5]
    const { mesh: cutMesh3, newVertexIndices: newVerts3 } = loopCut(box, [4, 5], 3);
    // 4 faces split into 4 * 4 = 16 faces; 2 remaining uncut faces -> total 18 faces
    expect(cutMesh3.faces.length).toBe(18);
    // 3 cuts across 4 edges -> 12 new vertices
    expect(newVerts3.length).toBe(12);
  });

  it("generates multiple preview segments when cuts > 1", () => {
    const box = createQuadBox(1, 1, 1);
    const segments2 = getLoopCutPreviewSegments(box, [4, 5], 2);
    // 2 cuts * 4 quad faces = 8 segments
    expect(segments2.length).toBe(8);

    const segments3 = getLoopCutPreviewSegments(box, [4, 5], 3);
    // 3 cuts * 4 quad faces = 12 segments
    expect(segments3.length).toBe(12);
  });

  it("ensures UV coordinates are continuous across multi-cuts without per-face 0..1 distortion", () => {
    const box = createQuadBox(1, 1, 1);
    // 3 cuts across edge loop [4, 5] creates 4 slices per affected face
    const { mesh: cutMesh } = loopCut(box, [4, 5], 3);
    expect(cutMesh.faceUVs).toBeDefined();

    // In a slice of width 0.25 (1 / 4 of the face), UV width must be ~0.25, not 1.0!
    // Face 0 was subdivided into 4 sub-quads: face 0 and faces (faces.length - 3)..faces.length - 1
    const subFaceUV0 = cutMesh.faceUVs![0];
    const uVals = subFaceUV0.map(([u]) => u);
    const uSpan = Math.max(...uVals) - Math.min(...uVals);
    // The slice UV span must be ~0.25, NOT 1.0 (which would squish the texture)
    expect(uSpan).toBeCloseTo(0.25, 2);
  });
});


