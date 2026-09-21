import * as THREE from "three";

const COMMON_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec2 vUv;
  varying vec4 vScreenPos;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vec4 mvPosition = viewMatrix * worldPos;
    vViewDir = -mvPosition.xyz;
    vScreenPos = projectionMatrix * mvPosition;
    gl_Position = vScreenPos;
  }
`;

const HASH_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
`;

const COMPOSITE_FRAGMENT_SHADER = /* glsl */ `
  // Base inputs
  uniform vec3 baseColor;
  uniform float baseOpacity;
  uniform sampler2D baseMap;
  uniform float hasMap;
  uniform vec3 lightDirection;
  uniform vec2 resolution;
  uniform float time;

  // 1. Duotone
  uniform float enableDuotone;
  uniform vec3 shadowColor;
  uniform vec3 highlightColor;
  uniform float balance;
  uniform float softness;
  uniform float amount;

  // 2. Halftone
  uniform float enableHalftone;
  uniform float shape;
  uniform float radius;
  uniform float screenAngle;
  uniform float scatter;
  uniform float halftoneAmount;
  uniform float greyscale;
  uniform float space;

  // 3. Film Texture
  uniform float enableFilmTexture;
  uniform float grain;
  uniform float dust;
  uniform float scratches;
  uniform float blotches;
  uniform float filmRate;
  uniform float filmSeed;

  // 4. Dry Brush
  uniform float enableDryBrush;
  uniform float coverage;
  uniform float dryBrushScale;
  uniform float dryBrushSoftness;
  uniform float stretch;
  uniform float dryBrushAngle;
  uniform float followInk;
  uniform vec3 paperColor;
  uniform float dryBrushAnimate;
  uniform float dryBrushRate;
  uniform float dryBrushSeed;

  // 5. Super 8
  uniform float enableSuper8;
  uniform float flicker;
  uniform float warmth;
  uniform float super8Softness;
  uniform float weave;
  uniform float super8Rate;
  uniform float super8Seed;

  // 6. Outline
  uniform float enableOutline;
  uniform vec3 edgeColor;
  uniform float edgeThickness;
  uniform float edgeStrength;
  uniform float alphaThreshold;
  uniform float sharpness;
  uniform float outlineSide;
  uniform float outlineSilhouette;
  uniform float outlineAlpha;

  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec2 vUv;
  varying vec4 vScreenPos;

  ${HASH_GLSL}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    vec3 L = normalize(lightDirection);
    float NdotL = max(0.0, dot(N, L));

    // 1. Optional Super 8 gate weave jitter on UV
    vec2 sampleUv = vUv;
    if (enableSuper8 > 0.5) {
      float s8Frame = floor(time * max(super8Rate, 0.001)) + super8Seed;
      vec2 jitter = (vec2(hash21(vec2(s8Frame, 1.0)), hash21(vec2(s8Frame, 2.0))) - 0.5) * weave * 0.015;
      sampleUv += jitter;
    }

    // 2. Base texture & opacity
    vec3 srcColor = baseColor;
    float alpha = baseOpacity;
    float mapAlpha = 1.0;
    if (hasMap > 0.5) {
      vec4 tex = texture2D(baseMap, sampleUv);
      srcColor *= tex.rgb;
      mapAlpha = tex.a;
      alpha *= tex.a;
    }

    float thresh = max(0.01, alphaThreshold);
    bool isTransparentPixel = (hasMap > 0.5) && (mapAlpha < thresh);

    // If this pixel is transparent, check if it lies in the EXTERNAL outline zone
    if (isTransparentPixel) {
      if (enableOutline > 0.5 && outlineAlpha > 0.5 && (outlineSide < 0.5 || outlineSide > 1.5)) {
        vec2 dUv = fwidth(sampleUv) * max(0.5, edgeThickness);
        if (length(dUv) < 1e-6) {
          dUv = vec2(edgeThickness / max(resolution.x, 1.0), edgeThickness / max(resolution.y, 1.0));
        }

        // 16 sampling taps across 3 concentric rings (0.35, 0.70, 1.00)
        float sumAlpha = 0.0;

        sumAlpha += texture2D(baseMap, sampleUv + vec2( dUv.x * 0.35, 0.0)).a * 1.2;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(-dUv.x * 0.35, 0.0)).a * 1.2;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(0.0,  dUv.y * 0.35)).a * 1.2;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(0.0, -dUv.y * 0.35)).a * 1.2;

        sumAlpha += texture2D(baseMap, sampleUv + vec2( dUv.x,  dUv.y) * 0.495).a;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(-dUv.x,  dUv.y) * 0.495).a;
        sumAlpha += texture2D(baseMap, sampleUv + vec2( dUv.x, -dUv.y) * 0.495).a;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(-dUv.x, -dUv.y) * 0.495).a;

        sumAlpha += texture2D(baseMap, sampleUv + vec2( dUv.x, 0.0)).a * 0.8;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(-dUv.x, 0.0)).a * 0.8;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(0.0,  dUv.y)).a * 0.8;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(0.0, -dUv.y)).a * 0.8;
        sumAlpha += texture2D(baseMap, sampleUv + vec2( dUv.x * 0.924,  dUv.y * 0.383)).a * 0.8;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(-dUv.x * 0.924,  dUv.y * 0.383)).a * 0.8;
        sumAlpha += texture2D(baseMap, sampleUv + vec2( dUv.x * 0.383, -dUv.y * 0.924)).a * 0.8;
        sumAlpha += texture2D(baseMap, sampleUv + vec2(-dUv.x * 0.383, -dUv.y * 0.924)).a * 0.8;

        float edgeProximity = clamp(sumAlpha / 7.0, 0.0, 1.0);
        if (edgeProximity > 0.001) {
          float edgeFactor = smoothstep(0.0, max(0.02, 1.0 - sharpness * 0.98), edgeProximity);
          float outAlpha = clamp(edgeFactor * edgeStrength * baseOpacity, 0.0, 1.0);
          if (outAlpha < 0.005) discard;
          gl_FragColor = vec4(edgeColor, outAlpha);
          return;
        }
      }
      discard;
    }

    if (alpha < 0.005) discard;

    // Base directional light
    float lighting = 0.25 + 0.75 * NdotL;
    vec3 color = srcColor * lighting;

    // 3. DUAL TONE STAGE
    if (enableDuotone > 0.5) {
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float half_ = max(softness, 0.001) * 0.5;
      float t = smoothstep(balance - half_, balance + half_, lum);
      vec3 graded = mix(shadowColor, highlightColor, t);
      color = mix(color, graded, amount);
    }

    // 4. HALFTONE STAGE
    if (enableHalftone > 0.5) {
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      vec2 coord;
      if (space > 0.5) {
        coord = sampleUv * max(10.0, radius * 12.0);
      } else {
        vec2 screenUV = (vScreenPos.xy / max(vScreenPos.w, 0.0001)) * 0.5 + 0.5;
        coord = screenUV * resolution;
      }

      float c = cos(screenAngle);
      float s = sin(screenAngle);
      coord = mat2(c, -s, s, c) * coord;

      float r = max(1.0, radius);
      vec2 cell = floor(coord / r);
      vec2 grid = fract(coord / r) - 0.5;

      if (scatter > 0.0) {
        grid += (vec2(hash21(cell), hash21(cell + 4.3)) - 0.5) * scatter * 0.5;
      }

      float d = 0.0;
      if (shape < 0.5) {
        d = length(grid);
      } else if (shape < 1.5) {
        d = length(grid * vec2(1.0, 2.0));
      } else if (shape < 2.5) {
        d = abs(grid.y) * 1.5;
      } else {
        d = max(abs(grid.x), abs(grid.y));
      }

      float dotSize = (1.0 - lum) * 0.65;
      float raster = smoothstep(dotSize - 0.06, dotSize + 0.06, d);
      vec3 col = greyscale > 0.5 ? vec3(lum) : color;
      vec3 shaded = mix(col * 0.12, col, raster);
      color = mix(color, shaded, halftoneAmount);
    }

    // 5. DRY BRUSH STAGE
    if (enableDryBrush > 0.5) {
      float frame = dryBrushAnimate > 0.5 ? floor(time * max(dryBrushRate, 0.001)) : 0.0;
      float jump = frame * 37.0 + dryBrushSeed * 91.0;
      vec2 p = sampleUv * dryBrushScale;
      float c = cos(dryBrushAngle);
      float s = sin(dryBrushAngle);
      p = mat2(c, -s, s, c) * p;
      p.x /= max(stretch, 0.001);
      float n = valueNoise(p + jump) * 0.65 + valueNoise(p * 2.7 + jump * 1.7) * 0.35;
      float edge = mix(0.86, 0.52, clamp(coverage, 0.0, 1.0));
      float soft = max(dryBrushSoftness, 0.001) * 0.2;
      float mask = smoothstep(edge - soft, edge + soft, n);
      if (followInk > 0.5) {
        float ink = 1.0 - dot(color, vec3(0.2126, 0.7152, 0.0722));
        mask *= smoothstep(0.05, 0.45, ink);
      }
      color = mix(color, paperColor, clamp(mask, 0.0, 1.0));
    }

    // 6. FILM TEXTURE STAGE
    if (enableFilmTexture > 0.5) {
      float frame = floor(time * max(filmRate, 0.001)) + filmSeed;
      vec2 screenUV = (vScreenPos.xy / max(vScreenPos.w, 0.0001)) * 0.5 + 0.5;

      if (grain > 0.0) {
        float n = hash21(screenUV * resolution + frame * 17.13) - 0.5;
        color += n * grain * (0.35 + 0.65 * (1.0 - dot(color, vec3(0.333))));
      }

      if (dust > 0.0) {
        vec2 cell = floor(screenUV * resolution / 3.0);
        float d = hash21(cell + frame * 41.7);
        float threshold = 1.0 - dust * 0.003;
        if (d > threshold) {
          float bright = step(0.7, hash21(cell + frame * 7.3));
          color = mix(color, vec3(bright), 0.85);
        }
      }

      if (scratches > 0.0) {
        float slow = floor(frame / 6.0);
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          float present = step(1.0 - scratches * 0.8, hash21(vec2(slow, fi * 13.0)));
          float x = hash21(vec2(slow * 3.1 + fi, 91.0));
          x += (hash21(vec2(frame, fi * 5.0)) - 0.5) * 0.004;
          float line = smoothstep(0.002, 0.0, abs(screenUV.x - x));
          color += line * present * scratches * 0.6;
        }
      }

      if (blotches > 0.0) {
        float n = valueNoise(sampleUv * 4.0 + vec2(frame * 0.02, -frame * 0.013));
        float stain = smoothstep(0.62, 0.95, n);
        color = mix(color, color * vec3(1.18, 0.94, 0.72), stain * blotches);
      }
    }

    // 7. SUPER 8 PROJECTOR STAGE
    if (enableSuper8 > 0.5) {
      float s8Frame = floor(time * max(super8Rate, 0.001)) + super8Seed;
      color *= mix(vec3(1.0), vec3(1.15, 0.95, 0.78), warmth);
      float f = 1.0 + (hash21(vec2(s8Frame, 7.3)) - 0.5) * flicker * 0.4;
      color *= f;
      float NdotV = max(0.0, dot(N, V));
      float vignette = mix(1.0, smoothstep(0.0, 0.8, NdotV), super8Softness * 0.3);
      color *= vignette;
    }

    // 8. OUTLINE STAGE (Inside the object or 3D silhouette)
    if (enableOutline > 0.5) {
      float isEdge = 0.0;

      // A. Alpha edge detection inside the object (when outlineSide is inside or center)
      if (hasMap > 0.5 && outlineAlpha > 0.5 && outlineSide > 0.5) {
        vec2 dUv = fwidth(sampleUv) * max(0.5, edgeThickness);
        if (length(dUv) < 1e-6) {
          dUv = vec2(edgeThickness / max(resolution.x, 1.0), edgeThickness / max(resolution.y, 1.0));
        }

        // 16 sampling taps across 3 concentric rings (0.35, 0.495, 1.0) measuring transparent margin proximity
        float sumTransparent = 0.0;

        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2( dUv.x * 0.35, 0.0)).a) / thresh, 0.0, 1.0) * 1.2;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(-dUv.x * 0.35, 0.0)).a) / thresh, 0.0, 1.0) * 1.2;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(0.0,  dUv.y * 0.35)).a) / thresh, 0.0, 1.0) * 1.2;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(0.0, -dUv.y * 0.35)).a) / thresh, 0.0, 1.0) * 1.2;

        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2( dUv.x,  dUv.y) * 0.495).a) / thresh, 0.0, 1.0);
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(-dUv.x,  dUv.y) * 0.495).a) / thresh, 0.0, 1.0);
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2( dUv.x, -dUv.y) * 0.495).a) / thresh, 0.0, 1.0);
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(-dUv.x, -dUv.y) * 0.495).a) / thresh, 0.0, 1.0);

        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2( dUv.x, 0.0)).a) / thresh, 0.0, 1.0) * 0.8;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(-dUv.x, 0.0)).a) / thresh, 0.0, 1.0) * 0.8;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(0.0,  dUv.y)).a) / thresh, 0.0, 1.0) * 0.8;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(0.0, -dUv.y)).a) / thresh, 0.0, 1.0) * 0.8;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2( dUv.x * 0.924,  dUv.y * 0.383)).a) / thresh, 0.0, 1.0) * 0.8;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(-dUv.x * 0.924,  dUv.y * 0.383)).a) / thresh, 0.0, 1.0) * 0.8;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2( dUv.x * 0.383, -dUv.y * 0.924)).a) / thresh, 0.0, 1.0) * 0.8;
        sumTransparent += clamp((thresh - texture2D(baseMap, sampleUv + vec2(-dUv.x * 0.383, -dUv.y * 0.924)).a) / thresh, 0.0, 1.0) * 0.8;

        float edgeProximity = clamp(sumTransparent / 5.0, 0.0, 1.0);
        if (edgeProximity > 0.001) {
          isEdge = smoothstep(0.0, max(0.02, 1.0 - sharpness * 0.98), edgeProximity);
        }
      }

      // B. 3D Geometric silhouette / crease detection
      if (outlineSilhouette > 0.5) {
        float NdotV = abs(dot(N, V));
        float silThresh = clamp(edgeThickness * 0.12, 0.03, 0.85);
        float rim = 1.0 - smoothstep(0.0, silThresh, NdotV);

        // Screen space normal gradient for creases/sharp edges
        vec3 dNdx = dFdx(N);
        vec3 dNdy = dFdy(N);
        float normalDelta = length(dNdx) + length(dNdy);
        float crease = smoothstep(0.35, 0.85, normalDelta * max(0.5, edgeThickness) * 0.5);

        float geoEdge = max(rim, crease);
        geoEdge = smoothstep(mix(0.0, 0.75, sharpness), 1.0, geoEdge);
        isEdge = max(isEdge, geoEdge);
      }

      float edgeFactor = clamp(isEdge * edgeStrength, 0.0, 1.0);
      color = mix(color, edgeColor, edgeFactor);
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), alpha);
  }
`;

