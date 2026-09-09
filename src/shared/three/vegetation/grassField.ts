import * as THREE from "three";
import { WIND_GLSL, WIND_UNIFORM_DECL, createWindUniforms } from "./windField";
import { MAP_UV_GLSL } from "./interactionMap";

/**
 * A field of grass that is finite in memory and infinite on screen.
 *
 * Two ideas do all the work, both borrowed from the way real-time foliage is
 * usually solved rather than invented here:
 *
 * 1. **No instancing.** A blade is three vertices, and an InstancedMesh of
 *    three-vertex instances spends more on the per-instance matrix than on the
 *    blade. So the whole field is *one* BufferGeometry of loose triangles; the
 *    blade's shape is rebuilt in the vertex shader from a corner index (tip /
 *    left / right) and a per-blade random. One draw call, no matrices.
 *
 * 2. **Toroidal wrapping.** Blade bases are laid out once in a square of side
 *    `size`, then each frame the shader folds them modulo that square around a
 *    moving centre. Walk forward and the blades behind you reappear in front,
 *    so a fixed 30k blades cover an unbounded world at a fixed cost and with
 *    zero reallocation. The scatter is jittered per cell, so the fold has no
 *    visible seam and no grid pattern.
 *
 * Height, colour and existence are all modulated by an optional density map,
 * which is what makes the field authorable: paint where grass grows instead of
 * placing it. Outside the map, nothing grows.
 */

export interface GrassGeometryOptions {
  /** Blades per side. Total blade count is the square of this. */
  subdivisions: number;
  /** World size of the wrapping square. */
  size: number;
  /** Scatter seed — same seed, same field, every run and every export frame. */
  seed: number;
}

