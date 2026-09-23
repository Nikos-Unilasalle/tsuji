import { describe, expect, it } from "vitest";
import { parseCssColor, themeVar, themeVarAlpha } from "./themeVars";

describe("parseCssColor", () => {
  it("reads the hex forms a palette can hold", () => {
    expect(parseCssColor("#38bdf8")).toEqual([56, 189, 248]);
    expect(parseCssColor("#fff")).toEqual([255, 255, 255]);
    expect(parseCssColor("  #000000  ")).toEqual([0, 0, 0]);
  });

  it("reads rgb() and rgba(), which is what getComputedStyle usually returns", () => {
    expect(parseCssColor("rgb(56, 189, 248)")).toEqual([56, 189, 248]);
    expect(parseCssColor("rgba(56, 189, 248, 0.5)")).toEqual([56, 189, 248]);
  });

  it("degrades to black rather than throwing on something unparseable", () => {
    expect(parseCssColor("transparent")).toEqual([0, 0, 0]);
    expect(parseCssColor("")).toEqual([0, 0, 0]);
  });
});

describe("themeVar", () => {
  it("falls back when there is no document to read the palette from", () => {
    // Headless: the fallback is the default theme's own value, not a second
    // palette — see the note in topography-bands-editor.css.
    expect(themeVar("--accent-color", "#38bdf8")).toBe("#38bdf8");
  });
});

describe("themeVarAlpha", () => {
  it("returns the palette entry at the requested opacity", () => {
    expect(themeVarAlpha("--chrome-text", 0.25, "#eef2f6")).toBe("rgba(238, 242, 246, 0.25)");
  });

  it("clamps the opacity", () => {
    expect(themeVarAlpha("--chrome-text", 5, "#000")).toBe("rgba(0, 0, 0, 1)");
    expect(themeVarAlpha("--chrome-text", -2, "#000")).toBe("rgba(0, 0, 0, 0)");
  });
});
