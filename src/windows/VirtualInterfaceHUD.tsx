import { useEffect, useState } from "react";
import { useEvaluatedResults } from "../shared/graph/playheadStore";
import { findNodeWithGraph, resolveDefinition } from "../shared/graph/groups";
import { connectedSocketIds, paramPanelValues } from "../shared/graph/paramPanelValues";
import { Graph, NodeInstance, NodeRegistry, ParamFieldDef } from "../shared/graph/types";
import {
  VI_ACCENT_COLOR,
  VI_KNOB_SIZE,
  ViAccent,
  ViRange,
  ViSize,
  defaultRange,
  rangeKey,
  storedRange,
} from "../shared/graph/nodes/virtualInterface";
import { selectChange, toDisplayUnit, toStoredUnit } from "./ParamPanel";
import { ColorPickerInput } from "./ColorPickerInput";
import { Knob, Selector, Switch } from "./LiveControls";
import "./virtual-interface.css";

type OnParamChange = (paramId: string | Record<string, unknown>, value?: unknown, targetNodeId?: string, options?: { coalesce?: boolean }) => void;

/**
 * The Virtual Interface node's HUD (see nodes/virtualInterface.ts): every pinned param as a control — a knob for a
 * number, a switch for an on/off, a stepped selector for a menu, a swatch for a colour. A wired param is shown but
 * dimmed: the wire is in charge of it. ✎ shows each knob's range to edit and the pins to take away; ⛶ fills the
 * window with the controls, bigger, for playing live (Esc to come back).
 */
