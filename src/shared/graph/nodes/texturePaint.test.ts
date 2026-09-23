import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { TEXTURE_PAINT_NODE } from "./texturePaint";
import { TEXTURE_MIX_PAINT_NODE } from "./textureMixPaint";

const CTX_PAINT: EvalContext = { time: 0, step: 0, nodeId: "tex-paint-node-1" };
const CTX_MIX: EvalContext = { time: 0, step: 0, nodeId: "tex-mix-node-1" };

describe("TEXTURE_PAINT_NODE", () => {
  it("has correct metadata and sockets", () => {
    expect(TEXTURE_PAINT_NODE.type).toBe("texture/paint");
    expect(TEXTURE_PAINT_NODE.label).toBe("Texture Paint");
    expect(TEXTURE_PAINT_NODE.category).toBe("texture");
    expect(TEXTURE_PAINT_NODE.inputs.some((i) => i.id === "geometry")).toBe(true);
    expect(TEXTURE_PAINT_NODE.outputs.some((o) => o.id === "texture")).toBe(true);
    expect(TEXTURE_PAINT_NODE.outputs.some((o) => o.id === "geometry")).toBe(true);
  });

  it("evaluates without crashing and outputs texture & geometry", () => {
    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const res = TEXTURE_PAINT_NODE.evaluate(
      { geometry: boxMesh },
      TEXTURE_PAINT_NODE.defaultParams,
      CTX_PAINT,
    );

    expect(res.texture).toBeInstanceOf(THREE.Texture);
    expect(res.geometry).toBeInstanceOf(THREE.Object3D);
    expect((res.geometry as THREE.Mesh).userData.nodeId).toBe(CTX_PAINT.nodeId);
    expect(res.matrix).toBeInstanceOf(THREE.Matrix4);
  });
});

describe("TEXTURE_MIX_PAINT_NODE", () => {
  it("has dynamic texture sockets", () => {
    expect(TEXTURE_MIX_PAINT_NODE.type).toBe("texture/mix-paint");
    expect(TEXTURE_MIX_PAINT_NODE.label).toBe("Texture Mix");
    expect(TEXTURE_MIX_PAINT_NODE.category).toBe("texture");

    const dynamicInputs = TEXTURE_MIX_PAINT_NODE.dynamicInputs!([]);
    expect(dynamicInputs.some((i) => i.id === "texture0")).toBe(true);

    const connections = [
      { id: "c1", fromNode: "n1", fromSocket: "out", toNode: "mix", toSocket: "texture0" },
    ];
    const growing = TEXTURE_MIX_PAINT_NODE.dynamicInputs!(connections);
    expect(growing.some((i) => i.id === "texture0")).toBe(true);
    expect(growing.some((i) => i.id === "texture1")).toBe(true);
  });

  it("evaluates multi-layer splat map and outputs composite texture", () => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
    const t1 = new THREE.Texture();
    const t2 = new THREE.Texture();

    const res = TEXTURE_MIX_PAINT_NODE.evaluate(
      { geometry: plane, texture0: t1, texture1: t2 },
      TEXTURE_MIX_PAINT_NODE.defaultParams,
      CTX_MIX,
    );

    expect(res.texture).toBeInstanceOf(THREE.Texture);
    expect(res.splatMap).toBeInstanceOf(THREE.Texture);
    expect(res.geometry).toBeInstanceOf(THREE.Object3D);
  });
});
