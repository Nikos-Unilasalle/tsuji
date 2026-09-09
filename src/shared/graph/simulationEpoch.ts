/**
 * The simulation epoch: one number that means "everything with memory starts
 * over".
 *
 * Simulations accumulate. A physics world holds where every crate ended up, a
 * fluid grid holds the smoke already in it, an integrator holds the distance
 * already walked. None of that can be recomputed from the current frame — it
 * *is* the history — so the only way back to a known state is to throw it away
 * and rebuild.
 *
 * Every node that holds such state records the epoch it was built at and
 * rebuilds when it no longer matches. That is the same `generation` trick
 * `physics/world` already uses to make its bodies notice a rebuild, promoted
 * to something the whole graph shares.
 *
 * It is carried on `EvalContext` rather than read from this module directly by
 * nodes, so the value flows through the evaluator: an export can pin it, a
 * headless call can leave it at zero, and two viewports rendering the same
 * graph cannot disagree about which generation they are drawing.
 */

let epoch = 0;
const listeners = new Set<() => void>();

/** Discards every simulation's accumulated state on the next evaluation. */
export function resetSimulations(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

export function getSimulationEpoch(): number {
  return epoch;
}

/**
 * Notifies when the epoch changes, for the parts of the app that have to act
 * rather than merely read — the viewport, which also restarts its clock and
 * frees GPU particle buffers.
 */
export function onSimulationReset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function resetSimulationEpochForTesting(): void {
  epoch = 0;
  listeners.clear();
}

/**
 * Whether a piece of cached state built at `builtAt` is still current.
 *
 * A node that has never run has no epoch, and gets one on its first
 * evaluation rather than being treated as stale — which would make the first
 * frame after a load a rebuild of something that was just built.
 */
export function isEpochCurrent(builtAt: number | undefined, epochNow: number | undefined): boolean {
  if (builtAt === undefined) return false;
  return builtAt === (epochNow ?? 0);
}
