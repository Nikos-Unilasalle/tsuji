import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { SAMPLE_TEXTURE_NODE } from "./sampleTexture";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "sample-texture-test-1" };

/** Helper to create a small 2x2 RGBA DataTexture for testing */
function createTestTexture(): THREE.DataTexture {
  // 2x2 RGBA
  // Pixel (0, 0): Red (255, 0, 0, 255)
  // Pixel (1, 0): Green (0, 255, 0, 255)
  // Pixel (0, 1): Blue (0, 0, 255, 255)
  // Pixel (1, 1): White (255, 255, 255, 255)
  const data = new Uint8Array([
    255, 0, 0, 255,     // (0,0) u=0, v=0
    0, 255, 0, 255,     // (1,0) u=1, v=0
    0, 0, 255, 255,     // (0,1) u=0, v=1
    255, 255, 255, 255, // (1,1) u=1, v=1
  ]);
  const texture = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

describe("SAMPLE_TEXTURE_NODE", () => {
  it("returns default/empty outputs when no positions or geometry are provided", () => {
    const res = SAMPLE_TEXTURE_NODE.evaluate({}, {}, CTX);
    expect(res.count).toBe(0);
    expect((res.values as number[]).length).toBe(0);
  });

  it("samples RGBA DataTexture with bounds mapping and returns normalized 0-1 values", () => {
    const texture = createTestTexture();
    // 4 sample positions corresponding to 4 corners in XZ plane
    const positions = [
      new THREE.Vector3(0, 0, 0),  // corner (0,0) -> Red
      new THREE.Vector3(10, 0, 0), // corner (1,0) -> Green
      new THREE.Vector3(0, 0, 10), // corner (0,1) -> Blue
      new THREE.Vector3(10, 0, 10) // corner (1,1) -> White
    ];

    const res = SAMPLE_TEXTURE_NODE.evaluate(
      { texture, positions },
      { channel: "red", mapping: "bounds", plane: "XZ" },
      CTX,
    );

    expect(res.count).toBe(4);
    const values = res.values as number[];
    expect(values[0]).toBeCloseTo(1.0, 1); // Red pixel has red=1
    expect(values[1]).toBeCloseTo(0.0, 1); // Green pixel has red=0
    expect(values[2]).toBeCloseTo(0.0, 1); // Blue pixel has red=0
    expect(values[3]).toBeCloseTo(1.0, 1); // White pixel has red=1

    // Verify all values are strictly between 0 and 1
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("supports luminance channel calculation in [0, 1]", () => {
    const texture = createTestTexture();
    const positions = [
      new THREE.Vector3(10, 0, 10), // (1, 1) White
      new THREE.Vector3(0, 0, 0),   // (0, 0) Red
    ];

    const res = SAMPLE_TEXTURE_NODE.evaluate(
      { texture, positions },
      { channel: "luminance", mapping: "bounds" },
      CTX,
    );

    const values = res.values as number[];
    expect(values[0]).toBeCloseTo(1.0, 1); // White luminance is 1.0
    expect(values[1]).toBeCloseTo(0.299, 1); // Red luminance (0.299 * 1)
  });

  it("supports green and blue channels", () => {
    const texture = createTestTexture();
    const positions = [
      new THREE.Vector3(0, 0, 0),  // Red
      new THREE.Vector3(10, 0, 0), // Green
      new THREE.Vector3(0, 0, 10), // Blue
    ];

    const resGreen = SAMPLE_TEXTURE_NODE.evaluate(
      { texture, positions },
      { channel: "green", mapping: "bounds" },
      CTX,
    );
    const greenVals = resGreen.values as number[];
    expect(greenVals[0]).toBeCloseTo(0.0, 1);
    expect(greenVals[1]).toBeCloseTo(1.0, 1);
    expect(greenVals[2]).toBeCloseTo(0.0, 1);

    const resBlue = SAMPLE_TEXTURE_NODE.evaluate(
      { texture, positions },
      { channel: "blue", mapping: "bounds" },
      CTX,
    );
    const blueVals = resBlue.values as number[];
    expect(blueVals[0]).toBeCloseTo(0.0, 1);
    expect(blueVals[1]).toBeCloseTo(0.0, 1);
    expect(blueVals[2]).toBeCloseTo(1.0, 1);
  });

  it("extracts positions from input geometry mesh", () => {
    const texture = createTestTexture();
    const boxGeo = new THREE.BoxGeometry(2, 2, 2);
    const mesh = new THREE.Mesh(boxGeo);

    const res = SAMPLE_TEXTURE_NODE.evaluate(
      { texture, geometry: mesh },
      { mapping: "bounds", channel: "luminance" },
      CTX,
    );

    expect(res.count).toBeGreaterThan(0);
    expect((res.values as number[]).length).toBe(res.count);
    for (const v of res.values as number[]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("extracts positions from InstancedMesh geometry input", () => {
    const texture = createTestTexture();
    const geom = new THREE.BufferGeometry();
    const instancedMesh = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial(), 3);
    const m = new THREE.Matrix4();
    m.setPosition(1, 2, 3);
    instancedMesh.setMatrixAt(0, m);
    m.setPosition(4, 5, 6);
    instancedMesh.setMatrixAt(1, m);
    m.setPosition(7, 8, 9);
    instancedMesh.setMatrixAt(2, m);
    instancedMesh.instanceMatrix.needsUpdate = true;

    const res = SAMPLE_TEXTURE_NODE.evaluate(
      { texture, geometry: instancedMesh },
      { mapping: "world", plane: "XZ" },
      CTX,
    );

    expect(res.count).toBe(3);
    expect((res.values as number[]).length).toBe(3);
  });

  it("handles different planes (XZ and XY)", () => {
    const texture = createTestTexture();
    const positions = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 0)];

    const resXY = SAMPLE_TEXTURE_NODE.evaluate(
      { texture, positions },
      { channel: "green", plane: "XY", mapping: "bounds" },
      CTX,
    );
    expect(resXY.count).toBe(2);
    const vals = resXY.values as number[];
    expect(vals.length).toBe(2);
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
