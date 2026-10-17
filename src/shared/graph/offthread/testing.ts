import { JobExecutor } from "./jobs";
import { JobKind, JobPayload, JobResult, JS_KERNELS, transferablesOf } from "./kernels";

/**
 * Test double for the geometry worker: queues jobs like DeferredExecutor, but
 * moves payloads and results through structuredClone with their buffers
 * transferred, as postMessage does — so a test fails if a node keeps using an
 * array it handed over, or sends something that does not clone.
 */
export class CloningExecutor implements JobExecutor {
  private queue: (() => void)[] = [];
  jobs = 0;

  run<K extends JobKind>(kind: K, payload: JobPayload<K>): Promise<{ result: JobResult<K>; ms: number }> {
    const sent = structuredClone(payload, { transfer: transferablesOf(payload) as Transferable[] });
    return new Promise((resolve) => {
      this.queue.push(() => {
        const result = (JS_KERNELS[kind] as (p: JobPayload<K>) => JobResult<K>)(sent);
        resolve({ result: structuredClone(result, { transfer: transferablesOf(result) as Transferable[] }), ms: 0 });
      });
    });
  }

  /** Runs everything queued and lets the results land. */
  async flush(): Promise<void> {
    const queue = this.queue;
    this.queue = [];
    for (const job of queue) {
      job();
      this.jobs++;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
