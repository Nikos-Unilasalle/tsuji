import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext, Graph, createRegistry } from "../types";
import { getCurveNodePose } from "../curvePoseStore";
import { evaluateGraph } from "../evaluate";
import {
  createVariableThicknessTubeGeometry,
  CURVE_ARRAY_NODE,
  CURVE_DEFORM_NODE,
  CURVE_FROM_POINTS_NODE,
  CURVE_PRIMITIVE_NODE,
  CURVE_TO_MESH_NODE,
  CURVES_TO_MESH_NODE,
  SAMPLE_CURVE_NODE,
} from "./curve";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "curve-test-1" };

describe("CURVE NODES", () => {
  it("CURVE_FROM_POINTS_NODE creates a valid THREE.Curve", () => {
    const res = CURVE_FROM_POINTS_NODE.evaluate(
      {
        points: [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1, 2, 0),
          new THREE.Vector3(2, 0, 0),
        ],
      },
      CURVE_FROM_POINTS_NODE.defaultParams,
      CTX
    );

    const curve = res.curve as THREE.Curve<THREE.Vector3>;
    expect(curve).toBeInstanceOf(THREE.Curve);
    const pt = curve.getPointAt(0.5);
    expect(pt).toBeInstanceOf(THREE.Vector3);
  });

  it("CURVE_PRIMITIVE_NODE generates helix and circle curves", () => {
    const resHelix = CURVE_PRIMITIVE_NODE.evaluate(
      {},
      { primitiveType: "helix", radius: 2, height: 4, turns: 2 },
      CTX
    );
    expect(resHelix.curve).toBeInstanceOf(THREE.Curve);

    const resCircle = CURVE_PRIMITIVE_NODE.evaluate(
      {},
      { primitiveType: "circle", radius: 3, height: 0, turns: 1 },
      CTX
    );
    expect(resCircle.curve).toBeInstanceOf(THREE.Curve);
  });

  it("CURVE_PRIMITIVE_NODE builds every shape", () => {
    for (const shape of ["ellipse", "heart", "star", "polygon", "diamond", "arch", "wave", "rectangle", "line"]) {
      const res = CURVE_PRIMITIVE_NODE.evaluate(
        {},
        { primitiveType: shape, radius: 2, height: 3, turns: 5 },
        CTX
      );
      const curve = res.curve as THREE.Curve<THREE.Vector3>;
      expect(curve, shape).toBeInstanceOf(THREE.Curve);
      expect(curve.getPoint(0)).toBeInstanceOf(THREE.Vector3);
      expect(curve.getPoint(1)).toBeInstanceOf(THREE.Vector3);
    }
  });

  it("CURVE_PRIMITIVE_NODE: Sag droops every shape without moving its endpoints", () => {
    // "line" is excluded: the primitive is hardcoded to run straight along
    // Y, the same axis Sag droops along, so drooping "down" is drooping
    // along the segment's own direction — geometrically a pure reparam of
    // the same straight path, not a visible bulge. Sag's slack-wire droop
    // only reads on a segment with some perpendicular-to-Y extent, which
    // every other primitive shape has (see CURVE_FROM_POINTS_NODE's own sag
    // tests for the same reason its fixture uses horizontal points).
    for (const shape of ["circle", "ellipse", "heart", "star", "polygon", "diamond", "arch", "wave", "rectangle", "helix"]) {
      const taut = CURVE_PRIMITIVE_NODE.evaluate({}, { primitiveType: shape, radius: 2, height: 3, turns: 5, sag: 0 }, CTX)
        .curve as THREE.Curve<THREE.Vector3>;
      const sagged = CURVE_PRIMITIVE_NODE.evaluate({}, { primitiveType: shape, radius: 2, height: 3, turns: 5, sag: 0.3 }, CTX)
        .curve as THREE.Curve<THREE.Vector3>;

      // Sag only pulls the interior of each segment down; the endpoints a
      // closed/open shape was built from stay exactly where they were.
      expect(sagged.getPoint(0).distanceTo(taut.getPoint(0)), shape).toBeLessThan(1e-6);

      // Somewhere along the curve, Sag actually moved a point downward —
      // otherwise the knob silently does nothing for this shape. Sampled at
      // a step (1/37, prime) that can't land exactly on every shape's own
      // segment-vertex spacing (20, 24, or turns*10 segments) — landing
      // exactly on a vertex would read a false "no droop" there, since
      // droop is 0 at every segment's own endpoints by construction.
      let maxDrop = 0;
      for (let i = 1; i < 37; i++) {
        const t = i / 37;
        maxDrop = Math.max(maxDrop, taut.getPointAt(t).y - sagged.getPointAt(t).y);
      }
      expect(maxDrop, shape).toBeGreaterThan(0.01);
    }
  });

  it("CURVE_FROM_POINTS_NODE closed emits a closed curve", () => {
    const res = CURVE_FROM_POINTS_NODE.evaluate(
      {
        points: [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(2, 0, 0),
          new THREE.Vector3(2, 2, 0),
          new THREE.Vector3(0, 2, 0),
        ],
      },
      { type: "catmull", closed: true },
      CTX
    );
    const curve = res.curve as THREE.CatmullRomCurve3;
    expect(curve.closed).toBe(true);
  });

  it("Curve from Points keeps the curve local and records its pose for curve-to-mesh", () => {
    const nodeId = "curve-pose-test";
    const res = CURVE_FROM_POINTS_NODE.evaluate(
      {
        points: [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(2, 0, 0),
          new THREE.Vector3(2, 2, 0),
        ],
      },
      { type: "catmull", location: new THREE.Vector3(10, 0, 0), rotation: new THREE.Vector3(0, 0, 0), scale: new THREE.Vector3(1, 1, 1) },
      { ...CTX, nodeId },
    );
    // The curve output stays in local space (spawned copies can sit on a
    // surface); the pose is recorded separately for curve-to-mesh to compose.
    expect((res.curve as THREE.CatmullRomCurve3).getPoint(0).x).toBeCloseTo(0, 3);
    const pose = getCurveNodePose(nodeId);
    expect(pose).toBeDefined();
    expect(new THREE.Vector3().setFromMatrixPosition(pose!).x).toBeCloseTo(10, 3);
  });

  it("createVariableThicknessTubeGeometry builds buffer geometry with positions and normals", () => {
    const pts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(2, 0, 0),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const geom = createVariableThicknessTubeGeometry(curve, 16, 8, 0.2);

    expect(geom).toBeInstanceOf(THREE.BufferGeometry);
    expect(geom.attributes.position.count).toBeGreaterThan(0);
    expect(geom.attributes.normal.count).toBe(geom.attributes.position.count);
  });

  it("createVariableThicknessTubeGeometry with caps adds extra vertices and index faces closing both ends", () => {
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0)];
    const curve = new THREE.CatmullRomCurve3(pts);

    const open = createVariableThicknessTubeGeometry(curve, 16, 8, 0.2, undefined, false, 0, 1, false);
    const capped = createVariableThicknessTubeGeometry(curve, 16, 8, 0.2, undefined, false, 0, 1, true);

    // Two discs: (radialSegments+1) duplicated ring verts + 1 center vertex, each.
    expect(capped.attributes.position.count).toBe(open.attributes.position.count + 2 * (8 + 1 + 1));
    // radialSegments triangles per disc, two discs.
    expect(capped.index!.count).toBe(open.index!.count + 2 * 8 * 3);
  });

  it("createVariableThicknessTubeGeometry caps are watertight — no NaNs and every cap normal is a unit vector", () => {
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(2, 0, 1)];
    const curve = new THREE.CatmullRomCurve3(pts);
    const geom = createVariableThicknessTubeGeometry(curve, 12, 6, 0.15, undefined, false, 0, 1, true);

    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      expect(Number.isFinite(pos.getX(i))).toBe(true);
      expect(Number.isFinite(pos.getY(i))).toBe(true);
      expect(Number.isFinite(pos.getZ(i))).toBe(true);
    }
    const nrm = geom.attributes.normal;
    // Last (radialSegments+2) vertices pushed are the end cap's — check its normal length.
    const lastIdx = nrm.count - 1;
    const n = new THREE.Vector3(nrm.getX(lastIdx), nrm.getY(lastIdx), nrm.getZ(lastIdx));
    expect(n.length()).toBeCloseTo(1, 4);
  });

  it("CURVE_TO_MESH_NODE generates a 3D Mesh object with variable thickness", () => {
    const pts = [
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(1, 0, 0),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);

    const res = CURVE_TO_MESH_NODE.evaluate(
      { curve, thickness: 0.3 },
      CURVE_TO_MESH_NODE.defaultParams,
      CTX
    );

    const group = res.geometry as THREE.Group;
    expect(group).toBeInstanceOf(THREE.Group);
    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
  });

  it("CURVE_TO_MESH_NODE trims curve from startProgress to endProgress", () => {
    const pts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 0, 0),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);

    const full = CURVE_TO_MESH_NODE.evaluate(
      { curve, startProgress: 0, endProgress: 1 },
      CURVE_TO_MESH_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "curve-full" }
    );
    const fullMesh = (full.geometry as THREE.Group).children[0] as THREE.Mesh;
    fullMesh.geometry.computeBoundingBox();
    const fullMaxX = fullMesh.geometry.boundingBox!.max.x;
    expect(fullMaxX).toBeCloseTo(10, 0);

    const trimmed = CURVE_TO_MESH_NODE.evaluate(
      { curve, startProgress: 0.2, endProgress: 0.7 },
      CURVE_TO_MESH_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "curve-trimmed" }
    );
    const trimmedMesh = (trimmed.geometry as THREE.Group).children[0] as THREE.Mesh;
    trimmedMesh.geometry.computeBoundingBox();
    expect(trimmedMesh.geometry.boundingBox!.min.x).toBeGreaterThan(1.5);
    expect(trimmedMesh.geometry.boundingBox!.max.x).toBeLessThan(7.5);
  });

  it("SAMPLE_CURVE_NODE computes position, tangent, and orientation matrix at progress t", () => {
    const pts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 0, 0),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);

    const res = SAMPLE_CURVE_NODE.evaluate(
      { curve, progress: 0.5 },
      SAMPLE_CURVE_NODE.defaultParams,
      CTX
    );

    expect(res.position).toBeInstanceOf(THREE.Vector3);
    expect(res.tangent).toBeInstanceOf(THREE.Vector3);
    expect(res.matrix).toBeInstanceOf(THREE.Matrix4);
    expect(res.rotation).toBeInstanceOf(THREE.Vector3);
  });

  it("CURVE_DEFORM_NODE bends 3D mesh geometry along a curve", () => {
    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 4), new THREE.MeshStandardMaterial());
    const pts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 3, 5),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);

    const res = CURVE_DEFORM_NODE.evaluate(
      { geometry: boxMesh, curve, progress: 0.1 },
      CURVE_DEFORM_NODE.defaultParams,
      CTX
    );

    const deformedMesh = res.geometry as THREE.Mesh;
    expect(deformedMesh).toBeInstanceOf(THREE.Mesh);
    expect(deformedMesh.geometry).not.toBe(boxMesh.geometry);
  });
});

