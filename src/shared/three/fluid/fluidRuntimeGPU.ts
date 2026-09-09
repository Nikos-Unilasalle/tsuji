import * as THREE from "three";
import {
  DEFAULT_FLUID_PARAMS,
  FluidEmitterDescriptor,
  FluidForceField,
  FluidGridConfig,
  FluidSimParams,
  generateCurlNoiseField3D,
  REFERENCE_EMITTER_SAMPLES,
} from "./fluidRuntime3D";

/**
 * Solveur de fluide 3D sur GPU, portage de fluidRuntime3D.ts en WebGL2.
 *
 * Le solveur CPU sature le thread principal : ~38 ms par pas pour 66k cellules,
 * ce qui plafonne la grille bien en dessous des 2 M cellules de l'exemple
 * three.js. Ici chaque passe est un quad plein écran rendu une fois PAR TRANCHE Z
 * dans un WebGL3DRenderTarget (three.js attache la tranche via
 * framebufferTextureLayer quand on passe l'index en deuxième argument de
 * setRenderTarget). Le fragment shader fait le travail des kernels compute WGSL
 * de l'exemple ; WebGL2 n'ayant pas de compute shader, c'est le seul chemin sans
 * migrer tout le renderer vers WebGPU.
 *
 * L'enchaînement des passes et les buffers sont volontairement identiques au CPU
 * et à l'exemple : advection vélocité -> divergence -> Jacobi -> projection ->
 * advection dye -> émission.
 *
 * Sans renderer (tests, évaluation headless) rien n'est construit : l'appelant
 * retombe sur le solveur CPU.
 */

/** Textures demi-flottantes : rgba16float est filtrable linéairement en WebGL2 de base, contrairement au float 32 bits. */
const TEXTURE_TYPE = THREE.HalfFloatType;

function createTarget3D(config: FluidGridConfig, name: string): THREE.WebGL3DRenderTarget {
  const rt = new THREE.WebGL3DRenderTarget(config.gridX, config.gridY, config.gridZ);
  rt.texture.name = name;
  rt.texture.format = THREE.RGBAFormat;
  rt.texture.type = TEXTURE_TYPE;
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  rt.texture.wrapR = THREE.ClampToEdgeWrapping;
  rt.texture.generateMipmaps = false;
  rt.depthBuffer = false;
  rt.stencilBuffer = false;
  return rt;
}

interface PingPong {
  read: THREE.WebGL3DRenderTarget;
  write: THREE.WebGL3DRenderTarget;
  swap(): void;
}

