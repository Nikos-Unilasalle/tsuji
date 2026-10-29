import type { DanceMove } from "./bipedDance";

/**
 * Biped Dance played live: a Hit socket per pose, fed by whatever the graph
 * has — a Keyboard's Is Down, an Audio Peak Detector's Beat Pulse, a Compare
 * on the Spectrum's bass. A hit throws the pose on the next beat (Quantize);
 * held, the pose is held; let go, it lets go — never sooner than Hit Length.
 *
 * Live moves count in beats from the start, not round the loop: they happen
 * once. Recording (the HUD's Rec) folds them into the loop as grid moves.
 */

export interface LiveMove {
  /** Unique per node, for the recorder to tell moves apart. */
  id: number;
  lane: number;
  /** In beats from the start (not in the loop). */
  start: number;
  /** Null while the hit is still held. */
  end: number | null;
  mirror: boolean;
  /** When the hit came, in beats from the start: the body sets off then, to land on `start`. */
  pressed?: number;
}

export interface LiveState {
  held: boolean[];
  moves: LiveMove[];
  lastBeat: number;
  nextId: number;
}

export const createLiveState = (): LiveState => ({ held: [], moves: [], lastBeat: -Infinity, nextId: 1 });

/** The next point on the grid at or after `beat` (`quantize` in beats; 0 is now). */
export function quantizeUp(beat: number, quantize: number): number {
  if (!(quantize > 0)) return beat;
  return Math.ceil(beat / quantize - 1e-6) * quantize;
}

/**
 * One frame of live play: rising hits start moves, falling ones end them.
 * Going back in time (a scrub, the loop restarting) forgets what was played.
 */
export function stepLive(state: LiveState, hits: boolean[], mirror: boolean, beat: number, quantize: number, hitLength: number, snap: number): LiveMove[] {
  if (beat < state.lastBeat - 1e-6) {
    state.moves = [];
    // What is held now does not hit again on the way back.
    state.held = hits.slice();
  }
  state.lastBeat = beat;
  const minLength = Math.max(0, hitLength);
  hits.forEach((hit, lane) => {
    const was = state.held[lane] ?? false;
    if (hit && !was) {
      const start = quantizeUp(beat, quantize);
      // A new hit on a lane cuts its previous move short.
      for (const m of state.moves) if (m.lane === lane && (m.end === null || m.end > start)) m.end = Math.max(m.start, start);
      state.moves.push({ id: state.nextId++, lane, start, end: null, mirror, pressed: beat });
    } else if (!hit && was) {
      for (const m of state.moves) if (m.lane === lane && m.end === null) m.end = Math.max(m.start + minLength, quantizeUp(beat, quantize));
    }
    state.held[lane] = hit;
  });
  // A move long gone leaves the list — after a while, so a recorder polling it sees it end.
  state.moves = state.moves.filter((m) => m.end === null || m.end + snap + 8 > beat);
  return state.moves;
}

/**
 * Folds live moves played since `from` into the loop's grid: each on its
 * whole beat, at least a beat long, replacing what it overlaps on its lane.
 */
export function recordLive(grid: DanceMove[], live: LiveMove[], from: number, now: number, loopBeats: number): DanceMove[] {
  let out = grid.map((m) => ({ ...m }));
  for (const m of live) {
    if (m.start < from - 1e-6) continue;
    const end = m.end ?? now;
    const length = Math.max(1, Math.min(loopBeats, Math.round(end - m.start)));
    const start = (((Math.round(m.start) % loopBeats) + loopBeats) % loopBeats);
    const fit = Math.min(length, loopBeats - start);
    out = out.filter((g) => g.lane !== m.lane || g.start + g.length <= start || g.start >= start + fit);
    out.push({ lane: m.lane, start, length: fit, mirror: m.mirror });
  }
  return out.sort((a, b) => a.start - b.start || a.lane - b.lane);
}
