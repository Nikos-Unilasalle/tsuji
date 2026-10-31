import { cloneParams, cloneKeyframes, cloneGraph } from "./cloneGraph";
import { DEFAULT_REGISTRY } from "./nodes";
import { rehydrateGraphParams } from "./rehydrateParams";
import { graphFromData, graphToData } from "./storage";
import { Connection, Graph, KeyframeStore, NodeInstance, NodeRegistry } from "./types";
import { randomId } from "../randomId";

export interface GraphClipboardData {
  nodes: NodeInstance[];
  connections: Connection[];
  keyframes?: KeyframeStore;
}

function cloneClipNode(n: NodeInstance): NodeInstance {
  return {
    id: n.id,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    params: cloneParams(n.params),
    // A group is its interior: without it a pasted group is an empty shell.
    ...(n.subgraph ? { subgraph: cloneGraph(n.subgraph) } : {}),
  };
}

let globalClipboard: GraphClipboardData | null = null;

/**
 * Ids of the system-clipboard payloads this instance wrote (or pasted from).
 * When the system clipboard still holds one of them, the in-memory copy is the
 * same nodes — newer even, after a paste or a duplicate re-filled it — and it
 * keeps what JSON cannot carry (THREE instances, loaded textures/meshes), so it
 * wins. Any other tsuji payload came from another window or document.
 */
const ownPayloadIds = new Set<string>();

export function setGraphClipboard(data: GraphClipboardData | null): void {
  if (!data || data.nodes.length === 0) {
    globalClipboard = null;
    return;
  }

  globalClipboard = {
    nodes: data.nodes.map(cloneClipNode),
    connections: data.connections.map((c) => ({ ...c })),
    keyframes: cloneKeyframes(data.keyframes),
  };
}

export function getGraphClipboard(): GraphClipboardData | null {
  if (!globalClipboard) return null;
  return {
    nodes: globalClipboard.nodes.map(cloneClipNode),
    connections: globalClipboard.connections.map((c) => ({ ...c })),
    keyframes: cloneKeyframes(globalClipboard.keyframes),
  };
}

export function hasGraphClipboard(): boolean {
  return globalClipboard !== null && globalClipboard.nodes.length > 0;
}

// ---------------------------------------------------------------------------
// System clipboard payload
//
// Copied nodes also go to the OS clipboard as text, so another tsuji window,
// browser tab, the desktop app, or the same instance after New/Open can paste
// them. The text is the same JSON a saved .tsuji uses for a graph (so params
// survive exactly as they would a save/reload), wrapped with a marker that
// tells it apart from any other text that happens to be JSON.
// ---------------------------------------------------------------------------

export const CLIPBOARD_FORMAT = "tsuji/nodes";
export const CLIPBOARD_VERSION = 1;

/**
 * Past this, the payload stays in memory only (still pasteable in this
 * window). Image-backed params are data URLs, and some OS clipboards and
 * browsers choke on hundreds of MB of text.
 */
export const MAX_SYSTEM_CLIPBOARD_CHARS = 64 * 1024 * 1024;

/** Serializes copied nodes for the system clipboard. Returns the text and the payload id it carries. */
export function serializeGraphClipboard(data: GraphClipboardData): { text: string; id: string } {
  const id = randomId();
  const graph: Graph = { nodes: data.nodes, connections: data.connections, keyframes: data.keyframes ?? {} };
  const text = JSON.stringify({ format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, id, graph: graphToData(graph) });
  return { text, id };
}

export interface ParsedGraphClipboard {
  id: string;
  data: GraphClipboardData;
}

/**
 * Reads a payload written by serializeGraphClipboard, with params rebuilt into
 * their THREE types. Anything else — plain text, foreign JSON, a payload from
 * a newer format, a malformed graph — is null, never an exception.
 */
export function parseGraphClipboard(text: string | null | undefined, registry: NodeRegistry = DEFAULT_REGISTRY): ParsedGraphClipboard | null {
  if (!text || text.length > MAX_SYSTEM_CLIPBOARD_CHARS) return null;
  // Cheap reject before parsing: most clipboard text is not JSON at all.
  const head = text.trimStart();
  if (!head.startsWith("{") || !text.includes(CLIPBOARD_FORMAT)) return null;
  try {
    const raw = JSON.parse(text) as { format?: unknown; version?: unknown; id?: unknown; graph?: unknown };
    if (!raw || typeof raw !== "object" || raw.format !== CLIPBOARD_FORMAT) return null;
    if (typeof raw.version !== "number" || raw.version > CLIPBOARD_VERSION) return null;
    const graph = rehydrateGraphParams(graphFromData(raw.graph, registry), registry);
    if (graph.nodes.length === 0) return null;
    const ids = new Set(graph.nodes.map((n) => n.id));
    return {
      id: typeof raw.id === "string" ? raw.id : "",
      data: {
        nodes: graph.nodes,
        // Only connections between the copied nodes mean anything once pasted.
        connections: graph.connections.filter((c) => ids.has(c.fromNode) && ids.has(c.toNode)),
        keyframes: graph.keyframes,
      },
    };
  } catch {
    return null;
  }
}

/** Remembers a payload id as this instance's own (see ownPayloadIds). */
export function markOwnClipboardPayload(id: string): void {
  if (id) ownPayloadIds.add(id);
}

/**
 * What a paste should use, given the system clipboard's text: nodes copied in
 * another instance or document when it holds a foreign tsuji payload, else
 * this instance's in-memory clipboard (unchanged in-app behaviour).
 */
export function resolvePasteClipboard(systemText: string | null | undefined): GraphClipboardData | null {
  const parsed = parseGraphClipboard(systemText);
  if (parsed && !ownPayloadIds.has(parsed.id)) {
    markOwnClipboardPayload(parsed.id);
    return parsed.data;
  }
  return getGraphClipboard();
}

/**
 * A group's interior with fresh node ids, recursively. Interior ids are
 * globally unique (see NodeInstance.subgraph), so a pasted group must not
 * share them with the group it was copied from. Every old→new id is added to
 * `idMap`, so keyframes of interior nodes can follow.
 */
export function freshSubgraph(graph: Graph, idMap: Map<string, string>, newId: () => string = randomId): Graph {
  for (const n of graph.nodes) idMap.set(n.id, newId());
  const map = (id: string) => idMap.get(id) ?? id;
  return {
    nodes: graph.nodes.map((n) => ({
      ...n,
      id: map(n.id),
      position: { x: n.position.x, y: n.position.y },
      params: cloneParams(n.params),
      ...(n.subgraph ? { subgraph: freshSubgraph(n.subgraph, idMap, newId) } : {}),
    })),
    connections: graph.connections.map((c) => ({
      id: `${map(c.fromNode)}.${c.fromSocket}->${map(c.toNode)}.${c.toSocket}`,
      fromNode: map(c.fromNode),
      fromSocket: c.fromSocket,
      toNode: map(c.toNode),
      toSocket: c.toSocket,
    })),
    keyframes: graph.keyframes
      ? Object.fromEntries(Object.entries(cloneKeyframes(graph.keyframes)!).map(([id, kf]) => [map(id), kf]))
      : graph.keyframes,
    markers: graph.markers?.map((m) => ({ ...m })),
    exposedParams: graph.exposedParams?.map((e) => ({ ...e, nodeId: map(e.nodeId) })),
  };
}
