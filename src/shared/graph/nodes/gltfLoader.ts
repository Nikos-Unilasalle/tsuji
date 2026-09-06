import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrixWithPivot } from "./transform";
import { COMMON_PRIMITIVE_OUTPUTS, TextureParams, applyMaterialParams, extractMaterialParams, primitiveOutputs } from "./object";
import { isTauri } from "../../isTauri";
import { describeMissingResources, directoryOf, externalResourceUris, resolveExternalResources } from "./gltfExternalResources";

/**
 * The Draco decoder owns a worker pool, so it is created once and shared by
 * every loader rather than per file pick, which would leak a pool per import.
 *
 * No setDecoderPath: DRACOLoader already points decoderPaths at its own
 * wasm/js through `new URL(..., import.meta.url)`, which the bundler rewrites
 * to real hashed assets. Setting a path by hand would override that with a
 * copy we'd have to ship and keep in sync with three ourselves.
 */
let sharedDraco: DRACOLoader | null = null;

/**
 * Loaders are per-load rather than shared, because a model with external
 * files needs its *own* LoadingManager to rewrite their URLs, and a shared
 * manager would leak one model's rewrites into the next one's load.
 *
 * Both decoders are registered because neither is exotic — Draco is what
 * Blender's "Compression" checkbox and virtually every Sketchfab download
 * produce, and meshopt is glTF-Transform's default. Without them GLTFLoader
 * refuses the file outright: Draco by *throwing synchronously* out of
 * parse(), meshopt through the error callback. Either way the import used to
 * fail into a silent fallback cube.
 */
