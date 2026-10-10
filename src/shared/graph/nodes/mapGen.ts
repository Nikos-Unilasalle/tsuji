import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import {
  BIOMES,
  MapData,
  createMapData,
  drawPaths,
  extendMapData,
  generateBiomes,
  generateElevation,
  generateMesh,
  generateMoisture,
  generateRivers,
  isMapData,
  rasterize,
  MAPGEN4_STYLE,
  stylizeMap,
} from "../../math/mapgen";
import { getTexturePixels, samplePixelHeight } from "../../three/terrainEngine";

/**
 * Map Generator nodes — Red Blob Games' mapgen4 pipeline, one stage per node:
 *
 *   Map Mesh → Map Elevation → Map Moisture → Map Rivers → Map Biomes → Map To Textures
 *
 * Every stage takes the previous stage's MapData and returns a fresh one with
 * its own field added (see mapData.ts), so a stage can be dropped, swapped or
 * branched. The terrain is Poisson-disk points + Delaunay triangulation, one
 * value per point; only Map To Textures turns it into pixels.
 *
 * evaluate() must stay pure but the graph runs it every frame, and the stages
 * are far too heavy for that. Each node therefore memoises its last result in
 * a per-node cache, keyed by a signature of its params and its input's `rev`,
 * and hands back the *same* object until something actually changes.
 */

interface Memo<T> {
  sig: string;
  value: T;
}

function memoized<T>(cache: Map<string, Memo<T>>, nodeId: string, sig: string, compute: () => T): T {
  const hit = cache.get(nodeId);
  if (hit && hit.sig === sig) return hit.value;
  const value = compute();
  cache.set(nodeId, { sig, value });
  return value;
}

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function textureSig(t: unknown): string {
  return t instanceof THREE.Texture ? `${t.uuid}:${t.version}` : "-";
}

/* -------------------------------------------------------------------------- */
/* Map Mesh                                                                   */
/* -------------------------------------------------------------------------- */

const meshCache = createNodeCache<Memo<MapData>>();

const MESH_FIELDS: ParamFieldDef[] = [
  { id: "seed", label: "Seed", kind: "number", step: 1 },
  { id: "spacing", label: "Point Spacing", kind: "number", step: 0.002 },
];

export const MAP_MESH_NODE: NodeDefinition = {
  type: "map/mesh",
  label: "Map Mesh",
  category: "map",
  inputs: [
    { id: "seed", label: "Seed", type: "value" },
    { id: "spacing", label: "Point Spacing", type: "value" },
  ],
  outputs: [
    { id: "map", label: "Map", type: "any" },
    { id: "count", label: "Point Count", type: "value" },
  ],
  defaultParams: { seed: 1, spacing: 0.012 },
  paramFields: MESH_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const seed = Math.round(num(inputs.seed, params.seed, 1));
    const spacing = num(inputs.spacing, params.spacing, 0.012);
    const map = memoized(meshCache, ctx.nodeId, `${seed}|${spacing}`, () => createMapData(generateMesh(seed, spacing)));
    return { map, count: map.mesh.numPoints };
  },
};

/* -------------------------------------------------------------------------- */
/* Map Elevation                                                              */
/* -------------------------------------------------------------------------- */

const elevationCache = createNodeCache<Memo<MapData | null>>();

const ELEVATION_FIELDS: ParamFieldDef[] = [
  { id: "seed", label: "Seed", kind: "number", step: 1, group: "Noise" },
  { id: "scale", label: "Scale", kind: "number", step: 0.25, group: "Noise" },
  { id: "octaves", label: "Octaves", kind: "number", step: 1, group: "Noise" },
  { id: "ridges", label: "Mountain Ridges", kind: "number", step: 0.05, group: "Relief" },
  { id: "mountains", label: "Mountain Height", kind: "number", step: 0.1, group: "Relief" },
  { id: "lowlands", label: "Lowland Bias", kind: "number", step: 0.1, group: "Relief" },
  { id: "oceanDepth", label: "Ocean Depth", kind: "number", step: 0.05, group: "Shape" },
  { id: "island", label: "Island", kind: "number", step: 0.05, group: "Shape" },
  { id: "seaLevel", label: "Sea Level", kind: "number", step: 0.01, group: "Shape" },
  { id: "paintStrength", label: "Paint Strength", kind: "number", step: 0.05, group: "Paint" },
];

