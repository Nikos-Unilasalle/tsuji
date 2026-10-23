import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MeshBuffers } from "./marchingCubes";
import { BLOB_POINT, BLOB_SEGMENT, polygonizeBlobs } from "./surfaceNets";
import { blobsJob, components, meshVolume, openEdges, sampleBlobsJob } from "./surfaceNets.fixtures";
import { instantiateWasmKernelsSync } from "./wasmKernels";

function expectIdentical(actual: MeshBuffers, expected: MeshBuffers): void {
  expect(actual.count).toBe(expected.count);
  expect(actual.position).toEqual(expected.position);
  expect(actual.normal).toEqual(expected.normal);
  expect(actual.uv).toEqual(expected.uv);
  expect(actual.index).toEqual(expected.index);
  expect(actual.color).toEqual(expected.color);
  expect(Array.from(actual.bounds)).toEqual(Array.from(expected.bounds));
}

function extent(mesh: MeshBuffers): [number, number, number, number, number, number] {
  return Array.from(mesh.bounds.slice(0, 6)) as [number, number, number, number, number, number];
}

const sphere = (x: number, y: number, z: number, radius: number, weight = 1) =>
  ({ kind: BLOB_POINT, a: [x, y, z], radius, smooth: 1, weight }) as const;

describe("surface nets kernel", () => {
  it("a lone sphere is closed, winds outward and sits at its radius", () => {
    const mesh = polygonizeBlobs(blobsJob([sphere(1, -2, 0.5, 0.8)], 64));
    expect(openEdges(mesh)).toBe(0);
    const vol = meshVolume(mesh);
    const exact = (4 / 3) * Math.PI * 0.8 ** 3;
    expect(vol).toBeGreaterThan(exact * 0.97);
    expect(vol).toBeLessThan(exact * 1.01);
    const [x0, y0, , x1, , z1] = extent(mesh);
    expect(x0).toBeCloseTo(0.2, 2);
    expect(x1).toBeCloseTo(1.8, 2);
    expect(y0).toBeCloseTo(-2.8, 2);
    expect(z1).toBeCloseTo(1.3, 2);
  });

  it("is indexed: every vertex is shared by several triangles", () => {
    const mesh = polygonizeBlobs(blobsJob([sphere(0, 0, 0, 1)], 32));
    expect(mesh.index!.length / 3).toBeGreaterThan(mesh.count * 1.9);
    expect(Math.max(...mesh.index!)).toBeLessThan(mesh.count);
  });

  it("normals are unit length and point away from the centre", () => {
    const mesh = polygonizeBlobs(blobsJob([sphere(0, 0, 0, 1)], 32));
    for (let i = 0; i < mesh.count * 3; i += 3) {
      const [px, py, pz] = [mesh.position[i], mesh.position[i + 1], mesh.position[i + 2]];
      const [nx, ny, nz] = [mesh.normal[i], mesh.normal[i + 1], mesh.normal[i + 2]];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      expect((px * nx + py * ny + pz * nz) / Math.hypot(px, py, pz)).toBeGreaterThan(0.999);
    }
  });

  it("each element keeps its own radius", () => {
    const mesh = polygonizeBlobs(blobsJob([sphere(-3, 0, 0, 0.5), sphere(3, 0, 0, 1.5)], 96));
    const [x0, , , x1, y1] = extent(mesh);
    expect(x0).toBeCloseTo(-3.5, 1);
    expect(x1).toBeCloseTo(4.5, 1);
    expect(y1).toBeCloseTo(1.5, 1);
  });

  it("an ellipsoid spans its shape's axes", () => {
    const mesh = polygonizeBlobs(blobsJob([{ kind: BLOB_POINT, a: [0, 0, 0], radius: 1, smooth: 1, weight: 1, shape: [2, 0, 0, 0, 0.5, 0, 0, 0, 1] }], 96));
    const [x0, y0, z0, x1, y1, z1] = extent(mesh);
    expect(x1 - x0).toBeCloseTo(4, 1);
    expect(y1 - y0).toBeCloseTo(1, 1);
    expect(z1 - z0).toBeCloseTo(2, 1);
    expect(openEdges(mesh)).toBe(0);
  });

  it("a capsule runs the length of its segment", () => {
    const mesh = polygonizeBlobs(blobsJob([{ kind: BLOB_SEGMENT, a: [0, -2, 0], b: [0, 2, 0], radius: 0.5, smooth: 1, weight: 1 }], 96));
    const [x0, y0, , x1, y1] = extent(mesh);
    expect(y0).toBeCloseTo(-2.5, 1);
    expect(y1).toBeCloseTo(2.5, 1);
    expect(x1 - x0).toBeCloseTo(1, 1);
    expect(openEdges(mesh)).toBe(0);
  });

  it("a polyline's chained capsules join without bulging; unchained ones bulge at the joint", () => {
    const bend = (chain: number) =>
      [
        { kind: BLOB_SEGMENT, a: [0, 0, 0], b: [2, 0, 0], radius: 0.3, smooth: 1, weight: 1, chain },
        { kind: BLOB_SEGMENT, a: [2, 0, 0], b: [2, 2, 0], radius: 0.3, smooth: 1, weight: 1, chain },
      ] as const;
    // Thickness through the joint's outer corner, along the diagonal (1, -1).
    const reach = (mesh: MeshBuffers) => {
      let best = 0;
      for (let i = 0; i < mesh.count * 3; i += 3) {
        const dx = mesh.position[i] - 2, dy = mesh.position[i + 1];
        if (Math.abs(mesh.position[i + 2]) < 0.05 && dx > 0 && dy < 0) best = Math.max(best, Math.hypot(dx, dy));
      }
      return best;
    };
    const chained = polygonizeBlobs(blobsJob([...bend(1)], 128));
    const loose = polygonizeBlobs(blobsJob([...bend(0)], 128));
    expect(reach(chained)).toBeCloseTo(0.3, 1);
    expect(reach(loose)).toBeGreaterThan(0.33);
    expect(openEdges(chained)).toBe(0);
    expect(components(chained)).toBe(1);
  });

  it("a chained tube keeps its radius along a straight run (no lumps at the joints)", () => {
    const specs = [0, 1, 2, 3].map((i) => ({ kind: BLOB_SEGMENT, a: [i, 0, 0], b: [i + 1, 0, 0], radius: 0.25, smooth: 1, weight: 1, chain: 1 }) as const);
    const mesh = polygonizeBlobs(blobsJob(specs, 160));
    let lo = Infinity, hi = 0;
    for (let i = 0; i < mesh.count * 3; i += 3) {
      const x = mesh.position[i];
      if (x < 0.3 || x > 3.7) continue;
      const r = Math.hypot(mesh.position[i + 1], mesh.position[i + 2]);
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    expect(hi - lo).toBeLessThan(0.02);
  });

  it("a negative element carves", () => {
    const whole = polygonizeBlobs(blobsJob([sphere(0, 0, 0, 1)], 64));
    const carved = polygonizeBlobs(blobsJob([sphere(0, 0, 0, 1), sphere(0.9, 0, 0, 0.6, -1)], 64));
    expect(meshVolume(carved)).toBeLessThan(meshVolume(whole) * 0.92);
    expect(extent(carved)[3]).toBeLessThan(0.8);
    expect(openEdges(carved)).toBe(0);
  });

  it("a negative element alone meshes nothing", () => {
    const mesh = polygonizeBlobs(blobsJob([sphere(0, 0, 0, 1, -1)], 32));
    expect(mesh.count).toBe(0);
    expect(mesh.index?.length ?? 0).toBe(0);
  });

  it("near elements fuse into one surface, far ones stay apart", () => {
    const near = polygonizeBlobs(blobsJob([sphere(-0.5, 0, 0, 0.5), sphere(0.5, 0, 0, 0.5)], 48));
    const far = polygonizeBlobs(blobsJob([sphere(-2, 0, 0, 0.5), sphere(2, 0, 0, 0.5)], 48));
    expect(components(near)).toBe(1);
    expect(components(far)).toBe(2);
    expect(openEdges(near)).toBe(0);
  });

  it("blends colours from the elements around each vertex", () => {
    const job = blobsJob(
      [
        { ...sphere(-2, 0, 0, 0.6), color: [1, 0, 0] },
        { ...sphere(2, 0, 0, 0.6), color: [0, 0, 1] },
      ],
      48,
      1.6,
      true,
    );
    const mesh = polygonizeBlobs(job);
    expect(mesh.color!.length).toBe(mesh.count * 3);
    for (let i = 0; i < mesh.count * 3; i += 3) {
      const left = mesh.position[i] < 0;
      expect(mesh.color![i]).toBeCloseTo(left ? 1 : 0, 5);
      expect(mesh.color![i + 2]).toBeCloseTo(left ? 0 : 1, 5);
    }
  });

  it("stops at maxVertices / maxIndices instead of overrunning", () => {
    const job = { ...sampleBlobsJob(64, 30), maxVertices: 500, maxIndices: 900 };
    const mesh = polygonizeBlobs(job);
    expect(mesh.count).toBeLessThanOrEqual(500);
    expect(mesh.index!.length).toBeLessThanOrEqual(900);
    expect(Math.max(...mesh.index!)).toBeLessThan(mesh.count);
  });

  it("no elements gives an empty mesh", () => {
    const mesh = polygonizeBlobs(blobsJob([], 32));
    expect(mesh.count).toBe(0);
  });

  it("reuses its scratch without leaking one job into the next", () => {
    const a = sampleBlobsJob(64, 40, 1);
    const b = sampleBlobsJob(32, 5, 2);
    const fresh = polygonizeBlobs(b);
    polygonizeBlobs(a);
    expectIdentical(polygonizeBlobs(b), fresh);
  });

  it.each([
    [24, 1],
    [48, 12],
    [96, 60],
  ])("the Rust/WASM build matches it bit for bit (res %i, %i elements)", (resolution, count) => {
    const wasm = instantiateWasmKernelsSync(readFileSync(join(__dirname, "tsuji_kernels.wasm")));
    const job = sampleBlobsJob(resolution, count);
    const js = polygonizeBlobs(job);
    expect(js.count).toBeGreaterThan(0);
    expectIdentical(wasm.blobs(job), js);
    // Twice: the second call reuses the kernel's grown buffers.
    expectIdentical(wasm.blobs(job), js);
  });
});
