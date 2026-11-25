import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { asColor } from "./object";

/** A ready-to-render 2D HUD element, consumed by the viewport's CSS overlay. */
export interface HubElement {
  id: string;
  /** Plain text content (ignored when `imageUrl` is set). */
  text: string;
  /** Object URL of an image to render instead of text (hub/image node). */
  imageUrl?: string;
  /** Base image width in px (hub/image) — scale multiplies it. */
  imageWidth?: number;
  /** 0..1 fraction of the view width (left). */
  x: number;
  /** 0..1 fraction of the view height (top). */
  y: number;
  /** Rotation in degrees, applied around the element's center. */
  rotation: number;
  fontFamily: string;
  fontSize: number;
  /** Uniform scale applied on top of fontSize/image width — driven by the gizmo's size handle. */
  scale: number;
  color: string;
  textShadow: string | null;
  backgroundColor: string | null;
  borderColor: string | null;
  borderWidth: number;
  borderRadius: number;
  shadow: string | null;
  /** Final CSS opacity (base opacity × animation opacity). */
  cssOpacity: number;
  /** Full CSS transform, including centering on (x, y), rotation and animation. */
  transform: string;
  filter: string;
  visible: boolean;
}

export const HUB_ANIMATIONS = [
  "none",
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "zoom",
  "blur",
] as const;

export type HubAnimation = (typeof HUB_ANIMATIONS)[number];

export const HUB_EASINGS = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "cubic-in",
  "cubic-out",
  "cubic-in-out",
] as const;

export type HubEasing = (typeof HUB_EASINGS)[number];

function easeCurve(name: HubEasing, t: number): number {
  switch (name) {
    case "linear":
      return t;
    case "ease-in":
      return t * t;
    case "ease-out":
      return 1 - Math.pow(1 - t, 2);
    case "ease-in-out":
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case "cubic-in":
      return t * t * t;
    case "cubic-out":
      return 1 - Math.pow(1 - t, 3);
    case "cubic-in-out":
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    default:
      return t;
  }
}

const FONT_FAMILIES = [
  "sans-serif",
  "serif",
  "monospace",
  "Arial",
  "Helvetica",
  "Verdana",
  "Trebuchet MS",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "Impact",
  "Comic Sans MS",
];

const HUB_STATE_CACHE = createNodeCache<HubState>();

interface HubState {
  entered: boolean;
  lastTrigger: boolean;
  animDir: "enter" | "exit" | "none";
  animStart?: number;
  /** Which clock `animStart` was stamped from — see hubClock(). */
  animClock?: HubClockDomain;
}

type HubClockDomain = "wall" | "graph";

/**
 * Which clock a hub animation runs on.
 *
 * Live preview uses wall-clock time so an enter/exit still plays out while the
 * timeline is paused — a HUD triggered from a keyboard node has to animate
 * whether or not the playhead is moving.
 *
 * A captured export frame uses the graph's deterministic `time` instead. The
 * export loop paces itself on real time and slows down whenever a frame takes
 * longer than its budget, so a wall-clock animation drifted away from the
 * frames it was supposed to be drawn on — the encoded video showed the HUD
 * ahead of (or behind) everything else in the scene.
 */
function hubClock(ctx: { time: number; capturing?: boolean }): { nowSec: number; domain: HubClockDomain } {
  if (ctx.capturing) return { nowSec: ctx.time, domain: "graph" };
  const wall = typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
  return { nowSec: wall, domain: "wall" };
}

function getHubState(nodeId: string): HubState {
  let state = HUB_STATE_CACHE.get(nodeId);
  if (!state) {
    // Default trigger is 1: hub elements start *shown* (entered), and each
    // rising edge toggles them out/in. lastTrigger starts true so the very
    // first evaluation (with the default trigger) doesn't immediately toggle.
    state = { entered: true, lastTrigger: true, animDir: "none" };
    HUB_STATE_CACHE.set(nodeId, state);
  }
  return state;
}

