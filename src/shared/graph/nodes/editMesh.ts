import * as THREE from "three";
import { NodeDefinition, NodeInstance, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { findFirstMesh } from "../meshRequired";
import {
  applyMaterialParams,
  clearAppliedMaterialSignature,
  materialParamsFromValue,
  primitiveOutputs,
  extractTextureParams,
  TextureParams,
  MaterialParams,
  NATIVE_TRANSFORM_PARAM_FIELDS,
  inheritSourceMaterial,
} from "./object";
import { asVector3, composeNativeMatrix, preserveModifierUserData } from "./transform";
import {
  QuadMesh,
  QuadMeshShading,
  createQuadBox,
  cloneQuadMesh,
  quadMeshToBufferGeometry,
  bufferGeometryToQuadMesh,
  geometrySignature,
  quadMeshSignature,
} from "../quadMesh";
import { convertSelection, MeshSelection, normalizeEdges, SelectMode } from "../mesh/selection";

const EDIT_MESH_NODE_TYPE = "modifier/edit-mesh";

export const EDIT_MESH_RESEED_ACTION = "edit-mesh/reseed";
export const EDIT_MESH_EXTRUDE_ACTION = "edit-mesh/extrude";
export const EDIT_MESH_INSET_ACTION = "edit-mesh/inset";
export const EDIT_MESH_UNWRAP_UVS_ACTION = "edit-mesh/unwrap-uvs";
export const EDIT_MESH_DELETE_FACES_ACTION = "edit-mesh/delete-faces";
export const EDIT_MESH_SEPARATE_FACES_ACTION = "edit-mesh/separate-faces";

/**
 * Resolves the effective QuadMesh for an Edit Mesh node:
 * 1. Returns frozen `node.params.meshData` if already edited / set.
 * 2. If not yet frozen, extracts the input geometry from evaluated results (or inputs).
 * 3. Falls back to a pristine unit quad box if no input geometry exists.
 */
export function resolveEditMeshData(
  node: { id: string; params: Record<string, unknown> },
  evaluatedResults?: Map<string, Record<string, unknown>> | null,
): QuadMesh {
  const meshData = node.params.meshData as QuadMesh | undefined;
  if (
    meshData &&
    typeof meshData === "object" &&
    Array.isArray(meshData.positions) &&
    meshData.positions.length > 0
  ) {
    return meshData;
  }

  // Check evaluated node output first: its geometry.userData.quadMesh holds the input quadMesh
  const evalResult = evaluatedResults?.get(node.id);
  const evalObj = evalResult?.geometry;
  const evalMesh = evalObj instanceof THREE.Object3D ? findFirstMesh(evalObj) : null;
  if (evalMesh?.geometry?.userData?.quadMesh) {
    return cloneQuadMesh(evalMesh.geometry.userData.quadMesh as QuadMesh);
  }

  // Check evaluated inputs if available
  const evalInputs = evalResult?.__evaluatedInputs as Record<string, unknown> | undefined;
  const inGeomObj = evalInputs?.geometry instanceof THREE.Object3D ? evalInputs.geometry : null;
  const inMesh = inGeomObj ? findFirstMesh(inGeomObj) : null;
  if (inMesh?.geometry) {
    return bufferGeometryToQuadMesh(inMesh.geometry);
  }

  if (evalMesh?.geometry) {
    return bufferGeometryToQuadMesh(evalMesh.geometry);
  }

  return createQuadBox(1, 1, 1);
}


const SELECTION_KEYS: Record<SelectMode, "selectedPoints" | "selectedEdges" | "selectedFaces"> = {
  points: "selectedPoints",
  edges: "selectedEdges",
  faces: "selectedFaces",
};

const indexList = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v) && v >= 0) : [];

/**
 * The select mode and the selection stored on an Edit Mesh (or Edit Mesh
 * Points, which only ever selects points) node.
 */
