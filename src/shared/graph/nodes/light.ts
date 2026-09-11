import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { asVector3, composeNativeMatrix, extractPositionFromInput } from "./transform";

const lightCache = createNodeCache<THREE.Object3D>(disposeObject3D);

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

/**
 * A small editor-only marker so a light is visible (and selectable) as
 * something other than its own effect on the scene — cameras and Empties
 * already get one (see camera.ts / object.ts), lights didn't. Every piece is
 * tagged `isHelper` so it hides along with them: in the output window, the
 * editor's own camera-preview pane, and now behind the viewport's Tab
 * overlay toggle (see Viewport.tsx).
 */
function createLightIcon(kind: "directional" | "point" | "spot"): THREE.Object3D {
  const group = new THREE.Group();
  const color = 0xfbbf24;
  const mat = new THREE.LineBasicMaterial({ color });

  if (kind === "point") {
    const geo = new THREE.IcosahedronGeometry(0.15, 0);
    group.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), mat));
  } else if (kind === "spot") {
    const geo = new THREE.ConeGeometry(0.12, 0.3, 8, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, -0.15);
    group.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), mat));
  } else {
    const bulbGeo = new THREE.IcosahedronGeometry(0.1, 0);
    group.add(new THREE.LineSegments(new THREE.WireframeGeometry(bulbGeo), mat));
    const rayPoints: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      rayPoints.push(dir.clone().multiplyScalar(0.14), dir.clone().multiplyScalar(0.22));
    }
    const raysGeo = new THREE.BufferGeometry().setFromPoints(rayPoints);
    group.add(new THREE.LineSegments(raysGeo, mat));
  }

  group.traverse((child) => {
    child.userData.isHelper = true;
  });
  return group;
}

/** Directional Light node — simulates distant sun lighting with directional shadow mapping. */
export const LIGHT_DIRECTIONAL_NODE: NodeDefinition = {
  type: "light/directional",
  label: "Directional Light",
  category: "lighting",
  inputs: [
    { id: "color", label: "Color", type: "color" },
    { id: "intensity", label: "Intensity", type: "value" },
    { id: "target", label: "Target", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "castShadow", label: "Shadows", type: "value" },
    { id: "shadowSoftness", label: "Shadow Softness", type: "value" },
  ],
  outputs: [{ id: "light", label: "Light", type: "geometry" }],
  defaultParams: {
    location: new THREE.Vector3(5, 10, 7),
    target: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    color: new THREE.Color(0xffffff),
    intensity: 1.5,
    castShadow: 1,
    shadowSoftness: 1,
  },
  paramFields: [
    { id: "location", label: "Location", kind: "vector" },
    { id: "target", label: "Target (fallback)", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector" },
    { id: "color", label: "Color", kind: "color" },
    { id: "intensity", label: "Intensity", kind: "number", step: 0.1 },
    { id: "castShadow", label: "Cast Shadows", kind: "boolean" },
    { id: "shadowSoftness", label: "Shadow Softness", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    let light = lightCache.get(ctx.nodeId) as THREE.DirectionalLight | undefined;

    if (!light) {
      light = new THREE.DirectionalLight(0xffffff, 1.5);
      light.shadow.mapSize.width = 2048;
      light.shadow.mapSize.height = 2048;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 50;
      const d = 10;
      light.shadow.camera.left = -d;
      light.shadow.camera.right = d;
      light.shadow.camera.top = d;
      light.shadow.camera.bottom = -d;
      light.shadow.bias = -0.0005;
      light.userData.nodeId = ctx.nodeId;
      light.add(createLightIcon("directional"));

      lightCache.set(ctx.nodeId, light);
    }

    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0xffffff)));
    const intensity = Math.max(0, inputs.intensity !== undefined ? Number(inputs.intensity) : Number(params.intensity) ?? 1.5);
    const castShadow = inputs.castShadow !== undefined ? Number(inputs.castShadow) > 0 : Boolean(params.castShadow ?? true);
    const shadowSoftness = Math.max(0, inputs.shadowSoftness !== undefined ? Number(inputs.shadowSoftness) : Number(params.shadowSoftness ?? 1));

    light.color.copy(color);
    light.intensity = intensity;
    light.castShadow = castShadow;
    light.shadow.radius = shadowSoftness;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      light.matrixAutoUpdate = false;
      const mat = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);
      light.matrix.copy(mat);
      mat.decompose(light.position, light.quaternion, light.scale);
    }

    const defaultTarget = asVector3(params?.target, new THREE.Vector3(0, 0, 0));
    const targetPos = inputs.target !== undefined
      ? extractPositionFromInput(inputs.target, defaultTarget)
      : defaultTarget;

    light.target.position.copy(targetPos);
    light.target.updateMatrixWorld(true);
    light.updateMatrixWorld(true);

    return { light };
  },
};