function num(v: unknown, fallback: unknown): number {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const f = Number(fallback);
  return Number.isFinite(f) ? f : 0;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The per-frame appearance of an animation given a visibility factor `p`
 * (0 = fully hidden, 1 = fully shown). For an entrance animation `p` climbs
 * 0→1; for an exit it falls 1→0, so the same shapes describe both directions.
 */
function hubAnimationStyle(anim: HubAnimation, p: number): { transform: string; filter: string; opacity: number } {
  const inv = 1 - p;
  switch (anim) {
    case "fade":
      return { transform: "", filter: "", opacity: p };
    case "slide-left":
      return { transform: `translateX(${inv * -100}vw)`, filter: "", opacity: p };
    case "slide-right":
      return { transform: `translateX(${inv * 100}vw)`, filter: "", opacity: p };
    case "slide-up":
      return { transform: `translateY(${inv * -100}vh)`, filter: "", opacity: p };
    case "slide-down":
      return { transform: `translateY(${inv * 100}vh)`, filter: "", opacity: p };
    case "zoom":
      return { transform: `scale(${Math.max(0.001, p)})`, filter: "", opacity: p };
    case "blur":
      return { transform: "", filter: `blur(${inv * 16}px)`, opacity: p };
    case "none":
    default:
      return { transform: "", filter: "", opacity: 1 };
  }
}

/**
 * Shared trigger + animation state machine for hub/* nodes. A single trigger
 * toggles enter/exit on each rising edge; `nowSec`/`domain` come from
 * hubClock(), which picks the wall clock live and the graph clock on export.
 */
function resolveHubAnimation(
  state: HubState,
  inputs: Record<string, unknown>,
  nowSec: number,
  domain: HubClockDomain,
  durationIn: number,
  durationOut: number,
  enterEase: HubEasing,
  exitEase: HubEasing,
  enterAnimation: HubAnimation,
  exitAnimation: HubAnimation,
): { p: number; anim: HubAnimation; isShown: boolean } {
  // The two clocks share no origin, so an animation stamped on one can't be
  // measured against the other — settle it and let the next trigger replay it
  // cleanly in the new domain.
  if (state.animClock !== domain) {
    state.animClock = domain;
    state.animDir = "none";
    state.animStart = undefined;
  }

  // Default trigger is 1 (shown); wiring the socket overrides that.
  const trigger = inputs.trigger !== undefined ? Number(inputs.trigger) > 0 : true;
  const risingTrigger = trigger && !state.lastTrigger;
  state.lastTrigger = trigger;

  if (risingTrigger) {
    if (state.entered) {
      state.entered = false;
      state.animDir = "exit";
      state.animStart = nowSec;
    } else {
      state.entered = true;
      state.animDir = "enter";
      state.animStart = nowSec;
    }
  }

  let p = 1;
  let anim: HubAnimation = "none";
  if (state.animDir === "enter") {
    const prog = clamp01(state.animStart !== undefined ? (nowSec - state.animStart) / durationIn : 1);
    anim = enterAnimation;
    p = easeCurve(enterEase, prog);
    if (prog >= 1) {
      state.animDir = "none";
      state.entered = true;
    }
  } else if (state.animDir === "exit") {
    const prog = clamp01(state.animStart !== undefined ? (nowSec - state.animStart) / durationOut : 1);
    anim = exitAnimation;
    p = 1 - easeCurve(exitEase, prog);
    if (prog >= 1) {
      state.animDir = "none";
      state.entered = false;
    }
  }

  const isShown = state.entered || state.animDir === "enter" || state.animDir === "exit";
  return { p, anim, isShown };
}

/**
 * HUD Text node — a screen-space 2D text element rendered over the camera
 * view, styled like CSS. Driven by two triggers: `enter` fades/slides it in,
 * `exit` animates it out. Only shown while a camera view is active.
 */
export const HUB_TEXT_NODE: NodeDefinition = {
  type: "hub/text",
  label: "HUD Text",
  category: "io",
  inputs: [
    { id: "trigger", label: "Trigger", type: "value" },
    { id: "text", label: "Text", type: "text" },
    { id: "x", label: "Position X", type: "value" },
    { id: "y", label: "Position Y", type: "value" },
    { id: "rotation", label: "Rotation", type: "value" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [{ id: "hud", label: "HUD Element", type: "any" }],
  defaultParams: {
    text: "tsuji",
    trigger: 1,
    x: undefined,
    y: undefined,
    rotation: 0,
    scale: 1,
    visible: 1,
    fontFamily: "sans-serif",
    fontSize: 48,
    color: new THREE.Color(0xffffff),
    useTextShadow: false,
    textShadowColor: new THREE.Color(0x000000),
    textShadowBlur: 2,
    textShadowOffsetX: 1,
    textShadowOffsetY: 1,
    useBackground: false,
    backgroundColor: new THREE.Color(0x000000),
    useBorder: false,
    borderColor: new THREE.Color(0xffffff),
    borderWidth: 2,
    borderRadius: 8,
    useShadow: false,
    shadowColor: new THREE.Color(0x000000),
    shadowBlur: 10,
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    opacity: 1,
    enterAnimation: "fade",
    exitAnimation: "fade",
    enterEase: "cubic-out",
    exitEase: "cubic-in",
    durationIn: 0.5,
    durationOut: 0.5,
  },
  dynamicParamFields: () => [
    { id: "text", label: "Text", kind: "text" },
    { id: "x", label: "Position X (px)", kind: "number", step: 0.01 },
    { id: "y", label: "Position Y (px)", kind: "number", step: 0.01 },
    // Stored in degrees, NOT radians, so no `degrees: true` here. This one
    // has three writers that must agree — the panel, the viewport's rotate
    // handle (Viewport.tsx's onHubChange, which writes degrees straight from
    // atan2) and a wire — and one reader, the CSS `rotate(Xdeg)` below. All
    // four already spoke degrees except the panel, which converted on the way
    // in: typing 90 stored 1.5708 and rendered a 1.5° tilt.
    { id: "rotation", label: "Rotation (°)", kind: "number", step: 1 },
    { id: "scale", label: "Scale", kind: "number", step: 0.05 },
    { id: "visible", label: "Visible", kind: "boolean" },
    { id: "fontFamily", label: "Font", kind: "select", options: FONT_FAMILIES },
    { id: "fontSize", label: "Font Size", kind: "number", step: 1 },
    { id: "color", label: "Text Color", kind: "color" },
    { id: "useTextShadow", label: "Text Shadow", kind: "boolean" },
    { id: "textShadowColor", label: "Text Shadow Color", kind: "color" },
    { id: "textShadowBlur", label: "Text Shadow Blur", kind: "number", step: 1 },
    { id: "textShadowOffsetX", label: "Text Shadow Offset X", kind: "number", step: 1 },
    { id: "textShadowOffsetY", label: "Text Shadow Offset Y", kind: "number", step: 1 },
    { id: "useBackground", label: "Background", kind: "boolean" },
    { id: "backgroundColor", label: "Background Color", kind: "color" },
    { id: "useBorder", label: "Border", kind: "boolean" },
    { id: "borderColor", label: "Border Color", kind: "color" },
    { id: "borderWidth", label: "Border Width", kind: "number", step: 1 },
    { id: "borderRadius", label: "Corner Radius", kind: "number", step: 1 },
    { id: "useShadow", label: "Shadow", kind: "boolean" },
    { id: "shadowColor", label: "Shadow Color", kind: "color" },
    { id: "shadowBlur", label: "Shadow Blur", kind: "number", step: 1 },
    { id: "shadowOffsetX", label: "Shadow Offset X", kind: "number", step: 1 },
    { id: "shadowOffsetY", label: "Shadow Offset Y", kind: "number", step: 1 },
    { id: "opacity", label: "Opacity", kind: "number", step: 0.05 },
    { id: "enterAnimation", label: "Enter Animation", kind: "select", options: [...HUB_ANIMATIONS] },
    { id: "exitAnimation", label: "Exit Animation", kind: "select", options: [...HUB_ANIMATIONS] },
    { id: "enterEase", label: "Enter Easing", kind: "select", options: [...HUB_EASINGS] },
    { id: "exitEase", label: "Exit Easing", kind: "select", options: [...HUB_EASINGS] },
    { id: "durationIn", label: "Animation Duration In (s)", kind: "number", step: 0.05 },
    { id: "durationOut", label: "Animation Duration Out (s)", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getHubState(ctx.nodeId);

    const text = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "");
    // Position is in render-node pixels; default (unset) is the render centre.
    const cx = ctx.renderSize ? ctx.renderSize.width / 2 : 0;
    const cy = ctx.renderSize ? ctx.renderSize.height / 2 : 0;
    const x = num(inputs.x, cx);
    const y = num(inputs.y, cy);
    const rotation = num(inputs.rotation, params.rotation);
    const scale = Math.max(0.05, Math.min(4, num(inputs.scale, params.scale)));
    const baseVisible = inputs.visible !== undefined ? Number(inputs.visible) > 0 : Boolean(params.visible ?? true);
    const opacity = clamp01(num(inputs.opacity, params.opacity));
    const fontSize = Math.max(4, num(inputs.fontSize, params.fontSize));
    const fontFamily = String(params.fontFamily ?? "sans-serif");
    const color = asColor(params.color, new THREE.Color(0xffffff)).getStyle();
    const textShadow = Boolean(params.useTextShadow)
      ? `${num(params.textShadowOffsetX, 1)}px ${num(params.textShadowOffsetY, 1)}px ${Math.max(0, num(params.textShadowBlur, 2))}px ${asColor(params.textShadowColor, new THREE.Color(0x000000)).getStyle()}`
      : null;
    const backgroundColor = Boolean(params.useBackground) ? asColor(params.backgroundColor, new THREE.Color(0x000000)).getStyle() : null;
    const borderColor = Boolean(params.useBorder) ? asColor(params.borderColor, new THREE.Color(0xffffff)).getStyle() : null;
    const borderWidth = Math.max(0, num(params.borderWidth, 0));
    const borderRadius = Math.max(0, num(params.borderRadius, 8));
    const shadow = Boolean(params.useShadow)
      ? `${num(params.shadowOffsetX, 2)}px ${num(params.shadowOffsetY, 2)}px ${Math.max(0, num(params.shadowBlur, 10))}px ${asColor(params.shadowColor, new THREE.Color(0x000000)).getStyle()}`
      : null;
    const enterAnimation = (String(params.enterAnimation ?? "fade") as HubAnimation);
    const exitAnimation = (String(params.exitAnimation ?? "fade") as HubAnimation);
    const enterEase = (String(params.enterEase ?? "cubic-out") as HubEasing);
    const exitEase = (String(params.exitEase ?? "cubic-in") as HubEasing);
    const durationIn = Math.max(0.05, num(params.durationIn, 0.5));
    const durationOut = Math.max(0.05, num(params.durationOut, 0.5));

    const { nowSec, domain } = hubClock(ctx);

    const { p, anim, isShown } = resolveHubAnimation(
      state, inputs, nowSec, domain, durationIn, durationOut, enterEase, exitEase, enterAnimation, exitAnimation,
    );

    const style = hubAnimationStyle(anim, p);

    const hud: HubElement = {
      id: ctx.nodeId,
      text,
      x,
      y,
      rotation,
      fontFamily,
      fontSize,
      scale,
      color,
      textShadow,
      backgroundColor,
      borderColor,
      borderWidth,
      borderRadius,
      shadow,
      cssOpacity: isShown ? opacity * style.opacity : 0,
      transform: `${style.transform} translate(-50%, -50%) rotate(${rotation}deg)`.trim(),
      filter: style.filter,
      visible: baseVisible && isShown,
    };

    return { hud };
  },
};

const hubImageCache = createNodeCache<{ url?: string; width?: number; lastPath?: string }>((s) => {
  if (s.url) {
    try {
      URL.revokeObjectURL(s.url);
    } catch {}
  }
});

function getImageState(nodeId: string): { url?: string; width?: number; lastPath?: string } {
  let s = hubImageCache.get(nodeId);
  if (!s) {
    s = {};
    hubImageCache.set(nodeId, s);
  }
  return s;
}

const HUB_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Fire onLoaded-style image decode from raw bytes — shared by the file picker and disk reloads. */
function loadImageBytes(nodeId: string, path: string, content: Uint8Array | string): void {
  const state = getImageState(nodeId);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const blob = new Blob([content], { type: HUB_IMAGE_MIME[ext] || "image/png" });
  const url = URL.createObjectURL(blob);
  const revoke = (target: string | undefined) => {
    if (!target) return;
    try {
      URL.revokeObjectURL(target);
    } catch {}
  };
  const img = new Image();
  img.onload = () => {
    // The object URL the element was showing until now is dead the moment this
    // one replaces it — only the *last* one ever reached the cache disposer, so
    // every re-pick and every disk reload leaked one blob for the session.
    revoke(state.url);
    state.url = url;
    state.width = img.naturalWidth || undefined;
  };
  img.onerror = () => {
    // A URL nothing will ever draw from — release it rather than holding the
    // decoded blob alive until the tab closes.
    revoke(url);
  };
  img.src = url;
}

/** Re-read a hub image from disk when its filePath param changed (duplicated nodes, reopened projects). */
function reloadImageFromDisk(nodeId: string, path: string): void {
  if (typeof path !== "string" || !path) return;
  const state = getImageState(nodeId);
  if (state.lastPath === path && state.url) return;
  state.lastPath = path;
  // @tauri-apps/plugin-fs is only available inside the desktop app; the browser
  // build resolves it at runtime, guarded by isTauri() exactly like rehydrateFiles.
  import("@tauri-apps/plugin-fs")
    .then(async ({ readFile }) => {
      const content = await readFile(path);
      loadImageBytes(nodeId, path, content);
    })
    .catch(() => {
      // Not Tauri / file unavailable — the user must re-pick in the browser.
    });
}

/**
 * HUD Image node — a screen-space 2D image (JPG/PNG with alpha) rendered over
 * the camera view, with rounded corners, size, position, rotation and the same
 * enter/exit trigger animations as HUD Text.
 */
export const HUB_IMAGE_NODE: NodeDefinition = {
  type: "hub/image",
  label: "HUD Image",
  category: "io",
  inputs: [
    { id: "trigger", label: "Trigger", type: "value" },
    { id: "x", label: "Position X", type: "value" },
    { id: "y", label: "Position Y", type: "value" },
    { id: "rotation", label: "Rotation", type: "value" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [{ id: "hud", label: "HUD Element", type: "any" }],
  defaultParams: {
    filePath: "",
    trigger: 1,
    x: undefined,
    y: undefined,
    rotation: 0,
    scale: 1,
    visible: 1,
    imageWidth: 200,
    borderRadius: 0,
    useBorder: false,
    borderColor: new THREE.Color(0xffffff),
    borderWidth: 2,
    useShadow: false,
    shadowColor: new THREE.Color(0x000000),
    shadowBlur: 10,
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    opacity: 1,
    enterAnimation: "fade",
    exitAnimation: "fade",
    enterEase: "cubic-out",
    exitEase: "cubic-in",
    durationIn: 0.5,
    durationOut: 0.5,
  },
  dynamicParamFields: () => [
    {
      id: "filePath",
      label: "Image File",
      kind: "file",
      accept: [".png", ".jpg", ".jpeg", ".webp"],
      onLoaded: (nodeId, path, content) => {
        if (!path) {
          const state = getImageState(nodeId);
          state.url = undefined;
          state.width = undefined;
          return;
        }
        getImageState(nodeId).lastPath = path;
        loadImageBytes(nodeId, path, content);
      },
    },
    { id: "x", label: "Position X (px)", kind: "number", step: 0.01 },
    { id: "y", label: "Position Y (px)", kind: "number", step: 0.01 },
    { id: "rotation", label: "Rotation (°)", kind: "number", step: 1 },
    { id: "scale", label: "Scale", kind: "number", step: 0.05 },
    { id: "visible", label: "Visible", kind: "boolean" },
    { id: "imageWidth", label: "Image Width (px)", kind: "number", step: 10 },
    { id: "borderRadius", label: "Corner Radius", kind: "number", step: 1 },
    { id: "useBorder", label: "Border", kind: "boolean" },
    { id: "borderColor", label: "Border Color", kind: "color" },
    { id: "borderWidth", label: "Border Width", kind: "number", step: 1 },
    { id: "useShadow", label: "Shadow", kind: "boolean" },
    { id: "shadowColor", label: "Shadow Color", kind: "color" },
    { id: "shadowBlur", label: "Shadow Blur", kind: "number", step: 1 },
    { id: "shadowOffsetX", label: "Shadow Offset X", kind: "number", step: 1 },
    { id: "shadowOffsetY", label: "Shadow Offset Y", kind: "number", step: 1 },
    { id: "opacity", label: "Opacity", kind: "number", step: 0.05 },
    { id: "enterAnimation", label: "Enter Animation", kind: "select", options: [...HUB_ANIMATIONS] },
    { id: "exitAnimation", label: "Exit Animation", kind: "select", options: [...HUB_ANIMATIONS] },
    { id: "enterEase", label: "Enter Easing", kind: "select", options: [...HUB_EASINGS] },
    { id: "exitEase", label: "Exit Easing", kind: "select", options: [...HUB_EASINGS] },
    { id: "durationIn", label: "Animation Duration In (s)", kind: "number", step: 0.05 },
    { id: "durationOut", label: "Animation Duration Out (s)", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getHubState(ctx.nodeId);
    const imgState = getImageState(ctx.nodeId);

    // A duplicated node (or a reopened project) carries a filePath but the
    // image itself lives in per-node memory — re-read it from disk when the
    // path changes so the second copy isn't silently invisible.
    if (typeof params.filePath === "string" && params.filePath && params.filePath !== imgState.lastPath) {
      reloadImageFromDisk(ctx.nodeId, params.filePath);
    }

    const cx = ctx.renderSize ? ctx.renderSize.width / 2 : 0;
    const cy = ctx.renderSize ? ctx.renderSize.height / 2 : 0;
    const x = num(inputs.x, cx);
    const y = num(inputs.y, cy);
    const rotation = num(inputs.rotation, params.rotation);
    const scale = Math.max(0.05, Math.min(4, num(inputs.scale, params.scale)));
    const baseVisible = inputs.visible !== undefined ? Number(inputs.visible) > 0 : Boolean(params.visible ?? true);
    const opacity = clamp01(num(inputs.opacity, params.opacity));
    const imageWidth = Math.max(1, num(imgState.width, params.imageWidth));
    const borderRadius = Math.max(0, num(params.borderRadius, 0));
    const borderColor = Boolean(params.useBorder) ? asColor(params.borderColor, new THREE.Color(0xffffff)).getStyle() : null;
    const borderWidth = Math.max(0, num(params.borderWidth, 0));
    const shadow = Boolean(params.useShadow)
      ? `${num(params.shadowOffsetX, 2)}px ${num(params.shadowOffsetY, 2)}px ${Math.max(0, num(params.shadowBlur, 10))}px ${asColor(params.shadowColor, new THREE.Color(0x000000)).getStyle()}`
      : null;
    const enterAnimation = (String(params.enterAnimation ?? "fade") as HubAnimation);
    const exitAnimation = (String(params.exitAnimation ?? "fade") as HubAnimation);
    const enterEase = (String(params.enterEase ?? "cubic-out") as HubEasing);
    const exitEase = (String(params.exitEase ?? "cubic-in") as HubEasing);
    const durationIn = Math.max(0.05, num(params.durationIn, 0.5));
    const durationOut = Math.max(0.05, num(params.durationOut, 0.5));

    const { nowSec, domain } = hubClock(ctx);
    const { p, anim, isShown } = resolveHubAnimation(
      state, inputs, nowSec, domain, durationIn, durationOut, enterEase, exitEase, enterAnimation, exitAnimation,
    );
    const style = hubAnimationStyle(anim, p);

    const hud: HubElement = {
      id: ctx.nodeId,
      text: "",
      imageUrl: imgState.url,
      imageWidth,
      x,
      y,
      rotation,
      fontFamily: "sans-serif",
      fontSize: 1,
      scale,
      color: "#ffffff",
      textShadow: null,
      backgroundColor: null,
      borderColor,
      borderWidth,
      borderRadius,
      shadow,
      cssOpacity: isShown ? opacity * style.opacity : 0,
      transform: `${style.transform} translate(-50%, -50%) rotate(${rotation}deg)`.trim(),
      filter: style.filter,
      visible: baseVisible && isShown && !!imgState.url,
    };

    return { hud };
  },
};
