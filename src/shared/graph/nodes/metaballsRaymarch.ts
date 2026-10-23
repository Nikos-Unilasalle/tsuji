import * as THREE from "three";
import { BLOB_AABB, BLOB_STRIDE, BLOB_WEIGHT } from "../offthread/surfaceNets";

/**
 * Metaballs drawn by the GPU instead of meshed by the worker: the node's mesh
 * becomes a box around the elements, and its own material — standard,
 * physical or basic, whatever applyMaterialParams made — is patched so each
 * fragment of that box marches a ray through the same field the Surface Nets
 * kernel meshes (surfaceNets.ts: compact bumps, ellipsoids, capsules, chains,
 * negative weights), and shades the hit as if it were the surface itself:
 *
 *   - discard on a miss, gl_FragDepth from the hit (so it intersects other
 *     geometry correctly);
 *   - the varyings the lighting code reads (vViewPosition, vNormal, the
 *     shadow coordinates, …) turned into plain globals and recomputed from
 *     the hit, so PBR, environment and received shadows all see the real
 *     surface;
 *   - custom depth / distance materials marching the same field, so it casts
 *     the right shadow too.
 *
 * Elements are uploaded as a float texture, 7 RGBA texels per element — the
 * kernel's 28-float layout as is. A ray only looks at the elements whose box
 * it crosses (at most MAX_CANDIDATES, in element order so chains stay
 * contiguous).
 */

/** Elements a single ray considers; more crossing one ray are dropped from that ray. */
export const MAX_CANDIDATES = 32;
/** The same for the shadow passes, which run the march once per cube face per point light. */
export const MAX_SHADOW_CANDIDATES = 12;
/** Elements uploaded; past this the rest are ignored (the texture is one element per row). */
export const MAX_RAYMARCH_ELEMENTS = 4096;
const TEXELS = BLOB_STRIDE / 4;

export interface RaymarchState {
  /** Distinguishes states in program cache keys: a program compiled for one state's uniforms is never reused for another's. */
  id: number;
  uniforms: {
    uBlobTex: { value: THREE.DataTexture };
    uBlobCount: { value: number };
    uBlobIso: { value: number };
    uBlobColors: { value: boolean };
    uBlobMin: { value: THREE.Vector3 };
    uBlobMax: { value: THREE.Vector3 };
  };
  depthMaterial: THREE.MeshDepthMaterial;
  distanceMaterial: THREE.MeshDistanceMaterial;
}

