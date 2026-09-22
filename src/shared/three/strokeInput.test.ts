import { describe, expect, it } from "vitest";
import {
  applyPressureCurve,
  collectPointerSamples,
  createPressureTracker,
  createStabilizer,
  resolveSamplePressure,
  tiltToBrushAngle,
  type PointerSample,
} from "./strokeInput";

function fakePointerEvent(
  overrides: Partial<PointerEvent> & { coalesced?: Partial<PointerEvent>[] } = {},
): PointerEvent {
  const { coalesced, ...rest } = overrides;
  const base = {
    clientX: 0,
    clientY: 0,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    timeStamp: 100,
    pointerType: "pen",
    ...rest,
  };
  const ev = {
    ...base,
    getCoalescedEvents: coalesced
      ? () => coalesced.map((c) => ({ ...base, ...c }) as PointerEvent)
      : undefined,
  };
  return ev as unknown as PointerEvent;
}

function sample(overrides: Partial<PointerSample> = {}): PointerSample {
  return {
    x: 0,
    y: 0,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    time: 0,
    pointerType: "pen",
    isPen: true,
    ...overrides,
  };
}

describe("collectPointerSamples", () => {
  it("returns every coalesced sample the tablet reported", () => {
    const e = fakePointerEvent({
      clientX: 30,
      clientY: 30,
      coalesced: [
        { clientX: 10, clientY: 10, pressure: 0.2, timeStamp: 100 },
        { clientX: 20, clientY: 20, pressure: 0.4, timeStamp: 104 },
        { clientX: 30, clientY: 30, pressure: 0.6, timeStamp: 108 },
      ],
    });

    const samples = collectPointerSamples(e);
    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.x)).toEqual([10, 20, 30]);
    expect(samples.map((s) => s.pressure)).toEqual([0.2, 0.4, 0.6]);
  });

  it("falls back to the event itself when coalescing is unsupported", () => {
    const samples = collectPointerSamples(fakePointerEvent({ clientX: 7, clientY: 9, pressure: 0.5 }));
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ x: 7, y: 9, pressure: 0.5, isPen: true });
  });

  it("discards the constant 0.5 pressure a mouse reports", () => {
    const samples = collectPointerSamples(fakePointerEvent({ pointerType: "mouse", pressure: 0.5 }));
    expect(samples[0].isPen).toBe(false);
    expect(samples[0].pressure).toBe(0);
  });
});

describe("applyPressureCurve", () => {
  it("is identity-like at gamma 1 across the full range", () => {
    expect(applyPressureCurve(0, { gamma: 1, min: 0, max: 1 })).toBeCloseTo(0);
    expect(applyPressureCurve(0.5, { gamma: 1, min: 0, max: 1 })).toBeCloseTo(0.5);
    expect(applyPressureCurve(1, { gamma: 1, min: 0, max: 1 })).toBeCloseTo(1);
  });

  it("gamma below 1 thickens light touches, above 1 thins them", () => {
    const soft = applyPressureCurve(0.3, { gamma: 0.5, min: 0, max: 1 });
    const hard = applyPressureCurve(0.3, { gamma: 2, min: 0, max: 1 });
    expect(soft).toBeGreaterThan(0.3);
    expect(hard).toBeLessThan(0.3);
  });

  it("clamps the output into the configured min/max band", () => {
    expect(applyPressureCurve(0, { min: 0.2, max: 0.8 })).toBeCloseTo(0.2);
    expect(applyPressureCurve(1, { min: 0.2, max: 0.8 })).toBeCloseTo(0.8);
  });
});

describe("resolveSamplePressure", () => {
  it("uses hardware pressure for pen samples", () => {
    const pr = resolveSamplePressure(sample({ pressure: 0.42 }), null, { gamma: 1, min: 0, max: 1 });
    expect(pr).toBeCloseTo(0.42);
  });

  it("simulates velocity-based pressure when the device reports none", () => {
    const prev = sample({ pointerType: "mouse", isPen: false, x: 0, y: 0, time: 0 });
    const slow = resolveSamplePressure(sample({ pointerType: "mouse", isPen: false, x: 2, y: 0, time: 16 }), prev);
    const fast = resolveSamplePressure(sample({ pointerType: "mouse", isPen: false, x: 90, y: 0, time: 16 }), prev);
    expect(slow).toBeGreaterThan(fast);
  });

  it("never lets a pen sample override hardware pressure with simulation", () => {
    const prev = sample({ x: 0, y: 0, time: 0, pressure: 0.9 });
    const fastPen = sample({ x: 200, y: 0, time: 16, pressure: 0.9 });
    expect(resolveSamplePressure(fastPen, prev, { gamma: 1, min: 0, max: 1 })).toBeCloseTo(0.9);
  });
});