export const MAP_ELEVATION_NODE: NodeDefinition = {
  type: "map/elevation",
  label: "Map Elevation",
  category: "map",
  inputs: [
    { id: "map", label: "Map", type: "any" },
    { id: "paint", label: "Paint (50% grey = neutral)", type: "texture" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "scale", label: "Scale", type: "value" },
    { id: "mountains", label: "Mountain Height", type: "value" },
    { id: "island", label: "Island", type: "value" },
    { id: "seaLevel", label: "Sea Level", type: "value" },
  ],
  outputs: [{ id: "map", label: "Map", type: "any" }],
  defaultParams: {
    seed: 1,
    scale: 3,
    octaves: 5,
    ridges: 0.5,
    mountains: 2.6,
    island: 0.8,
    seaLevel: 0.42,
    paintStrength: 1,
    lowlands: 1.7,
    oceanDepth: 0.9,
  },
  paramFields: ELEVATION_FIELDS,
  evaluate: (inputs, params, ctx) => {
    if (!isMapData(inputs.map)) return { map: null };
    const src = inputs.map;
    const seed = Math.round(num(inputs.seed, params.seed, 1));
    const scale = clamp(num(inputs.scale, params.scale, 3), 0.1, 40);
    const octaves = clamp(Math.round(num(undefined, params.octaves, 5)), 1, 8);
    const ridges = clamp(num(undefined, params.ridges, 0.5), 0, 1);
    const mountains = clamp(num(inputs.mountains, params.mountains, 2.6), 0, 6);
    const island = clamp(num(inputs.island, params.island, 0.8), 0, 1);
    const seaLevel = clamp(num(inputs.seaLevel, params.seaLevel, 0.42), 0, 1);
    const paintStrength = clamp(num(undefined, params.paintStrength, 1), 0, 2);
    const lowlands = clamp(num(undefined, params.lowlands, 1.7), 0.5, 4);
    const oceanDepth = clamp(num(undefined, params.oceanDepth, 0.9), 0.1, 1);
    const paintTex = inputs.paint instanceof THREE.Texture ? inputs.paint : null;

    const sig = [src.rev, seed, scale, octaves, ridges, mountains, island, seaLevel, paintStrength, lowlands, oceanDepth, textureSig(paintTex)].join("|");
    const map = memoized(elevationCache, ctx.nodeId, sig, () => {
      const pixels = paintTex ? getTexturePixels(paintTex) : null;
      // Same orientation as the Terrain heightmap: image row 0 is the map's y = 0 edge.
      // An 8-bit image's mid grey is 128/255, not 0.5; shift it so "no change" really is no change.
      const shift = pixels && !(pixels.data instanceof Float32Array) ? 128 / 255 - 0.5 : 0;
      const paint = pixels ? (x: number, y: number) => samplePixelHeight(pixels, x, 1 - y) - shift : undefined;
      const elevation = generateElevation(src.mesh, { seed, scale, octaves, ridges, mountains, island, seaLevel, paint, paintStrength, lowlands, oceanDepth });
      // Anything computed from the old elevation is stale now.
      return extendMapData(src, { elevation, moisture: undefined, rivers: undefined, biomes: undefined });
    });
    return { map };
  },
};

/* -------------------------------------------------------------------------- */
/* Map Moisture                                                               */
/* -------------------------------------------------------------------------- */

const moistureCache = createNodeCache<Memo<MapData | null>>();

const MOISTURE_FIELDS: ParamFieldDef[] = [
  { id: "windAngle", label: "Wind Direction (°)", kind: "number", step: 5 },
  { id: "evaporation", label: "Evaporation", kind: "number", step: 0.05 },
  { id: "rainShadow", label: "Rain Shadow", kind: "number", step: 0.05 },
];

