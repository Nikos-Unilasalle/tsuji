import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { EvalContext, NodeInstance } from "../types";
import { EXPLODE_GLTF_ACTION, OBJECT_GLTF_NODE, explodeGltfToMeshData, gltfSourceDirectory, sanitizeFileNamePart } from "./gltfLoader";
import { evaluateGraph } from "../evaluate";
import { DEFAULT_REGISTRY } from "./index";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "gltf-test-1" };
const DUMMY_NODE: NodeInstance = { id: "gltf-test-1", type: "object/gltf", params: OBJECT_GLTF_NODE.defaultParams, position: { x: 0, y: 0 } };

// Khronos' minimal "Triangle" sample, built as a GLB (binary) blob rather
// than a .gltf JSON with a data-URI buffer: a data-URI buffer still goes
// through GLTFLoader's FileLoader, which dispatches `new ProgressEvent(...)`
// — undefined in this suite's Node test environment (no DOM). A GLB's binary
// chunk is read directly off the parsed ArrayBuffer with no FileLoader
// involved, matching how an actual .glb file loads through this node.
function buildTriangleGlb(): Uint8Array {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3", max: [1, 1, 0], min: [0, 0, 0] },
    ],
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = (jsonBytes.length + 3) & ~3;

  const bin = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const binBytes = new Uint8Array(bin.buffer);
  const binPadded = (binBytes.length + 3) & ~3;

  const totalLength = 12 + 8 + jsonPadded + 8 + binPadded;
  const buf = new ArrayBuffer(totalLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;

  view.setUint32(offset, 0x46546c67, true); offset += 4; // magic 'glTF'
  view.setUint32(offset, 2, true); offset += 4; // version
  view.setUint32(offset, totalLength, true); offset += 4;

  view.setUint32(offset, jsonPadded, true); offset += 4;
  view.setUint32(offset, 0x4e4f534a, true); offset += 4; // 'JSON'
  bytes.set(jsonBytes, offset);
  for (let i = jsonBytes.length; i < jsonPadded; i++) bytes[offset + i] = 0x20; // space-pad
  offset += jsonPadded;

  view.setUint32(offset, binPadded, true); offset += 4;
  view.setUint32(offset, 0x004e4942, true); offset += 4; // 'BIN\0'
  bytes.set(binBytes, offset);
  offset += binPadded;

  return bytes;
}

/** Same fixture as buildTriangleGlb, but with a material naming `doubleSided`. */
function buildTriangleGlbWithMaterial(doubleSided: boolean, materialExtra: Record<string, unknown> = {}, topLevelExtra: Record<string, unknown> = {}): Uint8Array {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ doubleSided, ...materialExtra }],
    ...topLevelExtra,
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3", max: [1, 1, 0], min: [0, 0, 0] },
    ],
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = (jsonBytes.length + 3) & ~3;

  const bin = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const binBytes = new Uint8Array(bin.buffer);
  const binPadded = (binBytes.length + 3) & ~3;

  const totalLength = 12 + 8 + jsonPadded + 8 + binPadded;
  const buf = new ArrayBuffer(totalLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;

  view.setUint32(offset, 0x46546c67, true); offset += 4;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, totalLength, true); offset += 4;

  view.setUint32(offset, jsonPadded, true); offset += 4;
  view.setUint32(offset, 0x4e4f534a, true); offset += 4;
  bytes.set(jsonBytes, offset);
  for (let i = jsonBytes.length; i < jsonPadded; i++) bytes[offset + i] = 0x20;
  offset += jsonPadded;

  view.setUint32(offset, binPadded, true); offset += 4;
  view.setUint32(offset, 0x004e4942, true); offset += 4;
  bytes.set(binBytes, offset);
  offset += binPadded;

  return bytes;
}

