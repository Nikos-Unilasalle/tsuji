import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { OBJECT_FBX_NODE } from "./fbxLoader";
import { DEFAULT_REGISTRY } from "./index";
import { MATERIAL_NODE } from "./material";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "fbx-test-1" };

describe("OBJECT_FBX_NODE", () => {
  it("is registered and shows a unit cube before any file loads", () => {
    expect(DEFAULT_REGISTRY.get("object/fbx")).toBe(OBJECT_FBX_NODE);
    const out = OBJECT_FBX_NODE.evaluate({}, OBJECT_FBX_NODE.defaultParams, CTX);
    expect(out.geometry).toBeInstanceOf(THREE.Group);
  });

  it("reports a file that is not an FBX instead of throwing", () => {
    const node = { id: "fbx-test-2", type: "object/fbx", params: OBJECT_FBX_NODE.defaultParams, position: { x: 0, y: 0 } };
    const field = OBJECT_FBX_NODE.dynamicParamFields!(node).find((f) => f.id === "filePath");
    if (!field || field.kind !== "file") throw new Error("no file field");
    field.onLoaded?.(node.id, "bad.fbx", new TextEncoder().encode("not an fbx at all"));
    const note = OBJECT_FBX_NODE.dynamicParamFields!(node).find((f) => f.id === "loadError");
    expect(note).toBeTruthy();
  });
});

describe("OBJECT_FBX_NODE texture inputs", () => {
  it("exposes texture, normal and roughness map sockets", () => {
    const ids = OBJECT_FBX_NODE.inputs.filter((i) => i.type === "texture").map((i) => i.id);
    expect(ids).toEqual(["diffuse", "normal", "roughness"]);
  });

  it("puts a wired map on every mesh", () => {
    const tex = new THREE.Texture({ width: 1, height: 1 } as unknown as HTMLImageElement);
    const ctx = { ...CTX, nodeId: "fbx-test-3" };
    const out = OBJECT_FBX_NODE.evaluate({ diffuse: tex, roughness: tex }, OBJECT_FBX_NODE.defaultParams, ctx);
    let found = false;
    (out.geometry as THREE.Object3D).traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.MeshStandardMaterial;
        found = m.map === tex && m.roughnessMap === tex;
      }
    });
    expect(found).toBe(true);
  });
});

describe("OBJECT_FBX_NODE UV controls", () => {
  it("tiles and offsets the wired map from the UV inputs", () => {
    const tex = new THREE.Texture({ width: 1, height: 1 } as unknown as HTMLImageElement);
    const ctx = { ...CTX, nodeId: "fbx-test-4" };
    const out = OBJECT_FBX_NODE.evaluate(
      { diffuse: tex, uvScale: new THREE.Vector3(3, 2, 0), uvOffset: new THREE.Vector3(0.5, 0.25, 0) },
      OBJECT_FBX_NODE.defaultParams,
      ctx,
    );
    let repeat: THREE.Vector2 | null = null;
    let offset: THREE.Vector2 | null = null;
    (out.geometry as THREE.Object3D).traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const map = (o.material as THREE.MeshStandardMaterial).map!;
        repeat = map.repeat.clone();
        offset = map.offset.clone();
      }
    });
    expect(repeat).toEqual(new THREE.Vector2(3, 2));
    expect(offset).toEqual(new THREE.Vector2(0.5, 0.25));
  });
});

describe("OBJECT_FBX_NODE material input", () => {
  it("lets a wired Material override the model's own materials", () => {
    const material = MATERIAL_NODE.evaluate({}, { ...MATERIAL_NODE.defaultParams, color: new THREE.Color(0xff0000) }, CTX).material;
    const ctx = { ...CTX, nodeId: "fbx-test-material" };
    const out = OBJECT_FBX_NODE.evaluate({ material }, OBJECT_FBX_NODE.defaultParams, ctx);
    const colors: number[] = [];
    (out.geometry as THREE.Object3D).traverse((o) => {
      if (o instanceof THREE.Mesh) colors.push((o.material as THREE.MeshStandardMaterial).color.getHex());
    });
    expect(colors).toEqual([0xff0000]);
  });
});
