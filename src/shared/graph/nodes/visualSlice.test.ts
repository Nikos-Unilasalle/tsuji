import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { CLIP_BOX_NODE, VISUAL_SLICE_NODE } from "./visualSlice";
import { CURVE_TO_MESH_NODE } from "./curve";
import { clipCapHelperCount, clipCapMeshes, geometryHasOpenEdges } from "./clipCaps";
import { disposeNodeCaches } from "../nodeCaches";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "slice-test" };

/** A closed mesh the clip nodes can chew on, plus the params for a given cap state. */
function boxMesh() {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
}

describe("VISUAL_SLICE_NODE", () => {
  it("assigns a clipping plane to every mesh material in the subtree", () => {
    const meshA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const meshB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const group = new THREE.Group();
    group.add(meshA, meshB);

    VISUAL_SLICE_NODE.evaluate(
      { geometry: group, point: new THREE.Vector3(0, 0, 0), direction: new THREE.Vector3(0, 1, 0) },
      VISUAL_SLICE_NODE.defaultParams,
      CTX,
    );

    expect(meshA.material.clippingPlanes).toHaveLength(1);
    expect(meshB.material.clippingPlanes).toHaveLength(1);
    expect(meshA.material.clippingPlanes![0].normal.y).toBeCloseTo(1);
  });

  it("a wired matrix carries the plane with it", () => {
    const mesh = boxMesh();
    VISUAL_SLICE_NODE.evaluate(
      {
        geometry: mesh,
        point: new THREE.Vector3(0, 0, 0),
        direction: new THREE.Vector3(0, 1, 0),
        matrix: new THREE.Matrix4().makeTranslation(0, 3, 0),
      },
      VISUAL_SLICE_NODE.defaultParams,
      CTX,
    );

    const plane = (mesh.material as THREE.Material).clippingPlanes![0];
    expect(plane.normal.y).toBeCloseTo(1, 6);
    // The plane through y=0 has been carried up to y=3, so the origin is now
    // 3 below it.
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeCloseTo(-3, 6);
  });

  it("a wired rotation turns the plane's normal", () => {
    const mesh = boxMesh();
    VISUAL_SLICE_NODE.evaluate(
      {
        geometry: mesh,
        point: new THREE.Vector3(0, 0, 0),
        direction: new THREE.Vector3(0, 1, 0),
        matrix: new THREE.Matrix4().makeRotationZ(Math.PI / 2),
      },
      VISUAL_SLICE_NODE.defaultParams,
      CTX,
    );

    const plane = (mesh.material as THREE.Material).clippingPlanes![0];
    expect(plane.normal.x).toBeCloseTo(-1, 6);
    expect(plane.normal.y).toBeCloseTo(0, 6);
  });

  it("keeps the normal perpendicular under a non-uniform scale", () => {
    // A direction pushed through the matrix itself instead of its
    // inverse-transpose stops being perpendicular to the surface, and the cut
    // tilts away from where the plane really is. 45° in a box scaled 4x on X
    // is the case that shows it.
    const mesh = boxMesh();
    const matrix = new THREE.Matrix4().makeScale(4, 1, 1);
    VISUAL_SLICE_NODE.evaluate(
      {
        geometry: mesh,
        point: new THREE.Vector3(0, 0, 0),
        direction: new THREE.Vector3(1, 1, 0).normalize(),
        matrix,
      },
      VISUAL_SLICE_NODE.defaultParams,
      CTX,
    );

    const plane = (mesh.material as THREE.Material).clippingPlanes![0];
    // Two points that lie in the plane before the transform must still lie in
    // it after — the definition of the plane having been carried correctly.
    for (const local of [new THREE.Vector3(1, -1, 0), new THREE.Vector3(0, 0, 5)]) {
      const moved = local.clone().applyMatrix4(matrix);
      expect(plane.distanceToPoint(moved)).toBeCloseTo(0, 6);
    }
  });

  it("does not write the transform back into the node's own params", () => {
    // asVector3 hands back the params' Vector3 itself when nothing is wired,
    // so transforming in place would drift the stored point every frame.
    const mesh = boxMesh();
    const params = { ...VISUAL_SLICE_NODE.defaultParams, point: new THREE.Vector3(0, 0, 0) };
    const matrix = new THREE.Matrix4().makeTranslation(0, 2, 0);
    for (let i = 0; i < 3; i++) {
      VISUAL_SLICE_NODE.evaluate({ geometry: mesh, matrix }, params, CTX);
    }
    expect((params.point as THREE.Vector3).y).toBe(0);
    const plane = (mesh.material as THREE.Material).clippingPlanes![0];
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeCloseTo(-2, 6);
  });

  it("invert flips the plane normal", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    VISUAL_SLICE_NODE.evaluate(
      { geometry: mesh, point: new THREE.Vector3(0, 0, 0), direction: new THREE.Vector3(0, 1, 0) },
      { ...VISUAL_SLICE_NODE.defaultParams, invert: 1 },
      CTX,
    );
    expect(mesh.material.clippingPlanes![0].normal.y).toBeCloseTo(-1);
  });

  it("falls back to the default normal when a degenerate zero vector is given", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    VISUAL_SLICE_NODE.evaluate(
      { geometry: mesh, point: new THREE.Vector3(0, 0, 0), direction: new THREE.Vector3(0, 0, 0) },
      VISUAL_SLICE_NODE.defaultParams,
      CTX,
    );
    const n = mesh.material.clippingPlanes![0].normal;
    expect(n.length()).toBeCloseTo(1);
  });

  it("plane sits at the given point along the given normal", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    VISUAL_SLICE_NODE.evaluate(
      { geometry: mesh, point: new THREE.Vector3(0, 2.5, 0), direction: new THREE.Vector3(0, 1, 0) },
      VISUAL_SLICE_NODE.defaultParams,
      CTX,
    );
    const plane = mesh.material.clippingPlanes![0];
    expect(plane.distanceToPoint(new THREE.Vector3(0, 2.5, 0))).toBeCloseTo(0);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 10, 0))).toBeGreaterThan(0);
    expect(plane.distanceToPoint(new THREE.Vector3(0, -10, 0))).toBeLessThan(0);
  });

  it("turns on renderer.localClippingEnabled when a renderer is present", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const fakeRenderer = { localClippingEnabled: false } as unknown as THREE.WebGLRenderer;
    VISUAL_SLICE_NODE.evaluate(
      { geometry: mesh },
      VISUAL_SLICE_NODE.defaultParams,
      { ...CTX, renderer: fakeRenderer },
    );
    expect(fakeRenderer.localClippingEnabled).toBe(true);
  });

  it("passes through null when nothing is wired", () => {
    const res = VISUAL_SLICE_NODE.evaluate({}, VISUAL_SLICE_NODE.defaultParams, CTX);
    expect(res.geometry).toBeNull();
  });

  it("builds one cap (two stencil draws) when capping is on, and drops it when off", () => {
    const ctx = { ...CTX, nodeId: "slice-cap" };
    const mesh = boxMesh();

    VISUAL_SLICE_NODE.evaluate({ geometry: mesh }, { ...VISUAL_SLICE_NODE.defaultParams, capEnabled: 1 }, ctx);
    expect(clipCapHelperCount("slice-cap")).toEqual({ stencil: 2, caps: 1 });

    VISUAL_SLICE_NODE.evaluate({ geometry: mesh }, { ...VISUAL_SLICE_NODE.defaultParams, capEnabled: 0 }, ctx);
    expect(clipCapHelperCount("slice-cap")).toEqual({ stencil: 0, caps: 0 });
    expect(mesh.children).toHaveLength(0);
  });
});

