import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { MATERIAL_STYLIZED_WATER_NODE } from "./materialWater";

const CTX: EvalContext = { time: 2.5, step: 150, nodeId: "water-node-1" };

type WaterResult = {
  material: { customMaterial: THREE.ShaderMaterial; color: THREE.Color; opacity: number };
};

function evaluate(inputs: Record<string, unknown>, nodeId = CTX.nodeId): WaterResult {
  return MATERIAL_STYLIZED_WATER_NODE.evaluate(
    inputs,
    MATERIAL_STYLIZED_WATER_NODE.defaultParams,
    { ...CTX, nodeId },
  ) as WaterResult;
}

describe("MATERIAL_STYLIZED_WATER_NODE", () => {
  it("has the expected node schema", () => {
    expect(MATERIAL_STYLIZED_WATER_NODE.type).toBe("material/stylized-water");
    expect(MATERIAL_STYLIZED_WATER_NODE.category).toBe("texture");
    expect(MATERIAL_STYLIZED_WATER_NODE.outputs.some((o) => o.id === "material")).toBe(true);
  });

  it("matches the folio-2025 defaults with nothing connected", () => {
    const { material } = evaluate({}, "defaults");
    const u = material.customMaterial.uniforms;

    expect(material.customMaterial).toBeInstanceOf(THREE.ShaderMaterial);
    expect(material.customMaterial.transparent).toBe(true);
    expect(material.customMaterial.depthWrite).toBe(false);

    expect(u.shoreFoamWidth.value).toBe(0);
    expect(u.edgeFade.value).toBe(0.35);
    expect(u.shoreFoamWobble.value).toBe(0.35);
    expect(u.ripplesCount.value).toBe(3);
    expect(u.ripplesReach.value).toBe(2);
    expect(u.ripplesNoiseFrequency.value).toBe(0.1);
    expect(u.ripplesNoiseOffset.value).toBe(0.345);
    expect(u.ripplesShoreRange.value).toBe(0.2);
    expect(u.ripplesSpeed.value).toBe(0.12);
    expect(u.ripplesFalloff.value).toBe(1.5);
    expect(u.ripplesSegmentGap.value).toBe(0.5);
    expect(u.detailsShadowStrength.value).toBe(0.55);
    expect(u.iceNoiseFrequency.value).toBe(0.3);
    expect(u.splashesNoiseFrequency.value).toBe(0.33);
    expect(u.splashesTimeFrequency.value).toBe(6);
    expect(u.splashesThickness.value).toBe(0.3);
    expect(u.splashesEdgeAttenuationLow.value).toBe(0.14);
    expect(u.splashesEdgeAttenuationHigh.value).toBe(1);

    expect(u.sandColor.value.getHex()).toBe(0xffa94e);
    expect(u.shallowColor.value.getHex()).toBe(0x5bc2b9);
    expect(u.deepColor.value.getHex()).toBe(0x13375f);
    expect(u.detailsColor.value.getHex()).toBe(0xffffff);

    expect(u.hasShoreMap.value).toBe(0);
    expect(u.time.value).toBe(2.5);
    expect(Object.values(u).every((entry) => !Number.isNaN(entry.value))).toBe(true);
  });

  it("reuses the same material instance per node id", () => {
    const first = evaluate({}, "stable").material.customMaterial;
    const second = evaluate({}, "stable").material.customMaterial;
    expect(second).toBe(first);
  });

  it("reads the heightmap resolution off the connected texture", () => {
    const texture = new THREE.DataTexture(new Float32Array(65 * 33 * 4), 65, 33, THREE.RGBAFormat, THREE.FloatType);
    const u = evaluate({ shoreMap: texture }, "heightmap").material.customMaterial.uniforms;

    expect(u.hasShoreMap.value).toBe(1);
    expect(u.shoreMap.value).toBe(texture);
    expect(u.shoreMapResolution.value.x).toBe(65);
    expect(u.shoreMapResolution.value.y).toBe(33);
  });

  it("derives the weather ratios the way WaterSurface does", () => {
    const warm = evaluate({ temperature: 18, rain: 0.5 }, "warm").material.customMaterial.uniforms;
    expect(warm.ripplesRatio.value).toBe(1);
    expect(warm.iceRatio.value).toBe(0);
    expect(warm.splashesRatio.value).toBeCloseTo(0.25, 5);

    const cold = evaluate({ temperature: -1.5, rain: 1 }, "cold").material.customMaterial.uniforms;
    expect(cold.ripplesRatio.value).toBeCloseTo(0.5, 5);
    expect(cold.iceRatio.value).toBeCloseTo(0.3, 5);
    expect(cold.splashesRatio.value).toBe(1);

    const frozen = evaluate({ temperature: -10, rain: 2 }, "frozen").material.customMaterial.uniforms;
    expect(frozen.ripplesRatio.value).toBe(0);
    expect(frozen.iceRatio.value).toBe(1);
    expect(frozen.splashesRatio.value).toBe(1);
  });

  it("lets explicit ratio inputs override the weather", () => {
    const u = evaluate(
      { temperature: -10, ripplesRatio: 0.75, iceRatio: 0.2, splashesRatio: 1.6 },
      "override",
    ).material.customMaterial.uniforms;

    expect(u.ripplesRatio.value).toBe(0.75);
    expect(u.iceRatio.value).toBe(0.2);
    expect(u.splashesRatio.value).toBe(1);
  });

  it("keeps the water column non-degenerate when depth sits at or above the surface", () => {
    const u = evaluate({ surfaceElevation: 2, depthElevation: 5 }, "degenerate").material.customMaterial.uniforms;

    expect(u.surfaceElevation.value).toBe(2);
    expect(u.depthElevation.value).toBeLessThan(2);
    expect(Number.isFinite(u.depthElevation.value)).toBe(true);
  });

  it("applies terrain framing and color overrides", () => {
    const { material } = evaluate(
      {
        terrainWidth: 60,
        terrainDepth: 30,
        terrainCenter: new THREE.Vector3(5, 0, -5),
        shallowColor: new THREE.Color(0x00ffff),
        waterTint: 0,
      },
      "framing",
    );
    const u = material.customMaterial.uniforms;

    expect(u.terrainSize.value.x).toBe(60);
    expect(u.terrainSize.value.y).toBe(30);
    expect(u.terrainCenter.value.x).toBe(5);
    expect(u.terrainCenter.value.z).toBe(-5);
    expect(u.shallowColor.value.getHex()).toBe(0x00ffff);
    expect(u.waterTint.value).toBe(0);
    expect(material.opacity).toBe(0);
  });

  it("falls back to finite sizes on garbage input", () => {
    const u = evaluate({ terrainWidth: 0, terrainDepth: Number.NaN }, "garbage").material.customMaterial.uniforms;

    expect(u.terrainSize.value.x).toBeGreaterThan(0);
    expect(u.terrainSize.value.y).toBe(40);
  });
});
