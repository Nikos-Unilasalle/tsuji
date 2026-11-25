import { describe, expect, it } from "vitest";
import { createQuadPlane } from "../quadMesh";
import { buildSkeleton, buildTubes, expandLSystem, interpretTurtle, parseRules } from "./lsystem";
import { erodeHeightfield } from "./erosion";
import { heatGeodesic } from "./heatGeodesic";
import { pointNeighbours } from "./selectOps";
import { readAttribute } from "./polyAttributes";

const TURTLE = { angle: 90, step: 1, stepScale: 1, widthScale: 1, jitter: 0, seed: 0, maxSegments: 1e6 };

describe("L-system", () => {
  it("parses rules and expands in parallel with generations", () => {
    const { rules, errors } = parseRules("A = AB\nB -> A\n\n# comment");
    expect(errors).toEqual([]);
    const e = expandLSystem("A", rules, 4);
    expect(e.symbols).toBe("ABAABABA");
    expect(e.generation.length).toBe(8);
    expect(Math.max(...e.generation)).toBe(4);
  });

  it("stops at the length cap", () => {
    const e = expandLSystem("F", parseRules("F=FF").rules, 30, 1000);
    expect(e.truncated).toBe(true);
    expect(e.symbols.length).toBeLessThanOrEqual(1000);
  });

  it("counts segments and builds connected branches", () => {
    const e = expandLSystem("F", parseRules("F=F[+F]F").rules, 2);
    // 3^2 = 9 F's.
    const t = interpretTurtle(e, TURTLE);
    expect(t.segments).toBe(9);
    const skel = buildSkeleton(t);
    expect(skel.edges!.length).toBe(9);
    // Branch points are shared: 9 segments in a tree need 10 points.
    expect(skel.positions.length).toBe(10);
    expect(readAttribute(skel, "point", "depth")!.values.some((d) => d === 2)).toBe(true);
    const tubes = buildTubes(t, { radius: 0.05, sides: 6, caps: true });
    expect(tubes.faces.length).toBe(9 * 6 + t.chains.length * 2);
    expect(readAttribute(tubes, "point", "generation")).toBeTruthy();
  });

  it("turns in 3-D and caps segments", () => {
    const t = interpretTurtle({ symbols: "F&F", generation: new Uint16Array(3) }, TURTLE);
    expect(t.points[2][2]).toBeCloseTo(-1, 6);
    const capped = interpretTurtle(expandLSystem("F", parseRules("F=FF").rules, 10), { ...TURTLE, maxSegments: 100 });
    expect(capped.segments).toBe(100);
    expect(capped.truncated).toBe(true);
  });
});

describe("erosion", () => {
  it("lowers peaks and keeps the vertex count", () => {
    const plane = createQuadPlane(4, 4, 24, 24);
    // Plane lies in XY or XZ: find its flat axis and raise a cone along it.
    const flat = [0, 1, 2].find((k) => plane.positions.every((p) => Math.abs(p[k]) < 1e-9))!;
    const up: [number, number, number] = [0, 0, 0];
    up[flat] = 1;
    const positions = plane.positions.map((p) => {
      const q = [...p] as [number, number, number];
      const r = Math.hypot(p[(flat + 1) % 3], p[(flat + 2) % 3]);
      q[flat] = Math.max(0, 1.5 - r);
      return q;
    });
    const peak = Math.max(...positions.map((p) => p[flat]));
    const res = erodeHeightfield(positions, pointNeighbours({ ...plane, positions }), {
      up, iterations: 4, droplets: 300, rain: 1, erosion: 0.3, deposition: 0.3, capacity: 4, evaporation: 0.05, maxSteps: 40,
      thermal: 2, talus: 30, thermalRate: 0.5, seed: 1,
    });
    expect(res.positions.length).toBe(positions.length);
    expect(Math.max(...res.positions.map((p) => p[flat]))).toBeLessThan(peak);
    expect(res.positions.flat().every(Number.isFinite)).toBe(true);
    expect(res.flow.some((f) => f > 0)).toBe(true);
  });
});

describe("heat geodesic", () => {
  it("is close to euclidean distance on a plane", () => {
    const plane = createQuadPlane(2, 2, 20, 20);
    const center = plane.positions.findIndex((p) => Math.hypot(...p) < 1e-9);
    expect(center).toBeGreaterThanOrEqual(0);
    const res = heatGeodesic(plane, [center]);
    expect(res.method).toBe("heat");
    let worst = 0;
    plane.positions.forEach((p, i) => {
      const r = Math.hypot(...p);
      if (r > 0.2 && r < 0.9) worst = Math.max(worst, Math.abs(res.distance[i] - r) / r);
    });
    expect(worst).toBeLessThan(0.12);
  });

  it("marks unreachable islands with -1", () => {
    const a = createQuadPlane(1, 1, 2, 2);
    const n = a.positions.length;
    const two = {
      positions: [...a.positions, ...a.positions.map((p) => [p[0] + 5, p[1], p[2]] as [number, number, number])],
      faces: [...a.faces, ...a.faces.map((f) => f.map((v) => v + n))],
    };
    const res = heatGeodesic(two, [0]);
    expect(res.distance[n + 1]).toBe(-1);
    expect(res.distance[1]).toBeGreaterThan(0);
  });
});
