import { useEffect, useRef, useState } from "react";
import { HUD_PANEL_STYLE, HudBar, HudSeparator } from "./HudToolbars";
import { CommitSlider } from "./RigHuds";
import { DRUM_NOTES, DrumName } from "../music/dsp/drums";
import type { PreviewSound } from "../music/engine/description";
import { CHORD_NAMES, ChordName } from "../music/seq/chords";
import { compactPattern, formatPattern, noteName, parsePattern } from "../music/seq/notation";
import { joinBank, positionAt, splitBank } from "../music/seq/order";
import {
  DRUM_LANES,
  DRUM_LETTERS,
  OFF_LETTERS,
  drumsAt,
  editCell,
  heldBy,
  hitVelocity,
  moveCursor,
  noteForLetter,
  resize,
  setCell,
  setHitVelocity,
  spanNote,
  toggleDrum,
  toggleSharp,
  withOctave,
  writeNote,
} from "../music/seq/patternEdit";
import { Cell, CellFx, Sequence, stepAt } from "../music/seq/sequencer";
import type { NodeInstance } from "../graph/types";

/**
 * Pattern's palette in the 3D view (see docs/music-nodes-mvp.md, step 5): the pattern as a tracker grid — a cell per
 * step, a row per bar, the step playing lit as the timeline runs — and the keyboard. Click a cell to put the
 * cursor there; type notes by name, A B C D E F G in the keyboard's octave, Shift or # for the sharp, a digit right
 * after for the note's octave (C 4, F # 3: as the pattern text spells them), X or O for OFF, ⌫ to clear, the arrows to
 * move, [ ] for the octave. The bar along the bottom edits the cell under the cursor and is also the brush new notes
 * are written with (chord, inversion, spread, velocity).
 *
 * The mouse: a click on an empty step writes a note there (the last note's pitch, in the keyboard's octave), on a note
 * selects it — a digit then moves it to that octave; ⌘-click sharpens a note (or makes it natural again); Shift-click
 * clears a note, or writes an OFF on an empty step; press and drag across steps to hold a note over them (its length).
 *
 * A pattern feeding a Drum Kit shows as a drum machine instead: a lane per sound; a click on an empty cell adds a hit, on
 * a hit selects it (the bar's Vel is then that hit's alone, not the whole step's), Shift-click takes it away; each
 * sound's initial — K S C H O L T: kick, snare, clap, hat, open hat, low and top tom — strikes it at the cursor.
 *
 * Every edit writes the node's `steps` text (notation.ts) in one undo step: the HUD and the text field are the same
 * pattern.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;
/** A cell that plays a note (not an OFF). */
type NoteCell = Cell & { note: number };
const asNote = (c: Cell | null | undefined): NoteCell | null => (c && c.note !== "off" ? (c as NoteCell) : null);

export interface PatternPlayhead {
  frame: number;
  fps: number;
}

const ACCENT = "#d946ef"; // the Music category
const CELL_W = 42;
const CELL_H = 34;
const DRUM_CELL = 22;
const STEPS_PER_ROW = 16;
const selectStyle = { background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "2px 4px", fontSize: 11 } as const;
const wide = { width: "auto", padding: "0 8px" } as const;
const DRUM_LABEL: Record<DrumName, string> = { kick: "Kick", snare: "Snare", clap: "Clap", hat: "Hat", openhat: "Open Hat", tomlow: "Low Tom", tomhigh: "High Tom" };
const DRUM_KEY_OF = Object.fromEntries(Object.entries(DRUM_LETTERS).map(([letter, d]) => [d, letter.toUpperCase()])) as Record<DrumName, string>;

