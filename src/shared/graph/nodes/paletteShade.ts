import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { isRealMesh } from "../../three/objectKinds";
import { clearMeshWarning, warnMeshRequired } from "../meshRequired";
import { ColorRamp, DEFAULT_COLOR_RAMP, sampleColorRamp } from "../colorRamp";
import { asColor, inheritSourceMaterial, numberInput, primitiveOutputs } from "./object";

/**
 * Palette Shade — limits a geometry's look to a palette.
 *
 * The geometry's colour is *replaced* by palette colours: the light it
 * receives (every light summed — directional, point, spot, ambient, hemisphere
 * and environment) is measured, cut into as many bands as the palette has
 * colours, and each band paints with its colour. Dark bands take the dark end
 * of the palette, lit ones the bright end.
 *
 * The bands split the range 0 to 1 of summed light evenly: a light of
 * intensity 1 facing a surface head-on reaches the top of the palette. Light
 * Gain and Light Bias slide that scale for brighter or dimmer rigs.
 *
 * Shadows cast onto the geometry by *other* objects are deliberately not part
 * of that measurement. The bands come from the light as if nothing blocked it;
 * the shadow-map result is tracked separately and only darkens the finished
 * palette colour afterwards. So each geometry keeps its own hand-painted
 * ramp, and a neighbour's shadow still falls across it unquantised.
 *
 * Alpha is never touched: a material's opacity, alpha map, the alpha channel
 * of its texture and its alpha test carry over to the painted result, so a
 * cut-out leaf card keeps its silhouette — the Tree's leaves bring their own
 * blade cut and wind through an adapter on the material.
 *
 * Wired between an object and whatever consumes it, so each geometry can take
 * a different palette and a different number of shades.
 */

/** Largest palette the shader holds. */
export const MAX_PALETTE_COLORS = 32;

/** Used when nothing is wired to the Palette input: a warm, painterly 4-step ramp. */
const DEFAULT_PALETTE_HEX = [0x2b2a4c, 0x7a5c8c, 0xe8a07a, 0xfff1d0];

const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Turns whatever arrived on the Palette input into plain colours. Non-colour
 * entries are dropped rather than painted white, so a list with a stray number
 * in it still reads as the colours around it.
 */
export function paletteColorsFromList(list: unknown): THREE.Color[] {
  if (!Array.isArray(list)) return [];
  const out: THREE.Color[] = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    // A bare number is a value, not a colour: a numeric list wired here by
    // mistake would otherwise become a palette of near-blacks.
    if (typeof item === "boolean" || typeof item === "number") continue;
    const probe = new THREE.Color(-1, -1, -1);
    const c = asColor(item, probe);
    if (c === probe || c.r < 0) continue;
    out.push(c.clone());
  }
  return out;
}

/**
 * Brings a palette to exactly `steps` colours, stretching evenly across it:
 * fewer steps pick colours spread over the whole range (the first and last
 * are always kept), more steps interpolate between neighbours. `steps` of 0
 * keeps the palette as it is. The result is capped at MAX_PALETTE_COLORS.
 */
