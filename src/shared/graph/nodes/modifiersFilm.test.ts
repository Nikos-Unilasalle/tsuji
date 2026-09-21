import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import {
  MODIFIER_DUOTONE_NODE,
  MODIFIER_HALFTONE_NODE,
  MODIFIER_FILM_TEXTURE_NODE,
  MODIFIER_DRY_BRUSH_NODE,
  MODIFIER_SUPER8_NODE,
  MODIFIER_OUTLINE_NODE,
} from "./modifiersFilm";

const CTX: EvalContext = { time: 1.5, step: 45, nodeId: "test-modifier" };

function createTestMesh(color = 0x00ff00): THREE.Mesh {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color });
  return new THREE.Mesh(geom, mat);
}

describe("MODIFIERS FILM (Per-Object Shading Modifiers)", () => {
  describe("source immutability (regression check)", () => {
    it("never mutates the input mesh or its original material", () => {
      const origMesh = createTestMesh(0xff0000);
      const origMaterial = origMesh.material;

      const res = MODIFIER_DUOTONE_NODE.evaluate(
        { geometry: origMesh },
        { shadowColor: new THREE.Color(0x000000), highlightColor: new THREE.Color(0xffffff) },
        CTX
      );

      // The original source mesh still has its original standard material untouched
      expect(origMesh.material).toBe(origMaterial);
      expect((origMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("ff0000");

      // The output is an independent mesh with the styled shader material
      expect(res.geometry).not.toBe(origMesh);
      const outMesh = res.geometry as THREE.Mesh;
      expect(outMesh.material).not.toBe(origMaterial);
      expect((outMesh.material as THREE.ShaderMaterial).isShaderMaterial).toBe(true);
    });
  });

  describe("modifier/duotone", () => {
    it("assigns a duotone shader material to the output mesh with custom colors", () => {
      const mesh = createTestMesh();
      const res = MODIFIER_DUOTONE_NODE.evaluate(
        {
          geometry: mesh,
          shadowColor: new THREE.Color(0x112233),
          highlightColor: new THREE.Color(0xffeedd),
          balance: 0.6,
          softness: 0.4,
          amount: 0.8,
        },
        {},
        CTX
      );

      const outMesh = res.geometry as THREE.Mesh;
      const mat = outMesh.material as THREE.ShaderMaterial;
      expect(mat.isShaderMaterial).toBe(true);
      expect(mat.uniforms.shadowColor.value.getHexString()).toBe("112233");
      expect(mat.uniforms.highlightColor.value.getHexString()).toBe("ffeedd");
      expect(mat.uniforms.balance.value).toBe(0.6);
      expect(mat.uniforms.softness.value).toBe(0.4);
      expect(mat.uniforms.amount.value).toBe(0.8);
      // Preserved upstream base color
      expect(mat.uniforms.baseColor.value.getHexString()).toBe("00ff00");
    });
  });

  describe("modifier/halftone", () => {
    it("configures halftone raster uniforms on the output mesh", () => {
      const mesh = createTestMesh();
      const res = MODIFIER_HALFTONE_NODE.evaluate(
        {
          geometry: mesh,
          radius: 8,
          screenAngle: 45,
          scatter: 0.2,
          amount: 0.9,
        },
        {
          shape: "line",
          space: "uv",
          greyscale: 1,
        },
        CTX
      );

      const outMesh = res.geometry as THREE.Mesh;
      const mat = outMesh.material as THREE.ShaderMaterial;
      expect(mat.isShaderMaterial).toBe(true);
      expect(mat.uniforms.radius.value).toBe(8);
      expect(mat.uniforms.screenAngle.value).toBeCloseTo((45 * Math.PI) / 180);
      expect(mat.uniforms.scatter.value).toBe(0.2);
      expect(mat.uniforms.halftoneAmount.value).toBe(0.9);
      expect(mat.uniforms.shape.value).toBe(2); // "line" is index 2
      expect(mat.uniforms.space.value).toBe(1.0); // "uv" is 1.0
      expect(mat.uniforms.greyscale.value).toBe(1.0);
    });
  });

  describe("modifier/film-texture", () => {
    it("applies film grain, dust, and scratch uniforms to the mesh", () => {
      const mesh = createTestMesh();
      const res = MODIFIER_FILM_TEXTURE_NODE.evaluate(
        {
          geometry: mesh,
          grain: 0.3,
          dust: 0.5,
          scratches: 0.4,
          blotches: 0.25,
          rate: 24,
        },
        { seed: 3 },
        CTX
      );

      const outMesh = res.geometry as THREE.Mesh;
      const mat = outMesh.material as THREE.ShaderMaterial;
      expect(mat.isShaderMaterial).toBe(true);
      expect(mat.uniforms.grain.value).toBe(0.3);
      expect(mat.uniforms.dust.value).toBe(0.5);
      expect(mat.uniforms.scratches.value).toBe(0.4);
      expect(mat.uniforms.blotches.value).toBe(0.25);
      expect(mat.uniforms.filmRate.value).toBe(24);
      expect(mat.uniforms.time.value).toBe(1.5);
      expect(mat.uniforms.filmSeed.value).toBe(3);
    });
  });

  describe("modifier/dry-brush", () => {
    it("sets dry brush ink and paper parameters on the mesh", () => {
      const mesh = createTestMesh();
      const res = MODIFIER_DRY_BRUSH_NODE.evaluate(
        {
          geometry: mesh,
          coverage: 0.35,
          speckSize: 80,
          stretch: 5,
          paperColor: new THREE.Color(0xf5ecd7),
        },
        {
          animate: 1,
          followInk: 0,
        },
        CTX
      );

      const outMesh = res.geometry as THREE.Mesh;
      const mat = outMesh.material as THREE.ShaderMaterial;
      expect(mat.isShaderMaterial).toBe(true);
      expect(mat.uniforms.coverage.value).toBe(0.35);
      expect(mat.uniforms.dryBrushScale.value).toBe(80);
      expect(mat.uniforms.stretch.value).toBe(5);
      expect(mat.uniforms.paperColor.value.getHexString()).toBe("f5ecd7");
      expect(mat.uniforms.dryBrushAnimate.value).toBe(1.0);
      expect(mat.uniforms.followInk.value).toBe(0.0);
    });
  });

  describe("modifier/super8", () => {
    it("configures vintage projection artifacts on the mesh", () => {
      const mesh = createTestMesh();
      const res = MODIFIER_SUPER8_NODE.evaluate(
        {
          geometry: mesh,
          softness: 2.0,
          flicker: 0.2,
          weave: 0.5,
          warmth: 0.6,
          rate: 16,
        },
        { seed: 7 },
        CTX
      );

      const outMesh = res.geometry as THREE.Mesh;
      const mat = outMesh.material as THREE.ShaderMaterial;
      expect(mat.isShaderMaterial).toBe(true);
      expect(mat.uniforms.super8Softness.value).toBe(2.0);
      expect(mat.uniforms.flicker.value).toBe(0.2);
      expect(mat.uniforms.weave.value).toBe(0.5);
      expect(mat.uniforms.warmth.value).toBe(0.6);
      expect(mat.uniforms.super8Rate.value).toBe(16);
      expect(mat.uniforms.super8Seed.value).toBe(7);
    });
  });

  describe("edge cases & chaining", () => {
    it("handles non-Object3D input gracefully", () => {
      const res = MODIFIER_DUOTONE_NODE.evaluate({ geometry: null }, {}, CTX);
      expect(res.geometry).toBeNull();
    });

    it("chains modifiers in sequence and combines their shader stages", () => {
      const mesh = createTestMesh(0x336699);
      const duoRes = MODIFIER_DUOTONE_NODE.evaluate(
        { geometry: mesh, shadowColor: new THREE.Color(0x112233) },
        {},
        { ...CTX, nodeId: "n-duo" }
      );
      const halfRes = MODIFIER_HALFTONE_NODE.evaluate(
        { geometry: duoRes.geometry, radius: 10 },
        {},
        { ...CTX, nodeId: "n-half" }
      );
      const finalMesh = halfRes.geometry as THREE.Mesh;
      expect(finalMesh).toBeDefined();
      const finalMat = finalMesh.material as THREE.ShaderMaterial;
      expect(finalMat.isShaderMaterial).toBe(true);
      // Both Duotone AND Halftone stages are active!
      expect(finalMat.uniforms.enableDuotone.value).toBe(1.0);
      expect(finalMat.uniforms.shadowColor.value.getHexString()).toBe("112233");
      expect(finalMat.uniforms.enableHalftone.value).toBe(1.0);
      expect(finalMat.uniforms.radius.value).toBe(10);
      // Original mesh remains untouched
      expect((mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial).toBe(true);

      // Chain a 3rd modifier (Film Texture)
      const filmRes = MODIFIER_FILM_TEXTURE_NODE.evaluate(
        { geometry: halfRes.geometry, grain: 0.4 },
        {},
        { ...CTX, nodeId: "n-film" }
      );
      const tripleMesh = filmRes.geometry as THREE.Mesh;
      const tripleMat = tripleMesh.material as THREE.ShaderMaterial;
      expect(tripleMat.uniforms.enableDuotone.value).toBe(1.0);
      expect(tripleMat.uniforms.enableHalftone.value).toBe(1.0);
      expect(tripleMat.uniforms.enableFilmTexture.value).toBe(1.0);
      expect(tripleMat.uniforms.grain.value).toBe(0.4);
    });

    it("preserves alpha channel and enables transparency when mesh has a texture or opacity", () => {
      const texture = new THREE.Texture();
      const mat = new THREE.MeshStandardMaterial({
        map: texture,
        transparent: true,
        opacity: 0.75,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);

      const res = MODIFIER_DUOTONE_NODE.evaluate({ geometry: mesh }, {}, { ...CTX, nodeId: "n-alpha" });
      const outMesh = res.geometry as THREE.Mesh;
      const outMat = outMesh.material as THREE.ShaderMaterial;

      expect(outMat.transparent).toBe(true);
      expect(outMat.uniforms.baseOpacity.value).toBe(0.75);
      expect(outMat.uniforms.baseMap.value).toBe(texture);
      expect(outMat.uniforms.hasMap.value).toBe(1.0);
    });
  });

  describe("modifier/outline", () => {
    it("configures outline shader uniforms on the output mesh", () => {
      const mesh = createTestMesh();
      const res = MODIFIER_OUTLINE_NODE.evaluate(
        {
          geometry: mesh,
          edgeColor: new THREE.Color(0xff0000),
          edgeThickness: 3.5,
          edgeStrength: 0.8,
          alphaThreshold: 0.25,
          silhouette: true,
          alphaEdge: true,
        },
        {},
        CTX
      );

      const outMesh = res.geometry as THREE.Mesh;
      const mat = outMesh.material as THREE.ShaderMaterial;
      expect(mat.isShaderMaterial).toBe(true);
      expect(mat.uniforms.enableOutline.value).toBe(1.0);
      expect(mat.uniforms.edgeColor.value.getHexString()).toBe("ff0000");
      expect(mat.uniforms.edgeThickness.value).toBe(3.5);
      expect(mat.uniforms.edgeStrength.value).toBe(0.8);
      expect(mat.uniforms.alphaThreshold.value).toBe(0.25);
      expect(outMesh.userData.outlineModifier).toBeDefined();
      expect(outMesh.userData.outlineModifier.is3D).toBe(true);
      expect(outMesh.userData.outlineModifier.edgeColor.getHexString()).toBe("ff0000");
      expect(outMesh.userData.outlineModifier.edgeThickness).toBe(3.5);
      expect(outMesh.userData.outlineModifier.edgeStrength).toBe(0.8);
    });

    it("chains seamlessly with other modifiers while preserving earlier stages", () => {
      const mesh = createTestMesh();
      // Stage 1: Duotone
      const duoRes = MODIFIER_DUOTONE_NODE.evaluate(
        { geometry: mesh, shadowColor: new THREE.Color(0x0000ff) },
        {},
        { ...CTX, nodeId: "node-duo" }
      );
      // Stage 2: Halftone
      const halfRes = MODIFIER_HALFTONE_NODE.evaluate(
        { geometry: duoRes.geometry, radius: 6 },
        {},
        { ...CTX, nodeId: "node-half" }
      );
      // Stage 3: Outline
      const outlineRes = MODIFIER_OUTLINE_NODE.evaluate(
        { geometry: halfRes.geometry, edgeColor: new THREE.Color(0x000000), edgeThickness: 2.5 },
        {},
        { ...CTX, nodeId: "node-outline" }
      );

      const finalMesh = outlineRes.geometry as THREE.Mesh;
      const finalMat = finalMesh.material as THREE.ShaderMaterial;
      expect(finalMat.isShaderMaterial).toBe(true);
      // All three stages active!
      expect(finalMat.uniforms.enableDuotone.value).toBe(1.0);
      expect(finalMat.uniforms.shadowColor.value.getHexString()).toBe("0000ff");
      expect(finalMat.uniforms.enableHalftone.value).toBe(1.0);
      expect(finalMat.uniforms.radius.value).toBe(6);
      expect(finalMat.uniforms.enableOutline.value).toBe(1.0);
      expect(finalMat.uniforms.edgeColor.value.getHexString()).toBe("000000");
      expect(finalMat.uniforms.edgeThickness.value).toBe(2.5);

      // Input mesh is untouched
      expect((mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
    });

    it("respects alpha channel and cutout outlines on textured meshes", () => {
      const alphaTexture = new THREE.Texture();
      const alphaMat = new THREE.MeshStandardMaterial({
        map: alphaTexture,
        transparent: true,
        opacity: 0.9,
      });
      const spriteMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), alphaMat);

      const res = MODIFIER_OUTLINE_NODE.evaluate(
        {
          geometry: spriteMesh,
          edgeColor: new THREE.Color(0x111111),
          alphaThreshold: 0.15,
        },
        {},
        { ...CTX, nodeId: "node-sprite-outline" }
      );

      const outMesh = res.geometry as THREE.Mesh;
      const outMat = outMesh.material as THREE.ShaderMaterial;

      expect(outMat.transparent).toBe(true);
      expect(outMat.uniforms.hasMap.value).toBe(1.0);
      expect(outMat.uniforms.baseMap.value).toBe(alphaTexture);
      expect(outMat.uniforms.baseOpacity.value).toBe(0.9);
      expect(outMat.uniforms.enableOutline.value).toBe(1.0);
      expect(outMat.uniforms.outlineAlpha.value).toBe(1.0);
      expect(outMat.uniforms.alphaThreshold.value).toBe(0.15);
      // Defaults to outside and sharp
      expect(outMat.uniforms.outlineSide.value).toBe(0.0);
      expect(outMat.uniforms.sharpness.value).toBe(1.0);
      // 2D alpha cutout does not use 3D postprocessing
      expect(outMesh.userData.outlineModifier.is3D).toBe(false);
      // Original sprite mesh untouched
      expect(spriteMesh.material).toBe(alphaMat);
    });

    it("accepts custom sharpness (flou/sharp) and outline side parameters", () => {
      const mesh = createTestMesh();
      const res = MODIFIER_OUTLINE_NODE.evaluate(
        {
          geometry: mesh,
          sharpness: 0.35,
          outlineSide: "outside",
        },
        {},
        CTX
      );

      const outMesh = res.geometry as THREE.Mesh;
      const mat = outMesh.material as THREE.ShaderMaterial;
      expect(mat.uniforms.sharpness.value).toBe(0.35);
      expect(mat.uniforms.outlineSide.value).toBe(0.0);
      expect(outMesh.userData.outlineModifier.outlineSide).toBe(0.0);

      // Test "inside"
      const resInside = MODIFIER_OUTLINE_NODE.evaluate(
        { geometry: mesh, outlineSide: "inside" },
        {},
        CTX
      );
      const matInside = (resInside.geometry as THREE.Mesh).material as THREE.ShaderMaterial;
      expect(matInside.uniforms.outlineSide.value).toBe(1.0);
      expect((resInside.geometry as THREE.Mesh).userData.outlineModifier.outlineSide).toBe(1.0);

      // Test "center"
      const resCenter = MODIFIER_OUTLINE_NODE.evaluate(
        { geometry: mesh, outlineSide: "center" },
        {},
        CTX
      );
      const matCenter = (resCenter.geometry as THREE.Mesh).material as THREE.ShaderMaterial;
      expect(matCenter.uniforms.outlineSide.value).toBe(2.0);
      expect((resCenter.geometry as THREE.Mesh).userData.outlineModifier.outlineSide).toBe(2.0);
    });
  });

  describe("gizmo and transform propagation (BUG fix)", () => {
    it("propagates position, rotation, and scale from upstream object to modifier output mesh", () => {
      const origMesh = createTestMesh();
      origMesh.position.set(10, 5, -3);
      origMesh.rotation.set(0, Math.PI / 4, 0);
      origMesh.scale.set(2, 2, 2);
      origMesh.updateMatrix();

      const res = MODIFIER_OUTLINE_NODE.evaluate(
        { geometry: origMesh },
        {},
        { ...CTX, nodeId: "node-pose" }
      );

      const outMesh = res.geometry as THREE.Mesh;
      expect(outMesh.position.x).toBeCloseTo(10);
      expect(outMesh.position.y).toBeCloseTo(5);
      expect(outMesh.position.z).toBeCloseTo(-3);
      expect(outMesh.scale.x).toBeCloseTo(2);
      expect(outMesh.scale.y).toBeCloseTo(2);
      expect(outMesh.scale.z).toBeCloseTo(2);

      const matrixElements = Array.from(outMesh.matrix.elements);
      const origElements = Array.from(origMesh.matrix.elements);
      for (let i = 0; i < 16; i++) {
        expect(matrixElements[i]).toBeCloseTo(origElements[i]);
      }
    });

    it("chains transform properly across multiple consecutive modifiers", () => {
      const origMesh = createTestMesh();
      origMesh.position.set(-4, 8, 12);
      origMesh.scale.set(1.5, 1.5, 1.5);
      origMesh.updateMatrix();

      const duoRes = MODIFIER_DUOTONE_NODE.evaluate({ geometry: origMesh }, {}, { ...CTX, nodeId: "duo" });
      const halfRes = MODIFIER_HALFTONE_NODE.evaluate({ geometry: duoRes.geometry }, {}, { ...CTX, nodeId: "half" });
      const outlineRes = MODIFIER_OUTLINE_NODE.evaluate({ geometry: halfRes.geometry }, {}, { ...CTX, nodeId: "out" });

      const finalMesh = outlineRes.geometry as THREE.Mesh;
      expect(finalMesh.position.x).toBeCloseTo(-4);
      expect(finalMesh.position.y).toBeCloseTo(8);
      expect(finalMesh.position.z).toBeCloseTo(12);
      expect(finalMesh.scale.x).toBeCloseTo(1.5);
    });

    it("preserves 3D outlineModifier userData across chained modifiers", () => {
      const origMesh = createTestMesh();
      const outlineRes = MODIFIER_OUTLINE_NODE.evaluate(
        { geometry: origMesh, edgeColor: new THREE.Color(0x00ff00), sharpness: 0.8 },
        {},
        { ...CTX, nodeId: "outline-node" }
      );
      // Chain Duotone after Outline
      const duoRes = MODIFIER_DUOTONE_NODE.evaluate(
        { geometry: outlineRes.geometry },
        {},
        { ...CTX, nodeId: "duo-node" }
      );

      const finalMesh = duoRes.geometry as THREE.Mesh;
      expect(finalMesh.userData.outlineModifier).toBeDefined();
      expect(finalMesh.userData.outlineModifier.is3D).toBe(true);
      expect(finalMesh.userData.outlineModifier.edgeColor.getHexString()).toBe("00ff00");
      expect(finalMesh.userData.outlineModifier.sharpness).toBe(0.8);
      expect(finalMesh.userData.outlineModifier.nodeId).toBe("outline-node");
    });
  });
});


