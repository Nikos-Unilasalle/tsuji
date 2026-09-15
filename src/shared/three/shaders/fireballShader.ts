import * as THREE from "three";

// Port of the explosion fireball from brunosimon/folio-2025
// (sources/Game/World/Fireballs.js). That one is WebGPU/TSL and samples a baked perlin texture
// triplanarly; this is WebGL/GLSL with the noise generated in the shader, so `noiseScale` stands
// in for how much of his texture the sphere's ±0.5 local range covered.
const FIREBALL_VERTEX_SHADER = /* glsl */ `
  varying vec3 vLocalPosition;
  varying vec3 vLocalNormal;
  varying vec3 vWorldPosition;

  void main() {
    vLocalPosition = position;
    vLocalNormal = normal;

    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FIREBALL_FRAGMENT_SHADER = /* glsl */ `
  uniform float progress;
  uniform float noiseScale;
  uniform float noiseLow;
  uniform float noiseHigh;
  uniform float floorLevel;
  uniform float floorFade;
  uniform vec3 emissiveColorA;
  uniform vec3 emissiveColorB;
  uniform float emissiveStrength;
  uniform vec3 gooColor;
  uniform float gooEdge;
  uniform float glowGain;
  uniform float glowThreshold;

  varying vec3 vLocalPosition;
  varying vec3 vLocalNormal;
  varying vec3 vWorldPosition;

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  float perlin01(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = dot(hash22(i) * 2.0 - 1.0, f);
    float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
    float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
    float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) + 0.5;
  }

  // The original multiplies its emissive well past 1 and leans on the renderer's tone mapping to
  // turn that into a hot core with an orange falloff. This viewport does not tone map, so the
  // curve is applied here instead — otherwise every value above 1 clips to the same flat orange.
  vec3 tonemap(vec3 c) {
    return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
  }

  void main() {
    // Triplanar, on the geometry's own position and normal, so the pattern is fixed to the
    // sphere and the whole thing can spin without the fire crawling over it.
    vec3 p = vLocalPosition * noiseScale;
    float noiseX = perlin01(p.yz);
    float noiseY = perlin01(p.xz + 31.7);
    float noiseZ = perlin01(p.xy + 63.4);

    vec3 blending = abs(vLocalNormal);
    blending /= max(blending.x + blending.y + blending.z, 0.0001);

    float noise = noiseX * blending.x + noiseY * blending.y + noiseZ * blending.z;
    noise = clamp((noise - noiseLow) / max(noiseHigh - noiseLow, 0.0001), 0.0, 1.0);

    // Flattens the fireball against the ground instead of letting it hang below.
    noise *= clamp((vWorldPosition.y - floorLevel) * floorFade, 0.0, 1.0);

    // The burn: chunks drop out of the sphere as progress rises, until nothing is left.
    noise -= progress;

    if (noise < 0.0) discard;

    vec3 emissive = tonemap(mix(emissiveColorA, emissiveColorB, noise) * emissiveStrength);

    // The curve above keeps the red-to-orange gradient readable, but it also caps the fire at 1,
    // which is exactly the bloom threshold's blind spot. The hottest part is pushed back over 1
    // so it lands in the composer's half-float buffer as genuine overbright and Bloom can catch
    // it — the original gets this for free from its renderer's tone mapping.
    emissive *= 1.0 + glowGain * smoothstep(glowThreshold, 1.0, noise);

    vec3 finalColor = mix(emissive, gooColor, step(noise, gooEdge));

    gl_FragColor = vec4(finalColor, 1.0);
    #include <colorspace_fragment>
  }
`;

export function createFireballMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      progress: { value: 0.15 },
      noiseScale: { value: 6 },
      noiseLow: { value: 0.15 },
      noiseHigh: { value: 0.9 },
      floorLevel: { value: 0 },
      floorFade: { value: 2 },
      emissiveColorA: { value: new THREE.Color(0xff0000) },
      emissiveColorB: { value: new THREE.Color(0xffa500) },
      emissiveStrength: { value: 2.5 },
      gooColor: { value: new THREE.Color(0x000000) },
      gooEdge: { value: 0.1 },
      glowGain: { value: 2.5 },
      glowThreshold: { value: 0.25 },
    },
    vertexShader: FIREBALL_VERTEX_SHADER,
    fragmentShader: FIREBALL_FRAGMENT_SHADER,
  });
}

export function createFireballGeometry(): THREE.SphereGeometry {
  return new THREE.SphereGeometry(0.5, 12, 6);
}