describe("createPressureTracker", () => {
  const mouse = (x: number, time: number) =>
    sample({ pointerType: "mouse", isPen: false, x, y: 0, time });

  it("does not spike when the hand decelerates before lifting", () => {
    const tracker = createPressureTracker({ gamma: 1, min: 0, max: 1 });
    let prev = mouse(0, 0);
    let fastPressure = 0;
    // Fast run: 40px per 8ms sample.
    for (let i = 1; i <= 15; i++) {
      const s = mouse(i * 40, i * 8);
      fastPressure = tracker.next(s, prev);
      prev = s;
    }
    // Dwell: 12 samples barely moving, as a hand does before pen-up.
    let dwellPressure = fastPressure;
    for (let i = 1; i <= 12; i++) {
      const s = mouse(600 + i * 0.2, 120 + i * 8);
      dwellPressure = tracker.next(s, prev);
      prev = s;
    }
    // The old exp(-speed) mapping jumped straight to 1.0 here — a blob.
    expect(fastPressure).toBeLessThan(0.35);
    expect(dwellPressure).toBeLessThan(fastPressure + 0.5);
  });

  it("still thins instantly when the pen accelerates", () => {
    const tracker = createPressureTracker({ gamma: 1, min: 0, max: 1 });
    let prev = mouse(0, 0);
    const slow = tracker.next(mouse(1, 16), prev);
    prev = mouse(1, 16);
    const fast = tracker.next(mouse(200, 32), prev);
    expect(fast).toBeLessThan(slow);
  });

  it("passes hardware pressure through untouched and reports it", () => {
    const tracker = createPressureTracker({ gamma: 1, min: 0, max: 1 });
    expect(tracker.usedHardware()).toBe(false);
    expect(tracker.next(sample({ pressure: 0.9, x: 0, time: 0 }), null)).toBeCloseTo(0.9);
    expect(tracker.next(sample({ pressure: 0.2, x: 1, time: 8 }), sample({ pressure: 0.9 }))).toBeCloseTo(0.2);
    expect(tracker.usedHardware()).toBe(true);
  });
});

describe("tiltToBrushAngle", () => {
  it("returns null for devices without tilt", () => {
    expect(tiltToBrushAngle(sample({ pointerType: "mouse", isPen: false }))).toBeNull();
    expect(tiltToBrushAngle(sample({ tiltX: 0, tiltY: 0 }))).toBeNull();
  });

  it("maps tilt to an angle and a normalized inclination", () => {
    const res = tiltToBrushAngle(sample({ tiltX: 45, tiltY: 0 }));
    expect(res?.angle).toBeCloseTo(0);
    expect(res?.inclination).toBeCloseTo(0.5);
  });
});

describe("createStabilizer", () => {
  it("passes input straight through in none mode", () => {
    const st = createStabilizer("none", 1);
    st.begin({ x: 0, y: 0 });
    expect(st.push({ x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
    expect(st.finish({ x: 100, y: 50 })).toHaveLength(0);
  });

  it("damps jitter in basic mode without straying off the path", () => {
    const st = createStabilizer("basic", 1);
    st.begin({ x: 0, y: 0 });
    const out = st.push({ x: 100, y: 0 });
    expect(out.x).toBeGreaterThan(0);
    expect(out.x).toBeLessThan(100);
    expect(out.y).toBeCloseTo(0);
  });

  it("removes high-frequency tremor in weighted mode", () => {
    const st = createStabilizer("weighted", 1);
    st.begin({ x: 0, y: 0 });
    let maxDeviation = 0;
    // A straight run along x, with 1px of alternating tremor on y.
    for (let i = 1; i <= 40; i++) {
      const out = st.push({ x: i, y: i % 2 === 0 ? 1 : -1 });
      // Ignore the warm-up while the averaging window fills.
      if (i > 20) maxDeviation = Math.max(maxDeviation, Math.abs(out.y));
    }
    expect(maxDeviation).toBeLessThan(0.6);
  });

  it("trails the cursor by the pull radius in stabilizer mode, then catches up", () => {
    const st = createStabilizer("stabilizer", 1);
    st.begin({ x: 0, y: 0 });
    const out = st.push({ x: 20, y: 0 });
    // Radius at full strength is 28px, so a 20px move must not move the tip.
    expect(out.x).toBeCloseTo(0);

    const tail = st.finish({ x: 20, y: 0 });
    expect(tail.length).toBeGreaterThan(0);
    expect(tail[tail.length - 1]).toEqual({ x: 20, y: 0 });
  });

  it("relaxes with pen speed so fast strokes are not cut short", () => {
    const run = (speed: number) => {
      const st = createStabilizer("stabilizer", 1);
      st.begin({ x: 0, y: 0 });
      let last = { x: 0, y: 0 };
      for (let i = 1; i <= 10; i++) last = st.push({ x: i * 20, y: 0 }, speed);
      return last.x;
    };
    const slow = run(0);
    const fast = run(3);
    expect(fast).toBeGreaterThan(slow);
    // A fast flick must land close to where the hand actually is (200px).
    expect(fast).toBeGreaterThan(180);
  });

  it("emits no catch-up tail when there is no lag left to drain", () => {
    const st = createStabilizer("stabilizer", 1);
    st.begin({ x: 0, y: 0 });
    // Releasing on the spot must not pile points up — that made an ink blob.
    expect(st.finish({ x: 0, y: 0 })).toHaveLength(0);
    expect(st.finish({ x: 1, y: 0 })).toHaveLength(0);
  });

  it("spaces the catch-up tail roughly every 2px", () => {
    const st = createStabilizer("stabilizer", 1);
    st.begin({ x: 0, y: 0 });
    st.push({ x: 20, y: 0 });
    const tail = st.finish({ x: 20, y: 0 });
    for (let i = 1; i < tail.length; i++) {
      expect(Math.hypot(tail[i].x - tail[i - 1].x, tail[i].y - tail[i - 1].y)).toBeLessThan(6);
    }
  });

  it("never lags in stabilizer mode once the cursor passes the radius", () => {
    const st = createStabilizer("stabilizer", 0.1); // radius ~9.6px
    st.begin({ x: 0, y: 0 });
    let last = { x: 0, y: 0 };
    for (let i = 1; i <= 60; i++) last = st.push({ x: i * 5, y: 0 });
    expect(last.x).toBeGreaterThan(250);
    expect(last.y).toBeCloseTo(0);
  });
});