export const MAP_MOISTURE_NODE: NodeDefinition = {
  type: "map/moisture",
  label: "Map Moisture",
  category: "map",
  inputs: [
    { id: "map", label: "Map", type: "any" },
    { id: "windAngle", label: "Wind Direction (°)", type: "value" },
    { id: "evaporation", label: "Evaporation", type: "value" },
    { id: "rainShadow", label: "Rain Shadow", type: "value" },
  ],
  outputs: [{ id: "map", label: "Map", type: "any" }],
  defaultParams: { windAngle: 0, evaporation: 0.15, rainShadow: 0.6 },
  paramFields: MOISTURE_FIELDS,
  evaluate: (inputs, params, ctx) => {
    if (!isMapData(inputs.map) || !inputs.map.elevation) return { map: null };
    const src = inputs.map;
    const windAngle = num(inputs.windAngle, params.windAngle, 0);
    const evaporation = clamp(num(inputs.evaporation, params.evaporation, 0.15), 0, 1);
    const rainShadow = clamp(num(inputs.rainShadow, params.rainShadow, 0.6), 0, 3);
    const map = memoized(moistureCache, ctx.nodeId, [src.rev, windAngle, evaporation, rainShadow].join("|"), () => {
      const moisture = generateMoisture(src.mesh, src.elevation!, { windAngle, evaporation, rainShadow });
      return extendMapData(src, { moisture, rivers: undefined, biomes: undefined });
    });
    return { map };
  },
};

/* -------------------------------------------------------------------------- */
/* Map Rivers                                                                 */
/* -------------------------------------------------------------------------- */

interface RiversResult {
  map: MapData | null;
  paths: THREE.Vector3[][];
}

const riversCache = createNodeCache<Memo<RiversResult>>();

const RIVERS_FIELDS: ParamFieldDef[] = [
  { id: "density", label: "River Density", kind: "number", step: 0.01, group: "Rivers" },
  { id: "width", label: "Terrain Width (X)", kind: "number", step: 1, group: "Match the Terrain node" },
  { id: "depth", label: "Terrain Depth (Z)", kind: "number", step: 1, group: "Match the Terrain node" },
  { id: "heightScale", label: "Height Amplitude", kind: "number", step: 0.5, group: "Match the Terrain node" },
  { id: "heightOffset", label: "Height Offset (Y)", kind: "number", step: 0.5, group: "Match the Terrain node" },
  { id: "lift", label: "Lift Above Ground", kind: "number", step: 0.01, group: "Match the Terrain node" },
];

export const MAP_RIVERS_NODE: NodeDefinition = {
  type: "map/rivers",
  label: "Map Rivers",
  category: "map",
  inputs: [
    { id: "map", label: "Map", type: "any" },
    { id: "density", label: "River Density", type: "value" },
  ],
  outputs: [
    { id: "map", label: "Map", type: "any" },
    { id: "paths", label: "River Paths", type: "list" },
  ],
  defaultParams: { density: 0.05, width: 40, depth: 40, heightScale: 6, heightOffset: 0, lift: 0.05 },
  paramFields: RIVERS_FIELDS,
  evaluate: (inputs, params, ctx) => {
    if (!isMapData(inputs.map) || !inputs.map.elevation || !inputs.map.moisture) return { map: null, paths: [] };
    const src = inputs.map;
    const density = clamp(num(inputs.density, params.density, 0.05), 0, 0.5);
    const width = Math.max(0.01, num(undefined, params.width, 40));
    const depth = Math.max(0.01, num(undefined, params.depth, 40));
    const heightScale = num(undefined, params.heightScale, 6);
    const heightOffset = num(undefined, params.heightOffset, 0);
    const lift = num(undefined, params.lift, 0.05);

    const sig = [src.rev, density, width, depth, heightScale, heightOffset, lift].join("|");
    const result = memoized(riversCache, ctx.nodeId, sig, (): RiversResult => {
      const rivers = generateRivers(src.mesh, src.elevation!, src.moisture!, { density });
      const P = src.mesh.points;
      const paths = rivers.paths.map((path) =>
        path.map((i) => {
          // A river mouth in the sea sits at the shoreline, not under the water.
          const h = Math.max(0, src.elevation![i]);
          return new THREE.Vector3((P[i * 2] - 0.5) * width, h * heightScale + heightOffset + lift, (P[i * 2 + 1] - 0.5) * depth);
        }),
      );
      return { map: extendMapData(src, { rivers, biomes: undefined }), paths };
    });
    return { map: result.map, paths: result.paths };
  },
};

