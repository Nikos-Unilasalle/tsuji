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

  it("paints every mesh with the palette, sharing it between materials, and passes the object through", () => {
    const group = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const b = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const c = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    group.add(a, b, c);
    const out = evaluate({ geometry: group, palette: grays(0, 0.5, 1) });
    expect(out.geometry).toBe(group);
    // Meshes that shared a material keep sharing; each source gets its own variant.
    expect(a.material).toBe(b.material);
    expect(c.material).not.toBe(a.material);
    expect((a.material as any).__isPaletteMaterial).toBe(true);
    const u = (a.material as any).__paletteUniforms;
    expect(u.uPaletteCount.value).toBe(3);
    // One palette for all of them, by reference.
    expect((c.material as any).__paletteUniforms).toBe(u);
  });

  it("keeps the alpha of the original material: map, alpha map, alpha test, opacity, sidedness", () => {
    const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
    const alphaMap = new THREE.DataTexture(new Uint8Array([255]), 1, 1);
    const original = new THREE.MeshStandardMaterial({
      map,
      alphaMap,
      alphaTest: 0.4,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), original);
    evaluate({ geometry: mesh });
    const painted = mesh.material as unknown as THREE.MeshLambertMaterial;
    expect(painted).not.toBe(original);
    expect(painted.map).toBe(map);
    expect(painted.alphaMap).toBe(alphaMap);
    expect(painted.alphaTest).toBe(0.4);
    expect(painted.transparent).toBe(true);
    expect(painted.opacity).toBe(0.7);
    expect(painted.side).toBe(THREE.DoubleSide);
    expect(painted.color.getHex()).toBe(0xffffff);
  });

  it("follows later changes to the original's alpha", () => {
    const original = new THREE.MeshStandardMaterial({ opacity: 1 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), original);
    evaluate({ geometry: mesh });
    original.opacity = 0.25;
    original.transparent = true;
    evaluate({ geometry: mesh });
    expect((mesh.material as unknown as THREE.MeshLambertMaterial).opacity).toBe(0.25);
    expect((mesh.material as unknown as THREE.MeshLambertMaterial).transparent).toBe(true);
  });

  it("brings a material's vertex patches along, and drops its fragment ones", () => {
    const original = new THREE.MeshStandardMaterial();
    original.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n// VERTEX_PATCH");
      shader.fragmentShader = shader.fragmentShader.replace("void main() {", "// FRAGMENT_PATCH\nvoid main() {");
      shader.uniforms.uProbe = { value: 1 };
    };
    original.customProgramCacheKey = () => "orig-key";
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original);
    evaluate({ geometry: mesh });
    const painted = mesh.material as unknown as THREE.MeshLambertMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    };
    painted.onBeforeCompile(shader as any, undefined as any);
    expect(shader.vertexShader).toContain("VERTEX_PATCH");
    expect(shader.fragmentShader).not.toContain("FRAGMENT_PATCH");
    expect(shader.uniforms.uProbe).toBeDefined();
    expect(painted.customProgramCacheKey()).toContain("orig-key");
  });

  it("lets a material with a palette adapter redraw itself (a leaf card cuts its blade)", () => {
    const leaf = new THREE.ShaderMaterial({ side: THREE.DoubleSide });
    (leaf as any).__paletteAdapter = {
      key: "test-leaf",
      patch: (shader: { fragmentShader: string }) => {
        shader.fragmentShader = shader.fragmentShader.replace("void main() {", "// ADAPTER\nvoid main() {");
      },
    };
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), leaf);
    evaluate({ geometry: mesh });
    const painted = mesh.material as unknown as THREE.MeshLambertMaterial;
    expect(painted.side).toBe(THREE.DoubleSide);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    };
    painted.onBeforeCompile(shader as any, undefined as any);
    expect(shader.fragmentShader).toContain("ADAPTER");
    expect(painted.customProgramCacheKey()).toContain("test-leaf");
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
