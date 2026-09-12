import * as THREE from "three";
import { describe, expect, test, vi } from "vitest";
import {
  GRASS_FIELD_NODE,
  INTERACTION_MAP_NODE,
  TREE_NODE,
  WIND_FIELD_NODE,
  WIND_SWAY_NODE,
  readMapPlacement,
} from "./vegetation";
import { EvalContext } from "../types";
import {
  DEFAULT_WIND,
  WIND_GLSL,
  WIND_UNIFORM_DECL,
  WindFieldDescriptor,
  createWindUniforms,
  isWindField,
  sampleWind,
} from "../../three/vegetation/windField";
import { blurMask, buildGrassGeometry, createRandom } from "../../three/vegetation/grassField";
import { initBvhRaycast } from "../../three/bvh";
import {
  DEFAULT_TREE_PARAMS,
  FOLIAGE_MODE_OPTIONS,
  LEAF_SHAPES,
  MAX_TREE_LEAVES,
  computeLeafHeights,
  resolveFoliageMode,
  MAX_TREE_BRANCHES,
  SPECIES_PROFILES,
  TREE_SPECIES,
  buildBranchGeometry,
  buildLeafMatrices,
  generateTreeSkeleton,
  leafShapeId,
  resolveLeafShape,
} from "../../three/vegetation/treeGenerator";
import { createWindSwayUniforms, isPatchedForSway } from "../../three/vegetation/windSway";
import {
  MAP_UV_GLSL,
  collectPaintPoints,
  interactionFade,
  worldToMapUv,
} from "../../three/vegetation/interactionMap";

function makeContext(nodeId: string, time = 0): EvalContext {
  return { nodeId, time, step: Math.floor(time * 60) };
}

function windField(overrides: Partial<WindFieldDescriptor> = {}): WindFieldDescriptor {
  return { ...DEFAULT_WIND, direction: DEFAULT_WIND.direction.clone(), ...overrides };
}

describe("wind field", () => {
  test("sampleWind is deterministic and finite", () => {
    const field = windField({ phase: 2.5 });
    const a = sampleWind(field, 3, 7);
    const b = sampleWind(field, 3, 7);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(a.y)).toBe(true);
  });

  test("displacement is always parallel to the wind direction", () => {
    const field = windField({ direction: new THREE.Vector2(1, 0), phase: 1.3 });
    for (let x = -20; x < 20; x += 3.7) {
      const wind = sampleWind(field, x, x * 0.4);
      // Direction is +X, so the field can never push along Z.
      expect(Math.abs(wind.y)).toBeLessThan(1e-9);
    }
  });

  test("zero strength means no wind at all", () => {
    const field = windField({ strength: 0, phase: 4 });
    const wind = sampleWind(field, 12, -5);
    expect(wind.length()).toBe(0);
  });

  test("advancing the phase changes the wind — the field is not frozen", () => {
    const still = sampleWind(windField({ phase: 0 }), 5, 5);
    const later = sampleWind(windField({ phase: 3.2 }), 5, 5);
    expect(still.distanceTo(later)).toBeGreaterThan(1e-6);
  });

  test("strength scales the displacement linearly", () => {
    const single = sampleWind(windField({ strength: 1, phase: 1 }), 2, 3);
    const double = sampleWind(windField({ strength: 2, phase: 1 }), 2, 3);
    expect(double.length()).toBeCloseTo(single.length() * 2, 6);
  });

  test("every GLSL wind uniform has a matching entry in createWindUniforms", () => {
    // The CPU and GPU sides are two implementations of one field; a rename on
    // one side that silently misses the other is exactly the bug this catches.
    const declared = [...WIND_UNIFORM_DECL.matchAll(/uniform \w+ (\w+);/g)].map((m) => m[1]);
    const provided = Object.keys(createWindUniforms());
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(provided).toContain(name);
    expect(WIND_GLSL).toContain("vec2 windOffset(vec2 worldXZ)");
  });

  test("isWindField only accepts a real descriptor", () => {
    expect(isWindField(windField())).toBe(true);
    expect(isWindField({ kind: "attractor" })).toBe(false);
    expect(isWindField(null)).toBe(false);
  });
});

describe("physics/wind-field node", () => {
  test("builds a normalised direction from the angle param", () => {
    const out = WIND_FIELD_NODE.evaluate(
      {},
      { ...WIND_FIELD_NODE.defaultParams, angle: 0 },
      makeContext("wind-1"),
    ) as { field: WindFieldDescriptor };
    expect(out.field.direction.length()).toBeCloseTo(1, 6);
    // angle 0 = (sin 0, cos 0) = +Z
    expect(out.field.direction.x).toBeCloseTo(0, 6);
    expect(out.field.direction.y).toBeCloseTo(1, 6);
  });

  test("phase folds time × speed, so a frame is reproducible from its time alone", () => {
    const params = { ...WIND_FIELD_NODE.defaultParams, timeFrequency: 0.25 };
    const out = WIND_FIELD_NODE.evaluate({}, params, makeContext("wind-2", 8)) as { field: WindFieldDescriptor };
    expect(out.field.phase).toBeCloseTo(2, 6);

    const again = WIND_FIELD_NODE.evaluate({}, params, makeContext("wind-2", 8)) as { field: WindFieldDescriptor };
    expect(again.field.phase).toBe(out.field.phase);
  });

  test("the Wind vector output is horizontal and matches the CPU sample", () => {
    const params = { ...WIND_FIELD_NODE.defaultParams, samplePosition: new THREE.Vector3(4, 0, -2) };
    const out = WIND_FIELD_NODE.evaluate({}, params, makeContext("wind-3", 3)) as {
      field: WindFieldDescriptor;
      wind: THREE.Vector3;
      speed: number;
    };
    const expected = sampleWind(out.field, 4, -2);
    expect(out.wind.y).toBe(0);
    expect(out.wind.x).toBeCloseTo(expected.x, 10);
    expect(out.wind.z).toBeCloseTo(expected.y, 10);
    expect(out.speed).toBeCloseTo(expected.length(), 10);
  });

  test("negative strength is clamped rather than inverting the wind", () => {
    const out = WIND_FIELD_NODE.evaluate(
      { strength: -5 },
      WIND_FIELD_NODE.defaultParams,
      makeContext("wind-4"),
    ) as { field: WindFieldDescriptor };
    expect(out.field.strength).toBe(0);
  });
});

