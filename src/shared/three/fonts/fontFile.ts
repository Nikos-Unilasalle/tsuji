import { Font as OpenTypeFont, parse as parseOpenType } from "opentype.js";
import { Font, FontLoader } from "three/examples/jsm/loaders/FontLoader.js";

/** Font files the Text nodes accept: a three.js typeface JSON, or a real font. */
export const FONT_FILE_ACCEPT = [".json", ".ttf", ".otf", ".woff"];

const round = (n: number) => Math.round(n * 100) / 100;

/** The three.js typeface outline string for one character (y flipped: SVG space is y-down, typeface is y-up). */
function outlineOf(font: OpenTypeFont, char: string): string {
  const parts: string[] = [];
  const neg = (n: number | undefined) => round(-(n ?? 0));
  for (const c of font.getPath(char, 0, 0, font.unitsPerEm).commands) {
    if (c.type === "M") parts.push(`m ${round(c.x ?? 0)} ${neg(c.y)}`);
    else if (c.type === "L") parts.push(`l ${round(c.x ?? 0)} ${neg(c.y)}`);
    else if (c.type === "Q") parts.push(`q ${round(c.x ?? 0)} ${neg(c.y)} ${round(c.x1 ?? 0)} ${neg(c.y1)}`);
    else if (c.type === "C") parts.push(`b ${round(c.x ?? 0)} ${neg(c.y)} ${round(c.x1 ?? 0)} ${neg(c.y1)} ${round(c.x2 ?? 0)} ${neg(c.y2)}`);
  }
  return parts.join(" ");
}

/**
 * A three.js Font backed by a real font file. The glyph table is lazy — a glyph's outline is converted the first time a
 * string asks for it — so a CJK font with tens of thousands of glyphs costs only the characters actually shown.
 */
export function fontFromOpenType(buffer: ArrayBuffer): Font {
  const otf = parseOpenType(buffer);
  const cache = new Map<string, unknown>();
  const glyphs = new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (typeof key !== "string" || [...key].length !== 1) return undefined;
      if (cache.has(key)) return cache.get(key);
      const glyph = otf.charToGlyph(key);
      const entry =
        !glyph || glyph.index === 0
          ? undefined
          : {
              x_min: Math.round(glyph.xMin ?? 0),
              x_max: Math.round(glyph.xMax ?? 0),
              ha: Math.round(glyph.advanceWidth ?? otf.unitsPerEm / 2),
              o: outlineOf(otf, key),
            };
      cache.set(key, entry);
      return entry;
    },
    has: (_t, key) => typeof key === "string" && [...key].length === 1 && otf.charToGlyph(key)?.index !== 0,
  });
  return new Font({
    familyName: "Custom",
    resolution: otf.unitsPerEm,
    ascender: Math.round(otf.ascender),
    descender: Math.round(otf.descender),
    underlineThickness: 50,
    underlinePosition: -100,
    boundingBox: { yMin: Math.round(otf.descender), xMin: -50, yMax: Math.round(otf.ascender), xMax: otf.unitsPerEm },
    glyphs,
  } as never);
}

/** Reads a font the user picked: typeface JSON as text, a font file as bytes. Throws if it is neither. */
export function parseFontFile(path: string, content: unknown): Font {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "ttf" || ext === "otf" || ext === "woff") {
    if (!(content instanceof Uint8Array)) throw new Error("A font file has to be read as bytes.");
    const copy = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
    return fontFromOpenType(copy);
  }
  return new FontLoader().parse(JSON.parse(String(content)));
}
