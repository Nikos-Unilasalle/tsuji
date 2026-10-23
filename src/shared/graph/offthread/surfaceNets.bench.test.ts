import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { polygonizeMetaballs } from "./marchingCubes";
import { sampleJob } from "./marchingCubes.fixtures";
import { BALL_STRIDE } from "./marchingCubes";
import { BLOB_AABB, BLOB_POINT, BLOB_STRIDE, BlobsJob, polygonizeBlobs } from "./surfaceNets";
import { blobsJob, sampleBlobsJob } from "./surfaceNets.fixtures";
import { instantiateWasmKernelsSync } from "./wasmKernels";

/**
 * Surface Nets (JS and WASM) next to the legacy marching-cubes WASM kernel.
 * Skipped by plain `npm test`. Run with:
 *
 *   TSUJI_KERNEL_BENCH=1 npx vitest run src/shared/graph/offthread/surfaceNets.bench.test.ts
 */
const ENABLED = process.env.TSUJI_KERNEL_BENCH === "1";

function time(run: () => unknown): number {
  for (let i = 0; i < 3; i++) run();
  const samples: number[] = [];
  const deadline = performance.now() + 800;
  while (samples.length < 7 || (performance.now() < deadline && samples.length < 100)) {
    const t = performance.now();
    run();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe.skipIf(!ENABLED)("surface nets kernel bench", () => {
  it("times Surface Nets JS / WASM against legacy marching cubes WASM", () => {
    const wasm = instantiateWasmKernelsSync(readFileSync(join(__dirname, "tsuji_kernels.wasm")));
    const rows = [
      "| res | elements | SN verts | SN tris | SN JS ms | SN WASM ms | MC verts (same res, WASM) | MC WASM ms |",
      "|---|---|---|---|---|---|---|---|",
    ];
    for (const [resolution, count] of [
      [32, 8],
      [64, 24],
      [64, 128],
      [96, 64],
      [128, 64],
      [192, 128],
      [256, 256],
    ]) {
      const job: BlobsJob = sampleBlobsJob(resolution, count);
      const sn = wasm.blobs(job);
      const js = time(() => polygonizeBlobs(job));
      const w = time(() => wasm.blobs(job));
      const mcJob = resolution <= 96 ? sampleJob(resolution, count) : null;
      const mc = mcJob ? time(() => wasm.metaballs(mcJob)) : NaN;
      const mcVerts = mcJob ? polygonizeMetaballs(mcJob).count : NaN;
      rows.push(
        `| ${resolution} | ${count} | ${sn.count} | ${sn.index!.length / 3} | ${js.toFixed(2)} | ${w.toFixed(2)} | ${mcJob ? mcVerts : "— (max 96)"} | ${mcJob ? mc.toFixed(2) : "—"} |`,
      );
    }
    process.stdout.write(`\n${rows.join("\n")}\n\n`);

    // Like for like: marching cubes' sample scene (spheres of radius 0.5 in a
    // 6-unit field cube) as Surface Nets elements, at the same cell size.
    const fair = [
      "| MC res | balls | MC verts / tris | MC WASM ms | SN res (same cell) | SN verts / tris | SN WASM ms |",
      "|---|---|---|---|---|---|---|",
    ];
    for (const [resolution, balls] of [
      [32, 8],
      [48, 24],
      [64, 24],
      [64, 128],
      [96, 64],
    ]) {
      const mcJob = sampleJob(resolution, balls);
      const mc = wasm.metaballs(mcJob);
      const specs = [];
      for (let i = 0; i < balls; i++) {
        const b = mcJob.balls;
        const o = i * BALL_STRIDE;
        const toWorld = (v: number, c: number) => (v - 0.5) * mcJob.size + c;
        specs.push({ kind: BLOB_POINT, a: [toWorld(b[o], mcJob.centerX), toWorld(b[o + 1], mcJob.centerY), toWorld(b[o + 2], mcJob.centerZ)] as const, radius: 0.5, smooth: 1, weight: 1 });
      }
      const probe = blobsJob(specs as never, 1);
      // Longest side of the elements' box, from a 1-cell probe grid's own fit.
      const e = probe.elements;
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < e.length; i += BLOB_STRIDE) {
          mn = Math.min(mn, e[i + BLOB_AABB + k]);
          mx = Math.max(mx, e[i + BLOB_AABB + 3 + k]);
        }
        if (mx - mn > hi - lo) [lo, hi] = [mn, mx];
      }
      const snRes = Math.max(8, Math.round((hi - lo) / (mcJob.size / resolution)));
      const snJob = blobsJob(specs as never, snRes);
      const sn = wasm.blobs(snJob);
      fair.push(
        `| ${resolution} | ${balls} | ${mc.count} / ${mc.count / 3} | ${time(() => wasm.metaballs(mcJob)).toFixed(2)} | ${snRes} | ${sn.count} / ${sn.index!.length / 3} | ${time(() => wasm.blobs(snJob)).toFixed(2)} |`,
      );
    }
    process.stdout.write(`\n${fair.join("\n")}\n\n`);
  }, 300_000);
});
