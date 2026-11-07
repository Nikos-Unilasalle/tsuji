import { Fragment, useState } from "react";
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
import { MidiBinding, isBindable } from "../shared/graph/midiBinding";
import { MidiCcButton, MidiSettings, PinMidiRow, usePinMidi } from "./PinMidi";
import { resolveExposedField } from "../shared/graph/exposedComponent";
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
 * turn the knob. Learned, it names the control; click it for the encoder coding, a number's step a notch, Relearn and
 * Forget (PinMidi.tsx). Moving the control then sets the param, one undo step a gesture (App's
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
  const midiRows: PinMidiRow[] = [];
  const pin = usePinMidi(midiRows, onChange, onBindMidi);

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
        const resolved = resolveExposedField(fields, values, ref.paramId);
        if (resolved && isBindable(resolved.field)) {
          const { field, baseId, value, toStored } = resolved;
          midiRows.push({ key: `${nodeId}:${ref.paramId}`, nodeId, paramId: ref.paramId, field, baseId, value, toStored, midi: ref.midi });
        }
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
                  const resolved = resolveExposedField(fields, values, ref.paramId);
                  if (!resolved) return null;
                  const field: ParamFieldDef = resolved.field;
                  // An axis keys as "position.y", the key ParamPanel's vector shows its status by too.
                  const status = keyframesEnabled ? getKeyframeStatus(keyframes, nodeId, field.id, currentFrame) : "none";
                  const value = resolved.value;
                  const set = (v: unknown) => onChange(resolved.baseId, resolved.toStored(v), nodeId);

                  const key = `${nodeId}:${ref.paramId}`;
                  const isEditing = editingKey === key;
                  const commitRename = () => {
                    setEditingKey(null);
                    if (onRename) onRename(nodeId, ref.paramId, editingValue);
                  };

                  const bindable = onBindMidi && isBindable(field) ? field : null;
                  const midi = ref.midi;

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
                            value={toDisplayUnit(Number(value) || 0, field.degrees, field.percent)}
                            step={field.step}
                            status={status}
                            onChange={(v) => set(toStoredUnit(v, field.degrees, field.percent))}
                          />
                        )}
                        {field.kind === "vector" &&
                          vectorField(
                            field,
                            value,
                            (v) => set(v),
                            nodeId,
                            keyframes,
                            currentFrame,
                            keyframesEnabled,
                            () => {},
                          )}
                        {field.kind === "boolean" &&
                          booleanField(value, (v) => set(v))}
                        {field.kind === "select" &&
                          selectField(field, value, (v) => set(v))}
                        {field.kind === "color" && (
                          <ColorPickerInput value={value} onChange={(v) => set(v)} />
                        )}
                      </div>
                      {bindable && <MidiCcButton pin={pin} rowKey={key} midi={midi} />}
                      <button
                        type="button"
                        className="viewport-param-hud-unpin"
                        title="Unpin"
                        onClick={() => onUnpin(nodeId, ref.paramId)}
                      >
                        ×
                      </button>
                    </div>
                    {bindable && midi && pin.midiOpen === key && (
                      <MidiSettings pin={pin} rowKey={key} field={bindable} midi={midi} value={value} onBind={(m) => onBindMidi?.(nodeId, ref.paramId, m)} />
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
