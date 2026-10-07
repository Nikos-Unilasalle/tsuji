import * as THREE from "three";

const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const size = new THREE.Vector3();
const parentRotation = new THREE.Quaternion();
const cameraRotation = new THREE.Quaternion();
const scratch = new THREE.Vector3();

/** Turns `object` to face `camera`, keeping the position and size its matrix gives it. */
function orient(object: THREE.Object3D, camera: THREE.Camera): void {
  object.matrix.decompose(position, rotation, size);
  if (object.parent) object.parent.getWorldQuaternion(parentRotation).invert();
  else parentRotation.identity();
  // From the camera's world matrix, not its quaternion: a camera placed by
  // a matrix (the Camera node's output view) never updates its quaternion.
  camera.matrixWorld.decompose(scratch, cameraRotation, scratch);
  rotation.copy(parentRotation).multiply(cameraRotation);
  object.matrix.compose(position, rotation, size);
  if (object.parent) object.matrixWorld.multiplyMatrices(object.parent.matrixWorld, object.matrix);
  else object.matrixWorld.copy(object.matrix);
  // The renderer has already derived these from the old matrix by the time a
  // material's hook runs; bring them in line with the new one.
  object.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
  object.normalMatrix.getNormalMatrix(object.modelViewMatrix);
}

/**
 * The turn rides on the material, not the mesh: the output view draws
 * clones of the scene's objects, and a clone keeps its material (shared) and
 * its userData (copied) but not the mesh's own onBeforeRender. Any hook the
 * material already had still runs first.
 */
function hookMaterial(material: THREE.Material): void {
  if (material.userData.faceCameraHooked) return;
  material.userData.faceCameraHooked = true;
  const previous = material.onBeforeRender;
  material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
    previous.call(this, renderer, scene, camera, geometry, object, group);
    if (object.userData?.faceCamera) orient(object, camera);
  };
}

/**
 * Makes a mesh face whichever camera is drawing it — a label, a number on an
 * axis, a formula — so it reads upright from any side. The turn happens at
 * draw time, per camera, so the editor view and the output view each see it
 * face-on, and the mesh keeps its own position and size from its matrix.
 * Call again after the mesh's material is replaced.
 */
export function faceCamera(mesh: THREE.Mesh, enabled = true): void {
  mesh.userData.faceCamera = enabled;
  if (!enabled) return;
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) hookMaterial(material);
}
