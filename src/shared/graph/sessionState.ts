import { EvalContext } from "./types";

/**
 * Per-render-loop state for nodes that remember things between frames.
 *
 * Several viewports evaluate the same graph at once, each on its own clock —
 * the editor pane, the output pane, the offscreen export (see
 * EvalContext.sessionId). A simulation or an edge detector kept once per node
 * sees their frames interleaved: a lagging clock looks like a rewind and
 * restarts the simulation every frame, and the first viewport to read a click
 * swallows it for all the others. Keyed by session, each loop keeps its own
 * history — the export replays from frame 0 while the live view carries on.
 */
export function sessionKey(ctx: Pick<EvalContext, "sessionId" | "evalScope">): string {
  return `${ctx.sessionId ?? ""}|${ctx.evalScope ?? ""}`;
}

/** Sessions kept per node before the least recently used is dropped — viewports come and go (one per export). */
const MAX_SESSIONS = 8;

/** The entry for this session, created on first use; most recently used last, oldest evicted past the cap. */
export function perSession<T>(sessions: Map<string, T>, key: string, create: () => T): T {
  let value = sessions.get(key);
  if (value === undefined) {
    value = create();
  } else {
    sessions.delete(key);
  }
  sessions.set(key, value);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  return value;
}
