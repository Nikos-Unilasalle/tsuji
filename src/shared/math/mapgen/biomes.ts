export interface BiomeDef {
  id: number;
  name: string;
  /** sRGB 0..1. */
  color: [number, number, number];
}

export const BIOMES: BiomeDef[] = [
  { id: 0, name: "Deep Ocean", color: [0.1, 0.22, 0.42] },
  { id: 1, name: "Shallows", color: [0.2, 0.42, 0.62] },
  { id: 2, name: "Beach", color: [0.82, 0.77, 0.58] },
  { id: 3, name: "Lake", color: [0.25, 0.5, 0.7] },
  { id: 4, name: "Marsh", color: [0.35, 0.5, 0.4] },
  { id: 5, name: "Grassland", color: [0.45, 0.65, 0.3] },
  { id: 6, name: "Forest", color: [0.2, 0.45, 0.22] },
  { id: 7, name: "Rainforest", color: [0.1, 0.38, 0.2] },
  { id: 8, name: "Savanna", color: [0.7, 0.66, 0.35] },
  { id: 9, name: "Desert", color: [0.85, 0.75, 0.5] },
  { id: 10, name: "Rock", color: [0.5, 0.47, 0.44] },
  { id: 11, name: "Snow", color: [0.95, 0.96, 0.98] },
];

export interface BiomeParams {
  /** Elevation above which rock gives way to snow. */
  snowLine: number;
  /** Elevation above which vegetation stops. */
  treeLine: number;
  /** Elevation band just above the sea that counts as beach. */
  beach: number;
  /** Shifts every moisture threshold: positive = wetter world. */
  wetness: number;
}

export function classifyBiome(elevation: number, moisture: number, isLake: boolean, p: BiomeParams): number {
  if (elevation <= 0) return elevation < -0.15 ? 0 : 1;
  if (isLake) return 3;
  if (elevation > p.snowLine) return 11;
  if (elevation > p.treeLine) return 10;
  if (elevation < p.beach) return moisture + p.wetness > 0.75 ? 4 : 2;
  const m = moisture + p.wetness;
  if (m < 0.1) return 9;
  if (m < 0.25) return 8;
  if (m < 0.55) return 5;
  if (m < 0.8) return 6;
  return 7;
}

export function generateBiomes(
  elevation: Float32Array,
  moisture: Float32Array,
  isLake: Uint8Array,
  p: BiomeParams,
): Uint8Array {
  const out = new Uint8Array(elevation.length);
  for (let i = 0; i < out.length; i++) out[i] = classifyBiome(elevation[i], moisture[i], isLake[i] === 1, p);
  return out;
}