/** Same fixture as buildTriangleGlb, but with a TEXCOORD_0 accessor of known values. */
function buildTriangleGlbWithUvs(): Uint8Array {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
    buffers: [{ byteLength: 60 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 24, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3", max: [1, 1, 0], min: [0, 0, 0] },
      { bufferView: 1, byteOffset: 0, componentType: 5126, count: 3, type: "VEC2" },
    ],
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = (jsonBytes.length + 3) & ~3;

  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]); // glTF-convention V: top-left origin
  const bin = new Uint8Array(pos.byteLength + uv.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(uv.buffer), pos.byteLength);
  const binPadded = (bin.length + 3) & ~3;

  const totalLength = 12 + 8 + jsonPadded + 8 + binPadded;
  const buf = new ArrayBuffer(totalLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;

  view.setUint32(offset, 0x46546c67, true); offset += 4;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, totalLength, true); offset += 4;

  view.setUint32(offset, jsonPadded, true); offset += 4;
  view.setUint32(offset, 0x4e4f534a, true); offset += 4;
  bytes.set(jsonBytes, offset);
  for (let i = jsonBytes.length; i < jsonPadded; i++) bytes[offset + i] = 0x20;
  offset += jsonPadded;

  view.setUint32(offset, binPadded, true); offset += 4;
  view.setUint32(offset, 0x004e4942, true); offset += 4;
  bytes.set(bin, offset);
  offset += binPadded;

  return bytes;
}

describe("OBJECT_GLTF_NODE", () => {
  it("evaluates fallback mesh when no path is provided", () => {
    const res = OBJECT_GLTF_NODE.evaluate({}, OBJECT_GLTF_NODE.defaultParams, CTX);
    const group = res.geometry as THREE.Group;
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBeGreaterThan(0);
  });

  it("parses a valid .glb binary via onLoaded callback", async () => {
    const fields = OBJECT_GLTF_NODE.dynamicParamFields?.(DUMMY_NODE) ?? [];
    const fileFieldDef = fields.find((f) => f.id === "filePath") as any;
    expect(fileFieldDef).toBeDefined();

    fileFieldDef?.onLoaded?.("gltf-test-1", "triangle.glb", buildTriangleGlb());

    await vi.waitFor(() => {
      const res = OBJECT_GLTF_NODE.evaluate({}, OBJECT_GLTF_NODE.defaultParams, CTX);
      const group = res.geometry as THREE.Group;
      expect(group.children.length).toBe(1);
    });

    const res = OBJECT_GLTF_NODE.evaluate({}, OBJECT_GLTF_NODE.defaultParams, CTX);
    const group = res.geometry as THREE.Group;
    const scene = group.children[0] as THREE.Group;
    expect(scene).toBeInstanceOf(THREE.Object3D);

    let mesh: THREE.Mesh | null = null;
    scene.traverse((c) => {
      if (c instanceof THREE.Mesh) mesh = c;
    });
    expect(mesh).not.toBeNull();
    expect((mesh as unknown as THREE.Mesh).castShadow).toBe(true);
  });

  it("Visible param actually hides the object, end-to-end (evaluateGraph's generic visibility gate)", () => {
    const graph = {
      nodes: [{ id: "gltf-1", type: "object/gltf", position: { x: 0, y: 0 }, params: { ...OBJECT_GLTF_NODE.defaultParams, visible: 0 } }],
      connections: [],
    };
    const results = evaluateGraph(graph, DEFAULT_REGISTRY, { time: 0, step: 0, nodeId: "root" });
    const obj = results.get("gltf-1")?.geometry as THREE.Object3D;
    expect(obj).toBeInstanceOf(THREE.Object3D);
    expect(obj.visible).toBe(false);
  });
});

