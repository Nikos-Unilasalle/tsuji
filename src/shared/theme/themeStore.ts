/**
 * Interface theme definition and manager for Tsuji.
 * Controls CSS variables across the entire application chrome and canvas.
 */

export interface ThemeColors {
  // Chrome
  chromeBg: string;
  chromeSurface: string;
  chromeSurfaceRaised: string;
  chromeBorder: string;
  chromeText: string;
  chromeTextMuted: string;
  // Canvas / Graph
  canvasBg: string;
  canvasNodeList: string;
  canvasSceneBg: string;
  canvasSceneActive: string;
  canvasNode: string;
  canvasNodeRaised: string;
  // Accent & Highlights
  accentColor: string;
  // 3D Viewport
  viewportBgTop: string;
  viewportBgBottom: string;
  viewportGrid: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  isPreset?: boolean;
  colors: ThemeColors;
}

export const PRESET_THEMES: ThemeDefinition[] = [
  {
    id: "tsuji-slate",
    name: "Tsuji Slate (Default)",
    isPreset: true,
    colors: {
      chromeBg: "#2f3641",
      chromeSurface: "#3b434f",
      chromeSurfaceRaised: "#47505d",
      chromeBorder: "#5a6472",
      chromeText: "#eef2f6",
      chromeTextMuted: "#b3bdc9",
      canvasBg: "#3c4552",
      canvasNodeList: "#353d49",
      canvasSceneBg: "#343d4a",
      canvasSceneActive: "#38bdf8",
      canvasNode: "#4c5561",
      canvasNodeRaised: "#58626f",
      accentColor: "#38bdf8",
      viewportBgTop: "#39424f",
      viewportBgBottom: "#59636f",
      viewportGrid: "#6a7482",
    },
  },
  {
    id: "blender-dark",
    name: "Blender Charcoal",
    isPreset: true,
    colors: {
      chromeBg: "#242424",
      chromeSurface: "#2d2d2d",
      chromeSurfaceRaised: "#3a3a3a",
      chromeBorder: "#454545",
      chromeText: "#f0f0f0",
      chromeTextMuted: "#9e9e9e",
      canvasBg: "#2b2b2b",
      canvasNodeList: "#262626",
      canvasSceneBg: "#252525",
      canvasSceneActive: "#47a2f5",
      canvasNode: "#363636",
      canvasNodeRaised: "#444444",
      accentColor: "#47a2f5",
      viewportBgTop: "#303030",
      viewportBgBottom: "#474747",
      viewportGrid: "#505050",
    },
  },
  {
    id: "midnight-abyss",
    name: "Midnight Abyss",
    isPreset: true,
    colors: {
      chromeBg: "#10141d",
      chromeSurface: "#18202d",
      chromeSurfaceRaised: "#222c3e",
      chromeBorder: "#2d3a52",
      chromeText: "#e8effc",
      chromeTextMuted: "#8da0c0",
      canvasBg: "#151b26",
      canvasNodeList: "#121721",
      canvasSceneBg: "#141a24",
      canvasSceneActive: "#38bdf8",
      canvasNode: "#1e2736",
      canvasNodeRaised: "#293549",
      accentColor: "#38bdf8",
      viewportBgTop: "#131a28",
      viewportBgBottom: "#202c40",
      viewportGrid: "#2e3f5b",
    },
  },
  {
    id: "nordic-frost",
    name: "Nordic Frost",
    isPreset: true,
    colors: {
      chromeBg: "#28303d",
      chromeSurface: "#333d4e",
      chromeSurfaceRaised: "#404c60",
      chromeBorder: "#526078",
      chromeText: "#eaf0f8",
      chromeTextMuted: "#a0afc4",
      canvasBg: "#2e3745",
      canvasNodeList: "#29313e",
      canvasSceneBg: "#2b3442",
      canvasSceneActive: "#67e8f9",
      canvasNode: "#3c4759",
      canvasNodeRaised: "#4a576d",
      accentColor: "#67e8f9",
      viewportBgTop: "#2d3848",
      viewportBgBottom: "#414e62",
      viewportGrid: "#566882",
    },
  },
  {
    id: "oled-minimal",
    name: "OLED Minimal",
    isPreset: true,
    colors: {
      chromeBg: "#0c0d0f",
      chromeSurface: "#16181c",
      chromeSurfaceRaised: "#23262b",
      chromeBorder: "#343840",
      chromeText: "#f4f4f5",
      chromeTextMuted: "#9ca3af",
      canvasBg: "#121316",
      canvasNodeList: "#0e0f12",
      canvasSceneBg: "#111215",
      canvasSceneActive: "#38bdf8",
      canvasNode: "#1c1e24",
      canvasNodeRaised: "#292c34",
      accentColor: "#38bdf8",
      viewportBgTop: "#111215",
      viewportBgBottom: "#1f2228",
      viewportGrid: "#31353e",
    },
  },
  {
    id: "london-parchment",
    name: "London Parchment",
    isPreset: true,
    colors: {
      chromeBg: "#ece8e1",
      chromeSurface: "#f5f2eb",
      chromeSurfaceRaised: "#ffffff",
      chromeBorder: "#d5cfc4",
      chromeText: "#2d3238",
      chromeTextMuted: "#767b83",
      canvasBg: "#e0dbd1",
      canvasNodeList: "#e5e0d6",
      canvasSceneBg: "#e4dfd5",
      canvasSceneActive: "#38b8ce",
      canvasNode: "#f8f6f0",
      canvasNodeRaised: "#eae5db",
      accentColor: "#38b8ce",
      viewportBgTop: "#e2ded4",
      viewportBgBottom: "#f2efe7",
      viewportGrid: "#c5bfb2",
    },
  },
];