function makeGltfLoader(manager?: THREE.LoadingManager): GLTFLoader {
  const loader = new GLTFLoader(manager);
  if (!sharedDraco) sharedDraco = new DRACOLoader();
  loader.setDRACOLoader(sharedDraco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** The glTF JSON, from either form of the file, for inspecting what it references. */
function readGltfJson(data: ArrayBuffer | string): unknown | null {
  try {
    if (typeof data === "string") return JSON.parse(data);
    if (data.byteLength < GLB_HEADER_LENGTH) return null;
    if (new TextDecoder().decode(new Uint8Array(data, 0, 4)) !== GLB_MAGIC) return null;
    const view = new DataView(data);
    const declared = Math.min(view.getUint32(8, true), data.byteLength);
    let offset = GLB_HEADER_LENGTH;
    while (offset + 8 <= declared) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      offset += 8;
      if (offset + chunkLength > data.byteLength) return null;
      if (chunkType === 0x4e4f534a) {
        return JSON.parse(new TextDecoder().decode(new Uint8Array(data, offset, chunkLength)));
      }
      offset += chunkLength;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Loads a model whose buffers/images live in separate files next to it, by
 * reading each one off disk and serving it to three under its original URI.
 *
 * Only possible with real filesystem access: a browser `<input type="file">`
 * yields one chosen file and no way to reach its neighbours, so there the
 * honest answer is to say which files are missing and why.
 */
function loadWithExternalResources(
  gltfPath: string,
  data: ArrayBuffer | string,
  uris: string[],
  onLoaded: (gltf: { scene: THREE.Group }) => void,
  onError: (err: unknown) => void,
  onUnavailable: (message: string) => void,
): void {
  if (!isTauri()) {
    onUnavailable(
      `This .gltf keeps its data in separate files (${uris.slice(0, 3).join(", ")}${uris.length > 3 ? ", …" : ""}), which a browser file picker can't reach — it only ever hands over the one file you chose. Open the model in the desktop app, or export it as a single self-contained .glb.`,
    );
    return;
  }

  void (async () => {
    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const resolved = await resolveExternalResources(gltfPath, uris, readFile);
      if (resolved.missing.length > 0) {
        resolved.release();
        onUnavailable(describeMissingResources(resolved.missing, gltfPath));
        return;
      }

      const manager = new THREE.LoadingManager();
      // three resolves each glTF URI against the (empty) path it was given,
      // so what reaches the manager is the URI verbatim — the same string
      // used as the map key.
      manager.setURLModifier((url) => resolved.urlMap.get(url) ?? url);

      makeGltfLoader(manager).parse(
        data,
        "",
        (gltf) => {
          // Held until parse resolves: revoking earlier would pull the blobs
          // out from under textures three has not finished decoding.
          resolved.release();
          onLoaded(gltf);
        },
        (err) => {
          resolved.release();
          onError(err);
        },
      );
    } catch (err) {
      onError(err);
    }
  })();
}

const GLB_MAGIC = "glTF";
const GLB_HEADER_LENGTH = 12;

/**
 * Checks a .glb's own header against how many bytes actually arrived, and
 * returns a description of the mismatch (null when it's consistent).
 *
 * GLTFLoader reads each chunk with `new Uint8Array(data, offset, chunkLength)`
 * straight from the numbers in the file. When those numbers overrun the buffer
 * — a truncated download, a half-written export, Git LFS handing back a
 * pointer file — the browser throws a bare "Length out of range of buffer",
 * which says nothing about which file or how short it was. The same numbers
 * checked up front say exactly that.
 */
function describeGlbInconsistency(data: ArrayBuffer): string | null {
  const total = data.byteLength;
  if (total < GLB_HEADER_LENGTH) {
    return `The file is only ${total} bytes — too short to be a glTF binary at all. It may be an empty or failed download.`;
  }

  const view = new DataView(data);
  const magic = new TextDecoder().decode(new Uint8Array(data, 0, 4));
  // Not a GLB: three falls back to reading the whole buffer as glTF JSON,
  // which is a legitimate path, so this isn't ours to reject.
  if (magic !== GLB_MAGIC) return null;

  const declared = view.getUint32(8, true);
  if (declared > total) {
    return `This .glb is truncated: its header declares ${declared.toLocaleString()} bytes but only ${total.toLocaleString()} arrived (${Math.round((total / declared) * 100)}% of the file). Re-export or re-download it — if it came from Git, check whether Git LFS actually fetched it.`;
  }

  // Walk the chunk table the same way the loader will, so a chunk that
  // overruns is caught here rather than deep inside three.
  let offset = GLB_HEADER_LENGTH;
  let jsonChunk: string | null = null;
  let binChunkLength: number | null = null;
  while (offset + 8 <= Math.min(declared, total)) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + chunkLength > total) {
      return `This .glb is malformed: a chunk at byte ${offset} claims ${chunkLength.toLocaleString()} bytes, which runs past the end of the ${total.toLocaleString()}-byte file. It's most likely truncated or was written incompletely.`;
    }
    if (chunkType === 0x4e4f534a) jsonChunk = new TextDecoder().decode(new Uint8Array(data, offset, chunkLength));
    if (chunkType === 0x004e4942) binChunkLength = chunkLength;
    offset += chunkLength;
  }

  return jsonChunk ? describeGltfBufferOverrun(jsonChunk, binChunkLength) : null;
}

/**
 * The layer below the container: a GLB whose chunks all fit can still carry a
 * bufferView pointing past the end of the binary chunk it lives in, which is
 * where the loader's own typed-array reads blow up. Purely diagnostic, so any
 * surprise in here is swallowed — a validator that throws while explaining a
 * crash would be worse than no validator.
 */
function describeGltfBufferOverrun(jsonChunk: string, binChunkLength: number | null): string | null {
  try {
    const gltf = JSON.parse(jsonChunk) as {
      buffers?: { byteLength?: number; uri?: string }[];
      bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number }[];
    };

    const buffers = gltf.buffers ?? [];
    const views = gltf.bufferViews ?? [];

    // Buffer 0 of a GLB is the BIN chunk; the JSON's own byteLength for it
    // should agree with how big that chunk actually is.
    if (binChunkLength !== null && buffers[0] && typeof buffers[0].byteLength === "number" && buffers[0].uri === undefined) {
      const declaredBuffer = buffers[0].byteLength;
      if (declaredBuffer > binChunkLength) {
        return `This model's data is incomplete: it says its binary buffer is ${declaredBuffer.toLocaleString()} bytes, but the file only carries ${binChunkLength.toLocaleString()}. The export was very likely interrupted — re-export it.`;
      }
    }

    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      const bufferIndex = v.buffer ?? 0;
      const start = v.byteOffset ?? 0;
      const length = v.byteLength ?? 0;
      // Only buffer 0 of a GLB has a size we can trust here; a uri-backed
      // buffer isn't in this file at all.
      const capacity =
        bufferIndex === 0 && binChunkLength !== null && buffers[0]?.uri === undefined
          ? binChunkLength
          : buffers[bufferIndex]?.byteLength;
      if (typeof capacity !== "number") continue;
      if (start + length > capacity) {
        return `This model is corrupt: its bufferView #${i} reads bytes ${start.toLocaleString()}–${(start + length).toLocaleString()} of a buffer that is only ${capacity.toLocaleString()} bytes long. Re-export the model — this file can't be loaded as-is.`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Turns a loader failure into something a person can act on. The known causes
 * get a plain-language line and a way out; anything unrecognised keeps its raw
 * message, since a message nobody anticipated is exactly the one worth reading
 * verbatim.
 */
function describeLoadFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/DRACOLoader/i.test(message)) {
    return `Draco-compressed model: the decoder failed to load.\n\n${message}`;
  }
  if (/meshopt/i.test(message)) {
    return `Meshopt-compressed model: the decoder failed to load.\n\n${message}`;
  }
  if (/KTX2|basisu/i.test(message)) {
    return `This model uses KTX2/Basis textures, which aren't supported yet. Re-export with PNG/JPEG textures.\n\n${message}`;
  }
  if (/Unexpected token|JSON|Unexpected end/i.test(message)) {
    return `Not readable as glTF. A .gltf must have its buffers and textures embedded — external .bin/texture files aren't resolved. Export as .glb instead.\n\n${message}`;
  }
  // "Length out of range of buffer" / "Invalid typed array length" / "Offset is
  // outside the bounds of the DataView" — the same overrun, worded differently
  // per engine. describeGlbInconsistency normally catches these before parse
  // and says which numbers disagree; this is the backstop when it doesn't.
  if (/out of range|Invalid typed array length|outside the bounds/i.test(message)) {
    return `The file's internal sizes don't match how many bytes it actually has, so it's truncated or corrupt. Re-export or re-download it.\n\n${message}`;
  }
  return message;
}

/** Action id the Explode button sends up to App.tsx's onAction — see explodeGltfToMeshData. */
export const EXPLODE_GLTF_ACTION = "object/gltf-explode-to-nodes";

/**
 * The directory the loaded model itself lives in, so App.tsx can write
 * exploded textures out as real sibling files rather than leaving them
 * session-only. Null with nothing loaded, or a model whose bytes came in
 * some other way with no path of its own (there isn't one today, but the
 * check costs nothing and a null here is the correct "can't persist" signal
 * either way).
 */
export function gltfSourceDirectory(nodeId: string): string | null {
  const path = gltfStateCache.get(nodeId)?.lastPath;
  return path ? directoryOf(path) : null;
}

/** A texture baked back out to real file bytes, ready for the same onLoaded() path a manual file pick already takes. */
export interface ExplodedTexture {
  bytes: Uint8Array;
  fileName: string;
}

/**
 * Re-encodes a live THREE.Texture's decoded image back to PNG bytes.
 *
 * GLTFLoader has already done the actual decode (the texture's `.image` is a
 * real HTMLImageElement/ImageBitmap by the time a mesh exists at all) — this
 * only needs to get pixels back out, which a 2D canvas does synchronously via
 * `toDataURL`. Synchronous matters here: it keeps the whole Explode action a
 * single, ordinary graph edit rather than a multi-step async flow the rest of
 * the button-action machinery (App.tsx's onAction) doesn't expect.
 *
 * Not attempted for a compressed source (KTX2/Basis) — `.image` there is a
 * GPU-ready blob, not a decodable bitmap, and this app doesn't support KTX2
 * import in the first place (see describeLoadFailure).
 */
function textureToPngBytes(texture: THREE.Texture, fileName: string): ExplodedTexture | null {
  if (typeof document === "undefined") return null;
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width;
  const height = image?.height;
  if (!width || !height) return null;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image as CanvasImageSource, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, fileName };
  } catch (err) {
    console.error(`Explode into Nodes: could not re-encode a texture (${fileName}):`, err);
    return null;
  }
}