describe("grass geometry", () => {
  test("three vertices per blade, one blade per cell", () => {
    const geometry = buildGrassGeometry({ subdivisions: 8, size: 10, seed: 1 });
    expect(geometry.getAttribute("position").count).toBe(8 * 8 * 3);
    expect(geometry.getAttribute("aCorner").count).toBe(8 * 8 * 3);
    expect(geometry.getAttribute("aRandom").count).toBe(8 * 8 * 3);
  });

  test("corners cycle 0/1/2 and a blade's three vertices share a base and a random", () => {
    const geometry = buildGrassGeometry({ subdivisions: 4, size: 8, seed: 3 });
    const corner = geometry.getAttribute("aCorner");
    const random = geometry.getAttribute("aRandom");
    const position = geometry.getAttribute("position");

    for (let blade = 0; blade < 16; blade++) {
      const base = blade * 3;
      expect(corner.getX(base)).toBe(0);
      expect(corner.getX(base + 1)).toBe(1);
      expect(corner.getX(base + 2)).toBe(2);
      expect(random.getX(base)).toBe(random.getX(base + 2));
      expect(position.getX(base)).toBe(position.getX(base + 1));
      expect(position.getZ(base)).toBe(position.getZ(base + 2));
      // Bases sit on the ground; the shader raises the tip.
      expect(position.getY(base)).toBe(0);
    }
  });

  test("blades stay inside the wrapping square", () => {
    const size = 12;
    const geometry = buildGrassGeometry({ subdivisions: 10, size, seed: 7 });
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      expect(Math.abs(position.getX(i))).toBeLessThanOrEqual(size / 2);
      expect(Math.abs(position.getZ(i))).toBeLessThanOrEqual(size / 2);
    }
  });

  test("same seed scatters identically, a different seed does not", () => {
    const a = buildGrassGeometry({ subdivisions: 6, size: 10, seed: 42 });
    const b = buildGrassGeometry({ subdivisions: 6, size: 10, seed: 42 });
    const c = buildGrassGeometry({ subdivisions: 6, size: 10, seed: 43 });

    expect(Array.from(a.getAttribute("position").array)).toEqual(Array.from(b.getAttribute("position").array));
    expect(Array.from(a.getAttribute("position").array)).not.toEqual(Array.from(c.getAttribute("position").array));
  });

  test("a manual bounding sphere is set — the shader relocates every vertex", () => {
    const geometry = buildGrassGeometry({ subdivisions: 4, size: 20, seed: 1 });
    expect(geometry.boundingSphere).not.toBeNull();
    expect(geometry.boundingSphere!.radius).toBe(20);
  });

  test("createRandom is a reproducible stream in [0,1)", () => {
    const first = Array.from({ length: 50 }, createRandom(9));
    const second = Array.from({ length: 50 }, createRandom(9));
    expect(first).toEqual(second);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("structure/grass-field node", () => {
  const params = () => ({ ...GRASS_FIELD_NODE.defaultParams, subdivisions: 8, size: 10 });

  /** A flat plate at `y`, standing in for a terrain. */
  const groundPlate = (y: number, size = 10) => {
    const geometry = new THREE.PlaneGeometry(size, size);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.y = y;
    mesh.updateMatrix();
    return mesh;
  };

  const uniformsOf = (out: { geometry: THREE.Mesh }) =>
    (out.geometry.material as THREE.ShaderMaterial).uniforms;

  test("stands the blades on a Ground mesh when one is wired", () => {
    initBvhRaycast();
    const ground = groundPlate(3.5);
    const out = GRASS_FIELD_NODE.evaluate(
      { ground },
      { ...params(), groundResolution: 16 },
      makeContext("grass-ground"),
    ) as { geometry: THREE.Mesh };
    const u = uniformsOf(out);

    expect(u.uHasGround.value).toBe(1);
    expect(u.uGroundResolution.value).toBe(16);
    expect((u.uGroundSize.value as THREE.Vector2).x).toBeCloseTo(10, 3);

    const data = (u.uGroundMap.value as THREE.DataTexture).image.data as Float32Array;
    // Every texel of a flat plate reads the same height, and every one is a hit.
    expect(data[0]).toBeCloseTo(3.5, 3);
    expect(data[1]).toBe(1);
  });

  test("leaves the field flat when no Ground is wired", () => {
    const out = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-flat")) as { geometry: THREE.Mesh };

    expect(uniformsOf(out).uHasGround.value).toBe(0);
    expect(uniformsOf(out).uGroundMap.value).toBeNull();
  });

  test("rebakes only when the ground actually changes", () => {
    initBvhRaycast();
    const ground = groundPlate(1);
    const ctx = makeContext("grass-rebake");
    const evaluate = () =>
      GRASS_FIELD_NODE.evaluate({ ground }, { ...params(), groundResolution: 16 }, ctx) as { geometry: THREE.Mesh };

    const first = uniformsOf(evaluate()).uGroundMap.value as THREE.DataTexture;
    const again = uniformsOf(evaluate()).uGroundMap.value as THREE.DataTexture;
    expect(again).toBe(first);

    ground.position.y = 6;
    ground.updateMatrix();
    const moved = uniformsOf(evaluate());
    // The texture object is reused; what it holds is not.
    expect(moved.uGroundMap.value).toBe(first);
    expect((first.image.data as Float32Array)[0]).toBeCloseTo(6, 3);
  });

  test("drops the height field when the ground is unwired again", () => {
    initBvhRaycast();
    const ctx = makeContext("grass-unwire");
    GRASS_FIELD_NODE.evaluate({ ground: groundPlate(2) }, { ...params(), groundResolution: 16 }, ctx);
    const out = GRASS_FIELD_NODE.evaluate({}, params(), ctx) as { geometry: THREE.Mesh };

    expect(uniformsOf(out).uHasGround.value).toBe(0);
  });

  test("ignores a Ground input that is not an object", () => {
    const out = GRASS_FIELD_NODE.evaluate({ ground: "terrain" }, params(), makeContext("grass-junk")) as {
      geometry: THREE.Mesh;
    };

    expect(uniformsOf(out).uHasGround.value).toBe(0);
  });

  test("outputs a mesh, a matrix and the blade count", () => {
    const out = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-1")) as {
      geometry: THREE.Mesh;
      matrix: THREE.Matrix4;
      bladeCount: number;
    };
    expect(out.geometry).toBeInstanceOf(THREE.Mesh);
    expect(out.matrix).toBeInstanceOf(THREE.Matrix4);
    expect(out.bladeCount).toBe(64);
    expect(out.geometry.frustumCulled).toBe(false);
  });

  test("re-evaluating reuses the same mesh and geometry instead of rebuilding", () => {
    const first = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-2", 0)) as { geometry: THREE.Mesh };
    const second = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-2", 1)) as { geometry: THREE.Mesh };
    expect(second.geometry).toBe(first.geometry);
    expect(second.geometry.geometry).toBe(first.geometry.geometry);
  });

  test("changing subdivisions rebuilds the geometry but keeps the material", () => {
    const first = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-3")) as { geometry: THREE.Mesh };
    const firstGeometry = first.geometry.geometry;
    const firstMaterial = first.geometry.material;

    const second = GRASS_FIELD_NODE.evaluate(
      {},
      { ...params(), subdivisions: 12 },
      makeContext("grass-3"),
    ) as { geometry: THREE.Mesh; bladeCount: number };

    expect(second.geometry.geometry).not.toBe(firstGeometry);
    // The compiled program is expensive; the buffers are not.
    expect(second.geometry.material).toBe(firstMaterial);
    expect(second.bladeCount).toBe(144);
  });

  test("a wired wind field reaches the shader uniforms", () => {
    const field = windField({ strength: 3, phase: 1.25, positionFrequency: 0.75 });
    const out = GRASS_FIELD_NODE.evaluate({ wind: field }, params(), makeContext("grass-4")) as {
      geometry: THREE.Mesh;
    };
    const material = out.geometry.material as THREE.ShaderMaterial;
    expect(material.uniforms.uWindStrength.value).toBe(3);
    expect(material.uniforms.uWindPhase.value).toBe(1.25);
    expect(material.uniforms.uWindPositionFrequency.value).toBe(0.75);
  });

  test("with no wind wired the field still moves — an unwired node is not a dead one", () => {
    const still = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-5", 0)) as { geometry: THREE.Mesh };
    const phaseAtZero = (still.geometry.material as THREE.ShaderMaterial).uniforms.uWindPhase.value;
    const later = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-5", 10)) as { geometry: THREE.Mesh };
    const phaseLater = (later.geometry.material as THREE.ShaderMaterial).uniforms.uWindPhase.value;
    expect(phaseLater).toBeGreaterThan(phaseAtZero);
  });

  test("the Center input drives the wrap centre on the XZ plane", () => {
    const out = GRASS_FIELD_NODE.evaluate(
      { center: new THREE.Vector3(7, 99, -4) },
      params(),
      makeContext("grass-6"),
    ) as { geometry: THREE.Mesh };
    const center = (out.geometry.material as THREE.ShaderMaterial).uniforms.uCenter.value as THREE.Vector2;
    expect(center.x).toBe(7);
    // Y is dropped: the field wraps horizontally, height is not a coordinate here.
    expect(center.y).toBe(-4);
  });

  test("the ground shadow is authorable — colour and intensity reach the shader", () => {
    const out = GRASS_FIELD_NODE.evaluate(
      {},
      { ...params(), shadowColor: new THREE.Color(0x123456), shadowIntensity: 0.8 },
      makeContext("grass-shadow"),
    ) as { geometry: THREE.Mesh };
    const uniforms = (out.geometry.material as THREE.ShaderMaterial).uniforms;
    expect((uniforms.uShadowColor.value as THREE.Color).getHex()).toBe(0x123456);
    expect(uniforms.uShadowIntensity.value).toBe(0.8);
  });

  test("shadow intensity is clamped — a negative one would brighten the roots", () => {
    const dark = GRASS_FIELD_NODE.evaluate(
      {},
      { ...params(), shadowIntensity: 4 },
      makeContext("grass-shadow-2"),
    ) as { geometry: THREE.Mesh };
    expect((dark.geometry.material as THREE.ShaderMaterial).uniforms.uShadowIntensity.value).toBe(1);

    const lit = GRASS_FIELD_NODE.evaluate(
      {},
      { ...params(), shadowIntensity: -2 },
      makeContext("grass-shadow-2"),
    ) as { geometry: THREE.Mesh };
    expect((lit.geometry.material as THREE.ShaderMaterial).uniforms.uShadowIntensity.value).toBe(0);
  });

  test("the ground shadow output is a texture carrying the density map's placement", () => {
    const texture = new THREE.Texture();
    texture.userData.mapPlacement = { center: new THREE.Vector2(3, -5), size: 22 };
    const out = GRASS_FIELD_NODE.evaluate({ densityMap: texture }, params(), makeContext("grass-ground")) as {
      groundShadow: THREE.Texture | null;
    };

    // Off-DOM (the test runner, and headless export) there is no canvas to
    // draw into, so the node says so rather than inventing a texture.
    if (typeof document === "undefined") {
      expect(out.groundShadow).toBeNull();
      return;
    }
    expect(out.groundShadow).toBeInstanceOf(THREE.Texture);
    expect(out.groundShadow!.userData.mapPlacement).toEqual({ center: new THREE.Vector2(3, -5), size: 22 });
  });

  test("a density map switches the sampling branch on, and its absence off", () => {
    const withoutMap = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-7")) as { geometry: THREE.Mesh };
    expect((withoutMap.geometry.material as THREE.ShaderMaterial).uniforms.uHasDensityMap.value).toBe(0);

    const texture = new THREE.Texture();
    const withMap = GRASS_FIELD_NODE.evaluate({ densityMap: texture }, params(), makeContext("grass-7")) as {
      geometry: THREE.Mesh;
    };
    const material = withMap.geometry.material as THREE.ShaderMaterial;
    expect(material.uniforms.uHasDensityMap.value).toBe(1);
    expect(material.uniforms.uDensityMap.value).toBe(texture);
  });
});

describe("grass ground shadow mask", () => {
  const impulse = (size: number, at: number) => {
    const mask = new Float32Array(size * size);
    mask[at] = 1;
    return mask;
  };

  test("a radius below one pixel leaves the mask alone — nothing to average", () => {
    const mask = impulse(8, 27);
    const out = blurMask(mask, 8, 0.4);
    expect(Array.from(out)).toEqual(Array.from(mask));
    // and it is a copy, so the caller's mask is never mutated under it
    expect(out).not.toBe(mask);
  });

  test("blurring spreads a point outward and conserves its weight", () => {
    const size = 32;
    const centre = 16 * size + 16;
    const mask = impulse(size, centre);
    const out = blurMask(mask, size, 3);

    expect(out[centre]).toBeLessThan(1);
    expect(out[centre]).toBeGreaterThan(0);
    // The neighbours, previously empty, now carry some of it.
    expect(out[centre + 1]).toBeGreaterThan(0);
    expect(out[centre + size]).toBeGreaterThan(0);
    // Away from the edges a box blur is weight-preserving.
    const before = mask.reduce((a, b) => a + b, 0);
    const after = out.reduce((a, b) => a + b, 0);
    expect(after).toBeCloseTo(before, 4);
  });

  test("the blur falls off with distance — a shadow has no hard rim", () => {
    const size = 32;
    const centre = 16 * size + 16;
    const out = blurMask(impulse(size, centre), size, 4);
    expect(out[centre]).toBeGreaterThan(out[centre + 2]);
    expect(out[centre + 2]).toBeGreaterThan(out[centre + 6]);
  });

  test("a fully covered mask stays covered — blurring flat ground changes nothing", () => {
    const mask = new Float32Array(16 * 16).fill(1);
    const out = blurMask(mask, 16, 3);
    // Interior only: the edges see fewer samples by construction.
    expect(out[8 * 16 + 8]).toBeCloseTo(1, 6);
  });
});

describe("tree skeleton", () => {
  const params = { ...DEFAULT_TREE_PARAMS, levels: 2, childCount: 3, segments: 4 };

  test("branch count is the full recursion: 1 + c + c² …", () => {
    const branches = generateTreeSkeleton(params);
    expect(branches.length).toBe(1 + 3 + 9);
  });

  test("every branch has segments + 1 spine points and a tangent for each", () => {
    for (const branch of generateTreeSkeleton(params)) {
      expect(branch.points.length).toBe(params.segments + 1);
      expect(branch.tangents.length).toBe(params.segments + 1);
      for (const tangent of branch.tangents) expect(tangent.length()).toBeCloseTo(1, 6);
    }
  });

  test("the trunk starts at the origin and grows upward", () => {
    const [trunk] = generateTreeSkeleton(params);
    expect(trunk.level).toBe(0);
    expect(trunk.points[0].length()).toBe(0);
    expect(trunk.points[trunk.points.length - 1].y).toBeGreaterThan(params.trunkHeight * 0.5);
  });

  test("branches get thinner with depth", () => {
    const branches = generateTreeSkeleton(params);
    const trunk = branches.find((b) => b.level === 0)!;
    const twig = branches.find((b) => b.level === 2)!;
    expect(twig.radiusStart).toBeLessThan(trunk.radiusStart);
  });

  test("same seed grows the same tree; a different seed does not", () => {
    const a = generateTreeSkeleton({ ...params, seed: 5 });
    const b = generateTreeSkeleton({ ...params, seed: 5 });
    const c = generateTreeSkeleton({ ...params, seed: 6 });

    expect(a[1].points[2].toArray()).toEqual(b[1].points[2].toArray());
    expect(a[1].points[2].toArray()).not.toEqual(c[1].points[2].toArray());
  });

  test("zero levels is a bare trunk, zero children too", () => {
    expect(generateTreeSkeleton({ ...params, levels: 0 }).length).toBe(1);
    expect(generateTreeSkeleton({ ...params, childCount: 0 }).length).toBe(1);
  });

  test("no spine point is NaN even with heavy gnarl and curvature", () => {
    const branches = generateTreeSkeleton({ ...params, gnarl: 2, curvature: 3 });
    for (const branch of branches) {
      for (const point of branch.points) {
        expect(Number.isFinite(point.x + point.y + point.z)).toBe(true);
      }
    }
  });
});

describe("tree meshing", () => {
  const params = { ...DEFAULT_TREE_PARAMS, levels: 1, childCount: 2, segments: 3, radialSegments: 5 };

  test("the tube geometry has one closed ring per spine point", () => {
    const branches = generateTreeSkeleton(params);
    const geometry = buildBranchGeometry(branches, params.radialSegments);
    // sides + 1 vertices per ring: the seam vertex is duplicated for the UV.
    const expected = branches.length * (params.segments + 1) * (params.radialSegments + 1);
    expect(geometry.getAttribute("position").count).toBe(expected);
    expect(geometry.getAttribute("normal").count).toBe(expected);
    expect(geometry.getAttribute("uv").count).toBe(expected);
    expect(geometry.getIndex()).not.toBeNull();
    expect(geometry.boundingSphere).not.toBeNull();
  });

  test("tube normals are unit length — the parallel transport frame stays sane", () => {
    const geometry = buildBranchGeometry(generateTreeSkeleton(params), params.radialSegments);
    const normal = geometry.getAttribute("normal");
    for (let i = 0; i < normal.count; i += 7) {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      expect(length).toBeCloseTo(1, 4);
    }
  });

  test("foliage depth decides how far back from the tips leaves reach", () => {
    const branches = generateTreeSkeleton(params);
    const tips = branches.filter((b) => b.level === params.levels).length;
    const tipsAndParents = branches.filter((b) => b.level >= params.levels - 1).length;

    const shell = buildLeafMatrices(branches, { ...params, leavesPerBranch: 4, leafLevels: 1 });
    expect(shell.length).toBe(tips * 4);

    const crown = buildLeafMatrices(branches, { ...params, leavesPerBranch: 4, leafLevels: 2 });
    expect(crown.length).toBe(tipsAndParents * 4);
    expect(crown.length).toBeGreaterThan(shell.length);
  });

  test("no leaves when the count or the size is zero", () => {
    const branches = generateTreeSkeleton(params);
    expect(buildLeafMatrices(branches, { ...params, leavesPerBranch: 0 }).length).toBe(0);
    expect(buildLeafMatrices(branches, { ...params, leafSize: 0 }).length).toBe(0);
  });
});

describe("object/tree node", () => {
  const params = () => ({
    ...TREE_NODE.defaultParams,
    levels: 2,
    childCount: 2,
    segments: 3,
    radialSegments: 5,
  });

  test("outputs a group holding the bark mesh and the leaf instances", () => {
    const out = TREE_NODE.evaluate({}, params(), makeContext("tree-1")) as {
      geometry: THREE.Group;
      tips: THREE.Vector3[];
      branchCount: number;
    };
    expect(out.geometry).toBeInstanceOf(THREE.Group);

    const meshes = out.geometry.children;
    expect(meshes.some((child) => child instanceof THREE.InstancedMesh)).toBe(true);
    expect(meshes.some((child) => child instanceof THREE.Mesh && !(child instanceof THREE.InstancedMesh))).toBe(true);

    expect(out.branchCount).toBe(1 + 2 + 4);
    expect(out.tips.length).toBe(out.branchCount);
  });

  test("branch tips come back as world-space-ready vectors, cloned per evaluation", () => {
    const first = TREE_NODE.evaluate({}, params(), makeContext("tree-2")) as { tips: THREE.Vector3[] };
    const second = TREE_NODE.evaluate({}, params(), makeContext("tree-2")) as { tips: THREE.Vector3[] };
    expect(second.tips[0]).not.toBe(first.tips[0]);
    expect(second.tips[0].toArray()).toEqual(first.tips[0].toArray());
  });

  test("re-evaluating with unchanged shape params does not rebuild the geometry", () => {
    const first = TREE_NODE.evaluate({}, params(), makeContext("tree-3", 0)) as { geometry: THREE.Group };
    const barkFirst = first.geometry.children.find((c) => !(c instanceof THREE.InstancedMesh)) as THREE.Mesh;

    const second = TREE_NODE.evaluate({}, params(), makeContext("tree-3", 1)) as { geometry: THREE.Group };
    const barkSecond = second.geometry.children.find((c) => !(c instanceof THREE.InstancedMesh)) as THREE.Mesh;

    expect(second.geometry).toBe(first.geometry);
    expect(barkSecond.geometry).toBe(barkFirst.geometry);
  });

  test("changing the seed regrows the tree", () => {
    const first = TREE_NODE.evaluate({}, params(), makeContext("tree-4")) as { tips: THREE.Vector3[] };
    const second = TREE_NODE.evaluate({}, { ...params(), seed: 99 }, makeContext("tree-4")) as {
      tips: THREE.Vector3[];
    };
    expect(second.tips[1].toArray()).not.toEqual(first.tips[1].toArray());
  });

  test("wind reaches both the bark and the leaf materials", () => {
    const field = windField({ strength: 2.5, phase: 0.75 });
    const out = TREE_NODE.evaluate({ wind: field }, params(), makeContext("tree-5")) as { geometry: THREE.Group };

    const leaves = out.geometry.children.find((c) => c instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
    const leafMaterial = leaves.material as THREE.ShaderMaterial;
    expect(leafMaterial.uniforms.uWindStrength.value).toBe(2.5);
    expect(leafMaterial.uniforms.uWindPhase.value).toBe(0.75);

    const bark = out.geometry.children.find((c) => !(c instanceof THREE.InstancedMesh)) as THREE.Mesh;
    expect(isPatchedForSway(bark.material as THREE.Material, "tree-5")).toBe(true);
  });

  test("an absurd levels × children cannot hang the graph", () => {
    // Clamping each input alone is not enough — it is their product that
    // explodes — so the generator stops at a hard branch budget.
    const out = TREE_NODE.evaluate(
      { levels: 50, childCount: 50 },
      params(),
      makeContext("tree-6"),
    ) as { branchCount: number };
    expect(out.branchCount).toBeLessThanOrEqual(MAX_TREE_BRANCHES);
  });
});

describe("geometry/wind-sway node", () => {
  function makeMesh(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 4, 1).translate(0, 2, 0),
      new THREE.MeshStandardMaterial({ color: 0x00ff00 }),
    );
    return mesh;
  }

  test("swaps in a patched clone rather than touching the incoming material", () => {
    const mesh = makeMesh();
    const original = mesh.material as THREE.Material;

    WIND_SWAY_NODE.evaluate({ geometry: mesh }, WIND_SWAY_NODE.defaultParams, makeContext("sway-1"));

    expect(mesh.material).not.toBe(original);
    expect(isPatchedForSway(mesh.material as THREE.Material, "sway-1")).toBe(true);
    // The upstream material is left exactly as it was, for whoever else shares it.
    expect(isPatchedForSway(original, "sway-1")).toBe(false);
  });

  test("re-evaluating is a no-op, not a fresh clone every frame", () => {
    const mesh = makeMesh();
    WIND_SWAY_NODE.evaluate({ geometry: mesh }, WIND_SWAY_NODE.defaultParams, makeContext("sway-2", 0));
    const patched = mesh.material;
    WIND_SWAY_NODE.evaluate({ geometry: mesh }, WIND_SWAY_NODE.defaultParams, makeContext("sway-2", 1));
    expect(mesh.material).toBe(patched);
  });

  test("auto height reads the mask range off the geometry bounds", () => {
    const mesh = makeMesh();
    const out = WIND_SWAY_NODE.evaluate(
      { geometry: mesh },
      { ...WIND_SWAY_NODE.defaultParams, autoHeight: true },
      makeContext("sway-3"),
    ) as { geometry: THREE.Object3D };

    const material = (out.geometry as THREE.Mesh).material as THREE.Material;
    const uniforms = createWindSwayUniforms();
    // Rebuild the shader to read what the node wrote into the shared uniforms.
    const shader = { uniforms: uniforms as any, vertexShader: "void main() {\n#include <begin_vertex>\n}", fragmentShader: "" };
    material.onBeforeCompile!(shader as any, {} as any);
    expect(shader.uniforms.uSwayAnchorY.value).toBe(0);
    expect(shader.uniforms.uSwayHeight.value).toBe(4);
  });

  test("manual height wins when auto is off", () => {
    const mesh = makeMesh();
    const out = WIND_SWAY_NODE.evaluate(
      { geometry: mesh, anchorY: 1, height: 9 },
      { ...WIND_SWAY_NODE.defaultParams, autoHeight: false },
      makeContext("sway-4"),
    ) as { geometry: THREE.Object3D };

    const material = (out.geometry as THREE.Mesh).material as THREE.Material;
    const shader = { uniforms: {} as any, vertexShader: "void main() {\n#include <begin_vertex>\n}", fragmentShader: "" };
    material.onBeforeCompile!(shader as any, {} as any);
    expect(shader.uniforms.uSwayAnchorY.value).toBe(1);
    expect(shader.uniforms.uSwayHeight.value).toBe(9);
  });

  test("the injected chunk declares the wind and displaces after begin_vertex", () => {
    const mesh = makeMesh();
    WIND_SWAY_NODE.evaluate({ geometry: mesh }, WIND_SWAY_NODE.defaultParams, makeContext("sway-5"));

    const shader = { uniforms: {} as any, vertexShader: "void main() {\n#include <begin_vertex>\n}", fragmentShader: "" };
    (mesh.material as THREE.Material).onBeforeCompile!(shader as any, {} as any);

    expect(shader.vertexShader).toContain("uniform vec2 uWindDirection;");
    expect(shader.vertexShader).toContain("windOffset(swayWorld.xz)");
    expect(shader.vertexShader.indexOf("#include <begin_vertex>")).toBeLessThan(
      shader.vertexShader.indexOf("transformed = (uSwayMatrixInverse"),
    );
  });

  test("passes a non-object through untouched instead of throwing", () => {
    const out = WIND_SWAY_NODE.evaluate({ geometry: 42 }, WIND_SWAY_NODE.defaultParams, makeContext("sway-6"));
    expect(out.geometry).toBe(42);
  });

  test("a multi-material mesh gets every slot patched", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshBasicMaterial(),
    ]);
    WIND_SWAY_NODE.evaluate({ geometry: mesh }, WIND_SWAY_NODE.defaultParams, makeContext("sway-7"));
    for (const material of mesh.material as THREE.Material[]) {
      expect(isPatchedForSway(material, "sway-7")).toBe(true);
    }
  });
});

