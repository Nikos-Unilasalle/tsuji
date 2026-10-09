/**
 * Follows Go To Canvas switches through an export.
 *
 * An export asks for global frames 0, 1, 2… but each canvas has its own
 * timeline, so after a switch the new canvas starts at its own frame 0 (as in
 * the editor, where every canvas keeps its own playhead). The export ends when
 * the canvas it is on has played all its frames — which is how a chain of
 * scenes, each switching to the next, adds up to one video.
 */
export interface CanvasTour {
  readonly canvas: number;
  /** Timeline frame inside the current canvas for global frame `globalFrame`; remembers it as the latest one captured. */
  timelineFrame(globalFrame: number): number;
  /** A Go To Canvas fired while evaluating the latest frame: the next one is the new canvas's first. */
  switchTo(canvas: number): void;
  /** The current canvas has played all its frames. */
  done(): boolean;
  /** Upper bound on the frames the tour can produce (a loop of switches would never end otherwise). */
  readonly maxFrames: number;
  /** Frames the tour has to produce if no further switch happens. */
  expectedFrames(): number;
}

export function createCanvasTour(frameCounts: number[], startCanvas: number): CanvasTour {
  let canvas = startCanvas;
  let origin = 0;
  let last = 0;
  const countOf = (c: number) => Math.max(1, frameCounts[c] ?? 1);
  return {
    get canvas() {
      return canvas;
    },
    timelineFrame(globalFrame) {
      last = globalFrame;
      return Math.max(0, globalFrame - origin);
    },
    switchTo(next) {
      if (next === canvas) return;
      canvas = next;
      origin = last + 1;
    },
    done() {
      return last >= 1 && last - origin + 1 >= countOf(canvas);
    },
    maxFrames: frameCounts.reduce((sum, n) => sum + Math.max(1, n), 0),
    expectedFrames() {
      return origin + countOf(canvas);
    },
  };
}
