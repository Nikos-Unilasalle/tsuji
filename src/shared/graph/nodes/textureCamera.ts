import * as THREE from "three";
import { NodeDefinition } from "../types";
import { toBoolean } from "../sockets";
import { createNodeCache } from "../nodeCaches";
import { manualPose } from "./camera";
import { replaceCanvasTexture } from "./texture";

const NEAR = 0.05;
const FAR = 500;
const DEFAULT_FOV = 50;

interface TextureCameraState {
  target?: THREE.WebGLRenderTarget;
  camera?: THREE.PerspectiveCamera;
  width?: number;
  height?: number;
  buffer?: Uint8Array;
  canvas?: HTMLCanvasElement;
  texture?: THREE.CanvasTexture;
  /** Ticks up once per evaluate() call — throttle skips the render unless this hits `updateEvery`. */
  tickCount: number;
}

const textureCameraCache = createNodeCache<TextureCameraState>((s) => {
  s.target?.dispose();
  s.texture?.dispose();
});

const RESOLUTION_PRESETS: Record<string, [number, number] | null> = {
  "1:1 (256x256)": [256, 256],
  "1:1 (512x512)": [512, 512],
  "1:1 (1024x1024)": [1024, 1024],
  "16:9 (1280x720)": [1280, 720],
  "16:9 (1920x1080)": [1920, 1080],
  "9:16 (720x1280)": [720, 1280],
  Custom: null,
};

/**
 * A camera dedicated to feeding a texture, separate from `calibration/camera`
 * (which drives the main 3D view) for two reasons: it never costs anything
 * unless actually wired up, and it carries its own resolution/throttle/
 * readback controls tuned for that one job instead of inheriting the main
 * Camera's calibration mode, helper geometry and active-view plumbing.
 *
 * Two very different things share this one node on purpose: a low-res,
 * throttled "screen inside the scene" decoration, and a full-resolution,
 * every-frame "this texture *is* the deliverable" kinetic-type render. The
 * resolution presets span both (256px up to 1920x1080 or Custom); Throttle
 * only helps the first case and must stay at 1 for the second, since a
 * dropped frame in a motion graphic that's the actual output is visible in
 * a way a laggy screen-prop texture never is.
 */
export const TEXTURE_CAMERA_NODE: NodeDefinition = {
  type: "texture/camera",
  label: "Camera",
  category: "texture",
  inputs: [
    { id: "location", label: "Location", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "target", label: "Target", type: "any" },
    { id: "fov", label: "FOV", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 5),
    rotation: new THREE.Vector3(0, 0, 0),
    useTarget: false,
    target: new THREE.Vector3(0, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    fov: DEFAULT_FOV,
    resolutionPreset: "1:1 (512x512)",
    width: 512,
    height: 512,
    updateEvery: 1,
    cpuReadback: true,
  },
  dynamicParamFields: (instance) => {
    const isCustom = String(instance.params.resolutionPreset ?? "1:1 (512x512)") === "Custom";
    return [
      { id: "location", label: "Location", kind: "vector" },
      { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
      { id: "useTarget", label: "Use Target (Look At)", kind: "boolean" },
      { id: "target", label: "Target (fallback)", kind: "vector" },
      { id: "up", label: "Up", kind: "vector" },
      { id: "fov", label: "FOV (deg)", kind: "number" },
      { id: "resolutionPreset", label: "Resolution", kind: "select", options: Object.keys(RESOLUTION_PRESETS) },
      ...(isCustom
        ? [
            { id: "width", label: "Width (px)", kind: "number" as const, step: 1 },
            { id: "height", label: "Height (px)", kind: "number" as const, step: 1 },
          ]
        : []),
      {
        id: "updateEvery",
        label: "Update Every N Frames (screen-prop use only — leave at 1 if this texture IS the output)",
        kind: "number",
        step: 1,
      },
      {
        id: "cpuReadback",
        label: "CPU Readback (needed for Blur/Mix/Mask/etc downstream — off is faster if only feeding a material)",
        kind: "boolean",
      },
    ];
  },
  evaluate: (inputs, params, ctx) => {
    let state = textureCameraCache.get(ctx.nodeId);
    if (!state) {
      state = { tickCount: 0 };
      textureCameraCache.set(ctx.nodeId, state);
    }

    if (!ctx.connectedOutputs?.has("texture") || !ctx.renderer || !ctx.scene || typeof document === "undefined") {
      return { texture: null };
    }

    const preset = RESOLUTION_PRESETS[String(params.resolutionPreset ?? "1:1 (512x512)")];
    const [width, height] = preset ?? [
      Math.max(16, Math.round(Number(params.width) || 512)),
      Math.max(16, Math.round(Number(params.height) || 512)),
    ];
    const cpuReadback = toBoolean(params.cpuReadback ?? true);
    const updateEvery = Math.max(1, Math.round(Number(params.updateEvery) || 1));

    state.tickCount += 1;
    const dueForUpdate = (state.tickCount - 1) % updateEvery === 0;

    if (!dueForUpdate && (state.texture || state.target)) {
      return { texture: cpuReadback ? state.texture ?? null : state.target?.texture ?? null };
    }

    if (!state.target || state.width !== width || state.height !== height) {
      state.target?.dispose();
      state.target = new THREE.WebGLRenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace });
      state.width = width;
      state.height = height;
      // Force the canvas/texture pair below to rebuild at the new size too.
      state.buffer = undefined;
      state.canvas = undefined;
    }
    // Independent of the resolution check above — cpuReadback can be
    // toggled at runtime without a resolution change, and the canvas/
    // texture pair only needs to exist at all when it's on.
    if (cpuReadback && !state.canvas) {
      state.buffer = new Uint8Array(width * height * 4);
      state.canvas = document.createElement("canvas");
      state.canvas.width = width;
      state.canvas.height = height;
      state.texture = replaceCanvasTexture(state.texture, state.canvas, THREE.SRGBColorSpace);
    }
    if (!state.camera) {
      state.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, width / height, NEAR, FAR);
    }

    const pose = manualPose(inputs, params, ctx.connectedInputs);
    const camera = state.camera;
    camera.fov = pose.fov || DEFAULT_FOV;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    pose.matrix.decompose(position, quaternion, scale);
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    camera.updateMatrixWorld(true);

    const hiddenHelpers: THREE.Object3D[] = [];
    ctx.scene.traverse((obj) => {
      if (obj.userData?.isHelper && obj.visible) {
        hiddenHelpers.push(obj);
        obj.visible = false;
      }
    });

    const previousTarget = ctx.renderer.getRenderTarget();
    ctx.renderer.setRenderTarget(state.target);
    ctx.renderer.render(ctx.scene, camera);
    if (cpuReadback && state.buffer) {
      ctx.renderer.readRenderTargetPixels(state.target, 0, 0, width, height, state.buffer);
    }
    ctx.renderer.setRenderTarget(previousTarget);

    for (const obj of hiddenHelpers) obj.visible = true;

    if (!cpuReadback) {
      return { texture: state.target.texture };
    }

    // Same bottom-up-to-top-down row flip as Camera's own RTT readback —
    // required any time readRenderTargetPixels output lands in a canvas.
    const canvas = state.canvas!;
    const ctx2d = canvas.getContext("2d")!;
    const img = ctx2d.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const srcOffset = (height - 1 - y) * rowBytes;
      img.data.set(state.buffer!.subarray(srcOffset, srcOffset + rowBytes), y * rowBytes);
    }
    ctx2d.putImageData(img, 0, 0);
    state.texture!.needsUpdate = true;

    return { texture: state.texture };
  },
};