export function readEditMeshSelection(node: { type: string; params: Record<string, unknown> }): {
  mode: SelectMode;
  selection: MeshSelection;
  isPointsOnly: boolean;
} {
  const isPointsOnly = node.type !== EDIT_MESH_NODE_TYPE;
  const raw = node.params.selectMode;
  const mode: SelectMode = isPointsOnly ? "points" : raw === "points" || raw === "edges" ? raw : "faces";
  return {
    mode,
    isPointsOnly,
    selection: {
      points: indexList(node.params.selectedPoints),
      edges: normalizeEdges(node.params.selectedEdges),
      faces: indexList(node.params.selectedFaces),
    },
  };
}

/**
 * The param patch storing `selection`'s list for `mode`. Selection indices
 * only mean something against one fixed mesh, so the first non-empty
 * selection on a live (not yet frozen) Edit Mesh also freezes it: `quadMesh`
 * — what the selection was made on — is stored as meshData in the same
 * change. Edit Mesh Points has no meshData and just gets the selection.
 */
export function editMeshSelectionParams(
  node: { type: string; params: Record<string, unknown> },
  mode: SelectMode,
  selection: MeshSelection,
  quadMesh: QuadMesh,
): Record<string, unknown> {
  const key = SELECTION_KEYS[mode];
  const value = mode === "points" ? selection.points : mode === "edges" ? selection.edges : selection.faces;
  if (node.type === EDIT_MESH_NODE_TYPE && !node.params.meshData && value.length > 0) {
    return { [key]: value, meshData: cloneQuadMesh(quadMesh) };
  }
  return { [key]: value };
}

/**
 * Switching select mode carries the selection over (see convertSelection),
 * as Blender does, rather than dropping it.
 */
export function editMeshModeSwitchParams(
  node: { type: string; params: Record<string, unknown> },
  to: SelectMode,
  quadMesh: QuadMesh,
): Record<string, unknown> {
  const { mode, selection } = readEditMeshSelection(node);
  if (mode === to) return {};
  const converted = convertSelection(quadMesh, mode, selection, to);
  return { selectMode: to, ...editMeshSelectionParams(node, to, converted, quadMesh) };
}

interface EditMeshState {
  mesh?: THREE.Mesh;
  lastQuadMesh?: string;
  lastShading?: string;
  sourceGeometry?: THREE.BufferGeometry | null;
  /** geometrySignature() of the wired input, cached against its identity/version. */
  sourceSignature?: string;
  sourceSignatureKey?: string;
  sourceSignatureGeometry?: THREE.BufferGeometry | null;
  /** Whether the node is working from a stored copy (meshData) rather than the live input. */
  frozen?: boolean;
  /** Frozen, and the input no longer matches what it was frozen from. */
  inputChanged?: boolean;
}

const editMeshCache = createNodeCache<EditMeshState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(cache: typeof editMeshCache, nodeId: string): EditMeshState {
  let state = cache.get(nodeId);
  if (!state) {
    state = {};
    cache.set(nodeId, state);
  }
  return state;
}

/**
 * The input's signature, recomputed only when the geometry object or its
 * position/index buffers actually changed — an upstream node that rebuilds
 * nothing hands back the same geometry every frame.
 */
function sourceSignatureOf(state: EditMeshState, geom: THREE.BufferGeometry): string {
  const pos = geom.attributes.position;
  const posVersion = !pos ? -1 : "isInterleavedBufferAttribute" in pos ? pos.data.version : pos.version;
  const key = `${posVersion}:${geom.index?.version ?? -1}`;
  if (state.sourceSignatureGeometry !== geom || state.sourceSignatureKey !== key || !state.sourceSignature) {
    state.sourceSignature = geometrySignature(geom);
    state.sourceSignatureKey = key;
    state.sourceSignatureGeometry = geom;
  }
  return state.sourceSignature;
}

/** Freeze status for the param panel — see EditMeshState. */
export function editMeshFreezeStatus(nodeId: string): { frozen: boolean; inputChanged: boolean } {
  const state = editMeshCache.get(nodeId);
  return { frozen: Boolean(state?.frozen), inputChanged: Boolean(state?.inputChanged) };
}