/* -------------------------------------------------------------------------- */
/* Map Biomes                                                                 */
/* -------------------------------------------------------------------------- */

const biomesCache = createNodeCache<Memo<MapData | null>>();

const BIOMES_FIELDS: ParamFieldDef[] = [
  { id: "snowLine", label: "Snow Line", kind: "number", step: 0.02 },
  { id: "treeLine", label: "Tree Line", kind: "number", step: 0.02 },
  { id: "beach", label: "Beach Width", kind: "number", step: 0.01 },
  { id: "wetness", label: "Wetness Bias", kind: "number", step: 0.05 },
];

export const MAP_BIOMES_NODE: NodeDefinition = {
  type: "map/biomes",
  label: "Map Biomes",
  category: "map",
  inputs: [
    { id: "map", label: "Map", type: "any" },
    { id: "snowLine", label: "Snow Line", type: "value" },
    { id: "treeLine", label: "Tree Line", type: "value" },
    { id: "wetness", label: "Wetness Bias", type: "value" },
  ],
  outputs: [{ id: "map", label: "Map", type: "any" }],
  defaultParams: { snowLine: 0.8, treeLine: 0.6, beach: 0.04, wetness: 0 },
  paramFields: BIOMES_FIELDS,
  evaluate: (inputs, params, ctx) => {
    if (!isMapData(inputs.map) || !inputs.map.elevation || !inputs.map.moisture) return { map: null };
    const src = inputs.map;
    const snowLine = clamp(num(inputs.snowLine, params.snowLine, 0.8), 0, 1);
    const treeLine = clamp(num(inputs.treeLine, params.treeLine, 0.6), 0, 1);
    const beach = clamp(num(undefined, params.beach, 0.04), 0, 0.5);
    const wetness = clamp(num(inputs.wetness, params.wetness, 0), -1, 1);
    const map = memoized(biomesCache, ctx.nodeId, [src.rev, snowLine, treeLine, beach, wetness].join("|"), () => {
      const isLake = src.rivers?.isLake ?? new Uint8Array(src.mesh.numPoints);
      const biomes = generateBiomes(src.elevation!, src.moisture!, isLake, { snowLine, treeLine, beach, wetness });
      return extendMapData(src, { biomes });
    });
    return { map };
  },
};

/* -------------------------------------------------------------------------- */
/* Map To Textures                                                            */
/* -------------------------------------------------------------------------- */

interface TextureSet {
  heightmap: THREE.DataTexture;
  moisture: THREE.DataTexture;
  biome: THREE.DataTexture;
  rivers: THREE.DataTexture;
}

interface TexturesState {
  sig: string;
  size: number;
  set: TextureSet;
}

const texturesCache = createNodeCache<TexturesState>((s) => {
  s.set.heightmap.dispose();
  s.set.moisture.dispose();
  s.set.biome.dispose();
  s.set.rivers.dispose();
});

export const MAP_RESOLUTIONS = ["128", "256", "512", "1024"];

const TEXTURES_FIELDS: ParamFieldDef[] = [
  { id: "resolution", label: "Resolution", kind: "select", options: MAP_RESOLUTIONS },
  { id: "riverWidth", label: "River Width (px)", kind: "number", step: 0.5 },
];

function makeTexture(
  data: Float32Array | Uint8Array,
  size: number,
  type: THREE.TextureDataType,
  colorSpace: string,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, type);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Grey single-channel values -> RGBA8. */
