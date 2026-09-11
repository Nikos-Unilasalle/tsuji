import * as THREE from "three";
import { NodeDefinition } from "../types";
import { asColor, degreesInput, numberInput } from "./object";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { createNodeCache } from "../nodeCaches";

function asVector(v: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  return v instanceof THREE.Vector3 ? v : fallback;
}

export type BackgroundFit = "stretch" | "cover" | "contain";

export interface EnvironmentData {
  color: THREE.Color;
  intensity: number;
  showBackground: boolean;
  blurriness: number;
  texture: THREE.Texture | null;
  /** A flat, non-equirect image standing in for the background color — independent of `texture`, which still drives reflections/lighting either way. */
  backgroundImage: THREE.Texture | null;
  /** How backgroundImage fills a viewport whose aspect ratio doesn't match the image's — computed against actual canvas size in Viewport.tsx, not here (this node has no canvas to measure). */
  backgroundFit: BackgroundFit;
  /** Extra zoom on top of the fit, x/y independent — (1,1) = fit as computed, >1 = zoom in/crop more. */
  backgroundScale: THREE.Vector3;
  /** Extra pan on top of the fit, in UV units. */
  backgroundOffset: THREE.Vector3;
  /** Radians, pivoted on the image center. */
  backgroundRotation: number;
  /** Global scene ambient light level — 0 disables it. */
  ambientIntensity: number;
  /** Global scene directional (sun) light level — 0 disables it. */
  sunIntensity: number;
}

const envTextureCache = createNodeCache<
  { lastPath?: string; texture?: THREE.Texture; lastBackgroundImagePath?: string; backgroundImage?: THREE.Texture }
>((s) => {
  s.texture?.dispose();
  s.backgroundImage?.dispose();
});

function getOrCreateEnvState(nodeId: string) {
  let state = envTextureCache.get(nodeId);
  if (!state) {
    state = {};
    envTextureCache.set(nodeId, state);
  }
  return state;
}

function loadEnvTexture(nodeId: string, filePath: string, content?: Uint8Array | string) {
  const state = getOrCreateEnvState(nodeId);
  if (!filePath) return;
  if (!content && state.lastPath === filePath && state.texture) return;
  state.lastPath = filePath;

  try {
    const ext = filePath.toLowerCase().split(".").pop();
    let url = filePath;
    if (content) {
      const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([content]);
      url = URL.createObjectURL(blob);
    }

    if (ext === "hdr") {
      new RGBELoader().load(
        url,
        (hdrTexture) => {
          if (content) URL.revokeObjectURL(url);
          hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
          hdrTexture.generateMipmaps = true;
          hdrTexture.minFilter = THREE.LinearMipmapLinearFilter;
          hdrTexture.needsUpdate = true;
          state.texture = hdrTexture;
        },
        undefined,
        (err) => {
          if (content) URL.revokeObjectURL(url);
          console.error("RGBELoader error loading HDR file:", filePath, err);
        }
      );
    } else if (ext === "exr") {
      new EXRLoader().load(
        url,
        (exrTexture) => {
          if (content) URL.revokeObjectURL(url);
          exrTexture.mapping = THREE.EquirectangularReflectionMapping;
          exrTexture.generateMipmaps = true;
          exrTexture.minFilter = THREE.LinearMipmapLinearFilter;
          exrTexture.needsUpdate = true;
          state.texture = exrTexture;
        },
        undefined,
        (err) => {
          if (content) URL.revokeObjectURL(url);
          console.error("EXRLoader error loading EXR file:", filePath, err);
        }
      );
    } else {
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          if (content) URL.revokeObjectURL(url);
          texture.mapping = THREE.EquirectangularReflectionMapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.generateMipmaps = true;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.needsUpdate = true;
          state.texture = texture;
        },
        undefined,
        (err) => {
          if (content) URL.revokeObjectURL(url);
          console.error("TextureLoader error loading env texture file:", filePath, err);
        }
      );
    }
  } catch (err) {
    console.error("Failed to load environment HDRI map:", err);
  }
}

/**
 * Plain 2D image, default UV mapping — deliberately NOT run through
 * EquirectangularReflectionMapping like loadEnvTexture above. That mapping
 * wraps an image as a 360° panorama (right for an HDRI skybox, wrong for
 * "just show this picture behind the scene") — three.js draws a plain
 * Texture assigned to scene.background as a flat, screen-filling backdrop
 * instead, which is what "fixed image replacing the background color" means.
 */
function loadBackgroundImageTexture(nodeId: string, filePath: string, content?: Uint8Array | string) {
  const state = getOrCreateEnvState(nodeId);
  if (!filePath) return;
  if (!content && state.lastBackgroundImagePath === filePath && state.backgroundImage) return;
  state.lastBackgroundImagePath = filePath;

  try {
    let url = filePath;
    if (content) {
      const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([content]);
      url = URL.createObjectURL(blob);
    }

    new THREE.TextureLoader().load(
      url,
      (texture) => {
        if (content) URL.revokeObjectURL(url);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        state.backgroundImage = texture;
      },
      undefined,
      (err) => {
        if (content) URL.revokeObjectURL(url);
        console.error("TextureLoader error loading background image:", filePath, err);
      }
    );
  } catch (err) {
    console.error("Failed to load background image:", err);
  }
}

/**
 * Environment & HDRI Node — configures 3D scene background color, HDRI environment map,
 * environment lighting reflection intensity, and background blurriness.
 */
