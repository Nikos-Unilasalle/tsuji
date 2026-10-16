import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { polygonizeMetaballs } from "./marchingCubes";
import { expectSameMesh, referenceMesh, sampleJob } from "./marchingCubes.fixtures";
import { instantiateWasmKernelsSync } from "./wasmKernels";

describe("marching-cubes kernel", () => {
  it.each([
    [16, 1],
    [32, 6],
    [48, 40],
  ])("matches three's MarchingCubes vertex for vertex (res %i, %i balls)", (resolution, balls) => {
    const job = sampleJob(resolution, balls);
    const expected = referenceMesh(job);
    expect(expected.count).toBeGreaterThan(0);
    expectSameMesh(polygonizeMetaballs(job), expected);
  });

  it("reuses its scratch field without leaking the previous job into the next", () => {
    const a = sampleJob(32, 10, 1);
    const b = sampleJob(32, 3, 2);
    polygonizeMetaballs(a);
    expectSameMesh(polygonizeMetaballs(b), referenceMesh(b));
  });

  it("stops at maxVertices instead of overrunning", () => {
    const job = { ...sampleJob(32, 20), maxVertices: 300 };
    const mesh = polygonizeMetaballs(job);
    expect(mesh.count).toBeLessThanOrEqual(300);
    expect(mesh.position.every(Number.isFinite)).toBe(true);
  });

  it("returns an empty mesh when no ball reaches the iso level", () => {
    const mesh = polygonizeMetaballs(sampleJob(16, 0));
    expect(mesh.count).toBe(0);
    expect(mesh.position.length).toBe(0);
  });

  it.each([
    [16, 1],
    [32, 6],
    [48, 40],
  ])("the Rust/WASM build matches it too (res %i, %i balls)", (resolution, balls) => {
    const wasm = instantiateWasmKernelsSync(readFileSync(join(__dirname, "tsuji_kernels.wasm")));
    const job = sampleJob(resolution, balls);
    expectSameMesh(wasm.metaballs(job), polygonizeMetaballs(job));
    // Twice: the second call reuses the kernel's grown buffers.
    expectSameMesh(wasm.metaballs(job), referenceMesh(job));
  });
});
