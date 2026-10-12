// Converts a subset of an OpenType/TrueType font (CJK included) to the three.js
// FontLoader JSON the Text node reads. `convertFonts.mjs` keeps Latin only; a
// CJK face has ~30k glyphs, so this one keeps exactly the characters you name.
//
//   node scripts/convertFontSubset.mjs <font.otf> <out.json> "<characters>" [Family Name]
//
// Printable ASCII is always included so numbers and Latin titles work.
import opentype from "opentype.js";
import { readFileSync, writeFileSync } from "node:fs";

const [, , src, out, chars = "", family = "Subset"] = process.argv;
if (!src || !out) {
  console.error('usage: node scripts/convertFontSubset.mjs <font> <out.json> "<characters>" [family]');
  process.exit(1);
}

const round = (n) => Math.round(n * 100) / 100;
const buffer = readFileSync(src);
const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

const wanted = new Set(chars);
for (let cp = 0x20; cp <= 0x7e; cp++) wanted.add(String.fromCharCode(cp));

function outline(char) {
  const parts = [];
  // SVG coordinates are y-down; the three.js Font format is y-up.
  for (const c of font.getPath(char, 0, 0, font.unitsPerEm).commands) {
    if (c.type === "M") parts.push(`m ${round(c.x)} ${round(-c.y)}`);
    else if (c.type === "L") parts.push(`l ${round(c.x)} ${round(-c.y)}`);
    else if (c.type === "Q") parts.push(`q ${round(c.x)} ${round(-c.y)} ${round(c.x1)} ${round(-c.y1)}`);
    else if (c.type === "C") parts.push(`b ${round(c.x)} ${round(-c.y)} ${round(c.x1)} ${round(-c.y1)} ${round(c.x2)} ${round(-c.y2)}`);
  }
  return parts.join(" ");
}

const glyphs = {};
const missing = [];
for (const char of wanted) {
  const g = font.charToGlyph(char);
  if (!g || g.index === 0) { missing.push(char); continue; }
  glyphs[char] = { x_min: Math.round(g.xMin ?? 0), x_max: Math.round(g.xMax ?? 0), ha: Math.round(g.advanceWidth), o: outline(char) };
}

const data = {
  familyName: family, cssFontWeight: "normal", cssFontStyle: "normal",
  resolution: font.unitsPerEm, ascender: Math.round(font.ascender), descender: Math.round(font.descender),
  lineHeight: Math.round(font.ascender - font.descender), underlineThickness: 50, underlinePosition: -100,
  boundingBox: { yMin: Math.round(font.descender), xMin: -50, yMax: Math.round(font.ascender), xMax: 1000 },
  glyphs,
};
const json = JSON.stringify(data);
writeFileSync(out, json);
console.log(`${out}: ${(json.length / 1024).toFixed(0)}KB, ${Object.keys(glyphs).length} glyphs${missing.length ? `, missing: ${missing.join("")}` : ""}`);