describe("CURVE_FROM_POINTS_NODE sag (linear type — slack wire droop)", () => {
  const points = [new THREE.Vector3(0, 5, 0), new THREE.Vector3(10, 5, 0), new THREE.Vector3(20, 5, 0)];

  it("keeps the segment taut (a straight LineCurve3) when sag is 0", () => {
    const res = CURVE_FROM_POINTS_NODE.evaluate(
      { points },
      { ...CURVE_FROM_POINTS_NODE.defaultParams, type: "linear", sag: 0 },
      CTX,
    );
    const curve = res.curve as THREE.CurvePath<THREE.Vector3>;
    const mid = curve.getPoint(0.25); // midpoint of the first of two segments
    expect(mid.y).toBeCloseTo(5, 5);
  });

  it("droops the midpoint along -Y only (this app's up axis), by the Sag amount, while leaving both endpoints exactly where they were", () => {
    const res = CURVE_FROM_POINTS_NODE.evaluate(
      { points },
      { ...CURVE_FROM_POINTS_NODE.defaultParams, type: "linear", sag: 2 },
      CTX,
    );
    const curve = res.curve as THREE.CurvePath<THREE.Vector3>;

    // First segment spans t in [0, 0.5] of the whole two-segment path.
    const start = curve.getPoint(0);
    const mid = curve.getPoint(0.25);
    const end = curve.getPoint(0.5);

    expect(start.x).toBeCloseTo(0, 5);
    expect(start.y).toBeCloseTo(5, 5); // untouched — droop is 0 at t=0
    expect(end.x).toBeCloseTo(10, 5);
    expect(end.y).toBeCloseTo(5, 5); // untouched — droop is 0 at t=1

    // Peak droop at the segment's own midpoint: sag * 4*0.5*(1-0.5) = sag.
    expect(mid.x).toBeCloseTo(5, 5); // X/Z interpolation itself is untouched
    expect(mid.y).toBeCloseTo(5 - 2, 5);
  });

  it("forces straight (linear) segments when Sag is on, even with Type left at its catmull default — otherwise the knob silently did nothing", () => {
    const res = CURVE_FROM_POINTS_NODE.evaluate({ points }, { ...CURVE_FROM_POINTS_NODE.defaultParams, sag: 5 }, CTX);
    expect(res.curve).toBeInstanceOf(THREE.CurvePath);
    const mid = (res.curve as THREE.CurvePath<THREE.Vector3>).getPoint(0.25);
    expect(mid.y).toBeCloseTo(0, 5); // 5 (start Y) - 5 (sag) at the segment's own midpoint
  });

  it("droops toward true WORLD -Y even when the node itself is rotated, not local -Y", () => {
    // A segment lying flat along local X, then the whole node rotated 90°
    // about X: local Y now points along world Z, and local Z now points
    // along world -Y. A sag that (bug) droops along local -Y would show up
    // as a world Z shift once rotated; a sag that (fix) compensates for the
    // node's own rotation still lands on world -Y.
    const ctxRot: EvalContext = { time: 0, step: 0, nodeId: "sag-rotated" };
    const flatPoints = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)];
    const rotatedParams = {
      ...CURVE_FROM_POINTS_NODE.defaultParams,
      type: "linear",
      sag: 2,
      rotation: new THREE.Vector3(Math.PI / 2, 0, 0),
    };

    const taut = CURVE_FROM_POINTS_NODE.evaluate({ points: flatPoints }, { ...rotatedParams, sag: 0 }, ctxRot);
    const tautMidWorld = (taut.curve as THREE.CurvePath<THREE.Vector3>).getPoint(0.5).applyMatrix4(getCurveNodePose(ctxRot.nodeId)!);

    const sagged = CURVE_FROM_POINTS_NODE.evaluate({ points: flatPoints }, rotatedParams, ctxRot);
    const saggedMidWorld = (sagged.curve as THREE.CurvePath<THREE.Vector3>).getPoint(0.5).applyMatrix4(getCurveNodePose(ctxRot.nodeId)!);

    // Drops by exactly `sag` along world Y, and nowhere else.
    expect(saggedMidWorld.y).toBeCloseTo(tautMidWorld.y - 2, 4);
    expect(saggedMidWorld.x).toBeCloseTo(tautMidWorld.x, 4);
    expect(saggedMidWorld.z).toBeCloseTo(tautMidWorld.z, 4);
  });
});

