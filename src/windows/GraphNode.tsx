import React, { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import { Handle, NodeResizeControl, Position, useUpdateNodeInternals } from "@xyflow/react";
import * as THREE from "three";
import { CATEGORY_COLOR, NodeCategory, UNKNOWN_CATEGORY_COLOR } from "../shared/graph/categories";
import { GROUP_TYPE, NEW_PORT_SOCKET } from "../shared/graph/groups";
import { getInspectorValue, subscribeInspector } from "../shared/graph/inspectorStore";
import { SOCKET_COLOR, SocketDef } from "../shared/graph/sockets";
import { NODE_APPLY_TRANSFORM_ACTION, NODE_FREEZE_ACTION } from "../shared/graph/nodeActions";
import { FRAME_MIN_HEIGHT, FRAME_MIN_WIDTH, FRAME_TYPE } from "../shared/graph/nodes/frame";

export interface GraphNodeData {
  nodeId?: string;
  nodeType?: string;
  label: string;
  customName?: string;
  category?: NodeCategory;
  inputs: SocketDef[];
  outputs: SocketDef[];
  /** How many nodes a group holds — absent on every other kind of node. */
  groupSize?: number;
  /** A group's folder colour (hex) — absent on every other kind of node. */
  groupColor?: string;
  /** A Frame's title and colour (hex) — absent on every other kind of node. */
  frameTitle?: string;
  frameColor?: string;
  [key: string]: unknown;
}

/**
 * What the icons under a node on hover can do (see GraphEditor, which knows
 * the registry): the Reset action a node type declares, and where actions go.
 */
export interface NodeActions {
  resetAction: (nodeType: string | undefined) => string | null;
  /** Whether the node type has a pose that Apply Rotation & Scale can fold into its geometry. */
  canApply: (nodeType: string | undefined) => boolean;
  run: (nodeId: string, action: string) => void;
}
export const NodeActionsContext = createContext<NodeActions | null>(null);

/** What a Frame can write back to its own params: title, colour, size. */
export interface FrameActions {
  updateParams: (nodeId: string, patch: Record<string, unknown>) => void;
}
export const FrameActionsContext = createContext<FrameActions | null>(null);

const FRAME_SWATCHES = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#8b949e"];

/**
 * A canvas Frame: a titled, tinted rectangle behind the nodes. Only its title
 * bar is draggable/clickable (the rest lets pointer events through to the
 * canvas — see .graph-frame-node in graph-editor.css), so it never gets in
 * the way of moving the nodes it sits under.
 */
function FrameNodeView({ data, selected }: { data: GraphNodeData; selected?: boolean }) {
  const actions = useContext(FrameActionsContext);
  const nodeId = data.nodeId;
  const title = data.frameTitle ?? "Frame";
  const color = data.frameColor ?? "#3b82f6";
  const [draft, setDraft] = useState<string | null>(null);

  const commitTitle = () => {
    if (draft !== null && nodeId && draft !== title) actions?.updateParams(nodeId, { title: draft });
    setDraft(null);
  };

  return (
    <>
      {selected && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={FRAME_MIN_WIDTH}
          minHeight={FRAME_MIN_HEIGHT}
          className="graph-frame-resize-handle"
          onResizeEnd={(_event, params) => {
            if (nodeId) actions?.updateParams(nodeId, { width: Math.round(params.width), height: Math.round(params.height) });
          }}
        />
      )}
      <div className={selected ? "graph-frame selected" : "graph-frame"} style={{ ["--frame-color" as string]: color }}>
        <div className="graph-frame-titlebar">
          <input
            className="graph-frame-title nodrag"
            value={draft ?? title}
            size={Math.max(4, (draft ?? title).length + 1)}
            placeholder="Frame"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") {
                setDraft(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {selected && (
            <div className="graph-frame-swatches nodrag">
              {FRAME_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={"graph-frame-swatch" + (hex === color ? " active" : "")}
                  style={{ background: hex }}
                  title={`Frame color ${hex}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (nodeId) actions?.updateParams(nodeId, { color: new THREE.Color(hex) });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Folder colour a group gets until someone picks another — the macOS folder blue. */
export const GROUP_DEFAULT_COLOR = "#5eb4ec";
const GROUP_MIN_WIDTH = 120;
const GROUP_DEFAULT_WIDTH = 180;
/** Where the socket rows start: below the tab and the paper peeking out of the folder. */
const GROUP_SOCKETS_TOP = 30;
const GROUP_ROW_HEIGHT = 22;
const GROUP_BOTTOM_ROOM = 24;

/**
 * The size a group's folder is drawn at: what the author dragged it to, but
 * never so small that its sockets spill out of it — the ports are the whole
 * reason the folder is on this level at all.
 */
export function groupFolderSize(
  params: Record<string, unknown> | undefined,
  rows: number,
): { width: number; height: number; minWidth: number; minHeight: number } {
  const minHeight = GROUP_SOCKETS_TOP + Math.max(1, rows) * GROUP_ROW_HEIGHT + GROUP_BOTTOM_ROOM;
  const w = Number(params?.folderWidth);
  const h = Number(params?.folderHeight);
  return {
    width: Number.isFinite(w) ? Math.max(GROUP_MIN_WIDTH, w) : GROUP_DEFAULT_WIDTH,
    height: Number.isFinite(h) ? Math.max(minHeight, h) : Math.max(minHeight, 120),
    minWidth: GROUP_MIN_WIDTH,
    minHeight,
  };
}

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.06.44L11.5 7h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);

/**
 * A group drawn as what it is — a folder holding part of the graph. Same
 * sockets as any node (its ports, down the left and right edges), its name
 * underneath like a file in Finder, and a size and colour of its own.
 * Double-click opens it, as before.
 */
function GroupFolderView({ data, selected }: { data: GraphNodeData; selected?: boolean }) {
  const actions = useContext(FrameActionsContext);
  const nodeId = data.nodeId;
  const [colorDraft, setColorDraft] = useState<string | null>(null);
  const color = colorDraft ?? data.groupColor ?? GROUP_DEFAULT_COLOR;
  const name = typeof data.customName === "string" && data.customName.trim() !== "" ? data.customName : "Group";
  const rows = Math.max(data.inputs.length, data.outputs.length);
  const { minWidth, minHeight } = groupFolderSize(undefined, rows);

  const setColor = (hex: string) => {
    setColorDraft(null);
    if (nodeId) actions?.updateParams(nodeId, { folderColor: hex });
  };
  // The picker previews as it moves (React's onChange is the `input` event)
  // and commits on the native `change`, when it is let go — one undo step per
  // colour picked, not one per pixel the cursor crossed.
  const colorInputRef = useRef<HTMLInputElement>(null);
  const setColorRef = useRef(setColor);
  setColorRef.current = setColor;
  useEffect(() => {
    const el = colorInputRef.current;
    if (!el) return;
    const onCommit = () => setColorRef.current(el.value);
    el.addEventListener("change", onCommit);
    return () => el.removeEventListener("change", onCommit);
  }, [selected]);

  return (
    <>
      {selected && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={minWidth}
          minHeight={minHeight}
          className="graph-group-resize-handle"
          onResizeEnd={(_event, params) => {
            if (nodeId) actions?.updateParams(nodeId, { folderWidth: Math.round(params.width), folderHeight: Math.round(params.height) });
          }}
        />
      )}
      <div
        className={"graph-group-folder" + (selected ? " selected" : "")}
        style={{ ["--folder-color" as string]: color }}
        title="Double-click to open"
      >
        <div className="graph-group-folder-tab" />
        <div className="graph-group-folder-back" />
        <div className="graph-group-folder-paper" />
        <div className="graph-group-folder-front" />
        <div className="graph-group-folder-sockets">
          <div className="graph-node-column">
            {data.inputs.map((socket) => (
              <div
                className={"graph-node-socket" + (socket.id === NEW_PORT_SOCKET ? " graph-node-socket-new" : "")}
                key={socket.id}
                title={socket.id === NEW_PORT_SOCKET ? "Drop a wire here to add a port" : undefined}
              >
                <Handle type="target" position={Position.Left} id={socket.id} style={{ background: SOCKET_COLOR[socket.type] }} />
                <span>{socket.label}</span>
              </div>
            ))}
          </div>
          <div className="graph-node-column graph-node-column-right">
            {data.outputs.map((socket) => (
              <div
                className={"graph-node-socket graph-node-socket-out" + (socket.id === NEW_PORT_SOCKET ? " graph-node-socket-new" : "")}
                key={socket.id}
                title={socket.id === NEW_PORT_SOCKET ? "Drag from here to add a port" : undefined}
              >
                <span>{socket.label}</span>
                <Handle type="source" position={Position.Right} id={socket.id} style={{ background: SOCKET_COLOR[socket.type] }} />
              </div>
            ))}
          </div>
        </div>
        {typeof data.groupSize === "number" && (
          <div className="graph-group-folder-count">
            <FolderIcon />
            {data.groupSize}
          </div>
        )}
      </div>
      <div className="graph-group-folder-name">{name}</div>
      {selected && (
        <div className="graph-group-folder-swatches nodrag nopan">
          {FRAME_SWATCHES.concat(GROUP_DEFAULT_COLOR).map((hex) => (
            <button
              key={hex}
              type="button"
              className={"graph-frame-swatch" + (hex === color ? " active" : "")}
              style={{ background: hex }}
              title={`Folder color ${hex}`}
              onClick={(e) => {
                e.stopPropagation();
                setColor(hex);
              }}
            />
          ))}
          <label className="graph-frame-swatch graph-group-swatch-custom" title="Custom color">
            <input ref={colorInputRef} type="color" value={color} onChange={(e) => setColorDraft(e.target.value)} />
          </label>
        </div>
      )}
    </>
  );
}

const FreezeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="2" x2="12" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="4.9" y1="4.9" x2="19.1" y2="19.1" />
    <line x1="19.1" y1="4.9" x2="4.9" y2="19.1" />
  </svg>
);

/** A cube with its axes squared up — the turn and stretch set into the shape. */
const ApplyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5 12 12l8-4.5" />
    <line x1="12" y1="12" x2="12" y2="21" />
  </svg>
);

const ResetIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <polyline points="3 3 3 9 9 9" />
  </svg>
);

/**
 * Freeze (anything that outputs geometry), Apply (a node with a pose of its
 * own) and Reset (a node that declares one), under the node, shown while the
 * pointer is over it. `nodrag` keeps a
 * click on them from starting a node drag.
 */
function NodeHoverActions({ data }: { data: GraphNodeData }) {
  const actions = useContext(NodeActionsContext);
  if (!actions || !data.nodeId) return null;
  const canFreeze = data.outputs.some((o) => o.id === "geometry" && o.type === "geometry");
  const reset = actions.resetAction(data.nodeType);
  const canApply = actions.canApply(data.nodeType);
  if (!canFreeze && !reset && !canApply) return null;
  const nodeId = data.nodeId;
  const run = (action: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    actions.run(nodeId, action);
  };
  return (
    <div className="graph-node-actions nodrag nopan">
      {reset && (
        <button type="button" className="graph-node-action" title="Reset: discard what was made in this node (Cmd/Ctrl+Z undoes)" onClick={run(reset)}>
          <ResetIcon />
        </button>
      )}
      {canApply && (
        <button
          type="button"
          className="graph-node-action"
          title="Apply Rotation & Scale: set the object's turn and size into its shape, leaving Rotation 0 and Scale 1 — it stays exactly where it is (Cmd/Ctrl+Z undoes)"
          onClick={run(NODE_APPLY_TRANSFORM_ACTION)}
        >
          <ApplyIcon />
        </button>
      )}
      {canFreeze && (
        <button type="button" className="graph-node-action" title="Freeze: bake the current geometry into a new, static Frozen Geometry node" onClick={run(NODE_FREEZE_ACTION)}>
          <FreezeIcon />
        </button>
      )}
    </div>
  );
}

function useInspectorValue(nodeId?: string) {
  const [val, setVal] = useState<unknown>(() => (nodeId ? getInspectorValue(nodeId) : undefined));

  useEffect(() => {
    if (!nodeId) return;
    setVal(getInspectorValue(nodeId));
    return subscribeInspector(() => {
      setVal(getInspectorValue(nodeId));
    });
  }, [nodeId]);

  return val;
}

function renderValuePreview(val: unknown) {
  if (val === undefined || val === null) {
    return <span style={{ color: "#6b7280" }}>null</span>;
  }

  if (typeof val === "number") {
    return Number.isInteger(val) ? val.toString() : val.toFixed(3);
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "string") {
    return `"${val}"`;
  }

  if (val instanceof THREE.Vector3) {
    return `Vec3(${val.x.toFixed(2)}, ${val.y.toFixed(2)}, ${val.z.toFixed(2)})`;
  }

  if (val instanceof THREE.Color) {
    const hex = `#${val.getHexString()}`;
    return (
      <span>
        <span className="inspector-color-swatch" style={{ background: hex }} />
        {hex}
      </span>
    );
  }

  if (val instanceof THREE.Matrix4) {
    return "[Matrix 4x4]";
  }

  if (val instanceof THREE.Object3D) {
    return `<${val.type || "Object3D"}>`;
  }

  if (val instanceof THREE.Texture) {
    return "<Texture>";
  }

  if (Array.isArray(val)) {
    const sample = val.slice(0, 3).map((x) => {
      if (typeof x === "number") return Number.isInteger(x) ? x : x.toFixed(2);
      if (x instanceof THREE.Color) return `#${x.getHexString()}`;
      return String(x);
    });
    const suffix = val.length > 3 ? `, ... (+${val.length - 3})` : "";
    return `List[${val.length}]: [${sample.join(", ")}${suffix}]`;
  }

  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

/**
 * Generic node renderer — every node type looks the same shape (title,
 * inputs down the left, outputs down the right), driven entirely by the
 * NodeDefinition's socket list.
 *
 * Memoized: React Flow re-renders its node wrappers for reasons that don't
 * touch what a node draws (a neighbour dragged, the selection moving), and
 * with a large graph re-rendering every node body each time adds up.
 */
export const GraphNode = memo(function GraphNode({ data, selected }: { data: GraphNodeData; selected?: boolean }) {
  // Hook must be called unconditionally (Rules of Hooks): this component renders
  // both reroute nodes and every other node type, and the count of hooks a render
  // invokes may not depend on `data.nodeType`. For a reroute the value is always
  // undefined and simply unused.
  const inspectorVal = useInspectorValue(data.nodeId);
  const updateNodeInternals = useUpdateNodeInternals();

  const socketSignature = `${data.inputs?.map((s) => s.id).join(",") ?? ""}|${data.outputs?.map((s) => s.id).join(",") ?? ""}`;
  useEffect(() => {
    if (data.nodeId) {
      updateNodeInternals(data.nodeId);
    }
  }, [data.nodeId, socketSignature, updateNodeInternals]);

  if (data.nodeType === FRAME_TYPE) return <FrameNodeView data={data} selected={selected} />;
  if (data.nodeType === GROUP_TYPE) return <GroupFolderView data={data} selected={selected} />;

  if (data.nodeType === "utility/reroute") {
    const socketType = data.inputs[0]?.type || "any";
    const dotColor = SOCKET_COLOR[socketType] || "#38bdf8";

    const rerouteStyle: React.CSSProperties = {
      width: 10,
      height: 10,
      borderRadius: "50%",
      background: dotColor,
      border: selected ? "1.5px solid #ffffff" : "1.5px solid rgba(15, 23, 42, 0.9)",
      boxShadow: selected ? "0 0 6px " + dotColor : "0 1px 3px rgba(0,0,0,0.6)",
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "grab",
    };

    const handleCenterStyle: React.CSSProperties = {
      width: 4,
      height: 4,
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      opacity: 0,
      minWidth: 0,
      minHeight: 0,
      border: "none",
      position: "absolute",
      cursor: "crosshair",
    };

    return (
      <div className={selected ? "graph-node-reroute selected" : "graph-node-reroute"} style={rerouteStyle} title="Reroute">
        <Handle type="target" position={Position.Left} id="in" style={handleCenterStyle} />
        <Handle type="source" position={Position.Right} id="out" style={handleCenterStyle} />
      </div>
    );
  }

  const categoryColor = data.category ? CATEGORY_COLOR[data.category] : UNKNOWN_CATEGORY_COLOR;

  return (
    <div className="graph-node" style={{ borderColor: selected ? categoryColor : undefined }}>
      <div className="graph-node-title" style={{ color: categoryColor }}>
        {data.label}
      </div>
      <div className="graph-node-body">
        <div className="graph-node-column">
          {data.inputs.map((socket) => (
            <div
              className={"graph-node-socket" + (socket.id === NEW_PORT_SOCKET ? " graph-node-socket-new" : "")}
              key={socket.id}
              title={socket.id === NEW_PORT_SOCKET ? "Drop a wire here to add a port" : undefined}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={socket.id}
                style={{ background: SOCKET_COLOR[socket.type] }}
              />
              <span>{socket.label}</span>
            </div>
          ))}
        </div>
        <div className="graph-node-column graph-node-column-right">
          {data.outputs.map((socket) => (
            <div
              className={
                "graph-node-socket graph-node-socket-out" +
                (socket.id === NEW_PORT_SOCKET ? " graph-node-socket-new" : "")
              }
              key={socket.id}
              title={socket.id === NEW_PORT_SOCKET ? "Drag from here to add a port" : undefined}
            >
              <span>{socket.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={socket.id}
                style={{ background: SOCKET_COLOR[socket.type] }}
              />
            </div>
          ))}
        </div>
      </div>
      {/* A group is worth telling apart at a glance: what is inside is not
          visible from here, and double-click is the only way in. */}
      {typeof data.groupSize === "number" && (
        <div className="graph-node-group-badge" title="Double-click to open">
          {data.groupSize} node{data.groupSize === 1 ? "" : "s"} ⏎
        </div>
      )}
      {data.nodeType === "io/inspector" && (
        <div className="graph-node-inspector">{renderValuePreview(inspectorVal)}</div>
      )}
      {typeof data.customName === "string" && data.customName.trim() !== "" && (
        <div className="graph-node-custom-name">{data.customName}</div>
      )}
      <NodeHoverActions data={data} />
    </div>
  );
});
