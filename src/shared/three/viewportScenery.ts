import * as THREE from "three";
import { EnvironmentData } from "../graph/nodes/environment";
import { disposeObject3D } from "../graph/nodeCaches";

/**
 * The viewport's own furniture — the ground grid, the origin axes, the
 * background gradient, the corner orientation gizmo, and the palette they
 * share. All of it is built once from nothing and never reads graph state,
 * which is exactly why it doesn't belong in the render loop's closure: it
 * was the largest block of Viewport.tsx that had no reason to be there.
 */
/** Create text canvas sprite for corner 3D axes labels ("X", "Y", "Z") */
function createTextSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(32, 32, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 26px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 32);
  }

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.scale.set(0.32, 0.32, 1);
  return sprite;
}

/** Build 3D Axes Triad Gizmo for Corner HUD */
export function createGizmoScene(): { gizmoScene: THREE.Scene; gizmoCamera: THREE.PerspectiveCamera } {
  const gizmoScene = new THREE.Scene();
  const gizmoCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  gizmoCamera.position.set(0, 0, 3);
  gizmoCamera.lookAt(0, 0, 0);

  const axisLength = 1.0;
  const axes = [
    { dir: new THREE.Vector3(1, 0, 0), color: 0xf43f5e, hexColor: "#f43f5e", label: "X" },
    { dir: new THREE.Vector3(0, 1, 0), color: 0x22c55e, hexColor: "#22c55e", label: "Y" },
    { dir: new THREE.Vector3(0, 0, 1), color: 0x38bdf8, hexColor: "#38bdf8", label: "Z" },
  ];

  axes.forEach(({ dir, color, hexColor, label }) => {
    // Axis line
    const points = [new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(axisLength)];
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color, linewidth: 3 });
    gizmoScene.add(new THREE.Line(geom, mat));

    // Label Sprite
    const sprite = createTextSprite(label, hexColor);
    sprite.position.copy(dir.clone().multiplyScalar(axisLength + 0.2));
    gizmoScene.add(sprite);
  });

  // Center origin dot
  const dotGeom = new THREE.SphereGeometry(0.08, 16, 16);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
  gizmoScene.add(new THREE.Mesh(dotGeom, dotMat));

  return { gizmoScene, gizmoCamera };
}

/**
 * Viewport palette, modelled on Blender's own 3D view rather than the near
 * black the rest of the app started from: a soft blue-grey gradient reads as
 * *space* around the scene, and it gives dark geometry something to sit
 * against instead of vanishing into the background.
 */
const VIEWPORT_BG_TOP = "#39424f";
const VIEWPORT_BG_BOTTOM = "#59636f";
const GRID_LINE = 0x6a7482;
const GRID_LINE_MAJOR = 0x7c8794;
/** Muted enough to read as reference lines, not as scene content — same reason Blender desaturates its own. */
const AXIS_X_COLOR = 0xa8555f;
const AXIS_Z_COLOR = 0x4d7fa6;

/**
 * TransformControls' own gizmo defaults to pure #f00/#0f0/#00f — harsh
 * against everything else in this file already being softened toward
 * Blender's own muted palette. Same treatment, same reasoning as the axis
 * lines above, via TransformControls.setColors() (its own public API for
 * this — no need to reach into gizmo internals).
 */
export const GIZMO_X_COLOR = 0xe0757f;
export const GIZMO_Y_COLOR = 0x8fcf8a;
export const GIZMO_Z_COLOR = 0x6fa8dc;
/** The axis actively being dragged, or hovered. */
export const GIZMO_ACTIVE_COLOR = 0xf0c674;

/**
 * Blender's vertical viewport gradient, as a 2px-wide canvas texture. Assigned
 * to `scene.background`, three.js stretches it flat across the frame (the
 * equirect wrapping only applies to textures explicitly mapped that way).
 */
export function createViewportBackground(top?: string, bottom?: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, top ?? VIEWPORT_BG_TOP);
  gradient.addColorStop(1, bottom ?? VIEWPORT_BG_BOTTOM);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Live-updates the gradient texture used for the viewport background.
 */
export function updateViewportBackground(texture: THREE.Texture, top: string, bottom: string): void {
  const canvasTexture = texture as THREE.CanvasTexture;
  const canvas = canvasTexture.image as HTMLCanvasElement | undefined;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  canvasTexture.needsUpdate = true;
}

/**
 * Releases the GPU resources a viewport's corner gizmo allocated (axis lines,
 * label sprites, origin dot). Called when the viewport unmounts — these are
 * per-viewport objects, not shared caches, so they are safe to dispose here.
 */
export function disposeGizmoScene(gizmo: { gizmoScene: THREE.Scene }): void {
  disposeObject3D(gizmo.gizmoScene);
}

