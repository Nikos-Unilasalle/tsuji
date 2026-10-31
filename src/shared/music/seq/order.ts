/**
 * A tracker's order list: short numbered patterns, played in the order the song lists them.
 *
 * A Pattern node's text can hold a bank of patterns, one after the other, `|` between them:
 *
 *   C4 . E4 . | G3 . . . | A3:min7 . . .          patterns 0, 1 and 2
 *
 * An Order List node, wired between the Clock and the Patterns, says which play when (`0 1 0 2`) and how long each
 * pattern number is: the same for every track, as in a tracker, where a pattern is a slice of time across all
 * channels. Without an Order List a bank plays its patterns once each, in turn.
 *
 * The sequencer never sees any of this: a bank is laid end to end along the order into one long pattern (the
 * sequencer's notes ring across the joins exactly as they would in one pattern), and the layout rides along on the
 * sequence for the HUD to say which pattern is playing.
 */

/** What the Order List node passes on, with the clock. */
export interface SongOrder {
  /** Pattern numbers, in play order. */
  list: number[];
  /** Each pattern number's length in steps; past the end of it (or 0), `length`. */
  lengths: number[];
  length: number;
}

/** How a bank is laid out along the song. */
export interface BankLayout {
  /** The pattern number at each order position. */
  list: number[];
  /** Where each position starts, in steps from the song's start. */
  starts: number[];
  /** Each pattern number's length in steps. */
  lengths: number[];
  /** Every position's steps added up: the song's length. */
  total: number;
}

/** The longest a laid-out song can be, in steps. */
export const MAX_SONG_STEPS = 65_536;
/** The most positions an order list can have, and the highest pattern number + 1. */
export const MAX_ORDER = 1024;

const SEPARATOR = "|";

/** Whether the text holds a bank (more than one pattern). */
export function isBank(text: string): boolean {
  return /(^|\s)\|(\s|$)/.test(String(text ?? ""));
}

/** A Pattern's text → its patterns' texts (one, for a text with no `|`). */
export function splitBank(text: string): string[] {
  const sections: string[][] = [[]];
  for (const w of String(text ?? "").split(/\s+/)) {
    if (w === SEPARATOR) sections.push([]);
    else if (w !== "") sections[sections.length - 1].push(w);
  }
  return sections.map((s) => s.join(" "));
}

export function joinBank(sections: readonly string[]): string {
  return sections.map((s) => s.trim() || ".").join(` ${SEPARATOR} `);
}

/** Pattern numbers from text: `0 1 2 1`, commas or any spacing between; anything else is skipped. */
export function parseOrder(text: string): number[] {
  return String(text ?? "")
    .split(/[\s,;]+/)
    .filter((w) => /^\d+$/.test(w))
    .map(Number)
    .filter((n) => n < MAX_ORDER)
    .slice(0, MAX_ORDER);
}

export function orderLengthOf(order: SongOrder, pattern: number): number {
  const own = order.lengths[pattern];
  return Math.max(1, Math.round(own > 0 ? own : order.length));
}

/**
 * Where each pattern of a bank goes. With an order: its list, its lengths. Without one: every pattern once, in turn,
 * each as long as its own steps and at least `minLength` (the Pattern's Length).
 */
export function bankLayout(stepCounts: readonly number[], minLength: number, order: SongOrder | null): BankLayout {
  const list = order ? order.list : stepCounts.map((_, k) => k);
  const highest = Math.max(stepCounts.length - 1, ...list, -1);
  const lengths = Array.from({ length: highest + 1 }, (_, k) =>
    order ? orderLengthOf(order, k) : Math.max(1, Math.round(minLength), stepCounts[k] ?? 0),
  );
  const starts: number[] = [];
  let total = 0;
  for (const k of list) {
    if (total + lengths[k] > MAX_SONG_STEPS) break;
    starts.push(total);
    total += lengths[k];
  }
  return { list: list.slice(0, starts.length), starts, lengths, total: Math.max(1, total) };
}

/** The order position, pattern number and step in it of a song step (the song loops); null for an empty order. */
export function positionAt(layout: BankLayout, step: number): { position: number; pattern: number; row: number } | null {
  if (layout.list.length === 0 || step < 0) return null;
  const g = step % layout.total;
  let lo = 0;
  let hi = layout.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.starts[mid] <= g) lo = mid;
    else hi = mid - 1;
  }
  return { position: lo, pattern: layout.list[lo], row: g - layout.starts[lo] };
}
