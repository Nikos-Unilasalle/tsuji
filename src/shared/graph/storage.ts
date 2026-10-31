import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { moveOpeningEasing } from "./evaluate";
import { DEFAULT_REGISTRY } from "./nodes";
import { LEGACY_ROTATION_MODE } from "./rotationMode";
import { pruneDanglingConnections } from "./pruneConnections";
import { CANVAS_COUNT, Graph, Marker, NodeRegistry, normalizeCanvases, Project } from "./types";
import { isTauri } from "../isTauri";

/**
 * Markers were saved as bare frame numbers before labels existed
 * ([[types.ts]]'s Marker). Accept both shapes so an old .tsuji still loads.
 */
function normalizeMarkers(raw: unknown): Marker[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => (typeof m === "number" ? { frame: m } : (m as Marker))).filter((m) => Number.isFinite(m?.frame));
}

export function ensureOvmExtension(filename: string): string {
  if (!filename) return "project_v1.tsuji";
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tsuji") || lower.endsWith(".json") || lower.endsWith(".ovm")) {
    return filename;
  }
  return `${filename}.tsuji`;
}

export function incrementFilename(filename: string): string {
  let ext = ".tsuji";
  let base = filename;

  if (filename.toLowerCase().endsWith(".tsuji")) {
    ext = ".tsuji";
    base = filename.slice(0, -6);
  } else if (filename.toLowerCase().endsWith(".json")) {
    ext = ".json";
    base = filename.slice(0, -5);
  } else if (filename.toLowerCase().endsWith(".ovm")) {
    ext = ".ovm";
    base = filename.slice(0, -4);
  }

  const match = base.match(/^(.+?)([_-]?[vV]?)(\d+)$/);

  if (match) {
    const prefix = match[1];
    const tag = match[2];
    const numStr = match[3];
    const nextNum = parseInt(numStr, 10) + 1;
    const paddedNum =
      numStr.startsWith("0") && numStr.length > 1
        ? String(nextNum).padStart(numStr.length, "0")
        : String(nextNum);
    const actualTag = tag || "_v";
    return `${prefix}${actualTag}${paddedNum}${ext}`;
  }

  return `${base}_v2${ext}`;
}

function cleanGraph(graph: Graph): Graph {
  return {
    nodes: (graph.nodes || []).map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: Math.round(n.position?.x ?? 0), y: Math.round(n.position?.y ?? 0) },
      params: n.params ? JSON.parse(JSON.stringify(n.params)) : {},
      // A group's interior is part of the document, cleaned by the same rules
      // at every depth rather than dumped as raw params.
      ...(n.subgraph ? { subgraph: cleanGraph(n.subgraph) } : {}),
    })),
    connections: (graph.connections || []).map((c) => ({
      id: c.id,
      fromNode: c.fromNode,
      fromSocket: c.fromSocket,
      toNode: c.toNode,
      toSocket: c.toSocket,
    })),
    keyframes: graph.keyframes ? JSON.parse(JSON.stringify(graph.keyframes)) : {},
    markers: Array.isArray(graph.markers)
      ? graph.markers.map((m) => ({ frame: m.frame, ...(m.label ? { label: m.label } : {}) }))
      : [],
    exposedParams: Array.isArray(graph.exposedParams)
      ? graph.exposedParams.map((e) => ({ nodeId: e.nodeId, paramId: e.paramId, ...(e.label ? { label: e.label } : {}) }))
      : [],
  };
}

/**
 * Marks files written since an easing belongs to the keyframe it arrives at (the opening
 * keyframe's easing no longer shapes anything). An unmarked file is migrated on load.
 */
const EASING_MODEL = "arrival";

/**
 * Marks files written since rotations have a Rotation Mode (rotationMode.ts).
 * In an unmarked file every node that takes one is given the mode rotations
 * were composed in before — so an old scene, its wired rotations and its
 * keyframes included, renders exactly as it did. New nodes get the new
 * default from their definition.
 */
const ROTATION_MODEL = "modes";

/** The plain-JSON object a saved graph is written as — what serializeGraph stringifies, for embedding in another payload. */
export function graphToData(graph: Graph): Record<string, unknown> {
  return { ...cleanGraph(graph), keyframeEasing: EASING_MODEL, rotationModel: ROTATION_MODEL };
}

export function serializeGraph(graph: Graph): string {
  return JSON.stringify(graphToData(graph), null, 2);
}