describe("CURVE_FROM_POINTS_NODE bezier mode", () => {
  const points = (count: number) =>
    Array.from({ length: count }, (_, i) => new THREE.Vector3(i, i % 2, 0));

  function pathOf(count: number, closed = false): THREE.CurvePath<THREE.Vector3> {
    const res = CURVE_FROM_POINTS_NODE.evaluate(
      { points: points(count) },
      { ...CURVE_FROM_POINTS_NODE.defaultParams, type: "bezier", closed },
      CTX
    );
    return res.curve as THREE.CurvePath<THREE.Vector3>;
  }

  it("builds one cubic segment per group of three points past the first", () => {
    expect(pathOf(4).curves).toHaveLength(1);
    expect(pathOf(7).curves).toHaveLength(2);
  });

  it("ends a 3n+2 list on a quadratic instead of dropping its tail", () => {
    const curves = pathOf(6).curves;

    expect(curves).toHaveLength(2);
    expect(curves[1]).toBeInstanceOf(THREE.QuadraticBezierCurve3);
  });

  it("ends a 3n+3 list on a straight segment instead of dropping its tail", () => {
    const curves = pathOf(5).curves;

    expect(curves).toHaveLength(2);
    expect(curves[1]).toBeInstanceOf(THREE.LineCurve3);
  });

  it("every point reaches the curve — the last one is on it", () => {
    const pts = points(6);
    const path = pathOf(6);

    expect(path.getPoint(1).distanceTo(pts[5])).toBeLessThan(1e-6);
  });

  it("closes back to the first point when Closed is set", () => {
    const path = pathOf(4, true);

    expect(path.curves).toHaveLength(2);
    expect(path.getPoint(1).distanceTo(points(4)[0])).toBeLessThan(1e-6);
  });
});

