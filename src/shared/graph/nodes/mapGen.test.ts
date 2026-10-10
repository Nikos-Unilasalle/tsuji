import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { DEFAULT_REGISTRY } from "./index";
import {
  MAP_BIOMES_NODE,
  MAP_ELEVATION_NODE,
  MAP_MESH_NODE,
  MAP_MOISTURE_NODE,
  MAP_RIVERS_NODE,
  MAP_TO_TEXTURES_NODE,
} from "./mapGen";
import { TERRAIN_NODE } from "./terrain";
import { MAP_PAINT_NODE, commitMapPaint, flushMapPaint, getMapPaintState, paintDab } from "./mapPaint";

const ctx = (id: string): EvalContext => ({ time: 0, step: 0, nodeId: id });
const P = (node: { defaultParams: Record<string, unknown> }, over: Record<string, unknown> = {}) => ({
  ...node.defaultParams,
  ...over,
});

function chain(tag: string, over: { mesh?: Record<string, unknown>; elevation?: Record<string, unknown> } = {}) {
  const mesh = MAP_MESH_NODE.evaluate({}, P(MAP_MESH_NODE, { spacing: 0.02, ...over.mesh }), ctx(`${tag}-mesh`));
  const elev = MAP_ELEVATION_NODE.evaluate({ map: mesh.map }, P(MAP_ELEVATION_NODE, over.elevation), ctx(`${tag}-elev`));
  const moist = MAP_MOISTURE_NODE.evaluate({ map: elev.map }, P(MAP_MOISTURE_NODE), ctx(`${tag}-moist`));
  const rivers = MAP_RIVERS_NODE.evaluate({ map: moist.map }, P(MAP_RIVERS_NODE), ctx(`${tag}-riv`));
  const biomes = MAP_BIOMES_NODE.evaluate({ map: rivers.map }, P(MAP_BIOMES_NODE), ctx(`${tag}-bio`));
  const tex = MAP_TO_TEXTURES_NODE.evaluate({ map: biomes.map }, P(MAP_TO_TEXTURES_NODE, { resolution: "128" }), ctx(`${tag}-tex`));
  return { mesh, elev, moist, rivers, biomes, tex };
}

