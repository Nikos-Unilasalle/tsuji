import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { asColor, materialParamsFromValue, numberInput } from "./object";
import { POOL_WIDTH, MAX_EDGES_PER_TRIANGLE, wornPool } from "./worn/wornPool";
import { MIN_FEATURE_ANGLE, prepareWornGeometry } from "./worn/wornGeometry";
import { MAX_IMPACTS, MIN_IMPACT_SPEED } from "./worn/wornImpacts";
import { sampleWornPoints, WORN_MASKS, type WornMask } from "./worn/wornMasks";
import { bakeWornTextures, collectWornMeshes, WORN_BAKE_ACTION, WORN_BAKE_SIZES } from "./worn/wornBake";

export { WORN_BAKE_ACTION } from "./worn/wornBake";

export { prepareWornGeometry } from "./worn/wornGeometry";

/** What the Debug View select shows, in the order of its options. */
export const WORN_DEBUG_VIEWS = [
  "off",
  "curvature",
  "edge distance",
  "occlusion",
  "wear mask",
  "dirt mask",
  "chips",
  "scratches",
  "dust & streaks",
  "paint, grip & impacts",
] as const;

/** Grip zones the shader loops over. */
export const MAX_GRIPS = 4;

/** What a bake pass writes, in the order of uBakeChannel (see worn/wornBake.ts). */
export const WORN_BAKE_CHANNELS = ["albedo", "roughness", "metalness", "height", "wear", "dirt"] as const;

/** Bound when a texture socket is empty, so the sampler always has something (and multiplies by 1). */
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

/**
 * Creates the Worn material: a MeshStandardMaterial whose colour, roughness
 * and metalness blend three looks — base, worn (convex edges, tight convex
 * curvature), dirt (concave creases, tight hollows, occluded cavities) —
 * from the geometry prepared by prepareWornGeometry (see worn/). Everything
 * is measured in the mesh's rest space, a fraction of its size, so the same
 * settings weather a ring and a cathedral alike, and the wear stays glued to
 * the surface while it deforms.
 */
export function createWornMaterial(shared?: WornUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.6,
    metalness: 0.1,
  });
  const uniforms = shared ?? createWornUniforms();

  (mat as any).__isSharedCustom = true;
  (mat as any).__isWornMaterial = true;
  (mat as any).__wornUniforms = uniforms;
  (mat as any).__prepareGeometry = (geometry: THREE.BufferGeometry, mesh?: THREE.Object3D) =>
    prepareWornGeometry(geometry, {
      // Occlusion costs rays: bake it only when something reads it.
      ao: uniforms.uCavityDirt.value > 0.001 || uniforms.uDustAmount.value > 0.001 || uniforms.uDebugView.value === 3,
      owner: mesh?.uuid,
    });
  // A copy is the same Worn look — same uniforms, so it follows every edit —
  // with its own side, vertex-colour flag and so on. Edit Mesh copies the
  // material it draws with once the mesh has vertex colours (to switch them
  // on); a plain MeshStandardMaterial copy dropped the whole shader.
  mat.clone = function (this: THREE.MeshStandardMaterial) {
    return createWornMaterial(uniforms).copy(this);
  };

  mat.onBeforeCompile = (shader) => compileWorn(mat, uniforms, shader);
  return mat;
}

export type WornUniforms = ReturnType<typeof createWornUniforms>;

function createWornUniforms() {
  return {
    uBaseColor: { value: new THREE.Color(0x3a4a58) },
    uBaseRoughness: { value: 0.6 },
    uBaseMetalness: { value: 0.1 },

    uWornColor: { value: new THREE.Color(0xdcdcdc) },
    uWornRoughness: { value: 0.25 },
    uWornMetalness: { value: 0.9 },

    uDirtColor: { value: new THREE.Color(0x1e1510) },
    uDirtRoughness: { value: 0.95 },
    uDirtMetalness: { value: 0.0 },

    uWearAmount: { value: 0.4 },
    uDirtAmount: { value: 0.4 },
    uContrast: { value: 2.0 },
    uNoise: { value: 0.35 },
    uNoiseScale: { value: 6.0 },
    // Octave count for the fractal noise, as a float so it can be faded in
    // fractionally rather than popping a whole octave into existence.
    uNoiseDetail: { value: 3.0 },
    // Domain offset derived from the Seed param, so two Worn nodes on two
    // objects don't wear along identical noise.
    uSeedOffset: { value: new THREE.Vector3() },
    uNoiseSpace: { value: 0 },
    // Low-frequency mottling of the base surface itself, independent of the
    // edge wear: a perfectly uniform flat face is the least convincing part
    // of the result.
    uVariation: { value: 0.25 },
    // Discrete on/off patching of the wear and the dirt, so neither runs the
    // full length of every qualifying edge.
    uWearPatch: { value: 0.3 },
    uDirtPatch: { value: 0.3 },
    uPatchScale: { value: 2.5 },
    // Wear and dirt driven by per-vertex curvature instead of edges, the only
    // measure that sees a smooth curved surface at all.
    uCurveWear: { value: 0.35 },
    uCurveDirt: { value: 0.35 },
    uCurveSensitivity: { value: 1.0 },
    // Edges bending less than this (degrees) don't wear or collect dirt; the
    // effect ramps in over the next 30°.
    uEdgeAngle: { value: 30 },
    // Grime from ambient occlusion: cavities, under lips, between parts.
    uCavityDirt: { value: 0.35 },
    // 0 off, else an index into WORN_DEBUG_VIEWS: shows a mask, unlit.
    uDebugView: { value: 0 },
    // The shared pool (see worn/wornPool.ts) — never rebound, so one material
    // can draw any number of different meshes.
    uWornEdges: { value: wornPool.edgeTexture },
    uWornLists: { value: wornPool.listTexture },

    // Paint chips: the worn area in layers — the paint gives way to a primer
    // rim, the primer to bare metal at the heart of the chip.
    uPrimerColor: { value: new THREE.Color(0x8a3b2a) },
    uPrimerWidth: { value: 0 },
    // 0: wear fades in softly (as it always did); 1: chips with crisp edges.
    uChipHardness: { value: 0 },
    // Depth of the chips, for the light: their edge catches it.
    uChipRelief: { value: 0 },
    uScratchAmount: { value: 0 },
    uScratchScale: { value: 18 },
    uDustAmount: { value: 0 },
    uDustColor: { value: new THREE.Color(0xb8ad9a) },
    uStreakAmount: { value: 0 },
    uStreakScale: { value: 4 },
    // Textures for the base and the worn metal, projected triplanar in rest
    // space: no UVs needed, glued to the surface like the rest.
    uBaseMap: { value: WHITE as THREE.Texture },
    uWornMap: { value: WHITE as THREE.Texture },
    uTextureScale: { value: 1 },

    // Global Scale: how wide the bands run (the noise frequencies are divided
    // by it on the CPU side, see evaluate).
    uWidthScale: { value: 1 },
    // Hand-painted masks from the vertex colours: 0 off, 1 on.
    uPaintMask: { value: 0 },
    // Grip zones, in world space: xyz and radius.
    uGripCount: { value: 0 },
    uGrip: { value: Array.from({ length: MAX_GRIPS }, () => new THREE.Vector4()) },
    uGripAmount: { value: 0.8 },
    // Impacts recorded by the physics (see worn/wornImpacts.ts).
    uImpactAmount: { value: 0.8 },
    uImpactSize: { value: 1 },
    uImpactThreshold: { value: 1.5 },
    // Bake passes only (WORN_BAKE defined): which channel to write.
    uBakeChannel: { value: 0 },
  };
}

