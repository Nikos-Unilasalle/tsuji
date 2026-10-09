import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { textureSize } from "../gpuTexture";
import { compositeMasks, maskToRgba } from "../maskRaster";
import { bitmapFingerprint } from "../maskBitmap";
import { MaskLayer, sanitizeLayers } from "../maskShapes";

export const MASK_RESOLUTIONS = ["512", "1024", "2048"] as const;

interface RotoMaskState {
  texture: THREE.DataTexture;
  data: Uint8Array;
  width: number;
  height: number;
  key: string;
}

const rotoCache = createNodeCache<RotoMaskState>((s) => s.texture.dispose());

/** The size a mask is rasterised at: its long side is `resolution`, its shape the image's. */
export function maskRasterSize(
  resolution: unknown,
  aspect: number,
): [number, number] {
  const long = Math.max(64, Math.min(2048, Math.round(Number(resolution) || 1024)));
  const a = Number.isFinite(aspect) && aspect > 0.01 && aspect < 100 ? aspect : 1;
  return a >= 1 ? [long, Math.max(1, Math.round(long / a))] : [Math.max(1, Math.round(long * a)), long];
}

/**
 * The key a mask's pixels depend on — nothing else may change them, and
 * nothing in it may change while they stay the same, or the mask is
 * re-rasterised every frame.
 */
export function maskKey(layers: readonly MaskLayer[], width: number, height: number, showFull: boolean): string {
  if (showFull) return `full|${width}x${height}`;
  return `${width}x${height}|${JSON.stringify(
    layers.map((l) => [
      l.visible,
      l.mode,
      l.opacity,
      l.invert,
      l.feather,
      l.expansion,
      l.kind === "paint" ? (l.bitmap ? bitmapFingerprint(l.bitmap) : "empty") : l.points.map((p) => [p.x, p.y, p.ix, p.iy, p.ox, p.oy]),
    ]),
  )}`;
}

/**
 * Roto Mask — a mask drawn by hand over an image, as a texture.
 *
 * Select the node and the viewport offers the drawing tools: pen (Bézier
 * with tangent handles), ellipse, rectangle and freehand, each shape its own
 * layer with a mode (Add, Subtract, Intersect, Difference — as in After
 * Effects), opacity, a soft edge and an expansion. The shapes are drawn on
 * whatever the mask feeds — a Texture to Plane, say — and stored in UV, so
 * they follow the image and do not depend on the mask's resolution.
 *
 * The output is a plain grey texture (white shows, black hides), so every
 * texture node — Blur, Levels, Invert, Mix, Math — works on it as a mask
 * operator. A mask with nothing drawn on it is white: wiring one in does not
 * make the picture disappear.
 *
 * The mask is rasterised on the CPU, only when a shape or a setting changes.
 * Wire an image into `Reference` and the mask takes its aspect ratio (and the
 * editor shows it); without one, `Aspect` stands in and the viewport sets it
 * from the surface being drawn on.
 */
export const ROTO_MASK_NODE: NodeDefinition = {
  type: "mask/roto",
  label: "Roto Mask",
  category: "textureTools",
  inputs: [{ id: "reference", label: "Reference Image", type: "texture" }],
  outputs: [
    { id: "mask", label: "Mask", type: "texture" },
    { id: "aspect", label: "Aspect", type: "value" },
  ],
  defaultParams: {
    masks: [] as MaskLayer[],
    activeLayer: 0,
    /** The brush: diameter on screen in px, hardness (0 = soft falloff), flow. */
    brushSize: 48,
    brushHardness: 0.3,
    brushFlow: 1,
    resolution: "1024",
    aspect: 1,
    showFull: false,
  },
  paramFields: [
    { id: "resolution", label: "Resolution (long side, px)", kind: "select", options: [...MASK_RESOLUTIONS] },
    { id: "aspect", label: "Aspect (width / height, without a Reference)", kind: "number", step: 0.01 },
    { id: "showFull", label: "Show the whole image while editing", kind: "boolean" },
    {
      id: "howTo",
      label:
        "Select this node and draw in the viewport, on the surface the mask feeds: pen, ellipse, rectangle, freehand. " +
        "Wire the result into a mask input (Texture to Plane) or into Apply Mask.",
      kind: "note",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const reference = inputs.reference instanceof THREE.Texture ? inputs.reference : null;
    const refSize = textureSize(reference);
    const aspect = refSize ? refSize[0] / refSize[1] : Number(params.aspect) || 1;
    const [width, height] = maskRasterSize(params.resolution, aspect);
    const layers = sanitizeLayers(params.masks);
    const showFull = Boolean(params.showFull);
    const key = maskKey(layers, width, height, showFull);

    let state = rotoCache.get(ctx.nodeId);
    if (!state || state.width !== width || state.height !== height) {
      state?.texture.dispose();
      const data = new Uint8Array(width * height * 4);
      const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = false;
      state = { texture, data, width, height, key: "" };
      rotoCache.set(ctx.nodeId, state);
    }

    if (state.key !== key) {
      const mask = showFull
        ? new Float32Array(width * height).fill(1)
        : compositeMasks(layers, width, height);
      maskToRgba(mask, state.data);
      state.texture.needsUpdate = true;
      state.key = key;
    }

    return { mask: state.texture, aspect: width / height };
  },
};