export function VirtualInterfaceHUD({
  graph,
  registry,
  node,
  currentFrame,
  keyframesEnabled,
  onParamChange,
  onUnpin,
}: {
  graph: Graph;
  registry: NodeRegistry;
  node: NodeInstance;
  currentFrame: number;
  keyframesEnabled: boolean;
  onParamChange: OnParamChange;
  onUnpin?: (nodeId: string, paramId: string) => void;
}) {
  const evaluatedResults = useEvaluatedResults();
  const [editing, setEditing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  const p = node.params;
  const accent = VI_ACCENT_COLOR[(String(p.accent) as ViAccent) in VI_ACCENT_COLOR ? (String(p.accent) as ViAccent) : "theme"];
  const baseSize = VI_KNOB_SIZE[(String(p.size) as ViSize) in VI_KNOB_SIZE ? (String(p.size) as ViSize) : "M"];
  const knobSize = Math.round(baseSize * (fullscreen ? 2 : 1));
  const ranges = (p.ranges && typeof p.ranges === "object" ? p.ranges : {}) as Record<string, unknown>;
  const setRange = (key: string, r: ViRange) => onParamChange({ ranges: { ...ranges, [key]: r } }, node.id);
  const frame = keyframesEnabled ? currentFrame : undefined;

  const refs = graph.exposedParams ?? [];
  const byNode = new Map<string, typeof refs>();
  for (const ref of refs) {
    if (!byNode.has(ref.nodeId)) byNode.set(ref.nodeId, []);
    byNode.get(ref.nodeId)!.push(ref);
  }

  const groups = Array.from(byNode.entries()).map(([nodeId, nodeRefs]) => {
    const found = findNodeWithGraph(graph, nodeId);
    if (!found) return null;
    const { instance, graph: owningGraph } = found;
    const def = resolveDefinition(instance, registry);
    if (!def) return null;
    const fields = def.dynamicParamFields
      ? def.dynamicParamFields(instance, owningGraph.connections.filter((c) => c.toNode === nodeId || c.fromNode === nodeId))
      : (def.paramFields ?? []);
    const values = paramPanelValues(owningGraph, instance, def, evaluatedResults, frame);
    const wired = connectedSocketIds(owningGraph, nodeId);
    const name = String(instance.params.name ?? "") || def.label;

    const controls = nodeRefs.map((ref) => {
      const field = fields.find((f) => f.id === ref.paramId) as ParamFieldDef | undefined;
      if (!field) return null;
      const label = ref.label ?? field.label.replace(/\s*[(—].*$/, "");
      const disabled = wired.has(field.id);
      const title = `${def.label} · ${field.label}${disabled ? " — wired: the wire sets it" : ""}`;
      const set = (v: unknown) => onParamChange(field.id, v, nodeId);
      const key = rangeKey(nodeId, field.id);
      const unpin = editing && onUnpin && (
        <button type="button" className="vi-unpin" title="Unpin" onClick={() => onUnpin(nodeId, field.id)}>
          ×
        </button>
      );

      let control: React.ReactNode = null;
      if (field.kind === "number") {
        const value = toDisplayUnit(Number(values[field.id]) || 0, field.degrees, field.percent);
        const range = storedRange(ranges, key) ?? defaultRange(value, field);
        const fallback = def.defaultParams[field.id];
        control = (
          <>
            <Knob
              value={value}
              range={range}
              step={field.step && field.step >= 1 ? field.step : undefined}
              size={knobSize}
              accent={accent}
              label={label}
              unit={field.degrees ? "°" : field.percent ? "%" : undefined}
              disabled={disabled}
              title={`${title} — drag up/down (⇧ fine), wheel, double-click to reset`}
              onChange={(v) => set(toStoredUnit(v, field.degrees, field.percent))}
              onReset={typeof fallback === "number" ? () => set(fallback) : undefined}
            />
            {editing && <RangeEditor range={range} onChange={(r) => setRange(key, r)} />}
          </>
        );
      } else if (field.kind === "boolean") {
        control = <Switch on={!!values[field.id]} accent={accent} label={label} disabled={disabled} title={title} onChange={(on) => set(on ? 1 : 0)} />;
      } else if (field.kind === "select") {
        control = (
          <Selector
            value={String(values[field.id])}
            options={field.options}
            labels={field.optionLabels}
            accent={accent}
            label={label}
            disabled={disabled}
            title={title}
            onChange={(v) => {
              const change = selectChange(field, v);
              if (typeof change === "string") set(v);
              else onParamChange(change, nodeId);
            }}
          />
        );
      } else if (field.kind === "color") {
        control = (
          <div className={`vi-control vi-color${disabled ? " vi-disabled" : ""}`} title={title}>
            <ColorPickerInput value={values[field.id]} onChange={set} />
            <span className="vi-label">{label}</span>
          </div>
        );
      } else {
        control = (
          <div className="vi-control vi-unsupported" title={`${title} — no live control for this kind of param yet`}>
            <span className="vi-value">—</span>
            <span className="vi-label">{label}</span>
          </div>
        );
      }
      return (
        <div className="vi-cell" key={field.id}>
          {unpin}
          {control}
        </div>
      );
    });
    return (
      <section className="vi-group" key={nodeId}>
        <header>{name}</header>
        <div className="vi-row">{controls}</div>
      </section>
    );
  });

  return (
    <div className={`vi-panel${fullscreen ? " vi-fullscreen" : ""}`} style={{ ["--vi-accent" as string]: accent }}>
      <div className="vi-titlebar">
        <span className="vi-title">{String(p.title ?? "") || "Virtual Interface"}</span>
        <button type="button" className={editing ? "vi-on" : ""} title="Edit: knob ranges, unpin" onClick={() => setEditing((v) => !v)}>
          ✎
        </button>
        <button type="button" title={fullscreen ? "Leave (Esc)" : "Fill the window, for playing live"} onClick={() => setFullscreen((v) => !v)}>
          {fullscreen ? "⤡" : "⛶"}
        </button>
        {!fullscreen && (
          <button type="button" title={collapsed ? "Show" : "Hide"} onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? "▸" : "▾"}
          </button>
        )}
      </div>
      {(!collapsed || fullscreen) && (
        <div className="vi-body">
          {refs.length === 0 ? <p className="vi-empty">Pin params from the param panel (the pin beside each one) to play them here.</p> : groups}
        </div>
      )}
    </div>
  );
}

function RangeEditor({ range, onChange }: { range: ViRange; onChange: (r: ViRange) => void }) {
  const [min, max] = range;
  const commit = (i: 0 | 1, text: string) => {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v)) return;
    const next: ViRange = i === 0 ? [v, max] : [min, v];
    if (next[1] > next[0]) onChange(next);
  };
  return (
    <div className="vi-range" title="The knob's range: left is all the way down, right all the way up">
      {([0, 1] as const).map((i) => (
        <input
          key={`${i}:${range[i]}`}
          defaultValue={String(range[i])}
          aria-label={i === 0 ? "Minimum" : "Maximum"}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => commit(i, e.target.value)}
        />
      ))}
    </div>
  );
}
