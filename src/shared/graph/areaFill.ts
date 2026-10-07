import * as THREE from "three";

/**
 * The region between a graph and its baseline, as triangles, with its signed
 * area. For y = f(x) the baseline is the x-axis; for a polar curve it is the
 * origin, and the region a fan of sectors. Where the graph crosses the
 * baseline the strip is split exactly at the crossing, so the part above and
 * the part below each get their own colour — the integral's sign, drawn.
 */

export interface AreaFill {
  /** Math-space triangle corners, 3 numbers each. */
  positions: number[];
  /** 1 where the triangle is above the baseline (positive area), 0 below. */
  above: number[];
  /** Signed area: ∫ f(x) dx over the runs, or ½∫ r² dθ for polar. */
  area: number;
}

/** Fills between each run (math-space points, x increasing) and the x-axis. */
export function fillToAxis(runs: THREE.Vector3[][]): AreaFill {
  const out: AreaFill = { positions: [], above: [], area: 0 };
  const quad = (x0: number, y0: number, x1: number, y1: number) => {
    // A trapezoid on one side of the axis: two triangles.
    const sign = y0 + y1 >= 0 ? 1 : 0;
    out.positions.push(x0, 0, 0, x1, 0, 0, x1, y1, 0, x0, 0, 0, x1, y1, 0, x0, y0, 0);
    out.above.push(sign, sign, sign, sign, sign, sign);
    out.area += ((y0 + y1) / 2) * (x1 - x0);
  };
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      if (a.y * b.y < 0) {
        // Crosses the axis: split where it does.
        const x = a.x + ((b.x - a.x) * a.y) / (a.y - b.y);
        quad(a.x, a.y, x, 0);
        quad(x, 0, b.x, b.y);
      } else {
        quad(a.x, a.y, b.x, b.y);
      }
    }
  }
  return out;
}

/** Fills between each run of a polar curve and the origin: a fan, area ½∫ r² dθ, counted positive turning anticlockwise. */
export function fillToOrigin(runs: THREE.Vector3[][]): AreaFill {
  const out: AreaFill = { positions: [], above: [], area: 0 };
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      const cross = (a.x * b.y - a.y * b.x) / 2;
      out.positions.push(0, 0, 0, a.x, a.y, 0, b.x, b.y, 0);
      const sign = cross >= 0 ? 1 : 0;
      out.above.push(sign, sign, sign);
      out.area += cross;
    }
  }
  return out;
}
