import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { DELETE_GEOMETRY_NODE, EXTRUDE_MESH_NODE, FACE_SELECTION_NODE, selectFaces } from "./meshEdit";
import { HEX_GRID_NODE } from "./hexGrid";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "mesh-edit-test" };

function faceCountOf(mesh: THREE.Mesh): number {
  const geom = mesh.geometry;
  return (geom.index ? geom.index.count : geom.attributes.position.count) / 3;
}

describe("selectFaces", () => {
  it("'all' selects every triangle", () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const positions = box.attributes.position.array as Float32Array;
    const indices = box.index!.array;
    const faceCount = indices.length / 3;

    const sel = selectFaces(positions, indices, faceCount, { mode: "all", axis: "y", threshold: 0, invert: false });
    expect(sel.every(Boolean)).toBe(true);
  });

  it("'normal' selects only the top-facing triangles of a box", () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const positions = box.attributes.position.array as Float32Array;
    const indices = box.index!.array;
    const faceCount = indices.length / 3;

    const sel = selectFaces(positions, indices, faceCount, { mode: "normal", axis: "y", threshold: 0.9, invert: false });
    const selectedCount = sel.filter(Boolean).length;
    // A unit box's +Y face is 2 triangles out of 12 total.
    expect(selectedCount).toBe(2);
  });

  it("invert flips the selection", () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const positions = box.attributes.position.array as Float32Array;
    const indices = box.index!.array;
    const faceCount = indices.length / 3;

    const normal = selectFaces(positions, indices, faceCount, { mode: "normal", axis: "y", threshold: 0.9, invert: false });
    const inverted = selectFaces(positions, indices, faceCount, { mode: "normal", axis: "y", threshold: 0.9, invert: true });
    for (let i = 0; i < normal.length; i++) expect(inverted[i]).toBe(!normal[i]);
  });

  it("'height' selects faces whose average position along the axis clears the threshold", () => {
    const box = new THREE.BoxGeometry(1, 1, 1); // spans -0.5..0.5
    const positions = box.attributes.position.array as Float32Array;
    const indices = box.index!.array;
    const faceCount = indices.length / 3;

    const above = selectFaces(positions, indices, faceCount, { mode: "height", axis: "y", threshold: 0, invert: false });
    const below = selectFaces(positions, indices, faceCount, { mode: "height", axis: "y", threshold: 0, invert: true });
    // Every face's centroid is strictly above or below y=0 on a symmetric
    // box (none straddle exactly), so the two selections partition all faces.
    for (let i = 0; i < above.length; i++) expect(above[i]).toBe(!below[i]);
  });
});

