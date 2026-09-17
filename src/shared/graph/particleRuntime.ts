import { GPUComputationRenderer, Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import * as THREE from "three";
import { STEP_SECONDS, stepsSince } from "./clock";
import { createNodeCache } from "./nodeCaches";

/**
 * GPGPU particle pipeline per BIBLE.md: particle state (position, velocity,
 * age) lives in floating-point textures, updated by a fragment shader,
 * ping-ponged between two render targets — three.js's own established
 * pattern for this (GPUComputationRenderer), not a CPU array, to stay cheap
 * at scale.
 *
 * Population size follows the standard steady-state relation
 * population = spawnRate × lifetime (see activeParticleCount) rather than
 * tracking individual spawn timers — every texel below that count cycles
 * itself (age exceeds lifetime → respawn at the emitter) independently, no
 * shared spawn queue needed; texels above it stay permanently parked. Both
 * the position and velocity shaders recompute the same respawn condition
 * from the same inputs (age, delta, lifetime) — deterministic per texel, so
 * they agree without talking to each other.
 */

/** Smallest square texture whose texel count covers `capacity` particles. */
export function textureSizeFor(capacity: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(0, capacity))));
}

export interface EmitterConfig {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spawnRate: number;
  /**
   * Flat (x,y,z) triples — a respawning particle is placed at
   * seedPositions[idx % count] instead of `position` + jitter, so an
   * imported point cloud's shape becomes the emitter's spawn pattern rather
   * than a single jittered point. Undefined keeps the old single-point
   * behavior exactly (particles/emitter-from-points is the only node that
   * sets this).
   */
  seedPositions?: Float32Array;
  /**
   * Side length of the cube a respawning particle is jittered within around
   * `position` (a cube, not a true sphere, for the same reason the jitter
   * itself is per-axis uniform noise rather than a rejection-sampled sphere
   * point — cheap, and close enough at this scale). Ignored once
   * seedPositions is set — a seeded emitter's spawn pattern is the point
   * cloud's own shape, not a jittered point. Only particles/emitter (the
   * single-point emitter) exposes this as "Diameter"; particles/emitter-
   * from-points and particles/emitter-from-surface both already have their
   * own, more specific idea of spread (the point cloud / the sampled mesh).
   */
  diameter: number;
  /**
   * With seedPositions set, whether each respawn picks a *fresh* random seed
   * point (true) or keeps the texel permanently bound to one (false) — see
   * the seedRandomPick branch in POSITION_SHADER for why the difference is
   * visible rather than academic. Surface emission wants random; reproducing
   * a point cloud exactly wants sequential. Ignored without seedPositions.
   */
  randomSpawnPick: boolean;
  /**
   * Whether the emitter is currently spawning. False lets particles die out
   * as they age rather than respawning them — so an Oscillator, Trigger,
   * Toggle or Compare node wired into the emitter's Emit input turns
   * emission into something the graph drives over time, instead of a
   * constant. Existing particles are untouched; only respawn is gated.
   */
  emit: boolean;
  /**
   * Set only by particles/points-to-particles: "one particle per point,
   * spawned all at once" doesn't fit the rate×lifetime population model
   * (activeParticleCount) every other emitter uses — there's no rate to
   * tune, the population IS the point count. When set, getOrCreateSimulation
   * uses this directly instead of spawnRate×lifetime, and forces burst
   * semantics regardless of Particle Simulate's own Burst Spawn checkbox —
   * "spawned, not emitted" means the whole population appears immediately
   * without the user needing to reason about staggering or respawn cycles
   * at all.
   */
  pointCount?: number;
  /**
   * A LEVEL (like `emit`, not a pulse): once true, every particle this
   * simulation owns gets force-killed — not the gradual "stop respawning,
   * let the existing population age out naturally" `emit=false` already
   * gives you, which can take up to a full Lifetime to actually clear the
   * scene (worse, arbitrarily long if Lifetime was deliberately set past
   * the animation's own length, exactly what Burst Spawn's own setup
   * recommends). "Clean up the scene at a specific frame" wants everyone
   * gone RIGHT NOW, not a fade. Stays true forever once set, same reasoning
   * as `emit`'s own level-not-pulse contract (see EmitterConfig.emit) —
   * this is a decision "should this population still exist", never a
   * one-shot signal to bounce back from.
   */
  killSignal?: boolean;
}

export function buildEmitterConfig(
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  spawnRate: number,
  seedPositions?: Float32Array,
  diameter = 0.25,
  randomSpawnPick = false,
  emit = true,
  pointCount?: number,
  killSignal = false,
): EmitterConfig {
  return { position, velocity, spawnRate, seedPositions, diameter, randomSpawnPick, emit, pointCount, killSignal };
}

/** How many of `capacity` texels are actually alive-capable — population = rate × lifetime, capped. */
export function activeParticleCount(spawnRate: number, lifetime: number, capacity: number): number {
  if (!Number.isFinite(spawnRate) || !Number.isFinite(lifetime) || lifetime <= 0) return 0;
  return Math.min(capacity, Math.max(0, Math.round(spawnRate * lifetime)));
}

