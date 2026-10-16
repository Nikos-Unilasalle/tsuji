import { MeshBuffers, MetaballsJob, polygonizeMetaballs } from "./marchingCubes";

/**
 * Every job the geometry worker knows how to run: its payload, its result,
 * and the JS kernel that computes it. The same table runs inline on the main
 * thread (headless, export capture, cold start) and inside the worker, where
 * a WASM build may stand in for the JS kernel — see geometry.worker.ts.
 *
 * Payloads and results are plain objects of numbers and typed arrays: they
 * cross postMessage by structured clone, typed arrays by transfer.
 */
export interface JobTypes {
  metaballs: { payload: MetaballsJob; result: MeshBuffers };
}

export type JobKind = keyof JobTypes;
export type JobPayload<K extends JobKind> = JobTypes[K]["payload"];
export type JobResult<K extends JobKind> = JobTypes[K]["result"];

export const JS_KERNELS: { [K in JobKind]: (payload: JobPayload<K>) => JobResult<K> } = {
  metaballs: polygonizeMetaballs,
};

/** The typed-array buffers in a payload or result — what postMessage moves instead of copying. */
export function transferablesOf(value: unknown): Transferable[] {
  const out: Transferable[] = [];
  if (!value || typeof value !== "object") return out;
  for (const field of Object.values(value)) {
    if (ArrayBuffer.isView(field) && field.buffer instanceof ArrayBuffer && !out.includes(field.buffer)) out.push(field.buffer);
  }
  return out;
}
