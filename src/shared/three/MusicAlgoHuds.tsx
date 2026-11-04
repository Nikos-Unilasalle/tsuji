import { useEffect, useRef, useState, type ReactNode } from "react";
import { HUD_PANEL_STYLE, HudSeparator } from "./HudToolbars";
import type { NodeInstance } from "../graph/types";
import type { PatternPlayhead } from "./PatternHud";
import type { PreviewSound } from "../music/engine/description";
import { euclid } from "../music/seq/generators";
import { PITCH_CLASSES } from "../music/seq/scales";
import { Sequence, notesSoundingAt, stepAt } from "../music/seq/sequencer";
import { TUNING_SYSTEM_NAMES, tunedPitch } from "../music/seq/tuning";
import { tuningOf } from "../graph/nodes/musicAlgo";

/**
 * The palettes of two algorithmic music nodes in the 3D view (see musicAlgo.ts):
 *
 * - Euclid: its rhythm as a necklace — one bead per step, the hits joined into a polygon, the step playing lit. Pulses,
 *   steps and rotation by buttons; a click on a bead turns the rhythm so its first hit lands there; the wheel over the
 *   ring rotates it.
 * - Tuning: one period of the system as a circle, 12-TET's notes as grey ticks behind it, each key's distance from
 *   12-TET in cents, the notes sounding lit. A click on a pitch auditions it on the voice downstream; "Play scale"
 *   walks the period up.
 *
 * Every edit writes the node's params in one undo step.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const ACCENT = "#d946ef"; // the Music category
const RATE = 48_000;

export function useLive<T>(read: () => T): T {
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

/** The song sample under the playhead, or −1 before the song's start. */
export function songSample(readPlayhead: () => PatternPlayhead, startFrame: number): number {
  const { frame, fps } = readPlayhead();
  const t = (frame - startFrame) / Math.max(1, fps);
  return t < 0 ? -1 : Math.round(t * RATE);
}