/** Deterministic PRNG (mulberry32) — the field must be identical across reloads and exports. */
export function createRandom(seed: number): () => number {
  let a = Math.floor(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Three vertices per blade: corner 0 is the tip, 1 and 2 the base corners.
 *
 * `position` carries the blade's *base* point (y = 0) rather than the vertex's
 * final position, which the shader derives. It is a real vec3 attribute on
 * purpose: it keeps the geometry legible to every generic node in the graph
 * that walks vertices, instead of being a vec2 that silently means something
 * else.
 */
export function buildGrassGeometry(options: GrassGeometryOptions): THREE.BufferGeometry {
  const subdivisions = Math.max(1, Math.floor(options.subdivisions));
  const size = Math.max(0.001, options.size);
  const count = subdivisions * subdivisions;
  const fragmentSize = size / subdivisions;
  const random = createRandom(options.seed);

  const positions = new Float32Array(count * 3 * 3);
  const corners = new Float32Array(count * 3);
  const randoms = new Float32Array(count * 3);

  for (let ix = 0; ix < subdivisions; ix++) {
    const cellX = (ix / subdivisions - 0.5) * size + fragmentSize * 0.5;

    for (let iz = 0; iz < subdivisions; iz++) {
      const cellZ = (iz / subdivisions - 0.5) * size + fragmentSize * 0.5;

      const bladeIndex = ix * subdivisions + iz;
      const x = cellX + (random() - 0.5) * fragmentSize;
      const z = cellZ + (random() - 0.5) * fragmentSize;
      const bladeRandom = random();

      for (let corner = 0; corner < 3; corner++) {
        const vertex = bladeIndex * 3 + corner;
        positions[vertex * 3] = x;
        positions[vertex * 3 + 1] = 0;
        positions[vertex * 3 + 2] = z;
        corners[vertex] = corner;
        randoms[vertex] = bladeRandom;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aCorner", new THREE.Float32BufferAttribute(corners, 1));
  geometry.setAttribute("aRandom", new THREE.Float32BufferAttribute(randoms, 1));

  // The shader moves vertices far outside their authored bounds (the wrap
  // recentres the whole field), so a computed bounding sphere would cull the
  // field the moment the centre moved. A generous manual one, plus
  // frustumCulled = false on the mesh, is the honest answer.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), size);

  return geometry;
}

const GRASS_VERTEX = /* glsl */ `
  ${WIND_UNIFORM_DECL}
  uniform vec2 uCenter;
  uniform float uSize;
  uniform float uBladeWidth;
  uniform float uBladeHeight;
  uniform float uHeightRandomness;
  uniform float uWindInfluence;
  uniform float uDensityThreshold;
  uniform float uHasDensityMap;
  uniform sampler2D uDensityMap;
  uniform vec2 uDensityCenter;
  uniform float uDensitySize;
  uniform float uHasTrampleMap;
  uniform sampler2D uTrampleMap;
  uniform vec2 uTrampleCenter;
  uniform float uTrampleSize;
  uniform float uTrampleStrength;

  attribute float aCorner;
  attribute float aRandom;

  varying float vTipness;
  varying float vRandom;
  varying float vDensity;
  varying float vTrample;

  ${WIND_GLSL}
  ${MAP_UV_GLSL}

  void main() {
    vec4 base = modelMatrix * vec4(position, 1.0);

    // Fold the blade into the square centred on uCenter — the infinite field.
    float halfSize = uSize * 0.5;
    vec2 local = mod(base.xz - uCenter + halfSize, uSize) - halfSize;
    vec2 world = local + uCenter;

    float density = 1.0;
    if (uHasDensityMap > 0.5) {
      vec2 densityUv = mapUv(world, uDensityCenter, uDensitySize);
      // Nothing grows off the edge of the map.
      density = texture2D(uDensityMap, clamp(densityUv, 0.0, 1.0)).r * mapInside(densityUv);
    }
    density = smoothstep(uDensityThreshold, uDensityThreshold + 0.15, density);

    // Whatever has passed through here flattens the blade rather than
    // deleting it: trampled grass is bent, not absent.
    float trample = 0.0;
    if (uHasTrampleMap > 0.5) {
      vec2 trampleUv = mapUv(world, uTrampleCenter, uTrampleSize);
      trample = texture2D(uTrampleMap, clamp(trampleUv, 0.0, 1.0)).r * mapInside(trampleUv);
      trample = clamp(trample * uTrampleStrength, 0.0, 1.0);
    }
    vTrample = trample;
    vDensity = density;

    // Broad clumps of taller grass, so the field reads as terrain rather than carpet.
    float heightVariation = 0.7 + 0.6 * windNoise(world * 0.05);
    float height = uBladeHeight
      * mix(1.0 - uHeightRandomness, 1.0, aRandom)
      * heightVariation
      * density;

    float angle = aRandom * 6.2831853;
    vec3 side = vec3(cos(angle), 0.0, sin(angle)) * uBladeWidth * 0.5;

    vec2 wind = windOffset(world) * uWindInfluence;

    vec3 finalPosition = vec3(world.x, base.y, world.y);
    float isTip = step(aCorner, 0.5);
    vTipness = isTip;
    vRandom = aRandom;

    if (isTip > 0.5) {
      // The tip leans with the wind and drops as it leans — a blade bends,
      // it does not stretch.
      finalPosition += vec3(wind.x * height, height, wind.y * height);
      finalPosition.y -= length(wind) * height * 0.35;

      // Trampled: the tip folds over sideways in a per-blade direction, so a
      // crushed patch reads as flattened grass instead of shorter grass.
      float foldAngle = aRandom * 6.2831853;
      vec3 fold = vec3(cos(foldAngle), 0.0, sin(foldAngle)) * height * trample * 0.9;
      finalPosition += fold;
      finalPosition.y -= height * trample * 0.75;
    } else {
      finalPosition += side * (aCorner < 1.5 ? 1.0 : -1.0);
    }

    gl_Position = projectionMatrix * viewMatrix * vec4(finalPosition, 1.0);
  }
`;

const GRASS_FRAGMENT = /* glsl */ `
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform vec3 uLightDirection;
  uniform float uAmbient;
  uniform vec3 uShadowColor;
  uniform float uShadowIntensity;

  varying float vTipness;
  varying float vRandom;
  varying float vDensity;
  varying float vTrample;

  void main() {
    if (vDensity <= 0.001) discard;

    vec3 color = mix(uBaseColor, uTipColor, vTipness);
    // Flattened grass sits in its own shadow and shows more of the litter
    // underneath, so it darkens and desaturates toward the base colour.
    color = mix(color, uBaseColor * 0.75, vTrample);
    // Per-blade tint break-up: a uniform green field looks synthetic.
    color *= 0.88 + 0.24 * vRandom;

    // A blade is flat-shaded against the light with a fake vertical AO — real
    // per-vertex normals on three vertices would only ever be a guess anyway.
    float diffuse = 0.55 + 0.45 * max(dot(normalize(uLightDirection), vec3(0.0, 1.0, 0.0)), 0.0);

    // The light that reaches a blade's root has been filtered by every blade
    // around it, so the base tints toward the shadow colour and the tip keeps
    // its own. vTipness interpolates 0 -> 1 up the triangle, which is the
    // gradient we want for free. Trampled blades lie in the litter, so they
    // sink further into it.
    float rootness = (1.0 - vTipness) * (1.0 + vTrample * 0.5);
    color = mix(color, uShadowColor, clamp(rootness * uShadowIntensity, 0.0, 1.0));

    gl_FragColor = vec4(color * (uAmbient + diffuse), 1.0);
  }
`;

export function createGrassMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...createWindUniforms(),
      uCenter: { value: new THREE.Vector2() },
      uSize: { value: 60 },
      uBladeWidth: { value: 0.09 },
      uBladeHeight: { value: 0.55 },
      uHeightRandomness: { value: 0.6 },
      uWindInfluence: { value: 1 },
      uDensityThreshold: { value: 0.05 },
      uHasDensityMap: { value: 0 },
      uDensityMap: { value: null },
      uDensityCenter: { value: new THREE.Vector2() },
      uDensitySize: { value: 60 },
      uHasTrampleMap: { value: 0 },
      uTrampleMap: { value: null },
      uTrampleCenter: { value: new THREE.Vector2() },
      uTrampleSize: { value: 60 },
      uTrampleStrength: { value: 1 },
      uBaseColor: { value: new THREE.Color(0x2f5d2a) },
      uTipColor: { value: new THREE.Color(0xa8c34a) },
      uLightDirection: { value: new THREE.Vector3(0.5, 1, 0.3).normalize() },
      uAmbient: { value: 0.35 },
      uShadowColor: { value: new THREE.Color(0x000000) },
      uShadowIntensity: { value: 0.55 },
    },
    vertexShader: GRASS_VERTEX,
    fragmentShader: GRASS_FRAGMENT,
    side: THREE.DoubleSide,
  });
}

/* -------------------------------------------------------------------------- */
/* Ground shadow                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The shadow the field casts on the ground it stands on, as a *texture*.
 *
 * The blades cannot cast it themselves: they are three-vertex triangles with
 * no honest normals, and a shadow map of 30k of them would cost more than the
 * field. Nor is a dark quad laid over the ground the answer — it is one more
 * transparent surface to sort, and it fights whatever the ground's own
 * material is doing.
 *
 * What actually reads as a grass shadow is a soft darkening that follows
 * *where the grass is* — which is exactly what the density map already says.
 * So the shadow is that map, blurred and tinted, handed back as a texture to
 * be multiplied into the ground's own map (Mix Texture, blend mode Multiply).
 * White where nothing grows, so the multiply is a no-op there; the shadow
 * colour where the field is dense. The ground keeps one material, one draw
 * call, and its texture is composed in the graph like any other.
 */

/**
 * Separable box blur, three passes — the classic cheap approximation of a
 * gaussian. Kept as a pure function over a mask so it is testable without a
 * canvas, and so the blur radius can be reasoned about in pixels.
 */
export function blurMask(mask: Float32Array, size: number, radius: number): Float32Array {
  const r = Math.floor(radius);
  if (r < 1) return mask.slice();

  let src = mask.slice();
  let dst = new Float32Array(mask.length);

  for (let pass = 0; pass < 3; pass++) {
    // Horizontal, then vertical — a box blur separates, so 2 * O(n) beats
    // O(n * r²) and the three passes cost less than one honest gaussian.
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          let sum = 0;
          let count = 0;
          for (let k = -r; k <= r; k++) {
            const s = j + k;
            if (s < 0 || s >= size) continue;
            sum += axis === 0 ? src[i * size + s] : src[s * size + i];
            count++;
          }
          const value = sum / count;
          if (axis === 0) dst[i * size + j] = value;
          else dst[j * size + i] = value;
        }
      }
      const swap = src;
      src = dst;
      dst = swap;
    }
  }

  return src;
}