describe("SAMPLE_CURVE_NODE progress", () => {
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)]);

  function positionAt(progress: number): THREE.Vector3 {
    const res = SAMPLE_CURVE_NODE.evaluate({ curve, progress }, SAMPLE_CURVE_NODE.defaultParams, CTX);
    return res.position as THREE.Vector3;
  }

  it("reaches the end of the curve at progress 1 rather than snapping back to the start", () => {
    expect(positionAt(1).x).toBeCloseTo(10, 5);
  });

  it("still wraps past 1 so an ever-increasing driver loops the path", () => {
    expect(positionAt(1.25).x).toBeCloseTo(positionAt(0.25).x, 5);
    // 1 is the one exception — every other whole number is another lap.
    expect(positionAt(2).x).toBeCloseTo(0, 5);
  });

  it("regression: bakes in the source curve node's own Location/Rotation/Scale, via the real graph evaluator", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "prim",
          type: CURVE_PRIMITIVE_NODE.type,
          params: {
            ...CURVE_PRIMITIVE_NODE.defaultParams,
            primitiveType: "line",
            height: 10,
            location: new THREE.Vector3(0, 0, 5),
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "follow",
          type: SAMPLE_CURVE_NODE.type,
          params: { ...SAMPLE_CURVE_NODE.defaultParams, progress: 0.5 },
          position: { x: 0, y: 0 },
        },
      ],
      connections: [{ id: "prim.curve->follow.curve", fromNode: "prim", fromSocket: "curve", toNode: "follow", toSocket: "curve" }],
    };

    const registry = createRegistry([CURVE_PRIMITIVE_NODE, SAMPLE_CURVE_NODE]);
    const results = evaluateGraph(graph, registry, { time: 0, step: 0, nodeId: "eval" } as EvalContext);
    const position = results.get("follow")?.position as THREE.Vector3;

    // "line" primitive runs from (0,-5,0) to (0,5,0) locally; moved to
    // z=5, its own midpoint (progress 0.5) should land at (0, 0, 5) —
    // only true if Location actually made it into Follow Path's output.
    expect(position.x).toBeCloseTo(0, 4);
    expect(position.y).toBeCloseTo(0, 4);
    expect(position.z).toBeCloseTo(5, 4);
  });
});

describe("CURVE_TO_MESH_NODE geometry caching", () => {
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)]);
  const ctx: EvalContext = { time: 0, step: 0, nodeId: "curve-cache-1" };

  it("keeps the same geometry when nothing it depends on changed", () => {
    const first = CURVE_TO_MESH_NODE.evaluate({ curve }, CURVE_TO_MESH_NODE.defaultParams, ctx);
    const firstGeometry = ((first.geometry as THREE.Group).children[0] as THREE.Mesh).geometry;
    // A fresh Curve instance with the same definition, as the upstream node
    // hands back every frame — identity must not be what triggers a rebuild.
    const sameCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)]);
    const second = CURVE_TO_MESH_NODE.evaluate({ curve: sameCurve }, CURVE_TO_MESH_NODE.defaultParams, ctx);

    expect(((second.geometry as THREE.Group).children[0] as THREE.Mesh).geometry).toBe(firstGeometry);
  });

  it("rebuilds when a shape parameter changes", () => {
    // The mesh instance is reused, so the geometry it held has to be captured
    // before the second evaluate swaps it out.
    const before = CURVE_TO_MESH_NODE.evaluate({ curve }, CURVE_TO_MESH_NODE.defaultParams, ctx);
    const beforeGeometry = ((before.geometry as THREE.Group).children[0] as THREE.Mesh).geometry;

    const after = CURVE_TO_MESH_NODE.evaluate(
      { curve },
      { ...CURVE_TO_MESH_NODE.defaultParams, radialSegments: 5 },
      ctx
    );

    expect(((after.geometry as THREE.Group).children[0] as THREE.Mesh).geometry).not.toBe(beforeGeometry);
  });

  it("rebuilds when the curve itself moves", () => {
    const before = CURVE_TO_MESH_NODE.evaluate({ curve }, CURVE_TO_MESH_NODE.defaultParams, ctx);
    const beforeGeometry = ((before.geometry as THREE.Group).children[0] as THREE.Mesh).geometry;

    const moved = new THREE.CatmullRomCurve3([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 4, 0)]);
    const after = CURVE_TO_MESH_NODE.evaluate({ curve: moved }, CURVE_TO_MESH_NODE.defaultParams, ctx);

    expect(((after.geometry as THREE.Group).children[0] as THREE.Mesh).geometry).not.toBe(beforeGeometry);
  });
});

