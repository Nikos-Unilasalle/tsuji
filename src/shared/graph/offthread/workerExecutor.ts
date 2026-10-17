import type { Backend, WorkerReply, WorkerRequest } from "./geometry.worker";
import { JobExecutor, LaneRouter, poolSize, setJobExecutorFactory } from "./jobs";
import { JobKind, JobPayload, JobResult, transferablesOf } from "./kernels";

/**
 * The browser side of geometry.worker.ts: one dedicated worker, jobs matched
 * to replies by id. WorkerPool below runs several of these. Payload buffers are transferred, not copied — the
 * scheduler builds a fresh payload per job, so nothing on this side reads
 * them again.
 */
export class WorkerExecutor implements JobExecutor {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: { result: unknown; ms: number }) => void; reject: (e: unknown) => void }>();
  /** What the worker actually runs once initialised ("wasm" can fall back to "js"). */
  backend: Backend | null = null;

  constructor(requested: Backend, name = "tsuji-geometry") {
    this.worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module", name });
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

/**
 * Several geometry workers, `poolSize(hardwareConcurrency)` of them. Jobs are
 * routed by node id (LaneRouter), so a node always lands on the same worker:
 * its jobs stay in order and that worker's scratch (marching-cubes field,
 * WASM memory) stays sized for it. Each worker starts on the first job routed
 * to it, so a project with one heavy node spawns one. A failure on any worker
 * rejects that job, and the scheduler then drops the whole pool (jobs.ts).
 */
export class WorkerPool implements JobExecutor {
  private readonly workers: (WorkerExecutor | null)[];
  private readonly router: LaneRouter;

  constructor(
    private readonly requested: Backend,
    size: number,
  ) {
    this.router = new LaneRouter(size);
    this.workers = new Array(size).fill(null);
  }

  get size(): number {
    return this.workers.length;
  }

  /** Backend of the first started worker (they all get the same request). */
  get backend(): Backend | null {
    return this.workers.find((w) => w?.backend)?.backend ?? null;
  }

  run<K extends JobKind>(kind: K, payload: JobPayload<K>, route: string): Promise<{ result: JobResult<K>; ms: number; lane: number }> {
    const lane = this.router.lane(route);
    let worker = this.workers[lane];
    if (!worker) {
      try {
        worker = this.workers[lane] = new WorkerExecutor(this.requested, `tsuji-geometry-${lane + 1}`);
      } catch (err) {
        // Same as a worker that fails to load: the job rejects and the scheduler goes inline.
        return Promise.reject(err);
      }
    }
    return worker.run(kind, payload).then((reply) => ({ ...reply, lane }));
  }

  dispose(): void {
    for (const worker of this.workers) worker?.dispose();
    this.workers.fill(null);
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
    const backend = choice === "js" ? "js" : choice === "wasm" ? "wasm" : DEFAULT_BACKEND;
    return new WorkerPool(backend, poolSize(globalThis.navigator?.hardwareConcurrency));
  } catch (err) {
    console.warn("[offthread] could not start the geometry workers; running inline", err);
    return null;
  }
}

/**
 * Called once at startup (main.tsx). Workers start on the first job routed to
 * them, so a project without such nodes never spawns one.
 * `__tsuji.offthread.use("js" | "wasm" | "off")` switches backend live, for
 * A/B timing in the profiler overlay (Ctrl/Cmd+Shift+P, "worker: …" rows per
 * job kind, "worker #N busy" per pool worker).
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
