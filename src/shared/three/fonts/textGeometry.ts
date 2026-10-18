import * as THREE from "three";
import type { Font } from "three/examples/jsm/loaders/FontLoader.js";

/**
 * Extruded text built from cached glyphs: the same vertices, bit for bit, as
 * `new ExtrudeGeometry(font.generateShapes(text, size), options)`, without
 * triangulating and bevelling every letter again whenever the text changes.
 *
 * A Text node driven by the frame (a counter, a typewriter reveal, a value
 * readout) re-extruded its whole string every frame — the costliest node in
 * the stress bench after the fluid sim.
 *
 * ExtrudeGeometry treats every shape on its own — triangulates it, bevels it,
 * appends its lid faces (group 0) then its side walls (group 1) — so the
 * string's geometry is its glyphs' geometries end to end. A glyph is cached
 * *where it stands* (character, pen position, size, options), not at the
 * origin: earcut is not translation-invariant (its z-order hashing rounds
 * differently), so a glyph extruded elsewhere and shifted would come out as
 * a different triangulation of the same surface — which Spawn, sampling
 * triangles, would see. Counters, reveals and readouts keep most glyphs at
 * the same pen positions from one frame to the next, which is what hits.
 */

export interface TextExtrudeOptions {
  depth: number;
  bevelEnabled: boolean;
  bevelThickness: number;
  bevelSize: number;
  bevelSegments: number;
  curveSegments: number;
}

interface Glyph {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  groups: { start: number; count: number; materialIndex: number }[];
}

let cacheEnabled = true;

/** Off: buildTextGeometry always returns null, so callers extrude the whole string — for tests comparing the two. */
export function setGlyphCacheEnabled(enabled: boolean): void {
  cacheEnabled = enabled;
}

/** Bounds a font's cache: a text scrolling through sizes or positions would otherwise grow it without end. */
const MAX_GLYPHS_PER_FONT = 4096;
const glyphCaches = new WeakMap<Font, Map<string, Glyph>>();

type FontGlyph = { ha: number; o?: string; _cachedOutline?: string[] };
type FontData = {
  resolution: number;
  boundingBox: { yMin: number; yMax: number };
  underlineThickness: number;
  glyphs: Record<string, FontGlyph | undefined>;
};

/** three's createPath (FontLoader.js), operation for operation, so the outline points are the same doubles. */
function glyphPath(glyph: FontGlyph, scale: number, offsetX: number, offsetY: number): THREE.ShapePath {
  const path = new THREE.ShapePath();
  if (!glyph.o) return path;
  const outline = glyph._cachedOutline || (glyph._cachedOutline = glyph.o.split(" "));
  const n = (s: string) => +s;
  for (let i = 0, l = outline.length; i < l; ) {
    const action = outline[i++];
    switch (action) {
      case "m": {
        const x = n(outline[i++]) * scale + offsetX;
        const y = n(outline[i++]) * scale + offsetY;
        path.moveTo(x, y);
        break;
      }
      case "l": {
        const x = n(outline[i++]) * scale + offsetX;
        const y = n(outline[i++]) * scale + offsetY;
        path.lineTo(x, y);
        break;
      }
      case "q": {
        const cpx = n(outline[i++]) * scale + offsetX;
        const cpy = n(outline[i++]) * scale + offsetY;
        const cpx1 = n(outline[i++]) * scale + offsetX;
        const cpy1 = n(outline[i++]) * scale + offsetY;
        path.quadraticCurveTo(cpx1, cpy1, cpx, cpy);
        break;
      }
      case "b": {
        const cpx = n(outline[i++]) * scale + offsetX;
        const cpy = n(outline[i++]) * scale + offsetY;
        const cpx1 = n(outline[i++]) * scale + offsetX;
        const cpy1 = n(outline[i++]) * scale + offsetY;
        const cpx2 = n(outline[i++]) * scale + offsetX;
        const cpy2 = n(outline[i++]) * scale + offsetY;
        path.bezierCurveTo(cpx1, cpy1, cpx2, cpy2, cpx, cpy);
        break;
      }
    }
  }
  return path;
}

function buildGlyph(path: THREE.ShapePath, options: TextExtrudeOptions): Glyph {
  const geometry = new THREE.ExtrudeGeometry(path.toShapes(), options);
  const glyph: Glyph = {
    position: ((geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array).slice(),
    normal: ((geometry.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array).slice(),
    uv: ((geometry.getAttribute("uv") as THREE.BufferAttribute).array as Float32Array).slice(),
    groups: geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex ?? 0 })),
  };
  geometry.dispose();
  return glyph;
}

/**
 * The extruded text, or null when it has to be left to ExtrudeGeometry: the
 * cache is off, or a character has no glyph and no "?" to stand in — where
 * three itself throws, and the caller should keep doing exactly that.
 */
export function buildTextGeometry(font: Font, text: string, size: number, options: TextExtrudeOptions): THREE.BufferGeometry | null {
  if (!cacheEnabled) return null;
  const data = (font as unknown as { data?: FontData }).data;
  if (!data?.glyphs || !data.boundingBox) return null;

  let cache = glyphCaches.get(font);
  if (!cache) {
    cache = new Map();
    glyphCaches.set(font, cache);
  }
  const optionsKey = `${size}|${options.depth}|${options.bevelEnabled}|${options.bevelThickness}|${options.bevelSize}|${options.bevelSegments}|${options.curveSegments}`;

  // Pen layout as three's createPaths, left to right.
  const scale = size / data.resolution;
  const lineHeight = (data.boundingBox.yMax - data.boundingBox.yMin + data.underlineThickness) * scale;
  const glyphs: Glyph[] = [];
  let offsetX = 0;
  let offsetY = 0;
  let floats = 0;

  for (const char of Array.from(text)) {
    if (char === "\n") {
      offsetX = 0;
      offsetY -= lineHeight;
      continue;
    }
    const source = data.glyphs[char] || data.glyphs["?"];
    if (!source) return null;
    const key = `${char}\u0000${offsetX}\u0000${offsetY}\u0000${optionsKey}`;
    let glyph = cache.get(key);
    if (!glyph) {
      // Oldest first (a Map iterates in insertion order): what a moving text left behind goes before what it is using.
      if (cache.size >= MAX_GLYPHS_PER_FONT) cache.delete(cache.keys().next().value!);
      glyph = buildGlyph(glyphPath(source, scale, offsetX, offsetY), options);
      cache.set(key, glyph);
    }
    glyphs.push(glyph);
    floats += glyph.position.length;
    offsetX += source.ha * scale;
  }

  const position = new Float32Array(floats);
  const normal = new Float32Array(floats);
  const uv = new Float32Array((floats / 3) * 2);
  const geometry = new THREE.BufferGeometry();
  let vertex = 0;
  for (const glyph of glyphs) {
    position.set(glyph.position, vertex * 3);
    normal.set(glyph.normal, vertex * 3);
    uv.set(glyph.uv, vertex * 2);
    for (const g of glyph.groups) geometry.addGroup(vertex + g.start, g.count, g.materialIndex);
    vertex += glyph.position.length / 3;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}
