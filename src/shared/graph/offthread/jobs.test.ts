import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { disposeNodeCaches } from "../nodeCaches";
import { METABALLS_NODE } from "../nodes/metaballs";
import { DeferredExecutor, JobExecutor, jobsInFlight, LaneRouter, poolSize, requestJob, setJobExecutor } from "./jobs";
import { sampleJob } from "./marchingCubes.fixtures";
import { JobPayload } from "./kernels";

const ids: string[] = [];
function nodeId(): string {
  const id = `offthread-test-${ids.length}`;
  ids.push(id);
  return id;
}

afterEach(() => {
  setJobExecutor(null);
  disposeNodeCaches(ids.splice(0));
});

/** A metaballs job whose result size identifies it: n balls in a row. */
function job(balls: number): () => JobPayload<"metaballs"> {
  return () => sampleJob(24, balls, balls);
}

describe("offthread jobs", () => {
  it("runs inline when no executor is installed (Node, tests)", () => {
    const id = nodeId();
    const view = requestJob(id, "metaballs", "a", job(2));
    expect(view.fresh).toBe(true);
    expect(view.result!.count).toBeGreaterThan(0);
  });

  it("computes the first result inline, then hands later ones to the executor", async () => {
    const exec = new DeferredExecutor();
    setJobExecutor(exec);
    const id = nodeId();
    const first = requestJob(id, "metaballs", "a", job(1));
    expect(first.fresh).toBe(true);

    const second = requestJob(id, "metaballs", "b", job(3));
    // Still showing "a" while "b" is computed.
    expect(second.fresh).toBe(false);
    expect(second.signature).toBe("a");
    expect(second.result).toBe(first.result);
    expect(jobsInFlight()).toBe(1);

    await exec.flush();
    const landed = requestJob(id, "metaballs", "b", job(3));
    expect(landed.fresh).toBe(true);
    expect(landed.result!.count).toBe(requestJob(nodeId(), "metaballs", "x", job(3)).result!.count);
    expect(jobsInFlight()).toBe(0);
  });

  it("keeps one job in flight per node and drops the states in between (latest wins)", async () => {
    const exec = new DeferredExecutor();
    setJobExecutor(exec);
    const id = nodeId();
    requestJob(id, "metaballs", "s0", job(1));
    for (let i = 1; i <= 10; i++) requestJob(id, "metaballs", `s${i}`, job(1 + (i % 3)));
    expect(jobsInFlight()).toBe(1);
    await exec.flush(); // s1 lands, s10 (the queued one) is sent
    expect(requestJob(id, "metaballs", "s10", job(2)).signature).toBe("s1");
    await exec.flush();
    expect(requestJob(id, "metaballs", "s10", job(2)).fresh).toBe(true);
    expect(exec.jobs).toBe(2);
  });

  it("does not resend what is already in flight, and drops the queue on returning to the shown state", async () => {
    const exec = new DeferredExecutor();
    setJobExecutor(exec);
    const id = nodeId();
    requestJob(id, "metaballs", "a", job(1));
    requestJob(id, "metaballs", "b", job(2));
    requestJob(id, "metaballs", "b", job(2));
    requestJob(id, "metaballs", "c", job(3));
    requestJob(id, "metaballs", "b", job(2)); // c is moot: b is in flight
    await exec.flush();
    expect(exec.jobs).toBe(1);
    expect(requestJob(id, "metaballs", "b", job(2)).fresh).toBe(true);
  });

  it("answers sync requests (export capture) on the spot, and a late job cannot overwrite them", async () => {
    const exec = new DeferredExecutor();
    setJobExecutor(exec);
    const id = nodeId();
    requestJob(id, "metaballs", "a", job(1));
    requestJob(id, "metaballs", "b", job(2)); // in flight
    const captured = requestJob(id, "metaballs", "c", job(3), { sync: true });
    expect(captured.fresh).toBe(true);
    await exec.flush(); // b lands after c was computed
    const after = requestJob(id, "metaballs", "c", job(3));
    expect(after.signature).toBe("c");
    expect(after.result).toBe(captured.result);
  });

  it("drops a result whose node was deleted while it ran", async () => {
    const exec = new DeferredExecutor();
    setJobExecutor(exec);
    const id = nodeId();
    requestJob(id, "metaballs", "a", job(1));
    requestJob(id, "metaballs", "b", job(2));
    disposeNodeCaches([id]);
    await exec.flush();
    // Re-added with the same id: starts clean, does not inherit "b".
    const view = requestJob(id, "metaballs", "a", job(1));
    expect(view.signature).toBe("a");
    expect(jobsInFlight()).toBe(0);
  });

  it("falls back to inline for good when the executor fails", async () => {
    setJobExecutor({ run: () => Promise.reject(new Error("worker failed to load")) });
    const id = nodeId();
    requestJob(id, "metaballs", "a", job(1));
    requestJob(id, "metaballs", "b", job(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestJob(id, "metaballs", "c", job(3)).fresh).toBe(true);
  });
});

describe("worker pool routing", () => {
  it("sizes the pool at min(4, cores - 1), at least one", () => {
    expect(poolSize(1)).toBe(1);
    expect(poolSize(2)).toBe(1);
    expect(poolSize(4)).toBe(3);
    expect(poolSize(8)).toBe(4);
    expect(poolSize(32)).toBe(4);
    expect(poolSize(undefined)).toBe(1);
  });

  it("keeps a node on one lane and spreads new nodes over the least used", () => {
    const router = new LaneRouter(3);
    const lanes = ["a", "b", "c", "d", "e", "f"].map((id) => router.lane(id));
    expect(lanes).toEqual([0, 1, 2, 0, 1, 2]);
    expect(router.lane("b")).toBe(1);
    expect(router.lane("f")).toBe(2);
  });

  it("routes by node id, so lanes run side by side", async () => {
    const exec = new DeferredExecutor({}, 2);
    setJobExecutor(exec);
    const a = nodeId();
    const b = nodeId();
    for (const id of [a, b]) requestJob(id, "metaballs", "1", job(1));
    for (const id of [a, b]) requestJob(id, "metaballs", "2", job(2));
    await exec.flush();
    expect(exec.jobs).toBe(2);
    expect(exec.laneMs[0]).toBeGreaterThan(0);
    expect(exec.laneMs[1]).toBeGreaterThan(0);
    // The busiest lane, not the sum: what a two-worker pool waits for.
    expect(exec.criticalMs).toBeLessThan(exec.kernelMs);
    expect(requestJob(a, "metaballs", "2", job(2)).fresh).toBe(true);
    expect(requestJob(b, "metaballs", "2", job(2)).fresh).toBe(true);
  });

  it("goes inline for every node when one lane fails", async () => {
    const router = new LaneRouter(2);
    const healthy = new DeferredExecutor();
    const pool: JobExecutor = {
      run: (kind, payload, route) =>
        router.lane(route) === 1 ? Promise.reject(new Error("worker #2 crashed")) : healthy.run(kind, payload, route),
    };
    setJobExecutor(pool);
    const a = nodeId();
    const b = nodeId();
    for (const id of [a, b]) requestJob(id, "metaballs", "1", job(1));
    for (const id of [a, b]) requestJob(id, "metaballs", "2", job(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // a's lane is fine, but the pool as a whole is no longer trusted.
    expect(requestJob(a, "metaballs", "3", job(3)).fresh).toBe(true);
    expect(requestJob(b, "metaballs", "3", job(3)).fresh).toBe(true);
  });
});

describe("object/metaballs off the main thread", () => {
  const ctx = (id: string, capturing = false) => ({ time: 0, step: 0, nodeId: id, capturing }) as never;
  const params = { ...METABALLS_NODE.defaultParams, resolution: 24 };
  const at = (x: number) => ({ points: [{ x: 0, y: 0, z: 0 }, { x, y: 0, z: 0 }] });

  function surfaceOf(outputs: Record<string, unknown>): THREE.BufferGeometry {
    return (outputs.geometry as THREE.Mesh).geometry;
  }

  it("shows the previous surface until the worker's lands, on the same mesh", async () => {
    const exec = new DeferredExecutor();
    setJobExecutor(exec);
    const id = nodeId();
    const first = METABALLS_NODE.evaluate(at(0.6), params, ctx(id));
    const geometry = surfaceOf(first);
    const before = geometry.getAttribute("position").count;
    expect(before).toBeGreaterThan(0);

    const moved = METABALLS_NODE.evaluate(at(1.6), params, ctx(id));
    expect(moved.geometry).toBe(first.geometry);
    expect(surfaceOf(moved).getAttribute("position").count).toBe(before);

    await exec.flush();
    const landed = METABALLS_NODE.evaluate(at(1.6), params, ctx(id));
    expect(landed.geometry).toBe(first.geometry);
    const after = surfaceOf(landed).getAttribute("position").count;
    expect(after).not.toBe(before);
    expect(surfaceOf(landed).boundingSphere!.radius).toBeGreaterThan(0);

    // The same scene computed inline from scratch gives the same surface.
    setJobExecutor(null);
    const reference = METABALLS_NODE.evaluate(at(1.6), params, ctx(nodeId()));
    expect(surfaceOf(reference).getAttribute("position").array).toEqual(surfaceOf(landed).getAttribute("position").array);
  });

  it("is exact on a captured frame without waiting", () => {
    setJobExecutor(new DeferredExecutor());
    const id = nodeId();
    METABALLS_NODE.evaluate(at(0.6), params, ctx(id));
    const captured = METABALLS_NODE.evaluate(at(1.6), params, ctx(id, true));
    setJobExecutor(null);
    const reference = METABALLS_NODE.evaluate(at(1.6), params, ctx(nodeId()));
    expect(surfaceOf(captured).getAttribute("position").array).toEqual(surfaceOf(reference).getAttribute("position").array);
  });
});
