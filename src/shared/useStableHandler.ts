import { useCallback, useRef } from "react";

/**
 * A function whose identity never changes but that always calls the latest
 * `fn` passed in.
 *
 * For event handlers handed to a memoized subtree that fans out wide — React
 * Flow forwards its node and edge handlers to every node and every edge, so
 * one new handler identity re-renders the whole canvas even though nothing it
 * draws changed. Only for handlers called from events or effects, never during
 * render: the ref is updated as the owner renders.
 */
export function useStableHandler<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: Args) => ref.current(...args), []);
}
