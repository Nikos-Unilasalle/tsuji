import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "./storage";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { disposeEvalSession, evaluateGraph, setEvalMemoEnabled } from "./evaluate";
import { getEvalProfiler, startEvalProfiling, stopEvalProfiling } from "./evalProfiler";
import { initBvhRaycast } from "../three/bvh";
import { DeferredExecutor, poolSize, setJobExecutor } from "./offthread/jobs";
import { instantiateWasmKernelsSync } from "./offthread/wasmKernels";
import { Connection, Graph, KeyframeStore, NodeInstance } from "./types";

/**
 * Headless stress bench: every demo in public/demos merged into ONE graph,
 * repeated COPIES times, evaluated for FRAMES frames with the per-node
 * profiler on. The same input every run (seeded Math.random), so two runs —
 * before and after a change — compare like for like.
 *
 * Skipped by plain `npm test`. Run with:
 *
 *   npm run stress                                    # 1 copy, 120 frames
 *   TSUJI_STRESS_COPIES=4 TSUJI_STRESS_FRAMES=60 npm run stress
 *   TSUJI_STRESS_FILTER=shan_shui,rig npm run stress  # only matching demos
 *   TSUJI_STRESS_STATIC=1 npm run stress              # paused on one frame
 *   TSUJI_STRESS_NOMEMO=1 npm run stress              # pure-node memo off (baseline)
 *   TSUJI_STRESS_OFFTHREAD=1 npm run stress           # worker-capable nodes (offthread/jobs.ts) as in the app
 *   TSUJI_STRESS_OFFTHREAD=wasm npm run stress        # … with the Rust/WASM kernels the app's worker runs
 *   TSUJI_STRESS_OFFTHREAD=1 TSUJI_STRESS_WORKERS=1 npm run stress  # … routed over 1 worker instead of the app's pool size
 *
 * With OFFTHREAD, such nodes' kernels are queued as the app would post them
 * to its geometry worker and run between frames, outside the timed
 * evaluation — the frame times are then what the main thread pays, and the
 * kernel time is reported on its own line (and as "worker: …" phases), split
 * over the lanes of a pool sized as the app would size it on this machine:
 * the busiest lane per frame is how long the pool needs to deliver a frame.
 * Without it they run inline, as they do in Node and in the test suite.
 *
 * Measures evaluation only (CPU, main thread in the app): no WebGL, no scene
 * sync, no draw — the in-app overlay (Ctrl+Shift+P) covers those. Writes the
 * full report to scratch/stress/.
 */

const ENABLED = process.env.TSUJI_STRESS === "1";
const COPIES = Number(process.env.TSUJI_STRESS_COPIES ?? 1);
const FRAMES = Number(process.env.TSUJI_STRESS_FRAMES ?? 120);
const FILTER = (process.env.TSUJI_STRESS_FILTER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** Paused on one frame: what an idle or orbiting viewport costs — the work a dirty check could skip. */
const STATIC = process.env.TSUJI_STRESS_STATIC === "1";
/** Every node every frame, as before the pure-node memo — the baseline to compare against. */
const NO_MEMO = process.env.TSUJI_STRESS_NOMEMO === "1";
/** Worker-capable nodes hand their kernels to a deferred executor, flushed between frames. */
const OFFTHREAD = process.env.TSUJI_STRESS_OFFTHREAD === "1" || process.env.TSUJI_STRESS_OFFTHREAD === "wasm";
const OFFTHREAD_WASM = process.env.TSUJI_STRESS_OFFTHREAD === "wasm";
/** Worker pool size jobs are routed over; the app's `poolSize(hardwareConcurrency)` by default. */
const WORKERS = Number(process.env.TSUJI_STRESS_WORKERS ?? poolSize(availableParallelism()));
const FPS = 30;
const DEMO_DIR = join(process.cwd(), "public/demos");

/** mulberry32 — a fixed stream so nodes that roll Math.random see the same numbers every run. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Swap every string that is exactly one of `ids` (a node reference inside params) for its prefixed form. */
function remapIds(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapIds(v, ids));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = remapIds(v, ids);
    return out;
  }
  return value;
}

