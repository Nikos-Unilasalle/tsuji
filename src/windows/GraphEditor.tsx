import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Connection as FlowConnection,
  Edge,
  EdgeMouseHandler,
  Node,
  NodeChange,
  OnConnect,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { DEFAULT_PICKS } from "../shared/graph/calibration/picks";
import { getGraphClipboard, setGraphClipboard } from "../shared/graph/clipboard";
import { cloneKeyframes, cloneParams, cloneParamValue } from "../shared/graph/cloneGraph";
import { groupSelection, materializeNewPort, ungroupNode } from "../shared/graph/groupSelection";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  graphAtPath,
  isGroupInstance,
  replaceGraphAtPath,
  resolveDefinition,
} from "../shared/graph/groups";
import { findCompatibleSocket, segmentIntersectsRect } from "../shared/graph/insertOnWire";
import { getInputZone, isGraphZone, isTimelineZone, isViewportZone, setInputZone } from "../shared/graph/inputZoneStore";
import { isKeyReservedForPlayback } from "../shared/graph/playbackKeys";
import { randomId } from "../shared/randomId";
import { SOCKET_COLOR } from "../shared/graph/sockets";
import { Connection, ExposedParamRef, Graph, KeyframeStore, Marker, NodeInstance, NodeRegistry } from "../shared/graph/types";
import { GraphNode, GraphNodeData } from "./GraphNode";
import { NodePalette } from "./NodePalette";
import { QuickAddToolbar } from "./QuickAddToolbar";
import { NodeSearchModal } from "./NodeSearchModal";
import "./graph-editor.css";