function compileWorn(mat: THREE.Material, uniforms: WornUniforms, shader: THREE.WebGLProgramParametersWithUniforms) {
  for (const [k, v] of Object.entries(uniforms)) {
    shader.uniforms[k] = v;
  }
  (mat as any).__shaderUniforms = shader.uniforms;

  shader.vertexShader = shader.vertexShader.replace(
    "#include <common>",
    `
    #include <common>
    attribute vec3 aWornRest;
    attribute vec2 aWornSurface;
    attribute vec2 aWornList;
    attribute vec3 aWornPaint;
    attribute vec2 aWornImpacts;

    varying vec3 vWornRest;
    varying vec2 vWornSurface;
    flat varying vec2 vWornList;
    varying vec3 vWornNoisePos;
    varying vec3 vWornWorldPos;
    varying vec3 vWornWorldNormal;
    varying vec3 vWornObjectNormal;
    varying vec3 vWornPaint;
    flat varying vec2 vWornImpacts;
    uniform float uNoiseSpace;
    `
  );

  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    `
    #include <begin_vertex>
    vWornRest = aWornRest;
    // x: mean curvature (×size), interpolated so it reads as a smooth
    // gradient over a curved surface; y: ambient occlusion (1 open).
    vWornSurface = aWornSurface;
    vWornList = aWornList;
    // Rest space by default: glued to the surface, even while it deforms.
    // In world space it stays put and the object slides through it — which
    // is what a row of instances wants (each copy weathered differently)
    // and what a moving object never does.
    vec4 wornLocal = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      wornLocal = instanceMatrix * wornLocal;
    #endif
    vWornNoisePos = uNoiseSpace > 0.5 ? (modelMatrix * wornLocal).xyz : aWornRest;
    // World position and normal, for what gravity decides: dust settles on
    // what faces up, streaks run down what stands.
    vWornWorldPos = (modelMatrix * wornLocal).xyz;
    vec3 wornNormalLocal = objectNormal;
    #ifdef USE_INSTANCING
      wornNormalLocal = mat3(instanceMatrix) * wornNormalLocal;
    #endif
    vWornWorldNormal = normalize(mat3(modelMatrix) * wornNormalLocal);
    vWornObjectNormal = objectNormal;
    vWornPaint = aWornPaint;
    vWornImpacts = aWornImpacts;
    `
  );

  // Bake: draw the surface flat in its UV layout instead of in the view.
  shader.vertexShader = shader.vertexShader.replace(
    "#include <project_vertex>",
    `
    #include <project_vertex>
    #ifdef WORN_BAKE
      gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    #endif
    `
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <common>",
    `
    #include <common>
    uniform vec3 uBaseColor;
    uniform float uBaseRoughness;
    uniform float uBaseMetalness;

    uniform vec3 uWornColor;
    uniform float uWornRoughness;
    uniform float uWornMetalness;

    uniform vec3 uDirtColor;
    uniform float uDirtRoughness;
    uniform float uDirtMetalness;

    uniform float uWearAmount;
    uniform float uDirtAmount;
    uniform float uContrast;
    uniform float uNoise;
    uniform float uNoiseScale;
    uniform float uNoiseDetail;
    uniform vec3 uSeedOffset;
    uniform float uVariation;
    uniform float uWearPatch;
    uniform float uDirtPatch;
    uniform float uPatchScale;
    uniform float uCurveWear;
    uniform float uCurveDirt;
    uniform float uCurveSensitivity;
    uniform float uEdgeAngle;
    uniform float uCavityDirt;
    uniform int uDebugView;
    uniform highp sampler2D uWornEdges;
    uniform highp sampler2D uWornLists;
    uniform vec3 uPrimerColor;
    uniform float uPrimerWidth;
    uniform float uChipHardness;
    uniform float uChipRelief;
    uniform float uScratchAmount;
    uniform float uScratchScale;
    uniform float uDustAmount;
    uniform vec3 uDustColor;
    uniform float uStreakAmount;
    uniform float uStreakScale;
    uniform sampler2D uBaseMap;
    uniform sampler2D uWornMap;
    uniform float uTextureScale;
    uniform float uWidthScale;
    uniform float uPaintMask;
    uniform int uGripCount;
    uniform vec4 uGrip[${MAX_GRIPS}];
    uniform float uGripAmount;
    uniform float uImpactAmount;
    uniform float uImpactSize;
    uniform float uImpactThreshold;
    uniform int uBakeChannel;

    varying vec3 vWornRest;
    varying vec2 vWornSurface;
    flat varying vec2 vWornList;
    varying vec3 vWornNoisePos;
    varying vec3 vWornWorldPos;
    varying vec3 vWornWorldNormal;
    varying vec3 vWornObjectNormal;
    varying vec3 vWornPaint;
    flat varying vec2 vWornImpacts;

    // A texture projected along the three rest-space axes, blended by the
    // normal. Tiled here (fract) rather than by the texture's own wrap mode,
    // which belongs to whoever made it; the gradients of the untiled
    // coordinates keep the mip level from jumping at each tile's seam.
    vec3 wornSample(sampler2D map, vec2 uv) {
      return textureGrad(map, fract(uv), dFdx(uv), dFdy(uv)).rgb;
    }
    vec3 wornTriplanar(sampler2D map, vec3 p, vec3 n) {
      vec3 w = pow(abs(normalize(n)), vec3(4.0));
      w /= max(w.x + w.y + w.z, 1e-5);
      return wornSample(map, p.zy) * w.x + wornSample(map, p.xz) * w.y + wornSample(map, p.xy) * w.z;
    }

    ivec2 wornTexel(int i) { return ivec2(i % ${POOL_WIDTH}, i / ${POOL_WIDTH}); }

    // Distance from p to the segment a–b.
    float wornSegmentDistance(vec3 p, vec3 a, vec3 b) {
      vec3 ab = b - a;
      float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
      return length(p - (a + ab * t));
    }

    // 3D Simplex noise
    vec4 permuteWorn(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
    vec4 taylorInvSqrtWorn(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float snoiseWorn(vec3 v){
      const vec2  C = vec2(1.0/6.0, 1.0/3.0);
      const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy) );
      vec3 x0 = v - i + dot(i, C.xxx) ;
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min( g.xyz, l.zxy );
      vec3 i2 = max( g.xyz, l.zxy );
      vec3 x1 = x0 - i1 + 1.0 * C.xxx;
      vec3 x2 = x0 - i2 + 2.0 * C.xxx;
      vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
      i = mod(i, 289.0 );
      vec4 p = permuteWorn( permuteWorn( permuteWorn(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
      float n_ = 0.142857142857;
      vec3  ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z *ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_ );
      vec4 x = x_ *ns.x + ns.yyyy;
      vec4 y = y_ *ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4( x.xy, y.xy );
      vec4 b1 = vec4( x.zw, y.zw );
      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
      vec3 p0 = vec3(a0.xy,h.x);
      vec3 p1 = vec3(a0.zw,h.y);
      vec3 p2 = vec3(a1.xy,h.z);
      vec3 p3 = vec3(a1.zw,h.w);
      vec4 norm = taylorInvSqrtWorn(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
    }

    // Fractal sum of the noise above, in [-1, 1]. A single octave gives an
    // even, soapy breakup; stacking a few is what reads as grime and pitting
    // rather than a wobbly outline. The loop bound is a constant (GLSL ES 1.0
    // will not take a uniform there) and the octave count fades each one in,
    // so raising Detail doesn't pop.
    float fbmWorn(vec3 p, float detail) {
      float sum = 0.0;
      float amp = 0.5;
      float norm = 0.0;
      for (int i = 0; i < 4; i++) {
        // Not named "active" — that is a reserved word in GLSL ES.
        float octWeight = clamp(detail - float(i), 0.0, 1.0);
        if (octWeight <= 0.0) break;
        sum += snoiseWorn(p) * amp * octWeight;
        norm += amp * octWeight;
        p *= 2.02;
        amp *= 0.5;
      }
      return norm > 0.0 ? sum / norm : 0.0;
    }

    // A discrete patch mask: 0 or 1 over most of the surface, with a narrow
    // ramp at the boundary that exists for anti-aliasing, not as a gradient.
    // The continuous Organic Breakup only ever wobbles the width of a band
    // that still runs the entire length of every qualifying edge, which is
    // what makes an untouched result look machine-applied. This instead
    // removes whole stretches. Raising "amount" lifts the threshold, so more
    // of the noise field falls below it and more of the edge is left clean.
    float patchMaskWorn(vec3 p, float amount) {
      if (amount <= 0.001) return 1.0;
      // 0.7, not the 0.5 a plain [-1,1] -> [0,1] remap would use: two
      // octaves of simplex rarely approach ±1, so the field bunches around
      // 0.5 and the first half of the slider would do nothing at all. The
      // gain spreads it back out across the threshold's range.
      float m = clamp(fbmWorn(p, 2.0) * 0.7 + 0.5, 0.0, 1.0);
      float t = amount * 0.8;
      return smoothstep(t, t + 0.1, m);
    }

    // Fine scratches: noise squashed along one axis is a stack of thin
    // sheets, and a sheet cut by the surface is a line. Three families at
    // unrelated tilts, each let through only in sparse patches, so the
    // lines run every which way without a grid showing.
    float scratchFamilyWorn(vec3 p, mat3 turn, float gate) {
      vec3 q = turn * p;
      float sheet = abs(snoiseWorn(vec3(q.x * 0.7, q.y * 0.7, q.z * 38.0)));
      float line = 1.0 - smoothstep(0.0, 0.07, sheet);
      float patchN = snoiseWorn(q * 0.35 + gate) * 0.5 + 0.5;
      return line * smoothstep(0.55, 0.75, patchN);
    }
    float scratchesWorn(vec3 p) {
      float s = scratchFamilyWorn(p, mat3(0.8, 0.6, 0.0, -0.6, 0.8, 0.0, 0.0, 0.0, 1.0), 3.1);
      s = max(s, scratchFamilyWorn(p, mat3(1.0, 0.0, 0.0, 0.0, 0.28, 0.96, 0.0, -0.96, 0.28), 7.7));
      s = max(s, scratchFamilyWorn(p, mat3(0.36, 0.0, -0.93, 0.0, 1.0, 0.0, 0.93, 0.0, 0.36), 12.9));
      return s;
    }
    `
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <color_fragment>",
    `
    #include <color_fragment>

    // Fractal noise for organic edge breakup, remapped to [0, 1] and
    // centred on 1.0 so raising Organic Breakup roughens the band's edge
    // instead of shrinking it.
    vec3 wornNoisePos = vWornNoisePos * uNoiseScale + uSeedOffset;
    float n = fbmWorn(wornNoisePos, uNoiseDetail) * 0.5 + 0.5;
    float noiseMod = 1.0 + (n - 0.5) * uNoise * 1.5;

    // A separate, much coarser sample: patchy discolouration and roughness
    // across the body of the surface, where the edge wear never reaches.
    float wornVariation = uVariation > 0.001
      ? fbmWorn(wornNoisePos * 0.5 + 11.3, max(2.0, uNoiseDetail)) * uVariation
      : 0.0;

    // Band widths, in rest space (fractions of the mesh's size).
    float wearWidth = max(0.0001, uWearAmount * 0.25 * uWidthScale) * max(0.05, noiseMod);
    float dirtWidth = max(0.0001, uDirtAmount * 0.25 * uWidthScale) * max(0.05, noiseMod);

    float wearFactor = 0.0;
    float dirtFactor = 0.0;
    float wornEdgeDistance = 1e9;

    // The feature edges near this triangle, each at its exact distance.
    // Several combine as a probabilistic OR, so a corner where three edges
    // meet wears more than any one of them — as corners do.
    int wornListStart = int(vWornList.x + 0.5);
    int wornListCount = int(vWornList.y + 0.5);
    for (int i = 0; i < ${MAX_EDGES_PER_TRIANGLE}; i++) {
      if (i >= wornListCount) break;
      vec4 wornListTexel = texelFetch(uWornLists, wornTexel(wornListStart + i / 4), 0);
      int lane = i - (i / 4) * 4;
      float edgeRef = lane == 0 ? wornListTexel.x : lane == 1 ? wornListTexel.y : lane == 2 ? wornListTexel.z : wornListTexel.w;
      if (edgeRef < 0.0) continue;
      int edge = int(edgeRef + 0.5);
      vec4 edgeA = texelFetch(uWornEdges, wornTexel(edge * 2), 0);
      vec4 edgeB = texelFetch(uWornEdges, wornTexel(edge * 2 + 1), 0);
      float strength = smoothstep(uEdgeAngle, uEdgeAngle + 30.0, abs(edgeA.w));
      if (strength <= 0.0) continue;
      float d = wornSegmentDistance(vWornRest, edgeA.xyz, edgeB.xyz);
      if (edgeA.w > 0.0) {
        wornEdgeDistance = min(wornEdgeDistance, d);
        if (uWearAmount > 0.001) {
          float f = smoothstep(wearWidth, 0.0, d) * strength;
          wearFactor = 1.0 - (1.0 - wearFactor) * (1.0 - f);
        }
      } else if (uDirtAmount > 0.001) {
        float f = smoothstep(dirtWidth, 0.0, d) * strength;
        dirtFactor = 1.0 - (1.0 - dirtFactor) * (1.0 - f);
      }
    }

    // The wear before its shaping: chips are cut from this (see below).
    float wearLinear = wearFactor;

    // Contrast shaping: above 1 pulls the falloff in to a tighter edge.
    if (uContrast > 0.1 && uContrast != 1.0) {
      wearFactor = pow(wearFactor, uContrast);
      dirtFactor = pow(dirtFactor, uContrast);
    }

    // Per-vertex curvature, the measure that sees smooth curved surfaces:
    // a gradient over the surface rather than a band along one edge. The
    // ramp starts well above zero (curvature ×size: 1 is a radius the size
    // of the whole object), so only tight curvature wears and broad
    // roundness stays clean.
    float curv = vWornSurface.x * uCurveSensitivity;
    float curveWearF = uCurveWear > 0.001
      ? smoothstep(0.6, 2.2, curv) * uCurveWear * clamp(noiseMod, 0.0, 2.0)
      : 0.0;
    float curveDirtF = uCurveDirt > 0.001
      ? smoothstep(0.6, 2.2, -curv) * uCurveDirt * clamp(noiseMod, 0.0, 2.0)
      : 0.0;
    wearFactor = max(wearFactor, curveWearF);
    wearLinear = max(wearLinear, curveWearF);
    dirtFactor = max(dirtFactor, curveDirtF);

    // Grime where the surface sees little of the sky.
    float wornOcclusion = 1.0 - vWornSurface.y;
    float cavityDirtF = uCavityDirt > 0.001
      ? smoothstep(0.12, 0.65, wornOcclusion) * uCavityDirt * clamp(noiseMod, 0.0, 2.0)
      : 0.0;
    dirtFactor = max(dirtFactor, cavityDirtF);

    // Discrete patches, after the shaping so pow() can't soften their
    // boundary; wear and dirt read the field at separate offsets.
    vec3 patchPos = vWornNoisePos * uPatchScale + uSeedOffset;
    float wearPatchMask = patchMaskWorn(patchPos, uWearPatch);
    wearFactor *= wearPatchMask;
    wearLinear *= wearPatchMask;
    dirtFactor *= patchMaskWorn(patchPos + 53.7, uDirtPatch);

    // Hand-painted masks (the vertex colours Edit Mesh paints): red wears,
    // green dirties, blue protects. Each counts only by its lead over the
    // other two, so white, grey or black paint means nothing at all.
    vec3 wornPaint = vWornPaint * uPaintMask;
    float paintWear = clamp(wornPaint.r - max(wornPaint.g, wornPaint.b), 0.0, 1.0);
    float paintDirt = clamp(wornPaint.g - max(wornPaint.r, wornPaint.b), 0.0, 1.0);
    float paintGuard = 1.0 - clamp(wornPaint.b - max(wornPaint.r, wornPaint.g), 0.0, 1.0);
    float paintBreak = clamp(noiseMod, 0.0, 1.5);
    wearFactor = max(wearFactor, paintWear * paintBreak) * paintGuard;
    wearLinear = max(wearLinear, paintWear * paintBreak) * paintGuard;
    dirtFactor = max(dirtFactor, paintDirt * paintBreak) * paintGuard;

    // Impacts the physics recorded (rest-space point, radius; speed): a
    // chip where each hard knock landed, bigger for a harder one.
    float impactMask = 0.0;
    int wornImpactStart = int(vWornImpacts.x + 0.5);
    int wornImpactCount = int(vWornImpacts.y + 0.5);
    for (int i = 0; i < ${MAX_IMPACTS}; i++) {
      if (i >= wornImpactCount) break;
      vec4 hit = texelFetch(uWornEdges, wornTexel((wornImpactStart + i) * 2), 0);
      vec4 hitInfo = texelFetch(uWornEdges, wornTexel((wornImpactStart + i) * 2 + 1), 0);
      float hard = smoothstep(uImpactThreshold, uImpactThreshold * 1.6 + 0.1, hitInfo.x);
      if (hard <= 0.0) continue;
      float r = hit.w * uImpactSize * uWidthScale * max(0.2, noiseMod);
      float d = length(vWornRest - hit.xyz);
      impactMask = max(impactMask, (1.0 - smoothstep(r * 0.35, r, d)) * hard);
    }
    impactMask = clamp(impactMask * uImpactAmount, 0.0, 1.0) * paintGuard;
    wearFactor = max(wearFactor, impactMask);
    wearLinear = max(wearLinear, impactMask);

    // ----- Layers, bottom to top -----
    vec3 wornWorldN = normalize(vWornWorldNormal);

    // Base: its colour, times its texture.
    vec3 blendedCol = uBaseColor * wornTriplanar(uBaseMap, vWornRest * uTextureScale, vWornObjectNormal);

    // Scratches: thin, everywhere the paint could be brushed against.
    float scratchMask = uScratchAmount > 0.001
      ? scratchesWorn(vWornNoisePos * uScratchScale + uSeedOffset) * uScratchAmount * paintGuard
      : 0.0;

    // Dirt: creases, hollows, cavities.
    blendedCol = mix(blendedCol, uDirtColor, dirtFactor);

    // Streaks: stretched along gravity, on what stands rather than lies.
    float streakMask = 0.0;
    if (uStreakAmount > 0.001) {
      vec3 sp = vWornWorldPos * uStreakScale + uSeedOffset;
      float streakN = fbmWorn(vec3(sp.x, sp.y * 0.06, sp.z), 2.0) * 0.5 + 0.5;
      streakMask = smoothstep(0.52, 0.8, streakN) * (1.0 - abs(wornWorldN.y)) * uStreakAmount * paintGuard;
      blendedCol = mix(blendedCol, uDirtColor, streakMask * 0.85);
    }

    // Chips: the wear, softly (as ever) or crisp by Chip Hardness, in two
    // tiers — the primer rim, then the metal at the heart. Crisp chips are
    // cut from the unshaped wear, their outline broken by a finer noise of
    // its own: jagged edges, and islands flaking off ahead of the band,
    // rather than a clean stripe down every edge.
    float chipNoise = fbmWorn(wornNoisePos * 2.7 + 41.0, 3.0) * 0.5 + 0.5;
    float chipField = wearLinear * mix(1.0, 0.45 + chipNoise * 1.1, uChipHardness);
    float wornAA = fwidth(chipField) + 1e-4;
    float chipMask = mix(wearFactor, smoothstep(0.35 - wornAA, 0.35 + wornAA, chipField), uChipHardness);
    float coreMask = chipMask;
    if (uPrimerWidth > 0.001) {
      float coreAt = 0.35 + uPrimerWidth * 0.5;
      float soft = smoothstep(coreAt - 0.25, coreAt + 0.25, wearFactor) * wearFactor;
      coreMask = mix(soft, smoothstep(coreAt - wornAA, coreAt + wornAA, chipField), uChipHardness);
      blendedCol = mix(blendedCol, uPrimerColor, chipMask);
    }
    vec3 wornLook = uWornColor * wornTriplanar(uWornMap, vWornRest * uTextureScale, vWornObjectNormal);
    blendedCol = mix(blendedCol, wornLook, coreMask);
    // Scratches cut through the paint to what's under it.
    blendedCol = mix(blendedCol, wornLook, scratchMask * 0.55 * (1.0 - coreMask));

    // Grip zones: where hands hold it, polished down to the metal, with a
    // ring of the grime the fingers push to the edge of the polish.
    float gripPolish = 0.0;
    float gripGrime = 0.0;
    for (int i = 0; i < ${MAX_GRIPS}; i++) {
      if (i >= uGripCount) break;
      vec4 grip = uGrip[i];
      float r = max(grip.w, 1e-4);
      float d = length(vWornWorldPos - grip.xyz);
      gripPolish = max(gripPolish, 1.0 - smoothstep(r * 0.45, r, d));
      gripGrime = max(gripGrime, smoothstep(r * 1.6, r, d) * smoothstep(r * 0.6, r * 1.05, d));
    }
    gripPolish *= uGripAmount * clamp(0.6 + n * 0.8, 0.0, 1.0) * paintGuard;
    gripGrime *= uGripAmount * 0.6 * clamp(0.4 + n, 0.0, 1.0) * paintGuard;
    blendedCol = mix(blendedCol, uDirtColor, gripGrime);
    blendedCol = mix(blendedCol, wornLook, gripPolish);

    // Dust on top of everything: on what faces up, and in the cavities.
    float dustMask = 0.0;
    if (uDustAmount > 0.001) {
      float up = smoothstep(0.25, 0.9, wornWorldN.y);
      float dustN = fbmWorn(wornNoisePos * 1.7 + 29.0, 2.0) * 0.5 + 0.5;
      dustMask = clamp((up * 0.85 + wornOcclusion * 0.6) * mix(0.55, 1.15, dustN), 0.0, 1.0) * uDustAmount * paintGuard * (1.0 - gripPolish);
      blendedCol = mix(blendedCol, uDustColor, dustMask);
    }

    // Mottling rides on top of whichever look the pixel ended up with.
    blendedCol *= clamp(1.0 + wornVariation * 0.45, 0.0, 2.0);

    diffuseColor.rgb = blendedCol;

    // Relief, for the normal below: chips are dents, scratches finer ones,
    // dust a whisper above the paint.
    float wornHeight = -(chipMask * 0.6 + coreMask * 0.4) - scratchMask * 0.2 + dustMask * 0.1 - impactMask * 0.5;

    // Debug views: the masks themselves, drawn unlit at the very end.
    vec3 wornDebug = vec3(0.0);
    if (uDebugView == 1) {
      float c = clamp(curv / 2.2, -1.0, 1.0);
      wornDebug = c > 0.0 ? mix(vec3(0.5), vec3(1.0, 0.25, 0.1), c) : mix(vec3(0.5), vec3(0.1, 0.35, 1.0), -c);
    } else if (uDebugView == 2) {
      float k = clamp(wornEdgeDistance / 0.25, 0.0, 1.0);
      float rings = step(0.5, fract(wornEdgeDistance * 40.0));
      wornDebug = mix(vec3(1.0, 0.8, 0.2), vec3(0.08), k) * mix(0.8, 1.0, rings);
    } else if (uDebugView == 3) {
      wornDebug = vec3(vWornSurface.y);
    } else if (uDebugView == 4) {
      wornDebug = mix(vec3(0.05), vec3(1.0, 0.55, 0.1), wearFactor);
    } else if (uDebugView == 5) {
      wornDebug = mix(vec3(0.9), vec3(0.2, 0.12, 0.05), dirtFactor);
    } else if (uDebugView == 6) {
      wornDebug = mix(mix(vec3(0.12), vec3(0.95, 0.45, 0.2), chipMask), vec3(1.0), coreMask);
    } else if (uDebugView == 7) {
      wornDebug = mix(vec3(0.1), vec3(0.9, 0.95, 1.0), scratchMask);
    } else if (uDebugView == 8) {
      wornDebug = vec3(0.1) + vec3(0.9, 0.85, 0.7) * dustMask + vec3(0.2, 0.5, 0.9) * streakMask;
    } else if (uDebugView == 9) {
      wornDebug = vec3(0.1) + vec3(0.9, 0.15, 0.1) * paintWear + vec3(0.15, 0.8, 0.2) * paintDirt
        + vec3(0.2, 0.4, 1.0) * (1.0 - paintGuard);
      wornDebug = mix(wornDebug, vec3(1.0, 0.85, 0.2), gripPolish);
      wornDebug = mix(wornDebug, vec3(1.0), impactMask);
    }
    `
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <roughnessmap_fragment>",
    `
    #include <roughnessmap_fragment>
    float blendedRoughness = uBaseRoughness;
    blendedRoughness = mix(blendedRoughness, uDirtRoughness, max(dirtFactor, streakMask));
    blendedRoughness = mix(blendedRoughness, 0.8, uPrimerWidth > 0.001 ? chipMask : 0.0);
    blendedRoughness = mix(blendedRoughness, uWornRoughness, max(coreMask, scratchMask * 0.7));
    blendedRoughness = mix(blendedRoughness, uDirtRoughness, gripGrime);
    blendedRoughness = mix(blendedRoughness, uWornRoughness * 0.45, gripPolish);
    blendedRoughness = mix(blendedRoughness, 0.95, dustMask);
    blendedRoughness += wornVariation * 0.3;
    roughnessFactor = clamp(blendedRoughness, 0.0, 1.0);
    `
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <metalnessmap_fragment>",
    `
    #include <metalnessmap_fragment>
    float blendedMetalness = uBaseMetalness;
    blendedMetalness = mix(blendedMetalness, uDirtMetalness, max(dirtFactor, streakMask));
    blendedMetalness = mix(blendedMetalness, 0.0, uPrimerWidth > 0.001 ? chipMask : 0.0);
    blendedMetalness = mix(blendedMetalness, uWornMetalness, max(coreMask, scratchMask * 0.5));
    blendedMetalness = mix(blendedMetalness, uWornMetalness, gripPolish);
    blendedMetalness = mix(blendedMetalness, 0.0, dustMask);
    metalnessFactor = clamp(blendedMetalness, 0.0, 1.0);
    `
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <normal_fragment_maps>",
    `
    #include <normal_fragment_maps>
    // Chip relief: a height field (in scene units) turned into a bent
    // normal from its screen-space slope, like a bump map with no map. The
    // rest-to-scene scale comes from the same derivatives, so the depth is
    // a fraction of the object's size whatever its scale.
    if (uChipRelief > 0.001) {
      vec3 wornSx = dFdx(-vViewPosition);
      vec3 wornSy = dFdy(-vViewPosition);
      float wornRestStep = max(length(dFdx(vWornRest)), length(dFdy(vWornRest)));
      float wornScale = wornRestStep > 1e-7 ? max(length(wornSx), length(wornSy)) / wornRestStep : 0.0;
      float wornH = wornHeight * wornScale * 0.004 * uChipRelief;
      vec2 wornDH = vec2(dFdx(wornH), dFdy(wornH));
      vec3 wornR1 = cross(wornSy, normal);
      vec3 wornR2 = cross(normal, wornSx);
      float wornDet = dot(wornSx, wornR1) * faceDirection;
      vec3 wornGrad = sign(wornDet) * (wornDH.x * wornR1 + wornDH.y * wornR2);
      normal = normalize(abs(wornDet) * normal - wornGrad);
    }
    `
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <dithering_fragment>",
    `
    #include <dithering_fragment>
    if (uDebugView > 0) gl_FragColor = vec4(wornDebug, 1.0);
    #ifdef WORN_BAKE
      // Unlit, one channel per pass; colour as sRGB, the rest as data.
      float wornBakeValue = 0.0;
      if (uBakeChannel == 1) wornBakeValue = roughnessFactor;
      else if (uBakeChannel == 2) wornBakeValue = metalnessFactor;
      else if (uBakeChannel == 3) wornBakeValue = clamp(wornHeight * 0.5 + 0.75, 0.0, 1.0);
      else if (uBakeChannel == 4) wornBakeValue = max(max(chipMask, coreMask), max(scratchMask, gripPolish));
      else if (uBakeChannel == 5) wornBakeValue = max(dirtFactor, max(streakMask, max(dustMask, gripGrime)));
      gl_FragColor = uBakeChannel == 0
        ? vec4(sRGBTransferOETF(vec4(diffuseColor.rgb, 1.0)).rgb, 1.0)
        : vec4(vec3(wornBakeValue), 1.0);
    #endif
    `
  );
}

