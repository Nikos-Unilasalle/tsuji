import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { asVector3, composeNativeMatrix } from "./transform";
import { primitiveOutputs, asColor } from "./object";
import { ClipCapPlaneSpec, applyClipCaps, capCoverRadius, clipCapsHaveOpenGeometry, removeClipCaps } from "./clipCaps";
import { createNodeCache } from "../nodeCaches";

const DEFAULT_POINT = new THREE.Vector3(0, 0, 0);
const DEFAULT_NORMAL = new THREE.Vector3(0, 1, 0);
const DEFAULT_BOX_SIZE = new THREE.Vector3(1, 1, 1);
const DEFAULT_ROTATION = new THREE.Vector3(0, 0, 0);
const DEFAULT_CAP_COLOR = new THREE.Color(0xffffff);
const UNIT_Z = new THREE.Vector3(0, 0, 1);

/**
 * The six faces of a unit cube: outward normal, plus the two in-plane axes
 * that span it. `makeBasis(u, v, n).setPosition(n * 0.5)` maps the unit XY
 * quad a cap is drawn on exactly onto that face — multiply by the box's own
 * matrix and the cap lands on the real face, at the real size, whatever the
 * box's rotation and (even non-uniform) scale.
 */
const BOX_FACES: { normal: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 }[] = [
  { normal: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 0, -1), v: new THREE.Vector3(0, 1, 0) },
  { normal: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(0, 1, 0) },
  { normal: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, -1) },
  { normal: new THREE.Vector3(0, -1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1) },
  { normal: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0) },
  { normal: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 1, 0) },
];

/**
 * Capping a surface that encloses nothing draws nothing, and used to do so in
 * silence. The usual culprit is Curve to Mesh with its own "Caps" option off:
 * that tube is a hollow shell with open ends, so there is no solid for the cut
 * to expose. Said out loud, with the fix, rather than left as a mystery.
 */
function capParamFields(nodeId: string, capEnabled: boolean): ParamFieldDef[] {
  const openGeometry = capEnabled && clipCapsHaveOpenGeometry(nodeId);
  return [
    ...(openGeometry
      ? [
          {
            id: "capOpenGeometryNote",
            label:
              "⚠ Cap Cut has nothing to fill: this geometry is an open surface, not a closed solid. If it came from Curve to Mesh, switch on that node's \"Caps (fill open ends)\" and the cut will fill.",
            kind: "note" as const,
            tone: "warn" as const,
          },
        ]
      : []),
    ...CAP_PARAM_FIELDS,
  ];
}

const CAP_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "doubleSided", label: "Double Sided (See Inside)", kind: "boolean" as const },
  { id: "capEnabled", label: "Cap Cut (Solid Face)", kind: "boolean" as const },
  { id: "capColor", label: "Cap Color", kind: "color" as const },
  { id: "capRoughness", label: "Cap Roughness", kind: "number" as const, step: 0.05 },
  { id: "capMetalness", label: "Cap Metalness", kind: "number" as const, step: 0.05 },
];

const CAP_DEFAULT_PARAMS = {
  doubleSided: 0,
  capEnabled: 0,
  capColor: DEFAULT_CAP_COLOR.clone(),
  capRoughness: 0.6,
  capMetalness: 0,
};

function capAppearance(params: Record<string, unknown>) {
  return {
    color: asColor(params.capColor, DEFAULT_CAP_COLOR),
    roughness: Math.max(0, Math.min(1, Number(params.capRoughness) ?? 0.6)),
    metalness: Math.max(0, Math.min(1, Number(params.capMetalness) ?? 0)),
  };
}

/**
 * A clipped material as it was *before* this node ever touched it. Clipping
 * is a mutation of an object somebody else owns — the upstream node's cached
 * mesh and material outlive this node entirely — so every field written below
 * has to be recorded here first, or there is no way back.
 */
interface PreClipMaterial {
  material: THREE.Material;
  clippingPlanes: THREE.Plane[] | null;
  clipIntersection: boolean;
  clipShadows: boolean;
  side: THREE.Side;
}

interface ClipState {
  /** Keyed by material, so a mesh reached twice in one traverse is snapshotted once. */
  touched: Map<THREE.Material, PreClipMaterial>;
}

function restorePreClip(snapshot: PreClipMaterial): void {
  const mat = snapshot.material;
  mat.clippingPlanes = snapshot.clippingPlanes;
  mat.clipIntersection = snapshot.clipIntersection;
  mat.clipShadows = snapshot.clipShadows;
  mat.side = snapshot.side;
}