/**
 * A whole document — every canvas, plus which one was open.
 *
 * The single-graph shape stays readable forever (see deserializeProject), so
 * this is additive rather than a break: a file written before canvases
 * existed loads as canvas 1 with the rest empty.
 */
export function serializeProject(project: Project): string {
  return JSON.stringify(
    {
      canvases: normalizeCanvases(project.canvases).map(cleanGraph),
      activeCanvas: clampCanvasIndex(project.activeCanvas),
      keyframeEasing: EASING_MODEL,
      rotationModel: ROTATION_MODEL,
    },
    null,
    2,
  );
}

function clampCanvasIndex(index: unknown): number {
  const n = Math.round(Number(index));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(CANVAS_COUNT - 1, n));
}

function validateGraphShape(data: { nodes?: unknown; connections?: unknown }, where: string): void {
  if (!Array.isArray(data.nodes) || !Array.isArray(data.connections)) {
    throw new Error(`Invalid graph format${where}: missing 'nodes' or 'connections' arrays.`);
  }

  for (const n of data.nodes) {
    if (!n.id || !n.type || !n.position) {
      throw new Error(
        `Invalid node structure in graph${where}: missing required fields on node ${n?.id || "unknown"}.`,
      );
    }
    // A group carries a graph, which has to hold up as one: a malformed
    // interior would otherwise only surface once something tried to evaluate
    // it, several frames into a file that had already loaded "successfully".
    if (n.subgraph) validateGraphShape(n.subgraph, `${where} (inside group ${n.id})`);
  }

  for (const c of data.connections) {
    if (!c.id || !c.fromNode || !c.fromSocket || !c.toNode || !c.toSocket) {
      throw new Error(
        `Invalid connection structure in graph${where}: missing required fields on connection ${c?.id || "unknown"}.`,
      );
    }
  }
}

export function deserializeGraph(jsonString: string, registry: NodeRegistry = DEFAULT_REGISTRY): Graph {
  return graphFromData(JSON.parse(jsonString), registry);
}

/** Reads back what graphToData wrote (or any older single-graph file shape). Throws on a malformed graph. */
export function graphFromData(raw: unknown, registry: NodeRegistry = DEFAULT_REGISTRY): Graph {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid file format: content is not a valid JSON object.");
  }

  const data = raw as Parameters<typeof adoptGraph>[0] & { keyframeEasing?: unknown; rotationModel?: unknown };
  validateGraphShape(data, "");
  return adoptGraph(data, registry, data.keyframeEasing !== EASING_MODEL, data.rotationModel !== ROTATION_MODEL);
}

/**
 * Brings every node's params, groups' interiors included, up to its type's
 * current shape — see NodeDefinition.upgradeParams. `legacyRotation`: the file
 * predates Rotation Mode (see ROTATION_MODEL).
 */
function upgradeNodes(nodes: Graph["nodes"], registry: NodeRegistry, legacyRotation: boolean): Graph["nodes"] {
  return nodes.map((node) => {
    const def = registry.get(node.type);
    const upgrade = def?.upgradeParams;
    let params = upgrade ? upgrade({ ...(node.params ?? {}) }) : node.params;
    if (legacyRotation && def && "rotationMode" in def.defaultParams && !(params && "rotationMode" in params)) {
      params = { ...(params ?? {}), rotationMode: LEGACY_ROTATION_MODE };
    }
    const subgraph = node.subgraph
      ? { ...node.subgraph, nodes: upgradeNodes(node.subgraph.nodes, registry, legacyRotation) }
      : node.subgraph;
    return params === node.params && subgraph === node.subgraph ? node : { ...node, params, subgraph };
  });
}

function adoptGraph(
  data: { nodes: unknown[]; connections: unknown[]; keyframes?: unknown; markers?: unknown; exposedParams?: unknown },
  registry: NodeRegistry,
  migrateEasing: boolean,
  legacyRotation: boolean,
): Graph {
  // Sockets are a public surface — every saved file references them by id —
  // so a file outlives any socket that gets retired (the Camera's unused
  // geometry input, for one). The evaluator ignores a connection to a socket
  // that isn't declared any more, but the editor would still draw it,
  // anchored to a handle that no longer exists. Absorbing the difference here
  // means nothing downstream has to wonder whether a connection leads
  // anywhere.
  return pruneDanglingConnections(
    {
      nodes: upgradeNodes(data.nodes as Graph["nodes"], registry, legacyRotation),
      connections: data.connections as Graph["connections"],
      keyframes:
        data.keyframes && typeof data.keyframes === "object"
          ? migrateEasing
            ? moveOpeningEasing(data.keyframes as Graph["keyframes"])
            : (data.keyframes as Graph["keyframes"])
          : {},
      markers: normalizeMarkers(data.markers),
      exposedParams: Array.isArray(data.exposedParams) ? (data.exposedParams as Graph["exposedParams"]) : [],
    },
    registry,
  );
}

