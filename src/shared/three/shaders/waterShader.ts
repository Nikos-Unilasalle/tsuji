import * as THREE from "three";

// Port of the water surface from brunosimon/folio-2025 (sources/Game/World/WaterSurface.js).
// That project renders with WebGPU/TSL and gets the blue out of the terrain's own gradient,
// leaving the surface pure white with the details mask as alpha. This is WebGL/GLSL, so the
// terrain gradient (Terrain.js setGradient) is rebuilt here and mixed under the same mask.
const WATER_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const WATER_FRAGMENT_SHADER = /* glsl */ `
  uniform float time;

  uniform sampler2D shoreMap;
  uniform float hasShoreMap;
  uniform vec2 shoreMapResolution;
  uniform vec2 terrainSize;
  uniform vec3 terrainCenter;
  uniform float surfaceElevation;
  uniform float depthElevation;

  uniform float shoreFoamWidth;
  uniform float shoreFoamWobble;

  uniform float ripplesRatio;
  uniform float ripplesCount;
  uniform float ripplesReach;
  uniform float ripplesNoiseFrequency;
  uniform float ripplesNoiseOffset;
  uniform float ripplesShoreRange;
  uniform float ripplesSpeed;
  uniform float ripplesFalloff;
  uniform float ripplesSegmentFrequency;
  uniform float ripplesSegmentGap;

  uniform float iceRatio;
  uniform float iceNoiseFrequency;

  uniform float splashesRatio;
  uniform float splashesNoiseFrequency;
  uniform float splashesTimeFrequency;
  uniform float splashesThickness;
  uniform float splashesEdgeAttenuationLow;
  uniform float splashesEdgeAttenuationHigh;

  uniform vec3 sandColor;
  uniform vec3 shallowColor;
  uniform vec3 deepColor;
  uniform float sandStop;
  uniform float shallowStop;
  uniform float deepStop;
  uniform vec3 detailsColor;
  uniform float waterTint;
  uniform float edgeFade;
  uniform vec2 detailsShadowOffset;
  uniform float detailsShadowStrength;
  uniform vec3 detailsShadowColor;

  varying vec3 vWorldPosition;

  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  // Stand-in for the perlin noise texture the original samples. Signed and centred on zero: it
  // offsets the ripple bands rather than widening them, which is what keeps the arcs thin.
  float perlin(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = dot(hash22(i) * 2.0 - 1.0, f);
    float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
    float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
    float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // Stand-in for the voronoi noise texture: r = distance to cell, g = edge, b = cell id.
  vec3 voronoi(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);

    float first = 8.0;
    float second = 8.0;
    vec2 cell = i;

    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbour = vec2(float(x), float(y));
        vec2 point = neighbour + hash22(i + neighbour) - f;
        float distance = length(point);

        if (distance < first) {
          second = first;
          first = distance;
          cell = i + neighbour;
        } else if (distance < second) {
          second = distance;
        }
      }
    }

    return vec3(clamp(first, 0.0, 1.0), clamp(second - first, 0.0, 1.0), hash11(dot(cell, vec2(1.0, 57.0))));
  }

  float remapClamp(float value, float low, float high, float toLow, float toHigh) {
    float t = clamp((value - low) / (high - low), 0.0, 1.0);
    return toLow + t * (toHigh - toLow);
  }

  // Bilinear by hand: the terrain heightmap comes in with nearest filtering, which would
  // staircase the shore line.
  float sampleShoreHeight(vec2 uv) {
    vec2 texel = 1.0 / shoreMapResolution;
    // One texel per terrain vertex, so uv 0 and 1 land on the first and last texel centre —
    // not on the texture's outer edges.
    vec2 coord = uv * (shoreMapResolution - 1.0);
    vec2 base = floor(coord);
    vec2 f = fract(coord);

    float h00 = texture2D(shoreMap, (base + vec2(0.5, 0.5)) * texel).r;
    float h10 = texture2D(shoreMap, (base + vec2(1.5, 0.5)) * texel).r;
    float h01 = texture2D(shoreMap, (base + vec2(0.5, 1.5)) * texel).r;
    float h11 = texture2D(shoreMap, (base + vec2(1.5, 1.5)) * texel).r;

    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }

  vec2 shoreUv(vec2 p) {
    return clamp((p - terrainCenter.xz) / terrainSize + 0.5, 0.0, 1.0);
  }

  // The original's terrainData.b, renormalized: 0 in deep water, 1 at (and above) the water line.
  float shoreFactor(vec2 uv) {
    if (hasShoreMap < 0.5) return 0.0;

    return remapClamp(sampleShoreHeight(uv), depthElevation, surfaceElevation, 0.0, 1.0);
  }

  float waterDepth(float shore) {
    return (1.0 - shore) * (surfaceElevation - depthElevation);
  }

  // Horizontal distance from the waterline, in world units: the depth divided by the terrain's
  // slope. Everything about the shoreline is measured with this rather than with depth, which is
  // what the original uses. Depth alone works on its fairly even coastline; on a hand-sculpted
  // terrain a flat shallow shelf stretches any depth threshold into a white continent.
  float shoreDistance(vec2 uv, float shore) {
    vec2 uvStep = 1.0 / max(shoreMapResolution - 1.0, vec2(1.0));
    vec2 worldStep = terrainSize * uvStep;

    float hx = sampleShoreHeight(uv + vec2(uvStep.x, 0.0)) - sampleShoreHeight(uv - vec2(uvStep.x, 0.0));
    float hz = sampleShoreHeight(uv + vec2(0.0, uvStep.y)) - sampleShoreHeight(uv - vec2(0.0, uvStep.y));
    float slope = length(vec2(hx / (2.0 * worldStep.x), hz / (2.0 * worldStep.y)));

    return waterDepth(shore) / max(slope, 0.001);
  }

  float shoreFoam(vec2 p, float distance) {
    if (hasShoreMap < 0.5 || shoreFoamWidth <= 0.0) return 0.0;

    float width = shoreFoamWidth * (1.0 + shoreFoamWobble * perlin(p * 0.7 + time * 0.06));

    return step(distance, width);
  }

  float ripplesNode(vec2 p, float distance) {
    // 1 at the waterline, 0 once ripplesReach metres out: a fixed band of shallows carrying a
    // fixed number of ripples, however gentle or steep the beach is.
    float near = 1.0 - clamp(distance / max(ripplesReach, 0.001), 0.0, 1.0);

    // Bruno's structure, driven by that instead of by his baked depth channel. His water only
    // occupies the bottom fifth of the terrain's height range and his slope fade leans on that,
    // so ripplesShoreRange keeps the falloff in the band it was tuned for.
    float shore = near * ripplesShoreRange;
    float phase = (near + time * ripplesSpeed) * ripplesCount;
    float index = floor(phase);

    float noise = perlin((p + index / ripplesNoiseOffset) * ripplesNoiseFrequency);

    // ripplesFalloff sets how much of each cycle turns white: the knob for thin lines (higher)
    // versus broad bands (lower).
    float ripples = mod(phase, 1.0) - ripplesFalloff * (1.0 - shore) + noise;
    float band = step(mix(-1.0, -0.4, ripplesRatio), ripples);

    // A shoreline contour is a closed loop, and the original's noise texture is fine enough
    // relative to its 192-unit world to chop it into strokes. Mine is not at this scale, so the
    // loop is cut by its own mask: same shape, broken into segments, each band index offset so
    // neighbouring bands break in different places and read as little groups.
    float gaps = perlin((p + index * 7.3) * ripplesSegmentFrequency) * 0.5 + 0.5;

    return band * step(ripplesSegmentGap, gaps);
  }

  float iceNode(vec2 p, float shore) {
    float pattern = voronoi(p * iceNoiseFrequency).g;
    float ice = remapClamp(shore, 0.0, max(iceRatio, 0.0001), 0.0, 1.0);

    return step(pattern, ice);
  }

  float splashesNode(vec2 p) {
    vec3 cells = voronoi(p * splashesNoiseFrequency);
    float lowFrequency = perlin(p * splashesNoiseFrequency * 0.25);

    float splashTime = time * splashesTimeFrequency + hash11(cells.b * 123456.0) + lowFrequency;
    float splash = mod(cells.r - splashTime, 1.0);

    float edgeMultiplier = remapClamp(cells.g, splashesEdgeAttenuationLow, splashesEdgeAttenuationHigh, 0.0, 1.0);
    splash = 1.0 - step(splashesThickness * edgeMultiplier, splash);

    float visible = mod(hash11(cells.b * 654321.0) + lowFrequency, 1.0);

    return splash * step(visible, splashesRatio);
  }

  // Sampled at a world position rather than at this fragment, so the same mask can be read back
  // at an offset to place the segments' drop shadows.
  float detailsMask(vec2 p) {
    vec2 uv = shoreUv(p);
    float shore = shoreFactor(uv);

    float distance = hasShoreMap < 0.5 ? 1e6 : shoreDistance(uv, shore);
    float mask = shoreFoam(p, distance);

    if (ripplesRatio > 0.0001 && hasShoreMap > 0.5) mask = max(mask, ripplesNode(p, distance));
    if (iceRatio > 0.0001) mask = max(mask, iceNode(p, shore));
    if (splashesRatio > 0.0001) mask = max(mask, splashesNode(p));

    return mask;
  }

  vec3 depthGradient(float t) {
    if (t <= sandStop) return sandColor;
    if (t <= shallowStop) return mix(sandColor, shallowColor, (t - sandStop) / max(1e-4, shallowStop - sandStop));
    if (t <= deepStop) return mix(shallowColor, deepColor, (t - shallowStop) / max(1e-4, deepStop - shallowStop));
    return deepColor;
  }

  void main() {
    vec2 p = vWorldPosition.xz;
    float shore = shoreFactor(shoreUv(p));

    float details = detailsMask(p);

    // Each foam segment drops a shadow onto the water. The original gets these from the shadow
    // map (its surface casts through the same mask); here the mask is simply read back offset,
    // which costs one extra evaluation instead of a shadow pass.
    float shadow = 0.0;
    if (detailsShadowStrength > 0.0001) {
      shadow = detailsMask(p - detailsShadowOffset) * (1.0 - details) * detailsShadowStrength;
    }

    // The reference render has no cut at the waterline: the water thins out into the sand. The
    // body fades over the first few centimetres of depth, so the terrain's own colour carries
    // the shallows and the surface only takes over once there is water to see.
    float bodyAlpha = waterTint * smoothstep(0.0, max(edgeFade, 0.0001), waterDepth(shore));

    vec3 body = depthGradient(1.0 - shore);
    vec3 finalColor = mix(body, detailsColor, details);
    finalColor = mix(finalColor, finalColor * detailsShadowColor, shadow);

    float finalAlpha = max(max(details, shadow), bodyAlpha);

    if (finalAlpha < 0.001) discard;

    gl_FragColor = vec4(finalColor, finalAlpha);
    #include <colorspace_fragment>
  }
`;