describe("EXTRUDE_MESH_NODE", () => {
  it("extruding the top faces of a box adds a wall and raises the cap without moving the rest", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const originalTris = faceCountOf(box);

    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 0.5 },
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
      CTX,
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(faceCountOf(mesh)).toBeGreaterThan(originalTris);

    mesh.geometry.computeBoundingBox();
    const box3 = mesh.geometry.boundingBox!;
    // The box spans -0.5..0.5; extruding the top by 0.5 should push the
    // ceiling to ~1.0 while the floor stays at -0.5.
    expect(box3.max.y).toBeCloseTo(1.0, 4);
    expect(box3.min.y).toBeCloseTo(-0.5, 4);
  });

  it("'all' mode extrudes every face outward along its own normal (a flat plane just moves along its normal)", () => {
    // A plane (unlike a box) has one normal shared by every vertex, so the
    // expected offset is unambiguous — a box's corner vertices average 3
    // different face normals together, which is real correct behavior but
    // not a clean number to assert against by hand.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    const res = EXTRUDE_MESH_NODE.evaluate({ geometry: plane, distance: 0.25 }, EXTRUDE_MESH_NODE.defaultParams, CTX);
    const mesh = res.geometry as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const box3 = mesh.geometry.boundingBox!;
    expect(box3.max.z).toBeCloseTo(0.25, 4);
    expect(box3.min.z).toBeCloseTo(0, 4);
  });

  it("distance 0 passes the geometry through unchanged", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const originalTris = faceCountOf(box);
    const res = EXTRUDE_MESH_NODE.evaluate({ geometry: box, distance: 0 }, EXTRUDE_MESH_NODE.defaultParams, CTX);
    expect(faceCountOf(res.geometry as THREE.Mesh)).toBe(originalTris);
  });

  it("an empty selection passes the geometry through unchanged", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const originalTris = faceCountOf(box);
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 1 },
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 10 }, // impossible dot product
      CTX,
    );
    expect(faceCountOf(res.geometry as THREE.Mesh)).toBe(originalTris);
  });

  it("returns null when nothing is wired in", () => {
    const res = EXTRUDE_MESH_NODE.evaluate({}, EXTRUDE_MESH_NODE.defaultParams, CTX);
    expect(res.geometry).toBeNull();
  });

  it("a wired Face Selection overrides the formula fields", () => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    // The Face Selection node picks the upper half of the plane's two faces.
    const faceSel = FACE_SELECTION_NODE.evaluate(
      { geometry: plane },
      { ...FACE_SELECTION_NODE.defaultParams, selectMode: "height", axis: "y", threshold: 0, invert: false },
      CTX,
    );
    const selection = faceSel.selection as boolean[];
    expect(selection.filter(Boolean).length).toBe(1); // 1 of 2 triangles

    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: plane, distance: 0.25, selection },
      // A formula that would select nothing if the selection were ignored.
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 10 },
      CTX,
    );
    const mesh = res.geometry as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.max.z).toBeCloseTo(0.25, 4);
    expect(mesh.geometry.boundingBox!.min.z).toBeCloseTo(0, 4);
  });

  it("a mismatched-length selection falls back to the formula instead of misaligning", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 0.5, selection: [true] }, // 12 faces, not 1
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
      CTX,
    );
    const mesh = res.geometry as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.max.y).toBeCloseTo(1.0, 4); // formula selected the top
  });

  it("a wired Transform matrix drives the per-pass transform, overriding the direct fields", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    // Per-pass matrix: translate +0.4 in Z, rotate 0.5 rad about X.
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0.4),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 0.5, passes: 3, transform: matrix, scale: 5 }, // scale: 5 must be ignored
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
      { ...CTX, nodeId: "extrude-matrix" },
    );
    const mesh = res.geometry as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const box3 = mesh.geometry.boundingBox!;
    // The tip drifts +Z every pass (translation + bend): well past the base's ±0.5.
    expect(box3.max.z).toBeGreaterThan(1.2);
    // Rotation about X never changes X, and scale 5 was overridden by the
    // matrix's (1,1,1) — had it applied, the tip would balloon past 2.5.
    expect(box3.max.x).toBeLessThanOrEqual(0.6);
    expect(box3.min.x).toBeGreaterThanOrEqual(-0.6);
  });

  it("the extruded mesh inherits the source material, live across cache hits", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    box.material = material;
    const ctx = { ...CTX, nodeId: "extrude-material" };
    const params = { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 };

    const first = EXTRUDE_MESH_NODE.evaluate({ geometry: box, distance: 0.5 }, params, ctx);
    const mesh = first.geometry as THREE.Mesh;
    expect(mesh.material).toBe(material); // shared reference, not a clone

    // The source swaps to a *new* material instance (another Material node).
    // The topology cache hits, but the output must still pick the new
    // material up — the inheritance has to be live, not baked at build time.
    const replacement = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    box.material = replacement;
    const second = EXTRUDE_MESH_NODE.evaluate({ geometry: box, distance: 0.5 }, params, ctx);
    const mesh2 = second.geometry as THREE.Mesh;
    expect(mesh2).toBe(mesh); // cache hit, same mesh object
    expect(mesh2.material).toBe(replacement);
  });

  it("applies wired material input over source material", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    box.material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const customMat = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const ctx = { ...CTX, nodeId: "extrude-custom-mat" };
    const params = { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "all" };

    const res = EXTRUDE_MESH_NODE.evaluate({ geometry: box, distance: 0.2, material: customMat }, params, ctx);
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.material).toBe(customMat);
  });

  it("applies MaterialParams input object (from MATERIAL_NODE) and adapts live", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const ctx = { ...CTX, nodeId: "extrude-mat-params" };
    const params = { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "all" };

    // Pass a MaterialParams object
    const matParams = {
      color: new THREE.Color(0x00ff00),
      roughness: 0.2,
      metalness: 0.8,
      shadeless: false,
      opacity: 1.0,
    };
    const res = EXTRUDE_MESH_NODE.evaluate({ geometry: box, distance: 0.2, material: matParams }, params, ctx);
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x00ff00);

    // Update color live without rebuilding geometry
    const updatedParams = { ...matParams, color: new THREE.Color(0xff00ff) };
    const res2 = EXTRUDE_MESH_NODE.evaluate({ geometry: box, distance: 0.2, material: updatedParams }, params, ctx);
    const mesh2 = res2.geometry as THREE.Mesh;
    expect(mesh2).toBe(mesh); // cache hit
    expect((mesh2.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff00ff);
  });

  it("adapts vertex-colored source mesh (e.g. Grease Pencil) to shaded material without rendering black", () => {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    // Add vertex colors (e.g. blue)
    const colors = new Float32Array(geom.attributes.position.count * 3);
    for (let i = 0; i < geom.attributes.position.count; i++) {
      colors[i * 3] = 0.2;
      colors[i * 3 + 1] = 0.6;
      colors[i * 3 + 2] = 0.9;
    }
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const box = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ vertexColors: true }));
    const ctx = { ...CTX, nodeId: "extrude-gp-fallback" };
    const params = { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "all" };

    const res = EXTRUDE_MESH_NODE.evaluate({ geometry: box, distance: 0.2 }, params, ctx);
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    // Should NOT have vertexColors: true since the extruded geometry lacks a color attribute
    expect((mesh.material as any).vertexColors).toBeFalsy();
    expect((mesh.material as THREE.MeshStandardMaterial).color.r).toBeCloseTo(0.2);
    expect((mesh.material as THREE.MeshStandardMaterial).color.g).toBeCloseTo(0.6);
    expect((mesh.material as THREE.MeshStandardMaterial).color.b).toBeCloseTo(0.9);
  });

  it("preserves incoming mesh userData.pivot and showPivot adjustments", () => {
    const polygon = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.5, 6));
    polygon.userData.pivot = new THREE.Vector3(0, -0.25, 0);
    polygon.userData.showPivot = true;

    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: polygon, distance: 0.5 },
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "all" },
      { ...CTX, nodeId: "extrude-pivot-test" },
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.userData.pivot).toBeDefined();
    expect(mesh.userData.pivot.x).toBeCloseTo(0);
    expect(mesh.userData.pivot.y).toBeCloseTo(-0.25);
    expect(mesh.userData.pivot.z).toBeCloseTo(0);
    expect(mesh.userData.showPivot).toBe(true);

    // Cache hit should also preserve the pivot
    const resCached = EXTRUDE_MESH_NODE.evaluate(
      { geometry: polygon, distance: 0.5 },
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "all" },
      { ...CTX, nodeId: "extrude-pivot-test" },
    );
    const cachedMesh = resCached.geometry as THREE.Mesh;
    expect(cachedMesh.userData.pivot).toBeDefined();
    expect(cachedMesh.userData.pivot.y).toBeCloseTo(-0.25);

    // Downstream Hex Grid should inherit the pivot and apply pivotInv
    const hexRes = HEX_GRID_NODE.evaluate(
      { geometry: mesh },
      { cols: 2, rows: 2, radius: 1, spacing: 1 },
      { ...CTX, nodeId: "hex-after-extrude" },
    );
    const group = hexRes.geometry as THREE.Group;
    expect(group.children.length).toBe(4);
    const firstWrapper = group.children[0] as THREE.Group;
    expect(firstWrapper.userData.pivot).toBeDefined();
    expect(firstWrapper.userData.pivot.y).toBeCloseTo(-0.25);
  });
});