/**
 * How much of each layer an Age holds, as a multiplier on its amount:
 * 0 is brand new (nothing), 0.5 the look as set (all 1), 1 ancient. Layers
 * arrive in the order they do on a real object — scratches almost at once,
 * the edges wearing through steadily, grime a little ahead of them, dust
 * and streaks only after years — and the patches close up with time, the
 * wear running the whole length of the edges in the end.
 */
export function wornAgeFactors(age: number) {
  const t = 2 * Math.max(0, Math.min(1, age));
  const grow = (k: number) => Math.pow(t, k);
  return {
    scratch: grow(0.5),
    wear: grow(1),
    dirt: grow(0.8),
    dust: grow(1.6),
    streak: grow(2),
    variation: grow(0.7),
    /** Multiplies the share of an edge left clean (1 − patchiness). */
    patch: Math.sqrt(t),
  };
}

/**
 * The world positions of what is wired into Grip: points (vectors), objects
 * (their origin) or a list of either, at most MAX_GRIPS.
 */
export function gripPoints(value: unknown, out: THREE.Vector3[] = []): THREE.Vector3[] {
  if (out.length >= MAX_GRIPS || value == null) return out;
  if (value instanceof THREE.Vector3) out.push(value.clone());
  else if (value instanceof THREE.Object3D) {
    value.updateWorldMatrix(true, false);
    out.push(new THREE.Vector3().setFromMatrixPosition(value.matrixWorld));
  } else if (Array.isArray(value)) {
    for (const v of value) gripPoints(v, out);
  } else if (typeof value === "object") {
    const { x, y, z } = value as { x?: unknown; y?: unknown; z?: unknown };
    if (typeof x === "number" && typeof y === "number" && typeof z === "number") out.push(new THREE.Vector3(x, y, z));
  }
  return out.slice(0, MAX_GRIPS);
}