describe("explode into nodes", () => {
  const NODE_ID = "gltf-explode-1";
  const DUMMY = { id: NODE_ID, type: "object/gltf", params: OBJECT_GLTF_NODE.defaultParams, position: { x: 0, y: 0 } };

  async function loadTriangle(nodeId: string) {
    const field = OBJECT_GLTF_NODE.dynamicParamFields?.({ ...DUMMY, id: nodeId }) ?? [];
    const fileField = field.find((f) => f.id === "filePath") as any;
    fileField.onLoaded(nodeId, "triangle.glb", buildTriangleGlb());
    // Not "length === 1": the fallback cube already satisfies that the
    // instant onLoaded creates the node's state, before parse() has even
    // resolved. positions.length === 9 (the triangle's own 3 verts) is the
    // one signal that can't be true until the real async load has landed.
    await vi.waitFor(() => {
      expect(explodeGltfToMeshData(nodeId)[0]?.positions.length).toBe(9);
    });
  }

  it("returns nothing for a node that never loaded anything", () => {
    expect(explodeGltfToMeshData("gltf-never-loaded")).toEqual([]);
  });

  it("extracts one entry per mesh, with real vertex data", async () => {
    const nodeId = "gltf-explode-basic";
    OBJECT_GLTF_NODE.evaluate({}, OBJECT_GLTF_NODE.defaultParams, { ...CTX, nodeId });
    await loadTriangle(nodeId);

    const [mesh] = explodeGltfToMeshData(nodeId);
    // The fixture triangle: 3 vertices, non-indexed, no UVs supplied.
    expect(mesh.positions).toHaveLength(9);
    expect(mesh.index).toBeNull();
    expect(mesh.uvs).toEqual([]);
  });

  it("reads through to three's own implicit default material when a primitive names none", async () => {
    // glTF's own spec mandates a default material — metallicFactor: 1,
    // roughnessFactor: 1 — for a primitive naming none, and GLTFLoader
    // assigns it rather than leaving `.material` unset. So this exercises
    // the `std` branch, not the `undefined` fallback below it — worth
    // pinning explicitly, since it means that fallback is for a THREE.Mesh
    // built some other way, not a bare glTF.
    const nodeId = "gltf-explode-nomat";
    await loadTriangle(nodeId);
    const [mesh] = explodeGltfToMeshData(nodeId);
    expect(mesh.color).toBe(0xffffff);
    expect(mesh.roughness).toBe(1);
    expect(mesh.metalness).toBe(1);
    expect(mesh.opacity).toBe(1);
    expect(mesh.emissive).toBe(0x000000);
  });

  it("bakes the node's own pose into the vertices, so the exploded copy needs no parent transform", async () => {
    const nodeId = "gltf-explode-posed";
    await loadTriangle(nodeId);

    const atOrigin = explodeGltfToMeshData(nodeId)[0].positions;

    OBJECT_GLTF_NODE.evaluate(
      {},
      { ...OBJECT_GLTF_NODE.defaultParams, location: new THREE.Vector3(5, 0, 0) },
      { ...CTX, nodeId },
    );
    const moved = explodeGltfToMeshData(nodeId)[0].positions;

    // Every baked X coordinate shifted by exactly the Location offset.
    for (let i = 0; i < atOrigin.length; i += 3) {
      expect(moved[i]).toBeCloseTo(atOrigin[i] + 5);
    }
  });

  it("offers the Explode button only once a model has actually loaded", async () => {
    const nodeId = "gltf-explode-button";
    const before = OBJECT_GLTF_NODE.dynamicParamFields?.({ ...DUMMY, id: nodeId }) ?? [];
    expect(before.find((f) => f.id === "explodeButton")).toBeUndefined();

    await loadTriangle(nodeId);

    const after = OBJECT_GLTF_NODE.dynamicParamFields?.({ ...DUMMY, id: nodeId }) ?? [];
    const button = after.find((f) => f.id === "explodeButton") as any;
    expect(button).toBeDefined();
    expect(button.action).toBe(EXPLODE_GLTF_ACTION);
    expect(button.label).toContain("1");
  });

  it("reads doubleSided false by default", async () => {
    const nodeId = "gltf-explode-1side";
    const field = OBJECT_GLTF_NODE.dynamicParamFields?.({ ...DUMMY, id: nodeId }) ?? [];
    const fileField = field.find((f) => f.id === "filePath") as any;
    fileField.onLoaded(nodeId, "triangle.glb", buildTriangleGlbWithMaterial(false));
    await vi.waitFor(() => {
      expect(explodeGltfToMeshData(nodeId)[0]?.positions.length).toBe(9);
    });

    expect(explodeGltfToMeshData(nodeId)[0].doubleSided).toBe(false);
  });

  it("reads doubleSided true through from the glTF material", async () => {
    const nodeId = "gltf-explode-2side";
    const field = OBJECT_GLTF_NODE.dynamicParamFields?.({ ...DUMMY, id: nodeId }) ?? [];
    const fileField = field.find((f) => f.id === "filePath") as any;
    fileField.onLoaded(nodeId, "triangle.glb", buildTriangleGlbWithMaterial(true));
    await vi.waitFor(() => {
      expect(explodeGltfToMeshData(nodeId)[0]?.positions.length).toBe(9);
    });

    expect(explodeGltfToMeshData(nodeId)[0].doubleSided).toBe(true);
  });

  it("reads shadeless false for an ordinary lit (PBR) material", async () => {
    const nodeId = "gltf-explode-lit";
    const field = OBJECT_GLTF_NODE.dynamicParamFields?.({ ...DUMMY, id: nodeId }) ?? [];
    const fileField = field.find((f) => f.id === "filePath") as any;
    fileField.onLoaded(nodeId, "triangle.glb", buildTriangleGlbWithMaterial(false));
    await vi.waitFor(() => {
      expect(explodeGltfToMeshData(nodeId)[0]?.positions.length).toBe(9);
    });

    expect(explodeGltfToMeshData(nodeId)[0].shadeless).toBe(false);
  });

  it("reads shadeless true from a KHR_materials_unlit material, so the exploded copy doesn't silently upgrade to full PBR lighting", async () => {
    const nodeId = "gltf-explode-unlit";
    const field = OBJECT_GLTF_NODE.dynamicParamFields?.({ ...DUMMY, id: nodeId }) ?? [];
    const fileField = field.find((f) => f.id === "filePath") as any;
    fileField.onLoaded(
      nodeId,
      "triangle.glb",
      buildTriangleGlbWithMaterial(
        false,
        { extensions: { KHR_materials_unlit: {} } },
        { extensionsUsed: ["KHR_materials_unlit"] },
      ),
    );
    await vi.waitFor(() => {
      expect(explodeGltfToMeshData(nodeId)[0]?.positions.length).toBe(9);
    });

    expect(explodeGltfToMeshData(nodeId)[0].shadeless).toBe(true);
  });

  it("flips the V component of baked UVs to match the ordinary (non-glTF) texture loader's flipY=true convention", async () => {
    const nodeId = "gltf-explode-uvflip";
    const field = OBJECT_GLTF_NODE.dynamicParamFields?.({ ...DUMMY, id: nodeId }) ?? [];
    const fileField = field.find((f) => f.id === "filePath") as any;
    fileField.onLoaded(nodeId, "triangle.glb", buildTriangleGlbWithUvs());
    await vi.waitFor(() => {
      expect(explodeGltfToMeshData(nodeId)[0]?.uvs.length).toBe(6);
    });

    const [mesh] = explodeGltfToMeshData(nodeId);
    // Source UVs (glTF convention): (0,0), (1,0), (0,1) — expect V negated (1-v) on each.
    expect(mesh.uvs[0]).toBeCloseTo(0);
    expect(mesh.uvs[1]).toBeCloseTo(1);
    expect(mesh.uvs[2]).toBeCloseTo(1);
    expect(mesh.uvs[3]).toBeCloseTo(1);
    expect(mesh.uvs[4]).toBeCloseTo(0);
    expect(mesh.uvs[5]).toBeCloseTo(0);
  });

  it("has no textures to port when the fixture names none — map fields resolve to null rather than throwing", async () => {
    const nodeId = "gltf-explode-notex";
    await loadTriangle(nodeId);

    const [mesh] = explodeGltfToMeshData(nodeId);
    expect(mesh.map).toBeNull();
    expect(mesh.normalMap).toBeNull();
    expect(mesh.roughnessMap).toBeNull();
  });
});