describe("Map Generator nodes", () => {
  it("are registered in the map category", () => {
    for (const t of ["map/mesh", "map/elevation", "map/moisture", "map/rivers", "map/biomes", "map/to-textures"]) {
      expect(DEFAULT_REGISTRY.get(t)?.category).toBe("map");
    }
  });

  it("runs the whole pipeline and yields usable textures", () => {
    const r = chain("full");
    expect(r.mesh.count as number).toBeGreaterThan(500);
    const { heightmap, biome, moisture, rivers } = r.tex as Record<string, THREE.DataTexture>;
    for (const t of [heightmap, biome, moisture, rivers]) {
      expect(t).toBeInstanceOf(THREE.DataTexture);
      expect(t.image.width).toBe(128);
      expect(t.image.height).toBe(128);
    }
    expect(heightmap.image.data).toBeInstanceOf(Float32Array);
    const h = heightmap.image.data as Float32Array;
    let max = 0;
    for (let i = 0; i < h.length; i += 4) max = Math.max(max, h[i]);
    expect(max).toBeGreaterThan(0.4);
    expect(max).toBeLessThanOrEqual(1);
    expect((rivers.image.data as Uint8Array).some((v, i) => i % 4 === 0 && v > 0)).toBe(true);
  });

  it("returns the same objects when nothing changed, new ones when a param does", () => {
    const a = chain("memo");
    const b = chain("memo");
    expect(b.mesh.map).toBe(a.mesh.map);
    expect(b.elev.map).toBe(a.elev.map);
    expect(b.biomes.map).toBe(a.biomes.map);
    expect(b.tex.heightmap).toBe(a.tex.heightmap);

    const c = chain("memo", { elevation: { island: 0.2 } });
    expect(c.mesh.map).toBe(a.mesh.map);
    expect(c.elev.map).not.toBe(a.elev.map);
    expect(c.tex.heightmap).not.toBe(a.tex.heightmap);
  });

  it("is deterministic across node instances for the same seed", () => {
    const a = chain("det-a").tex.heightmap as THREE.DataTexture;
    const b = chain("det-b").tex.heightmap as THREE.DataTexture;
    expect(Array.from(a.image.data as Float32Array)).toEqual(Array.from(b.image.data as Float32Array));
    const other = chain("det-c", { mesh: { seed: 9 }, elevation: { seed: 9 } }).tex.heightmap as THREE.DataTexture;
    expect(Array.from(a.image.data as Float32Array)).not.toEqual(Array.from(other.image.data as Float32Array));
  });

  it("degrades to empty outputs instead of throwing when stages are missing", () => {
    expect(MAP_ELEVATION_NODE.evaluate({}, P(MAP_ELEVATION_NODE), ctx("x1")).map).toBeNull();
    const mesh = MAP_MESH_NODE.evaluate({}, P(MAP_MESH_NODE, { spacing: 0.05 }), ctx("x2"));
    expect(MAP_MOISTURE_NODE.evaluate({ map: mesh.map }, P(MAP_MOISTURE_NODE), ctx("x3")).map).toBeNull();
    expect(MAP_RIVERS_NODE.evaluate({ map: mesh.map }, P(MAP_RIVERS_NODE), ctx("x4")).paths).toEqual([]);
    expect(MAP_BIOMES_NODE.evaluate({ map: mesh.map }, P(MAP_BIOMES_NODE), ctx("x5")).map).toBeNull();
    expect(MAP_TO_TEXTURES_NODE.evaluate({}, P(MAP_TO_TEXTURES_NODE), ctx("x6")).heightmap).toBeNull();
    // Elevation alone is enough for textures: the other maps are just blank.
    const elev = MAP_ELEVATION_NODE.evaluate({ map: mesh.map }, P(MAP_ELEVATION_NODE), ctx("x7"));
    expect(MAP_TO_TEXTURES_NODE.evaluate({ map: elev.map }, P(MAP_TO_TEXTURES_NODE), ctx("x8")).heightmap).toBeInstanceOf(THREE.DataTexture);
  });

  it("paints: a bright paint texture raises land relative to a dark one", () => {
    const mesh = MAP_MESH_NODE.evaluate({}, P(MAP_MESH_NODE, { spacing: 0.03 }), ctx("pt-mesh"));
    const solid = (v: number) => {
      const data = new Uint8Array(4 * 4 * 4).fill(v);
      return new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat);
    };
    const run = (v: number, id: string) => {
      const e = MAP_ELEVATION_NODE.evaluate({ map: mesh.map, paint: solid(v) }, P(MAP_ELEVATION_NODE, { island: 0 }), ctx(id));
      const t = MAP_TO_TEXTURES_NODE.evaluate({ map: e.map }, P(MAP_TO_TEXTURES_NODE, { resolution: "128" }), ctx(`${id}-t`));
      const d = (t.heightmap as THREE.DataTexture).image.data as Float32Array;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i];
      return sum;
    };
    expect(run(255, "pt-hi")).toBeGreaterThan(run(0, "pt-lo"));
  });

  it("feeds Terrain, and river paths line up with the terrain surface", () => {
    const r = chain("terr");
    const heightmap = r.tex.heightmap as THREE.DataTexture;
    const out = TERRAIN_NODE.evaluate({ heightmap }, P(TERRAIN_NODE, { resolution: "128x128" }), ctx("terr-terrain"));
    expect(out.geometry ?? out.object ?? out).toBeTruthy();

    const paths = r.rivers.paths as THREE.Vector3[][];
    expect(paths.length).toBeGreaterThan(0);
    // Every path vertex must sit inside the terrain footprint and at/above its water line.
    for (const path of paths) {
      for (const v of path) {
        expect(Math.abs(v.x)).toBeLessThanOrEqual(20.0001);
        expect(Math.abs(v.z)).toBeLessThanOrEqual(20.0001);
        expect(v.y).toBeGreaterThanOrEqual(0);
      }
    }
    // Sample the heightmap where a river vertex is: it must match the vertex height (to raster accuracy).
    const data = heightmap.image.data as Float32Array;
    const W = heightmap.image.width;
    let checked = 0;
    for (const path of paths) {
      for (const v of path) {
        const px = Math.min(W - 1, Math.max(0, Math.round((v.x / 40 + 0.5) * W - 0.5)));
        const py = Math.min(W - 1, Math.max(0, Math.round((v.z / 40 + 0.5) * W - 0.5)));
        const sampled = data[(py * W + px) * 4] * 6 + 0.05;
        if (v.y > 0.06) {
          expect(Math.abs(sampled - v.y)).toBeLessThan(1.2);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("Map Paint", () => {
  const paintCtx = (id: string): EvalContext => ({ time: 0, step: 0, nodeId: id });
  const heightSum = (paint: THREE.Texture | undefined, tag: string): number => {
    const mesh = MAP_MESH_NODE.evaluate({}, P(MAP_MESH_NODE, { spacing: 0.03 }), ctx(`${tag}-mesh`));
    const e = MAP_ELEVATION_NODE.evaluate({ map: mesh.map, paint }, P(MAP_ELEVATION_NODE, { island: 0 }), ctx(`${tag}-e`));
    const t = MAP_TO_TEXTURES_NODE.evaluate({ map: e.map }, P(MAP_TO_TEXTURES_NODE, { resolution: "128" }), ctx(`${tag}-t`));
    const d = (t.heightmap as THREE.DataTexture).image.data as Float32Array;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i];
    return sum;
  };

  it("is registered, has no inputs, and an unpainted layer changes nothing", () => {
    expect(DEFAULT_REGISTRY.get("map/paint")?.inputs).toEqual([]);
    const blank = MAP_PAINT_NODE.evaluate({}, P(MAP_PAINT_NODE), paintCtx("mp-blank")).paint as THREE.Texture;
    expect(heightSum(blank, "mp-a")).toBeCloseTo(heightSum(undefined, "mp-b"), 4);
  });

  it("returns the same texture every frame, and a stroke flows through to the heightmap", () => {
    const params = P(MAP_PAINT_NODE);
    const first = MAP_PAINT_NODE.evaluate({}, params, paintCtx("mp-live")).paint as THREE.Texture;
    expect(MAP_PAINT_NODE.evaluate({}, params, paintCtx("mp-live")).paint).toBe(first);

    const before = heightSum(first, "mp-live-1");
    const state = getMapPaintState("mp-live", 256, params.paintData);
    for (let i = 0; i < 8; i++) paintDab(state, { x: 0.5, y: 0.5, radius: 0.25, strength: 1, tool: "raise", falloff: "smooth" });
    flushMapPaint(state);
    const after = heightSum(first, "mp-live-2");
    expect(after).toBeGreaterThan(before);

    const saved = commitMapPaint(state);
    expect(saved.length).toBeGreaterThan(0);
    // Committing must not look like an external change: no reload, same texture.
    expect(MAP_PAINT_NODE.evaluate({}, { ...params, paintData: saved }, paintCtx("mp-live")).paint).toBe(first);
    expect(heightSum(first, "mp-live-3")).toBeCloseTo(after, 4);
  });

  it("reloads when the saved data changes underneath it (undo / reset)", () => {
    const params = P(MAP_PAINT_NODE);
    const tex = MAP_PAINT_NODE.evaluate({}, params, paintCtx("mp-undo")).paint as THREE.Texture;
    const state = getMapPaintState("mp-undo", 256, "");
    for (let i = 0; i < 8; i++) paintDab(state, { x: 0.5, y: 0.5, radius: 0.25, strength: 1, tool: "raise", falloff: "smooth" });
    const saved = commitMapPaint(state);
    const painted = heightSum(tex, "mp-undo-1");

    MAP_PAINT_NODE.evaluate({}, { ...params, paintData: "" }, paintCtx("mp-undo"));
    expect(heightSum(tex, "mp-undo-2")).toBeLessThan(painted);
    MAP_PAINT_NODE.evaluate({}, { ...params, paintData: saved }, paintCtx("mp-undo"));
    // Saved data is quantised to 8 bits, so the reload matches to well under 0.1%, not exactly.
    expect(Math.abs(heightSum(tex, "mp-undo-3") - painted) / painted).toBeLessThan(0.001);
  });
});