describe("CLIP_BOX_NODE", () => {
  const params = CLIP_BOX_NODE.defaultParams;

  it("inside mode points all six planes inward, so the box interior survives", () => {
    const mesh = boxMesh();
    CLIP_BOX_NODE.evaluate({ geometry: mesh, size: new THREE.Vector3(2, 2, 2) }, params, CTX);

    const planes = mesh.material.clippingPlanes!;
    expect(planes).toHaveLength(6);
    expect(mesh.material.clipIntersection).toBe(false);
    // A point at the box's centre is kept only if it is on the positive side
    // of every plane — the thing that was broken when the normals faced out.
    for (const plane of planes) {
      expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeGreaterThan(0);
    }
    // ...and a point well outside fails at least one.
    expect(planes.some((p) => p.distanceToPoint(new THREE.Vector3(5, 0, 0)) < 0)).toBe(true);
  });

  it("outputs the box's own matrix, Box Size included, not the clipped object's", () => {
    const out = CLIP_BOX_NODE.evaluate(
      { geometry: boxMesh(), location: new THREE.Vector3(1, 2, 3), size: new THREE.Vector3(2, 4, 6) },
      params,
      CTX,
    );
    const corner = new THREE.Vector3(0.5, 0.5, 0.5).applyMatrix4(out.matrix as THREE.Matrix4);
    expect(corner.toArray()).toEqual([2, 4, 6]);
  });

  it("a wired Box takes over the volume, read off its bounds in its own frame", () => {
    const limits = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    limits.position.set(1, 0, 0);
    limits.rotation.set(0, Math.PI / 2, 0);
    const mesh = boxMesh();
    const out = CLIP_BOX_NODE.evaluate(
      { geometry: mesh, box: limits, size: new THREE.Vector3(100, 100, 100) },
      params,
      CTX,
    );

    const expected = limits.matrix.clone().scale(new THREE.Vector3(2, 4, 6));
    (out.matrix as THREE.Matrix4).elements.forEach((v, i) => expect(v).toBeCloseTo(expected.elements[i]));
    // Rotated a quarter turn about Y, the 6-deep box spans x ∈ [-2, 4].
    const planes = mesh.material.clippingPlanes!;
    expect(planes.every((p) => p.distanceToPoint(new THREE.Vector3(3.9, 0, 0)) > 0)).toBe(true);
    expect(planes.some((p) => p.distanceToPoint(new THREE.Vector3(4.1, 0, 0)) < 0)).toBe(true);
  });

  it("cavity mode flips the normals outward and unions the half-spaces", () => {
    const mesh = boxMesh();
    CLIP_BOX_NODE.evaluate(
      { geometry: mesh, size: new THREE.Vector3(2, 2, 2) },
      { ...params, clipMode: "cavity" },
      CTX,
    );

    const planes = mesh.material.clippingPlanes!;
    expect(mesh.material.clipIntersection).toBe(true);
    // Inverted: the centre is now rejected by every plane, so it is carved out.
    for (const plane of planes) {
      expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeLessThan(0);
    }
  });

  it("box rotation carries into the plane normals", () => {
    const mesh = boxMesh();
    CLIP_BOX_NODE.evaluate(
      { geometry: mesh, rotation: new THREE.Vector3(0, Math.PI / 2, 0), size: new THREE.Vector3(2, 2, 2) },
      params,
      CTX,
    );
    // The +X face's inward normal (-1,0,0) rotated 90° about Y lands on -Z.
    const planes = mesh.material.clippingPlanes!;
    expect(planes.some((p) => Math.abs(p.normal.z) > 0.99)).toBe(true);
  });

  it("caps every face, and each cap quad lands on its own plane", () => {
    const ctx = { ...CTX, nodeId: "box-cap" };
    const mesh = boxMesh();
    CLIP_BOX_NODE.evaluate(
      { geometry: mesh, size: new THREE.Vector3(2, 2, 2) },
      { ...params, capEnabled: 1 },
      ctx,
    );

    // Six planes × (one source mesh × back + front).
    expect(clipCapHelperCount("box-cap")).toEqual({ stencil: 12, caps: 6 });

    const caps = clipCapMeshes("box-cap");
    expect(caps).toHaveLength(6);
    // Both the caps and the stencil draws hang off the clipped mesh here.
    expect(mesh.children.filter((c) => c.userData.__clipCapHelper)).toHaveLength(18);
    const planes = mesh.material.clippingPlanes!;
    for (let i = 0; i < caps.length; i++) {
      const centre = new THREE.Vector3().setFromMatrixPosition(caps[i].matrixWorld);
      expect(planes[i].distanceToPoint(centre)).toBeCloseTo(0);
      // Trimmed by the other five faces, never by its own.
      expect((caps[i].material as THREE.Material).clippingPlanes).toHaveLength(5);
    }

    CLIP_BOX_NODE.evaluate({ geometry: mesh, size: new THREE.Vector3(2, 2, 2) }, { ...params, capEnabled: 0 }, ctx);
    expect(clipCapHelperCount("box-cap")).toEqual({ stencil: 0, caps: 0 });
  });

  it("reuses the same helper meshes across frames instead of rebuilding them", () => {
    const ctx = { ...CTX, nodeId: "box-cap-stable" };
    const mesh = boxMesh();
    const run = () => CLIP_BOX_NODE.evaluate({ geometry: mesh }, { ...params, capEnabled: 1 }, ctx);

    run();
    const firstCap = mesh.children.find((c) => c.userData.__clipCapHelper);
    run();
    run();
    expect(clipCapHelperCount("box-cap-stable")).toEqual({ stencil: 12, caps: 6 });
    expect(mesh.children.find((c) => c.userData.__clipCapHelper)).toBe(firstCap);
  });

  it("never treats its own cap helpers as geometry to clip", () => {
    const ctx = { ...CTX, nodeId: "box-cap-nore" };
    const mesh = boxMesh();
    const run = () => CLIP_BOX_NODE.evaluate({ geometry: mesh }, { ...params, capEnabled: 1 }, ctx);

    run();
    run();
    // A helper picked up as a source mesh would spawn helpers of its own and
    // multiply every frame; the count staying put is what proves it doesn't.
    expect(clipCapHelperCount("box-cap-nore")).toEqual({ stencil: 12, caps: 6 });
  });

  it("passes through null when nothing is wired", () => {
    const res = CLIP_BOX_NODE.evaluate({}, params, CTX);
    expect(res.geometry).toBeNull();
  });

  it("double-sided is opt-in and restores the material's original side when switched back off", () => {
    const mesh = boxMesh();
    mesh.material.side = THREE.FrontSide;

    CLIP_BOX_NODE.evaluate({ geometry: mesh }, params, CTX);
    expect(mesh.material.side).toBe(THREE.FrontSide);

    CLIP_BOX_NODE.evaluate({ geometry: mesh }, { ...params, doubleSided: 1 }, CTX);
    expect(mesh.material.side).toBe(THREE.DoubleSide);

    CLIP_BOX_NODE.evaluate({ geometry: mesh }, { ...params, doubleSided: 0 }, CTX);
    expect(mesh.material.side).toBe(THREE.FrontSide);
  });

  it("un-clips the geometry when the node is deleted", () => {
    const ctx = { ...CTX, nodeId: "box-deleted" };
    const mesh = boxMesh();
    mesh.material.side = THREE.FrontSide;

    CLIP_BOX_NODE.evaluate({ geometry: mesh }, { ...params, capEnabled: 1, doubleSided: 1 }, ctx);
    expect(mesh.material.clippingPlanes).toHaveLength(6);

    // What App.tsx runs for every node that left the graph.
    disposeNodeCaches(["box-deleted"]);

    expect(mesh.material.clippingPlanes).toBeNull();
    expect(mesh.material.clipIntersection).toBe(false);
    expect(mesh.material.clipShadows).toBe(false);
    expect(mesh.material.side).toBe(THREE.FrontSide);
    // The cap helpers go with it, rather than hanging off an uncut mesh.
    expect(clipCapHelperCount("box-deleted")).toEqual({ stencil: 0, caps: 0 });
    expect(mesh.children).toHaveLength(0);
  });

  it("releases the old geometry when the input is rewired to another object", () => {
    const ctx = { ...CTX, nodeId: "box-rewired" };
    const first = boxMesh();
    const second = boxMesh();

    CLIP_BOX_NODE.evaluate({ geometry: first }, params, ctx);
    expect(first.material.clippingPlanes).toHaveLength(6);

    CLIP_BOX_NODE.evaluate({ geometry: second }, params, ctx);
    expect(second.material.clippingPlanes).toHaveLength(6);
    expect(first.material.clippingPlanes).toBeNull();
  });

  it("releases the geometry when the input is unwired", () => {
    const ctx = { ...CTX, nodeId: "box-unwired" };
    const mesh = boxMesh();

    CLIP_BOX_NODE.evaluate({ geometry: mesh }, params, ctx);
    expect(mesh.material.clippingPlanes).toHaveLength(6);

    CLIP_BOX_NODE.evaluate({}, params, ctx);
    expect(mesh.material.clippingPlanes).toBeNull();
  });

  it("deleting one of two chained clips leaves the other still cutting", () => {
    const upstream = { ...CTX, nodeId: "chain-a" };
    const downstream = { ...CTX, nodeId: "chain-b" };
    const mesh = boxMesh();

    // Both run every frame, downstream last — the same order the evaluator uses.
    const frame = () => {
      CLIP_BOX_NODE.evaluate({ geometry: mesh }, params, upstream);
      VISUAL_SLICE_NODE.evaluate({ geometry: mesh }, VISUAL_SLICE_NODE.defaultParams, downstream);
    };
    frame();
    expect(mesh.material.clippingPlanes).toHaveLength(1);

    disposeNodeCaches(["chain-b"]);
    // Restores what it found: the upstream node's planes, not "unclipped".
    expect(mesh.material.clippingPlanes).toHaveLength(6);

    CLIP_BOX_NODE.evaluate({ geometry: mesh }, params, upstream);
    expect(mesh.material.clippingPlanes).toHaveLength(6);

    disposeNodeCaches(["chain-a"]);
    expect(mesh.material.clippingPlanes).toBeNull();
  });

  it("remembers the pre-clip side from the first touch, not from a double-sided frame", () => {
    const mesh = boxMesh();
    mesh.material.side = THREE.BackSide;

    // Several double-sided frames in a row must not latch DoubleSide as "the original".
    for (let i = 0; i < 3; i++) {
      CLIP_BOX_NODE.evaluate({ geometry: mesh }, { ...params, doubleSided: 1 }, CTX);
    }
    CLIP_BOX_NODE.evaluate({ geometry: mesh }, { ...params, doubleSided: 0 }, CTX);
    expect(mesh.material.side).toBe(THREE.BackSide);
  });
});

