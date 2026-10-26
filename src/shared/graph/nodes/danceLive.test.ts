import { describe, it, expect } from "vitest";
import { createLiveState, quantizeUp, recordLive, stepLive } from "./danceLive";

describe("dance live", () => {
  it("lands a hit on the next point of the grid", () => {
    expect(quantizeUp(4.1, 1)).toBe(5);
    expect(quantizeUp(4, 1)).toBe(4);
    expect(quantizeUp(4.1, 0.5)).toBe(4.5);
    expect(quantizeUp(4.1, 0)).toBe(4.1);
  });

  it("holds a pose while the hit is held, and lets go on the beat after release", () => {
    const s = createLiveState();
    stepLive(s, [true], false, 2.2, 1, 1, 0.25);
    expect(s.moves).toMatchObject([{ lane: 0, start: 3, end: null }]);
    stepLive(s, [true], false, 5.5, 1, 1, 0.25);
    expect(s.moves[0].end).toBeNull();
    stepLive(s, [false], false, 6.3, 1, 1, 0.25);
    expect(s.moves[0].end).toBe(7);
  });

  it("holds a one-frame pulse (a beat detector's) for Hit Length", () => {
    const s = createLiveState();
    stepLive(s, [true], true, 8.05, 0.5, 2, 0.25);
    stepLive(s, [false], true, 8.08, 0.5, 2, 0.25);
    expect(s.moves).toMatchObject([{ start: 8.5, end: 10.5, mirror: true }]);
  });

  it("cuts a lane's move short when it is hit again, and forgets all on going back", () => {
    const s = createLiveState();
    stepLive(s, [true], false, 1, 1, 4, 0.25);
    stepLive(s, [false], false, 1.1, 1, 4, 0.25);
    stepLive(s, [true], false, 2.5, 1, 4, 0.25);
    expect(s.moves.map((m) => [m.start, m.end])).toEqual([
      [1, 3],
      [3, null],
    ]);
    // Scrubbed back while still held: forgotten, and no new hit.
    stepLive(s, [true], false, 0.5, 1, 4, 0.25);
    expect(s.moves).toEqual([]);
  });

  it("records live moves into the loop, on whole beats, over what they overlap", () => {
    const grid = [
      { lane: 0, start: 4, length: 4, mirror: false },
      { lane: 1, start: 4, length: 2, mirror: false },
    ];
    const live = [
      { id: 1, lane: 0, start: 21, end: 23.2, mirror: true },
      { id: 2, lane: 1, start: 2, end: 3, mirror: false },
    ];
    // From beat 16 on a 16-beat loop: 21 is beat 5 of the loop; the second was played before Rec.
    expect(recordLive(grid, live, 16, 30, 16)).toEqual([
      { lane: 1, start: 4, length: 2, mirror: false },
      { lane: 0, start: 5, length: 2, mirror: true },
    ]);
  });
});
