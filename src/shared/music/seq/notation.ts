/**
 * A pattern as one line of text — one word per step — read by the Pattern node until the grid editor (step 5) and
 * kept by it after: it is what a saved pattern looks like, readable and diffable.
 *
 *   C4:maj7 . . .  A3:min7/1 . . .  F3:maj7^ . . off  G3:7@0.6~2!GLD12
 *
 * A step is one of:
 *   .  or  -          empty
 *   .*N               N empty steps (a converted song's long silences)
 *   off               ends the note sounding
 *   NOTE[+NOTE…][…]   a note — more joined with + are struck with it (kick+hat) — then any of, in any order:
 *     :CHORD            a chord on it (maj min 7 9 sus dim maj7 min7 sus2 dim7 aug)
 *     /N                inversion N (0–3)
 *     ^                 spread voicing
 *     @V                velocity, 0–1 — or one per note, @V,V,… (kick+hat@1,0.4: a soft hat on a loud kick)
 *     ~N                length in steps
 *     !FX               one effect: GLDn (glide n × 10 ms), RTGn (ratchet ×n), CHNn (chance n %),
 *                       DLYn (the note n / 16 of a step late)
 *
 * NOTE is a pitch with its octave, C4 = MIDI 60 (C-4, C#4, Db4 and c4 work too), a MIDI number, or a drum name
 * (kick snare clap hat openhat tomlow tomhigh) for a Drum Kit.
 */
import { DRUM_NOTES } from "../dsp/drums";
import { isChordName } from "./chords";
import type { Cell, CellFx } from "./sequencer";

const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** A pitch name (C4, C-4, F#3, Bb2), a MIDI number, or a drum name → MIDI note; null if it is none of those. */
export function parseNote(word: string): number | null {
  const w = word.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DRUM_NOTES, w)) return DRUM_NOTES[w as keyof typeof DRUM_NOTES];
  if (/^\d{1,3}$/.test(w)) {
    const n = Number(w);
    return n <= 127 ? n : null;
  }
  const m = /^([a-g])([#b]?)-?(-?\d)$/.exec(w);
  if (!m) return null;
  const semis = LETTERS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  const midi = (Number(m[3]) + 1) * 12 + semis;
  return midi >= 0 && midi <= 127 ? midi : null;
}

export function noteName(midi: number): string {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** One step's word → its cell (null for an empty step, or for a word that cannot be read). */
export function parseCell(word: string): Cell | null {
  const w = word.trim();
  if (w === "" || w === "." || w === "-" || w === "--" || w === "---") return null;
  if (w.toLowerCase() === "off" || w === "==") return { note: "off" };
  // The note runs up to the first modifier character.
  const m = /^([^:/^@~!]+)(.*)$/.exec(w);
  if (!m) return null;
  const [first, ...more] = m[1].split("+");
  const note = parseNote(first);
  if (note === null) return null;
  const cell: Cell = { note };
  const add = more.map(parseNote).filter((n): n is number => n !== null);
  if (add.length > 0) cell.add = add;
  const mods = m[2];
  const re = /([:/@~!])([^:/^@~!]*)|\^/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(mods))) {
    if (x[0] === "^") {
      cell.spread = true;
      continue;
    }
    const [, kind, value] = x;
    if (kind === ":" && isChordName(value)) cell.chord = value;
    else if (kind === "/" && /^\d$/.test(value)) cell.inversion = Number(value);
    else if (kind === "@" && value !== "") {
      const vs = value.split(",").map(Number);
      if (vs.every(Number.isFinite)) {
        const v = vs.map((x) => Math.min(1, Math.max(0, x)));
        cell.velocity = v[0];
        if (v.length > 1 && cell.add) {
          const own = cell.add.map((_, k) => v[k + 1] ?? v[0]);
          if (own.some((x) => x !== v[0])) cell.addVelocity = own;
        }
      }
    }
    else if (kind === "~" && Number(value) > 0) cell.length = Number(value);
    else if (kind === "!") {
      const fx = /^(GLD|RTG|CHN|DLY)(\d+(?:\.\d+)?)$/i.exec(value);
      if (fx) cell.fx = { type: fx[1].toUpperCase() as CellFx["type"], value: Number(fx[2]) } as CellFx;
    }
  }
  return cell;
}

const MAX_RUN = 65_536;

/** A pattern's text → one word per step, `.*N` spelled out as N empty steps. */
export function stepWords(text: string): string[] {
  const words: string[] = [];
  for (const w of String(text ?? "").split(/\s+/)) {
    if (w === "") continue;
    const run = /^\.\*(\d+)$/.exec(w);
    if (run) {
      for (let k = Math.min(MAX_RUN, Number(run[1])); k > 0; k--) words.push(".");
    } else words.push(w);
  }
  return words;
}

/** A whole pattern's text → its steps, `length` long (padded with empty steps, or cut). */
export function parsePattern(text: string, length: number): (Cell | null)[] {
  const words = stepWords(text);
  const L = Math.max(1, Math.round(length));
  return Array.from({ length: L }, (_, i) => (i < words.length ? parseCell(words[i]) : null));
}

/** The inverse of parseCell. */
export function formatCell(cell: Cell | null, opts: { drums?: boolean } = {}): string {
  if (!cell) return ".";
  if (cell.note === "off") return "off";
  const name = (n: number) => (opts.drums ? Object.entries(DRUM_NOTES).find(([, d]) => d === n)?.[0] : undefined) ?? noteName(n);
  let s = [cell.note, ...(cell.add ?? [])].map(name).join("+");
  if (cell.chord) s += `:${cell.chord}`;
  if (cell.inversion) s += `/${cell.inversion}`;
  if (cell.spread) s += "^";
  const v = (x: number) => Number(x.toFixed(2));
  const own = cell.add && cell.addVelocity?.some((x) => x !== (cell.velocity ?? 0.8)) ? cell.addVelocity : null;
  if (own) s += `@${[cell.velocity ?? 0.8, ...cell.add!.map((_, k) => own[k] ?? cell.velocity ?? 0.8)].map(v).join(",")}`;
  else if (cell.velocity !== undefined) s += `@${v(cell.velocity)}`;
  if (cell.length !== undefined) s += `~${cell.length}`;
  if (cell.fx) s += `!${cell.fx.type}${cell.fx.value}`;
  return s;
}

export function formatPattern(steps: readonly (Cell | null)[], opts: { drums?: boolean } = {}): string {
  return steps.map((c) => formatCell(c, opts)).join(" ");
}

/** The same text, each run of 4 or more empty steps written `.*N` (a converted song's patterns stay readable). */
export function compactPattern(text: string): string {
  const out: string[] = [];
  let run = 0;
  const flush = () => {
    if (run >= 4) out.push(`.*${run}`);
    else for (; run > 0; run--) out.push(".");
    run = 0;
  };
  for (const w of stepWords(text)) {
    if (w === "." || w === "-") run++;
    else {
      flush();
      out.push(w);
    }
  }
  flush();
  return out.join(" ");
}
