import { create } from "zustand";
import { CANVAS_COUNT } from "./types";

/**
 * The two values that change on every evaluated frame: the playhead and the
 * viewport's latest evaluation results.
 *
 * They used to be App state, so every frame re-rendered App and everything
 * under it — the node canvas included, every node and every edge, dozens of
 * times a second while nothing in the graph had changed. Here they live
 * outside React: only the few components that actually display them
 * subscribe (the timeline, the param panel, the viewport), and App's
 * callbacks read the current value at the moment they run via getState().
 */
interface PlayheadState {
  /** Per canvas — each has its own Render node and so its own frame count. */
  frames: number[];
  evaluatedResults: Map<string, Record<string, unknown>> | null;
}

export const usePlayheadStore = create<PlayheadState>(() => ({
  frames: new Array(CANVAS_COUNT).fill(0),
  evaluatedResults: null,
}));

export function getPlayheadFrame(canvas: number): number {
  return usePlayheadStore.getState().frames[canvas] ?? 0;
}

export function setPlayheadFrame(canvas: number, nextOrUpdater: number | ((prev: number) => number)): void {
  usePlayheadStore.setState((state) => {
    const prev = state.frames[canvas] ?? 0;
    const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
    if (next === prev) return state;
    const frames = state.frames.slice();
    frames[canvas] = next;
    return { frames };
  });
}

export function resetPlayheadFrames(): void {
  usePlayheadStore.setState({ frames: new Array(CANVAS_COUNT).fill(0) });
}

export function getEvaluatedResults(): Map<string, Record<string, unknown>> | null {
  return usePlayheadStore.getState().evaluatedResults;
}

export function setEvaluatedResults(results: Map<string, Record<string, unknown>> | null): void {
  usePlayheadStore.setState({ evaluatedResults: results });
}

/** Subscribes the calling component to one canvas's playhead. */
export function usePlayheadFrame(canvas: number): number {
  return usePlayheadStore((state) => state.frames[canvas] ?? 0);
}

/** Subscribes the calling component to the latest evaluation results. */
export function useEvaluatedResults(): Map<string, Record<string, unknown>> | null {
  return usePlayheadStore((state) => state.evaluatedResults);
}
