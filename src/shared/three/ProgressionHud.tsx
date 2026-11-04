import { useRef, useState } from "react";
import type { NodeInstance } from "../graph/types";
import type { PatternPlayhead } from "./PatternHud";
import type { PreviewSound } from "../music/engine/description";
import { chordNotes } from "../music/seq/chords";
import { FUNCTION_MOVES, numeralDegree, numeralOf, parseNumeral, randomProgression } from "../music/seq/compose";
import { PITCH_CLASSES } from "../music/seq/scales";
import { Sequence, stepAt } from "../music/seq/sequencer";
import { HudButton, Panel, Stepper, songSample, useLive } from "./MusicAlgoHuds";

/**
 * The Progression node's palette: the chords laid out in time, written by clicking rather than typing numerals.
 *
 * - The timeline: one block per chord, as wide as it lasts, coloured by its function — tonic blue, predominant green,
 *   dominant orange, borrowed or applied magenta — with its numeral and its name in the key (iv · Gm). The chord
 *   playing is lit. Click a block to select it and hear it; drag it to move it; drag its right edge to make it longer
 *   or shorter (by whole chords; Shift: by quarters).
 * - The palette: the key's own chords, and a row of colour (applied dominants, borrowed chords). With a chord
 *   selected a click replaces it, with none it appends. The chords that usually come next glow — brighter, more usual.
 * - Random: the walk the node would take, shown, and written out as numerals with one click to edit from there.
 *
 * Every edit writes the numerals text in one undo step — the text stays what the file saves.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

interface Token {
  num: string;
  beats: number;
}

export function parseTokens(text: string): Token[] {
  return String(text ?? "")
    .split(/[\s,|]+/)
    .filter((w) => w !== "")
    .map((w) => {
      const m = /^(.*?)(?::(\d+(?:\.\d+)?))?$/.exec(w)!;
      return { num: m[1], beats: m[2] !== undefined ? Math.max(0.25, Number(m[2])) : 1 };
    });
}

export function formatTokens(tokens: readonly Token[]): string {
  return tokens.map((t) => (t.beats === 1 ? t.num : `${t.num}:${Number(t.beats.toFixed(2))}`)).join(" ");
}

const FUNCTION_COLORS = { tonic: "#38bdf8", predominant: "#84cc16", dominant: "#f59e0b", colour: "#d946ef" } as const;
type Fn = keyof typeof FUNCTION_COLORS;
/** Degree → function: I iii vi rest, ii IV move away, V vii pull home. */
const FUNCTION_OF: Fn[] = ["tonic", "predominant", "tonic", "predominant", "dominant", "tonic", "dominant"];