describe("gltfSourceDirectory", () => {
  it("returns null for a node that never loaded anything", () => {
    expect(gltfSourceDirectory("gltf-nosrc-never-loaded")).toBeNull();
  });

  it("returns the empty string for a path with no directory component", async () => {
    const nodeId = "gltf-nosrc-flat";
    const field = OBJECT_GLTF_NODE.dynamicParamFields?.({ id: nodeId, type: "object/gltf", params: OBJECT_GLTF_NODE.defaultParams, position: { x: 0, y: 0 } }) ?? [];
    const fileField = field.find((f) => f.id === "filePath") as any;
    fileField.onLoaded(nodeId, "triangle.glb", buildTriangleGlb());
    await vi.waitFor(() => {
      expect(explodeGltfToMeshData(nodeId)[0]?.positions.length).toBe(9);
    });

    expect(gltfSourceDirectory(nodeId)).toBe("");
  });

  it("returns the containing directory for a nested path", async () => {
    const nodeId = "gltf-nosrc-nested";
    const field = OBJECT_GLTF_NODE.dynamicParamFields?.({ id: nodeId, type: "object/gltf", params: OBJECT_GLTF_NODE.defaultParams, position: { x: 0, y: 0 } }) ?? [];
    const fileField = field.find((f) => f.id === "filePath") as any;
    fileField.onLoaded(nodeId, "models/car/model.glb", buildTriangleGlb());
    await vi.waitFor(() => {
      expect(explodeGltfToMeshData(nodeId)[0]?.positions.length).toBe(9);
    });

    expect(gltfSourceDirectory(nodeId)).toBe("models/car");
  });
});