describe("CURVE_TO_MESH_NODE surface mode", () => {
  const ctx: EvalContext = { time: 0, step: 0, nodeId: "curve-surface-1" };
  const closedCurve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-2, 0, -2),
      new THREE.Vector3(2, 0, -2),
      new THREE.Vector3(2, 0, 2),
      new THREE.Vector3(-2, 0, 2),
    ],
    true
  );

  it("adds a filled surface mesh to the group when surface is on and the curve is closed", () => {
    const res = CURVE_TO_MESH_NODE.evaluate(
      { curve: closedCurve },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: true, depth: 0.5 },
      ctx
    );
    const group = res.geometry as THREE.Group;
    expect(group.children).toHaveLength(2);
    const surface = group.children[1] as THREE.Mesh;
    expect(surface).toBeInstanceOf(THREE.Mesh);
    expect(surface.geometry.attributes.position.count).toBeGreaterThan(3);
    // Depth is real: the solid spans ~0.5 along the loop's normal (here +Y).
    surface.geometry.computeBoundingBox();
    const bb = surface.geometry.boundingBox!;
    expect(bb.max.y - bb.min.y).toBeCloseTo(0.5, 1);
  });

  it("hides the tube when surface is on and Show Curve is off", () => {
    const res = CURVE_TO_MESH_NODE.evaluate(
      { curve: closedCurve },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: true, showCurve: false },
      ctx
    );
    const group = res.geometry as THREE.Group;
    expect(group.children[0].visible).toBe(false);
    expect(group.children[1].visible).toBe(true);
  });

  it("does not build a surface when the curve is open", () => {
    const openCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-2, 0, -2),
      new THREE.Vector3(2, 0, -2),
      new THREE.Vector3(2, 0, 2),
    ]);
    const res = CURVE_TO_MESH_NODE.evaluate(
      { curve: openCurve },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: true },
      ctx
    );
    expect((res.geometry as THREE.Group).children).toHaveLength(1);
  });

  it("Closed checkbox closes the built-in fallback curve (so Surface can build)", () => {
    // No curve wired → uses its own pointsList; Closed now shapes it.
    const open = CURVE_TO_MESH_NODE.evaluate(
      {},
      { ...CURVE_TO_MESH_NODE.defaultParams, closed: false, surface: true },
      ctx
    );
    expect((open.geometry as THREE.Group).children).toHaveLength(1);

    const closed = CURVE_TO_MESH_NODE.evaluate(
      {},
      { ...CURVE_TO_MESH_NODE.defaultParams, closed: true, surface: true },
      ctx
    );
    expect((closed.geometry as THREE.Group).children).toHaveLength(2);
  });

  it("laplacian surface mode follows a non-planar boundary instead of flattening it", () => {
    // A boundary that lifts out of the plane: z is not constant.
    const boundary = [
      new THREE.Vector3(-2, -2, 0),
      new THREE.Vector3(2, -2, 0),
      new THREE.Vector3(2, 2, 3),
      new THREE.Vector3(-2, 2, 3),
    ];
    const curve = new THREE.CatmullRomCurve3(boundary, true);

    const res = CURVE_TO_MESH_NODE.evaluate(
      { curve },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: true, surfaceMode: "laplacian", surfaceRings: 6, surfaceIterations: 80 },
      ctx
    );
    const group = res.geometry as THREE.Group;
    const surface = group.children[1] as THREE.Mesh;
    expect(surface).toBeInstanceOf(THREE.Mesh);
    // The relaxed surface interpolates the boundary, so its z range spans the
    // boundary's z range (0..3) rather than collapsing to a single plane.
    const pos = surface.geometry.attributes.position;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    expect(minZ).toBeLessThan(0.5);
    expect(maxZ).toBeGreaterThan(2.5);
    expect(surface.geometry.index).not.toBeNull();
  });

  it("planar laplacian surface has consistent, non-flipped normals (no dark disc at the centre)", () => {
    const boundary = [
      new THREE.Vector3(-2, -2, 0),
      new THREE.Vector3(2, -2, 0),
      new THREE.Vector3(2, 2, 0),
      new THREE.Vector3(-2, 2, 0),
    ];
    const curve = new THREE.CatmullRomCurve3(boundary, true);
    const res = CURVE_TO_MESH_NODE.evaluate(
      { curve },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: true, surfaceMode: "laplacian", surfaceRings: 6, surfaceIterations: 60 },
      ctx
    );
    const surface = (res.geometry as THREE.Group).children[1] as THREE.Mesh;
    const normals = surface.geometry.attributes.normal;
    // Every normal should point along +Z (a flat surface): all roughly parallel.
    for (let i = 0; i < normals.count; i++) {
      expect(normals.getZ(i)).toBeGreaterThan(0.99);
    }
  });

  it("applies an independent surface material via the surfaceMaterial socket", () => {
    const surfMat = { color: new THREE.Color(0xff0000), roughness: 0.9, opacity: 1.0 };
    const res = CURVE_TO_MESH_NODE.evaluate(
      { curve: closedCurve, surfaceMaterial: surfMat },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: true },
      ctx
    );
    const group = res.geometry as THREE.Group;
    const surface = group.children[1] as THREE.Mesh;
    expect((surface.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
  });

  it("routes the diffuse texture to the curve when surface is off, and to the surface when it is on", () => {
    const texture = new THREE.Texture();
    texture.image = { width: 1, height: 1 };

    // Surface off → the curve carries the texture.
    const off = CURVE_TO_MESH_NODE.evaluate(
      { curve: closedCurve, texture },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: false },
      ctx
    );
    const offGroup = off.geometry as THREE.Group;
    expect(((offGroup.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBe(texture);

    // Surface on → the texture moves to the surface; the curve has none.
    const on = CURVE_TO_MESH_NODE.evaluate(
      { curve: closedCurve, texture },
      { ...CURVE_TO_MESH_NODE.defaultParams, surface: true },
      ctx
    );
    const onGroup = on.geometry as THREE.Group;
    expect(((onGroup.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBeNull();
    expect(((onGroup.children[1] as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBe(texture);
  });
});

describe("curve preview line geometry output", () => {
  const ctx: EvalContext = { time: 0, step: 0, nodeId: "curve-preview-1" };

  it("Curve from Points exposes the curve as a dark-gray preview line", () => {
    const res = CURVE_FROM_POINTS_NODE.evaluate(
      {
        points: [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1, 2, 0),
          new THREE.Vector3(2, 0, 0),
        ],
      },
      { type: "catmull" },
      ctx
    );
    const line = res.geometry as THREE.Line;
    expect(line).toBeInstanceOf(THREE.Line);
    expect(line.geometry.attributes.position.count).toBeGreaterThan(8);
    expect((line.material as THREE.LineBasicMaterial).color.getHex()).toBe(0x9ca3af);
  });

  it("Curve Primitive exposes the curve as a preview line", () => {
    const res = CURVE_PRIMITIVE_NODE.evaluate(
      {},
      { primitiveType: "circle", radius: 2 },
      ctx
    );
    const line = res.geometry as THREE.Line;
    expect(line).toBeInstanceOf(THREE.Line);
    expect(line.geometry.attributes.position.count).toBeGreaterThan(8);
  });
});

describe("CURVE_DEFORM_NODE placement", () => {
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 10)]);

  function boxAt(offsetY: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 4), new THREE.MeshStandardMaterial());
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeTranslation(0, offsetY, 0);
    return mesh;
  }

  function centroid(mesh: THREE.Mesh): THREE.Vector3 {
    const position = mesh.geometry.attributes.position;
    const sum = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) sum.add(v.fromBufferAttribute(position, i));
    // Through the mesh's own matrix, which is affine, so the centroid of the
    // transformed vertices is the transformed centroid. The deformed geometry
    // is recentred on its own origin with the offset carried on the matrix, so
    // the vertices alone no longer say where the object is.
    return sum.divideScalar(position.count).applyMatrix4(mesh.matrix);
  }

  it("honours the source object's own transform instead of deforming it as if at the origin", () => {
    const low = CURVE_DEFORM_NODE.evaluate(
      { geometry: boxAt(0), curve },
      CURVE_DEFORM_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "deform-low" }
    );
    const high = CURVE_DEFORM_NODE.evaluate(
      { geometry: boxAt(5), curve },
      CURVE_DEFORM_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "deform-high" }
    );

    // The offset survives into the deformed result — which axis it lands on
    // depends on the curve's Frenet frame, so distance is what is asserted.
    const moved = centroid(high.geometry as THREE.Mesh).distanceTo(centroid(low.geometry as THREE.Mesh));
    expect(moved).toBeCloseTo(5, 4);
  });

  it("applies its own pose to the result, so the gizmo has something to drag", () => {
    const res = CURVE_DEFORM_NODE.evaluate(
      { geometry: boxAt(0), curve },
      { ...CURVE_DEFORM_NODE.defaultParams, location: new THREE.Vector3(3, 0, 0) },
      { time: 0, step: 0, nodeId: "deform-posed" }
    );

    const offset = new THREE.Vector3().setFromMatrixPosition((res.geometry as THREE.Mesh).matrix);
    expect(offset.x).toBeCloseTo(3, 5);
  });

  it("reuses one mesh across frames rather than leaking a copy per evaluate", () => {
    const ctx: EvalContext = { time: 0, step: 0, nodeId: "deform-reuse" };
    const box = boxAt(0);

    const first = CURVE_DEFORM_NODE.evaluate({ geometry: box, curve }, CURVE_DEFORM_NODE.defaultParams, ctx);
    const second = CURVE_DEFORM_NODE.evaluate({ geometry: box, curve }, CURVE_DEFORM_NODE.defaultParams, ctx);

    expect(second.geometry).toBe(first.geometry);
  });
});

