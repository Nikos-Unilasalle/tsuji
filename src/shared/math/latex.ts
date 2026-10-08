import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

/**
 * LaTeX to vector glyphs. MathJax typesets the formula into SVG — offline,
 * the same layout as in a browser or a paper — and this walks the result
 * straight off MathJax's own lightweight DOM (no browser DOM needed, so it
 * runs headless too) into three.js shapes, one entry per glyph, each
 * remembering the character it draws. Units are ems (MathJax's 1000 per em,
 * divided out), y up, origin on the baseline at the formula's left.
 */

export interface Glyph {
  /** The character drawn ("x", "∫", "2"), or "rule" for a fraction bar or root's line. */
  char: string;
  shapes: THREE.Shape[];
  /** Left, right, bottom, top, in ems. */
  box: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface Typeset {
  glyphs: Glyph[];
  box: { minX: number; maxX: number; minY: number; maxY: number };
  /** The TeX error MathJax reported, if any — the formula is then empty. */
  error?: string;
}

type LiteNode = unknown;

let engine: { adaptor: ReturnType<typeof liteAdaptor>; doc: ReturnType<typeof mathjax.document> } | null = null;

function mathjaxEngine() {
  if (!engine) {
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    // fontCache none: every glyph's outline sits inline where it is used, not behind a <use>.
    const doc = mathjax.document("", { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: "none" }) });
    engine = { adaptor, doc };
  }
  return engine;
}

/** Parses an SVG transform list into a 2D affine matrix. */
function parseTransform(text: string | null): THREE.Matrix3 {
  const m = new THREE.Matrix3();
  if (!text) return m;
  const re = /(translate|scale|matrix)\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const n = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    const t = new THREE.Matrix3();
    if (match[1] === "translate") t.set(1, 0, n[0] ?? 0, 0, 1, n[1] ?? 0, 0, 0, 1);
    else if (match[1] === "scale") t.set(n[0] ?? 1, 0, 0, 0, n[1] ?? n[0] ?? 1, 0, 0, 0, 1);
    else t.set(n[0], n[2], n[4], n[1], n[3], n[5], 0, 0, 1);
    m.multiply(t);
  }
  return m;
}

/**
 * An SVG path's `d` into a ShapePath, through `m`. Covers the commands
 * MathJax's fonts use (M L H V Q T C S Z), absolute and relative.
 */
function pathToShapePath(d: string, m: THREE.Matrix3): THREE.ShapePath {
  const sp = new THREE.ShapePath();
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const v = new THREE.Vector2();
  const at = (x: number, y: number) => v.set(x, y).applyMatrix3(m).clone();
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, prev = "";
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === "Z") {
      sp.currentPath?.closePath();
      x = sx; y = sy;
      prev = C;
      continue;
    }
    if (C === "M") {
      x = ox + num(); y = oy + num(); sx = x; sy = y;
      const p = at(x, y); sp.moveTo(p.x, p.y);
      cmd = rel ? "l" : "L"; // further pairs are line-tos
    } else if (C === "L") {
      x = ox + num(); y = oy + num();
      const p = at(x, y); sp.lineTo(p.x, p.y);
    } else if (C === "H") {
      x = ox + num();
      const p = at(x, y); sp.lineTo(p.x, p.y);
    } else if (C === "V") {
      y = oy + num();
      const p = at(x, y); sp.lineTo(p.x, p.y);
    } else if (C === "Q" || C === "T") {
      if (C === "Q") { cx = ox + num(); cy = oy + num(); }
      else if (prev === "Q" || prev === "T") { cx = 2 * x - cx; cy = 2 * y - cy; }
      else { cx = x; cy = y; }
      x = ox + num(); y = oy + num();
      const c = at(cx, cy), p = at(x, y);
      sp.quadraticCurveTo(c.x, c.y, p.x, p.y);
    } else if (C === "C" || C === "S") {
      let c1x: number, c1y: number;
      if (C === "C") { c1x = ox + num(); c1y = oy + num(); }
      else if (prev === "C" || prev === "S") { c1x = 2 * x - cx; c1y = 2 * y - cy; }
      else { c1x = x; c1y = y; }
      cx = ox + num(); cy = oy + num();
      x = ox + num(); y = oy + num();
      const a = at(c1x, c1y), b = at(cx, cy), p = at(x, y);
      sp.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
    } else {
      i++; // a command we do not draw; skip its number
    }
    prev = C;
  }
  return sp;
}

