import { describe, expect, test } from "vitest";
import { createLbm2D, setSolid, stepLbm2D, tauFor, U_LATTICE, vorticity } from "./lbm2d";

/** A cylinder of diameter d in a tunnel 20d × 8d, 4d downstream of the inlet; `offset` breaks the symmetry. */
function cylinder(d: number, re: number, offset = 0.3) {
  const nx = 20 * d, ny = 8 * d;
  const s = createLbm2D(nx, ny, d, re);
  const mask = new Uint8Array(nx * ny);
  const cx = 4 * d, cy = ny / 2 - 0.5 + offset, r = d / 2;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * nx + x] = 1;
  setSolid(s, mask);
  return s;
}

// Reference values are for an unbounded flow (Re 20: Cd ≈ 2.05; Re 100: Cd ≈ 1.35, St ≈ 0.165).
// The tunnel's free-stream walls 4 diameters away (12.5 % blockage) and a staircase cylinder
// of 12 cells push both up by 10-25 %, as they do in a real wind tunnel.
describe("LBM D2Q9 wind tunnel (CPU)", () => {
  test("relaxation time follows the Reynolds number", () => {
    expect(tauFor(100, 100)).toBeCloseTo(3 * U_LATTICE + 0.5, 9);
  });

  test("steady flow past a cylinder at Re = 20: symmetric, drag coefficient ≈ 2–2.8", () => {
    const d = 12;
    const s = cylinder(d, 20, 0); // mirror-symmetric staircase
    stepLbm2D(s, 3000);
    const dyn = 0.5 * U_LATTICE * U_LATTICE * d;
    expect(s.fx / dyn).toBeGreaterThan(2.0);
    expect(s.fx / dyn).toBeLessThan(2.8);
    expect(Math.abs(s.fy / dyn)).toBeLessThan(0.05);
  }, 60_000);

  test("vortex shedding at Re = 100: Strouhal ≈ 0.16–0.2, Cd ≈ 1.3–1.8, vorticity of both signs", () => {
    const d = 12;
    const s = cylinder(d, 100);
    stepLbm2D(s, 4000);
    const dyn = 0.5 * U_LATTICE * U_LATTICE * d;
    const cl: number[] = [];
    let cdSum = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) { stepLbm2D(s, 1); cl.push(s.fy / dyn); cdSum += s.fx / dyn; }
    const ups: number[] = [];
    for (let i = 1; i < N; i++) if (cl[i - 1] < 0 && cl[i] >= 0) ups.push(i);
    expect(ups.length).toBeGreaterThan(3);
    const period = (ups[ups.length - 1] - ups[0]) / (ups.length - 1);
    const st = d / (period * U_LATTICE);
    expect(st).toBeGreaterThan(0.16);
    expect(st).toBeLessThan(0.2);
    expect(cdSum / N).toBeGreaterThan(1.3);
    expect(cdSum / N).toBeLessThan(1.8);
    const w = vorticity(s);
    expect(Math.max(...w)).toBeGreaterThan(1);
    expect(Math.min(...w)).toBeLessThan(-1);
  }, 60_000);

  test("stays stable at Re = 10 000 (Smagorinsky)", () => {
    const s = cylinder(12, 10000);
    stepLbm2D(s, 3000);
    expect(Number.isFinite(s.fx)).toBe(true);
    let maxU = 0;
    for (let c = 0; c < s.ux.length; c++) maxU = Math.max(maxU, Math.hypot(s.ux[c], s.uy[c]));
    expect(maxU).toBeLessThan(4 * U_LATTICE);
  }, 60_000);
});