/** Point Light node — omnidirectional point light source with distance attenuation and shadow mapping. */
export const LIGHT_POINT_NODE: NodeDefinition = {
  type: "light/point",
  label: "Point Light",
  category: "lighting",
  inputs: [
    { id: "color", label: "Color", type: "color" },
    { id: "intensity", label: "Intensity", type: "value" },
    { id: "distance", label: "Distance", type: "value" },
    { id: "decay", label: "Decay", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "castShadow", label: "Shadows", type: "value" },
    { id: "shadowSoftness", label: "Shadow Softness", type: "value" },
  ],
  outputs: [{ id: "light", label: "Light", type: "geometry" }],
  defaultParams: {
    location: new THREE.Vector3(0, 5, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    color: new THREE.Color(0xffffff),
    intensity: 2.0,
    distance: 15,
    decay: 2,
    castShadow: 1,
    shadowSoftness: 1,
  },
  paramFields: [
    { id: "location", label: "Location", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector" },
    { id: "color", label: "Color", kind: "color" },
    { id: "intensity", label: "Intensity", kind: "number", step: 0.1 },
    { id: "distance", label: "Distance", kind: "number", step: 0.5 },
    { id: "decay", label: "Decay", kind: "number", step: 0.1 },
    { id: "castShadow", label: "Cast Shadows", kind: "boolean" },
    { id: "shadowSoftness", label: "Shadow Softness", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    let light = lightCache.get(ctx.nodeId) as THREE.PointLight | undefined;
    if (!light) {
      light = new THREE.PointLight(0xffffff, 2.0, 15, 2);
      light.shadow.mapSize.width = 1024;
      light.shadow.mapSize.height = 1024;
      light.shadow.bias = -0.001;
      light.userData.nodeId = ctx.nodeId;
      light.add(createLightIcon("point"));
      lightCache.set(ctx.nodeId, light);
    }

    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0xffffff)));
    const intensity = Math.max(0, inputs.intensity !== undefined ? Number(inputs.intensity) : Number(params.intensity) ?? 2.0);
    const distance = Math.max(0, inputs.distance !== undefined ? Number(inputs.distance) : Number(params.distance) ?? 15);
    const decay = Math.max(0, inputs.decay !== undefined ? Number(inputs.decay) : Number(params.decay) ?? 2);
    const castShadow = inputs.castShadow !== undefined ? Number(inputs.castShadow) > 0 : Boolean(params.castShadow ?? true);
    const shadowSoftness = Math.max(0, inputs.shadowSoftness !== undefined ? Number(inputs.shadowSoftness) : Number(params.shadowSoftness ?? 1));

    light.color.copy(color);
    light.intensity = intensity;
    light.distance = distance;
    light.decay = decay;
    light.castShadow = castShadow;
    light.shadow.radius = shadowSoftness;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      light.matrixAutoUpdate = false;
      light.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    return { light };
  },
};