function greyRGBA8(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(clamp(values[i], 0, 1) * 255);
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function buildTextures(map: MapData, size: number, riverWidth: number): TextureSet {
  const { mesh } = map;
  const n = mesh.numPoints;

  // Heightmap — Terrain's convention (row 0 is the -Z edge), land only: the sea is flat zero.
  const land = new Float32Array(n);
  if (map.elevation) for (let i = 0; i < n; i++) land[i] = Math.max(0, map.elevation[i]);
  const h = rasterize(mesh, land, 1, size, size, false);
  const hRGBA = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    hRGBA[i * 4] = h[i];
    hRGBA[i * 4 + 3] = 1;
  }

  // The other maps are plain UV-mapped images (row 0 at v = 0).
  const moist = rasterize(mesh, map.moisture ?? new Float32Array(n), 1, size, size, true);

  const colors = new Float32Array(n * 3);
  if (map.biomes) {
    for (let i = 0; i < n; i++) colors.set(BIOMES[map.biomes[i]]?.color ?? [0, 0, 0], i * 3);
  }
  const rgb = rasterize(mesh, colors, 3, size, size, true);
  const biomeRGBA = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    biomeRGBA[i * 4] = Math.round(clamp(rgb[i * 3], 0, 1) * 255);
    biomeRGBA[i * 4 + 1] = Math.round(clamp(rgb[i * 3 + 1], 0, 1) * 255);
    biomeRGBA[i * 4 + 2] = Math.round(clamp(rgb[i * 3 + 2], 0, 1) * 255);
    biomeRGBA[i * 4 + 3] = 255;
  }

  const riverMask = map.rivers
    ? drawPaths(mesh, map.rivers.paths, map.rivers.flow, size, size, true, riverWidth)
    : new Float32Array(size * size);

  return {
    heightmap: makeTexture(hRGBA, size, THREE.FloatType, THREE.NoColorSpace),
    moisture: makeTexture(greyRGBA8(moist), size, THREE.UnsignedByteType, THREE.NoColorSpace),
    biome: makeTexture(biomeRGBA, size, THREE.UnsignedByteType, THREE.SRGBColorSpace),
    rivers: makeTexture(greyRGBA8(riverMask), size, THREE.UnsignedByteType, THREE.NoColorSpace),
  };
}

export const MAP_TO_TEXTURES_NODE: NodeDefinition = {
  type: "map/to-textures",
  label: "Map To Textures",
  category: "map",
  inputs: [{ id: "map", label: "Map", type: "any" }],
  outputs: [
    { id: "heightmap", label: "Heightmap", type: "texture" },
    { id: "biome", label: "Biome Colors", type: "texture" },
    { id: "moisture", label: "Moisture", type: "texture" },
    { id: "rivers", label: "Rivers Mask", type: "texture" },
  ],
  defaultParams: { resolution: "256", riverWidth: 1 },
  paramFields: TEXTURES_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const none = { heightmap: null, biome: null, moisture: null, rivers: null };
    if (!isMapData(inputs.map)) return none;
    const map = inputs.map;
    const size = MAP_RESOLUTIONS.includes(String(params.resolution)) ? Number(params.resolution) : 256;
    const riverWidth = clamp(num(undefined, params.riverWidth, 1), 0.25, 8);
    const sig = `${map.rev}|${size}|${riverWidth}`;

    let state = texturesCache.get(ctx.nodeId);
    if (!state || state.sig !== sig) {
      const next = buildTextures(map, size, riverWidth);
      if (state) {
        // Rebuilt textures replace the old ones; free the old GPU copies.
        state.set.heightmap.dispose();
        state.set.moisture.dispose();
        state.set.biome.dispose();
        state.set.rivers.dispose();
      }
      state = { sig, size, set: next };
      texturesCache.set(ctx.nodeId, state);
    }
    return { ...state.set };
  },
};

/* -------------------------------------------------------------------------- */
/* Map Stylize                                                                */
/* -------------------------------------------------------------------------- */

interface StylizeState {
  sig: string;
  texture: THREE.DataTexture;
}

const stylizeCache = createNodeCache<StylizeState>((s) => s.texture.dispose());

export const MAP_STYLE_RESOLUTIONS = ["256", "512", "1024"];

