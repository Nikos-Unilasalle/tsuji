import * as THREE from "three";

/**
 * Math coordinates and the world. Math puts z up; the world puts y up. A 2D
 * figure lies in the screen plane (x right, y up); a 3D one maps math x to
 * world X, math y to world −Z (into the scene) and math z to world Y — still
 * a right-handed frame, so cross products and orientations come out as on
 * paper. The Axes node builds this, scaled to its units and placed by its
 * own transform, and hands it on as one matrix; every math node takes that
 * matrix so its points land on the axes without anyone converting anything.
 */

export type MathDimension = "2D" | "3D";

/** Math → the axes' own frame, before units and placement. */
export function mathBasis(dimension: MathDimension): THREE.Matrix4 {
  if (dimension === "2D") return new THREE.Matrix4();
  // Columns are where math x, y, z go.
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0));
}

/** The full math → world matrix: placement × basis × units. */
export function spaceMatrix(pose: THREE.Matrix4, dimension: MathDimension, unit: THREE.Vector3): THREE.Matrix4 {
  return pose.clone().multiply(mathBasis(dimension)).multiply(new THREE.Matrix4().makeScale(unit.x || 1, unit.y || 1, unit.z || 1));
}

/** A wired space matrix, or plain math-as-world (2D, one unit per unit) when nothing is wired. */
export function readSpace(raw: unknown): THREE.Matrix4 {
  return raw instanceof THREE.Matrix4 ? raw : new THREE.Matrix4();
}

/**
 * A round tick spacing — 1, 2 or 5 times a power of ten — giving about
 * `target` ticks over the span. 0.37 to 8.2 gets ticks every 1, not 0.78.
 */
export function niceStep(span: number, target = 10): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / target;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

/** The multiples of `step` within [min, max], without floating-point crumbs (0.30000000000000004). */
export function ticks(min: number, max: number, step: number): number[] {
  if (!(step > 0) || !(max >= min)) return [];
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  if (last - first > 1000) return out;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let k = first; k <= last; k++) out.push(Number((k * step).toFixed(decimals)));
  return out;
}

/** A tick label as printed in a textbook: −2, 0.5, 1 000 is left alone, π multiples when asked. */
export function formatTick(value: number, piUnits = false): string {
  if (piUnits) {
    const k = Math.round((value / Math.PI) * 12) / 12;
    if (Math.abs(k * Math.PI - value) < 1e-9) return formatPi(k);
  }
  const text = Number(value.toPrecision(10)).toString();
  return text.replace("-", "−");
}

function formatPi(k: number): string {
  if (k === 0) return "0";
  const sign = k < 0 ? "−" : "";
  const a = Math.abs(k);
  for (const d of [1, 2, 3, 4, 6, 12]) {
    const n = Math.round(a * d);
    if (Math.abs(n / d - a) < 1e-9) {
      const num = n === 1 ? "π" : `${n}π`;
      return d === 1 ? `${sign}${num}` : `${sign}${num}/${d}`;
    }
  }
  return `${sign}${a}π`;
}
