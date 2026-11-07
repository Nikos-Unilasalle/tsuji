import { useEffect, useRef, useState } from "react";
import { subscribeMidi } from "../shared/graph/midiRuntime";
import { BindableField, CC_MODE_LABELS, CcMode, MidiBinding, applyCc, bindingMatches, bindingName, bindingStep, detectMode, learnBinding, modesFor } from "../shared/graph/midiBinding";
import { toDisplayUnit, toStoredUnit } from "./ParamPanel";
import { DragNumberInput } from "./DragNumberInput";
import "./viewport-param-hud.css";

/**
 * MIDI on pinned params, shared by the two HUDs that show them — the pinned-param list and the Virtual Interface (the
 * digital twin of the controller on the desk). Whichever is shown listens: the bindings live on the pins (the graph's
 * exposedParams), not on the panel, so a knob keeps driving its param whichever panel plays it.
 */

/** A pinned row as the MIDI handler needs it: read between renders, so kept in a ref. */
export interface PinMidiRow {
  /** "nodeId:paramId". */
  key: string;
  nodeId: string;
  /** The pin's paramId — "position.y" for an axis pinned alone. */
  paramId: string;
  field: BindableField;
  /** The param the node stores — a vector's id when the row is one of its axes. */
  baseId: string;
  value: unknown;
  /** The row's new value → what the node stores (the whole vector for an axis; `base`, a fresher vector to set it on). */
  toStored: (v: unknown, base?: unknown) => unknown;
  midi?: MidiBinding;
}

type OnChange = (paramId: string, value: unknown, targetNodeId?: string) => void;
type OnBindMidi = (nodeId: string, paramId: string, midi: MidiBinding | undefined) => void;

/** How long a value MIDI wrote wins over the rendered one: an encoder turns faster than the graph re-renders. */
const WRITTEN_MS = 250;
/** Learning listens this long after the first move: long enough to hear how the control sends (detectMode). */
const LEARN_MS = 600;
/** The raw values the settings show, per control. */
const MONITOR_LENGTH = 10;

export interface PinMidi {
  /** The row waiting for a control to be moved, and the row whose MIDI settings are open ("nodeId:paramId"). */
  learning: string | null;
  setLearning: (key: string | null) => void;
  midiOpen: string | null;
  setMidiOpen: (update: string | null | ((k: string | null) => string | null)) => void;
  /** The last raw values a binding's control sent, from every input. */
  seen: (b: MidiBinding) => { port: string; value: number }[];
}

/**
 * Listens to every MIDI input and drives the rows' bound params; learns a control for a row. Moving a control sets the
 * param, one undo step a gesture (App's coalescing), keyed when keyframes are on — so turning a knob while playing
 * records automation.
 */