describe("interaction map maths", () => {
  const center = new THREE.Vector2(10, -4);

  test("the map centre is the middle of the texture", () => {
    const uv = worldToMapUv(center.x, center.y, center, 20);
    expect(uv.x).toBeCloseTo(0.5, 10);
    expect(uv.y).toBeCloseTo(0.5, 10);
  });

  test("+X goes right and +Z goes DOWN the image — the top-down flip is deliberate", () => {
    // A top-down camera necessarily mirrors one axis. v is the mirrored one so
    // that v = 1 is north, which is how a map image reads.
    expect(worldToMapUv(center.x + 5, center.y, center, 20).x).toBeGreaterThan(0.5);
    expect(worldToMapUv(center.x, center.y + 5, center, 20).y).toBeLessThan(0.5);
    expect(worldToMapUv(center.x, center.y - 5, center, 20).y).toBeGreaterThan(0.5);
  });

  test("the map edge is exactly uv 0 and 1", () => {
    const corner = worldToMapUv(center.x - 10, center.y + 10, center, 20);
    expect(corner.x).toBeCloseTo(0, 10);
    expect(corner.y).toBeCloseTo(0, 10);
  });

  test("the GLSL twin exists and is what the shaders include", () => {
    expect(MAP_UV_GLSL).toContain("vec2 mapUv(vec2 worldXZ, vec2 mapCenter, float mapSize)");
    expect(MAP_UV_GLSL).toContain("float mapInside(vec2 uv)");
  });

  test("fade is a half-life: one half-life leaves half the mark", () => {
    expect(interactionFade(2, 2)).toBeCloseTo(0.5, 10);
    expect(interactionFade(2, 4)).toBeCloseTo(0.25, 10);
  });

  test("fade is frame-rate independent — two half-steps equal one whole step", () => {
    // The bug this pins: a per-frame constant would erase tracks faster on a
    // 144Hz machine than on a 30Hz one.
    const oneStep = interactionFade(3, 1);
    const twoHalfSteps = interactionFade(3, 0.5) * interactionFade(3, 0.5);
    expect(twoHalfSteps).toBeCloseTo(oneStep, 10);
  });

  test("a zero half-life never fades — the map becomes a drawing surface", () => {
    expect(interactionFade(0, 100)).toBe(1);
  });
});

