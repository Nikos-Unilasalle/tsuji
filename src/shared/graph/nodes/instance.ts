import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeTransform, extractPositionFromInput } from "./transform";
import { DEFAULT_ROTATION_MODE, ROTATION_MODE_FIELD } from "../rotationMode";

const groupCache = createNodeCache<THREE.Group>(disposeObject3D);

/**
 * Cloned materials for Set Instance Color, keyed by (instance, mesh, source
 * material). The node re-clones its whole input every frame, so cloning the
 * material along with it allocated — and leaked — one THREE.Material per mesh
 * per frame. Reusing the clone and writing only `.color` keeps the per-frame
 * work to a colour copy, and the prune below releases the ones whose source
 * went away.
 */
const instanceMaterialCache = createNodeCache<Map<string, THREE.Material>>((m) => {
  m.forEach((mat) => mat.dispose());
});

function getMaterialCache(nodeId: string): Map<string, THREE.Material> {
  let cache = instanceMaterialCache.get(nodeId);
  if (!cache) {
    cache = new Map();
    instanceMaterialCache.set(nodeId, cache);
  }
  return cache;
}

function getGroup(nodeId: string): THREE.Group {
  const existing = groupCache.get(nodeId);
  if (existing) return existing;
  const group = new THREE.Group();
  groupCache.set(nodeId, group);
  return group;
}