describe("capping geometry that encloses no volume", () => {
  /** An open-ended tube: a lateral surface only, exactly what Curve to Mesh makes with Caps off. */
  function openTube() {
    return new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 2, 12, 1, true),
      new THREE.MeshStandardMaterial(),
    );
  }

  function noteOf(nodeId: string, params: Record<string, unknown>): string | undefined {
    const fields = CLIP_BOX_NODE.dynamicParamFields?.({
      id: nodeId,
      type: CLIP_BOX_NODE.type,
      params,
      position: { x: 0, y: 0 },
    }) ?? [];
    return fields.find((f) => f.id === "capOpenGeometryNote")?.label;
  }

  it("tells open geometry from closed", () => {
    expect(geometryHasOpenEdges(new THREE.CylinderGeometry(0.3, 0.3, 2, 12, 1, true))).toBe(true);
    // Closed solids: a capped cylinder and a box both enclose a volume.
    expect(geometryHasOpenEdges(new THREE.CylinderGeometry(0.3, 0.3, 2, 12, 1, false))).toBe(false);
    expect(geometryHasOpenEdges(new THREE.BoxGeometry(1, 1, 1))).toBe(false);
    // A plane is the degenerate open case.
    expect(geometryHasOpenEdges(new THREE.PlaneGeometry(1, 1))).toBe(true);
  });

  it("explains the silence when Cap Cut is on but the surface is open", () => {
    const ctx = { ...CTX, nodeId: "cap-open" };
    const params = { ...CLIP_BOX_NODE.defaultParams, capEnabled: 1 };
    CLIP_BOX_NODE.evaluate({ geometry: openTube() }, params, ctx);

    const note = noteOf("cap-open", params) ?? "";
    expect(note).toMatch(/open surface/i);
    // Names the actual way out, not just the diagnosis.
    expect(note).toMatch(/Caps \(fill open ends\)/);
  });

  it("says nothing when the surface is closed", () => {
    const ctx = { ...CTX, nodeId: "cap-closed" };
    const params = { ...CLIP_BOX_NODE.defaultParams, capEnabled: 1 };
    CLIP_BOX_NODE.evaluate({ geometry: boxMesh() }, params, ctx);
    expect(noteOf("cap-closed", params)).toBeUndefined();
  });

  it("says nothing when capping is off, however open the surface is", () => {
    const ctx = { ...CTX, nodeId: "cap-off" };
    const params = { ...CLIP_BOX_NODE.defaultParams, capEnabled: 0 };
    CLIP_BOX_NODE.evaluate({ geometry: openTube() }, params, ctx);
    expect(noteOf("cap-off", params)).toBeUndefined();
  });

  it("stays quiet when only some of the meshes are open — the closed ones still cap", () => {
    const ctx = { ...CTX, nodeId: "cap-mixed" };
    const params = { ...CLIP_BOX_NODE.defaultParams, capEnabled: 1 };
    const group = new THREE.Group();
    group.add(openTube(), boxMesh());
    CLIP_BOX_NODE.evaluate({ geometry: group }, params, ctx);
    expect(noteOf("cap-mixed", params)).toBeUndefined();
  });
});

