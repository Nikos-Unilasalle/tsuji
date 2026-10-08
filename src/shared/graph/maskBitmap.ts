/**
 * Painted mask layers: an 8-bit coverage bitmap, stored in the node's params.
 *
 * A project file and the undo history both hold params, so the bitmap has to
 * live there as plain data — and a megapixel of mostly empty bytes would make
 * every undo step and every save enormous. Run-length encoding fixes that: a
 * mask is mostly 0 (nothing painted) or 255 (fully painted), in long runs, and
 * only a soft brush's falloff breaks them up. Encoded, it is a string, so
 * cloning params shares it rather than copying it.
 *
 * Pure and synchronous (no canvas, no CompressionStream) so it runs the same
 * in a node's `evaluate`, in tests and in an export.
 */

export interface MaskBitmap {
  w: number;
  h: number;
  /** Run-length encoded, base64. Row 0 is the bottom of the image, as everywhere else in the mask code. */
  data: string;
}

export const MAX_BITMAP_SIDE = 4096;

export function emptyBitmap(w: number, h: number): MaskBitmap {
  return { w, h, data: encodeBytes(new Uint8Array(w * h)) };
}

/** Bytes → [value, run length as LEB128] pairs → base64. */
export function encodeBytes(bytes: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const value = bytes[i];
    let run = 1;
    while (i + run < bytes.length && bytes[i + run] === value) run++;
    out.push(value);
    let n = run;
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
    i += run;
  }
  let binary = "";
  for (let k = 0; k < out.length; k += 0x8000) binary += String.fromCharCode(...out.slice(k, k + 0x8000));
  return btoa(binary);
}

/**
 * The inverse, into exactly `length` bytes. Malformed or truncated data gives
 * what could be read and zeros after it — never a throw, never more bytes
 * than asked for: a corrupt file must not take the project down.
 */
export function decodeBytes(data: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return out;
  }
  let pos = 0;
  let i = 0;
  while (i < binary.length && pos < length) {
    const value = binary.charCodeAt(i++);
    let run = 0;
    let shift = 0;
    while (i < binary.length) {
      const b = binary.charCodeAt(i++);
      run += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80) || shift > 35) break;
    }
    const end = Math.min(length, pos + run);
    if (value !== 0) out.fill(value, pos, end);
    pos = end;
  }
  return out;
}

export function isValidBitmap(value: unknown): value is MaskBitmap {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return (
    Number.isInteger(b.w) &&
    Number.isInteger(b.h) &&
    (b.w as number) >= 1 &&
    (b.h as number) >= 1 &&
    (b.w as number) <= MAX_BITMAP_SIDE &&
    (b.h as number) <= MAX_BITMAP_SIDE &&
    typeof b.data === "string"
  );
}

/*
 * A decoded bitmap is reused for as long as the string is the same one. Keyed
 * on the data string itself (an engine caches a string's hash, so the lookup
 * is cheap for the same instance) with the size checked on the entry.
 */
const decoded = new Map<string, { w: number; h: number; bytes: Uint8Array }>();
const MAX_DECODED = 6;

/** The bitmap's bytes. Shared and cached: copy before writing to it. */
export function decodeBitmap(bitmap: MaskBitmap): Uint8Array {
  const hit = decoded.get(bitmap.data);
  if (hit && hit.w === bitmap.w && hit.h === bitmap.h) {
    decoded.delete(bitmap.data);
    decoded.set(bitmap.data, hit);
    return hit.bytes;
  }
  const bytes = decodeBytes(bitmap.data, bitmap.w * bitmap.h);
  decoded.set(bitmap.data, { w: bitmap.w, h: bitmap.h, bytes });
  if (decoded.size > MAX_DECODED) decoded.delete(decoded.keys().next().value as string);
  return bytes;
}

export function encodeBitmap(w: number, h: number, bytes: Uint8Array): MaskBitmap {
  return { w, h, data: encodeBytes(bytes) };
}

/**
 * A cheap fingerprint of a bitmap, for a cache key: length plus a hash over the
 * whole string. Memoised on the last string seen, so the per-frame check is a
 * pointer comparison, not a pass over a megabyte.
 */
let lastHashed: { data: string; hash: string } | null = null;
export function bitmapFingerprint(bitmap: MaskBitmap): string {
  if (!lastHashed || lastHashed.data !== bitmap.data) {
    let h = 2166136261;
    const s = bitmap.data;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    lastHashed = { data: bitmap.data, hash: `${s.length}.${(h >>> 0).toString(36)}` };
  }
  return `${bitmap.w}x${bitmap.h}.${lastHashed.hash}`;
}