export function usePinMidi(rows: PinMidiRow[], onChange: OnChange, onBindMidi: OnBindMidi | undefined): PinMidi {
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [learning, setLearning] = useState<string | null>(null);
  const [midiOpen, setMidiOpen] = useState<string | null>(null);
  const lastCc = useRef(new Map<string, number>());
  /** The control being learned and what it has sent so far. */
  const capture = useRef<{ key: string; port: string; channel: number; cc: number; values: number[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** The last raw values each control sent ("channel:cc"), from every input — what the settings' monitor shows. */
  const recent = useRef(new Map<string, { port: string; value: number }[]>());
  const [, setMonitorTick] = useState(0);
  const finishLearn = () => {
    const c = capture.current;
    capture.current = null;
    setLearning(null);
    const row = c && rowsRef.current.find((r) => r.key === c.key);
    if (!c || !row || !onBindMidi) return;
    const binding = learnBinding(row.field, c.channel, c.cc, row.value, c.port || undefined);
    const detected = row.field.kind === "boolean" ? null : detectMode(c.values);
    if (detected && modesFor(row.field).includes(detected)) binding.mode = detected;
    onBindMidi(row.nodeId, row.paramId, binding);
  };
  const finishLearnRef = useRef(finishLearn);
  finishLearnRef.current = finishLearn;
  const written = useRef(new Map<string, { value: unknown; at: number }>());
  /** The same for what was stored ("nodeId:baseId"): two knobs on two axes of one vector each set theirs on the other's latest write. */
  const writtenBase = useRef(new Map<string, { value: unknown; at: number }>());
  const handleMidi = useRef<(e: Parameters<Parameters<typeof subscribeMidi>[0]>[0]) => void>(() => {});
  handleMidi.current = (e) => {
    if (e.type !== "cc") return;
    const control = `${e.port}:${e.channel}:${e.controller}`;
    const previous = lastCc.current.get(control);
    lastCc.current.set(control, e.value);
    const seen = recent.current.get(`${e.channel}:${e.controller}`) ?? [];
    seen.push({ port: e.port, value: e.value });
    recent.current.set(`${e.channel}:${e.controller}`, seen.slice(-MONITOR_LENGTH * 2));
    const open = midiOpen ? rowsRef.current.find((r) => r.key === midiOpen)?.midi : undefined;
    if (open && open.channel === e.channel && open.cc === e.controller) setMonitorTick((t) => t + 1);
    if (learning) {
      const c = capture.current;
      if (!c) {
        capture.current = { key: learning, port: e.port, channel: e.channel, cc: e.controller, values: [e.value], timer: setTimeout(() => finishLearnRef.current(), LEARN_MS) };
      } else if (c.port === e.port && c.channel === e.channel && c.cc === e.controller) {
        c.values.push(e.value);
      }
      return;
    }
    const now = performance.now();
    for (const row of rowsRef.current) {
      if (!row.midi || !bindingMatches(row.midi, e.port, e.channel, e.controller)) continue;
      const w = written.current.get(row.key);
      const current = w && now - w.at < WRITTEN_MS ? w.value : row.value;
      const next = applyCc(row.field, row.midi, e.value, current, previous);
      if (next === undefined || next === current) continue;
      written.current.set(row.key, { value: next, at: now });
      const baseKey = `${row.nodeId}:${row.baseId}`;
      const wb = writtenBase.current.get(baseKey);
      const stored = row.toStored(next, wb && now - wb.at < WRITTEN_MS ? wb.value : undefined);
      writtenBase.current.set(baseKey, { value: stored, at: now });
      onChange(row.baseId, stored, row.nodeId);
    }
  };
  useEffect(() => subscribeMidi((e) => handleMidi.current(e)), []);
  // Learning cancelled (or done): drop what was being heard.
  useEffect(() => {
    if (learning || !capture.current) return;
    clearTimeout(capture.current.timer);
    capture.current = null;
  }, [learning]);
  useEffect(() => () => void (capture.current && clearTimeout(capture.current.timer)), []);
  useEffect(() => {
    if (!learning) return;
    const cancel = (e: KeyboardEvent) => e.key === "Escape" && setLearning(null);
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [learning]);

  return {
    learning,
    setLearning,
    midiOpen,
    setMidiOpen,
    seen: (b) => recent.current.get(`${b.channel}:${b.cc}`) ?? [],
  };
}

/**
 * The small CC button: click it, turn a knob, and it is learned; learned, it names the control and opens its
 * settings. Every knob is endless: one way adds the step, the other takes it off.
 */
export function MidiCcButton({ pin, rowKey, midi, className }: { pin: PinMidi; rowKey: string; midi?: MidiBinding; className?: string }) {
  const learning = pin.learning === rowKey;
  return (
    <button
      type="button"
      className={`viewport-param-hud-midi${midi ? " bound" : ""}${learning ? " learning" : ""}${className ? ` ${className}` : ""}`}
      title={
        learning
          ? "Turn a knob a little (or press a button) on your MIDI controller — how it sends is detected (click or Esc to cancel)"
          : midi
            ? `MIDI: ${bindingName(midi)}${midi.port ? ` on ${midi.port}` : ""}, ${CC_MODE_LABELS[midi.mode]} — click for its settings`
            : "Learn a MIDI control: click, then turn a knob (or press a button)"
      }
      onClick={() => {
        if (learning) return pin.setLearning(null);
        if (midi) return pin.setMidiOpen((k) => (k === rowKey ? null : rowKey));
        pin.setLearning(rowKey);
      }}
    >
      {learning ? "…" : midi ? midi.cc : "CC"}
    </button>
  );
}

/** A binding's settings: how the knob codes its turns, a number's step a notch, what it sends, Relearn and Forget; × or Esc closes. */
export function MidiSettings({
  pin,
  rowKey,
  field,
  midi,
  value,
  onBind,
}: {
  pin: PinMidi;
  rowKey: string;
  field: BindableField;
  midi: MidiBinding;
  /** The param's value now: what a step guessed for a binding with none goes by. */
  value: unknown;
  onBind: (midi: MidiBinding | undefined) => void;
}) {
  const set = (patch: Partial<MidiBinding>) => onBind({ ...midi, ...patch });
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && pin.setMidiOpen(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [pin.setMidiOpen]);
  return (
    <div className="viewport-param-hud-midi-settings">
      <span className="viewport-param-hud-midi-name" title={midi.port ? `Only from ${midi.port}` : "From any MIDI input"}>
        {bindingName(midi)}
        {midi.port ? ` · ${midi.port}` : ""}
      </span>
      <button type="button" className="viewport-param-hud-midi-close" title="Close (Esc)" onClick={() => pin.setMidiOpen(null)}>
        ×
      </button>
      <select
        value={modesFor(field).includes(midi.mode) ? midi.mode : modesFor(field)[0]}
        onChange={(e) => set({ mode: e.target.value as CcMode })}
        title="How the knob codes its turns — heard when it was learned"
      >
        {modesFor(field).map((m) => (
          <option key={m} value={m}>
            {CC_MODE_LABELS[m]}
          </option>
        ))}
      </select>
      {field.kind === "number" && (
        <span className="viewport-param-hud-midi-range" title={`What one notch adds (turned the other way, takes off)${field.degrees ? ", in degrees" : field.percent ? ", in percent" : ""}`}>
          <span>Step</span>
          <DragNumberInput
            value={toDisplayUnit(bindingStep(field, midi, Number(value) || 0), field.degrees, field.percent)}
            onChange={(v) => {
              const stored = toStoredUnit(v, field.degrees, field.percent);
              // A binding from before keeps its range no more: the step replaces it.
              if (Number.isFinite(stored) && stored !== 0) set({ step: Math.abs(stored), min: undefined, max: undefined });
            }}
          />
        </span>
      )}
      <MidiMonitor binding={midi} seen={pin.seen(midi)} />
      <button type="button" onClick={() => { pin.setMidiOpen(null); pin.setLearning(rowKey); }}>
        Relearn
      </button>
      <button type="button" onClick={() => { pin.setMidiOpen(null); onBind(undefined); }}>
        Forget
      </button>
    </div>
  );
}

/**
 * What the control has been sending, raw, per input: shows at a glance how it codes its moves (positions climbing,
 * or the same step repeated) and whether another input sends the same CC — the two things that make a knob jump.
 */
function MidiMonitor({ binding, seen }: { binding: MidiBinding; seen: { port: string; value: number }[] }) {
  if (seen.length === 0) return <span className="viewport-param-hud-midi-monitor">Move the control to see what it sends</span>;
  const byPort = new Map<string, number[]>();
  for (const { port, value } of seen) byPort.set(port, [...(byPort.get(port) ?? []), value]);
  return (
    <span className="viewport-param-hud-midi-monitor">
      {[...byPort.entries()].map(([port, values]) => {
        const ignored = !!binding.port && binding.port !== port;
        return (
          <span key={port} className={ignored ? "ignored" : undefined} title={ignored ? "Another input sending the same CC — ignored" : undefined}>
            {port || "input"}: {values.slice(-MONITOR_LENGTH).join(" ")}
            {ignored ? " (ignored)" : ""}
          </span>
        );
      })}
    </span>
  );
}
