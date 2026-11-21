/**
 * 2D wind tunnel — lattice Boltzmann (D2Q9), BGK collision with a Smagorinsky
 * eddy viscosity so it stays stable at the Reynolds numbers of insect wings
 * (10³–10⁴) on a grid of a few hundred cells.
 *
 * Lattice units throughout: one cell = 1, one step = 1, density ≈ 1. The flow
 * always runs along +x (the caller rotates the obstacle for an angle of attack),
 * so drag is the x force and lift the y force.
 *
 * Reynolds number: Re = U·L/ν with U the inflow speed (`U_LATTICE`), L the
 * reference length in cells (the chord) and ν = (τ − ½)/3, so the relaxation
 * time follows from the Re asked for: τ = 3·U·L/Re + ½.
 *
 * Boundaries: inflow at x = 0 and far field at y = 0 / ny − 1 (equilibrium at
 * the free stream), zero-gradient outflow at x = nx − 1, half-way bounce-back
 * on obstacle cells. Forces on the obstacle by momentum exchange.
 *
 * References: Krüger et al., *The Lattice Boltzmann Method* (Springer 2017),
 * ch. 5 (bounce-back), 5.4 (momentum exchange), 10.7 (Smagorinsky LES);
 * Hou et al. 1996, *A lattice Boltzmann subgrid model for high Reynolds number
 * flows*, Fields Inst. Commun. 6.
 */

/** Inflow speed in lattice units — Mach ≈ 0.14, low enough for incompressible flow. */
export const U_LATTICE = 0.08;
/** Smagorinsky constant. */
const CS_SMAG = 0.16;

// D2Q9: rest, 4 axis, 4 diagonal.
const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];

/** What the read-out helpers need — filled by both the CPU and the GPU solver. */
export interface LbmFields {
  nx: number;
  ny: number;
  solid: Uint8Array;
  rho: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
  length: number;
}

export interface Lbm2D extends LbmFields {
  nx: number;
  ny: number;
  /** Post-collision populations, structure of arrays: f[i * n + cell]. */
  f: Float32Array;
  /** Scratch for the next step. */
  g: Float32Array;
  /** 1 = obstacle. */
  solid: Uint8Array;
  rho: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
  /** Reference length in cells (the chord), for Re and the force coefficients. */
  length: number;
  reynolds: number;
  /** Molecular relaxation time, from Re. */
  tau: number;
  steps: number;
  /** Force on the obstacle at the last step (lattice units). */
  fx: number;
  fy: number;
  /** Exponential moving averages of the coefficients (shedding makes them oscillate). */
  cd: number;
  cl: number;
}

function feq(i: number, rho: number, ux: number, uy: number): number {
  const cu = CX[i] * ux + CY[i] * uy;
  return W[i] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (ux * ux + uy * uy));
}

export function tauFor(reynolds: number, length: number): number {
  const nu = (U_LATTICE * length) / Math.max(1, reynolds);
  return 3 * nu + 0.5;
}

export function createLbm2D(nx: number, ny: number, length: number, reynolds: number): Lbm2D {
  const n = nx * ny;
  const s: Lbm2D = {
    nx, ny,
    f: new Float32Array(9 * n), g: new Float32Array(9 * n),
    solid: new Uint8Array(n),
    rho: new Float32Array(n).fill(1), ux: new Float32Array(n).fill(U_LATTICE), uy: new Float32Array(n),
    length, reynolds, tau: tauFor(reynolds, length),
    steps: 0, fx: 0, fy: 0, cd: 0, cl: 0,
  };
  for (let c = 0; c < n; c++) {
    // A faint transverse ripple: a perfectly symmetric start can stay symmetric
    // (no vortex shedding) for a very long time.
    const y = Math.floor(c / nx);
    const uy = 0.002 * U_LATTICE * Math.sin((2 * Math.PI * y) / ny);
    for (let i = 0; i < 9; i++) s.f[i * n + c] = feq(i, 1, U_LATTICE, uy);
  }
  return s;
}

export function setReynolds(s: Lbm2D, reynolds: number, length = s.length): void {
  s.reynolds = reynolds;
  s.length = length;
  s.tau = tauFor(reynolds, length);
}

/**
 * Replaces the obstacle. Cells that turn fluid get the free-stream equilibrium,
 * so the flow carries on instead of restarting when the angle of attack or the
 * section changes.
 */
export function setSolid(s: Lbm2D, mask: Uint8Array): void {
  const n = s.nx * s.ny;
  for (let c = 0; c < n; c++) {
    if (s.solid[c] && !mask[c]) {
      for (let i = 0; i < 9; i++) s.f[i * n + c] = feq(i, 1, U_LATTICE, 0);
    }
    s.solid[c] = mask[c];
  }
}

