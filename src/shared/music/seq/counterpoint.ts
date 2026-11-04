/**
 * Species counterpoint: a second voice written against a given one (the cantus firmus), by the textbook rules, as the
 * cheapest path through every allowed note — a dynamic-programming search, so the line is the best one under the
 * rules, not a greedy one. Seeded: a little noise in the costs gives other, equally correct lines.
 *
 * - First species, note against note: consonances only (unison, 3rds, 5ths, 6ths, octaves — a 4th is a dissonance
 *   in two voices), no parallel fifths or octaves, contrary motion preferred, steps over leaps, begin on a perfect
 *   consonance and end on the octave or unison, reached by step.
 * - Second species, two notes against one: the downbeat consonant; the offbeat may be a dissonance if it is a passing
 *   note — reached and left by step, in the same direction.
 */
import { hash01 } from "./hash";
import { Ev, stepsOf } from "./compose";
import { ScaleSpec, degreeNote, degreeOf, snapNote } from "./scales";
import type { Cell } from "./sequencer";

export interface CounterpointSettings {
  species: 1 | 2;
  above: boolean;
  scale: ScaleSpec;
  low: number;
  high: number;
  velocity: number;
  seed: number;
}

interface Slot {
  start: number;
  dur: number;
  /** The cantus note it sounds against. */
  cf: number;
  strong: boolean;
  first: boolean;
  last: boolean;
}

const BAD = 1e9;
const mod12 = (n: number) => ((Math.round(n) % 12) + 12) % 12;
const consonant = (i: number) => [0, 3, 4, 7, 8, 9].includes(mod12(i));
const perfect = (i: number) => [0, 7].includes(mod12(i));
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** The cost of a leap in the counter-voice (semitones, signed); BAD for the forbidden ones. */
function leapCost(d: number): number {
  const a = Math.abs(d);
  if (a === 0) return 3;
  if (a <= 2) return 0;
  if (a <= 4) return 1;
  if (a === 6 || a === 10 || a === 11 || a > 12) return BAD; // tritone, sevenths, beyond the octave
  if (a <= 7) return 3;
  if (a <= 9) return 6;
  return 5; // the octave
}

/**
 * The counter-voice to the note events of a cantus (rests stay rests), as steps of the same length. Chords in the
 * cantus count by their root.
 */
