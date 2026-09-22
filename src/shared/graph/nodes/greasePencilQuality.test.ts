import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  BRUSH_SHADER_ID,
  GreaseStroke,
  KeyframeDrawing,
  StrokePoint,
  applyStrokeEdgeAA,
  buildStrokesFillGeometry,
  buildStrokesRibbonGeometry,
  resampleStrokePoints,
} from "./greasePencil";
import { eraseStrokesCut, trimStrokeDwellTail } from "../../three/greasePencilDrawing";

function pt(x: number, z: number, pressure = 0.6): StrokePoint {
  return { x, y: 0, z, pressure };
}

function stroke(points: StrokePoint[], overrides: Partial<GreaseStroke> = {}): GreaseStroke {
  return { id: "s1", points, color: "#ffffff", width: 4, ...overrides };
}

describe("resampleStrokePoints", () => {
  it("densifies coarse tablet samples to the requested spacing", () => {
    const raw = [pt(0, 0), pt(1, 0), pt(2, 0), pt(3, 0)];
    const out = resampleStrokePoints(raw, 0.1);
    expect(out.length).toBeGreaterThan(25);

    for (let i = 1; i < out.length; i++) {
      const d = Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
      expect(d).toBeLessThanOrEqual(0.2);
    }
  });

  it("keeps the stroke endpoints exactly where the artist put them", () => {
    const raw = [pt(0, 0), pt(1, 2), pt(3, 1)];
    const out = resampleStrokePoints(raw, 0.05);
    expect(out[0].x).toBeCloseTo(0);
    expect(out[0].z).toBeCloseTo(0);
    expect(out[out.length - 1].x).toBeCloseTo(3);
    expect(out[out.length - 1].z).toBeCloseTo(1);
  });

  it("interpolates pressure along the resampled path", () => {
    const out = resampleStrokePoints([pt(0, 0, 0.1), pt(1, 0, 0.5), pt(2, 0, 1.0)], 0.1);
    expect(out[0].pressure).toBeCloseTo(0.1, 2);
    expect(out[out.length - 1].pressure).toBeCloseTo(1.0, 2);
    const mid = out[Math.floor(out.length / 2)].pressure;
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(1.0);
  });

  it("leaves short or degenerate strokes untouched", () => {
    const two = [pt(0, 0), pt(1, 0)];
    expect(resampleStrokePoints(two, 0.1)).toBe(two);
    const tiny = [pt(0, 0), pt(0.001, 0), pt(0.002, 0)];
    expect(resampleStrokePoints(tiny, 1).length).toBe(3);
  });

  it("spreads a hard corner over many small turns instead of one 90° kink", () => {
    const out = resampleStrokePoints([pt(0, 0), pt(1, 0), pt(1, 1)], 0.05);
    let maxTurn = 0;
    for (let i = 1; i < out.length - 1; i++) {
      const a = Math.atan2(out[i].z - out[i - 1].z, out[i].x - out[i - 1].x);
      const b = Math.atan2(out[i + 1].z - out[i].z, out[i + 1].x - out[i].x);
      let d = Math.abs(b - a);
      if (d > Math.PI) d = 2 * Math.PI - d;
      maxTurn = Math.max(maxTurn, d);
    }
    // The raw polyline turns 90° at one vertex; the resampled path must not.
    expect(maxTurn).toBeLessThan(Math.PI / 6);
  });
});

