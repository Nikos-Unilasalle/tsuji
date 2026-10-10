import { describe, expect, it } from "vitest";
import {
  BIOMES,
  generateBiomes,
  generateElevation,
  generateMesh,
  generateMoisture,
  generateRivers,
  rasterize,
} from "./index";

const ELEV = { seed: 3, scale: 3, octaves: 5, ridges: 0.5, mountains: 2.6, island: 0.9, seaLevel: 0.42, paintStrength: 0.5, lowlands: 1.7, oceanDepth: 0.9 };
const WIND = { windAngle: 0, evaporation: 0.15, rainShadow: 0.6 };
const BIOME = { snowLine: 0.8, treeLine: 0.6, beach: 0.04, wetness: 0 };

function build(seed = 3) {
  const mesh = generateMesh(seed, 0.02);
  const elevation = generateElevation(mesh, { ...ELEV, seed });
  const moisture = generateMoisture(mesh, elevation, WIND);
  const rivers = generateRivers(mesh, elevation, moisture, { density: 0.04 });
  return { mesh, elevation, moisture, rivers };
}

describe("mapgen mesh", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    const a = generateMesh(5, 0.03);
    const b = generateMesh(5, 0.03);
    const c = generateMesh(6, 0.03);
    expect(Array.from(a.points)).toEqual(Array.from(b.points));
    expect(Array.from(a.points)).not.toEqual(Array.from(c.points));
  });

  it("keeps every point in the unit square and every point connected", () => {
    const m = generateMesh(1, 0.03);
    for (const v of m.points) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
    for (let i = 0; i < m.numPoints; i++) expect(m.adjStart[i + 1]).toBeGreaterThan(m.adjStart[i]);
  });

  it("clamps absurd spacing instead of exploding", () => {
    expect(generateMesh(1, 0).numPoints).toBeLessThan(120000);
    expect(generateMesh(1, 99).numPoints).toBeGreaterThan(3);
  });
});

describe("mapgen pipeline", () => {
  it("island mode floods the map edge and keeps land inside", () => {
    const { mesh, elevation } = build();
    let land = 0;
    for (let i = 0; i < mesh.numPoints; i++) {
      if (mesh.isBoundary[i]) expect(elevation[i]).toBeLessThanOrEqual(0);
      if (elevation[i] > 0) land++;
    }
    expect(land).toBeGreaterThan(mesh.numPoints * 0.05);
    expect(land).toBeLessThan(mesh.numPoints * 0.95);
  });

  it("is reproducible end to end", () => {
    const a = build();
    const b = build();
    expect(Array.from(a.elevation)).toEqual(Array.from(b.elevation));
    expect(a.rivers.paths).toEqual(b.rivers.paths);
  });

  it("paint raises and lowers terrain", () => {
    const mesh = generateMesh(3, 0.03);
    const base = generateElevation(mesh, { ...ELEV, island: 0 });
    const up = generateElevation(mesh, { ...ELEV, island: 0, paint: () => 1 });
    const down = generateElevation(mesh, { ...ELEV, island: 0, paint: () => 0 });
    const i = Math.floor(mesh.numPoints / 2);
    expect(up[i]).toBeGreaterThanOrEqual(base[i]);
    expect(down[i]).toBeLessThanOrEqual(base[i]);
  });

  it("every river flows downhill and ends at the sea or edge", () => {
    const { mesh, elevation, rivers } = build();
    expect(rivers.paths.length).toBeGreaterThan(0);
    for (const path of rivers.paths) {
      for (let i = 0; i + 1 < path.length; i++) {
        expect(rivers.filled[path[i + 1]]).toBeLessThanOrEqual(rivers.filled[path[i]]);
      }
      const last = path[path.length - 1];
      const mouthOk = elevation[last] <= 0 || mesh.isBoundary[last] === 1 || rivers.isRiver[last] === 1;
      expect(mouthOk).toBe(true);
    }
  });

  it("moisture and flow stay in [0, 1]", () => {
    const { moisture, rivers } = build();
    for (const v of moisture) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
    for (const v of rivers.flow) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
  });

  it("windward land is wetter than the lee of the same range", () => {
    const { mesh, elevation, moisture } = build();
    let west = 0, wn = 0, east = 0, en = 0;
    for (let i = 0; i < mesh.numPoints; i++) {
      if (elevation[i] <= 0) continue;
      if (mesh.points[i * 2] < 0.5) (west += moisture[i]), wn++;
      else (east += moisture[i]), en++;
    }
    expect(wn).toBeGreaterThan(0);
    expect(en).toBeGreaterThan(0);
    // Wind blows towards +x: the west half gets the sea air first.
    expect(west / wn).toBeGreaterThan(east / en);
  });

  it("assigns valid biomes, ocean below sea level, snow only high", () => {
    const { elevation, moisture, rivers } = build();
    const biomes = generateBiomes(elevation, moisture, rivers.isLake, BIOME);
    for (let i = 0; i < biomes.length; i++) {
      expect(biomes[i]).toBeLessThan(BIOMES.length);
      if (elevation[i] <= 0) expect(biomes[i]).toBeLessThanOrEqual(1);
      if (biomes[i] === 11) expect(elevation[i]).toBeGreaterThan(BIOME.snowLine);
    }
  });
});

describe("rasterize", () => {
  it("reproduces a linear ramp across the map", () => {
    const mesh = generateMesh(2, 0.05);
    const vals = new Float32Array(mesh.numPoints);
    for (let i = 0; i < mesh.numPoints; i++) vals[i] = mesh.points[i * 2];
    const W = 32;
    const img = rasterize(mesh, vals, 1, W, W, false);
    for (let y = 0; y < W; y += 7) for (let x = 2; x < W - 2; x += 5) expect(img[y * W + x]).toBeCloseTo((x + 0.5) / W, 1);
  });

  it("flipY mirrors rows", () => {
    const mesh = generateMesh(2, 0.05);
    const vals = new Float32Array(mesh.numPoints);
    for (let i = 0; i < mesh.numPoints; i++) vals[i] = mesh.points[i * 2 + 1];
    const a = rasterize(mesh, vals, 1, 16, 16, false);
    const b = rasterize(mesh, vals, 1, 16, 16, true);
    expect(a[3 * 16 + 8]).toBeCloseTo(b[12 * 16 + 8], 5);
  });
});