function shapesOf(sp: THREE.ShapePath): THREE.Shape[] {
  (sp as unknown as { userData: unknown }).userData = { style: { fillRule: "nonzero" } };
  return SVGLoader.createShapes(sp as Parameters<typeof SVGLoader.createShapes>[0]);
}

function boxOf(shapes: THREE.Shape[]) {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const s of shapes) {
    for (const p of s.getPoints(4)) {
      box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x);
      box.minY = Math.min(box.minY, p.y); box.maxY = Math.max(box.maxY, p.y);
    }
  }
  return box;
}

const cache = new Map<string, Typeset>();

/** Typesets `tex` (display style unless `inline`), cached by formula. */
export function typeset(tex: string, inline = false): Typeset {
  const key = `${inline ? "i" : "d"}|${tex}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { adaptor, doc } = mathjaxEngine();
  const glyphs: Glyph[] = [];
  let error: string | undefined;
  const root = doc.convert(tex, { display: !inline }) as LiteNode;
  const a = adaptor as unknown as {
    kind(n: LiteNode): string;
    childNodes(n: LiteNode): LiteNode[];
    getAttribute(n: LiteNode, name: string): string | null;
  };

  // MathJax's units are 1/1000 em, and its output is SVG, y down (its own
  // scale(1,-1) only undoes the fonts' y-up): divide out the units and flip
  // back to y up at the root.
  const walk = (node: LiteNode, parent: THREE.Matrix3) => {
    const kind = a.kind(node);
    if (kind === "#text" || kind === "#comment") return;
    if (a.getAttribute(node, "data-mml-node") === "merror") {
      error = a.getAttribute(node, "data-mjx-error") ?? "TeX error";
    }
    const m = parent.clone().multiply(parseTransform(a.getAttribute(node, "transform")));
    if (kind === "path") {
      const d = a.getAttribute(node, "d");
      if (d) {
        const shapes = shapesOf(pathToShapePath(d, m));
        const code = a.getAttribute(node, "data-c");
        if (shapes.length) glyphs.push({ char: code ? String.fromCodePoint(parseInt(code, 16)) : "?", shapes, box: boxOf(shapes) });
      }
    } else if (kind === "rect") {
      const x = Number(a.getAttribute(node, "x") ?? 0), y = Number(a.getAttribute(node, "y") ?? 0);
      const w = Number(a.getAttribute(node, "width") ?? 0), h = Number(a.getAttribute(node, "height") ?? 0);
      const sp = new THREE.ShapePath();
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => new THREE.Vector2(px, py).applyMatrix3(m));
      sp.moveTo(corners[0].x, corners[0].y);
      for (const c of corners.slice(1)) sp.lineTo(c.x, c.y);
      sp.currentPath?.closePath();
      const shapes = shapesOf(sp);
      if (shapes.length) glyphs.push({ char: "rule", shapes, box: boxOf(shapes) });
    }
    for (const child of a.childNodes(node)) walk(child, m);
  };
  walk(root, new THREE.Matrix3().makeScale(1 / 1000, -1 / 1000));

  const result: Typeset = error
    ? { glyphs: [], box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, error }
    : {
        glyphs,
        box: glyphs.reduce(
          (b, g) => ({ minX: Math.min(b.minX, g.box.minX), maxX: Math.max(b.maxX, g.box.maxX), minY: Math.min(b.minY, g.box.minY), maxY: Math.max(b.maxY, g.box.maxY) }),
          { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
        ),
      };
  if (!result.error && !glyphs.length) result.box = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}