function appendPrefixed(target: Graph, source: Graph, prefix: string): void {
  const ids = new Map(source.nodes.map((n) => [n.id, `${prefix}${n.id}`]));
  for (const n of source.nodes) {
    const node: NodeInstance = {
      ...n,
      id: ids.get(n.id)!,
      params: remapIds(n.params, ids) as Record<string, unknown>,
    };
    target.nodes.push(node);
  }
  for (const c of source.connections) {
    const conn: Connection = {
      ...c,
      id: `${prefix}${c.id}`,
      fromNode: ids.get(c.fromNode) ?? c.fromNode,
      toNode: ids.get(c.toNode) ?? c.toNode,
    };
    target.connections.push(conn);
  }
  const kf: KeyframeStore = target.keyframes ?? (target.keyframes = {});
  for (const [nodeId, tracks] of Object.entries(source.keyframes ?? {})) {
    kf[ids.get(nodeId) ?? `${prefix}${nodeId}`] = tracks;
  }
}

function buildStressGraph(): { graph: Graph; demos: string[] } {
  const files = readdirSync(DEMO_DIR)
    .filter((f) => f.endsWith(".tsuji"))
    .filter((f) => FILTER.length === 0 || FILTER.some((p) => f.includes(p)))
    .sort();
  const graph: Graph = { nodes: [], connections: [], keyframes: {}, markers: [], exposedParams: [] };
  for (let copy = 0; copy < COPIES; copy++) {
    for (const file of files) {
      // Re-parsed per copy: every copy owns its params objects, as separately built scenes would.
      const project = deserializeProject(readFileSync(join(DEMO_DIR, file), "utf8"), DEFAULT_REGISTRY);
      const source = project.canvases.find((c) => c.nodes.length > 0);
      if (!source) continue;
      appendPrefixed(graph, source, `c${copy}:${file.replace(/\.tsuji$/, "")}:`);
    }
  }
  return { graph, demos: files };
}

