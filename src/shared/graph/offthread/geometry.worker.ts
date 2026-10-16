import { JobKind, JobPayload, JobResult, JS_KERNELS, transferablesOf } from "./kernels";
import { instantiateWasmKernels, WasmKernels } from "./wasmKernels";

/**
 * The geometry worker: runs one job at a time, in arrival order, and posts
 * the result back with its buffers transferred. Holds no graph state — the
 * main thread decides what to run and when (offthread/jobs.ts).
 *
 * Messages in:  { type: "init", backend } | { type: "job", id, kind, payload }
 * Messages out: { type: "ready", backend } | { type: "done", id, result, ms, backend } | { type: "failed", id, message }
 */
export type Backend = "js" | "wasm";

export type WorkerRequest =
  | { type: "init"; backend: Backend }
  | { type: "job"; id: number; kind: JobKind; payload: JobPayload<JobKind> };

export type WorkerReply =
  | { type: "ready"; backend: Backend }
  | { type: "done"; id: number; result: JobResult<JobKind>; ms: number; backend: Backend }
  | { type: "failed"; id: number; message: string };

// The app compiles against the DOM lib, not "webworker" (the two clash); this is all of the worker scope used here.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
};

let wasm: WasmKernels | null = null;
let ready: Promise<void> = Promise.resolve();

function backend(): Backend {
  return wasm ? "wasm" : "js";
}

function run(kind: JobKind, payload: JobPayload<JobKind>): JobResult<JobKind> {
  if (wasm && kind === "metaballs") return wasm.metaballs(payload);
  return JS_KERNELS[kind](payload);
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "init") {
    ready =
      message.backend === "wasm"
        ? instantiateWasmKernels(fetch(new URL("./tsuji_kernels.wasm", import.meta.url)))
            .then((kernels) => {
              wasm = kernels;
            })
            .catch((err) => {
              // The JS kernels compute the same thing; a missing or blocked .wasm only costs speed.
              console.warn("[geometry worker] WASM kernels unavailable, using JS", err);
            })
        : Promise.resolve();
    void ready.then(() => scope.postMessage({ type: "ready", backend: backend() }));
    return;
  }
  void ready.then(() => {
    try {
      const start = performance.now();
      const result = run(message.kind, message.payload);
      const ms = performance.now() - start;
      scope.postMessage({ type: "done", id: message.id, result, ms, backend: backend() }, transferablesOf(result));
    } catch (err) {
      scope.postMessage({ type: "failed", id: message.id, message: String(err) });
    }
  });
};