function applyEditMeshMaterial(
  mesh: THREE.Mesh,
  srcMesh: THREE.Mesh | null,
  materialInput: unknown,
  texParams?: TextureParams,
) {
  const matParams = materialParamsFromValue(materialInput);
  if (matParams) {
    applyMaterialParams(mesh, matParams, THREE.DoubleSide, texParams);
    delete (mesh.material as any).__isDefaultClay;
    delete (mesh.material as any).__isSharedFromSrc;
    return;
  }

  // If texture sockets (Texture, Normal, Roughness) are connected directly
  if (texParams && (texParams.activeDiffuse || texParams.activeNormal || texParams.activeRoughness)) {
    const baseParams: MaterialParams = {
      color: new THREE.Color(0xffffff),
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 1.0,
      shadeless: false,
      roughness: 0.5,
      metalness: 0.05,
      wireframe: false,
      opacity: 1.0,
      transmission: 0,
      thickness: 0.5,
    };
    applyMaterialParams(mesh, baseParams, THREE.DoubleSide, texParams);
    delete (mesh.material as any).__isDefaultClay;
    delete (mesh.material as any).__isSharedFromSrc;
    return;
  }

  // A single material or a multi-material array alike: a multi-material
  // import carries per-face slots (QuadMesh.faceMaterials) that index into it.
  if (srcMesh && (srcMesh.material instanceof THREE.Material || Array.isArray(srcMesh.material))) {
    inheritSourceMaterial(mesh, srcMesh.material);
    clearAppliedMaterialSignature(mesh);
    (mesh.material as any).__isSharedFromSrc = true;
    delete (mesh.material as any).__isDefaultClay;
    return;
  }

  // Fallback: Default neutral clay material without any textures
  const defaultParams: MaterialParams = {
    color: new THREE.Color(0xcccccc),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: false,
    roughness: 0.5,
    metalness: 0.05,
    wireframe: false,
    opacity: 1.0,
    transmission: 0,
    thickness: 0.5,
  };
  applyMaterialParams(mesh, defaultParams, THREE.DoubleSide, undefined);
  (mesh.material as any).__isDefaultClay = true;
  delete (mesh.material as any).__isSharedFromSrc;
}

/**
 * The frame this node's own pose is composed on top of: the source mesh's
 * world matrix (when a Geometry is wired) followed by whatever the Matrix
 * socket carries.
 *
 * matrixWorld, not matrix: for a mesh nested under a posed wrapper group (an
 * OBJ Model bakes its pose onto the group) the mesh's own .matrix is identity.
 */
export function editMeshPoseParent(
  inputObj: THREE.Object3D | null,
  srcMesh: THREE.Mesh | null,
  wiredMatrix: unknown,
): THREE.Matrix4 {
  const parent = new THREE.Matrix4();
  if (inputObj && srcMesh) {
    inputObj.updateMatrixWorld(true);
    parent.copy(srcMesh.matrixWorld);
  }
  if (wiredMatrix instanceof THREE.Matrix4) parent.multiply(wiredMatrix);
  return parent;
}

/**
 * The node's final matrix: that parent frame, with this node's own
 * location/rotation/scale/pivot and the two inherit modes as the local pose on
 * top of it, exactly as a primitive's native pose works. With the default
 * identity pose this is the source's matrixWorld verbatim — the behaviour Edit
 * Mesh had before it owned a pose.
 */
function composeEditMeshMatrix(
  inputObj: THREE.Object3D | null,
  srcMesh: THREE.Mesh | null,
  wiredMatrix: unknown,
  params: Record<string, unknown>,
): { parent: THREE.Matrix4; matrix: THREE.Matrix4 } {
  const parent = editMeshPoseParent(inputObj, srcMesh, wiredMatrix);
  return {
    parent,
    matrix: composeNativeMatrix(parent, params.location, params.rotation, params.scale, params),
  };
}

/**
 * Writes that matrix onto the output mesh and carries the source object's
 * metadata across. matrixAutoUpdate is forced off rather than copied from the
 * source: an OBJ-parsed mesh defaults to true, which would have three's own
 * render loop recompute (and wipe) this matrix next frame.
 */