export function counterpoint(cantus: readonly Ev[], length: number, s: CounterpointSettings): (Cell | null)[] {
  const notes = cantus.filter((e) => e.cell && e.cell.note !== "off");
  const slots: Slot[] = [];
  notes.forEach((e, k) => {
    const cf = e.cell!.note as number;
    // The last note is whole, as in the textbook: the line comes to rest.
    const split = s.species === 2 && e.dur >= 2 && k < notes.length - 1;
    const a = split ? Math.ceil(e.dur / 2) : e.dur;
    const firstNote = k === 0;
    const lastNote = k === notes.length - 1;
    slots.push({ start: e.start, dur: a, cf, strong: true, first: firstNote, last: lastNote && !split });
    if (split) slots.push({ start: e.start + a, dur: e.dur - a, cf, strong: false, first: false, last: lastNote });
  });
  const L = Math.max(1, length);
  if (slots.length === 0) return new Array(L).fill(null);

  // Candidates: the scale's notes in range (on the right side of the cantus, checked per slot).
  const lo = Math.min(s.low, s.high);
  const hi = Math.max(s.low, s.high);
  const cand: number[] = [];
  for (let k = degreeOf(s.scale, snapNote(s.scale, lo, "up")); ; k++) {
    const n = degreeNote(s.scale, k);
    if (n > hi) break;
    if (n >= lo) cand.push(n);
  }
  if (cand.length === 0) return new Array(L).fill(null);
  const C = cand.length;
  const interval = (cp: number, cf: number) => (s.above ? cp - cf : cf - cp);

  // State: (candidate, how the voice arrived when the previous slot was a passing dissonance: −1, +1, or 0 for none).
  const key = (c: number, pending: number) => c * 3 + (pending + 1);
  const S = C * 3;
  let cost = new Float64Array(S).fill(BAD);
  const back: Int32Array[] = [];

  const slotCost = (slot: Slot, i: number, salt: number) => {
    if (i < 0) return BAD; // voices crossing
    let c = 0;
    if (!consonant(i) && slot.strong) return BAD;
    if (slot.first) c += perfect(i) && (s.above || mod12(i) === 0) ? 0 : 50;
    if (slot.last) c += mod12(i) === 0 ? 0 : 60;
    if (i === 0 && !slot.first && !slot.last) c += 4; // unison inside the line
    if (i > 16) c += (i - 16) * 0.5; // the voices drifting apart
    return c + hash01(salt, s.seed, 0x43505431) * 1.5;
  };

  slots.forEach((slot, t) => {
    const next = new Float64Array(S).fill(BAD);
    const from = new Int32Array(S).fill(-1);
    for (let c = 0; c < C; c++) {
      const cp = cand[c];
      const i = interval(cp, slot.cf);
      const here = slotCost(slot, i, t * 97 + c);
      if (here >= BAD) continue;
      const dissonant = !consonant(i);
      if (t === 0) {
        if (dissonant) continue;
        next[key(c, 0)] = here;
        continue;
      }
      const prevSlot = slots[t - 1];
      for (let p = 0; p < C; p++) {
        for (const pending of [-1, 0, 1]) {
          const pc = cost[key(p, pending)];
          if (pc >= BAD) continue;
          const prev = cand[p];
          const d = cp - prev;
          // Leaving a passing note: by step, the same way it came.
          if (pending !== 0 && !(Math.abs(d) >= 1 && Math.abs(d) <= 2 && sign(d) === pending)) continue;
          let step = leapCost(d);
          if (step >= BAD) continue;
          // A passing dissonance: arrived at by step (it must leave the same way, checked on the next slot).
          if (dissonant && !(Math.abs(d) >= 1 && Math.abs(d) <= 2)) continue;
          const cfMove = slot.cf - prevSlot.cf;
          const prevI = interval(prev, prevSlot.cf);
          // Parallel fifths and octaves (the same perfect interval, both voices moving): forbidden.
          if (perfect(i) && perfect(prevI) && mod12(i) === mod12(prevI) && d !== 0 && cfMove !== 0) continue;
          // Hidden (direct) fifths and octaves: similar motion into a perfect interval with a leap.
          if (perfect(i) && sign(d) === sign(cfMove) && d !== 0 && Math.abs(d) > 2) step += 4;
          // Motion: contrary best, oblique fine, similar worst.
          if (cfMove !== 0 && d !== 0) step += sign(d) === sign(cfMove) ? 2 : 0;
          else if (d !== 0 || cfMove !== 0) step += 0.5;
          // The last note reached by step.
          if (slot.last && Math.abs(d) > 2) step += 10;
          const total = pc + here + step;
          const k = key(c, dissonant ? sign(d) : 0);
          if (total < next[k]) {
            next[k] = total;
            from[k] = key(p, pending);
          }
        }
      }
    }
    back.push(from);
    cost = next;
  });

  // The cheapest end (not left hanging on a passing note), traced back.
  let best = -1;
  for (let k = 0; k < S; k++) if (k % 3 === 1 && cost[k] < BAD && (best < 0 || cost[k] < cost[best])) best = k;
  if (best < 0) for (let k = 0; k < S; k++) if (cost[k] < BAD && (best < 0 || cost[k] < cost[best])) best = k;
  if (best < 0) return new Array(L).fill(null);
  const picks: number[] = new Array(slots.length);
  for (let t = slots.length - 1, k = best; t >= 0; t--) {
    picks[t] = cand[Math.floor(k / 3)];
    k = back[t][k];
  }

  // Back to steps: the counter-voice's notes, the cantus's rests as rests.
  const events: Ev[] = cantus.filter((e) => !e.cell || e.cell.note === "off").map((e) => ({ ...e, cell: null }));
  slots.forEach((slot, t) => events.push({ start: slot.start, dur: slot.dur, cell: { note: picks[t], velocity: s.velocity } }));
  return stepsOf(
    events.sort((a, b) => a.start - b.start),
    L,
  );
}
