import { getEvalProfiler } from "../evalProfiler";
import { createNodeCache } from "../nodeCaches";
import { JobKind, JobPayload, JobResult, JS_KERNELS } from "./kernels";

/**
 * Off-main-thread jobs for nodes whose evaluate is one heavy, self-contained
 * computation (a field polygonised, a CSG, a sweep). See
 * docs/offthread-geometry.md for the design; in short:
 *
 * evaluateGraph is synchronous, so a node cannot wait for a worker. It calls
 * `requestJob` every frame with a signature of its inputs and gets back the
 * newest finished result — possibly for an older signature — and whether it
 * is current. Behind that call, per node:
 *
 *   - at most one job in flight; a newer signature arriving meanwhile
 *     replaces the queued one (latest wins: while a slider is dragged only
 *     the first and the last state get computed, not every one in between),
 *   - a result whose signature is already current is never recomputed,
 *   - no executor (Node, tests), `sync` (export capture) or nothing to show
 *     yet (first evaluation) → the JS kernel runs inline, so those see an
 *     exact, current result on the very frame they ask.
 *
 * Results land between frames; the node picks them up on its next evaluate,
 * which the viewport runs every frame. That is why a node using this must not
 * be `pure`: the memo would never call it again to collect the result.
 */

export interface JobExecutor {
  run<K extends JobKind>(kind: K, payload: JobPayload<K>): Promise<{ result: JobResult<K>; ms: number }>;
  dispose?(): void;
}

export interface JobView<K extends JobKind> {
  /** Newest finished result, or null before the first one. */
  result: JobResult<K> | null;
  /** The signature `result` was computed for. */
  signature: string | null;
  /** `signature` is the one just asked for. */
  fresh: boolean;
}

interface Slot {
  kind: JobKind;
  result: unknown;
  signature: string | null;
  inflight: string | null;
  queued: { signature: string; payload: unknown } | null;
  /** Bumped whenever `result` is replaced, so a job that finishes after a newer inline result cannot overwrite it. */
  version: number;
}

const slots = createNodeCache<Slot>();

/** undefined: not chosen yet (the app installs the worker lazily); null: run inline. */
let executor: JobExecutor | null | undefined;
let executorFactory: (() => JobExecutor | null) | null = null;
let inFlight = 0;

/**
 * Where jobs run when they may run asynchronously. The app registers the Web
 * Worker factory once at startup (workerExecutor.ts); nothing registered
 * means inline, which is what Node and the test suite get.
 */
export function setJobExecutorFactory(factory: (() => JobExecutor | null) | null): void {
  executor?.dispose?.();
  executor = undefined;
  executorFactory = factory;
}

/** Installs one executor directly (the stress bench's deferred one); null forces inline. */
export function setJobExecutor(next: JobExecutor | null): void {
  executor?.dispose?.();
  executor = next;
}

function currentExecutor(): JobExecutor | null {
  if (executor === undefined) executor = executorFactory?.() ?? null;
  return executor;
}

/** Jobs sent and not yet back, across every node. */
export function jobsInFlight(): number {
  return inFlight;
}

function runInline<K extends JobKind>(slot: Slot, kind: K, signature: string, payload: JobPayload<K>): void {
  slot.result = JS_KERNELS[kind](payload);
  slot.signature = signature;
  slot.version++;
}

