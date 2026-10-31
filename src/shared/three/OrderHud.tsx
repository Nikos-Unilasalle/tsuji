import { useEffect, useRef, useState } from "react";
import { HUD_PANEL_STYLE, HudSeparator } from "./HudToolbars";
import {
  MAX_ORDER,
  SongOrder,
  bankLayout,
  formatOrder,
  insertOrderAt,
  orderLengthOf,
  parseOrder,
  positionAt,
  removeOrderAt,
  setOrderAt,
  setOwnLength,
  unusedPattern,
} from "../music/seq/order";
import { Clock, stepAt, stepTime } from "../music/seq/sequencer";
import type { NodeInstance } from "../graph/types";
import type { PatternPlayhead } from "./PatternHud";

/**
 * The Order List's palette in the 3D view, a tracker's order list: a cell per position, its pattern number in it, the
 * position playing lit as the song runs. Click a cell to select it, double-click to play from it. The keyboard, once
 * the list is clicked: ← → move, ↑ ↓ (or − +) change the pattern number, two digits type one (0 7 → 07), Insert or Enter
 * repeats the selected position after it, ⌫ removes it, N puts a pattern number no position uses yet, Space plays from
 * it. The bar under the list sets the selected pattern's length (the same in every track).
 *
 * Every edit writes the node's `order` (or `lengths`) text in one undo step.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const ACCENT = "#d946ef"; // the Music category
const CELL_W = 36;
const CELL_H = 40;
const PER_ROW = 16;
/** Two digits typed within this many ms make one number (0 then 7: 07). */
const TYPE_MS = 1200;

/** A pattern number's colour: the same number, the same hue, so repeats show at a glance. */
function hueOf(n: number): number {
  return Math.round((n * 137.508) % 360);
}

