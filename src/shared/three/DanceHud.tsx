import { useEffect, useRef, useState } from "react";
import { HUD_PANEL_STYLE, HudBar, HudSeparator } from "./HudToolbars";
import { CommitSlider } from "./RigHuds";
import { GROOVE_PRESET_KEYS, GROOVE_PRESETS } from "../graph/ik/danceGroove";
import { moveAt, readMoves, type DanceInfo, type DanceMove } from "../graph/nodes/bipedDance";
import { diceChoreography } from "../graph/nodes/danceDice";
import { recordLive, type LiveMove } from "../graph/nodes/danceLive";
import type { NodeInstance } from "../graph/types";

/**
 * Biped Dance's palette: the groove along the bottom (style, tempo with Tap,
 * energy, groove, swing) and above it the beat grid — a lane per wired pose,
 * a cell per beat, the playhead running through it and the count lit on the
 * beat. Click a cell to drop the pose there, drag to hold it longer, click it
 * again to take it out; shift-click mirrors it. One undo step per gesture.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const wide = { width: "auto", padding: "0 9px" } as const;
const selectStyle = { background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "3px 6px", fontSize: 12 } as const;
const CELL = 22;
const LANE_COLORS = ["#f472b6", "#38bdf8", "#facc15", "#a78bfa", "#34d399", "#fb923c", "#f87171", "#22d3ee"];
const LOOPS = [4, 8, 16, 32, 64];

/** The node's beat, read every animation frame: the grid's playhead has to land on the beat, not near it. */
function useLiveBeat(read: () => DanceInfo | null): DanceInfo | null {
  const readRef = useRef(read);
  readRef.current = read;
  const [info, setInfo] = useState<DanceInfo | null>(() => read());
  useEffect(() => {
    let id = 0;
    const tick = () => {
      setInfo(readRef.current());
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
  return info;
}

/** Tap the beat: the tempo of the last few taps, forgotten after a pause. */
function useTapTempo(onTempo: (bpm: number) => void) {
  const taps = useRef<number[]>([]);
  return () => {
    const now = performance.now();
    const last = taps.current[taps.current.length - 1];
    if (last === undefined || now - last > 2000) taps.current = [];
    taps.current = [...taps.current, now].slice(-5);
    const t = taps.current;
    if (t.length < 2) return;
    const bpm = (60000 * (t.length - 1)) / (t[t.length - 1] - t[0]);
    if (Number.isFinite(bpm)) onTempo(Math.max(30, Math.min(300, Math.round(bpm))));
  };
}

export function DanceHud({ node, laneNames, readInfo, onParams }: { node: NodeInstance; laneNames: string[]; readInfo: () => DanceInfo | null; onParams: OnParams }) {
  const info = useLiveBeat(readInfo);
  const p = node.params;
  const set = (params: Record<string, unknown>) => onParams(params, node.id);
  const tap = useTapTempo((bpm) => set({ bpm }));
  const preset = String(p.preset ?? "bounce");

  return (
    <>
      <BeatGrid node={node} info={info} laneNames={laneNames} onParams={onParams} />
      <HudBar>
        <select value={preset} onChange={(e) => set({ preset: e.target.value })} title={GROOVE_PRESETS[preset as keyof typeof GROOVE_PRESETS]?.hint ?? "Groove style"} style={selectStyle}>
          {GROOVE_PRESET_KEYS.map((key) => (
            <option key={key} value={key} title={GROOVE_PRESETS[key].hint}>
              {GROOVE_PRESETS[key].label}
            </option>
          ))}
        </select>
        <HudSeparator />
        <CommitSlider label="BPM" value={Number(p.bpm ?? 110)} min={40} max={200} step={1} digits={0} title="Tempo, beats per minute" onCommit={(bpm) => set({ bpm: Math.round(bpm) })} />
        <button type="button" className="viewport-hud-button" style={wide} onClick={tap} title="Tap along with the music: the tempo follows your last taps">
          Tap
        </button>
        <HudSeparator />
        <CommitSlider label="Energy" value={Number(p.energy ?? 1)} min={0} max={2} step={0.05} title="How big every movement is: 0 still, 1 as styled, more is wild" onCommit={(energy) => set({ energy })} />
        <CommitSlider
          label="Groove"
          value={Number(p.groove ?? 0.4)}
          min={0}
          max={2}
          step={0.05}
          title="The human in it: every part a little off, a little late, never twice the same (0 a metronome, 1 human, more loose)"
          onCommit={(groove) => set({ groove })}
        />
        <CommitSlider label="Swing" value={Number(p.swing ?? 0)} min={0} max={1} step={0.05} title="Off-beats pushed late: 0 straight, 1 triplet swing" onCommit={(swing) => set({ swing })} />
      </HudBar>
    </>
  );
}

function BeatCount({ beat }: { beat: number }) {
  const inBar = ((Math.floor(beat) % 4) + 4) % 4;
  const bar = Math.floor(beat / 4) + 1;
  // Bright on the beat, fading through it.
  const flash = 1 - (beat - Math.floor(beat));
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }} title="Bar and beat">
      <span style={{ fontVariantNumeric: "tabular-nums", color: "#94a3b8", minWidth: 42 }}>Bar {bar}</span>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            display: "grid",
            placeItems: "center",
            fontSize: 11,
            fontWeight: 700,
            color: i === inBar ? "#0f172a" : "#94a3b8",
            background: i === inBar ? `rgba(250, 204, 21, ${0.35 + 0.65 * flash})` : "rgba(255,255,255,0.08)",
            transform: i === inBar ? `scale(${1 + 0.25 * flash})` : undefined,
          }}
        >
          {i + 1}
        </span>
      ))}
    </span>
  );
}

