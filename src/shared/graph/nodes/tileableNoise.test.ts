import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext, NodeInstance } from "../types";
import {
  cloudShape,
  packCloudShape,
  sampleTileable,
  TILEABLE_PATTERNS,
  TileableSettings,
  tileablePerlin,
  tileableWorley,
  tileFrequency,
} from "../../math/tileableNoise";
import { TILEABLE_NOISE_GLSL } from "../../three/shaders/tileableNoiseGlsl";
import { TEXTURE_TILEABLE_NOISE_NODE, TEXTURE_TILEABLE_VOLUME_NODE, volumeResolution } from "./tileableNoise";
import { VOLUME_CLOUDS_NODE } from "./volumeClouds";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "test" };

const settings = (pattern: TileableSettings["pattern"], channels = false): TileableSettings => ({
  pattern,
  frequency: [3, 4, 5],
  channels,
  octaves: 3,
  gain: 0.5,
  seed: 7,
});

describe("tileable noise math", () => {
  test("Perlin and Worley repeat exactly after one period on every axis", () => {
    const period: [number, number, number] = [3, 4, 5];
    for (const [x, y, z] of [[0.3, 1.7, 2.2], [2.9, 3.99, 4.5], [0.01, 0.02, 0.03]]) {
      for (const fn of [tileablePerlin, tileableWorley]) {
        const base = fn(x, y, z, period, 2);
        expect(fn(x + 3, y, z, period, 2)).toBeCloseTo(base, 10);
        expect(fn(x, y + 4, z, period, 2)).toBeCloseTo(base, 10);
        expect(fn(x, y, z + 5, period, 2)).toBeCloseTo(base, 10);
      }
    }
  });

  test("every pattern is seamless across the tile edge (no jump between u≈1 and u≈0)", () => {
    const eps = 1e-4;
    for (const pattern of TILEABLE_PATTERNS) {
      for (const channels of [false, true]) {
        const s = settings(pattern, channels);
        for (const t of [0.13, 0.5, 0.87]) {
          const pairs: [number[], number[]][] = [
            [sampleTileable(1 - eps, t, t, s), sampleTileable(eps, t, t, s)],
            [sampleTileable(t, 1 - eps, t, s), sampleTileable(t, eps, t, s)],
            [sampleTileable(t, t, 1 - eps, s), sampleTileable(t, t, eps, s)],
          ];
          for (const [a, b] of pairs) {
            for (let c = 0; c < 4; c++) expect(Math.abs(a[c] - b[c])).toBeLessThan(0.05);
          }
        }
      }
    }
  });

  test("outputs stay finite and inside [0, 1]", () => {
    for (const pattern of TILEABLE_PATTERNS) {
      const s = settings(pattern, true);
      for (let i = 0; i < 200; i++) {
        const v = sampleTileable(Math.sin(i) * 3.1, Math.cos(i * 1.3) * 2.7, i * 0.137, s);
        for (const c of v) {
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("seed decorrelates, same seed reproduces", () => {
    const a = sampleTileable(0.3, 0.6, 0.1, settings("worley"));
    expect(sampleTileable(0.3, 0.6, 0.1, settings("worley"))).toEqual(a);
    expect(sampleTileable(0.3, 0.6, 0.1, { ...settings("worley"), seed: 8 })).not.toEqual(a);
  });

  test("packed cloud shape matches the original's remap of its channels", () => {
    const c = cloudShape(0.2, 0.4, 0.6, [4, 4, 4], 0);
    const low = c[1] * 0.625 + c[2] * 0.25 + c[3] * 0.125;
    expect(packCloudShape(c)).toBeCloseTo(Math.min(1, Math.max(0, (c[0] - (low - 1)) / (2 - low))), 10);
  });

  test("frequencies are whole numbers, at least one cell", () => {
    expect(tileFrequency(3.6)).toBe(4);
    expect(tileFrequency(0)).toBe(1);
    expect(tileFrequency("nope", 2)).toBe(2);
  });

  test("the GLSL twin carries the same Perlin range", async () => {
    const { PERLIN_RANGE } = await import("../../math/tileableNoise");
    expect(TILEABLE_NOISE_GLSL).toContain(PERLIN_RANGE.toFixed(4));
  });
});

describe("TEXTURE_TILEABLE_NOISE_NODE", () => {
  test("degrades to null without a renderer", () => {
    expect(TEXTURE_TILEABLE_NOISE_NODE.evaluate({}, TEXTURE_TILEABLE_NOISE_NODE.defaultParams, CTX)).toEqual({ texture: null });
  });

  test("octaves and gain only show for the plain noises", () => {
    const fields = (pattern: string) =>
      TEXTURE_TILEABLE_NOISE_NODE.dynamicParamFields!({
        id: "n",
        type: TEXTURE_TILEABLE_NOISE_NODE.type,
        position: { x: 0, y: 0 },
        params: { ...TEXTURE_TILEABLE_NOISE_NODE.defaultParams, pattern },
      } as NodeInstance).map((f) => f.id);
    expect(fields("perlin")).toContain("octaves");
    expect(fields("cloud-shape")).not.toContain("octaves");
    expect(fields("cloud-shape")).toContain("size");
  });
});

describe("TEXTURE_TILEABLE_VOLUME_NODE", () => {
  test("degrades to null without a renderer", () => {
    expect(TEXTURE_TILEABLE_VOLUME_NODE.evaluate({}, TEXTURE_TILEABLE_VOLUME_NODE.defaultParams, CTX)).toEqual({ volume: null, ready: 0 });
  });

  test("auto resolution follows the original's sizes", () => {
    expect(volumeResolution("auto", "cloud-shape")).toBe(128);
    expect(volumeResolution("auto", "cloud-detail")).toBe(32);
    expect(volumeResolution("auto", "perlin")).toBe(64);
    expect(volumeResolution("256", "perlin")).toBe(256);
    expect(volumeResolution("17", "perlin")).toBe(64);
  });
});

describe("VOLUME_CLOUDS_NODE", () => {
  test("builds its cloud box headless and keeps the same mesh across frames", () => {
    const ctx = { ...CTX, nodeId: "clouds" };
    const first = VOLUME_CLOUDS_NODE.evaluate({}, VOLUME_CLOUDS_NODE.defaultParams, ctx);
    const second = VOLUME_CLOUDS_NODE.evaluate({}, VOLUME_CLOUDS_NODE.defaultParams, { ...ctx, time: 1, step: 60 });
    expect(first.geometry).toBeInstanceOf(THREE.Mesh);
    expect(second.geometry).toBe(first.geometry);
    const mesh = first.geometry as THREE.Mesh;
    expect(mesh.matrixAutoUpdate).toBe(false);
    expect(new THREE.Vector3().setFromMatrixPosition(mesh.matrix).y).toBe(12);
  });

  test("wind scrolls the noise with time and the sun direction is normalized", () => {
    const ctx = { ...CTX, nodeId: "clouds-wind", time: 2 };
    const mesh = VOLUME_CLOUDS_NODE.evaluate({}, VOLUME_CLOUDS_NODE.defaultParams, ctx).geometry as THREE.Mesh;
    const u = (mesh.material as THREE.ShaderMaterial).uniforms;
    expect((u.uShapeOffset.value as THREE.Vector3).x).toBeCloseTo(-3);
    expect((u.uSunDir.value as THREE.Vector3).length()).toBeCloseTo(1);
  });

  test("a wired 3D volume replaces the built-in one; a 2D texture does not", () => {
    const ctx = { ...CTX, nodeId: "clouds-wired" };
    const volume = new THREE.Data3DTexture(new Uint8Array(8), 2, 2, 2);
    const mesh = VOLUME_CLOUDS_NODE.evaluate({ shape: volume, detail: new THREE.Texture() }, VOLUME_CLOUDS_NODE.defaultParams, ctx).geometry as THREE.Mesh;
    const u = (mesh.material as THREE.ShaderMaterial).uniforms;
    expect(u.uShape.value).toBe(volume);
    expect(u.uDetail.value).toBeInstanceOf(THREE.Data3DTexture);
    expect(u.uDetail.value).not.toBe(volume);
  });

  test("a directional light wired as the sun points from its target to itself", () => {
    const light = new THREE.DirectionalLight();
    light.position.set(0, 10, 0);
    light.target.position.set(0, 0, 0);
    const ctx = { ...CTX, nodeId: "clouds-sun" };
    const mesh = VOLUME_CLOUDS_NODE.evaluate({ sun: light }, VOLUME_CLOUDS_NODE.defaultParams, ctx).geometry as THREE.Mesh;
    const dir = (mesh.material as THREE.ShaderMaterial).uniforms.uSunDir.value as THREE.Vector3;
    expect(dir.y).toBeCloseTo(1);
  });
});