/**
 * Deleting a clip node has to un-clip what it clipped. Nothing else will:
 * the geometry it cut belongs to an upstream node whose mesh and material are
 * cached across frames, so a `clippingPlanes` left behind keeps cutting a hole
 * in an object no node in the graph is clipping any more. Registering the
 * undo here means node deletion runs it for free — see nodeCaches.ts.
 */
const clipStateCache = createNodeCache<ClipState>((state) => {
  for (const snapshot of state.touched.values()) restorePreClip(snapshot);
  state.touched.clear();
});

/**
 * Applies this node's clip to every real mesh under `object` (null to clip
 * nothing), and restores anything it used to clip but no longer reaches —
 * rewiring the input to another object, or unwiring it, has to release the
 * old one for the same reason deleting the node does.
 *
 * `doubleSided` rides along because it is the same kind of borrowed mutation:
 * cutting a closed mesh open exposes its back faces, and a single-sided
 * material simply doesn't draw them — you look straight through the object and
 * out the far side. Off by default; it doubles the fragments a clipped object
 * costs, and for a cut you only ever view from outside it buys nothing.
 */
function syncClipToSubtree(
  nodeId: string,
  object: THREE.Object3D | null,
  planes: THREE.Plane[],
  clipIntersection: boolean,
  doubleSided: boolean,
): void {
  let state = clipStateCache.get(nodeId);
  if (!state) {
    state = { touched: new Map() };
    clipStateCache.set(nodeId, state);
  }

  const stillClipped = new Set<THREE.Material>();
  object?.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || child.userData?.__clipCapHelper) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of materials) {
      if (!mat) continue;
      stillClipped.add(mat);
      let snapshot = state.touched.get(mat);
      if (!snapshot) {
        snapshot = {
          material: mat,
          clippingPlanes: mat.clippingPlanes,
          clipIntersection: mat.clipIntersection,
          clipShadows: mat.clipShadows,
          side: mat.side,
        };
        state.touched.set(mat, snapshot);
      }
      mat.clippingPlanes = planes;
      mat.clipIntersection = clipIntersection;
      mat.clipShadows = true;
      // Snapshot, not "whatever it is now" — several double-sided frames in a
      // row must not latch DoubleSide as the value to go back to.
      mat.side = doubleSided ? THREE.DoubleSide : snapshot.side;
    }
  });

  for (const [mat, snapshot] of state.touched) {
    if (stillClipped.has(mat)) continue;
    restorePreClip(snapshot);
    state.touched.delete(mat);
  }
}

/**
 * The matrix taking the unit cube onto `object`'s bounds, measured in the
 * object's own frame — so a rotated Box gives a rotated volume, not the
 * axis-aligned box around it. Null when there is nothing with a size inside.
 */
function boundsMatrix(object: THREE.Object3D): THREE.Matrix4 | null {
  object.updateWorldMatrix(true, true);
  const toLocal = object.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();
  const meshBounds = new THREE.Box3();
  const relative = new THREE.Matrix4();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || child.userData?.__clipCapHelper || !child.geometry) return;
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    if (!child.geometry.boundingBox || child.geometry.boundingBox.isEmpty()) return;
    relative.multiplyMatrices(toLocal, child.matrixWorld);
    bounds.union(meshBounds.copy(child.geometry.boundingBox).applyMatrix4(relative));
  });
  if (bounds.isEmpty()) return null;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3()).max(new THREE.Vector3(1e-6, 1e-6, 1e-6));
  return object.matrixWorld.clone().multiply(new THREE.Matrix4().compose(center, new THREE.Quaternion(), size));
}

/**
 * Clip Box — the "advanced clipping" case a single Visual Slice plane can't
 * do: six planes at once (an oriented box) instead of one flat cut across the
 * whole scene.
 *
 * three.js keeps the fragments on a clipping plane's *positive-normal* side,
 * so which way the six face normals point is the whole difference between the
 * two modes. "inside" turns them inward: a fragment must be on the inner side
 * of all six to survive, which is exactly the box's interior. "cavity" turns
 * them outward and flips `clipIntersection`, so surviving one plane is enough
 * — the union of the six outer half-spaces, i.e. everything *except* the box,
 * carving its volume out of the geometry like threejs.org's advanced-clipping
 * example.
 *
 * The cut is an open hole unless `capEnabled` is on — see clipCaps.ts.
 */