function asColor(v: unknown, fallback: THREE.Color): THREE.Color {
  if (v instanceof THREE.Color) return v;
  if (typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v) {
    const { r, g, b } = v as { r: number; g: number; b: number };
    return new THREE.Color(r, g, b);
  }
  if (typeof v === "string" || typeof v === "number") {
    try {
      return new THREE.Color(v as any);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function asVector(v: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (v instanceof THREE.Vector3) return v;
  if (typeof v === "number") return new THREE.Vector3(v, v, v);
  if (typeof v === "object" && v !== null && "x" in v && "y" in v) {
    const obj = v as { x: number; y: number; z?: number };
    return new THREE.Vector3(Number(obj.x) || 0, Number(obj.y) || 0, Number(obj.z) || 0);
  }
  return fallback;
}

function listValueAt(list: unknown[], index: number, fallback: number): number {
  if (index < list.length) {
    const val = Number(list[index]);
    return Number.isFinite(val) ? val : fallback;
  }
  return fallback;
}

/** Helper to get top-level instance elements from a geometry (or children if it's a Group) */
function getInstances(source: THREE.Object3D): THREE.Object3D[] {
  if (source instanceof THREE.Group && source.children.length > 0) {
    return source.children;
  }
  return [source];
}

/**
 * Instances carry their transform in `matrix` with `matrixAutoUpdate` off (the
 * Array node writes it directly), which a plain `clone()` would leave for the
 * next `updateMatrixWorld` to overwrite from position/quaternion/scale.
 */
function cloneInstance(instance: THREE.Object3D): THREE.Object3D {
  const clone = instance.clone(true);
  clone.matrixAutoUpdate = instance.matrixAutoUpdate;
  clone.matrix.copy(instance.matrix);
  clone.matrixWorldNeedsUpdate = true;
  return clone;
}

/** Index value that targets every instance rather than a single one. */
const ALL_INSTANCES = -1;

/**
 * Which frame a relative transform is applied in — the difference between
 * `final = delta × placement` and `final = placement × delta`.
 *
 * - "shared": the delta acts in the pack's own space, *before* each
 *   instance's placement. Every instance therefore turns about the pack's
 *   origin — the source object's pivot — so a rotation swings the whole
 *   arrangement around like a carousel and a translation moves it bodily.
 * - "individual": the delta acts in each instance's own space, *after* its
 *   placement, so each one spins about its own origin and stays where the
 *   Array put it. Offsets are read in the instance's own axes too, which is
 *   what makes "push every instance along its own normal" expressible.
 *
 * Both are useful and neither is a special case of the other, hence a
 * switch rather than a fix.
 */
const PIVOT_OPTIONS = ["shared", "individual"];

/**
 * Which instance a Set Instance node writes to. The default (-1) keeps the
 * node's original behaviour — every instance — so an index is opt-in: wire the
 * Proximity node's `index` in to touch only the nearest instance, and leave it
 * alone to drive the whole pack. An index past the end of the pack targets
 * nothing, rather than wrapping around, so a stale index can't silently modify
 * an unrelated instance.
 */
function resolveTargetIndex(input: unknown, param: unknown): number {
  const raw = input !== undefined ? Number(input) : Number(param);
  return Number.isFinite(raw) ? Math.floor(raw) : ALL_INSTANCES;
}

function isTargeted(index: number, targetIndex: number): boolean {
  return targetIndex < 0 || index === targetIndex;
}

/** Unit vector for an axis name ("X" / "Y" / "Z" / "-X" / …) used by align mode. */
function alignAxisVector(axis: string): THREE.Vector3 {
  switch (axis) {
    case "X": return new THREE.Vector3(1, 0, 0);
    case "Y": return new THREE.Vector3(0, 1, 0);
    case "-X": return new THREE.Vector3(-1, 0, 0);
    case "-Y": return new THREE.Vector3(0, -1, 0);
    case "-Z": return new THREE.Vector3(0, 0, -1);
    default: return new THREE.Vector3(0, 0, 1); // "Z"
  }
}

/** Quaternion rotating `from` onto `to`, robust to anti-parallel directions. */
function quaternionAlignAxis(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  const fromN = from.clone().normalize();
  const toN = to.clone().normalize();
  const dot = fromN.dot(toN);
  if (dot > 0.999999) return new THREE.Quaternion();
  if (dot < -0.999999) {
    // 180° about any axis perpendicular to `from` — setFromUnitVectors would
    // produce a degenerate rotation here.
    const perp = Math.abs(fromN.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const axis = new THREE.Vector3().crossVectors(fromN, perp).normalize();
    return new THREE.Quaternion().setFromAxisAngle(axis, Math.PI);
  }
  return new THREE.Quaternion().setFromUnitVectors(fromN, toN);
}

const INSTANCE_INDEX_INPUT = { id: "index", label: "Index (-1 = All)", type: "value" } as const;

const INSTANCE_INDEX_FIELD = { id: "index", label: "Index (-1 = All)", kind: "number", step: 1 } as const;

/**
 * Set Instance Color node — applies individual colors to each object/instance in a geometry pack.
 * Colors are driven by a List of colors (e.g. from Color Palette or Random List).
 */
export const SET_INSTANCE_COLOR_NODE: NodeDefinition = {
  type: "structure/instance-color",
  label: "Set Instance Color",
  category: "instance",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "colors", label: "Colors", type: "list" },
    { id: "color", label: "Default Color", type: "color" },
    INSTANCE_INDEX_INPUT,
    // Same 1-based id-list targeting as Instance Transform — see its own
    // input for the full rationale. Takes priority over `index` when
    // non-empty; each targeted instance still pulls its own colour from
    // `colors` by its own array index, not one shared item.
    { id: "ids", label: "Target IDs (List, 1-based)", type: "list" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: { color: new THREE.Color(0xffffff), index: ALL_INSTANCES },
  paramFields: [
    { id: "color", label: "Default Color", kind: "color" },
    INSTANCE_INDEX_FIELD,
  ],
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();

    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!source) return { geometry: group };

    const instances = getInstances(source);
    const colorsList = Array.isArray(inputs.colors) ? inputs.colors : [];
    const defaultColor = asColor(inputs.color, asColor(params.color, new THREE.Color(0xffffff)));
    const targetIndex = resolveTargetIndex(inputs.index, params.index);
    const targetIdsInput = Array.isArray(inputs.ids) ? inputs.ids : [];
    const targetIdSet = targetIdsInput.length > 0
      ? new Set(
          targetIdsInput
            .map((v) => Math.floor(Number(v)) - 1)
            .filter((n) => Number.isFinite(n) && n >= 0),
        )
      : null;
    // Own-index colour lookup in ids-list mode, same as ALL_INSTANCES —
    // never the "one shared item" a lone scalar `index` broadcasts.
    const listIndex = targetIdSet ? ALL_INSTANCES : targetIndex;
    const materialCache = getMaterialCache(ctx.nodeId);
    const liveMaterialKeys = new Set<string>();

    instances.forEach((instance, i) => {
      const clone = cloneInstance(instance);

      if (!(targetIdSet ? targetIdSet.has(i) : isTargeted(i, targetIndex))) {
        group.add(clone);
        return;
      }

      const colorItem = listIndex >= 0
        ? (colorsList.length === 1 ? colorsList[0] : colorsList[listIndex % (colorsList.length || 1)])
        : colorsList[i % (colorsList.length || 1)];

      const targetColor = colorsList.length > 0
        ? asColor(colorItem, defaultColor)
        : defaultColor;

      // Apply color to all meshes and lights inside this instance
      let meshOrdinal = 0;
      clone.traverse((child) => {
        if (child instanceof THREE.Light) {
          child.color.copy(targetColor);
        }
        if (child instanceof THREE.Mesh && child.material) {
          const ordinal = meshOrdinal++;
          const sources = Array.isArray(child.material) ? child.material : [child.material];
          const tinted = sources.map((src, slot) => {
            // The source uuid is part of the key so an upstream node that
            // rebuilds its material gets a fresh clone rather than a stale one.
            const key = `${i}:${ordinal}:${slot}:${src.uuid}`;
            liveMaterialKeys.add(key);
            const cached = materialCache.get(key);
            const mat: THREE.Material = cached ?? src.clone();
            if (!cached) materialCache.set(key, mat);
            if ("color" in mat) {
              (mat as THREE.MeshStandardMaterial).color.copy(targetColor);
            }
            return mat;
          });
          child.material = Array.isArray(child.material) ? tinted : tinted[0];
        }
      });

      group.add(clone);
    });

    // Release the clones nothing referenced this frame (instance count dropped,
    // an upstream material was rebuilt, the index moved).
    for (const [key, mat] of materialCache) {
      if (!liveMaterialKeys.has(key)) {
        mat.dispose();
        materialCache.delete(key);
      }
    }

    return { geometry: group };
  },
};

function resolveScalarOrListItem(
  inputVal: unknown,
  instanceIndex: number,
  targetIndex: number,
  fallback: number
): number {
  if (Array.isArray(inputVal)) {
    if (inputVal.length === 0) return fallback;
    const idx = targetIndex >= 0 ? (inputVal.length === 1 ? 0 : targetIndex % inputVal.length) : instanceIndex;
    return listValueAt(inputVal, idx, fallback);
  }
  if (inputVal !== undefined && inputVal !== null) {
    const num = Number(inputVal);
    if (Number.isFinite(num)) return num;
  }
  return fallback;
}

/**
 * Set Instance Transform node — applies per-instance or global position, rotation, scale or matrix transformations
 * to each object/instance in a geometry pack (driven by single X, Y, Z defaults/inputs, or Lists of vectors/scalars/matrices).
 */
export const SET_INSTANCE_TRANSFORM_NODE: NodeDefinition = {
  type: "structure/instance-transform",
  label: "Instance Transform",
  category: "instance",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "matrices", label: "Matrices (List)", type: "any" },
    { id: "positions", label: "Positions (Vector List)", type: "list" },
    { id: "target", label: "Target (look-at)", type: "any" },
    { id: "posX", label: "Pos X", type: "any" },
    { id: "posY", label: "Pos Y", type: "any" },
    { id: "posZ", label: "Pos Z", type: "any" },
    { id: "rotations", label: "Rotations / Directions (Vector List)", type: "list" },
    { id: "rotX", label: "Rot X (°)", type: "any" },
    { id: "rotY", label: "Rot Y (°)", type: "any" },
    { id: "rotZ", label: "Rot Z (°)", type: "any" },
    { id: "scales", label: "Scales (Vector List)", type: "list" },
    { id: "scaleX", label: "Scale X", type: "any" },
    { id: "scaleY", label: "Scale Y", type: "any" },
    { id: "scaleZ", label: "Scale Z", type: "any" },
    INSTANCE_INDEX_INPUT,
    // 1-based like the label says — instance 1 is array index 0 — matching
    // how a human counts instances, not how the group's children array is
    // indexed. Takes priority over `index` when non-empty: targets exactly
    // this set, each still pulling its *own* position/rotation/scale/matrix
    // from the list inputs (same per-instance lookup ALL_INSTANCES already
    // uses), not the one shared item a lone `index` broadcasts to its target.
    { id: "ids", label: "Target IDs (List, 1-based)", type: "list" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: {
    mode: "relative",
    // "shared" is the original behaviour and stays the default so existing
    // .ovm files keep composing exactly as they did — a saved graph has no
    // `pivot` key and so falls back to here. See the note by PIVOT_OPTIONS.
    pivot: "shared",
    index: ALL_INSTANCES,
    rotationMode: "euler",
    alignAxis: "Z",
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  },
  paramFields: [
    { ...INSTANCE_INDEX_FIELD, group: "Transform Defaults" },
    { id: "mode", label: "Transform Mode", kind: "select", options: ["relative", "absolute"], group: "Transform Defaults" },
    { id: "pivot", label: "Pivot", kind: "select", options: PIVOT_OPTIONS, group: "Transform Defaults" },
    { id: "rotationMode", label: "Rotation Mode", kind: "select", options: ["euler", "align"], group: "Transform Defaults" },
    { id: "alignAxis", label: "Align Axis (toward direction)", kind: "select", options: ["X", "Y", "Z", "-X", "-Y", "-Z"], group: "Transform Defaults" },
    { id: "posX", label: "Pos X", kind: "number", step: 0.1, group: "Transform Defaults" },
    { id: "posY", label: "Pos Y", kind: "number", step: 0.1, group: "Transform Defaults" },
    { id: "posZ", label: "Pos Z", kind: "number", step: 0.1, group: "Transform Defaults" },
    { id: "rotX", label: "Rot X (°)", kind: "number", step: 1, group: "Transform Defaults" },
    { id: "rotY", label: "Rot Y (°)", kind: "number", step: 1, group: "Transform Defaults" },
    { id: "rotZ", label: "Rot Z (°)", kind: "number", step: 1, group: "Transform Defaults" },
    { id: "scaleX", label: "Scale X", kind: "number", step: 0.1, group: "Transform Defaults" },
    { id: "scaleY", label: "Scale Y", kind: "number", step: 0.1, group: "Transform Defaults" },
    { id: "scaleZ", label: "Scale Z", kind: "number", step: 0.1, group: "Transform Defaults" },
  ],
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();

    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!source) return { geometry: group };

    const instances = getInstances(source);
    const positionsList = Array.isArray(inputs.positions) ? inputs.positions : [];
    const rotationsList = Array.isArray(inputs.rotations) ? inputs.rotations : [];
    const scalesList = Array.isArray(inputs.scales) ? inputs.scales : [];
    
    const singleMatrix = (inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix : null)
      ?? (inputs.matrices instanceof THREE.Matrix4 ? inputs.matrices : null);
    const matricesList = Array.isArray(inputs.matrices)
      ? inputs.matrices
      : (singleMatrix ? [singleMatrix] : []);

    const mode = String(params.mode || "relative");
    const usesIndividualPivot = String(params.pivot || "shared") === "individual";

    // evaluateGraph fills unconnected sockets with their defaultParams value,
    // so `inputs.posX === 0` looks identical to a genuinely wired 0. Only a
    // socket that actually has a wire may override the positions/rotations/
    // scales list base — otherwise a positions list would always lose to the
    // posX/posY/posZ defaults. See EvalContext.connectedInputs.
    const hasWire = (id: string): boolean =>
      ctx.connectedInputs ? ctx.connectedInputs.has(id) : inputs[id] !== undefined;
    const wired = (id: string): unknown => (hasWire(id) ? inputs[id] : undefined);

    const paramPX = Number(params.posX) || 0;
    const paramPY = Number(params.posY) || 0;
    const paramPZ = Number(params.posZ) || 0;

    const paramRX = Number(params.rotX) || 0;
    const paramRY = Number(params.rotY) || 0;
    const paramRZ = Number(params.rotZ) || 0;

    const paramSX = params.scaleX !== undefined ? Number(params.scaleX) : 1;
    const paramSY = params.scaleY !== undefined ? Number(params.scaleY) : 1;
    const paramSZ = params.scaleZ !== undefined ? Number(params.scaleZ) : 1;

    // When a Target is wired, every instance's align axis is rotated to point
    // at it (look-at). Accepts a vector, an object (Empty), or a matrix.
    const targetPosition = hasWire("target")
      ? extractPositionFromInput(inputs.target, new THREE.Vector3())
      : null;

    const targetIndex = resolveTargetIndex(inputs.index, params.index);

    const targetIdsInput = Array.isArray(inputs.ids) ? inputs.ids : [];
    const targetIdSet = targetIdsInput.length > 0
      ? new Set(
          targetIdsInput
            .map((v) => Math.floor(Number(v)) - 1)
            .filter((n) => Number.isFinite(n) && n >= 0),
        )
      : null;
    // List items (position/rotation/scale/matrix) are always looked up by
    // each instance's own array index in ids-list mode — the same
    // ALL_INSTANCES lookup below, just restricted to the targeted subset —
    // never the "one shared item, broadcast to a lone target" behavior a
    // scalar `index` gets.
    const listIndex = targetIdSet ? ALL_INSTANCES : targetIndex;

    instances.forEach((instance, i) => {
      const clone = cloneInstance(instance);

      if (!(targetIdSet ? targetIdSet.has(i) : isTargeted(i, targetIndex))) {
        group.add(clone);
        return;
      }

      const matItem = listIndex >= 0 && matricesList.length > 0
        ? (matricesList.length === 1 ? matricesList[0] : matricesList[listIndex % matricesList.length])
        : matricesList[i];

      // Check matrix override
      if (matItem instanceof THREE.Matrix4) {
        const mat = matItem as THREE.Matrix4;
        if (mode === "absolute") {
          clone.matrixAutoUpdate = false;
          clone.matrix.copy(mat);
        } else {
          clone.matrixAutoUpdate = false;
          // Same left/right choice as the vector path below — see PIVOT_OPTIONS.
          const placement = clone.matrix.clone();
          if (usesIndividualPivot) {
            clone.matrix.multiplyMatrices(placement, mat);
          } else {
            clone.matrix.multiplyMatrices(mat, placement);
          }
        }
      } else {
        // Base vectors from vector list or origin/identity
        const posItem = listIndex >= 0 && positionsList.length > 0
          ? (positionsList.length === 1 ? positionsList[0] : positionsList[listIndex % positionsList.length])
          : positionsList[i];
        const basePos = posItem !== undefined
          ? asVector(posItem, new THREE.Vector3(0, 0, 0))
          : new THREE.Vector3(0, 0, 0);

        const posOffset = new THREE.Vector3(
          resolveScalarOrListItem(wired("posX"), i, listIndex, basePos.x + paramPX),
          resolveScalarOrListItem(wired("posY"), i, listIndex, basePos.y + paramPY),
          resolveScalarOrListItem(wired("posZ"), i, listIndex, basePos.z + paramPZ),
        );

        // Rotation — either Euler angles in degrees, or (rotationMode = "align")
        // a per-instance world direction that the chosen axis is rotated to point
        // along (normals list → disc facing the surface, for example). Wiring a
        // Target overrides the direction list: each instance faces the target.
        const rotItem = listIndex >= 0 && rotationsList.length > 0
          ? (rotationsList.length === 1 ? rotationsList[0] : rotationsList[listIndex % rotationsList.length])
          : rotationsList[i];
        const baseRot = rotItem !== undefined
          ? asVector(rotItem, new THREE.Vector3(0, 0, 0))
          : new THREE.Vector3(0, 0, 0);

        const rotX = resolveScalarOrListItem(wired("rotX"), i, listIndex, paramRX);
        const rotY = resolveScalarOrListItem(wired("rotY"), i, listIndex, paramRY);
        const rotZ = resolveScalarOrListItem(wired("rotZ"), i, listIndex, paramRZ);

        const align = String(params.rotationMode || "euler") === "align" || targetPosition !== null;
        const RAD = Math.PI / 180;
        let quat: THREE.Quaternion;
        if (align) {
          const alignAxis = alignAxisVector(String(params.alignAxis || "Z"));
          let dir: THREE.Vector3;
          if (targetPosition) {
            // Direction from the instance's final position to the target. Under
            // an individual pivot the offset is read in the instance's own axes
            // (`placement × delta`), so it has to go through the placement
            // matrix to land in world space — adding it to the placement's
            // translation aimed rotated instances at the wrong point.
            const instancePos = usesIndividualPivot
              ? posOffset.clone().applyMatrix4(clone.matrix)
              : new THREE.Vector3().setFromMatrixPosition(clone.matrix).add(posOffset);
            dir = targetPosition.clone().sub(instancePos).normalize();
          } else {
            dir = baseRot.lengthSq() > 1e-9 ? baseRot.clone().normalize() : alignAxis;
          }
          quat = quaternionAlignAxis(alignAxis, dir);
          // The euler fields become extra rotation applied after alignment.
          quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX * RAD, rotY * RAD, rotZ * RAD)));
          if (usesIndividualPivot) {
            // `dir` is a world direction but this delta is applied on the right
            // (`placement × delta`), i.e. read in the instance's local frame.
            // Undoing the placement's own rotation is what makes the two agree:
            // placement × (placement⁻¹ × qWorld) = qWorld. Without it, any
            // instance whose placement carried a rotation aimed off-target.
            // decompose, not setFromRotationMatrix: the placement usually
            // carries scale, which the latter silently folds into the rotation.
            const placementQuat = new THREE.Quaternion();
            clone.matrix.decompose(new THREE.Vector3(), placementQuat, new THREE.Vector3());
            quat.premultiply(placementQuat.invert());
          }
        } else {
          const rotOffset = new THREE.Vector3(
            resolveScalarOrListItem(wired("rotX"), i, listIndex, baseRot.x + paramRX),
            resolveScalarOrListItem(wired("rotY"), i, listIndex, baseRot.y + paramRY),
            resolveScalarOrListItem(wired("rotZ"), i, listIndex, baseRot.z + paramRZ),
          );
          quat = new THREE.Quaternion().setFromEuler(
            new THREE.Euler((rotOffset.x * RAD), (rotOffset.y * RAD), (rotOffset.z * RAD)),
          );
        }

        // Scale
        const scaleItem = listIndex >= 0 && scalesList.length > 0
          ? (scalesList.length === 1 ? scalesList[0] : scalesList[listIndex % scalesList.length])
          : scalesList[i];
        const baseScale = scaleItem !== undefined
          ? asVector(scaleItem, new THREE.Vector3(1, 1, 1))
          : new THREE.Vector3(1, 1, 1);

        const scaleVal = new THREE.Vector3(
          resolveScalarOrListItem(wired("scaleX"), i, listIndex, baseScale.x * paramSX),
          resolveScalarOrListItem(wired("scaleY"), i, listIndex, baseScale.y * paramSY),
          resolveScalarOrListItem(wired("scaleZ"), i, listIndex, baseScale.z * paramSZ),
        );

        const deltaMat = new THREE.Matrix4();
        deltaMat.compose(posOffset, quat, scaleVal);

        if (usesIndividualPivot) {
          // Fold the delta into the instance's own matrix, on the right:
          // `placement × delta` puts it in the instance's local frame, so a
          // rotation turns it about its own origin instead of swinging it
          // around the pack's. No wrapper needed — and not merely an
          // optimisation, since a wrapper is by definition a parent and so
          // could only ever express the "shared" order.
          clone.matrixAutoUpdate = false;
          clone.matrix.multiply(deltaMat);
          group.add(clone);
          return;
        }

        const wrapper = new THREE.Group();
        wrapper.matrixAutoUpdate = false;
        wrapper.matrix.copy(deltaMat);
        wrapper.add(clone);
        group.add(wrapper);
        return;
      }

      group.add(clone);
    });

    return { geometry: group };
  },
};

