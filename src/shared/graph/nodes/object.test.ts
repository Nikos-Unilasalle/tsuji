import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { OBJECT_BOX_NODE, OBJECT_CYLINDER_NODE, OBJECT_DISC_NODE, OBJECT_PLANE_NODE, OBJECT_POLYGON_NODE, OBJECT_TEXT_NODE } from "./object";
import { BUILTIN_FONTS, FONT_NAMES } from "../../three/fonts/fonts";
import helvetikerData from "../../three/fonts/helvetikerData.json";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "text-test" };

describe("OBJECT_TEXT_NODE font", () => {
  it("builds extruded text geometry with the default font", () => {
    const res = OBJECT_TEXT_NODE.evaluate(
      { text: "hello", fontSize: 32 },
      { ...OBJECT_TEXT_NODE.defaultParams, text: "hello", fontSize: 32 },
      CTX,
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
  });

  it("exposes bundled fonts in the menu and builds text with a preset", () => {
    expect(FONT_NAMES).toContain("Helvetiker");
    expect(FONT_NAMES.length).toBeGreaterThanOrEqual(5);
    expect(BUILTIN_FONTS["Lobster"]).toBeDefined();

    const res = OBJECT_TEXT_NODE.evaluate(
      { text: "hello" },
      { ...OBJECT_TEXT_NODE.defaultParams, fontPreset: "Lobster", text: "hello" },
      CTX,
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
  });

  it("uses a font loaded via the Font (.json) field and re-extrudes", () => {
    const first = OBJECT_TEXT_NODE.evaluate({ text: "hi" }, OBJECT_TEXT_NODE.defaultParams, CTX);
    const g1 = (first.geometry as THREE.Mesh).geometry;

    // Load a font through the file field's onLoaded (same helvetiker JSON).
    const instance = { id: "text-test", type: "object/text", position: { x: 0, y: 0 }, params: {} } as never;
    const fields = OBJECT_TEXT_NODE.dynamicParamFields!(instance);
    const fontField = fields.find((f) => f.id === "fontPath") as { onLoaded?: (n: string, p: string, c: unknown) => void };
    fontField.onLoaded?.("text-test", "helvetiker.json", JSON.stringify(helvetikerData));

    const second = OBJECT_TEXT_NODE.evaluate({ text: "hi" }, OBJECT_TEXT_NODE.defaultParams, CTX);
    const g2 = (second.geometry as THREE.Mesh).geometry;
    // A new font object must trigger a re-extrude (new geometry instance).
    expect(g2).not.toBe(g1);
    expect(g2.attributes.position.count).toBeGreaterThan(0);
  });
});

describe("scalar angle sockets take degrees when wired", () => {
  // The panel edits these in degrees and stores radians (degrees: true, see
  // ParamPanel's toStoredUnit). A wired Value node carries a plain unitless
  // number, so reading it raw meant "36" typed by hand and "36" arriving on a
  // wire were different angles — 36° versus 36 radians.
  // The evaluator fills EVERY socket, wired or not — an unconnected one from
  // the node's own params — so a test that only sets `inputs` is not modelling
  // a wire at all. connectedInputs is what actually says "driven", and it is
  // what the degrees conversion keys off.
  const disc = (
    inputs: Record<string, unknown>,
    params: Record<string, unknown> = {},
    connected: string[] = Object.keys(inputs),
  ) => {
    const merged = { ...OBJECT_DISC_NODE.defaultParams, ...params };
    return OBJECT_DISC_NODE.evaluate(
      // Mirror the evaluator: unconnected sockets arrive holding the param.
      { ...merged, ...inputs },
      merged,
      {
        ...CTX,
        nodeId: `disc-${JSON.stringify(inputs)}-${JSON.stringify(params)}-${connected.join()}`,
        connectedInputs: new Set(connected),
      },
    );
  };

  function arcSpanX(res: Record<string, unknown>): number {
    const mesh = res.geometry as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    return box.max.x - box.min.x;
  }

  it("a wired 90 on Arc Angle is a quarter turn, the same as typing 90", () => {
    const wired = disc({ arcAngle: 90 });
    const typed = disc({}, { arcAngle: Math.PI / 2 });
    expect(arcSpanX(wired)).toBeCloseTo(arcSpanX(typed), 5);
  });

  it("a wired 180 on Start Angle matches typing 180, not 180 radians", () => {
    const wired = disc({ startAngle: 180, arcAngle: 90 });
    const typed = disc({}, { startAngle: Math.PI, arcAngle: Math.PI / 2 });
    const asRadians = disc({}, { startAngle: 180, arcAngle: Math.PI / 2 });
    const w = arcSpanX(wired);
    expect(w).toBeCloseTo(arcSpanX(typed), 5);
    // 180 rad wraps to a different part of the circle — proof the raw value
    // is not simply being passed through.
    expect(Math.abs(w - arcSpanX(asRadians))).toBeGreaterThan(1e-3);
  });

  it("leaves the stored param alone — an unwired disc still reads radians", () => {
    // Both span the full diameter in X, so compare the half that a 0..π arc
    // actually drops: its lower half.
    const minY = (res: Record<string, unknown>) => {
      const mesh = res.geometry as THREE.Mesh;
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox!.min.y;
    };
    const full = disc({}, { arcAngle: Math.PI * 2 });
    const half = disc({}, { arcAngle: Math.PI });
    expect(minY(full)).toBeLessThan(-0.1);
    expect(minY(half)).toBeCloseTo(0, 3);

    // The regression this guards: converting the *unwired* socket too, which
    // is filled from the param, applied the panel's degrees->radians a second
    // time. A freshly dropped Disc then needed ~10300 in Arc Angle to reach
    // half a circle.
    const fresh = disc({}, {});
    expect(minY(fresh)).toBeLessThan(-0.1);
  });

  it("a wired 360 fills the circle, where a wired 6.28 would be a hair of one", () => {
    const wired = disc({ arcAngle: 360 });
    const typed = disc({}, { arcAngle: Math.PI * 2 });
    expect(arcSpanX(wired)).toBeCloseTo(arcSpanX(typed), 5);
  });
});

describe("flat primitives lie flat", () => {
  /** The world-space direction a flat primitive's face points, from its own matrix. */
  function faceNormal(res: Record<string, unknown>): THREE.Vector3 {
    const mesh = res.geometry as THREE.Mesh;
    return new THREE.Vector3(0, 0, 1)
      .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(mesh.matrix))
      .normalize();
  }

  it("a fresh Plane and Disc face UP, not sideways", () => {
    // three builds every flat shape in XY facing +Z, which in a Y-up world
    // stands a new one on its edge like a billboard. -90 degrees about X is
    // what lays it down; +90 also lays it down but leaves the normal facing
    // the ground, which lights it from underneath.
    for (const [name, def] of [["plane", OBJECT_PLANE_NODE], ["disc", OBJECT_DISC_NODE]] as const) {
      const res = def.evaluate({}, def.defaultParams, { ...CTX, nodeId: `flat-${name}` });
      expect(faceNormal(res).y, `${name} should face up`).toBeCloseTo(1, 5);
    }
  });

  it("Disc's flat default survives its own trailing spread", () => {
    // Disc spreads COMMON_DEFAULT_PARAMS *last*, so a leading flat default was
    // silently overwritten and the disc stayed upright — the shape of bug that
    // only shows as "nothing happened".
    const rot = OBJECT_DISC_NODE.defaultParams.rotation as THREE.Vector3;
    expect(rot.x).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe("Plane topology", () => {
  it("Segments subdivides it, so Edit Mesh Points has interior vertices to grab", () => {
    // A one-quad plane is editable in name only: four corners, nothing between.
    for (const segments of [1, 2, 6]) {
      const res = OBJECT_PLANE_NODE.evaluate(
        {},
        { ...OBJECT_PLANE_NODE.defaultParams, segments },
        { ...CTX, nodeId: `plane-seg-${segments}` },
      );
      const g = (res.geometry as THREE.Mesh).geometry;
      expect(g.getAttribute("position").count).toBe((segments + 1) ** 2);
    }
  });

  it("defaults to a single quad, so raising Segments never re-maps existing point edits", () => {
    // Edit Mesh Points stores pointsList by vertex index; changing the
    // subdivision of a plane that already has edits would shuffle all of them.
    expect(OBJECT_PLANE_NODE.defaultParams.segments).toBe(1);
  });

  it("Inner cuts a hole through it — nothing is left inside the hole", () => {
    const inner = 0.3;
    const holed = OBJECT_PLANE_NODE.evaluate(
      {},
      { ...OBJECT_PLANE_NODE.defaultParams, innerRadius: inner, segments: 4 },
      { ...CTX, nodeId: "plane-holed" },
    );
    const pos = (holed.geometry as THREE.Mesh).geometry.getAttribute("position");

    let insideHole = 0;
    let onHoleEdge = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = Math.abs(pos.getX(i));
      const y = Math.abs(pos.getY(i));
      const within = Math.max(x, y);
      if (within < inner - 1e-6) insideHole++;
      if (Math.abs(within - inner) < 1e-6) onHoleEdge++;
    }
    expect(insideHole).toBe(0);
    expect(onHoleEdge).toBeGreaterThan(0);
  });

  it("Inner and Segments combine — the frame around the hole still subdivides", () => {
    // The hole used to force a triangulated Shape, which has no grid, so
    // Segments silently did nothing the moment Inner went above 0.
    const counts = [1, 2, 4].map((segments) => {
      const res = OBJECT_PLANE_NODE.evaluate(
        {},
        { ...OBJECT_PLANE_NODE.defaultParams, innerRadius: 0.25, segments },
        { ...CTX, nodeId: `plane-holed-seg-${segments}` },
      );
      return (res.geometry as THREE.Mesh).geometry.getAttribute("position").count;
    });
    expect(counts[1]).toBeGreaterThan(counts[0]);
    expect(counts[2]).toBeGreaterThan(counts[1]);
  });

  it("Depth extrudes it symmetrically, so thickening never shifts it off its plane", () => {
    const depth = 0.4;
    const res = OBJECT_PLANE_NODE.evaluate(
      {},
      { ...OBJECT_PLANE_NODE.defaultParams, depth },
      { ...CTX, nodeId: "plane-deep" },
    );
    const geom = (res.geometry as THREE.Mesh).geometry;
    geom.computeBoundingBox();
    const box = geom.boundingBox!;
    expect(box.min.z).toBeCloseTo(-depth / 2, 5);
    expect(box.max.z).toBeCloseTo(depth / 2, 5);
  });

  it("Depth 0 stays a flat sheet", () => {
    const res = OBJECT_PLANE_NODE.evaluate({}, OBJECT_PLANE_NODE.defaultParams, { ...CTX, nodeId: "plane-flat" });
    const geom = (res.geometry as THREE.Mesh).geometry;
    geom.computeBoundingBox();
    expect(geom.boundingBox!.min.z).toBeCloseTo(0, 5);
    expect(geom.boundingBox!.max.z).toBeCloseTo(0, 5);
  });

  it("Depth combines with Inner — an extruded frame, still hollow", () => {
    const inner = 0.3;
    const depth = 0.2;
    const res = OBJECT_PLANE_NODE.evaluate(
      {},
      { ...OBJECT_PLANE_NODE.defaultParams, innerRadius: inner, depth },
      { ...CTX, nodeId: "plane-deep-holed" },
    );
    const geom = (res.geometry as THREE.Mesh).geometry;
    const pos = geom.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const within = Math.max(Math.abs(pos.getX(i)), Math.abs(pos.getY(i)));
      expect(within).toBeGreaterThan(inner - 1e-6);
    }
    geom.computeBoundingBox();
    expect(geom.boundingBox!.min.z).toBeCloseTo(-depth / 2, 5);
  });

  it("clamps Inner short of the edge, so it can never erase the whole quad", () => {
    const res = OBJECT_PLANE_NODE.evaluate(
      {},
      { ...OBJECT_PLANE_NODE.defaultParams, innerRadius: 5 },
      { ...CTX, nodeId: "plane-huge-hole" },
    );
    expect((res.geometry as THREE.Mesh).geometry.getAttribute("position").count).toBeGreaterThan(0);
  });
});

describe("OBJECT_POLYGON_NODE", () => {
  const poly = (params: Record<string, unknown>, id: string) =>
    OBJECT_POLYGON_NODE.evaluate({}, { ...OBJECT_POLYGON_NODE.defaultParams, ...params }, { ...CTX, nodeId: id });

  /** Distinct corner directions in the XY plane — the count IS the side count. */
  function cornerCount(res: Record<string, unknown>): number {
    const g = (res.geometry as THREE.Mesh).geometry;
    const pos = g.getAttribute("position");
    const angles = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      if (Math.hypot(x, y) < 1e-4) continue; // the fan centre has no direction
      angles.add((Math.round((Math.atan2(y, x) * 180) / Math.PI * 100) / 100).toFixed(2));
    }
    return angles.size;
  }

  it("has exactly the number of corners asked for", () => {
    for (const sides of [3, 5, 6, 8]) {
      expect(cornerCount(poly({ sides }, `poly-${sides}`)), `${sides}-gon`).toBe(sides);
    }
  });

  it("lies flat like the other flat primitives", () => {
    const mesh = poly({}, "poly-flat").geometry as THREE.Mesh;
    const n = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(mesh.matrix))
      .normalize();
    expect(n.y).toBeCloseTo(1, 5);
  });

  it("Radius is the circumradius — corners sit on it", () => {
    const g = (poly({ sides: 6, radius: 2 }, "poly-r").geometry as THREE.Mesh).geometry;
    const pos = g.getAttribute("position");
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getY(i)));
    expect(maxR).toBeCloseTo(2, 4);
  });

  it("Inner Radius punches a hole that is itself a polygon, not a circle", () => {
    // An absarc hole would leave a round hole in a faceted plate; the corners
    // of the hole have to match the corners of the outline.
    const flat = poly({ sides: 5, innerRadius: 0.25 }, "poly-hole");
    expect(cornerCount(flat)).toBe(5);
    const extruded = poly({ sides: 5, innerRadius: 0.25, depth: 0.4 }, "poly-hole-deep");
    const g = (extruded.geometry as THREE.Mesh).geometry;
    const pos = g.getAttribute("position");
    let minR = Infinity;
    for (let i = 0; i < pos.count; i++) minR = Math.min(minR, Math.hypot(pos.getX(i), pos.getY(i)));
    // The hole really goes through: nothing sits at the centre.
    expect(minR).toBeGreaterThan(0.2);
  });

  it("Depth extrudes it into a prism of the same side count", () => {
    const g = (poly({ sides: 6, depth: 0.5 }, "poly-prism").geometry as THREE.Mesh).geometry;
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.max.z - box.min.z).toBeCloseTo(0.5, 4);
    // Centred on its own origin, like the Disc's extrusion.
    expect(box.max.z).toBeCloseTo(0.25, 4);
  });

  it("never degenerates below a triangle, however low Sides is driven", () => {
    for (const sides of [0, 1, 2, -5]) {
      const g = (poly({ sides }, `poly-min-${sides}`).geometry as THREE.Mesh).geometry;
      expect(g.getAttribute("position").count).toBeGreaterThan(2);
    }
  });
});

describe("primitive pivot", () => {
  it("stores userData.pivot on the returned mesh", () => {
    const res = OBJECT_BOX_NODE.evaluate(
      {},
      { ...OBJECT_BOX_NODE.defaultParams, pivot: new THREE.Vector3(0, -0.5, 0) },
      { nodeId: "box-piv-test" } as EvalContext,
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.userData.pivot).toBeDefined();
    expect(mesh.userData.pivot.y).toBe(-0.5);

    const cylRes = OBJECT_CYLINDER_NODE.evaluate(
      {},
      { ...OBJECT_CYLINDER_NODE.defaultParams, pivot: new THREE.Vector3(0, -1, 0) },
      { nodeId: "cyl-piv-test" } as EvalContext,
    );
    const cylMesh = cylRes.geometry as THREE.Mesh;
    expect(cylMesh.userData.pivot).toBeDefined();
    expect(cylMesh.userData.pivot.y).toBe(-1);
  });
});