describe("Curve nodes declare a Visible socket (evaluate.ts applies it generically)", () => {
  it("Curve from Points and Curve Primitive both declare Visible", () => {
    for (const def of [CURVE_FROM_POINTS_NODE, CURVE_PRIMITIVE_NODE]) {
      expect(def.inputs.some((i) => i.id === "visible")).toBe(true);
      expect(def.defaultParams.visible).toBe(1);
    }
  });

  it("end-to-end: Visible=0 actually hides Curve from Points' preview geometry, via the real evaluator", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "c1",
          type: CURVE_FROM_POINTS_NODE.type,
          params: { ...CURVE_FROM_POINTS_NODE.defaultParams, visible: 0, pointsList: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] },
          position: { x: 0, y: 0 },
        },
      ],
      connections: [],
    };
    const results = evaluateGraph(graph, createRegistry([CURVE_FROM_POINTS_NODE]), CTX);
    const preview = results.get("c1")?.geometry as THREE.Object3D;
    expect(preview.visible).toBe(false);
  });
});

describe("Curve from Points -> Curve to Mesh: animating Sag actually rebuilds the tube", () => {
  it("regression: SaggedLineCurve3 had no toJSON() override, so curve.toJSON() looked identical at every sag value — Curve to Mesh's rebuild guard (keyed on JSON.stringify(curve.toJSON())) never fired, and the meshed tube stayed frozen while the raw curve preview (which resamples fresh every frame) visibly moved", () => {
    const points = [new THREE.Vector3(0, 5, 0), new THREE.Vector3(10, 5, 0), new THREE.Vector3(20, 5, 0)];

    const flat = CURVE_FROM_POINTS_NODE.evaluate({ points }, { ...CURVE_FROM_POINTS_NODE.defaultParams, sag: 0 }, CTX);
    const flatMesh = CURVE_TO_MESH_NODE.evaluate({ curve: flat.curve }, CURVE_TO_MESH_NODE.defaultParams, CTX)
      .geometry as THREE.Group;
    const flatBox = new THREE.Box3().setFromObject(flatMesh);

    const sagged = CURVE_FROM_POINTS_NODE.evaluate({ points }, { ...CURVE_FROM_POINTS_NODE.defaultParams, sag: 3 }, CTX);
    const saggedMesh = CURVE_TO_MESH_NODE.evaluate({ curve: sagged.curve }, CURVE_TO_MESH_NODE.defaultParams, CTX)
      .geometry as THREE.Group;
    const saggedBox = new THREE.Box3().setFromObject(saggedMesh);

    // A sagging tube dips well below a flat one — same node instance/state
    // reused across both calls (CTX has a fixed nodeId), so this only passes
    // if the rebuild guard actually saw the curves as different.
    expect(saggedBox.min.y).toBeLessThan(flatBox.min.y - 1);
  });
});