export const CLIP_BOX_NODE: NodeDefinition = {
  type: "modifier/clip-box",
  label: "Clip Box",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "location", label: "Box Center", type: "vector" },
    { id: "rotation", label: "Box Rotation (°)", type: "vector" },
    { id: "size", label: "Box Size", type: "vector" },
    // Any object (a Box primitive, typically) whose bounds become the clip
    // volume — center, rotation and size all read off it, overriding the
    // three above, so the limits can be shaped and animated like any object.
    { id: "box", label: "Box", type: "geometry" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    // The box itself (unit cube → clip volume, Box Size included), not the
    // clipped object's pose: wired into a 1×1×1 Box's Matrix, that Box sits
    // exactly on the clip volume.
    { id: "matrix", label: "Box Matrix", type: "matrix" },
  ],
  defaultParams: {
    location: DEFAULT_POINT.clone(),
    rotation: DEFAULT_ROTATION.clone(),
    size: DEFAULT_BOX_SIZE.clone(),
    clipMode: "inside",
    ...CAP_DEFAULT_PARAMS,
  },
  dynamicParamFields: (instance) => [
    { id: "location", label: "Box Center", kind: "vector" },
    { id: "rotation", label: "Box Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "size", label: "Box Size", kind: "vector" },
    { id: "clipMode", label: "Clip Mode", kind: "select", options: ["inside", "cavity"] },
    ...capParamFields(instance.id, Boolean(instance.params.capEnabled)),
  ],
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) {
      removeClipCaps(ctx.nodeId);
      // Unwiring the input has to release whatever was clipped through it.
      syncClipToSubtree(ctx.nodeId, null, [], false, false);
      return { geometry: null, matrix: new THREE.Matrix4() };
    }

    if (ctx.renderer) ctx.renderer.localClippingEnabled = true;

    const boxObj = inputs.box instanceof THREE.Object3D ? inputs.box : null;
    const boxMatrix =
      (boxObj && boundsMatrix(boxObj)) ||
      composeNativeMatrix(
        new THREE.Matrix4(),
        asVector3(inputs.location, asVector3(params.location, DEFAULT_POINT)),
        asVector3(inputs.rotation, asVector3(params.rotation, DEFAULT_ROTATION)),
        asVector3(inputs.size, asVector3(params.size, DEFAULT_BOX_SIZE)),
      );
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(boxMatrix);

    const cavity = String(params.clipMode || "inside") === "cavity";

    // Inward planes are the canonical form — they describe the box's interior,
    // which is what "inside" clips to *and* what trims each cap to its face.
    const inwardPlanes: THREE.Plane[] = [];
    const capMatrices: THREE.Matrix4[] = [];
    for (const face of BOX_FACES) {
      const outward = face.normal.clone().applyMatrix3(normalMatrix).normalize();
      const center = face.normal.clone().multiplyScalar(0.5).applyMatrix4(boxMatrix);
      inwardPlanes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(outward.clone().negate(), center));
      capMatrices.push(
        new THREE.Matrix4()
          .makeBasis(face.u, face.v, face.normal)
          .setPosition(face.normal.clone().multiplyScalar(0.5))
          .premultiply(boxMatrix)
      );
    }

    const objectPlanes = cavity
      ? inwardPlanes.map((p) => new THREE.Plane(p.normal.clone().negate(), -p.constant))
      : inwardPlanes;

    syncClipToSubtree(ctx.nodeId, inputObj, objectPlanes, cavity, Boolean(params.doubleSided));

    if (params.capEnabled) {
      const planes: ClipCapPlaneSpec[] = objectPlanes.map((plane, i) => ({
        plane,
        capMatrix: capMatrices[i],
        // Every face but this one, always inward: that intersection is the
        // face's own rectangle, whichever way the object is being clipped.
        restrictPlanes: inwardPlanes.filter((_, idx) => idx !== i),
      }));
      applyClipCaps({ nodeId: ctx.nodeId, object: inputObj, planes, ...capAppearance(params) });
    } else {
      removeClipCaps(ctx.nodeId);
    }

    return { geometry: inputObj, matrix: boxMatrix };
  },
};