/** Flips the V component of a flat [u0,v0,u1,v1,...] array — see the comment at its call site for why. */
function flipUvV(uv: ArrayLike<number>): number[] {
  const out = new Array<number>(uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    out[i] = uv[i];
    out[i + 1] = 1 - uv[i + 1];
  }
  return out;
}

/** A name safe to use as a filename, derived from whatever the glTF happened to call the thing. */
export function sanitizeFileNamePart(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "texture";
}

/**
 * One mesh out of a loaded glTF, flattened to the same plain, JSON-serializable
 * shape "object/frozen" already accepts from Particle Render's Bake button —
 * so the result is a real graph node with no tie back to this one or the
 * loaded model.
 *
 * Vertices are baked in *world* space (the mesh's full matrixWorld, which
 * already includes this node's own Location/Rotation/Scale/Pivot) rather than
 * kept relative to the glTF's own hierarchy, so every new node comes out at
 * identity pose and already sits exactly where the piece appeared on screen —
 * no parent chain to reconstruct. The tradeoff is the same one Bake to Mesh
 * already accepts: the new nodes are independent copies, not tied to the
 * source, so moving or re-loading the glTF node afterward doesn't move them.
 *
 * Diffuse/normal/roughness maps are re-encoded to real PNG bytes (see
 * textureToPngBytes) and handed back alongside the PBR scalars, for App.tsx
 * to feed through the exact same file-field `onLoaded()` path a manual pick
 * already uses — so a textured model explodes looking like the original, not
 * just shaped like it. Several meshes sharing one material (routine on a
 * real model — a car's dozen chrome trim pieces, say) share one encode too,
 * memoized by the texture's own uuid rather than repeated per mesh.
 */
