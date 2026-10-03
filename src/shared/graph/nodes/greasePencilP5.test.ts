import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { EvalContext } from "../types";
import { GREASE_PENCIL_NODE, GreaseStroke } from "./greasePencil";
import { GreaseP5Options, buildGreaseP5Geometry, buildGreaseP5Layout, isP5GreaseBrush } from "./greasePencilP5";
import { GEOMETRY_WAVE_RIPPLE_NODE } from "./geometryDeform";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "gp-p5" };

const OPTS: GreaseP5Options = {
  density: 256,
  maxTextureSize: 4096,
  seed: 1,
  opacity: 150,
  bleed: 0.3,
  texture: 0.5,
  border: 0.4,
  defaultColor: "#000000",
  defaultWidth: 4,
};

function stroke(brushType: GreaseStroke["brushType"], extra: Partial<GreaseStroke> = {}): GreaseStroke {
  return {
    id: `s-${brushType}`,
    brushType,
    color: "#aa3300",
    points: [
      { x: -1, y: 0, z: 0, pressure: 0.5 },
      { x: 0, y: 1, z: 0, pressure: 1 },
      { x: 1, y: 0, z: 0, pressure: 0.5 },
    ],
    ...extra,
  };
}

describe("greasePencilP5", () => {
  test("recognises only p5 media", () => {
    expect(isP5GreaseBrush("p5:charcoal")).toBe(true);
    expect(isP5GreaseBrush("p5:watercolor")).toBe(true);
    expect(isP5GreaseBrush("charcoal")).toBe(false);
    expect(isP5GreaseBrush("p5:bogus")).toBe(false);
  });

  test("no p5 strokes means no layer", () => {
    expect(buildGreaseP5Layout([stroke("ink_pen")], OPTS)).toBeNull();
    expect(buildGreaseP5Layout([], OPTS)).toBeNull();
  });

  test("the quad covers the strokes with room for bleed", () => {
    const layout = buildGreaseP5Layout([stroke("p5:2B")], OPTS)!;
    expect(layout.width).toBeGreaterThan(2);
    expect(layout.height).toBeGreaterThan(1);
    expect(layout.center.x).toBeCloseTo(0);
    expect(layout.center.y).toBeCloseTo(0.5);
    for (const [x, y] of layout.scene.paths[0].points) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(layout.scene.width);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(layout.scene.height);
    }
  });

  test("world +y is canvas up", () => {
    const [path] = buildGreaseP5Layout([stroke("p5:2B")], OPTS)!.scene.paths;
    const apex = path.points[1];
    expect(apex[1]).toBeLessThan(path.points[0][1]);
  });

  test("each stroke keeps its own medium, colour and fill", () => {
    const layout = buildGreaseP5Layout(
      [
        stroke("p5:charcoal"),
        stroke("p5:watercolor", { color: "#0044aa" }),
        stroke("p5:HB", { fill: true, fillColor: "#ffcc00" }),
        stroke("ink_pen"),
      ],
      OPTS,
    )!;
    const [charcoal, wash, filled] = layout.scene.paths;
    expect(layout.scene.paths).toHaveLength(3);
    expect(charcoal.stroke).toMatchObject({ enabled: true, brush: "charcoal", color: "#aa3300" });
    expect(charcoal.fill?.mode).toBe("none");
    expect(wash).toMatchObject({ closed: true, stroke: { enabled: false }, fill: { mode: "watercolor", color: "#0044aa" } });
    expect(filled).toMatchObject({ closed: true, fill: { mode: "watercolor", color: "#ffcc00" } });
  });

  test("density yields to the texture size cap without changing world size", () => {
    const huge = stroke("p5:2B", {
      points: [
        { x: -500, y: 0, z: 0, pressure: 1 },
        { x: 500, y: 0, z: 0, pressure: 1 },
      ],
    });
    const layout = buildGreaseP5Layout([huge], OPTS)!;
    expect(Math.max(layout.scene.width, layout.scene.height)).toBeLessThanOrEqual(4096);
    expect(layout.width).toBeGreaterThan(1000);
  });

  test("Grease Pencil keeps p5 strokes off its vector ribbons and stays headless-safe", () => {
    const frames = [{ frame: 0, strokes: [stroke("p5:charcoal")] }];
    const out = GREASE_PENCIL_NODE.evaluate({}, { ...GREASE_PENCIL_NODE.defaultParams, frames }, CTX);
    const group = out.geometry as THREE.Group;
    const ribbons = group.children.filter((c) => c instanceof THREE.Mesh && c.visible && c.renderOrder === 10);
    expect(ribbons).toHaveLength(0);
    expect(Array.isArray(out.curves) && out.curves.length).toBe(1);
  });

  test("ground-drawn strokes get an XZ quad at their height", () => {
    const ground = stroke("p5:2B", {
      points: [
        { x: -1, y: 0.5, z: 0, pressure: 1 },
        { x: 0, y: 0.5, z: -1, pressure: 1 },
        { x: 1, y: 0.5, z: 0, pressure: 1 },
      ],
    });
    const layout = buildGreaseP5Layout([ground], OPTS)!;
    expect(layout.plane).toBe("xz");
    expect(layout.center.y).toBeCloseTo(0.5);
    expect(layout.center.z).toBeCloseTo(-0.5);
    // -Z reads as "up" on the canvas, like a top view.
    const [path] = layout.scene.paths;
    expect(path.points[1][1]).toBeLessThan(path.points[0][1]);
  });

  test("the painted grid carries its pose in its vertices, subdivided for deformers", () => {
    const layout = buildGreaseP5Layout([stroke("p5:2B")], OPTS)!;
    const geometry = buildGreaseP5Geometry(layout);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.x - box.min.x).toBeCloseTo(layout.width);
    expect(box.max.y - box.min.y).toBeCloseTo(layout.height);
    expect((box.max.x + box.min.x) / 2).toBeCloseTo(layout.center.x);
    expect((box.max.y + box.min.y) / 2).toBeCloseTo(layout.center.y);
    expect(geometry.attributes.position.count).toBeGreaterThan(100);
  });

  test("a ground painting's grid lies in XZ", () => {
    const layout = buildGreaseP5Layout(
      [stroke("p5:2B", { points: [{ x: -1, y: 0.5, z: 0, pressure: 1 }, { x: 1, y: 0.5, z: -2, pressure: 1 }] })],
      OPTS,
    )!;
    const geometry = buildGreaseP5Geometry(layout);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.y - box.min.y).toBeCloseTo(0);
    expect(box.min.y).toBeCloseTo(0.5);
    expect(box.max.z - box.min.z).toBeCloseTo(layout.height);
  });

  test("Wave / Ripple bends the painting where it is instead of collapsing it", () => {
    const layout = buildGreaseP5Layout([stroke("p5:2B")], OPTS)!;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(buildGreaseP5Geometry(layout), new THREE.MeshBasicMaterial()));
    const out = GEOMETRY_WAVE_RIPPLE_NODE.evaluate(
      { geometry: group },
      { ...GEOMETRY_WAVE_RIPPLE_NODE.defaultParams, mode: "linear", amplitude: 0.2 },
      { ...CTX, nodeId: "wave-p5", time: 0.3 },
    );
    const deformed = new THREE.Box3().setFromObject(out.geometry as THREE.Object3D);
    expect(deformed.max.x - deformed.min.x).toBeCloseTo(layout.width, 1);
    const base = buildGreaseP5Geometry(layout).attributes.position;
    const moved = (out.geometry as THREE.Object3D).getObjectsByProperty("isMesh", true)[0] as THREE.Mesh;
    let changed = 0;
    for (let i = 0; i < base.count; i++) if (Math.abs(moved.geometry.attributes.position.getY(i) - base.getY(i)) > 1e-3) changed++;
    expect(changed).toBeGreaterThan(base.count / 2);
  });
});