function applyEditMeshPose(
  mesh: THREE.Mesh,
  inputObj: THREE.Object3D | null,
  srcMesh: THREE.Mesh | null,
  wiredMatrix: unknown,
  params: Record<string, unknown>,
  nodeId: string,
): void {
  const { parent, matrix } = composeEditMeshMatrix(inputObj, srcMesh, wiredMatrix, params);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix);
  if (inputObj && srcMesh) {
    preserveModifierUserData(mesh, inputObj, srcMesh, nodeId);
  } else {
    mesh.userData = {};
  }
  mesh.userData.nodeId = nodeId;
  // The gizmo solves `own pose = dragged world pose × parent⁻¹`, and for every
  // other native-pose node that parent is just whatever is wired into `matrix`
  // — which the viewport reads straight off the graph. This node's parent also
  // includes the *source geometry's* world matrix, invisible from the graph, so
  // it has to publish it or a drag solves against the identity and the mesh
  // jumps by exactly the source's pose the moment a handle is grabbed.
  mesh.userData.poseParent = parent;
}

/**
 * This node owns a Pivot Offset of its own, and a node that has one
 * legitimately replaces the source's — but only once it has actually been
 * set. Left at its default of (0, 0, 0) it used to erase whatever the source
 * carried, so inserting an Edit Mesh silently moved the pivot marker, the
 * gizmo anchor and every downstream node's idea of the pivot back to the
 * object's origin.
 */
function pivotParams(params: Record<string, unknown>, mesh: THREE.Mesh): Record<string, unknown> {
  const own = asVector3(params.pivot, new THREE.Vector3());
  if (own.lengthSq() > 1e-9) return params;
  const inherited = mesh.userData?.pivot;
  return inherited ? { ...params, pivot: inherited } : params;
}

/**
 * One list for both the static and the dynamic field set, so the two can't
 * drift apart. Without an instance every optional field is included.
 */
function editMeshParamFields(instance?: NodeInstance): ParamFieldDef[] {
  const fields: ParamFieldDef[] = [];
  if (instance) {
    const status = editMeshFreezeStatus(instance.id);
    if (status.inputChanged) {
      fields.push({
        id: "inputChangedNote",
        label: "⚠ The input changed since this mesh was frozen. Freeze / Reset from Input picks it up — and discards the edits.",
        kind: "note",
        tone: "warn",
      });
    } else if (status.frozen) {
      fields.push({
        id: "frozenNote",
        label: "Frozen: edits apply to a stored copy of the input; upstream changes are ignored.",
        kind: "note",
      });
    }
  }
  fields.push(
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    { id: "shading", label: "Shading", kind: "select", options: ["auto", "smooth", "flat"] },
    { id: "extrudeDistance", label: "Extrude Distance", kind: "number", step: 0.05 },
    { id: "insetRatio", label: "Inset Amount (%)", kind: "number", step: 5, percent: true },
    { id: "flatAngle", label: "Flat Region Angle (°)", kind: "number", step: 1 },
    { id: "proportionalEditing", label: "Proportional Editing", kind: "boolean" },
  );
  if (!instance || instance.params?.proportionalEditing) {
    fields.push({ id: "proportionalDiameter", label: "Influence Diameter", kind: "number", step: 0.1 });
  }
  fields.push(
    { id: "reseedButton", label: "Freeze / Reset from Input", kind: "button", action: EDIT_MESH_RESEED_ACTION },
    { id: "unwrapButton", label: "Recalculate UVs", kind: "button", action: EDIT_MESH_UNWRAP_UVS_ACTION },
  );
  return fields;
}

/**
 * Edit Mesh node — comprehensive polygon / quad mesh editing node.
 * Supports box modeling workflow:
 * - Points and Faces selection modes
 * - Extrude, Inset, Loop Cut modeling operations
 * - Transform (loc/rot/scale) of selections around centroid
 * - Pure quad topology with no diagonal triangulation artifacts
 * - Shading options (auto, smooth, flat) and coherent UV unwrapping
 */