/** What hits next: the pose's name, mirrored or not, and a countdown in beats. Its ghost is on the body. */
function NextUp({ info, laneNames }: { info: DanceInfo | null; laneNames: string[] }) {
  const next = info?.next;
  if (!next) return null;
  const color = LANE_COLORS[next.lane % LANE_COLORS.length];
  const count = Math.ceil(next.inBeats - 1e-6);
  return (
    <span style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: 5, alignItems: "center", minWidth: 120 }} title="The next pose, drawn as a ghost on the body">
      Next
      <span style={{ color, fontWeight: 700 }}>
        {laneNames[next.lane] ?? `Pose ${next.lane + 1}`}
        {next.mirror ? " ◐" : ""}
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", color: count <= 1 ? "#facc15" : "#94a3b8" }}>in {count}</span>
    </span>
  );
}

interface Drag {
  index: number;
  /** The move as it was, or null when this gesture made it. */
  was: DanceMove | null;
  moved: boolean;
}

function BeatGrid({ node, info, laneNames, onParams }: { node: NodeInstance; info: DanceInfo | null; laneNames: string[]; onParams: OnParams }) {
  const saved = readMoves(node.params.moves);
  const [draft, setDraftState] = useState<DanceMove[] | null>(null);
  // The gesture's moves as of now, for the pointer-up that may land anywhere on the page.
  const draftRef = useRef<DanceMove[] | null>(null);
  const setDraft = (next: DanceMove[] | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const drag = useRef<Drag | null>(null);
  const moves = draft ?? saved;
  // Recording: what was played live since Rec, folded into the grid when Rec stops (one undo step).
  const [recFrom, setRecFrom] = useState<number | null>(null);
  const played = useRef(new Map<number, LiveMove>());
  useEffect(() => {
    if (recFrom === null || !info) return;
    for (const m of info.live) if (m.start >= recFrom - 1e-6) played.current.set(m.id, m);
  }, [info, recFrom]);
  const toggleRec = () => {
    if (recFrom === null) {
      played.current.clear();
      setRecFrom(info?.beat ?? 0);
      return;
    }
    const taken = [...played.current.values()];
    setRecFrom(null);
    if (taken.length > 0) commit(recordLive(saved, taken, recFrom, info?.beat ?? recFrom, loopBeats));
  };
  const beatNow = info?.beat ?? 0;
  const liveLane = (lane: number) => info?.live.some((m) => m.lane === lane && m.start <= beatNow + 0.5 && (m.end === null || m.end > beatNow)) ?? false;
  const loopBeats = info?.loopBeats ?? Math.round(Number(node.params.loopBeats ?? 16));
  // Up to the last pose wired: the empty socket below it is no lane yet.
  const laneCount = Math.max((info?.lanes.lastIndexOf(true) ?? -1) + 1, laneNames.length);
  const set = (params: Record<string, unknown>) => onParams(params, node.id);
  const commit = (next: DanceMove[]) => {
    setDraft(null);
    set({ moves: next.map((m) => ({ ...m })) });
  };

  // How long a move on `lane` from `start` may run before it meets the next one there, or the loop's end.
  const room = (list: DanceMove[], lane: number, start: number, except: number) =>
    list.reduce((r, m, i) => (i !== except && m.lane === lane && m.start > start ? Math.min(r, m.start - start) : r), loopBeats - start);

  const down = (lane: number, cell: number, e: React.PointerEvent) => {
    e.preventDefault();
    const index = moveAt(moves, lane, cell);
    if (index >= 0 && e.shiftKey) {
      commit(moves.map((m, i) => (i === index ? { ...m, mirror: !m.mirror } : m)));
      return;
    }
    window.addEventListener("pointerup", up, { once: true });
    if (index >= 0) {
      drag.current = { index, was: moves[index], moved: false };
      setDraft(moves);
      return;
    }
    const next = [...moves, { lane, start: cell, length: 1, mirror: false }];
    drag.current = { index: next.length - 1, was: null, moved: false };
    setDraft(next);
  };
  const over = (cell: number) => {
    const d = drag.current;
    const draft = draftRef.current;
    if (!d || !draft) return;
    const m = draft[d.index];
    const length = Math.max(1, Math.min(cell - m.start + 1, room(draft, m.lane, m.start, d.index)));
    if (length === m.length) return;
    d.moved = true;
    setDraft(draft.map((x, i) => (i === d.index ? { ...x, length } : x)));
  };
  function up() {
    const d = drag.current;
    const draft = draftRef.current;
    drag.current = null;
    if (!d || !draft) return;
    // A click on a move without dragging takes it out.
    if (d.was && !d.moved) commit(draft.filter((_, i) => i !== d.index));
    else commit(draft);
  }

  const beat = info?.beat ?? 0;
  const head = ((beat % loopBeats) + loopBeats) % loopBeats;

  return (
    <div
      className="viewport-gp-hud"
      style={{
        ...HUD_PANEL_STYLE,
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
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <BeatCount beat={beat} />
        <HudSeparator />
        <select value={loopBeats} onChange={(e) => set({ loopBeats: Number(e.target.value) })} title="Beats before the choreography comes round again" style={selectStyle}>
          {LOOPS.map((n) => (
            <option key={n} value={n}>
              {n / 4} {n === 4 ? "bar" : "bars"}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="viewport-hud-button"
          style={wide}
          disabled={!info || !info.lanes.some(Boolean)}
          onClick={() => {
            if (!info) return;
            const seed = Math.round(Number(node.params.diceSeed ?? 0)) + 1;
            const lanes = info.lanes.flatMap((wired, i) => (wired ? [i] : []));
            setDraft(null);
            set({ moves: diceChoreography(lanes, loopBeats, seed), diceSeed: seed });
          }}
          title="Roll a choreography from the poses wired in — phrased in call and answer, ending on a held pose. Again for another (undo to go back)"
        >
          🎲 Dice
        </button>
        <button type="button" className="viewport-hud-button" style={wide} onClick={() => commit([])} disabled={saved.length === 0} title="Take every pose out: just the groove">
          Clear
        </button>
        <button
          type="button"
          className={`viewport-hud-button ${recFrom !== null ? "viewport-hud-button-active" : ""}`}
          style={{ ...wide, color: recFrom !== null ? "#f87171" : undefined }}
          onClick={toggleRec}
          title={
            recFrom !== null
              ? "Recording what the Hit sockets play — click to stop and put it on the grid"
              : "Record live: play the poses through their Hit sockets (Keyboard, Audio Peak Detector…) while the timeline plays, and they land on the grid"
          }
        >
          {recFrom !== null ? "■ Stop" : "● Rec"}
        </button>
        <NextUp info={info} laneNames={laneNames} />
        <span style={{ color: "#94a3b8", fontSize: 11, marginLeft: "auto" }}>click: drop · drag: hold · click again: remove · ⇧ click: mirror</span>
      </div>
      {laneCount === 0 ? (
        <span style={{ color: "#94a3b8", fontSize: 11 }}>Wire a Biped Pose's Pose output into Pose 1 to dance it on the beat — just the groove until then.</span>
      ) : (
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <div style={{ position: "relative", display: "grid", gridTemplateColumns: `90px repeat(${loopBeats}, ${CELL}px)`, rowGap: 3, userSelect: "none" }}>
            {Array.from({ length: laneCount }, (_, lane) => {
              const color = LANE_COLORS[lane % LANE_COLORS.length];
              const wired = info?.lanes[lane] ?? true;
              return [
                <span
                  key={`n${lane}`}
                  style={{
                    fontSize: 11,
                    color: liveLane(lane) ? "#0f172a" : wired ? color : "#64748b",
                    background: liveLane(lane) ? color : undefined,
                    borderRadius: 4,
                    paddingLeft: 3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginRight: 6,
                    lineHeight: `${CELL}px`,
                  }}
                  title={`${laneNames[lane] ?? `Pose ${lane + 1}`} — lights up while its Hit socket plays it`}
                >
                  {lane + 1}. {laneNames[lane] ?? "—"}
                </span>,
                ...Array.from({ length: loopBeats }, (_, cell) => {
                  const index = moveAt(moves, lane, cell);
                  const m = index >= 0 ? moves[index] : null;
                  const first = m?.start === cell;
                  const last = m ? cell === m.start + m.length - 1 : false;
                  const playing = Math.floor(head) === cell;
                  return (
                    <div
                      key={`${lane}:${cell}`}
                      onPointerDown={(e) => down(lane, cell, e)}
                      onPointerEnter={() => over(cell)}
                      title={m ? `${laneNames[lane] ?? `Pose ${lane + 1}`}${m.mirror ? " (mirrored)" : ""}, ${m.length === 1 ? `beat ${m.start + 1}` : `beats ${m.start + 1}–${m.start + m.length}`}` : `Drop ${laneNames[lane] ?? `Pose ${lane + 1}`} on beat ${cell + 1}`}
                      style={{
                        height: CELL,
                        cursor: "pointer",
                        borderLeft: cell % 4 === 0 ? "1px solid rgba(255,255,255,0.25)" : "1px solid rgba(255,255,255,0.06)",
                        background: m ? color : playing ? "rgba(250,204,21,0.18)" : cell % 8 < 4 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.02)",
                        opacity: m && !wired ? 0.35 : 1,
                        borderRadius: m ? `${first ? 5 : 0}px ${last ? 5 : 0}px ${last ? 5 : 0}px ${first ? 5 : 0}px` : 0,
                        display: "grid",
                        placeItems: "center",
                        fontSize: 10,
                        color: "#0f172a",
                        fontWeight: 700,
                        boxShadow: m && playing ? "inset 0 0 0 2px #fff" : undefined,
                      }}
                    >
                      {first && m?.mirror ? "◐" : ""}
                    </div>
                  );
                }),
              ];
            })}
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 90 + head * CELL,
                width: 2,
                background: "#facc15",
                boxShadow: "0 0 6px #facc15",
                pointerEvents: "none",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