const STYLIZE_FIELDS: ParamFieldDef[] = [
  { id: "resolution", label: "Resolution", kind: "select", options: MAP_STYLE_RESOLUTIONS },
  { id: "biomeColors", label: "Biome Colors", kind: "number", step: 0.05, group: "Color" },
  { id: "lightAngle", label: "Light Angle (°)", kind: "number", step: 5, group: "Light" },
  { id: "slope", label: "Slope", kind: "number", step: 0.1, group: "Light" },
  { id: "flat", label: "Flat", kind: "number", step: 0.1, group: "Light" },
  { id: "ambient", label: "Ambient", kind: "number", step: 0.05, group: "Light" },
  { id: "overhead", label: "Overhead", kind: "number", step: 1, group: "Light" },
  { id: "outlineStrength", label: "Outline Strength", kind: "number", step: 1, group: "Outline" },
  { id: "outlineDepth", label: "Outline Depth", kind: "number", step: 0.1, group: "Outline" },
  { id: "outlineThreshold", label: "Outline Threshold", kind: "number", step: 1, group: "Outline" },
  { id: "outlineWater", label: "River Channel / Coast Lift", kind: "number", step: 1, group: "Outline" },
  { id: "riverWidth", label: "River Width", kind: "number", step: 0.1, group: "Rivers" },
];

/**
 * Map Stylize — the Red Blob Games look. Bakes elevation × moisture colours,
 * slope lighting, outlines and flat blue rivers into one image; show it on a
 * Terrain with Shadeless on (the lighting is already in the pixels) and a
 * white material colour. Defaults are mapgen4's own render sliders.
 */
export const MAP_STYLIZE_NODE: NodeDefinition = {
  type: "map/stylize",
  label: "Map Stylize",
  category: "map",
  inputs: [{ id: "map", label: "Map", type: "any" }],
  outputs: [{ id: "image", label: "Image", type: "texture" }],
  defaultParams: { resolution: "512", ...MAPGEN4_STYLE },
  paramFields: STYLIZE_FIELDS,
  evaluate: (inputs, params, ctx) => {
    if (!isMapData(inputs.map) || !inputs.map.elevation) return { image: null };
    const map = inputs.map;
    const size = MAP_STYLE_RESOLUTIONS.includes(String(params.resolution)) ? Number(params.resolution) : 512;
    const d = MAPGEN4_STYLE;
    const style = {
      size,
      lightAngle: num(undefined, params.lightAngle, d.lightAngle),
      slope: clamp(num(undefined, params.slope, d.slope), 0, 10),
      flat: clamp(num(undefined, params.flat, d.flat), 0, 10),
      ambient: clamp(num(undefined, params.ambient, d.ambient), 0, 2),
      overhead: clamp(num(undefined, params.overhead, d.overhead), 0, 100),
      outlineStrength: clamp(num(undefined, params.outlineStrength, d.outlineStrength), 0, 60),
      outlineDepth: clamp(num(undefined, params.outlineDepth, d.outlineDepth), 0, 4),
      outlineThreshold: clamp(num(undefined, params.outlineThreshold, d.outlineThreshold), 0, 100),
      outlineWater: clamp(num(undefined, params.outlineWater, d.outlineWater), 0, 20),
      biomeColors: clamp(num(undefined, params.biomeColors, d.biomeColors), 0, 1),
      riverWidth: clamp(num(undefined, params.riverWidth, d.riverWidth), 0.1, 6),
    };
    const sig = `${map.rev}|${Object.values(style).join("|")}`;
    let state = stylizeCache.get(ctx.nodeId);
    if (!state || state.sig !== sig) {
      const data = stylizeMap(
        { mesh: map.mesh, elevation: map.elevation!, moisture: map.moisture, rivers: map.rivers },
        style,
      );
      // Rebuilt rather than refilled when the size changes; the same texture object is kept otherwise so Terrain isn't re-keyed.
      if (state && state.texture.image.width === size) {
        (state.texture.image.data as Uint8Array).set(data);
        state.texture.needsUpdate = true;
        state.sig = sig;
      } else {
        state?.texture.dispose();
        state = { sig, texture: makeTexture(data, size, THREE.UnsignedByteType, THREE.SRGBColorSpace) };
        stylizeCache.set(ctx.nodeId, state);
      }
    }
    return { image: state.texture };
  },
};