const wornMaterialCache = createNodeCache<THREE.MeshStandardMaterial>((m) => m.dispose());

const c = (hex: number) => new THREE.Color(hex);

/**
 * Every look param a preset sets, at neutral values: each preset starts from
 * this, so picking one never inherits a stray setting from the last.
 */
const PRESET_BASE: Record<string, unknown> = {
  wearAmount: 0.35, dirtAmount: 0.35, contrast: 2, noise: 0.4, noiseScale: 6, noiseDetail: 3, variation: 0.25,
  wearPatch: 0.3, dirtPatch: 0.3, patchScale: 2.5, curveWear: 0.3, curveDirt: 0.3, cavityDirt: 0.35, edgeAngle: 30,
  primerWidth: 0, chipHardness: 0, chipRelief: 0, scratchAmount: 0, scratchScale: 18, dustAmount: 0,
  streakAmount: 0, streakScale: 4, textureScale: 1,
  dustColor: c(0xb8ad9a), primerColor: c(0x8a3b2a),
};
const preset = (look: Record<string, unknown>) => ({ ...PRESET_BASE, ...look });

/**
 * Named looks for the Preset select: one pick writes all of them (see
 * ParamFieldDef presets). Metal layers stop short of full metalness: a pure
 * metal reflects only its surroundings, so with no Environment wired it
 * reads as black — these stay readable in a bare scene and still shine in a lit one.
 */
