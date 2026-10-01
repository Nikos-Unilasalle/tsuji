import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import {
  gripPoints,
  MATERIAL_WORN_NODE,
  MATERIAL_WORN_POINTS_NODE,
  MAX_GRIPS,
  prepareWornGeometry,
  WORN_DEBUG_VIEWS,
  WORN_PRESETS,
  wornAgeFactors,
} from "./materialWorn";
import { selectChange } from "../../../windows/ParamPanel";
import { REST_REBAKE_DELAY_MS, wornEdgeDistances, wornEntryOf } from "./worn/wornGeometry";
import { advanceWornAO } from "./worn/wornAO";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MATERIAL_NODE } from "./material";
import { SOLIDIFY_NODE } from "./solidify";
import { BOOLEAN_NODE } from "./boolean";
import { applyMaterialParams } from "./object";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "worn-test" };

describe("MATERIAL_WORN_NODE and Edge Curvature computation", () => {
  it("evaluates MATERIAL_WORN_NODE and creates a custom MeshStandardMaterial with curvature uniforms", () => {
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, CTX);
    expect(res.material).toBeDefined();

    const matParams = res.material as any;
    expect(matParams.customMaterial).toBeInstanceOf(THREE.MeshStandardMaterial);
    const customMat = matParams.customMaterial as THREE.MeshStandardMaterial;

    expect((customMat as any).__isWornMaterial).toBe(true);

    const u = (customMat as any).__wornUniforms;
    expect(u).toBeDefined();
    expect(u.uWearAmount.value).toBe(0.4);
    expect(u.uDirtAmount.value).toBe(0.4);
    expect(u.uContrast.value).toBe(2.0);
  });

  it("extracts and blends 3 connected input materials (base, worn, dirt)", () => {
    const baseMatRes = MATERIAL_NODE.evaluate(
      {},
      { color: new THREE.Color(0xff0000), roughness: 0.7, metalness: 0.2 },
      { time: 0, step: 0, nodeId: "base-mat" }
    );
    const wornMatRes = MATERIAL_NODE.evaluate(
      {},
      { color: new THREE.Color(0xffd700), roughness: 0.1, metalness: 0.95 },
      { time: 0, step: 0, nodeId: "worn-mat" }
    );
    const dirtMatRes = MATERIAL_NODE.evaluate(
      {},
      { color: new THREE.Color(0x111111), roughness: 0.9, metalness: 0.0 },
      { time: 0, step: 0, nodeId: "dirt-mat" }
    );

    const res = MATERIAL_WORN_NODE.evaluate(
      {
        base: baseMatRes.material,
        worn: wornMatRes.material,
        dirt: dirtMatRes.material,
        wearAmount: 0.6,
        dirtAmount: 0.3,
      },
      MATERIAL_WORN_NODE.defaultParams,
      CTX
    );

    const customMat = (res.material as any).customMaterial;
    const u = customMat.__wornUniforms;

    expect(u.uBaseColor.value.getHexString()).toBe("ff0000");
    expect(u.uBaseRoughness.value).toBeCloseTo(0.7);
    expect(u.uBaseMetalness.value).toBeCloseTo(0.2);

    expect(u.uWornColor.value.getHexString()).toBe("ffd700");
    expect(u.uWornRoughness.value).toBeCloseTo(0.1);
    expect(u.uWornMetalness.value).toBeCloseTo(0.95);

    expect(u.uDirtColor.value.getHexString()).toBe("111111");
    expect(u.uWearAmount.value).toBeCloseTo(0.6);
    expect(u.uDirtAmount.value).toBeCloseTo(0.3);
  });

  it("drives the fractal noise, surface variation and seed uniforms", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { noiseDetail: 4, variation: 0.7, seed: 7 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-noise" },
    );
    const u = (res.material as any).customMaterial.__wornUniforms;
    expect(u.uNoiseDetail.value).toBe(4);
    expect(u.uVariation.value).toBeCloseTo(0.7);

    // Two seeds have to land on different parts of the noise field, or every
    // object in the scene wears along an identical pattern.
    const offset7 = u.uSeedOffset.value.clone();
    const res1 = MATERIAL_WORN_NODE.evaluate(
      { seed: 1 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-noise-2" },
    );
    const offset1 = (res1.material as any).customMaterial.__wornUniforms.uSeedOffset.value;
    expect(offset7.distanceTo(offset1)).toBeGreaterThan(1);
  });

  it("drives the discrete patch masks for wear and dirt independently", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { wearPatch: 0.8, dirtPatch: 0.2, patchScale: 9 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-patch" },
    );
    const u = (res.material as any).customMaterial.__wornUniforms;
    expect(u.uWearPatch.value).toBeCloseTo(0.8);
    expect(u.uDirtPatch.value).toBeCloseTo(0.2);
    expect(u.uPatchScale.value).toBeCloseTo(9);
  });

  it("clamps the patch amounts to 0-1", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { wearPatch: 5, dirtPatch: -3 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-patch-clamp" },
    );
    const u = (res.material as any).customMaterial.__wornUniforms;
    expect(u.uWearPatch.value).toBe(1);
    expect(u.uDirtPatch.value).toBe(0);
  });

  it("clamps Noise Detail to the octave count the shader loop is unrolled to", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { noiseDetail: 99 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-detail-clamp" },
    );
    expect((res.material as any).customMaterial.__wornUniforms.uNoiseDetail.value).toBe(4);
  });

  describe("per-vertex curvature", () => {
    const range = (geometry: THREE.BufferGeometry) => {
      const a = prepareWornGeometry(geometry).getAttribute("aWornSurface");
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (let i = 0; i < a.count; i++) {
        const v = a.getX(i);
        min = Math.min(min, v);
        max = Math.max(max, v);
        sum += v;
      }
      return { min, max, mean: sum / a.count };
    };

    it("is zero on a flat surface", () => {
      const flat = range(new THREE.PlaneGeometry(2, 2, 8, 8));
      expect(Math.abs(flat.min)).toBeLessThan(1e-4);
      expect(Math.abs(flat.max)).toBeLessThan(1e-4);
    });

    it("reads the same on a sphere whatever its tessellation — and whatever its size", () => {
      // Curvature × size: 1/R × 2R = 2 for every sphere. A dihedral measure
      // fades as a mesh is subdivided; an absolute one changes with scale.
      // This does neither, so the same settings weather a marble and a planet.
      expect(range(new THREE.SphereGeometry(0.5, 24, 16)).mean).toBeCloseTo(2, 1);
      expect(range(new THREE.SphereGeometry(0.5, 64, 48)).mean).toBeCloseTo(2, 1);
      expect(range(new THREE.SphereGeometry(20, 32, 24)).mean).toBeCloseTo(2, 1);
    });

    it("is negative inside a concave surface", () => {
      const bowl = new THREE.SphereGeometry(0.5, 24, 16).toNonIndexed();
      const pos = bowl.getAttribute("position") as THREE.BufferAttribute;
      for (let t = 0; t < pos.count / 3; t++) {
        const i = t * 3;
        const j = t * 3 + 2;
        for (const axis of ["X", "Y", "Z"] as const) {
          const a = pos[`get${axis}`](i);
          const b = pos[`get${axis}`](j);
          pos[`set${axis}`](i, b);
          pos[`set${axis}`](j, a);
        }
      }
      expect(range(bowl).mean).toBeCloseTo(-2, 1);
    });

    it("drives the curvature wear/dirt uniforms", () => {
      const res = MATERIAL_WORN_NODE.evaluate(
        { curveWear: 0.9, curveDirt: 0.1, curveSensitivity: 2.5 },
        MATERIAL_WORN_NODE.defaultParams,
        { time: 0, step: 0, nodeId: "worn-curve" },
      );
      const u = (res.material as any).customMaterial.__wornUniforms;
      expect(u.uCurveWear.value).toBeCloseTo(0.9);
      expect(u.uCurveDirt.value).toBeCloseTo(0.1);
      expect(u.uCurveSensitivity.value).toBeCloseTo(2.5);
    });
  });

  it("survives a modifier that inherits the source mesh's material", () => {
    // A modifier assigning `mesh.material = srcMesh.material` by hand used to
    // skip the material's geometry hook, so the worn shader landed on geometry
    // without its data and the node looked like it did nothing at all.
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, CTX);
    const customMat = (res.material as any).customMaterial as THREE.Material;

    const source = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    applyMaterialParams(source, res.material as any);
    expect(source.geometry.getAttribute("aWornList")).toBeDefined();

    const solidified = SOLIDIFY_NODE.evaluate(
      { geometry: source },
      { ...SOLIDIFY_NODE.defaultParams },
      { time: 0, step: 0, nodeId: "worn-solidify" },
    );
    const out = solidified.geometry as THREE.Mesh;
    expect(out.material).toBe(customMat);
    expect(out.geometry.getAttribute("aWornList")).toBeDefined();
  });

  describe("feature edges", () => {
    const entryFor = (geometry: THREE.BufferGeometry) => wornEntryOf(prepareWornGeometry(geometry))!;
    const angles = (entry: ReturnType<typeof entryFor>) =>
      Array.from({ length: entry.featureEdges }, (_, e) => entry.data.edges[e * 8 + 3]);

    it("finds a box's 12 convex edges, and nothing across its faces' diagonals", () => {
      const entry = entryFor(new THREE.BoxGeometry(2, 2, 2));
      const a = angles(entry);
      expect(a).toHaveLength(12);
      for (const angle of a) expect(angle).toBeCloseTo(90, 3);
      // Every triangle knows its own two box edges.
      for (let t = 0; t < 12; t++) expect(entry.data.listCounts[t]).toBeGreaterThanOrEqual(2);
    });

    it("signs a concave inner corner negative", () => {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]), 3));
      const a = angles(entryFor(geom));
      expect(a).toHaveLength(1);
      expect(a[0]).toBeCloseTo(-90, 3);
    });

    it("finds none on a flat, subdivided plane", () => {
      expect(entryFor(new THREE.PlaneGeometry(4, 4, 6, 6)).featureEdges).toBe(0);
    });

    it("runs a wear band across as many triangles as its width covers, not just the first row", () => {
      // An 8 × 8 box face: a triangle three rows in from an edge still sees
      // that edge, at its true distance — before, only the edge's own
      // triangles did, so a dense mesh capped every band at one row.
      const box = new THREE.BoxGeometry(1, 1, 1, 8, 8, 8);
      const prepared = prepareWornGeometry(box);
      const entry = wornEntryOf(prepared)!;
      const rest = prepared.getAttribute("aWornRest");
      let checked = 0;
      for (let t = 0; t < rest.count / 3; t++) {
        const c = [0, 1, 2].map((k) => [0, 1, 2].reduce((s, i) => s + rest.getComponent(t * 3 + i, k), 0) / 3) as [number, number, number];
        // Top face, centre row across x, 2–4 rows (of 1/8) in from the +x edge.
        if (Math.abs(c[1] - 0.5) > 1e-6 || Math.abs(c[2]) > 0.07) continue;
        const fromEdge = 0.5 - c[0];
        if (fromEdge < 0.2 || fromEdge > 0.4) continue;
        expect(wornEdgeDistances(entry, t, c).convex).toBeCloseTo(fromEdge, 5);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("gives a corner every edge that meets there, so they add up", () => {
      const prepared = prepareWornGeometry(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4));
      const entry = wornEntryOf(prepared)!;
      const rest = prepared.getAttribute("aWornRest");
      // The top-face triangle at the (+x, +z) corner.
      for (let t = 0; t < rest.count / 3; t++) {
        const pts = [0, 1, 2].map((i) => [rest.getX(t * 3 + i), rest.getY(t * 3 + i), rest.getZ(t * 3 + i)]);
        if (!pts.every((p) => Math.abs(p[1] - 0.5) < 1e-6)) continue;
        if (!pts.some((p) => Math.abs(p[0] - 0.5) < 1e-6 && Math.abs(p[2] - 0.5) < 1e-6)) continue;
        const near = new Set<number>();
        for (let i = 0; i < entry.data.listCounts[t]; i++) near.add(entry.data.lists[entry.data.listStarts[t] * 4 + i]);
        // Two top edges and the vertical one down from the corner.
        expect(near.size).toBeGreaterThanOrEqual(3);
        return;
      }
      throw new Error("no corner triangle found");
    });

    it("measures in the object's own size: a box ten times bigger weathers the same", () => {
      const small = entryFor(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2));
      const big = entryFor(new THREE.BoxGeometry(10, 10, 10, 2, 2, 2));
      expect(big.featureEdges).toBe(small.featureEdges);
      for (let i = 0; i < small.data.edges.length; i++) expect(big.data.edges[i]).toBeCloseTo(small.data.edges[i], 5);
    });

    it("does not streak a flat panel with false edges around a Boolean cutout's retriangulation seams", () => {
      // A CSG library computes cut-boundary vertices independently on each
      // side of a re-triangulated region, a few ULPs apart. No edge lying in
      // the flat top of the panel may read as a feature, bar its real rims.
      function boxAt(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.Mesh {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshStandardMaterial());
        mesh.matrixAutoUpdate = false;
        mesh.matrix.makeTranslation(x, y, z);
        mesh.updateMatrixWorld(true);
        return mesh;
      }
      const res = BOOLEAN_NODE.evaluate(
        { geometry: boxAt(0, 0, 0, 6, 2, 3), boolean: boxAt(0, 0.5, 1.5, 2, 1, 1), operation: "subtract" },
        { ...BOOLEAN_NODE.defaultParams, useGroups: false },
        { ...CTX, nodeId: "worn-after-boolean" },
      );
      const entry = entryFor((res.geometry as THREE.Mesh).geometry);
      const size = entry.size;
      for (let e = 0; e < entry.featureEdges; e++) {
        const o = e * 8;
        const a = [entry.data.edges[o] * size, entry.data.edges[o + 1] * size, entry.data.edges[o + 2] * size];
        const b = [entry.data.edges[o + 4] * size, entry.data.edges[o + 5] * size, entry.data.edges[o + 6] * size];
        const onTop = Math.abs(a[1] - 1) < 1e-3 && Math.abs(b[1] - 1) < 1e-3;
        if (!onTop) continue;
        const outerRim = [a, b].every((p) => Math.abs(p[0]) > 2.99) || [a, b].every((p) => Math.abs(p[2]) > 1.49);
        // The cutter reaches the panel's top, so it opens a notch there: its
        // near rim (z = 1) and its two sides (x = ±1, z from 1 to 1.5) are real.
        const cutoutRim =
          [a, b].every((p) => Math.abs(p[2] - 1) < 1e-3 && Math.abs(p[0]) <= 1 + 1e-3) ||
          [a, b].every((p) => Math.abs(Math.abs(p[0]) - 1) < 1e-3 && p[2] >= 1 - 1e-3);
        expect(outerRim || cutoutRim, `edge ${a} – ${b}`).toBe(true);
      }
    });
  });

  describe("deformation and re-baking", () => {
    it("keeps the weathering glued to the rest pose while the shape moves, and re-bakes once it settles", () => {
      const box = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
      const first = prepareWornGeometry(box, { now: 0, owner: "mesh-a" });
      const rest = Float32Array.from(first.getAttribute("aWornRest").array as Float32Array);

      // Same topology, moved positions (an animated modifier's next frame).
      const moved = box.clone();
      moved.scale(1.5, 1, 1);
      const second = prepareWornGeometry(moved, { now: 16, owner: "mesh-a" });
      expect(second).toBe(first);
      expect(second.getAttribute("position").getX(0)).toBeCloseTo(box.getAttribute("position").getX(box.getIndex()!.getX(0)) * 1.5);
      expect(Array.from(second.getAttribute("aWornRest").array as Float32Array)).toEqual(Array.from(rest));

      // Still moving: no re-bake. Held still past the delay: a fresh bake for the new shape.
      expect(prepareWornGeometry(moved, { now: 100, owner: "mesh-a" })).toBe(first);
      const settled = prepareWornGeometry(moved, { now: 16 + REST_REBAKE_DELAY_MS + 1, owner: "mesh-a" });
      expect(settled).not.toBe(first);
      expect(wornEntryOf(settled)!.size).toBeCloseTo(1.5);
    });

    it("never hands one mesh's bake to a different mesh of the same topology", () => {
      // Two boxes with the same segment counts and different sizes: sharing
      // one prepared geometry drew both with the shape of the last one.
      const a = prepareWornGeometry(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2), { owner: "box-a" });
      const b = prepareWornGeometry(new THREE.BoxGeometry(3, 1, 1, 2, 2, 2), { owner: "box-b" });
      const c = prepareWornGeometry(new THREE.BoxGeometry(2, 1, 1, 2, 2, 2));
      expect(b).not.toBe(a);
      expect(c).not.toBe(a);
      a.computeBoundingBox();
      b.computeBoundingBox();
      expect(a.boundingBox!.max.x).toBeCloseTo(0.5);
      expect(b.boundingBox!.max.x).toBeCloseTo(1.5);
    });
  });

  describe("occlusion", () => {
    it("finds the cavity: a floor point against a wall sees less sky than one out in the open", () => {
      // A floor (y = 0, facing up) and a wall (x = 0, facing +x), both 2 × 2, subdivided.
      const floor = new THREE.PlaneGeometry(2, 2, 8, 8).rotateX(-Math.PI / 2).translate(1, 0, 0);
      const wall = new THREE.PlaneGeometry(2, 2, 8, 8).rotateY(Math.PI / 2).translate(0, 1, 0);
      const merged = mergeGeometries([floor.toNonIndexed(), wall.toNonIndexed()])!;
      const prepared = prepareWornGeometry(merged);
      const entry = wornEntryOf(prepared)!;
      while (!advanceWornAO(entry, Infinity));
      const pos = prepared.getAttribute("position");
      const ao = prepared.getAttribute("aWornSurface");
      let inCorner = -1, inOpen = -1;
      for (let i = 0; i < pos.count; i++) {
        const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        if (Math.abs(y) > 1e-6 || Math.abs(z) > 1e-6) continue;
        if (Math.abs(x - 0.25) < 1e-6) inCorner = ao.getY(i);
        if (Math.abs(x - 2) < 1e-6) inOpen = ao.getY(i);
      }
      expect(inCorner).toBeGreaterThanOrEqual(0);
      expect(inOpen).toBeGreaterThan(inCorner + 0.1);
    });
  });

  it("drives Edge Angle, Cavity Dirt and the Debug View", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { edgeAngle: 45, cavityDirt: 0.8 },
      { ...MATERIAL_WORN_NODE.defaultParams, debugView: "occlusion" },
      { time: 0, step: 0, nodeId: "worn-new-params" },
    );
    const u = (res.material as any).customMaterial.__wornUniforms;
    expect(u.uEdgeAngle.value).toBe(45);
    expect(u.uCavityDirt.value).toBeCloseTo(0.8);
    expect(u.uDebugView.value).toBe(WORN_DEBUG_VIEWS.indexOf("occlusion"));
  });

  it("samples the wear in object space by default, so it travels with the mesh", () => {
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, {
      time: 0,
      step: 0,
      nodeId: "worn-space",
    }) as { material: { customMaterial: THREE.Material } };
    const u = (res.material.customMaterial as any).__wornUniforms;

    expect(MATERIAL_WORN_NODE.defaultParams.noiseSpace).toBe("object");
    expect(u.uNoiseSpace.value).toBe(0);
  });

  it("switches to world space on request", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      {},
      { ...MATERIAL_WORN_NODE.defaultParams, noiseSpace: "world" },
      { time: 0, step: 0, nodeId: "worn-space-world" },
    ) as { material: { customMaterial: THREE.Material } };

    expect((res.material.customMaterial as any).__wornUniforms.uNoiseSpace.value).toBe(1);
  });
});