const POSITION_SHADER = /* glsl */ `
  uniform float delta;
  uniform float lifetime;
  uniform float activeCount;
  uniform vec3 emitterPosition;
  uniform float boundsRadius;
  uniform sampler2D seedPositions;
  uniform float seedCount;
  uniform float seedSize;
  uniform float spawnDiameter;
  uniform float seedRandomPick;
  uniform float time;
  uniform float emitEnabled;
  uniform float lifetimeVariance;
  uniform float groundEnabled;
  uniform float groundY;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);
    float idx = floor(gl_FragCoord.y) * resolution.x + floor(gl_FragCoord.x);

    if (idx >= activeCount) {
      gl_FragColor = vec4(pos.rgb, -1.0e6);
      return;
    }

    // A fixed-per-texel random factor (not time-seeded, so it never changes
    // across a particle's life) spreads each particle's own lifetime around
    // the mean by up to +/-lifetimeVariance — without this, every particle
    // sharing one exact lifetime dies in the same frame it was spawned in,
    // which reads as a whole group popping out of existence at once rather
    // than a population that thins out gradually. 0 keeps every particle at
    // exactly lifetime, same as before this uniform existed.
    float lifeRand = fract(sin(idx * 78.233) * 43758.5453);
    float myLifetime = max(0.0001, lifetime * (1.0 + lifetimeVariance * (lifeRand * 2.0 - 1.0)));

    float age = pos.a + delta;
    // A particle that has drifted past the bounds radius is treated as if it
    // had just aged out — it respawns through the exact same spawn path
    // below, so there is only one spawn rule to keep in sync rather than a
    // second copy of it guarded by a distance check.
    if (boundsRadius > 0.0 && length(pos.rgb) > boundsRadius) {
      age = myLifetime + 1.0;
    }
    if (age > myLifetime) {
      // Emission gated off: let this particle die instead of respawning it,
      // using the same past-the-active-count sentinel so every consumer
      // (particles/render's vAlive, isAlive() on the CPU side) already treats
      // it as gone. Particles alive when the gate closed still finish their
      // lifetime — closing the gate stops *new* emission, it doesn't
      // teleport the existing population away.
      if (emitEnabled < 0.5) {
        gl_FragColor = vec4(pos.rgb, -1.0e6);
        return;
      }
      vec3 spawnPos;
      if (seedCount > 0.0) {
        // Which seed point this respawn lands on. No jitter either way: the
        // seed set's own geometry is the spawn pattern.
        //
        // Sequential (mod of idx by seedCount) binds each texel to one seed
        // point *for the lifetime of the simulation* — particle 7 respawns at
        // seed point 7 every single time. That reproduces a point cloud
        // exactly when the population matches the cloud, which is what
        // Particle Emitter (From Points) wants, but it is wrong for a surface
        // emitter: every particle then retraces an identical path each life
        // (the flow field being deterministic), so the emission reads as a few
        // fixed streaks instead of a surface actually emitting.
        //
        // Random picks a fresh point per respawn by hashing the texel against
        // the simulation clock. time is the sim's own fixed-step clock, not
        // wall time, so a scrub or a re-export replays the identical sequence.
        // More seed points than texels to hold them: walk the cloud in even
        // strides instead of a plain modulo, which would bind texels to seeds
        // 0..capacity-1 and simply drop the rest. PLY and scanner exports
        // store vertices in traversal order, so that tail is a contiguous
        // *region* of the model — the particle cloud came out visibly
        // cropped, reading as a smaller cloud than its source.
        float capacity = resolution.x * resolution.y;
        float seedIdx = seedCount > capacity
          ? min(floor(idx * (seedCount / capacity)), seedCount - 1.0)
          : mod(idx, seedCount);
        if (seedRandomPick > 0.5) {
          float h = fract(sin(idx * 12.9898 + floor(time * 60.0) * 78.233) * 43758.5453);
          seedIdx = floor(h * seedCount);
        }
        vec2 suv = (vec2(mod(seedIdx, seedSize), floor(seedIdx / seedSize)) + 0.5) / seedSize;
        spawnPos = texture2D(seedPositions, suv).rgb;
      } else {
        float seed = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
        vec3 jitter = (vec3(seed, fract(seed * 7.0), fract(seed * 13.0)) - 0.5) * spawnDiameter;
        spawnPos = emitterPosition + jitter;
      }
      gl_FragColor = vec4(spawnPos, age - myLifetime);
    } else {
      vec3 newPos = pos.rgb + vel.rgb * delta;
      // Belt-and-suspenders alongside VELOCITY_SHADER's own bounce/friction
      // response: that shader reacts to *last frame's* position, one step
      // behind this one's own integration, so a large delta or a particle
      // already deep in free-fall can still integrate a hair past groundY
      // before its velocity even reflects contact. Clamping the position
      // directly here is what actually stops a fast-falling cloud from
      // visibly sinking a little into the ground every frame.
      if (groundEnabled > 0.5) newPos.y = max(newPos.y, groundY);
      gl_FragColor = vec4(newPos, age);
    }
  }
`;

/**
 * Ashima Arts / Stefan Gustavson's analytic-derivative 3D simplex noise
 * (webgl-noise, MIT) — same public-domain-grade algorithm every curl-noise
 * flow field in the field uses (Book of Shaders, countless Genuary/shader
 * demos), reimplemented here rather than copied from any one of them.
 * Returns (gradient.xyz, value) in one evaluation, which is what makes curl
 * noise cheap: curl needs the gradient, not the value, and a derivative-free
 * noise would need 6 extra taps (finite differences) to approximate it.
 */
const SIMPLEX_GRADIENT_NOISE_GLSL = /* glsl */ `
  vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute289(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  vec4 simplexGrad(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289v3(i);
    vec4 p = permute289(permute289(permute289(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 g0 = vec3(a0.xy, h.x);
    vec3 g1 = vec3(a0.zw, h.y);
    vec3 g2 = vec3(a1.xy, h.z);
    vec3 g3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(g0, g0), dot(g1, g1), dot(g2, g2), dot(g3, g3)));
    g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;

    vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    vec4 m2 = m * m;
    vec4 m4 = m2 * m2;

    vec4 pdotx = vec4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3));

    float value = 42.0 * dot(m4, pdotx);

    vec4 temp = m2 * m * pdotx;
    vec3 gradient = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
    gradient += m4.x * g0 + m4.y * g1 + m4.z * g2 + m4.w * g3;
    gradient *= 42.0;

    return vec4(gradient, value);
  }

  /**
   * Curl of a vector potential built from 3 independent noise channels (the
   * Bridson/McEwan trick: sample the *same* scalar field at 3 widely-offset
   * points instead of building 3 truly independent fields — one evaluation
   * each is enough because the offsets already decorrelate them). The result
   * is divergence-free by construction, which is what keeps particles
   * flowing rather than clumping or blowing apart at sinks/sources — a
   * scalar field's raw gradient would do both.
   *
   * \`time\` is folded into the sample position (not a 4th noise dimension —
   * that needs a whole extra derivative to carry through) so the field
   * itself drifts, rather than each particle just riding a fixed field
   * faster.
   */
  vec3 curlNoise(vec3 p, float noiseScale, float speed, float time) {
    vec3 offsetY = vec3(31.416, -47.853, 12.793);
    vec3 offsetZ = vec3(-233.145, -113.408, 71.996);
    vec3 drift = vec3(time * speed);

    vec3 gx = simplexGrad((p) * noiseScale + drift).xyz;
    vec3 gy = simplexGrad((p + offsetY) * noiseScale + drift).xyz;
    vec3 gz = simplexGrad((p + offsetZ) * noiseScale + drift).xyz;

    return vec3(gy.z - gz.y, gz.x - gx.z, gx.y - gy.x);
  }
`;

