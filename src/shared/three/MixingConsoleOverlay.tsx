import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Graph, KeyframeStore, NodeInstance } from "../graph/types";
import { evaluateKeyframeValue } from "../graph/evaluate";
import { musicAnalysersOf, musicMetersOf } from "../music/engine/bridge";
import type { EngineMeters } from "../music/engine/engine.worklet";
import { notesSoundingAt } from "../music/seq/sequencer";
import { noteName } from "../music/seq/notation";
import { viewerForm } from "../music/viewer/fromGraph";
import { FADER_MARKS, barBeat, clockLabel, consoleStrips, dbLabel, dbOf, faderLevel, faderTravel, panLabel, type ConsoleStrip, type StripParam } from "../music/console/strips";
import { AUTOMATABLE, clearAutomation, isAutomated, writeAutomation } from "../music/console/automation";
import { HUD_PANEL_STYLE } from "./HudToolbars";
import "./mixingConsole.css";

/**
 * A shown Mixing Console over the 3D view, in the music HUDs' style: one channel strip per track Music Out mixes, and
 * a master section with the meters, the analysis (spectrum, phase scope, R128 loudness), the send returns and the
 * master fader. Every control writes its param on the voice (or Music Out) through `onParams`, so a move is an edit
 * like any other (one undo step per gesture: App coalesces a param's changes) — or, while automation writes, keyframes
 * (see music/console/automation.ts). The meters are the engine's own (bridge.ts), drawn in one animation loop that
 * never re-renders React.
 */

type Results = { get(id: string): Record<string, unknown> | undefined } | null | undefined;

/** The music HUDs' colours: the category's magenta, the voices' own, and the slate greys. */
const C = {
  accent: "#d946ef",
  sky: "#38bdf8",
  green: "#84cc16",
  amber: "#f59e0b",
  red: "#ef4444",
  text: "#cbd5e1",
  muted: "#94a3b8",
  dim: "#64748b",
  track: "rgba(255,255,255,0.08)",
  grid: "rgba(255,255,255,0.06)",
};
const KIND_COLORS: Record<ConsoleStrip["kind"], string> = { FM: C.accent, GB: C.green, DRUM: C.amber, SID: C.sky };

const RATE = 48_000;
/** The meters' scale, in dBFS. */
const METER_LO = -60;
const METER_HI = 6;
/** dB a meter falls per second, and how long a peak holds. */
const FALL_DB = 26;
const HOLD_MS = 1400;
const HISTORY = 48;

interface StripLive {
  meter: HTMLCanvasElement | null;
  spark: HTMLCanvasElement | null;
  notes: HTMLSpanElement | null;
  disp: number;
  hold: number;
  holdAt: number;
  hist: Float32Array;
  histAt: number;
}

const newLive = (): StripLive => ({ meter: null, spark: null, notes: null, disp: -Infinity, hold: -Infinity, holdAt: 0, hist: new Float32Array(HISTORY), histAt: 0 });

/** A canvas sized to its box, in device pixels; returns the context and the size. */
function fit(canvas: HTMLCanvasElement): [CanvasRenderingContext2D | null, number, number, number] {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return [canvas.getContext("2d"), w, h, dpr];
}

const meterAt = (db: number) => Math.max(0, Math.min(1, (db - METER_LO) / (METER_HI - METER_LO)));

/** Level bars, bottom to top, one per column (a stereo pair draws two): green, amber from −9 dB, red over 0 dB. */
function drawMeter(canvas: HTMLCanvasElement, levels: number[], holds: number[]): void {
  const [ctx, w, h, dpr] = fit(canvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const cols = levels.length;
  const gap = 2 * dpr;
  const cw = (w - gap * (cols - 1)) / cols;
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, C.green);
  grad.addColorStop(meterAt(-9), C.green);
  grad.addColorStop(meterAt(-3), C.amber);
  grad.addColorStop(meterAt(0), C.red);
  grad.addColorStop(1, C.red);
  for (let c = 0; c < cols; c++) {
    const x = c * (cw + gap);
    ctx.fillStyle = C.track;
    ctx.beginPath();
    ctx.roundRect(x, 0, cw, h, cw / 2);
    ctx.fill();
    const lh = meterAt(levels[c]) * h;
    if (lh > 0) {
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, h - lh, cw, lh, Math.min(cw / 2, lh / 2));
      ctx.fill();
    }
    const hy = h - meterAt(holds[c]) * h;
    if (Number.isFinite(holds[c]) && holds[c] > METER_LO) {
      ctx.fillStyle = holds[c] > 0 ? C.red : "rgba(255,255,255,0.85)";
      ctx.fillRect(x, Math.max(0, hy - dpr), cw, 2 * dpr);
    }
  }
}