export function resamplePalette(colors: THREE.Color[], steps: number): THREE.Color[] {
  if (colors.length === 0) return [];
  const wanted = steps >= 1 ? Math.floor(steps) : colors.length;
  const count = Math.max(1, Math.min(MAX_PALETTE_COLORS, wanted));
  if (count === 1) return [colors[Math.floor((colors.length - 1) / 2)].clone()];
  if (count === colors.length) return colors.map((c) => c.clone());
  const out: THREE.Color[] = [];
  for (let i = 0; i < count; i++) {
    const pos = (i / (count - 1)) * (colors.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(colors.length - 1, lo + 1);
    out.push(colors[lo].clone().lerp(colors[hi], pos - lo));
  }
  return out;
}

/** Resolves the colours a Palette Shade uses: sorted dark to bright (optionally), then fitted to `steps`. */
export function buildPalette(colors: THREE.Color[], steps: number, sort: boolean): THREE.Color[] {
  const base = colors.length > 0 ? colors : DEFAULT_PALETTE_HEX.map((h) => new THREE.Color(h));
  const ordered = sort ? [...base].sort((a, b) => luminance(a) - luminance(b)) : base;
  return resamplePalette(ordered, steps);
}

interface PaletteUniforms {
  uPalette: { value: THREE.Vector3[] };
  uPaletteCount: { value: number };
  uPaletteSoftness: { value: number };
  uPaletteBias: { value: number };
  uPaletteExposure: { value: number };
  uPaletteShadow: { value: number };
}

/**
 * The shader patches Lambert's lighting in four places:
 *  1. each light's shadow factor is kept in `pcShadow` instead of being
 *     multiplied into its colour, so the light stays unshadowed;
 *  2. RE_Direct adds up the light's luminance into `pcLit`, and the same
 *     amount scaled by the shadow into `pcLitShadowed`;
 *  3. RE_IndirectDiffuse (ambient, hemisphere, probes, environment) adds to both;
 *  4. the final colour is the palette entry for `pcLit`, darkened by how much
 *     of the light the shadows took away.
 */
function compilePalette(uniforms: PaletteUniforms, shader: { uniforms: Record<string, unknown>; fragmentShader: string }): void {
  Object.assign(shader.uniforms, uniforms);

  // Lights chunk from three's own source, so every light type (point, spot,
  // directional) gets its shadow factor captured instead of applied.
  const lightsBegin = THREE.ShaderChunk.lights_fragment_begin
    .replace(/directLight\.color \*= (.+) : 1\.0;/g, "pcShadow = $1 : 1.0;")
    .replace(/(get(?:Point|Spot|Directional)LightInfo\([^;]*;)/g, "$1 pcShadow = 1.0;");

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <lights_lambert_pars_fragment>",
      /* glsl */ `
      varying vec3 vViewPosition;
      struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
      uniform vec3 uPalette[${MAX_PALETTE_COLORS}];
      uniform float uPaletteCount;
      uniform float uPaletteSoftness;
      uniform float uPaletteBias;
      uniform float uPaletteExposure;
      uniform float uPaletteShadow;
      float pcShadow = 1.0;
      float pcLit = 0.0;
      float pcLitShadowed = 0.0;
      float pcLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
      void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
        float l = saturate( dot( geometryNormal, directLight.direction ) ) * pcLuma( directLight.color );
        pcLit += l;
        pcLitShadowed += l * pcShadow;
      }
      void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
        float l = pcLuma( irradiance );
        pcLit += l;
        pcLitShadowed += l;
      }
      #define RE_Direct RE_Direct_Lambert
      #define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert
      `,
    )
    .replace("#include <lights_fragment_begin>", () => lightsBegin)
    .replace(
      "vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;",
      /* glsl */ `
      float pcCount = max( uPaletteCount, 1.0 );
      float pcT = clamp( pcLit * uPaletteExposure + uPaletteBias, 0.0, 1.0 ) * pcCount;
      int pcIdx = int( min( floor( pcT ), pcCount - 1.0 ) );
      float pcFrac = min( pcT - float( pcIdx ), 1.0 );
      vec3 pcColor = uPalette[ pcIdx ];
      if ( pcIdx > 0 ) {
        float pcW = uPaletteSoftness > 1e-4 ? smoothstep( 0.0, uPaletteSoftness, pcFrac ) : 1.0;
        pcColor = mix( uPalette[ pcIdx - 1 ], pcColor, pcW );
      }
      float pcRatio = pcLit > 1e-4 ? clamp( pcLitShadowed / pcLit, 0.0, 1.0 ) : 1.0;
      pcColor *= mix( 1.0, pcRatio, uPaletteShadow );
      vec3 outgoingLight = pcColor + totalEmissiveRadiance;`,
    );
}

function createPaletteUniforms(): PaletteUniforms {
  return {
    uPalette: { value: Array.from({ length: MAX_PALETTE_COLORS }, () => new THREE.Vector3()) },
    uPaletteCount: { value: 1 },
    uPaletteSoftness: { value: 0 },
    uPaletteBias: { value: 0 },
    uPaletteExposure: { value: 1 },
    uPaletteShadow: { value: 1 },
  };
}

/** What a material may expose so Palette Shade can redraw it faithfully (a leaf card brings its own wind and blade cut). */
interface PaletteAdapter {
  key: string;
  patch: (shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }) => void;
}