/**
 * Blender-style force fields, summed alongside gravity/wind/the global flow
 * field. A fixed-size array + a float count rather than a variable-length
 * one — WebGL has no dynamic arrays — unrolled to MAX_FORCE_FIELDS every
 * frame and masked per-slot by \`isActive\` rather than a runtime \`break\`:
 * see SHUTTER_SCALE's neighbor comment in motionBlur.ts for why a dynamic
 * break against a uniform loop bound is the pattern to avoid (some driver's
 * loop unrolling rejects it) — masking keeps the loop's iteration count
 * always exactly MAX_FORCE_FIELDS, so there's nothing for it to reject.
 */
const MAX_FORCE_FIELDS = 8;

const FORCE_FIELD_GLSL = /* glsl */ `
  uniform vec3 fieldPosition[${MAX_FORCE_FIELDS}];
  uniform vec3 fieldAxis[${MAX_FORCE_FIELDS}];
  uniform float fieldStrength[${MAX_FORCE_FIELDS}];
  uniform float fieldRadius[${MAX_FORCE_FIELDS}];
  uniform float fieldScale[${MAX_FORCE_FIELDS}];
  uniform float fieldSpeed[${MAX_FORCE_FIELDS}];
  uniform int fieldType[${MAX_FORCE_FIELDS}];
  uniform float fieldCount;

  vec3 forceFieldContribution(vec3 pos, float time) {
    vec3 total = vec3(0.0);
    for (int i = 0; i < ${MAX_FORCE_FIELDS}; i++) {
      float isActive = float(i) < fieldCount ? 1.0 : 0.0;

      vec3 toField = fieldPosition[i] - pos;
      float dist = length(toField);
      float falloff = fieldRadius[i] > 0.0 ? clamp(1.0 - dist / fieldRadius[i], 0.0, 1.0) : 1.0;

      vec3 contribution = vec3(0.0);
      if (fieldType[i] == 0) {
        // Attractor — pulls toward (positive strength) or pushes away
        // (negative) fieldPosition.
        contribution = dist > 0.0001 ? normalize(toField) * fieldStrength[i] : vec3(0.0);
      } else if (fieldType[i] == 1) {
        // Vortex — spins around the axis through fieldPosition. The radial
        // vector is flattened onto the plane perpendicular to axis first, so
        // an off-axis particle still orbits cleanly instead of spiraling in.
        vec3 axis = length(fieldAxis[i]) > 0.0001 ? normalize(fieldAxis[i]) : vec3(0.0, 1.0, 0.0);
        vec3 radial = -toField - axis * dot(-toField, axis);
        vec3 tangent = cross(axis, radial);
        float tlen = length(tangent);
        contribution = tlen > 0.0001 ? (tangent / tlen) * fieldStrength[i] : vec3(0.0);
      } else if (fieldType[i] == 2) {
        // Wind — constant push along axis; falloff (via radius) makes it a
        // zone instead of a global gust.
        float alen = length(fieldAxis[i]);
        contribution = alen > 0.0001 ? (fieldAxis[i] / alen) * fieldStrength[i] : vec3(0.0);
      } else {
        // Turbulence — a second, independently positioned/scaled curl-noise
        // source, on top of Particle Simulate's own global Flow Field knob.
        contribution = curlNoise(pos, fieldScale[i], fieldSpeed[i], time) * fieldStrength[i];
      }

      total += contribution * falloff * isActive;
    }
    return total;
  }
`;

const VELOCITY_SHADER = /* glsl */ `
  uniform float delta;
  uniform float gravity;
  uniform vec3 wind;
  uniform float lifetime;
  uniform float activeCount;
  uniform vec3 emitterVelocity;
  uniform float noiseStrength;
  uniform float noiseScale;
  uniform float noiseSpeed;
  uniform float time;
  uniform float maxSpeed;
  uniform float lifetimeVariance;
  uniform float groundEnabled;
  uniform float groundY;
  uniform float groundBounce;
  uniform float groundFriction;

  ${SIMPLEX_GRADIENT_NOISE_GLSL}
  ${FORCE_FIELD_GLSL}

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);
    float idx = floor(gl_FragCoord.y) * resolution.x + floor(gl_FragCoord.x);

    if (idx >= activeCount) {
      gl_FragColor = vec4(0.0);
      return;
    }

    // Same per-texel hash as POSITION_SHADER's myLifetime — has to match
    // exactly, or this shader's respawn branch (which resets velocity) and
    // the position shader's (which resets position) disagree about which
    // frame a given particle dies on.
    float lifeRand = fract(sin(idx * 78.233) * 43758.5453);
    float myLifetime = max(0.0001, lifetime * (1.0 + lifetimeVariance * (lifeRand * 2.0 - 1.0)));

    float age = pos.a + delta;
    if (age > myLifetime) {
      float seed = fract(sin(dot(uv, vec2(93.9898, 47.233))) * 24634.6345);
      vec3 jitter = (vec3(seed, fract(seed * 5.0), fract(seed * 11.0)) - 0.5) * 0.5;
      gl_FragColor = vec4(emitterVelocity + jitter, 0.0);
    } else {
      vec3 flow = noiseStrength > 0.0
        ? curlNoise(pos.rgb, noiseScale, noiseSpeed, time) * noiseStrength
        : vec3(0.0);
      vec3 fields = forceFieldContribution(pos.rgb, time);
      vec3 v = vel.rgb + vec3(0.0, -gravity, 0.0) * delta + wind * delta + flow * delta + fields * delta;
      // Ground collision: reacts to the position this particle already sits
      // at (pos.rgb, last frame's) and only when actually moving downward
      // into it — a particle resting exactly on groundY with v.y already
      // clamped to ~0 shouldn't re-trigger every frame and re-apply
      // friction to velocity that's already settled. groundBounce 0 = dead
      // stop on contact (a cloud settling onto the floor); 1 = perfectly
      // elastic. groundFriction scales the horizontal (x/z) speed on every
      // contact — 1 = frictionless slide, 0 = grips instantly.
      if (groundEnabled > 0.5 && pos.rgb.y <= groundY && v.y < 0.0) {
        v.y = -v.y * groundBounce;
        v.x *= groundFriction;
        v.z *= groundFriction;
      }
      // Pure integration with no drag term — an accelerating force (the flow
      // field, but gravity/wind too given enough lifetime) would otherwise
      // grow v without bound. maxSpeed <= 0.0 keeps the old unclamped
      // behavior, so a graph that only ever used gravity/wind (where the
      // scene's own lifetime already kept speeds in a sane range) renders
      // identically to before this param existed.
      if (maxSpeed > 0.0) {
        float speed = length(v);
        if (speed > maxSpeed) v *= maxSpeed / speed;
      }
      gl_FragColor = vec4(v, 0.0);
    }
  }
`;

