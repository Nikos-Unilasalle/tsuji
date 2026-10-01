import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { objectWorldPosition, worldMatrixOf } from "../objectPosition";
import { asColor, numberInput } from "./object";
import { asVector3, composeNativeMatrix } from "./transform";
import { createTileableVolumeState, TileableGpuSettings, TileableVolumeState, updateTileableVolume } from "../../three/tileableNoiseGpu";
import { MAX_CLOUD_LIGHT_STEPS, MAX_CLOUD_STEPS, VOLUME_CLOUDS_FRAGMENT, VOLUME_CLOUDS_VERTEX } from "../../three/shaders/volumeCloudsShader";

/**
 * Volume Clouds — a raymarched box of clouds driven by tileable noise
 * volumes, the use sebh/TileableVolumeNoise was written for.
 *
 * Works on its own: with nothing wired it generates the original's two
 * volumes itself (128³ base shape, 32³ erosion detail, both packed). Wire a
 * Tileable Noise Volume into Shape or Detail to swap in your own — any 3D
 * texture works, only its red channel is read.
 */

/** Height profiles over the box's height: fade-in start/end at the base, fade-out start/end at the top. */
const PROFILES: Record<string, [number, number, number, number]> = {
  cumulus: [0.0, 0.12, 0.45, 0.95],
  stratocumulus: [0.0, 0.15, 0.3, 0.6],
  stratus: [0.0, 0.08, 0.15, 0.35],
  cumulonimbus: [0.0, 0.05, 0.75, 1.0],
  fog: [0.0, 0.0, 0.6, 1.0],
};
const PROFILE_NAMES = Object.keys(PROFILES);

const DEFAULT_SHAPE: TileableGpuSettings = { pattern: "cloud-shape", frequency: [4, 4, 4], channels: false, octaves: 3, gain: 0.5, seed: 0, invert: false };
const DEFAULT_DETAIL: TileableGpuSettings = { ...DEFAULT_SHAPE, pattern: "cloud-detail", frequency: [2, 2, 2] };

/** Shared by every clouds node: the defaults are the same volumes, no reason to hold one pair per node. */
const defaultVolumes = { shape: createTileableVolumeState(), detail: createTileableVolumeState() };

let placeholder: THREE.Data3DTexture | null = null;
function placeholderVolume(): THREE.Data3DTexture {
  if (!placeholder) {
    placeholder = new THREE.Data3DTexture(new Uint8Array([0]), 1, 1, 1);
    placeholder.format = THREE.RedFormat;
    placeholder.unpackAlignment = 1;
    placeholder.needsUpdate = true;
  }
  return placeholder;
}

function volumeInput(value: unknown, renderer: THREE.WebGLRenderer | undefined, fallback: TileableVolumeState, settings: TileableGpuSettings, size: number): THREE.Texture {
  if (value instanceof THREE.Data3DTexture) return value;
  if (!renderer) return placeholderVolume();
  return updateTileableVolume(renderer, fallback, settings, size).texture;
}

function createCloudMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: VOLUME_CLOUDS_VERTEX,
    fragmentShader: VOLUME_CLOUDS_FRAGMENT,
    uniforms: {
      uInvModel: { value: new THREE.Matrix4() },
      uShape: { value: placeholderVolume() },
      uDetail: { value: placeholderVolume() },
      uHalfSize: { value: new THREE.Vector3(1, 1, 1) },
      uShapeOffset: { value: new THREE.Vector3() },
      uDetailOffset: { value: new THREE.Vector3() },
      uShapeScale: { value: 1 },
      uDetailScale: { value: 1 },
      uShapeLevels: { value: new THREE.Vector2(0, 1) },
      uProfile: { value: new THREE.Vector4() },
      uCoverage: { value: 0.5 },
      uDensity: { value: 1 },
      uErosion: { value: 0.5 },
      uEdgeFade: { value: 0.1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSkyColor: { value: new THREE.Color() },
      uGroundColor: { value: new THREE.Color() },
      uAnisotropy: { value: 0.6 },
      uPowder: { value: 0.5 },
      uSteps: { value: 64 },
      uLightSteps: { value: 6 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  // The pose can change after evaluate (a gizmo drag), so the inverse is taken at draw time.
  material.onBeforeRender = (_r, _s, _c, _g, object) => {
    (material.uniforms.uInvModel.value as THREE.Matrix4).copy(object.matrixWorld).invert();
  };
  return material;
}

/** Direction toward the sun, world space: a directional light shines from itself to its target, anything else from where it stands. */
function sunDirection(sun: unknown, fallback: THREE.Vector3, boxCenter: THREE.Vector3): THREE.Vector3 {
  if (!(sun instanceof THREE.Object3D)) return fallback.clone().normalize();
  const position = objectWorldPosition(sun);
  let directional: THREE.DirectionalLight | null = null;
  sun.traverse((o) => {
    if (!directional && o instanceof THREE.DirectionalLight) directional = o;
  });
  const toward = directional
    ? new THREE.Vector3().setFromMatrixPosition(worldMatrixOf((directional as THREE.DirectionalLight).target))
    : boxCenter;
  const dir = position.sub(toward);
  return dir.lengthSq() > 1e-8 ? dir.normalize() : fallback.clone().normalize();
}

const cloudCache = createNodeCache<THREE.Mesh>(disposeObject3D);

export const VOLUME_CLOUDS_NODE: NodeDefinition = {
  type: "object/volume-clouds",
  label: "Volume Clouds",
  category: "object",
  inputs: [
    { id: "shape", label: "Shape Volume (3D)", type: "texture" },
    { id: "detail", label: "Detail Volume (3D)", type: "texture" },
    { id: "sun", label: "Sun Light", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "boxSize", label: "Box Size", type: "vector" },
    { id: "coverage", label: "Coverage", type: "value" },
    { id: "density", label: "Density", type: "value" },
    { id: "erosion", label: "Erosion", type: "value" },
    { id: "wind", label: "Wind", type: "vector" },
    { id: "sunColor", label: "Sun Color", type: "color" },
  ],
  outputs: [
    { id: "geometry", label: "Clouds", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    location: new THREE.Vector3(0, 12, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    boxSize: new THREE.Vector3(60, 10, 60),
    profile: "cumulus",
    coverage: 0.5,
    density: 1.2,
    erosion: 0.6,
    shapeScale: 30,
    detailScale: 6,
    wind: new THREE.Vector3(1.5, 0, 0.5),
    edgeFade: 0.15,
    shapeBlack: 0.8,
    shapeWhite: 1,
    sunDirection: new THREE.Vector3(0.5, 0.6, 0.3),
    sunColor: new THREE.Color(1, 0.95, 0.88),
    sunIntensity: 8,
    skyColor: new THREE.Color(0.55, 0.68, 0.9),
    groundColor: new THREE.Color(0.32, 0.33, 0.36),
    ambient: 1,
    anisotropy: 0.6,
    powder: 0.5,
    steps: 64,
    lightSteps: 6,
  },
  paramFields: [
    { id: "profile", label: "Cloud Type", kind: "select", options: PROFILE_NAMES, group: "Shape" },
    { id: "coverage", label: "Coverage", kind: "number", step: 0.05, group: "Shape" },
    { id: "density", label: "Density", kind: "number", step: 0.1, group: "Shape" },
    { id: "erosion", label: "Edge Erosion", kind: "number", step: 0.05, group: "Shape" },
    { id: "shapeScale", label: "Shape Size (world)", kind: "number", step: 1, group: "Shape" },
    { id: "detailScale", label: "Detail Size (world)", kind: "number", step: 0.5, group: "Shape" },
    { id: "wind", label: "Wind (units / s)", kind: "vector", group: "Shape" },
    { id: "edgeFade", label: "Box Edge Fade", kind: "number", step: 0.05, group: "Shape" },
    { id: "shapeBlack", label: "Shape Levels: Black", kind: "number", step: 0.05, group: "Shape" },
    { id: "shapeWhite", label: "Shape Levels: White", kind: "number", step: 0.05, group: "Shape" },
    { id: "sunDirection", label: "Sun Direction (no light wired)", kind: "vector", group: "Lighting" },
    { id: "sunColor", label: "Sun Color", kind: "color", group: "Lighting" },
    { id: "sunIntensity", label: "Sun Intensity", kind: "number", step: 0.5, group: "Lighting" },
    { id: "skyColor", label: "Sky Ambient", kind: "color", group: "Lighting" },
    { id: "groundColor", label: "Ground Ambient", kind: "color", group: "Lighting" },
    { id: "ambient", label: "Ambient Intensity", kind: "number", step: 0.1, group: "Lighting" },
    { id: "anisotropy", label: "Silver Lining (anisotropy)", kind: "number", step: 0.05, group: "Lighting" },
    { id: "powder", label: "Powder (dark edges)", kind: "number", step: 0.05, group: "Lighting" },
    { id: "steps", label: "Raymarch Steps", kind: "number", step: 8, group: "Quality" },
    { id: "lightSteps", label: "Light Steps", kind: "number", step: 1, group: "Quality" },
    { id: "boxSize", label: "Box Size", kind: "vector", group: "Transform" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
  ],
  evaluate: (inputs, params, ctx) => {
    const box = asVector3(inputs.boxSize, asVector3(params.boxSize, new THREE.Vector3(60, 10, 60)));
    const half = new THREE.Vector3(Math.max(0.01, box.x), Math.max(0.01, box.y), Math.max(0.01, box.z)).multiplyScalar(0.5);

    let mesh = cloudCache.get(ctx.nodeId);
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), createCloudMaterial());
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      cloudCache.set(ctx.nodeId, mesh);
    }
    const u = (mesh.material as THREE.ShaderMaterial).uniforms;
    const halfSize = u.uHalfSize.value as THREE.Vector3;
    if (!halfSize.equals(half)) {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
      halfSize.copy(half);
    }

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    u.uShape.value = volumeInput(inputs.shape, ctx.renderer, defaultVolumes.shape, DEFAULT_SHAPE, 128);
    u.uDetail.value = volumeInput(inputs.detail, ctx.renderer, defaultVolumes.detail, DEFAULT_DETAIL, 32);

    const wind = asVector3(inputs.wind, asVector3(params.wind, new THREE.Vector3()));
    // Detail drifts faster than the shape so edges keep churning, as in Horizon Zero Dawn's clouds.
    (u.uShapeOffset.value as THREE.Vector3).copy(wind).multiplyScalar(-ctx.time);
    (u.uDetailOffset.value as THREE.Vector3).copy(wind).multiplyScalar(-1.5 * ctx.time);
    u.uShapeScale.value = Math.max(0.01, numberInput(undefined, params.shapeScale, 30));
    u.uDetailScale.value = Math.max(0.01, numberInput(undefined, params.detailScale, 6));
    (u.uShapeLevels.value as THREE.Vector2).set(numberInput(undefined, params.shapeBlack, 0.8), numberInput(undefined, params.shapeWhite, 1));
    (u.uProfile.value as THREE.Vector4).fromArray(PROFILES[String(params.profile)] ?? PROFILES.cumulus);
    u.uCoverage.value = Math.max(0, Math.min(1, numberInput(inputs.coverage, params.coverage, 0.5)));
    u.uDensity.value = Math.max(0, numberInput(inputs.density, params.density, 1.2));
    u.uErosion.value = Math.max(0, Math.min(1, numberInput(inputs.erosion, params.erosion, 0.6)));
    u.uEdgeFade.value = Math.max(0, Math.min(1, numberInput(undefined, params.edgeFade, 0.15)));

    const center = new THREE.Vector3().setFromMatrixPosition(mesh.matrix);
    const worldSun = sunDirection(inputs.sun, asVector3(params.sunDirection, new THREE.Vector3(0.5, 0.6, 0.3)), center);
    const toLocal = new THREE.Matrix3().setFromMatrix4(mesh.matrix).invert();
    (u.uSunDir.value as THREE.Vector3).copy(worldSun).applyMatrix3(toLocal).normalize();
    const sunIntensity = Math.max(0, numberInput(undefined, params.sunIntensity, 8));
    (u.uSunColor.value as THREE.Color).copy(asColor(inputs.sunColor, asColor(params.sunColor))).multiplyScalar(sunIntensity);
    const ambient = Math.max(0, numberInput(undefined, params.ambient, 1));
    (u.uSkyColor.value as THREE.Color).copy(asColor(params.skyColor)).multiplyScalar(ambient);
    (u.uGroundColor.value as THREE.Color).copy(asColor(params.groundColor)).multiplyScalar(ambient);
    u.uAnisotropy.value = Math.max(-0.95, Math.min(0.95, numberInput(undefined, params.anisotropy, 0.6)));
    u.uPowder.value = Math.max(0, Math.min(1, numberInput(undefined, params.powder, 0.5)));
    u.uSteps.value = Math.max(8, Math.min(MAX_CLOUD_STEPS, Math.round(numberInput(undefined, params.steps, 64))));
    u.uLightSteps.value = Math.max(1, Math.min(MAX_CLOUD_LIGHT_STEPS, Math.round(numberInput(undefined, params.lightSteps, 6))));

    return { geometry: mesh, matrix: mesh.matrix.clone() };
  },
};