export interface ExplodedGltfMesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  index: number[] | null;
  color: number;
  roughness: number;
  metalness: number;
  opacity: number;
  emissive: number;
  emissiveIntensity: number;
  doubleSided: boolean;
  /** KHR_materials_unlit: GLTFLoader represents this as a MeshBasicMaterial, not a `std` field — read off the material's own class instead. */
  shadeless: boolean;
  map: ExplodedTexture | null;
  normalMap: ExplodedTexture | null;
  roughnessMap: ExplodedTexture | null;
}

export function explodeGltfToMeshData(nodeId: string): ExplodedGltfMesh[] {
  const state = gltfStateCache.get(nodeId);
  if (!state) return [];
  state.group.updateMatrixWorld(true);

  const textureCache = new Map<string, ExplodedTexture | null>();
  const encodeOnce = (texture: THREE.Texture | null, suffix: string, meshName: string): ExplodedTexture | null => {
    if (!texture) return null;
    const cached = textureCache.get(texture.uuid);
    if (cached !== undefined) return cached;
    const fileName = `${sanitizeFileNamePart(texture.name || meshName)}_${suffix}.png`;
    const result = textureToPngBytes(texture, fileName);
    textureCache.set(texture.uuid, result);
    return result;
  };

  const out: ExplodedGltfMesh[] = [];
  state.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const source = child.geometry;
    if (!source?.getAttribute("position")?.count) return;

    const baked = source.clone();
    baked.applyMatrix4(child.matrixWorld); // also rotates normals correctly (non-uniform scale included)

    const position = baked.getAttribute("position");
    const normal = baked.getAttribute("normal");
    const uv = baked.getAttribute("uv");
    const index = baked.getIndex();

    const material = Array.isArray(child.material) ? child.material[0] : child.material;
    const std = material as THREE.MeshStandardMaterial | undefined;
    const meshName = child.name || material?.name || "mesh";

    out.push({
      positions: Array.from(position.array as ArrayLike<number>),
      normals: normal ? Array.from(normal.array as ArrayLike<number>) : [],
      // glTF's own V origin is the top of the image; GLTFLoader compensates by
      // loading its textures with flipY=false. The exploded node's texture
      // fields go through the ordinary primitive file-load path instead (see
      // buildPrimitiveDynamicParamFields in object.ts), which defaults to
      // THREE's usual flipY=true — so without this, every ported UV samples
      // the wrong vertical band of a shared atlas (e.g. dashboard details
      // showing up on the hood). Flipping V here, once, keeps the baked UVs
      // correct for the consumer they're actually headed for.
      uvs: uv ? flipUvV(uv.array as ArrayLike<number>) : [],
      index: index ? Array.from(index.array as ArrayLike<number>) : null,
      color: std?.color?.getHex() ?? 0xffffff,
      roughness: std?.roughness ?? 0.5,
      metalness: std?.metalness ?? 0,
      opacity: std?.opacity ?? 1,
      emissive: std?.emissive?.getHex() ?? 0x000000,
      emissiveIntensity: std?.emissiveIntensity ?? 1,
      doubleSided: material?.side === THREE.DoubleSide,
      // KHR_materials_unlit doesn't survive onto the loaded THREE material as
      // a flag — GLTFLoader's own unlit extension just builds a
      // MeshBasicMaterial instead of the usual MeshStandardMaterial, so the
      // class is the only tell. Miss this and the exploded copy silently
      // upgrades to full PBR lighting — same look, much heavier to shade.
      shadeless: material instanceof THREE.MeshBasicMaterial,
      map: uv ? encodeOnce(std?.map ?? null, "diffuse", meshName) : null,
      normalMap: uv ? encodeOnce(std?.normalMap ?? null, "normal", meshName) : null,
      roughnessMap: uv ? encodeOnce(std?.roughnessMap ?? null, "roughness", meshName) : null,
    });
    baked.dispose();
  });
  return out;
}

