import { describe, test, expect } from "vitest";
import * as THREE from "three";
import { TERRAIN_NODE } from "./terrain";
import {
  createTerrainGeometry,
  parseResolution,
  samplePixelHeight,
  updateTerrainHeightsAndNormals,
  TerrainGridConfig,
} from "../../three/terrainEngine";
import { applySculptStroke, calculateFalloff, SculptStrokeParams } from "../../three/terrainSculpt";

describe("Terrain Maker & Engine", () => {
  test("parses resolutions properly", () => {
    expect(parseResolution("32x32")).toEqual({ segmentsX: 32, segmentsZ: 32 });
    expect(parseResolution("64x64")).toEqual({ segmentsX: 64, segmentsZ: 64 });
    expect(parseResolution("128x128")).toEqual({ segmentsX: 128, segmentsZ: 128 });
    expect(parseResolution("256x256")).toEqual({ segmentsX: 256, segmentsZ: 256 });
    expect(parseResolution("invalid")).toEqual({ segmentsX: 128, segmentsZ: 128 });
  });

  test("creates base plane geometry on XZ plane with Y as up", () => {
    const geo = createTerrainGeometry(40, 40, 4, 4);
    expect(geo.attributes.position).toBeDefined();
    expect(geo.attributes.position.count).toBe(25); // (4+1) * (4+1)
    const pos = geo.attributes.position.array as Float32Array;

    // Check that vertices lie in XZ plane (Y = 0 initially)
    for (let i = 0; i < 25; i++) {
      expect(pos[i * 3 + 1]).toBeCloseTo(0, 4);
    }
  });

  test("texture height sampling reads luminance correctly", () => {
    const data = new Uint8Array(4 * 4 * 4); // 4x4 RGBA
    // Set pixel (0, 0) to full white
    data[0] = 255;
    data[1] = 255;
    data[2] = 255;
    data[3] = 255;

    // Set pixel (2, 2) to half gray
    const idx = (2 * 4 + 2) * 4;
    data[idx] = 128;
    data[idx + 1] = 128;
    data[idx + 2] = 128;
    data[idx + 3] = 255;

    const pixels = { data, width: 4, height: 4 };
    expect(samplePixelHeight(pixels, 0.05, 0.95)).toBeCloseTo(1.0, 2);
    expect(samplePixelHeight(pixels, 0.55, 0.45)).toBeCloseTo(0.5, 1);
  });

  test("updateTerrainHeightsAndNormals computes heights, finite difference normals, and slope shading", () => {
    const geo = createTerrainGeometry(10, 10, 2, 2); // 9 vertices
    const config: TerrainGridConfig = {
      width: 10,
      depth: 10,
      segmentsX: 2,
      segmentsZ: 2,
      heightScale: 5,
      heightOffset: 0,
      slopeShading: true,
      flatShading: false,
    };

    // Center vertex (index 4) has a sculpted elevation of 3.0
    const sculptOffsets: Record<number, number> = { 4: 3.0 };
    const heights = updateTerrainHeightsAndNormals(geo, config, null, sculptOffsets);

    expect(heights[4]).toBeCloseTo(3.0, 4);
    expect(heights[0]).toBeCloseTo(0.0, 4);

    const pos = geo.attributes.position.array as Float32Array;
    expect(pos[4 * 3 + 1]).toBeCloseTo(3.0, 4);

    const norm = geo.attributes.normal.array as Float32Array;
    // Normals should be unit vectors
    for (let i = 0; i < 9; i++) {
      const len = Math.hypot(norm[i * 3], norm[i * 3 + 1], norm[i * 3 + 2]);
      expect(len).toBeCloseTo(1.0, 3);
    }

    // Since center vertex is higher, neighbor normal X/Z should point outward
    expect(norm[4 * 3 + 1]).toBeGreaterThan(0.5);

    // Color attribute exists when slopeShading is on
    expect(geo.attributes.color).toBeDefined();
    expect(geo.attributes.color.count).toBe(9);
  });

  test("sculpting brushes deform terrain offsets correctly", () => {
    const geo = createTerrainGeometry(20, 20, 10, 10);
    const config: TerrainGridConfig = {
      width: 20,
      depth: 20,
      segmentsX: 10,
      segmentsZ: 10,
      heightScale: 5,
      heightOffset: 0,
      slopeShading: false,
      flatShading: false,
    };

    const sculptOffsets: Record<number, number> = {};

    // 1. Sculpt Raise
    const strokeRaise: SculptStrokeParams = {
      tool: "sculpt",
      falloff: "smooth",
      radius: 4.0,
      strength: 1.0,
      invert: false,
      hitPoint: new THREE.Vector3(0, 0, 0),
      deltaTime: 0.05,
    };

    applySculptStroke(geo, config, null, sculptOffsets, strokeRaise);

    // Center vertex is at (0, 0) -> index 5 * 11 + 5 = 60
    const centerIdx = 5 * 11 + 5;
    expect(sculptOffsets[centerIdx]).toBeGreaterThan(0.5);

    // 2. Sculpt Lower with invert
    const strokeLower: SculptStrokeParams = {
      tool: "sculpt",
      falloff: "smooth",
      radius: 4.0,
      strength: 1.0,
      invert: true,
      hitPoint: new THREE.Vector3(0, 0, 0),
      deltaTime: 0.05,
    };
    applySculptStroke(geo, config, null, sculptOffsets, strokeLower);
    expect(sculptOffsets[centerIdx]).toBeCloseTo(0.0, 1);

    // 3. Flatten
    sculptOffsets[centerIdx] = 5.0;
    updateTerrainHeightsAndNormals(geo, config, null, sculptOffsets);
    const strokeFlatten: SculptStrokeParams = {
      tool: "flatten",
      falloff: "flat",
      radius: 3.0,
      strength: 1.0,
      invert: false,
      hitPoint: new THREE.Vector3(0, 2.0, 0),
      targetHeight: 2.0,
      deltaTime: 0.1,
    };
    applySculptStroke(geo, config, null, sculptOffsets, strokeFlatten);
    // Center vertex pulled towards 2.0
    expect(sculptOffsets[centerIdx]).toBeLessThan(5.0);

    // 4. Smooth
    sculptOffsets[centerIdx] = 8.0;
    updateTerrainHeightsAndNormals(geo, config, null, sculptOffsets);
    const strokeSmooth: SculptStrokeParams = {
      tool: "smooth",
      falloff: "smooth",
      radius: 4.0,
      strength: 1.0,
      invert: false,
      hitPoint: new THREE.Vector3(0, 0, 0),
      deltaTime: 0.1,
    };
    applySculptStroke(geo, config, null, sculptOffsets, strokeSmooth);
    expect(sculptOffsets[centerIdx]).toBeLessThan(8.0);
  });

  test("falloff calculations conform to curve shapes", () => {
    expect(calculateFalloff(0.0, "smooth")).toBeCloseTo(1.0);
    expect(calculateFalloff(1.0, "smooth")).toBeCloseTo(0.0);
    expect(calculateFalloff(0.5, "smooth")).toBeCloseTo(0.5);

    expect(calculateFalloff(0.5, "linear")).toBeCloseTo(0.5);
    expect(calculateFalloff(0.0, "flat")).toBeCloseTo(1.0);
    expect(calculateFalloff(0.99, "flat")).toBeCloseTo(1.0);
    expect(calculateFalloff(1.1, "flat")).toBeCloseTo(0.0);
  });

  test("TERRAIN_NODE evaluation outputs geometry, matrix and userData", () => {
    const ctx = { nodeId: "terrain_test_1" };
    const inputs = {};
    const params = {
      width: 50,
      depth: 50,
      resolution: "32x32",
      heightScale: 10,
      heightOffset: 2,
    };

    const out = TERRAIN_NODE.evaluate(inputs, params, ctx as any);
    expect(out.geometry).toBeInstanceOf(THREE.Mesh);
    expect(out.matrix).toBeInstanceOf(THREE.Matrix4);

    const mesh = out.geometry as THREE.Mesh;
    expect(mesh.userData.isTerrain).toBe(true);
    expect(mesh.userData.terrainConfig.width).toBe(50);
    expect(mesh.geometry.attributes.position.count).toBe(33 * 33);
  });

  test("Terrain mesh geometry generates valid trimesh collider data for Rapier physics", async () => {
    const { extractColliderGeometry } = await import("../../three/physics/rapierRuntime");
    const ctx = { nodeId: "terrain_phys_1" };
    const out = TERRAIN_NODE.evaluate({}, { width: 40, depth: 40, resolution: "32x32" }, ctx as any);
    const mesh = out.geometry as THREE.Mesh;

    const colliderData = extractColliderGeometry(mesh);
    expect(colliderData).not.toBeNull();
    expect(colliderData!.vertices.length).toBe(33 * 33 * 3);
    expect(colliderData!.indices.length).toBe(32 * 32 * 2 * 3);
  });
});