interface Simulation {
  gpuCompute: GPUComputationRenderer;
  /**
   * The renderer this particular Simulation's GPUComputationRenderer was
   * built against — its render targets live in *that* WebGL context. Kept on
   * the record mostly for the assertion in getOrCreateSimulation now (the
   * cache is keyed by renderer, see simCache below, so this should always
   * already match whatever's passed in); historically, before that keying
   * existed, only one Simulation per node existed at all, so a second
   * viewport evaluating the same graph (split mode's two simultaneously
   * live panes, chief culprit) fought over ownership of it every frame —
   * neither ever got far enough into stepsSince's catch-up window to
   * actually advance, so the particles it drove sat frozen at their
   * initial spawn state the whole time both panes were live.
   */
  renderer: THREE.WebGLRenderer;
  positionVar: Variable;
  velocityVar: Variable;
  size: number;
  lastSteppedStep: number;
  /**
   * The flow field's own clock, in seconds — advanced by STEP_SECONDS once
   * per `compute()` call rather than read from ctx.time, so a run of capped
   * catch-up steps (see MAX_STEPS_PER_FRAME) still sees the field evolve one
   * fixed increment per step instead of jumping straight to wall-clock time.
   */
  simSeconds: number;
  /** The Float32Array last uploaded as the seed texture — reference equality decides whether to rebuild it (see updateSeedTexture). */
  seedArray?: Float32Array;
  seedTexture?: THREE.DataTexture;
  /**
   * `emitter.emit` as of last frame — burstSpawn + "Emit When: only when
   * driven" wants the whole population to appear at the moment something
   * drives Emit true, not just whenever the sim happens to be created (the
   * graph could well be evaluating for several frames with the gate closed
   * before anything drives it). Comparing against this catches exactly that
   * false→true edge so the burst re-seed (see maybeBurstOnEmitRisingEdge)
   * fires once, right when the gate opens, rather than never at all if it
   * was already closed when the sim was first built.
   */
  lastEmit: boolean;
  /** Same false→true edge-detection contract as lastEmit, for EmitterConfig.killSignal — see maybeKillOnRisingEdge. */
  lastKill: boolean;
}

// One Simulation *per renderer* per node, not one shared across whichever
// renderer last asked — SplitViewport now keeps every pane's Viewport (and
// its own WebGLRenderer) mounted and independently ticking for as long as
// that pane is visible, so two panes showing the same particle node (split
// mode's whole reason to exist) are both live at once. A single shared slot
// meant each pane's tick() saw the *other* pane's renderer parked there and
// rebuilt on top of it — every frame, from both sides — so neither ever
// advanced past step 0.
const simCache = createNodeCache<Map<THREE.WebGLRenderer, Simulation>>((perRenderer) => {
  for (const s of perRenderer.values()) {
    s.gpuCompute.dispose();
    s.seedTexture?.dispose();
  }
});
let warnedMissingRenderer = false;

/**
 * A 1x1 dummy texture bound to the `seedPositions` sampler when no point
 * cloud is wired in. WebGL requires every sampler uniform a shader
 * references to be bound to *something* valid; seedCount stays 0 in that
 * case so the shader branch that would sample it never runs, but the
 * binding itself still has to exist.
 */
let placeholderSeedTexture: THREE.DataTexture | undefined;
function getPlaceholderSeedTexture(): THREE.DataTexture {
  if (!placeholderSeedTexture) {
    placeholderSeedTexture = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    placeholderSeedTexture.needsUpdate = true;
  }
  return placeholderSeedTexture;
}

