import * as opentype from "opentype.js";
import { describe, expect, test } from "vitest";
import { fontFromOpenType, parseFontFile } from "./fontFile";

/** A one-glyph font ("A": a triangle), built in memory so the test needs no font file. */
function tinyFontBytes(): Uint8Array {
  const notdef = new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: 650, path: new opentype.Path() });
  const triangle = new opentype.Path();
  triangle.moveTo(0, 0);
  triangle.lineTo(300, 700);
  triangle.lineTo(600, 0);
  triangle.close();
  const a = new opentype.Glyph({ name: "A", unicode: 65, advanceWidth: 650, path: triangle });
  const font = new opentype.Font({ familyName: "Tiny", styleName: "Regular", unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [notdef, a] });
  return new Uint8Array(font.toArrayBuffer());
}

describe("font files", () => {
  test("a TTF/OTF becomes a three.js Font that shapes the characters it has", () => {
    const bytes = tinyFontBytes();
    const font = parseFontFile("tiny.otf", bytes);
    expect(font.generateShapes("A", 1).length).toBe(1);
    expect(font.data.resolution).toBe(1000);
  });

  test("glyphs are converted on demand, and a missing one is simply absent", () => {
    const bytes = tinyFontBytes();
    const font = fontFromOpenType(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const glyphs = font.data.glyphs as Record<string, { ha: number; o: string } | undefined>;
    expect(glyphs["A"]?.ha).toBe(650);
    expect(glyphs["A"]?.o.startsWith("m ")).toBe(true);
    expect(glyphs["Z"]).toBeUndefined();
  });

  test("a font file has to arrive as bytes", () => {
    expect(() => parseFontFile("tiny.ttf", "not bytes")).toThrow();
  });
});