function emptyTexture(rows: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Float32Array(TEXELS * 4 * rows), TEXELS, rows, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

let nextStateId = 1;

export function createRaymarchState(): RaymarchState {
  const id = nextStateId++;
  const uniforms = {
    uBlobTex: { value: emptyTexture(1) },
    uBlobCount: { value: 0 },
    uBlobIso: { value: 0 },
    uBlobColors: { value: false },
    uBlobMin: { value: new THREE.Vector3() },
    uBlobMax: { value: new THREE.Vector3() },
  };
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const distanceMaterial = new THREE.MeshDistanceMaterial();
  for (const material of [depthMaterial, distanceMaterial]) {
    material.side = THREE.BackSide;
    material.onBeforeCompile = (shader) => patchShader(shader, uniforms, true);
    material.customProgramCacheKey = () => `tsuji-blob-raymarch#${id}`;
  }
  return { id, uniforms, depthMaterial, distanceMaterial };
}

export function disposeRaymarchState(state: RaymarchState): void {
  state.uniforms.uBlobTex.value.dispose();
  state.depthMaterial.dispose();
  state.distanceMaterial.dispose();
}

/**
 * Uploads a job's elements. Returns the box (node-local) the positive
 * elements reach, or null when nothing would be drawn.
 */
export function uploadElements(state: RaymarchState, elements: Float64Array, iso: number, colors: boolean): THREE.Box3 | null {
  const count = Math.min(MAX_RAYMARCH_ELEMENTS, Math.floor(elements.length / BLOB_STRIDE));
  const u = state.uniforms;
  let texture = u.uBlobTex.value;
  if (texture.image.height < count) {
    texture.dispose();
    let rows = Math.max(16, texture.image.height);
    while (rows < count) rows *= 2;
    texture = emptyTexture(Math.min(rows, MAX_RAYMARCH_ELEMENTS));
    u.uBlobTex.value = texture;
  }
  const data = texture.image.data as Float32Array;
  data.set(count === elements.length / BLOB_STRIDE ? elements : elements.subarray(0, count * BLOB_STRIDE));
  texture.needsUpdate = true;
  u.uBlobCount.value = count;
  u.uBlobIso.value = iso;
  u.uBlobColors.value = colors;

  const box = new THREE.Box3();
  for (let i = 0; i < count; i++) {
    const o = i * BLOB_STRIDE;
    if (!(elements[o + BLOB_WEIGHT] > 0)) continue;
    const a = o + BLOB_AABB;
    box.expandByPoint(new THREE.Vector3(elements[a], elements[a + 1], elements[a + 2]));
    box.expandByPoint(new THREE.Vector3(elements[a + 3], elements[a + 4], elements[a + 5]));
  }
  if (box.isEmpty()) return null;
  u.uBlobMin.value.copy(box.min);
  u.uBlobMax.value.copy(box.max);
  return box;
}

const PREV_HOOK = Symbol("tsuji-raymarch-prev");
interface Binding {
  hook: THREE.Material["onBeforeCompile"];
  state: RaymarchState;
  active: boolean;
  prev: { onBeforeCompile: THREE.Material["onBeforeCompile"]; key: THREE.Material["customProgramCacheKey"] };
}
interface Patched {
  [PREV_HOOK]?: Binding;
}

/**
 * Binds `material` to a raymarch state, on top of whatever onBeforeCompile it
 * already has (triplanar). `active` raymarches; inactive only *carries* the
 * state's uniforms, with the shader untouched.
 *
 * Why carry them at all: three keeps every program a material has used, and
 * going back to one already compiled skips onBeforeCompile and keeps the
 * uniforms object of whichever program was compiled *last*. Raymarch → mesh →
 * raymarch would then draw the raymarch program with the mesh program's
 * uniforms — no element texture, count 0, every fragment discarded. Making
 * every program of the material carry the same uniforms closes that.
 *
 * Cheap to call every frame: it only reinstalls itself when the state or mode
 * changed, or something else replaced the hook.
 */
export function bindRaymarch(material: THREE.Material, state: RaymarchState, active: boolean): void {
  const m = material as THREE.Material & Patched;
  const current = m[PREV_HOOK];
  if (current && m.onBeforeCompile === current.hook) {
    if (current.state === state && current.active === active) return;
    unbindRaymarch(m);
  }
  const prev = { onBeforeCompile: m.onBeforeCompile, key: m.customProgramCacheKey };
  const hook: THREE.Material["onBeforeCompile"] = function (this: THREE.Material, shader, renderer) {
    prev.onBeforeCompile.call(this, shader, renderer);
    if (active) patchShader(shader, state.uniforms);
    else Object.assign(shader.uniforms, state.uniforms);
  };
  m[PREV_HOOK] = { hook, state, active, prev };
  m.onBeforeCompile = hook;
  const suffix = `|tsuji-blob-${active ? "raymarch" : "uniforms"}#${state.id}`;
  m.customProgramCacheKey = function (this: THREE.Material) {
    // The default key is onBeforeCompile's source — ours, not what was there; ask for it as it was.
    const base = prev.key === THREE.Material.prototype.customProgramCacheKey ? prev.onBeforeCompile.toString() : prev.key.call(this);
    return `${base}${suffix}`;
  };
  m.needsUpdate = true;
}

/** Takes the binding off entirely (no-op on a material never bound). */
export function unbindRaymarch(material: THREE.Material): void {
  const m = material as THREE.Material & Patched;
  const current = m[PREV_HOOK];
  if (!current) return;
  if (m.onBeforeCompile === current.hook) {
    m.onBeforeCompile = current.prev.onBeforeCompile;
    m.customProgramCacheKey = current.prev.key;
  }
  delete m[PREV_HOOK];
  m.needsUpdate = true;
}

export function isRaymarchEnabled(material: THREE.Material): boolean {
  const current = (material as THREE.Material & Patched)[PREV_HOOK];
  return !!current && current.active && material.onBeforeCompile === current.hook;
}

/** Varyings the patched fragment recomputes from the hit, when the shader has them. */
const RECOMPUTED = ["vViewPosition", "vNormal", "vWorldPosition", "vHighPrecisionZW", "vTriPos", "vTriNormal"];
const SHADOW_COORDS = ["vDirectionalShadowCoord", "vSpotLightCoord", "vPointShadowCoord"];

/** `shadowPass`: depth / distance materials only need where the ray hits — no normal, no colour, coarser steps. */
function patchShader(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: RaymarchState["uniforms"], shadowPass = false): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vBlobWorld;")
    .replace("#include <project_vertex>", "#include <project_vertex>\nvBlobWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");

  // Inline the chunks that declare varyings we need as globals.
  let fragment = shader.fragmentShader
    .replace("#include <normal_pars_fragment>", THREE.ShaderChunk.normal_pars_fragment)
    .replace("#include <shadowmap_pars_fragment>", THREE.ShaderChunk.shadowmap_pars_fragment);
  const present: string[] = [];
  for (const name of [...RECOMPUTED, ...SHADOW_COORDS]) {
    const declaration = new RegExp(`varying\\s+(\\w+)\\s+${name}\\b`, "g");
    if (declaration.test(fragment)) {
      fragment = fragment.replace(declaration, `$1 ${name}`);
      present.push(name);
    }
  }
  const has = (name: string) => present.includes(name);
  const assign: string[] = [];
  if (has("vViewPosition")) assign.push("vViewPosition = - blobView.xyz;");
  if (has("vNormal")) assign.push("vNormal = normalize( ( viewMatrix * vec4( blobWorldNormal, 0.0 ) ).xyz );");
  if (has("vWorldPosition")) assign.push("vWorldPosition = blobWorldHit;");
  if (has("vHighPrecisionZW")) assign.push("vHighPrecisionZW = blobClip.zw;");
  if (has("vTriPos")) assign.push("vTriPos = blobLocalHit;");
  if (has("vTriNormal")) assign.push("vTriNormal = blobLocalNormal;");
  if (has("vDirectionalShadowCoord")) assign.push(DIR_SHADOW_COORDS);
  if (has("vSpotLightCoord")) assign.push(SPOT_SHADOW_COORDS);
  if (has("vPointShadowCoord")) assign.push(POINT_SHADOW_COORDS);

  fragment = fragment.replace("#include <common>", `#include <common>\n${shadowPass ? "#define BLOB_SHADOW_PASS\n" : ""}${has("vDirectionalShadowCoord") || has("vSpotLightCoord") || has("vPointShadowCoord") ? SHADOW_UNIFORMS : ""}\n${RAYMARCH_GLSL}`);
  fragment = fragment.replace(
    /void\s+main\s*\(\s*\)\s*\{/,
    `void main() {
	vec3 blobLocalHit;
	vec3 blobLocalNormal;
	vec3 blobColor;
	if ( ! blobTrace( blobLocalHit, blobLocalNormal, blobColor ) ) discard;
	vec3 blobWorldHit = ( modelMatrix * vec4( blobLocalHit, 1.0 ) ).xyz;
	vec3 blobWorldNormal = normalize( transpose( inverse( mat3( modelMatrix ) ) ) * blobLocalNormal );
	vec4 blobView = viewMatrix * vec4( blobWorldHit, 1.0 );
	vec4 blobClip = projectionMatrix * blobView;
	gl_FragDepth = clamp( 0.5 * blobClip.z / blobClip.w + 0.5, 0.0, 1.0 );
	${assign.join("\n\t")}
`,
  );
  fragment = fragment.replace("#include <color_fragment>", "#include <color_fragment>\n\tif ( uBlobColors ) diffuseColor.rgb *= blobColor;");
  shader.fragmentShader = fragment;
}

const SHADOW_UNIFORMS = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif
#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
#endif
`;

const DIR_SHADOW_COORDS = /* glsl */ `
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * vec4( blobWorldHit + blobWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 1.0 );
	}
	#endif`;

