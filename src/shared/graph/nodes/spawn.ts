import * as THREE from "three";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { clearMeshWarning, warnMeshRequired } from "../meshRequired";
import { sampleSurfacePoints } from "../../three/bvh";
import { InstancedItemSpec, renderInstanced } from "./instancedRender";
import { getSourcePivot } from "./transform";

function toNumberList(v: unknown): number[] {
  if (!Array.isArray(v)) return typeof v === "number" ? [v] : [];
  return v.map((x) => Number(x) || 0);
}

const RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

const groupCache = createNodeCache<THREE.Group>(disposeObject3D);

function getGroup(nodeId: string): THREE.Group {
  const existing = groupCache.get(nodeId);
  if (existing) return existing;
  const group = new THREE.Group();
  groupCache.set(nodeId, group);
  return group;
}

/** Deterministic pseudo-random number generator (Park-Miller LCG) */
function createPrng(seed: number) {
  let s = Math.floor(Math.abs(seed)) % 2147483647;
  if (s <= 0) s = 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Surface sampling for the Spawner now goes through the shared BVH module. */
export { sampleSurfacePoints };

function extractItems(rawItems: unknown): THREE.Object3D[] {
  const items: THREE.Object3D[] = [];
  const stack = Array.isArray(rawItems) ? [...rawItems] : [rawItems];

  // Every top-level object is ONE spawnable unit — a Merge's Group, a
  // curve-to-mesh Group, a single mesh, etc. Only explicit lists/arrays are
  // flattened (a List Group of several items still cycles between them);
  // groups are NOT recursed into, otherwise a merged "flower" of two surfaces
  // would spawn as two separate parts instead of one unit.
  while (stack.length > 0) {
    const current = stack.shift();
    if (Array.isArray(current)) {
      stack.unshift(...current);
    } else if (current instanceof THREE.Object3D) {
      items.push(current);
    }
  }
  return items;
}

export const SPAWN_NODE: NodeDefinition = {
  type: "structure/spawn",
  label: "Spawner",
  category: "instance",
  inputs: [
    { id: "support", label: "Support (Surface)", type: "geometry" },
    { id: "items", label: "Items to Spawn", type: "any", owns: true },
    { id: "xValues", label: "X Values (List)", type: "list" },
    { id: "yValues", label: "Y Values (List)", type: "list" },
    { id: "zValues", label: "Z Values (List)", type: "list" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: {
    count: 50,
    seed: 1,
    placement: "center",
    scaleMin: 0.8,
    scaleMax: 1.2,
    rotXVar: 0,
    rotYVar: 180,
    rotZVar: 0,
    alignToNormal: 1,
    dispersion: 0,
    gpuInstancing: false,
  },
  paramFields: [
    { id: "count", label: "Count", kind: "number", step: 1, group: "Spawning" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Spawning" },
    {
      id: "gpuInstancing",
      label: "GPU Instancing (1 draw call — disables Get/Set Instance)",
      kind: "boolean",
      group: "Spawning",
    },
    { id: "placement", label: "Placement", kind: "select", options: ["center", "base", "pivot"], group: "Spawning" },
    { id: "alignToNormal", label: "Align to Normal", kind: "boolean", group: "Spawning" },
    { id: "dispersion", label: "Dispersion / Jitter", kind: "number", step: 0.05, group: "Spawning" },
    { id: "scaleMin", label: "Min Scale", kind: "number", step: 0.05, group: "Variation" },
    { id: "scaleMax", label: "Max Scale", kind: "number", step: 0.05, group: "Variation" },
    { id: "rotXVar", label: "Rot X Var (°)", kind: "number", step: 1, degrees: true, group: "Variation" },
    { id: "rotYVar", label: "Rot Y Var (°)", kind: "number", step: 1, degrees: true, group: "Variation" },
    { id: "rotZVar", label: "Rot Z Var (°)", kind: "number", step: 1, degrees: true, group: "Variation" },
  ],
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();

    const supportObj = inputs.support instanceof THREE.Object3D ? inputs.support : null;

    const items = extractItems(inputs.items);
    if (items.length === 0) return { geometry: group };

    let count = Math.max(1, Math.min(5000, Math.floor(Number(params.count) || 50)));
    const seed = Number(params.seed) || 1;
    const scaleMin = Number.isFinite(Number(params.scaleMin)) ? Number(params.scaleMin) : 0.8;
    const scaleMax = Number.isFinite(Number(params.scaleMax)) ? Number(params.scaleMax) : 1.2;
    const rotXVarRad = (Number.isFinite(Number(params.rotXVar)) ? Number(params.rotXVar) : 0) * RAD;
    const rotYVarRad = (Number.isFinite(Number(params.rotYVar)) ? Number(params.rotYVar) : 180) * RAD;
    const rotZVarRad = (Number.isFinite(Number(params.rotZVar)) ? Number(params.rotZVar) : 0) * RAD;
    const alignToNormal = params.alignToNormal !== undefined ? Boolean(params.alignToNormal) : true;
    const dispersion = Number.isFinite(Number(params.dispersion)) ? Number(params.dispersion) : 0;
    const placement = String(params.placement || "center");

    const gpuInstancing = Boolean(params.gpuInstancing);
    const instancedItems: InstancedItemSpec[] = [];

    const prng = createPrng(seed);

    // Area-weighted surface sampling via the shared BVH module: cached per
    // geometry (vs. the old per-frame collectTriangles scan) and reused by the
    // physics/sample node. Returns world-space positions + normals.
    // Explicit positions win over surface sampling — this is the point-cloud
    // -> scatter bridge. Rather than a second scatter node duplicating all the
    // anchoring/orientation work below, the existing Spawner just accepts
    // where to put things from a list (Point Cloud, Particles to Points, CSV
    // Reader, any list source) as an alternative to picking points itself.
    // Support (Surface) stays wired-or-not independently: with lists driving
    // position there is no surface normal to align to, so Align to Normal has
    // nothing to act on and copies keep their own orientation.
    const listX = toNumberList(inputs.xValues);
    const listY = toNumberList(inputs.yValues);
    const listZ = toNumberList(inputs.zValues);
    const listCount = Math.min(listX.length, listY.length, listZ.length);

    let sampledPositions: THREE.Vector3[];
    let sampledNormals: THREE.Vector3[];
    if (listCount > 0) {
      const used = Math.min(listCount, count);
      sampledPositions = Array.from({ length: used }, (_, i) => new THREE.Vector3(listX[i], listY[i], listZ[i]));
      sampledNormals = Array.from({ length: used }, () => UP.clone());
      count = used;
    } else {
      // No positions given and no surface to pick them from — nothing to do.
      if (!supportObj) return { geometry: group };
      const sampled = sampleSurfacePoints(supportObj, count, prng);
      sampledPositions = sampled.positions;
      sampledNormals = sampled.normals;
      if (sampledPositions.length === 0) {
        warnMeshRequired(ctx.nodeId, "Spawner", supportObj);
        return { geometry: group };
      }
      clearMeshWarning(ctx.nodeId);
    }

    for (let i = 0; i < count; i++) {
      const worldPos = sampledPositions[i];
      const worldNorm = sampledNormals[i];

      // Apply dispersion / jitter along tangent space
      if (dispersion > 0) {
        const jitterVec = new THREE.Vector3(
          (prng() - 0.5) * dispersion,
          (prng() - 0.5) * dispersion,
          (prng() - 0.5) * dispersion,
        );
        worldPos.add(jitterVec);
      }

      // Select item to clone
      const sourceItem = items[i % items.length];
      // The item's *world* rotation & scale — same reasoning as the surface
      // sampler: a graph-driven item's matrix is the truth, but a curve-to-mesh
      // (or any modifier) hands back a GROUP whose pose lives on the group. We
      // decompose the forced matrixWorld and keep rotation/scale (the shape's
      // orientation and size) but DROP the item's world position — each copy
      // sits on the support surface rather than being pushed off it by where
      // the item happens to be in the scene.
      // `updateMatrixWorld(true)` (force) refreshes the WHOLE subtree, so
      // Box3.setFromObject below sees correct bounds for graph-driven children.
      sourceItem.updateMatrixWorld(true);
      const itemPos = new THREE.Vector3();
      const itemQuat = new THREE.Quaternion();
      const itemScale = new THREE.Vector3();
      sourceItem.matrixWorld.decompose(itemPos, itemQuat, itemScale);

      // Where the copy's shape should meet the spawn point. A merged "flower"
      // has parts carrying absolute scene offsets, so placing the item's origin
      // would scatter them. Anchor the copy by its actual bounds instead:
      // - "center": the bounds' centre lands on the spawn point.
      // - "base": the bounds' bottom-centre lands on it (sits on the surface).
      const sourcePivot = getSourcePivot(sourceItem);
      const hasPivot = sourcePivot.lengthSq() > 1e-9;
      const box = new THREE.Box3().setFromObject(sourceItem);
      const worldCenter = box.getCenter(new THREE.Vector3());
      const invItem = new THREE.Matrix4().copy(sourceItem.matrixWorld).invert();
      const centerLocal = worldCenter.clone().applyMatrix4(invItem);
      const anchor =
        placement === "base"
          ? new THREE.Vector3(centerLocal.x, box.min.clone().applyMatrix4(invItem).y, centerLocal.z)
          : placement === "pivot" || (hasPivot && placement !== "center" && placement !== "base")
          ? sourcePivot.clone()
          : centerLocal;

      // Orientation & Rotation (surface normal × variation × item's own rotation)
      const finalQuat = new THREE.Quaternion();
      if (alignToNormal) {
        finalQuat.setFromUnitVectors(UP, worldNorm);
      }

      const rx = (prng() - 0.5) * 2 * rotXVarRad;
      const ry = (prng() - 0.5) * 2 * rotYVarRad;
      const rz = (prng() - 0.5) * 2 * rotZVarRad;
      const varQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));

      finalQuat.multiply(varQuat).multiply(itemQuat);

      // Scale multiplier × item's own scale
      const scaleVal = scaleMin + prng() * (scaleMax - scaleMin);
      const spawnScale = new THREE.Vector3(scaleVal, scaleVal, scaleVal).multiply(itemScale);

      // Compose surface placement, then shift so the chosen anchor lands on the
      // spawn point (no item translation otherwise).
      const spawnMatrix = new THREE.Matrix4().compose(worldPos, finalQuat, spawnScale);
      const anchorOffset = new THREE.Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z);
      const finalMatrix = new THREE.Matrix4().multiplyMatrices(spawnMatrix, anchorOffset);

      if (gpuInstancing) {
        instancedItems.push({ template: sourceItem, matrix: finalMatrix, applyTemplateTransform: false });
        continue;
      }

      const instance = sourceItem.clone(true);
      instance.matrixAutoUpdate = false;
      instance.matrix.copy(finalMatrix);
      if (hasPivot) instance.userData.pivot = sourcePivot.clone();
      finalMatrix.decompose(instance.position, instance.quaternion, instance.scale);

      group.add(instance);
    }

    if (gpuInstancing) renderInstanced(ctx.nodeId, group, instancedItems);
    return { geometry: group };
  },
};