export const WORN_PRESETS: Record<string, Record<string, unknown>> = {
  "painted metal": preset({
    baseColor: c(0x2f5470), baseRoughness: 0.5, baseMetalness: 0.1,
    wornColor: c(0xd6d6d6), wornRoughness: 0.3, wornMetalness: 0.75,
    dirtColor: c(0x2a2016), dirtRoughness: 0.95, dirtMetalness: 0,
    primerColor: c(0x9c4230), primerWidth: 0.4, chipHardness: 0.9, chipRelief: 0.6,
    scratchAmount: 0.3, dustAmount: 0.15, streakAmount: 0.12, wearAmount: 0.5, cavityDirt: 0.4,
  }),
  "rusty iron": preset({
    baseColor: c(0x5c3620), baseRoughness: 0.92, baseMetalness: 0.15,
    wornColor: c(0xa09c96), wornRoughness: 0.4, wornMetalness: 0.75,
    dirtColor: c(0x3a1c0c), dirtRoughness: 1, dirtMetalness: 0,
    primerColor: c(0x2a1a10), primerWidth: 0.2, chipHardness: 0.6, chipRelief: 0.4,
    wearAmount: 0.22, dirtAmount: 0.45, streakAmount: 0.45, streakScale: 3, variation: 0.55, noise: 0.55, cavityDirt: 0.5,
  }),
  "old wood": preset({
    baseColor: c(0x6b4a2e), baseRoughness: 0.72, baseMetalness: 0,
    wornColor: c(0xa47c52), wornRoughness: 0.6, wornMetalness: 0,
    dirtColor: c(0x2a1a0e), dirtRoughness: 0.95, dirtMetalness: 0,
    chipHardness: 0.25, chipRelief: 0.2, scratchAmount: 0.35, scratchScale: 12, dustAmount: 0.2,
    dirtAmount: 0.45, cavityDirt: 0.45, variation: 0.4,
  }),
  "worn plastic": preset({
    baseColor: c(0xc0392b), baseRoughness: 0.42, baseMetalness: 0,
    wornColor: c(0xe2bcae), wornRoughness: 0.62, wornMetalness: 0,
    dirtColor: c(0x2e2e2e), dirtRoughness: 0.9, dirtMetalness: 0,
    chipHardness: 0.3, chipRelief: 0.15, scratchAmount: 0.45, scratchScale: 22, dustAmount: 0.12,
    wearAmount: 0.25, dirtAmount: 0.25, variation: 0.15,
  }),
  "mossy stone": preset({
    baseColor: c(0x7a7870), baseRoughness: 0.92, baseMetalness: 0,
    wornColor: c(0x9c9a92), wornRoughness: 0.85, wornMetalness: 0,
    dirtColor: c(0x3d5a22), dirtRoughness: 1, dirtMetalness: 0,
    chipHardness: 0.1, chipRelief: 0.3, wearAmount: 0.15, dirtAmount: 0.6, cavityDirt: 0.7, curveDirt: 0.5,
    streakAmount: 0.3, variation: 0.5, noise: 0.6, dirtPatch: 0.15,
  }),
  "antique bronze": preset({
    baseColor: c(0x7a5228), baseRoughness: 0.45, baseMetalness: 0.8,
    wornColor: c(0xe0b06a), wornRoughness: 0.2, wornMetalness: 0.85,
    dirtColor: c(0x2e7a64), dirtRoughness: 0.8, dirtMetalness: 0,
    chipHardness: 0.2, chipRelief: 0.2, scratchAmount: 0.3, dirtAmount: 0.55, cavityDirt: 0.6, curveDirt: 0.5,
    wearAmount: 0.3, dirtPatch: 0.15,
  }),
  gilded: preset({
    baseColor: c(0xd9ac48), baseRoughness: 0.25, baseMetalness: 0.85,
    wornColor: c(0x7a2a1a), wornRoughness: 0.65, wornMetalness: 0,
    dirtColor: c(0x2a2014), dirtRoughness: 0.9, dirtMetalness: 0,
    primerColor: c(0xe8dcc0), primerWidth: 0.4, chipHardness: 0.85, chipRelief: 0.5,
    wearAmount: 0.3, cavityDirt: 0.45, scratchAmount: 0.15,
  }),
};

