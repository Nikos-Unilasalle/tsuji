import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PRESET_THEMES,
  applyThemeColors,
  loadCustomThemes,
  getAllThemes,
  getActiveTheme,
  setActiveTheme,
  saveCustomTheme,
  deleteCustomTheme,
  exportThemeToJSON,
  importThemeFromJSON,
  ThemeDefinition,
} from "./themeStore";

function installMocks() {
  const store = new Map<string, string>();
  const localStorageMock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };

  const cssProperties = new Map<string, string>();
  const documentMock = {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => cssProperties.set(k, v),
        getPropertyValue: (k: string) => cssProperties.get(k) ?? "",
        cssText: "",
      },
    },
  };

  const listeners = new Map<string, Set<(e: any) => void>>();
  const windowMock = {
    localStorage: localStorageMock,
    addEventListener: (type: string, cb: (e: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: (e: any) => void) => {
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent: (event: any) => {
      const set = listeners.get(event.type);
      if (set) {
        set.forEach((cb) => cb(event));
      }
      return true;
    },
  };

  vi.stubGlobal("localStorage", localStorageMock);
  vi.stubGlobal("window", windowMock);
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("CustomEvent", class {
    type: string;
    detail: any;
    constructor(type: string, init?: { detail?: any }) {
      this.type = type;
      this.detail = init?.detail;
    }
  });

  return { store, cssProperties, listeners };
}

describe("themeStore", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  it("applies theme colors to CSS variables and dispatches window event", () => {
    let dispatchedEvent: CustomEvent | null = null;
    window.addEventListener("tsuji-theme-colors-changed", (e) => {
      dispatchedEvent = e as CustomEvent;
    });

    const preset = PRESET_THEMES[0];
    applyThemeColors(preset.colors);
    expect(mocks.cssProperties.get("--chrome-bg")).toBe(preset.colors.chromeBg);
    expect(mocks.cssProperties.get("--accent-color")).toBe(preset.colors.accentColor);
    expect(mocks.cssProperties.get("--viewport-bg-top")).toBe(preset.colors.viewportBgTop);
    expect(mocks.cssProperties.get("--viewport-bg-bottom")).toBe(preset.colors.viewportBgBottom);
    expect(mocks.cssProperties.get("--viewport-grid")).toBe(preset.colors.viewportGrid);
    expect(dispatchedEvent).not.toBeNull();
    expect(dispatchedEvent!.detail.viewportBgTop).toBe(preset.colors.viewportBgTop);
  });

  it("loads presets by default and can switch active theme", () => {
    const all = getAllThemes();
    expect(all.length).toBeGreaterThanOrEqual(PRESET_THEMES.length);
    expect(getActiveTheme().id).toBe("tsuji-slate");

    setActiveTheme(PRESET_THEMES[1]);
    expect(getActiveTheme().id).toBe(PRESET_THEMES[1].id);
    expect(mocks.cssProperties.get("--chrome-bg")).toBe(PRESET_THEMES[1].colors.chromeBg);
    expect(mocks.cssProperties.get("--viewport-bg-top")).toBe(PRESET_THEMES[1].colors.viewportBgTop);
  });

  it("saves and activates a custom theme", () => {
    const custom: ThemeDefinition = {
      id: "custom-test",
      name: "My Custom Theme",
      colors: {
        ...PRESET_THEMES[0].colors,
        accentColor: "#ff0077",
        viewportBgTop: "#123456",
      },
    };
    saveCustomTheme(custom);

    const active = getActiveTheme();
    expect(active.id).toBe("custom-test");
    expect(active.name).toBe("My Custom Theme");
    expect(mocks.cssProperties.get("--accent-color")).toBe("#ff0077");
    expect(mocks.cssProperties.get("--viewport-bg-top")).toBe("#123456");

    const customList = loadCustomThemes();
    expect(customList.some((t) => t.id === "custom-test")).toBe(true);
  });

  it("deletes a custom theme and falls back to default preset if active", () => {
    const custom: ThemeDefinition = {
      id: "custom-to-delete",
      name: "To Delete",
      colors: PRESET_THEMES[0].colors,
    };
    saveCustomTheme(custom);
    expect(getActiveTheme().id).toBe("custom-to-delete");

    deleteCustomTheme("custom-to-delete");
    expect(loadCustomThemes().some((t) => t.id === "custom-to-delete")).toBe(false);
    expect(getActiveTheme().id).toBe("tsuji-slate");
  });

  it("exports and imports theme JSON", () => {
    const theme = PRESET_THEMES[1];
    const json = exportThemeToJSON(theme);
    expect(json).toContain("tsuji-theme");

    const imported = importThemeFromJSON(json);
    expect(imported.colors.chromeBg).toBe(theme.colors.chromeBg);
    expect(imported.colors.accentColor).toBe(theme.colors.accentColor);
    expect(imported.colors.viewportBgTop).toBe(theme.colors.viewportBgTop);
    expect(imported.colors.viewportGrid).toBe(theme.colors.viewportGrid);
  });
});
