import * as THREE from "three";
import { Font } from "three/examples/jsm/loaders/FontLoader.js";

export type TextAlignment = "left" | "center" | "right";
export type TextAnchor = "glyph_center" | "baseline_center" | "bottom_center" | "top_center";

export interface GlyphLayoutInfo {
  char: string;
  charIndex: number;
  wordIndex: number;
  lineIndex: number;
  /** 3D position where this glyph's local origin should be placed. */
  basePosition: THREE.Vector3;
  /** Base orientation along path or planar (Euler angles in radians). */
  baseRotation: THREE.Euler;
  /** Base transformation matrix before animator range selector deltas. */
  baseMatrix: THREE.Matrix4;
  /** Width advance of this glyph. */
  advance: number;
  /** 2D Extruded shapes for this character. Empty for whitespace. */
  shapes: THREE.Shape[];
  /** Bounding box of the 2D glyph shapes. */
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
  };
}

export interface TextLayoutOptions {
  fontSize?: number;
  tracking?: number; // extra space in px/units
  lineHeight?: number; // multiplier, default 1.2
  align?: TextAlignment;
  anchor?: TextAnchor;
  curve?: THREE.Curve<THREE.Vector3> | null;
  pathOffset?: number; // 0..1 shift along the curve
  alignToPath?: boolean; // orient along tangent
  fitToCurve?: boolean; // distribute evenly along entire curve
}

export interface ComputedTextLayout {
  glyphs: GlyphLayoutInfo[];
  totalWidth: number;
  totalHeight: number;
  lines: string[];
  words: string[];
}

/** Computes bounding box of an array of 2D shapes. */
function computeShapesBounds(shapes: THREE.Shape[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
} {
  if (shapes.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const s of shapes) {
    const pts = s.getPoints();
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  if (!isFinite(minX)) {
    minX = 0;
    maxX = 0;
    minY = 0;
    maxY = 0;
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/**
 * Parses text and computes per-glyph layout, bounds, and placement coordinates.
 */
export function computeTextLayout(
  text: string,
  font: Font,
  options: TextLayoutOptions = {}
): ComputedTextLayout {
  const {
    fontSize = 64,
    tracking = 0,
    lineHeight = 1.2,
    align = "center",
    curve = null,
    pathOffset = 0,
    alignToPath = true,
    fitToCurve = false,
  } = options;

  const scale = Math.max(0.001, fontSize * 0.015);
  const resolution = font.data.resolution || 1000;
  const glyphScale = scale / resolution;

  const fontDataAny = font.data as any;
  const fontLineHeight =
    (fontDataAny.lineHeight ||
      (font.data.boundingBox.yMax - font.data.boundingBox.yMin + (fontDataAny.underlineThickness || 0))) *
    glyphScale *
    lineHeight;

  const rawLines = text.split("\n");
  const words: string[] = [];
  const lineStrings: string[] = [];

  // 1. Gather lines, words, and measure line widths
  interface TempChar {
    char: string;
    charIndex: number;
    wordIndex: number;
    lineIndex: number;
    advance: number;
    shapes: THREE.Shape[];
    bounds: ReturnType<typeof computeShapesBounds>;
  }

  const linesOfChars: TempChar[][] = [];
  let globalCharIndex = 0;
  let globalWordIndex = 0;

  for (let l = 0; l < rawLines.length; l++) {
    const lineText = rawLines[l];
    lineStrings.push(lineText);
    const lineChars: TempChar[] = [];

    const lineWords = lineText.split(/(\s+)/);
    for (const token of lineWords) {
      if (!token) continue;
      const isWhitespace = /^\s+$/.test(token);
      if (!isWhitespace) {
        words.push(token);
      }

      for (let c = 0; c < token.length; c++) {
        const char = token[c];
        const glyphData = font.data.glyphs[char] || font.data.glyphs[" "] || { ha: 500 };
        const baseAdvance = (glyphData.ha ?? 500) * glyphScale;
        const advance = baseAdvance + tracking * 0.02;

        const shapes = font.generateShapes(char, scale);
        const bounds = computeShapesBounds(shapes);

        lineChars.push({
          char,
          charIndex: globalCharIndex++,
          wordIndex: globalWordIndex,
          lineIndex: l,
          advance,
          shapes,
          bounds,
        });
      }
      if (!isWhitespace) {
        globalWordIndex++;
      }
    }
    linesOfChars.push(lineChars);
  }

  // 2. Measure line dimensions
  const lineWidths = linesOfChars.map((line) =>
    line.reduce((sum, ch) => sum + ch.advance, 0)
  );
  const maxLineWidth = Math.max(...lineWidths, 0);
  const totalHeight = Math.max(0, (rawLines.length - 1) * fontLineHeight);

  // 3. Compute 2D planar positions
  const glyphs: GlyphLayoutInfo[] = [];

  const totalCharsCount = globalCharIndex;
  const curveLength = curve ? curve.getLength() : 0;

  let accumulatedAdvanceAlongPath = 0;

  for (let l = 0; l < linesOfChars.length; l++) {
    const line = linesOfChars[l];
    const lineWidth = lineWidths[l];

    let xCursor = 0;
    if (align === "center") {
      xCursor = -lineWidth / 2;
    } else if (align === "right") {
      xCursor = -lineWidth;
    } else {
      xCursor = 0;
    }

    // Centered baseline around Y=0
    const baselineY = totalHeight / 2 - l * fontLineHeight;

    for (const item of line) {
      const charWidth = item.advance;
      const charCenter2D = xCursor + charWidth / 2;

      let posX = charCenter2D;
      let posY = baselineY;
      let posZ = 0;

      const baseRotation = new THREE.Euler(0, 0, 0);
      const baseMatrix = new THREE.Matrix4();

      if (curve && curveLength > 0) {
        // --- 3D Curve Conforming (Text on Path) ---
        let u: number;
        if (fitToCurve && totalCharsCount > 1) {
          u = (item.charIndex / (totalCharsCount - 1) + pathOffset) % 1;
        } else {
          const charMidDist = accumulatedAdvanceAlongPath + item.advance / 2;
          u = ((charMidDist + pathOffset * curveLength) / curveLength) % 1;
        }
        if (u < 0) u += 1;

        const curvePt = curve.getPointAt(u);
        posX = curvePt.x;
        posY = curvePt.y;
        posZ = curvePt.z;

        if (alignToPath) {
          const tangent = curve.getTangentAt(u).normalize();
          const up = new THREE.Vector3(0, 1, 0);
          if (Math.abs(tangent.dot(up)) > 0.99) {
            up.set(0, 0, 1);
          }
          const normal = new THREE.Vector3().crossVectors(up, tangent).normalize();
          const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();

          const rotMatrix = new THREE.Matrix4().makeBasis(tangent, binormal, normal);
          baseRotation.setFromRotationMatrix(rotMatrix);
          baseMatrix.makeRotationFromEuler(baseRotation);
        }

        accumulatedAdvanceAlongPath += item.advance;
      }

      baseMatrix.setPosition(posX, posY, posZ);

      glyphs.push({
        char: item.char,
        charIndex: item.charIndex,
        wordIndex: item.wordIndex,
        lineIndex: item.lineIndex,
        basePosition: new THREE.Vector3(posX, posY, posZ),
        baseRotation,
        baseMatrix,
        advance: item.advance,
        shapes: item.shapes,
        bounds: item.bounds,
      });

      xCursor += item.advance;
    }
  }

  return {
    glyphs,
    totalWidth: maxLineWidth,
    totalHeight,
    lines: lineStrings,
    words,
  };
}
