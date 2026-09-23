/**
 * Persistence for multi-layer splat weights.
 *
 * The first implementation quantized the weights to bytes and base64'd them
 * one `String.fromCharCode` at a time. At 1024² with four layers that is a
 * 4.2-million-iteration string concat on the main thread, producing ~5.6 MB of
 * base64 — written into the node's params at the end of every brush stroke,
 * saved into the .tsuji, and pushed at the autosave's localStorage quota
 * (which is around 5 MB, so autosave simply stopped working).
 *
 * Weights are 8-bit and spatially smooth, which is exactly what PNG is good
 * at. Packing four layers into one RGBA image and letting the encoder do its
 * job takes the same data to tens of kilobytes, and the encode happens in
 * native code rather than in a character loop.
 *
 * Old files keep loading: a payload that is plain base64 of the expected raw
 * length is still decoded the original way.
 */

import { restoreSplatBuffer } from "./textureMixEngine";

/** Layers packed per PNG image, one per RGBA channel. */
export const LAYERS_PER_IMAGE = 4;

export interface SplatEnvelope {
  v: 1;
  w: number;
  h: number;
  /** Layer count, which may not be a multiple of LAYERS_PER_IMAGE. */
  l: number;
  /** One data URL per group of four layers. */
  png: string[];
}

/** True when the string is one of the new PNG envelopes. */
export function isSplatEnvelope(serialized: string): boolean {
  return typeof serialized === "string" && serialized.startsWith('{"v":1');
}

export function parseSplatEnvelope(serialized: string): SplatEnvelope | null {
  if (!isSplatEnvelope(serialized)) return null;
  try {
    const parsed = JSON.parse(serialized) as SplatEnvelope;
    if (parsed.v !== 1 || !Array.isArray(parsed.png)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Quantizes a group of four layers into one RGBA byte array.
 *
 * Channels past the layer count are zeroed rather than left undefined, so the
 * PNG compresses them away to nothing.
 */
export function packLayerGroup(
  weights: Float32Array,
  width: number,
  height: number,
  layerCount: number,
  groupIndex: number,
): Uint8ClampedArray {
  const count = Math.max(1, layerCount);
  const bytes = new Uint8ClampedArray(width * height * 4);
  const base = groupIndex * LAYERS_PER_IMAGE;

  for (let pixel = 0; pixel < width * height; pixel++) {
    const src = pixel * count;
    const dst = pixel * 4;
    for (let c = 0; c < LAYERS_PER_IMAGE; c++) {
      const layer = base + c;
      bytes[dst + c] = layer < count ? Math.round(Math.max(0, Math.min(1, weights[src + layer])) * 255) : 0;
    }
  }
  return bytes;
}

/** Reverses packLayerGroup into the float weight buffer. */
export function unpackLayerGroup(
  weights: Float32Array,
  bytes: Uint8ClampedArray,
  width: number,
  height: number,
  layerCount: number,
  groupIndex: number,
): void {
  const count = Math.max(1, layerCount);
  const base = groupIndex * LAYERS_PER_IMAGE;

  for (let pixel = 0; pixel < width * height; pixel++) {
    const src = pixel * 4;
    const dst = pixel * count;
    for (let c = 0; c < LAYERS_PER_IMAGE; c++) {
      const layer = base + c;
      if (layer >= count) break;
      weights[dst + layer] = bytes[src + c] / 255;
    }
  }
}

/** How many PNG images a layer count needs. */
export function imageCountFor(layerCount: number): number {
  return Math.max(1, Math.ceil(Math.max(1, layerCount) / LAYERS_PER_IMAGE));
}

/**
 * Encodes the weights as a PNG envelope.
 *
 * Returns "" where there is no canvas to encode with (headless), which the
 * caller treats as "nothing to persist this time" rather than as data loss:
 * the in-memory buffer is still the live one.
 */
export function serializeSplatToPng(
  weights: Float32Array,
  width: number,
  height: number,
  layerCount: number,
): string {
  if (typeof document === "undefined") return "";

  const images: string[] = [];
  const groups = imageCountFor(layerCount);

  for (let g = 0; g < groups; g++) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    const bytes = packLayerGroup(weights, width, height, layerCount, g);
    const image = ctx.createImageData(width, height);
    image.data.set(bytes);
    ctx.putImageData(image, 0, 0);

    try {
      images.push(canvas.toDataURL("image/png"));
    } catch {
      return "";
    }
  }

  const envelope: SplatEnvelope = { v: 1, w: width, h: height, l: layerCount, png: images };
  return JSON.stringify(envelope);
}

/**
 * Restores weights from either format.
 *
 * PNG decoding is asynchronous, so the buffer arrives through `onDone` rather
 * than as a return value; legacy payloads still resolve synchronously and are
 * also delivered through the callback so callers have one code path.
 */
export function restoreSplatAuto(
  serialized: string,
  width: number,
  height: number,
  layerCount: number,
  onDone: (weights: Float32Array | null) => void,
): void {
  if (!serialized) {
    onDone(null);
    return;
  }

  const envelope = parseSplatEnvelope(serialized);
  if (!envelope) {
    // Pre-PNG file: raw quantized base64.
    onDone(restoreSplatBuffer(serialized, width, height, layerCount));
    return;
  }

  if (envelope.w !== width || envelope.h !== height || typeof Image === "undefined") {
    // A resolution change invalidates the stored map; better to keep the
    // current weights than to stretch someone's painting.
    onDone(null);
    return;
  }

  const count = Math.max(1, layerCount);
  const weights = new Float32Array(width * height * count);
  let remaining = envelope.png.length;
  let failed = false;

  if (remaining === 0) {
    onDone(null);
    return;
  }

  envelope.png.forEach((dataUrl, groupIndex) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const data = ctx.getImageData(0, 0, width, height).data;
          unpackLayerGroup(weights, data, width, height, count, groupIndex);
        } else {
          failed = true;
        }
      } catch {
        failed = true;
      }
      if (--remaining === 0) onDone(failed ? null : weights);
    };
    img.onerror = () => {
      failed = true;
      if (--remaining === 0) onDone(null);
    };
    img.src = dataUrl;
  });
}

/**
 * Base64 for a byte array, in chunks.
 *
 * Kept for any caller still producing raw payloads: building the binary string
 * one `+=` at a time is O(n) allocations and was measurably seconds of frozen
 * UI on a large map.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "undefined") return "";
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
  }
  return btoa(parts.join(""));
}