export function Panel({ title, status, children }: { title: string; status: ReactNode; children: ReactNode }) {
  return (
    <div
      className="viewport-gp-hud music-hud-scroll"
      style={{
        ...HUD_PANEL_STYLE,
        border: "1px solid rgba(217, 70, 239, 0.45)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(217, 70, 239, 0.15)",
        position: "absolute",
        bottom: 62,
        left: 134,
        right: 12,
        marginLeft: "auto",
        marginRight: "auto",
        width: "max-content",
        maxWidth: "calc(100% - 146px)",
        // A narrow view: the controls wrap under the ring, and the panel scrolls rather than leaving the view.
        maxHeight: "calc(100% - 120px)",
        overflowY: "auto",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
        <span style={{ fontWeight: 600, fontSize: 12, color: ACCENT }}>{title}</span>
        <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>{status}</span>
      </div>
      {children}
    </div>
  );
}

export function HudButton({ label, title, onClick, disabled = false, active = false }: { label: string; title: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      type="button"
      className={`viewport-hud-button${active ? " viewport-hud-button-active" : ""}`}
      style={{ width: "auto", minWidth: 24, padding: "0 7px" }}
      title={title}
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** A number with − and + on either side. */
export function Stepper({ label, value, title, onChange, min, max, wired }: { label: string; value: number; title: string; onChange: (v: number) => void; min: number; max: number; wired?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "#94a3b8" }} title={wired ? `${title} — wired: the wire wins` : title}>
      {label}
      <HudButton label="−" title={`Less (${label})`} onClick={() => onChange(value - 1)} disabled={value <= min} />
      <span style={{ color: wired ? "#64748b" : "#fff", minWidth: 20, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{wired ? "~" : value}</span>
      <HudButton label="+" title={`More (${label})`} onClick={() => onChange(value + 1)} disabled={value >= max} />
    </span>
  );
}

const SELECT_STYLE = { background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "1px 4px", fontSize: 11 } as const;

// ── Euclid ─────────────────────────────────────────────────────────────────

/** Toussaint's catalogue ("The Euclidean algorithm generates traditional musical rhythms", 2005), a few of them. */
const NAMED_RHYTHMS: Record<string, string> = {
  "2,3": "shuffle",
  "2,5": "khafif-e-ramal (Persia)",
  "3,4": "cumbia",
  "3,5": "York-Samai (Arab)",
  "3,7": "ruchenitza (Bulgaria)",
  "3,8": "tresillo (Cuba)",
  "4,7": "ruchenitza (Bulgaria)",
  "4,9": "aksak (Turkey)",
  "4,11": "Frank Zappa's Outside Now",
  "4,12": "fandango",
  "5,6": "York-Samai (Arab)",
  "5,7": "Nawakhat (Arab)",
  "5,8": "cinquillo (Cuba)",
  "5,9": "Arab rhythm",
  "5,11": "Moussorgsky's Pictures",
  "5,12": "Venda clapping (South Africa)",
  "5,16": "bossa nova",
  "7,8": "Tuareg bendir",
  "7,12": "West African bell",
  "7,16": "samba (Brazil)",
  "9,16": "Central African bell",
  "11,24": "Aka Pygmies",
  "13,24": "Aka Pygmies",
};

export function EuclidHud({
  node,
  wired,
  restrike,
  readSequence,
  readPlayhead,
  startFrame,
  onParams,
}: {
  node: NodeInstance;
  /** The inputs that have a wire in: the wire wins over the param, so the HUD shows it as such. */
  wired: Set<string>;
  /** A sequence (not a clock) is wired in: its notes are struck on the hits. */
  restrike: boolean;
  readSequence: () => Sequence | null;
  readPlayhead: () => PatternPlayhead;
  startFrame: number;
  onParams: OnParams;
}) {
  const p = node.params;
  const n = Math.max(1, Math.min(64, Math.round(Number(p.steps) || 8)));
  const k = Math.max(0, Math.min(n, Math.round(Number(p.pulses) || 0)));
  const r = Math.round(Number(p.rotation) || 0);
  const hits = euclid(k, n, r);
  const set = (params: Record<string, unknown>) => onParams(params, node.id);

  const current = useLive(() => {
    const seq = readSequence();
    const t = songSample(readPlayhead, startFrame);
    if (!seq || t < 0) return -1;
    return stepAt(seq.clock, RATE, t) % n;
  });

  const size = 190;
  const c = size / 2;
  const R = c - 16;
  const at = (i: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [c + R * Math.cos(a), c + R * Math.sin(a)] as const;
  };
  const bead = Math.max(4, Math.min(10, (Math.PI * R) / n - 2));
  const polygon = hits.map((h, i) => (h ? at(i).join(",") : null)).filter(Boolean).join(" ");
  const name = NAMED_RHYTHMS[`${k},${n}`];

  return (
    <Panel title="Euclid" status={`E(${k},${n})${r ? ` · rotated ${((r % n) + n) % n}` : ""}${name ? ` · ${name}` : ""}`}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <svg
          width={size}
          height={size}
          style={{ display: "block", flexShrink: 0 }}
          onWheel={(e) => {
            e.stopPropagation();
            set({ rotation: r + (e.deltaY > 0 ? 1 : -1) });
          }}
        >
          <circle cx={c} cy={c} r={R} fill="none" stroke="rgba(255,255,255,0.12)" />
          {k >= 2 && <polygon points={polygon} fill="rgba(217, 70, 239, 0.12)" stroke="rgba(217, 70, 239, 0.6)" strokeWidth={1.5} />}
          {hits.map((h, i) => {
            const [x, y] = at(i);
            const playing = i === current;
            return (
              <circle
                key={i}
                cx={x}
                cy={y}
                r={playing ? bead + 2 : bead}
                fill={h ? (playing ? "#fff" : ACCENT) : playing ? "rgba(255,255,255,0.45)" : "rgba(15, 23, 42, 0.9)"}
                stroke={i === 0 ? "#fff" : h ? ACCENT : "rgba(255,255,255,0.3)"}
                strokeWidth={i === 0 ? 2 : 1}
                style={{ cursor: "pointer", filter: playing && h ? `drop-shadow(0 0 6px ${ACCENT})` : undefined }}
                onClick={() => set({ rotation: i })}
              >
                <title>{`Step ${i + 1}${h ? " · hit" : ""} — click: the first hit lands here`}</title>
              </circle>
            );
          })}
          <text x={c} y={c - 2} textAnchor="middle" fill="#fff" fontSize={18} fontWeight={700}>{`${k} / ${n}`}</text>
          <text x={c} y={c + 16} textAnchor="middle" fill="#94a3b8" fontSize={10}>
            {hits.map((h) => (h ? "x" : "·")).join("").slice(0, 24)}
          </text>
        </svg>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Stepper label="Pulses" title="Hits in the loop" value={k} min={0} max={n} wired={wired.has("pulses")} onChange={(v) => set({ pulses: v })} />
          <Stepper label="Steps" title="The loop's length — against a 16-step bar, 5 or 7 make a polymeter" value={n} min={1} max={64} wired={wired.has("steps")} onChange={(v) => set({ steps: v, pulses: Math.min(k, v) })} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "#94a3b8" }}>
            Rotation
            <HudButton label="◀" title="Turn the rhythm a step earlier (wheel over the ring)" onClick={() => set({ rotation: r - 1 })} />
            <span style={{ color: wired.has("rotation") ? "#64748b" : "#fff", minWidth: 20, textAlign: "center" }}>{wired.has("rotation") ? "~" : ((r % n) + n) % n}</span>
            <HudButton label="▶" title="Turn the rhythm a step later" onClick={() => set({ rotation: r + 1 })} />
          </span>
          <HudSeparator />
          <span style={{ fontSize: 10, color: "#64748b", maxWidth: 220 }}>
            {restrike ? "Restriking the wired sequence's notes" : `Notes: ${String(p.notes ?? "C4") || "C4"}`}
            <br />
            Click a bead: the first hit lands there · wheel: rotate
          </span>
        </div>
      </div>
    </Panel>
  );
}

// ── Tuning ─────────────────────────────────────────────────────────────────

const signed = (c: number) => `${c > 0.05 ? "+" : c < -0.05 ? "−" : "±"}${Math.abs(c).toFixed(Math.abs(c) < 10 ? 1 : 0)}`;

export function TuningHud({
  node,
  readSequence,
  readPlayhead,
  startFrame,
  previewSound,
  onParams,
  onPreview,
}: {
  node: NodeInstance;
  readSequence: () => Sequence | null;
  readPlayhead: () => PatternPlayhead;
  startFrame: number;
  /** The voice downstream, to audition a pitch on; null: no audition. */
  previewSound: PreviewSound | null;
  onParams: OnParams;
  onPreview: (sound: PreviewSound, note: number, velocity: number) => void;
}) {
  const p = node.params;
  const t = tuningOf(p);
  const set = (params: Record<string, unknown>) => onParams(params, node.id);
  const n = t.steps.length;
  const rootName = PITCH_CLASSES[t.root - 60] ?? "C";
  const offset = (t.offset ?? 0) / 100;
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => clearTimeout(id)), []);

  const sounding = useLive(() => {
    const seq = readSequence();
    const s = songSample(readPlayhead, startFrame);
    if (!seq || s < 0) return [] as number[];
    return [...new Set(notesSoundingAt(seq, RATE, s).map((e) => e.note))];
  });

  const size = 190;
  const c = size / 2;
  const R = c - 26;
  /** Angle of a pitch given in cents above the root, one period a full turn. */
  const point = (cents: number, radius = R) => {
    const a = -Math.PI / 2 + ((((cents % t.period) + t.period) % t.period) / t.period) * Math.PI * 2;
    return [c + radius * Math.cos(a), c + radius * Math.sin(a)] as const;
  };
  const audition = (cents: number) => previewSound && onPreview(previewSound, t.root + cents / 100 + offset, 0.8);
  const playScale = () => {
    if (!previewSound) return;
    timers.current.forEach((id) => clearTimeout(id));
    timers.current = [...t.steps, t.period].map((cents, i) => window.setTimeout(() => audition(cents), i * 260));
  };

  // What each of the twelve keys sounds at, in cents off its 12-TET pitch (retune); or which key plays each step.
  const keys =
    t.map === "retune"
      ? PITCH_CLASSES.map((_, i) => {
          const key = t.root + i;
          return { label: PITCH_CLASSES[(t.root - 60 + i) % 12], dev: (tunedPitch(t, key) - key - offset) * 100 };
        })
      : [];
  const twelveTicks = Math.max(1, Math.round(t.period / 100));
  const system = String(p.system ?? "");

  return (
    <Panel title="Tuning" status={`${system === "EDO" ? `${Math.round(Number(p.edo) || 12)}-EDO` : system} · ${n} steps a ${t.period === 1200 ? "octave" : `period of ${t.period.toFixed(1)}¢`} · keys ${t.map === "retune" ? "retuned" : "as steps"}`}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <svg width={size} height={size} style={{ display: "block", flexShrink: 0 }}>
          <circle cx={c} cy={c} r={R} fill="none" stroke="rgba(255,255,255,0.12)" />
          {/* 12-TET, behind */}
          {Array.from({ length: twelveTicks }, (_, i) => {
            const [x1, y1] = point(i * 100, R - 9);
            const [x2, y2] = point(i * 100, R + 9);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(148,163,184,0.35)" strokeWidth={1} />;
          })}
          {/* The notes sounding now */}
          {sounding.map((note, i) => {
            const [x, y] = point((note - t.root) * 100);
            return <circle key={`s${i}`} cx={x} cy={y} r={11} fill="none" stroke="#fff" strokeWidth={2} style={{ filter: "drop-shadow(0 0 6px #fff)" }} />;
          })}
          {t.steps.map((cents, i) => {
            const [x, y] = point(cents);
            const [lx, ly] = point(cents, R + 18);
            const label = t.map === "retune" && n === 12 ? PITCH_CLASSES[(t.root - 60 + i) % 12] : String(i);
            return (
              <g key={i} style={{ cursor: previewSound ? "pointer" : "default" }} onClick={() => audition(cents)}>
                <title>{`Step ${i}: ${cents.toFixed(2)}¢${n <= 24 ? ` (${signed(cents - Math.round(cents / 100) * 100)}¢ from 12-TET)` : ""}${previewSound ? " — click to hear it" : ""}`}</title>
                <circle cx={x} cy={y} r={n > 31 ? 3 : 6} fill={i === 0 ? "#fff" : ACCENT} stroke="rgba(15,23,42,0.9)" />
                {n <= 24 && (
                  <text x={lx} y={ly + 3} textAnchor="middle" fill="#cbd5e1" fontSize={9}>
                    {label}
                  </text>
                )}
              </g>
            );
          })}
          <text x={c} y={c - 2} textAnchor="middle" fill="#fff" fontSize={16} fontWeight={700}>
            {rootName}
          </text>
          <text x={c} y={c + 14} textAnchor="middle" fill="#94a3b8" fontSize={10}>
            {t.offset ? `${signed(t.offset)}¢` : "root at its pitch"}
          </text>
        </svg>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8" }}>
            System
            <select style={SELECT_STYLE} value={system} onChange={(e) => set({ system: e.target.value })} onKeyDown={(e) => e.stopPropagation()}>
              {TUNING_SYSTEM_NAMES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {system === "EDO" && <Stepper label="" title="Steps per octave" value={Math.round(Number(p.edo) || 12)} min={1} max={311} onChange={(v) => set({ edo: v })} />}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8" }}>
            Root
            <select style={SELECT_STYLE} value={rootName} onChange={(e) => set({ root: e.target.value })} onKeyDown={(e) => e.stopPropagation()}>
              {PITCH_CLASSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8" }}>
            Keys
            <HudButton label="Auto" title="12 steps an octave: retune; otherwise steps" active={(p.map ?? "auto") === "auto"} onClick={() => set({ map: "auto" })} />
            <HudButton label="Retune" title="The twelve keys keep their names, each moved to its pitch in the system" active={p.map === "retune"} onClick={() => set({ map: "retune" })} />
            <HudButton label="Steps" title="Each key is the next step of the system" active={p.map === "steps"} onClick={() => set({ map: "steps" })} />
          </div>
          {keys.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 44px)", gap: 3 }}>
              {keys.map((k, i) => {
                const hue = k.dev > 0.5 ? 25 : k.dev < -0.5 ? 200 : 0;
                return (
                  <div
                    key={i}
                    title={`${k.label}: ${signed(k.dev)} cents from 12-TET${previewSound ? " — click to hear it" : ""}`}
                    onClick={() => audition(i * 100 + k.dev)}
                    style={{
                      borderRadius: 4,
                      padding: "2px 0",
                      textAlign: "center",
                      cursor: previewSound ? "pointer" : "default",
                      background: hue ? `hsla(${hue}, 70%, 50%, ${Math.min(0.6, 0.12 + Math.abs(k.dev) / 40)})` : "rgba(255,255,255,0.06)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <div style={{ fontSize: 11, color: "#fff", fontWeight: 600 }}>{k.label}</div>
                    <div style={{ fontSize: 9, color: "#cbd5e1" }}>{signed(k.dev)}</div>
                  </div>
                );
              })}
            </div>
          )}
          {keys.length === 0 && (
            <span style={{ fontSize: 10, color: "#94a3b8", maxWidth: 280 }}>
              Each key is one step: {rootName}4 is step 0, the next key step 1… {n} keys make a {t.period === 1200 ? "octave" : "period"}.
            </span>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <HudButton label="▶ Play scale" title={previewSound ? "Hear one period, step by step, on the voice downstream" : "Wire the Tuning into a voice to hear it"} onClick={playScale} disabled={!previewSound} />
            <HudSeparator />
            <span style={{ fontSize: 10, color: "#64748b" }}>{previewSound ? "click a pitch to hear it" : "wire into a voice to hear pitches"}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