describe("collectPaintPoints", () => {
  test("an object contributes its own position and each mesh under it", () => {
    const group = new THREE.Group();
    group.position.set(1, 0, 1);
    const footA = new THREE.Mesh(new THREE.BoxGeometry());
    footA.position.set(-0.5, 0, 0);
    const footB = new THREE.Mesh(new THREE.BoxGeometry());
    footB.position.set(0.5, 0, 0);
    group.add(footA, footB);

    const points = collectPaintPoints(group, undefined);
    // Group origin plus two feet, in world space.
    expect(points.length).toBe(3);
    expect(points.map((p) => p.x).sort()).toEqual([0.5, 1, 1.5]);
  });

  test("meshes stacked at one spot do not each burn a brush slot", () => {
    const group = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry());
    const b = new THREE.Mesh(new THREE.BoxGeometry());
    group.add(a, b);
    expect(collectPaintPoints(group, undefined).length).toBe(1);
  });

  test("a list of vectors paints too, and junk in it is ignored", () => {
    const points = collectPaintPoints(undefined, [
      new THREE.Vector3(1, 0, 2),
      "not a point",
      null,
      new THREE.Vector3(3, 0, 4),
    ]);
    expect(points.length).toBe(2);
  });

  test("nothing wired paints nothing", () => {
    expect(collectPaintPoints(undefined, undefined)).toEqual([]);
  });

  test("list points are cloned, so the map cannot move a caller's vector", () => {
    const source = new THREE.Vector3(1, 2, 3);
    const [copy] = collectPaintPoints(undefined, [source]);
    expect(copy).not.toBe(source);
    expect(copy.toArray()).toEqual(source.toArray());
  });
});

