import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MetaballsJob, polygonizeMetaballs } from "./marchingCubes";
import { referenceMesh, sampleJob } from "./marchingCubes.fixtures";
import { instantiateWasmKernelsSync } from "./wasmKernels";

/**
 * Kernel-only timing: the old main-thread path (three's MarchingCubes plus
 * the node's own copy/UV/bounds pass) against the JS kernel and its Rust/WASM
 * build, on the same jobs. Skipped by plain `npm test`. Run with:
 *
 *   TSUJI_KERNEL_BENCH=1 npx vitest run src/shared/graph/offthread/marchingCubes.bench.test.ts
 *
 * Node's V8 — the same engine as WebView2; WKWebView (macOS Tauri) is
 * JavaScriptCore, so the in-app overlay is the number that counts there.
 */
const ENABLED = process.env.TSUJI_KERNEL_BENCH === "1";

function time(run: (job: MetaballsJob) => unknown, job: MetaballsJob): number {
  for (let i = 0; i < 5; i++) run(job);
  const samples: number[] = [];
  const deadline = performance.now() + 600;
  while (samples.length < 15 || (performance.now() < deadline && samples.length < 200)) {
    const t = performance.now();
    run(job);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe.skipIf(!ENABLED)("marching-cubes kernel bench", () => {
  it("times three / JS kernel / WASM", () => {
    const wasm = instantiateWasmKernelsSync(readFileSync(join(__dirname, "tsuji_kernels.wasm")));
    const rows: string[] = ["| res | balls | verts | three (old path) ms | JS kernel ms | WASM ms | JS vs three | WASM vs JS |", "|---|---|---|---|---|---|---|---|"];
    for (const [resolution, balls] of [
      [32, 8],
      [32, 64],
      [48, 24],
      [64, 24],
      [64, 128],
      [96, 64],
    ]) {
      const job = sampleJob(resolution, balls);
      const verts = polygonizeMetaballs(job).count;
      expect(wasm.metaballs(job).count).toBe(verts);
      const three = time(referenceMesh, job);
      const js = time(polygonizeMetaballs, job);
      const w = time((j) => wasm.metaballs(j), job);
      rows.push(
        `| ${resolution} | ${balls} | ${verts} | ${three.toFixed(2)} | ${js.toFixed(2)} | ${w.toFixed(2)} | ${(three / js).toFixed(2)}× | ${(js / w).toFixed(2)}× |`,
      );
    }
    process.stdout.write(`\n${rows.join("\n")}\n\n`);
  }, 120_000);
});
