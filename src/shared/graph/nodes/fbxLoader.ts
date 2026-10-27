import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrixWithPivot } from "./transform";
import { COMMON_PRIMITIVE_OUTPUTS, TextureParams, applyMaterialParams, extractMaterialParams, inheritSourceMaterial, materialParamsFromValue, primitiveOutputs } from "./object";

/** A 1×1 white pixel, served in place of any texture file FBXLoader asks for that isn't embedded in the .fbx. */
const WHITE_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * FBX keeps its textures as file references (a path on the exporter's disk) unless
 * they were embedded. FBXLoader would turn each reference into a request that 404s;
 * only the bytes already in the file (blob:/data: URLs) are real, so everything else
 * gets a white pixel — the material keeps its color and the console stays clean.
 */
function makeFbxLoader(): FBXLoader {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (url.startsWith("blob:") || url.startsWith("data:") ? url : WHITE_PIXEL));
  return new FBXLoader(manager);
}

function describeLoadFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/Unknown format|Unsupported|version/i.test(message)) {
    return `Not readable as FBX (only FBX 7.x is supported). Re-export it from your 3D app as FBX 2013 or newer.\n\n${message}`;
  }
  return message;
}

interface FbxState {
  group: THREE.Group;
  lastPath?: string;
  /** Why the last pick failed, surfaced as a note above the file field. */
  loadError?: string;
  /** Each mesh's material as the file shipped it — what "Use Own Materials" puts back. */
  originalMaterials: WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>;
  /** Owner of the override material while "Use Own Materials" is off — see evaluate. */
  overrideHolder?: THREE.Mesh;
}

function recordOriginalMaterials(state: FbxState, root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh && !state.originalMaterials.has(child)) {
      state.originalMaterials.set(child, child.material);
    }
  });
}

const fbxStateCache = createNodeCache<FbxState>((s) => {
  // The file's own materials go back first, so they're the ones disposed —
  // the override on the meshes is the holder's, disposed with it.
  s.group.traverse((child) => {
    const original = child instanceof THREE.Mesh ? s.originalMaterials.get(child) : undefined;
    if (original) (child as THREE.Mesh).material = original;
  });
  disposeObject3D(s.group);
  if (s.overrideHolder) disposeObject3D(s.overrideHolder);
});

function getOrCreateFbxState(nodeId: string): FbxState {
  const existing = fbxStateCache.get(nodeId);
  if (existing) return existing;

  // Unit cube until a model loads, same convention as the OBJ and glTF nodes.
  const defaultMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x38bdf8 }));
  defaultMesh.castShadow = true;
  defaultMesh.receiveShadow = true;
  defaultMesh.userData.nodeId = nodeId;

  const group = new THREE.Group();
  group.add(defaultMesh);

  const state: FbxState = { group, originalMaterials: new WeakMap() };
  recordOriginalMaterials(state, group);
  fbxStateCache.set(nodeId, state);
  return state;
}

/**
 * FBX Model node — imports binary or ASCII .fbx models (FBX 7.x).
 *
 * Geometry, hierarchy and materials come across; textures only when embedded in
 * the file, since a reference to the exporter's disk can't be resolved here.
 * Wiring Texture / Normal / Roughness Map inputs swaps the file's materials for the
 * node's own PBR one carrying those maps.
 * FBX files are often authored in centimeters, so a model may need Scale 0.01.
 */