describe("EXTRUDE_MESH_NODE — UVs", () => {
  /** Every triangle's UV area, so a degenerate mapping (all of them zero) is visible. */
  function uvAreas(mesh: THREE.Mesh): number[] {
    const uv = mesh.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const index = mesh.geometry.getIndex()!;
    const areas: number[] = [];
    for (let t = 0; t < index.count / 3; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => index.getX(t * 3 + k));
      const abx = uv.getX(b) - uv.getX(a);
      const aby = uv.getY(b) - uv.getY(a);
      const acx = uv.getX(c) - uv.getX(a);
      const acy = uv.getY(c) - uv.getY(a);
      areas.push(Math.abs(abx * acy - aby * acx) / 2);
    }
    return areas;
  }

  it("gives the extruded result UVs at all", () => {
    // A textured box through Extrude used to come out with its material and
    // its map intact and no UVs to sample them with, which renders as garbage
    // rather than as nothing — and every node downstream inherited the loss.
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 0.4 },
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
      { time: 0, step: 0, nodeId: "uv-basic" } as never,
    );
    const mesh = res.geometry as THREE.Mesh;
    const uv = mesh.geometry.getAttribute("uv");
    expect(uv).toBeDefined();
    expect(uv.count).toBe(mesh.geometry.getAttribute("position").count);
  });

  it("keeps every UV inside the source's own range — the cap carries the patch's mapping", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 0.3 },
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
      { time: 0, step: 0, nodeId: "uv-range" } as never,
    );
    const uv = (res.geometry as THREE.Mesh).geometry.getAttribute("uv") as THREE.BufferAttribute;
    // BoxGeometry maps every face to the full 0..1 square. The walls climb out
    // of it by the extrusion's share of an edge, so a little overshoot is
    // expected; a wild one means the mapping lost its scale.
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThan(-0.5);
      expect(uv.getX(i)).toBeLessThan(1.5);
      expect(uv.getY(i)).toBeGreaterThan(-0.5);
      expect(uv.getY(i)).toBeLessThan(1.5);
    }
  });

  it("gives the walls real UV area rather than a smear", () => {
    // The cheap way out is to hand the wall its edge's two UVs twice, which
    // costs nothing and maps the whole side to a line of texels.
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 0.5 },
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
      { time: 0, step: 0, nodeId: "uv-walls" } as never,
    );
    const areas = uvAreas(res.geometry as THREE.Mesh);
    expect(areas.every((area) => area > 1e-6)).toBe(true);
  });

  it("scales the wall's UVs with the extrusion, not with the quad", () => {
    // Half the distance, half the texture on the side: the texel density of
    // the cap, carried onto the wall.
    const uvSpan = (distance: number) => {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
      const res = EXTRUDE_MESH_NODE.evaluate(
        { geometry: box, distance },
        { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
        { time: 0, step: 0, nodeId: `uv-scale-${distance}` } as never,
      );
      const uv = (res.geometry as THREE.Mesh).geometry.getAttribute("uv") as THREE.BufferAttribute;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < uv.count; i++) {
        min = Math.min(min, uv.getY(i));
        max = Math.max(max, uv.getY(i));
      }
      return max - min;
    };
    // Each overshoots the source's 0..1 by its own extrusion; the bigger one
    // has to overshoot more.
    expect(uvSpan(0.6)).toBeGreaterThan(uvSpan(0.2));
  });

  it("still works on a source with no UVs at all", () => {
    const bare = new THREE.BufferGeometry();
    bare.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: new THREE.Mesh(bare), distance: 0.2 },
      { ...EXTRUDE_MESH_NODE.defaultParams },
      { time: 0, step: 0, nodeId: "uv-none" } as never,
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(mesh.geometry.getAttribute("uv")).toBeUndefined();
  });
});

