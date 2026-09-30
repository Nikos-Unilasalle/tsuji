import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyMaterialParams, extractMaterialParams, extractTextureParams, OBJECT_BOX_NODE } from "./object";

describe("triplanar texture mapping", () => {
  const texture = new THREE.Texture({ width: 4, height: 4 } as unknown as HTMLImageElement);
  const params = (triplanar: number) => ({ ...OBJECT_BOX_NODE.defaultParams, triplanar, triplanarBlend: 6, uvScaleX: 2, uvScaleY: 3 });
  const compile = (material: THREE.Material) => {
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n}",
      fragmentShader: "#include <common>\nvoid main() {\n#include <map_fragment>\n}",
    };
    material.onBeforeCompile(shader as never, undefined as never);
    return shader;
  };

  it("swaps the UV lookup for three planar samples, its settings as uniforms", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const p = params(1);
    const tex = { ...extractTextureParams({}, p, "tri-on"), activeDiffuse: texture };
    applyMaterialParams(mesh, extractMaterialParams({}, p), THREE.FrontSide, tex);
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.map).toBe(texture);
    expect(material.customProgramCacheKey()).toBe("tsuji-triplanar");

    const shader = compile(material);
    expect(shader.fragmentShader).not.toContain("#include <map_fragment>");
    expect(shader.fragmentShader).toContain("vTriPos.zy");
    expect(shader.vertexShader).toContain("vTriPos = position;");
    expect(shader.uniforms.uTriBlend.value).toBe(6);
    expect((shader.uniforms.uTriScale.value as THREE.Vector2).toArray()).toEqual([2, 3]);
  });

  it("puts three's own mapping back when turned off", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const on = params(1);
    applyMaterialParams(mesh, extractMaterialParams({}, on), THREE.FrontSide, { ...extractTextureParams({}, on, "tri-off"), activeDiffuse: texture });
    const off = params(0);
    applyMaterialParams(mesh, extractMaterialParams({}, off), THREE.FrontSide, { ...extractTextureParams({}, off, "tri-off"), activeDiffuse: texture });
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.customProgramCacheKey()).not.toBe("tsuji-triplanar");
    expect(compile(material).fragmentShader).toContain("#include <map_fragment>");
  });

  it("stays off with no texture to map", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const p = params(1);
    applyMaterialParams(mesh, extractMaterialParams({}, p), THREE.FrontSide, extractTextureParams({}, p, "tri-none"));
    expect((mesh.material as THREE.Material).customProgramCacheKey()).not.toBe("tsuji-triplanar");
  });
});