interface GltfState {
  group: THREE.Group;
  lastPath?: string;
  /** Why the last pick failed, surfaced on the file field's own label. */
  loadError?: string;
  /** Real meshes in the last successfully loaded model — undefined until one loads, which is what gates the Explode button. */
  meshCount?: number;
}

const gltfStateCache = createNodeCache<GltfState>((s) => disposeObject3D(s.group));

function getOrCreateGltfState(nodeId: string): GltfState {
  const existing = gltfStateCache.get(nodeId);
  if (existing) return existing;

  // Default fallback mesh if no glTF loaded yet (unit cube), same convention
  // as OBJ Model's fallback.
  const defaultMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8 })
  );
  defaultMesh.castShadow = true;
  defaultMesh.receiveShadow = true;
  defaultMesh.userData.nodeId = nodeId;

  const group = new THREE.Group();
  group.add(defaultMesh);

  const state: GltfState = { group };
  gltfStateCache.set(nodeId, state);
  return state;
}

/**
 * glTF/GLB Model node — imports .gltf/.glb models.
 *
 * Self-contained files (a .glb, or a .gltf with data: URIs) load straight
 * from the bytes handed over. A .gltf that keeps its geometry and textures in
 * sibling files — what Sketchfab, Unity and Blender's "glTF Separate" all
 * emit — has those read off disk beside it and served to the loader; that
 * needs real filesystem access, so it works in the desktop app but not from a
 * browser file picker, which only ever yields the one chosen file.
 */
