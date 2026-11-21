import * as THREE from "three";
import { tauFor, U_LATTICE } from "./lbm2d";

/**
 * The same D2Q9 + Smagorinsky wind tunnel as lbm2d.ts, on the GPU: one
 * fragment shader per step, ping-ponging between two render targets of four
 * float textures (MRT):
 *
 *   0: f0 f1 f2 f3     1: f4 f5 f6 f7     2: f8 Fx Fy —     3: ρ ux uy —
 *
 * Fx, Fy are each cell's share of the momentum exchanged with the obstacle.
 * After the steps of a frame, textures 2 and 3 are read back once so that the
 * visualisations (field colours, streamlines, pressure, forces) are computed
 * on the CPU from the same arrays as the CPU solver fills.
 *
 * Boundaries as on the CPU, with one difference: the outflow column copies the
 * column before it from the previous step (a shader cannot read the step it is
 * writing), which makes no visible difference that far downstream.
 */

const VERTEX = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
uniform float uU;
const int CX[9] = int[9](0, 1, 0, -1, 0, 1, -1, -1, 1);
const int CY[9] = int[9](0, 0, 1, 0, -1, 1, 1, -1, -1);
const float W[9] = float[9](4.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0);
const int OPP[9] = int[9](0, 3, 4, 1, 2, 7, 8, 5, 6);
float feq(int i, float rho, vec2 u) {
  float cu = float(CX[i]) * u.x + float(CY[i]) * u.y;
  return W[i] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u));
}
void writeEquilibrium(float rho, vec2 u, vec2 force) {
  o0 = vec4(feq(0, rho, u), feq(1, rho, u), feq(2, rho, u), feq(3, rho, u));
  o1 = vec4(feq(4, rho, u), feq(5, rho, u), feq(6, rho, u), feq(7, rho, u));
  o2 = vec4(feq(8, rho, u), force, 0.0);
  o3 = vec4(rho, u, 0.0);
}
`;

const INIT_FRAGMENT = /* glsl */ `${COMMON}
uniform ivec2 uSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  // A faint transverse ripple: a perfectly symmetric start can stay symmetric.
  float uy = 0.002 * uU * sin(6.28318530718 * float(p.y) / float(uSize.y));
  writeEquilibrium(1.0, vec2(uU, uy), vec2(0.0));
}
`;

// Unrolled by hand: dynamic indexing into arrays and vector components is slow
// on some drivers (Metal through ANGLE notably), ~4× slower than this.
const STEP_FRAGMENT = /* glsl */ `${COMMON}
uniform sampler2D uF0;
uniform sampler2D uF1;
uniform sampler2D uF2;
uniform sampler2D uF3;
uniform sampler2D uSolid;
uniform ivec2 uSize;
uniform float uTau0;
uniform float uSmag;

