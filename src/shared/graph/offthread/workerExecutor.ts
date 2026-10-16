import type { Backend, WorkerReply, WorkerRequest } from "./geometry.worker";
import { JobExecutor, setJobExecutorFactory } from "./jobs";
import { JobKind, JobPayload, JobResult, transferablesOf } from "./kernels";

/**
 * The browser side of geometry.worker.ts: one dedicated worker, jobs matched
 * to replies by id. Payload buffers are transferred, not copied — the
 * scheduler builds a fresh payload per job, so nothing on this side reads
 * them again.
 */
export class WorkerExecutor implements JobExecutor {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: { result: unknown; ms: number }) => void; reject: (e: unknown) => void }>();
  /** What the worker actually runs once initialised ("wasm" can fall back to "js"). */
  backend: Backend | null = null;

  constructor(requested: Backend) {
    this.worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module", name: "tsuji-geometry" });
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === "ready") {
        this.backend = reply.backend;
        return;
      }
      const job = this.pending.get(reply.id);
      if (!job) return;
      this.pending.delete(reply.id);
      if (reply.type === "done") {
        this.backend = reply.backend;
        job.resolve({ result: reply.result, ms: reply.ms });
      } else {
        job.reject(new Error(reply.message));
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(`geometry worker error: ${event.message}`);
      for (const job of this.pending.values()) job.reject(error);
      this.pending.clear();
    };
    this.post({ type: "init", backend: requested });
  }

  private post(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  run<K extends JobKind>(kind: K, payload: JobPayload<K>): Promise<{ result: JobResult<K>; ms: number }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: { result: unknown; ms: number }) => void, reject });
      this.post({ type: "job", id, kind, payload }, transferablesOf(payload));
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const job of this.pending.values()) job.reject(new Error("geometry worker disposed"));
    this.pending.clear();
  }
}

/** Unset = the default. `localStorage["tsuji.offthread"]` = "off" | "js" | "wasm" overrides it, for A/B in the profiler overlay. */
export const DEFAULT_BACKEND: Backend = "wasm";

export function createWorkerExecutor(): JobExecutor | null {
  if (typeof Worker === "undefined") return null;
  let choice: string | null = null;
  try {
    choice = globalThis.localStorage?.getItem("tsuji.offthread") ?? null;
  } catch {
    // Storage blocked: defaults.
  }
  if (choice === "off") return null;
  try {
    return new WorkerExecutor(choice === "js" ? "js" : choice === "wasm" ? "wasm" : DEFAULT_BACKEND);
  } catch (err) {
    console.warn("[offthread] could not start the geometry worker; running inline", err);
    return null;
  }
}

/**
 * Called once at startup (main.tsx). The worker itself starts on the first
 * job, so a project without such nodes never spawns it.
 * `__tsuji.offthread.use("js" | "wasm" | "off")` switches backend live, for
 * A/B timing in the profiler overlay (Ctrl/Cmd+Shift+P, "worker: …" rows).
 */
export function installGeometryWorker(): void {
  setJobExecutorFactory(createWorkerExecutor);
  const w = window as unknown as { __tsuji?: Record<string, unknown> };
  w.__tsuji = {
    ...w.__tsuji,
    offthread: {
      use(choice: "js" | "wasm" | "off") {
        localStorage.setItem("tsuji.offthread", choice);
        setJobExecutorFactory(createWorkerExecutor);
      },
    },
  };
}