export const ENVIRONMENT_NODE: NodeDefinition = {
  type: "lighting/environment",
  label: "Environment & HDRI",
  category: "lighting",
  inputs: [
    { id: "color", label: "Background Color", type: "color" },
    { id: "texture", label: "HDRI / Env Map", type: "texture" },
    { id: "intensity", label: "Env Intensity", type: "value" },
    { id: "background", label: "Show Background", type: "value" },
    { id: "blurriness", label: "Bg Blur", type: "value" },
    { id: "backgroundScale", label: "Bg Image Scale", type: "vector" },
    { id: "backgroundOffset", label: "Bg Image Offset", type: "vector" },
    { id: "backgroundRotation", label: "Bg Image Rotation", type: "value" },
  ],
  outputs: [{ id: "environment", label: "Environment", type: "any" }],
  defaultParams: {
    color: new THREE.Color(0x3f4956),
    intensity: 1.0,
    background: 1,
    blurriness: 0.0,
    filePath: "",
    backgroundImagePath: "",
    backgroundFit: "cover",
    backgroundScale: new THREE.Vector3(1, 1, 1),
    backgroundOffset: new THREE.Vector3(0, 0, 0),
    backgroundRotation: 0,
    ambientIntensity: 0.65,
    sunIntensity: 1.2,
  },
  dynamicParamFields: () => [
    { id: "color", label: "Background Color", kind: "color" },
    { id: "intensity", label: "Env Intensity", kind: "number", step: 0.1 },
    { id: "background", label: "Show Background", kind: "boolean" },
    { id: "blurriness", label: "Bg Blur", kind: "number", step: 0.001 },
    { id: "ambientIntensity", label: "Global Ambient Light", kind: "number", step: 0.05, group: "Lighting" },
    { id: "sunIntensity", label: "Global Sun Light", kind: "number", step: 0.05, group: "Lighting" },
    {
      id: "filePath",
      label: "HDRI Map (.hdr, .jpg, .png)",
      kind: "file",
      accept: [".hdr", ".exr", ".jpg", ".jpeg", ".png", ".webp"],
      onLoaded: (nodeId, path, content) => {
        loadEnvTexture(nodeId, path, content);
      },
    },
    {
      id: "backgroundImagePath",
      label: "Fixed Background Image (flat, overrides color)",
      kind: "file",
      accept: [".jpg", ".jpeg", ".png", ".webp", ".bmp"],
      onLoaded: (nodeId, path, content) => {
        loadBackgroundImageTexture(nodeId, path, content);
      },
    },
    { id: "backgroundFit", label: "Bg Image Fit", kind: "select", options: ["cover", "contain", "stretch"] },
    { id: "backgroundScale", label: "Bg Image Scale (fallback)", kind: "vector", step: 0.05 },
    { id: "backgroundOffset", label: "Bg Image Offset (fallback)", kind: "vector", step: 0.02 },
    { id: "backgroundRotation", label: "Bg Image Rotation (°, fallback)", kind: "number", step: 1, degrees: true },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getOrCreateEnvState(ctx.nodeId);
    if (typeof params.filePath === "string") {
      if (!params.filePath && state.texture) {
        state.texture.dispose();
        state.texture = undefined;
        state.lastPath = "";
      } else if (params.filePath && params.filePath !== state.lastPath) {
        loadEnvTexture(ctx.nodeId, params.filePath);
      }
    }
    if (typeof params.backgroundImagePath === "string") {
      if (!params.backgroundImagePath && state.backgroundImage) {
        state.backgroundImage.dispose();
        state.backgroundImage = undefined;
        state.lastBackgroundImagePath = "";
      } else if (params.backgroundImagePath && params.backgroundImagePath !== state.lastBackgroundImagePath) {
        loadBackgroundImageTexture(ctx.nodeId, params.backgroundImagePath);
      }
    }

    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0x3f4956)));
    const intensity = Math.max(0, numberInput(inputs.intensity, params.intensity, 1.0));

    const rawBg = inputs.background !== undefined ? inputs.background : params.background;
    const showBackground = rawBg === undefined ? true : typeof rawBg === "number" ? rawBg !== 0 : Boolean(rawBg);

    const blurriness = Math.max(0, Math.min(1, numberInput(inputs.blurriness, params.blurriness, 0.0)));

    const inputTexture = inputs.texture instanceof THREE.Texture ? inputs.texture : null;
    const activeTexture = inputTexture || state.texture || null;

    if (activeTexture) {
      activeTexture.mapping = THREE.EquirectangularReflectionMapping;
    }

    const backgroundFit: BackgroundFit =
      params.backgroundFit === "contain" || params.backgroundFit === "stretch" ? params.backgroundFit : "cover";
    const backgroundScale = asVector(inputs.backgroundScale, asVector(params.backgroundScale, new THREE.Vector3(1, 1, 1)));
    const backgroundOffset = asVector(inputs.backgroundOffset, asVector(params.backgroundOffset, new THREE.Vector3(0, 0, 0)));
    // Wired in degrees, stored in radians (three's texture.rotation) — see degreesInput.
    const backgroundRotation = degreesInput(inputs, params, "backgroundRotation", ctx, 0);

    const envData: EnvironmentData = {
      color,
      intensity,
      showBackground,
      blurriness,
      texture: activeTexture,
      backgroundImage: state.backgroundImage ?? null,
      backgroundFit,
      backgroundScale,
      backgroundOffset,
      backgroundRotation,
      ambientIntensity: Math.max(0, numberInput(inputs.ambientIntensity, params.ambientIntensity, 0.65)),
      sunIntensity: Math.max(0, numberInput(inputs.sunIntensity, params.sunIntensity, 1.2)),
    };

    return { environment: envData };
  },
};