/** The step under the playhead, read every animation frame: the light has to land on the step, not near it. */
function useLiveStep(read: () => number): number {
  const readRef = useRef(read);
  readRef.current = read;
  const [step, setStep] = useState(() => read());
  useEffect(() => {
    let id = 0;
    const tick = () => {
      setStep(readRef.current());
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
  return step;
}

const MAX_STEPS = 16384;

/** The pattern's length in bars (16 steps each; a quarter bar is 4 steps), typed: Enter or leaving the field sets it,
 * Esc takes it back. */
function LengthField({ length, onLength }: { length: number; onLength: (steps: number) => void }) {
  const bars = Number((length / STEPS_PER_ROW).toFixed(2));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Math.round(Number(draft.replace(",", ".")) * STEPS_PER_ROW);
    setDraft(null);
    if (Number.isFinite(n) && n >= 1 && n !== length) onLength(Math.min(MAX_STEPS, n));
  };
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4, color: "#94a3b8" }} title="Bars before the pattern comes round again (16 steps a bar; 0.25 is a beat)">
      <input
        type="text"
        inputMode="decimal"
        aria-label="Bars"
        value={draft ?? String(bars)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const b = Math.max(1, Math.floor(bars) + (e.key === "ArrowUp" ? 1 : Math.ceil(bars) === bars ? -1 : 0));
            setDraft(null);
            onLength(Math.min(MAX_STEPS, b * STEPS_PER_ROW));
          }
        }}
        style={{ ...selectStyle, width: 44, textAlign: "right" }}
      />
      {bars === 1 ? "bar" : "bars"} · {length} steps
    </span>
  );
}