const STORAGE_KEY_ACTIVE = "tsuji_active_theme";
const STORAGE_KEY_CUSTOM = "tsuji_custom_themes";
const STORAGE_KEY_CURRENT_COLORS = "tsuji_current_colors";

/**
 * Ensures all required color keys exist, filling missing ones with default preset colors.
 */
export function normalizeThemeColors(colors: Partial<ThemeColors> | undefined): ThemeColors {
  const fallback = PRESET_THEMES[0].colors;
  if (!colors) return { ...fallback };
  return {
    chromeBg: colors.chromeBg || fallback.chromeBg,
    chromeSurface: colors.chromeSurface || fallback.chromeSurface,
    chromeSurfaceRaised: colors.chromeSurfaceRaised || fallback.chromeSurfaceRaised,
    chromeBorder: colors.chromeBorder || fallback.chromeBorder,
    chromeText: colors.chromeText || fallback.chromeText,
    chromeTextMuted: colors.chromeTextMuted || fallback.chromeTextMuted,
    canvasBg: colors.canvasBg || fallback.canvasBg,
    canvasNodeList: colors.canvasNodeList || colors.canvasBg || fallback.canvasNodeList || fallback.canvasBg,
    canvasSceneBg: colors.canvasSceneBg || colors.chromeSurface || fallback.canvasSceneBg || fallback.chromeSurface,
    canvasSceneActive: colors.canvasSceneActive || colors.accentColor || fallback.canvasSceneActive || fallback.accentColor,
    canvasNode: colors.canvasNode || fallback.canvasNode,
    canvasNodeRaised: colors.canvasNodeRaised || fallback.canvasNodeRaised,
    accentColor: colors.accentColor || fallback.accentColor,
    viewportBgTop: colors.viewportBgTop || fallback.viewportBgTop,
    viewportBgBottom: colors.viewportBgBottom || fallback.viewportBgBottom,
    viewportGrid: colors.viewportGrid || fallback.viewportGrid,
  };
}

/**
 * Retrieve current applied colors from localStorage, or fallback to active theme colors.
 */
export function getCurrentColors(): ThemeColors {
  if (typeof localStorage === "undefined") return PRESET_THEMES[0].colors;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CURRENT_COLORS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed) return normalizeThemeColors(parsed);
    }
  } catch {
    // fallback
  }
  return getActiveTheme().colors;
}

/**
 * Apply the given theme colors as CSS root variables in the document, persist to localStorage, and dispatch window event.
 */
export function applyThemeColors(colors: ThemeColors): void {
  const normalized = normalizeThemeColors(colors);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY_CURRENT_COLORS, JSON.stringify(normalized));
    } catch (err) {
      console.warn("Failed to persist current colors to localStorage", err);
    }
  }

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.style.setProperty("--chrome-bg", normalized.chromeBg);
    root.style.setProperty("--chrome-surface", normalized.chromeSurface);
    root.style.setProperty("--chrome-surface-raised", normalized.chromeSurfaceRaised);
    root.style.setProperty("--chrome-border", normalized.chromeBorder);
    root.style.setProperty("--chrome-text", normalized.chromeText);
    root.style.setProperty("--chrome-text-muted", normalized.chromeTextMuted);
    root.style.setProperty("--canvas-bg", normalized.canvasBg);
    root.style.setProperty("--canvas-node-list", normalized.canvasNodeList);
    root.style.setProperty("--canvas-scene-bg", normalized.canvasSceneBg);
    root.style.setProperty("--canvas-scene-active", normalized.canvasSceneActive);
    root.style.setProperty("--canvas-node", normalized.canvasNode);
    root.style.setProperty("--canvas-node-raised", normalized.canvasNodeRaised);
    root.style.setProperty("--canvas-text", normalized.chromeText);
    root.style.setProperty("--canvas-text-muted", normalized.chromeTextMuted);
    root.style.setProperty("--canvas-dot", normalized.chromeBorder);
    root.style.setProperty("--accent-color", normalized.accentColor);
    root.style.setProperty("--viewport-bg-top", normalized.viewportBgTop);
    root.style.setProperty("--viewport-bg-bottom", normalized.viewportBgBottom);
    root.style.setProperty("--viewport-grid", normalized.viewportGrid);
  }

  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("tsuji-theme-colors-changed", { detail: normalized }));
  }
}