describe("EXTRUDE_MESH_NODE — grow passes", () => {
  // Extruding the top faces of a unit box repeatedly: each pass raises the cap
  // by `distance` (the cap's averaged normal is exactly +Y — the side faces
  // aren't selected, so they don't drag the corners sideways).
  function growBox(params: Record<string, unknown>, nodeId = "grow-box"): THREE.Mesh {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 0.5 },
      { ...EXTRUDE_MESH_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9, ...params },
      { ...CTX, nodeId },
    );
    return res.geometry as THREE.Mesh;
  }

  /** Centroid of the vertices near the mesh's highest point — the grown tip. */
  function topCentroid(mesh: THREE.Mesh): THREE.Vector3 {
    mesh.geometry.computeBoundingBox();
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const maxY = mesh.geometry.boundingBox!.max.y;
    let cx = 0;
    let cz = 0;
    let count = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > maxY - 0.1) {
        cx += pos.getX(i);
        cz += pos.getZ(i);
        count++;
      }
    }
    return new THREE.Vector3(cx / count, maxY, cz / count);
  }

  it("each pass raises the cap by exactly one distance (3 passes on a box top)", () => {
    const mesh = growBox({ passes: 3 });
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.max.y).toBeCloseTo(0.5 + 3 * 0.5, 3);
    expect(mesh.geometry.boundingBox!.min.y).toBeCloseTo(-0.5, 3);
  });

  it("passes 0 passes the geometry through unchanged", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const originalTris = faceCountOf(box);
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: box, distance: 0.5 },
      { ...EXTRUDE_MESH_NODE.defaultParams, passes: 0 },
      CTX,
    );
    expect(faceCountOf(res.geometry as THREE.Mesh)).toBe(originalTris);
  });

  it("per-pass scale tapers the tip toward its top while the base keeps its width", () => {
    const mesh = growBox({ passes: 3, scale: 0.5 });
    mesh.geometry.computeBoundingBox();
    // Base stays a unit box.
    expect(mesh.geometry.boundingBox!.max.x).toBeCloseTo(0.5, 3);
    // The tip shrank by 0.5 per pass: 0.5 × 0.5³ = 0.0625 half-width.
    const tip = topCentroid(mesh);
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    let maxTipX = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > tip.y - 0.1) maxTipX = Math.max(maxTipX, Math.abs(pos.getX(i)));
    }
    expect(maxTipX).toBeCloseTo(0.5 * 0.5 ** 3, 3);
  });

  it("per-pass rotation bends the tip off-axis, accumulating every pass", () => {
    // Rotate the cap 0.5 rad about X after every pass: the tip walks +Z.
    const mesh = growBox({ passes: 3, rotation: new THREE.Vector3(0.5, 0, 0) });
    const tip = topCentroid(mesh);
    expect(tip.y).toBeGreaterThan(1.5); // still grows upward overall
    expect(tip.z).toBeGreaterThan(0.4); // but bends toward +Z
    expect(Math.abs(tip.x)).toBeLessThan(0.2); // no x-bend
  });

  it("a fixed seed always grows the same shape, a different seed a different one", () => {
    const params = { passes: 3, rotation: new THREE.Vector3(0.2, 0.1, 0), random: 0.5, seed: 42 };
    const a = growBox(params, "grow-seed-a");
    const b = growBox(params, "grow-seed-b");
    const c = growBox({ ...params, seed: 7 }, "grow-seed-c");

    const positions = (m: THREE.Mesh) => Array.from(m.geometry.attributes.position.array as Float32Array);
    expect(positions(a)).toEqual(positions(b));
    expect(positions(a)).not.toEqual(positions(c));
  });

  it("grows the top ring of a tube into a taller, bending shape (the tree case)", () => {
    // A cylinder standing on the plane: its top ring faces all have centroid
    // y above the threshold, so 'height' selects exactly the growing cap.
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1, 12));
    const res = EXTRUDE_MESH_NODE.evaluate(
      { geometry: tube, distance: 0.3 },
      { ...EXTRUDE_MESH_NODE.defaultParams, passes: 5, selectMode: "height", axis: "y", threshold: 0.4, rotation: new THREE.Vector3(0, 0, 0.15), scale: 0.96 },
      { ...CTX, nodeId: "grow-tree" },
    );
    const mesh = res.geometry as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    // Cylinder top at y≈0.5 grows by 5×0.3 → well past 1.5.
    expect(mesh.geometry.boundingBox!.max.y).toBeGreaterThan(1.5);
    expect(faceCountOf(mesh)).toBeGreaterThan(faceCountOf(tube));
  });
});