export const OBJECT_FBX_NODE: NodeDefinition = {
  type: "object/fbx",
  label: "FBX Model",
  category: "object",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "diffuse", label: "Texture Map", type: "texture" },
    { id: "normal", label: "Normal Map", type: "texture" },
    { id: "roughness", label: "Roughness Map", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "uvScale", label: "UV Scale", type: "vector" },
    { id: "uvOffset", label: "UV Offset", type: "vector" },
    { id: "material", label: "Material", type: "material" },
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
    uvScaleX: 1,
    uvScaleY: 1,
    uvOffsetX: 0,
    uvOffsetY: 0,
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
    ...(fbxStateCache.get(instance.id)?.loadError
      ? [
          {
            id: "loadError",
            label: `⚠ ${fbxStateCache.get(instance.id)!.loadError}`,
            kind: "note" as const,
            tone: "warn" as const,
          },
        ]
      : []),
    {
      id: "filePath",
      label: "3D Model (.fbx)",
      kind: "file",
      accept: [".fbx"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreateFbxState(nodeId);
        state.lastPath = path;
        state.loadError = undefined;
        if (!path) {
          state.group.clear();
          return;
        }

        try {
          const data = content instanceof Uint8Array ? content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) : content;
          // FBXLoader.parse reads both forms: it sniffs the "Kaydara FBX Binary" header, else treats it as ASCII text.
          const root = makeFbxLoader().parse(data, "");
          root.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
              child.userData.nodeId = nodeId;
            }
          });
          recordOriginalMaterials(state, root);
          state.group.clear();
          state.group.add(root);
        } catch (err) {
          state.loadError = describeLoadFailure(err);
          console.error("Failed to parse FBX file content:", err);
        }
      },
    },
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector" },
    { id: "uvScaleX", label: "UV Scale X (Tile)", kind: "number", step: 0.1, group: "Material" },
    { id: "uvScaleY", label: "UV Scale Y (Tile)", kind: "number", step: 0.1, group: "Material" },
    { id: "uvOffsetX", label: "UV Offset X", kind: "number", step: 0.05, group: "Material" },
    { id: "uvOffsetY", label: "UV Offset Y", kind: "number", step: 0.05, group: "Material" },
    { id: "showPivot", label: "Show Pivot", kind: "boolean", group: "Transform" },
    { id: "pivot", label: "Pivot", kind: "vector", group: "Transform" },
    { id: "useOwnMaterials", label: "Use Model's Own Materials", kind: "boolean", group: "Material" },
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
    const state = getOrCreateFbxState(ctx.nodeId);
    const group = state.group;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(
        composeNativeMatrixWithPivot(inputs.matrix, params.location, params.rotation, params.scale, inputs.pivot, params),
      );
    }

    const textureInput = (v: unknown) => (v instanceof THREE.Texture && v.image ? v : null);
    const activeDiffuse = textureInput(inputs.diffuse);
    const activeNormal = textureInput(inputs.normal);
    const activeRoughness = textureInput(inputs.roughness);
    // A wired map can only show on the node's own PBR material (the file's
    // Phong/Lambert ones have no roughness slot), so wiring one takes over
    // from the file's materials just like switching them off does.
    let scaleX = Number(params.uvScaleX) || 1;
    let scaleY = Number(params.uvScaleY) || 1;
    if (inputs.uvScale instanceof THREE.Vector3) {
      scaleX = inputs.uvScale.x;
      scaleY = inputs.uvScale.y;
    }
    let offsetX = Number(params.uvOffsetX) || 0;
    let offsetY = Number(params.uvOffsetY) || 0;
    if (inputs.uvOffset instanceof THREE.Vector3) {
      offsetX = inputs.uvOffset.x;
      offsetY = inputs.uvOffset.y;
    }
    const textured = Boolean(activeDiffuse || activeNormal || activeRoughness);

    // The override is built once on a mesh of this node's own and handed to
    // every mesh, never edited into the file's materials, so turning
    // "Use Own Materials" back on can hand them back.
    const useOwnMaterials = params.useOwnMaterials !== undefined ? Boolean(params.useOwnMaterials) : true;
    // A wired Material is an explicit ask, like a wired map: it wins over the
    // file's materials whatever the checkbox says.
    const wiredMaterial = materialParamsFromValue(inputs.material) !== null;
    let override: THREE.Material | THREE.Material[] | undefined;
    if (!useOwnMaterials || textured || wiredMaterial) {
      const matParams = extractMaterialParams(inputs, params);
      const texParams: TextureParams = { activeDiffuse, activeNormal, activeRoughness, scaleX, scaleY, offsetX, offsetY };
      state.overrideHolder ??= new THREE.Mesh();
      applyMaterialParams(state.overrideHolder, matParams, THREE.FrontSide, texParams);
      override = state.overrideHolder.material;
    }
    recordOriginalMaterials(state, group);
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (override) inheritSourceMaterial(child, override);
      else child.material = state.originalMaterials.get(child) ?? child.material;
    });

    return primitiveOutputs(group, params);
  },
};