/**
 * Reads either shape: a multi-canvas document, or a single graph saved before
 * canvases existed — which becomes canvas 1, the remaining slots empty.
 * Nobody's old .ovm needs converting, and no version field has to be
 * consulted: the two shapes are told apart by whether `canvases` is there.
 */
export function deserializeProject(jsonString: string, registry: NodeRegistry = DEFAULT_REGISTRY): Project {
  const data = JSON.parse(jsonString);

  if (!data || typeof data !== "object") {
    throw new Error("Invalid file format: content is not a valid JSON object.");
  }

  if (!Array.isArray(data.canvases)) {
    validateGraphShape(data, "");
    return {
      canvases: normalizeCanvases([
        adoptGraph(data, registry, data.keyframeEasing !== EASING_MODEL, data.rotationModel !== ROTATION_MODEL),
      ]),
      activeCanvas: 0,
    };
  }

  const canvases = data.canvases.map((canvas: { nodes?: unknown; connections?: unknown }, i: number) => {
    validateGraphShape(canvas, ` (canvas ${i + 1})`);
    return adoptGraph(
      canvas as { nodes: unknown[]; connections: unknown[] },
      registry,
      data.keyframeEasing !== EASING_MODEL,
      data.rotationModel !== ROTATION_MODEL,
    );
  });

  return { canvases: normalizeCanvases(canvases), activeCanvas: clampCanvasIndex(data.activeCanvas) };
}

// Re-exported so the many existing `from "./storage"` importers keep working.
export { isTauri };

/**
 * Open file via native Tauri dialog or browser file picker.
 * Returns { project, filename } on success, null on cancel.
 */
export async function openProjectWithFilePicker(): Promise<{ project: Project; filename: string; path?: string } | null> {
  if (!isTauri()) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".tsuji,.json,.ovm";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        try {
          const text = await file.text();
          const project = deserializeProject(text);
          resolve({ project, filename: file.name });
        } catch (e) {
          alert("Error reading file: " + (e as Error).message);
          resolve(null);
        }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  }

  const selected = await dialogOpen({
    multiple: false,
    filters: [{ name: "Tsuji Project", extensions: ["tsuji", "json", "ovm"] }],
  });

  if (!selected || typeof selected !== "string") return null;

  const content = await readTextFile(selected);
  const project = deserializeProject(content);
  const parts = selected.split(/[\/\\]/);
  const filename = parts[parts.length - 1] || "project_v1.tsuji";
  return { project, filename, path: selected };
}

/**
 * Save file via native Tauri dialog or browser blob download.
 * Returns saved filename on success, null on cancel.
 */
export async function saveProjectAsWithFilePicker(
  project: Project,
  suggestedFilename: string
): Promise<string | null> {
  const filename = ensureOvmExtension(suggestedFilename);
  const jsonString = serializeProject(project);

  if (!isTauri()) {
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return filename;
  }

  const filePath = await dialogSave({
    defaultPath: filename,
    filters: [{ name: "Tsuji Project", extensions: ["tsuji"] }],
  });

  if (!filePath) return null;

  await writeTextFile(filePath, jsonString);
  const parts = filePath.split(/[\/\\]/);
  return parts[parts.length - 1] || filename;
}

/**
 * Save file directly to the given path (no dialog).
 * Used for "Save" (overwrite) and "Incremental Save".
 * Returns the resolved path/filename.
 */
export async function saveProjectToPath(
  project: Project,
  filePath: string
): Promise<string> {
  const jsonString = serializeProject(project);

  if (!isTauri()) {
    const parts = filePath.split(/[\/\\]/);
    const filename = parts[parts.length - 1] || filePath;
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return filename;
  }

  await writeTextFile(filePath, jsonString);
  const parts = filePath.split(/[\/\\]/);
  return parts[parts.length - 1] || filePath;
}