const FORCE = new Float64Array(2);

/**
 * Advances `count` steps. The interior is unrolled by hand and kept in its own
 * monomorphic kernel (V8 kept deoptimising the all-in-one version); cells next
 * to an obstacle take the general path with bounce-back and force accounting.
 */
export function stepLbm2D(s: Lbm2D, count = 1): void {
  const { nx, ny } = s;
  const n = nx * ny;
  const solid = s.solid;
  // Cells with an obstacle neighbour.
  const near = new Uint8Array(n);
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 1; x < nx - 1; x++) {
      const c = y * nx + x;
      if (solid[c]) continue;
      for (let i = 1; i < 9; i++) if (solid[c - CX[i] - CY[i] * nx]) { near[c] = 1; break; }
    }
  }
  const dyn = 0.5 * U_LATTICE * U_LATTICE * s.length;
  for (let it = 0; it < count; it++) {
    kernel(s.f, s.g, solid, near, s.rho, s.ux, s.uy, nx, ny, s.tau, FORCE);
    const t = s.f;
    s.f = s.g;
    s.g = t;
    s.steps++;
    s.fx = FORCE[0];
    s.fy = FORCE[1];
    // Averaged over ~50 steps; plain mean while fewer have run.
    const k = Math.max(0.02, 1 / s.steps);
    s.cd += k * (s.fx / dyn - s.cd);
    s.cl += k * (s.fy / dyn - s.cl);
  }
}

const EQ = new Float64Array(9);
for (let i = 0; i < 9; i++) EQ[i] = feq(i, 1, U_LATTICE, 0);
const FIN = new Float64Array(9);

function kernel(
  f: Float32Array, g: Float32Array, solid: Uint8Array, near: Uint8Array,
  RHO: Float32Array, UX: Float32Array, UY: Float32Array,
  nx: number, ny: number, tau0: number, force: Float64Array,
): void {
  const n = nx * ny;
  const n2 = 2 * n, n3 = 3 * n, n4 = 4 * n, n5 = 5 * n, n6 = 6 * n, n7 = 7 * n, n8 = 8 * n;
  const smag = 18 * Math.SQRT2 * CS_SMAG * CS_SMAG;
  const tt = tau0 * tau0;
  let fx = 0;
  let fy = 0;
  // Inflow and far field: free-stream equilibrium. Obstacles: frozen.
  for (let y = 0; y < ny; y++) {
    const edge = y === 0 || y === ny - 1;
    for (let x = 0; x < nx; x++) {
      if (!edge && x !== 0) continue;
      const c = y * nx + x;
      if (solid[c]) continue;
      for (let i = 0; i < 9; i++) g[i * n + c] = EQ[i];
      RHO[c] = 1; UX[c] = U_LATTICE; UY[c] = 0;
    }
  }
  for (let y = 1; y < ny - 1; y++) {
    const row = y * nx;
    for (let x = 1; x < nx - 1; x++) {
      const c = row + x;
      if (solid[c] === 1) {
        RHO[c] = 1; UX[c] = 0; UY[c] = 0;
        continue;
      }
      let f0 = 0, f1 = 0, f2 = 0, f3 = 0, f4 = 0, f5 = 0, f6 = 0, f7 = 0, f8 = 0;
      if (near[c] === 0) {
        f0 = f[c];
        f1 = f[n + c - 1];
        f2 = f[n2 + c - nx];
        f3 = f[n3 + c + 1];
        f4 = f[n4 + c + nx];
        f5 = f[n5 + c - 1 - nx];
        f6 = f[n6 + c + 1 - nx];
        f7 = f[n7 + c + 1 + nx];
        f8 = f[n8 + c - 1 + nx];
      } else {
        for (let i = 0; i < 9; i++) {
          const cs = c - CX[i] - CY[i] * nx;
          if (solid[cs] === 1) {
            const o = OPP[i];
            const fo = f[o * n + c];
            FIN[i] = fo;
            // What left towards the wall (direction o) comes back as i:
            // the obstacle receives 2·f_o·c_o.
            fx += 2 * fo * CX[o];
            fy += 2 * fo * CY[o];
          } else {
            FIN[i] = f[i * n + cs];
          }
        }
        f0 = FIN[0]; f1 = FIN[1]; f2 = FIN[2]; f3 = FIN[3]; f4 = FIN[4];
        f5 = FIN[5]; f6 = FIN[6]; f7 = FIN[7]; f8 = FIN[8];
      }
      const rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
      const ir = 1 / rho;
      const ux = (f1 - f3 + f5 - f6 - f7 + f8) * ir;
      const uy = (f2 - f4 + f5 + f6 - f7 - f8) * ir;
      const usq = 1.5 * (ux * ux + uy * uy);
      const r9 = rho / 9, r36 = rho / 36;
      const e0 = 4 * r9 * (1 - usq);
      const e1 = r9 * (1 + 3 * ux + 4.5 * ux * ux - usq);
      const e2 = r9 * (1 + 3 * uy + 4.5 * uy * uy - usq);
      const e3 = r9 * (1 - 3 * ux + 4.5 * ux * ux - usq);
      const e4 = r9 * (1 - 3 * uy + 4.5 * uy * uy - usq);
      const a = ux + uy, b = uy - ux;
      const e5 = r36 * (1 + 3 * a + 4.5 * a * a - usq);
      const e6 = r36 * (1 + 3 * b + 4.5 * b * b - usq);
      const e7 = r36 * (1 - 3 * a + 4.5 * a * a - usq);
      const e8 = r36 * (1 - 3 * b + 4.5 * b * b - usq);
      const d1 = f1 - e1, d2 = f2 - e2, d3 = f3 - e3, d4 = f4 - e4;
      const d5 = f5 - e5, d6 = f6 - e6, d7 = f7 - e7, d8 = f8 - e8;
      // Non-equilibrium momentum flux → Smagorinsky relaxation time.
      const pxx = d1 + d3 + d5 + d6 + d7 + d8;
      const pyy = d2 + d4 + d5 + d6 + d7 + d8;
      const pxy = d5 - d6 + d7 - d8;
      const q = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
      const om = 2 / (tau0 + Math.sqrt(tt + smag * q * ir));
      g[c] = f0 + om * (e0 - f0);
      g[n + c] = f1 - om * d1;
      g[n2 + c] = f2 - om * d2;
      g[n3 + c] = f3 - om * d3;
      g[n4 + c] = f4 - om * d4;
      g[n5 + c] = f5 - om * d5;
      g[n6 + c] = f6 - om * d6;
      g[n7 + c] = f7 - om * d7;
      g[n8 + c] = f8 - om * d8;
      RHO[c] = rho; UX[c] = ux; UY[c] = uy;
    }
    // Zero-gradient outflow.
    const c = row + nx - 1;
    if (solid[c] === 0) {
      for (let i = 0; i < 9; i++) g[i * n + c] = g[i * n + c - 1];
      RHO[c] = RHO[c - 1]; UX[c] = UX[c - 1]; UY[c] = UY[c - 1];
    }
  }
  force[0] = fx;
  force[1] = fy;
}