export function createCompositeFilmMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      // Base
      baseColor: { value: new THREE.Color(0xffffff) },
      baseOpacity: { value: 1.0 },
      baseMap: { value: null as THREE.Texture | null },
      hasMap: { value: 0.0 },
      lightDirection: { value: new THREE.Vector3(1.0, 2.0, 1.5).normalize() },
      resolution: { value: new THREE.Vector2(1920, 1080) },
      time: { value: 0.0 },

      // Duotone
      enableDuotone: { value: 0.0 },
      shadowColor: { value: new THREE.Color(0x1b2a4a) },
      highlightColor: { value: new THREE.Color(0xffd9a0) },
      balance: { value: 0.5 },
      softness: { value: 0.5 },
      amount: { value: 1.0 },

      // Halftone
      enableHalftone: { value: 0.0 },
      shape: { value: 0.0 },
      radius: { value: 4.0 },
      screenAngle: { value: (15 * Math.PI) / 180 },
      scatter: { value: 0.0 },
      halftoneAmount: { value: 1.0 },
      greyscale: { value: 0.0 },
      space: { value: 0.0 },

      // Film Texture
      enableFilmTexture: { value: 0.0 },
      grain: { value: 0.15 },
      dust: { value: 0.2 },
      scratches: { value: 0.15 },
      blotches: { value: 0.15 },
      filmRate: { value: 16.0 },
      filmSeed: { value: 0.0 },

      // Dry Brush
      enableDryBrush: { value: 0.0 },
      coverage: { value: 0.25 },
      dryBrushScale: { value: 60.0 },
      dryBrushSoftness: { value: 0.25 },
      stretch: { value: 3.0 },
      dryBrushAngle: { value: 0.0 },
      followInk: { value: 1.0 },
      paperColor: { value: new THREE.Color(0xffffff) },
      dryBrushAnimate: { value: 0.0 },
      dryBrushRate: { value: 12.0 },
      dryBrushSeed: { value: 0.0 },

      // Super 8
      enableSuper8: { value: 0.0 },
      flicker: { value: 0.12 },
      warmth: { value: 0.35 },
      super8Softness: { value: 1.0 },
      weave: { value: 0.25 },
      super8Rate: { value: 18.0 },
      super8Seed: { value: 0.0 },

      // Outline
      enableOutline: { value: 0.0 },
      edgeColor: { value: new THREE.Color(0x000000) },
      edgeThickness: { value: 3.0 },
      edgeStrength: { value: 1.0 },
      alphaThreshold: { value: 0.1 },
      sharpness: { value: 1.0 },
      outlineSide: { value: 0.0 },
      outlineSilhouette: { value: 1.0 },
      outlineAlpha: { value: 1.0 },
    },
    vertexShader: COMMON_VERTEX_SHADER,
    fragmentShader: COMPOSITE_FRAGMENT_SHADER,
  });
}

export function createModifierDuotoneMaterial(): THREE.ShaderMaterial {
  const m = createCompositeFilmMaterial();
  m.uniforms.enableDuotone.value = 1.0;
  return m;
}

export function createModifierHalftoneMaterial(): THREE.ShaderMaterial {
  const m = createCompositeFilmMaterial();
  m.uniforms.enableHalftone.value = 1.0;
  return m;
}

export function createModifierFilmTextureMaterial(): THREE.ShaderMaterial {
  const m = createCompositeFilmMaterial();
  m.uniforms.enableFilmTexture.value = 1.0;
  return m;
}

export function createModifierDryBrushMaterial(): THREE.ShaderMaterial {
  const m = createCompositeFilmMaterial();
  m.uniforms.enableDryBrush.value = 1.0;
  return m;
}

export function createModifierSuper8Material(): THREE.ShaderMaterial {
  const m = createCompositeFilmMaterial();
  m.uniforms.enableSuper8.value = 1.0;
  return m;
}

export function createModifierOutlineMaterial(): THREE.ShaderMaterial {
  const m = createCompositeFilmMaterial();
  m.uniforms.enableOutline.value = 1.0;
  return m;
}