function createPingPong(config: FluidGridConfig, name: string): PingPong {
  const pp: PingPong = {
    read: createTarget3D(config, `${name} A`),
    write: createTarget3D(config, `${name} B`),
    swap() {
      const t = this.read;
      this.read = this.write;
      this.write = t;
    },
  };
  return pp;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * Quad plein écran : la géométrie couvre déjà le NDC, aucune matrice n'est
 * nécessaire.
 *
 * `position` et `uv` doivent être déclarés explicitement : contrairement à
 * ShaderMaterial, RawShaderMaterial n'injecte AUCUN préambule — ni attributs,
 * ni matrices. Les omettre fait échouer la compilation avec
 * "'uv' : undeclared identifier", et le solveur tombe silencieusement.
 */
const QUAD_VERTEX = /* glsl */ `
  in vec3 position;
  in vec2 uv;

  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** En-tête commun à toutes les passes : la tranche courante devient la 3e coordonnée. */
const FRAG_HEADER = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  uniform vec3 uTexel;     // 1 / dimensions de grille
  uniform float uSlice;    // (z + 0.5) / gridZ de la tranche en cours d'écriture

  vec3 cellUVW() { return vec3(vUv, uSlice); }
`;

const ADVECT_VELOCITY_FRAG = /* glsl */ `
  ${FRAG_HEADER}

  uniform sampler3D uVel;
  uniform sampler3D uDye;
  uniform sampler3D uCurl;

  uniform vec3 uVolumeSize;
  uniform float uDt;
  uniform float uTime;
  uniform float uBuoyancy;
  uniform float uSmokeWeight;
  uniform float uTurbulence;
  uniform float uTurbulenceDecay;
  uniform float uTurbFrequency;
  uniform float uVelDamping;
  uniform vec3 uWind;

  uniform mat4 uVolumeToWorld;
  uniform mat3 uWorldToVolumeBasis;

  // Champs de force (particles/force-field), même sémantique que le CPU
  #define MAX_FORCES 8
  uniform int uForceCount;
  uniform int uForceType[MAX_FORCES];      // 0 attractor, 1 vortex, 2 wind, 3 turbulence
  uniform vec3 uForcePosition[MAX_FORCES];
  uniform vec3 uForceAxis[MAX_FORCES];
  uniform float uForceStrength[MAX_FORCES];
  uniform float uForceRadius[MAX_FORCES];
  uniform float uForceScale[MAX_FORCES];
  uniform float uForceSpeed[MAX_FORCES];

  // Sphère de vent induite par un émetteur en mouvement
  uniform int uEmitterMoving;
  uniform vec3 uEmitterPosition;
  uniform vec3 uEmitterVelocity;
  uniform float uEmitterSpeed;
  uniform float uEmitterWindStrength;
  uniform float uEmitterWindRadius;

  // Bruit de valeur 3D bon marché, uniquement pour les champs de turbulence
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float valueNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0));
    float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
    float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
    float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z) * 2.0 - 1.0;
  }

  vec3 forceFieldAccel(vec3 worldPos) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < MAX_FORCES; i++) {
      if (i >= uForceCount) break;
      vec3 delta = uForcePosition[i] - worldPos;
      float dist = length(delta);
      float falloff = 1.0;
      if (uForceRadius[i] > 0.0) {
        if (dist >= uForceRadius[i]) continue;
        falloff = 1.0 - dist / uForceRadius[i];
      }
      float gain = uForceStrength[i] * falloff;
      int t = uForceType[i];
      if (t == 0) {
        if (dist > 1e-4) acc += delta * (gain / dist);
      } else if (t == 1) {
        vec3 axis = uForceAxis[i];
        vec3 radial = worldPos - uForcePosition[i];
        radial -= axis * dot(radial, axis);
        if (dot(radial, radial) > 1e-8) acc += normalize(cross(axis, radial)) * gain;
      } else if (t == 2) {
        acc += uForceAxis[i] * gain;
      } else {
        float s = max(1e-3, uForceScale[i]);
        float drift = uTime * uForceSpeed[i];
        acc += vec3(
          valueNoise(vec3(worldPos.x * s + drift, worldPos.y * s, worldPos.z * s)),
          valueNoise(vec3(worldPos.x * s, worldPos.y * s + drift, worldPos.z * s + 41.3)),
          valueNoise(vec3(worldPos.x * s + 17.7, worldPos.y * s, worldPos.z * s + drift))
        ) * gain;
      }
    }
    return acc;
  }

  void main() {
    vec3 uvw = cellUVW();
    vec3 vel = texture(uVel, uvw).xyz;

    // Advection semi-lagrangienne : remonter la trajectoire
    vec3 prevPos = uvw - (vel / uVolumeSize) * uDt;
    vec3 newVel = texture(uVel, prevPos).xyz;

    vec4 dye = texture(uDye, uvw);
    float density = dye.r;
    float temperature = dye.g;
    float age = dye.b;

    // Flottabilité thermique contre poids de la fumée
    float buoyancy = (temperature * uBuoyancy - density * uSmokeWeight) * uVolumeSize.y;
    newVel.y += buoyancy * uDt;

    // Turbulence thermique : suit le panache via l'âge, décroît avec lui
    float invFreq = 1.0 / max(0.1, uTurbFrequency);
    vec3 thermalPos = uvw + vec3(0.0, -age * 0.6, age * 0.13) * invFreq;
    vec3 thermal = texture(uCurl, fract(thermalPos)).xyz
                 * uTurbulence * temperature * exp(-uTurbulenceDecay * age);

    // Turbulence ambiante : basse fréquence, animée, agit sur la fumée refroidie
    vec3 ambientPos = uvw * 0.5 + vec3(0.0, uTime * 0.25, uTime * 0.06) * invFreq;
    vec3 ambient = texture(uCurl, fract(ambientPos)).xyz * (uTurbulence * 0.2) * density;

    newVel += (thermal + ambient) * uVolumeSize.y * uDt;
    newVel += uWind * uDt;

    // Amortissement
    newVel *= max(1.0 - uVelDamping * uDt, 0.0);

    if (uForceCount > 0 || uEmitterMoving == 1) {
      vec3 localPos = (uvw - 0.5) * uVolumeSize;
      vec3 worldPos = (uVolumeToWorld * vec4(localPos, 1.0)).xyz;

      if (uForceCount > 0) {
        newVel += (uWorldToVolumeBasis * forceFieldAccel(worldPos)) * uDt;
      }

      if (uEmitterMoving == 1) {
        float dist = distance(worldPos, uEmitterPosition);
        if (dist < uEmitterWindRadius) {
          float falloff = smoothstep(0.0, 1.0, 1.0 - dist / uEmitterWindRadius);
          vec3 windCurl = texture(uCurl, fract(uvw + vec3(0.0, uTime * 0.5, 0.0) * invFreq)).xyz;
          vec3 windVel = uEmitterVelocity * uEmitterWindStrength + windCurl * (uTurbulence * uEmitterSpeed);
          newVel += (uWorldToVolumeBasis * windVel) * falloff * uDt;
        }
      }
    }

    // Condition limite molle : la vitesse s'éteint au voisinage des parois
    vec3 edge = min(uvw, vec3(1.0) - uvw);
    newVel *= smoothstep(0.0, 0.08, min(edge.x, min(edge.y, edge.z)));

    fragColor = vec4(newVel, 0.0);
  }
`;

const DIVERGENCE_FRAG = /* glsl */ `
  ${FRAG_HEADER}
  uniform sampler3D uVel;

  void main() {
    vec3 uvw = cellUVW();
    float vR = texture(uVel, uvw + vec3(uTexel.x, 0.0, 0.0)).x;
    float vL = texture(uVel, uvw - vec3(uTexel.x, 0.0, 0.0)).x;
    float vU = texture(uVel, uvw + vec3(0.0, uTexel.y, 0.0)).y;
    float vD = texture(uVel, uvw - vec3(0.0, uTexel.y, 0.0)).y;
    float vF = texture(uVel, uvw + vec3(0.0, 0.0, uTexel.z)).z;
    float vB = texture(uVel, uvw - vec3(0.0, 0.0, uTexel.z)).z;
    fragColor = vec4(0.5 * ((vR - vL) + (vU - vD) + (vF - vB)), 0.0, 0.0, 1.0);
  }
`;

const JACOBI_FRAG = /* glsl */ `
  ${FRAG_HEADER}
  uniform sampler3D uPressure;
  uniform sampler3D uDivergence;

  void main() {
    vec3 uvw = cellUVW();
    float pR = texture(uPressure, uvw + vec3(uTexel.x, 0.0, 0.0)).x;
    float pL = texture(uPressure, uvw - vec3(uTexel.x, 0.0, 0.0)).x;
    float pU = texture(uPressure, uvw + vec3(0.0, uTexel.y, 0.0)).x;
    float pD = texture(uPressure, uvw - vec3(0.0, uTexel.y, 0.0)).x;
    float pF = texture(uPressure, uvw + vec3(0.0, 0.0, uTexel.z)).x;
    float pB = texture(uPressure, uvw - vec3(0.0, 0.0, uTexel.z)).x;
    float div = texture(uDivergence, uvw).x;
    fragColor = vec4((pR + pL + pU + pD + pF + pB - div) / 6.0, 0.0, 0.0, 1.0);
  }
`;

const PROJECT_FRAG = /* glsl */ `
  ${FRAG_HEADER}
  uniform sampler3D uVel;
  uniform sampler3D uPressure;

  void main() {
    vec3 uvw = cellUVW();
    float pR = texture(uPressure, uvw + vec3(uTexel.x, 0.0, 0.0)).x;
    float pL = texture(uPressure, uvw - vec3(uTexel.x, 0.0, 0.0)).x;
    float pU = texture(uPressure, uvw + vec3(0.0, uTexel.y, 0.0)).x;
    float pD = texture(uPressure, uvw - vec3(0.0, uTexel.y, 0.0)).x;
    float pF = texture(uPressure, uvw + vec3(0.0, 0.0, uTexel.z)).x;
    float pB = texture(uPressure, uvw - vec3(0.0, 0.0, uTexel.z)).x;
    vec3 gradient = 0.5 * vec3(pR - pL, pU - pD, pF - pB);
    fragColor = vec4(texture(uVel, uvw).xyz - gradient, 0.0);
  }
`;

const ADVECT_DYE_FRAG = /* glsl */ `
  ${FRAG_HEADER}
  uniform sampler3D uVel;
  uniform sampler3D uDye;
  uniform vec3 uVolumeSize;
  uniform float uDt;
  uniform float uCooling;
  uniform float uDissipation;
  uniform vec3 uGrid;

  void main() {
    vec3 uvw = cellUVW();
    vec3 vel = texture(uVel, uvw).xyz;
    vec3 prevPos = uvw - (vel / uVolumeSize) * uDt;

    // Bord ZÉRO : avec un clamp, toutes les cellules qui rétro-tracent hors de la
    // boîte relisent la même rangée de bord et la dupliquent — l'advection se met
    // à fabriquer de la masse. Même correctif que sur le chemin CPU.
    vec3 outside = step(prevPos, vec3(0.0)) + step(vec3(1.0), prevPos);
    float inBox = 1.0 - min(1.0, outside.x + outside.y + outside.z);

    vec4 dye = texture(uDye, prevPos) * inBox;

    float density = max(0.0, dye.r * max(1.0 - uDissipation * uDt, 0.0));
    float temperature = clamp(dye.g * max(1.0 - uCooling * uDt, 0.0), 0.0, 12.0);

    // L'âge se lit en plus proche voisin : l'interpoler mélangerait des parcelles
    // d'histoires différentes et brouillerait la décroissance de turbulence.
    vec3 nearest = (floor(prevPos * uGrid) + 0.5) / uGrid;
    float age = texture(uDye, nearest).b * inBox + uDt;
    if (density <= 0.01) age = 0.0;

    fragColor = vec4(density, temperature, age, 1.0);
  }
`;

/**
 * Émission : les sommets de l'émetteur sont dessinés en POINTS additifs sur la
 * cible dye qui vient d'être advectée. Un fragment shader ne peut que lire
 * (gather), or l'injection est une dispersion (scatter) — d'où le passage par la
 * rasterisation de points, seule primitive de dispersion de WebGL.
 *
 * Chaque tranche redessine tous les sommets ; ceux qui ne lui appartiennent pas
 * sont rejetés hors du volume de vue par le vertex shader. À quelques centaines
 * de sommets c'est négligeable devant l'économie du solveur.
 */
const EMIT_VERTEX = /* glsl */ `
  in vec3 position;

  uniform mat4 uEmitterMatrix;
  uniform mat4 uWorldToVolume;
  uniform vec3 uVolumeSize;
  uniform vec3 uGrid;
  uniform float uSlice;
  uniform float uPointSize;
  uniform float uTime;

  out float vFlicker;
  out vec3 vUVW;

  void main() {
    vec3 worldPos = (uEmitterMatrix * vec4(position, 1.0)).xyz;
    vec3 localPos = (uWorldToVolume * vec4(worldPos, 1.0)).xyz;
    vec3 uvw = localPos / uVolumeSize + 0.5;
    vUVW = uvw;

    // Scintillement en espace local du sommet : stable quand l'émetteur bouge
    vec3 p = position * 9.0 + vec3(0.0, -uTime * 2.5, uTime * 0.7);
    vFlicker = 0.5 + 0.5 * sin(p.x * 1.7 + sin(p.y * 2.3) + sin(p.z * 3.1));

    float sliceIndex = floor(uSlice * uGrid.z);
    float pointSlice = floor(uvw.z * uGrid.z);
    bool inBox = all(greaterThanEqual(uvw, vec3(0.0))) && all(lessThanEqual(uvw, vec3(1.0)));

    if (!inBox || abs(pointSlice - sliceIndex) > 0.5) {
      // Hors de cette tranche : rejeté hors du volume de vue
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    gl_Position = vec4(uvw.xy * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = uPointSize;
  }
`;

const EMIT_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  in float vFlicker;
  in vec3 vUVW;
  layout(location = 0) out vec4 fragColor;

  uniform sampler3D uDye;
  uniform float uDensityRate;
  uniform float uTemperatureRate;
  uniform float uDt;
  uniform float uEmissionFactor;
  uniform float uPointSize;

  void main() {
    // Pondération radiale dans le point, normalisée par l'aire du disque pour que
    // grossir le rayon étale la matière au lieu de la multiplier.
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(d, d);
    if (r2 > 1.0) discard;
    float w = (1.0 - r2) / max(1.0, 3.14159 * uPointSize * uPointSize * 0.125);

    float gain = (vFlicker * 0.85 + 0.15) * uDt * uEmissionFactor * w;
    float density = uDensityRate * gain;
    float temperature = uTemperatureRate * gain;

    // L'âge doit être tiré vers 0 par la matière fraîche, mais le blending est
    // additif : on émet la variation négative correspondante, bornée à 0 par la
    // passe d'advection suivante.
    vec4 current = texture(uDye, vUVW);
    float ageDelta = -current.b * (density / max(current.r + density, 0.001));

    fragColor = vec4(density, temperature, ageDelta, 0.0);
  }
`;

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

export interface FluidGPUState {
  config: FluidGridConfig;
  vel: PingPong;
  dye: PingPong;
  pressure: PingPong;
  divergence: THREE.WebGL3DRenderTarget;
  curlTexture: THREE.Data3DTexture;
  curlFrequency: number;
  /** Texture de dye exposée aux consommateurs (le raymarcher). */
  readonly dyeTexture: THREE.Texture;
  /** Texture de vélocité exposée aux consommateurs. */
  readonly velTexture: THREE.Texture;
  stepCount: number;
  dispose(): void;
}

interface GPUInternals {
  quadScene: THREE.Scene;
  quadCamera: THREE.OrthographicCamera;
  quad: THREE.Mesh;
  materials: Record<string, THREE.RawShaderMaterial>;
  emitPoints: THREE.Points;
  emitMaterial: THREE.RawShaderMaterial;
  emitScene: THREE.Scene;
  emitGeometry: THREE.BufferGeometry | null;
  emitGeometryOwned: boolean;
}

const internals = new WeakMap<FluidGPUState, GPUInternals>();

function makeMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: QUAD_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

/** WebGL2 et le rendu vers une tranche de texture 3D sont indispensables. */
export function isFluidGPUSupported(renderer: THREE.WebGLRenderer | undefined): boolean {
  if (!renderer) return false;
  const ctx = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && ctx instanceof WebGL2RenderingContext;
  if (!isWebGL2) return false;
  // Rendre dans une cible demi-flottante exige cette extension.
  return renderer.extensions.has("EXT_color_buffer_float");
}

export function createFluidGPUState(
  renderer: THREE.WebGLRenderer,
  config: FluidGridConfig
): FluidGPUState {
  const vel = createPingPong(config, "velocity");
  const dye = createPingPong(config, "dye");
  const pressure = createPingPong(config, "pressure");
  const divergence = createTarget3D(config, "divergence");

  const curlFrequency = DEFAULT_FLUID_PARAMS.turbFrequency;
  const curlTexture = buildCurlTexture(config, curlFrequency);

  const texel = new THREE.Vector3(1 / config.gridX, 1 / config.gridY, 1 / config.gridZ);
  const grid = new THREE.Vector3(config.gridX, config.gridY, config.gridZ);

  const shared = () => ({
    uTexel: { value: texel },
    uSlice: { value: 0 },
  });

  const materials: Record<string, THREE.RawShaderMaterial> = {
    advectVelocity: makeMaterial(ADVECT_VELOCITY_FRAG, {
      ...shared(),
      uVel: { value: null },
      uDye: { value: null },
      uCurl: { value: curlTexture },
      uVolumeSize: { value: config.worldSize.clone() },
      uDt: { value: 0.016 },
      uTime: { value: 0 },
      uBuoyancy: { value: 3 },
      uSmokeWeight: { value: 0.15 },
      uTurbulence: { value: 3.2 },
      uTurbulenceDecay: { value: 0.1 },
      uTurbFrequency: { value: 10 },
      uVelDamping: { value: 0.25 },
      uWind: { value: new THREE.Vector3() },
      uVolumeToWorld: { value: new THREE.Matrix4() },
      uWorldToVolumeBasis: { value: new THREE.Matrix3() },
      uForceCount: { value: 0 },
      uForceType: { value: new Array(8).fill(0) },
      uForcePosition: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
      uForceAxis: { value: Array.from({ length: 8 }, () => new THREE.Vector3(0, 1, 0)) },
      uForceStrength: { value: new Array(8).fill(0) },
      uForceRadius: { value: new Array(8).fill(0) },
      uForceScale: { value: new Array(8).fill(1) },
      uForceSpeed: { value: new Array(8).fill(0.1) },
      uEmitterMoving: { value: 0 },
      uEmitterPosition: { value: new THREE.Vector3() },
      uEmitterVelocity: { value: new THREE.Vector3() },
      uEmitterSpeed: { value: 0 },
      uEmitterWindStrength: { value: 6.5 },
      uEmitterWindRadius: { value: 1 },
    }),
    divergence: makeMaterial(DIVERGENCE_FRAG, { ...shared(), uVel: { value: null } }),
    jacobi: makeMaterial(JACOBI_FRAG, {
      ...shared(),
      uPressure: { value: null },
      uDivergence: { value: divergence.texture },
    }),
    project: makeMaterial(PROJECT_FRAG, {
      ...shared(),
      uVel: { value: null },
      uPressure: { value: null },
    }),
    advectDye: makeMaterial(ADVECT_DYE_FRAG, {
      ...shared(),
      uVel: { value: null },
      uDye: { value: null },
      uVolumeSize: { value: config.worldSize.clone() },
      uDt: { value: 0.016 },
      uCooling: { value: 0.77 },
      uDissipation: { value: 0.29 },
      uGrid: { value: grid },
    }),
  };

  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), materials.advectVelocity);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  const emitMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: EMIT_VERTEX,
    fragmentShader: EMIT_FRAGMENT,
    uniforms: {
      uEmitterMatrix: { value: new THREE.Matrix4() },
      uWorldToVolume: { value: new THREE.Matrix4() },
      uVolumeSize: { value: config.worldSize.clone() },
      uGrid: { value: grid },
      uSlice: { value: 0 },
      uPointSize: { value: 3 },
      uTime: { value: 0 },
      uDye: { value: null },
      uDensityRate: { value: 7 },
      uTemperatureRate: { value: 5.5 },
      uDt: { value: 0.016 },
      uEmissionFactor: { value: 1 },
    },
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  });

  const emitPoints = new THREE.Points(new THREE.BufferGeometry(), emitMaterial);
  emitPoints.frustumCulled = false;
  const emitScene = new THREE.Scene();
  emitScene.add(emitPoints);

  const state: FluidGPUState = {
    config,
    vel,
    dye,
    pressure,
    divergence,
    curlTexture,
    curlFrequency,
    get dyeTexture() {
      return dye.read.texture;
    },
    get velTexture() {
      return vel.read.texture;
    },
    stepCount: 0,
    dispose() {
      vel.read.dispose();
      vel.write.dispose();
      dye.read.dispose();
      dye.write.dispose();
      pressure.read.dispose();
      pressure.write.dispose();
      divergence.dispose();
      this.curlTexture.dispose();
      const int = internals.get(this);
      if (int) {
        int.quad.geometry.dispose();
        for (const m of Object.values(int.materials)) m.dispose();
        int.emitMaterial.dispose();
        if (int.emitGeometryOwned) int.emitGeometry?.dispose();
        int.emitPoints.geometry.dispose();
      }
    },
  };

  internals.set(state, {
    quadScene,
    quadCamera,
    quad,
    materials,
    emitPoints,
    emitMaterial,
    emitScene,
    emitGeometry: null,
    emitGeometryOwned: false,
  });

  // Les cibles démarrent avec un contenu indéfini : les mettre à zéro évite un
  // premier pas alimenté par des NaN.
  const prevTarget = renderer.getRenderTarget();
  for (const rt of [vel.read, vel.write, dye.read, dye.write, pressure.read, pressure.write, divergence]) {
    for (let z = 0; z < config.gridZ; z++) {
      renderer.setRenderTarget(rt, z);
      renderer.clear(true, false, false);
    }
  }
  renderer.setRenderTarget(prevTarget);

  return state;
}

function buildCurlTexture(config: FluidGridConfig, frequency: number): THREE.Data3DTexture {
  const raw = generateCurlNoiseField3D(config, frequency, 1.0);
  const count = config.gridX * config.gridY * config.gridZ;
  const data = new Float32Array(count * 4);
  for (let i = 0, j = 0; i < count; i++, j += 3) {
    data[i * 4] = raw[j];
    data[i * 4 + 1] = raw[j + 1];
    data[i * 4 + 2] = raw[j + 2];
    data[i * 4 + 3] = 1;
  }
  const tex = new THREE.Data3DTexture(data, config.gridX, config.gridY, config.gridZ);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.FloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // Enroulement : les coordonnées de lecture défilent avec l'âge et le temps
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Exécute une passe sur toutes les tranches Z de la cible. */
function runPass(
  renderer: THREE.WebGLRenderer,
  int: GPUInternals,
  material: THREE.RawShaderMaterial,
  target: THREE.WebGL3DRenderTarget,
  gridZ: number
): void {
  int.quad.material = material;
  for (let z = 0; z < gridZ; z++) {
    material.uniforms.uSlice.value = (z + 0.5) / gridZ;
    renderer.setRenderTarget(target, z);
    renderer.render(int.quadScene, int.quadCamera);
  }
}

/**
 * Un pas complet sur GPU. Signature alignée sur stepFluidSimulation pour que les
 * nodes puissent basculer d'un chemin à l'autre sans logique conditionnelle.
 */
export function stepFluidSimulationGPU(
  renderer: THREE.WebGLRenderer,
  state: FluidGPUState,
  params: FluidSimParams,
  emitters: FluidEmitterDescriptor[] = [],
  forces: FluidForceField[] = []
): void {
  const int = internals.get(state);
  if (!int) return;

  const { config } = state;
  const gridZ = config.gridZ;
  const dt = Math.max(0.0001, params.dt);

  // Le champ de curl est précalculé pour une fréquence donnée
  if (state.curlFrequency !== params.turbFrequency) {
    state.curlTexture.dispose();
    state.curlTexture = buildCurlTexture(config, params.turbFrequency);
    state.curlFrequency = params.turbFrequency;
    int.materials.advectVelocity.uniforms.uCurl.value = state.curlTexture;
  }

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  // --- 1) Advection de la vélocité + forces externes ---
  const av = int.materials.advectVelocity.uniforms;
  av.uVel.value = state.vel.read.texture;
  av.uDye.value = state.dye.read.texture;
  av.uVolumeSize.value.copy(config.worldSize);
  av.uDt.value = dt;
  av.uTime.value = params.time;
  av.uBuoyancy.value = params.buoyancy;
  av.uSmokeWeight.value = params.smokeWeight;
  av.uTurbulence.value = params.turbulence;
  av.uTurbulenceDecay.value = params.turbulenceDecay;
  av.uTurbFrequency.value = params.turbFrequency;
  av.uVelDamping.value = params.velocityDamping;
  av.uWind.value.copy(params.wind);
  av.uVolumeToWorld.value.copy(params.volumeToWorld);
  av.uWorldToVolumeBasis.value.setFromMatrix4(params.worldToVolume);

  const forceCount = Math.min(8, forces.length);
  av.uForceCount.value = forceCount;
  const FORCE_TYPE_INDEX: Record<string, number> = { attractor: 0, vortex: 1, wind: 2, turbulence: 3 };
  for (let i = 0; i < forceCount; i++) {
    const f = forces[i];
    av.uForceType.value[i] = FORCE_TYPE_INDEX[f.type] ?? 0;
    (av.uForcePosition.value[i] as THREE.Vector3).copy(f.position);
    (av.uForceAxis.value[i] as THREE.Vector3).copy(f.axis);
    av.uForceStrength.value[i] = f.strength;
    av.uForceRadius.value[i] = f.radius;
    av.uForceScale.value[i] = f.scale;
    av.uForceSpeed.value[i] = f.speed;
  }

  const mover = emitters.find((e) => e.position && e.velocity && (e.speed ?? 0) > 1e-4);
  av.uEmitterMoving.value = mover ? 1 : 0;
  if (mover) {
    av.uEmitterPosition.value.copy(mover.position!);
    av.uEmitterVelocity.value.copy(mover.velocity!);
    av.uEmitterSpeed.value = mover.speed ?? 0;
    av.uEmitterWindStrength.value = mover.windStrength ?? 6.5;
    av.uEmitterWindRadius.value = mover.windRadius ?? 1;
  }

  runPass(renderer, int, int.materials.advectVelocity, state.vel.write, gridZ);

  // --- 2) Divergence du champ advecté ---
  int.materials.divergence.uniforms.uVel.value = state.vel.write.texture;
  runPass(renderer, int, int.materials.divergence, state.divergence, gridZ);

  // --- 3) Jacobi. La pression n'est PAS remise à zéro : le champ de la frame
  //        précédente sert de point de départ (warm start), ce qui permet de
  //        converger avec très peu d'itérations.
  const iterations = Math.max(1, Math.min(16, params.jacobiIterations));
  for (let i = 0; i < iterations; i++) {
    int.materials.jacobi.uniforms.uPressure.value = state.pressure.read.texture;
    runPass(renderer, int, int.materials.jacobi, state.pressure.write, gridZ);
    state.pressure.swap();
  }

  // --- 4) Projection : soustraction du gradient de pression ---
  int.materials.project.uniforms.uVel.value = state.vel.write.texture;
  int.materials.project.uniforms.uPressure.value = state.pressure.read.texture;
  runPass(renderer, int, int.materials.project, state.vel.read, gridZ);

  // --- 5) Advection des scalaires ---
  const ad = int.materials.advectDye.uniforms;
  ad.uVel.value = state.vel.read.texture;
  ad.uDye.value = state.dye.read.texture;
  ad.uVolumeSize.value.copy(config.worldSize);
  ad.uDt.value = dt;
  ad.uCooling.value = params.cooling;
  ad.uDissipation.value = params.dissipation;
  runPass(renderer, int, int.materials.advectDye, state.dye.write, gridZ);

  // --- 6) Émission, en additif par-dessus le dye fraîchement advecté ---
  for (const emitter of emitters) {
    const geometry = resolveEmitGeometry(int, emitter);
    if (!geometry) continue;

    const em = int.emitMaterial.uniforms;
    em.uEmitterMatrix.value.copy(emitter.worldMatrix ?? new THREE.Matrix4());
    em.uWorldToVolume.value.copy(params.worldToVolume);
    em.uVolumeSize.value.copy(config.worldSize);
    em.uDye.value = state.dye.read.texture;
    em.uDensityRate.value = emitter.density;
    em.uTemperatureRate.value = emitter.temperature;
    em.uDt.value = dt;

    // Rayon de dépôt exprimé en pixels de la tranche
    const pointSize = Math.max(1, (emitter.radius / config.worldSize.x) * config.gridX * 2);
    em.uPointSize.value = pointSize;
    em.uTime.value = params.time;

    const vertexCount = geometry.attributes.position.count;
    let factor = (emitter.temperature > 0 ? 1 : 0) + (emitter.speed ?? 0) * emitter.motionBoost;
    if (emitter.normalizeEmission) factor *= REFERENCE_EMITTER_SAMPLES / Math.max(1, vertexCount);
    em.uEmissionFactor.value = factor;

    int.emitPoints.geometry = geometry;
    for (let z = 0; z < gridZ; z++) {
      em.uSlice.value = (z + 0.5) / gridZ;
      renderer.setRenderTarget(state.dye.write, z);
      renderer.render(int.emitScene, int.quadCamera);
    }
  }

  state.dye.swap();
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  state.stepCount++;
}

/**
 * Rassemble les sommets de l'émetteur en une géométrie de points unique, en
 * espace monde. Contrairement au CPU on ne peut pas parcourir plusieurs maillages
 * à la volée pendant le rendu : on aplatit une fois et on met en cache tant que
 * la source ne change pas.
 */
function resolveEmitGeometry(
  int: GPUInternals,
  emitter: FluidEmitterDescriptor
): THREE.BufferGeometry | null {
  const geo = emitter.geometry;

  if (geo instanceof THREE.BufferGeometry) {
    if (int.emitGeometryOwned) int.emitGeometry?.dispose();
    int.emitGeometry = geo;
    int.emitGeometryOwned = false;
    return geo.attributes.position ? geo : null;
  }

  if (!(geo instanceof THREE.Object3D)) return null;

  const positions: number[] = [];
  const v = new THREE.Vector3();
  geo.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Points)) return;
    const attr = child.geometry?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!attr) return;
    child.updateWorldMatrix(true, false, true);
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(child.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
  });

  if (positions.length === 0) return null;

  // Réutiliser le buffer tant que le nombre de sommets ne change pas : un
  // émetteur qui bouge voit ses positions changer à chaque frame, mais
  // recréer la BufferGeometry provoquerait une réallocation GPU par frame.
  const existing = int.emitGeometryOwned ? int.emitGeometry : null;
  const attr = existing?.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (attr && attr.array.length === positions.length) {
    (attr.array as Float32Array).set(positions);
    attr.needsUpdate = true;
    return existing!;
  }

  existing?.dispose();
  const flat = new THREE.BufferGeometry();
  flat.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  int.emitGeometry = flat;
  int.emitGeometryOwned = true;
  return flat;
}
