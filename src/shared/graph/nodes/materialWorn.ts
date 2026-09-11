import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { asColor, materialParamsFromValue, numberInput } from "./object";

/**
 * Computes a normalized curvature attribute [-1..1] for a geometry.
 * Convex corners/ridges bend away from the normal: positive values (+1 = sharp peak/ridge).
 * Concave crevices/cavities bend towards the normal: negative values (-1 = deep crevice).
 * Flat surfaces: 0.
 */
export function computeGeometryCurvature(geometry: THREE.BufferGeometry): THREE.Float32BufferAttribute {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr) return new THREE.Float32BufferAttribute(new Float32Array(0), 1);

  const count = posAttr.count;
  const curvatures = new Float32Array(count);
  const normAttr = geometry.getAttribute("normal");

  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : Math.floor(count / 3);

  // Group coincident vertices using spatial hashing (welds split normals/corners)
  const spatialMap = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const x = Math.round(posAttr.getX(i) * 1000);
    const y = Math.round(posAttr.getY(i) * 1000);
    const z = Math.round(posAttr.getZ(i) * 1000);
    const key = `${x}_${y}_${z}`;
    let list = spatialMap.get(key);
    if (!list) {
      list = [];
      spatialMap.set(key, list);
    }
    list.push(i);
  }

  const getCanonical = (idx: number): number => {
    const x = Math.round(posAttr.getX(idx) * 1000);
    const y = Math.round(posAttr.getY(idx) * 1000);
    const z = Math.round(posAttr.getZ(idx) * 1000);
    const list = spatialMap.get(`${x}_${y}_${z}`);
    return list && list.length > 0 ? list[0] : idx;
  };

  const neighbors = new Map<number, Set<number>>();
  const addEdge = (i1: number, i2: number) => {
    const c1 = getCanonical(i1);
    const c2 = getCanonical(i2);
    if (c1 === c2) return;
    let s1 = neighbors.get(c1);
    if (!s1) {
      s1 = new Set();
      neighbors.set(c1, s1);
    }
    s1.add(c2);
    let s2 = neighbors.get(c2);
    if (!s2) {
      s2 = new Set();
      neighbors.set(c2, s2);
    }
    s2.add(c1);
  };

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    addEdge(i0, i1);
    addEdge(i1, i2);
    addEdge(i2, i0);
  }

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const nA = new THREE.Vector3();
  const delta = new THREE.Vector3();

  const canonicalCurvature = new Map<number, number>();
  for (const [c, nbrs] of neighbors.entries()) {
    pA.fromBufferAttribute(posAttr, c);
    if (normAttr) {
      nA.fromBufferAttribute(normAttr, c);
    } else {
      nA.set(0, 1, 0);
    }

    if (nbrs.size === 0) {
      canonicalCurvature.set(c, 0);
      continue;
    }

    let sum = 0;
    for (const nbr of nbrs) {
      pB.fromBufferAttribute(posAttr, nbr);
      delta.subVectors(pB, pA);
      const len = delta.length();
      if (len > 1e-6) {
        delta.divideScalar(len);
        // Convex: neighbor points away from outward normal (delta . nA < 0) -> positive curvature
        // Concave: neighbor points towards inward cavity (delta . nA > 0) -> negative curvature
        sum -= delta.dot(nA);
      }
    }
    const avg = sum / nbrs.size;
    canonicalCurvature.set(c, Math.max(-1, Math.min(1, avg * 2.0)));
  }

  for (let i = 0; i < count; i++) {
    const c = getCanonical(i);
    curvatures[i] = canonicalCurvature.get(c) ?? 0;
  }

  return new THREE.Float32BufferAttribute(curvatures, 1);
}

/**
 * Ensures that a geometry has a precomputed `curvature` vertex attribute.
 */
export function ensureCurvatureAttribute(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute("curvature")) return;
  const attr = computeGeometryCurvature(geometry);
  geometry.setAttribute("curvature", attr);
}

/**
 * Creates an edge-worn, crevice-dirt MeshStandardMaterial powered by PBR lighting,
 * geometry/screen-space curvature, and procedural Simplex 3D noise.
 */
