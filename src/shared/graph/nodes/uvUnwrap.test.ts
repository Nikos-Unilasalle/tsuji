import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { UV_UNWRAP_NODE, UV_METHODS, transformUVs } from "./uvUnwrap";
import { MATERIAL_WORN_NODE } from "./materialWorn";
import { applyMaterialParams } from "./object";
import type { EvalContext } from "../types";

const ctx = (nodeId: string): EvalContext => ({ nodeId, time: 0, step: 0 });
const run = (geometry: THREE.BufferGeometry | THREE.Object3D, params: Record<string, unknown> = {}, id = "uv", inputs: Record<string, unknown> = {}) => {
  const input = geometry instanceof THREE.Object3D ? geometry : new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const out = UV_UNWRAP_NODE.evaluate({ geometry: input, ...inputs }, { ...UV_UNWRAP_NODE.defaultParams, ...params }, ctx(id)) as any;
  return { mesh: out.geometry as THREE.Mesh, islands: out.islands as number };
};
const uvsOf = (mesh: THREE.Mesh) => Array.from(mesh.geometry.getAttribute("uv").array as Float32Array);

describe("UV Unwrap", () => {
  it("unwraps every method into the 0..1 square, keeping the shape", () => {
    for (const method of UV_METHODS) {
      const source = new THREE.SphereGeometry(1, 16, 12);
      const { mesh, islands } = run(source, { method }, `uv-${method}`);
      const uvs = uvsOf(mesh);
      expect(uvs.every(Number.isFinite), method).toBe(true);
      expect(Math.min(...uvs), method).toBeGreaterThanOrEqual(-1e-6);
      expect(Math.max(...uvs), method).toBeLessThanOrEqual(1 + 1e-6);
      expect(islands, method).toBeGreaterThan(0);
      // Same triangles, same places.
      expect(mesh.geometry.getAttribute("position").count).toBe(source.getIndex()!.count);
    }
  });

  it("cuts a box into its six faces with Smart, without overlaps between them", () => {
    const { mesh, islands } = run(new THREE.BoxGeometry(2, 1, 1, 2, 2, 2), { method: "smart" }, "uv-box-smart");
    expect(islands).toBe(6);
    // Each face's island has its own spot: the centres of the six faces' UVs differ.
    const uv = mesh.geometry.getAttribute("uv");
    const n = mesh.geometry.getAttribute("normal");
    const centres = new Map<string, [number, number, number]>();
    for (let i = 0; i < uv.count; i++) {
      const key = [n.getX(i), n.getY(i), n.getZ(i)].map(Math.round).join(",");
      const c = centres.get(key) ?? [0, 0, 0];
      centres.set(key, [c[0] + uv.getX(i), c[1] + uv.getY(i), c[2] + 1]);
    }
    const points = [...centres.values()].map(([u, v, k]) => [u / k, v / k]);
    expect(points).toHaveLength(6);
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      expect(Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1])).toBeGreaterThan(0.05);
    }
  });

  it("keeps the layout while the shape deforms (topology), and redoes it on demand (always)", () => {
    const base = new THREE.BoxGeometry(1, 1, 1, 3, 3, 3);
    const first = uvsOf(run(base, {}, "uv-deform").mesh);
    const moved = base.clone().scale(3, 1, 1);
    const { mesh } = run(moved, {}, "uv-deform");
    expect(uvsOf(mesh)).toEqual(first);
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.max.x).toBeCloseTo(1.5);

    run(base, { update: "always" }, "uv-always");
    const again = uvsOf(run(moved, { update: "always" }, "uv-always").mesh);
    expect(again).not.toEqual(first);
  });

  it("applies scale, rotation and offset about the centre without unwrapping again", () => {
    const raw = new Float32Array([0, 0, 1, 1]);
    expect(Array.from(transformUVs(raw, { scale: 2, rotation: 0, offset: [0, 0] }))).toEqual([-0.5, -0.5, 1.5, 1.5]);
    const turned = transformUVs(raw, { scale: 1, rotation: 90, offset: [0.25, 0] });
    expect(turned[0]).toBeCloseTo(1.25);
    expect(turned[1]).toBeCloseTo(0);
    const plain = uvsOf(run(new THREE.BoxGeometry(), {}, "uv-transform").mesh);
    const shifted = uvsOf(run(new THREE.BoxGeometry(), { offsetU: 0.5 }, "uv-transform").mesh);
    expect(shifted[0]).toBeCloseTo(plain[0] + 0.5);
  });

  it("keeps the input's material, normals and pose, and gives a Worn bake its UVs", () => {
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, ctx("uv-worn")) as any;
    const source = new THREE.Mesh(new THREE.TorusKnotGeometry(0.5, 0.15, 48, 8));
    source.geometry.deleteAttribute("uv");
    applyMaterialParams(source, res.material);
    source.position.set(2, 0, 0);
    source.updateMatrixWorld(true);
    const { mesh } = run(source, { method: "conformal" }, "uv-worn-unwrap");
    expect(mesh.material).toBe(res.material.customMaterial);
    expect(mesh.geometry.getAttribute("uv")).toBeDefined();
    expect(mesh.geometry.getAttribute("normal")).toBeDefined();
    expect(new THREE.Vector3().setFromMatrixPosition(mesh.matrix).x).toBeCloseTo(2);
  });

  it("passes through what isn't a mesh", () => {
    const group = new THREE.Group();
    const out = UV_UNWRAP_NODE.evaluate({ geometry: group }, UV_UNWRAP_NODE.defaultParams, ctx("uv-none")) as any;
    expect(out.geometry).toBe(group);
    expect(out.islands).toBe(0);
  });
});