export const EDIT_MESH_NODE: NodeDefinition = {
  type: EDIT_MESH_NODE_TYPE,
  label: "Edit Mesh",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    // Same role as a primitive's Matrix socket: a parent pose applied
    // *outside* this node's own location/rotation/scale, composed on top of
    // the source geometry's world matrix when one is wired into Geometry.
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "material", label: "Material", type: "material" },
    { id: "texture", label: "Texture Map", type: "texture" },
    { id: "normal", label: "Normal Map", type: "texture" },
    { id: "roughnessMap", label: "Roughness Map", type: "texture" },
    { id: "uvScale", label: "UV Scale", type: "vector" },
    { id: "uvOffset", label: "UV Offset", type: "vector" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    meshData: null as QuadMesh | null,
    selectMode: "faces" as SelectMode,
    selectedPoints: [] as number[],
    selectedEdges: [] as [number, number][],
    selectedFaces: [] as number[],
    activeTool: "select" as "select" | "extrude" | "loopcut" | "inset",
    shading: "auto" as QuadMeshShading,
    extrudeDistance: 0.5,
    insetRatio: 0.25,
    proportionalEditing: false,
    proportionalDiameter: 1.0,
    // Pick through the surface (Alt+Z); off, hidden points/faces can't be selected.
    xray: false,
    // Select Flat Region grows across edges bending less than this, in degrees.
    flatAngle: 10,
    uvScale: [1, 1] as [number, number],
    uvOffset: [0, 0] as [number, number],
    // The same native pose every geometry node owns (see
    // NATIVE_TRANSFORM_PARAM_FIELDS / composeNativeMatrix). Defaults are the
    // identity, so an existing Edit Mesh keeps drawing at exactly the source
    // mesh's matrix as it did before it had a pose of its own.
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    showPivot: false,
    pivot: new THREE.Vector3(0, 0, 0),
    inheritRotation: "parent",
    inheritScale: "parent",
  },
  paramFields: editMeshParamFields(),
  dynamicParamFields: (instance: NodeInstance) => editMeshParamFields(instance),
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const srcMesh = inputObj ? findFirstMesh(inputObj) : null;
    const srcGeom = srcMesh?.geometry;

    const state = getState(editMeshCache, ctx.nodeId);
    const sourceSig = srcGeom ? sourceSignatureOf(state, srcGeom) : undefined;

    let quadMesh: QuadMesh;
    if (params.meshData && typeof params.meshData === "object" && Array.isArray((params.meshData as QuadMesh).positions)) {
      quadMesh = params.meshData as QuadMesh;
      state.frozen = true;
      // A copy frozen before signatures existed has nothing to compare
      // against, so it is never flagged rather than always flagged.
      state.inputChanged = Boolean(sourceSig && quadMesh.sourceSignature && quadMesh.sourceSignature !== sourceSig);
    } else if (srcGeom) {
      quadMesh = bufferGeometryToQuadMesh(srcGeom);
      // Carried into geometry.userData.quadMesh, which is what the viewport
      // clones into meshData the moment an edit freezes this node.
      quadMesh.sourceSignature = sourceSig;
      state.frozen = false;
      state.inputChanged = false;
    } else {
      quadMesh = createQuadBox(1, 1, 1);
      state.frozen = false;
      state.inputChanged = false;
    }

    const shadeMode = (params.shading as QuadMeshShading) || "auto";
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);

    const isSameSourceGeom = state.sourceGeometry === (srcGeom ?? null);
    const signature = quadMeshSignature(quadMesh);

    if (
      state.mesh &&
      state.lastQuadMesh === signature &&
      state.lastShading === shadeMode &&
      isSameSourceGeom
    ) {
      applyEditMeshPose(state.mesh, inputObj, srcMesh, inputs.matrix, params, ctx.nodeId);
      applyEditMeshMaterial(state.mesh, srcMesh, inputs.material, texParams);
      return primitiveOutputs(state.mesh, pivotParams(params, state.mesh));
    }

    const geometry = quadMeshToBufferGeometry(quadMesh, shadeMode);

    if (!state.mesh) {
      state.mesh = new THREE.Mesh(geometry);
      state.mesh.castShadow = true;
      state.mesh.receiveShadow = true;
    } else {
      state.mesh.geometry.dispose();
      state.mesh.geometry = geometry;
    }

    applyEditMeshMaterial(state.mesh, srcMesh, inputs.material, texParams);

    applyEditMeshPose(state.mesh, inputObj, srcMesh, inputs.matrix, params, ctx.nodeId);

    state.lastQuadMesh = signature;
    state.lastShading = shadeMode;
    state.sourceGeometry = srcGeom ?? null;

    return primitiveOutputs(state.mesh, pivotParams(params, state.mesh));
  },
};
