import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planClip } from "./clipPlan";
import { getOrCreatePlayer, syncClip } from "./audioStore";

/** A Web Audio stand-in: enough to see which sources start, where, and when they stop. */
class FakeSource {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  playbackRate = { value: 1 };
  started: unknown[] | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start(...args: unknown[]) {
    this.started = args;
  }
  stop() {
    this.stopped = true;
  }
}

let sources: FakeSource[];
let clock: { now: number };

class FakeContext {
  state = "running";
  destination = {};
  get currentTime() {
    return clock.now;
  }
  createBufferSource() {
    const s = new FakeSource();
    sources.push(s);
    return s;
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createMediaElementSource() {
    return { connect() {}, disconnect() {} };
  }
  resume() {
    return Promise.resolve();
  }
}

const BASE = { fps: 30, startFrame: 0, clipStart: 0, clipEnd: 0, clipLength: 10, loop: false, rate: 1 };
const OPTS = { rate: 1, loop: false, tolerance: 0.06 };

beforeEach(() => {
  sources = [];
  clock = { now: 100 };
  (globalThis as unknown as { window: unknown }).window = { AudioContext: FakeContext, addEventListener() {}, removeEventListener() {} };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function player(id: string) {
  const p = getOrCreatePlayer(id);
  p.buffer = { duration: 10 } as AudioBuffer;
  return p;
}

describe("syncClip", () => {
  it("starts a source at the planned offset, and for exactly the time left before the stop point", () => {
    const p = player("a");
    syncClip(p, planClip({ ...BASE, frame: 0, clipStart: 4, clipEnd: 7 }), OPTS);
    expect(sources).toHaveLength(1);
    expect(sources[0].started).toEqual([0, 4, 3]);
  });

  it("leaves a source that is keeping time alone", () => {
    const p = player("b");
    syncClip(p, planClip({ ...BASE, frame: 0 }), OPTS);
    clock.now += 1; // one second later the timeline is at frame 30 too
    syncClip(p, planClip({ ...BASE, frame: 30 }), OPTS);
    expect(sources).toHaveLength(1);
  });

  it("starts again at the start point when the timeline comes back to zero", () => {
    const p = player("c");
    syncClip(p, planClip({ ...BASE, frame: 0, clipStart: 2 }), OPTS);
    clock.now += 5;
    syncClip(p, planClip({ ...BASE, frame: 150, clipStart: 2 }), OPTS);
    expect(sources).toHaveLength(1);
    // the playhead wraps: frame 0 again
    clock.now += 0.033;
    syncClip(p, planClip({ ...BASE, frame: 0, clipStart: 2 }), OPTS);
    expect(sources).toHaveLength(2);
    expect(sources[0].stopped).toBe(true);
    expect(sources[1].started?.[1]).toBe(2);
  });

  it("goes quiet when the plan does (paused timeline, before the start frame, past the stop point)", () => {
    const p = player("d");
    syncClip(p, planClip({ ...BASE, frame: 0 }), OPTS);
    syncClip(p, { ...planClip({ ...BASE, frame: 0 }), active: false }, OPTS);
    expect(sources[0].stopped).toBe(true);
    expect(p.clip).toBeUndefined();
  });

  it("loops the region natively", () => {
    const p = player("e");
    syncClip(p, planClip({ ...BASE, frame: 0, clipStart: 4, clipEnd: 7, loop: true }), { ...OPTS, loop: true });
    expect(sources[0]).toMatchObject({ loop: true, loopStart: 4, loopEnd: 7 });
  });
});