describe.skipIf(!ENABLED)("stress bench", () => {
  it(
    "evaluates the merged demo scene",
    async () => {
      initBvhRaycast();
      const realRandom = Math.random;
      Math.random = seededRandom(0x75756a69);

      // Geometry gauges. A geometry counts as "built" the first time it is
      // given an attribute — that skips the empty placeholder every
      // `new Mesh()` (and so every Mesh.clone()) allocates and throws away.
      // A built geometry that is never disposed is, in the app, a GPU buffer
      // that stays allocated once it has been drawn.
      const built = new WeakSet<THREE.BufferGeometry>();
      // Strong on purpose, and only while profiling: what is left in here at
      // the end is what was never disposed, by the node type that built it.
      const liveByType = new Map<THREE.BufferGeometry, string>();
      let tracking = false;
      let builtCount = 0;
      let builtDisposed = 0;
      const realSetAttribute = THREE.BufferGeometry.prototype.setAttribute;
      const realDispose = THREE.BufferGeometry.prototype.dispose;
      THREE.BufferGeometry.prototype.setAttribute = function (this: THREE.BufferGeometry, ...args) {
        if (!built.has(this)) {
          built.add(this);
          builtCount++;
          if (tracking) liveByType.set(this, getEvalProfiler()?.currentType ?? "(outside evaluate)");
        }
        return realSetAttribute.apply(this, args) as never;
      };
      THREE.BufferGeometry.prototype.dispose = function (this: THREE.BufferGeometry) {
        if (built.has(this)) {
          built.delete(this);
          liveByType.delete(this);
          builtDisposed++;
        }
        return realDispose.call(this);
      };
      // Object3D ids come from one global counter: a throwaway's id tells how many exist.
      const object3DId = () => new THREE.Object3D().id;

      const sessionId = "stress-bench";
      setEvalMemoEnabled(!NO_MEMO);
      try {
        const { graph, demos } = buildStressGraph();
        expect(graph.nodes.length).toBeGreaterThan(0);

        // Frame 0 is the cold build (caches empty, BVHs built): timed on its own.
        const ctx = (rawFrame: number) => {
          const frame = STATIC ? 1 : rawFrame;
          return {
            time: frame / FPS,
            step: frame,
            nodeId: "",
            renderSize: { width: 1920, height: 1080 },
            fps: FPS,
            currentFrame: frame,
            keyframes: graph.keyframes,
            sessionId,
            isPlaying: !STATIC,
            simulationRun: !STATIC,
          } as never;
        };

        const wasm = OFFTHREAD_WASM
          ? instantiateWasmKernelsSync(readFileSync(join(process.cwd(), "src/shared/graph/offthread/tsuji_kernels.wasm")))
          : null;
        const deferred = OFFTHREAD ? new DeferredExecutor(wasm ? { metaballs: (job) => wasm.metaballs(job) } : {}, WORKERS) : null;
        setJobExecutor(deferred);

        const coldStart = performance.now();
        evaluateGraph(graph, DEFAULT_REGISTRY, ctx(0));
        const coldMs = performance.now() - coldStart;

        (globalThis as { gc?: () => void }).gc?.();
        const heapBefore = process.memoryUsage().heapUsed;
        const builtBefore = builtCount;
        const disposedBefore = builtDisposed;
        const objectsBefore = object3DId();

        const profiler = startEvalProfiling();
        profiler.reset();
        profiler.counter = () => builtCount;
        tracking = true;
        let wallMs = 0;
        for (let frame = 1; frame <= FRAMES; frame++) {
          const start = performance.now();
          evaluateGraph(graph, DEFAULT_REGISTRY, ctx(frame));
          wallMs += performance.now() - start;
          // The worker's share: between frames, untimed, results delivered before the next one.
          if (deferred) await deferred.flush();
        }
        tracking = false;

        (globalThis as { gc?: () => void }).gc?.();
        const heapAfter = process.memoryUsage().heapUsed;
        const created = builtCount - builtBefore;
        const freed = builtDisposed - disposedBefore;
        const objects = object3DId() - objectsBefore - 1;

        const report = profiler.report();
        const nodeSum = report.byNode.reduce((s, n) => s + n.totalMs, 0) / Math.max(1, report.frames.count);
        profiler.setGauge("geometries built/frame", created / FRAMES);
        profiler.setGauge("built never disposed/frame", (created - freed) / FRAMES);
        profiler.setGauge("Object3D created/frame", objects / FRAMES);
        profiler.setGauge("heap growth KB/frame", (heapAfter - heapBefore) / 1024 / FRAMES);

        const header = [
          `stress bench${STATIC ? " (static)" : ""}${NO_MEMO ? " (memo off)" : ""}${OFFTHREAD ? ` (off-thread, ${OFFTHREAD_WASM ? "WASM" : "JS"} kernels)` : ""} — ${demos.length} demos × ${COPIES} copies = ${graph.nodes.length} nodes, ${graph.connections.length} wires`,
          `cold first frame ${coldMs.toFixed(1)} ms · ${FRAMES} frames in ${(wallMs / 1000).toFixed(2)} s · ${(FRAMES / (wallMs / 1000)).toFixed(1)} eval/s (budget 16.7 ms at 60 fps)`,
          `node evaluate ${nodeSum.toFixed(2)} ms/frame · evaluator overhead ${(report.frames.meanMs - nodeSum).toFixed(2)} ms/frame`,
          ...(deferred
            ? [
                `off-thread kernels: ${deferred.jobs} jobs, ${(deferred.kernelMs / FRAMES).toFixed(2)} ms/frame — worker time, not in the frame times`,
                `worker pool ×${WORKERS}: busiest lane ${(deferred.criticalMs / FRAMES).toFixed(2)} ms/frame (wall clock) · per lane ${deferred.laneMs.map((ms) => (ms / FRAMES).toFixed(2)).join(" / ")} ms/frame`,
              ]
            : []),
          "(group nodes include their inner nodes' time)",
          "",
        ].join("\n");
        const text = [
          header + profiler.format(30),
          "",
          "── by geometry allocations ──",
          profiler.format(15, "allocs").split("\n\n").slice(-2, -1)[0].split("\n").slice(1).join("\n"),
        ].join("\n");
        const leaks = new Map<string, number>();
        for (const type of liveByType.values()) leaks.set(type, (leaks.get(type) ?? 0) + 1);
        const leakLines = [...leaks.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([type, n]) => `${type.padEnd(34)}${String(n).padStart(7)}${(n / FRAMES).toFixed(1).padStart(10)}/frame`);
        const fullText = [
          text,
          "",
          `── built geometries never disposed after ${FRAMES} frames (one frame's worth can be a legitimate cache) ──`,
          ...leakLines,
        ].join("\n");
        console.log(fullText);

        const outDir = join(process.cwd(), "scratch/stress");
        mkdirSync(outDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(outDir, `stress-${stamp}.txt`), fullText);
        writeFileSync(
          join(outDir, `stress-${stamp}.json`),
          JSON.stringify(
            { copies: COPIES, frameCount: FRAMES, demos, coldMs, wallMs, undisposedByType: Object.fromEntries(leaks), ...profiler.report() },
            null,
            2,
          ),
        );
      } finally {
        stopEvalProfiling();
        setJobExecutor(null);
        disposeEvalSession(sessionId);
        setEvalMemoEnabled(true);
        THREE.BufferGeometry.prototype.dispose = realDispose;
        THREE.BufferGeometry.prototype.setAttribute = realSetAttribute;
        Math.random = realRandom;
      }
    },
    30 * 60_000,
  );
});