const adapterOf = (m: THREE.Material | null | undefined): PaletteAdapter | undefined =>
  (m as any)?.__paletteAdapter as PaletteAdapter | undefined;

/** The alpha side of a material: what must survive a change of colour. */
function syncAlpha(variant: THREE.MeshLambertMaterial, source: THREE.Material | null | undefined, doubleSided: boolean): void {
  const src = source as (THREE.Material & { map?: THREE.Texture | null; alphaMap?: THREE.Texture | null }) | null | undefined;
  const side = doubleSided ? THREE.DoubleSide : (src?.side ?? THREE.FrontSide);
  const map = src?.map ?? null;
  const alphaMap = src?.alphaMap ?? null;
  const alphaTest = src?.alphaTest ?? 0;
  const transparent = src?.transparent ?? false;
  const needsRecompile =
    variant.side !== side ||
    variant.alphaTest !== alphaTest ||
    variant.transparent !== transparent ||
    !!variant.map !== !!map ||
    !!variant.alphaMap !== !!alphaMap ||
    variant.alphaToCoverage !== (src?.alphaToCoverage ?? false) ||
    variant.alphaHash !== (src?.alphaHash ?? false);
  variant.side = side;
  variant.map = map;
  variant.alphaMap = alphaMap;
  variant.alphaTest = alphaTest;
  variant.transparent = transparent;
  variant.alphaToCoverage = src?.alphaToCoverage ?? false;
  variant.alphaHash = src?.alphaHash ?? false;
  variant.opacity = src?.opacity ?? 1;
  variant.depthWrite = src?.depthWrite ?? true;
  if (needsRecompile) variant.needsUpdate = true;
}

/**
 * A Lambert material that paints with the palette while keeping the look of
 * `source` that is not colour: its alpha (opacity, alpha map, the alpha channel
 * of its texture, alpha test), its sidedness, and its vertex behaviour (wind
 * sway, and a leaf card's own pivoting and blade cut).
 */
export function createPaletteMaterial(
  uniforms: PaletteUniforms = createPaletteUniforms(),
  source?: THREE.Material | null,
): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  (mat as any).__isSharedCustom = true;
  (mat as any).__isPaletteMaterial = true;
  (mat as any).__paletteUniforms = uniforms;
  const adapter = adapterOf(source);
  const isShader = !!(source as THREE.ShaderMaterial | undefined)?.isShaderMaterial;
  const sourceCompile = !isShader && source ? source.onBeforeCompile : undefined;
  const sourceKey = !isShader && source ? source.customProgramCacheKey() : "";

  mat.onBeforeCompile = (shader, renderer) => {
    // The source's own vertex patches (wind sway on bark) come along; its
    // fragment side is thrown away — that is the colour being replaced.
    if (sourceCompile) {
      const probe = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader };
      sourceCompile.call(source, probe as never, renderer);
      shader.vertexShader = probe.vertexShader;
      Object.assign(shader.uniforms, probe.uniforms);
    }
    adapter?.patch(shader as never);
    compilePalette(uniforms, shader);
  };
  mat.customProgramCacheKey = () => `palette-shade|${adapter?.key ?? ""}|${sourceKey}`;
  syncAlpha(mat, source, false);
  return mat;
}

