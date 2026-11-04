import { useMemo, useRef, useState } from "react";
import type { NodeInstance } from "../graph/types";
import type { PatternPlayhead } from "./PatternHud";
import { formatBars, parseBars } from "../graph/nodes/musicAlgo";
import { Sequence, stepAt } from "../music/seq/sequencer";
import { HudButton, Panel, Stepper, songSample, useLive } from "./MusicAlgoHuds";
import { songForm } from "../music/seq/form";

export { songForm };

/**
 * The arrangement of a song: every Sections node of the graph as one lane, bar by bar, the way a DAW shows its
 * clips — so the form of the piece is read, and written, in one place.
 *
 * - A lane's lit bars hold a miniature of what plays there (its notes, by pitch), coloured by the voice it feeds.
 * - Click or drag along a lane to bring it in or out (the first bar touched decides which); one undo step per stroke.
 *   Painting past the end makes the song longer.
 * - The Form strip reads the arrangement back: runs of bars with the same lanes playing are one section, lettered —
 *   a section that comes back gets its letter again (A B A).
 * - The Energy strip counts the lanes playing in each bar: the piece's arc at a glance.
 * - A lane's name selects its node; ↺ toggles Restart.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

export interface SectionsLane {
  node: NodeInstance;
  /** The voice it feeds, for the label's fallback and the colour. */
  voice?: NodeInstance;
}

const VOICE_COLORS: Record<string, string> = {
  "music/fm-voice": "#d946ef",
  "music/gameboy": "#84cc16",
  "music/drum-kit": "#f59e0b",
  "music/sid": "#38bdf8",
};
const LABEL_W = 150;
const LANE_H = 22;
const FORM_H = 18;
const RULER_H = 14;
const ENERGY_H = 18;

const barsOf = (n: NodeInstance) => parseBars(String(n.params.bars ?? ""));
const barLengthOf = (n: NodeInstance) => Math.max(1, Math.min(256, Math.round(Number(n.params.barLength) || 16)));

function laneLabel({ node, voice }: SectionsLane): string {
  const own = String(node.params.name ?? "").trim();
  if (own) return own;
  const v = voice ? String(voice.params.name ?? "").trim() || String(voice.params.preset ?? "").trim() : "";
  return v || node.id;
}

/** Per bar, the notes starting in it: [position in the bar 0–1, pitch]. Cached on the sequence. */
const rollCache = new WeakMap<Sequence, Map<number, [number, number][][]>>();
function rollOf(seq: Sequence | null, barLength: number): { bars: [number, number][][]; lo: number; hi: number } {
  if (!seq) return { bars: [], lo: 60, hi: 72 };
  let byLength = rollCache.get(seq);
  if (!byLength) rollCache.set(seq, (byLength = new Map()));
  let bars = byLength.get(barLength);
  if (!bars) {
    bars = [];
    seq.pattern.steps.forEach((c, i) => {
      if (!c || c.note === "off") return;
      const b = Math.floor(i / barLength);
      (bars![b] ??= []).push([(i % barLength) / barLength, c.note]);
    });
    byLength.set(barLength, bars);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const bar of bars) for (const [, p] of bar ?? []) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  if (!Number.isFinite(lo)) return { bars, lo: 60, hi: 72 };
  return { bars, lo, hi: Math.max(hi, lo + 5) };
}