describe("DELETE_GEOMETRY_NODE", () => {
  it("default params delete exactly the faces whose own centroid clears the threshold", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const originalTris = faceCountOf(box);

    const res = DELETE_GEOMETRY_NODE.evaluate({ geometry: box }, DELETE_GEOMETRY_NODE.defaultParams, CTX);
    const mesh = res.geometry as THREE.Mesh;
    // A unit box's 12 triangles: the top cap (2) sit fully above y=0, and of
    // each side wall's 2 triangles exactly one has a centroid above y=0 (the
    // wall is split corner-to-corner) — 6 of 12 have centroid y >= 0 and get
    // deleted. Deliberately not asserting the bounding box here: a *kept*
    // side-wall triangle still touches y=+0.5 at one of its own corners even
    // though its centroid is below 0, so the box stays full-height — that's
    // correct face-centroid selection, not a bug, just not what a naive
    // bounding-box check would expect.
    expect(faceCountOf(mesh)).toBe(6);
    expect(faceCountOf(mesh)).toBeLessThan(originalTris);
  });

  it("preserves UVs and normals on the surviving faces (pure subtraction, no new topology)", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = DELETE_GEOMETRY_NODE.evaluate({ geometry: box }, DELETE_GEOMETRY_NODE.defaultParams, CTX);
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.attributes.uv).toBeDefined();
    expect(mesh.geometry.attributes.normal).toBeDefined();
  });

  it("invert deletes the complementary set of faces", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const normal = DELETE_GEOMETRY_NODE.evaluate({ geometry: box }, DELETE_GEOMETRY_NODE.defaultParams, CTX);
    const inverted = DELETE_GEOMETRY_NODE.evaluate(
      { geometry: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)) },
      { ...DELETE_GEOMETRY_NODE.defaultParams, invert: true },
      { ...CTX, nodeId: "mesh-edit-test-inverted" },
    );
    // Same box, complementary selection — together they should account for
    // every triangle (12), and inverting should not land on the same count
    // by coincidence unless the split happens to be even (it is: 6/6 here,
    // asserted directly instead of just "not equal" to keep this precise).
    expect(faceCountOf(normal.geometry as THREE.Mesh) + faceCountOf(inverted.geometry as THREE.Mesh)).toBe(12);
    expect(faceCountOf(inverted.geometry as THREE.Mesh)).toBe(6);
  });

  it("returns null when nothing is wired in", () => {
    const res = DELETE_GEOMETRY_NODE.evaluate({}, DELETE_GEOMETRY_NODE.defaultParams, CTX);
    expect(res.geometry).toBeNull();
  });
});

