import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { EvalContext } from "../types";
import {
  TEXT_ANIMATOR_NODE,
  TEXT_DECOMPOSE_NODE,
  TEXT_RANGE_SELECTOR_NODE,
  CURVE_TEXT_ON_PATH_NODE,
} from "./kineticText";
import {
  computeRangeWeights,
  getShuffledPermutation,
} from "../../three/typography/rangeSelector";
import { computeTextLayout } from "../../three/typography/textLayout";
import { BUILTIN_FONTS } from "../../three/fonts/fonts";

const CTX: EvalContext = {
  time: 1.0,
  step: 60,
  nodeId: "test-kinetic-text",
};

describe("Range Selector Mathematics", () => {
  it("computes smooth weights across elements", () => {
    const weights = computeRangeWeights(5, { start: 0, end: 1, shape: "smooth" });
    expect(weights.length).toBe(5);
    expect(weights[0]).toBe(0);
    expect(weights[4]).toBe(1);
    expect(weights[2]).toBeCloseTo(0.5, 2);
  });

  it("handles offset shifts", () => {
    const weights = computeRangeWeights(5, { start: 0, end: 0.5, offset: 0.5, shape: "linear" });
    // range is now 0.5 to 1.0
    expect(weights[0]).toBe(0);
    expect(weights[1]).toBe(0);
    expect(weights[4]).toBe(1);
  });

  it("supports inverted weights", () => {
    const normal = computeRangeWeights(4, { start: 0, end: 1, shape: "linear" });
    const inverted = computeRangeWeights(4, { start: 0, end: 1, shape: "linear", invert: true });
    for (let i = 0; i < 4; i++) {
      expect(normal[i] + inverted[i]).toBeCloseTo(1, 4);
    }
  });

  it("generates deterministic shuffled permutations", () => {
    const p1 = getShuffledPermutation(10, 42);
    const p2 = getShuffledPermutation(10, 42);
    expect(p1).toEqual(p2);
    expect(p1.length).toBe(10);
    expect(new Set(p1).size).toBe(10);
  });

  it("adds procedural wiggle when configured", () => {
    const baseWeights = computeRangeWeights(5, { start: 0, end: 1, shape: "linear" });
    const wiggly = computeRangeWeights(5, {
      start: 0,
      end: 1,
      shape: "linear",
      wiggleAmount: 0.2,
      time: 2.5,
    });
    expect(wiggly.length).toBe(5);
    expect(wiggly).not.toEqual(baseWeights);
  });

  it("computes elastic weights with spring recoil overshoot", () => {
    const weights = computeRangeWeights(11, { start: 0, end: 1, shape: "elastic" });
    expect(weights.length).toBe(11);
    expect(weights[0]).toBe(0);
    expect(weights[10]).toBe(1);
    // Elastic overshoot: some intermediate values should exceed 1.0
    const hasOvershoot = weights.some((w) => w > 1.0);
    expect(hasOvershoot).toBe(true);
  });

  it("computes bounce weights with decaying parabolic rebounds", () => {
    const weights = computeRangeWeights(11, { start: 0, end: 1, shape: "bounce" });
    expect(weights.length).toBe(11);
    expect(weights[0]).toBe(0);
    expect(weights[10]).toBe(1);
    // At u ~ 0.5 (middle), bounce is already in its rebounds (> 0.5)
    expect(weights[5]).toBeGreaterThan(0.6);
  });
});

describe("Text Layout Engine", () => {
  const font = BUILTIN_FONTS["Helvetiker"];

  it("parses single-line and multi-line strings into glyphs", () => {
    const layout = computeTextLayout("TSUJI\n3D", font, { fontSize: 64, align: "center" });
    expect(layout.glyphs.length).toBe(7); // 5 + 2 characters (newline is separator)
    expect(layout.lines.length).toBe(2);
    expect(layout.words).toEqual(["TSUJI", "3D"]);
    expect(layout.totalWidth).toBeGreaterThan(0);
    expect(layout.totalHeight).toBeGreaterThan(0);
  });

  it("aligns lines horizontally (left, center, right)", () => {
    const left = computeTextLayout("ABC", font, { align: "left" });
    const center = computeTextLayout("ABC", font, { align: "center" });
    const right = computeTextLayout("ABC", font, { align: "right" });

    expect(left.glyphs[0].basePosition.x).toBeGreaterThan(center.glyphs[0].basePosition.x);
    expect(center.glyphs[0].basePosition.x).toBeGreaterThan(right.glyphs[0].basePosition.x);
  });

  it("conforms text along a 3D spline curve", () => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-10, 0, 0),
      new THREE.Vector3(0, 5, 0),
      new THREE.Vector3(10, 0, 0),
    ]);

    const layout = computeTextLayout("WAVE", font, {
      curve,
      alignToPath: true,
      fitToCurve: true,
    });

    expect(layout.glyphs.length).toBe(4);
    // All characters should sit along the curve arc
    for (const g of layout.glyphs) {
      expect(g.basePosition.x).toBeGreaterThanOrEqual(-10.1);
      expect(g.basePosition.x).toBeLessThanOrEqual(10.1);
      expect(g.baseMatrix).toBeInstanceOf(THREE.Matrix4);
    }
  });
});

