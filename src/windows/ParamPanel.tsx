import { isKeyReservedForPlayback } from "../shared/graph/playbackKeys";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import * as THREE from "three";
import { isTauri } from "../shared/graph/storage";
import { CATEGORY_COLOR, NodeCategory, UNKNOWN_CATEGORY_COLOR } from "../shared/graph/categories";
import { KeyframeStore, ParamFieldDef } from "../shared/graph/types";
import { ColorPickerInput } from "./ColorPickerInput";
import { CurveProfileEditor } from "./CurveProfileEditor";
import { ColorRampEditor } from "./ColorRampEditor";
import { DragNumberInput } from "./DragNumberInput";
import "./param-panel.css";

interface ParamPanelProps {
  nodeId: string;
  label: string;
  category?: NodeCategory;
  fields: ParamFieldDef[];
  params: Record<string, unknown>;
  keyframes?: KeyframeStore;
  currentFrame?: number;
  keyframesEnabled?: boolean;
  onChange: (paramId: string, value: unknown) => void;
  onToggleKeyframe?: (nodeId: string, paramKey: string, frame: number, currentValue: any) => void;
  /** Fired by a "button" field — see ParamFieldDef. */
  onAction?: (nodeId: string, action: string) => void;
  /**
   * Input sockets of this node that have a wire in them. Such a field shows
   * the value arriving through the wire, not the param under it, so it is
   * marked and made non-interactive: editing it would look like it worked
   * and be overwritten on the next evaluation.
   */
  connectedSockets?: Set<string>;
  /**
   * Whether this node produces geometry that Freeze can snapshot. Computed by
   * the caller, which has the node *definition* — the panel only ever sees a
   * flat field list, so it cannot tell an object node from a maths one.
   */
  canFreeze?: boolean;
  /** Fired by the Freeze button; carries FREEZE_GEOMETRY_ACTION like any other action. */
  onFreeze?: (nodeId: string) => void;
  /** paramIds of *this* node currently pinned to the viewport HUD — for the pin button's active state. */
  exposedKeys?: Set<string>;
  onToggleExposed?: (nodeId: string, paramId: string) => void;
}

export type KeyframeStatus = "none" | "exact" | "interpolated";

export function getKeyframeStatus(
  keyframes: KeyframeStore | undefined,
  nodeId: string,
  paramKey: string,
  currentFrame: number | undefined,
): KeyframeStatus {
  if (!keyframes || currentFrame === undefined || currentFrame < 0) return "none";
  const list = keyframes[nodeId]?.[paramKey];
  if (!list || list.length === 0) return "none";
  if (list.some((k) => k.frame === currentFrame)) return "exact";
  return "interpolated";
}

/** Field kinds simple enough to render as a compact HUD row — see ViewportParamHUD. */
export const EXPOSABLE_KINDS = new Set(["number", "vector", "boolean", "select", "color"]);

export function booleanField(value: unknown, onChange: (v: unknown) => void) {
  return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />;
}

