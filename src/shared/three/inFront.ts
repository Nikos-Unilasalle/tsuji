import * as THREE from "three";

/**
 * Draws an object on top of everything else, the way Blender's armature
 * "In Front" does: a rig sitting inside a mesh is hidden by it, which makes
 * the rig impossible to pick or read exactly when it is being edited.
 *
 * Done on the objects' own materials — depth test and write off, drawn late —
 * with what was there kept on the object, so turning it off puts back exactly
 * that. Calling it again while it is on also covers parts added since.
 */
const FRONT_RENDER_ORDER = 900;

interface Saved {
  renderOrder: number;
  materials: { material: THREE.Material; depthTest: boolean; depthWrite: boolean }[];
}

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

export function setInFront(root: THREE.Object3D, on: boolean): void {
  root.traverse((object) => {
    const materials = materialsOf(object);
    if (materials.length === 0) return;
    const saved = object.userData.__beforeInFront as Saved | undefined;
    if (on) {
      if (!saved) {
        object.userData.__beforeInFront = {
          renderOrder: object.renderOrder,
          materials: materials.map((material) => ({ material, depthTest: material.depthTest, depthWrite: material.depthWrite })),
        } satisfies Saved;
      }
      object.renderOrder = FRONT_RENDER_ORDER;
      for (const material of materials) {
        material.depthTest = false;
        material.depthWrite = false;
      }
    } else if (saved) {
      object.renderOrder = saved.renderOrder;
      for (const { material, depthTest, depthWrite } of saved.materials) {
        material.depthTest = depthTest;
        material.depthWrite = depthWrite;
      }
      delete object.userData.__beforeInFront;
    }
  });
}

/** Rig nodes whose skeleton is drawn in front while they are selected; a Skin's rig is, while the Skin is. */
export function isRigNodeType(type: string): boolean {
  return type.startsWith("rig/") && type !== "rig/skin";
}
