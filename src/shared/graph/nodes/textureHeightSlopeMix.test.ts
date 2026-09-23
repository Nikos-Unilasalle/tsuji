import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { TEXTURE_HEIGHT_SLOPE_MIX_NODE } from "./textureHeightSlopeMix";

const CTX_MIX: EvalContext = { time: 0, step: 0, nodeId: "tex-height-slope-mix-1" };

describe("TEXTURE_HEIGHT_SLOPE_MIX_NODE", () => {
  it("has correct metadata and sockets", () => {
    expect(TEXTURE_HEIGHT_SLOPE_MIX_NODE.type).toBe("texture/height-slope-mix");
    expect(TEXTURE_HEIGHT_SLOPE_MIX_NODE.label).toBe("Topography Texture Mix");
    expect(TEXTURE_HEIGHT_SLOPE_MIX_NODE.category).toBe("texture");
    expect(TEXTURE_HEIGHT_SLOPE_MIX_NODE.inputs.some((i) => i.id === "geometry")).toBe(true);
    expect(TEXTURE_HEIGHT_SLOPE_MIX_NODE.outputs.some((o) => o.id === "texture")).toBe(true);
    expect(TEXTURE_HEIGHT_SLOPE_MIX_NODE.outputs.some((o) => o.id === "splatMap")).toBe(true);
    expect(TEXTURE_HEIGHT_SLOPE_MIX_NODE.outputs.some((o) => o.id === "geometry")).toBe(true);
  });

  it("handles dynamic growing texture sockets", () => {
    const defaultDynamic = TEXTURE_HEIGHT_SLOPE_MIX_NODE.dynamicInputs!([]);
    expect(defaultDynamic.some((i) => i.id === "texture0")).toBe(true);
    expect(defaultDynamic.some((i) => i.id === "texture1")).toBe(true);
    expect(defaultDynamic.some((i) => i.id === "texture2")).toBe(true);

    const connections = [
      { id: "c1", fromNode: "n1", fromSocket: "out", toNode: "mix", toSocket: "texture3" },
    ];
    const growing = TEXTURE_HEIGHT_SLOPE_MIX_NODE.dynamicInputs!(connections);
    expect(growing.some((i) => i.id === "texture3")).toBe(true);
    expect(growing.some((i) => i.id === "texture4")).toBe(true);
  });

  it("evaluates procedural height & slope blending for incoming geometry", () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 4, 4), new THREE.MeshBasicMaterial());
    mesh.rotation.x = -Math.PI / 2;
    mesh.updateMatrixWorld(true);

    const t0 = new THREE.Texture();
    const t1 = new THREE.Texture();
    const t2 = new THREE.Texture();

    const res = TEXTURE_HEIGHT_SLOPE_MIX_NODE.evaluate(
      { geometry: mesh, texture0: t0, texture1: t1, texture2: t2 },
      TEXTURE_HEIGHT_SLOPE_MIX_NODE.defaultParams,
      CTX_MIX,
    );

    expect(res.texture).toBeInstanceOf(THREE.Texture);
    expect(res.splatMap).toBeInstanceOf(THREE.Texture);
    expect(res.geometry).toBeInstanceOf(THREE.Object3D);
    expect(res.matrix).toBeInstanceOf(THREE.Matrix4);
  });
});