export interface GroundShadowOptions {
  /** The field's density map, or null when grass covers the square evenly. */
  density: THREE.Texture | null;
  /** The colour the ground is tinted toward. Multiplied, so white is a no-op. */
  color: THREE.Color;
  /** 0 leaves the ground untouched, 1 reaches the shadow colour under dense grass. */
  intensity: number;
  /** Blur radius as a fraction of the map's width — a real distance on the ground. */
  softness: number;
  /** Texture resolution. */
  resolution: number;
}

/**
 * Reads the density map, blurs it and paints the tint. Returns null off-DOM
 * (headless evaluation and the test runner), like every other canvas node.
 *
 * The mask is the density map's raw red channel — not the blade's growth
 * smoothstep. That threshold decides a binary yes/no per blade over a narrow
 * 0.05-wide band, so a density map whose values mostly sit above it (which is
 * the common case — most authored maps stay bright except where they mean to
 * bare the ground) saturates the mask to a flat 1 almost everywhere, and the
 * shadow stops tracking the map at all. The ground doesn't grow blades, it
 * just darkens with how much grass is nearby — density → blur → multiply.
 */
export function buildGroundShadowCanvas(
  canvas: HTMLCanvasElement,
  readDensity: (resolution: number) => Uint8ClampedArray | null,
  options: GroundShadowOptions,
): boolean {
  const resolution = Math.max(16, Math.min(1024, Math.round(options.resolution)));
  canvas.width = resolution;
  canvas.height = resolution;
  const context = canvas.getContext("2d");
  if (!context) return false;

  const pixels = options.density ? readDensity(resolution) : null;
  const mask = new Float32Array(resolution * resolution);

  if (pixels) {
    for (let i = 0; i < mask.length; i++) {
      mask[i] = pixels[i * 4] / 255;
    }
  } else {
    mask.fill(1);
  }

  const blurred = blurMask(mask, resolution, options.softness * resolution);

  const image = context.createImageData(resolution, resolution);
  const { r, g, b } = options.color;
  for (let i = 0; i < blurred.length; i++) {
    const amount = Math.max(0, Math.min(1, blurred[i] * options.intensity));
    // White where there is no grass: this texture is multiplied into the
    // ground's own, and 1 is the identity of a multiply.
    image.data[i * 4] = Math.round((1 + (r - 1) * amount) * 255);
    image.data[i * 4 + 1] = Math.round((1 + (g - 1) * amount) * 255);
    image.data[i * 4 + 2] = Math.round((1 + (b - 1) * amount) * 255);
    image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);

  return true;
}