export function SectionsHud({
  lanes,
  selectedId,
  readSequence,
  readPlayhead,
  startFrame,
  onParams,
  onSelect,
}: {
  lanes: SectionsLane[];
  selectedId: string;
  /** A Sections node's output, as evaluated. */
  readSequence: (nodeId: string) => Sequence | null;
  readPlayhead: () => PatternPlayhead;
  startFrame: number;
  onParams: OnParams;
  onSelect?: (nodeId: string) => void;
}) {
  // Lanes in the order they first come in, fixed while the HUD is open so a lane never jumps under the pointer.
  const orderRef = useRef<string[] | null>(null);
  const ids = lanes.map((l) => l.node.id).join("|");
  const order = useMemo(() => {
    const first = (l: SectionsLane) => {
      const i = barsOf(l.node).indexOf(true);
      return i < 0 ? Infinity : i;
    };
    const prev = orderRef.current?.filter((id) => lanes.some((l) => l.node.id === id)) ?? [];
    const fresh = lanes.filter((l) => !prev.includes(l.node.id)).sort((a, b) => first(a) - first(b)).map((l) => l.node.id);
    orderRef.current = [...prev, ...fresh];
    return orderRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const sorted = order.map((id) => lanes.find((l) => l.node.id === id)!).filter(Boolean);

  // A stroke in progress: the lane, what it paints, and the lane's bars as painted so far.
  const [stroke, setStroke] = useState<{ id: string; value: boolean; bars: boolean[] } | null>(null);
  const masks = sorted.map((l) => (stroke?.id === l.node.id ? stroke.bars : barsOf(l.node)));
  const total = Math.max(1, ...masks.map((m) => m.length));
  const cw = Math.max(5, Math.min(18, Math.floor(760 / total)));
  const width = LABEL_W + total * cw;

  const selected = sorted.find((l) => l.node.id === selectedId) ?? sorted[0];
  const seqs = sorted.map((l) => readSequence(l.node.id));
  const clock = seqs.find(Boolean)?.clock ?? null;
  const barLength = selected ? barLengthOf(selected.node) : 16;
  const seconds = clock ? (total * barLength) / clock.stepsPerBeat / clock.bpm * 60 : 0;
  const time = (bar: number) => {
    if (!clock) return "";
    const s = (bar * barLength) / clock.stepsPerBeat / clock.bpm * 60;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

  const playhead = useLive(() => {
    const t = songSample(readPlayhead, startFrame);
    if (!clock || t < 0) return -1;
    const step = stepAt(clock, 48_000, t);
    return (step / barLength) % total;
  });

  const form = songForm(masks, total);
  const energy = Array.from({ length: total }, (_, b) => masks.reduce((a, m) => a + (m[b] ? 1 : 0), 0));
  const maxEnergy = Math.max(1, ...energy);

  const paint = (bars: boolean[], bar: number, value: boolean) => {
    const next = bars.slice();
    while (next.length <= bar) next.push(false);
    next[bar] = value;
    return next;
  };
  const barAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    return Math.max(0, Math.floor((e.clientX - r.left) / cw));
  };
  const commit = () => {
    if (!stroke) return;
    onParams({ bars: formatBars(stroke.bars) }, stroke.id);
    setStroke(null);
  };
  const resize = (n: number) => {
    // Every lane to the same length: trimmed, or padded with rests.
    for (const l of sorted) {
      const m = barsOf(l.node).slice(0, n);
      while (m.length < n) m.push(false);
      onParams({ bars: formatBars(m) }, l.node.id);
    }
  };

  const status = `${sorted.length} lanes · ${total} bars${seconds ? ` · ${time(total)}` : ""} · form ${form.map((f) => f.letter).join(" ") || "—"}`;

  return (
    <Panel title="Arrangement" status={status}>
      <svg width={width} height={RULER_H + FORM_H + ENERGY_H + sorted.length * LANE_H + 2} style={{ display: "block", flexShrink: 0, fontSize: 10 }}>
        {/* Ruler: bar numbers from 1, every 4 */}
        {Array.from({ length: total }, (_, b) =>
          b % 4 === 0 ? (
            <text key={`r${b}`} x={LABEL_W + b * cw + 2} y={10} fill="#64748b">
              {b + 1}
            </text>
          ) : null,
        )}
        <text x={0} y={10} fill="#64748b">
          bar
        </text>
        {/* Form */}
        <text x={0} y={RULER_H + 12} fill="#94a3b8">
          Form
        </text>
        {form.map((f, k) => (
          <g key={`f${k}`}>
            <title>{`${f.letter}: bars ${f.from + 1}–${f.to}${clock ? ` · ${time(f.from)}–${time(f.to)}` : ""}`}</title>
            <rect x={LABEL_W + f.from * cw + 0.5} y={RULER_H + 1} width={(f.to - f.from) * cw - 1} height={FORM_H - 3} rx={3} fill={f.color} fillOpacity={0.22} stroke={f.color} strokeOpacity={0.7} />
            {(f.to - f.from) * cw >= 10 && (
              <text x={LABEL_W + ((f.from + f.to) / 2) * cw} y={RULER_H + 12} textAnchor="middle" fill="#fff" fontWeight={600}>
                {f.letter}
              </text>
            )}
          </g>
        ))}
        {/* Energy */}
        <text x={0} y={RULER_H + FORM_H + 12} fill="#94a3b8">
          Energy
        </text>
        {energy.map((n, b) => {
          const h = (n / maxEnergy) * (ENERGY_H - 4);
          return <rect key={`e${b}`} x={LABEL_W + b * cw + 1} y={RULER_H + FORM_H + ENERGY_H - 2 - h} width={cw - 2} height={h} fill="rgba(148,163,184,0.45)" />;
        })}
        {/* Lanes */}
        {sorted.map((lane, r) => {
          const y = RULER_H + FORM_H + ENERGY_H + r * LANE_H;
          const id = lane.node.id;
          const mask = masks[r];
          const color = VOICE_COLORS[lane.voice?.type ?? ""] ?? "#d946ef";
          const isSel = id === selected?.node.id;
          const roll = rollOf(seqs[r], barLengthOf(lane.node));
          const restart = lane.node.params.restart !== false;
          return (
            <g key={id}>
              {isSel && <rect x={0} y={y} width={width} height={LANE_H} fill="rgba(217,70,239,0.10)" />}
              <g style={{ cursor: "pointer" }} onPointerDown={(e) => e.stopPropagation()} onClick={() => onSelect?.(id)}>
                <title>{`${laneLabel(lane)} — click to select its node`}</title>
                <rect x={0} y={y + 3} width={4} height={LANE_H - 6} rx={2} fill={color} />
                <text x={9} y={y + 15} fill={isSel ? "#fff" : "#cbd5e1"} fontWeight={isSel ? 600 : 400}>
                  {laneLabel(lane).length > 19 ? `${laneLabel(lane).slice(0, 18)}…` : laneLabel(lane)}
                </text>
              </g>
              <g style={{ cursor: "pointer" }} onClick={() => onParams({ restart: !restart }, id)}>
                <title>{restart ? "Restart at each entry (on) — click: it loops on underneath" : "Loops on underneath — click: restart at each entry"}</title>
                <text x={LABEL_W - 14} y={y + 15} fill={restart ? color : "#475569"}>
                  ↺
                </text>
              </g>
              <svg
                x={LABEL_W}
                y={y}
                width={total * cw}
                height={LANE_H}
                style={{ cursor: "crosshair", overflow: "visible" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.currentTarget as Element).setPointerCapture(e.pointerId);
                  const bar = barAt(e);
                  const value = !mask[bar];
                  setStroke({ id, value, bars: paint(mask, bar, value) });
                }}
                onPointerMove={(e) => {
                  if (stroke?.id !== id) return;
                  const bar = barAt(e);
                  if (!!stroke.bars[bar] !== stroke.value) setStroke({ ...stroke, bars: paint(stroke.bars, bar, stroke.value) });
                }}
                onPointerUp={commit}
                onPointerCancel={commit}
              >
                <rect x={0} y={1} width={total * cw} height={LANE_H - 2} fill="rgba(255,255,255,0.03)" />
                {Array.from({ length: total }, (_, b) => {
                  const on = !!mask[b];
                  const notes = on ? (roll.bars[b] ?? []) : [];
                  return (
                    <g key={b}>
                      <title>{`${laneLabel(lane)} · bar ${b + 1}${clock ? ` (${time(b)})` : ""} · ${on ? "plays" : "rests"}`}</title>
                      <rect
                        x={b * cw + 0.5}
                        y={2}
                        width={cw - 1}
                        height={LANE_H - 4}
                        rx={1.5}
                        fill={on ? color : b % 4 === 0 ? "rgba(255,255,255,0.06)" : "transparent"}
                        fillOpacity={on ? 0.28 : 1}
                        stroke={on ? color : "none"}
                        strokeOpacity={0.55}
                        strokeWidth={0.8}
                      />
                      {notes.map(([pos, p], k) => {
                        const ny = 4 + (1 - (p - roll.lo) / (roll.hi - roll.lo)) * (LANE_H - 9);
                        return <rect key={k} x={b * cw + 0.5 + pos * (cw - 1)} y={ny} width={Math.max(1, cw / 8)} height={1.6} fill="#fff" fillOpacity={0.85} />;
                      })}
                    </g>
                  );
                })}
              </svg>
            </g>
          );
        })}
        {/* Playhead */}
        {playhead >= 0 && (
          <line
            x1={LABEL_W + playhead * cw}
            x2={LABEL_W + playhead * cw}
            y1={0}
            y2={RULER_H + FORM_H + ENERGY_H + sorted.length * LANE_H}
            stroke="#fff"
            strokeOpacity={0.8}
            strokeWidth={1}
            pointerEvents="none"
          />
        )}
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", fontSize: 11, color: "#94a3b8" }}>
        <Stepper label="Song (bars)" title="The song's length: every lane trimmed, or padded with rests" value={total} min={1} max={1024} onChange={resize} />
        {selected && (
          <Stepper
            label="Bar (steps)"
            title={`${laneLabel(selected)}: steps per bar`}
            value={barLengthOf(selected.node)}
            min={1}
            max={256}
            onChange={(v) => onParams({ barLength: v }, selected.node.id)}
          />
        )}
        {selected && (
          <HudButton label="Clear lane" title={`${laneLabel(selected)}: every bar rests`} onClick={() => onParams({ bars: formatBars(new Array(total).fill(false)) }, selected.node.id)} />
        )}
        {selected && (
          <HudButton label="Fill lane" title={`${laneLabel(selected)}: every bar plays`} onClick={() => onParams({ bars: formatBars(new Array(total).fill(true)) }, selected.node.id)} />
        )}
        <span>Drag along a lane to bring it in or out · click a name to select its node</span>
      </div>
    </Panel>
  );
}
