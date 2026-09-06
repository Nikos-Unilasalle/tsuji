import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrixWithPivot } from "./transform";
import { COMMON_PRIMITIVE_OUTPUTS, TextureParams, applyMaterialParams, extractMaterialParams, primitiveOutputs } from "./object";

interface ObjState {
  group: THREE.Group;
  lastObjContent?: string;
  lastObjPath?: string;
  textureMap?: THREE.Texture;
  normalMap?: THREE.Texture;
  lastTexturePath?: string;
  lastNormalPath?: string;
}

const objStateCache = createNodeCache<ObjState>((state) => {
  disposeObject3D(state.group);
  state.textureMap?.dispose();
  state.normalMap?.dispose();
});

function getOrCreateObjState(nodeId: string): ObjState {
  const existing = objStateCache.get(nodeId);
  if (existing) return existing;

  // Default fallback mesh if no OBJ loaded yet (unit cube)
  const defaultMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8 })
  );
  defaultMesh.castShadow = true;
  defaultMesh.receiveShadow = true;
  defaultMesh.userData.nodeId = nodeId;

  const group = new THREE.Group();
  group.add(defaultMesh);

  const state: ObjState = { group };
  objStateCache.set(nodeId, state);
  return state;
}

/**
 * OBJ Model node — imports 3D .OBJ models with UV texture mapping, normal maps,
 * UV tiling/offset scaling, and PBR/Shadeless material controls.
 */
