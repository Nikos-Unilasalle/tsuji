import { describe, expect, it } from "vitest";
import { NodeInstance, ParamFieldDef } from "../types";
import {
  TEXTURE_HEIGHT_SLOPE_MIX_NODE,
  TOPOGRAPHY_BAKE_ACTION,
  TOPOGRAPHY_PRESETS,
  TOPOGRAPHY_PRESET_ACTION_PREFIX,
} from "./textureHeightSlopeMix";
import { TEXTURE_MIX_PAINT_NODE } from "./textureMixPaint";
import { LAYER_DEFAULT_NAMES, layerName, layerNames } from "../../three/layeredTexture";

function instance(type: string, params: Record<string, unknown>): NodeInstance {
  return { id: "n1", type, position: { x: 0, y: 0 }, params } as NodeInstance;
}

function fieldsOf(def: typeof TEXTURE_MIX_PAINT_NODE, params: Record<string, unknown>): ParamFieldDef[] {
  return def.dynamicParamFields!(instance(def.type, { ...def.defaultParams, ...params }));
}

function field(fields: ParamFieldDef[], id: string): ParamFieldDef | undefined {
  return fields.find((f) => f.id === id);
}

describe("layer names", () => {
  it("falls back to a readable default per slot", () => {
    expect(layerName({}, 0)).toBe(LAYER_DEFAULT_NAMES[0]);
    expect(layerName({}, 2)).toBe(LAYER_DEFAULT_NAMES[2]);
    expect(layerName({}, 99)).toBe("Layer 100");
  });

  it("prefers a name the artist typed, ignoring blanks", () => {
    expect(layerName({ layerName1: "Mossy rock" }, 1)).toBe("Mossy rock");
    expect(layerName({ layerName1: "   " }, 1)).toBe(LAYER_DEFAULT_NAMES[1]);
  });

  it("lists a whole stack", () => {
    expect(layerNames({ layerName0: "Path" }, 3)).toEqual(["Path", LAYER_DEFAULT_NAMES[1], LAYER_DEFAULT_NAMES[2]]);
  });
});

describe("Texture Mix param panel", () => {
  it("labels the active-layer picker with names while storing indices", () => {
    const fields = fieldsOf(TEXTURE_MIX_PAINT_NODE, { layerName0: "Path", layerName1: "Grass" });
    const picker = field(fields, "activeLayer");

    expect(picker?.kind).toBe("select");
    const sel = picker as ParamFieldDef & { kind: "select" };
    // The stored value stays the index the weight buffer is keyed by.
    expect(sel.options[0]).toBe("0");
    expect(sel.optionLabels?.[0]).toBe("Path");
    expect(sel.optionLabels?.[1]).toBe("Grass");
  });

  it("gives every layer a name and a tiling control in one group", () => {
    const fields = fieldsOf(TEXTURE_MIX_PAINT_NODE, {});
    expect(field(fields, "layerName0")?.kind).toBe("text");
    expect(field(fields, "uvScale0")?.kind).toBe("number");
    expect(field(fields, "layerName0")?.group).toBe("Layers");
    expect(field(fields, "uvScale0")?.group).toBe("Layers");
  });

  it("grows the layer controls with the wired sockets", () => {
    const fields = fieldsOf(TEXTURE_MIX_PAINT_NODE, { uvScale4: 1, uvScale5: 1 });
    expect(field(fields, "layerName5")).toBeDefined();
    const sel = field(fields, "activeLayer") as ParamFieldDef & { kind: "select" };
    expect(sel.options).toHaveLength(6);
  });
});

describe("Topography param panel", () => {
  it("drives the altitude and steepness rules from one visual control", () => {
    const fields = fieldsOf(TEXTURE_HEIGHT_SLOPE_MIX_NODE, {});
    expect(field(fields, "bands")?.kind).toBe("topography_bands");
    expect(field(fields, "bands")?.group).toBe("Rules");
  });

  it("no longer asks for the thresholds as bare numbers", () => {
    const fields = fieldsOf(TEXTURE_HEIGHT_SLOPE_MIX_NODE, {});
    // These are handles on the bar and the dial now; a panel that showed both
    // would be two sources of truth for the same rule.
    for (const id of [
      "slopeAngle",
      "slopeBlend",
      "snowHeight",
      "snowBlend",
      "shoreHeight",
      "shoreBlend",
      "baseLayer",
      "slopeLayer",
      "snowLayer",
      "shoreLayer",
    ]) {
      expect(field(fields, id), `${id} should live in the visual editor`).toBeUndefined();
    }
  });

  it("shows the break-up amount as a percentage", () => {
    const fields = fieldsOf(TEXTURE_HEIGHT_SLOPE_MIX_NODE, {});
    const noise = field(fields, "noiseAmount") as ParamFieldDef & { kind: "number" };
    expect(noise.kind).toBe("number");
    expect(noise.percent).toBe(true);
  });

  it("exposes the presets and the bake handoff as buttons", () => {
    const fields = fieldsOf(TEXTURE_HEIGHT_SLOPE_MIX_NODE, {});
    const buttons = fields.filter((f) => f.kind === "button") as (ParamFieldDef & { kind: "button" })[];
    const actions = buttons.map((b) => b.action);

    for (const preset of Object.keys(TOPOGRAPHY_PRESETS)) {
      expect(actions).toContain(TOPOGRAPHY_PRESET_ACTION_PREFIX + preset);
    }
    expect(actions).toContain(TOPOGRAPHY_BAKE_ACTION);
  });

  it("keeps a preset editable rather than turning it into a mode", () => {
    // What a preset writes lands in the visual editor sitting right below it,
    // where every threshold is still a handle the artist can move.
    const fields = fieldsOf(TEXTURE_HEIGHT_SLOPE_MIX_NODE, {});
    const order = fields.map((f) => f.id);
    expect(order.indexOf("bands")).toBeGreaterThan(order.indexOf("presetAlpine"));
  });
});

describe("Topography presets", () => {
  it("write a coherent set of thresholds each", () => {
    for (const [name, preset] of Object.entries(TOPOGRAPHY_PRESETS)) {
      expect(preset.slopeAngle, name).toBeGreaterThan(0);
      expect(preset.slopeAngle, name).toBeLessThan(90);
      expect(preset.slopeBlend, name).toBeGreaterThan(0);
      expect(preset.noiseAmount, name).toBeGreaterThanOrEqual(0);
      expect(preset.noiseAmount, name).toBeLessThanOrEqual(1);
      expect(preset.shoreHeight, name).toBeLessThan(preset.snowHeight);
    }
  });

  it("only touches rule params, never layer wiring or resolution", () => {
    const allowed = new Set([
      "slopeAngle",
      "slopeBlend",
      "snowHeight",
      "snowBlend",
      "shoreHeight",
      "shoreBlend",
      "shoreLayer",
      "noiseAmount",
      "noiseFrequency",
    ]);
    for (const [name, preset] of Object.entries(TOPOGRAPHY_PRESETS)) {
      for (const key of Object.keys(preset)) {
        expect(allowed.has(key), `${name} must not rewrite ${key}`).toBe(true);
      }
    }
  });

  it("turns snow off by altitude in the desert rather than by unwiring it", () => {
    // The picker keeps showing which layer *would* be used, so the rule is
    // legible instead of silently disabled.
    expect(TOPOGRAPHY_PRESETS.desert.snowHeight).toBeGreaterThan(1);
  });
});
