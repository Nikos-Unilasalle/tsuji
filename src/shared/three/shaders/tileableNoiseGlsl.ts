import { MAX_TILEABLE_OCTAVES, PERLIN_RANGE } from "../../math/tileableNoise";

/**
 * GPU twin of `math/tileableNoise.ts` — same PCG3D hash, same lattice wrap,
 * same channel recipes. Keep the two in step: the CPU copy is what the tests
 * check tiling against.
 *
 * Needs WebGL2 (uint arithmetic), which every three.js renderer here is.
 * Lattice coordinates must be non-negative: callers pass `uvw` already
 * wrapped into the unit tile, which also keeps the uint casts exact.
 *
 * Entry point: `vec4 tnPattern(vec3 uvw, vec3 freq, int pattern, bool channels,
 * int octaves, float gain, uint seed)` with `pattern` indexing
 * TILEABLE_PATTERNS.
 */
export const TILEABLE_NOISE_GLSL = /* glsl */ `
  uvec3 tnPcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }
  vec3 tnHash(uvec3 c, uint seed) {
    c.x += seed << 16u;
    return vec3(tnPcg3d(c) >> 8u) * (1.0 / 16777215.0);
  }
  float tnCorner(uvec3 c, vec3 f, uint seed) {
    return dot(tnHash(c, seed) * 2.0 - 1.0, f);
  }
  float tnPerlin(vec3 p, vec3 period, uint seed) {
    vec3 i0 = floor(p);
    vec3 f = p - i0;
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    uvec3 per = uvec3(period);
    uvec3 a = uvec3(i0) % per;
    uvec3 b = (a + 1u) % per;
    return mix(
      mix(
        mix(tnCorner(a, f, seed), tnCorner(uvec3(b.x, a.y, a.z), f - vec3(1.0, 0.0, 0.0), seed), u.x),
        mix(tnCorner(uvec3(a.x, b.y, a.z), f - vec3(0.0, 1.0, 0.0), seed), tnCorner(uvec3(b.x, b.y, a.z), f - vec3(1.0, 1.0, 0.0), seed), u.x),
        u.y),
      mix(
        mix(tnCorner(uvec3(a.x, a.y, b.z), f - vec3(0.0, 0.0, 1.0), seed), tnCorner(uvec3(b.x, a.y, b.z), f - vec3(1.0, 0.0, 1.0), seed), u.x),
        mix(tnCorner(uvec3(a.x, b.y, b.z), f - vec3(0.0, 1.0, 1.0), seed), tnCorner(b, f - vec3(1.0), seed), u.x),
        u.y),
      u.z);
  }
  float tnWorley(vec3 p, vec3 period, uint seed) {
    vec3 i0 = floor(p);
    vec3 f = p - i0;
    uvec3 per = uvec3(period);
    uvec3 base = uvec3(i0) + per - 1u;
    float d = 1.0;
    for (int k = 0; k < 3; k++) {
      for (int j = 0; j < 3; j++) {
        for (int i = 0; i < 3; i++) {
          uvec3 o = uvec3(i, j, k);
          vec3 r = vec3(o) - 1.0 + tnHash((base + o) % per, seed) - f;
          d = min(d, dot(r, r));
        }
      }
    }
    return 1.0 - d;
  }
  float tnWorleyAt(vec3 uvw, vec3 freq, uint seed) {
    return tnWorley(uvw * freq, freq, seed);
  }
  float tnPerlinFbm(vec3 uvw, vec3 freq, int octaves, float gain, uint seed) {
    float sum = 0.0, amp = 1.0, norm = 0.0;
    for (int i = 0; i < ${MAX_TILEABLE_OCTAVES}; i++) {
      if (i >= octaves) break;
      sum += tnPerlin(uvw * freq, freq, seed) * amp;
      norm += amp;
      amp *= gain;
      freq *= 2.0;
    }
    return clamp(sum / norm * ${PERLIN_RANGE.toFixed(4)} + 0.5, 0.0, 1.0);
  }
  float tnWorleyFbm(vec3 uvw, vec3 freq, int octaves, float gain, uint seed) {
    float sum = 0.0, amp = 1.0, norm = 0.0;
    for (int i = 0; i < ${MAX_TILEABLE_OCTAVES}; i++) {
      if (i >= octaves) break;
      sum += tnWorleyAt(uvw, freq, seed) * amp;
      norm += amp;
      amp *= gain;
      freq *= 2.0;
    }
    return clamp(sum / norm, 0.0, 1.0);
  }
  float tnPerlinWorley(vec3 uvw, vec3 freq, int octaves, float gain, uint seed) {
    float p = tnPerlinFbm(uvw, freq, octaves, gain, seed);
    float w = tnWorleyAt(uvw, freq, seed) * 0.625
            + tnWorleyAt(uvw, freq * 4.0, seed) * 0.25
            + tnWorleyAt(uvw, freq * 7.0, seed) * 0.125;
    return w + p * (1.0 - w);
  }
  vec4 tnCloudShape(vec3 uvw, vec3 base, uint seed) {
    float perlin = tnPerlinFbm(uvw, base * 2.0, 3, 0.5, seed);
    float w2 = tnWorleyAt(uvw, base * 2.0, seed);
    float w4 = tnWorleyAt(uvw, base * 4.0, seed);
    float w8 = tnWorleyAt(uvw, base * 8.0, seed);
    float w14 = tnWorleyAt(uvw, base * 14.0, seed);
    float w16 = tnWorleyAt(uvw, base * 16.0, seed);
    float pw = w2 * 0.625 + w8 * 0.25 + w14 * 0.125;
    return vec4(
      pw + perlin * (1.0 - pw),
      w2 * 0.625 + w4 * 0.25 + w8 * 0.125,
      w4 * 0.625 + w8 * 0.25 + w16 * 0.125,
      w8 * 0.75 + w16 * 0.25);
  }
  float tnPackCloudShape(vec4 c) {
    float low = c.g * 0.625 + c.b * 0.25 + c.a * 0.125;
    return clamp((c.r - (low - 1.0)) / (2.0 - low), 0.0, 1.0);
  }
  vec4 tnCloudDetail(vec3 uvw, vec3 base, uint seed) {
    float w1 = tnWorleyAt(uvw, base, seed);
    float w2 = tnWorleyAt(uvw, base * 2.0, seed);
    float w4 = tnWorleyAt(uvw, base * 4.0, seed);
    float w8 = tnWorleyAt(uvw, base * 8.0, seed);
    return vec4(w1 * 0.625 + w2 * 0.25 + w4 * 0.125, w2 * 0.625 + w4 * 0.25 + w8 * 0.125, w4 * 0.75 + w8 * 0.25, 1.0);
  }
  float tnPackCloudDetail(vec4 c) {
    return c.r * 0.625 + c.g * 0.25 + c.b * 0.125;
  }
  float tnSimple(int pattern, vec3 uvw, vec3 freq, int octaves, float gain, uint seed) {
    if (pattern == 1) return tnWorleyFbm(uvw, freq, octaves, gain, seed);
    if (pattern == 2) return tnPerlinWorley(uvw, freq, octaves, gain, seed);
    return tnPerlinFbm(uvw, freq, octaves, gain, seed);
  }
  vec4 tnPattern(vec3 uvw, vec3 freq, int pattern, bool channels, int octaves, float gain, uint seed) {
    uvw = fract(uvw);
    if (pattern == 3) {
      vec4 c = tnCloudShape(uvw, freq, seed);
      return channels ? c : vec4(vec3(tnPackCloudShape(c)), 1.0);
    }
    if (pattern == 4) {
      vec4 c = tnCloudDetail(uvw, freq, seed);
      return channels ? c : vec4(vec3(tnPackCloudDetail(c)), 1.0);
    }
    if (!channels) return vec4(vec3(tnSimple(pattern, uvw, freq, octaves, gain, seed)), 1.0);
    return vec4(
      tnSimple(pattern, uvw, freq, octaves, gain, seed),
      tnSimple(pattern, uvw, freq * 2.0, octaves, gain, seed),
      tnSimple(pattern, uvw, freq * 4.0, octaves, gain, seed),
      tnSimple(pattern, uvw, freq * 8.0, octaves, gain, seed));
  }
`;
