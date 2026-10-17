import { BooleanJob, BooleanResult, evaluateBoolean } from "./csg";
import { CurveTubeJob, sweepCurveTube, TubeBuffers } from "./curveTube";
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
  curveTube: { payload: CurveTubeJob; result: TubeBuffers };
  boolean: { payload: BooleanJob; result: BooleanResult };
}

export type JobKind = keyof JobTypes;
export type JobPayload<K extends JobKind> = JobTypes[K]["payload"];
export type JobResult<K extends JobKind> = JobTypes[K]["result"];

export const JS_KERNELS: { [K in JobKind]: (payload: JobPayload<K>) => JobResult<K> } = {
  metaballs: polygonizeMetaballs,
  curveTube: sweepCurveTube,
  boolean: evaluateBoolean,
};

/**
 * The typed-array buffers in a payload or result — what postMessage moves
 * instead of copying. Looks into nested objects (a boolean's two sides, their
 * attribute maps); arrays of plain values (a curve's JSON) are skipped.
 */
export function transferablesOf(value: unknown, out: Transferable[] = []): Transferable[] {
  if (!value || typeof value !== "object") return out;
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer && !out.includes(value.buffer)) out.push(value.buffer);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === "object") for (const item of value) transferablesOf(item, out);
    return out;
  }
  for (const field of Object.values(value)) transferablesOf(field, out);
  return out;
}
