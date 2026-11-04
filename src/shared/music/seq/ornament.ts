/**
 * Ornaments: a cell's note decorated by the notes around it, all inside the note's own time — a trill, a mordent, a
 * turn, a grace note, a scoop up to the pitch. The Ornament node puts one on a cell (Cell.orn); the sequencer plays
 * it here, as it plays a ratchet: from the note's start and end, nothing else.
 */

export const ORNAMENT_TYPES = ["trill", "mordent", "upper mordent", "turn", "grace above", "grace below", "scoop"] as const;
export type OrnamentType = (typeof ORNAMENT_TYPES)[number];

export interface Ornament {
  type: OrnamentType;
  /** Semitones up to the upper neighbour, and down to the lower one (a Scale node after makes them the scale's). */
  up: number;
  down: number;
  /** One ornament note, in beats (0.125 = a 32nd). */
  beats: number;
}

export interface OrnamentPart {
  /** Exact times, in samples. */
  on: number;
  off: number;
  /** Semitones from the written note. */
  offset: number;
  /** A scoop: the part glides in from this offset over `glideSeconds`. */
  glideFrom?: number;
  glideSeconds?: number;
}

/** At most this many trill notes: the rest of a very long note is held. */
const MAX_TRILL = 256;

/**
 * The parts a note from `on` to `off` plays under the ornament. `unit` is one ornament note in samples; a note too
 * short for its figure plays it faster, so the written note always lands.
 */
export function ornamentParts(o: Ornament, on: number, off: number, unit: number, sampleRate: number): OrnamentPart[] {
  const dur = off - on;
  if (dur <= 0) return [];
  const figure: number[] =
    o.type === "mordent" ? [0, -o.down]
    : o.type === "upper mordent" ? [0, o.up]
    : o.type === "turn" ? [o.up, 0, -o.down]
    : o.type === "grace above" ? [o.up]
    : o.type === "grace below" ? [-o.down]
    : [];
  if (o.type === "scoop") {
    const u = Math.min(unit, dur / 2);
    return [{ on, off, offset: 0, glideFrom: -o.down, glideSeconds: u / sampleRate }];
  }
  if (o.type === "trill") {
    const count = Math.min(MAX_TRILL, Math.floor(dur / unit));
    if (count < 2) return [{ on, off, offset: 0 }];
    const parts: OrnamentPart[] = [];
    // An odd count: the trill ends on the written note, which holds to the end, rather than hanging on the upper one.
    const n = count % 2 === 0 ? count - 1 : count;
    for (let i = 0; i < n; i++) parts.push({ on: on + i * unit, off: i === n - 1 ? off : on + (i + 1) * unit, offset: i % 2 === 0 ? 0 : o.up });
    return parts;
  }
  const u = Math.min(unit, dur / (figure.length + 1));
  const parts: OrnamentPart[] = figure.map((offset, i) => ({ on: on + i * u, off: on + (i + 1) * u, offset }));
  parts.push({ on: on + figure.length * u, off, offset: 0 });
  return parts;
}