describe("buildStrokesRibbonGeometry", () => {
  it("emits the edge distance-field attribute used for anti-aliasing", () => {
    const geo = buildStrokesRibbonGeometry([stroke([pt(0, 0), pt(1, 0), pt(2, 0)])], "#ffffff", 4);
    const edge = geo.getAttribute("aEdge");
    expect(edge).toBeDefined();
    expect(edge.itemSize).toBe(2);
    expect(edge.count).toBe(geo.getAttribute("position").count);

    // Ribbon silhouette vertices sit at |edge| == 1.
    let sawLeft = false;
    let sawRight = false;
    for (let i = 0; i < edge.count; i++) {
      if (edge.getX(i) === -1 && edge.getY(i) === 0) sawLeft = true;
      if (edge.getX(i) === 1 && edge.getY(i) === 0) sawRight = true;
      expect(Math.hypot(edge.getX(i), edge.getY(i))).toBeLessThanOrEqual(1.0001);
    }
    expect(sawLeft && sawRight).toBe(true);
  });

  it("caps open strokes so the ends are round, not chopped", () => {
    const open = buildStrokesRibbonGeometry([stroke([pt(0, 0), pt(1, 0), pt(2, 0)])], "#ffffff", 4);
    const capped = buildStrokesRibbonGeometry(
      [stroke([pt(0, 0), pt(1, 0), pt(2, 0)], { closed: true })],
      "#ffffff",
      4,
    );
    expect(open.getAttribute("position").count).toBeGreaterThan(capped.getAttribute("position").count);

    // The cap extends past the last sample along the stroke direction.
    const pos = open.getAttribute("position");
    let maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) maxX = Math.max(maxX, pos.getX(i));
    expect(maxX).toBeGreaterThan(2);
  });

  it("widens the ribbon at a sharp corner instead of pinching it", () => {
    // Miter compensation: the corner's half-width must be >= the straight run's.
    const geo = buildStrokesRibbonGeometry(
      [stroke([pt(0, 0), pt(1, 0), pt(1, 1)], { width: 20 })],
      "#ffffff",
      20,
    );
    const pos = geo.getAttribute("position");
    let maxDistFromCorner = 0;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - 1;
      const dz = pos.getZ(i) - 0;
      // Only consider vertices generated around the corner point.
      if (Math.hypot(dx, dz) < 0.6) maxDistFromCorner = Math.max(maxDistFromCorner, Math.hypot(dx, dz));
    }
    const halfWidth = 20 * 0.02 * 0.6; // baseRadius * pressure
    expect(maxDistFromCorner).toBeGreaterThan(halfWidth * 0.9);
  });

  it("scales stroke width with recorded pressure", () => {
    const thin = buildStrokesRibbonGeometry([stroke([pt(0, 0, 0.1), pt(2, 0, 0.1)])], "#fff", 20);
    const thick = buildStrokesRibbonGeometry([stroke([pt(0, 0, 1.0), pt(2, 0, 1.0)])], "#fff", 20);
    const spread = (g: THREE.BufferGeometry) => {
      const pos = g.getAttribute("position");
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        min = Math.min(min, pos.getZ(i));
        max = Math.max(max, pos.getZ(i));
      }
      return max - min;
    };
    expect(spread(thick)).toBeGreaterThan(spread(thin) * 3);
  });

  it("produces an empty geometry for strokes with fewer than two points", () => {
    const geo = buildStrokesRibbonGeometry([stroke([pt(0, 0)])], "#ffffff", 4);
    expect(geo.getAttribute("position")).toBeUndefined();
  });
});

describe("applyStrokeEdgeAA", () => {
  it("injects the edge feather into the compiled shader once", () => {
    const mat = applyStrokeEdgeAA(new THREE.MeshBasicMaterial());
    expect(mat.transparent).toBe(true);
    expect(mat.customProgramCacheKey?.()).toBe("strokeEdgeAA_v2");

    const shader = {
      vertexShader: "#include <common>\nvoid main(){\n#include <begin_vertex>\n}",
      fragmentShader: "#include <common>\nvoid main(){\n#include <dithering_fragment>\n}",
      uniforms: {},
    };
    mat.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain("attribute vec2 aEdge");
    expect(shader.fragmentShader).toContain("gl_FragColor.a *=");

    const before = mat.onBeforeCompile;
    applyStrokeEdgeAA(mat);
    expect(mat.onBeforeCompile).toBe(before);
  });
});

