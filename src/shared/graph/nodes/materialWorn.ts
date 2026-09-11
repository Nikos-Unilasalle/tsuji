import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { asColor, materialParamsFromValue, numberInput } from "./object";

/**
 * Prepares a BufferGeometry with per-triangle barycentric coordinates and dihedral edge curvatures:
 * - `aBarycentric`: (1,0,0), (0,1,0), (0,0,1) for each triangle
 * - `aEdgeAltitudes`: perpendicular heights (h0, h1, h2) from vertices to edges in local units
 * - `aEdgeCurvatures`: signed dihedral curvature (k0, k1, k2):
 *     > 0 : convex ridge / outer corner (takes worn material)
 *     < 0 : concave crease / inner valley (takes dirt material)
 *     = 0 : flat / coplanar surface (takes base material)
 */
export function prepareWornGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geometry.getAttribute("aBarycentric") && geometry.getAttribute("aEdgeCurvatures")) {
    return geometry;
  }

  // Convert to non-indexed so each triangle has unique vertices for barycentric coordinates
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  nonIndexed.userData = { ...geometry.userData };

  const posAttr = nonIndexed.getAttribute("position");
  if (!posAttr || posAttr.count < 3) return geometry;

  const count = posAttr.count;
  const triCount = Math.floor(count / 3);

  const barycentrics = new Float32Array(count * 3);
  const altitudes = new Float32Array(count * 3);
  const edgeCurvatures = new Float32Array(count * 3);

  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const e0 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const cross = new THREE.Vector3();

  const triNormals: THREE.Vector3[] = new Array(triCount);
  const triAltitudes: [number, number, number][] = new Array(triCount);

  const hashV = (v: THREE.Vector3) =>
    `${Math.round(v.x * 10000)}_${Math.round(v.y * 10000)}_${Math.round(v.z * 10000)}`;
  const makeEdgeKey = (k1: string, k2: string) => (k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`);

  interface EdgeRef {
    triIdx: number;
    edgeIdx: number;
    oppPos: THREE.Vector3;
  }
  const edgeMap = new Map<string, EdgeRef[]>();

  for (let t = 0; t < triCount; t++) {
    p0.fromBufferAttribute(posAttr, t * 3);
    p1.fromBufferAttribute(posAttr, t * 3 + 1);
    p2.fromBufferAttribute(posAttr, t * 3 + 2);

    e0.subVectors(p1, p0);
    e1.subVectors(p2, p1);
    e2.subVectors(p0, p2);

    cross.crossVectors(e0, e2.clone().negate());
    const area = cross.length() * 0.5;
    const normal = area > 1e-8 ? cross.clone().normalize() : new THREE.Vector3(0, 1, 0);

    triNormals[t] = normal;

    const l0 = e0.length();
    const l1 = e1.length();
    const l2 = e2.length();

    // Altitudes: perpendicular distance to edge opposite to the vertex
    const h0 = l0 > 1e-6 ? (2 * area) / l0 : 0.001;
    const h1 = l1 > 1e-6 ? (2 * area) / l1 : 0.001;
    const h2 = l2 > 1e-6 ? (2 * area) / l2 : 0.001;
    triAltitudes[t] = [h0, h1, h2];

    const kP0 = hashV(p0);
    const kP1 = hashV(p1);
    const kP2 = hashV(p2);

    const key0 = makeEdgeKey(kP0, kP1);
    const key1 = makeEdgeKey(kP1, kP2);
    const key2 = makeEdgeKey(kP2, kP0);

    const addEdgeRef = (key: string, edgeIdx: number, oppPos: THREE.Vector3) => {
      let list = edgeMap.get(key);
      if (!list) {
        list = [];
        edgeMap.set(key, list);
      }
      list.push({ triIdx: t, edgeIdx, oppPos: oppPos.clone() });
    };

    addEdgeRef(key0, 0, p2);
    addEdgeRef(key1, 1, p0);
    addEdgeRef(key2, 2, p1);
  }

  const triEdgeCurv: [number, number, number][] = Array.from({ length: triCount }, () => [0, 0, 0]);

  for (let t = 0; t < triCount; t++) {
    p0.fromBufferAttribute(posAttr, t * 3);
    p1.fromBufferAttribute(posAttr, t * 3 + 1);
    p2.fromBufferAttribute(posAttr, t * 3 + 2);

    const kP0 = hashV(p0);
    const kP1 = hashV(p1);
    const kP2 = hashV(p2);

    const keys = [makeEdgeKey(kP0, kP1), makeEdgeKey(kP1, kP2), makeEdgeKey(kP2, kP0)];
    const edgeMidpoints = [
      new THREE.Vector3((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5, (p0.z + p1.z) * 0.5),
      new THREE.Vector3((p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5, (p1.z + p2.z) * 0.5),
      new THREE.Vector3((p2.x + p0.x) * 0.5, (p2.y + p0.y) * 0.5, (p2.z + p0.z) * 0.5),
    ];

    const n1 = triNormals[t];

    for (let e = 0; e < 3; e++) {
      const refs = edgeMap.get(keys[e]);
      if (!refs || refs.length <= 1) {
        // Open boundary edge: treated as convex edge
        triEdgeCurv[t][e] = 1.0;
        continue;
      }

      const neighbor = refs.find((r) => r.triIdx !== t);
      if (!neighbor) {
        triEdgeCurv[t][e] = 1.0;
        continue;
      }

      const n2 = triNormals[neighbor.triIdx];
      const dot = Math.max(-1, Math.min(1, n1.dot(n2)));

      // If normals are coplanar, curvature is strictly 0 (FLAT SURFACE)
      if (dot > 0.999) {
        triEdgeCurv[t][e] = 0.0;
        continue;
      }

      // Check whether neighbor bends away from normal (convex) or towards normal (concave)
      const mid = edgeMidpoints[e];
      const dirToOpp = neighbor.oppPos.clone().sub(mid);
      const proj = dirToOpp.dot(n1);

      const angleWeight = Math.max(0, 1.0 - dot);

      if (proj < -1e-5) {
        // Convex ridge/corner
        triEdgeCurv[t][e] = angleWeight;
      } else if (proj > 1e-5) {
        // Concave crease/valley
        triEdgeCurv[t][e] = -angleWeight;
      } else {
        triEdgeCurv[t][e] = 0.0;
      }
    }
  }

  for (let t = 0; t < triCount; t++) {
    const [h0, h1, h2] = triAltitudes[t];
    const [k0, k1, k2] = triEdgeCurv[t];

    const baseIdx = t * 3;

    // Vertex 0: barycentric (1, 0, 0)
    barycentrics[baseIdx * 3] = 1;
    barycentrics[baseIdx * 3 + 1] = 0;
    barycentrics[baseIdx * 3 + 2] = 0;

    altitudes[baseIdx * 3] = h0;
    altitudes[baseIdx * 3 + 1] = h1;
    altitudes[baseIdx * 3 + 2] = h2;

    edgeCurvatures[baseIdx * 3] = k0;
    edgeCurvatures[baseIdx * 3 + 1] = k1;
    edgeCurvatures[baseIdx * 3 + 2] = k2;

    // Vertex 1: barycentric (0, 1, 0)
    const idx1 = baseIdx + 1;
    barycentrics[idx1 * 3] = 0;
    barycentrics[idx1 * 3 + 1] = 1;
    barycentrics[idx1 * 3 + 2] = 0;

    altitudes[idx1 * 3] = h0;
    altitudes[idx1 * 3 + 1] = h1;
    altitudes[idx1 * 3 + 2] = h2;

    edgeCurvatures[idx1 * 3] = k0;
    edgeCurvatures[idx1 * 3 + 1] = k1;
    edgeCurvatures[idx1 * 3 + 2] = k2;

    // Vertex 2: barycentric (0, 0, 1)
    const idx2 = baseIdx + 2;
    barycentrics[idx2 * 3] = 0;
    barycentrics[idx2 * 3 + 1] = 0;
    barycentrics[idx2 * 3 + 2] = 1;

    altitudes[idx2 * 3] = h0;
    altitudes[idx2 * 3 + 1] = h1;
    altitudes[idx2 * 3 + 2] = h2;

    edgeCurvatures[idx2 * 3] = k0;
    edgeCurvatures[idx2 * 3 + 1] = k1;
    edgeCurvatures[idx2 * 3 + 2] = k2;
  }

  nonIndexed.setAttribute("aBarycentric", new THREE.Float32BufferAttribute(barycentrics, 3));
  nonIndexed.setAttribute("aEdgeAltitudes", new THREE.Float32BufferAttribute(altitudes, 3));
  nonIndexed.setAttribute("aEdgeCurvatures", new THREE.Float32BufferAttribute(edgeCurvatures, 3));

  return nonIndexed;
}

/**
 * Creates an edge-worn, crevice-dirt MeshStandardMaterial powered by PBR lighting,
 * geometry edge curvature, and procedural Simplex 3D noise.
 */
export function createWornMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.6,
    metalness: 0.1,
  });

  (mat as any).__isSharedCustom = true;
  (mat as any).__isWornMaterial = true;
  (mat as any).__prepareGeometry = (geometry: THREE.BufferGeometry) => {
    return prepareWornGeometry(geometry);
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
    for (const [k, v] of Object.entries(uniforms)) {
      shader.uniforms[k] = v;
    }
    (mat as any).__shaderUniforms = shader.uniforms;

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `
      #include <common>
      attribute vec3 aBarycentric;
      attribute vec3 aEdgeAltitudes;
      attribute vec3 aEdgeCurvatures;

      varying vec3 vWornBary;
      varying vec3 vWornAltitudes;
      varying vec3 vWornEdgeCurv;
      varying vec3 vWornWorldPos;
      `
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `
      #include <begin_vertex>
      vWornBary = aBarycentric;
      vWornAltitudes = aEdgeAltitudes;
      vWornEdgeCurv = aEdgeCurvatures;
      vWornWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
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

      varying vec3 vWornBary;
      varying vec3 vWornAltitudes;
      varying vec3 vWornEdgeCurv;
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

      // Distance from pixel to each of the 3 triangle edges in local units
      float d0 = vWornBary.z * vWornAltitudes.x;
      float d1 = vWornBary.x * vWornAltitudes.y;
      float d2 = vWornBary.y * vWornAltitudes.z;

      float k0 = vWornEdgeCurv.x;
      float k1 = vWornEdgeCurv.y;
      float k2 = vWornEdgeCurv.z;

      // 3D simplex noise for organic edge breakup
      float n = snoiseWorn(vWornWorldPos * uNoiseScale);
      float noiseMod = 1.0 + (n - 0.5) * uNoise * 1.5;

      // Effective radii: multiplied by noiseMod so edge breakup is organic
      // without ever generating wear or dirt on flat faces away from edges
      float wearRadius = max(0.0001, uWearAmount * 0.25) * max(0.05, noiseMod);
      float dirtRadius = max(0.0001, uDirtAmount * 0.25) * max(0.05, noiseMod);

      float wearFactor = 0.0;
      float dirtFactor = 0.0;

      // Convex Wear (k > 0): strictly applies to convex edges
      if (k0 > 0.05 && uWearAmount > 0.001) {
        wearFactor = max(wearFactor, smoothstep(wearRadius, 0.0, d0) * clamp(k0, 0.0, 1.0));
      }
      if (k1 > 0.05 && uWearAmount > 0.001) {
        wearFactor = max(wearFactor, smoothstep(wearRadius, 0.0, d1) * clamp(k1, 0.0, 1.0));
      }
      if (k2 > 0.05 && uWearAmount > 0.001) {
        wearFactor = max(wearFactor, smoothstep(wearRadius, 0.0, d2) * clamp(k2, 0.0, 1.0));
      }

      // Concave Dirt (k < 0): strictly applies to concave edges/creases
      if (k0 < -0.05 && uDirtAmount > 0.001) {
        dirtFactor = max(dirtFactor, smoothstep(dirtRadius, 0.0, d0) * clamp(-k0, 0.0, 1.0));
      }
      if (k1 < -0.05 && uDirtAmount > 0.001) {
        dirtFactor = max(dirtFactor, smoothstep(dirtRadius, 0.0, d1) * clamp(-k1, 0.0, 1.0));
      }
      if (k2 < -0.05 && uDirtAmount > 0.001) {
        dirtFactor = max(dirtFactor, smoothstep(dirtRadius, 0.0, d2) * clamp(-k2, 0.0, 1.0));
      }

      // Contrast shaping
      if (uContrast > 0.1 && uContrast != 1.0) {
        wearFactor = pow(wearFactor, 1.0 / max(0.1, uContrast));
        dirtFactor = pow(dirtFactor, 1.0 / max(0.1, uContrast));
      }

      // Base color blending: on flat surfaces, wearFactor == 0 and dirtFactor == 0 -> 100% uBaseColor!
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
