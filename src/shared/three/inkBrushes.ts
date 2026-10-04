import * as brush from "p5.brush/standalone";
import type { TipSurface } from "p5.brush/standalone";

/**
 * Chinese ink brushes (毛笔) for p5.brush, registered on the engine next to
 * its built-in pencils and markers.
 *
 * A calligraphy brush is a cone of hair: pressed down it spreads into a wide
 * mark, lifted it narrows to a point, and the hair leaves faint streaks along
 * the direction of travel — solid where the brush is loaded, broken into the
 * white streaks of "flying white" (飞白) where it runs dry. So the tip is
 * drawn as a soft ellipse of individual bristles lying along the stroke, and
 * turns with it ("natural" rotation), which keeps each bristle's streak
 * running the length of the mark.
 *
 * The brushes press with the stroke's own pressure only — a Grease Pencil
 * stroke's, or one read off a font's outline — instead of p5.brush's
 * simulated pressure curve, which would put a second, random swell on top of
 * a calligrapher's. And the soft blob p5.brush adds where a stroke starts and
 * ends is off: a brush lands and lifts with the pressure it is given.
 */

export const INK_BRUSH_NAMES = ["sumi", "sumi-dry"] as const;

/** Deterministic, so a tip is the same every session — the drawing must not change on reload. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface BristleTip {
  /** Darkness (0-1) of the body the bristles lie on; 0 for none. */
  body: number;
  bristles: number;
  /** Fraction of bristles carrying no ink — the white streaks. */
  gaps: number;
  seed: number;
}

/**
 * The tip as p5.brush reads it: dark is ink, white is paper. Drawn straight on
 * the surface's 2D context, already centred and scaled to ±50 units, with x
 * along the direction of travel.
 */
function bristleTip(o: BristleTip): (surface: TipSurface) => void {
  return (surface) => {
    const ctx = surface.drawingContext;
    const rand = lcg(o.seed);
    const halfAlong = 26;
    const halfAcross = 47;
    if (o.body > 0) {
      const v = Math.round(255 * (1 - o.body));
      ctx.fillStyle = `rgb(${v} ${v} ${v})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, halfAlong, halfAcross, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineCap = "round";
    for (let i = 0; i < o.bristles; i++) {
      const y = -halfAcross + (2 * halfAcross * (i + rand())) / o.bristles;
      if (rand() < o.gaps) continue;
      const reach = halfAlong * Math.sqrt(Math.max(0, 1 - (y / halfAcross) ** 2));
      const v = Math.round(255 * (0.15 * rand()));
      ctx.strokeStyle = `rgb(${v} ${v} ${v})`;
      ctx.lineWidth = 0.6 + rand() * 1.4;
      ctx.beginPath();
      ctx.moveTo(-reach * (0.7 + 0.3 * rand()), y);
      ctx.lineTo(reach * (0.7 + 0.3 * rand()), y + (rand() - 0.5) * 2);
      ctx.stroke();
    }
  };
}

/** Constant pressure: the stroke's own is the only pressure. */
const OWN_PRESSURE = [1, 1];

export function registerInkBrushes(): void {
  // Same weight unit as the built-in marker, so Stroke Weight reads the same.
  brush.add("sumi", {
    type: "custom",
    weight: 2,
    scatter: 0.02,
    opacity: 7,
    spacing: 0.08,
    pressure: OWN_PRESSURE,
    tip: bristleTip({ body: 0.4, bristles: 70, gaps: 0.12, seed: 7 }),
    rotate: "natural",
    markerTip: false,
    noise: 0.25,
  });
  brush.add("sumi-dry", {
    type: "custom",
    weight: 2,
    scatter: 0.03,
    opacity: 30,
    spacing: 0.12,
    pressure: OWN_PRESSURE,
    tip: bristleTip({ body: 0, bristles: 46, gaps: 0.35, seed: 11 }),
    rotate: "natural",
    markerTip: false,
    noise: 0.4,
  });
}