const POINT_SHADOW_COORDS = /* glsl */ `
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * vec4( blobWorldHit + blobWorldNormal * pointLightShadows[ i ].shadowNormalBias, 1.0 );
	}
	#endif`;

const SPOT_SHADOW_COORDS = /* glsl */ `
	#if NUM_SPOT_LIGHT_COORDS > 0
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * vec4( blobWorldHit, 1.0 );
	}
	#endif`;

/**
 * The field, the trace and the gradient — surfaceNets.ts's qAt / chain / gradient
 * logic, per ray. Texel layout per element (row i): t0 kind,a.xyz · t1 b.xyz,M0 ·
 * t2 M1..M4 · t3 M5..M8 · t4 min.xyz,max.x · t5 max.yz,reach,weight · t6 rgb,chain.
 */
const RAYMARCH_GLSL = /* glsl */ `
varying vec3 vBlobWorld;
// three only declares these in the vertex stage; it fills them for the fragment too once declared.
uniform mat4 modelMatrix;
uniform mat4 projectionMatrix;
uniform highp sampler2D uBlobTex;
uniform int uBlobCount;
uniform float uBlobIso;
uniform bool uBlobColors;
uniform vec3 uBlobMin;
uniform vec3 uBlobMax;

#ifdef BLOB_SHADOW_PASS
	#define BLOB_MAX_CANDIDATES ${MAX_SHADOW_CANDIDATES}
#else
	#define BLOB_MAX_CANDIDATES ${MAX_CANDIDATES}
#endif
// March step, as a fraction of the smallest reach on the ray, and bisection
// iterations. The shadow passes (a cube map per point light: six renders of
// the whole march) settle for a coarser hit.
#ifdef BLOB_SHADOW_PASS
	#define BLOB_STEP 0.5
	#define BLOB_BISECT 5
#else
	#define BLOB_STEP 0.25
	#define BLOB_BISECT 10
#endif

// Per candidate only its id and its span on the ray: every other datum is
// re-read from the texture when needed. Wide per-pixel arrays cost registers,
// and on Apple GPUs that collapses occupancy for every fragment of the box —
// 13 floats per candidate made the shadow passes 10× slower than these 3.
int blobN;
int blobId[ BLOB_MAX_CANDIDATES ];
vec2 blobT[ BLOB_MAX_CANDIDATES ];   // the ray's [t in, t out] of the element's box

vec4 blobTexel( int id, int t ) { return texelFetch( uBlobTex, ivec2( t, id ), 0 ); }

mat3 blobMatrix( int id ) {
	vec4 t1 = blobTexel( id, 1 );
	vec4 t2 = blobTexel( id, 2 );
	vec4 t3 = blobTexel( id, 3 );
	// M0 = t1.w, M1..M4 = t2, M5..M8 = t3; columns are (M0 M3 M6), (M1 M4 M7), (M2 M5 M8).
	return mat3( t1.w, t2.z, t3.y,  t2.x, t2.w, t3.z,  t2.y, t3.x, t3.w );
}

// Offset from element id's core, through its matrix when it is an ellipsoid.
vec3 blobLocal( int id, vec3 p ) {
	vec4 t0 = blobTexel( id, 0 );
	vec3 a = t0.yzw;
	vec3 d = p - a;
	if ( t0.x == 1.0 ) {
		vec3 s = blobTexel( id, 1 ).xyz - a;
		float len2 = dot( s, s );
		if ( len2 > 0.0 ) d -= clamp( dot( d, s ) / len2, 0.0, 1.0 ) * s;
	} else if ( t0.x == 2.0 ) {
		d = blobMatrix( id ) * d;
	}
	return d;
}

// reach, weight, chain of element id.
vec3 blobRWC( int id ) {
	vec4 t5 = blobTexel( id, 5 );
	return vec3( t5.z, t5.w, blobTexel( id, 6 ).w );
}

float blobQ( int id, float reach, vec3 p ) {
	vec3 u = blobLocal( id, p );
	float r2 = reach * reach;
	float d2 = dot( u, u );
	return d2 < r2 ? 1.0 - d2 / r2 : 0.0;
}

// Field minus iso at ray parameter t; a chain counts once, through its best
// segment. Elements whose box the ray is not inside at t are skipped (their
// bump is 0 there anyway). \`covered\`: some positive element's box holds t.
float blobField( vec3 p, float t, out bool covered ) {
	float sum = 0.0;
	float chain = 0.0;
	float bestQ = 0.0;
	float bestW = 0.0;
	covered = false;
	for ( int c = 0; c < blobN; c ++ ) {
		if ( t < blobT[ c ].x || t > blobT[ c ].y ) {
			// Outside this box its bump is 0; a chain still has to be closed when it ends.
			continue;
		}
		int id = blobId[ c ];
		vec3 rwc = blobRWC( id );
		if ( rwc.z != chain ) {
			if ( chain > 0.0 && bestQ > 0.0 ) sum += bestW * bestQ * bestQ * bestQ;
			chain = rwc.z;
			bestQ = 0.0;
		}
		if ( rwc.y > 0.0 ) covered = true;
		float q = blobQ( id, rwc.x, p );
		if ( rwc.z > 0.0 ) {
			if ( q > bestQ ) { bestQ = q; bestW = rwc.y; }
		} else if ( q > 0.0 ) {
			sum += rwc.y * q * q * q;
		}
	}
	if ( chain > 0.0 && bestQ > 0.0 ) sum += bestW * bestQ * bestQ * bestQ;
	return sum - uBlobIso;
}

// One element's gradient contribution and colour weight.
void blobGradientOf( int id, vec3 p, inout vec3 grad, inout vec4 color ) {
	vec3 rwc = blobRWC( id );
	vec3 u = blobLocal( id, p );
	float r2 = rwc.x * rwc.x;
	float d2 = dot( u, u );
	if ( ! ( d2 < r2 ) ) return;
	float q = 1.0 - d2 / r2;
	float w = rwc.y;
	float coef = w * 3.0 * q * q * - 2.0 / r2;
	vec3 g = u;
	if ( blobTexel( id, 0 ).x == 2.0 ) g = transpose( blobMatrix( id ) ) * u;
	grad += coef * g;
	if ( w > 0.0 ) {
		float f = w * q * q * q;
		color += vec4( blobTexel( id, 6 ).rgb * f, f );
	}
}

void blobShade( vec3 p, float t, out vec3 normal, out vec3 rgb ) {
	vec3 grad = vec3( 0.0 );
	vec4 color = vec4( 0.0 );
	// Chains contribute through their best segment only.
	float chain = 0.0;
	int best = -1;
	float bestQ = 0.0;
	for ( int c = 0; c < blobN; c ++ ) {
		if ( t < blobT[ c ].x || t > blobT[ c ].y ) continue;
		int id = blobId[ c ];
		vec3 rwc = blobRWC( id );
		if ( rwc.z != chain ) {
			if ( best >= 0 ) blobGradientOf( best, p, grad, color );
			chain = rwc.z;
			best = -1;
			bestQ = 0.0;
		}
		if ( rwc.z > 0.0 ) {
			float q = blobQ( id, rwc.x, p );
			if ( q > bestQ ) { bestQ = q; best = id; }
		} else {
			blobGradientOf( id, p, grad, color );
		}
	}
	if ( best >= 0 ) blobGradientOf( best, p, grad, color );
	float len = length( grad );
	normal = len > 0.0 ? - grad / len : vec3( 0.0, 1.0, 0.0 );
	rgb = color.w > 0.0 ? color.rgb / color.w : vec3( 1.0 );
}

// Ray / box slab test: (tNear, tFar), tNear > tFar on a miss.
vec2 blobSlab( vec3 ro, vec3 inv, vec3 lo, vec3 hi ) {
	vec3 t0 = ( lo - ro ) * inv;
	vec3 t1 = ( hi - ro ) * inv;
	vec3 tmin = min( t0, t1 );
	vec3 tmax = max( t0, t1 );
	return vec2( max( max( tmin.x, tmin.y ), tmin.z ), min( min( tmax.x, tmax.y ), tmax.z ) );
}

bool blobTrace( out vec3 hit, out vec3 normal, out vec3 rgb ) {
	hit = vec3( 0.0 );
	normal = vec3( 0.0, 1.0, 0.0 );
	rgb = vec3( 1.0 );
	mat4 worldToLocal = inverse( modelMatrix );
	// Camera in world space, from the view matrix alone (cameraPosition is not
	// set for every material — the shadow passes' depth / distance ones).
	mat3 viewRot = mat3( viewMatrix );
	vec3 camWorld = - transpose( viewRot ) * viewMatrix[ 3 ].xyz;
	bool ortho = projectionMatrix[ 2 ][ 3 ] == 0.0;
	vec3 forward = - vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );
	vec3 rdWorld = ortho ? forward : normalize( vBlobWorld - camWorld );
	vec3 roWorld = ortho ? vBlobWorld - forward * dot( vBlobWorld - camWorld, forward ) : camWorld;
	vec3 ro = ( worldToLocal * vec4( roWorld, 1.0 ) ).xyz;
	vec3 rd = normalize( ( worldToLocal * vec4( rdWorld, 0.0 ) ).xyz );
	vec3 inv = 1.0 / rd;

	vec2 span = blobSlab( ro, inv, uBlobMin, uBlobMax );
	span.x = max( span.x, 0.0 );
	// The box's far face is this fragment: nothing behind it is ours to draw.
	span.y = min( span.y, dot( ( worldToLocal * vec4( vBlobWorld, 1.0 ) ).xyz - ro, rd ) + 1e-4 );
	if ( span.x >= span.y ) return false;

	// Candidates: elements whose box this ray crosses, in element order.
	blobN = 0;
	float t0 = 1e30;
	float t1 = - 1e30;
	float minReach = 1e30;
	for ( int id = 0; id < uBlobCount; id ++ ) {
		vec4 box0 = blobTexel( id, 4 );
		vec4 box1 = blobTexel( id, 5 );
		vec2 s = blobSlab( ro, inv, box0.xyz, vec3( box0.w, box1.xy ) );
		s.x = max( s.x, span.x );
		s.y = min( s.y, span.y );
		if ( s.x > s.y ) continue;
		if ( blobN == BLOB_MAX_CANDIDATES ) break;
		blobId[ blobN ] = id;
		blobT[ blobN ] = s;
		blobN ++;
		if ( box1.w > 0.0 ) {
			t0 = min( t0, s.x );
			t1 = max( t1, s.y );
			minReach = min( minReach, box1.z );
		}
	}
	if ( t0 >= t1 ) return false;

	// March, skipping the gaps no positive element covers, then bisect the first crossing.
	float dt = max( minReach * BLOB_STEP, ( t1 - t0 ) / 256.0 );
	float t = t0;
	float tPrev = t0;
	bool found = false;
	for ( int i = 0; i < 256; i ++ ) {
		if ( t > t1 ) break;
		bool covered;
		float f = blobField( ro + rd * t, t, covered );
		if ( f > 0.0 ) {
			float lo = tPrev;
			float hi = t;
			for ( int k = 0; k < BLOB_BISECT; k ++ ) {
				float mid = 0.5 * ( lo + hi );
				bool unused;
				if ( blobField( ro + rd * mid, mid, unused ) > 0.0 ) hi = mid; else lo = mid;
			}
			hit = ro + rd * hi;
			found = true;
			break;
		}
		tPrev = t;
		if ( covered ) {
			t += dt;
		} else {
			// Nothing positive here: jump to where the next positive box starts.
			float next = 1e30;
			for ( int c = 0; c < blobN; c ++ ) {
				if ( blobT[ c ].x > t && blobTexel( blobId[ c ], 5 ).w > 0.0 ) next = min( next, blobT[ c ].x );
			}
			if ( next > t1 ) break;
			t = next;
		}
	}
	if ( ! found ) return false;
#ifndef BLOB_SHADOW_PASS
	blobShade( hit, dot( hit - ro, rd ), normal, rgb );
#endif
	return true;
}
`;