describe("sanitizeFileNamePart", () => {
  it("leaves an already-safe name alone", () => {
    expect(sanitizeFileNamePart("wheel_diffuse")).toBe("wheel_diffuse");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeFileNamePart("Body Color/Paint #1")).toBe("Body_Color_Paint_1");
  });

  it("trims leading and trailing underscores left by stripped characters", () => {
    expect(sanitizeFileNamePart("  wheel  ")).toBe("wheel");
  });

  it("falls back to a generic name for a name with no safe characters", () => {
    expect(sanitizeFileNamePart("###")).toBe("texture");
  });

  it("falls back to a generic name for an empty string", () => {
    expect(sanitizeFileNamePart("")).toBe("texture");
  });
});

/** A GLB whose header declares `required`, so GLTFLoader must have that decoder wired to get past parse. */
function buildGlbRequiring(required: string, extras: Record<string, unknown>): Uint8Array {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    extensionsRequired: [required],
    extensionsUsed: [required],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: 4 }],
    ...extras,
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binBytes = new Uint8Array(4);
  const binPadded = 4;
  const totalLength = 12 + 8 + jsonPadded + 8 + binPadded;
  const buf = new ArrayBuffer(totalLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;
  view.setUint32(offset, 0x46546c67, true); offset += 4;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, totalLength, true); offset += 4;
  view.setUint32(offset, jsonPadded, true); offset += 4;
  view.setUint32(offset, 0x4e4f534a, true); offset += 4;
  bytes.set(jsonBytes, offset);
  for (let i = jsonBytes.length; i < jsonPadded; i++) bytes[offset + i] = 0x20;
  offset += jsonPadded;
  view.setUint32(offset, binPadded, true); offset += 4;
  view.setUint32(offset, 0x004e4942, true); offset += 4;
  bytes.set(binBytes, offset);
  return bytes;
}

const DRACO_GLB = () => buildGlbRequiring("KHR_draco_mesh_compression", {
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } }] }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
  accessors: [{ componentType: 5126, count: 1, type: "VEC3" }],
});

const MESHOPT_GLB = () => buildGlbRequiring("EXT_meshopt_compression", {
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 4, count: 1, byteStride: 4, mode: "ATTRIBUTES" } } }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC3" }],
});

function fieldsOf(nodeId: string) {
  const node: NodeInstance = { id: nodeId, type: "object/gltf", params: OBJECT_GLTF_NODE.defaultParams, position: { x: 0, y: 0 } };
  return OBJECT_GLTF_NODE.dynamicParamFields?.(node) ?? [];
}

function fileFieldOf(nodeId: string) {
  return fieldsOf(nodeId).find((f) => f.id === "filePath") as any;
}

/** The warn note the panel shows when a pick failed, or undefined when it didn't. */
function errorNoteOf(nodeId: string): string | undefined {
  return fieldsOf(nodeId).find((f) => f.id === "loadError")?.label;
}