function dispatch(nodeId: string, slot: Slot, signature: string, payload: unknown): void {
  const exec = currentExecutor();
  if (!exec) return;
  slot.inflight = signature;
  slot.queued = null;
  const version = slot.version;
  inFlight++;
  getEvalProfiler()?.setGauge("offthread jobs in flight", inFlight);
  exec.run(slot.kind, payload as JobPayload<JobKind>).then(
    ({ result, ms }) => {
      inFlight--;
      const profiler = getEvalProfiler();
      profiler?.recordPhase(`worker: ${slot.kind}`, ms);
      profiler?.setGauge("offthread jobs in flight", inFlight);
      // Deleted (or deleted and re-added) while the job ran: the answer belongs to nobody.
      if (slots.get(nodeId) !== slot) return;
      slot.inflight = null;
      // An export frame computed a newer result inline meanwhile: keep that one.
      if (slot.version === version) {
        slot.result = result;
        slot.signature = signature;
        slot.version++;
      }
      if (slot.queued) dispatch(nodeId, slot, slot.queued.signature, slot.queued.payload);
    },
    (err) => {
      inFlight--;
      console.warn(`[offthread] ${slot.kind} job failed; running inline from now on`, err);
      // A worker that failed once (failed to load, crashed) is not trusted again this session.
      if (executor === exec) setJobExecutor(null);
      if (slots.get(nodeId) === slot) {
        slot.inflight = null;
        slot.queued = null;
      }
    },
  );
}

/**
 * Asks for `kind` computed from `payload`, identified by `signature` (equal
 * signatures must mean equal results). Returns at once with what is
 * available — see JobView. `buildPayload` is only called when a job is
 * actually started, so an unchanged signature costs nothing past building it.
 */
export function requestJob<K extends JobKind>(
  nodeId: string,
  kind: K,
  signature: string,
  buildPayload: () => JobPayload<K>,
  options: { sync?: boolean } = {},
): JobView<K> {
  let slot = slots.get(nodeId);
  if (!slot || slot.kind !== kind) {
    slot = { kind, result: null, signature: null, inflight: null, queued: null, version: 0 };
    slots.set(nodeId, slot);
  }
  if (slot.signature !== signature) {
    if (options.sync || slot.result === null || !currentExecutor()) {
      runInline(slot, kind, signature, buildPayload());
    } else if (slot.inflight === signature) {
      slot.queued = null;
    } else if (slot.inflight !== null) {
      if (slot.queued?.signature !== signature) slot.queued = { signature, payload: buildPayload() };
    } else {
      dispatch(nodeId, slot, signature, buildPayload());
    }
  } else {
    // Back to what is already shown (a scrub returned to where it was): whatever was queued is moot.
    slot.queued = null;
  }
  return { result: slot.result as JobResult<K> | null, signature: slot.signature, fresh: slot.signature === signature };
}

/**
 * Runs queued work by hand: the stress bench installs this in place of a
 * worker, so main-thread cost (what evaluate pays) and kernel cost (what the
 * worker would pay) are timed apart, in one process, deterministically.
 */
export class DeferredExecutor implements JobExecutor {
  private queue: { kind: JobKind; payload: unknown; resolve: (value: { result: unknown; ms: number }) => void }[] = [];
  /** Kernel milliseconds run by flush() so far. */
  kernelMs = 0;
  jobs = 0;

  /** `kernels` replaces some of the JS kernels — the bench passes the WASM ones to time those instead. */
  constructor(private readonly kernels: Partial<typeof JS_KERNELS> = {}) {}

  run<K extends JobKind>(kind: K, payload: JobPayload<K>): Promise<{ result: JobResult<K>; ms: number }> {
    return new Promise((resolve) => {
      this.queue.push({ kind, payload, resolve: resolve as (value: { result: unknown; ms: number }) => void });
    });
  }

  /** Runs everything queued; await the returned promise so the results are delivered before the next frame. */
  async flush(): Promise<void> {
    const queue = this.queue;
    this.queue = [];
    for (const job of queue) {
      const start = performance.now();
      const kernel = (this.kernels[job.kind] ?? JS_KERNELS[job.kind]) as (payload: JobPayload<JobKind>) => unknown;
      const result = kernel(job.payload as JobPayload<JobKind>);
      const ms = performance.now() - start;
      this.kernelMs += ms;
      this.jobs++;
      job.resolve({ result, ms });
    }
    // One macrotask: every .then above (and any dispatch they chain) has run by the time this resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