export const OBJECT_OBJ_NODE: NodeDefinition = {
  type: "object/obj",
  label: "OBJ Model",
  category: "object",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "diffuse", label: "Diffuse Map", type: "texture" },
    { id: "normal", label: "Normal Map", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "material", label: "Material", type: "material" },
    { id: "uvScale", label: "UV Scale", type: "vector" },
    { id: "uvOffset", label: "UV Offset", type: "vector" },
    // OBJ has no pivot concept of its own — vertices sit wherever the
    // exporting app left them relative to (0,0,0), which a plain
    // Transform always rotates/scales around. This lets rotation/scale
    // pivot around whatever point actually matches the model instead.
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
    texturePath: "",
    normalMapPath: "",
    color: new THREE.Color(0xffffff),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: 0,
    uvScaleX: 1,
    uvScaleY: 1,
    uvOffsetX: 0,
    uvOffsetY: 0,
    roughness: 0.5,
    metalness: 0.1,
    wireframe: 0,
    opacity: 1.0,
    transmission: 0,
    thickness: 0.5,
  },
  dynamicParamFields: () => [
    {
      id: "filePath",
      label: "3D Model (.obj)",
      kind: "file",
      accept: [".obj"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreateObjState(nodeId);
        state.lastObjPath = path;
        state.lastObjContent = content;

        try {
          const loader = new OBJLoader();
          const parsed = loader.parse(content);

          // Configure shadows & nodeId metadata on parsed child meshes
          parsed.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
              child.userData.nodeId = nodeId;
            }
          });

          state.group.clear();
          state.group.add(parsed);
        } catch (err) {
          console.error("Failed to parse OBJ file content:", err);
        }
      },
    },
    {
      id: "texturePath",
      label: "Diffuse Texture Map",
      kind: "file",
      accept: [".png", ".jpg", ".jpeg", ".webp"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreateObjState(nodeId);
        if (!path) {
          if (state.textureMap) {
            state.textureMap.dispose();
            state.textureMap = undefined;
          }
          state.lastTexturePath = undefined;
          state.group.traverse((c) => {
            if (c instanceof THREE.Mesh && c.material) {
              c.material.needsUpdate = true;
            }
          });
          return;
        }
        state.lastTexturePath = path;
        try {
          const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([content]);
          const url = URL.createObjectURL(blob);
          const texture = new THREE.TextureLoader().load(
            url,
            () => {
              URL.revokeObjectURL(url);
              state.group.traverse((c) => {
                if (c instanceof THREE.Mesh && c.material) {
                  c.material.needsUpdate = true;
                }
              });
            },
            undefined,
            () => URL.revokeObjectURL(url)
          );
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          state.textureMap = texture;
        } catch (err) {
          console.error("Failed to load texture image:", err);
        }
      },
    },
    {
      id: "normalMapPath",
      label: "Normal Map",
      kind: "file",
      accept: [".png", ".jpg", ".jpeg", ".webp"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreateObjState(nodeId);
        if (!path) {
          if (state.normalMap) {
            state.normalMap.dispose();
            state.normalMap = undefined;
          }
          state.lastNormalPath = undefined;
          state.group.traverse((c) => {
            if (c instanceof THREE.Mesh && c.material) {
              c.material.needsUpdate = true;
            }
          });
          return;
        }
        state.lastNormalPath = path;
        try {
          const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([content]);
          const url = URL.createObjectURL(blob);
          const texture = new THREE.TextureLoader().load(
            url,
            () => {
              URL.revokeObjectURL(url);
              state.group.traverse((c) => {
                if (c instanceof THREE.Mesh && c.material) {
                  c.material.needsUpdate = true;
                }
              });
            },
            undefined,
            () => URL.revokeObjectURL(url)
          );
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          state.normalMap = texture;
        } catch (err) {
          console.error("Failed to load normal map image:", err);
        }
      },
    },
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector" },
    { id: "showPivot", label: "Show Pivot", kind: "boolean", group: "Transform" },
    { id: "pivot", label: "Pivot", kind: "vector", group: "Transform" },
    { id: "color", label: "Color (fallback)", kind: "color" },
    { id: "emissive", label: "Emissive (Glow)", kind: "color" },
    { id: "emissiveIntensity", label: "Emissive Intensity", kind: "number", step: 0.1 },
    { id: "shadeless", label: "Shadeless (Unlit)", kind: "boolean" },
    { id: "uvScaleX", label: "UV Scale X (Tile)", kind: "number", step: 0.1 },
    { id: "uvScaleY", label: "UV Scale Y (Tile)", kind: "number", step: 0.1 },
    { id: "uvOffsetX", label: "UV Offset X", kind: "number", step: 0.05 },
    { id: "uvOffsetY", label: "UV Offset Y", kind: "number", step: 0.05 },
    { id: "roughness", label: "Roughness", kind: "number", step: 0.05 },
    { id: "metalness", label: "Metalness", kind: "number", step: 0.05 },
    { id: "wireframe", label: "Wireframe", kind: "boolean" },
    { id: "opacity", label: "Opacity", kind: "number", step: 0.05 },
    { id: "transmission", label: "Transmission (Glass)", kind: "number", step: 0.05, group: "Material" },
    { id: "thickness", label: "Glass Thickness", kind: "number", step: 0.05, group: "Material" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getOrCreateObjState(ctx.nodeId);
    const group = state.group;

    // Apply matrix transformation
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(
        composeNativeMatrixWithPivot(inputs.matrix, params.location, params.rotation, params.scale, inputs.pivot, params),
      );
    }

    const matParams = extractMaterialParams(inputs, params);

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

    const inputDiffuse = inputs.diffuse instanceof THREE.Texture && inputs.diffuse.image ? inputs.diffuse : null;
    const inputNormal = inputs.normal instanceof THREE.Texture && inputs.normal.image ? inputs.normal : null;

    const activeDiffuse = (inputDiffuse || state.textureMap) ?? null;
    const activeNormal = (inputNormal || state.normalMap) ?? null;
    const texParams: TextureParams = { activeDiffuse, activeNormal, activeRoughness: null, scaleX, scaleY, offsetX, offsetY };

    // Same shared material pipeline every other object node uses (Box,
    // Sphere, Curve to Mesh...) — this is what gets an OBJ the params that
    // pipeline supports (emissive glow, glass transmission) for free, and
    // keeps its material behaviour from silently drifting out of sync with
    // theirs. applyMaterialParams caches per-mesh (its own signature, not
    // a single one for the whole group) and only recompiles/re-uploads when
    // something actually changed, so it's cheap to call on every mesh every
    // frame — including a mesh that just got swapped in by loading a new OBJ,
    // which a single whole-group signature would otherwise miss.
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        applyMaterialParams(child, matParams, THREE.FrontSide, texParams);
      }
    });

    return primitiveOutputs(group, params);
  },
};