/** Writes a resolved palette and the shading knobs into palette uniforms. */
export function setPaletteUniforms(
  target: THREE.Material | PaletteUniforms,
  palette: THREE.Color[],
  options: { softness: number; bias: number; exposure: number; shadowStrength: number },
): void {
  const u = ("uPalette" in target ? target : (target as any).__paletteUniforms) as PaletteUniforms | undefined;
  if (!u) return;
  const count = Math.max(1, Math.min(MAX_PALETTE_COLORS, palette.length));
  for (let i = 0; i < MAX_PALETTE_COLORS; i++) {
    const c = palette[Math.min(i, palette.length - 1)];
    if (c) u.uPalette.value[i].set(c.r, c.g, c.b);
  }
  u.uPaletteCount.value = count;
  u.uPaletteSoftness.value = options.softness;
  u.uPaletteBias.value = options.bias;
  u.uPaletteExposure.value = options.exposure;
  u.uPaletteShadow.value = options.shadowStrength;
}

type MeshMaterial = THREE.Material | THREE.Material[];

interface PaletteShadeState {
  /** The palette every variant shares, by reference: one write repaints them all. */
  uniforms: PaletteUniforms;
  /** One palette variant per source material, so meshes sharing a material keep sharing. */
  variants: Map<THREE.Material, THREE.MeshLambertMaterial>;
  /** Stable arrays for multi-material meshes, keyed by the source array. */
  arrays: WeakMap<THREE.Material[], THREE.Material[]>;
  /** What each mesh was wearing before this node took over, so unwiring gives it back. */
  originals: Map<THREE.Mesh, MeshMaterial>;
}

function disposeVariants(state: PaletteShadeState): void {
  for (const v of state.variants.values()) v.dispose();
  state.variants.clear();
}

const paletteShadeCache = createNodeCache<PaletteShadeState>((state) => {
  for (const [mesh, original] of state.originals) inheritSourceMaterial(mesh, original);
  state.originals.clear();
  disposeVariants(state);
});

function getState(nodeId: string): PaletteShadeState {
  let state = paletteShadeCache.get(nodeId);
  if (!state) {
    state = { uniforms: createPaletteUniforms(), variants: new Map(), arrays: new WeakMap(), originals: new Map() };
    paletteShadeCache.set(nodeId, state);
  }
  return state;
}

/** Every real mesh under an object — helpers (clip caps, light icons) keep their own look. */
export function collectPaletteTargets(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (!isRealMesh(child)) return;
    if (child.userData.__clipCapHelper || child.userData.isHelper) return;
    meshes.push(child);
  });
  return meshes;
}

const isVariant = (m: THREE.Material | undefined): boolean => !!(m as any)?.__isPaletteMaterial;

function variantFor(state: PaletteShadeState, source: THREE.Material, doubleSided: boolean): THREE.MeshLambertMaterial {
  let v = state.variants.get(source);
  if (!v) {
    v = createPaletteMaterial(state.uniforms, source);
    state.variants.set(source, v);
  }
  syncAlpha(v, source, doubleSided);
  return v;
}

function variantsOf(state: PaletteShadeState, original: MeshMaterial, doubleSided: boolean): MeshMaterial {
  if (!Array.isArray(original)) return variantFor(state, original, doubleSided);
  const mapped = original.map((m) => variantFor(state, m, doubleSided));
  const previous = state.arrays.get(original);
  if (previous && previous.length === mapped.length && previous.every((m, i) => m === mapped[i])) return previous;
  state.arrays.set(original, mapped);
  return mapped;
}

