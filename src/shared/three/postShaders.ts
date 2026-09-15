import * as THREE from "three";

/**
 * Full-screen shaders for the film-look post passes, in the shape
 * `ShaderPass` wants (uniforms + vertexShader + fragmentShader).
 *
 * They live here rather than in postProcessChain.ts because they are longer
 * than the chain's own bookkeeping and would bury it — the chain stays a list
 * of "which pass, in what order, with which uniforms".
 *
 * Two conventions run through all three:
 *
 * - **Time is quantised.** Real film's imperfections change once per exposed
 *   frame, not once per drawn frame. Grain that updates 60 times a second
 *   reads as digital noise, and a projector's flicker at 60 Hz reads as a
 *   failing monitor. Each shader floors `time * rate` to a whole film frame
 *   first, so at rate 16 the whole look ticks over sixteen times a second
 *   regardless of how fast the app is drawing.
 * - **Randomness is a hash of position and film frame**, never a per-draw
 *   value: the same second of a scene renders identically in the preview, in
 *   the second viewport and in an export, which is what makes a captured
 *   frame match what was authored.
 */

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Value hash in [0,1) — cheap, stable, and enough for grain and specks. */
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

/**
 * Two-colour grade: luminance is remapped onto a ramp between a shadow and a
 * highlight colour. `balance` slides the midpoint (which tones fall on which
 * side), `softness` is how abrupt the crossover is — near 0 it is a hard
 * two-tone poster, at 1 a smooth gradient. `amount` blends the whole thing
 * back over the original, so the node can be dialled in rather than being all
 * or nothing.
 */
export const DuotoneShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    shadowColor: { value: new THREE.Color(0x1b2a4a) },
    highlightColor: { value: new THREE.Color(0xffd9a0) },
    balance: { value: 0.5 },
    softness: { value: 0.5 },
    amount: { value: 1.0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 shadowColor;
    uniform vec3 highlightColor;
    uniform float balance;
    uniform float softness;
    uniform float amount;
    varying vec2 vUv;

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      float lum = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));

      // A softness of 0 would make the two edges of the smoothstep meet and
      // the result undefined; the floor keeps it a (very) hard edge instead.
      float half_ = max(softness, 0.001) * 0.5;
      float t = smoothstep(balance - half_, balance + half_, lum);

      vec3 graded = mix(shadowColor, highlightColor, t);
      gl_FragColor = vec4(mix(src.rgb, graded, amount), src.a);
    }
  `,
};

/**
 * The imperfections of a print that has been through a projector a few too
 * many times: grain, dust specks, vertical scratches, and slow chemical
 * blotches. Each is independent so the look can be pushed one axis at a time
 * — the default is a light dusting rather than a ruin.
 */
export const FilmTextureShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    rate: { value: 16 },
    grain: { value: 0.12 },
    dust: { value: 0.2 },
    scratches: { value: 0.15 },
    blotches: { value: 0.15 },
    resolution: { value: new THREE.Vector2(1, 1) },
    seed: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float rate;
    uniform float grain;
    uniform float dust;
    uniform float scratches;
    uniform float blotches;
    uniform vec2 resolution;
    uniform float seed;
    varying vec2 vUv;

    ${HASH_GLSL}

    void main() {
      float frame = floor(time * max(rate, 0.001)) + seed;
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 color = src.rgb;

      // Grain: signed noise scaled by how much room the pixel has left, so
      // highlights stay clean the way exposed silver does.
      if (grain > 0.0) {
        float n = hash21(vUv * resolution + frame * 17.13) - 0.5;
        color += n * grain * (0.35 + 0.65 * (1.0 - dot(color, vec3(0.333))));
      }

      // Dust: sparse specks, most of them dark (dirt on the gate), a few
      // bright (emulsion loss). Cells are square in *pixels* so they don't
      // stretch with the aspect ratio.
      if (dust > 0.0) {
        vec2 cell = floor(vUv * resolution / 3.0);
        float d = hash21(cell + frame * 41.7);
        // A 3px cell over a 800×600 frame is ~53k chances per frame, so the
        // rate has to be small: 0.002 puts a dozen specks on screen at the
        // default, where 0.02 put two hundred and read as a starfield.
        float threshold = 1.0 - dust * 0.002;
        if (d > threshold) {
          float bright = step(0.7, hash21(cell + frame * 7.3));
          color = mix(color, vec3(bright), 0.85);
        }
      }

      // Scratches: a handful of thin vertical lines that drift sideways and
      // survive several frames — a scratch is damage to the print, not noise.
      if (scratches > 0.0) {
        float slow = floor(frame / 6.0);
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          float present = step(1.0 - scratches * 0.8, hash21(vec2(slow, fi * 13.0)));
          float x = hash21(vec2(slow * 3.1 + fi, 91.0));
          x += (hash21(vec2(frame, fi * 5.0)) - 0.5) * 0.004;
          float line = smoothstep(0.0016, 0.0, abs(vUv.x - x));
          color += line * present * scratches * 0.6;
        }
      }

      // Blotches: large, soft, slow stains — the chemical ones, so they move
      // at a fraction of the frame rate and tint rather than replace.
      if (blotches > 0.0) {
        float n = valueNoise(vUv * 3.0 + vec2(frame * 0.02, -frame * 0.013));
        float stain = smoothstep(0.62, 0.95, n);
        color = mix(color, color * vec3(1.18, 0.94, 0.72), stain * blotches);
      }

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), src.a);
    }
  `,
};

