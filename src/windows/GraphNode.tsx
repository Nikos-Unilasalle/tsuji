import React, { createContext, useContext, useEffect, useState } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import * as THREE from "three";
import { CATEGORY_COLOR, NodeCategory, UNKNOWN_CATEGORY_COLOR } from "../shared/graph/categories";
import { NEW_PORT_SOCKET } from "../shared/graph/groups";
import { getInspectorValue, subscribeInspector } from "../shared/graph/inspectorStore";
import { SOCKET_COLOR, SocketDef } from "../shared/graph/sockets";
import { NODE_FREEZE_ACTION } from "../shared/graph/nodeActions";

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
  [key: string]: unknown;
}

/**
 * What the icons under a node on hover can do (see GraphEditor, which knows
 * the registry): the Reset action a node type declares, and where actions go.
 */
export interface NodeActions {
  resetAction: (nodeType: string | undefined) => string | null;
  run: (nodeId: string, action: string) => void;
}
export const NodeActionsContext = createContext<NodeActions | null>(null);

const FreezeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="2" x2="12" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="4.9" y1="4.9" x2="19.1" y2="19.1" />
    <line x1="19.1" y1="4.9" x2="4.9" y2="19.1" />
  </svg>
);

const ResetIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <polyline points="3 3 3 9 9 9" />
  </svg>
);

/**
 * Freeze (anything that outputs geometry) and Reset (a node that declares
 * one), under the node, shown while the pointer is over it. `nodrag` keeps a
 * click on them from starting a node drag.
 */
function NodeHoverActions({ data }: { data: GraphNodeData }) {
  const actions = useContext(NodeActionsContext);
  if (!actions || !data.nodeId) return null;
  const canFreeze = data.outputs.some((o) => o.id === "geometry" && o.type === "geometry");
  const reset = actions.resetAction(data.nodeType);
  if (!canFreeze && !reset) return null;
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
 */
export function GraphNode({ data, selected }: { data: GraphNodeData; selected?: boolean }) {
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
}