describe("texture/interaction-map node", () => {
  test("degrades to no texture without a renderer, and still reports what it would paint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = INTERACTION_MAP_NODE.evaluate(
      { positions: [new THREE.Vector3(1, 0, 1), new THREE.Vector3(2, 0, 2)] },
      INTERACTION_MAP_NODE.defaultParams,
      makeContext("map-1"),
    ) as { texture: THREE.Texture | null; count: number; size: number };

    expect(out.texture).toBeNull();
    expect(out.count).toBe(2);
    expect(out.size).toBe(40);

    // Once, not once per frame.
    INTERACTION_MAP_NODE.evaluate({}, INTERACTION_MAP_NODE.defaultParams, makeContext("map-1", 1));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("the Center output drops back out as a vector for whoever else needs it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = INTERACTION_MAP_NODE.evaluate(
      { center: new THREE.Vector3(5, 0, -3) },
      INTERACTION_MAP_NODE.defaultParams,
      makeContext("map-2"),
    ) as { center: THREE.Vector3 };
    expect(out.center.toArray()).toEqual([5, 0, -3]);
    warn.mockRestore();
  });
});

describe("readMapPlacement", () => {
  test("a stamped texture wins over the consumer's params — one wire, not three", () => {
    const texture = new THREE.Texture();
    texture.userData.mapPlacement = { center: new THREE.Vector2(7, 8), size: 25 };

    const placement = readMapPlacement(texture, new THREE.Vector2(0, 0), 40);
    expect(placement.center.toArray()).toEqual([7, 8]);
    expect(placement.size).toBe(25);
  });

  test("a plain image map falls back to the params, since it carries no stamp", () => {
    const placement = readMapPlacement(new THREE.Texture(), new THREE.Vector2(1, 2), 30);
    expect(placement.center.toArray()).toEqual([1, 2]);
    expect(placement.size).toBe(30);
  });

  test("no texture at all falls back too", () => {
    expect(readMapPlacement(null, new THREE.Vector2(3, 4), 12).size).toBe(12);
  });
});

describe("grass field × trample map", () => {
  const params = () => ({ ...GRASS_FIELD_NODE.defaultParams, subdivisions: 8, size: 10 });

  test("a trample map switches the branch on and follows the map's own placement", () => {
    const texture = new THREE.Texture();
    texture.userData.mapPlacement = { center: new THREE.Vector2(12, -6), size: 30 };

    const out = GRASS_FIELD_NODE.evaluate({ trampleMap: texture }, params(), makeContext("grass-t1")) as {
      geometry: THREE.Mesh;
    };
    const uniforms = (out.geometry.material as THREE.ShaderMaterial).uniforms;

    expect(uniforms.uHasTrampleMap.value).toBe(1);
    expect(uniforms.uTrampleMap.value).toBe(texture);
    // Params said 40 at the origin; the live map overrides both.
    expect(uniforms.uTrampleSize.value).toBe(30);
    expect((uniforms.uTrampleCenter.value as THREE.Vector2).toArray()).toEqual([12, -6]);
  });

  test("no trample map means no trampling", () => {
    const out = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-t2")) as { geometry: THREE.Mesh };
    expect((out.geometry.material as THREE.ShaderMaterial).uniforms.uHasTrampleMap.value).toBe(0);
  });

  test("the vertex shader folds the blade over rather than shrinking it", () => {
    const out = GRASS_FIELD_NODE.evaluate({}, params(), makeContext("grass-t3")) as { geometry: THREE.Mesh };
    const shader = (out.geometry.material as THREE.ShaderMaterial).vertexShader;
    expect(shader).toContain("vec3 fold = vec3(cos(foldAngle), 0.0, sin(foldAngle))");
    expect(shader).toContain("mapUv(world, uTrampleCenter, uTrampleSize)");
  });
});

