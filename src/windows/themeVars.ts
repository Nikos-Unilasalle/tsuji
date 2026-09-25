import { useEffect } from "react";

/**
 * Reads the interface palette from CSS, for the places that cannot use it
 * directly.
 *
 * Anything drawn in CSS just writes `var(--chrome-border)`. A canvas cannot:
 * `ctx.strokeStyle` takes a colour, not a custom property. Without this, a
 * widget that paints itself would be the one piece of the interface a theme
 * cannot repaint — which is exactly the bug hardcoded colours cause.
 *
 * Values are read at draw time rather than cached, so switching theme and
 * redrawing is enough to pick up the new palette; see themeStore.ts for the
 * variables that exist.
 */

export type ThemeVarName =
  | "--chrome-bg"
  | "--chrome-surface"
  | "--chrome-surface-raised"
  | "--chrome-border"
  | "--chrome-pill-bg"
  | "--chrome-text"
  | "--chrome-text-muted"
  | "--canvas-bg"
  | "--canvas-node"
  | "--canvas-node-raised"
  | "--accent-color"
  | "--danger-color";

/** One palette entry, or the fallback when there is no document to read. */
export function themeVar(name: ThemeVarName, fallback: string, element?: Element | null): string {
  if (typeof window === "undefined" || typeof getComputedStyle === "undefined") return fallback;
  const target = element ?? document.documentElement;
  const value = getComputedStyle(target).getPropertyValue(name).trim();
  return value || fallback;
}

/** Parses `#rgb`, `#rrggbb` or `rgb()/rgba()` into 0-255 components. */
export function parseCssColor(color: string): [number, number, number] {
  const value = color.trim();

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    return [
      parseInt(full.slice(0, 2), 16) || 0,
      parseInt(full.slice(2, 4), 16) || 0,
      parseInt(full.slice(4, 6), 16) || 0,
    ];
  }

  const parts = value.match(/-?[\d.]+/g);
  if (parts && parts.length >= 3) {
    return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
  }
  return [0, 0, 0];
}

/**
 * A palette entry at partial opacity.
 *
 * Canvas overlays need "the border colour at 20%" constantly, and writing
 * `rgba(255,255,255,0.2)` for it is how a widget stops following the theme.
 */
export function themeVarAlpha(
  name: ThemeVarName,
  alpha: number,
  fallback: string,
  element?: Element | null,
): string {
  const [r, g, b] = parseCssColor(themeVar(name, fallback, element));
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** Re-runs a canvas `draw` when the theme changes — a canvas keeps whatever colours it was last painted with. */
export function useRedrawOnThemeChange(draw: () => void): void {
  useEffect(() => {
    window.addEventListener("tsuji-theme-colors-changed", draw);
    return () => window.removeEventListener("tsuji-theme-colors-changed", draw);
  }, [draw]);
}