// The mask holds 0 or 1 as bytes, read back normalised: 1 → 1/255.
float solidAt(ivec2 q) { return texelFetch(uSolid, q, 0).r > 0.001 ? 1.0 : 0.0; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uF0, p, 0);
  vec4 b = texelFetch(uF1, p, 0);
  float c8 = texelFetch(uF2, p, 0).x;
  if (solidAt(p) > 0.5) {
    o0 = a; o1 = b; o2 = vec4(c8, 0.0, 0.0, 0.0); o3 = vec4(1.0, 0.0, 0.0, 0.0);
    return;
  }
  if (p.x == 0 || p.y == 0 || p.y == uSize.y - 1) {
    writeEquilibrium(1.0, vec2(uU, 0.0), vec2(0.0));
    return;
  }
  if (p.x == uSize.x - 1) {
    ivec2 q = p - ivec2(1, 0);
    o0 = texelFetch(uF0, q, 0);
    o1 = texelFetch(uF1, q, 0);
    o2 = vec4(texelFetch(uF2, q, 0).x, 0.0, 0.0, 0.0);
    o3 = texelFetch(uF3, q, 0);
    return;
  }
  // Pull streaming: f_i comes from p - c_i.
  float f0 = a.x;
  float f1 = texelFetch(uF0, p + ivec2(-1, 0), 0).y;
  float f2 = texelFetch(uF0, p + ivec2(0, -1), 0).z;
  float f3 = texelFetch(uF0, p + ivec2(1, 0), 0).w;
  float f4 = texelFetch(uF1, p + ivec2(0, 1), 0).x;
  float f5 = texelFetch(uF1, p + ivec2(-1, -1), 0).y;
  float f6 = texelFetch(uF1, p + ivec2(1, -1), 0).z;
  float f7 = texelFetch(uF1, p + ivec2(1, 1), 0).w;
  float f8 = texelFetch(uF2, p + ivec2(-1, 1), 0).x;
  // Half-way bounce-back: from an obstacle cell, f_i is this cell's own f_opp(i);
  // the obstacle receives 2·f_opp·c_opp.
  float s1 = solidAt(p + ivec2(-1, 0)), s2 = solidAt(p + ivec2(0, -1));
  float s3 = solidAt(p + ivec2(1, 0)), s4 = solidAt(p + ivec2(0, 1));
  float s5 = solidAt(p + ivec2(-1, -1)), s6 = solidAt(p + ivec2(1, -1));
  float s7 = solidAt(p + ivec2(1, 1)), s8 = solidAt(p + ivec2(-1, 1));
  vec2 force = vec2(0.0);
  force += 2.0 * vec2(-a.w, 0.0) * s1;        // opp(1) = 3, c3 = (-1, 0)
  force += 2.0 * vec2(0.0, -b.x) * s2;        // opp(2) = 4
  force += 2.0 * vec2(a.y, 0.0) * s3;         // opp(3) = 1
  force += 2.0 * vec2(0.0, a.z) * s4;         // opp(4) = 2
  force += 2.0 * vec2(-b.w, -b.w) * s5;       // opp(5) = 7, c7 = (-1, -1)
  force += 2.0 * vec2(c8, -c8) * s6;          // opp(6) = 8, c8 = (1, -1)
  force += 2.0 * vec2(b.y, b.y) * s7;         // opp(7) = 5
  force += 2.0 * vec2(-b.z, b.z) * s8;        // opp(8) = 6, c6 = (-1, 1)
  f1 = mix(f1, a.w, s1); f2 = mix(f2, b.x, s2); f3 = mix(f3, a.y, s3); f4 = mix(f4, a.z, s4);
  f5 = mix(f5, b.w, s5); f6 = mix(f6, c8, s6); f7 = mix(f7, b.y, s7); f8 = mix(f8, b.z, s8);

  float rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
  float ir = 1.0 / rho;
  float ux = (f1 - f3 + f5 - f6 - f7 + f8) * ir;
  float uy = (f2 - f4 + f5 + f6 - f7 - f8) * ir;
  float usq = 1.5 * (ux * ux + uy * uy);
  float r9 = rho / 9.0, r36 = rho / 36.0;
  float e0 = 4.0 * r9 * (1.0 - usq);
  float e1 = r9 * (1.0 + 3.0 * ux + 4.5 * ux * ux - usq);
  float e2 = r9 * (1.0 + 3.0 * uy + 4.5 * uy * uy - usq);
  float e3 = r9 * (1.0 - 3.0 * ux + 4.5 * ux * ux - usq);
  float e4 = r9 * (1.0 - 3.0 * uy + 4.5 * uy * uy - usq);
  float sp = ux + uy, sm = uy - ux;
  float e5 = r36 * (1.0 + 3.0 * sp + 4.5 * sp * sp - usq);
  float e6 = r36 * (1.0 + 3.0 * sm + 4.5 * sm * sm - usq);
  float e7 = r36 * (1.0 - 3.0 * sp + 4.5 * sp * sp - usq);
  float e8 = r36 * (1.0 - 3.0 * sm + 4.5 * sm * sm - usq);
  float d1 = f1 - e1, d2 = f2 - e2, d3 = f3 - e3, d4 = f4 - e4;
  float d5 = f5 - e5, d6 = f6 - e6, d7 = f7 - e7, d8 = f8 - e8;
  // Non-equilibrium momentum flux → Smagorinsky relaxation time.
  float pxx = d1 + d3 + d5 + d6 + d7 + d8;
  float pyy = d2 + d4 + d5 + d6 + d7 + d8;
  float pxy = d5 - d6 + d7 - d8;
  float q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
  float om = 2.0 / (uTau0 + sqrt(uTau0 * uTau0 + uSmag * q * ir));
  o0 = vec4(f0 + om * (e0 - f0), f1 - om * d1, f2 - om * d2, f3 - om * d3);
  o1 = vec4(f4 - om * d4, f5 - om * d5, f6 - om * d6, f7 - om * d7);
  o2 = vec4(f8 - om * d8, force, 0.0);
  o3 = vec4(rho, ux, uy, 0.0);
}
`;

export function isLbmGPUSupported(renderer: THREE.WebGLRenderer | undefined): boolean {
  if (!renderer) return false;
  const gl = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  return isWebGL2 && renderer.extensions.has("EXT_color_buffer_float");
}

export interface Lbm2DGPU {
  nx: number;
  ny: number;
  length: number;
  reynolds: number;
  tau: number;
  steps: number;
  solid: Uint8Array;
  /** Read back after each `stepLbm2DGPU`. */
  rho: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
  fx: number;
  fy: number;
  cd: number;
  cl: number;
  dispose(): void;
}

interface Internals {
  read: THREE.WebGLRenderTarget;
  write: THREE.WebGLRenderTarget;
  solidTex: THREE.DataTexture;
  step: THREE.RawShaderMaterial;
  init: THREE.RawShaderMaterial;
  scene: THREE.Scene;
  quad: THREE.Mesh;
  camera: THREE.OrthographicCamera;
  buf: Float32Array;
}
const internals = new WeakMap<Lbm2DGPU, Internals>();

function target(nx: number, ny: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(nx, ny, {
    count: 4,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

function render(renderer: THREE.WebGLRenderer, int: Internals, material: THREE.Material, into: THREE.WebGLRenderTarget) {
  int.quad.material = material;
  renderer.setRenderTarget(into);
  renderer.render(int.scene, int.camera);
}

export function createLbm2DGPU(renderer: THREE.WebGLRenderer, nx: number, ny: number, length: number, reynolds: number): Lbm2DGPU {
  const n = nx * ny;
  const solid = new Uint8Array(n);
  const solidTex = new THREE.DataTexture(solid, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
  solidTex.minFilter = THREE.NearestFilter;
  solidTex.magFilter = THREE.NearestFilter;
  solidTex.unpackAlignment = 1;
  solidTex.needsUpdate = true;
  const common = { glslVersion: THREE.GLSL3, vertexShader: VERTEX, depthTest: false, depthWrite: false };
  const init = new THREE.RawShaderMaterial({
    ...common,
    fragmentShader: INIT_FRAGMENT,
    uniforms: { uU: { value: U_LATTICE }, uSize: { value: new THREE.Vector2(nx, ny) } },
  });
  const step = new THREE.RawShaderMaterial({
    ...common,
    fragmentShader: STEP_FRAGMENT,
    uniforms: {
      uU: { value: U_LATTICE },
      uF0: { value: null }, uF1: { value: null }, uF2: { value: null }, uF3: { value: null },
      uSolid: { value: solidTex },
      uSize: { value: new THREE.Vector2(nx, ny) },
      uTau0: { value: tauFor(reynolds, length) },
      uSmag: { value: 18 * Math.SQRT2 * 0.16 * 0.16 },
    },
  });
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), init);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const int: Internals = { read: target(nx, ny), write: target(nx, ny), solidTex, step, init, scene, quad, camera, buf: new Float32Array(4 * n) };

  const state: Lbm2DGPU = {
    nx, ny, length, reynolds, tau: tauFor(reynolds, length), steps: 0, solid,
    rho: new Float32Array(n).fill(1), ux: new Float32Array(n).fill(U_LATTICE), uy: new Float32Array(n),
    fx: 0, fy: 0, cd: 0, cl: 0,
    dispose() {
      int.read.dispose();
      int.write.dispose();
      solidTex.dispose();
      step.dispose();
      init.dispose();
      quad.geometry.dispose();
    },
  };
  internals.set(state, int);
  const prev = renderer.getRenderTarget();
  render(renderer, int, init, int.read);
  renderer.setRenderTarget(prev);
  return state;
}

export function setReynoldsGPU(s: Lbm2DGPU, reynolds: number, length = s.length): void {
  s.reynolds = reynolds;
  s.length = length;
  s.tau = tauFor(reynolds, length);
}

export function setSolidGPU(s: Lbm2DGPU, mask: Uint8Array): void {
  s.solid.set(mask);
  internals.get(s)!.solidTex.needsUpdate = true;
}

/**
 * Advances `count` steps on the GPU, then reads back ρ, u and the obstacle force
 * (skipped with `readBack = false`: the read-back stalls the pipeline).
 */
export function stepLbm2DGPU(renderer: THREE.WebGLRenderer, s: Lbm2DGPU, count: number, readBack = true): void {
  const int = internals.get(s)!;
  const prev = renderer.getRenderTarget();
  const u = int.step.uniforms;
  u.uTau0.value = s.tau;
  for (let k = 0; k < count; k++) {
    const t = int.read.textures;
    u.uF0.value = t[0]; u.uF1.value = t[1]; u.uF2.value = t[2]; u.uF3.value = t[3];
    render(renderer, int, int.step, int.write);
    const r = int.read;
    int.read = int.write;
    int.write = r;
    s.steps++;
  }
  renderer.setRenderTarget(prev);
  if (count === 0 || !readBack) return;

  const { nx, ny } = s;
  const n = nx * ny;
  const buf = int.buf;
  renderer.readRenderTargetPixels(int.read, 0, 0, nx, ny, buf, undefined, 3);
  for (let c = 0; c < n; c++) {
    s.rho[c] = buf[4 * c];
    s.ux[c] = buf[4 * c + 1];
    s.uy[c] = buf[4 * c + 2];
  }
  renderer.readRenderTargetPixels(int.read, 0, 0, nx, ny, buf, undefined, 2);
  let fx = 0;
  let fy = 0;
  for (let c = 0; c < n; c++) {
    fx += buf[4 * c + 1];
    fy += buf[4 * c + 2];
  }
  s.fx = fx;
  s.fy = fy;
  const dyn = 0.5 * U_LATTICE * U_LATTICE * s.length;
  // One sample per frame: averaged over ~20 frames.
  const k = Math.max(0.05, 1 / Math.max(1, s.steps / Math.max(1, count)));
  s.cd += k * (fx / dyn - s.cd);
  s.cl += k * (fy / dyn - s.cl);
}