/**
 * Dry brush: the specks a loaded brush *misses*.
 *
 * The motion-design staple — paint that doesn't quite cover, leaving little
 * holes of bare paper. So the effect punches the paper colour through the
 * image rather than adding white on top of it: what shows is what was never
 * painted, and the two read differently the moment the paper isn't white.
 *
 * Two things keep it from looking like noise. The mask is clustered noise, not
 * per-pixel hash, so the gaps are blobs of a few pixels with ragged edges; and
 * it can be stretched along the stroke direction, which is what turns a field
 * of dots into something a brush left behind.
 *
 * `followInk` weights the mask by how much ink is under it: a brush can only
 * fail where it was painting, so gaps land on the artwork instead of raining
 * over the whole frame. Turn it off for the flat all-over speckle of a badly
 * inked screen print.
 */
export const DryBrushShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    rate: { value: 12 },
    animate: { value: 0 },
    coverage: { value: 0.25 },
    scale: { value: 220 },
    softness: { value: 0.25 },
    stretch: { value: 3 },
    angle: { value: 0 },
    followInk: { value: 1 },
    paperColor: { value: new THREE.Color(0xffffff) },
    resolution: { value: new THREE.Vector2(1, 1) },
    seed: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float rate;
    uniform float animate;
    uniform float coverage;
    uniform float scale;
    uniform float softness;
    uniform float stretch;
    uniform float angle;
    uniform float followInk;
    uniform vec3 paperColor;
    uniform vec2 resolution;
    uniform float seed;
    varying vec2 vUv;

    ${HASH_GLSL}

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);

      // Off, the pattern is fixed: a still frame of dry brush is a texture,
      // and it should hold still unless asked to boil.
      float frame = animate > 0.5 ? floor(time * max(rate, 0.001)) : 0.0;
      float jump = frame * 37.0 + seed * 91.0;

      // Aspect-corrected, so a speck is as wide as it is tall, then rotated
      // and squashed along the stroke: the brush drags in one direction.
      vec2 p = vUv * vec2(resolution.x / max(resolution.y, 1.0), 1.0) * scale;
      float c = cos(angle);
      float s = sin(angle);
      p = mat2(c, -s, s, c) * p;
      p.x /= max(stretch, 0.001);

      float n = valueNoise(p + jump) * 0.65 + valueNoise(p * 2.7 + jump * 1.7) * 0.35;

      // A gap is a *peak* of the noise, not its lower half: two octaves pile
      // up around 0.5, so cutting there leaves half the frame bare and reads
      // as static. Coverage slides the cut down from "almost nothing gets
      // through" towards "the brush is running dry".
      float edge = mix(0.86, 0.52, clamp(coverage, 0.0, 1.0));
      float soft = max(softness, 0.001) * 0.2;
      float mask = smoothstep(edge - soft, edge + soft, n);

      if (followInk > 0.5) {
        // How much ink is here: dark pixels are painted, near-paper pixels
        // have nothing left to strip away.
        float ink = 1.0 - dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
        mask *= smoothstep(0.05, 0.45, ink);
      }

      gl_FragColor = vec4(mix(src.rgb, paperColor, clamp(mask, 0.0, 1.0)), src.a);
    }
  `,
};

/**
 * A Super 8 projector rather than a Super 8 camera: what the audience sees on
 * the wall. Soft focus from a cheap lens, an unsteady gate, lamp flicker, warm
 * tungsten light and the fall-off of the projected rectangle.
 *
 * The blur is a 3×3 tent rather than a real gaussian — the point is a lens
 * that never quite resolves, which is a pixel or two of softness, and at that
 * radius the difference between the two kernels is not visible.
 */
export const Super8Shader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    rate: { value: 18 },
    softness: { value: 1.2 },
    flicker: { value: 0.12 },
    weave: { value: 0.35 },
    warmth: { value: 0.35 },
    vignette: { value: 0.45 },
    resolution: { value: new THREE.Vector2(1, 1) },
    seed: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float rate;
    uniform float softness;
    uniform float flicker;
    uniform float weave;
    uniform float warmth;
    uniform float vignette;
    uniform vec2 resolution;
    uniform float seed;
    varying vec2 vUv;

    ${HASH_GLSL}

    void main() {
      float frame = floor(time * max(rate, 0.001)) + seed;

      // Gate weave: the frame is never quite where the last one was. Mostly
      // vertical, as it is the pull-down claw that is imprecise.
      vec2 jitter = vec2(
        (hash21(vec2(frame, 3.7)) - 0.5) * 0.0016,
        (hash21(vec2(frame, 8.1)) - 0.5) * 0.0035
      ) * weave;
      vec2 uv = clamp(vUv + jitter, 0.0, 1.0);

      vec2 texel = softness / max(resolution, vec2(1.0));
      vec3 color = texture2D(tDiffuse, uv).rgb * 4.0;
      color += texture2D(tDiffuse, uv + vec2( texel.x, 0.0)).rgb * 2.0;
      color += texture2D(tDiffuse, uv + vec2(-texel.x, 0.0)).rgb * 2.0;
      color += texture2D(tDiffuse, uv + vec2(0.0,  texel.y)).rgb * 2.0;
      color += texture2D(tDiffuse, uv + vec2(0.0, -texel.y)).rgb * 2.0;
      color += texture2D(tDiffuse, uv + texel).rgb;
      color += texture2D(tDiffuse, uv - texel).rgb;
      color += texture2D(tDiffuse, uv + vec2( texel.x, -texel.y)).rgb;
      color += texture2D(tDiffuse, uv + vec2(-texel.x,  texel.y)).rgb;
      color /= 16.0;

      // Lamp flicker: one exposure brighter or dimmer than the last, plus a
      // slower swell so it doesn't read as a repeating pattern.
      float f = (hash21(vec2(frame, 1.3)) - 0.5) * 2.0;
      float swell = sin(frame * 0.21) * 0.4;
      color *= 1.0 + (f + swell) * flicker * 0.5;

      // Tungsten lamp and aged stock: warm the highlights, cool nothing —
      // a projected image never gets bluer than the bulb.
      vec3 warm = color * vec3(1.12, 1.0, 0.82);
      color = mix(color, warm, warmth);

      // The projected rectangle falls off towards its corners.
      vec2 d = vUv - 0.5;
      float falloff = 1.0 - dot(d, d) * 2.2 * vignette;
      color *= clamp(falloff, 0.0, 1.0);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};