/** Rebuilds the seed-position DataTexture only when the source array actually changed (reference equality — cheap, and evaluate() only hands back a new array when its own inputs changed). */
function updateSeedTexture(sim: Simulation, seedPositions: Float32Array | undefined): { texture: THREE.Texture; count: number; size: number } {
  if (!seedPositions || seedPositions.length === 0) {
    return { texture: getPlaceholderSeedTexture(), count: 0, size: 1 };
  }
  const count = Math.floor(seedPositions.length / 3);
  if (sim.seedArray !== seedPositions) {
    sim.seedTexture?.dispose();
    const size = textureSizeFor(count);
    const data = new Float32Array(size * size * 4);
    for (let i = 0; i < count; i++) {
      data[i * 4] = seedPositions[i * 3];
      data[i * 4 + 1] = seedPositions[i * 3 + 1];
      data[i * 4 + 2] = seedPositions[i * 3 + 2];
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true;
    sim.seedArray = seedPositions;
    sim.seedTexture = texture;
  }
  const size = sim.seedTexture!.image.width;
  return { texture: sim.seedTexture!, count, size };
}

/**
 * A texel's starting age — pulled out of initialPositionTexture as its own
 * pure function purely so it's unit-testable without a WebGLRenderer
 * (everything else GPU-sim-related in this file needs a real one).
 *
 * Three cases:
 *  - burstSpawn off: the original staggered negative age, spreading first
 *    activation across one Lifetime's worth of "already elapsed" time so a
 *    fresh population doesn't visibly pop into existence on frame 1.
 *  - burstSpawn on, spawnNow true (the gate is already open — "Emit When:
 *    always", or "only when driven" with something already driving it
 *    true): age 0, already alive.
 *  - burstSpawn on, spawnNow false ("only when driven" with nothing driving
 *    Emit yet): a dead sentinel — invisible and inert until
 *    maybeBurstOnEmitRisingEdge re-seeds it the moment Emit actually turns
 *    on. Staying dead here (rather than falling back to the staggered
 *    case) matters: staggering would eventually make these visible on its
 *    own, bypassing the gate entirely.
 */
export function initialAge(index: number, capacity: number, lifetimeGuess: number, burstSpawn: boolean, spawnNow: boolean): number {
  if (!burstSpawn) return -((index / capacity) * lifetimeGuess);
  return spawnNow ? 0 : -1;
}

/**
 * A burst-spawned texel's starting position. Every OTHER texel starts at
 * (0,0,0) and stays there, invisible (age < 0), until its very first
 * respawn — POSITION_SHADER's `age > myLifetime` branch is the ONLY place
 * a particle is ever placed at a real spawn point, and that first respawn
 * needs up to a full Lifetime of simulated time to fire. burstSpawn already
 * sets age to 0 (alive immediately) — pairing that with a Lifetime set
 * longer than the animation (exactly what "spawn everything, then let it
 * fall" wants, so nothing respawns mid-fall) means that first respawn would
 * NEVER happen inside the visible window: every particle would sit glued to
 * the origin for the whole animation, indistinguishable from "no particles"
 * unless the camera happens to be framed right on (0,0,0). Mirrors the
 * shader's own sequential seed-index spawn rule (not the random-pick
 * variant — that's keyed to the sim clock and meaningless to precompute) so
 * a burst-spawned Point Emitter (From Points) shows its actual cloud shape
 * from frame 0, not a pile at the origin.
 */
export function initialPosition(index: number, emitter: EmitterConfig, capacity?: number, size?: number): [number, number, number] {
  const seedPositions = emitter.seedPositions;
  const seedCount = seedPositions ? Math.floor(seedPositions.length / 3) : 0;
  if (seedCount > 0 && seedPositions) {
    // Same even-stride rule the spawn shader uses once the cloud outgrows
    // the texture — the burst texture is frame 0 of the very same
    // population, so picking differently here would show one cloud on the
    // first frame and another from the second on.
    const seedIdx =
      capacity !== undefined && seedCount > capacity
        ? Math.min(Math.floor(index * (seedCount / capacity)), seedCount - 1)
        : index % seedCount;
    return [seedPositions[seedIdx * 3], seedPositions[seedIdx * 3 + 1], seedPositions[seedIdx * 3 + 2]];
  }
  if (emitter.diameter > 0 && size !== undefined && size > 0) {
    const u = ((index % size) + 0.5) / size;
    const v = (Math.floor(index / size) + 0.5) / size;
    const dotVal = u * 12.9898 + v * 78.233;
    const seed = ((Math.sin(dotVal) * 43758.5453) % 1 + 1) % 1;
    const s1 = seed;
    const s2 = ((seed * 7.0) % 1 + 1) % 1;
    const s3 = ((seed * 13.0) % 1 + 1) % 1;
    return [
      emitter.position.x + (s1 - 0.5) * emitter.diameter,
      emitter.position.y + (s2 - 0.5) * emitter.diameter,
      emitter.position.z + (s3 - 0.5) * emitter.diameter,
    ];
  }
  return [emitter.position.x, emitter.position.y, emitter.position.z];
}

/**
 * Initial velocity for burst-spawned particles — matches VELOCITY_SHADER's
 * own jitter pattern so burst particles start moving with emitter.velocity
 * immediately instead of sitting stationary until their first respawn.
 */
export function initialVelocity(index: number, emitter: EmitterConfig, size?: number): [number, number, number] {
  if (size !== undefined && size > 0) {
    const u = ((index % size) + 0.5) / size;
    const v = (Math.floor(index / size) + 0.5) / size;
    const dotVal = u * 93.9898 + v * 47.233;
    const seed = ((Math.sin(dotVal) * 24634.6345) % 1 + 1) % 1;
    const s1 = seed;
    const s2 = ((seed * 5.0) % 1 + 1) % 1;
    const s3 = ((seed * 11.0) % 1 + 1) % 1;
    return [
      emitter.velocity.x + (s1 - 0.5) * 0.5,
      emitter.velocity.y + (s2 - 0.5) * 0.5,
      emitter.velocity.z + (s3 - 0.5) * 0.5,
    ];
  }
  return [emitter.velocity.x, emitter.velocity.y, emitter.velocity.z];
}

/**
 * Fills a fresh DataTexture with every burst-spawned texel's position+age
 * (spawnNow=true shape of initialAge/initialPosition above) — shared by
 * createSimulation's initial texture (the gate was already open when the
 * sim was built) and maybeBurstOnEmitRisingEdge's later re-seed (the gate
 * just opened on a live sim). Velocity resets to the emitter's initial velocity
 * with jitter alongside it.
 */
function buildBurstTextures(gpuCompute: GPUComputationRenderer, size: number, emitter: EmitterConfig): { position: THREE.DataTexture; velocity: THREE.DataTexture } {
  const position = gpuCompute.createTexture();
  const positionData = position.image.data as Float32Array;
  const velocity = gpuCompute.createTexture();
  const velocityData = velocity.image.data as Float32Array;
  const capacity = size * size;
  for (let i = 0; i < capacity; i++) {
    const [x, y, z] = initialPosition(i, emitter, capacity, size);
    positionData[i * 4] = x;
    positionData[i * 4 + 1] = y;
    positionData[i * 4 + 2] = z;
    positionData[i * 4 + 3] = 0;

    const [vx, vy, vz] = initialVelocity(i, emitter, size);
    velocityData[i * 4] = vx;
    velocityData[i * 4 + 1] = vy;
    velocityData[i * 4 + 2] = vz;
    velocityData[i * 4 + 3] = 0;
  }
  return { position, velocity };
}

function initialPositionTexture(
  gpuCompute: GPUComputationRenderer,
  size: number,
  lifetimeGuess: number,
  burstSpawn: boolean,
  spawnNow: boolean,
  emitter: EmitterConfig,
): THREE.DataTexture {
  const texture = gpuCompute.createTexture();
  const data = texture.image.data as Float32Array;
  const capacity = size * size;
  for (let i = 0; i < capacity; i++) {
    data[i * 4 + 3] = initialAge(i, capacity, lifetimeGuess, burstSpawn, spawnNow);
    if (burstSpawn && spawnNow) {
      const [x, y, z] = initialPosition(i, emitter, capacity, size);
      data[i * 4] = x;
      data[i * 4 + 1] = y;
      data[i * 4 + 2] = z;
    }
  }
  return texture;
}

function initialVelocityTexture(
  gpuCompute: GPUComputationRenderer,
  size: number,
  burstSpawn: boolean,
  spawnNow: boolean,
  emitter: EmitterConfig,
): THREE.DataTexture {
  const texture = gpuCompute.createTexture();
  if (burstSpawn && spawnNow) {
    const data = texture.image.data as Float32Array;
    const capacity = size * size;
    for (let i = 0; i < capacity; i++) {
      const [vx, vy, vz] = initialVelocity(i, emitter, size);
      data[i * 4] = vx;
      data[i * 4 + 1] = vy;
      data[i * 4 + 2] = vz;
      data[i * 4 + 3] = 0;
    }
  }
  return texture;
}

/**
 * The other half of the burstSpawn + "only when driven" gate: a sim that
 * was already alive with the gate closed (emitter.emit false) has every
 * burst-mode texel parked at the dead sentinel age (see initialAge) since
 * creation. The moment something drives Emit to true, this writes real
 * spawn positions (age 0) straight into whichever render target the sim's
 * ping-pong is currently reading from — not through the shader's own
 * respawn branch, which would need a full Lifetime of simulated time to
 * reach every texel (the entire reason burstSpawn exists in the first
 * place). Runs at most once per false→true transition (see Simulation.lastEmit).
 */
function maybeBurstOnEmitRisingEdge(sim: Simulation, burstSpawn: boolean, emitter: EmitterConfig): void {
  const risingEdge = burstSpawn && !sim.lastEmit && emitter.emit;
  sim.lastEmit = emitter.emit;
  if (!risingEdge) return;

  const { position, velocity } = buildBurstTextures(sim.gpuCompute, sim.size, emitter);
  const positionTarget = sim.gpuCompute.getCurrentRenderTarget(sim.positionVar);
  const velocityTarget = sim.gpuCompute.getCurrentRenderTarget(sim.velocityVar);
  sim.renderer.copyTextureToTexture(position, positionTarget.texture);
  sim.renderer.copyTextureToTexture(velocity, velocityTarget.texture);
  position.dispose();
  velocity.dispose();
}

/** Every texel's age set to the same "beyond activeCount" dead sentinel POSITION_SHADER already uses — a force-kill, not the gradual per-texel fade `emit=false` alone gives. Position/velocity reset to zero too: irrelevant once dead, but tidy. */
function buildKillTextures(gpuCompute: GPUComputationRenderer): { position: THREE.DataTexture; velocity: THREE.DataTexture } {
  const position = gpuCompute.createTexture();
  const data = position.image.data as Float32Array;
  for (let i = 3; i < data.length; i += 4) data[i] = -1.0e6;
  return { position, velocity: gpuCompute.createTexture() };
}

/**
 * The kill counterpart to maybeBurstOnEmitRisingEdge: on killSignal's
 * false→true edge, force-kills the ENTIRE population immediately by writing
 * the dead sentinel into every texel of the sim's current ping-pong render
 * target — "clean up the scene at frame N" wants everyone gone on that
 * exact frame, not faded out over up to a full Lifetime the way closing the
 * `emit` gate alone would (worse, arbitrarily slow if Lifetime was
 * deliberately set past the animation's length, which Burst Spawn's own
 * setup recommends). Runs at most once per false→true transition.
 */
function maybeKillOnRisingEdge(sim: Simulation, killSignal: boolean): void {
  const risingEdge = !sim.lastKill && killSignal;
  sim.lastKill = killSignal;
  if (!risingEdge) return;

  const { position, velocity } = buildKillTextures(sim.gpuCompute);
  const positionTarget = sim.gpuCompute.getCurrentRenderTarget(sim.positionVar);
  const velocityTarget = sim.gpuCompute.getCurrentRenderTarget(sim.velocityVar);
  sim.renderer.copyTextureToTexture(position, positionTarget.texture);
  sim.renderer.copyTextureToTexture(velocity, velocityTarget.texture);
  position.dispose();
  velocity.dispose();
}

function createSimulation(
  nodeId: string,
  renderer: THREE.WebGLRenderer,
  size: number,
  lifetimeGuess: number,
  currentStep: number,
  burstSpawn: boolean,
  emitter: EmitterConfig,
): Simulation {
  const gpuCompute = new GPUComputationRenderer(size, size, renderer);
  const spawnNow = emitter.emit && !emitter.killSignal;
  const position0 = initialPositionTexture(gpuCompute, size, lifetimeGuess, burstSpawn, spawnNow, emitter);
  const velocity0 = initialVelocityTexture(gpuCompute, size, burstSpawn, spawnNow, emitter);

  const positionVar = gpuCompute.addVariable("texturePosition", POSITION_SHADER, position0);
  const velocityVar = gpuCompute.addVariable("textureVelocity", VELOCITY_SHADER, velocity0);
  gpuCompute.setVariableDependencies(positionVar, [positionVar, velocityVar]);
  gpuCompute.setVariableDependencies(velocityVar, [positionVar, velocityVar]);

  for (const uniforms of [positionVar.material.uniforms, velocityVar.material.uniforms]) {
    uniforms.delta = { value: STEP_SECONDS };
    uniforms.lifetime = { value: lifetimeGuess };
    uniforms.lifetimeVariance = { value: 0 };
    uniforms.activeCount = { value: 0 };
  }
  positionVar.material.uniforms.emitterPosition = { value: new THREE.Vector3() };
  positionVar.material.uniforms.boundsRadius = { value: 0 };
  positionVar.material.uniforms.seedPositions = { value: getPlaceholderSeedTexture() };
  positionVar.material.uniforms.seedCount = { value: 0 };
  positionVar.material.uniforms.seedSize = { value: 1 };
  positionVar.material.uniforms.spawnDiameter = { value: 0.25 };
  positionVar.material.uniforms.seedRandomPick = { value: 0 };
  positionVar.material.uniforms.emitEnabled = { value: 1 };
  positionVar.material.uniforms.time = { value: 0 };
  positionVar.material.uniforms.groundEnabled = { value: 0 };
  positionVar.material.uniforms.groundY = { value: 0 };
  velocityVar.material.uniforms.groundEnabled = { value: 0 };
  velocityVar.material.uniforms.groundY = { value: 0 };
  velocityVar.material.uniforms.groundBounce = { value: 0 };
  velocityVar.material.uniforms.groundFriction = { value: 1 };
  velocityVar.material.uniforms.emitterVelocity = { value: new THREE.Vector3() };
  velocityVar.material.uniforms.gravity = { value: 0 };
  velocityVar.material.uniforms.wind = { value: new THREE.Vector3() };
  velocityVar.material.uniforms.noiseStrength = { value: 0 };
  velocityVar.material.uniforms.noiseScale = { value: 1 };
  velocityVar.material.uniforms.noiseSpeed = { value: 0.1 };
  velocityVar.material.uniforms.time = { value: 0 };
  velocityVar.material.uniforms.maxSpeed = { value: 0 };
  velocityVar.material.uniforms.fieldPosition = { value: Array.from({ length: MAX_FORCE_FIELDS }, () => new THREE.Vector3()) };
  velocityVar.material.uniforms.fieldAxis = { value: Array.from({ length: MAX_FORCE_FIELDS }, () => new THREE.Vector3(0, 1, 0)) };
  velocityVar.material.uniforms.fieldStrength = { value: new Array(MAX_FORCE_FIELDS).fill(0) };
  velocityVar.material.uniforms.fieldRadius = { value: new Array(MAX_FORCE_FIELDS).fill(0) };
  velocityVar.material.uniforms.fieldScale = { value: new Array(MAX_FORCE_FIELDS).fill(1) };
  velocityVar.material.uniforms.fieldSpeed = { value: new Array(MAX_FORCE_FIELDS).fill(0.1) };
  velocityVar.material.uniforms.fieldType = { value: new Array(MAX_FORCE_FIELDS).fill(0) };
  velocityVar.material.uniforms.fieldCount = { value: 0 };

  const error = gpuCompute.init();
  if (error) console.error(`particles/simulate (${nodeId}): GPUComputationRenderer init failed — ${error}`);

  const sim: Simulation = {
    gpuCompute,
    renderer,
    positionVar,
    velocityVar,
    size,
    lastSteppedStep: currentStep,
    simSeconds: currentStep * STEP_SECONDS,
    lastEmit: emitter.emit,
    lastKill: emitter.killSignal ?? false,
  };
  // Caching is the caller's job now (see getOrCreateSimulation) — it owns
  // the per-renderer slot this belongs in, not just the node id.
  return sim;
}

const MAX_STEPS_PER_FRAME = 240;

export interface SimulationResult {
  positionsTexture: THREE.Texture;
  velocityTexture?: THREE.Texture;
  capacity: number;
}

/** Curl-noise flow field force — see curlNoise() in VELOCITY_SHADER. Strength 0 skips the noise entirely. */
export interface FlowFieldConfig {
  strength: number;
  scale: number;
  speed: number;
}

/** particles/ground's collision plane — a horizontal (Y-normal) floor at `y`. See the ground-response block in VELOCITY_SHADER and the position clamp in POSITION_SHADER. */
export interface GroundConfig {
  enabled: boolean;
  y: number;
  /** 0 = dead stop on contact (settles onto the floor), 1 = perfectly elastic bounce. */
  bounce: number;
  /** Horizontal (x/z) speed retained per contact — 1 = frictionless slide, 0 = grips instantly. */
  friction: number;
}

/** particles/force-field's numeric type tag — matches the fieldType branch in FORCE_FIELD_GLSL exactly. */
export const FORCE_FIELD_TYPES = ["attractor", "vortex", "wind", "turbulence"] as const;
export type ForceFieldType = (typeof FORCE_FIELD_TYPES)[number];

/** One Blender-style force field. Multiple sum together — see forceFieldContribution() in VELOCITY_SHADER. */
export interface ForceFieldDescriptor {
  type: ForceFieldType;
  position: THREE.Vector3;
  /** Rotation axis (vortex) or push direction (wind); unused by attractor/turbulence. */
  axis: THREE.Vector3;
  strength: number;
  /** 0 = infinite (applies everywhere), else a linear falloff to 0 at this distance from `position`. */
  radius: number;
  /** Turbulence only — noise scale. */
  scale: number;
  /** Turbulence only — noise drift speed. */
  speed: number;
}

/**
 * Renderer-less contexts (tests, a headless evaluate call) get a one-time
 * warning and no texture rather than a thrown error — same "degrade
 * gracefully, log once" contract as EvalContext.renderer's own doc.
 */
export function getOrCreateSimulation(
  nodeId: string,
  renderer: THREE.WebGLRenderer | undefined,
  capacity: number,
  emitter: EmitterConfig,
  gravity: number,
  wind: THREE.Vector3,
  lifetime: number,
  currentStep: number,
  lifetimeVariance = 0,
  flowField: FlowFieldConfig = { strength: 0, scale: 1, speed: 0.1 },
  boundsRadius = 0,
  maxSpeed = 0,
  forces: ForceFieldDescriptor[] = [],
  ground?: GroundConfig,
  burstSpawn = false,
): SimulationResult | null {
  if (!renderer) {
    if (!warnedMissingRenderer) {
      console.error("particles/simulate: no WebGLRenderer in EvalContext — particle simulation skipped");
      warnedMissingRenderer = true;
    }
    return null;
  }

  const size = textureSizeFor(capacity);
  let perRenderer = simCache.get(nodeId);
  if (!perRenderer) {
    perRenderer = new Map();
    simCache.set(nodeId, perRenderer);
  }
  let sim = perRenderer.get(renderer);
  // A clock that jumped *backwards* — the timeline scrubbed back, or a video
  // export restarting at frame 0 after the preview already ran — can't be
  // caught up by stepping forward, and leaving the sim where it was made the
  // first exported frames show a simulation that is minutes old. Rebuilding
  // restarts it from the same deterministic initial state every time.
  const rewound = sim !== undefined && currentStep < sim.lastSteppedStep;
  // particles/points-to-particles carries its own population size (one
  // particle per point) and always wants the whole thing spawned at once —
  // see EmitterConfig.pointCount's doc.
  const effectiveBurst = burstSpawn || emitter.pointCount !== undefined;
  if (!sim || sim.size !== size || rewound) {
    if (sim) {
      sim.gpuCompute.dispose();
      sim.seedTexture?.dispose();
    }
    sim = createSimulation(nodeId, renderer, size, lifetime, currentStep, effectiveBurst, emitter);
    perRenderer.set(renderer, sim);
  }
  maybeBurstOnEmitRisingEdge(sim, effectiveBurst, emitter);
  maybeKillOnRisingEdge(sim, emitter.killSignal ?? false);

  const active =
    emitter.pointCount !== undefined
      ? Math.min(size * size, Math.max(0, Math.floor(emitter.pointCount)))
      : effectiveBurst
        ? Math.min(size * size, Math.max(0, emitter.spawnRate > 0 ? Math.round(emitter.spawnRate) : size * size))
        : activeParticleCount(emitter.spawnRate, lifetime, size * size);
  for (const uniforms of [sim.positionVar.material.uniforms, sim.velocityVar.material.uniforms]) {
    uniforms.lifetime.value = lifetime;
    uniforms.lifetimeVariance.value = Math.max(0, Math.min(1, lifetimeVariance));
    uniforms.activeCount.value = active;
  }
  sim.positionVar.material.uniforms.emitterPosition.value.copy(emitter.position);
  sim.positionVar.material.uniforms.boundsRadius.value = Math.max(0, boundsRadius);
  const seed = updateSeedTexture(sim, emitter.seedPositions);
  sim.positionVar.material.uniforms.seedPositions.value = seed.texture;
  sim.positionVar.material.uniforms.seedCount.value = seed.count;
  sim.positionVar.material.uniforms.seedSize.value = seed.size;
  sim.positionVar.material.uniforms.spawnDiameter.value = Math.max(0, emitter.diameter);
  sim.positionVar.material.uniforms.seedRandomPick.value = emitter.randomSpawnPick ? 1 : 0;
  sim.positionVar.material.uniforms.emitEnabled.value = emitter.emit ? 1 : 0;
  sim.velocityVar.material.uniforms.emitterVelocity.value.copy(emitter.velocity);
  sim.velocityVar.material.uniforms.gravity.value = gravity;
  sim.velocityVar.material.uniforms.wind.value.copy(wind);
  sim.velocityVar.material.uniforms.noiseStrength.value = flowField.strength;
  sim.velocityVar.material.uniforms.noiseScale.value = flowField.scale;
  sim.velocityVar.material.uniforms.noiseSpeed.value = flowField.speed;
  sim.velocityVar.material.uniforms.maxSpeed.value = Math.max(0, maxSpeed);

  sim.positionVar.material.uniforms.groundEnabled.value = ground?.enabled ? 1 : 0;
  sim.positionVar.material.uniforms.groundY.value = ground?.y ?? 0;
  sim.velocityVar.material.uniforms.groundEnabled.value = ground?.enabled ? 1 : 0;
  sim.velocityVar.material.uniforms.groundY.value = ground?.y ?? 0;
  sim.velocityVar.material.uniforms.groundBounce.value = Math.max(0, Math.min(1, ground?.bounce ?? 0));
  sim.velocityVar.material.uniforms.groundFriction.value = Math.max(0, Math.min(1, ground?.friction ?? 1));

  const fieldCount = Math.min(MAX_FORCE_FIELDS, forces.length);
  const fieldUniforms = sim.velocityVar.material.uniforms;
  for (let i = 0; i < fieldCount; i++) {
    const f = forces[i];
    fieldUniforms.fieldPosition.value[i].copy(f.position);
    fieldUniforms.fieldAxis.value[i].copy(f.axis);
    fieldUniforms.fieldStrength.value[i] = f.strength;
    fieldUniforms.fieldRadius.value[i] = Math.max(0, f.radius);
    fieldUniforms.fieldScale.value[i] = f.scale;
    fieldUniforms.fieldSpeed.value[i] = f.speed;
    fieldUniforms.fieldType.value[i] = Math.max(0, FORCE_FIELD_TYPES.indexOf(f.type));
  }
  fieldUniforms.fieldCount.value = fieldCount;

  const steps = stepsSince(sim.lastSteppedStep, currentStep, MAX_STEPS_PER_FRAME);
  for (let i = 0; i < steps; i++) {
    sim.velocityVar.material.uniforms.time.value = sim.simSeconds;
    sim.positionVar.material.uniforms.time.value = sim.simSeconds;
    sim.simSeconds += STEP_SECONDS;
    sim.gpuCompute.compute();
  }
  sim.lastSteppedStep += steps;

  const positionsTexture = sim.gpuCompute.getCurrentRenderTarget(sim.positionVar).texture;
  const velocityTexture = sim.gpuCompute.getCurrentRenderTarget(sim.velocityVar).texture;
  positionsTexture.userData = { ...(positionsTexture.userData ?? {}), velocityTexture };

  return {
    positionsTexture,
    velocityTexture,
    capacity: size * size,
  };
}

/**
 * Disposes every cached GPU simulation (render targets, shader materials)
 * and drops the cache, so the next evaluate() rebuilds fresh — what a
 * viewport "reset simulation" control calls. Actually frees GPU resources
 * rather than just dropping references: a reset control is expected to be
 * clicked repeatedly while iterating, and GPUComputationRenderer owns real
 * WebGLRenderTargets that won't otherwise be reclaimed until the renderer
 * itself is torn down.
 */
export function resetAllParticleSimulations(): void {
  for (const perRenderer of simCache.values()) {
    for (const sim of perRenderer.values()) {
      sim.gpuCompute.dispose();
      sim.seedTexture?.dispose();
    }
  }
  simCache.clear();
}

const BLIT_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BLIT_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tex;
  void main() {
    gl_FragColor = texture2D(tex, vUv);
  }
`;

interface ReadbackState {
  target: THREE.WebGLRenderTarget;
  quad: FullScreenQuad;
  material: THREE.ShaderMaterial;
  size: number;
  buffer: Float32Array;
}

// Per-renderer, same reasoning as simCache above — a WebGLRenderTarget reused
// across two concurrently-live renderers (split mode's two panes) is at best
// wasted cross-context state churn and at worst reads back whichever
// renderer wrote to it last, not the one asking.
const readbackCache = createNodeCache<Map<THREE.WebGLRenderer, ReadbackState>>((perRenderer) => {
  for (const s of perRenderer.values()) {
    s.target.dispose();
    s.quad.dispose();
    s.material.dispose();
  }
});

/**
 * Pulls a GPGPU positions texture back to the CPU as a flat (x,y,z,age)×N
 * array — what a node that can't work purely on the GPU (nearest-neighbor
 * search for connect-nearby) needs.
 *
 * `texture` alone doesn't carry pixels off the GPU: `readRenderTargetPixels`
 * reads a *render target*, and the positions texture arriving over the
 * "positions" socket is just the plain THREE.Texture face of one (see
 * particles/simulate's positions output) — the WebGLRenderTarget wrapper
 * that owns it lives inside GPUComputationRenderer and isn't exposed. Rather
 * than plumb that target across the socket (which would break every other
 * consumer expecting a THREE.Texture, e.g. particles/render's material
 * uniform), this blits the incoming texture into a small render target of
 * its own — one fullscreen-quad draw call, using three's own postprocessing
 * FullScreenQuad rather than a hand-rolled one — and reads pixels from that
 * instead. Cheap at the particle counts this node targets (low thousands, a
 * few dozen texels square).
 */
export function readPositionsSync(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  size: number,
  nodeId: string,
): Float32Array {
  let perRenderer = readbackCache.get(nodeId);
  if (!perRenderer) {
    perRenderer = new Map();
    readbackCache.set(nodeId, perRenderer);
  }
  let state = perRenderer.get(renderer);
  if (!state || state.size !== size) {
    if (state) {
      state.target.dispose();
      state.quad.dispose();
      state.material.dispose();
    }
    const target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    const material = new THREE.ShaderMaterial({
      uniforms: { tex: { value: null } },
      vertexShader: BLIT_VERTEX_SHADER,
      fragmentShader: BLIT_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new FullScreenQuad(material);
    state = { target, quad, material, size, buffer: new Float32Array(size * size * 4) };
    perRenderer.set(renderer, state);
  }

  state.material.uniforms.tex.value = texture;
  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(state.target);
  state.quad.render(renderer);
  renderer.setRenderTarget(previousTarget);
  renderer.readRenderTargetPixels(state.target, 0, 0, size, size, state.buffer);
  return state.buffer;
}
