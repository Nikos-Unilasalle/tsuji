import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { manualPose } from "./camera";
import { markGpuTextureRendered, registerGpuTexture } from "../gpuTexture";

const NEAR = 0.05;
const FAR = 500;
const DEFAULT_FOV = 50;

/** Teal, matching the Textures category color — distinct from the 3D Camera node's blue, the point being to tell the two apart at a glance in the viewport. */
const HELPER_COLOR = 0x2dd4bf;

const groupCache = createNodeCache<THREE.Group>(disposeObject3D);
function getGroup(nodeId: string): THREE.Group {
  let group = groupCache.get(nodeId);
  if (!group) {
    group = new THREE.Group();
    groupCache.set(nodeId, group);
  }
  return group;
}

/**
 * A flat wedge body (not a box) plus a frustum ending in an outlined
 * rectangle — the rectangle is the part `calibration/camera`'s helper
 * doesn't have, standing in for "this one captures a flat frame, not a 3D
 * view." Built at the texture's own aspect ratio rather than a fixed 16:9,
 * so the frustum's proportions already hint at the output shape.
 */
function buildTextureCameraHelperGeometry(fov: number, aspect: number): THREE.Group {
  const group = new THREE.Group();
  const color = HELPER_COLOR;

  const bodyGeo = new THREE.ConeGeometry(0.14, 0.3, 4);
  const bodyMat = new THREE.MeshBasicMaterial({ color, wireframe: true });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.rotation.x = -Math.PI / 2;
  body.rotation.y = Math.PI / 4;
  body.position.set(0, 0, 0.1);
  group.add(body);

  const radFov = THREE.MathUtils.degToRad(fov || DEFAULT_FOV);
  const dist = 1.2;
  const h = Math.tan(radFov / 2) * dist;
  const w = h * (aspect || 1);

  const points = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(-w, h, -dist),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(w, h, -dist),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(w, -h, -dist),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(-w, -h, -dist),
  ];
  const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
  const lineMat = new THREE.LineBasicMaterial({ color });
  group.add(new THREE.LineSegments(lineGeo, lineMat));

  // The captured-frame rectangle, thicker than the frustum lines so it
  // reads as "the frame" rather than another frustum edge.
  const framePoints = [
    new THREE.Vector3(-w, h, -dist), new THREE.Vector3(w, h, -dist),
    new THREE.Vector3(w, h, -dist), new THREE.Vector3(w, -h, -dist),
    new THREE.Vector3(w, -h, -dist), new THREE.Vector3(-w, -h, -dist),
    new THREE.Vector3(-w, -h, -dist), new THREE.Vector3(-w, h, -dist),
  ];
  const frameGeo = new THREE.BufferGeometry().setFromPoints(framePoints);
  const frameMat = new THREE.LineBasicMaterial({ color, linewidth: 2 });
  group.add(new THREE.LineSegments(frameGeo, frameMat));

  group.traverse((child) => {
    child.userData.isHelper = true;
  });

  return group;
}

interface TextureCameraState {
  target?: THREE.WebGLRenderTarget;
  camera?: THREE.PerspectiveCamera;
  width?: number;
  height?: number;
  /**
   * Ticks up once per evaluate() call, per renderer — throttle skips the
   * render unless this hits `updateEvery`. Keyed by renderer, not a single
   * shared counter: `state.target` is one WebGLRenderTarget *object*, but
   * each THREE.WebGLRenderer that touches it keeps its own separate GPU-side
   * backing for it (three.js allows several renderers to share render
   * targets/textures this way). A single shared tick count meant only
   * whichever renderer happened to land on the qualifying tick actually
   * called `renderer.render()` — e.g. with both the 3D viewport and a 2D
   * View pane evaluating the same graph, the tick landed on one renderer's
   * call roughly half the time, and the OTHER renderer's copy of this
   * target was never once written to. Every downstream texture/* node
   * sampling `cam2d`'s texture through that renderer then read whatever
   * uninitialized/garbage data sat in its own never-rendered backing store
   * — the "2D Render pane is black or full of static" bug this fixes.
   */
  tickCounts: Map<THREE.WebGLRenderer, number>;
}

const textureCameraCache = createNodeCache<TextureCameraState>((s) => {
  s.target?.dispose();
});

const RESOLUTION_PRESETS: Record<string, [number, number] | null> = {
  "1920 × 1080 (Full HD)": [1920, 1080],
  "1280 × 720 (HD)": [1280, 720],
  "3840 × 2160 (4K UHD)": [3840, 2160],
  "1080 × 1920 (Vertical)": [1080, 1920],
  "1080 × 1080 (Square)": [1080, 1080],
  "1024 × 1024": [1024, 1024],
  "512 × 512": [512, 512],
  "256 × 256": [256, 256],
  Custom: null,
};

/** Preset names used before the "W × H" labels, so saved graphs keep their size. */
const LEGACY_RESOLUTION_PRESETS: Record<string, [number, number]> = {
  "1:1 (256x256)": [256, 256],
  "1:1 (512x512)": [512, 512],
  "1:1 (1024x1024)": [1024, 1024],
  "16:9 (1280x720)": [1280, 720],
  "16:9 (1920x1080)": [1920, 1080],
  "9:16 (720x1280)": [720, 1280],
};

