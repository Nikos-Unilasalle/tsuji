import * as THREE from "three";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { getSourcePivot } from "./transform";

/**
 * One item to place: `template` is the source object to draw (its mesh
 * geometry/material is reused, never mutated), `matrix` is where this
 * particular copy goes, and `color` is an optional per-instance tint (drawn
 * via InstancedMesh's built-in instanceColor, multiplied into the material's
 * own color the same way three.js does it everywhere else).
 */
export interface InstancedItemSpec {
  template: THREE.Object3D;
  matrix: THREE.Matrix4;
  color?: THREE.Color;
  /**
   * Whether to apply the template's own matrix and pivot offset. Defaults to true.
   * Set to false when matrix is already pre-composed with the template transform (e.g. Spawner).
   */
  applyTemplateTransform?: boolean;
}

/**
 * Buckets tracked per node so the next evaluate can dispose exactly the
 * InstancedMesh geometries/materials it allocated, the same lifecycle
 * particles/render-instances already uses for its single mesh.
 */
const bucketCache = createNodeCache<THREE.InstancedMesh[]>((meshes) => {
  for (const mesh of meshes) disposeObject3D(mesh);
});

/**
 * Draws `items` as one InstancedMesh per unique (template, mesh-within-template)
 * pair instead of one Object3D per item — the "1 draw call whatever the
 * count" trade this app's particle instancing nodes already make, generalized
 * to graph nodes that place many copies of a static template (Array, Spawner,
 * Texture Pixel Spawner). A template that is itself a compound object (e.g. a
 * merged multi-part "flower") still gets one InstancedMesh per part, each
 * carrying that part's own local offset composed under every placement.
 *
 * Individual copies stop being addressable as separate Object3D nodes once
 * drawn this way — Get/Set Instance and the viewport gizmo can no longer pick
 * one out — so callers gate this behind an explicit "GPU Instancing" toggle
 * rather than making it the default.
 */
export function renderInstanced(nodeId: string, group: THREE.Group, items: InstancedItemSpec[]): void {
  const prevMeshes = bucketCache.get(nodeId);
  if (prevMeshes) for (const mesh of prevMeshes) disposeObject3D(mesh);
  group.clear();

  interface Bucket {
    meshTemplate: THREE.Mesh;
    localMatrix: THREE.Matrix4;
    entries: { matrix: THREE.Matrix4; color?: THREE.Color }[];
  }
  const buckets = new Map<string, Bucket>();

  for (const item of items) {
    item.template.updateMatrixWorld(true);
    const sourcePivot = getSourcePivot(item.template);
    const hasPivot = sourcePivot.lengthSq() > 1e-9;
    const pivotInv = hasPivot ? new THREE.Matrix4().makeTranslation(-sourcePivot.x, -sourcePivot.y, -sourcePivot.z) : null;

    const applyTransform = item.applyTemplateTransform !== false;
    let templateTransform = new THREE.Matrix4();
    if (applyTransform) {
      if (pivotInv) {
        templateTransform.multiplyMatrices(item.template.matrix, pivotInv);
      } else {
        templateTransform.copy(item.template.matrix);
      }
    }

    const invRoot = new THREE.Matrix4().copy(item.template.matrixWorld).invert();
    let meshIndex = 0;
    item.template.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const key = `${item.template.uuid}#${meshIndex}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        const childRelative = new THREE.Matrix4().multiplyMatrices(invRoot, child.matrixWorld);
        const localMatrix = applyTransform
          ? new THREE.Matrix4().multiplyMatrices(templateTransform, childRelative)
          : childRelative;
        bucket = { meshTemplate: child, localMatrix, entries: [] };
        buckets.set(key, bucket);
      }
      bucket.entries.push({ matrix: item.matrix, color: item.color });
      meshIndex++;
    });
  }

  const builtMeshes: THREE.InstancedMesh[] = [];
  const composed = new THREE.Matrix4();
  for (const bucket of buckets.values()) {
    const geometry = bucket.meshTemplate.geometry.clone();
    const sourceMaterial = Array.isArray(bucket.meshTemplate.material)
      ? bucket.meshTemplate.material[0]
      : bucket.meshTemplate.material;
    const material = sourceMaterial ? sourceMaterial.clone() : new THREE.MeshStandardMaterial({ color: 0xffffff });

    const mesh = new THREE.InstancedMesh(geometry, material, bucket.entries.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    let hasColor = false;
    bucket.entries.forEach((entry, i) => {
      composed.multiplyMatrices(entry.matrix, bucket.localMatrix);
      mesh.setMatrixAt(i, composed);
      if (entry.color) {
        mesh.setColorAt(i, entry.color);
        hasColor = true;
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (hasColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    group.add(mesh);
    builtMeshes.push(mesh);
  }

  bucketCache.set(nodeId, builtMeshes);
}