/**
 * Visual Slice — hides everything on the back side of a plane, GPU-side, via
 * THREE.Material.clippingPlanes. Unlike Boolean this never touches geometry:
 * no CSG, no watertight-mesh requirement, works on a whole instanced pack at
 * once (every mesh in the subtree, not just the first one Boolean would find)
 * and is effectively free to animate every frame. The cut is an open hole by
 * default — for "make the bottom of a randomly-tall pole stop existing below
 * the floor" that's exactly the point — but `capEnabled` fills it with a
 * solid face (see clipCaps.ts) when the cut needs to read as capped; reach
 * for Boolean when the geometry itself must be watertight downstream
 * (physics, export), since this only ever changes pixels.
 */
export const VISUAL_SLICE_NODE: NodeDefinition = {
  type: "modifier/visual-slice",
  label: "Visual Slice",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "point", label: "Plane Point", type: "vector" },
    { id: "direction", label: "Plane Normal", type: "vector" },
    // Parents the cutting plane, so it can ride an animated object instead of
    // being pinned to world coordinates. The plane is a point and a normal
    // rather than a pose, so the matrix is applied to those two directly —
    // there is no location/rotation/scale here for composeNativeMatrix to
    // parent in the usual way.
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    point: DEFAULT_POINT.clone(),
    direction: DEFAULT_NORMAL.clone(),
    invert: 0,
    ...CAP_DEFAULT_PARAMS,
  },
  dynamicParamFields: (instance) => [
    { id: "point", label: "Plane Point", kind: "vector" },
    // Any id containing "normal" (case-insensitive) gets auto-grouped into
    // "Texture & Files" by ParamPanel's heuristic, built for Normal Map
    // sockets — "direction" sidesteps that; this field has nothing to do
    // with textures.
    { id: "direction", label: "Plane Normal", kind: "vector" },
    { id: "invert", label: "Invert", kind: "boolean" },
    ...capParamFields(instance.id, Boolean(instance.params.capEnabled)),
  ],
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) {
      removeClipCaps(ctx.nodeId);
      // Unwiring the input has to release whatever was clipped through it.
      syncClipToSubtree(ctx.nodeId, null, [], false, false);
      return { geometry: null, matrix: new THREE.Matrix4() };
    }

    // clippingPlanes is a renderer-level feature — off by default, and a
    // single flag switches it on for every clipped material in the scene, so
    // flip it here rather than asking every project to remember a viewport
    // setting just because one node exists somewhere in the graph.
    if (ctx.renderer) ctx.renderer.localClippingEnabled = true;

    // Cloned: asVector3 hands back the params' own Vector3 when nothing is
    // wired, and the transform below would otherwise move the stored param.
    const point = asVector3(inputs.point, asVector3(params.point, DEFAULT_POINT)).clone();
    const normal = asVector3(inputs.direction, asVector3(params.direction, DEFAULT_NORMAL)).clone();
    if (normal.lengthSq() < 1e-12) normal.copy(DEFAULT_NORMAL);
    normal.normalize();
    if (params.invert) normal.negate();

    // A wired matrix carries the plane with it. The normal goes through the
    // inverse-transpose, not the matrix itself: under non-uniform scale a
    // direction transformed like a position stops being perpendicular to the
    // surface, and the cut would tilt away from where the plane actually is.
    if (inputs.matrix instanceof THREE.Matrix4) {
      point.applyMatrix4(inputs.matrix);
      normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(inputs.matrix));
      if (normal.lengthSq() < 1e-12) normal.copy(DEFAULT_NORMAL);
      normal.normalize();
    }

    // world-space plane: clippingPlanes are compared against each vertex's
    // world position, so the plane needs no relation to this node's own
    // input transform beyond point/normal already being in world units.
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);

    syncClipToSubtree(ctx.nodeId, inputObj, [plane], false, Boolean(params.doubleSided));

    if (params.capEnabled) {
      // One bare plane has no outline to trim the cap to, so the quad is sized
      // to swallow the object and left to the stencil to cut down.
      const radius = capCoverRadius(inputObj);
      const capMatrix = new THREE.Matrix4().compose(
        point,
        new THREE.Quaternion().setFromUnitVectors(UNIT_Z, normal),
        new THREE.Vector3(radius * 2, radius * 2, 1)
      );
      applyClipCaps({
        nodeId: ctx.nodeId,
        object: inputObj,
        planes: [{ plane, capMatrix, restrictPlanes: [] }],
        ...capAppearance(params),
      });
    } else {
      removeClipCaps(ctx.nodeId);
    }

    return primitiveOutputs(inputObj);
  },
};