describe("TEXT_ANIMATOR_NODE", () => {
  it("evaluates text to a THREE.Group with child glyph meshes", () => {
    const res = TEXT_ANIMATOR_NODE.evaluate(
      { text: "ANTIGRAVITY" },
      { ...TEXT_ANIMATOR_NODE.defaultParams, text: "ANTIGRAVITY" },
      { ...CTX, nodeId: "animator-1" }
    );

    const group = res.geometry as THREE.Group;
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBe(11);
    expect(res.count).toBe(11);
    expect((res.matrices as THREE.Matrix4[]).length).toBe(11);
    expect((res.positions as THREE.Vector3[]).length).toBe(11);
    expect(res.characters).toEqual(["A", "N", "T", "I", "G", "R", "A", "V", "I", "T", "Y"]);
  });

  it("applies range selector weights and transform deltas", () => {
    const res = TEXT_ANIMATOR_NODE.evaluate(
      {
        text: "XYZ",
        positionDelta: [0, 10, 0],
        scaleDelta: [0, 0, 0],
      },
      {
        ...TEXT_ANIMATOR_NODE.defaultParams,
        text: "XYZ",
        start: 0,
        end: 1,
        positionDelta: [0, 10, 0],
        scaleDelta: [0, 0, 0],
      },
      { ...CTX, nodeId: "animator-2" }
    );

    const weights = res.weights as number[];
    expect(weights.length).toBe(3);
    const positions = res.positions as THREE.Vector3[];
    expect(positions.length).toBe(3);
    // At start=0, end=1, weight ramps up from 0 to 1
    expect(weights[0]).toBe(0);
    expect(weights[1]).toBeCloseTo(0.5, 2);
    expect(weights[2]).toBe(1);
    // Delta is [0, 10, 0], invW = 1 - w:
    // When w = 0 (first char), char is fully offset by +10.
    // When w = 1 (last char), char has arrived at base (offset +0).
    expect(positions[0].y).toBeGreaterThan(positions[2].y);
  });

  it("handles text on a 3D curve path input", () => {
    const curve3D = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-10, 0, 0),
      new THREE.Vector3(0, 5, 0),
      new THREE.Vector3(10, 0, 0),
    ]);

    const res = TEXT_ANIMATOR_NODE.evaluate(
      { text: "ORBIT", curve: curve3D },
      { ...TEXT_ANIMATOR_NODE.defaultParams, text: "ORBIT" },
      { ...CTX, nodeId: "animator-3" }
    );

    expect(res.count).toBe(5);
    const group = res.geometry as THREE.Group;
    expect(group.children.length).toBe(5);
  });

  it("interprets all material parameters including emissive, shadeless, transmission and custom material", () => {
    // Standard PBR parameters with emissive and opacity
    const resPbr = TEXT_ANIMATOR_NODE.evaluate(
      {
        text: "PBR",
        color: "#ff0000",
        emissive: "#00ff00",
        emissiveIntensity: 2.5,
        roughness: 0.1,
        metalness: 0.9,
        wireframe: true,
        opacity: 0.7,
      },
      {
        ...TEXT_ANIMATOR_NODE.defaultParams,
        text: "PBR",
        color: "#ff0000",
        emissive: "#00ff00",
        emissiveIntensity: 2.5,
        roughness: 0.1,
        metalness: 0.9,
        wireframe: true,
        opacity: 0.7,
      },
      { ...CTX, nodeId: "animator-mat-1" }
    );
    const groupPbr = resPbr.geometry as THREE.Group;
    const meshPbr = groupPbr.children[0] as THREE.Mesh;
    const matPbr = meshPbr.material as THREE.MeshStandardMaterial;
    expect(matPbr).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(matPbr.color.getHexString()).toBe("ff0000");
    expect(matPbr.emissive.getHexString()).toBe("00ff00");
    expect(matPbr.emissiveIntensity).toBe(2.5);
    expect(matPbr.roughness).toBe(0.1);
    expect(matPbr.metalness).toBe(0.9);
    expect(matPbr.wireframe).toBe(true);
    expect(matPbr.opacity).toBe(0.7);
    expect(matPbr.transparent).toBe(true);

    // Shadeless mode -> MeshBasicMaterial
    const resBasic = TEXT_ANIMATOR_NODE.evaluate(
      { text: "FLAT", shadeless: true, color: "#123456" },
      { ...TEXT_ANIMATOR_NODE.defaultParams, text: "FLAT", shadeless: true, color: "#123456" },
      { ...CTX, nodeId: "animator-mat-2" }
    );
    const groupBasic = resBasic.geometry as THREE.Group;
    const meshBasic = groupBasic.children[0] as THREE.Mesh;
    expect(meshBasic.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((meshBasic.material as THREE.MeshBasicMaterial).color.getHexString()).toBe("123456");

    // Glass / transmission mode -> MeshPhysicalMaterial
    const resGlass = TEXT_ANIMATOR_NODE.evaluate(
      { text: "GLASS", transmission: 0.85, thickness: 1.5 },
      { ...TEXT_ANIMATOR_NODE.defaultParams, text: "GLASS", transmission: 0.85, thickness: 1.5 },
      { ...CTX, nodeId: "animator-mat-3" }
    );
    const groupGlass = resGlass.geometry as THREE.Group;
    const meshGlass = groupGlass.children[0] as THREE.Mesh;
    const matGlass = meshGlass.material as THREE.MeshPhysicalMaterial;
    expect(matGlass).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(matGlass.transmission).toBe(0.85);
    expect(matGlass.thickness).toBe(1.5);

    // Custom material input
    const customMat = new THREE.MeshToonMaterial({ color: 0x336699 });
    const resCustom = TEXT_ANIMATOR_NODE.evaluate(
      { text: "TOON", material: customMat },
      { ...TEXT_ANIMATOR_NODE.defaultParams, text: "TOON" },
      { ...CTX, nodeId: "animator-mat-4" }
    );
    const groupCustom = resCustom.geometry as THREE.Group;
    const meshCustom = groupCustom.children[0] as THREE.Mesh;
    expect(meshCustom.material).toBe(customMat);
  });
});

