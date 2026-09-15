import { useState } from "react";
import { EvalResult } from "../shared/graph/evaluate";
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
import "./viewport-param-hud.css";

interface ViewportParamHUDProps {
  graph: Graph;
  registry: NodeRegistry;
  evaluatedResults: EvalResult | null;
  keyframes?: KeyframeStore;
  currentFrame: number;
  keyframesEnabled: boolean;
  onChange: (paramId: string, value: unknown, targetNodeId?: string) => void;
  onUnpin: (nodeId: string, paramId: string) => void;
  onRename?: (nodeId: string, paramId: string, label: string) => void;
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
 */
export function ViewportParamHUD({
  graph,
  registry,
  evaluatedResults,
  keyframes,
  currentFrame,
  keyframesEnabled,
  onChange,
  onUnpin,
  onRename,
}: ViewportParamHUDProps) {
  const [collapsed, setCollapsed] = useState(false);
  // Which row's label is mid-edit — at most one at a time, keyed by
  // "nodeId:paramId" since paramId alone collides across pinned nodes.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const refs = graph.exposedParams ?? [];
  if (refs.length === 0) return null;

  const byNode = new Map<string, typeof refs>();
  for (const ref of refs) {
    if (!byNode.has(ref.nodeId)) byNode.set(ref.nodeId, []);
    byNode.get(ref.nodeId)!.push(ref);
  }

  const frame = keyframesEnabled ? currentFrame : undefined;

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
          {Array.from(byNode.entries()).map(([nodeId, nodeRefs]) => {
            // Deep: a param stays pinned when its node is grouped — the pin
            // is on the node, and grouping doesn't move the node anywhere the
            // HUD can't follow. The level that holds it supplies the
            // connections paramPanelValues reads.
            const found = findNodeWithGraph(graph, nodeId);
            if (!found) return null;
            const { instance, graph: owningGraph } = found;
            const def = resolveDefinition(instance, registry);
            if (!def) return null;
            const fields = def.dynamicParamFields ? def.dynamicParamFields(instance) : (def.paramFields ?? []);
            const values = paramPanelValues(owningGraph, instance, def, evaluatedResults, frame);
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

                  return (
                    <div className="viewport-param-hud-row" key={field.id}>
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
                      <button
                        type="button"
                        className="viewport-param-hud-unpin"
                        title="Unpin"
                        onClick={() => onUnpin(nodeId, ref.paramId)}
                      >
                        ×
                      </button>
                    </div>
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