describe("an open mesh must not poison the stencil for a closed one beside it", () => {
  function openTube() {
    return new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2, 12, 1, true), new THREE.MeshStandardMaterial());
  }

  it("caps the closed mesh and leaves the open one out of the stencil pass", () => {
    const ctx = { ...CTX, nodeId: "mixed-stencil" };
    const group = new THREE.Group();
    group.add(openTube(), boxMesh());

    CLIP_BOX_NODE.evaluate({ geometry: group }, { ...CLIP_BOX_NODE.defaultParams, capEnabled: 1 }, ctx);

    // Six planes, and only the *one* closed mesh contributing back+front draws.
    // Counting both meshes would be 24 — and their counts would cancel out.
    expect(clipCapHelperCount("mixed-stencil")).toEqual({ stencil: 12, caps: 6 });
  });

  it("a circle through Curve to Mesh in Surface mode still caps", () => {
    // The exact graph that showed no caps: the node emits its filled surface
    // (closed) together with the curve's own tube (open) in one group.
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);

    const built = CURVE_TO_MESH_NODE.evaluate(
      { curve },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: true },
      { ...CTX, nodeId: "curve-surface" },
    );
    const geometry = built.geometry as THREE.Object3D;

    const meshes: THREE.Mesh[] = [];
    geometry.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    // Two meshes, one of each kind — the situation that has to be handled.
    expect(meshes).toHaveLength(2);
    expect(meshes.filter((m) => geometryHasOpenEdges(m.geometry))).toHaveLength(1);

    const ctx = { ...CTX, nodeId: "curve-surface-clip" };
    CLIP_BOX_NODE.evaluate({ geometry }, { ...CLIP_BOX_NODE.defaultParams, capEnabled: 1 }, ctx);

    // Only the surface takes part: 6 planes × 2 draws.
    expect(clipCapHelperCount("curve-surface-clip")).toEqual({ stencil: 12, caps: 6 });
    // And nothing is claimed to be uncappable, because the surface caps fine.
    const fields = CLIP_BOX_NODE.dynamicParamFields?.({
      id: "curve-surface-clip",
      type: CLIP_BOX_NODE.type,
      params: { ...CLIP_BOX_NODE.defaultParams, capEnabled: 1 },
      position: { x: 0, y: 0 },
    }) ?? [];
    expect(fields.find((f) => f.id === "capOpenGeometryNote")).toBeUndefined();
  });
});