describe("TEXT_DECOMPOSE_NODE", () => {
  it("breaks down text into characters, words, lines and base coordinates", () => {
    const res = TEXT_DECOMPOSE_NODE.evaluate(
      { text: "Alpha Beta\nGamma" },
      { ...TEXT_DECOMPOSE_NODE.defaultParams, text: "Alpha Beta\nGamma" },
      CTX
    );

    expect(res.count).toBe(15); // 10 chars ("Alpha Beta") + 5 chars ("Gamma")
    expect(res.words).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(res.lines).toEqual(["Alpha Beta", "Gamma"]);
    expect((res.positions as THREE.Vector3[]).length).toBe(15);
    expect((res.matrices as THREE.Matrix4[]).length).toBe(15);
    expect(res.width).toBeGreaterThan(0);
    expect(res.height).toBeGreaterThan(0);
  });
});

describe("TEXT_RANGE_SELECTOR_NODE", () => {
  it("outputs modulation weights and active count", () => {
    const res = TEXT_RANGE_SELECTOR_NODE.evaluate(
      { count: 10, start: 0.2, end: 0.8 },
      { ...TEXT_RANGE_SELECTOR_NODE.defaultParams, count: 10, start: 0.2, end: 0.8 },
      CTX
    );

    const weights = res.weights as number[];
    expect(weights.length).toBe(10);
    expect(res.activeCount).toBeGreaterThan(0);
  });
});

describe("CURVE_TEXT_ON_PATH_NODE", () => {
  it("constructs text along a curve path", () => {
    const spline = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(5, 5, 0),
      new THREE.Vector3(10, 0, 0),
    ]);

    const res = CURVE_TEXT_ON_PATH_NODE.evaluate(
      { text: "SPIRAL", curve: spline },
      { ...CURVE_TEXT_ON_PATH_NODE.defaultParams, text: "SPIRAL" },
      { ...CTX, nodeId: "curve-text-1" }
    );

    expect(res.count).toBe(6);
    expect(res.geometry).toBeInstanceOf(THREE.Group);
    expect((res.matrices as THREE.Matrix4[]).length).toBe(6);
    expect((res.positions as THREE.Vector3[]).length).toBe(6);
  });

  it("applies full material parameters on curved text meshes", () => {
    const spline = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
    const res = CURVE_TEXT_ON_PATH_NODE.evaluate(
      {
        text: "ARC",
        curve: spline,
        emissive: "#330000",
        emissiveIntensity: 1.8,
        wireframe: true,
      },
      {
        ...CURVE_TEXT_ON_PATH_NODE.defaultParams,
        text: "ARC",
        emissive: "#330000",
        emissiveIntensity: 1.8,
        wireframe: true,
      },
      { ...CTX, nodeId: "curve-text-mat-1" }
    );
    const group = res.geometry as THREE.Group;
    const mesh = group.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.emissive.getHexString()).toBe("330000");
    expect(mat.emissiveIntensity).toBe(1.8);
    expect(mat.wireframe).toBe(true);
  });
});