/**
 * Get Instance node — extracts an individual object/instance from a geometry pack by index,
 * and outputs total instance count.
 */
export const GET_INSTANCE_NODE: NodeDefinition = {
  type: "structure/get-instance",
  label: "Get Instance",
  category: "instance",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "index", label: "Index", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { index: 0 },
  paramFields: [{ id: "index", label: "Index", kind: "number", step: 1 }],
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();

    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!source) return { geometry: group, count: 0 };

    const instances = getInstances(source);
    const count = instances.length;

    const rawIndex = inputs.index !== undefined ? Number(inputs.index) : Number(params.index);
    const index = Math.max(0, Math.floor(isNaN(rawIndex) ? 0 : rawIndex)) % count;

    const selectedInstance = instances[index];
    if (selectedInstance) {
      group.add(cloneInstance(selectedInstance));
    }

    return { geometry: group, count };
  },
};

/**
 * Transform Geometry — moves, turns and grows an incoming object's shape in
 * its own space, about its origin, as Blender's node of the same name.
 */
export const GEOMETRY_TRANSFORM_NODE: NodeDefinition = {
  type: "structure/geometry-transform",
  label: "Transform Geometry",
  category: "instance",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "location", label: "Location", type: "vector" },
    { id: "posX", label: "Pos X", type: "value" },
    { id: "posY", label: "Pos Y", type: "value" },
    { id: "posZ", label: "Pos Z", type: "value" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "rotX", label: "Rot X (°)", type: "value" },
    { id: "rotY", label: "Rot Y (°)", type: "value" },
    { id: "rotZ", label: "Rot Z (°)", type: "value" },
    { id: "scale", label: "Scale", type: "vector" },
    { id: "scaleX", label: "Scale X", type: "value" },
    { id: "scaleY", label: "Scale Y", type: "value" },
    { id: "scaleZ", label: "Scale Z", type: "value" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: {
    mode: "relative",
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    rotationMode: DEFAULT_ROTATION_MODE,
  },
  paramFields: [
    ROTATION_MODE_FIELD,
    { id: "posX", label: "Pos X", kind: "number", step: 0.1 },
    { id: "posY", label: "Pos Y", kind: "number", step: 0.1 },
    { id: "posZ", label: "Pos Z", kind: "number", step: 0.1 },
    { id: "rotX", label: "Rot X (°)", kind: "number", step: 1 },
    { id: "rotY", label: "Rot Y (°)", kind: "number", step: 1 },
    { id: "rotZ", label: "Rot Z (°)", kind: "number", step: 1 },
    { id: "scaleX", label: "Scale X", kind: "number", step: 0.1 },
    { id: "scaleY", label: "Scale Y", kind: "number", step: 0.1 },
    { id: "scaleZ", label: "Scale Z", kind: "number", step: 0.1 },
    { id: "location", label: "Location (fallback)", kind: "vector" },
    { id: "rotation", label: "Rotation (°, fallback)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale (fallback)", kind: "vector" },
  ],
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();

    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!source) return { geometry: group };

    const clone = cloneInstance(source);

    let transformMat: THREE.Matrix4;

    if (inputs.matrix instanceof THREE.Matrix4) {
      transformMat = inputs.matrix.clone();
    } else {
      /**
       * Whether a socket actually has a wire in it.
       *
       * The per-axis sockets used to win over the vector ones unconditionally
       * — `inputs.posX !== undefined` — which is always true: the evaluator
       * fills every unconnected socket from `defaultParams`, and posX/posY/
       * posZ default to 0. Wiring anything into Location therefore did
       * nothing at all, the axis zeros silently overwrote it. Same for
       * Rotation and Scale.
       *
       * Precedence now: a wired axis beats a wired vector, a wired vector
       * beats the panel's axis numbers, and with nothing wired the panel
       * still wins — so graphs built entirely through the panel behave
       * exactly as before.
       */
      const isWired = (id: string): boolean =>
        ctx.connectedInputs ? ctx.connectedInputs.has(id) : inputs[id] !== undefined;

      const axis = (componentId: string, vectorId: string, base: number, unit = 1): number => {
        if (isWired(componentId)) {
          const wiredValue = Number(inputs[componentId]);
          return Number.isFinite(wiredValue) ? wiredValue * unit : base;
        }
        if (isWired(vectorId)) return base;
        const param = Number(params[componentId]);
        return params[componentId] !== undefined && Number.isFinite(param) ? param * unit : base;
      };

      const baseLoc = asVector(inputs.location, asVector(params.location, new THREE.Vector3(0, 0, 0)));
      const location = new THREE.Vector3(
        axis("posX", "location", baseLoc.x),
        axis("posY", "location", baseLoc.y),
        axis("posZ", "location", baseLoc.z),
      );

      // Units: the Rot X/Y/Z numbers are degrees, as labelled; the Rotation
      // vector is radians, like every rotation vector that travels between
      // nodes (Separate Transform's output, the panel's own stored fallback).
      // Both used to go through one degrees-to-radians step, so a wired 90°
      // vector (1.5708) turned the geometry by 1.57°.
      const DEG = Math.PI / 180;
      const baseRot = asVector(inputs.rotation, asVector(params.rotation, new THREE.Vector3(0, 0, 0)));
      const rotation = new THREE.Vector3(
        axis("rotX", "rotation", baseRot.x, DEG),
        axis("rotY", "rotation", baseRot.y, DEG),
        axis("rotZ", "rotation", baseRot.z, DEG),
      );

      const baseScale = asVector(inputs.scale, asVector(params.scale, new THREE.Vector3(1, 1, 1)));
      const scale = new THREE.Vector3(
        axis("scaleX", "scale", baseScale.x),
        axis("scaleY", "scale", baseScale.y),
        axis("scaleZ", "scale", baseScale.z),
      );

      transformMat = composeTransform(location, rotation, scale, params);
    }

    // In the object's own space, as Blender's Transform Geometry: the
    // geometry turns and grows about the object's origin and moves along its
    // axes. The wrapper sits outside the clone, so the transform is
    // conjugated by the clone's own pose (C·M·C⁻¹·C = C·M) — applied plainly
    // it acted about the world origin, and an object standing anywhere else
    // swung around 0,0,0. A collapsed object (zero scale) has no inverse and
    // draws as nothing either way.
    if (clone.matrixAutoUpdate) clone.updateMatrix();
    const own = clone.matrix;
    const local =
      Math.abs(own.determinant()) > 1e-12
        ? new THREE.Matrix4().multiplyMatrices(own, transformMat).multiply(own.clone().invert())
        : transformMat;

    const wrapper = new THREE.Group();
    wrapper.matrixAutoUpdate = false;
    wrapper.matrix.copy(local);
    wrapper.add(clone);
    group.add(wrapper);

    return { geometry: group };
  },
};

/**
 * Instances to List node — decomposes a Group or Array geometry into a List of individual 3D instances.
 */
export const INSTANCES_TO_LIST_NODE: NodeDefinition = {
  type: "structure/instances-to-list",
  label: "Instances to List",
  category: "converter",
  inputs: [{ id: "geometry", label: "Geometry", type: "geometry", owns: true }],
  outputs: [
    { id: "list", label: "List", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {},
  evaluate: (inputs) => {
    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!source) return { list: [], count: 0 };
    const instances = getInstances(source);
    return { list: instances, count: instances.length };
  },
};

