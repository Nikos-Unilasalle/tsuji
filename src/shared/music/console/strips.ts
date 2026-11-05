/**
 * The Mixing Console's model, without React: which channel strips a graph has (one per track Music Out mixes, each
 * the voice node it edits), the fader's dB taper, and the readouts' words. The overlay (three/MixingConsoleOverlay.tsx)
 * draws and plays it.
 */
import type { Graph, NodeInstance } from "../../graph/types";
import { isTrack, type TrackDescription } from "../engine/description";

type Results = { get(id: string): Record<string, unknown> | undefined } | null | undefined;

/** The voice nodes a strip can edit; any other source of a track (a hand-built one) is shown, not edited. */
export const CONSOLE_VOICE_TYPES = ["music/fm-voice", "music/gameboy", "music/sid", "music/drum-kit"] as const;

/** The params a strip plays, which a wire into the voice can take over. */
export const STRIP_PARAMS = ["level", "pan", "mute", "solo", "delaySend", "reverbSend"] as const;
export type StripParam = (typeof STRIP_PARAMS)[number];

export interface ConsoleStrip {
  /** The engine's id for the track (the meters are keyed by it). */
  trackId: string;
  /** The voice node the strip edits, when it is one. */
  node: NodeInstance | null;
  name: string;
  /** Four letters for the strip's badge. */
  kind: "FM" | "GB" | "SID" | "DRUM";
  desc: TrackDescription;
  /** The params a wire drives: the strip shows them, locked. */
  wired: ReadonlySet<StripParam>;
}

const KIND: Record<TrackDescription["kind"], ConsoleStrip["kind"]> = { fm: "FM", gb: "GB", sid: "SID", drums: "DRUM" };

/** The strips, in Music Out's socket order; `out` is the Music Out they mix through. */
export function consoleStrips(graph: Graph, results: Results): { out: NodeInstance | null; strips: ConsoleStrip[] } {
  const out = graph.nodes.find((n) => n.type === "music/out") ?? null;
  if (!out || !results) return { out, strips: [] };
  const wires = graph.connections
    .filter((c) => c.toNode === out.id && c.toSocket.startsWith("track"))
    .sort((a, b) => Number(a.toSocket.slice(5)) - Number(b.toSocket.slice(5)));
  const strips: ConsoleStrip[] = [];
  const used = new Map<string, number>();
  for (const c of wires) {
    const v = results.get(c.fromNode)?.[c.fromSocket];
    if (!isTrack(v)) continue;
    // Music Out plays a track wired twice under "<id>#2": the strip follows the same naming, so its meter is its own.
    const n = (used.get(v.id) ?? 0) + 1;
    used.set(v.id, n);
    const trackId = n === 1 ? v.id : `${v.id}#${n}`;
    const voice = graph.nodes.find((x) => x.id === v.id && (CONSOLE_VOICE_TYPES as readonly string[]).includes(x.type)) ?? null;
    const name = String(voice?.params.name ?? "").trim() || String(voice?.params.preset ?? "").trim() || (v.kind === "drums" ? "Drums" : v.id);
    const wired = new Set<StripParam>(
      voice ? graph.connections.filter((w) => w.toNode === voice.id && (STRIP_PARAMS as readonly string[]).includes(w.toSocket)).map((w) => w.toSocket as StripParam) : [],
    );
    strips.push({ trackId, node: voice, name, kind: KIND[v.kind], desc: v, wired });
  }
  return { out, strips };
}

// ── The fader's taper ──────────────────────────────────────────────────────

/** (travel 0–1, dB): a console's scale — wide around unity, crowded at the bottom; level 2 (the most) is +6 dB. */
const TAPER: readonly [number, number][] = [
  [0.04, -60],
  [0.16, -40],
  [0.3, -30],
  [0.45, -20],
  [0.58, -12],
  [0.69, -6],
  [0.8, 0],
  [1, 20 * Math.log10(2)],
];

export const dbOf = (level: number) => (level > 0 ? 20 * Math.log10(level) : -Infinity);

/** The level (linear gain, 0–2) at a fader travel (0 bottom – 1 top). */
export function faderLevel(travel: number): number {
  const t = Math.min(1, Math.max(0, travel));
  const [t0, d0] = TAPER[0];
  // Below −60 dB the last stretch fades linearly to silence.
  if (t <= t0) return (t / t0) * 10 ** (d0 / 20);
  for (let i = 1; i < TAPER.length; i++) {
    const [a, da] = TAPER[i - 1];
    const [b, db] = TAPER[i];
    if (t <= b) return 10 ** ((da + ((t - a) / (b - a)) * (db - da)) / 20);
  }
  return 2;
}

/** The fader travel (0–1) a level sits at: faderLevel's inverse. */
export function faderTravel(level: number): number {
  const l = Math.min(2, Math.max(0, level));
  const [t0, d0] = TAPER[0];
  const floor = 10 ** (d0 / 20);
  if (l <= floor) return (l / floor) * t0;
  const d = dbOf(l);
  for (let i = 1; i < TAPER.length; i++) {
    const [a, da] = TAPER[i - 1];
    const [b, db] = TAPER[i];
    if (d <= db) return a + ((d - da) / (db - da)) * (b - a);
  }
  return 1;
}

/** The scale printed beside the faders: dB marks at their travel. */
export const FADER_MARKS: readonly { db: number; travel: number }[] = [6, 0, -6, -12, -20, -30, -40, -60].map((db) => ({ db, travel: faderTravel(10 ** (db / 20)) }));

// ── Readouts ───────────────────────────────────────────────────────────────

/** "+2.5", "-12.0", "-INF": a level in dB, for a seven-segment readout. */
export function dbLabel(level: number): string {
  const d = dbOf(level);
  if (d < -99) return "-INF";
  const s = d.toFixed(1);
  return d > 0.04 ? `+${s}` : s === "-0.0" ? "0.0" : s;
}

/** "C", "L40", "R100": a pan as a console prints it. */
export function panLabel(pan: number): string {
  const p = Math.round(Math.min(1, Math.max(-1, pan)) * 100);
  return p === 0 ? "C" : p < 0 ? `L${-p}` : `R${p}`;
}

/** Bar and beat (1-based) and the step in the beat, from the song's beat: "012.3". */
export function barBeat(beat: number, beatsPerBar = 4): { bar: number; beat: number } {
  if (!(beat >= 0)) return { bar: 0, beat: 0 };
  const b = Math.floor(beat);
  return { bar: Math.floor(b / beatsPerBar) + 1, beat: (b % beatsPerBar) + 1 };
}

/** "01:23.45" */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
}