describe("tree species", () => {
  const base = { ...DEFAULT_TREE_PARAMS, levels: 3, childCount: 3, segments: 4 };
  const height = (params: typeof base) => {
    let top = 0;
    for (const branch of generateTreeSkeleton(params)) {
      for (const point of branch.points) top = Math.max(top, point.y);
    }
    return top;
  };

  test("every species grows a finite, non-empty tree", () => {
    for (const species of TREE_SPECIES) {
      const branches = generateTreeSkeleton({ ...base, species });
      expect(branches.length).toBeGreaterThan(0);
      for (const branch of branches) {
        for (const point of branch.points) {
          expect(Number.isFinite(point.x + point.y + point.z)).toBe(true);
        }
      }
    }
  });

  test("a conifer keeps a central leader; an oak forks into equals", () => {
    const conifer = generateTreeSkeleton({ ...base, species: "conifer" });
    const oak = generateTreeSkeleton({ ...base, species: "oak" });

    // The leader is the child that *is* the parent continuing, so a conifer's
    // crown reaches higher than an oak's from the same trunk height.
    expect(height({ ...base, species: "conifer" })).toBeGreaterThan(height({ ...base, species: "oak" }));
    expect(conifer.filter((b) => b.isLeader).length).toBeGreaterThan(0);
    expect(oak.length).toBeGreaterThan(0);
  });

  test("a palm does not branch at all — one stem, fronds on top", () => {
    const palm = generateTreeSkeleton({ ...base, species: "palm" });
    expect(palm.length).toBe(1);
    expect(palm[0].level).toBe(0);

    const fronds = buildLeafMatrices(palm, { ...base, species: "palm" });
    expect(fronds.length).toBeGreaterThan(0);
    // Anchored at the very top of the stem, not scattered down it.
    const stemTop = palm[0].points[palm[0].points.length - 1].y;
    for (const matrix of fronds) {
      const position = new THREE.Vector3().setFromMatrixPosition(matrix);
      expect(position.y).toBeGreaterThan(stemTop * 0.8);
    }
  });

  test("a dead tree branches normally and carries no leaves", () => {
    const dead = generateTreeSkeleton({ ...base, species: "dead" });
    expect(dead.length).toBeGreaterThan(1);
    expect(buildLeafMatrices(dead, { ...base, species: "dead" }).length).toBe(0);
  });

  test("a willow hangs below the ground plane's origin height; an oak does not", () => {
    const lowest = (species: (typeof TREE_SPECIES)[number]) => {
      let min = Infinity;
      for (const branch of generateTreeSkeleton({ ...base, species })) {
        // Only the outer branches are pulled down; the trunk holds it up.
        if (branch.level === 0) continue;
        for (const point of branch.points) min = Math.min(min, point.y);
      }
      return min;
    };
    expect(lowest("willow")).toBeLessThan(lowest("oak"));
  });

  test("species scales the author's numbers rather than replacing them", () => {
    // The promise made in the node's docs: the numbers still do their job
    // whichever species is selected.
    const spread = (params: typeof base) => {
      let max = 0;
      for (const branch of generateTreeSkeleton(params)) {
        for (const point of branch.points) max = Math.max(max, Math.hypot(point.x, point.z));
      }
      return max;
    };

    expect(spread({ ...base, species: "oak", branchAngle: 1.2 })).toBeGreaterThan(
      spread({ ...base, species: "oak", branchAngle: 0.2 }),
    );

    // A willow's own droop dominates its horizontal reach — a wider branch
    // angle on one just hangs from further out, it does not necessarily reach
    // further — so the check there is that the parameter still changes the
    // tree at all rather than being swallowed by the species.
    const narrowWillow = generateTreeSkeleton({ ...base, species: "willow", branchAngle: 0.2 });
    const wideWillow = generateTreeSkeleton({ ...base, species: "willow", branchAngle: 1.2 });
    expect(wideWillow[1].points[2].toArray()).not.toEqual(narrowWillow[1].points[2].toArray());
  });

  test("size is one master scale, not three numbers kept in proportion by hand", () => {
    const small = generateTreeSkeleton({ ...base, sizeScale: 1 });
    const big = generateTreeSkeleton({ ...base, sizeScale: 3 });

    expect(big[0].radiusStart).toBeCloseTo(small[0].radiusStart * 3, 6);
    expect(height({ ...base, sizeScale: 3 })).toBeGreaterThan(height({ ...base, sizeScale: 1 }) * 2.5);

    const leaves = buildLeafMatrices(big, { ...base, sizeScale: 3 });
    const scale = new THREE.Vector3().setFromMatrixScale(leaves[0]);
    const smallLeaves = buildLeafMatrices(small, { ...base, sizeScale: 1 });
    const smallScale = new THREE.Vector3().setFromMatrixScale(smallLeaves[0]);
    expect(scale.y).toBeGreaterThan(smallScale.y * 2.5);
  });

  test("phototropism lifts the crown, droop lowers it", () => {
    // Measured on the laterals only: the trunk and the leader chain that
    // continues it are already vertical, so neither control can move them —
    // including them would compare the same number to itself.
    const crownTop = (params: typeof base) => {
      let top = -Infinity;
      for (const branch of generateTreeSkeleton(params)) {
        if (branch.level === 0 || branch.isLeader) continue;
        for (const point of branch.points) top = Math.max(top, point.y);
      }
      return top;
    };

    const lifted = crownTop({ ...base, phototropism: 0.8 });
    const neutral = crownTop({ ...base, phototropism: 0, droop: 0 });
    const hung = crownTop({ ...base, droop: 1.0 });

    expect(lifted).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(hung);
  });
});

