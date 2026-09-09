import * as THREE from "three";
import { WIND_GLSL, WIND_UNIFORM_DECL, createWindUniforms } from "./windField";

/**
 * Makes any existing material sway in the wind, without replacing it.
 *
 * The alternative — swapping in a custom ShaderMaterial — would throw away
 * whatever the user had already set up (maps, PBR values, a Hologram material
 * upstream). So this patches through `onBeforeCompile` instead: the material
 * keeps its own lighting and look, and gains a world-space displacement whose
 * amount is masked by height, so a trunk is planted and a tip whips.
 *
 * The displacement is computed in world space (wind is a property of the
 * world, not of the model) and converted back with a uniform inverse matrix
 * rather than a GLSL `inverse()` call — one CPU-side invert per frame is
 * cheaper than one per vertex, and it keeps the chunk valid on any GLSL
 * version three targets.
 */
export interface WindSwayUniforms extends Record<string, THREE.IUniform> {
  uSwayInfluence: THREE.IUniform<number>;
  uSwayAnchorY: THREE.IUniform<number>;
  uSwayHeight: THREE.IUniform<number>;
  uSwayStiffness: THREE.IUniform<number>;
  uSwayMatrixInverse: THREE.IUniform<THREE.Matrix4>;
}

export function createWindSwayUniforms(): WindSwayUniforms {
  return {
    ...createWindUniforms(),
    uSwayInfluence: { value: 1 },
    uSwayAnchorY: { value: 0 },
    uSwayHeight: { value: 1 },
    uSwayStiffness: { value: 1.6 },
    uSwayMatrixInverse: { value: new THREE.Matrix4() },
  } as WindSwayUniforms;
}

const SWAY_DECLARATIONS = /* glsl */ `
  ${WIND_UNIFORM_DECL}
  uniform float uSwayInfluence;
  uniform float uSwayAnchorY;
  uniform float uSwayHeight;
  uniform float uSwayStiffness;
  uniform mat4 uSwayMatrixInverse;

  ${WIND_GLSL}
`;

const SWAY_BODY = /* glsl */ `
  {
    vec4 swayWorld = modelMatrix * vec4(transformed, 1.0);
    float swayMask = clamp((swayWorld.y - uSwayAnchorY) / max(0.0001, uSwayHeight), 0.0, 1.0);
    swayMask = pow(swayMask, uSwayStiffness);
    vec2 swayOffset = windOffset(swayWorld.xz) * uSwayInfluence * swayMask;
    // Bending shortens: drop the vertex as it leans, or the mesh visibly stretches.
    swayWorld.xyz += vec3(swayOffset.x, -length(swayOffset) * 0.25, swayOffset.y);
    transformed = (uSwayMatrixInverse * swayWorld).xyz;
  }
`;

/** Marker left on a patched material so re-evaluating the node is a no-op instead of a re-patch. */
const SWAY_TAG = "__windSwayNodeId";

export function isPatchedForSway(material: THREE.Material, nodeId: string): boolean {
  return (material as any).userData?.[SWAY_TAG] === nodeId;
}

/**
 * Adds the sway to a material in place. Only call this on a material you own
 * — see `createSwayingMaterial` for the case where you don't.
 */
export function patchMaterialForSway(
  material: THREE.Material,
  uniforms: WindSwayUniforms,
  nodeId: string,
): THREE.Material {
  material.userData = { ...material.userData, [SWAY_TAG]: nodeId };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      `${SWAY_DECLARATIONS}\nvoid main() {`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>\n${SWAY_BODY}`,
    );
  };

  // Two materials with identical programs are cached together by three; the
  // key has to change or the patched one silently reuses the unpatched program.
  material.customProgramCacheKey = () => `windSway-${nodeId}`;
  material.needsUpdate = true;

  return material;
}

/**
 * Returns a patched *clone* of `source`. Cloning matters: the incoming
 * material may be shared with meshes this node was never wired to, and
 * patching in place would set the whole scene swaying.
 */
export function createSwayingMaterial(
  source: THREE.Material,
  uniforms: WindSwayUniforms,
  nodeId: string,
): THREE.Material {
  return patchMaterialForSway(source.clone(), uniforms, nodeId);
}

/** Keeps the inverse-model uniform current. Call once per frame per swaying mesh. */
export function updateSwayMatrix(mesh: THREE.Object3D, uniforms: WindSwayUniforms): void {
  mesh.updateWorldMatrix(true, false);
  uniforms.uSwayMatrixInverse.value.copy(mesh.matrixWorld).invert();
}