/**
 * Load all custom themes from localStorage.
 */
export function loadCustomThemes(): ThemeDefinition[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CUSTOM);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t: ThemeDefinition) => ({
      ...t,
      colors: normalizeThemeColors(t.colors),
    }));
  } catch {
    return [];
  }
}

/**
 * Save custom themes list to localStorage.
 */
export function saveCustomThemes(themes: ThemeDefinition[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY_CUSTOM, JSON.stringify(themes));
  } catch (err) {
    console.warn("Failed to persist custom themes to localStorage", err);
  }
}

/**
 * Get all available themes (presets + saved custom themes).
 */
export function getAllThemes(): ThemeDefinition[] {
  return [...PRESET_THEMES, ...loadCustomThemes()];
}

/**
 * Get active theme from localStorage or fallback to default preset.
 */
export function getActiveTheme(): ThemeDefinition {
  if (typeof localStorage === "undefined") return PRESET_THEMES[0];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ACTIVE);
    if (raw) {
      const parsed = JSON.parse(raw) as ThemeDefinition;
      if (parsed && parsed.colors) {
        return {
          ...parsed,
          colors: normalizeThemeColors(parsed.colors),
        };
      }
    }
  } catch {
    // fallback
  }
  return PRESET_THEMES[0];
}

/**
 * Set active theme, apply CSS variables and persist to localStorage.
 */
export function setActiveTheme(theme: ThemeDefinition): void {
  const normalizedTheme: ThemeDefinition = {
    ...theme,
    colors: normalizeThemeColors(theme.colors),
  };
  applyThemeColors(normalizedTheme.colors);
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY_ACTIVE, JSON.stringify(normalizedTheme));
  } catch (err) {
    console.warn("Failed to persist active theme to localStorage", err);
  }
}

/**
 * Save a new custom theme or update existing one by ID.
 */
export function saveCustomTheme(theme: ThemeDefinition): ThemeDefinition[] {
  const custom = loadCustomThemes();
  const normalizedTheme: ThemeDefinition = {
    ...theme,
    isPreset: false,
    colors: normalizeThemeColors(theme.colors),
  };
  const index = custom.findIndex((t) => t.id === theme.id);
  let updated: ThemeDefinition[];
  if (index >= 0) {
    updated = [...custom];
    updated[index] = normalizedTheme;
  } else {
    updated = [...custom, normalizedTheme];
  }
  saveCustomThemes(updated);
  setActiveTheme(normalizedTheme);
  return updated;
}

/**
 * Delete a custom theme by ID.
 */
export function deleteCustomTheme(id: string): ThemeDefinition[] {
  const custom = loadCustomThemes();
  const updated = custom.filter((t) => t.id !== id);
  saveCustomThemes(updated);
  const active = getActiveTheme();
  if (active.id === id) {
    setActiveTheme(PRESET_THEMES[0]);
  }
  return updated;
}

/**
 * Export a theme definition as a downloadable JSON string.
 */
export function exportThemeToJSON(theme: ThemeDefinition): string {
  return JSON.stringify(
    {
      format: "tsuji-theme",
      version: 1,
      theme: {
        id: theme.id,
        name: theme.name,
        colors: normalizeThemeColors(theme.colors),
      },
    },
    null,
    2
  );
}

/**
 * Parse an imported JSON string into a ThemeDefinition.
 */
export function importThemeFromJSON(jsonText: string): ThemeDefinition {
  const parsed = JSON.parse(jsonText);
  const candidate = parsed.theme ?? parsed;
  if (!candidate || !candidate.colors || typeof candidate.colors !== "object") {
    throw new Error("Invalid theme format: missing colors object.");
  }
  const colors = normalizeThemeColors(candidate.colors as Partial<ThemeColors>);

  return {
    id: candidate.id && !candidate.id.startsWith("tsuji-") ? candidate.id : `custom-${Date.now()}`,
    name: candidate.name || "Imported Theme",
    isPreset: false,
    colors,
  };
}

/**
 * Initialize theme at application start.
 */
export function initTheme(): ThemeDefinition {
  const theme = getActiveTheme();
  const colors = getCurrentColors();
  applyThemeColors(colors);
  return {
    ...theme,
    colors,
  };
}
