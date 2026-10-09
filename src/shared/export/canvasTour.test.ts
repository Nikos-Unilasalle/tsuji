import { describe, expect, test } from "vitest";
import { createCanvasTour } from "./canvasTour";

describe("createCanvasTour", () => {
  test("stays on one canvas and ends after its frames", () => {
    const tour = createCanvasTour([4, 4], 0);
    for (let i = 0; i < 4; i++) {
      expect(tour.done()).toBe(false);
      expect(tour.timelineFrame(i)).toBe(i);
    }
    expect(tour.done()).toBe(true);
  });

  test("a switch restarts the timeline on the new canvas and extends the export", () => {
    const tour = createCanvasTour([4, 3], 0);
    for (let i = 0; i < 4; i++) tour.timelineFrame(i);
    tour.switchTo(1); // fired while evaluating frame 3
    expect(tour.done()).toBe(false);
    expect([4, 5, 6].map((i) => tour.timelineFrame(i))).toEqual([0, 1, 2]);
    expect(tour.done()).toBe(true);
    expect(tour.canvas).toBe(1);
  });
});