export const OBJECT_GLTF_NODE: NodeDefinition = {
  type: "object/gltf",
  label: "glTF Model",
  category: "object",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "material", label: "Material", type: "material" },
    // glTF has no pivot concept of its own — vertices sit wherever the
    // exporting app left them relative to (0,0,0), which a plain Transform
    // always rotates/scales around. This lets rotation/scale pivot around
    // whatever point actually matches the model instead.
    { id: "pivot", label: "Pivot", type: "vector" },
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    visible: 1,
    showPivot: false,
    pivot: new THREE.Vector3(0, 0, 0),
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    filePath: "",
    color: new THREE.Color(0xffffff),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: 0,
    roughness: 0.5,
    metalness: 0.1,
    wireframe: 0,
    opacity: 1.0,
    transmission: 0,
    thickness: 0.5,
    useOwnMaterials: 1,
  },
  dynamicParamFields: (instance) => [
    // A failed import used to look identical to no import at all — the
    // fallback cube, and an error only in the devtools console. As its own
    // note rather than part of the file field's label: these messages are
    // sentences, and a label is clipped to the panel's width.
    ...(gltfStateCache.get(instance.id)?.loadError
      ? [
          {
            id: "loadError",
            label: `⚠ ${gltfStateCache.get(instance.id)!.loadError}`,
            kind: "note" as const,
            tone: "warn" as const,
          },
        ]
      : []),
    {
      id: "filePath",
      label: "3D Model (.gltf/.glb)",
      kind: "file",
      accept: [".gltf", ".glb"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreateGltfState(nodeId);
        state.lastPath = path;
        state.loadError = undefined;
        if (!path) {
          state.group.clear();
          state.meshCount = undefined;
          return;
        }

        const fail = (err: unknown) => {
          state.loadError = describeLoadFailure(err);
          console.error("Failed to parse glTF file content:", err);
        };

        try {
          const data = content instanceof Uint8Array ? content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) : content;

          // Checked before handing it over: the loader's own failure for a
          // short file is an opaque engine-level RangeError.
          if (data instanceof ArrayBuffer) {
            const inconsistency = describeGlbInconsistency(data);
            if (inconsistency) {
              state.loadError = inconsistency;
              console.error("Refused glTF file:", inconsistency);
              return;
            }
          }

          const adopt = (gltf: { scene: THREE.Group }) => {
            let meshCount = 0;
            gltf.scene.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                child.userData.nodeId = nodeId;
                meshCount++;
              }
            });
            state.group.clear();
            state.group.add(gltf.scene);
            state.loadError = undefined;
            state.meshCount = meshCount;
          };

          // A .gltf is only the JSON half of a model: its geometry and images
          // usually sit beside it as separate files. Those have to be found
          // and served before parsing, or the loader reads whatever the page
          // answers with instead — see gltfExternalResources.ts.
          const external = externalResourceUris(readGltfJson(data) ?? {});
          if (external.length > 0) {
            loadWithExternalResources(path, data, external, adopt, fail, (message) => {
              state.loadError = message;
              console.error("Cannot load glTF:", message);
            });
            return;
          }

          // Draco throws straight out of parse() rather than routing to the
          // error callback, so both paths have to be handled.
          makeGltfLoader().parse(data, "", adopt, fail);
        } catch (err) {
          fail(err);
        }
      },
    },
    ...(gltfStateCache.get(instance.id)?.meshCount
      ? [
          {
            id: "explodeButton",
            label: `Explode into ${gltfStateCache.get(instance.id)!.meshCount} Nodes`,
            kind: "button" as const,
            action: EXPLODE_GLTF_ACTION,
          },
        ]
      : []),
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector" },
    { id: "showPivot", label: "Show Pivot", kind: "boolean", group: "Transform" },
    { id: "pivot", label: "Pivot", kind: "vector", group: "Transform" },
    {
      id: "useOwnMaterials",
      label: "Use Model's Own Materials",
      kind: "boolean",
      group: "Material",
    },
    { id: "color", label: "Color (fallback)", kind: "color", group: "Material" },
    { id: "emissive", label: "Emissive (Glow)", kind: "color", group: "Material" },
    { id: "emissiveIntensity", label: "Emissive Intensity", kind: "number", step: 0.1, group: "Material" },
    { id: "shadeless", label: "Shadeless (Unlit)", kind: "boolean", group: "Material" },
    { id: "roughness", label: "Roughness", kind: "number", step: 0.05, group: "Material" },
    { id: "metalness", label: "Metalness", kind: "number", step: 0.05, group: "Material" },
    { id: "wireframe", label: "Wireframe", kind: "boolean", group: "Material" },
    { id: "opacity", label: "Opacity", kind: "number", step: 0.05, group: "Material" },
    { id: "transmission", label: "Transmission (Glass)", kind: "number", step: 0.05, group: "Material" },
    { id: "thickness", label: "Glass Thickness", kind: "number", step: 0.05, group: "Material" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getOrCreateGltfState(ctx.nodeId);
    const group = state.group;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(
        composeNativeMatrixWithPivot(inputs.matrix, params.location, params.rotation, params.scale, inputs.pivot, params),
      );
    }

    // glTF ships PBR materials per-mesh (base color, metallic/roughness maps,
    // etc.) that OBJ never carries — overwriting them with the shared
    // primitive material pipeline by default would flatten every imported
    // model to a single flat color. Only override when the user explicitly
    // asks to (matching the graph a Material socket, or dialling in the
    // fallback color/roughness/etc. by hand).
    const useOwnMaterials = params.useOwnMaterials !== undefined ? Boolean(params.useOwnMaterials) : true;
    if (!useOwnMaterials) {
      const matParams = extractMaterialParams(inputs, params);
      const texParams: TextureParams = { activeDiffuse: null, activeNormal: null, activeRoughness: null, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          applyMaterialParams(child, matParams, THREE.FrontSide, texParams);
        }
      });
    }

    return primitiveOutputs(group, params);
  },
};