describe("caps survive an upstream node rebuilding its own subtree", () => {
  function curveNodeOutput(nodeId: string, caps: boolean) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) pts.push(new THREE.Vector3(i * 0.3 - 1.5, Math.sin(i * 0.4), 0));
    return CURVE_TO_MESH_NODE.evaluate(
      { curve: new THREE.CatmullRomCurve3(pts, false) },
      { ...CURVE_TO_MESH_NODE.defaultParams, caps },
      { ...CTX, nodeId },
    ).geometry as THREE.Object3D;
  }

  it("a capped tube stays capped after the curve node re-evaluates", () => {
    const clipCtx = { ...CTX, nodeId: "tube-clip" };
    const clipParams = { ...CLIP_BOX_NODE.defaultParams, capEnabled: 1 };

    const group = curveNodeOutput("tube-src", true);
    CLIP_BOX_NODE.evaluate({ geometry: group }, clipParams, clipCtx);

    const caps = clipCapMeshes("tube-clip");
    expect(caps).toHaveLength(6);
    expect(caps.every((c) => c.parent === group)).toBe(true);

    // Curve to Mesh opens its evaluate with group.clear(), so the next frame
    // detaches every cap quad parented there. The rig looked healthy while
    // nothing drew.
    curveNodeOutput("tube-src", true);
    expect(caps.some((c) => c.parent === group)).toBe(false);

    // Re-evaluating the clip node has to put them back.
    CLIP_BOX_NODE.evaluate({ geometry: group }, clipParams, clipCtx);
    expect(clipCapMeshes("tube-clip").every((c) => c.parent === group)).toBe(true);
    expect(clipCapHelperCount("tube-clip")).toEqual({ stencil: 12, caps: 6 });
  });

  it("a tube with its own Caps off contributes nothing to the stencil", () => {
    const clipCtx = { ...CTX, nodeId: "tube-open-clip" };
    const group = curveNodeOutput("tube-open-src", false);
    CLIP_BOX_NODE.evaluate({ geometry: group }, { ...CLIP_BOX_NODE.defaultParams, capEnabled: 1 }, clipCtx);
    expect(clipCapHelperCount("tube-open-clip").stencil).toBe(0);
  });
});
