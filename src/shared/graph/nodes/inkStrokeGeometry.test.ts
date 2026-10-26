import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createPRNG } from "../../math/random";
import { valueNoise3 } from "../../math/valueNoise";
import { Curve3, curvePlane, fromPlane, polylineCurve, strokeSamples, toPlane } from "../curveLists";
import { DEFAULT_PROFILE_POINTS, evalProfileCurve, ProfilePoint } from "../profileCurve";
import { buildStrokeGeometry } from "./ink";

// buildStrokeGeometry as it was before it moved to preallocated typed arrays,
// kept so the faster version is held to exactly the same vertices.
function profileAt(kind: string, t: number, curve: ProfilePoint[]): number {
  if (kind === "curve") return evalProfileCurve(curve, t);
  if (kind === "uniform") return 1;
  if (kind === "taper") return Math.cos((t * Math.PI) / 2);
  const s = Math.max(0, Math.sin(t * Math.PI));
  return kind === "blob" ? Math.sqrt(s) : s;
}
type Options = Parameters<typeof buildStrokeGeometry>[1];
function reference(curves: Curve3[], o: Options): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rng = createPRNG(o.seed * 7919 + 11);
  for (const curve of curves) {
    const pts = strokeSamples(curve);
    const n = pts.length;
    if (n < 2) continue;
    const plane = curvePlane(pts);
    const flat = pts.map((p) => toPlane(plane, p));
    const n0 = rng() * 100;
    const alpha = 1 - o.alphaJitter * rng();
    const base = positions.length / 3;
    for (let i = 0; i < n; i++) {
      const prev = flat[Math.max(0, i - 1)];
      const next = flat[Math.min(n - 1, i + 1)];
      let tu = next[0] - prev[0];
      let tv = next[1] - prev[1];
      const len = Math.hypot(tu, tv) || 1;
      tu /= len;
      tv /= len;
      const t = i / (n - 1);
      let w = o.width * profileAt(o.profile, t, o.profileCurve);
      w = w * (1 - o.widthNoise) + w * o.widthNoise * valueNoise3(i * 0.5, n0);
      w += o.minWidth;
      const shift = o.wobble * 2 * (valueNoise3(i * o.wobbleScale, n0 + 7) - 0.47);
      const [u, v, depth] = flat[i];
      const cu = u - tv * shift;
      const cv = v + tu * shift;
      const left = fromPlane(plane, cu - tv * w, cv + tu * w, depth + o.zOffset);
      const right = fromPlane(plane, cu + tv * w, cv - tu * w, depth + o.zOffset);
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
      colors.push(1, 1, 1, alpha, 1, 1, 1, alpha);
      if (i > 0) {
        const a = base + (i - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

function randomCurves(seed: number, count: number, plane: "xy" | "xz" | "yz"): Curve3[] {
  const rng = createPRNG(seed);
  const curves: Curve3[] = [];
  for (let c = 0; c < count; c++) {
    const pts: THREE.Vector3[] = [];
    const n = 2 + Math.floor(rng() * 30);
    for (let i = 0; i < n; i++) {
      const a = i * 0.3 + rng();
      const b = Math.sin(a) * 2 + rng();
      const flat = rng() * 0.01;
      pts.push(plane === "xy" ? new THREE.Vector3(a, b, flat) : plane === "xz" ? new THREE.Vector3(a, flat, b) : new THREE.Vector3(flat, b, a));
    }
    curves.push(c % 4 === 3 ? new THREE.LineCurve3(pts[0], pts[pts.length - 1]) : polylineCurve(pts));
  }
  return curves;
}

describe("buildStrokeGeometry", () => {
  for (const plane of ["xy", "xz", "yz"] as const) {
    for (const profile of ["sine", "blob", "taper", "uniform", "curve"]) {
      it(`matches the original vertex for vertex (${plane}, ${profile})`, () => {
        const options: Options = {
          width: 0.05,
          minWidth: 0.004,
          profile,
          profileCurve: DEFAULT_PROFILE_POINTS,
          widthNoise: 0.5,
          wobble: 0.02,
          wobbleScale: 0.3,
          alphaJitter: 0.4,
          zOffset: 0.002,
          seed: 7,
        };
        const curves = randomCurves(plane.charCodeAt(0) * 31 + profile.length, 12, plane);
        const got = buildStrokeGeometry(curves, options);
        const want = reference(curves, options);
        expect(Array.from(got.getAttribute("position").array)).toEqual(Array.from(want.getAttribute("position").array));
        expect(Array.from(got.getAttribute("color").array)).toEqual(Array.from(want.getAttribute("color").array));
        expect(Array.from(got.getIndex()!.array)).toEqual(Array.from(want.getIndex()!.array));
        expect(got.getIndex()!.array.constructor).toBe(want.getIndex()!.array.constructor);
      });
    }
  }

  it("builds an empty geometry from no curves", () => {
    const geometry = buildStrokeGeometry([], {
      width: 0.03, minWidth: 0.004, profile: "sine", profileCurve: DEFAULT_PROFILE_POINTS,
      widthNoise: 0.5, wobble: 0, wobbleScale: 0.3, alphaJitter: 0, zOffset: 0.002, seed: 0,
    });
    expect(geometry.getAttribute("position").count).toBe(0);
    expect(geometry.getIndex()!.count).toBe(0);
  });
});