/**
 * Worn Material Node — blends three materials across a mesh's shape:
 * - Convex edges, tight convex curvature -> Worn material
 * - Concave creases, tight hollows, occluded cavities -> Dirt material
 * - Everything else -> Base material
 */
export const MATERIAL_WORN_NODE: NodeDefinition = {
  type: "material/worn",
  label: "Worn Material",
  category: "material",
  inputs: [
    { id: "base", label: "Base Material", type: "material" },
    { id: "worn", label: "Worn Material (Convex)", type: "material" },
    { id: "dirt", label: "Dirt Material (Concave)", type: "material" },
    { id: "wearAmount", label: "Wear Amount", type: "value" },
    { id: "dirtAmount", label: "Dirt Amount", type: "value" },
    { id: "contrast", label: "Contrast", type: "value" },
    { id: "noise", label: "Noise Intensity", type: "value" },
    { id: "noiseScale", label: "Noise Scale", type: "value" },
    { id: "noiseDetail", label: "Noise Detail", type: "value" },
    { id: "variation", label: "Surface Variation", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "wearPatch", label: "Wear Patchiness", type: "value" },
    { id: "dirtPatch", label: "Dirt Patchiness", type: "value" },
    { id: "patchScale", label: "Patch Scale", type: "value" },
    { id: "curveWear", label: "Curvature Wear", type: "value" },
    { id: "curveDirt", label: "Curvature Dirt", type: "value" },
    { id: "curveSensitivity", label: "Curvature Sensitivity", type: "value" },
    { id: "edgeAngle", label: "Edge Angle", type: "value" },
    { id: "cavityDirt", label: "Cavity Dirt", type: "value" },
    { id: "baseTexture", label: "Base Texture", type: "texture" },
    { id: "wornTexture", label: "Worn Texture", type: "texture" },
    { id: "primerWidth", label: "Primer Width", type: "value" },
    { id: "chipHardness", label: "Chip Hardness", type: "value" },
    { id: "chipRelief", label: "Chip Relief", type: "value" },
    { id: "scratchAmount", label: "Scratches", type: "value" },
    { id: "dustAmount", label: "Dust", type: "value" },
    { id: "streakAmount", label: "Streaks", type: "value" },
    { id: "age", label: "Age", type: "value" },
    { id: "scale", label: "Scale", type: "value" },
    { id: "grip", label: "Grip Points", type: "any" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    baseColor: new THREE.Color(0x3a4a58),
    baseRoughness: 0.6,
    baseMetalness: 0.1,
    wornColor: new THREE.Color(0xdcdcdc),
    wornRoughness: 0.25,
    wornMetalness: 0.9,
    dirtColor: new THREE.Color(0x1e1510),
    dirtRoughness: 0.95,
    dirtMetalness: 0.0,
    wearAmount: 0.4,
    dirtAmount: 0.4,
    contrast: 2.0,
    noise: 0.35,
    noiseScale: 6.0,
    noiseSpace: "object",
    noiseDetail: 3,
    variation: 0.25,
    seed: 1,
    wearPatch: 0.3,
    dirtPatch: 0.3,
    patchScale: 2.5,
    curveWear: 0.35,
    curveDirt: 0.35,
    curveSensitivity: 1.0,
    edgeAngle: 30,
    cavityDirt: 0.35,
    debugView: "off",
    preset: "custom",
    primerColor: new THREE.Color(0x8a3b2a),
    primerWidth: 0,
    chipHardness: 0,
    chipRelief: 0,
    scratchAmount: 0,
    scratchScale: 18,
    dustAmount: 0,
    dustColor: new THREE.Color(0xb8ad9a),
    streakAmount: 0,
    streakScale: 4,
    textureScale: 1,
    age: 0.5,
    scale: 1,
    paintMask: false,
    gripAmount: 0.8,
    gripRadius: 0.15,
    impactAmount: 0.8,
    impactSize: 1,
    impactThreshold: 1.5,
    bakeSize: "2048",
  },
  paramFields: [
    {
      id: "preset",
      label: "Preset",
      kind: "select",
      options: ["custom", ...Object.keys(WORN_PRESETS)],
      presets: WORN_PRESETS,
      group: "Global",
    },
    { id: "age", label: "Age", kind: "number", step: 0.05, group: "Global" },
    { id: "scale", label: "Scale", kind: "number", step: 0.1, group: "Global" },
    {
      id: "globalNote",
      label:
        "Age: 0 is brand new, 0.5 the look exactly as set below, 1 ancient — wire a Time into it to "
        + "watch the object weather (or run it backwards to restore it). Scale: the whole weathering "
        + "bigger or smaller at once — bands, chips, noise, scratches, streaks and textures.",
      kind: "note",
      group: "Global",
    },
    { id: "wearAmount", label: "Wear Amount", kind: "number", step: 0.05, group: "Wear (Convex)" },
    { id: "wornColor", label: "Worn Color", kind: "color", group: "Wear (Convex)" },
    { id: "wornRoughness", label: "Worn Roughness", kind: "number", step: 0.05, group: "Wear (Convex)" },
    { id: "wornMetalness", label: "Worn Metalness", kind: "number", step: 0.05, group: "Wear (Convex)" },
    { id: "wearPatch", label: "Wear Patchiness", kind: "number", step: 0.05, group: "Wear (Convex)" },
    { id: "curveWear", label: "Curvature Wear (Smooth)", kind: "number", step: 0.05, group: "Wear (Convex)" },

    { id: "dirtAmount", label: "Dirt Amount", kind: "number", step: 0.05, group: "Dirt (Concave)" },
    { id: "dirtColor", label: "Dirt Color", kind: "color", group: "Dirt (Concave)" },
    { id: "dirtRoughness", label: "Dirt Roughness", kind: "number", step: 0.05, group: "Dirt (Concave)" },
    { id: "dirtMetalness", label: "Dirt Metalness", kind: "number", step: 0.05, group: "Dirt (Concave)" },
    { id: "dirtPatch", label: "Dirt Patchiness", kind: "number", step: 0.05, group: "Dirt (Concave)" },
    { id: "curveDirt", label: "Curvature Dirt (Smooth)", kind: "number", step: 0.05, group: "Dirt (Concave)" },
    { id: "cavityDirt", label: "Cavity Dirt (Occlusion)", kind: "number", step: 0.05, group: "Dirt (Concave)" },

    { id: "chipHardness", label: "Chip Hardness", kind: "number", step: 0.05, group: "Paint Chips" },
    { id: "primerWidth", label: "Primer Width", kind: "number", step: 0.05, group: "Paint Chips" },
    { id: "primerColor", label: "Primer Color", kind: "color", group: "Paint Chips" },
    { id: "chipRelief", label: "Chip Relief", kind: "number", step: 0.05, group: "Paint Chips" },

    { id: "scratchAmount", label: "Scratches", kind: "number", step: 0.05, group: "Scratches, Dust & Streaks" },
    { id: "scratchScale", label: "Scratch Scale", kind: "number", step: 1, group: "Scratches, Dust & Streaks" },
    { id: "dustAmount", label: "Dust", kind: "number", step: 0.05, group: "Scratches, Dust & Streaks" },
    { id: "dustColor", label: "Dust Color", kind: "color", group: "Scratches, Dust & Streaks" },
    { id: "streakAmount", label: "Streaks", kind: "number", step: 0.05, group: "Scratches, Dust & Streaks" },
    { id: "streakScale", label: "Streak Scale", kind: "number", step: 0.5, group: "Scratches, Dust & Streaks" },

    { id: "textureScale", label: "Texture Scale", kind: "number", step: 0.25, group: "Textures" },
    {
      id: "textureNote",
      label:
        "Wire a texture into Base Texture or Worn Texture: it is projected along the object's own axes "
        + "(no UVs needed) and multiplies that colour. Texture Scale 1 spans the object once.",
      kind: "note",
      group: "Textures",
    },

    { id: "bakeSize", label: "Size", kind: "select", options: [...WORN_BAKE_SIZES], group: "Export Textures" },
    { id: "bakeButton", label: "Bake & Export Textures (ZIP)", kind: "button", action: WORN_BAKE_ACTION, group: "Export Textures" },
    {
      id: "bakeNote",
      label:
        "Bakes every object drawn with this material into PNG maps in its UV layout — albedo, "
        + "roughness, metalness, height, normal, wear and dirt masks — for use outside Tsuji. "
        + "Objects need UVs (Edit Mesh can unwrap them).",
      kind: "note",
      group: "Export Textures",
    },

    { id: "baseColor", label: "Base Color", kind: "color", group: "Base (General)" },
    { id: "baseRoughness", label: "Base Roughness", kind: "number", step: 0.05, group: "Base (General)" },
    { id: "baseMetalness", label: "Base Metalness", kind: "number", step: 0.05, group: "Base (General)" },

    { id: "paintMask", label: "Paint Mask (Vertex Colors)", kind: "boolean", group: "Hands & Impacts" },
    { id: "gripAmount", label: "Grip Polish", kind: "number", step: 0.05, group: "Hands & Impacts" },
    { id: "gripRadius", label: "Grip Radius", kind: "number", step: 0.01, group: "Hands & Impacts" },
    { id: "impactAmount", label: "Impact Chips", kind: "number", step: 0.05, group: "Hands & Impacts" },
    { id: "impactSize", label: "Impact Size", kind: "number", step: 0.1, group: "Hands & Impacts" },
    { id: "impactThreshold", label: "Impact Threshold (m/s)", kind: "number", step: 0.25, group: "Hands & Impacts" },
    {
      id: "handsNote",
      label:
        "Paint Mask: paint the mesh's vertex colours in Edit Mesh — red wears, green dirties, blue "
        + "protects (white, grey and black do nothing). Grip Points: wire points or objects placed "
        + "where the object is held; the paint there is polished away, with a ring of grime around "
        + "it (world units). Impacts: a Rigid Body drawn with this material is chipped wherever it is "
        + "knocked harder than the threshold, while the simulation plays.",
      kind: "note",
      group: "Hands & Impacts",
    },

    { id: "edgeAngle", label: "Edge Angle (°)", kind: "number", step: 5, group: "Tuning" },
    { id: "contrast", label: "Edge Sharpness", kind: "number", step: 0.1, group: "Tuning" },
    { id: "noise", label: "Organic Breakup", kind: "number", step: 0.05, group: "Tuning" },
    { id: "noiseScale", label: "Noise Scale", kind: "number", step: 0.5, group: "Tuning" },
    {
      id: "noiseSpace",
      label: "Noise Space",
      kind: "select",
      options: ["object", "world"],
      group: "Tuning",
    },
    {
      id: "noiseSpaceNote",
      label:
        "object: the wear is glued to the mesh and moves with it. world: it stays put in the "
        + "scene and the object slides through it, which weathers every copy of an Array "
        + "differently but swims on anything that moves.",
      kind: "note",
      group: "Tuning",
    },
    { id: "noiseDetail", label: "Noise Detail (Octaves)", kind: "number", step: 0.25, group: "Tuning" },
    { id: "variation", label: "Surface Variation", kind: "number", step: 0.05, group: "Tuning" },
    { id: "patchScale", label: "Patch Scale", kind: "number", step: 0.25, group: "Tuning" },
    { id: "curveSensitivity", label: "Curvature Sensitivity", kind: "number", step: 0.1, group: "Tuning" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Tuning" },
    {
      id: "debugView",
      label: "Debug View",
      kind: "select",
      options: [...WORN_DEBUG_VIEWS],
      group: "Tuning",
    },
    {
      id: "scaleNote",
      label:
        "Widths, noise and curvature are measured against the object's size, so the same settings "
        + "weather a ring and a cathedral alike. The weathering stays glued to the surface while it "
        + "deforms, and is recomputed once an edited shape holds still.",
      kind: "note",
      group: "Tuning",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = wornMaterialCache.get(ctx.nodeId);
    if (!mat) {
      mat = createWornMaterial();
      wornMaterialCache.set(ctx.nodeId, mat);
    }

    const baseConn = materialParamsFromValue(inputs.base);
    const baseColor = baseConn ? baseConn.color : asColor(params.baseColor, new THREE.Color(0x3a4a58));
    const baseRoughness = baseConn ? baseConn.roughness : numberInput(undefined, params.baseRoughness, 0.6);
    const baseMetalness = baseConn ? baseConn.metalness : numberInput(undefined, params.baseMetalness, 0.1);

    const wornConn = materialParamsFromValue(inputs.worn);
    const wornColor = wornConn ? wornConn.color : asColor(params.wornColor, new THREE.Color(0xdcdcdc));
    const wornRoughness = wornConn ? wornConn.roughness : numberInput(undefined, params.wornRoughness, 0.25);
    const wornMetalness = wornConn ? wornConn.metalness : numberInput(undefined, params.wornMetalness, 0.9);

    const dirtConn = materialParamsFromValue(inputs.dirt);
    const dirtColor = dirtConn ? dirtConn.color : asColor(params.dirtColor, new THREE.Color(0x1e1510));
    const dirtRoughness = dirtConn ? dirtConn.roughness : numberInput(undefined, params.dirtRoughness, 0.95);
    const dirtMetalness = dirtConn ? dirtConn.metalness : numberInput(undefined, params.dirtMetalness, 0.0);

    const wearAmount = Math.max(0, Math.min(1, numberInput(inputs.wearAmount, params.wearAmount, 0.4)));
    const dirtAmount = Math.max(0, Math.min(1, numberInput(inputs.dirtAmount, params.dirtAmount, 0.4)));
    const contrast = Math.max(0.1, Math.min(10, numberInput(inputs.contrast, params.contrast, 2.0)));
    const noise = Math.max(0, Math.min(1, numberInput(inputs.noise, params.noise, 0.35)));
    const noiseScale = Math.max(0.1, Math.min(50, numberInput(inputs.noiseScale, params.noiseScale, 6.0)));
    // 4 is the octave count the shader's loop is unrolled to.
    const noiseDetail = Math.max(1, Math.min(4, numberInput(inputs.noiseDetail, params.noiseDetail, 3)));
    const variation = Math.max(0, Math.min(1, numberInput(inputs.variation, params.variation, 0.25)));
    const seed = numberInput(inputs.seed, params.seed, 1);
    const wearPatch = Math.max(0, Math.min(1, numberInput(inputs.wearPatch, params.wearPatch, 0.3)));
    const dirtPatch = Math.max(0, Math.min(1, numberInput(inputs.dirtPatch, params.dirtPatch, 0.3)));
    const patchScale = Math.max(0.05, Math.min(50, numberInput(inputs.patchScale, params.patchScale, 2.5)));
    const curveWear = Math.max(0, Math.min(1, numberInput(inputs.curveWear, params.curveWear, 0.35)));
    const curveDirt = Math.max(0, Math.min(1, numberInput(inputs.curveDirt, params.curveDirt, 0.35)));
    const curveSensitivity = Math.max(0.01, Math.min(20, numberInput(inputs.curveSensitivity, params.curveSensitivity, 1.0)));
    // Below MIN_FEATURE_ANGLE there are no edges to find: curvature takes over.
    const edgeAngle = Math.max(MIN_FEATURE_ANGLE, Math.min(150, numberInput(inputs.edgeAngle, params.edgeAngle, 30)));
    const cavityDirt = Math.max(0, Math.min(1, numberInput(inputs.cavityDirt, params.cavityDirt, 0.35)));
    const debugView = Math.max(0, WORN_DEBUG_VIEWS.indexOf(String(params.debugView ?? "off") as (typeof WORN_DEBUG_VIEWS)[number]));
    const unit = (key: string, fallback: number) => Math.max(0, Math.min(1, numberInput(inputs[key], params[key], fallback)));
    const primerWidth = unit("primerWidth", 0);
    const chipHardness = unit("chipHardness", 0);
    const chipRelief = unit("chipRelief", 0);
    const scratchAmount = unit("scratchAmount", 0);
    const dustAmount = unit("dustAmount", 0);
    const streakAmount = unit("streakAmount", 0);
    const scratchScale = Math.max(0.5, Math.min(200, numberInput(undefined, params.scratchScale, 18)));
    const streakScale = Math.max(0.1, Math.min(100, numberInput(undefined, params.streakScale, 4)));
    const textureScale = Math.max(0.01, Math.min(100, numberInput(undefined, params.textureScale, 1)));
    const texture = (v: unknown) => (v instanceof THREE.Texture && v.image ? v : null);
    const baseTexture = texture(inputs.baseTexture);
    const wornTexture = texture(inputs.wornTexture);
    const age = unit("age", 0.5);
    const grow = wornAgeFactors(age);
    const scale = Math.max(0.1, Math.min(10, numberInput(inputs.scale, params.scale, 1)));
    const grips = gripPoints(inputs.grip);
    const gripRadius = Math.max(0.001, numberInput(undefined, params.gripRadius, 0.15));

    const u = (mat as any).__wornUniforms;
    if (u) {
      u.uBaseColor.value.copy(baseColor);
      u.uBaseRoughness.value = baseRoughness;
      u.uBaseMetalness.value = baseMetalness;

      u.uWornColor.value.copy(wornColor);
      u.uWornRoughness.value = wornRoughness;
      u.uWornMetalness.value = wornMetalness;

      u.uDirtColor.value.copy(dirtColor);
      u.uDirtRoughness.value = dirtRoughness;
      u.uDirtMetalness.value = dirtMetalness;

      // Age scales every layer's amount by its own growth curve (1 at the
      // default 0.5, so the sliders mean what they say there). Wear and dirt
      // may run past 1 — their bands widen up to the bake's reach — the
      // other layers are fractions and stop at full.
      const aged = (amount: number, factor: number, max = 1) => Math.min(max, amount * factor);
      const agedPatch = (patch: number) => Math.max(0, Math.min(1, 1 - (1 - patch) * grow.patch));
      u.uWearAmount.value = aged(wearAmount, grow.wear, 1.6);
      u.uDirtAmount.value = aged(dirtAmount, grow.dirt, 1.6);
      u.uContrast.value = contrast;
      u.uNoise.value = noise;
      // Scale: the whole weathering bigger or smaller — every pattern's
      // frequency divided by it, every band's width multiplied.
      u.uWidthScale.value = scale;
      u.uNoiseScale.value = noiseScale / scale;
      u.uNoiseSpace.value = String(params.noiseSpace ?? "object") === "world" ? 1 : 0;
      u.uNoiseDetail.value = noiseDetail;
      u.uVariation.value = aged(variation, grow.variation);
      u.uWearPatch.value = agedPatch(wearPatch);
      u.uDirtPatch.value = agedPatch(dirtPatch);
      u.uPatchScale.value = patchScale / scale;
      u.uCurveWear.value = aged(curveWear, grow.wear);
      u.uCurveDirt.value = aged(curveDirt, grow.dirt);
      u.uCurveSensitivity.value = curveSensitivity;
      u.uEdgeAngle.value = edgeAngle;
      u.uCavityDirt.value = aged(cavityDirt, grow.dirt);
      u.uDebugView.value = debugView;
      u.uPrimerColor.value.copy(asColor(params.primerColor, new THREE.Color(0x8a3b2a)));
      u.uPrimerWidth.value = primerWidth;
      u.uChipHardness.value = chipHardness;
      u.uChipRelief.value = chipRelief;
      u.uScratchAmount.value = aged(scratchAmount, grow.scratch);
      u.uScratchScale.value = scratchScale / scale;
      u.uDustAmount.value = aged(dustAmount, grow.dust);
      u.uDustColor.value.copy(asColor(params.dustColor, new THREE.Color(0xb8ad9a)));
      u.uStreakAmount.value = aged(streakAmount, grow.streak);
      u.uStreakScale.value = streakScale / scale;
      u.uTextureScale.value = textureScale / scale;
      u.uPaintMask.value = params.paintMask === true ? 1 : 0;
      u.uGripCount.value = grips.length;
      grips.forEach((p, i) => u.uGrip.value[i].set(p.x, p.y, p.z, gripRadius));
      u.uGripAmount.value = unit("gripAmount", 0.8);
      u.uImpactAmount.value = unit("impactAmount", 0.8);
      u.uImpactSize.value = Math.max(0.05, Math.min(10, numberInput(undefined, params.impactSize, 1)));
      u.uImpactThreshold.value = Math.max(MIN_IMPACT_SPEED, numberInput(undefined, params.impactThreshold, 1.5));
      u.uBaseMap.value = baseTexture ?? WHITE;
      u.uWornMap.value = wornTexture ?? WHITE;
      // Irrational multipliers so consecutive integer seeds land far apart in
      // the noise field on all three axes instead of sliding along one.
      u.uSeedOffset.value.set(seed * 31.4159, seed * 27.1828, seed * 16.1803);
    }

    mat.color.copy(baseColor);
    mat.roughness = baseRoughness;
    mat.metalness = baseMetalness;

    return {
      material: {
        color: baseColor,
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 0,
        shadeless: false,
        roughness: baseRoughness,
        metalness: baseMetalness,
        wireframe: false,
        opacity: 1.0,
        transmission: 0,
        thickness: 0,
        customMaterial: mat,
      },
    };
  },
};

/**
 * The Bake & Export button (see App.tsx's onAction): bakes every mesh this
 * node's material draws, among the graph's evaluated results, and saves the
 * maps as one ZIP. Reports what it couldn't do rather than failing quietly.
 */
export async function exportWornTextures(
  nodeId: string,
  results: Map<string, Record<string, unknown>> | null | undefined,
  params: Record<string, unknown> | undefined,
): Promise<void> {
  const mat = wornMaterialCache.get(nodeId);
  const roots = results ? [...results.values()].flatMap((outputs) => Object.values(outputs)) : [];
  const meshes = mat ? collectWornMeshes(roots, (mat as any).__wornUniforms) : [];
  if (!mat || meshes.length === 0) {
    alert("Nothing to bake: no object in the scene is drawn with this Worn Material yet.");
    return;
  }
  const size = Number(params?.bakeSize) || 2048;
  try {
    const result = await bakeWornTextures(meshes, mat, size);
    if (result.baked.length === 0) {
      alert("Nothing to bake:\n" + result.skipped.join("\n"));
      return;
    }
    const { saveZipBlob } = await import("../../export/imageSequenceExport");
    await saveZipBlob(result.zip, `worn_textures_${size}.zip`);
    if (result.skipped.length > 0) alert("Some objects were skipped:\n" + result.skipped.join("\n"));
  } catch (err) {
    console.error("Worn texture bake failed:", err);
    alert("Worn texture bake failed: " + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Worn Points — the weathering, handed on to the rest of the graph: points
 * scattered where a Worn material wears, dirties or gathers dust, as X/Y/Z
 * lists (for Spawn, a particle emitter, anything taking points), plus how
 * much of the surface the mask covers.
 */
export const MATERIAL_WORN_POINTS_NODE: NodeDefinition = {
  type: "material/worn-points",
  label: "Worn Points",
  category: "material",
  inputs: [
    { id: "geometry", label: "Geometry (Worn)", type: "geometry" },
    { id: "count", label: "Count", type: "value" },
    { id: "threshold", label: "Threshold", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "xValues", label: "X Values (List)", type: "list" },
    { id: "yValues", label: "Y Values (List)", type: "list" },
    { id: "zValues", label: "Z Values (List)", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "coverage", label: "Coverage", type: "value" },
  ],
  defaultParams: { mask: "dirt", count: 200, threshold: 0.3, seed: 1 },
  paramFields: [
    { id: "mask", label: "Mask", kind: "select", options: [...WORN_MASKS] },
    { id: "count", label: "Count", kind: "number", step: 10 },
    { id: "threshold", label: "Threshold", kind: "number", step: 0.05 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    {
      id: "note",
      label:
        "Wire an object drawn with a Worn Material: points land where its mask is at least the "
        + "threshold, more of them where it is stronger — moss in the grime (Spawn), dust shed from "
        + "the dirty parts (particles), flakes along the worn edges. The masks follow the Worn "
        + "settings (Age, amounts, painted masks) without their noise breakup.",
      kind: "note",
    },
  ],
  evaluate: (inputs, params) => {
    const root = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const empty = { xValues: [], yValues: [], zValues: [], count: 0, coverage: 0 };
    if (!root) return empty;
    const mask = (WORN_MASKS as readonly string[]).includes(String(params.mask)) ? (params.mask as WornMask) : "dirt";
    const result = sampleWornPoints(root, {
      mask,
      count: Math.max(0, Math.min(20000, Math.round(numberInput(inputs.count, params.count, 200)))),
      threshold: Math.max(0, Math.min(1, numberInput(inputs.threshold, params.threshold, 0.3))),
      seed: numberInput(inputs.seed, params.seed, 1),
    });
    return {
      xValues: result.x,
      yValues: result.y,
      zValues: result.z,
      count: result.x.length,
      coverage: result.coverage,
    };
  },
};