function functionOf(num: string): Fn {
  const d = numeralDegree(num);
  if (!d) return "colour";
  // The raised leading-tone chord of the minor (#vii°) is a dominant, accidental or not.
  if (d.degree === 6 && /^#/.test(num)) return "dominant";
  return d.chromatic ? "colour" : FUNCTION_OF[d.degree];
}

const CHORD_SUFFIX: Record<string, string> = { maj: "", min: "m", "7": "7", "9": "9", sus: "sus", dim: "°", maj7: "maj7", min7: "m7", sus2: "sus2", dim7: "°7", aug: "+", m7b5: "ø7" };
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** A numeral's chord named in the key (Gm, Bb, E°…), or "?" for one that does not read. */
function chordName(num: string, key: number, minor: boolean): string {
  const c = parseNumeral(num, minor);
  return c ? `${NAMES[(key + c.root) % 12]}${CHORD_SUFFIX[c.chord] ?? c.chord}` : "?";
}

/** The palette: the key's own chords, then a row of colour. */
function paletteOf(minor: boolean, sevenths: boolean): { diatonic: string[]; colour: string[] } {
  if (minor) {
    return {
      diatonic: sevenths ? ["i7", "iiø7", "IIImaj7", "iv7", "v7", "V7", "VImaj7", "VII7", "#vii°7"] : ["i", "ii°", "III", "iv", "v", "V", "VI", "VII", "#vii°"],
      colour: ["I", "IV", "bII", "V7/iv", "V7/V", "V7/III"],
    };
  }
  return {
    diatonic: sevenths ? ["Imaj7", "ii7", "iii7", "IVmaj7", "V7", "vi7", "viiø7"] : ["I", "ii", "iii", "IV", "V", "vi", "vii°"],
    colour: ["V7/ii", "V7/IV", "V7/V", "V7/vi", "iv", "bVI", "bVII", "bIII"],
  };
}

export function ProgressionHud({
  node,
  readSequence,
  readPlayhead,
  startFrame,
  previewSound,
  onParams,
  onPreview,
}: {
  node: NodeInstance;
  /** The node's Chords output, as evaluated. */
  readSequence: () => Sequence | null;
  readPlayhead: () => PatternPlayhead;
  startFrame: number;
  previewSound: PreviewSound | null;
  onParams: OnParams;
  onPreview: (sound: PreviewSound, note: number, velocity: number) => void;
}) {
  const p = node.params;
  const set = (params: Record<string, unknown>) => onParams(params, node.id);
  const minor = p.mode === "minor";
  const key = Math.max(0, PITCH_CLASSES.indexOf(String(p.root)));
  const random = p.source === "random";
  const chordLength = Math.max(1, Math.round(Number(p.chordLength) || 16));
  const center = Number(p.center) || 60;
  const [sevenths, setSevenths] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  // Random: the walk the node takes, as numerals (shown, and written out on request).
  const randomTokens = (): Token[] =>
    randomProgression(Math.max(1, Math.round(Number(p.count) || 8)), minor, Boolean(p.sevenths), Number(p.tension) || 0, Boolean(p.cadence), Math.round(Number(p.seed) || 0)).map((c) => ({
      num: numeralOf(c.root, c.chord, minor) ?? "I",
      beats: 1,
    }));
  const written = parseTokens(String(p.numerals ?? ""));
  const tokens = random ? randomTokens() : written;
  const write = (next: Token[]) => set({ numerals: formatTokens(next) });

  // A drag in progress: moving a block (to `to`), or resizing it (to `beats`).
  const [drag, setDrag] = useState<{ kind: "move" | "size"; index: number; x0: number; beats0: number; to: number; beats: number; moved: boolean } | null>(null);
  const shown = (() => {
    if (!drag || !drag.moved) return tokens;
    const t = tokens.slice();
    if (drag.kind === "size") t[drag.index] = { ...t[drag.index], beats: drag.beats };
    else {
      const [x] = t.splice(drag.index, 1);
      t.splice(drag.to, 0, x);
    }
    return t;
  })();

  const total = Math.max(1, shown.reduce((a, t) => a + t.beats, 0));
  const unit = Math.max(16, Math.min(72, Math.floor(760 / total)));
  const width = total * unit;
  const starts: number[] = [];
  shown.reduce((a, t, i) => ((starts[i] = a), a + t.beats), 0);

  // The chord playing: its step inside the progression's loop, found among the blocks.
  const playing = useLive(() => {
    const seq = readSequence();
    const t = songSample(readPlayhead, startFrame);
    if (!seq || t < 0) return -1;
    const at = (stepAt(seq.clock, 48_000, t) % Math.max(1, seq.pattern.length)) / chordLength;
    let acc = 0;
    for (let i = 0; i < tokens.length; i++) {
      acc += Math.max(1, Math.round(tokens[i].beats * chordLength)) / chordLength;
      if (at < acc) return i;
    }
    return -1;
  });

  const audition = (num: string) => {
    if (!previewSound) return;
    const c = parseNumeral(num, minor);
    if (!c) return;
    const pc = (key + c.root) % 12;
    const root = pc + 12 * Math.ceil((center - 6 - pc) / 12);
    for (const n of chordNotes(root, c.chord)) onPreview(previewSound, n, 0.6);
  };

  const sel = selected !== null && selected < tokens.length ? selected : null;
  const from = sel ?? (tokens.length ? tokens.length - 1 : null);
  const fromDegree = from !== null ? numeralDegree(tokens[from].num) : null;
  const moves = fromDegree && !fromDegree.chromatic ? FUNCTION_MOVES[fromDegree.degree] : null;
  const maxMove = moves ? Math.max(...Object.values(moves)) : 1;
  const glow = (num: string) => {
    const d = numeralDegree(num);
    if (!moves || !d || d.chromatic) return 0;
    return (moves[d.degree] ?? 0) / maxMove;
  };

  const pick = (num: string) => {
    audition(num);
    if (random) return;
    if (sel !== null) {
      const next = written.slice();
      next[sel] = { ...next[sel], num };
      write(next);
    } else {
      write([...written, { num, beats: 1 }]);
    }
  };

  const svgRef = useRef<SVGSVGElement>(null);
  const xOf = (e: React.PointerEvent) => e.clientX - (svgRef.current?.getBoundingClientRect().left ?? 0);
  const H = 46;

  const status = `${PITCH_CLASSES[key]} ${minor ? "minor" : "major"} · ${tokens.length} chords · ${Number(((total * chordLength) / 16).toFixed(2))} bars${random ? " · random walk" : ""}`;

  const btnStyle = (color: string, g: number, active = false) => ({
    background: `color-mix(in srgb, ${color} ${Math.round(14 + g * 40)}%, transparent)`,
    border: `1px solid ${color}`,
    borderColor: active ? "#fff" : `color-mix(in srgb, ${color} ${Math.round(35 + g * 65)}%, transparent)`,
    boxShadow: g > 0 ? `0 0 ${Math.round(4 + g * 10)}px color-mix(in srgb, ${color} ${Math.round(g * 70)}%, transparent)` : "none",
    color: "#fff",
    borderRadius: 5,
    padding: "2px 7px",
    minWidth: 40,
    cursor: random ? "default" : "pointer",
    display: "inline-flex",
    flexDirection: "column" as const,
    alignItems: "center",
    lineHeight: 1.15,
    fontSize: 12,
  });

  const palette = paletteOf(minor, sevenths);
  const PaletteRow = ({ label, nums }: { label: string; nums: string[] }) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
      <span style={{ width: 54, fontSize: 10, color: "#64748b" }}>{label}</span>
      {nums.map((num) => {
        const fn = functionOf(num);
        const g = glow(num);
        return (
          <button
            key={num}
            type="button"
            style={btnStyle(FUNCTION_COLORS[fn], g)}
            title={`${num} — ${chordName(num, key, minor)} (${fn})${g > 0 ? ` · ${g >= 0.75 ? "a usual" : g >= 0.4 ? "a common" : "a rarer"} next chord` : ""}\n${random ? "Write the random walk out to edit it" : sel !== null ? "Click: replace the selected chord" : "Click: add it at the end"}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => pick(num)}
          >
            <span style={{ fontWeight: 600 }}>{num}</span>
            <span style={{ fontSize: 9, color: "#cbd5e1" }}>{chordName(num, key, minor)}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <Panel title="Progression" status={status}>
      {/* Key, mode, source, chord length */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontSize: 11, color: "#94a3b8" }}>
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          Key
          <select
            value={PITCH_CLASSES[key]}
            onChange={(e) => set({ root: e.target.value })}
            style={{ background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "1px 4px", fontSize: 11 }}
          >
            {PITCH_CLASSES.map((pc) => (
              <option key={pc} value={pc}>
                {pc}
              </option>
            ))}
          </select>
        </span>
        <span style={{ display: "inline-flex", gap: 3 }}>
          <HudButton label="Major" title="Major key" active={!minor} onClick={() => set({ mode: "major" })} />
          <HudButton label="Minor" title="Minor key (V and vii° from the harmonic minor in the palette)" active={minor} onClick={() => set({ mode: "minor" })} />
        </span>
        <span style={{ display: "inline-flex", gap: 3 }}>
          <HudButton label="Written" title="The chords below, as you write them" active={!random} onClick={() => set({ source: "written" })} />
          <HudButton label="Random" title="A seeded walk along the usual functional paths" active={random} onClick={() => set({ source: "random" })} />
        </span>
        <Stepper label="Chord (steps)" title="Steps one chord lasts (16: a bar)" value={chordLength} min={1} max={256} onChange={(v) => set({ chordLength: Math.max(1, v) })} />
        {!previewSound && <span style={{ color: "#64748b" }}>wire it to a voice to hear the chords</span>}
      </div>

      {/* Timeline */}
      <div className="music-hud-scroll" style={{ overflowX: "auto", overflowY: "hidden", maxWidth: "100%", flexShrink: 0 }}>
        <svg
          ref={svgRef}
          width={Math.max(width, 120)}
          height={H + 14}
          style={{ display: "block", flexShrink: 0 }}
          onPointerMove={(e) => {
            if (!drag || random) return;
            const dx = xOf(e) - drag.x0;
            if (!drag.moved && Math.abs(dx) < 4) return;
            if (drag.kind === "size") {
              const q = e.shiftKey ? 0.25 : 1;
              setDrag({ ...drag, moved: true, beats: Math.max(q, Math.round((drag.beats0 + dx / unit) / q) * q) });
            } else {
              // The slot the block's centre is over.
              const centre = (starts[drag.index] ?? 0) * unit + dx;
              let to = 0;
              let acc = 0;
              for (let i = 0; i < tokens.length; i++) {
                if (i === drag.index) continue;
                if (centre > (acc + tokens[i].beats / 2) * unit) to++;
                acc += tokens[i].beats;
              }
              setDrag({ ...drag, moved: true, to });
            }
          }}
          onPointerUp={() => {
            if (!drag) return;
            if (drag.moved && !random) {
              write(shown);
              setSelected(drag.kind === "move" ? drag.to : drag.index);
            } else if (!drag.moved && drag.kind === "move") {
              // A click, not a drag: select (or deselect) it, and hear it.
              setSelected(sel === drag.index ? null : drag.index);
              audition(tokens[drag.index].num);
            }
            setDrag(null);
          }}
          onPointerCancel={() => setDrag(null)}
        >
          {/* bar ticks */}
          {Array.from({ length: Math.floor((total * chordLength) / 16) + 1 }, (_, b) => (
            <g key={`b${b}`}>
              <line x1={(b * 16 * unit) / chordLength} x2={(b * 16 * unit) / chordLength} y1={H + 2} y2={H + 6} stroke="#475569" />
              {b % 4 === 0 && (
                <text x={(b * 16 * unit) / chordLength + 2} y={H + 13} fontSize={9} fill="#64748b">
                  {b + 1}
                </text>
              )}
            </g>
          ))}
          {shown.map((t, i) => {
            const x = starts[i] * unit;
            const w = t.beats * unit;
            const color = FUNCTION_COLORS[functionOf(t.num)];
            const isSel = sel === i && !drag?.moved;
            const isPlaying = playing === i && !drag?.moved;
            const ok = !!parseNumeral(t.num, minor);
            return (
              <g key={i}>
                <title>{`${t.num} — ${chordName(t.num, key, minor)} · ${t.beats} chord${t.beats === 1 ? "" : "s"} long${ok ? "" : " · not a numeral this node reads"}`}</title>
                <rect
                  x={x + 1}
                  y={1}
                  width={Math.max(2, w - 2)}
                  height={H - 2}
                  rx={5}
                  fill={ok ? color : "#ef4444"}
                  fillOpacity={isPlaying ? 0.55 : 0.22}
                  stroke={isSel ? "#fff" : color}
                  strokeOpacity={isSel ? 1 : 0.7}
                  strokeWidth={isSel ? 1.6 : 1}
                  style={{ cursor: random ? "default" : "grab" }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                    setDrag({ kind: "move", index: i, x0: xOf(e), beats0: t.beats, to: i, beats: t.beats, moved: false });
                  }}
                />
                {w >= 18 && (
                  <text x={x + w / 2} y={20} textAnchor="middle" fontSize={w >= 34 ? 13 : 10} fontWeight={600} fill="#fff" pointerEvents="none">
                    {t.num}
                  </text>
                )}
                {w >= 30 && (
                  <text x={x + w / 2} y={35} textAnchor="middle" fontSize={9} fill="#cbd5e1" pointerEvents="none">
                    {chordName(t.num, key, minor)}
                  </text>
                )}
                {!random && (
                  <rect
                    x={x + w - 6}
                    y={1}
                    width={6}
                    height={H - 2}
                    fill="transparent"
                    style={{ cursor: "ew-resize" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                      setDrag({ kind: "size", index: i, x0: xOf(e), beats0: t.beats, to: i, beats: t.beats, moved: false });
                    }}
                  >
                    <title>Drag: longer or shorter (Shift: by quarters)</title>
                  </rect>
                )}
              </g>
            );
          })}
          {tokens.length === 0 && (
            <text x={6} y={26} fontSize={11} fill="#64748b">
              Click chords below to write a progression
            </text>
          )}
        </svg>
      </div>

      {/* Palette */}
      {!random && <PaletteRow label="In key" nums={palette.diatonic} />}
      {!random && <PaletteRow label="Colour" nums={palette.colour} />}

      {/* Edit / random */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 11, color: "#94a3b8" }}>
        {!random ? (
          <>
            <HudButton label="7ths" title="The palette in sevenths" active={sevenths} onClick={() => setSevenths(!sevenths)} />
            <HudButton label="◀" title="Move the selected chord earlier" disabled={sel === null || sel === 0} onClick={() => {
              const next = written.slice();
              [next[sel! - 1], next[sel!]] = [next[sel!], next[sel! - 1]];
              write(next);
              setSelected(sel! - 1);
            }} />
            <HudButton label="▶" title="Move the selected chord later" disabled={sel === null || sel >= written.length - 1} onClick={() => {
              const next = written.slice();
              [next[sel! + 1], next[sel!]] = [next[sel!], next[sel! + 1]];
              write(next);
              setSelected(sel! + 1);
            }} />
            <HudButton label="Duplicate" title="Copy the selected chord after it" disabled={sel === null} onClick={() => {
              const next = written.slice();
              next.splice(sel! + 1, 0, { ...next[sel!] });
              write(next);
              setSelected(sel! + 1);
            }} />
            <HudButton label="Delete" title="Remove the selected chord" disabled={sel === null} onClick={() => {
              write(written.filter((_, i) => i !== sel));
              setSelected(null);
            }} />
            <HudButton label="Clear" title="Remove every chord" disabled={written.length === 0} onClick={() => {
              write([]);
              setSelected(null);
            }} />
            <span>{sel !== null ? "palette replaces the selected chord · click it again to deselect" : "palette adds at the end · brighter: a more usual next chord"}</span>
          </>
        ) : (
          <>
            <Stepper label="Chords" title="How many chords the walk takes" value={Math.round(Number(p.count) || 8)} min={1} max={256} onChange={(v) => set({ count: v })} />
            <Stepper label="Seed" title="Another walk" value={Math.round(Number(p.seed) || 0)} min={-9999} max={9999} onChange={(v) => set({ seed: v })} />
            <HudButton label="Sevenths" title="Sevenths in the walk" active={Boolean(p.sevenths)} onClick={() => set({ sevenths: !p.sevenths })} />
            <HudButton label="Cadence" title="End V → I" active={Boolean(p.cadence)} onClick={() => set({ cadence: !p.cadence })} />
            <HudButton label="Write it out" title="Keep this walk as written numerals, to edit it" onClick={() => set({ source: "written", numerals: formatTokens(randomTokens()) })} />
          </>
        )}
      </div>
    </Panel>
  );
}