/** Releases the grid, axis lines and up-arrow geometry/materials of the editor scaffold. */
export function disposeMainSceneGridAndAxes(group: THREE.Group): void {
  disposeObject3D(group);
}

/** Build main 3D Scene Grid & Origin Axes Helper */
export function buildMainSceneGridAndAxes(gridColor?: string | number, gridMajorColor?: string | number): THREE.Group {
  const group = new THREE.Group();

  // Ground Grid (XZ Plane)
  const major = new THREE.Color(gridMajorColor ?? GRID_LINE_MAJOR);
  const minor = new THREE.Color(gridColor ?? GRID_LINE);
  const gridHelper = new THREE.GridHelper(20, 20, major, minor);
  gridHelper.position.y = -0.001; // Avoid z-fighting with objects at y=0
  gridHelper.userData.isSceneryGridHelper = true;
  group.add(gridHelper);

  // The two in-plane axes drawn the length of the grid, Blender-style: a
  // coloured line running the whole floor tells you which way X and Z go far
  // more legibly than a short arrow at the origin does, and it stays readable
  // when the camera is right down on the ground plane.
  const half = 10;
  for (const [axis, color] of [
    [new THREE.Vector3(1, 0, 0), AXIS_X_COLOR],
    [new THREE.Vector3(0, 0, 1), AXIS_Z_COLOR],
  ] as const) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        axis.clone().multiplyScalar(-half),
        axis.clone().multiplyScalar(half),
      ]),
      new THREE.LineBasicMaterial({ color }),
    );
    line.position.y = 0.001;
    group.add(line);
  }

  // Only "up" gets an arrow now. X and Z are the two floor lines above, and
  // stacking a second, brighter set of markers on the same axes at the origin
  // just cluttered it — the corner orientation gizmo already names all three.
  const upArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 0),
    1.2,
    0x6f9e57,
    0.24,
    0.1,
  );
  group.add(upArrow);

  return group;
}

/**
 * Live-updates the grid helper colors inside the grid & axes group.
 */
export function updateGridColor(group: THREE.Group, gridColor: string | number, gridMajorColor?: string | number): void {
  const oldHelper = group.children.find((child) => child.userData?.isSceneryGridHelper);
  if (oldHelper) {
    group.remove(oldHelper);
    disposeObject3D(oldHelper);
  }
  const major = new THREE.Color(gridMajorColor ?? GRID_LINE_MAJOR);
  const minor = new THREE.Color(gridColor ?? GRID_LINE);
  const newGridHelper = new THREE.GridHelper(20, 20, major, minor);
  newGridHelper.position.y = -0.001;
  newGridHelper.userData.isSceneryGridHelper = true;
  group.add(newGridHelper);
}

/**
 * Fits `texture` (a flat background image) into a `viewportW`×`viewportH`
 * canvas per `fit`, then applies the user's extra scale/offset/rotation on
 * top — same "texture.offset/repeat/rotation drive the sample" mechanism
 * texture.ts already uses for uvScale/uvOffset, just computed here because
 * only Viewport.tsx knows the actual canvas size (environment.ts's evaluate
 * has no canvas to measure against).
 *
 * "contain" has no true letterbox (a flat background texture always fills
 * the screen quad) — the padding reads as stretched edge pixels via
 * ClampToEdgeWrapping instead of a solid color bar. Acceptable trade for a
 * VJ tool; a real letterbox would need a dedicated background shader pass.
 */
export function applyBackgroundImageTransform(texture: THREE.Texture, env: EnvironmentData, viewportW: number, viewportH: number): void {
  const img = texture.image as { width?: number; height?: number } | undefined;
  let repeatX = 1;
  let repeatY = 1;

  if (img?.width && img?.height && viewportW > 0 && viewportH > 0) {
    const canvasAspect = viewportW / viewportH;
    const imageAspect = img.width / img.height;
    if (env.backgroundFit === "cover") {
      if (canvasAspect > imageAspect) repeatY = imageAspect / canvasAspect;
      else repeatX = canvasAspect / imageAspect;
    } else if (env.backgroundFit === "contain") {
      if (canvasAspect > imageAspect) repeatX = canvasAspect / imageAspect;
      else repeatY = imageAspect / canvasAspect;
    }
    // "stretch": repeatX/repeatY stay 1 — the image fills the quad as-is, distortion and all.
  }

  const scale = env.backgroundScale;
  repeatX *= scale.x || 1;
  repeatY *= scale.y || 1;

  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.center.set(0.5, 0.5);
  texture.rotation = env.backgroundRotation;
  texture.repeat.set(repeatX, repeatY);
  texture.offset.set((1 - repeatX) / 2 + env.backgroundOffset.x, (1 - repeatY) / 2 + env.backgroundOffset.y);
  texture.needsUpdate = true;
}
