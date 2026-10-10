import * as THREE from "three";
import { beforeEach, describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { disposeNodeCaches } from "../nodeCaches";
import { resetMeshWarnings } from "../meshRequired";
import { PALETTE_SHADE_NODE, buildPalette, paletteColorsFromList, resamplePalette } from "./paletteShade";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "palette-test" };
const evaluate = (inputs: Record<string, unknown>, params: Record<string, unknown> = {}) =>
  PALETTE_SHADE_NODE.evaluate(inputs, { ...PALETTE_SHADE_NODE.defaultParams, ...params }, CTX) as Record<string, any>;

const grays = (...v: number[]) => v.map((x) => new THREE.Color(x, x, x));

beforeEach(() => {
  disposeNodeCaches(CTX.nodeId);
  resetMeshWarnings();
});

describe("palette helpers", () => {
  it("keeps only colours from a list", () => {
    const out = paletteColorsFromList([new THREE.Color(1, 0, 0), 5, null, true, "#00ff00"]);
    expect(out).toHaveLength(2);
  });

  it("keeps the palette as is when steps is 0", () => {
    expect(resamplePalette(grays(0, 0.5, 1), 0)).toHaveLength(3);
  });

  it("reduces to fewer steps spread over the range, keeping both ends", () => {
    const out = resamplePalette(grays(0, 0.25, 0.5, 0.75, 1), 3);
    expect(out.map((c) => c.r)).toEqual([0, 0.5, 1]);
  });

  it("interpolates when asked for more steps", () => {
    const out = resamplePalette(grays(0, 1), 3);
    expect(out.map((c) => c.r)).toEqual([0, 0.5, 1]);
  });

  it("sorts dark to light and falls back to a default palette", () => {
    expect(buildPalette(grays(1, 0, 0.5), 0, true).map((c) => c.r)).toEqual([0, 0.5, 1]);
    expect(buildPalette([], 0, true).length).toBeGreaterThan(1);
  });
});

describe("PALETTE_SHADE_NODE", () => {
  it("returns null geometry with nothing wired", () => {
    expect(evaluate({}).geometry).toBeNull();
  });

  it("paints every mesh with one palette material and passes the object through", () => {
    const group = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    group.add(a, b);
    const out = evaluate({ geometry: group, palette: grays(0, 0.5, 1) });
    expect(out.geometry).toBe(group);
    expect(a.material).toBe(b.material);
    expect((a.material as any).__isPaletteMaterial).toBe(true);
    const u = (a.material as any).__paletteUniforms;
    expect(u.uPaletteCount.value).toBe(3);
  });

  it("honours Steps, and works with the node's own ramp when no palette is wired", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    evaluate({ geometry: mesh, steps: 5 });
    expect(((mesh.material as any).__paletteUniforms).uPaletteCount.value).toBe(5);
  });

  it("gives the original material back when unwired", () => {
    const original = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original);
    evaluate({ geometry: mesh });
    expect(mesh.material).not.toBe(original);
    evaluate({});
    expect(mesh.material).toBe(original);
  });

  it("builds a shader that keeps shadows out of the bands", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    evaluate({ geometry: mesh });
    const shader = { uniforms: {} as Record<string, unknown>, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
    (mesh.material as THREE.Material).onBeforeCompile(shader as any, undefined as any);
    expect(shader.fragmentShader).toContain("pcShadow = ");
    expect(shader.fragmentShader).not.toContain("directLight.color *=");
    expect(shader.fragmentShader).not.toContain("#include <lights_fragment_begin>");
    expect(Object.keys(shader.uniforms)).toContain("uPalette");
  });
});