describe("leaf shape", () => {
  test("auto follows the species; an explicit shape overrides it", () => {
    expect(resolveLeafShape("auto", "conifer")).toBe("needle");
    expect(resolveLeafShape("auto", "birch")).toBe("heart");
    expect(resolveLeafShape("maple", "conifer")).toBe("maple");
  });

  test("every listed shape maps to a distinct id the shader can branch on", () => {
    const ids = LEAF_SHAPES.filter((shape) => shape !== "auto").map((shape) =>
      leafShapeId(shape as Exclude<(typeof LEAF_SHAPES)[number], "auto">),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(Number.isInteger(id)).toBe(true);
  });

  test("every species names a shape that actually exists", () => {
    for (const species of TREE_SPECIES) {
      expect(LEAF_SHAPES).toContain(SPECIES_PROFILES[species].leafShape);
    }
  });

  test("leaf width is a non-uniform scale on the card, not a smaller leaf", () => {
    const params = { ...DEFAULT_TREE_PARAMS, levels: 1, childCount: 2, leafAspect: 0.25 };
    const branches = generateTreeSkeleton(params);
    const [matrix] = buildLeafMatrices(branches, params);
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    expect(scale.x).toBeCloseTo(scale.y * 0.25, 5);
  });
});

describe("object/tree node — appearance controls", () => {
  const params = () => ({
    ...TREE_NODE.defaultParams,
    levels: 2,
    childCount: 2,
    segments: 3,
    radialSegments: 5,
  });

  const leafMaterialOf = (group: THREE.Group) =>
    (group.children.find((c) => c instanceof THREE.InstancedMesh) as THREE.InstancedMesh)
      .material as THREE.ShaderMaterial;

  test("leaf shape and tip sharpness are uniforms — no rebuild to try a silhouette", () => {
    const first = TREE_NODE.evaluate({}, { ...params(), leafShape: "maple" }, makeContext("tree-s1")) as {
      geometry: THREE.Group;
    };
    const bark = first.geometry.children.find((c) => !(c instanceof THREE.InstancedMesh)) as THREE.Mesh;
    const barkGeometry = bark.geometry;
    expect(leafMaterialOf(first.geometry).uniforms.uLeafShape.value).toBe(leafShapeId("maple"));

    const second = TREE_NODE.evaluate(
      {},
      { ...params(), leafShape: "needle", leafTip: 0.9 },
      makeContext("tree-s1"),
    ) as { geometry: THREE.Group };

    expect(leafMaterialOf(second.geometry).uniforms.uLeafShape.value).toBe(leafShapeId("needle"));
    expect(leafMaterialOf(second.geometry).uniforms.uLeafTip.value).toBe(0.9);
    // The woody geometry never moved.
    const barkAfter = second.geometry.children.find((c) => !(c instanceof THREE.InstancedMesh)) as THREE.Mesh;
    expect(barkAfter.geometry).toBe(barkGeometry);
  });

  test("an unknown species or leaf shape falls back instead of throwing", () => {
    const out = TREE_NODE.evaluate(
      {},
      { ...params(), species: "banana", leafShape: "spiral" },
      makeContext("tree-s2"),
    ) as { geometry: THREE.Group; branchCount: number };
    expect(out.branchCount).toBeGreaterThan(0);
    expect(leafMaterialOf(out.geometry).uniforms.uLeafShape.value).toBe(leafShapeId("oval"));
  });

  test("changing species regrows the tree", () => {
    const oak = TREE_NODE.evaluate({}, { ...params(), species: "oak" }, makeContext("tree-s3")) as {
      branchCount: number;
      tips: THREE.Vector3[];
    };
    const palm = TREE_NODE.evaluate({}, { ...params(), species: "palm" }, makeContext("tree-s3")) as {
      branchCount: number;
    };
    expect(oak.branchCount).toBeGreaterThan(1);
    expect(palm.branchCount).toBe(1);
  });

  test("Size is wired as a socket, so a forest can vary its trees from a list", () => {
    const small = TREE_NODE.evaluate({ sizeScale: 1 }, params(), makeContext("tree-s4")) as {
      tips: THREE.Vector3[];
    };
    const big = TREE_NODE.evaluate({ sizeScale: 2.5 }, params(), makeContext("tree-s4")) as {
      tips: THREE.Vector3[];
    };
    const topOf = (tips: THREE.Vector3[]) => Math.max(...tips.map((t) => t.y));
    expect(topOf(big.tips)).toBeGreaterThan(topOf(small.tips) * 2);
  });

  test("bark roughness reaches the material without rebuilding geometry", () => {
    const out = TREE_NODE.evaluate({}, { ...params(), barkRoughness: 0.2 }, makeContext("tree-s5")) as {
      geometry: THREE.Group;
    };
    const bark = out.geometry.children.find((c) => !(c instanceof THREE.InstancedMesh)) as THREE.Mesh;
    expect((bark.material as THREE.MeshStandardMaterial).roughness).toBe(0.2);
  });
});

describe("clumped foliage", () => {
  const base = {
    ...DEFAULT_TREE_PARAMS,
    levels: 2,
    childCount: 2,
    segments: 4,
    leavesPerBranch: 6,
    leafLevels: 1,
    foliageMode: "clumps" as const,
    clumpsPerBranch: 2,
  };

  test("auto follows the species: a cherry clumps, an oak scatters", () => {
    expect(resolveFoliageMode("auto", "cherry")).toBe("clumps");
    expect(resolveFoliageMode("auto", "oak")).toBe("scattered");
    // An explicit choice always wins over the species.
    expect(resolveFoliageMode("scattered", "cherry")).toBe("scattered");
    expect(resolveFoliageMode("clumps", "oak")).toBe("clumps");
  });

  test("every mode option is either auto or a real mode", () => {
    expect(FOLIAGE_MODE_OPTIONS[0]).toBe("auto");
    for (const option of FOLIAGE_MODE_OPTIONS) {
      expect(resolveFoliageMode(option, "oak")).toMatch(/scattered|clumps/);
    }
  });

  test("clump mode places clumps × leaves per leaf-bearing branch", () => {
    const branches = generateTreeSkeleton(base);
    const bearing = branches.filter((b) => b.level === base.levels).length;
    const matrices = buildLeafMatrices(branches, base);
    expect(matrices.length).toBe(bearing * base.clumpsPerBranch * base.leavesPerBranch);
  });

  test("leaves in a clump sit inside its ball, not strung along the branch", () => {
    const single = { ...base, clumpsPerBranch: 1, leavesPerBranch: 40, clumpRadius: 3 };
    // One branch, one clump: every card must be within the clump radius of
    // their common centre.
    const branches = generateTreeSkeleton({ ...single, levels: 0, childCount: 0 });
    const matrices = buildLeafMatrices(branches, single);
    expect(matrices.length).toBe(40);

    const points = matrices.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
    const centre = points
      .reduce((sum, p) => sum.add(p), new THREE.Vector3())
      .divideScalar(points.length);

    const size = single.leafSize * single.sizeScale;
    const reach = single.clumpRadius * size * 1.3;
    for (const point of points) expect(point.distanceTo(centre)).toBeLessThan(reach);
  });

  test("a clump is hollow-ish: leaves are spent on the surface, not the middle", () => {
    const single = { ...base, clumpsPerBranch: 1, leavesPerBranch: 200, clumpRadius: 4, levels: 0, childCount: 0 };
    const matrices = buildLeafMatrices(generateTreeSkeleton(single), single);
    const points = matrices.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
    const centre = points
      .reduce((sum, p) => sum.add(p), new THREE.Vector3())
      .divideScalar(points.length);

    const radius = single.clumpRadius * single.leafSize * single.sizeScale;
    const inner = points.filter((p) => p.distanceTo(centre) < radius * 0.4).length;
    // The bias starts at 0.45 of the radius, so the very middle stays empty.
    expect(inner / points.length).toBeLessThan(0.1);
  });

  test("scattered and clumped placements genuinely differ", () => {
    const branches = generateTreeSkeleton(base);
    const clumped = buildLeafMatrices(branches, base);
    const scattered = buildLeafMatrices(branches, { ...base, foliageMode: "scattered" });
    expect(clumped.length).not.toBe(scattered.length);
  });

  test("the leaf budget holds even when clumps multiply out", () => {
    const greedy = {
      ...DEFAULT_TREE_PARAMS,
      levels: 5,
      childCount: 5,
      foliageMode: "clumps" as const,
      clumpsPerBranch: 8,
      leavesPerBranch: 60,
      leafLevels: 6,
    };
    const matrices = buildLeafMatrices(generateTreeSkeleton(greedy), greedy);
    expect(matrices.length).toBeLessThanOrEqual(MAX_TREE_LEAVES);
  });
});

describe("canopy heights", () => {
  const matrixAt = (y: number) =>
    new THREE.Matrix4().setPosition(new THREE.Vector3(0, y, 0));

  test("the lowest leaf is 0 and the highest is 1", () => {
    const heights = computeLeafHeights([matrixAt(2), matrixAt(6), matrixAt(4)]);
    expect(heights[0]).toBeCloseTo(0, 6);
    expect(heights[1]).toBeCloseTo(1, 6);
    expect(heights[2]).toBeCloseTo(0.5, 6);
  });

  test("a flat crown is all top rather than a division by zero", () => {
    const heights = computeLeafHeights([matrixAt(3), matrixAt(3)]);
    expect(Array.from(heights)).toEqual([1, 1]);
  });

  test("no leaves, no heights", () => {
    expect(computeLeafHeights([]).length).toBe(0);
  });

  test("heights are relative to the canopy, not to world zero", () => {
    // Same crown, lifted: the gradient must not change with the tree's height.
    const low = computeLeafHeights([matrixAt(1), matrixAt(3)]);
    const high = computeLeafHeights([matrixAt(101), matrixAt(103)]);
    expect(Array.from(low)).toEqual(Array.from(high));
  });
});

describe("object/tree node — season and canopy", () => {
  const params = () => ({
    ...TREE_NODE.defaultParams,
    levels: 2,
    childCount: 2,
    segments: 3,
    radialSegments: 5,
  });

  const leavesOf = (group: THREE.Group) =>
    group.children.find((c) => c instanceof THREE.InstancedMesh) as THREE.InstancedMesh;

  test("every leaf carries its canopy height as an instanced attribute", () => {
    const out = TREE_NODE.evaluate({}, params(), makeContext("tree-a1")) as { geometry: THREE.Group };
    const leaves = leavesOf(out.geometry);
    const heights = leaves.geometry.getAttribute("aLeafHeight");
    expect(heights.count).toBe(leaves.count);
    for (let i = 0; i < heights.count; i++) {
      expect(heights.getX(i)).toBeGreaterThanOrEqual(0);
      expect(heights.getX(i)).toBeLessThanOrEqual(1);
    }
  });

  test("season is a uniform, so animating a turn costs no rebuild", () => {
    const summer = TREE_NODE.evaluate({ season: 0 }, params(), makeContext("tree-a2", 0)) as {
      geometry: THREE.Group;
    };
    const leafGeometry = leavesOf(summer.geometry).geometry;
    expect(leavesOf(summer.geometry).material).toBeDefined();

    const autumn = TREE_NODE.evaluate({ season: 0.8 }, params(), makeContext("tree-a2", 1)) as {
      geometry: THREE.Group;
    };
    const material = leavesOf(autumn.geometry).material as THREE.ShaderMaterial;
    expect(material.uniforms.uSeason.value).toBeCloseTo(0.8, 6);
    expect(leavesOf(autumn.geometry).geometry).toBe(leafGeometry);
  });

  test("season is clamped to the ramp's own range", () => {
    const out = TREE_NODE.evaluate({ season: 4 }, params(), makeContext("tree-a3")) as {
      geometry: THREE.Group;
    };
    expect((leavesOf(out.geometry).material as THREE.ShaderMaterial).uniforms.uSeason.value).toBe(1);
  });

  test("autumn colours and the canopy gradient reach the shader", () => {
    const out = TREE_NODE.evaluate(
      {},
      {
        ...params(),
        autumnColorA: new THREE.Color(0x112233),
        autumnColorB: new THREE.Color(0x445566),
        canopyShade: 0.7,
        canopyShadePower: 2.5,
        seasonVariance: 0.9,
      },
      makeContext("tree-a4"),
    ) as { geometry: THREE.Group };

    const uniforms = (leavesOf(out.geometry).material as THREE.ShaderMaterial).uniforms;
    expect((uniforms.uAutumnColorA.value as THREE.Color).getHex()).toBe(0x112233);
    expect((uniforms.uAutumnColorB.value as THREE.Color).getHex()).toBe(0x445566);
    expect(uniforms.uCanopyShade.value).toBe(0.7);
    expect(uniforms.uCanopyShadePower.value).toBe(2.5);
    expect(uniforms.uSeasonVariance.value).toBe(0.9);
  });

  test("wind moves a leaf rigidly: sampled once at the stem, applied as a rotation", () => {
    // The bug this pins: sampling windOffset at each vertex's own world
    // position gave the four corners of one card four different displacements,
    // which sheared and stretched the leaf. Wind must be read once per
    // instance, at its anchor, and applied as a rotation about that anchor —
    // a rotation cannot change the card's shape at any wind strength.
    const out = TREE_NODE.evaluate({}, params(), makeContext("tree-a7")) as { geometry: THREE.Group };
    const shader = (leavesOf(out.geometry).material as THREE.ShaderMaterial).vertexShader;

    expect(shader).toContain("vec3 anchor = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz");
    expect(shader).toContain("windOffset(anchor.xz + aLeafRandom * 12.0)");
    expect(shader).toContain("rotateAboutAxis(world.xyz - anchor, axis, angle)");

    // The per-vertex sample and the per-vertex bend mask are both gone.
    expect(shader).not.toContain("windOffset(world.xz");
    expect(shader).not.toContain("0.4 + uv.y");
  });

  test("the leaf normal turns with the leaf, so shading follows the gust", () => {
    const out = TREE_NODE.evaluate({}, params(), makeContext("tree-a8")) as { geometry: THREE.Group };
    const shader = (leavesOf(out.geometry).material as THREE.ShaderMaterial).vertexShader;
    expect(shader).toContain("vLeafNormal = normalize(rotateAboutAxis(");
  });

  test("the ramp is per leaf, not per tree — the shader offsets it by the leaf's random", () => {
    const out = TREE_NODE.evaluate({}, params(), makeContext("tree-a5")) as { geometry: THREE.Group };
    const shader = (leavesOf(out.geometry).material as THREE.ShaderMaterial).fragmentShader;
    expect(shader).toContain("uSeason + (vLeafRandom - 0.5) * uSeasonVariance");
    expect(shader).toContain("pow(clamp(vLeafHeight, 0.0, 1.0), uCanopyShadePower)");
  });

  test("switching to clump mode rebuilds the foliage", () => {
    const scattered = TREE_NODE.evaluate(
      {},
      { ...params(), foliageMode: "scattered" },
      makeContext("tree-a6"),
    ) as { geometry: THREE.Group };
    const scatteredCount = leavesOf(scattered.geometry).count;

    const clumped = TREE_NODE.evaluate(
      {},
      { ...params(), foliageMode: "clumps", clumpsPerBranch: 3 },
      makeContext("tree-a6"),
    ) as { geometry: THREE.Group };

    expect(leavesOf(clumped.geometry).count).toBeGreaterThan(scatteredCount);
  });
});

describe("leaf rigidity under wind", () => {
  /**
   * A TypeScript mirror of the leaf vertex shader's displacement, so the claim
   * "wind cannot deform a leaf" can be checked as arithmetic rather than by
   * eye. The shader-text guard above pins that the real shader uses this same
   * math; this pins that the math is actually rigid.
   */
  const CARD_CORNERS = [
    new THREE.Vector3(-0.5, 0, 0),
    new THREE.Vector3(0.5, 0, 0),
    new THREE.Vector3(0.5, 1, 0),
    new THREE.Vector3(-0.5, 1, 0),
  ];

  const field = windField({ strength: 3, phase: 1.7, positionFrequency: 0.8 });

  /** What the shader does now: one sample at the stem, applied as a rotation. */
  function rigidLeaf(anchor: THREE.Vector3, leafRandom: number, influence: number): THREE.Vector3[] {
    const offset = sampleWind(field, anchor.x + leafRandom * 12, anchor.z + leafRandom * 12)
      .multiplyScalar(influence);
    const strength = offset.length();
    return CARD_CORNERS.map((corner) => {
      const world = anchor.clone().add(corner);
      if (strength <= 1e-5) return world;
      const direction = new THREE.Vector3(offset.x, 0, offset.y).divideScalar(strength);
      const axis = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
      const angle = Math.atan(strength) * (0.75 + 0.5 * leafRandom);
      return anchor.clone().add(world.sub(anchor).applyAxisAngle(axis, angle));
    });
  }

  /** What it used to do: a fresh sample per vertex, scaled by a per-vertex mask. */
  function shearedLeaf(anchor: THREE.Vector3, leafRandom: number, influence: number): THREE.Vector3[] {
    return CARD_CORNERS.map((corner) => {
      const world = anchor.clone().add(corner);
      const offset = sampleWind(field, world.x + leafRandom * 12, world.z + leafRandom * 12)
        .multiplyScalar(influence);
      const mask = 0.4 + corner.y;
      return world.add(new THREE.Vector3(offset.x, -offset.length() * 0.2, offset.y).multiplyScalar(mask));
    });
  }

  const edges = (corners: THREE.Vector3[]) => [
    corners[0].distanceTo(corners[1]),
    corners[1].distanceTo(corners[2]),
    corners[2].distanceTo(corners[3]),
    corners[3].distanceTo(corners[0]),
    corners[0].distanceTo(corners[2]),
  ];

  const REST = edges(CARD_CORNERS.map((c) => c.clone()));

  test("a rotated leaf keeps every edge and diagonal, at any wind influence", () => {
    for (const influence of [0.5, 1, 2.5, 8, 40]) {
      for (let i = 0; i < 12; i++) {
        const anchor = new THREE.Vector3(i * 1.7 - 10, 3 + i * 0.3, i * -2.1 + 4);
        const moved = edges(rigidLeaf(anchor, (i % 7) / 7, influence));
        for (let e = 0; e < moved.length; e++) {
          expect(moved[e]).toBeCloseTo(REST[e], 6);
        }
      }
    }
  });

  test("the old per-vertex sampling did stretch the card — this is the bug being fixed", () => {
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      const anchor = new THREE.Vector3(i * 1.7 - 10, 3 + i * 0.3, i * -2.1 + 4);
      const moved = edges(shearedLeaf(anchor, (i % 7) / 7, 8));
      for (let e = 0; e < moved.length; e++) {
        worst = Math.max(worst, Math.abs(moved[e] - REST[e]) / REST[e]);
      }
    }
    // Not a rounding wobble: whole percentage points of stretch on a quad.
    expect(worst).toBeGreaterThan(0.05);
  });

  test("a leaf still moves — rigidity is not stiffness", () => {
    const anchor = new THREE.Vector3(2, 4, -1);
    const still = rigidLeaf(anchor, 0.3, 0);
    const blown = rigidLeaf(anchor, 0.3, 6);
    let moved = 0;
    for (let i = 0; i < still.length; i++) moved = Math.max(moved, still[i].distanceTo(blown[i]));
    expect(moved).toBeGreaterThan(0.1);
  });

  test("the stem stays put — the leaf pivots where it is attached", () => {
    const anchor = new THREE.Vector3(-3, 2, 5);
    // The bottom edge's midpoint is the stem, and a rotation about the anchor
    // leaves the anchor itself exactly where it was.
    const blown = rigidLeaf(anchor, 0.8, 10);
    const stem = blown[0].clone().add(blown[1]).multiplyScalar(0.5);
    expect(stem.distanceTo(anchor)).toBeLessThan(1e-6);
  });
});