/** Puts the palette on `targets`, and gives back the original on every mesh that is no longer reached. */
export function syncPaletteMaterial(state: PaletteShadeState, targets: THREE.Mesh[], doubleSided = false): void {
  const wanted = new Set(targets);
  for (const [mesh, original] of [...state.originals]) {
    if (wanted.has(mesh)) continue;
    inheritSourceMaterial(mesh, original);
    state.originals.delete(mesh);
  }
  for (const mesh of targets) {
    // Anything on the mesh that isn't ours is the true original — including a
    // material an upstream node swapped in since we last looked.
    const current = mesh.material;
    const ours = Array.isArray(current) ? current.every(isVariant) : isVariant(current);
    if (!ours) state.originals.set(mesh, current);
    const original = state.originals.get(mesh) ?? current;
    inheritSourceMaterial(mesh, variantsOf(state, original, doubleSided));
  }
  // Drop variants nothing reads any more (a source replaced upstream).
  const live = new Set<THREE.Material>();
  for (const original of state.originals.values()) for (const m of Array.isArray(original) ? original : [original]) live.add(m);
  for (const [source, v] of [...state.variants]) {
    if (live.has(source)) continue;
    v.dispose();
    state.variants.delete(source);
  }
}

/** Palette Shade node — paints a geometry with a limited palette, driven by the light it receives. */
export const PALETTE_SHADE_NODE: NodeDefinition = {
  type: "material/palette-shade",
  label: "Palette Shade",
  category: "material",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "palette", label: "Palette", type: "list" },
    { id: "steps", label: "Steps", type: "value" },
    { id: "softness", label: "Softness", type: "value" },
    { id: "bias", label: "Light Bias", type: "value" },
    { id: "exposure", label: "Light Gain", type: "value" },
    { id: "shadowStrength", label: "Shadow Strength", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    ramp: DEFAULT_COLOR_RAMP,
    steps: 0,
    sort: 1,
    softness: 0,
    bias: 0,
    exposure: 1,
    shadowStrength: 1,
    doubleSided: 0,
  },
  paramFields: [
    { id: "ramp", label: "Palette (if none wired)", kind: "color_ramp" },
    { id: "steps", label: "Steps (0 = palette size)", kind: "number", step: 1 },
    { id: "sort", label: "Sort Dark to Light", kind: "boolean" },
    { id: "softness", label: "Softness", kind: "number", step: 0.02 },
    { id: "bias", label: "Light Bias", kind: "number", step: 0.05 },
    { id: "exposure", label: "Light Gain", kind: "number", step: 0.1 },
    { id: "shadowStrength", label: "Shadow Strength", kind: "number", step: 0.05 },
    { id: "doubleSided", label: "Force Double Sided", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) {
      syncPaletteMaterial(state, []);
      return { geometry: null, matrix: new THREE.Matrix4() };
    }

    const targets = collectPaletteTargets(inputObj);
    if (targets.length === 0) {
      syncPaletteMaterial(state, []);
      warnMeshRequired(ctx.nodeId, "Palette Shade", inputObj);
      return primitiveOutputs(inputObj);
    }
    clearMeshWarning(ctx.nodeId);

    // A wired palette wins; otherwise the node's own ramp, sampled at the step count.
    let colors = paletteColorsFromList(inputs.palette);
    const steps = Math.max(0, Math.floor(numberInput(inputs.steps, params.steps, 0)));
    if (colors.length === 0) {
      const ramp = params.ramp && typeof params.ramp === "object" ? (params.ramp as ColorRamp) : DEFAULT_COLOR_RAMP;
      const n = steps >= 1 ? Math.min(MAX_PALETTE_COLORS, steps) : 4;
      colors = Array.from({ length: n }, (_, i) => sampleColorRamp(ramp, n > 1 ? i / (n - 1) : 0).clone());
    }
    const sort = params.sort === undefined ? true : Boolean(params.sort);
    const palette = buildPalette(colors, steps, sort);

    setPaletteUniforms(state.uniforms, palette, {
      softness: Math.max(0, Math.min(0.5, numberInput(inputs.softness, params.softness, 0))),
      bias: Math.max(-1, Math.min(1, numberInput(inputs.bias, params.bias, 0))),
      exposure: Math.max(0, numberInput(inputs.exposure, params.exposure, 1)),
      shadowStrength: Math.max(0, Math.min(1, numberInput(inputs.shadowStrength, params.shadowStrength, 1))),
    });

    syncPaletteMaterial(state, targets, Boolean(params.doubleSided));

    return primitiveOutputs(inputObj);
  },
};