const DEFAULT_PRESET = "1920 × 1080 (Full HD)";

/**
 * A camera dedicated to feeding a texture, separate from `calibration/camera`
 * (which drives the main 3D view) for two reasons: it never costs anything
 * unless actually wired up, and it carries its own resolution and throttle
 * controls tuned for that one job instead of inheriting the main
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
  label: "2D Camera",
  category: "texture",
  inputs: [
    { id: "location", label: "Location", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "target", label: "Target", type: "any" },
    { id: "fov", label: "FOV", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "texture", label: "Texture", type: "texture" },
  ],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 5),
    rotation: new THREE.Vector3(0, 0, 0),
    useTarget: false,
    target: new THREE.Vector3(0, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    fov: DEFAULT_FOV,
    resolutionPreset: DEFAULT_PRESET,
    width: 1920,
    height: 1080,
    updateEvery: 1,
  },
  dynamicParamFields: (instance) => {
    const isCustom = String(instance.params.resolutionPreset ?? DEFAULT_PRESET) === "Custom";
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
    ];
  },
  evaluate: (inputs, params, ctx) => {
    let state = textureCameraCache.get(ctx.nodeId);
    if (!state) {
      state = { tickCounts: new Map() };
      textureCameraCache.set(ctx.nodeId, state);
    }

    const pose = manualPose(inputs, params, ctx.connectedInputs);

    const presetKey = String(params.resolutionPreset ?? DEFAULT_PRESET);
    const preset = RESOLUTION_PRESETS[presetKey] ?? LEGACY_RESOLUTION_PRESETS[presetKey];
    const [width, height] = preset ?? [
      Math.max(16, Math.round(Number(params.width) || 512)),
      Math.max(16, Math.round(Number(params.height) || 512)),
    ];

    // Helper geometry is always built — a texture camera has to be visible
    // and gizmo-positionable in the 3D view whether or not anything is
    // wired to its `texture` output yet. Only the actual scene render
    // (below) is gated on that wiring.
    const group = getGroup(ctx.nodeId);
    group.clear();
    group.matrixAutoUpdate = false;
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrix.copy(pose.matrix);
    }
    group.userData.nodeId = ctx.nodeId;
    const helperContent = buildTextureCameraHelperGeometry(pose.fov, width / height);
    helperContent.traverse((child) => {
      child.userData.nodeId = ctx.nodeId;
    });
    group.add(helperContent);

    if (!ctx.connectedOutputs?.has("texture") || !ctx.renderer || !ctx.scene || typeof document === "undefined") {
      return { geometry: group, texture: null };
    }

    const updateEvery = Math.max(1, Math.round(Number(params.updateEvery) || 1));

    // Per-renderer: a renderer this node has never rendered for yet has no
    // GPU-side backing for `state.target` at all (see the interface's own
    // doc comment) and must render regardless of where the shared throttle
    // cycle happens to be, or its very first read would come back
    // uninitialized.
    const tick = (state.tickCounts.get(ctx.renderer) ?? 0) + 1;
    state.tickCounts.set(ctx.renderer, tick);
    const dueForUpdate = (tick - 1) % updateEvery === 0;

    if (!dueForUpdate && state.target) {
      return { geometry: group, texture: state.target.texture };
    }

    if (!state.target || state.width !== width || state.height !== height) {
      state.target?.dispose();
      state.target = new THREE.WebGLRenderTarget(width, height, {
        colorSpace: THREE.SRGBColorSpace,
        // Every downstream texture/* pass samples this 1:1 (a fullscreen
        // quad, no minification) — mipmaps would only cost a GPU-side
        // regeneration on every live frame for nothing ever reading them.
        // `samples` (MSAA) stays: unlike mipmaps, it's a real antialiasing
        // win for the 3D scene this actually captures.
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        samples: 4,
      });
      state.target.texture.wrapS = THREE.RepeatWrapping;
      state.target.texture.wrapT = THREE.RepeatWrapping;
      registerGpuTexture(state.target);
      state.width = width;
      state.height = height;
    }
    if (!state.camera) {
      state.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, width / height, NEAR, FAR);
    }

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
    const previousClearColor = ctx.renderer.getClearColor(new THREE.Color());
    const previousClearAlpha = ctx.renderer.getClearAlpha();
    ctx.renderer.setRenderTarget(state.target);
    // Viewports run with autoClear off, so without this every frame draws over the last one.
    ctx.renderer.setClearColor(0x000000, 0);
    ctx.renderer.clear(true, true, true);
    ctx.renderer.render(ctx.scene, camera);
    ctx.renderer.setRenderTarget(previousTarget);
    ctx.renderer.setClearColor(previousClearColor, previousClearAlpha);
    markGpuTextureRendered(state.target, ctx.renderer);

    for (const obj of hiddenHelpers) obj.visible = true;

    // Stays on the GPU: texture tools downstream are shader passes, and the
    // few CPU consumers (Pixel Spawner, Sample Texture) read it back lazily.
    return { geometry: group, texture: state.target.texture };
  },
};