/**
 * Radial wall thickness of a flat, Y-up ring tube: (outermost - innermost
 * vertex distance from the Y axis) / 2, among vertices near `centerRadius`
 * (default: all of them — correct for a mesh holding a single ring; pass an
 * explicit `centerRadius`/`band` to isolate one ring out of a merged
 * multi-ring mesh, since a global min/max there would span the whole stack
 * of rings instead of one tube's own cross-section).
 */
function ringWallThickness(group: THREE.Group, centerRadius = Infinity, band = 0.3): number {
  let mesh: THREE.Mesh | null = null;
  group.traverse((obj) => {
    if (!mesh && obj instanceof THREE.Mesh) mesh = obj;
  });
  if (!mesh) throw new Error("no mesh found in group");
  const position = (mesh as THREE.Mesh).geometry.attributes.position;
  let minR = Infinity;
  let maxR = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const r = Math.hypot(v.x, v.z);
    if (Number.isFinite(centerRadius) && Math.abs(r - centerRadius) > band) continue;
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }
  return (maxR - minR) / 2;
}

describe("CURVE_ARRAY_NODE", () => {
  it("duplicates the input curve Count times, scaled by Start + i*Step (Spacing off)", () => {
    const circle = CURVE_PRIMITIVE_NODE.evaluate({}, { primitiveType: "circle", radius: 2 }, CTX).curve as THREE.Curve<THREE.Vector3>;
    const res = CURVE_ARRAY_NODE.evaluate({ curve: circle }, { count: 4, spacing: 0, start: 1, step: 0.5 }, CTX);

    expect(res.scales).toEqual([1, 1.5, 2, 2.5]);
    expect(res.offsets).toEqual([0, 0, 0, 0]);
    const curves = res.curves as THREE.Curve<THREE.Vector3>[];
    expect(curves).toHaveLength(4);

    // Each copy is the base curve scaled about the local origin — a point
    // at radius R on the base sits at radius R*scale on copy i.
    const basePoint = circle.getPoint(0);
    for (let i = 0; i < curves.length; i++) {
      const scaled = curves[i].getPoint(0);
      expect(scaled.x).toBeCloseTo(basePoint.x * (1 + i * 0.5), 5);
      expect(scaled.z).toBeCloseTo(basePoint.z * (1 + i * 0.5), 5);
    }
  });

  it("Spacing pushes each copy outward by i*Spacing world units, independent of the base curve's own radius", () => {
    const smallCircle = CURVE_PRIMITIVE_NODE.evaluate({}, { primitiveType: "circle", radius: 1 }, CTX).curve as THREE.Curve<THREE.Vector3>;
    const bigCircle = CURVE_PRIMITIVE_NODE.evaluate({}, { primitiveType: "circle", radius: 50 }, CTX).curve as THREE.Curve<THREE.Vector3>;
    const params = { count: 4, spacing: 0.5, start: 1, step: 0 };

    const fromSmall = CURVE_ARRAY_NODE.evaluate({ curve: smallCircle }, params, CTX);
    const fromBig = CURVE_ARRAY_NODE.evaluate({ curve: bigCircle }, params, CTX);

    expect(fromSmall.offsets).toEqual([0, 0.5, 1, 1.5]);
    expect(fromBig.offsets).toEqual([0, 0.5, 1, 1.5]); // same, regardless of base radius (1 vs 50)

    // Radius 1 circle, copy 2 (offset 1): radius becomes exactly 1*1 + 1 = 2.
    const curves = fromSmall.curves as THREE.Curve<THREE.Vector3>[];
    const p = curves[2].getPoint(0);
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(2, 5);
  });

  it("no curve wired, or Count 0: empty lists, no throw", () => {
    const noCurve = CURVE_ARRAY_NODE.evaluate({}, { count: 5, spacing: 0, start: 1, step: 1 }, CTX);
    expect(noCurve.curves).toEqual([]);
    expect(noCurve.scales).toEqual([]);
    expect(noCurve.offsets).toEqual([]);

    const circle = CURVE_PRIMITIVE_NODE.evaluate({}, { primitiveType: "circle", radius: 2 }, CTX).curve as THREE.Curve<THREE.Vector3>;
    const zeroCount = CURVE_ARRAY_NODE.evaluate({ curve: circle }, { count: 0, spacing: 0, start: 1, step: 1 }, CTX);
    expect(zeroCount.curves).toEqual([]);
  });

  it("regression: a bigger ring keeps the SAME tube thickness — the bug this node exists to fix", () => {
    // Instance Transform's per-instance Scale grows a baked tube MESH
    // uniformly, so its wall thickness grows right along with its radius.
    // Curve Array scales the CURVE before meshing instead, so Curves to
    // Meshes' one shared Thickness stays the tube's actual thickness no
    // matter how big the ring gets.
    const circle = CURVE_PRIMITIVE_NODE.evaluate({}, { primitiveType: "circle", radius: 2 }, CTX).curve as THREE.Curve<THREE.Vector3>;
    const { curves } = CURVE_ARRAY_NODE.evaluate({ curve: circle }, { count: 3, spacing: 0, start: 1, step: 2 }, CTX) as {
      curves: THREE.Curve<THREE.Vector3>[];
    };

    const innerMesh = CURVE_TO_MESH_NODE.evaluate({ curve: curves[0] }, { ...CURVE_TO_MESH_NODE.defaultParams, thickness: 0.1 }, {
      time: 0,
      step: 0,
      nodeId: "ring-inner",
    }).geometry as THREE.Group;
    const outerMesh = CURVE_TO_MESH_NODE.evaluate({ curve: curves[2] }, { ...CURVE_TO_MESH_NODE.defaultParams, thickness: 0.1 }, {
      time: 0,
      step: 0,
      nodeId: "ring-outer",
    }).geometry as THREE.Group;

    // curves[0] is radius 2 (scale 1), curves[2] is radius 10 (scale 5) — a
    // 5x bigger ring. Discretized tube cross-sections (finite radialSegments)
    // systematically undershoot the nominal Thickness a bit, so compare the
    // two measured thicknesses to each other rather than to the nominal
    // 0.1 — that's the actual property this node exists to guarantee: wall
    // thickness independent of ring radius, not exact discretization fidelity.
    const innerThickness = ringWallThickness(innerMesh);
    const outerThickness = ringWallThickness(outerMesh);
    expect(innerThickness).toBeGreaterThan(0.05); // sanity: actually built a tube, not a flat line
    expect(outerThickness).toBeCloseTo(innerThickness, 2);
  });

  it("end-to-end through Curves to Meshes: one shared Thickness, N different radii", () => {
    const circle = CURVE_PRIMITIVE_NODE.evaluate({}, { primitiveType: "circle", radius: 1 }, CTX).curve as THREE.Curve<THREE.Vector3>;
    const { curves } = CURVE_ARRAY_NODE.evaluate({ curve: circle }, { count: 5, spacing: 0, start: 1, step: 1 }, CTX) as {
      curves: THREE.Curve<THREE.Vector3>[];
    };

    const res = CURVES_TO_MESH_NODE.evaluate(
      { curves },
      { ...CURVES_TO_MESH_NODE.defaultParams, thickness: 0.08 },
      { time: 0, step: 0, nodeId: "web-mesh" },
    );
    const group = res.geometry as THREE.Group;
    // Radii are 1, 2, 3, 4, 5 (Start=1, Step=1) — isolate the innermost and
    // outermost rings out of the merged mesh and compare their thicknesses
    // to each other (see the regression test above for why not to a fixed
    // nominal value).
    const innerThickness = ringWallThickness(group, 1);
    const outerThickness = ringWallThickness(group, 5);
    expect(innerThickness).toBeGreaterThan(0.03);
    expect(outerThickness).toBeCloseTo(innerThickness, 2);
  });
});
