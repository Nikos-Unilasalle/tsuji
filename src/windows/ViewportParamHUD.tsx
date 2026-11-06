import { Fragment, useEffect, useRef, useState } from "react";
import { useEvaluatedResults } from "../shared/graph/playheadStore";
import { findNodeWithGraph, resolveDefinition } from "../shared/graph/groups";
import { paramPanelValues } from "../shared/graph/paramPanelValues";
import { Graph, KeyframeStore, NodeRegistry, ParamFieldDef } from "../shared/graph/types";
import {
  booleanField,
  getKeyframeStatus,
  selectField,
  toDisplayUnit,
  toStoredUnit,
  vectorField,
} from "./ParamPanel";
import { ColorPickerInput } from "./ColorPickerInput";
import { DragNumberInput } from "./DragNumberInput";
import { subscribeMidi } from "../shared/graph/midiRuntime";
import { BindableField, CC_MODE_LABELS, CcMode, MidiBinding, applyCc, bindingMatches, bindingName, detectMode, isBindable, learnBinding, modesFor } from "../shared/graph/midiBinding";
import "./viewport-param-hud.css";

interface ViewportParamHUDProps {
  graph: Graph;
  registry: NodeRegistry;
  keyframes?: KeyframeStore;
  currentFrame: number;
  keyframesEnabled: boolean;
  onChange: (paramId: string, value: unknown, targetNodeId?: string) => void;
  onUnpin: (nodeId: string, paramId: string) => void;
  onRename?: (nodeId: string, paramId: string, label: string) => void;
  /** Learns (or forgets, undefined) the MIDI control driving a pin. */
  onBindMidi?: (nodeId: string, paramId: string, midi: MidiBinding | undefined) => void;
}

/** A pinned row as the MIDI handler needs it: read between renders, so kept in a ref. */
interface MidiRow {
  key: string;
  nodeId: string;
  field: BindableField;
  value: unknown;
  midi?: MidiBinding;
}

/** How long a value MIDI wrote wins over the rendered one: an encoder turns faster than the graph re-renders. */
const WRITTEN_MS = 250;
/** Learning listens this long after the first move: long enough to hear how the control sends (detectMode). */
const LEARN_MS = 600;
/** The raw values the settings show, per control. */
const MONITOR_LENGTH = 10;

/**
 * Houdini-style pinned viewport HUD: a hand-picked set of (nodeId, paramId)
 * pairs, always visible regardless of what's currently selected in the
 * graph. Pins are toggled from ParamPanel's per-row pin button.
 *
 * Deliberately not a reuse of ParamPanel's own group-switch rendering — that
 * machinery is entangled with keyframe-hover state, group headers, and axis
 * "use" checkboxes that don't belong in a terse, always-on HUD row. Only the
 * pure per-kind renderers are shared.
 *
 * MIDI: the small CC button on a number, switch or menu row learns a controller's knob, fader or button — click it,
 * move the control. Learned, it names the control; click it for the mode (absolute or one of the encoder codings), a
 * number's range, Relearn and Forget. Moving the control then sets the param, one undo step a gesture (App's
 * coalescing), keyed when keyframes are on — so turning a knob while playing records automation.
 */
