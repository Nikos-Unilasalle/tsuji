/**
 * Raymarched cloud box — the shading half of the Frostbite / GPU Pro 7 cloud
 * model the tileable volumes were built for.
 *
 * Density: the packed base-shape volume, shaped by a height profile, cut by
 * Coverage (low coverage keeps only the densest cores), then eroded at its
 * edges by the detail volume — wispy at the base, billowy at the top.
 *
 * Lighting: Beer-Lambert toward the sun through a few cheap samples (base
 * shape only), a three-octave multiple-scattering approximation (Wrenninge
 * 2013) over a dual-lobe Henyey-Greenstein phase, a powder term, and a
 * height-graded sky/ground ambient. Scattering is integrated per step with
 * Hillaire's energy-conserving formula, so changing Steps changes noise, not
 * brightness.
 *
 * Output is premultiplied (color, 1 - transmittance) and blended One /
 * OneMinusSrcAlpha. Back faces are drawn so the camera can fly inside.
 */

export const VOLUME_CLOUDS_VERTEX = /* glsl */ `
  uniform mat4 uInvModel;
  varying vec3 vLocalPos;
  varying vec3 vLocalCam;
  void main() {
    vLocalPos = position;
    vLocalCam = (uInvModel * vec4(cameraPosition, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const MAX_CLOUD_STEPS = 256;
export const MAX_CLOUD_LIGHT_STEPS = 16;

export const VOLUME_CLOUDS_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uShape;
  uniform sampler3D uDetail;
  uniform vec3 uHalfSize;
  uniform vec3 uShapeOffset;
  uniform vec3 uDetailOffset;
  uniform float uShapeScale;
  uniform float uDetailScale;
  uniform vec2 uShapeLevels;
  uniform vec4 uProfile;
  uniform float uCoverage;
  uniform float uDensity;
  uniform float uErosion;
  uniform float uEdgeFade;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform float uAnisotropy;
  uniform float uPowder;
  uniform int uSteps;
  uniform int uLightSteps;

  varying vec3 vLocalPos;
  varying vec3 vLocalCam;

  vec2 boxHit(vec3 ro, vec3 rd) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (-uHalfSize - ro) * inv;
    vec3 t1 = (uHalfSize - ro) * inv;
    vec3 lo = min(t0, t1);
    vec3 hi = max(t0, t1);
    return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
  }

  float remap(float v, float a, float b, float c, float d) {
    return c + (v - a) / max(b - a, 1e-5) * (d - c);
  }

  float heightFraction(vec3 p) {
    return clamp(p.y / (2.0 * uHalfSize.y) + 0.5, 0.0, 1.0);
  }

  // Base shape with coverage, no detail: what the light march and the empty-space test read.
  float baseDensity(vec3 p, float h) {
    float profile = smoothstep(uProfile.x, uProfile.y, h) * (1.0 - smoothstep(uProfile.z, uProfile.w, h));
    vec2 edge = (uHalfSize.xz - abs(p.xz)) / max(uEdgeFade * uHalfSize.xz, vec2(1e-3));
    float cov = uCoverage * clamp(min(edge.x, edge.y), 0.0, 1.0);
    float shape = texture(uShape, (p + uShapeOffset) / uShapeScale).r;
    shape = clamp(remap(shape, uShapeLevels.x, uShapeLevels.y, 0.0, 1.0), 0.0, 1.0) * profile;
    return clamp(remap(shape, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
  }

  float erode(float base, vec3 p, float h) {
    float detail = texture(uDetail, (p + uDetailOffset) / uDetailScale).r;
    detail = mix(detail, 1.0 - detail, clamp(h * 4.0, 0.0, 1.0));
    return clamp(remap(base, detail * uErosion * 0.35, 1.0, 0.0, 1.0), 0.0, 1.0);
  }

  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  }

  float phase(float c, float g) {
    return mix(hg(c, g), hg(c, -0.3 * g), 0.25);
  }

  float sunOpticalDepth(vec3 p) {
    float exitT = boxHit(p, uSunDir).y;
    float dt = max(exitT, 0.0) / float(uLightSteps);
    float od = 0.0;
    for (int i = 0; i < ${MAX_CLOUD_LIGHT_STEPS}; i++) {
      if (i >= uLightSteps) break;
      vec3 q = p + uSunDir * dt * (float(i) + 0.5);
      od += baseDensity(q, heightFraction(q));
    }
    return od * dt * uDensity;
  }

  void main() {
    vec3 ro = vLocalCam;
    vec3 rd = normalize(vLocalPos - vLocalCam);
    vec2 t = boxHit(ro, rd);
    t.x = max(t.x, 0.0);
    if (t.y <= t.x) discard;

    float dt = (t.y - t.x) / float(uSteps);
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float cosTheta = dot(rd, uSunDir);
    vec3 phases = vec3(phase(cosTheta, uAnisotropy), phase(cosTheta, uAnisotropy * 0.5), phase(cosTheta, uAnisotropy * 0.25));

    vec3 color = vec3(0.0);
    float T = 1.0;
    for (int i = 0; i < ${MAX_CLOUD_STEPS}; i++) {
      if (i >= uSteps) break;
      vec3 p = ro + rd * (t.x + dt * (float(i) + jitter));
      float h = heightFraction(p);
      float base = baseDensity(p, h);
      if (base <= 0.0) continue;
      float d = erode(base, p, h);
      if (d <= 0.0) continue;
      float sigma = d * uDensity;
      float od = sunOpticalDepth(p);
      vec3 sun = uSunColor * (exp(-od) * phases.x + 0.5 * exp(-od * 0.5) * phases.y + 0.25 * exp(-od * 0.25) * phases.z);
      sun *= mix(1.0, 1.0 - exp(-2.0 * sigma), uPowder);
      vec3 S = (sun + mix(uGroundColor, uSkyColor, h)) * sigma;
      float Tr = exp(-sigma * dt);
      color += T * (S - S * Tr) / sigma;
      T *= Tr;
      if (T < 0.01) { T = 0.0; break; }
    }
    if (T >= 0.999) discard;
    gl_FragColor = vec4(color, 1.0 - T);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
