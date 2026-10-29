import { useEffect, useRef, useState } from "react";
import { HUD_PANEL_STYLE, HudBar, HudSeparator } from "./HudToolbars";
import { CommitSlider } from "./RigHuds";
import { DRUM_NOTES, DrumName } from "../music/dsp/drums";
import type { PreviewSound } from "../music/engine/description";
import { CHORD_NAMES, ChordName } from "../music/seq/chords";
import { formatPattern, noteName, parsePattern } from "../music/seq/notation";
import {
  DRUM_LANES,
  DRUM_LETTERS,
  OFF_LETTERS,
  drumsAt,
  editCell,
  moveCursor,
  noteForLetter,
  resize,
  setCell,
  toggleDrum,
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
 * A pattern feeding a Drum Kit shows as a drum machine instead: a lane per sound, a click per hit, and each sound's
 * initial — K S C H O L T: kick, snare, clap, hat, open hat, low and top tom — strikes it at the cursor.
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
  const length = Math.max(1, Math.round(Number(p.length) || 16));
  const cells = parsePattern(String(p.steps ?? ""), length);
  const [cursor, setCursor] = useState(0);
  const [lane, setLane] = useState(0);
  const [octave, setOctave] = useState(4);
  const [advance, setAdvance] = useState(1);
  const [brush, setBrush] = useState<Partial<Cell>>({});
  const keysRef = useRef<HTMLInputElement>(null);
  /** The step the last note was typed on, while the next key may still give it its octave or its sharp. */
  const lastTyped = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);
  const cur = Math.min(cursor, length - 1);

  const write = (next: (Cell | null)[]) => onParams({ steps: formatPattern(next, { drums }) }, node.id);
  const audition = (note: number, velocity = 0.8) => previewSound && onPreview(previewSound, note, velocity);
  const focusKeys = () => keysRef.current?.focus({ preventScroll: true });

  const step = useLiveStep(() => {
    const seq = readSequence();
    const { frame, fps } = readPlayhead();
    const t = (frame - startFrame) / Math.max(1, fps);
    if (!seq || t < 0) return -1;
    const g = stepAt(seq.clock, 48_000, t * 48_000);
    return g < 0 ? -1 : g % length;
  });

  const cell = cells[cur];
  const noteCell = asNote(cell);
  // The bar shows the cell under the cursor, or the brush on an empty step.
  const shown: Partial<Cell> = noteCell ?? brush;
  const change = (patch: Partial<Cell>) => {
    setBrush((b) => ({ ...b, ...patch }));
    if (noteCell) write(editCell(cells, cur, patch));
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
    // Right after a note: a digit is its octave, # its sharp (C 4, F # 3).
    const prev = typed !== null ? asNote(cells[typed]) : null;
    if (prev && /^[0-9]$/.test(key) && !drums) {
      e.preventDefault();
      const n = withOctave(prev.note, Number(key));
      setOctave(Number(key));
      if (n !== null) {
        write(setCell(cells, typed!, { ...prev, note: n }));
        audition(n, prev.velocity ?? 0.8);
      }
      lastTyped.current = typed;
      return;
    }
    if (prev && key === "#" && !drums) {
      e.preventDefault();
      if (prev.note < 127) {
        write(setCell(cells, typed!, { ...prev, note: prev.note + 1 }));
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
      setOctave((o) => Math.max(0, o - 1));
      return;
    }
    if (code === "BracketRight" || code === "NumpadAdd") {
      e.preventDefault();
      setOctave((o) => Math.min(8, o + 1));
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
      const next = toggleDrum(cells, cur, drum);
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
    lastTyped.current = cur;
    setCursor(moveCursor(cur, advance, length));
  };

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
          <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums", minWidth: 92 }}>
            {step >= 0 ? `Bar ${Math.floor(step / STEPS_PER_ROW) + 1} · step ${(step % STEPS_PER_ROW) + 1}` : "—"}
          </span>
          <HudSeparator />
          <select
            value={length}
            onChange={(e) => onParams({ length: e.target.value, steps: formatPattern(resize(cells, Number(e.target.value)), { drums }) }, node.id)}
            title="Steps in the pattern before it comes round again"
            style={selectStyle}
          >
            {[...new Set([16, 32, 64, length])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {n} steps · {Number((n / 16).toFixed(2))} {n === 16 ? "bar" : "bars"}
              </option>
            ))}
          </select>
          {!drums && (
            <span style={{ display: "flex", alignItems: "center", gap: 3 }} title="The keyboard's octave: Z plays C of this octave ([ and ] to change it)">
              <button type="button" className="viewport-hud-button" style={{ width: 22 }} onClick={() => setOctave((o) => Math.max(0, o - 1))}>
                −
              </button>
              <span style={{ minWidth: 52, textAlign: "center" }}>Oct {octave}</span>
              <button type="button" className="viewport-hud-button" style={{ width: 22 }} onClick={() => setOctave((o) => Math.min(8, o + 1))}>
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
          <span style={{ color: focused ? "#e2e8f0" : "#94a3b8", marginLeft: "auto" }}>
            {focused
              ? drums
                ? "K S C H O L T strike · ↵ the lane · ← → ↑ ↓ · ⌫ clear · Esc"
                : "A–G notes · ⇧ or # sharp · 0–9 octave · X off · ⌫ clear · ← → ↑ ↓ · [ ] · Esc"
              : "click the grid to type"}
          </span>
        </div>

        <input
          ref={keysRef}
          aria-label="Pattern keyboard"
          readOnly
          value=""
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ position: "absolute", opacity: 0, width: 1, height: 1, pointerEvents: "none" }}
        />

        <div style={{ overflowX: "auto", overflowY: "auto", maxWidth: "100%", maxHeight: "min(44vh, 340px)" }}>
          {drums ? (
            <div style={{ display: "grid", gridTemplateColumns: `78px repeat(${length}, ${DRUM_CELL}px)`, rowGap: 3, userSelect: "none" }}>
              {DRUM_LANES.map((d, li) => [
                <span
                  key={`n${d}`}
                  onPointerDown={() => setLane(li)}
                  style={{ fontSize: 11, color: li === lane ? "#fff" : "#94a3b8", lineHeight: `${DRUM_CELL}px`, cursor: "pointer", whiteSpace: "nowrap" }}
                  title={`${DRUM_LABEL[d]} — key ${DRUM_KEY_OF[d]}`}
                >
                  {DRUM_KEY_OF[d]} · {DRUM_LABEL[d]}
                </span>,
                ...cells.map((c, i) => {
                  const on = drumsAt(c).has(DRUM_NOTES[d]);
                  const vel = c && c.note !== "off" ? (c.velocity ?? 0.8) : 0.8;
                  return (
                    <div
                      key={`${d}:${i}`}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setCursor(i);
                        setLane(li);
                        const next = toggleDrum(cells, i, d);
                        write(next);
                        if (on === false) audition(DRUM_NOTES[d], 1);
                        focusKeys();
                      }}
                      title={`${DRUM_LABEL[d]}, step ${i + 1}${on ? "" : " — click to add"}`}
                      style={{
                        height: DRUM_CELL,
                        cursor: "pointer",
                        borderLeft: i % 4 === 0 ? "1px solid rgba(255,255,255,0.25)" : "1px solid rgba(255,255,255,0.06)",
                        background: on ? `rgba(217, 70, 239, ${0.35 + 0.65 * vel})` : step === i ? "rgba(250,204,21,0.2)" : i % 8 < 4 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.02)",
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
              {cells.map((c, i) => {
                const isOff = c?.note === "off";
                const n = asNote(c);
                const vel = n?.velocity ?? 0.8;
                const playing = step === i;
                const isCursor = i === cur;
                return (
                  <div
                    key={i}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setCursor(i);
                      if (n) audition(n.note, vel);
                      focusKeys();
                    }}
                    onDoubleClick={() => write(setCell(cells, i, null))}
                    title={n ? `${formatPattern([n])} — double-click to clear` : isOff ? "OFF: ends the note" : `Step ${i + 1}`}
                    style={{
                      height: CELL_H,
                      cursor: "pointer",
                      borderLeft: i % 4 === 0 ? "1px solid rgba(255,255,255,0.3)" : "1px solid rgba(255,255,255,0.06)",
                      background: n
                        ? `rgba(217, 70, 239, ${0.25 + 0.6 * vel})`
                        : playing
                          ? "rgba(250,204,21,0.22)"
                          : (i % STEPS_PER_ROW) % 8 < 4
                            ? "rgba(255,255,255,0.05)"
                            : "rgba(255,255,255,0.02)",
                      boxShadow: isCursor && focused ? "inset 0 0 0 2px #fff" : isCursor ? "inset 0 0 0 1px rgba(255,255,255,0.5)" : playing && n ? "inset 0 0 0 2px #facc15" : undefined,
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
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <HudBar>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>{noteCell ? `Step ${cur + 1}` : "New notes"}</span>
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