describe("textured brushes and stylus tilt", () => {
  it("tags every vertex with its brush id and distance along the stroke", () => {
    const geo = buildStrokesRibbonGeometry(
      [stroke([pt(0, 0), pt(1, 0), pt(2, 0)], { brushType: "charcoal" })],
      "#ffffff",
      4,
    );
    const grain = geo.getAttribute("aGrain");
    expect(grain).toBeDefined();
    expect(grain.count).toBe(geo.getAttribute("position").count);

    let maxAlong = 0;
    for (let i = 0; i < grain.count; i++) {
      expect(grain.getY(i)).toBe(BRUSH_SHADER_ID.charcoal);
      maxAlong = Math.max(maxAlong, grain.getX(i));
    }
    // Grain runs in half-widths: a 2-unit stroke at radius 0.08 is ~25 of them.
    expect(maxAlong).toBeGreaterThan(10);
  });

  it("gives every textured brush its own shader id, and untextured ones zero", () => {
    expect(BRUSH_SHADER_ID.ink_pen).toBe(0);
    expect(BRUSH_SHADER_ID.marker_bold).toBe(0);
    expect(new Set([BRUSH_SHADER_ID.pencil, BRUSH_SHADER_ID.charcoal, BRUSH_SHADER_ID.watercolor]).size).toBe(3);
  });

  it("steers the chisel nib with stylus tilt", () => {
    const flat = [pt(0, 0), pt(1, 0), pt(2, 0)].map((p) => ({ ...p, tiltAngle: 0, tiltInc: 1 }));
    const turned = [pt(0, 0), pt(1, 0), pt(2, 0)].map((p) => ({ ...p, tiltAngle: Math.PI / 2, tiltInc: 1 }));

    const spread = (pts: StrokePoint[]) => {
      const geo = buildStrokesRibbonGeometry([stroke(pts, { brushType: "marker_bold", width: 30 })], "#fff", 30);
      const pos = geo.getAttribute("position");
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        minZ = Math.min(minZ, pos.getZ(i));
        maxZ = Math.max(maxZ, pos.getZ(i));
      }
      return maxZ - minZ;
    };

    // Tilting along the stroke direction collapses the nib's cross-section;
    // tilting across it keeps the ribbon wide.
    expect(spread(turned)).toBeLessThan(spread(flat));
  });

  it("keeps the fixed 45° chisel when the tablet reports no tilt", () => {
    const geo = buildStrokesRibbonGeometry(
      [stroke([pt(0, 0), pt(1, 0), pt(2, 0)], { brushType: "marker_bold" })],
      "#fff",
      4,
    );
    expect(geo.getAttribute("position").count).toBeGreaterThan(0);
  });
});

describe("fill holes", () => {
  it("triangulates a hole out of a filled shape", () => {
    const outline = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];
    const hole = [pt(3, 3), pt(7, 3), pt(7, 7), pt(3, 7)];

    const solid = buildStrokesFillGeometry([stroke(outline, { fill: true })], "#fff");
    const holed = buildStrokesFillGeometry([stroke(outline, { fill: true, holes: [hole] })], "#fff");

    // The perforated fill carries the hole's vertices too.
    expect(holed.getAttribute("position").count).toBe(solid.getAttribute("position").count + 4);
    const solidTris = (solid.getIndex()?.count ?? 0) / 3;
    const holedTris = (holed.getIndex()?.count ?? 0) / 3;
    expect(holedTris).toBeGreaterThan(solidTris);
  });

  it("ignores degenerate holes", () => {
    const outline = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];
    const geo = buildStrokesFillGeometry([stroke(outline, { fill: true, holes: [[pt(1, 1), pt(2, 2)]] })], "#fff");
    expect(geo.getAttribute("position").count).toBe(4);
  });
});