export function PatternHud({
  node,
  drums,
  readPlayhead,
  readSequence,
  startFrame,
  previewSound,
  onParams,
  onPreview,
}: {
  node: NodeInstance;
  /** The pattern feeds a Drum Kit: show the drum machine. */
  drums: boolean;
  readPlayhead: () => PatternPlayhead;
  /** The node's evaluated sequence — it carries the clock wired in. */
  readSequence: () => Sequence | null;
  /** Music Out's Start Frame, where the song's step 0 is. */
  startFrame: number;
  /** What the pattern plays through, to audition typed notes on; null when nothing is wired after it. */
  previewSound: PreviewSound | null;
  onParams: OnParams;
  onPreview: (sound: PreviewSound, note: number, velocity: number) => void;
}) {
  const p = node.params;
  const text = String(p.steps ?? "");
  // A bank (an Order List before it, or | in its text): the HUD shows one numbered pattern at a time.
  const bank = readSequence()?.bank ?? null;
  const sections = bank ? splitBank(text) : null;
  const [picked, setPicked] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [lane, setLane] = useState(0);
  const [octave, setOctave] = useState(4);
  const [advance, setAdvance] = useState(1);
  const [brush, setBrush] = useState<Partial<Cell>>({});
  const keysRef = useRef<HTMLInputElement>(null);
  /** The step the last note was typed on, while the next key may still give it its octave or its sharp. */
  const lastTyped = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);

  const songStep = useLiveStep(() => {
    const seq = readSequence();
    const { frame, fps } = readPlayhead();
    const t = (frame - startFrame) / Math.max(1, fps);
    if (!seq || t < 0) return -1;
    return stepAt(seq.clock, 48_000, t * 48_000);
  });
  const at = bank && songStep >= 0 ? positionAt(bank, songStep) : null;
  /** The pattern number shown: the one playing, unless you are typing in it or picked another with the song stopped. */
  const patternCount = bank ? Math.max(sections!.length, bank.lengths.length) : 1;
  const number = bank ? Math.min(patternCount - 1, !focused && at ? at.pattern : (picked ?? at?.pattern ?? bank.list[0] ?? 0)) : 0;
  const length = bank ? Math.max(1, bank.lengths[number] ?? 1) : Math.max(1, Math.round(Number(p.length) || 16));
  const cells = parsePattern(bank ? (sections![number] ?? "") : text, length);
  const step = bank ? (at && at.pattern === number ? at.row : -1) : songStep < 0 ? -1 : songStep % length;
  const pick = (k: number) => {
    setPicked(Math.min(patternCount - 1, Math.max(0, k)));
    setCursor(0);
  };
  /** The pitch the last note clicked, typed or selected had: a click on an empty step writes it again. */
  const [lastNote, setLastNote] = useState(60);
  /** The steps a press-and-drag runs over, from where it started. */
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number; moved: boolean } | null>(null);
  const cur = Math.min(cursor, length - 1);

  const write = (next: (Cell | null)[]) => {
    if (!sections) return onParams({ steps: formatPattern(next, { drums }) }, node.id);
    const all = [...sections];
    while (all.length <= number) all.push("");
    all[number] = compactPattern(formatPattern(next, { drums }));
    onParams({ steps: joinBank(all) }, node.id);
  };
  const audition = (note: number, velocity = 0.8) => previewSound && onPreview(previewSound, note, velocity);
  const focusKeys = () => keysRef.current?.focus({ preventScroll: true });


  // A long pattern (a whole converted song) is shown a page at a time: the page holding the cursor while you type, the
  // step playing otherwise — thousands of cells redrawn every frame would stall the app.
  const pageSize = drums ? 64 : 256;
  const anchor = focused || step < 0 ? cur : step;
  const pageStart = length > pageSize ? Math.floor(anchor / pageSize) * pageSize : 0;
  const pageEnd = Math.min(length, pageStart + pageSize);
  const visible = cells.slice(pageStart, pageEnd);
  const turnPage = (by: number) => {
    setCursor(Math.min(length - 1, Math.max(0, pageStart + by * pageSize)));
    focusKeys();
  };

  const cell = cells[cur];
  const noteCell = asNote(cell);
  // In the drum view the hit under the cursor (its lane, its step), whose velocity is its own.
  const laneNote = DRUM_NOTES[DRUM_LANES[lane]];
  const hitVel = drums ? hitVelocity(cell, laneNote) : null;
  // The bar shows the cell under the cursor, or the brush on an empty step.
  const shown: Partial<Cell> = noteCell ? { ...noteCell, velocity: drums ? (hitVel ?? brush.velocity) : noteCell.velocity } : brush;
  const change = (patch: Partial<Cell>) => {
    if (drums && "velocity" in patch && hitVel !== null) {
      // A drum's velocity is the selected hit's, the step's other hits as they are — and new hits as they were.
      write(setHitVelocity(cells, cur, laneNote, patch.velocity ?? 0.8));
      return;
    }
    setBrush((b) => ({ ...b, ...patch }));
    if (!noteCell || (drums && "velocity" in patch)) return;
    write(editCell(cells, cur, patch));
  };

  /** − / + and [ ]: the selected note an octave down or up; with no note selected, the octave the next notes are in. */
  const shiftOctave = (by: number) => {
    if (!drums && noteCell) {
      const n = noteCell.note + 12 * by;
      if (n < 0 || n > 127) return;
      write(setCell(cells, cur, { ...noteCell, note: n }));
      audition(n, noteCell.velocity ?? 0.8);
      remember(n);
      return;
    }
    setOctave((o) => Math.min(8, Math.max(0, o + by)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const code = e.code;
    const key = e.key;
    const typed = lastTyped.current;
    lastTyped.current = null;
    const move = (by: number) => {
      e.preventDefault();
      setCursor(moveCursor(cur, by, length));
    };
    if (e.metaKey || e.ctrlKey) return; // leave the app's shortcuts (undo…) alone
    // Right after a note, or on the note selected: a digit is its octave, # its sharp (C 4, F # 3).
    const target = typed ?? (asNote(cells[cur]) ? cur : null);
    const prev = target !== null ? asNote(cells[target]) : null;
    if (prev && /^[0-9]$/.test(key) && !drums) {
      e.preventDefault();
      const n = withOctave(prev.note, Number(key));
      setOctave(Number(key));
      if (n !== null) {
        write(setCell(cells, target!, { ...prev, note: n }));
        audition(n, prev.velocity ?? 0.8);
        setLastNote(n);
      }
      lastTyped.current = typed;
      return;
    }
    if (prev && key === "#" && !drums) {
      e.preventDefault();
      if (prev.note < 127) {
        write(setCell(cells, target!, { ...prev, note: prev.note + 1 }));
        audition(prev.note + 1, prev.velocity ?? 0.8);
      }
      lastTyped.current = typed;
      return;
    }
    if (e.altKey) return;
    if (code === "Space") {
      // Play / pause, as everywhere else: hand the key back to the app.
      e.preventDefault();
      keysRef.current?.blur();
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }));
      return;
    }
    if (code === "ArrowRight") return move(1);
    if (code === "ArrowLeft") return move(-1);
    if (code === "ArrowDown") {
      if (drums) {
        e.preventDefault();
        setLane((l) => Math.min(DRUM_LANES.length - 1, l + 1));
        return;
      }
      return move(STEPS_PER_ROW);
    }
    if (code === "ArrowUp") {
      if (drums) {
        e.preventDefault();
        setLane((l) => Math.max(0, l - 1));
        return;
      }
      return move(-STEPS_PER_ROW);
    }
    if (code === "Escape") {
      keysRef.current?.blur();
      return;
    }
    if (code === "BracketLeft" || code === "NumpadSubtract") {
      e.preventDefault();
      shiftOctave(-1);
      return;
    }
    if (code === "BracketRight" || code === "NumpadAdd") {
      e.preventDefault();
      shiftOctave(1);
      return;
    }
    if (code === "Backspace" || code === "Delete") {
      e.preventDefault();
      write(setCell(cells, cur, null));
      return;
    }
    if (drums) {
      const drum = DRUM_LETTERS[key.toLowerCase()] ?? (code === "Enter" ? DRUM_LANES[lane] : undefined);
      if (!drum) return;
      e.preventDefault();
      const next = toggleDrum(cells, cur, drum, brush.velocity ?? 0.8);
      write(next);
      if (drumsAt(next[cur]).has(DRUM_NOTES[drum])) audition(DRUM_NOTES[drum], 1);
      setCursor(moveCursor(cur, advance, length));
      return;
    }
    if (OFF_LETTERS.has(key.toLowerCase())) {
      e.preventDefault();
      write(setCell(cells, cur, { note: "off" }));
      setCursor(moveCursor(cur, advance, length));
      return;
    }
    const note = noteForLetter(key, octave, e.shiftKey);
    if (note === null) return;
    e.preventDefault();
    if (e.repeat) return;
    write(writeNote(cells, cur, note, brush));
    audition(note, brush.velocity ?? 0.8);
    setLastNote(note);
    lastTyped.current = cur;
    setCursor(moveCursor(cur, advance, length));
  };

  // The melodic grid's mouse. The pitch a click writes: the last note's, in the keyboard's octave.
  const newPitch = () => withOctave(lastNote, octave) ?? lastNote;
  /** A note clicked or selected: the next click writes it again, the keyboard types in its octave. */
  const remember = (note: number) => {
    setLastNote(note);
    setOctave(Math.floor(note / 12) - 1);
  };
  const clickStep = (i: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const c = cells[i];
    const n = asNote(c);
    setCursor(i);
    if (e.shiftKey) {
      // Shift: a note or an OFF goes, an empty step gets an OFF.
      write(setCell(cells, i, c ? null : { note: "off" }));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      // ⌘: sharp (or natural again); on an empty step, a new note already sharp.
      if (c?.note === "off") return;
      const note = toggleSharp(n ? n.note : newPitch());
      write(n ? setCell(cells, i, { ...n, note }) : writeNote(cells, i, note, brush));
      audition(note, n?.velocity ?? brush.velocity ?? 0.8);
      remember(note);
      return;
    }
    if (n) {
      audition(n.note, n.velocity ?? 0.8);
      remember(n.note);
      return;
    }
    if (c) return; // an OFF: selected
    const note = newPitch();
    write(writeNote(cells, i, note, brush));
    audition(note, brush.velocity ?? 0.8);
  };
  const endDragRef = useRef<() => void>(() => {});
  endDragRef.current = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (!d.moved) return clickStep(d.from, { shiftKey: false, metaKey: false, ctrlKey: false });
    const from = Math.min(d.from, d.to);
    const n = asNote(cells[from]);
    write(spanNote(cells, d.from, d.to, newPitch(), brush));
    setCursor(from);
    const note = n ? n.note : newPitch();
    audition(note, n?.velocity ?? brush.velocity ?? 0.8);
    remember(note);
  };
  const held = drums ? [] : heldBy(cells);

  const fx = shown.fx ?? null;
  const fxRange = { GLD: { min: 1, max: 50, step: 1, label: "Glide ×10 ms" }, RTG: { min: 2, max: 8, step: 1, label: "Strikes" }, CHN: { min: 0, max: 100, step: 5, label: "Chance %" }, DLY: { min: 1, max: 15, step: 1, label: "Late /16 step" } } as const;

  return (
    <>
      <div
        className="viewport-gp-hud"
        style={{
          ...HUD_PANEL_STYLE,
          border: `1px solid ${focused ? ACCENT : "rgba(217, 70, 239, 0.45)"}`,
          boxShadow: `0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(217, 70, 239, ${focused ? 0.35 : 0.15})`,
          position: "absolute",
          bottom: 62,
          left: 134,
          right: 12,
          marginLeft: "auto",
          marginRight: "auto",
          width: "max-content",
          maxWidth: "calc(100% - 146px)",
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
        onPointerDown={(e) => {
          // Clicks inside the palette keep the keyboard on it; controls take their own focus.
          if (!(e.target as HTMLElement).closest("select, input, button")) {
            e.preventDefault();
            focusKeys();
          }
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
          <span style={{ fontWeight: 600, fontSize: 12, color: ACCENT }}>{drums ? "Drum Pattern" : "Pattern"}</span>
          {length > pageSize && (
            <span style={{ display: "flex", alignItems: "center", gap: 3, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }} title="A long pattern shows a page at a time: the one you type in, or the one playing">
              <button type="button" className="viewport-hud-button" style={{ width: 22 }} disabled={pageStart === 0} onClick={() => turnPage(-1)}>
                ◀
              </button>
              steps {pageStart + 1}–{pageEnd} of {length}
              <button type="button" className="viewport-hud-button" style={{ width: 22 }} disabled={pageEnd >= length} onClick={() => turnPage(1)}>
                ▶
              </button>
            </span>
          )}
          <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums", minWidth: 92 }}>
            {step >= 0 ? `Bar ${Math.floor(step / STEPS_PER_ROW) + 1} · step ${(step % STEPS_PER_ROW) + 1}` : "—"}
          </span>
          <HudSeparator />
          {bank ? (
            <span
              style={{ display: "flex", alignItems: "center", gap: 3, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}
              title="The numbered pattern shown: the one playing, or pick one (its length is the Order List's)"
            >
              <button type="button" className="viewport-hud-button" style={{ width: 22 }} disabled={number <= 0} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(number - 1)}>
                ◀
              </button>
              <span style={{ color: "#fff", minWidth: 70, textAlign: "center" }}>Pattern {String(number).padStart(2, "0")}</span>
              <button type="button" className="viewport-hud-button" style={{ width: 22 }} disabled={number >= patternCount - 1} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(number + 1)}>
                ▶
              </button>
              {length} steps{at ? ` · order ${at.position + 1}/${bank.list.length}` : ` · ${bank.list.length} in the order`}
            </span>
          ) : (
            <LengthField length={length} onLength={(n) => onParams({ length: String(n), steps: formatPattern(resize(cells, n), { drums }) }, node.id)} />
          )}
          {!drums && (
            <span style={{ display: "flex", alignItems: "center", gap: 3 }} title={noteCell ? "The selected note's octave: − and + (or [ ]) move it" : "The octave the next notes are written in: − and + (or [ ])"}>
              <button type="button" className="viewport-hud-button" style={{ width: 22 }} onPointerDown={(e) => e.preventDefault()} onClick={() => shiftOctave(-1)}>
                −
              </button>
              <span style={{ minWidth: 52, textAlign: "center" }}>Oct {noteCell ? Math.floor(noteCell.note / 12) - 1 : octave}</span>
              <button type="button" className="viewport-hud-button" style={{ width: 22 }} onPointerDown={(e) => e.preventDefault()} onClick={() => shiftOctave(1)}>
                +
              </button>
            </span>
          )}
          <select value={advance} onChange={(e) => setAdvance(Number(e.target.value))} title="How far the cursor moves after a note" style={selectStyle}>
            {[0, 1, 2, 4].map((n) => (
              <option key={n} value={n}>
                Advance {n}
              </option>
            ))}
          </select>
          <button type="button" className="viewport-hud-button" style={wide} onClick={() => write(cells.map(() => null))} disabled={cells.every((c) => c === null)} title="Empty every step (undo to get them back)">
            Clear
          </button>
        </div>

        {/* The keys, above the palette and out of its layout: showing them must not resize it. */}
        <span
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            fontSize: 11,
            padding: "3px 8px",
            borderRadius: 4,
            background: "rgba(15, 23, 42, 0.8)",
            color: focused ? "#e2e8f0" : "#94a3b8",
          }}
        >
          {focused
            ? drums
              ? "click add / select · ⇧click remove · K S C H O L T strike · ↵ the lane · ← → ↑ ↓ · ⌫ clear · Esc"
              : "click note / select · ⌘click ♯ · ⇧click clear / OFF · drag length · A–G notes · 0–9 octave · X off · ⌫ · [ ] · Esc"
            : "click the grid to type"}
        </span>

        <input
          ref={keysRef}
          aria-label="Pattern keyboard"
          readOnly
          value=""
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true);
            // Typing keeps the pattern you are in, even as the song moves on.
            if (bank) setPicked(number);
          }}
          onBlur={() => setFocused(false)}
          style={{ position: "absolute", opacity: 0, width: 1, height: 1, pointerEvents: "none" }}
        />

        <div style={{ overflowX: "auto", overflowY: "auto", maxWidth: "100%", maxHeight: "min(44vh, 340px)" }}>
          {drums ? (
            <div style={{ display: "grid", gridTemplateColumns: `78px repeat(${visible.length}, ${DRUM_CELL}px)`, rowGap: 3, userSelect: "none" }}>
              {DRUM_LANES.map((d, li) => [
                <span
                  key={`n${d}`}
                  onPointerDown={() => setLane(li)}
                  style={{ fontSize: 11, color: li === lane ? "#fff" : "#94a3b8", lineHeight: `${DRUM_CELL}px`, cursor: "pointer", whiteSpace: "nowrap" }}
                  title={`${DRUM_LABEL[d]} — key ${DRUM_KEY_OF[d]}`}
                >
                  {DRUM_KEY_OF[d]} · {DRUM_LABEL[d]}
                </span>,
                ...visible.map((c, j) => {
                  const i = pageStart + j;
                  const vel = hitVelocity(c, DRUM_NOTES[d]);
                  const on = vel !== null;
                  return (
                    <div
                      key={`${d}:${i}`}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setCursor(i);
                        setLane(li);
                        // Click: add a hit on an empty cell, select one already there. Shift-click: take it away.
                        if (e.shiftKey) {
                          if (on) write(toggleDrum(cells, i, d));
                        } else if (on) audition(DRUM_NOTES[d], vel);
                        else {
                          write(toggleDrum(cells, i, d, brush.velocity ?? 0.8));
                          audition(DRUM_NOTES[d], brush.velocity ?? 0.8);
                        }
                        focusKeys();
                      }}
                      title={`${DRUM_LABEL[d]}, step ${i + 1}${on ? ` · vel ${Number(vel.toFixed(2))} — shift-click to remove` : " — click to add"}`}
                      style={{
                        height: DRUM_CELL,
                        cursor: "pointer",
                        borderLeft: i % 4 === 0 ? "1px solid rgba(255,255,255,0.25)" : "1px solid rgba(255,255,255,0.06)",
                        background: on ? `rgba(217, 70, 239, ${0.2 + 0.8 * vel})` : step === i ? "rgba(250,204,21,0.2)" : i % 8 < 4 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.02)",
                        borderRadius: on ? 4 : 0,
                        boxShadow: i === cur && li === lane && focused ? "inset 0 0 0 2px #fff" : step === i && on ? "inset 0 0 0 2px #facc15" : undefined,
                      }}
                    />
                  );
                }),
              ])}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${STEPS_PER_ROW}, ${CELL_W}px)`, rowGap: 4, userSelect: "none" }}>
              {visible.map((c, j) => {
                const i = pageStart + j;
                const isOff = c?.note === "off";
                const n = asNote(c);
                const vel = n?.velocity ?? 0.8;
                const playing = step === i;
                const isCursor = i === cur;
                const inDrag = drag !== null && drag.from !== drag.to && i >= Math.min(drag.from, drag.to) && i <= Math.max(drag.from, drag.to);
                const isHeld = !c && held[i] >= 0;
                return (
                  <div
                    key={i}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      focusKeys();
                      if (e.button !== 0) return;
                      if (e.shiftKey || e.metaKey || e.ctrlKey) return clickStep(i, e);
                      // A plain press: a click when let go on the same step, a held note when dragged across steps.
                      setCursor(i);
                      dragRef.current = { from: i, to: i, moved: false };
                      setDrag({ from: i, to: i });
                      window.addEventListener("pointerup", () => endDragRef.current(), { once: true });
                    }}
                    onPointerEnter={() => {
                      const d = dragRef.current;
                      if (!d || d.to === i) return;
                      d.to = i;
                      d.moved = true;
                      setDrag({ from: d.from, to: i });
                    }}
                    title={
                      n
                        ? `${formatPattern([n])} — digit: octave · ⌘-click: sharp · shift-click: clear · drag: length`
                        : isOff
                          ? "OFF: ends the note — shift-click to clear"
                          : `Step ${i + 1} — click: note · shift-click: OFF · drag: a held note`
                    }
                    style={{
                      height: CELL_H,
                      cursor: "pointer",
                      borderLeft: i % 4 === 0 ? "1px solid rgba(255,255,255,0.3)" : "1px solid rgba(255,255,255,0.06)",
                      background: n
                        ? `rgba(217, 70, 239, ${0.25 + 0.6 * vel})`
                        : inDrag
                          ? "rgba(217, 70, 239, 0.35)"
                          : isHeld
                            ? "rgba(217, 70, 239, 0.16)"
                            : playing
                          ? "rgba(250,204,21,0.22)"
                          : (i % STEPS_PER_ROW) % 8 < 4
                            ? "rgba(255,255,255,0.05)"
                            : "rgba(255,255,255,0.02)",
                      boxShadow: inDrag
                        ? "inset 0 0 0 1px rgba(255,255,255,0.7)"
                        : isCursor && focused ? "inset 0 0 0 2px #fff" : isCursor ? "inset 0 0 0 1px rgba(255,255,255,0.5)" : playing && n ? "inset 0 0 0 2px #facc15" : undefined,
                      borderRadius: n ? 4 : 0,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1.05,
                      position: "relative",
                    }}
                  >
                    {n && (
                      <>
                        <span style={{ fontSize: 11, fontWeight: 700 }}>{[n.note, ...(n.add ?? [])].length > 1 ? `${noteName(n.note)}+` : noteName(n.note)}</span>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.8)" }}>
                          {n.chord ?? ""}
                          {n.inversion ? `/${n.inversion}` : ""}
                          {n.spread ? "^" : ""}
                        </span>
                        {n.fx && (
                          <span style={{ position: "absolute", top: 1, right: 2, fontSize: 8, color: "#facc15" }} title={`${n.fx.type} ${n.fx.value}`}>
                            {n.fx.type[0]}
                          </span>
                        )}
                      </>
                    )}
                    {isOff && <span style={{ fontSize: 10, color: "#f87171", fontWeight: 700 }}>OFF</span>}
                    {isHeld && <span style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 2, background: "rgba(217, 70, 239, 0.7)" }} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <HudBar>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>{drums ? (hitVel !== null ? `${DRUM_LABEL[DRUM_LANES[lane]]} · step ${cur + 1}` : `Step ${cur + 1} · new hits`) : noteCell ? `Step ${cur + 1}` : "New notes"}</span>
        {!drums && (
          <>
            <select
              value={shown.chord ?? ""}
              onChange={(e) => change({ chord: (e.target.value || undefined) as ChordName | undefined })}
              title="Chord on the note (and on the notes you type next)"
              style={selectStyle}
            >
              <option value="">no chord</option>
              {CHORD_NAMES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select value={shown.inversion ?? 0} onChange={(e) => change({ inversion: Number(e.target.value) || undefined })} title="Inversion: the lowest notes moved up an octave" style={selectStyle}>
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "root" : `inv ${n}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`viewport-hud-button ${shown.spread ? "viewport-hud-button-active" : ""}`}
              style={wide}
              onClick={() => change({ spread: !shown.spread || undefined })}
              title="Spread: every second note of the chord an octave up"
            >
              Spread
            </button>
            <HudSeparator />
          </>
        )}
        <CommitSlider label="Vel" value={shown.velocity ?? 0.8} min={0.05} max={1} step={0.05} title="Velocity: how hard the note is struck" onCommit={(v) => change({ velocity: Math.abs(v - 0.8) < 1e-9 ? undefined : v })} />
        <select value={shown.length ?? 0} onChange={(e) => change({ length: Number(e.target.value) || undefined })} title="Length in steps (or until the next note)" style={selectStyle}>
          {[0, 1, 2, 4, 8, 16].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "len: to next" : `len ${n}`}
            </option>
          ))}
        </select>
        <HudSeparator />
        <select
          value={fx?.type ?? ""}
          onChange={(e) => {
            const type = e.target.value as CellFx["type"] | "";
            change({ fx: type ? ({ type, value: type === "GLD" ? 10 : type === "RTG" ? 3 : type === "DLY" ? 2 : 50 } as CellFx) : undefined });
          }}
          title="Effect: glide from the previous note, ratchet, or chance"
          style={selectStyle}
        >
          <option value="">no effect</option>
          {!drums && <option value="GLD">Glide</option>}
          <option value="RTG">Ratchet</option>
          <option value="CHN">Chance</option>
          <option value="DLY">Late</option>
        </select>
        {fx && (
          <CommitSlider
            label={fxRange[fx.type].label}
            value={fx.value}
            min={fxRange[fx.type].min}
            max={fxRange[fx.type].max}
            step={fxRange[fx.type].step}
            digits={0}
            title="The effect's amount"
            onCommit={(v) => change({ fx: { type: fx.type, value: Math.round(v) } as CellFx })}
          />
        )}
      </HudBar>
    </>
  );
}
