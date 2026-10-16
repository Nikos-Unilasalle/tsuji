import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OBJECT_GLTF_NODE, GLTF_CHOOSE_FOLDER_ACTION, explodeGltfToMeshData } from "./gltfLoader";
import { clearBrowserFolder, addBrowserFiles, onFolderRequest, FolderRequest } from "../browserFiles";

const NODE = { id: "gltf-folder", type: "object/gltf", params: OBJECT_GLTF_NODE.defaultParams, position: { x: 0, y: 0 } };
const fields = () => OBJECT_GLTF_NODE.dynamicParamFields!(NODE);
const fileField = () => fields().find((f) => f.id === "filePath") as { onLoaded: (id: string, path: string, content: unknown) => void };
const note = () => fields().find((f) => f.id === "loadError") as { label: string } | undefined;
const folderButton = () => fields().find((f) => f.id === "chooseFolderButton") as { action?: string } | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const meshCount = (id: string) => explodeGltfToMeshData(id).length;

// A .gltf is the JSON half: its geometry is in tri.bin and its picture in textures/t.png, beside it.
const GLTF = JSON.stringify({
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ uri: "tri.bin", byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", max: [1, 1, 0], min: [0, 0, 0] }],
});

describe("a .gltf with separate files, in a browser", () => {
  // three reads a blob URL through FileLoader, which reports progress with a DOM event this Node suite does not have.
  beforeAll(() => {
    vi.stubGlobal("ProgressEvent", class extends Event {});
  });
  afterEach(() => clearBrowserFolder());

  it("asks for the folder instead of giving up, and offers to open the picker", async () => {
    const requests: FolderRequest[] = [];
    const stop = onFolderRequest((r) => requests.push(r));
    fileField().onLoaded(NODE.id, "scene.gltf", GLTF);
    await settle();
    stop();

    expect(requests).toEqual([{ needed: 1, pick: false }]);
    expect(note()?.label).toContain("tri.bin");
    expect(note()?.label).toContain("Choose the folder");
    expect(folderButton()?.action).toBe(GLTF_CHOOSE_FOLDER_ACTION);
  });

  it("finds the files in the folder the user chose, and stops asking", async () => {
    const requests: FolderRequest[] = [];
    const stop = onFolderRequest((r) => requests.push(r));
    addBrowserFiles([{ path: "model/tri.bin", file: new File([new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])], "tri.bin") }]);
    fileField().onLoaded(NODE.id, "scene.gltf", GLTF);
    await settle();
    stop();

    // The files were there: nothing to ask for, and the model loaded from them.
    expect(requests).toEqual([]);
    expect(meshCount(NODE.id)).toBe(1);
    expect(folderButton()).toBeUndefined();
    expect(note()?.label ?? "").not.toContain("Choose the folder");
  });
});

describe("a .gltf that arrives as bytes, as a dropped file does", () => {
  afterEach(() => clearBrowserFolder());

  it("is read for its separate files just like the text of it", async () => {
    const requests: FolderRequest[] = [];
    const stop = onFolderRequest((r) => requests.push(r));
    fileField().onLoaded(NODE.id, "dropped.gltf", new TextEncoder().encode(GLTF));
    await settle();
    stop();
    expect(requests).toEqual([{ needed: 1, pick: false }]);
  });
});