function useLive<T>(read: () => T): T {
  const readRef = useRef(read);
  readRef.current = read;
  const [value, setValue] = useState(() => read());
  useEffect(() => {
    let id = 0;
    const tick = () => {
      setValue(readRef.current());
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
  return value;
}

function StepsField({ steps, onSteps }: { steps: number; onSteps: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Math.round(Number(draft));
    setDraft(null);
    if (Number.isFinite(n) && n >= 1 && n !== steps) onSteps(Math.min(16384, n));
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label="Pattern length in steps"
      value={draft ?? String(steps)}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{ background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "2px 4px", fontSize: 11, width: 52, textAlign: "right" }}
    />
  );
}

export function OrderHud({
  node,
  readClock,
  readPlayhead,
  startFrame,
  onParams,
  onSeek,
}: {
  node: NodeInstance;
  /** The clock the Order List passes on (its BPM, its steps a beat), to place positions in time. */
  readClock: () => Clock | null;
  readPlayhead: () => PatternPlayhead;
  /** Music Out's Start Frame, where the song's step 0 is. */
  startFrame: number;
  onParams: OnParams;
  /** Puts the playhead on a frame. */
  onSeek: (frame: number) => void;
}) {
  const p = node.params;
  const list = parseOrder(String(p.order ?? ""));
  const length = Math.max(1, Math.round(Number(p.length) || 16));
  const lengthsText = String(p.lengths ?? "");
  const order: SongOrder = {
    list,
    lengths: lengthsText
      .split(/[\s,;]+/)
      .filter((w) => w !== "")
      .map((w) => Math.max(0, Math.round(Number(w) || 0))),
    length,
  };
  const layout = bankLayout([], 1, order);

  const [selected, setSelected] = useState(0);
  const [focused, setFocused] = useState(false);
  const keysRef = useRef<HTMLInputElement>(null);
  const typed = useRef<{ at: number; value: number } | null>(null);
  const sel = Math.min(Math.max(0, list.length - 1), selected);
  const focusKeys = () => keysRef.current?.focus({ preventScroll: true });

  const playing = useLive(() => {
    const clock = readClock();
    const { frame, fps } = readPlayhead();
    const t = (frame - startFrame) / Math.max(1, fps);
    if (!clock || t < 0 || list.length === 0) return -1;
    return positionAt(layout, stepAt(clock, 48_000, t * 48_000))?.position ?? -1;
  });

  const write = (next: number[]) => onParams({ order: formatOrder(next) }, node.id);
  const seekTo = (pos: number) => {
    const clock = readClock();
    if (!clock || pos < 0 || pos >= layout.starts.length) return;
    const { fps } = readPlayhead();
    onSeek(startFrame + Math.round(stepTime(clock, 1, layout.starts[pos]) * Math.max(1, fps)));
  };
  /** Not clamped to the list here: an insert selects a position the list has only after the write (render clamps). */
  const select = (i: number) => {
    setSelected(Math.max(0, i));
    typed.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.metaKey || e.ctrlKey) return; // the app's shortcuts (undo…)
    const key = e.key;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (key === "ArrowLeft" || key === "ArrowRight") {
      done();
      select(sel + (key === "ArrowLeft" ? -1 : 1));
    } else if (key === "ArrowUp" || key === "ArrowDown" || key === "+" || key === "-" || key === "=") {
      done();
      const by = key === "ArrowUp" || key === "+" || key === "=" ? 1 : -1;
      write(setOrderAt(list, sel, (list[sel] ?? 0) + by));
      typed.current = null;
    } else if (/^\d$/.test(key)) {
      done();
      const now = performance.now();
      const prev = typed.current;
      const value = prev && now - prev.at < TYPE_MS && prev.value * 10 + Number(key) < MAX_ORDER ? prev.value * 10 + Number(key) : Number(key);
      typed.current = { at: now, value };
      write(setOrderAt(list, sel, value));
    } else if (key === "Insert" || key === "Enter") {
      done();
      write(insertOrderAt(list, sel + 1, list[sel] ?? 0));
      select(sel + 1);
    } else if (key === "Backspace" || key === "Delete") {
      done();
      write(removeOrderAt(list, sel));
      select(key === "Backspace" ? sel - 1 : sel);
    } else if (key.toLowerCase() === "n") {
      done();
      write(setOrderAt(list, sel, unusedPattern(list)));
    } else if (key === " ") {
      done();
      seekTo(sel);
    } else if (key === "Escape") {
      done();
      keysRef.current?.blur();
    }
  };

  const button = (label: string, title: string, onClick: () => void, disabled = false) => (
    <button type="button" className="viewport-hud-button" style={{ width: "auto", padding: "0 8px" }} title={title} disabled={disabled} onPointerDown={(e) => e.preventDefault()} onClick={onClick}>
      {label}
    </button>
  );
  const number = list[sel] ?? 0;
  const ownSteps = orderLengthOf(order, number);
  const at = playing >= 0 ? playing : -1;

  return (
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
        if (!(e.target as HTMLElement).closest("select, input, button")) {
          e.preventDefault();
          focusKeys();
        }
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
        <span style={{ fontWeight: 600, fontSize: 12, color: ACCENT }}>Order List</span>
        <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums", minWidth: 150 }}>
          {at >= 0 ? `Playing ${at + 1}/${list.length} · pattern ${String(list[at]).padStart(2, "0")}` : `${list.length} positions`}
        </span>
        <span style={{ color: focused ? "#e2e8f0" : "#64748b", fontSize: 10 }}>
          {focused ? "← → select · ↑ ↓ or 0–9 pattern · ↵ repeat · ⌫ remove · N new · Space play from · Esc" : "click a position to edit · double-click to play from it"}
        </span>
      </div>

      <input
        ref={keysRef}
        aria-label="Order list keyboard"
        readOnly
        value=""
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{ position: "absolute", opacity: 0, width: 1, height: 1, pointerEvents: "none" }}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(PER_ROW, Math.max(1, list.length))}, ${CELL_W}px)`,
          gap: 3,
          maxHeight: "min(30vh, 220px)",
          overflowY: "auto",
          userSelect: "none",
        }}
      >
        {list.map((n, i) => {
          const hue = hueOf(n);
          const isSel = i === sel;
          const isPlaying = i === at;
          return (
            <div
              key={i}
              title={`Position ${i + 1}: pattern ${String(n).padStart(2, "0")} · ${orderLengthOf(order, n)} steps`}
              onPointerDown={() => select(i)}
              onDoubleClick={() => seekTo(i)}
              style={{
                width: CELL_W,
                height: CELL_H,
                borderRadius: 5,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                background: isPlaying ? `hsla(${hue}, 80%, 55%, 0.85)` : `hsla(${hue}, 55%, 40%, 0.35)`,
                border: isSel ? "2px solid #fff" : `1px solid hsla(${hue}, 70%, 60%, 0.5)`,
                boxShadow: isPlaying ? `0 0 10px hsla(${hue}, 90%, 60%, 0.8)` : "none",
                boxSizing: "border-box",
              }}
            >
              <span style={{ fontSize: 9, color: isPlaying ? "#0f172a" : "#94a3b8", fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: isPlaying ? "#0f172a" : "#fff", fontVariantNumeric: "tabular-nums" }}>{String(n).padStart(2, "0")}</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8" }}>
        <span style={{ color: "#fff" }}>
          Position {sel + 1} · pattern {String(number).padStart(2, "0")}
        </span>
        <StepsField steps={ownSteps} onSteps={(n) => onParams({ lengths: setOwnLength(lengthsText, number, n, length) }, node.id)} />
        <span title="Every track's pattern of this number is this long; the Pattern Length is the default">steps (default {length})</span>
        <HudSeparator />
        {button("◀", "Previous position", () => select(sel - 1), sel <= 0)}
        {button("▶", "Next position", () => select(sel + 1), sel >= list.length - 1)}
        {button("Repeat", "Insert this position again after it (Enter)", () => {
          write(insertOrderAt(list, sel + 1, number));
          select(sel + 1);
        })}
        {button("New", "Put a pattern number no position uses yet (N)", () => write(setOrderAt(list, sel, unusedPattern(list))))}
        {button("Remove", "Take this position out (⌫)", () => write(removeOrderAt(list, sel)), list.length <= 1)}
        <HudSeparator />
        {button("Play from here", "Move the playhead to this position (Space, or double-click)", () => seekTo(sel))}
      </div>
    </div>
  );
}