describe("Worn phase B: layers, presets, textures", () => {
  const evalWorn = (params: Record<string, unknown>, inputs: Record<string, unknown> = {}, id = "worn-b") =>
    (MATERIAL_WORN_NODE.evaluate(inputs, { ...MATERIAL_WORN_NODE.defaultParams, ...params }, { time: 0, step: 0, nodeId: id }) as any)
      .material.customMaterial.__wornUniforms;

  it("leaves every new layer off by default, so existing scenes look as they did", () => {
    const u = evalWorn({}, {}, "worn-b-defaults");
    for (const k of ["uPrimerWidth", "uChipHardness", "uChipRelief", "uScratchAmount", "uDustAmount", "uStreakAmount"]) {
      expect(u[k].value, k).toBe(0);
    }
  });

  it("offers a preset per look, each setting the whole look from the same neutral start", () => {
    const field = MATERIAL_WORN_NODE.paramFields!.find((f) => f.id === "preset") as any;
    expect(field.kind).toBe("select");
    expect(field.options[0]).toBe("custom");
    const names = Object.keys(WORN_PRESETS);
    expect(field.options.slice(1)).toEqual(names);
    const keys = Object.keys(WORN_PRESETS[names[0]]).sort();
    for (const name of names) expect(Object.keys(WORN_PRESETS[name]).sort(), name).toEqual(keys);
    // Every key a preset sets is a real param of the node.
    for (const k of keys) expect(k in MATERIAL_WORN_NODE.defaultParams, k).toBe(true);
  });

  it("picking a preset writes its whole look in one change", () => {
    const field = MATERIAL_WORN_NODE.paramFields!.find((f) => f.id === "preset") as any;
    const patch = selectChange(field, "painted metal") as Record<string, unknown>;
    expect(patch.preset).toBe("painted metal");
    expect(patch.primerWidth).toBeCloseTo(0.4);
    expect(selectChange(field, "custom")).toBe("preset");

    const u = evalWorn(patch, {}, "worn-b-preset");
    expect(u.uPrimerWidth.value).toBeCloseTo(0.4);
    expect(u.uChipHardness.value).toBeCloseTo(0.9);
    expect(u.uChipRelief.value).toBeCloseTo(0.6);
    expect(u.uScratchAmount.value).toBeCloseTo(0.3);
  });

  it("binds wired textures, and a white one in their absence", () => {
    const tex = new THREE.Texture({ width: 2, height: 2 } as unknown as HTMLImageElement);
    const wired = evalWorn({}, { baseTexture: tex }, "worn-b-tex");
    expect(wired.uBaseMap.value).toBe(tex);
    const bare = evalWorn({}, {}, "worn-b-notex");
    expect(bare.uBaseMap.value).not.toBe(tex);
    expect(bare.uWornMap.value.image.width).toBe(1);
  });

  it("patches every shader hook it relies on", () => {
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, { time: 0, step: 0, nodeId: "worn-b-hooks" }) as any;
    const mat = res.material.customMaterial as THREE.Material;
    const hooks = ["common", "begin_vertex", "color_fragment", "roughnessmap_fragment", "metalnessmap_fragment", "normal_fragment_maps", "dithering_fragment"];
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: hooks.map((h) => `#include <${h}>`).join("\n"),
      fragmentShader: hooks.map((h) => `#include <${h}>`).join("\n"),
    };
    mat.onBeforeCompile(shader as never, undefined as never);
    for (const needle of ["scratchesWorn", "chipMask", "coreMask", "dustMask", "streakMask", "wornHeight", "wornTriplanar", "textureGrad"]) {
      expect(shader.fragmentShader, needle).toContain(needle);
    }
    expect(shader.vertexShader).toContain("vWornWorldNormal");
    expect(shader.uniforms.uBaseMap).toBeDefined();
  });
});

