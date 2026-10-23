import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { METABALLS_NODE } from "./metaballs";
import { bindRaymarch, createRaymarchState, isRaymarchEnabled, unbindRaymarch, uploadElements } from "./metaballsRaymarch";
import { blobsJob } from "../offthread/surfaceNets.fixtures";
import { BLOB_POINT, BLOB_STRIDE } from "../offthread/surfaceNets";
import { EvalContext } from "../types";

function run(inputs: Record<string, unknown>, nodeId: string, overrides: Record<string, unknown> = {}, extra: Partial<EvalContext> = {}) {
  const params = { ...(METABALLS_NODE.defaultParams as Record<string, unknown>), ...overrides };
  const out = METABALLS_NODE.evaluate(inputs, params, { time: 0, step: 0, nodeId, simulationEpoch: 0, ...extra });
  return { out, mesh: out.geometry as THREE.Mesh };
}

/** Runs a material's onBeforeCompile on the real three shader source for its type, as the renderer would. */
function compiled(material: THREE.Material, lib: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: THREE.UniformsUtils.clone(lib.uniforms) };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];

describe("metaballs raymarched display", () => {
  test("draws a proxy box around the elements instead of a mesh, and patches the material", () => {
    const { mesh, out } = run({ points }, "rm-box", { display: "raymarch", radius: 0.5 });
    const geometry = mesh.geometry;
    expect(geometry.getAttribute("position").count).toBe(24);
    expect(geometry.getIndex()!.count).toBe(36);
    // Reach = radius × smooth = 0.8 around each centre.
    expect(geometry.boundingBox!.min.x).toBeCloseTo(-0.8, 5);
    expect(geometry.boundingBox!.max.x).toBeCloseTo(1.8, 5);
    expect(out.count).toBe(2);
    const material = mesh.material as THREE.Material;
    expect(isRaymarchEnabled(material)).toBe(true);
    expect(material.side).toBe(THREE.BackSide);
    expect(mesh.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(mesh.customDistanceMaterial).toBeInstanceOf(THREE.MeshDistanceMaterial);
  });

  test("falls back to the mesh when the Geometry output is wired downstream", () => {
    const { mesh } = run({ points }, "rm-wired", { display: "raymarch" }, { connectedOutputs: new Set(["geometry"]) });
    expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(24);
    expect(isRaymarchEnabled(mesh.material as THREE.Material)).toBe(false);
    expect(mesh.customDepthMaterial).toBeUndefined();
  });

  test("the legacy mesher ignores Display", () => {
    const { mesh } = run({ points }, "rm-legacy", { display: "raymarch", mesher: "marchingCubes" });
    expect(mesh.geometry.getIndex()).toBeNull();
    expect(isRaymarchEnabled(mesh.material as THREE.Material)).toBe(false);
  });

  test("switching back to Mesh restores the surface and the plain material, on the same mesh", () => {
    const first = run({ points }, "rm-switch", { display: "raymarch" }).mesh;
    const back = run({ points }, "rm-switch", { display: "mesh" }).mesh;
    expect(back).toBe(first);
    expect(back.geometry.getAttribute("position").count).toBeGreaterThan(24);
    expect(isRaymarchEnabled(back.material as THREE.Material)).toBe(false);
    expect((back.material as THREE.Material).side).toBe(THREE.FrontSide);
    expect(back.customDepthMaterial).toBeUndefined();
    // …and forth again.
    const again = run({ points }, "rm-switch", { display: "raymarch" }).mesh;
    expect(again.geometry.getAttribute("position").count).toBe(24);
    expect(isRaymarchEnabled(again.material as THREE.Material)).toBe(true);
  });

  test("only carvers: nothing to draw", () => {
    const { mesh } = run({ carvePoints: points }, "rm-empty", { display: "raymarch" });
    expect(mesh.geometry.drawRange.count).toBe(0);
  });

  test("uploads the kernel's element layout as is, 7 texels per element", () => {
    const state = createRaymarchState();
    const job = blobsJob(
      [
        { kind: BLOB_POINT, a: [1, 2, 3], radius: 0.5, smooth: 1, weight: 1 },
        { kind: BLOB_POINT, a: [-1, 0, 0], radius: 0.25, smooth: 1, weight: -1 },
      ],
      32,
    );
    const box = uploadElements(state, job.elements, job.iso, false)!;
    const texture = state.uniforms.uBlobTex.value;
    expect(texture.image.width).toBe(7);
    expect(Array.from((texture.image.data as Float32Array).subarray(0, 2 * BLOB_STRIDE))).toEqual(Array.from(Float32Array.from(job.elements)));
    expect(state.uniforms.uBlobCount.value).toBe(2);
    // Only the positive element bounds what gets drawn.
    expect(box.min.x).toBeCloseTo(0.2, 5);
    expect(box.max.z).toBeCloseTo(3.8, 5);
  });

  test("patches three's real standard / physical / basic / depth / distance shaders", () => {
    const state = createRaymarchState();
    const cases: [THREE.Material, keyof typeof THREE.ShaderLib][] = [
      [new THREE.MeshStandardMaterial(), "standard"],
      [new THREE.MeshPhysicalMaterial(), "physical"],
      [new THREE.MeshBasicMaterial(), "basic"],
    ];
    for (const [material, lib] of cases) {
      bindRaymarch(material, state, true);
      const shader = compiled(material, THREE.ShaderLib[lib]);
      expect(shader.vertexShader).toContain("vBlobWorld = ( modelMatrix");
      expect(shader.fragmentShader).toContain("if ( ! blobTrace(");
      expect(shader.fragmentShader).toContain("gl_FragDepth");
      expect(shader.fragmentShader).not.toMatch(/varying\s+vec3\s+vViewPosition/);
      expect(shader.fragmentShader).not.toMatch(/varying\s+vec4\s+vDirectionalShadowCoord/);
      expect(shader.uniforms.uBlobTex).toBe(state.uniforms.uBlobTex);
      expect(material.customProgramCacheKey()).toContain(`tsuji-blob-raymarch#${state.id}`);
    }
    const lit = compiled(cases[0][0], THREE.ShaderLib.standard).fragmentShader;
    expect(lit).toContain("vViewPosition = - blobView.xyz;");
    expect(lit).toContain("vNormal = normalize(");
    expect(lit).toContain("vPointShadowCoord[ i ] = pointShadowMatrix");
    expect(compiled(state.depthMaterial, THREE.ShaderLib.depth).fragmentShader).toContain("vHighPrecisionZW = blobClip.zw;");
    expect(compiled(state.distanceMaterial, THREE.ShaderLib.distance).fragmentShader).toContain("vWorldPosition = blobWorldHit;");
  });

  test("rebinds to a new state, with its own program key", () => {
    const material = new THREE.MeshStandardMaterial();
    const before = material.onBeforeCompile;
    const old = createRaymarchState();
    bindRaymarch(material, old, true);
    const oldKey = material.customProgramCacheKey();
    const fresh = createRaymarchState();
    bindRaymarch(material, fresh, true);
    expect(compiled(material, THREE.ShaderLib.standard).uniforms.uBlobTex).toBe(fresh.uniforms.uBlobTex);
    expect(material.customProgramCacheKey()).not.toBe(oldKey);
    unbindRaymarch(material);
    expect(material.onBeforeCompile).toBe(before);
  });

  test("inactive: the shader is untouched but every program still carries the raymarch uniforms", () => {
    // three reuses a material's earlier program on raymarch → mesh → raymarch
    // with the uniforms of the program compiled last — they must hold uBlobTex.
    const material = new THREE.MeshStandardMaterial();
    const state = createRaymarchState();
    bindRaymarch(material, state, true);
    const activeKey = material.customProgramCacheKey();
    bindRaymarch(material, state, false);
    expect(isRaymarchEnabled(material)).toBe(false);
    const meshShader = compiled(material, THREE.ShaderLib.standard);
    expect(meshShader.fragmentShader).not.toContain("blobTrace");
    expect(meshShader.uniforms.uBlobTex).toBe(state.uniforms.uBlobTex);
    expect(material.customProgramCacheKey()).not.toBe(activeKey);
    bindRaymarch(material, state, true);
    expect(material.customProgramCacheKey()).toBe(activeKey);
  });

  test("the node keeps its uniforms bound while showing the mesh, and raymarches again after", () => {
    const first = run({ points }, "rm-carry", { display: "raymarch" }).mesh;
    const material = first.material as THREE.Material;
    run({ points }, "rm-carry", { display: "mesh" });
    const meshShader = compiled(material, THREE.ShaderLib.standard);
    expect(meshShader.fragmentShader).not.toContain("blobTrace");
    expect(meshShader.uniforms.uBlobTex).toBeDefined();
    run({ points }, "rm-carry", { display: "raymarch" });
    expect(isRaymarchEnabled(material)).toBe(true);
  });

  test("chains onto an existing onBeforeCompile (triplanar) and undoes cleanly", () => {
    const state = createRaymarchState();
    const material = new THREE.MeshStandardMaterial();
    const previous = (shader: { fragmentShader: string }) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;");
    };
    material.onBeforeCompile = previous as never;
    material.customProgramCacheKey = () => "tsuji-triplanar";
    bindRaymarch(material, state, true);
    bindRaymarch(material, state, true); // idempotent
    const fragment = compiled(material, THREE.ShaderLib.standard).fragmentShader;
    expect(fragment).toContain("vTriPos = blobLocalHit;");
    expect(material.customProgramCacheKey()).toBe(`tsuji-triplanar|tsuji-blob-raymarch#${state.id}`);
    unbindRaymarch(material);
    expect(material.onBeforeCompile).toBe(previous);
    expect(material.customProgramCacheKey()).toBe("tsuji-triplanar");
  });
});
