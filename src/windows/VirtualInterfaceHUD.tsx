import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useEvaluatedResults } from "../shared/graph/playheadStore";
import { findNodeWithGraph, resolveDefinition } from "../shared/graph/groups";
import { connectedSocketIds, paramPanelValues } from "../shared/graph/paramPanelValues";
import { Graph, NodeInstance, NodeRegistry, ParamFieldDef } from "../shared/graph/types";
import {
  VI_ACCENT_COLOR,
  VI_KNOB_SIZE,
  ViAccent,
  ViAxis,
  ViRange,
  ViSize,
  defaultRange,
  linkedVector,
  vectorAxisRange,
  rangeKey,
  storedRange,
} from "../shared/graph/nodes/virtualInterface";
import { parseVector3, selectChange, toDisplayUnit, toStoredUnit } from "./ParamPanel";
import { ColorPickerInput } from "./ColorPickerInput";
import { Knob, Selector, Switch } from "./LiveControls";
import "./virtual-interface.css";

type OnParamChange = (paramId: string | Record<string, unknown>, value?: unknown, targetNodeId?: string, options?: { coalesce?: boolean }) => void;

/**
 * The Virtual Interface node's HUD (see nodes/virtualInterface.ts): every pinned param as a control — a knob for a
 * number, a switch for an on/off, a stepped selector for a menu, a swatch for a colour, and for a vector a knob per
 * axis — tinted X red, Y green, Z blue as the gizmo is — with a link that turns them together. A wired param is shown but
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
  const linked = (p.linked && typeof p.linked === "object" ? p.linked : {}) as Record<string, unknown>;
  const setLinked = (key: string, on: boolean) => onParamChange({ linked: { ...linked, [key]: on } }, node.id);
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
      } else if (field.kind === "vector") {
        control = (
          <VectorModule
            field={field}
            value={values[field.id]}
            fallback={def.defaultParams[field.id]}
            rangeKeyBase={key}
            ranges={ranges}
            linked={!!linked[key]}
            editing={editing}
            knobSize={Math.round(knobSize * 0.72)}
            label={label}
            title={title}
            disabled={disabled}
            onChange={set}
            onLink={(on) => setLinked(key, on)}
            onRange={setRange}
          />
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

const AXIS_COLOR: Record<ViAxis, string> = { x: "#f87171", y: "#4ade80", z: "#60a5fa" };

/** A vector: a knob per axis, side by side under one name, and a link that turns them all together. */
function VectorModule({
  field,
  value,
  fallback,
  rangeKeyBase,
  ranges,
  linked,
  editing,
  knobSize,
  label,
  title,
  disabled,
  onChange,
  onLink,
  onRange,
}: {
  field: ParamFieldDef & { kind: "vector" };
  value: unknown;
  fallback: unknown;
  rangeKeyBase: string;
  ranges: Record<string, unknown>;
  linked: boolean;
  editing: boolean;
  knobSize: number;
  label: string;
  title: string;
  disabled: boolean;
  onChange: (v: unknown) => void;
  onLink: (on: boolean) => void;
  onRange: (key: string, r: ViRange) => void;
}) {
  // A 2-value vector (a Vector2, {x, y}, [x, y]) keeps its shape.
  const is2D =
    value instanceof THREE.Vector2 ||
    (!!value && typeof value === "object" && "x" in value && "y" in value && !("z" in value)) ||
    (Array.isArray(value) && value.length === 2);
  const axes: ViAxis[] = is2D ? ["x", "y"] : ["x", "y", "z"];
  const v = parseVector3(value);
  const shown = { x: toDisplayUnit(v.x, field.degrees), y: toDisplayUnit(v.y, field.degrees), z: toDisplayUnit(v.z, field.degrees) };
  const start = useRef<Record<ViAxis, number> | null>(null);

  const write = (d: Record<ViAxis, number>) => {
    const x = toStoredUnit(d.x, field.degrees);
    const y = toStoredUnit(d.y, field.degrees);
    const z = toStoredUnit(d.z, field.degrees);
    if (!is2D) onChange(new THREE.Vector3(x, y, z));
    else if (value instanceof THREE.Vector2) onChange(new THREE.Vector2(x, y));
    else if (Array.isArray(value)) onChange([x, y]);
    else onChange({ x, y });
  };
  const turn = (axis: ViAxis, next: number) => write(linked ? linkedVector(start.current ?? shown, axis, next, axes) : { ...shown, [axis]: next });
  const home = fallback !== undefined ? parseVector3(fallback) : null;

  return (
    <div className={`vi-control vi-vector${disabled ? " vi-disabled" : ""}`} title={title}>
      <div className="vi-vector-knobs">
        {axes.map((axis) => {
          const key = `${rangeKeyBase}.${axis}`;
          const range = storedRange(ranges, key) ?? vectorAxisRange(shown[axis], field);
          return (
            <div className="vi-vector-axis" key={axis}>
              <Knob
                compact
                value={shown[axis]}
                range={range}
                step={field.step && field.step >= 1 ? field.step : undefined}
                size={knobSize}
                accent={AXIS_COLOR[axis]}
                label={axis.toUpperCase()}
                unit={field.degrees ? "°" : undefined}
                disabled={disabled}
                title={`${title} · ${axis.toUpperCase()} — drag up/down (⇧ fine), wheel, double-click to reset${linked ? "; linked: every axis follows" : ""}`}
                onDragStart={() => (start.current = { ...shown })}
                onChange={(n) => turn(axis, n)}
                onReset={home ? () => write({ ...shown, [axis]: toDisplayUnit(home[axis], field.degrees) }) : undefined}
              />
              {editing && <RangeEditor range={range} onChange={(r) => onRange(key, r)} />}
            </div>
          );
        })}
      </div>
      <div className="vi-vector-name">
        <button
          type="button"
          className={`vi-link${linked ? " vi-on" : ""}`}
          aria-pressed={linked}
          title={linked ? "Linked: turning one axis moves them all — click to unlink" : "Link the axes: turning one moves them all (a uniform scale)"}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onLink(!linked)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M6.5 9.5l3-3" />
            <path d="M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2" />
            <path d="M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" />
          </svg>
        </button>
        <span className="vi-label">{label}</span>
      </div>
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