describe("Worn phase C: age, scale, hands, masks for the graph", () => {
  const evalWorn = (params: Record<string, unknown>, inputs: Record<string, unknown> = {}, id = "worn-c") =>
    (MATERIAL_WORN_NODE.evaluate(inputs, { ...MATERIAL_WORN_NODE.defaultParams, ...params }, { time: 0, step: 0, nodeId: id }) as any)
      .material.customMaterial;

  it("ages every layer from nothing (0) through the look as set (0.5) to ancient (1)", () => {
    const fresh = wornAgeFactors(0);
    for (const [k, v] of Object.entries(fresh)) expect(v, k).toBe(0);
    for (const [k, v] of Object.entries(wornAgeFactors(0.5))) expect(v, k).toBeCloseTo(1);
    const old = wornAgeFactors(1);
    for (const [k, v] of Object.entries(old)) expect(v, k).toBeGreaterThan(1);
    // Scratches come first, streaks last.
    const young = wornAgeFactors(0.2);
    expect(young.scratch).toBeGreaterThan(young.wear);
    expect(young.wear).toBeGreaterThan(young.streak);
  });

  it("drives the amounts from Age, and leaves them as set at the default", () => {
    const look = { scratchAmount: 0.4, dustAmount: 0.3, streakAmount: 0.2 };
    const asSet = evalWorn(look, {}, "worn-c-age-default").__wornUniforms;
    expect(asSet.uWearAmount.value).toBeCloseTo(0.4);
    expect(asSet.uScratchAmount.value).toBeCloseTo(0.4);
    const fresh = evalWorn(look, { age: 0 }, "worn-c-age-0").__wornUniforms;
    for (const k of ["uWearAmount", "uDirtAmount", "uScratchAmount", "uDustAmount", "uStreakAmount", "uCavityDirt", "uCurveWear", "uVariation"]) {
      expect(fresh[k].value, k).toBe(0);
    }
    const ancient = evalWorn({ ...look, age: 1 }, {}, "worn-c-age-1").__wornUniforms;
    expect(ancient.uWearAmount.value).toBeGreaterThan(0.4);
    expect(ancient.uStreakAmount.value).toBeGreaterThan(0.2);
    expect(ancient.uWearPatch.value).toBeLessThan(0.3);
  });

  it("scales the whole weathering with one Scale", () => {
    const u = evalWorn({ scale: 2 }, {}, "worn-c-scale").__wornUniforms;
    expect(u.uWidthScale.value).toBe(2);
    expect(u.uNoiseScale.value).toBeCloseTo(3);
    expect(u.uPatchScale.value).toBeCloseTo(1.25);
    expect(u.uScratchScale.value).toBeCloseTo(9);
    expect(u.uStreakScale.value).toBeCloseTo(2);
    expect(u.uTextureScale.value).toBeCloseTo(0.5);
  });

  it("takes grip points as vectors, objects or a list of them", () => {
    const empty = new THREE.Object3D();
    empty.position.set(1, 2, 3);
    const u = evalWorn({ gripRadius: 0.2 }, { grip: [new THREE.Vector3(0, 1, 0), empty] }, "worn-c-grip").__wornUniforms;
    expect(u.uGripCount.value).toBe(2);
    expect(u.uGrip.value[1].toArray()).toEqual([1, 2, 3, 0.2]);
    expect(gripPoints(Array.from({ length: 9 }, () => new THREE.Vector3()))).toHaveLength(MAX_GRIPS);
    expect(evalWorn({}, {}, "worn-c-nogrip").__wornUniforms.uGripCount.value).toBe(0);
  });

  it("keeps the painted masks off unless asked, and hands the vertex colours to the shader", () => {
    expect(evalWorn({}, {}, "worn-c-paint-off").__wornUniforms.uPaintMask.value).toBe(0);
    expect(evalWorn({ paintMask: true }, {}, "worn-c-paint-on").__wornUniforms.uPaintMask.value).toBe(1);

    const box = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
    const count = box.getAttribute("position").count;
    box.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    const prepared = prepareWornGeometry(box, { owner: "painted" });
    expect(prepared.getAttribute("aWornPaint")).toBe(prepared.getAttribute("color"));

    // Repainted (a new geometry, same shape): the new colours arrive.
    const repainted = box.clone();
    (repainted.getAttribute("color").array as Float32Array).fill(0.25);
    expect(prepareWornGeometry(repainted, { owner: "painted" })).toBe(prepared);
    expect(prepared.getAttribute("aWornPaint").getX(0)).toBeCloseTo(0.25);

    // Painted for the first time after the bake.
    const plain = prepareWornGeometry(new THREE.BoxGeometry(1, 1, 1, 3, 3, 3), { owner: "first-paint" });
    const later = new THREE.BoxGeometry(1, 1, 1, 3, 3, 3);
    later.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(later.getAttribute("position").count * 3).fill(0.5), 3));
    expect(prepareWornGeometry(later, { owner: "first-paint" })).toBe(plain);
    expect(plain.getAttribute("aWornPaint").getX(0)).toBeCloseTo(0.5);
  });

  it("copies as the same Worn look (Edit Mesh copies its material once it has vertex colours)", () => {
    const mat = evalWorn({}, {}, "worn-c-clone");
    const copy = mat.clone();
    expect(copy).not.toBe(mat);
    expect(copy.__isWornMaterial).toBe(true);
    expect(copy.__wornUniforms).toBe(mat.__wornUniforms);
    expect(typeof copy.__prepareGeometry).toBe("function");
  });

  it("patches the bake pass and the new layers into the shader", () => {
    const mat = evalWorn({}, {}, "worn-c-hooks") as THREE.Material;
    const hooks = ["common", "begin_vertex", "project_vertex", "color_fragment", "roughnessmap_fragment", "metalnessmap_fragment", "normal_fragment_maps", "dithering_fragment"];
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: hooks.map((h) => `#include <${h}>`).join("\n"),
      fragmentShader: hooks.map((h) => `#include <${h}>`).join("\n"),
    };
    mat.onBeforeCompile(shader as never, undefined as never);
    for (const needle of ["paintGuard", "impactMask", "gripPolish", "WORN_BAKE", "uBakeChannel"]) {
      expect(shader.fragmentShader, needle).toContain(needle);
    }
    expect(shader.vertexShader).toContain("WORN_BAKE");
    expect(shader.vertexShader).toContain("aWornImpacts");
  });

  describe("Worn Points", () => {
    const wornBox = (id: string, params: Record<string, unknown>) => {
      const res = MATERIAL_WORN_NODE.evaluate({}, { ...MATERIAL_WORN_NODE.defaultParams, ...params }, { time: 0, step: 0, nodeId: id }) as any;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4));
      applyMaterialParams(mesh, res.material);
      return mesh;
    };

    it("scatters points along a box's edges for the wear mask", () => {
      const mesh = wornBox("worn-points-wear", { wearAmount: 0.4, curveWear: 0, wearPatch: 0 });
      const out = MATERIAL_WORN_POINTS_NODE.evaluate({ geometry: mesh }, { ...MATERIAL_WORN_POINTS_NODE.defaultParams, mask: "wear", count: 100, threshold: 0.3 }, CTX) as any;
      expect(out.count).toBe(100);
      for (let i = 0; i < out.count; i++) {
        // Near an edge: at least two coordinates close to the faces.
        const near = [out.xValues[i], out.yValues[i], out.zValues[i]].filter((c: number) => Math.abs(c) > 0.5 - 0.1 - 1e-6);
        expect(near.length).toBeGreaterThanOrEqual(2);
      }
      expect(out.coverage).toBeGreaterThan(0);
      expect(out.coverage).toBeLessThan(1);
    });

    it("is stable for a seed, follows the object in the world, and finds nothing without a Worn material", () => {
      const mesh = wornBox("worn-points-stable", {});
      const params = { ...MATERIAL_WORN_POINTS_NODE.defaultParams, mask: "wear" };
      const a = MATERIAL_WORN_POINTS_NODE.evaluate({ geometry: mesh }, params, CTX) as any;
      const b = MATERIAL_WORN_POINTS_NODE.evaluate({ geometry: mesh }, params, CTX) as any;
      expect(b.xValues).toEqual(a.xValues);
      mesh.position.x = 10;
      const moved = MATERIAL_WORN_POINTS_NODE.evaluate({ geometry: mesh }, params, CTX) as any;
      expect(moved.xValues[0]).toBeCloseTo(a.xValues[0] + 10);
      const bare = new THREE.Mesh(new THREE.BoxGeometry());
      expect((MATERIAL_WORN_POINTS_NODE.evaluate({ geometry: bare }, params, CTX) as any).count).toBe(0);
    });

    it("finds nothing for an object brand new (Age 0)", () => {
      const mesh = wornBox("worn-points-new", { age: 0 });
      const out = MATERIAL_WORN_POINTS_NODE.evaluate({ geometry: mesh }, { ...MATERIAL_WORN_POINTS_NODE.defaultParams, mask: "wear" }, CTX) as any;
      expect(out.count).toBe(0);
    });
  });
});