/** Spot Light node — focused cone light beam (projector) with cone angle, penumbra edge softness, and shadows. */
export const LIGHT_SPOT_NODE: NodeDefinition = {
  type: "light/spot",
  label: "Spot Light",
  category: "lighting",
  inputs: [
    { id: "color", label: "Color", type: "color" },
    { id: "intensity", label: "Intensity", type: "value" },
    { id: "angle", label: "Angle (°)", type: "value" },
    { id: "penumbra", label: "Penumbra", type: "value" },
    { id: "target", label: "Target", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "castShadow", label: "Shadows", type: "value" },
    { id: "shadowSoftness", label: "Shadow Softness", type: "value" },
  ],
  outputs: [{ id: "light", label: "Light", type: "geometry" }],
  defaultParams: {
    location: new THREE.Vector3(0, 6, 4),
    target: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    color: new THREE.Color(0xffffff),
    intensity: 3.0,
    angle: 45,
    penumbra: 0.3,
    castShadow: 1,
    shadowSoftness: 1,
  },
  paramFields: [
    { id: "location", label: "Location", kind: "vector" },
    { id: "target", label: "Target (fallback)", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector" },
    { id: "color", label: "Color", kind: "color" },
    { id: "intensity", label: "Intensity", kind: "number", step: 0.1 },
    { id: "angle", label: "Cone Angle (°)", kind: "number", step: 5 },
    { id: "penumbra", label: "Soft Edge (0..1)", kind: "number", step: 0.05 },
    { id: "castShadow", label: "Cast Shadows", kind: "boolean" },
    { id: "shadowSoftness", label: "Shadow Softness", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    let light = lightCache.get(ctx.nodeId) as THREE.SpotLight | undefined;

    if (!light) {
      light = new THREE.SpotLight(0xffffff, 3.0, 0, (45 * Math.PI) / 180, 0.3);
      light.shadow.mapSize.width = 2048;
      light.shadow.mapSize.height = 2048;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 50;
      light.shadow.bias = -0.0005;
      light.userData.nodeId = ctx.nodeId;
      light.add(createLightIcon("spot"));

      lightCache.set(ctx.nodeId, light);
    }

    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0xffffff)));
    const intensity = Math.max(0, inputs.intensity !== undefined ? Number(inputs.intensity) : Number(params.intensity) ?? 3.0);
    const angleDeg = Math.max(1, Math.min(89, inputs.angle !== undefined ? Number(inputs.angle) : Number(params.angle) ?? 45));
    const penumbra = Math.max(0, Math.min(1, inputs.penumbra !== undefined ? Number(inputs.penumbra) : Number(params.penumbra) ?? 0.3));
    const castShadow = inputs.castShadow !== undefined ? Number(inputs.castShadow) > 0 : Boolean(params.castShadow ?? true);
    const shadowSoftness = Math.max(0, inputs.shadowSoftness !== undefined ? Number(inputs.shadowSoftness) : Number(params.shadowSoftness ?? 1));

    light.color.copy(color);
    light.intensity = intensity;
    light.angle = (angleDeg * Math.PI) / 180;
    light.penumbra = penumbra;
    light.castShadow = castShadow;
    light.shadow.radius = shadowSoftness;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      light.matrixAutoUpdate = false;
      const mat = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);
      light.matrix.copy(mat);
      mat.decompose(light.position, light.quaternion, light.scale);
    }

    const defaultTarget = asVector3(params?.target, new THREE.Vector3(0, 0, 0));
    const targetPos = inputs.target !== undefined
      ? extractPositionFromInput(inputs.target, defaultTarget)
      : defaultTarget;

    light.target.position.copy(targetPos);
    light.target.updateMatrixWorld(true);
    light.updateMatrixWorld(true);

    return { light };
  },
};

/**
 * Ambient Light node — deliberately has no location/rotation/scale, unlike
 * every other light here: THREE.AmbientLight is position-independent (it
 * lights the whole scene uniformly), so transform params on it would be
 * inert fields that visibly do nothing.
 */
export const LIGHT_AMBIENT_NODE: NodeDefinition = {
  type: "light/ambient",
  label: "Ambient Light",
  category: "lighting",
  inputs: [
    { id: "color", label: "Color", type: "color" },
    { id: "intensity", label: "Intensity", type: "value" },
  ],
  outputs: [{ id: "light", label: "Light", type: "geometry" }],
  defaultParams: {
    color: new THREE.Color(0xffffff),
    intensity: 0.4,
  },
  paramFields: [
    { id: "color", label: "Color", kind: "color" },
    { id: "intensity", label: "Intensity", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    let light = lightCache.get(ctx.nodeId) as THREE.AmbientLight | undefined;
    if (!light) {
      light = new THREE.AmbientLight(0xffffff, 0.4);
      light.userData.nodeId = ctx.nodeId;
      lightCache.set(ctx.nodeId, light);
    }

    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0xffffff)));
    const intensity = Math.max(0, inputs.intensity !== undefined ? Number(inputs.intensity) : Number(params.intensity) ?? 0.4);

    light.color.copy(color);
    light.intensity = intensity;

    return { light };
  },
};