/** Vorticity ∂uy/∂x − ∂ux/∂y by central differences, in units of U/L (one chord). */
export function vorticity(s: LbmFields, out = new Float32Array(s.nx * s.ny)): Float32Array {
  const { nx, ny, ux, uy, solid } = s;
  const k = s.length / U_LATTICE / 2;
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 1; x < nx - 1; x++) {
      const c = y * nx + x;
      out[c] = solid[c] ? 0 : (uy[c + 1] - uy[c - 1] - (ux[c + nx] - ux[c - nx])) * k;
    }
  }
  return out;
}

/** Pressure coefficient Cp = (p − p∞) / (½ρU²), with p = ρ/3. */
export function pressureCoefficient(rho: number): number {
  return (rho - 1) / 3 / (0.5 * U_LATTICE * U_LATTICE);
}

/** Bilinear velocity at a point in cell coordinates (cell centres at integers). */
export function sampleVelocity(s: LbmFields, x: number, y: number): [number, number] {
  const { nx, ny } = s;
  const x0 = Math.max(0, Math.min(nx - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(ny - 2, Math.floor(y)));
  const tx = Math.max(0, Math.min(1, x - x0));
  const ty = Math.max(0, Math.min(1, y - y0));
  const c = y0 * nx + x0;
  const lerp = (a: Float32Array) =>
    (a[c] * (1 - tx) + a[c + 1] * tx) * (1 - ty) + (a[c + nx] * (1 - tx) + a[c + nx + 1] * tx) * ty;
  return [lerp(s.ux), lerp(s.uy)];
}

/** Bilinear density (for the pressure) at a point in cell coordinates, fluid cells only. */
export function sampleRho(s: LbmFields, x: number, y: number): number {
  const xi = Math.max(0, Math.min(s.nx - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(s.ny - 1, Math.round(y)));
  const c = yi * s.nx + xi;
  return s.solid[c] ? NaN : s.rho[c];
}