describe("FACE_SELECTION_NODE", () => {
  it("selects the top-facing triangles of a box and reports them as a boolean list, face indices and a count", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = FACE_SELECTION_NODE.evaluate(
      { geometry: box },
      { ...FACE_SELECTION_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
      CTX,
    );
    const selection = res.selection as boolean[];
    expect(selection.length).toBe(12); // one boolean per triangle, in index order
    expect(res.count).toBe(2); // a unit box's +Y face
    expect(res.faces).toEqual([4, 5]); // BoxGeometry's +Y face is triangles 4-5
    expect(selection.filter(Boolean)).toHaveLength(2);
  });

  it("invert flips every face", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const normal = FACE_SELECTION_NODE.evaluate(
      { geometry: box },
      { ...FACE_SELECTION_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9 },
      CTX,
    ).selection as boolean[];
    const inverted = FACE_SELECTION_NODE.evaluate(
      { geometry: box },
      { ...FACE_SELECTION_NODE.defaultParams, selectMode: "normal", axis: "y", threshold: 0.9, invert: true },
      CTX,
    ).selection as boolean[];
    for (let i = 0; i < normal.length; i++) expect(inverted[i]).toBe(!normal[i]);
  });

  it("a wired threshold overrides the param", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const none = FACE_SELECTION_NODE.evaluate(
      { geometry: box, threshold: 10 },
      { ...FACE_SELECTION_NODE.defaultParams, selectMode: "height", axis: "y", threshold: 0 },
      CTX,
    );
    expect(none.count).toBe(0);
  });

  it("returns empty lists when nothing is wired in", () => {
    const res = FACE_SELECTION_NODE.evaluate({}, FACE_SELECTION_NODE.defaultParams, CTX);
    expect(res.selection).toEqual([]);
    expect(res.count).toBe(0);
  });

  it("interactive picks (Shift+clicked faces) win over the formula once the operator has edited", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    // Formula would select the +Y face (triangles 4,5); the interactive set
    // is something completely different.
    const res = FACE_SELECTION_NODE.evaluate(
      { geometry: box },
      {
        ...FACE_SELECTION_NODE.defaultParams,
        selectMode: "normal",
        axis: "y",
        threshold: 0.9,
        interactive: true,
        selectedFaces: [2, 7],
      },
      CTX,
    );
    const selection = res.selection as boolean[];
    expect(selection.length).toBe(12);
    expect(selection.filter(Boolean)).toHaveLength(2);
    expect(selection[2]).toBe(true);
    expect(selection[7]).toBe(true);
    expect(selection[4]).toBe(false); // the formula's choice, ignored now
    expect(res.faces).toEqual([2, 7]);
    expect(res.count).toBe(2);
  });

  it("passes the source geometry through so the picked-on mesh keeps rendering", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = FACE_SELECTION_NODE.evaluate({ geometry: box }, FACE_SELECTION_NODE.defaultParams, CTX);
    expect(res.geometry).toBe(box);
  });

  it("the first Shift+click selects exactly that one face, not the whole mesh", () => {
    // The viewport seeds its working set from the stored `selectedFaces`
    // param (empty on a fresh node), never from the evaluated `selection`
    // output — which under the default "all" mode is every face. Seeding
    // from the output made one click extrude the entire object; this pins
    // the param that makes the click behave.
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    expect(FACE_SELECTION_NODE.defaultParams.selectedFaces).toEqual([]);
    expect(FACE_SELECTION_NODE.defaultParams.interactive).toBe(false);

    // A fresh node previews the formula — "all" — so the operator can see
    // what Extrude would do before touching anything.
    const preview = FACE_SELECTION_NODE.evaluate({ geometry: box }, FACE_SELECTION_NODE.defaultParams, { ...CTX, nodeId: "fresh" });
    expect((preview.faces as number[]).length).toBe(12);

    // Viewport's first Shift+click: working set starts from the stored param
    // (empty), adds the clicked face, and commits interactive: true.
    const afterOneClick = FACE_SELECTION_NODE.evaluate(
      { geometry: box },
      { ...FACE_SELECTION_NODE.defaultParams, interactive: true, selectedFaces: [3] },
      { ...CTX, nodeId: "fresh" },
    );
    expect(afterOneClick.faces).toEqual([3]);
    expect(afterOneClick.count).toBe(1);
  });

  it("ticking Interactive with nothing picked yet selects nothing, rather than falling back to the formula", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = FACE_SELECTION_NODE.evaluate(
      { geometry: box },
      { ...FACE_SELECTION_NODE.defaultParams, selectMode: "all", interactive: true, selectedFaces: [] },
      CTX,
    );
    expect(res.count).toBe(0);
    expect((res.selection as boolean[]).some(Boolean)).toBe(false);
  });
});
