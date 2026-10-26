import * as THREE from "three";

/**
 * Decides, frame by frame, whether the shadow maps need re-rendering.
 *
 * three.js re-renders every shadow map on every frame by default — for a
 * Point Light that is six full scene passes — even when nothing that casts a
 * shadow has moved, which is most frames of most scenes while editing. With
 * `renderer.shadowMap.autoUpdate = false`, this tracker flips `needsUpdate`
 * only when something the maps depend on changed since the last check.
 *
 * What a shadow map depends on, and so what goes into the signature: every
 * casting light (pose, its target, shadow camera and map size) and every
 * casting object (pose, geometry and its buffers' versions, draw range,
 * instance matrices, morph weights, skinning bones, and the material
 * properties the depth pass copies — side, alpha test, alpha/displacement
 * maps, clipping planes). Anything whose depth pass can change without
 * touching any of that — a custom depth material, whose uniforms may animate,
 * or a BatchedMesh — is treated as changed on every frame.
 */
export class ShadowUpdateTracker {
  private previous: number[] = [];
  private current: number[] = [];
  private hasPrevious = false;

  /** True when the shadow maps have to be re-rendered for this frame. */
  check(
    scene: THREE.Scene,
    renderer: Pick<THREE.WebGLRenderer, "shadowMap" | "localClippingEnabled" | "clippingPlanes">,
  ): boolean {
    const sig = this.current;
    sig.length = 0;
    let volatile = false;

    // The renderer's own state the depth pass reads.
    sig.push(renderer.shadowMap.type, renderer.localClippingEnabled ? 1 : 0);
    pushPlanes(sig, renderer.clippingPlanes);

    scene.updateMatrixWorld();
    scene.traverseVisible((obj) => {
      if (volatile) return;
      const light = obj as THREE.Light & { shadow?: THREE.LightShadow; target?: THREE.Object3D };
      if (light.isLight) {
        if (!light.castShadow || !light.shadow) return;
        sig.push(1, light.id);
        pushMatrix(sig, light.matrixWorld);
        if (light.target) {
          light.target.updateMatrixWorld();
          pushMatrix(sig, light.target.matrixWorld);
        }
        const shadow = light.shadow;
        sig.push(shadow.mapSize.x, shadow.mapSize.y);
        const cam = shadow.camera as THREE.PerspectiveCamera & THREE.OrthographicCamera;
        sig.push(cam.near, cam.far, cam.left ?? 0, cam.right ?? 0, cam.top ?? 0, cam.bottom ?? 0);
        const spot = light as unknown as THREE.SpotLight;
        sig.push(spot.angle ?? 0, spot.distance ?? 0, (shadow as THREE.SpotLightShadow).focus ?? 0);
        return;
      }

      const mesh = obj as THREE.Mesh;
      if (!mesh.castShadow || !(mesh.isMesh || (obj as THREE.Line).isLine || (obj as THREE.Points).isPoints)) return;
      if (mesh.customDepthMaterial || mesh.customDistanceMaterial || (obj as THREE.BatchedMesh).isBatchedMesh) {
        volatile = true;
        return;
      }
      sig.push(2, mesh.id);
      pushMatrix(sig, mesh.matrixWorld);

      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (geometry) {
        sig.push(geometry.id, geometry.drawRange.start, geometry.drawRange.count);
        if (geometry.index) sig.push(geometry.index.version, geometry.index.count);
        const position = geometry.attributes.position;
        if (position) {
          const interleaved = position as THREE.InterleavedBufferAttribute;
          sig.push(interleaved.isInterleavedBufferAttribute ? interleaved.data.version : (position as THREE.BufferAttribute).version, position.count);
        }
        const groups = geometry.groups;
        sig.push(groups.length);
      }

      const instanced = mesh as unknown as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) sig.push(instanced.count, instanced.instanceMatrix.version);

      const morph = mesh.morphTargetInfluences;
      if (morph) for (let i = 0; i < morph.length; i++) sig.push(morph[i]);

      const skinned = mesh as unknown as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh && skinned.skeleton) {
        pushMatrix(sig, skinned.bindMatrix);
        for (const bone of skinned.skeleton.bones) pushMatrix(sig, bone.matrixWorld);
      }

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) pushMaterial(sig, material);
    });

    if (volatile) {
      // Nothing to compare against next frame: whatever made this frame
      // volatile may be gone by then, and a stale signature must not match.
      this.hasPrevious = false;
      return true;
    }

    const changed = !this.hasPrevious || !sameNumbers(sig, this.previous);
    this.current = this.previous;
    this.previous = sig;
    this.hasPrevious = true;
    return changed;
  }

  /** Forces the next check to report a change. */
  invalidate(): void {
    this.hasPrevious = false;
  }
}

function pushMatrix(sig: number[], m: THREE.Matrix4): void {
  const e = m.elements;
  for (let i = 0; i < 16; i++) sig.push(e[i]);
}

function pushPlanes(sig: number[], planes: THREE.Plane[] | null | undefined): void {
  if (!planes) {
    sig.push(0);
    return;
  }
  sig.push(planes.length);
  for (const p of planes) sig.push(p.normal.x, p.normal.y, p.normal.z, p.constant);
}

function pushTexture(sig: number[], texture: THREE.Texture | null | undefined): void {
  if (!texture) {
    sig.push(0);
    return;
  }
  sig.push(texture.id, texture.version);
}

/** Only what the depth/distance materials copy from the object's own material. */
function pushMaterial(sig: number[], material: THREE.Material | undefined): void {
  if (!material) {
    sig.push(0);
    return;
  }
  const m = material as THREE.MeshStandardMaterial;
  sig.push((material as unknown as { id: number }).id, m.visible ? 1 : 0, m.side, m.shadowSide ?? -1, m.alphaTest, m.transparent ? 1 : 0, m.opacity);
  pushTexture(sig, m.map);
  pushTexture(sig, m.alphaMap);
  pushTexture(sig, m.displacementMap);
  sig.push(m.displacementScale ?? 0, m.displacementBias ?? 0);
  pushPlanes(sig, m.clippingPlanes);
}

function sameNumbers(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // NaN-safe: a NaN that stays NaN is unchanged.
    if (a[i] !== b[i] && !(a[i] !== a[i] && b[i] !== b[i])) return false;
  }
  return true;
}