export function createStylizedWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 },

      shoreMap: { value: null },
      hasShoreMap: { value: 0 },
      shoreMapResolution: { value: new THREE.Vector2(128, 128) },
      terrainSize: { value: new THREE.Vector2(40, 40) },
      terrainCenter: { value: new THREE.Vector3(0, 0, 0) },
      surfaceElevation: { value: 0 },
      depthElevation: { value: -1.2 },

      shoreFoamWidth: { value: 0 },
      shoreFoamWobble: { value: 0.35 },

      ripplesRatio: { value: 1 },
      ripplesCount: { value: 3 },
      ripplesReach: { value: 2.0 },
      ripplesNoiseFrequency: { value: 0.1 },
      ripplesNoiseOffset: { value: 0.345 },
      ripplesShoreRange: { value: 0.2 },
      ripplesSpeed: { value: 0.12 },
      ripplesFalloff: { value: 1.5 },
      ripplesSegmentFrequency: { value: 1.1 },
      ripplesSegmentGap: { value: 0.5 },

      iceRatio: { value: 0 },
      iceNoiseFrequency: { value: 0.3 },

      splashesRatio: { value: 0 },
      splashesNoiseFrequency: { value: 0.33 },
      splashesTimeFrequency: { value: 6 },
      splashesThickness: { value: 0.3 },
      splashesEdgeAttenuationLow: { value: 0.14 },
      splashesEdgeAttenuationHigh: { value: 1 },

      sandColor: { value: new THREE.Color(0xffa94e) },
      shallowColor: { value: new THREE.Color(0x5bc2b9) },
      deepColor: { value: new THREE.Color(0x13375f) },
      sandStop: { value: 0.1 },
      shallowStop: { value: 0.3 },
      deepStop: { value: 0.9 },
      detailsColor: { value: new THREE.Color(0xffffff) },
      waterTint: { value: 1 },
      edgeFade: { value: 0.35 },
      detailsShadowOffset: { value: new THREE.Vector2(0.07, 0.07) },
      detailsShadowStrength: { value: 0.55 },
      detailsShadowColor: { value: new THREE.Color(0.55, 0.62, 0.72) },
    },
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
  });
}
