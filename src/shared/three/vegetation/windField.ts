import * as THREE from "three";

/**
 * The global wind field — one noise, sampled identically on the CPU and in
 * every shader that wants to be blown about.
 *
 * The point of factoring it out is that grass, foliage, a swaying mesh and a
 * particle force field must agree on where the wind *is* at a given world
 * position, or the scene falls apart visually: the grass leans left while the
 * leaves above it lean right. So the field is described once (direction,
 * strength, scale, phase), passed around as a plain descriptor on an `any`
 * socket, and turned into either a `sampleWind()` call in TypeScript or the
 * same `windOffset()` function in GLSL — the two implementations below are
 * deliberately line-for-line equivalents and the unit tests hold them to it.
 *
 * Two octaves of value noise scrolled along the wind direction: the fast one
 * gives the individual gust, the slow one the long swell that makes a field
 * of grass look like it has weather over it rather than a vibration.
 */
export interface WindFieldDescriptor {
  /** Tag so a node receiving an `any` socket can tell a wind field from a force field. */
  kind: "wind";
  /** Horizontal direction, normalised. XZ world plane — y is never windy here. */
  direction: THREE.Vector2;
  /** Peak displacement in world units at full gust. */
  strength: number;
  /** World-space frequency: how large a single gust is. Low = broad rolling wind. */
  positionFrequency: number;
  /**
   * Scroll distance already accumulated, in noise units — the node folds
   * `time × timeFrequency` into this so the shader has no clock of its own
   * and an exported frame is reproducible from its frame number alone.
   */
  phase: number;
  /** Weight of the slow second octave. 0 = steady breeze, 1 = squally. */
  gustiness: number;
}

export const DEFAULT_WIND: WindFieldDescriptor = {
  kind: "wind",
  direction: new THREE.Vector2(Math.sin(Math.PI * 0.6), Math.cos(Math.PI * 0.6)),
  strength: 0.5,
  positionFrequency: 0.5,
  phase: 0,
  gustiness: 1,
};

/** True for a value arriving on an `any` socket that is actually a wind field. */
export function isWindField(value: unknown): value is WindFieldDescriptor {
  return Boolean(value) && (value as WindFieldDescriptor).kind === "wind";
}

/** Same hash the GLSL uses — a sin-based one, cheap and adequate for wind. */
function windHash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Bilinear value noise with a smoothstep fade, matching `windNoise` in WIND_GLSL. */
function windNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const a = windHash(ix, iy);
  const b = windHash(ix + 1, iy);
  const c = windHash(ix, iy + 1);
  const d = windHash(ix + 1, iy + 1);

  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uy;
}

/**
 * The wind's horizontal displacement at a world XZ position, in world units.
 * Writes into `target` when given one so a per-vertex loop allocates nothing.
 */
export function sampleWind(
  field: WindFieldDescriptor,
  worldX: number,
  worldZ: number,
  target = new THREE.Vector2(),
): THREE.Vector2 {
  const px = worldX * field.positionFrequency;
  const pz = worldZ * field.positionFrequency;

  const n1 = windNoise(px * 0.2 + field.direction.x * field.phase, pz * 0.2 + field.direction.y * field.phase) - 0.5;
  const n2 =
    windNoise(px * 0.1 + field.direction.x * field.phase * 0.2, pz * 0.1 + field.direction.y * field.phase * 0.2) - 0.5;

  const intensity = (n1 + n2 * field.gustiness) * field.strength;
  return target.set(field.direction.x * intensity, field.direction.y * intensity);
}

/** The uniform block every wind-aware material declares. Names are shared, so is the setter below. */
export const WIND_UNIFORM_DECL = /* glsl */ `
  uniform vec2 uWindDirection;
  uniform float uWindStrength;
  uniform float uWindPositionFrequency;
  uniform float uWindPhase;
  uniform float uWindGustiness;
`;

/** The GLSL twin of `sampleWind`. Include after WIND_UNIFORM_DECL. */
export const WIND_GLSL = /* glsl */ `
  float windHash(vec2 p) {
    return fract(sin(p.x * 127.1 + p.y * 311.7) * 43758.5453123);
  }

  float windNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = windHash(i);
    float b = windHash(i + vec2(1.0, 0.0));
    float c = windHash(i + vec2(0.0, 1.0));
    float d = windHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  vec2 windOffset(vec2 worldXZ) {
    vec2 p = worldXZ * uWindPositionFrequency;
    float n1 = windNoise(p * 0.2 + uWindDirection * uWindPhase) - 0.5;
    float n2 = windNoise(p * 0.1 + uWindDirection * uWindPhase * 0.2) - 0.5;
    float intensity = (n1 + n2 * uWindGustiness) * uWindStrength;
    return uWindDirection * intensity;
  }
`;

/** Fresh uniforms for a wind-aware material, pre-filled with the default breeze. */
export function createWindUniforms(): Record<string, THREE.IUniform> {
  return {
    uWindDirection: { value: DEFAULT_WIND.direction.clone() },
    uWindStrength: { value: DEFAULT_WIND.strength },
    uWindPositionFrequency: { value: DEFAULT_WIND.positionFrequency },
    uWindPhase: { value: DEFAULT_WIND.phase },
    uWindGustiness: { value: DEFAULT_WIND.gustiness },
  };
}

/** Pushes a descriptor into a material's wind uniforms. Silently ignores a material without them. */
export function applyWindUniforms(
  uniforms: Record<string, THREE.IUniform> | undefined,
  field: WindFieldDescriptor,
): void {
  if (!uniforms || !uniforms.uWindDirection) return;
  (uniforms.uWindDirection.value as THREE.Vector2).copy(field.direction);
  uniforms.uWindStrength.value = field.strength;
  uniforms.uWindPositionFrequency.value = field.positionFrequency;
  uniforms.uWindPhase.value = field.phase;
  uniforms.uWindGustiness.value = field.gustiness;
}