/** The last seconds of a channel's level, as a line in its colour. */
function drawSpark(canvas: HTMLCanvasElement, live: StripLive, color: string): void {
  const [ctx, w, h, dpr] = fit(canvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  for (let i = 0; i < HISTORY; i++) {
    const v = live.hist[(live.histAt + i) % HISTORY];
    const x = (i / (HISTORY - 1)) * w;
    const y = h - dpr - Math.max(0, Math.min(1, v)) * (h - 2 * dpr);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25 * dpr;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ── Analysis: spectrum, phase scope, loudness ─────────────────────────────

/** The analyser's bands: log-spaced from 25 Hz to 18 kHz. */
const BANDS = 48;
const F_LO = 25;
const F_HI = 18_000;
const BAND_EDGES = Array.from({ length: BANDS + 1 }, (_, i) => F_LO * (F_HI / F_LO) ** (i / BANDS));
const SPEC_LO = -100;
const SPEC_HI = -10;

/** Each band's level in dB from the two sides' spectra (the analysers' dB per bin), the louder bin of the band. */
function bandLevels(left: Float32Array, right: Float32Array, sampleRate: number, out: Float32Array): void {
  const binHz = sampleRate / (left.length * 2);
  for (let b = 0; b < BANDS; b++) {
    let lo = Math.floor(BAND_EDGES[b] / binHz);
    let hi = Math.ceil(BAND_EDGES[b + 1] / binHz);
    lo = Math.max(1, Math.min(left.length - 1, lo));
    hi = Math.max(lo + 1, Math.min(left.length, hi));
    let best = -Infinity;
    for (let k = lo; k < hi; k++) {
      const db = 10 * Math.log10((10 ** (left[k] / 10) + 10 ** (right[k] / 10)) / 2);
      if (db > best) best = db;
    }
    out[b] = best;
  }
}

function drawSpectrum(canvas: HTMLCanvasElement, levels: Float32Array, peaks: Float32Array): void {
  const [ctx, w, h, dpr] = fit(canvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const labelH = 12 * dpr;
  const gh = h - labelH;
  const at = (db: number) => Math.max(0, Math.min(1, (db - SPEC_LO) / (SPEC_HI - SPEC_LO))) * gh;
  // Grid: every 20 dB.
  ctx.fillStyle = C.grid;
  for (let db = -80; db <= -20; db += 20) ctx.fillRect(0, gh - at(db), w, dpr);
  const bw = w / BANDS;
  const grad = ctx.createLinearGradient(0, gh, 0, 0);
  grad.addColorStop(0, C.sky);
  grad.addColorStop(1, C.accent);
  for (let b = 0; b < BANDS; b++) {
    const x = b * bw + dpr;
    const bh = at(levels[b]);
    if (bh > 0) {
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, gh - bh, bw - 2 * dpr, bh, Math.min((bw - 2 * dpr) / 2, 2 * dpr));
      ctx.fill();
    }
    const ph = at(peaks[b]);
    if (ph > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillRect(x, gh - ph - dpr, bw - 2 * dpr, 1.5 * dpr);
    }
  }
  ctx.fillStyle = C.dim;
  ctx.font = `${Math.round(9 * dpr)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const [hz, label] of [
    [50, "50"],
    [100, "100"],
    [250, "250"],
    [500, "500"],
    [1000, "1k"],
    [2500, "2.5k"],
    [5000, "5k"],
    [10000, "10k"],
  ] as const) {
    ctx.fillText(label, (Math.log(hz / F_LO) / Math.log(F_HI / F_LO)) * w, h);
  }
}

/**
 * The phase scope: left against right turned 45°, so mono stands up straight and out-of-phase lies flat; the dots
 * fade over a few frames. Returns the correlation (−1 … 1) of the window it drew.
 */
function drawScope(canvas: HTMLCanvasElement, left: Float32Array, right: Float32Array, gain: number): number {
  const [ctx, w, h, dpr] = fit(canvas);
  if (!ctx) return 0;
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.47;
  ctx.strokeStyle = C.track;
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.stroke();
  ctx.fillStyle = C.dim;
  ctx.font = `${Math.round(9 * dpr)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("M", cx + 7 * dpr, 2 * dpr);
  ctx.fillText("L", 7 * dpr, 4 * dpr);
  ctx.fillText("R", w - 7 * dpr, 4 * dpr);
  ctx.fillStyle = C.sky;
  ctx.globalAlpha = 0.55;
  let lr = 0;
  let ll = 0;
  let rr = 0;
  const k = r * gain * Math.SQRT1_2;
  const size = 1.3 * dpr;
  for (let i = 0; i < left.length; i += 2) {
    const l = left[i];
    const rt = right[i];
    lr += l * rt;
    ll += l * l;
    rr += rt * rt;
    ctx.fillRect(cx + (rt - l) * k, cy - (l + rt) * k, size, size);
  }
  ctx.globalAlpha = 1;
  return ll > 1e-9 && rr > 1e-9 ? lr / Math.sqrt(ll * rr) : 0;
}

/** A thin horizontal gauge: the correlation (from its centre), or the loudness against its targets. */
function drawGauge(canvas: HTMLCanvasElement, value: number, lo: number, hi: number, marks: readonly number[], color: string, centred = false): void {
  const [ctx, w, h, dpr] = fit(canvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const at = (v: number) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * w;
  ctx.fillStyle = C.track;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, h / 2);
  ctx.fill();
  if (Number.isFinite(value)) {
    const x0 = centred ? at(0) : 0;
    const x = at(value);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(Math.min(x0, x), 0, Math.max(h, Math.abs(x - x0)), h, h / 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  for (const m of marks) ctx.fillRect(at(m) - dpr / 2, 0, dpr, h);
}

const lufsLabel = (v: number) => (Number.isFinite(v) && v > -99 ? v.toFixed(1) : "—");

// ── Controls ───────────────────────────────────────────────────────────────

/** Vertical drag on a control: `onMove` with the pixels moved (up is positive); Shift for fine moves. */
function dragHandler(onStart: () => number, onMove: (start: number, dy: number, fine: boolean) => void, onEnd?: () => void) {
  return (e: ReactPointerEvent<Element>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser does not track (a synthetic one): the drag still works while over the control.
    }
    const y0 = e.clientY;
    const start = onStart();
    const move = (ev: PointerEvent) => onMove(start, y0 - ev.clientY, ev.shiftKey);
    const up = () => {
      onEnd?.();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
}

/** An arc of a circle centred on 0,0, from angle a to b (degrees, 0 at the top, clockwise). */
function arc(r: number, a: number, b: number): string {
  const p = (deg: number) => [Math.sin((deg * Math.PI) / 180) * r, -Math.cos((deg * Math.PI) / 180) * r];
  const [x0, y0] = p(a);
  const [x1, y1] = p(b);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${Math.abs(b - a) > 180 ? 1 : 0} ${b > a ? 1 : 0} ${x1} ${y1}`;
}

function Knob({
  label,
  value,
  min,
  max,
  reset,
  color,
  bipolar = false,
  locked = false,
  readout,
  onChange,
  onGrab,
  onRelease,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  reset: number;
  color: string;
  bipolar?: boolean;
  locked?: boolean;
  readout: string;
  onChange: (v: number) => void;
  /** A gesture starts and ends (automation writes for as long as the control is held). */
  onGrab?: () => void;
  onRelease?: () => void;
}) {
  const t = (Math.min(max, Math.max(min, value)) - min) / (max - min);
  const angle = -135 + t * 270;
  const from = bipolar ? 0 : -135;
  return (
    <div className={`mx-knob${locked ? " mx-locked" : ""}`} title={`${label}: ${readout}${locked ? " — driven by a wire" : " — drag, Shift for fine, double-click to reset"}`}>
      <svg
        viewBox="-16 -16 32 32"
        onPointerDown={
          locked
            ? undefined
            : dragHandler(
                () => (onGrab?.(), value),
                (start, dy, fine) => onChange(Math.min(max, Math.max(min, start + (dy / (fine ? 600 : 140)) * (max - min)))),
                onRelease,
              )
        }
        onDoubleClick={locked ? undefined : () => onChange(reset)}
      >
        <path d={arc(12, -135, 135)} className="mx-knob-track" />
        {Math.abs(angle - from) > 0.5 && <path d={angle > from ? arc(12, from, angle) : arc(12, angle, from)} className="mx-knob-value" style={{ stroke: color }} />}
        <circle r={7.5} className="mx-knob-cap" />
        <line x1={0} y1={-3} x2={0} y2={-7} className="mx-knob-line" transform={`rotate(${angle})`} />
      </svg>
      <span className="mx-knob-label">{label}</span>
    </div>
  );
}

function Fader({
  level,
  locked,
  reset,
  color,
  onChange,
  onGrab,
  onRelease,
}: {
  level: number;
  locked: boolean;
  reset: number;
  color: string;
  onChange: (level: number) => void;
  onGrab?: () => void;
  onRelease?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const travel = faderTravel(level);
  const THUMB = 12;
  const span = () => Math.max(1, (trackRef.current?.clientHeight ?? 160) - THUMB);
  const pos = (t: number) => `calc(${t} * (100% - ${THUMB}px))`;
  return (
    <div
      ref={trackRef}
      className={`mx-fader${locked ? " mx-locked" : ""}`}
      title={locked ? "Level — driven by a wire" : "Drag (Shift: fine), click the track to jump, double-click for the default"}
      onPointerDown={
        locked
          ? undefined
          : (e) => {
              // A click on the track jumps the thumb there, then drags from it.
              const rect = trackRef.current!.getBoundingClientRect();
              const onThumb = (e.target as HTMLElement).classList.contains("mx-fader-thumb");
              const startTravel = onThumb ? travel : Math.min(1, Math.max(0, (rect.bottom - THUMB / 2 - e.clientY) / span()));
              onGrab?.();
              if (!onThumb) onChange(faderLevel(startTravel));
              dragHandler(
                () => startTravel,
                (start, dy, fine) => onChange(faderLevel(Math.min(1, Math.max(0, start + (dy / span()) * (fine ? 0.2 : 1))))),
                onRelease,
              )(e);
            }
      }
      onDoubleClick={locked ? undefined : () => onChange(reset)}
    >
      {FADER_MARKS.map((m) => (
        <div key={m.db} className={`mx-fader-mark${m.db === 0 ? " mx-unity" : ""}`} style={{ bottom: `calc(${THUMB / 2}px + ${m.travel} * (100% - ${THUMB}px))` }} />
      ))}
      <div className="mx-fader-track" />
      <div className="mx-fader-fill" style={{ height: `calc(${THUMB / 2}px + ${pos(travel)})`, background: color }} />
      <div className="mx-fader-thumb" style={{ bottom: pos(travel) }} />
    </div>
  );
}

function Toggle({ on, kind, label, locked = false, onClick, title }: { on: boolean; kind: "solo" | "mute"; label: string; locked?: boolean; onClick?: () => void; title: string }) {
  return (
    <button
      type="button"
      className={`mx-toggle mx-${kind}${on ? " mx-on" : ""}${locked ? " mx-locked" : ""}`}
      title={title}
      onPointerDown={(e) => e.preventDefault()}
      onClick={locked ? undefined : onClick}
    >
      {label}
    </button>
  );
}

/** What a strip draws from the evaluation (not the node's params): when it changes, React draws the strips again. */
const keyOf = (strips: ConsoleStrip[]) => strips.map((s) => `${s.trackId}:${s.name}:${s.desc.mute}:${s.desc.solo === true}:${[...s.wired].join(",")}`).join("|");

// ── The console ────────────────────────────────────────────────────────────

export function MixingConsoleOverlay({
  node,
  graph,
  readResults,
  readTime,
  readFrame,
  canAutomate,
  onKeyframes,
  onParams,
  onHide,
}: {
  node: NodeInstance;
  graph: Graph;
  readResults: () => Results;
  /** Seconds into the song (negative before it starts). */
  readTime: () => number;
  /** The playhead's frame: automation is written there. */
  readFrame: () => number;
  /** False without a timeline (no Render node): nothing to write automation on. */
  canAutomate: boolean;
  onKeyframes: (edit: (store: KeyframeStore) => KeyframeStore, coalesceKey?: string) => void;
  onParams: (params: Record<string, unknown>, nodeId: string) => void;
  onHide: () => void;
}) {
  const [, setRefresh] = useState(0);
  const [full, setFull] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { out, strips } = consoleStrips(graph, readResults());
  const stripKey = keyOf(strips);

  // Everything the animation loop reads, current on every render.
  const liveRef = useRef(new Map<string, StripLive>());
  const masterRef = useRef({
    meter: null as HTMLCanvasElement | null,
    clip: null as HTMLSpanElement | null,
    playing: null as HTMLSpanElement | null,
    position: null as HTMLSpanElement | null,
    time: null as HTMLSpanElement | null,
    section: null as HTMLSpanElement | null,
    spectrum: null as HTMLCanvasElement | null,
    scope: null as HTMLCanvasElement | null,
    corr: null as HTMLCanvasElement | null,
    lufsBar: null as HTMLCanvasElement | null,
    lufsM: null as HTMLSpanElement | null,
    lufsS: null as HTMLSpanElement | null,
    lufsI: null as HTMLSpanElement | null,
  });
  const armed = canAutomate && node.params.autoArm === true;
  const frame = Math.max(0, readFrame());
  /** The control held right now, while automation writes: each frame the playhead reaches gets its value. */
  const heldRef = useRef<{ nodeId: string; param: string; value: unknown; since: number | null; before: unknown } | null>(null);
  const write = (nodeId: string, param: string, value: unknown, before: unknown) => {
    const f = Math.max(0, Math.round(readFrame()));
    const h = heldRef.current && heldRef.current.nodeId === nodeId && heldRef.current.param === param ? heldRef.current : null;
    const since = h?.since ?? null;
    const was = h ? h.before : before;
    onKeyframes((store) => writeAutomation(store, { nodeId, param, frame: f, value, since, before: was }), `automation:${nodeId}:${param}`);
    if (h) {
      h.since = f;
      h.value = value;
    }
  };
  const automates = (nodeId: string, param: string) => canAutomate && (armed || isAutomated(graph.keyframes, nodeId, param));
  const stateRef = useRef({ strips, out, graph, stripKey, readResults, readTime, readFrame, armed, write });
  stateRef.current = { strips, out, graph, stripKey, readResults, readTime, readFrame, armed, write };

  useEffect(() => {
    let id = 0;
    let last = performance.now();
    let lastMeters: EngineMeters | null = null;
    let metersAt = 0;
    let slowAt = 0;
    let specL = new Float32Array(1024);
    let specR = new Float32Array(1024);
    let waveL = new Float32Array(2048);
    let waveR = new Float32Array(2048);
    const bands = new Float32Array(BANDS).fill(SPEC_LO);
    const peaks = new Float32Array(BANDS).fill(SPEC_LO);
    const peakAt = new Float64Array(BANDS);
    const levels = new Float32Array(BANDS);
    let scopeGain = 1;
    let corr = 0;
    let autoKey = "";
    const m = { dispL: -Infinity, dispR: -Infinity, holdL: -Infinity, holdR: -Infinity, holdAtL: 0, holdAtR: 0, clipAt: -Infinity };
    const fall = (disp: number, now: number, dt: number) => Math.max(now, (Number.isFinite(disp) ? disp : METER_LO) - FALL_DB * dt);
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const st = stateRef.current;
      const results = st.readResults();
      const meters = st.out ? musicMetersOf(st.out.id) : null;
      if (meters && meters !== lastMeters) {
        lastMeters = meters;
        metersAt = now;
      }
      const fresh = meters && now - metersAt < 300 ? meters : null;
      const outResult = st.out ? results?.get(st.out.id) : undefined;
      const playing = outResult?.playing === 1;
      const t = st.readTime();
      const slow = now - slowAt > 66;
      if (slow) slowAt = now;

      // A track appeared, or its evaluation caught up with an edit (a solo, a mute): draw the strips again.
      if (keyOf(consoleStrips(st.graph, results).strips) !== st.stripKey) setRefresh((n) => n + 1);

      // Automation: a held control keeps writing as the playhead moves; automated faders move on their own.
      const frameNow = Math.max(0, Math.round(st.readFrame()));
      const held = heldRef.current;
      if (held && st.armed && playing && held.since !== frameNow) st.write(held.nodeId, held.param, held.value, held.before);
      if (slow) {
        const store = st.graph.keyframes;
        const ids = [...st.strips.map((x) => x.node?.id), st.out?.id].filter((x): x is string => !!x);
        const key = store ? ids.map((nid) => (store[nid] ? `${nid}@${frameNow}` : "")).join(",") : "";
        if (key.replace(/@\d+/g, "").replace(/,/g, "") !== "" && key !== autoKey) setRefresh((n) => n + 1);
        autoKey = key;
      }

      for (const strip of st.strips) {
        let live = liveRef.current.get(strip.trackId);
        if (!live) liveRef.current.set(strip.trackId, (live = newLive()));
        const reading = fresh?.channels[strip.trackId];
        const peakDb = reading ? dbOf(reading[0]) : -Infinity;
        live.disp = fall(live.disp, peakDb, dt);
        if (peakDb >= live.hold || now - live.holdAt > HOLD_MS) {
          live.hold = peakDb;
          live.holdAt = now;
        }
        if (live.meter) drawMeter(live.meter, [live.disp], [live.hold]);
        if (slow) {
          live.hist[live.histAt] = Math.max(0, (dbOf(reading ? reading[1] : 0) + 60) / 60);
          live.histAt = (live.histAt + 1) % HISTORY;
          if (live.spark) drawSpark(live.spark, live, KIND_COLORS[strip.kind]);
          if (live.notes) {
            const sounding = playing && t >= 0 ? notesSoundingAt(strip.desc.seq, RATE, Math.round(t * RATE)) : [];
            live.notes.textContent =
              strip.kind === "DRUM"
                ? sounding.length
                  ? "●".repeat(Math.min(4, sounding.length))
                  : "·"
                : sounding
                    .slice(0, 2)
                    .map((e) => noteName(e.note))
                    .join(" ") || "·";
          }
        }
      }

      // The master's meter, by peak.
      const ms = masterRef.current;
      const [pl, pr] = fresh?.master ?? [0, 0];
      m.dispL = fall(m.dispL, dbOf(pl), dt);
      m.dispR = fall(m.dispR, dbOf(pr), dt);
      if (dbOf(pl) >= m.holdL || now - m.holdAtL > HOLD_MS) [m.holdL, m.holdAtL] = [dbOf(pl), now];
      if (dbOf(pr) >= m.holdR || now - m.holdAtR > HOLD_MS) [m.holdR, m.holdAtR] = [dbOf(pr), now];
      if ((fresh?.clipped ?? 0) > 0) m.clipAt = now;
      if (ms.meter) drawMeter(ms.meter, [m.dispL, m.dispR], [m.holdL, m.holdR]);
      ms.clip?.classList.toggle("mx-on", now - m.clipAt < 1500);
      ms.playing?.classList.toggle("mx-on", playing);

      // Spectrum and phase scope, from the analysers on the engine's output.
      const an = st.out ? musicAnalysersOf(st.out.id) : null;
      if (an) {
        if (specL.length !== an.left.frequencyBinCount) {
          specL = new Float32Array(an.left.frequencyBinCount);
          specR = new Float32Array(an.left.frequencyBinCount);
          waveL = new Float32Array(an.left.fftSize);
          waveR = new Float32Array(an.left.fftSize);
        }
        an.left.getFloatFrequencyData(specL);
        an.right.getFloatFrequencyData(specR);
        bandLevels(specL, specR, an.left.context.sampleRate, levels);
        an.left.getFloatTimeDomainData(waveL);
        an.right.getFloatTimeDomainData(waveR);
      } else levels.fill(-Infinity);
      for (let b = 0; b < BANDS; b++) {
        const v = Number.isFinite(levels[b]) ? levels[b] : SPEC_LO;
        bands[b] = Math.max(v, bands[b] - 60 * dt);
        if (v >= peaks[b]) {
          peaks[b] = v;
          peakAt[b] = now;
        } else if (now - peakAt[b] > 700) peaks[b] = Math.max(SPEC_LO, peaks[b] - 20 * dt);
      }
      if (ms.spectrum) drawSpectrum(ms.spectrum, bands, peaks);
      if (ms.scope) {
        // Auto-gain, slow: a quiet song still fills the scope.
        let pk = 0;
        for (let i = 0; i < waveL.length; i += 4) pk = Math.max(pk, Math.abs(waveL[i]), Math.abs(waveR[i]));
        const want = 0.9 / Math.max(0.05, pk);
        scopeGain += (Math.min(8, want) - scopeGain) * (want < scopeGain ? 0.3 : 0.02);
        const c = an ? drawScope(ms.scope, waveL, waveR, scopeGain) : 0;
        corr += (c - corr) * 0.15;
      }
      if (ms.corr) drawGauge(ms.corr, corr, -1, 1, [0], corr < 0 ? C.red : C.sky, true);
      const [lm, ls, li] = fresh?.lufs ?? [-Infinity, -Infinity, -Infinity];
      if (ms.lufsBar) drawGauge(ms.lufsBar, ls, -36, 0, [-23, -14], ls > -13 ? C.amber : C.accent);
      if (slow) {
        if (ms.lufsM) ms.lufsM.textContent = lufsLabel(lm);
        if (ms.lufsS) ms.lufsS.textContent = lufsLabel(ls);
        if (ms.lufsI) ms.lufsI.textContent = lufsLabel(li);
        const clock = st.strips[0]?.desc.seq.clock;
        const bb = barBeat(typeof outResult?.beat === "number" ? outResult.beat : -1);
        if (ms.position) ms.position.textContent = `${bb.bar}.${bb.beat}`;
        if (ms.time) ms.time.textContent = clockLabel(t);
        if (ms.section && clock) {
          const form = viewerForm(st.graph, clock.bpm, clock.stepsPerBeat);
          ms.section.textContent = form.find((f) => t >= f.from && t < f.to)?.letter ?? "—";
        }
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    const onFs = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFull(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);
  const toggleFull = () => {
    if (full) {
      setFull(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    } else {
      setFull(true);
      void wrapRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  /** A strip param's value: the evaluated one when a wire drives it, its automation at the playhead, else the node's. */
  const valueOf = (s: ConsoleStrip, key: StripParam): unknown => {
    if (!s.node || s.wired.has(key)) return s.desc[key];
    const own = s.node.params[key] ?? s.desc[key];
    return isAutomated(graph.keyframes, s.node.id, key) ? evaluateKeyframeValue(graph.keyframes, s.node.id, key, frame, own) : own;
  };
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || d);
  /** A control moved: automation when it writes or the param has some, else the param itself. */
  const setValue = (nodeId: string, key: string, value: unknown, current: unknown) => {
    if (automates(nodeId, key) && (AUTOMATABLE as readonly string[]).concat("master").includes(key)) write(nodeId, key, value, current);
    else onParams({ [key]: value }, nodeId);
  };
  const setStrip = (s: ConsoleStrip, key: StripParam, value: unknown) => s.node && setValue(s.node.id, key, value, valueOf(s, key));
  /** What a control's grab and release do: the gesture automation writes along. */
  const gesture = (nodeId: string | undefined, key: string, current: unknown) => ({
    onGrab: () => {
      if (nodeId) heldRef.current = { nodeId, param: key, value: current, since: null, before: current };
    },
    onRelease: () => {
      heldRef.current = null;
    },
  });
  const outWired = (socket: string) => !!out && graph.connections.some((c) => c.toNode === out.id && c.toSocket === socket);
  const outNum = (key: string, d: number) => {
    const own = num(out?.params[key], d);
    return out && isAutomated(graph.keyframes, out.id, key) ? num(evaluateKeyframeValue(graph.keyframes, out.id, key, frame, own), d) : own;
  };
  const outKnob = (key: string, label: string, d: number, max: number) => (
    <Knob
      label={label}
      value={outNum(key, d)}
      min={0}
      max={max}
      reset={d}
      color={C.accent}
      locked={!out}
      readout={outNum(key, d).toFixed(2)}
      onChange={(v) => out && onParams({ [key]: Math.round(v * 100) / 100 }, out.id)}
    />
  );
  const stripAutomated = (s: ConsoleStrip) => !!s.node && AUTOMATABLE.some((k) => isAutomated(graph.keyframes, s.node!.id, k));
  const anyAutomation = strips.some(stripAutomated) || (!!out && isAutomated(graph.keyframes, out.id, "master"));
  const soloing = strips.some((s) => s.desc.solo);
  const scale = Math.min(1.6, Math.max(0.6, Number(node.params.scale) || 1));
  const height = Math.min(1, Math.max(0.3, Number(node.params.height) || 1));
  const bpm = Math.round(strips[0]?.desc.seq.clock.bpm ?? 0);

  const panelStyle: CSSProperties = full
    ? { ...HUD_PANEL_STYLE, position: "fixed", inset: 0, zIndex: 10000, borderRadius: 0, background: "var(--chrome-surface, #0f172a)" }
    : {
        ...HUD_PANEL_STYLE,
        border: "1px solid rgba(217, 70, 239, 0.45)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(217, 70, 239, 0.15)",
        position: "absolute",
        left: 12,
        right: 12,
        bottom: 12,
        // Full height stops under the viewport's own toolbar, which stays usable.
        height: `calc(${height * 100}% - ${Math.round(12 + height * 50)}px)`,
        zIndex: 4,
      };

  return (
    <div ref={wrapRef} className="mx-panel" style={panelStyle} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="mx-zoom" style={{ zoom: scale }}>
        <div className="mx-header">
          <span className="mx-title">Mixing Console</span>
          <span className="mx-status">
            {strips.length} {strips.length === 1 ? "track" : "tracks"}
            {soloing && <span className="mx-solo-note"> · solo</span>}
            {bpm > 0 && ` · ${bpm} BPM`} · bar <span ref={(el) => void (masterRef.current.position = el)}>0.0</span> · section{" "}
            <span ref={(el) => void (masterRef.current.section = el)}>—</span> · <span ref={(el) => void (masterRef.current.time = el)}>00:00.00</span>
          </span>
          <span className="mx-dot" ref={(el) => void (masterRef.current.playing = el)} title="Playing" />
          <span className="mx-header-gap" />
          <button
            type="button"
            className={`viewport-hud-button mx-rec${armed ? " mx-on" : ""}`}
            disabled={!canAutomate}
            title={
              canAutomate
                ? armed
                  ? "Writing automation: hold a control while the song plays to record its moves. Click to stop."
                  : "Write automation: moves made while the song plays become keyframes"
                : "Automation needs a timeline: add a Render node"
            }
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onParams({ autoArm: !armed }, node.id)}
          >
            <span className="mx-rec-dot" /> Write
          </button>
          <span className={`mx-pill${anyAutomation ? " mx-on" : ""}`} title="Automation plays back: the automated controls move on their own">
            Read
          </span>
          <button type="button" className="viewport-hud-button mx-text-button" title={full ? "Leave full screen (Esc)" : "Full screen"} onClick={toggleFull}>
            {full ? "Exit full screen" : "⛶ Full screen"}
          </button>
          {!full && (
            <button type="button" className="viewport-hud-button mx-text-button" title="Hide the console (its node's Show)" onClick={onHide}>
              Hide
            </button>
          )}
        </div>

        <div className="mx-deck">
          <div className="mx-strips">
            {strips.length === 0 && <div className="mx-empty">Wire voices into a Music Out and press Play.</div>}
            {strips.map((s, i) => {
              const live = liveRef.current.get(s.trackId) ?? (liveRef.current.set(s.trackId, newLive()), liveRef.current.get(s.trackId)!);
              const color = KIND_COLORS[s.kind];
              const level = num(valueOf(s, "level"), 0.8);
              const pan = num(valueOf(s, "pan"), 0);
              const mute = Boolean(valueOf(s, "mute"));
              const solo = Boolean(valueOf(s, "solo"));
              const lock = (k: StripParam) => !s.node || s.wired.has(k);
              const dimmed = mute || (soloing && !s.desc.solo);
              const sendKnob = (key: "delaySend" | "reverbSend", label: string) => {
                const v = num(valueOf(s, key), 0);
                return (
                  <Knob
                    label={label}
                    value={v}
                    min={0}
                    max={1}
                    reset={0}
                    color={color}
                    locked={lock(key)}
                    readout={`${Math.round(v * 100)} %`}
                    onChange={(x) => setStrip(s, key, Math.round(x * 100) / 100)}
                    {...gesture(s.node?.id, key, v)}
                  />
                );
              };
              return (
                <div key={s.trackId} className={`mx-strip${dimmed ? " mx-dimmed" : ""}`} style={{ "--mx-color": color } as CSSProperties}>
                  <div className="mx-strip-head" title={s.node ? `${s.name} (${s.node.id})` : s.name}>
                    <span className="mx-strip-num">{i + 1}</span>
                    <span className="mx-kind">{s.kind}</span>
                    {stripAutomated(s) && (
                      <span
                        className={`mx-badge mx-auto${armed ? " mx-writing" : ""}`}
                        title={`Automated: ${AUTOMATABLE.filter((k) => isAutomated(graph.keyframes, s.node!.id, k)).join(", ")} — ⌥-click to clear this strip's automation`}
                        onClick={(e) => e.altKey && s.node && onKeyframes((store) => clearAutomation(store, s.node!.id), `automation-clear:${s.node.id}`)}
                      >
                        A
                      </span>
                    )}
                    {s.wired.size > 0 && (
                      <span className="mx-badge" title={`Driven by a wire: ${[...s.wired].join(", ")}`}>
                        ~
                      </span>
                    )}
                  </div>
                  <div className="mx-name">{s.name}</div>
                  <span className="mx-notes" ref={(el) => void (live.notes = el)}>
                    ·
                  </span>
                  <canvas className="mx-spark" ref={(el) => void (live.spark = el)} />
                  <div className="mx-knob-row">
                    {sendKnob("delaySend", "Dly")}
                    {sendKnob("reverbSend", "Rev")}
                  </div>
                  <Knob
                    label={panLabel(pan)}
                    value={pan}
                    min={-1}
                    max={1}
                    reset={0}
                    color={color}
                    bipolar
                    locked={lock("pan")}
                    readout={panLabel(pan)}
                    onChange={(v) => setStrip(s, "pan", Math.round(v * 100) / 100)}
                    {...gesture(s.node?.id, "pan", pan)}
                  />
                  <div className="mx-toggles">
                    <Toggle on={solo} kind="solo" label="S" locked={lock("solo")} title="Solo" onClick={() => s.node && onParams({ solo: !solo }, s.node.id)} />
                    <Toggle on={mute} kind="mute" label="M" locked={lock("mute")} title="Mute" onClick={() => setStrip(s, "mute", !mute)} />
                  </div>
                  <div className="mx-fader-row">
                    <Fader
                      level={level}
                      locked={lock("level")}
                      reset={s.kind === "DRUM" ? 0.9 : 0.8}
                      color={color}
                      onChange={(l) => setStrip(s, "level", Math.round(l * 1000) / 1000)}
                      {...gesture(s.node?.id, "level", level)}
                    />
                    <canvas className="mx-meter" ref={(el) => void (live.meter = el)} />
                  </div>
                  <div className="mx-db">{dbLabel(level)}</div>
                </div>
              );
            })}
          </div>

          <div className="mx-master">
            <div className="mx-analysis">
              <div className="mx-section">
                <div className="mx-section-head">
                  <span>Spectrum</span>
                  <span className="mx-section-note">25 Hz – 18 kHz</span>
                </div>
                <canvas className="mx-spectrum" ref={(el) => void (masterRef.current.spectrum = el)} />
              </div>
              <div className="mx-analysis-row">
                <div className="mx-section mx-scope-box">
                  <div className="mx-section-head">
                    <span>Phase</span>
                  </div>
                  <canvas className="mx-scope" ref={(el) => void (masterRef.current.scope = el)} />
                  <canvas className="mx-gauge" ref={(el) => void (masterRef.current.corr = el)} title="Correlation: +1 mono, 0 wide, below 0 out of phase" />
                  <div className="mx-scale">
                    <span>−1</span>
                    <span>0</span>
                    <span>+1</span>
                  </div>
                </div>
                <div className="mx-section mx-lufs">
                  <div className="mx-section-head">
                    <span>Loudness</span>
                    <span className="mx-section-note">LUFS · R128</span>
                  </div>
                  {(
                    [
                      ["Momentary", "lufsM", "The last 400 ms"],
                      ["Short-term", "lufsS", "The last 3 s"],
                      ["Integrated", "lufsI", "Since Play, gated"],
                    ] as const
                  ).map(([label, ref, title]) => (
                    <div key={ref} className="mx-lufs-row" title={title}>
                      <span className="mx-lufs-label">{label}</span>
                      <span className="mx-lufs-value" ref={(el) => void (masterRef.current[ref] = el)}>
                        —
                      </span>
                    </div>
                  ))}
                  <canvas className="mx-gauge" ref={(el) => void (masterRef.current.lufsBar = el)} title="Short-term loudness; marks at −23 (broadcast) and −14 (streaming)" />
                  <div className="mx-scale mx-scale-abs">
                    {[-36, -23, -14, 0].map((v) => (
                      <span key={v} style={{ left: `${((v + 36) / 36) * 100}%` }}>
                        {v}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mx-section">
                <div className="mx-section-head">
                  <span>Returns</span>
                  <span className="mx-section-note">set on Music Out</span>
                </div>
                <div className="mx-returns">
                  {outKnob("delayLevel", "Delay", 0.7, 1.5)}
                  {outKnob("delayFeedback", "Fdbk", 0.5, 0.95)}
                  {outKnob("reverbLevel", "Reverb", 0.4, 1.5)}
                  {outKnob("reverbSize", "Size", 0.6, 1)}
                </div>
              </div>
            </div>
            <div className="mx-master-strip" style={{ "--mx-color": C.accent } as CSSProperties}>
              <div className="mx-strip-head">
                <span className="mx-master-title">Master</span>
                <span className="mx-clip" ref={(el) => void (masterRef.current.clip = el)} title="The master went past full scale">
                  Clip
                </span>
              </div>
              <div className="mx-fader-row">
                <Fader
                  level={outNum("master", 0.8)}
                  locked={!out || outWired("master")}
                  reset={0.8}
                  color={C.accent}
                  onChange={(l) => out && setValue(out.id, "master", Math.round(l * 1000) / 1000, outNum("master", 0.8))}
                  {...gesture(out?.id, "master", outNum("master", 0.8))}
                />
                <canvas className="mx-meter mx-meter-stereo" ref={(el) => void (masterRef.current.meter = el)} />
              </div>
              <div className="mx-db">{dbLabel(outNum("master", 0.8))}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