describe("OBJECT_GLTF_NODE compressed-glTF support", () => {
  it("gets a Draco file past parse instead of throwing out of it", () => {
    // Draco rejects at parse() *synchronously* when no decoder is wired, which
    // is what made this failure look like "nothing happened" before.
    const field = fileFieldOf("gltf-draco");
    expect(() => field.onLoaded("gltf-draco", "d.glb", DRACO_GLB())).not.toThrow();

    expect(errorNoteOf("gltf-draco")).toBeUndefined();
  });

  it("gets a meshopt file past parse instead of erroring on a missing decoder", () => {
    const field = fileFieldOf("gltf-meshopt");
    field.onLoaded("gltf-meshopt", "m.glb", MESHOPT_GLB());
    expect(errorNoteOf("gltf-meshopt")).toBeUndefined();
  });

  it("surfaces a failure as a readable note, not just a console line", () => {
    const field = fileFieldOf("gltf-broken");
    field.onLoaded("gltf-broken", "broken.glb", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

    const note = errorNoteOf("gltf-broken");
    expect(note).toMatch(/⚠/);
    // The raw message survives: an unanticipated cause is the one worth
    // reading word for word, and a label would have clipped it.
    expect((note ?? "").length).toBeGreaterThan(20);
    expect(fieldsOf("gltf-broken").find((f) => f.id === "loadError")?.kind).toBe("note");
  });

  it("clears a previous error once a good file loads", async () => {
    fileFieldOf("gltf-recover").onLoaded("gltf-recover", "broken.glb", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(errorNoteOf("gltf-recover")).toMatch(/⚠/);

    fileFieldOf("gltf-recover").onLoaded("gltf-recover", "triangle.glb", buildTriangleGlb());
    await vi.waitFor(() => {
      expect(errorNoteOf("gltf-recover")).toBeUndefined();
    });
  });
});

describe("OBJECT_GLTF_NODE malformed-file diagnostics", () => {
  it("names the shortfall when a .glb header declares more bytes than arrived", () => {
    // A real, valid GLB with its tail cut off — the truncated-download case.
    const full = buildTriangleGlb();
    const truncated = full.slice(0, full.length - 20);

    fileFieldOf("gltf-truncated").onLoaded("gltf-truncated", "cut.glb", truncated);

    const note = errorNoteOf("gltf-truncated") ?? "";
    expect(note).toMatch(/truncated/i);
    // The actual numbers, not just "something went wrong".
    expect(note).toContain(String(truncated.length));
    expect(note).toContain(full.length.toLocaleString());
    // Never the raw engine wording, which is what sent us round in circles.
    expect(note).not.toMatch(/Length out of range/i);
  });

  it("names the shortfall when a chunk overruns the file", () => {
    const glb = buildTriangleGlb();
    // Keep the declared total honest, but blow up the JSON chunk's length so
    // the chunk table itself is what overruns.
    new DataView(glb.buffer, glb.byteOffset).setUint32(12, 0xffff, true);

    fileFieldOf("gltf-badchunk").onLoaded("gltf-badchunk", "bad.glb", glb);
    expect(errorNoteOf("gltf-badchunk") ?? "").toMatch(/chunk at byte .* runs past the end/i);
  });

  it("calls a near-empty file too short rather than blaming its contents", () => {
    fileFieldOf("gltf-tiny").onLoaded("gltf-tiny", "tiny.glb", new Uint8Array(3));
    expect(errorNoteOf("gltf-tiny") ?? "").toMatch(/only 3 bytes/i);
  });

  it("leaves a well-formed .glb alone", () => {
    fileFieldOf("gltf-intact").onLoaded("gltf-intact", "ok.glb", buildTriangleGlb());
    expect(errorNoteOf("gltf-intact")).toBeUndefined();
  });
});

describe("OBJECT_GLTF_NODE glTF-level buffer diagnostics", () => {
  /** A GLB whose container is perfectly valid but whose JSON overreaches its BIN chunk. */
  function buildGlbWithJson(gltfJson: object, binLength: number): Uint8Array {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltfJson));
    const jsonPadded = (jsonBytes.length + 3) & ~3;
    const binPadded = (binLength + 3) & ~3;
    const totalLength = 12 + 8 + jsonPadded + 8 + binPadded;
    const buf = new ArrayBuffer(totalLength);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let offset = 0;
    view.setUint32(offset, 0x46546c67, true); offset += 4;
    view.setUint32(offset, 2, true); offset += 4;
    view.setUint32(offset, totalLength, true); offset += 4;
    view.setUint32(offset, jsonPadded, true); offset += 4;
    view.setUint32(offset, 0x4e4f534a, true); offset += 4;
    bytes.set(jsonBytes, offset);
    for (let i = jsonBytes.length; i < jsonPadded; i++) bytes[offset + i] = 0x20;
    offset += jsonPadded;
    view.setUint32(offset, binPadded, true); offset += 4;
    view.setUint32(offset, 0x004e4942, true); offset += 4;
    return bytes;
  }

  it("names the bufferView that reads past the end of the binary chunk", () => {
    // Container is intact — only the glTF-level numbers disagree, which is the
    // case the container check alone reported as clean.
    const glb = buildGlbWithJson({
      asset: { version: "2.0" },
      scene: 0, scenes: [{ nodes: [] }],
      buffers: [{ byteLength: 64 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 32 },
        { buffer: 0, byteOffset: 32, byteLength: 9999 },
      ],
    }, 64);

    fileFieldOf("gltf-badview").onLoaded("gltf-badview", "bad.glb", glb);

    const note = errorNoteOf("gltf-badview") ?? "";
    expect(note).toMatch(/bufferView #1/);
    expect(note).toMatch(/corrupt/i);
    expect(note).not.toMatch(/Length out of range/i);
  });

  it("reports a binary buffer smaller than the JSON claims", () => {
    const glb = buildGlbWithJson({
      asset: { version: "2.0" },
      scene: 0, scenes: [{ nodes: [] }],
      buffers: [{ byteLength: 4096 }],
      bufferViews: [],
    }, 64);

    fileFieldOf("gltf-shortbin").onLoaded("gltf-shortbin", "short.glb", glb);
    expect(errorNoteOf("gltf-shortbin") ?? "").toMatch(/binary buffer is 4,096 bytes, but the file only carries 64/);
  });

  it("does not flag a uri-backed buffer it cannot see", () => {
    const glb = buildGlbWithJson({
      asset: { version: "2.0" },
      scene: 0, scenes: [{ nodes: [] }],
      buffers: [{ byteLength: 999999, uri: "data:application/octet-stream;base64,AAAA" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 999999 }],
    }, 64);

    fileFieldOf("gltf-uribuf").onLoaded("gltf-uribuf", "uri.glb", glb);
    expect(errorNoteOf("gltf-uribuf") ?? "").not.toMatch(/corrupt|incomplete/i);
  });

  it("still leaves a well-formed .glb alone", () => {
    fileFieldOf("gltf-intact2").onLoaded("gltf-intact2", "ok.glb", buildTriangleGlb());
    expect(errorNoteOf("gltf-intact2")).toBeUndefined();
  });
});

describe("glTF Model material override", () => {
  it("leaves the file's own materials intact, and hands them back when turned off", () => {
    const ctx = { ...CTX, nodeId: "gltf-override" };
    const meshOf = (params: Record<string, unknown>) => {
      const group = OBJECT_GLTF_NODE.evaluate({}, { ...OBJECT_GLTF_NODE.defaultParams, ...params }, ctx).geometry as THREE.Group;
      let mesh: THREE.Mesh | undefined;
      group.traverse((c) => { if (c instanceof THREE.Mesh) mesh ??= c; });
      return mesh!;
    };

    const own = meshOf({ useOwnMaterials: 1 }).material as THREE.MeshStandardMaterial;
    const ownColor = own.color.getHex();

    const overridden = meshOf({ useOwnMaterials: 0, color: new THREE.Color(0xff0000) });
    expect(overridden.material).not.toBe(own);
    expect((overridden.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
    expect(own.color.getHex()).toBe(ownColor);

    expect(meshOf({ useOwnMaterials: 1 }).material).toBe(own);
  });
});