export function selectField(field: ParamFieldDef & { kind: "select" }, value: unknown, onChange: (v: unknown) => void) {
  return (
    <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
      {field.options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function fileField(nodeId: string, field: ParamFieldDef & { kind: "file" }, value: unknown, onChange: (v: unknown) => void) {
  const hasFile = typeof value === "string" && value.length > 0;
  const fileName = hasFile ? (value.split(/[\\/]/).pop() ?? value) : "Choose file…";

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    field.onLoaded?.(nodeId, "", "");
    onChange("");
  };

  return (
    <div className="param-file-container">
      <button
        type="button"
        className="param-file-button"
        onClick={async () => {
          const rawExtensions = field.accept?.map((ext) => ext.replace(/^\./, "")) ?? [];
          const acceptAttr = field.accept?.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`)).join(",");

          if (!isTauri()) {
            const input = document.createElement("input");
            input.type = "file";
            if (acceptAttr) input.accept = acceptAttr;
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              const path = file.name;
              const ext = path.split(".").pop()?.toLowerCase() ?? "";
              const isBinary = [
                "png", "jpg", "jpeg", "webp", "bmp", "hdr", "exr", "tif", "tiff",
                "mp3", "wav", "ogg", "flac", "m4a", "aac", "glb", "ply",
              ].includes(ext);

              if (isBinary) {
                const buffer = await file.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                field.onLoaded?.(nodeId, path, bytes);
              } else {
                const content = await file.text();
                field.onLoaded?.(nodeId, path, content);
              }
              onChange(path);
            };
            input.click();
            return;
          }

          try {
            const path = await open({
              multiple: false,
              filters: rawExtensions.length ? [{ name: "File", extensions: rawExtensions }] : undefined,
            });
            if (!path || Array.isArray(path)) return;
            const ext = path.split(".").pop()?.toLowerCase() ?? "";
            const isBinary = [
              "png", "jpg", "jpeg", "webp", "bmp", "hdr", "exr", "tif", "tiff",
              "mp3", "wav", "ogg", "flac", "m4a", "aac", "glb", "ply",
            ].includes(ext);

            if (isBinary) {
              const bytes = await readFile(path);
              field.onLoaded?.(nodeId, path, bytes);
            } else {
              const content = await readTextFile(path);
              field.onLoaded?.(nodeId, path, content);
            }
            onChange(path);
          } catch (err) {
            console.warn("Tauri dialog error, falling back to browser picker:", err);
            const input = document.createElement("input");
            input.type = "file";
            if (acceptAttr) input.accept = acceptAttr;
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              const path = file.name;
              const ext = path.split(".").pop()?.toLowerCase() ?? "";
              const isBinary = [
                "png", "jpg", "jpeg", "webp", "bmp", "hdr", "exr", "tif", "tiff",
                "mp3", "wav", "ogg", "flac", "m4a", "aac", "glb", "ply",
              ].includes(ext);

              if (isBinary) {
                const buffer = await file.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                field.onLoaded?.(nodeId, path, bytes);
              } else {
                const content = await file.text();
                field.onLoaded?.(nodeId, path, content);
              }
              onChange(path);
            };
            input.click();
          }
        }}
      >
        {fileName}
      </button>
      {hasFile && (
        <button
          type="button"
          className="param-file-clear-button"
          onClick={handleClear}
          title="Remove file / texture"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

const RAD_TO_DEG = 180 / Math.PI;

export function toDisplayUnit(value: number, degrees?: boolean, percent?: boolean): number {
  if (degrees) return value * RAD_TO_DEG;
  if (percent) return value * 100;
  return value;
}

export function toStoredUnit(value: number, degrees?: boolean, percent?: boolean): number {
  if (degrees) return value / RAD_TO_DEG;
  if (percent) return value / 100;
  return value;
}

export function parseVector3(value: unknown): THREE.Vector3 {
  if (value instanceof THREE.Vector3) return value.clone();
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const x = Number(obj.x);
    const y = Number(obj.y);
    const z = Number(obj.z);
    return new THREE.Vector3(
      Number.isFinite(x) ? x : 0,
      Number.isFinite(y) ? y : 0,
      Number.isFinite(z) ? z : 0
    );
  }
  if (Array.isArray(value)) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    return new THREE.Vector3(
      Number.isFinite(x) ? x : 0,
      Number.isFinite(y) ? y : 0,
      Number.isFinite(z) ? z : 0
    );
  }
  return new THREE.Vector3(0, 0, 0);
}

interface VectorFieldControlProps {
  field: ParamFieldDef & { kind: "vector" };
  value: unknown;
  onChange: (v: unknown) => void;
  nodeId: string;
  keyframes: KeyframeStore | undefined;
  currentFrame: number | undefined;
  keyframesEnabled: boolean;
  onHoverKey: (key: string | null) => void;
}

export function VectorFieldControl({
  field,
  value,
  onChange,
  nodeId,
  keyframes,
  currentFrame,
  keyframesEnabled,
  onHoverKey,
}: VectorFieldControlProps) {
  const is2D =
    (value instanceof THREE.Vector2) ||
    (value && typeof value === "object" && "x" in value && "y" in value && !("z" in value)) ||
    (Array.isArray(value) && value.length === 2);

  const axes: ("x" | "y" | "z")[] = is2D ? ["x", "y"] : ["x", "y", "z"];
  const v = parseVector3(value);

  // Snapshot of vector components in display units captured when dragging begins
  const startVectorRef = useRef<Record<string, number> | null>(null);

  const handleDragStart = () => {
    const snap: Record<string, number> = {};
    for (const k of axes) {
      snap[k] = toDisplayUnit(v[k], field.degrees);
    }
    startVectorRef.current = snap;
  };

  const handleDragEnd = () => {
    startVectorRef.current = null;
  };

  return (
    <div className="param-vector">
      {axes.map((axisKey) => {
        const fullKey = `${field.id}.${axisKey}`;
        const status = keyframesEnabled ? getKeyframeStatus(keyframes, nodeId, fullKey, currentFrame) : "none";
        return (
          <DragNumberInput
            key={axisKey}
            value={toDisplayUnit(v[axisKey], field.degrees)}
            step={field.step}
            status={status}
            isVector={true}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onMouseEnter={() => onHoverKey(fullKey)}
            onMouseLeave={() => onHoverKey(null)}
            onChange={(next, meta) => {
              if (meta?.isDrag && meta.shiftKey) {
                const startSnap = startVectorRef.current ?? {
                  x: toDisplayUnit(v.x, field.degrees),
                  y: toDisplayUnit(v.y, field.degrees),
                  z: toDisplayUnit(v.z, field.degrees),
                };
                const startVal = startSnap[axisKey] ?? 0;
                const updated = v.clone();

                if (Math.abs(startVal) > 1e-7) {
                  // Proportional scale to preserve ratio
                  const factor = next / startVal;
                  for (const k of axes) {
                    const disp = k === axisKey ? next : startSnap[k] * factor;
                    updated[k] = toStoredUnit(disp, field.degrees);
                  }
                } else {
                  // Start value was 0: apply delta uniformly
                  const delta = next - startVal;
                  for (const k of axes) {
                    const disp = k === axisKey ? next : startSnap[k] + delta;
                    updated[k] = toStoredUnit(disp, field.degrees);
                  }
                }

                if (is2D) {
                  if (value instanceof THREE.Vector2) onChange(new THREE.Vector2(updated.x, updated.y));
                  else if (Array.isArray(value)) onChange([updated.x, updated.y]);
                  else onChange({ x: updated.x, y: updated.y });
                } else {
                  onChange(updated);
                }
              } else {
                const updated = v.clone();
                updated[axisKey] = toStoredUnit(next, field.degrees);
                if (is2D) {
                  if (value instanceof THREE.Vector2) onChange(new THREE.Vector2(updated.x, updated.y));
                  else if (Array.isArray(value)) onChange([updated.x, updated.y]);
                  else onChange({ x: updated.x, y: updated.y });
                } else {
                  onChange(updated);
                }
              }
            }}
          />
        );
      })}
    </div>
  );
}

export function vectorField(
  field: ParamFieldDef & { kind: "vector" },
  value: unknown,
  onChange: (v: unknown) => void,
  nodeId: string,
  keyframes: KeyframeStore | undefined,
  currentFrame: number | undefined,
  keyframesEnabled: boolean,
  onHoverKey: (key: string | null) => void,
) {
  return (
    <VectorFieldControl
      key={field.id}
      field={field}
      value={value}
      onChange={onChange}
      nodeId={nodeId}
      keyframes={keyframes}
      currentFrame={currentFrame}
      keyframesEnabled={keyframesEnabled}
      onHoverKey={onHoverKey}
    />
  );
}

/** Assign a logical group name for parameter fields if none is explicitly specified */
function getGroupName(field: ParamFieldDef): string {
  if (field.group) return field.group;

  const id = field.id.toLowerCase();
  if (["location", "rotation", "scale", "position", "transform"].includes(id)) {
    return "Transform";
  }
  if (
    [
      "color",
      "emissive",
      "emissiveintensity",
      "shadeless",
      "roughness",
      "metalness",
      "wireframe",
      "wireframelinewidth",
      "opacity",
    ].includes(id)
  ) {
    return "Material";
  }
  if (id.includes("uv") || id.includes("texture") || id.includes("normal") || field.kind === "file") {
    return "Texture & Files";
  }
  if (["fov", "near", "far"].includes(id)) {
    return "Lens & Optics";
  }
  if (["intensity", "distance", "decay", "angle", "penumbra", "castshadow"].includes(id)) {
    return "Light Settings";
  }
  return "General";
}

export function ParamPanel({
  nodeId,
  label,
  category,
  fields,
  params,
  keyframes,
  currentFrame,
  keyframesEnabled = true,
  onChange,
  onToggleKeyframe,
  onAction,
  canFreeze,
  onFreeze,
  connectedSockets,
  exposedKeys,
  onToggleExposed,
}: ParamPanelProps) {
  const categoryColor = category ? CATEGORY_COLOR[category] : UNKNOWN_CATEGORY_COLOR;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ Transform: true });
  const [hoveredParamKey, setHoveredParamKey] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!keyframesEnabled || !hoveredParamKey || currentFrame === undefined || currentFrame < 0 || !onToggleKeyframe) return;
      if ((e.key === "k" || e.key === "K") && !isKeyReservedForPlayback(e)) {
        const activeEl = document.activeElement;
        if (activeEl instanceof HTMLElement) {
          activeEl.blur();
        }
        e.preventDefault();

        let valToStore: any;
        if (hoveredParamKey.includes(".")) {
          const [baseKey, comp] = hoveredParamKey.split(".");
          const baseVal = parseVector3(params[baseKey]);
          valToStore = (baseVal as any)[comp] ?? 0;
        } else {
          valToStore = params[hoveredParamKey];
        }
        onToggleKeyframe(nodeId, hoveredParamKey, currentFrame, valToStore);
      }
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [keyframesEnabled, hoveredParamKey, currentFrame, nodeId, params, onToggleKeyframe]);

  const toggleGroup = (groupName: string) => {
    setOpenGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }));
  };

  const groupsMap: Map<string, ParamFieldDef[]> = new Map();
  for (const field of fields) {
    const groupName = getGroupName(field);
    if (!groupsMap.has(groupName)) {
      groupsMap.set(groupName, []);
    }
    groupsMap.get(groupName)!.push(field);
  }

  const groups = Array.from(groupsMap.entries());

  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [justSelected, setJustSelected] = useState(true);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setJustSelected(true);
    if (selectTimerRef.current) clearTimeout(selectTimerRef.current);
    selectTimerRef.current = setTimeout(() => {
      setJustSelected(false);
    }, 2500);
    return () => {
      if (selectTimerRef.current) clearTimeout(selectTimerRef.current);
    };
  }, [nodeId]);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setJustSelected(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useEffect(() => {
    return () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      if (selectTimerRef.current) clearTimeout(selectTimerRef.current);
    };
  }, []);

  const handleMouseEnter = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    if (panelRef.current && panelRef.current.contains(document.activeElement)) {
      return;
    }
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      setIsHovered(false);
      setJustSelected(false);
    }, 180);
  };

  const isVisible = isPinned || isHovered || justSelected;

  return (
    <>
      {!isVisible && (
        <button
          type="button"
          className="param-panel-tab"
          onMouseEnter={handleMouseEnter}
          onClick={() => {
            setIsHovered(true);
          }}
          title={`${label} — Open parameters`}
        >
          <span className="param-panel-tab-dot" style={{ backgroundColor: categoryColor }} />
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="param-panel-tab-label">{label}</span>
        </button>
      )}

      <div
        ref={panelRef}
        className={`param-panel ${!isVisible ? "param-panel-hidden" : ""}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="param-panel-title" style={{ color: categoryColor }}>
          <span className="param-panel-title-text">{label}</span>
          <div className="param-panel-title-actions">
            <button
              type="button"
              className={`param-panel-pin-btn-header ${isPinned ? "param-panel-pin-btn-header-active" : ""}`}
              onClick={() => setIsPinned((p) => !p)}
              title={isPinned ? "Auto-hide disabled (click to enable auto-hide)" : "Pin panel (keep visible)"}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-2l-2-2V5h1V3H6v2h1v8l-2 2v2z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="param-name-section">
          <div className="param-row">
            <label title="Custom name displayed under the node on the canvas">
              <span>Name</span>
            </label>
            <input
              type="text"
              className="param-text-input"
              placeholder=""
              value={String(params.name ?? "")}
              onChange={(e) => onChange("name", e.target.value)}
            />
          </div>
        </div>

        {fields.length === 0 && <div className="param-panel-empty">No other editable parameters.</div>}

      {groups.map(([groupName, groupFields]) => {
        const isOpen =
          openGroups[groupName] !== undefined
            ? openGroups[groupName]
            : groupName.includes("Transform") || groupName === "General";

        return (
          <div className="param-group" key={groupName}>
            <button
              type="button"
              className="param-group-header"
              onClick={() => toggleGroup(groupName)}
              title={isOpen ? "Collapse category" : "Expand category"}
            >
              <span className="param-group-arrow">{isOpen ? "▼" : "▶"}</span>
              <span className="param-group-title">{groupName}</span>
              <span className="param-group-count">({groupFields.length})</span>
            </button>

            {isOpen && (
              <div className="param-group-body">
                {groupFields.map((field) => {
                  const useKey = "use" + field.id.toUpperCase();
                  const hasUseToggle = (field.kind === "number" || field.kind === "vector") && params[useKey] !== undefined;
                  const status = keyframesEnabled ? getKeyframeStatus(keyframes, nodeId, field.id, currentFrame) : "none";
                  const isDriven = connectedSockets?.has(field.id) ?? false;

                  // A note carries no value and no control — it gets the whole
                  // row so its text can wrap instead of being clipped to the
                  // label column.
                  if (field.kind === "note") {
                    return (
                      <div
                        className={"param-note" + (field.tone === "warn" ? " param-note-warn" : "")}
                        key={field.id}
                      >
                        {field.label}
                      </div>
                    );
                  }

                  return (
                    <div
                      className={"param-row" + (isDriven ? " param-row-driven" : "")}
                      key={field.id}
                      title={isDriven ? `${field.label} comes from the wire plugged into this node — unplug it to set a value here` : undefined}
                    >
                      <label style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                        {hasUseToggle && (
                          <input
                            type="checkbox"
                            checked={!!params[useKey]}
                            onChange={(e) => onChange(useKey, e.target.checked ? 1 : 0)}
                            title={`Enable ${field.label}`}
                            style={{ cursor: "pointer", accentColor: "#38bdf8", flex: "0 0 auto" }}
                          />
                        )}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {field.kind !== "button" && field.label}
                        </span>
                      </label>
                      {EXPOSABLE_KINDS.has(field.kind) && onToggleExposed && (
                        <button
                          type="button"
                          className={"param-pin-btn" + (exposedKeys?.has(field.id) ? " param-pin-btn-active" : "")}
                          title={exposedKeys?.has(field.id) ? "Unpin from viewport HUD" : "Pin to viewport HUD"}
                          onClick={() => onToggleExposed(nodeId, field.id)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="17" x2="12" y2="22" />
                            <path d="M5 17h14l-1.4-1.4A2 2 0 0 1 17 14.2V9a5 5 0 0 0-10 0v5.2a2 2 0 0 1-.6 1.4L5 17z" />
                          </svg>
                        </button>
                      )}
                      {field.kind === "number" && (
                        <DragNumberInput
                          value={toDisplayUnit(Number(params[field.id]) || 0, field.degrees, field.percent)}
                          step={field.step}
                          status={status}
                          onMouseEnter={() => setHoveredParamKey(field.id)}
                          onMouseLeave={() => setHoveredParamKey((prev) => (prev === field.id ? null : prev))}
                          onChange={(v) => onChange(field.id, toStoredUnit(v, field.degrees, field.percent))}
                        />
                      )}
                      {field.kind === "vector" &&
                        vectorField(
                          field,
                          params[field.id],
                          (v) => onChange(field.id, v),
                          nodeId,
                          keyframes,
                          currentFrame,
                          keyframesEnabled,
                          setHoveredParamKey,
                        )}
                      {field.kind === "boolean" && booleanField(params[field.id], (v) => onChange(field.id, v))}
                      {field.kind === "select" && selectField(field, params[field.id], (v) => onChange(field.id, v))}
                      {field.kind === "color" && (
                        <ColorPickerInput value={params[field.id]} onChange={(v) => onChange(field.id, v)} />
                      )}
                      {field.kind === "text" && (
                        <input
                          type="text"
                          className="param-text-input"
                          value={String(params[field.id] ?? "")}
                          onChange={(e) => onChange(field.id, e.target.value)}
                        />
                      )}
                      {field.kind === "curve_profile" && (
                        <CurveProfileEditor
                          value={params[field.id] as any}
                          onChange={(v) => onChange(field.id, v)}
                        />
                      )}
                      {field.kind === "color_ramp" && (
                        <ColorRampEditor
                          value={params[field.id] as any}
                          onChange={(v) => onChange(field.id, v)}
                        />
                      )}
                      {field.kind === "file" && fileField(nodeId, field, params[field.id], (v) => onChange(field.id, v))}
                      {field.kind === "button" && (
                        <button type="button" className="param-file-button" onClick={() => onAction?.(nodeId, field.action)}>
                          {field.label}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Freeze — only for a node that actually has geometry to snapshot,
          which is why it lives here rather than as a `button` field on each
          of the fifty-odd node definitions that would need one. Last, below
          every param group: it acts on the result of all of them, and it
          spawns a whole new node rather than editing this one. */}
      {canFreeze && onFreeze && (
        <button
          type="button"
          className="param-panel-freeze"
          title="Bake this node's current geometry into a new, static Frozen Geometry node"
          onClick={() => onFreeze(nodeId)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="2" x2="12" y2="22" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <line x1="4.9" y1="4.9" x2="19.1" y2="19.1" />
            <line x1="19.1" y1="4.9" x2="4.9" y2="19.1" />
          </svg>
          Freeze to mesh
        </button>
      )}
    </div>
    </>
  );
}