export function createWornMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.6,
    metalness: 0.1,
  });

  (mat as any).__isSharedCustom = true;
  (mat as any).__isWornMaterial = true;
  (mat as any).__needsCurvature = true;
  (mat as any).__prepareGeometry = (geometry: THREE.BufferGeometry) => {
    ensureCurvatureAttribute(geometry);
  };

  const uniforms = {
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
  };

  (mat as any).__wornUniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    // Copy active uniforms into shader uniforms
    for (const [k, v] of Object.entries(uniforms)) {
      shader.uniforms[k] = v;
    }
    (mat as any).__shaderUniforms = shader.uniforms;

    // 1. Vertex Shader modifications
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `
      #include <common>
      attribute float curvature;
      varying float vWornCurvature;
      varying vec3 vWornWorldPos;
      `
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `
      #include <begin_vertex>
      vWornCurvature = curvature;
      vWornWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `
    );

    // 2. Fragment Shader modifications
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

      varying float vWornCurvature;
      varying vec3 vWornWorldPos;

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
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `
      #include <color_fragment>

      // Screen-space differential normal curvature fallback
      vec3 dPdx = dFdx(vViewPosition);
      vec3 dPdy = dFdy(vViewPosition);
      vec3 dNdx = dFdx(vNormal);
      vec3 dNdy = dFdy(vNormal);
      float screenCurv = (dot(dNdx, dPdx) / (dot(dPdx, dPdx) + 1e-4) + dot(dNdy, dPdy) / (dot(dPdy, dPdy) + 1e-4)) * 0.25;

      // Combined curvature (vertex curvature + screen derivative)
      float totalCurv = clamp(vWornCurvature + screenCurv, -1.0, 1.0);

      // Organic noise modulation
      float noiseVal = snoiseWorn(vWornWorldPos * uNoiseScale);
      float noiseMod = noiseVal * uNoise;

      // Convex Wear factor (ridges, corners, edges)
      float wearTarget = clamp((totalCurv * 0.5 + 0.5) + noiseMod, 0.0, 1.0);
      float wearCutoff = 1.0 - clamp(uWearAmount, 0.0, 0.99);
      float wearTransition = max(0.01, 0.5 / max(0.1, uContrast));
      float wearFactor = smoothstep(wearCutoff, min(1.0, wearCutoff + wearTransition), wearTarget);
      wearFactor *= step(0.001, uWearAmount);

      // Concave Dirt factor (crevices, cavities, grooves)
      float dirtTarget = clamp((0.5 - totalCurv * 0.5) + noiseMod, 0.0, 1.0);
      float dirtCutoff = 1.0 - clamp(uDirtAmount, 0.0, 0.99);
      float dirtTransition = max(0.01, 0.5 / max(0.1, uContrast));
      float dirtFactor = smoothstep(dirtCutoff, min(1.0, dirtCutoff + dirtTransition), dirtTarget);
      dirtFactor *= step(0.001, uDirtAmount);

      // Color blending
      vec3 blendedCol = uBaseColor;
      blendedCol = mix(blendedCol, uDirtColor, dirtFactor);
      blendedCol = mix(blendedCol, uWornColor, wearFactor);

      diffuseColor.rgb = blendedCol;
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `
      #include <roughnessmap_fragment>
      float blendedRoughness = uBaseRoughness;
      blendedRoughness = mix(blendedRoughness, uDirtRoughness, dirtFactor);
      blendedRoughness = mix(blendedRoughness, uWornRoughness, wearFactor);
      roughnessFactor = clamp(blendedRoughness, 0.0, 1.0);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <metalnessmap_fragment>",
      `
      #include <metalnessmap_fragment>
      float blendedMetalness = uBaseMetalness;
      blendedMetalness = mix(blendedMetalness, uDirtMetalness, dirtFactor);
      blendedMetalness = mix(blendedMetalness, uWornMetalness, wearFactor);
      metalnessFactor = clamp(blendedMetalness, 0.0, 1.0);
      `
    );
  };

  return mat;
}

const wornMaterialCache = createNodeCache<THREE.MeshStandardMaterial>((m) => m.dispose());

/**
 * Worn Material Node — blends three materials across a mesh's curvature:
 * - Convex ridges & protruding edges -> Worn material
 * - Concave crevices & inner folds -> Dirt material
 * - Flat surfaces & body -> Base material
 */