/** Yellow spawn cursor crosshair (#f2c14e matching scalar sockets) */
function SpawnCursorMarker({ position }: { position: { x: number; y: number } }) {
  const { x, y, zoom } = useViewport();

  return (
    <div
      style={{
        position: "absolute",
        left: x + position.x * zoom,
        top: y + position.y * zoom,
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <svg width="24" height="24" viewBox="-12 -12 24 24" style={{ overflow: "visible" }}>
        {/* Crisp 1px crosshair in yellow scalar socket color (#f2c14e) */}
        <path
          d="M -10 0 L 10 0 M 0 -10 L 0 10"
          stroke="#f2c14e"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {/* Center dot */}
        <circle cx="0" cy="0" r="1.5" fill="#f2c14e" />
      </svg>
    </div>
  );
}

const NODE_TYPES = { graphNode: GraphNode };
/** Node types that only ever exist because a group put them there. */
const GROUP_INTERNAL_TYPES = new Set([GROUP_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);
const EDGE_STROKE_WIDTH = 3;
const DEFAULT_NODE_WIDTH = 160;
const DEFAULT_NODE_HEIGHT = 90;

function toFlowNodes(graph: Graph, registry: NodeRegistry, selectedIds?: Set<string>): Node<GraphNodeData>[] {
  return graph.nodes.map((instance) => {
    const def = resolveDefinition(instance, registry);
    return {
      id: instance.id,
      type: "graphNode",
      position: instance.position,
      selected: selectedIds ? selectedIds.has(instance.id) : false,
      data: {
        nodeId: instance.id,
        nodeType: instance.type,
        label: def?.label ?? `${instance.type} (unknown)`,
        customName: typeof instance.params?.name === "string" ? instance.params.name : "",
        category: def?.category,
        inputs: def?.inputs ?? [],
        outputs: def?.outputs ?? [],
        ...(instance.subgraph ? { groupSize: instance.subgraph.nodes.length } : {}),
      },
    };
  });
}

function edgeColor(nodes: Node<GraphNodeData>[], nodeId: string, socketId: string): string {
  const socket = nodes.find((n) => n.id === nodeId)?.data.outputs.find((s) => s.id === socketId);
  return socket ? SOCKET_COLOR[socket.type] : "#6b7280";
}

function toFlowEdges(graph: Graph, flowNodes: Node<GraphNodeData>[]): Edge[] {
  return graph.connections.map((conn) => ({
    id: conn.id,
    source: conn.fromNode,
    sourceHandle: conn.fromSocket,
    target: conn.toNode,
    targetHandle: conn.toSocket,
    style: { stroke: edgeColor(flowNodes, conn.fromNode, conn.fromSocket), strokeWidth: EDGE_STROKE_WIDTH },
  }));
}

function refreshDynamicSockets(
  flowNodes: Node<GraphNodeData>[],
  flowEdges: Edge[],
  baseNodes: NodeInstance[],
  registry: NodeRegistry,
): Node<GraphNodeData>[] {
  return flowNodes.map((flowNode) => {
    const instance = baseNodes.find((n) => n.id === flowNode.id);
    const def = resolveDefinition(instance, registry);
    if (!def?.dynamicInputs && !def?.dynamicOutputs) return flowNode;

    const nodeIncomingConnections = flowEdges.filter((e) => e.target === flowNode.id);
    const nodeConnectionsWithTypes = nodeIncomingConnections.map((e) => {
      const sourceNode = flowNodes.find((n) => n.id === e.source);
      const sourceSocketDef = sourceNode?.data.outputs.find((s) => s.id === e.sourceHandle);
      return {
        connection: {
          id: e.id,
          fromNode: e.source,
          fromSocket: e.sourceHandle ?? "",
          toNode: e.target,
          toSocket: e.targetHandle ?? "",
        },
        sourceSocketType: sourceSocketDef?.type || ("any" as const),
      };
    });

    const connList = nodeConnectionsWithTypes.map((ct) => ct.connection);

    let nextInputs = flowNode.data.inputs;
    if (def.dynamicInputs) {
      nextInputs = def.dynamicInputs(connList, nodeConnectionsWithTypes);
    }

    let nextOutputs = flowNode.data.outputs;
    if (def.dynamicOutputs) {
      nextOutputs = def.dynamicOutputs(connList, nodeConnectionsWithTypes);
    }

    return {
      ...flowNode,
      data: {
        ...flowNode.data,
        inputs: nextInputs,
        outputs: nextOutputs,
      },
    };
  });
}

function toGraph(
  baseNodes: NodeInstance[],
  flowNodes: Node<GraphNodeData>[],
  flowEdges: Edge[],
  existingKeyframes?: KeyframeStore,
  existingMarkers?: Marker[],
  existingExposedParams?: ExposedParamRef[],
): Graph {
  const flowNodeIds = new Set(flowNodes.map((f) => f.id));
  const nodes = baseNodes
    .filter((n) => flowNodeIds.has(n.id))
    .map((n) => {
      const flowNode = flowNodes.find((f) => f.id === n.id);
      return flowNode ? { ...n, position: flowNode.position } : n;
    });
  const connections: Connection[] = flowEdges
    .filter((e) => flowNodeIds.has(e.source) && flowNodeIds.has(e.target))
    .map((e) => ({
      id: e.id,
      fromNode: e.source,
      fromSocket: e.sourceHandle ?? "",
      toNode: e.target,
      toSocket: e.targetHandle ?? "",
    }));

  const keyframes: KeyframeStore = {};
  if (existingKeyframes) {
    for (const nodeId of Object.keys(existingKeyframes)) {
      if (flowNodeIds.has(nodeId)) {
        keyframes[nodeId] = existingKeyframes[nodeId];
      }
    }
  }

  const exposedParams = (existingExposedParams ?? []).filter((e) => flowNodeIds.has(e.nodeId));

  return { nodes, connections, keyframes, markers: existingMarkers ?? [], exposedParams };
}

interface GraphEditorProps {
  graph: Graph;
  registry: NodeRegistry;
  onGraphChange?: (graph: Graph) => void;
  onSelectNode: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
  onSelectNodes?: (nodeIds: string[]) => void;
  selectedNodeIds?: string[];
  /** How many canvases the document holds — the selector draws one tab each. Omit to hide the selector entirely. */
  canvasCount?: number;
  /** Index of the canvas this editor is showing. */
  activeCanvas?: number;
  /** Per canvas: whether it's still empty, so untouched slots read as available rather than identical to the one in use. */
  emptyCanvases?: boolean[];
  onSelectCanvas?: (index: number) => void;
}

function GraphEditorContent({
  graph: rootGraph,
  registry,
  onGraphChange: onRootGraphChange,
  onSelectNode,
  selectedNodeId,
  onSelectNodes,
  selectedNodeIds: _selectedNodeIds,
  canvasCount,
  activeCanvas = 0,
  emptyCanvases,
  onSelectCanvas,
}: GraphEditorProps) {
  const { screenToFlowPosition } = useReactFlow();

  /**
   * Which group the canvas is showing the inside of — a path of group node
   * ids, empty at the top level.
   *
   * Diving into a group is an editor state, not a document one: the rest of
   * the app (the viewport, the timeline, undo) goes on working with the whole
   * root graph, and every edit made down here is lifted back into it before
   * it leaves this component. That is what keeps a group from needing its own
   * evaluation pass, its own history stack or its own selection model.
   */
  const [graphPath, setGraphPath] = useState<string[]>([]);
  const graph = useMemo(() => graphAtPath(rootGraph, graphPath) ?? rootGraph, [rootGraph, graphPath]);

  // The group being edited can vanish under us — deleted from a second pane,
  // or undone away. Surfacing at the root beats drawing a level that no
  // longer exists.
  useEffect(() => {
    if (graphPath.length > 0 && !graphAtPath(rootGraph, graphPath)) setGraphPath([]);
  }, [rootGraph, graphPath]);

  const onGraphChange = useCallback(
    (next: Graph) => {
      onRootGraphChange?.(graphPath.length === 0 ? next : replaceGraphAtPath(rootGraph, graphPath, next));
    },
    [onRootGraphChange, rootGraph, graphPath],
  );

  const breadcrumb = useMemo(() => {
    const trail: { id: string; label: string }[] = [];
    let level: Graph | undefined = rootGraph;
    for (const nodeId of graphPath) {
      const node: NodeInstance | undefined = level?.nodes.find((n) => n.id === nodeId);
      const name = typeof node?.params?.name === "string" && node.params.name ? node.params.name : "Group";
      trail.push({ id: nodeId, label: name });
      level = node?.subgraph;
    }
    return trail;
  }, [rootGraph, graphPath]);


  const initialSelectedIds = useMemo(() => {
    const set = new Set<string>();
    if (_selectedNodeIds && _selectedNodeIds.length > 0) {
      _selectedNodeIds.forEach((id) => set.add(id));
    } else if (selectedNodeId) {
      set.add(selectedNodeId);
    }
    return set;
  }, [selectedNodeId, _selectedNodeIds]);

  const initialNodes = useMemo(() => {
    const raw = toFlowNodes(graph, registry, initialSelectedIds);
    return refreshDynamicSockets(raw, toFlowEdges(graph, raw), graph.nodes, registry);
  }, [graph, registry, initialSelectedIds]);
  const [nodes, setNodes] = useNodesState(initialNodes);
  const [edges, setEdges] = useEdgesState(useMemo(() => toFlowEdges(graph, initialNodes), [graph, initialNodes]));

  /**
   * Which node ids are currently selected, mirrored outside React state.
   *
   * The graph-sync effect below (position/param reconciliation, triggered
   * whenever `graph` changes) needs to know this too, so it can carry
   * selection forward instead of dropping it — but reading it off whatever
   * `prevNodes` snapshot that effect's own setNodes happens to be holding is
   * not safe: StrictMode double-invokes effects in dev, and one of the two
   * invocations can run against a snapshot taken *before* a marquee-select's
   * setNodes call had applied, silently reverting the selection a box-drag
   * had just computed. Updated synchronously in onNodesChange, so it is
   * never behind the change that produced it.
   */
  const selectedIdsRef = useRef<Set<string>>(new Set(initialSelectedIds));

  useEffect(() => {
    if (_selectedNodeIds && _selectedNodeIds.length > 0) {
      selectedIdsRef.current = new Set(_selectedNodeIds);
    } else if (selectedNodeId) {
      selectedIdsRef.current = new Set([selectedNodeId]);
    } else {
      selectedIdsRef.current = new Set();
    }
  }, [selectedNodeId, _selectedNodeIds]);

  const connectingHandleRef = useRef<{
    nodeId: string;
    handleId: string;
    handleType: "source" | "target";
  } | null>(null);
  const connectFiredRef = useRef(false);

  const [pendingWireConnection, setPendingWireConnection] = useState<{
    nodeId: string;
    handleId: string;
    handleType: "source" | "target";
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    const rawNodes = toFlowNodes(graph, registry, selectedIdsRef.current);
    const flowEdges = toFlowEdges(graph, rawNodes);
    const nextNodes = refreshDynamicSockets(rawNodes, flowEdges, graph.nodes, registry);

    setNodes((prevNodes) => {
      const prevIds = prevNodes.map((n) => n.id).join(",");
      const nextIds = nextNodes.map((n) => n.id).join(",");
      if (prevIds !== nextIds) {
        return nextNodes.map((n) => ({ ...n, selected: selectedIdsRef.current.has(n.id) }));
      }
      return prevNodes.map((fn) => {
        const graphNode = graph.nodes.find((gn) => gn.id === fn.id);
        if (!graphNode) return fn;
        return {
          ...fn,
          // Sourced from the ref, not `fn.selected` off `prevNodes`: this
          // effect's own setNodes call can run — twice, under StrictMode's
          // deliberate double-invoke — against a `prevNodes` snapshot taken
          // *before* a marquee-select's own setNodes had applied, silently
          // reverting the selection a box-drag had just computed. The ref is
          // updated synchronously inside onNodesChange, so it can't be
          // behind whatever snapshot this effect happens to be holding.
          selected: selectedIdsRef.current.has(fn.id),
          position: graphNode.position,
          data: {
            ...fn.data,
            params: graphNode.params,
            customName: typeof graphNode.params?.name === "string" ? graphNode.params.name : "",
          },
        };
      });
    });

    setEdges((prevEdges) => {
      const unchanged =
        prevEdges.length === flowEdges.length &&
        prevEdges.every(
          (e, i) =>
            e.id === flowEdges[i].id &&
            e.source === flowEdges[i].source &&
            e.sourceHandle === flowEdges[i].sourceHandle &&
            e.target === flowEdges[i].target &&
            e.targetHandle === flowEdges[i].targetHandle,
        );
      return unchanged ? prevEdges : flowEdges;
    });
  }, [graph, registry, setNodes, setEdges]);

  const commit = useCallback(
    (nextNodes: Node<GraphNodeData>[], nextEdges: Edge[]) => {
      onGraphChange?.(toGraph(graph.nodes, nextNodes, nextEdges, graph.keyframes, graph.markers, graph.exposedParams));
    },
    [graph.nodes, graph.keyframes, graph.markers, onGraphChange],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<GraphNodeData>>[]) => {
      for (const change of changes) {
        if (change.type === "select") {
          if (change.selected) selectedIdsRef.current.add(change.id);
          else selectedIdsRef.current.delete(change.id);
        } else if (change.type === "remove") {
          selectedIdsRef.current.delete(change.id);
        }
      }
      const next = applyNodeChanges(changes, nodes);
      setNodes(next);
    },
    [nodes, setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: any) => {
      const nextEdges = applyEdgeChanges(changes, edges);
      const nextNodes = refreshDynamicSockets(nodes, nextEdges, graph.nodes, registry);
      setNodes(nextNodes);
      setEdges(nextEdges);
      commit(nextNodes, nextEdges);
    },
    [commit, edges, graph.nodes, nodes, registry, setEdges, setNodes],
  );

  const onNodesDelete = useCallback(
    (deletedNodes: Node<GraphNodeData>[]) => {
      // Cache disposal is deliberately NOT done here. It is reconciled
      // against the graph in App.tsx instead, so that undo, redo, New, Open
      // and any other way a node can leave are covered by the same rule
      // rather than each needing to remember to call it.
      const deletedIds = new Set(deletedNodes.map((n) => n.id));
      for (const id of deletedIds) selectedIdsRef.current.delete(id);

      const nextNodes = nodes.filter((n) => !deletedIds.has(n.id));
      const nextEdges = edges.filter((e) => !deletedIds.has(e.source) && !deletedIds.has(e.target));

      const updatedGraphNodes = graph.nodes
        .filter((n) => !deletedIds.has(n.id))
        .map((n) => {
          if (n.type === "camera") {
            const hasRefPoints = nextEdges.some((e) => e.target === n.id && e.targetHandle === "refPoints");
            if (!hasRefPoints) {
              return { ...n, params: { ...n.params, calibrationPicks: { ...DEFAULT_PICKS } } };
            }
          }
          return n;
        });

      const refreshedNodes = refreshDynamicSockets(nextNodes, nextEdges, updatedGraphNodes, registry);
      setNodes(refreshedNodes);
      setEdges(nextEdges);
      onGraphChange?.(toGraph(updatedGraphNodes, refreshedNodes, nextEdges, graph.keyframes, graph.markers, graph.exposedParams));
    },
    [edges, graph.nodes, graph.keyframes, graph.markers, nodes, onGraphChange, registry, setEdges, setNodes],
  );

  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      const deletedIds = new Set(deletedEdges.map((e) => e.id));
      let nextEdges = edges.filter((e) => !deletedIds.has(e.id));
      const nextNodes = refreshDynamicSockets(nodes, nextEdges, graph.nodes, registry);

      // Auto-prune any edges whose socket handles disappeared after dynamic socket contraction
      nextEdges = nextEdges.filter((e) => {
        const srcNode = nextNodes.find((n) => n.id === e.source);
        const tgtNode = nextNodes.find((n) => n.id === e.target);
        if (!srcNode || !tgtNode) return false;
        const srcHasSocket = srcNode.data.outputs.some((s) => s.id === e.sourceHandle);
        const tgtHasSocket = tgtNode.data.inputs.some((s) => s.id === e.targetHandle);
        return srcHasSocket && tgtHasSocket;
      });

      setNodes(nextNodes);
      setEdges(nextEdges);
      commit(nextNodes, nextEdges);
    },
    [commit, edges, graph.nodes, nodes, registry, setEdges, setNodes],
  );

  const isValidConnection = useCallback(
    (connection: FlowConnection | Edge) => {
      if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
        return false;
      }
      const sourceSocket = nodes
        .find((n) => n.id === connection.source)
        ?.data.outputs.find((s) => s.id === connection.sourceHandle);
      const targetSocket = nodes
        .find((n) => n.id === connection.target)
        ?.data.inputs.find((s) => s.id === connection.targetHandle);
      if (!sourceSocket || !targetSocket) return false;
      if (sourceSocket.type === "any" || targetSocket.type === "any") return true;
      return sourceSocket.type === targetSocket.type;
    },
    [nodes],
  );

  const onConnectStart = useCallback((_: any, { nodeId, handleId, handleType }: any) => {
    connectingHandleRef.current = nodeId && handleId && handleType ? { nodeId, handleId, handleType } : null;
    connectFiredRef.current = false;
  }, []);

  const onConnect: OnConnect = useCallback(
    (connection) => {
      connectFiredRef.current = true;
      if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;

      // Dropped on a boundary's empty socket: the port has to exist before
      // the wire can point at it, and both live in the graph rather than in
      // the flow nodes — so this path writes the graph directly and lets the
      // sync effect rebuild the canvas from it.
      const materialized = materializeNewPort(
        graph,
        {
          fromNode: connection.source,
          fromSocket: connection.sourceHandle,
          toNode: connection.target,
          toSocket: connection.targetHandle,
        },
        registry,
        randomId,
      );
      if (materialized) {
        const kept = materialized.graph.connections.filter(
          (c) => !(c.toNode === materialized.connection.toNode && c.toSocket === materialized.connection.toSocket),
        );
        onGraphChange?.({ ...materialized.graph, connections: [...kept, materialized.connection] });
        return;
      }

      const withoutConflict = edges.filter(
        (e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle),
      );
      const newEdge: Edge = {
        id: `${connection.source}.${connection.sourceHandle}->${connection.target}.${connection.targetHandle}`,
        source: connection.source!,
        sourceHandle: connection.sourceHandle,
        target: connection.target!,
        targetHandle: connection.targetHandle,
        style: { stroke: edgeColor(nodes, connection.source!, connection.sourceHandle!), strokeWidth: EDGE_STROKE_WIDTH },
      };
      const nextEdges = [...withoutConflict, newEdge];
      const nextNodes = refreshDynamicSockets(nodes, nextEdges, graph.nodes, registry);
      setNodes(nextNodes);
      setEdges(nextEdges);
      commit(nextNodes, nextEdges);
    },
    [commit, edges, graph, nodes, onGraphChange, registry, setEdges, setNodes],
  );

  const edgeReconnectSuccessful = useRef(true);

  const onReconnectStart = useCallback(() => {
    edgeReconnectSuccessful.current = false;
  }, []);

  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: FlowConnection) => {
      edgeReconnectSuccessful.current = true;
      if (!newConnection.source || !newConnection.target || !newConnection.sourceHandle || !newConnection.targetHandle) return;
      const withoutConflict = edges.filter(
        (e) => e.id !== oldEdge.id && !(e.target === newConnection.target && e.targetHandle === newConnection.targetHandle),
      );
      const newEdge: Edge = {
        id: `${newConnection.source}.${newConnection.sourceHandle}->${newConnection.target}.${newConnection.targetHandle}`,
        source: newConnection.source!,
        sourceHandle: newConnection.sourceHandle,
        target: newConnection.target!,
        targetHandle: newConnection.targetHandle,
        style: { stroke: edgeColor(nodes, newConnection.source!, newConnection.sourceHandle!), strokeWidth: EDGE_STROKE_WIDTH },
      };
      let nextEdges = [...withoutConflict, newEdge];
      const nextNodes = refreshDynamicSockets(nodes, nextEdges, graph.nodes, registry);

      nextEdges = nextEdges.filter((e) => {
        const srcNode = nextNodes.find((n) => n.id === e.source);
        const tgtNode = nextNodes.find((n) => n.id === e.target);
        if (!srcNode || !tgtNode) return false;
        const srcHasSocket = srcNode.data.outputs.some((s) => s.id === e.sourceHandle);
        const tgtHasSocket = tgtNode.data.inputs.some((s) => s.id === e.targetHandle);
        return srcHasSocket && tgtHasSocket;
      });

      setNodes(nextNodes);
      setEdges(nextEdges);
      commit(nextNodes, nextEdges);
    },
    [commit, edges, graph.nodes, nodes, registry, setEdges, setNodes],
  );

  const onReconnectEnd = useCallback(
    (_: any, edge: Edge) => {
      if (!edgeReconnectSuccessful.current) {
        let nextEdges = edges.filter((e) => e.id !== edge.id);
        const nextNodes = refreshDynamicSockets(nodes, nextEdges, graph.nodes, registry);

        nextEdges = nextEdges.filter((e) => {
          const srcNode = nextNodes.find((n) => n.id === e.source);
          const tgtNode = nextNodes.find((n) => n.id === e.target);
          if (!srcNode || !tgtNode) return false;
          const srcHasSocket = srcNode.data.outputs.some((s) => s.id === e.sourceHandle);
          const tgtHasSocket = tgtNode.data.inputs.some((s) => s.id === e.targetHandle);
          return srcHasSocket && tgtHasSocket;
        });

        setNodes(nextNodes);
        setEdges(nextEdges);
        commit(nextNodes, nextEdges);
      }
      edgeReconnectSuccessful.current = true;
    },
    [commit, edges, graph.nodes, nodes, registry, setEdges, setNodes],
  );

  const [searchModalOpen, setSearchModalOpen] = useState(false);

  const onConnectEnd = useCallback(
    (event: any) => {
      const handleInfo = connectingHandleRef.current;
      connectingHandleRef.current = null;

      if (!handleInfo || connectFiredRef.current) return;

      let clientX = 0;
      let clientY = 0;
      if (event && "clientX" in event && typeof event.clientX === "number") {
        clientX = event.clientX;
        clientY = event.clientY;
      } else if (event && "changedTouches" in event && event.changedTouches?.length) {
        clientX = event.changedTouches[0].clientX;
        clientY = event.changedTouches[0].clientY;
      }

      const position = screenToFlowPosition({ x: clientX, y: clientY });

      setPendingWireConnection({
        nodeId: handleInfo.nodeId,
        handleId: handleInfo.handleId,
        handleType: handleInfo.handleType,
        position,
      });
      setSearchModalOpen(true);
    },
    [screenToFlowPosition],
  );

  const onEdgeContextMenu: EdgeMouseHandler = useCallback(
    (event, edge) => {
      event.preventDefault();
      const nextEdges = applyEdgeChanges([{ type: "remove", id: edge.id }], edges);
      const nextNodes = refreshDynamicSockets(nodes, nextEdges, graph.nodes, registry);
      setNodes(nextNodes);
      setEdges(nextEdges);
      commit(nextNodes, nextEdges);
    },
    [commit, edges, graph.nodes, nodes, registry, setEdges, setNodes],
  );

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (event, edge) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();

        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const id = randomId();

        const rerouteDef = registry.get("utility/reroute");
        if (!rerouteDef) return;

        const instance: NodeInstance = {
          id,
          type: "utility/reroute",
          params: {},
          position: { x: position.x - 5, y: position.y - 5 },
        };

        const flowNode: Node<GraphNodeData> = {
          id,
          type: "graphNode",
          position: { x: position.x - 5, y: position.y - 5 },
          data: {
            nodeId: id,
            nodeType: "utility/reroute",
            label: "Reroute",
            category: "converter",
            inputs: [{ id: "in", label: "", type: "any" }],
            outputs: [{ id: "out", label: "", type: "any" }],
          },
        };

        const edge1: Edge = {
          id: `${edge.source}.${edge.sourceHandle}->${id}.in`,
          source: edge.source,
          sourceHandle: edge.sourceHandle,
          target: id,
          targetHandle: "in",
          style: edge.style,
        };

        const edge2: Edge = {
          id: `${id}.out->${edge.target}.${edge.targetHandle}`,
          source: id,
          sourceHandle: "out",
          target: edge.target,
          targetHandle: edge.targetHandle,
          style: edge.style,
        };

        const remainingEdges = edges.filter((e) => e.id !== edge.id);
        const nextEdges = [...remainingEdges, edge1, edge2];
        const unrefreshedNodes = [...nodes, flowNode];
        const nextNodes = refreshDynamicSockets(unrefreshedNodes, nextEdges, [...graph.nodes, instance], registry);

        setNodes(nextNodes);
        setEdges(nextEdges);
        onGraphChange?.(toGraph([...graph.nodes, instance], nextNodes, nextEdges, graph.keyframes, graph.markers, graph.exposedParams));
      }
    },
    [edges, graph, nodes, onGraphChange, registry, screenToFlowPosition, setEdges, setNodes],
  );

  const onNodeDragStop = useCallback(
    (event: unknown, draggedNode: Node<GraphNodeData>, draggedNodes?: Node<GraphNodeData>[]) => {
      if (event instanceof MouseEvent && event.shiftKey) {
        const nodesById = new Map(nodes.map((n) => [n.id, n]));
        const dimensionsOf = (n: Node<GraphNodeData>) => ({
          width: n.measured?.width ?? DEFAULT_NODE_WIDTH,
          height: n.measured?.height ?? DEFAULT_NODE_HEIGHT,
        });
        const draggedRect = { x: draggedNode.position.x, y: draggedNode.position.y, ...dimensionsOf(draggedNode) };

        const anchor = (n: Node<GraphNodeData>, side: "source" | "target") => {
          const { width, height } = dimensionsOf(n);
          return { x: n.position.x + (side === "source" ? width : 0), y: n.position.y + height / 2 };
        };

        const candidate = edges.find((edge) => {
          if (edge.source === draggedNode.id || edge.target === draggedNode.id) return false;
          const sourceNode = nodesById.get(edge.source);
          const targetNode = nodesById.get(edge.target);
          if (!sourceNode || !targetNode) return false;
          return segmentIntersectsRect(anchor(sourceNode, "source"), anchor(targetNode, "target"), draggedRect);
        });
        if (candidate) {
          const sourceSocket = nodesById.get(candidate.source)?.data.outputs.find((s) => s.id === candidate.sourceHandle);
          const targetSocket = nodesById.get(candidate.target)?.data.inputs.find((s) => s.id === candidate.targetHandle);
          if (sourceSocket && targetSocket) {
            const inSocket = findCompatibleSocket(draggedNode.data.inputs, sourceSocket.type);
            const outSocket = findCompatibleSocket(draggedNode.data.outputs, targetSocket.type);
            if (inSocket && outSocket) {
              const beforeEdge: Edge = {
                id: `${candidate.source}.${candidate.sourceHandle}->${draggedNode.id}.${inSocket.id}`,
                source: candidate.source,
                sourceHandle: candidate.sourceHandle,
                target: draggedNode.id,
                targetHandle: inSocket.id,
                style: candidate.style,
              };
              const afterEdge: Edge = {
                id: `${draggedNode.id}.${outSocket.id}->${candidate.target}.${candidate.targetHandle}`,
                source: draggedNode.id,
                sourceHandle: outSocket.id,
                target: candidate.target,
                targetHandle: candidate.targetHandle,
                style: { stroke: edgeColor(nodes, draggedNode.id, outSocket.id), strokeWidth: EDGE_STROKE_WIDTH },
              };

              const nextEdges = [
                ...edges.filter(
                  (e) => e.id !== candidate.id && !(e.target === draggedNode.id && e.targetHandle === inSocket.id),
                ),
                beforeEdge,
                afterEdge,
              ];
              const nextNodes = refreshDynamicSockets(nodes, nextEdges, graph.nodes, registry);
              setNodes(nextNodes);
              setEdges(nextEdges);
              commit(nextNodes, nextEdges);
              return;
            }
          }
        }
      }

      // Commit dragged positions for all dragged nodes
      const allDragged = draggedNodes && draggedNodes.length > 0 ? draggedNodes : [draggedNode];
      const draggedMap = new Map(allDragged.map((n) => [n.id, n.position]));
      const updatedNodes = graph.nodes.map((n) => {
        const newPos = draggedMap.get(n.id);
        return newPos ? { ...n, position: { x: newPos.x, y: newPos.y } } : n;
      });
      onGraphChange?.(toGraph(updatedNodes, nodes, edges, graph.keyframes, graph.markers, graph.exposedParams));
    },
    [commit, edges, graph.keyframes, graph.markers, graph.nodes, nodes, onGraphChange, registry, setEdges, setNodes],
  );

  const isMountedRef = useRef(false);
  useEffect(() => {
    isMountedRef.current = true;
  }, []);

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: { nodes: Node<GraphNodeData>[] }) => {
      const ids = selectedNodes.map((n) => n.id);
      if (!isMountedRef.current && ids.length === 0 && selectedIdsRef.current.size > 0) {
        return;
      }
      selectedIdsRef.current = new Set(ids);
      onSelectNodes?.(ids);
      if (selectedNodes.length === 1) {
        onSelectNode(selectedNodes[0].id);
      } else if (selectedNodes.length === 0) {
        onSelectNode(null);
      } else {
        onSelectNode(selectedNodes[0].id);
      }
    },
    [onSelectNode, onSelectNodes],
  );

  const [spawnCursorPos, setSpawnCursorPos] = useState<{ x: number; y: number }>({ x: 300, y: 180 });
  const spawnCursorPosRef = useRef(spawnCursorPos);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node<GraphNodeData>) => {
      selectedIdsRef.current = new Set([node.id]);
      onSelectNode(node.id);
      onSelectNodes?.([node.id]);
    },
    [onSelectNode, onSelectNodes],
  );
  /** Double-clicking a group opens it — the canvas shows its interior, the breadcrumb the way back. */
  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node<GraphNodeData>) => {
      const instance = graph.nodes.find((n) => n.id === node.id);
      if (!isGroupInstance(instance)) return;
      selectedIdsRef.current = new Set();
      onSelectNode(null);
      onSelectNodes?.([]);
      setGraphPath((path) => [...path, node.id]);
    },
    [graph.nodes, onSelectNode, onSelectNodes],
  );

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      selectedIdsRef.current = new Set();
      onSelectNode(null);
      onSelectNodes?.([]);
      if (event && typeof event.clientX === "number") {
        const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        spawnCursorPosRef.current = flowPos;
        setSpawnCursorPos(flowPos);
      }
    },
    [onSelectNode, onSelectNodes, screenToFlowPosition],
  );

  const addNode = useCallback(
    (type: string) => {
      const def = registry.get(type);
      if (!def) return;
      const id = randomId();

      const currentSpawnPos = spawnCursorPosRef.current;
      const position = pendingWireConnection
        ? { x: pendingWireConnection.position.x, y: pendingWireConnection.position.y }
        : { x: currentSpawnPos.x - DEFAULT_NODE_WIDTH / 2, y: currentSpawnPos.y - DEFAULT_NODE_HEIGHT / 2 };

      const instance: NodeInstance = {
        id,
        type,
        params: cloneParams(def.defaultParams || {}),
        position,
      };

      const inputs = def.dynamicInputs ? def.dynamicInputs([]) : def.inputs;
      const outputs = def.outputs;

      const flowNode: Node<GraphNodeData> = {
        id,
        type: "graphNode",
        position,
        data: {
          nodeId: id,
          nodeType: type,
          label: def.label,
          category: def.category,
          inputs,
          outputs,
        },
      };

      let nextEdges = [...edges];

      if (pendingWireConnection) {
        const sourceNode = nodes.find((n) => n.id === pendingWireConnection.nodeId);

        if (pendingWireConnection.handleType === "source") {
          const sourceSocket = sourceNode?.data.outputs.find((s) => s.id === pendingWireConnection.handleId);
          const sourceType = sourceSocket?.type || "any";
          const matchingInput =
            inputs.find((s) => s.type === sourceType || s.type === "any" || sourceType === "any") || inputs[0];

          if (matchingInput) {
            const newEdge: Edge = {
              id: `${pendingWireConnection.nodeId}.${pendingWireConnection.handleId}->${id}.${matchingInput.id}`,
              source: pendingWireConnection.nodeId,
              sourceHandle: pendingWireConnection.handleId,
              target: id,
              targetHandle: matchingInput.id,
              style: {
                stroke: edgeColor(nodes, pendingWireConnection.nodeId, pendingWireConnection.handleId),
                strokeWidth: EDGE_STROKE_WIDTH,
              },
            };
            nextEdges.push(newEdge);
          }
        } else if (pendingWireConnection.handleType === "target") {
          const targetSocket = sourceNode?.data.inputs.find((s) => s.id === pendingWireConnection.handleId);
          const targetType = targetSocket?.type || "any";
          const matchingOutput =
            outputs.find((s) => s.type === targetType || s.type === "any" || targetType === "any") || outputs[0];

          if (matchingOutput) {
            const withoutConflict = nextEdges.filter(
              (e) => !(e.target === pendingWireConnection.nodeId && e.targetHandle === pendingWireConnection.handleId),
            );
            const newEdge: Edge = {
              id: `${id}.${matchingOutput.id}->${pendingWireConnection.nodeId}.${pendingWireConnection.handleId}`,
              source: id,
              sourceHandle: matchingOutput.id,
              target: pendingWireConnection.nodeId,
              targetHandle: pendingWireConnection.handleId,
              style: {
                stroke: SOCKET_COLOR[matchingOutput.type] || "#6b7280",
                strokeWidth: EDGE_STROKE_WIDTH,
              },
            };
            nextEdges = [...withoutConflict, newEdge];
          }
        }

        setPendingWireConnection(null);
      }

      const newInstances: NodeInstance[] = [instance];
      const newFlowNodes: Node<GraphNodeData>[] = [flowNode];

      // Auto-couple Directional and Spot Lights with an Empty target object
      if ((type === "light/directional" || type === "light/spot") && !pendingWireConnection) {
        const emptyDef = registry.get("object/empty");
        if (emptyDef) {
          const emptyId = randomId();
          const emptyPos = { x: position.x - 260, y: position.y };
          const emptyInstance: NodeInstance = {
            id: emptyId,
            type: "object/empty",
            params: cloneParams(emptyDef.defaultParams || {}),
            position: emptyPos,
          };
          const emptyFlowNode: Node<GraphNodeData> = {
            id: emptyId,
            type: "graphNode",
            position: emptyPos,
            data: {
              nodeId: emptyId,
              nodeType: "object/empty",
              label: "Target (Empty)",
              category: emptyDef.category,
              inputs: emptyDef.inputs,
              outputs: emptyDef.outputs,
            },
          };
          const targetEdge: Edge = {
            id: `${emptyId}.geometry->${id}.target`,
            source: emptyId,
            sourceHandle: "geometry",
            target: id,
            targetHandle: "target",
            style: {
              stroke: SOCKET_COLOR.geometry || "#22c55e",
              strokeWidth: EDGE_STROKE_WIDTH,
            },
          };
          newInstances.push(emptyInstance);
          newFlowNodes.push(emptyFlowNode);
          nextEdges.push(targetEdge);
        }
      }

      const unrefreshedNodes = [...nodes, ...newFlowNodes];
      const finalNodes = refreshDynamicSockets(unrefreshedNodes, nextEdges, [...graph.nodes, ...newInstances], registry);

      setNodes(finalNodes);
      setEdges(nextEdges);
      onGraphChange?.(toGraph([...graph.nodes, ...newInstances], finalNodes, nextEdges, graph.keyframes, graph.markers, graph.exposedParams));
    },
    [graph, nodes, edges, pendingWireConnection, onGraphChange, registry, setNodes, setEdges],
  );

  const getSelectedNodeInstances = useCallback(() => {
    const selectedFlowNodes = nodes.filter((n) => n.selected);
    if (selectedFlowNodes.length > 0) {
      const selectedIds = new Set(selectedFlowNodes.map((n) => n.id));
      return graph.nodes.filter((n) => selectedIds.has(n.id));
    }
    if (selectedNodeId) {
      return graph.nodes.filter((n) => n.id === selectedNodeId);
    }
    return [];
  }, [graph.nodes, nodes, selectedNodeId]);

  const copySelected = useCallback(() => {
    const selected = getSelectedNodeInstances();
    if (selected.length === 0) return;

    const selectedIds = new Set(selected.map((n) => n.id));
    const internalConnections = graph.connections.filter(
      (c) => selectedIds.has(c.fromNode) && selectedIds.has(c.toNode),
    );

    const relevantKeyframes: KeyframeStore = {};
    if (graph.keyframes) {
      for (const id of selectedIds) {
        if (graph.keyframes[id]) {
          relevantKeyframes[id] = graph.keyframes[id];
        }
      }
    }

    setGraphClipboard({
      nodes: selected,
      connections: internalConnections,
      keyframes: relevantKeyframes,
    });
  }, [getSelectedNodeInstances, graph.connections, graph.keyframes]);

  const pasteClipboard = useCallback(
    (offset: number | boolean = 30) => {
      const clip = getGraphClipboard();
      if (!clip || clip.nodes.length === 0) return;

      const { nodes: clipNodes, connections: clipConns, keyframes: clipKeyframes } = clip;
      const idMap = new Map<string, string>();
      const px = offset === true ? 30 : offset === false ? 0 : offset;

      const newInstances: NodeInstance[] = clipNodes.map((n: NodeInstance) => {
        const newId = randomId();
        idMap.set(n.id, newId);
        return {
          id: newId,
          type: n.type,
          position: { x: n.position.x + px, y: n.position.y + px },
          params: cloneParams(n.params),
        };
      });

      // The copies become the selection — this also feeds the graph→flow sync
      // effect (selectedIdsRef), which would otherwise leave the *originals*
      // selected and elevated above the new nodes.
      selectedIdsRef.current = new Set(newInstances.map((n) => n.id));

    const newConnections: Connection[] = clipConns.map((c: Connection) => ({
      id: `${idMap.get(c.fromNode)}.${c.fromSocket}->${idMap.get(c.toNode)}.${c.toSocket}`,
      fromNode: idMap.get(c.fromNode)!,
      fromSocket: c.fromSocket,
      toNode: idMap.get(c.toNode)!,
      toSocket: c.toSocket,
    }));

    const nextKeyframes: KeyframeStore = graph.keyframes ? cloneKeyframes(graph.keyframes)! : {};
    if (clipKeyframes) {
      for (const [oldId, paramMap] of Object.entries(clipKeyframes)) {
        const newId = idMap.get(oldId);
        if (newId) {
          nextKeyframes[newId] = {};
          for (const [paramKey, list] of Object.entries(paramMap)) {
            nextKeyframes[newId][paramKey] = list.map((kf) => ({
              frame: kf.frame,
              value: cloneParamValue(kf.value),
              easeIn: kf.easeIn,
              easeStrength: kf.easeStrength,
              easeBezier: kf.easeBezier ? ([...kf.easeBezier] as [number, number, number, number]) : undefined,
            }));
          }
        }
      }
    }

    const newFlowNodes: Node<GraphNodeData>[] = newInstances.map((instance) => {
      const def = resolveDefinition(instance, registry);
      return {
        id: instance.id,
        type: "graphNode",
        position: instance.position,
        selected: true,
        data: {
          nodeId: instance.id,
          nodeType: instance.type,
          label: def?.label ?? instance.type,
          category: def?.category,
          inputs: def?.dynamicInputs ? def.dynamicInputs([]) : def?.inputs ?? [],
          outputs: def?.outputs ?? [],
          params: instance.params,
        },
      };
    });

    const unselectedPrevNodes = nodes.map((n) => ({ ...n, selected: false }));
    const nextFlowNodes = [...unselectedPrevNodes, ...newFlowNodes];

    const newEdges: Edge[] = newConnections.map((c) => ({
      id: c.id,
      source: c.fromNode,
      sourceHandle: c.fromSocket,
      target: c.toNode,
      targetHandle: c.toSocket,
      style: {
        stroke: edgeColor(nextFlowNodes, c.fromNode, c.fromSocket),
        strokeWidth: EDGE_STROKE_WIDTH,
      },
    }));

    const nextGraph: Graph = {
      nodes: [...graph.nodes, ...newInstances],
      connections: [...graph.connections, ...newConnections],
      keyframes: nextKeyframes,
      markers: graph.markers,
      exposedParams: graph.exposedParams,
    };

    setNodes(nextFlowNodes);
    setEdges((prevEdges) => [...prevEdges, ...newEdges]);
    onGraphChange?.(nextGraph);

    if (newInstances.length === 1) {
      onSelectNode(newInstances[0].id);
    }

    setGraphClipboard({
      nodes: newInstances,
      connections: newConnections,
      keyframes: clipKeyframes ? Object.fromEntries(
        newInstances.map((inst) => [inst.id, nextKeyframes[inst.id] ?? {}])
      ) : undefined,
    });
  }, [graph, nodes, onGraphChange, onSelectNode, registry, setEdges, setNodes]);

  const duplicateSelected = useCallback(() => {
    copySelected();
    // In front of the original (selected) but nudged down-right so it's visible.
    pasteClipboard(24);
  }, [copySelected, pasteClipboard]);

  /** Cmd+G — the selection becomes one group node, which then becomes the selection. */
  const groupSelected = useCallback(() => {
    const selected = getSelectedNodeInstances();
    if (selected.length === 0) return;

    const result = groupSelection(graph, selected.map((n) => n.id), registry, randomId);
    if (!result) return;

    selectedIdsRef.current = new Set([result.groupId]);
    onGraphChange?.(result.graph);
    onSelectNode(result.groupId);
    onSelectNodes?.([result.groupId]);
  }, [getSelectedNodeInstances, graph, onGraphChange, onSelectNode, onSelectNodes, registry]);

  /** Cmd+Shift+G — every selected group spills its contents back into this level. */
  const ungroupSelected = useCallback(() => {
    const groups = getSelectedNodeInstances().filter(isGroupInstance);
    if (groups.length === 0) return;

    let next = graph;
    for (const group of groups) next = ungroupNode(next, group.id) ?? next;
    if (next === graph) return;

    selectedIdsRef.current = new Set();
    onGraphChange?.(next);
    onSelectNode(null);
    onSelectNodes?.([]);
  }, [getSelectedNodeInstances, graph, onGraphChange, onSelectNode, onSelectNodes]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          (activeEl as HTMLElement).isContentEditable);

      if (isInput) return;

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      const code = e.code;

      // Cmd+Space (or Ctrl+Space) opens the node search modal everywhere in the app,
      // as long as the user is not typing in a text field.
      if (isCmdOrCtrl && (code === "Space" || e.key === " ")) {
        e.preventDefault();
        setSearchModalOpen(true);
        return;
      }

      // Delete / Backspace: timeline shortcuts own Delete when the cursor is over the timeline.
      // Otherwise, Delete / Backspace deletes selected nodes or edges in the graph.
      if (e.key === "Delete" || e.key === "Backspace") {
        if (isTimelineZone()) return;

        const selNodes = nodes.filter(
          (n) => n.selected || selectedIdsRef.current.has(n.id) || (selectedNodeId && n.id === selectedNodeId),
        );
        const selEdges = edges.filter((ed) => ed.selected);
        if (selNodes.length > 0 || selEdges.length > 0) {
          e.preventDefault();
          if (selNodes.length > 0) onNodesDelete(selNodes);
          if (selEdges.length > 0) onEdgesDelete(selEdges);
        }
        return;
      }

      // Node shortcuts only apply when not over the timeline
      if (isTimelineZone()) return;

      if (isCmdOrCtrl && code === "KeyG") {
        e.preventDefault();
        if (isShift) ungroupSelected();
        else groupSelected();
      } else if (isCmdOrCtrl && isShift && code === "KeyM") {
        e.preventDefault();
        addNode("merge");
      } else if (isCmdOrCtrl && isShift && code === "KeyT") {
        e.preventDefault();
        addNode("transform/matrix-transform");
      } else if (isCmdOrCtrl && isShift && code === "KeyV") {
        e.preventDefault();
        addNode("value/constant");
      } else if (isCmdOrCtrl && !isShift && code === "KeyT") {
        e.preventDefault();
        addNode("transform");
      } else if (isCmdOrCtrl && !isShift && code === "KeyP") {
        e.preventDefault();
        addNode("transform/parent");
      } else if (isCmdOrCtrl && !isShift && code === "KeyM") {
        e.preventDefault();
        addNode("value/math");
      } else if (isCmdOrCtrl && !isShift && code === "KeyD") {
        e.preventDefault();
        duplicateSelected();
      } else if (isCmdOrCtrl && !isShift && code === "KeyC") {
        e.preventDefault();
        copySelected();
      } else if (isCmdOrCtrl && !isShift && code === "KeyV") {
        e.preventDefault();
        pasteClipboard();
      } else if (isCmdOrCtrl && !isShift && e.key.toLowerCase() === "a") {
        if (!isViewportZone()) {
          e.preventDefault();
          setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    addNode,
    copySelected,
    duplicateSelected,
    groupSelected,
    ungroupSelected,
    edges,
    nodes,
    onEdgesDelete,
    onNodesDelete,
    pasteClipboard,
    selectedNodeId,
    setNodes,
  ]);

  const { fitView, setCenter } = useReactFlow();

  useEffect(() => {
    const timer = setTimeout(() => {
      fitView({ padding: 0.25, duration: 400 });
    }, 60);
    return () => clearTimeout(timer);
  }, [fitView]);

  // Diving into a group (or climbing back out) swaps the whole content of the
  // canvas while the pan and zoom stay where they were — which lands you
  // looking at empty space next to the level you asked for. Frame it instead.
  const framedPathRef = useRef<string>("");
  useEffect(() => {
    const key = graphPath.join("/");
    if (framedPathRef.current === key) return;
    framedPathRef.current = key;
    const timer = setTimeout(() => fitView({ padding: 0.25, duration: 300 }), 30);
    return () => clearTimeout(timer);
  }, [graphPath, fitView]);

  // "F" frames the selected node — only while the mouse is actually over
  // this canvas, so pressing F with the cursor over the 3D viewport (its own
  // "F" binding, see Viewport.tsx) doesn't also yank the graph view.
  useEffect(() => {
    const handleFrameKey = (e: KeyboardEvent) => {
      if (!isGraphZone() || e.key.toLowerCase() !== "f" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isKeyReservedForPlayback(e)) return;
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || (activeEl as HTMLElement).isContentEditable);
      if (isInput || !selectedNodeId) return;

      const node = graph.nodes.find((n) => n.id === selectedNodeId);
      if (!node) return;
      e.preventDefault();
      setCenter(node.position.x + DEFAULT_NODE_WIDTH / 2, node.position.y + DEFAULT_NODE_HEIGHT / 2, {
        zoom: 1.2,
        duration: 400,
      });
    };
    window.addEventListener("keydown", handleFrameKey);
    return () => window.removeEventListener("keydown", handleFrameKey);
  }, [selectedNodeId, graph.nodes, setCenter]);

  // Group nodes are built by Cmd+G, boundary nodes by the group that owns
  // them — placing either by hand would produce a node with no interior and
  // no ports, so they stay out of the palette and the search.
  const paletteNodes = useMemo(
    () => [...registry.values()].filter((def) => !GROUP_INTERNAL_TYPES.has(def.type)),
    [registry],
  );

  return (
    <div
      className="graph-editor"
      onMouseEnter={() => setInputZone("graph")}
      onMouseMove={() => {
        if (getInputZone() !== "graph") setInputZone("graph");
      }}
      onPointerDown={() => {
        if (getInputZone() !== "graph") setInputZone("graph");
      }}
      onMouseLeave={() => {
        if (getInputZone() === "graph") setInputZone(null);
      }}
    >
      <NodePalette nodes={paletteNodes} onAddNode={addNode} />
      <div className="graph-editor-canvas">
        <QuickAddToolbar onAddNode={addNode} onOpenSearch={() => setSearchModalOpen(true)} />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          onReconnectStart={onReconnectStart}
          onReconnect={onReconnect}
          onReconnectEnd={onReconnectEnd}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onEdgeContextMenu={onEdgeContextMenu}
          onEdgeClick={onEdgeClick}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onPaneClick={onPaneClick}
          onSelectionChange={onSelectionChange}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode={["Shift", "Meta", "Control"]}
          selectionKeyCode={null}
          deleteKeyCode={null}
          panOnDrag={[1, 2]}
          panOnScroll={false}
          minZoom={0.05}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          colorMode="dark"
        >
          <Background color="#5b6572" gap={20} />
          <SpawnCursorMarker position={spawnCursorPos} />
        </ReactFlow>
        {breadcrumb.length > 0 && (
          <div className="graph-breadcrumb">
            <button type="button" onClick={() => setGraphPath([])}>
              Root
            </button>
            {breadcrumb.map((crumb, index) => (
              <span key={crumb.id}>
                <span className="graph-breadcrumb-sep">/</span>
                <button
                  type="button"
                  disabled={index === breadcrumb.length - 1}
                  onClick={() => setGraphPath((path) => path.slice(0, index + 1))}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
        )}
        {canvasCount && onSelectCanvas ? (
          <div className="canvas-selector">
            {Array.from({ length: canvasCount }, (_, index) => (
              <button
                key={index}
                type="button"
                className={
                  "canvas-selector-tab" +
                  (index === activeCanvas ? " canvas-selector-tab-active" : "") +
                  (emptyCanvases?.[index] ? " canvas-selector-tab-empty" : "")
                }
                onClick={() => onSelectCanvas(index)}
                title={`Canvas ${index + 1}${emptyCanvases?.[index] ? " (empty)" : ""}`}
              >
                {index + 1}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {searchModalOpen && (
        <NodeSearchModal
          registry={registry}
          onSelectNodeType={(type) => addNode(type)}
          onClose={() => {
            setSearchModalOpen(false);
            setPendingWireConnection(null);
          }}
        />
      )}
    </div>
  );
}

export function GraphEditor(props: GraphEditorProps) {
  return (
    <ReactFlowProvider>
      <GraphEditorContent {...props} />
    </ReactFlowProvider>
  );
}