describe("trimStrokeDwellTail", () => {
  it("collapses the pile of samples left by the hand dwelling before pen-up", () => {
    const pts = [pt(0, 0, 0.3), pt(1, 0, 0.3), pt(2, 0, 0.3)];
    // Ten samples inside 0.05 units, pressure climbing — the blob.
    for (let i = 1; i <= 10; i++) pts.push(pt(2 + i * 0.005, 0, 0.3 + i * 0.07));
    const out = trimStrokeDwellTail(pts, 0.1);

    // Every sample within the radius of the endpoint folds into it, including
    // the last pre-dwell point at x=2.
    expect(out).toHaveLength(3);
    expect(out[out.length - 1].x).toBeCloseTo(2.05, 3);
    // The endpoint keeps the cluster's lowest pressure, never its inflated one.
    expect(out[out.length - 1].pressure).toBeCloseTo(0.3, 5);
  });

  it("leaves a stroke released while still moving untouched", () => {
    const pts = [pt(0, 0), pt(1, 0), pt(2, 0), pt(3, 0)];
    expect(trimStrokeDwellTail(pts, 0.1)).toBe(pts);
  });

  it("never trims a stroke below two points", () => {
    const pts = [pt(0, 0), pt(0.001, 0), pt(0.002, 0), pt(0.003, 0)];
    const out = trimStrokeDwellTail(pts, 1);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("handles degenerate input", () => {
    expect(trimStrokeDwellTail([], 1)).toEqual([]);
    const two = [pt(0, 0), pt(1, 0)];
    expect(trimStrokeDwellTail(two, 1)).toBe(two);
    expect(trimStrokeDwellTail([pt(0, 0), pt(1, 0), pt(2, 0)], 0)).toHaveLength(3);
  });
});

describe("eraseStrokesCut", () => {
  const frames = (): KeyframeDrawing[] => [
    {
      frame: 0,
      strokes: [stroke([pt(0, 0), pt(1, 0), pt(2, 0), pt(3, 0), pt(4, 0)])],
    },
  ];

  it("splits a stroke into two fragments when erasing its middle", () => {
    const out = eraseStrokesCut(frames(), 0, new THREE.Vector3(2, 0, 0), 0.5);
    const strokes = out[0].strokes;
    expect(strokes).toHaveLength(2);
    expect(strokes[0].points[strokes[0].points.length - 1].x).toBeLessThan(2);
    expect(strokes[1].points[0].x).toBeGreaterThan(2);
    expect(strokes[0].id).not.toBe(strokes[1].id);
  });

  it("shortens a stroke instead of deleting it when erasing one end", () => {
    const out = eraseStrokesCut(frames(), 0, new THREE.Vector3(4, 0, 0), 0.6);
    const strokes = out[0].strokes;
    expect(strokes).toHaveLength(1);
    const last = strokes[0].points[strokes[0].points.length - 1];
    expect(last.x).toBeLessThan(4);
    expect(last.x).toBeGreaterThan(3);
  });

  it("cuts exactly at the eraser boundary, not at the nearest sample", () => {
    const out = eraseStrokesCut(frames(), 0, new THREE.Vector3(2, 0, 0), 0.5);
    const cutEnd = out[0].strokes[0].points.slice(-1)[0];
    expect(cutEnd.x).toBeCloseTo(1.5, 2);
  });

  it("removes a stroke entirely when the eraser covers all of it", () => {
    const out = eraseStrokesCut(frames(), 0, new THREE.Vector3(2, 0, 0), 10);
    expect(out[0].strokes).toHaveLength(0);
  });

  it("returns the original frames when nothing is touched", () => {
    const input = frames();
    expect(eraseStrokesCut(input, 0, new THREE.Vector3(50, 0, 0), 0.5)).toBe(input);
  });

  it("opens a closed stroke that gets cut", () => {
    const input: KeyframeDrawing[] = [
      { frame: 0, strokes: [stroke([pt(0, 0), pt(2, 0), pt(2, 2), pt(0, 2)], { closed: true })] },
    ];
    const out = eraseStrokesCut(input, 0, new THREE.Vector3(2, 0, 0), 0.5);
    expect(out[0].strokes.every((s) => s.closed === false)).toBe(true);
  });
});