export const MATERIAL_WORN_NODE: NodeDefinition = {
  type: "material/worn",
  label: "Worn Material",
  category: "texture",
  inputs: [
    { id: "base", label: "Base Material", type: "material" },
    { id: "worn", label: "Worn Material (Convex)", type: "material" },
    { id: "dirt", label: "Dirt Material (Concave)", type: "material" },
    { id: "wearAmount", label: "Wear Amount", type: "value" },
    { id: "dirtAmount", label: "Dirt Amount", type: "value" },
    { id: "contrast", label: "Contrast", type: "value" },
    { id: "noise", label: "Noise Intensity", type: "value" },
    { id: "noiseScale", label: "Noise Scale", type: "value" },
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
  },
  paramFields: [
    { id: "wearAmount", label: "Wear Amount", kind: "number", step: 0.05, group: "Wear (Convex)" },
    { id: "wornColor", label: "Worn Color", kind: "color", group: "Wear (Convex)" },
    { id: "wornRoughness", label: "Worn Roughness", kind: "number", step: 0.05, group: "Wear (Convex)" },
    { id: "wornMetalness", label: "Worn Metalness", kind: "number", step: 0.05, group: "Wear (Convex)" },

    { id: "dirtAmount", label: "Dirt Amount", kind: "number", step: 0.05, group: "Dirt (Concave)" },
    { id: "dirtColor", label: "Dirt Color", kind: "color", group: "Dirt (Concave)" },
    { id: "dirtRoughness", label: "Dirt Roughness", kind: "number", step: 0.05, group: "Dirt (Concave)" },
    { id: "dirtMetalness", label: "Dirt Metalness", kind: "number", step: 0.05, group: "Dirt (Concave)" },

    { id: "baseColor", label: "Base Color", kind: "color", group: "Base (General)" },
    { id: "baseRoughness", label: "Base Roughness", kind: "number", step: 0.05, group: "Base (General)" },
    { id: "baseMetalness", label: "Base Metalness", kind: "number", step: 0.05, group: "Base (General)" },

    { id: "contrast", label: "Edge Sharpness", kind: "number", step: 0.1, group: "Tuning" },
    { id: "noise", label: "Organic Breakup", kind: "number", step: 0.05, group: "Tuning" },
    { id: "noiseScale", label: "Noise Scale", kind: "number", step: 0.5, group: "Tuning" },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = wornMaterialCache.get(ctx.nodeId);
    if (!mat) {
      mat = createWornMaterial();
      wornMaterialCache.set(ctx.nodeId, mat);
    }

    // Resolve base material properties
    const baseConn = materialParamsFromValue(inputs.base);
    const baseColor = baseConn ? baseConn.color : asColor(params.baseColor, new THREE.Color(0x3a4a58));
    const baseRoughness = baseConn ? baseConn.roughness : numberInput(undefined, params.baseRoughness, 0.6);
    const baseMetalness = baseConn ? baseConn.metalness : numberInput(undefined, params.baseMetalness, 0.1);

    // Resolve worn material properties
    const wornConn = materialParamsFromValue(inputs.worn);
    const wornColor = wornConn ? wornConn.color : asColor(params.wornColor, new THREE.Color(0xdcdcdc));
    const wornRoughness = wornConn ? wornConn.roughness : numberInput(undefined, params.wornRoughness, 0.25);
    const wornMetalness = wornConn ? wornConn.metalness : numberInput(undefined, params.wornMetalness, 0.9);

    // Resolve dirt material properties
    const dirtConn = materialParamsFromValue(inputs.dirt);
    const dirtColor = dirtConn ? dirtConn.color : asColor(params.dirtColor, new THREE.Color(0x1e1510));
    const dirtRoughness = dirtConn ? dirtConn.roughness : numberInput(undefined, params.dirtRoughness, 0.95);
    const dirtMetalness = dirtConn ? dirtConn.metalness : numberInput(undefined, params.dirtMetalness, 0.0);

    const wearAmount = Math.max(0, Math.min(1, numberInput(inputs.wearAmount, params.wearAmount, 0.4)));
    const dirtAmount = Math.max(0, Math.min(1, numberInput(inputs.dirtAmount, params.dirtAmount, 0.4)));
    const contrast = Math.max(0.1, Math.min(10, numberInput(inputs.contrast, params.contrast, 2.0)));
    const noise = Math.max(0, Math.min(1, numberInput(inputs.noise, params.noise, 0.35)));
    const noiseScale = Math.max(0.1, Math.min(50, numberInput(inputs.noiseScale, params.noiseScale, 6.0)));

    // Update uniforms
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

      u.uWearAmount.value = wearAmount;
      u.uDirtAmount.value = dirtAmount;
      u.uContrast.value = contrast;
      u.uNoise.value = noise;
      u.uNoiseScale.value = noiseScale;
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