export function ViewportParamHUD({
  graph,
  registry,
  keyframes,
  currentFrame,
  keyframesEnabled,
  onChange,
  onUnpin,
  onRename,
  onBindMidi,
}: ViewportParamHUDProps) {
  // Subscribed here, not passed down: the viewport above re-rendering on
  // every evaluated frame just to forward these would cost far more than
  // this small panel re-rendering on its own.
  const evaluatedResults = useEvaluatedResults();
  const [collapsed, setCollapsed] = useState(false);
  // Which row's label is mid-edit — at most one at a time, keyed by
  // "nodeId:paramId" since paramId alone collides across pinned nodes.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  /** The row waiting for a control to be moved, and the row whose MIDI settings are open ("nodeId:paramId"). */
  const [learning, setLearning] = useState<string | null>(null);
  const [midiOpen, setMidiOpen] = useState<string | null>(null);
  const midiRows = useRef<MidiRow[]>([]);
  midiRows.current = [];
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
    const row = c && midiRows.current.find((r) => r.key === c.key);
    if (!c || !row || !onBindMidi) return;
    const binding = learnBinding(row.field, c.channel, c.cc, row.value, c.port || undefined);
    const detected = row.field.kind === "boolean" ? null : detectMode(c.values);
    if (detected && modesFor(row.field).includes(detected)) binding.mode = detected;
    onBindMidi(row.nodeId, row.field.id, binding);
  };
  const finishLearnRef = useRef(finishLearn);
  finishLearnRef.current = finishLearn;
  const written = useRef(new Map<string, { value: unknown; at: number }>());
  const handleMidi = useRef<(e: Parameters<Parameters<typeof subscribeMidi>[0]>[0]) => void>(() => {});
  handleMidi.current = (e) => {
    if (e.type !== "cc") return;
    const control = `${e.port}:${e.channel}:${e.controller}`;
    const previous = lastCc.current.get(control);
    lastCc.current.set(control, e.value);
    const seen = recent.current.get(`${e.channel}:${e.controller}`) ?? [];
    seen.push({ port: e.port, value: e.value });
    recent.current.set(`${e.channel}:${e.controller}`, seen.slice(-MONITOR_LENGTH * 2));
    const open = midiOpen ? midiRows.current.find((r) => r.key === midiOpen)?.midi : undefined;
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
    for (const row of midiRows.current) {
      if (!row.midi || !bindingMatches(row.midi, e.port, e.channel, e.controller)) continue;
      const w = written.current.get(row.key);
      const current = w && now - w.at < WRITTEN_MS ? w.value : row.value;
      const next = applyCc(row.field, row.midi, e.value, current, previous);
      if (next === undefined || next === current) continue;
      written.current.set(row.key, { value: next, at: now });
      onChange(row.field.id, next, row.nodeId);
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

  const refs = graph.exposedParams ?? [];
  if (refs.length === 0) return null;

  const byNode = new Map<string, typeof refs>();
  for (const ref of refs) {
    if (!byNode.has(ref.nodeId)) byNode.set(ref.nodeId, []);
    byNode.get(ref.nodeId)!.push(ref);
  }

  const frame = keyframesEnabled ? currentFrame : undefined;

  // Each pinned node, resolved once: for the rows, and for MIDI even while the panel is collapsed.
  const nodes = Array.from(byNode.entries()).flatMap(([nodeId, nodeRefs]) => {
    // Deep: a param stays pinned when its node is grouped — the pin
    // is on the node, and grouping doesn't move the node anywhere the
    // HUD can't follow. The level that holds it supplies the
    // connections paramPanelValues reads.
    const found = findNodeWithGraph(graph, nodeId);
    if (!found) return [];
    const { instance, graph: owningGraph } = found;
    const def = resolveDefinition(instance, registry);
    if (!def) return [];
    const fields = def.dynamicParamFields
      ? def.dynamicParamFields(instance, owningGraph.connections.filter((c) => c.toNode === nodeId || c.fromNode === nodeId))
      : (def.paramFields ?? []);
    const values = paramPanelValues(owningGraph, instance, def, evaluatedResults, frame);
    if (onBindMidi) {
      for (const ref of nodeRefs) {
        const field = fields.find((f) => f.id === ref.paramId);
        if (field && isBindable(field)) midiRows.current.push({ key: `${nodeId}:${ref.paramId}`, nodeId, field, value: values[field.id], midi: ref.midi });
      }
    }
    return [{ nodeId, nodeRefs, def, fields, values }];
  });

  return (
    <div className="viewport-param-hud">
      <div className="viewport-param-hud-titlebar">
        <span>Pinned Params</span>
        <button type="button" className="viewport-param-hud-collapse" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? "▸" : "▾"}
        </button>
      </div>
      {!collapsed && (
        <div className="viewport-param-hud-body">
          {nodes.map(({ nodeId, nodeRefs, def, fields, values }) => {
            const showNodeHeader = nodeRefs.length > 1;

            return (
              <div className="viewport-param-hud-node" key={nodeId}>
                {showNodeHeader && <div className="viewport-param-hud-node-name">{def.label}</div>}
                {nodeRefs.map((ref) => {
                  const field = fields.find((f) => f.id === ref.paramId) as ParamFieldDef | undefined;
                  if (!field) return null;
                  const status = keyframesEnabled ? getKeyframeStatus(keyframes, nodeId, field.id, currentFrame) : "none";

                  const key = `${nodeId}:${ref.paramId}`;
                  const isEditing = editingKey === key;
                  const commitRename = () => {
                    setEditingKey(null);
                    if (onRename) onRename(nodeId, ref.paramId, editingValue);
                  };

                  const bindable = onBindMidi && isBindable(field) ? field : null;
                  const midi = ref.midi;
                  const setMidi = (patch: Partial<MidiBinding>) => midi && onBindMidi?.(nodeId, ref.paramId, { ...midi, ...patch });

                  return (
                    <Fragment key={field.id}>
                    <div className="viewport-param-hud-row">
                      {isEditing ? (
                        <input
                          className="viewport-param-hud-label-edit"
                          autoFocus
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setEditingKey(null);
                          }}
                        />
                      ) : (
                        <label
                          title={onRename ? "Click to rename" : undefined}
                          onClick={() => {
                            if (!onRename) return;
                            setEditingValue(ref.label ?? field.label);
                            setEditingKey(key);
                          }}
                        >
                          {ref.label ?? field.label}
                        </label>
                      )}
                      <div className="viewport-param-hud-control">
                        {field.kind === "number" && (
                          <DragNumberInput
                            value={toDisplayUnit(Number(values[field.id]) || 0, field.degrees, field.percent)}
                            step={field.step}
                            status={status}
                            onChange={(v) => onChange(field.id, toStoredUnit(v, field.degrees, field.percent), nodeId)}
                          />
                        )}
                        {field.kind === "vector" &&
                          vectorField(
                            field,
                            values[field.id],
                            (v) => onChange(field.id, v, nodeId),
                            nodeId,
                            keyframes,
                            currentFrame,
                            keyframesEnabled,
                            () => {},
                          )}
                        {field.kind === "boolean" &&
                          booleanField(values[field.id], (v) => onChange(field.id, v, nodeId))}
                        {field.kind === "select" &&
                          selectField(field, values[field.id], (v) => onChange(field.id, v, nodeId))}
                        {field.kind === "color" && (
                          <ColorPickerInput value={values[field.id]} onChange={(v) => onChange(field.id, v, nodeId)} />
                        )}
                      </div>
                      {bindable && (
                        <button
                          type="button"
                          className={`viewport-param-hud-midi${midi ? " bound" : ""}${learning === key ? " learning" : ""}`}
                          title={
                            learning === key
                              ? "Turn a knob or fader a little (or press a button) on your MIDI controller — how it sends is detected (click or Esc to cancel)"
                              : midi
                                ? `MIDI: ${bindingName(midi)}${midi.port ? ` on ${midi.port}` : ""}, ${CC_MODE_LABELS[midi.mode]} — click for its settings`
                                : "Learn a MIDI control: click, then move a knob, fader or button"
                          }
                          onClick={() => {
                            if (learning === key) return setLearning(null);
                            if (midi) return setMidiOpen((k) => (k === key ? null : key));
                            setLearning(key);
                          }}
                        >
                          {learning === key ? "…" : midi ? midi.cc : "CC"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="viewport-param-hud-unpin"
                        title="Unpin"
                        onClick={() => onUnpin(nodeId, ref.paramId)}
                      >
                        ×
                      </button>
                    </div>
                    {bindable && midi && midiOpen === key && (
                      <div className="viewport-param-hud-midi-settings">
                        <span className="viewport-param-hud-midi-name" title={midi.port ? `Only from ${midi.port}` : "From any MIDI input"}>
                          {bindingName(midi)}
                          {midi.port ? ` · ${midi.port}` : ""}
                        </span>
                        <select value={midi.mode} onChange={(e) => setMidi({ mode: e.target.value as CcMode })} title="How the control sends its moves">
                          {modesFor(bindable).map((m) => (
                            <option key={m} value={m}>
                              {CC_MODE_LABELS[m]}
                            </option>
                          ))}
                        </select>
                        {bindable.kind === "number" && (
                          <span className="viewport-param-hud-midi-range" title="The range the control sweeps (in stored units)">
                            <DragNumberInput value={midi.min ?? 0} step={field.kind === "number" ? field.step : undefined} onChange={(v) => setMidi({ min: v })} />
                            <span>→</span>
                            <DragNumberInput value={midi.max ?? 1} step={field.kind === "number" ? field.step : undefined} onChange={(v) => setMidi({ max: v })} />
                          </span>
                        )}
                        <MidiMonitor binding={midi} seen={recent.current.get(`${midi.channel}:${midi.cc}`) ?? []} />
                        <button type="button" onClick={() => { setMidiOpen(null); setLearning(key); }}>
                          Relearn
                        </button>
                        <button type="button" onClick={() => { setMidiOpen(null); onBindMidi?.(nodeId, ref.paramId, undefined); }}>
                          Forget
                        </button>
                      </div>
                    )}
                    </Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
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
