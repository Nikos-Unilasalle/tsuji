/**
 * graphSvg.ts — Rend un Graph Tsuji en schéma SVG vectoriel propre, mono-teinte
 * (même esprit que VNStudio's vnToSvg.ts : pas de capture DOM de l'éditeur —
 * on redessine à partir des données du graphe + du registre de nœuds).
 *
 * - positions reprises de node.position (layout fidèle à l'éditeur)
 * - hauteur recalculée d'après le nombre de ports (boîtes nettes)
 * - type de socket encodé par la FORME du port, pas par la couleur — palette
 *   à une seule teinte (bordeaux/rose), pour un rendu qui imprime bien et
 *   reste lisible même sans les couleurs de sockets de l'éditeur
 * - béziers identiques à ReactFlow/@xyflow (source=Right, target=Left)
 *
 * Aucune dépendance sur React ni sur le DOM : utilisable dans l'app (export
 * bouton/raccourci) comme en script Node pour générer la documentation.
 */
import { save as dialogSave } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Connection, Graph, NodeDefinition, NodeInstance, NodeRegistry } from "../graph/types";
import type { SocketDef, SocketType } from "../graph/sockets";
import { resolveDefinition } from "../graph/groups";
import { isTauri } from "../isTauri";

export interface RenderGraphSvgOptions {
  title?: string;
  pad?: number;
  showPortLabels?: boolean;
  /** Only export this subset of node ids (e.g. the current selection). */
  onlyIds?: Set<string>;
}

// ---- Palette (une seule teinte : famille bordeaux/rose) ---------------------
export const GRAPH_SVG_PALETTE = {
  ink: "#7a1330",
  header: "#f3d3da",
  body: "#fdf3f5",
  port: "#b51d44",
  hollow: "#ffffff",
  edge: "#c8607a",
  muted: "#9a5566",
  bg: "#ffffff",
};

const HEADER_H = 30;
const ROW_H = 26;
const PORT_R = 5.5;
const DEFAULT_NODE_W = 180;
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif";

type Shape =
  | "disc" | "ring" | "disc_ring" | "square" | "square_ring"
  | "diamond" | "diamond_ring" | "triangle" | "triangle_ring" | "hexagon" | "star" | "cross";

/** Une forme par type de socket — c'est la forme, pas la couleur, qui porte le sens ici. */
const TYPE_SHAPE: Record<SocketType, Shape> = {
  value: "disc",
  vector: "triangle",
  matrix: "square",
  color: "diamond",
  geometry: "hexagon",
  texture: "ring",
  curve: "triangle_ring",
  material: "square_ring",
  list: "diamond_ring",
  text: "star",
  postprocess: "cross",
  any: "disc_ring",
};

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

/** calculateControlOffset de ReactFlow/@xyflow. */
function rfOffset(distance: number, curvature = 0.25): number {
  return distance >= 0 ? 0.5 * distance : curvature * 25 * Math.sqrt(-distance);
}

/** getBezierPath de @xyflow (source=Right, target=Left). */
function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const cx1 = x1 + rfOffset(x2 - x1);
  const cx2 = x2 - rfOffset(x2 - x1);
  return `M${x1.toFixed(1)},${y1.toFixed(1)} C${cx1.toFixed(1)},${y1.toFixed(1)} ` +
         `${cx2.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

/** Sockets effectifs d'une instance pour un côté donné, dynamicInputs/Outputs inclus. */
function resolveSockets(
  def: NodeDefinition,
  side: "inputs" | "outputs",
  node: NodeInstance,
  connections: Connection[],
): SocketDef[] {
  const nodeConnections = connections.filter((c) =>
    side === "inputs" ? c.toNode === node.id : c.fromNode === node.id,
  );
  const dynamic = side === "inputs" ? def.dynamicInputs : def.dynamicOutputs;
  return dynamic ? (dynamic(nodeConnections, undefined, node.params) ?? def[side]) : def[side];
}

function nodeGeom(inputs: SocketDef[], outputs: SocketDef[]): [number, number] {
  const w = DEFAULT_NODE_W;
  const rows = Math.max(inputs.length, outputs.length, 1);
  return [w, HEADER_H + ROW_H * rows + 10];
}

function portXY(
  node: NodeInstance,
  w: number,
  side: "in" | "out",
  ports: SocketDef[],
  socketId: string,
): [number, number] {
  let idx = ports.findIndex((p) => p.id === socketId);
  if (idx < 0) idx = 0;
  const cx = side === "in" ? node.position.x : node.position.x + w;
  const cy = node.position.y + HEADER_H + idx * ROW_H + ROW_H / 2 + 5;
  return [cx, cy];
}

function portShape(cx: number, cy: number, kind: Shape): string {
  const r = PORT_R, p = GRAPH_SVG_PALETTE.port, ring = GRAPH_SVG_PALETTE.hollow;
  const f = (n: number) => n.toFixed(1);
  switch (kind) {
    case "disc":
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${r}" fill="${p}"/>`;
    case "ring":
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${r}" fill="${ring}" stroke="${p}" stroke-width="2"/>`;
    case "disc_ring":
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${r + 1}" fill="${ring}" stroke="${p}" stroke-width="1.5"/>` +
             `<circle cx="${f(cx)}" cy="${f(cy)}" r="2" fill="${p}"/>`;
    case "square":
      return `<rect x="${f(cx - r)}" y="${f(cy - r)}" width="${2 * r}" height="${2 * r}" rx="1" fill="${p}"/>`;
    case "square_ring":
      return `<rect x="${f(cx - r)}" y="${f(cy - r)}" width="${2 * r}" height="${2 * r}" rx="1" fill="${ring}" stroke="${p}" stroke-width="2"/>`;
    case "diamond":
      return `<path d="M${f(cx)},${f(cy - r - 1)} L${f(cx + r + 1)},${f(cy)} L${f(cx)},${f(cy + r + 1)} L${f(cx - r - 1)},${f(cy)} Z" fill="${p}"/>`;
    case "diamond_ring":
      return `<path d="M${f(cx)},${f(cy - r - 1)} L${f(cx + r + 1)},${f(cy)} L${f(cx)},${f(cy + r + 1)} L${f(cx - r - 1)},${f(cy)} Z" fill="${ring}" stroke="${p}" stroke-width="2"/>`;
    case "triangle":
      return `<path d="M${f(cx - r)},${f(cy - r)} L${f(cx + r + 1)},${f(cy)} L${f(cx - r)},${f(cy + r)} Z" fill="${p}"/>`;
    case "triangle_ring":
      return `<path d="M${f(cx - r)},${f(cy - r)} L${f(cx + r + 1)},${f(cy)} L${f(cx - r)},${f(cy + r)} Z" fill="${ring}" stroke="${p}" stroke-width="2"/>`;
    case "hexagon": {
      const pts = [0, 60, 120, 180, 240, 300].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return `${f(cx + r * Math.cos(rad))},${f(cy + r * Math.sin(rad))}`;
      });
      return `<polygon points="${pts.join(" ")}" fill="${p}"/>`;
    }
    case "star": {
      const pts: string[] = [];
      for (let i = 0; i < 8; i++) {
        const rad = (i * Math.PI) / 4;
        const rr = i % 2 === 0 ? r + 1.5 : r - 2;
        pts.push(`${f(cx + rr * Math.cos(rad))},${f(cy + rr * Math.sin(rad))}`);
      }
      return `<polygon points="${pts.join(" ")}" fill="${p}"/>`;
    }
    case "cross":
      return (
        `<rect x="${f(cx - r)}" y="${f(cy - 2)}" width="${2 * r}" height="4" fill="${p}"/>` +
        `<rect x="${f(cx - 2)}" y="${f(cy - r)}" width="4" height="${2 * r}" fill="${p}"/>`
      );
  }
}

/**
 * Rend un Graph Tsuji (ou un sous-ensemble via `onlyIds`) en SVG autonome.
 * `registry` doit connaître tous les types de nœuds présents dans `graph`.
 */
export function renderGraphToSvg(
  graph: Graph,
  registry: NodeRegistry,
  opts: RenderGraphSvgOptions = {},
): string {
  const { title, pad = 30, showPortLabels = true, onlyIds } = opts;

  const nodes = graph.nodes.filter((n) => !onlyIds || onlyIds.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  const connections = graph.connections.filter((c) => ids.has(c.fromNode) && ids.has(c.toNode));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (nodes.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`;

  const defOf = (n: NodeInstance): NodeDefinition =>
    resolveDefinition(n, registry) ?? { type: n.type, label: n.type, category: "utility", inputs: [], outputs: [], defaultParams: {}, evaluate: () => ({}) };
  const socketsOf = (n: NodeInstance) => {
    const def = defOf(n);
    return {
      def,
      inputs: resolveSockets(def, "inputs", n, graph.connections),
      outputs: resolveSockets(def, "outputs", n, graph.connections),
    };
  };
  const resolved = new Map(nodes.map((n) => [n.id, socketsOf(n)]));
  const geom = new Map(nodes.map((n) => {
    const r = resolved.get(n.id)!;
    return [n.id, nodeGeom(r.inputs, r.outputs)] as const;
  }));

  const minx = Math.min(...nodes.map((n) => n.position.x)) - pad;
  const miny = Math.min(...nodes.map((n) => n.position.y)) - pad - (title ? 26 : 0);
  const maxx = Math.max(...nodes.map((n) => n.position.x + geom.get(n.id)![0])) + pad;
  const maxy = Math.max(...nodes.map((n) => n.position.y + geom.get(n.id)![1])) + pad;
  const W = maxx - minx, H = maxy - miny;

  const P = GRAPH_SVG_PALETTE;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minx.toFixed(0)} ${miny.toFixed(0)} ${W.toFixed(0)} ${H.toFixed(0)}" ` +
    `width="${W.toFixed(0)}" height="${H.toFixed(0)}" font-family="${FONT}">`,
  );
  out.push(`<rect x="${minx.toFixed(0)}" y="${miny.toFixed(0)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" fill="${P.bg}"/>`);
  if (title) {
    out.push(`<text x="${(minx + pad).toFixed(0)}" y="${(miny + 24).toFixed(0)}" font-size="14" font-weight="600" fill="${P.ink}">${esc(title)}</text>`);
  }

  // arêtes (sous les nœuds)
  for (const c of connections) {
    const sn = byId.get(c.fromNode)!, dn = byId.get(c.toNode)!;
    const sr = resolved.get(sn.id)!, dr = resolved.get(dn.id)!;
    const [sw] = geom.get(sn.id)!;
    const [x1, y1] = portXY(sn, sw, "out", sr.outputs, c.fromSocket);
    const [x2, y2] = portXY(dn, geom.get(dn.id)![0], "in", dr.inputs, c.toSocket);
    out.push(`<path d="${bezier(x1, y1, x2, y2)}" fill="none" stroke="${P.edge}" stroke-width="2" stroke-linecap="round"/>`);
  }

  // nœuds
  for (const n of nodes) {
    const { def, inputs, outputs } = resolved.get(n.id)!;
    const x = n.position.x, y = n.position.y;
    const [w, h] = geom.get(n.id)!;
    const f = (v: number) => v.toFixed(0);

    out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="10" fill="${P.body}" stroke="${P.ink}" stroke-width="1.5"/>`);
    out.push(
      `<path d="M${f(x)},${f(y + HEADER_H)} L${f(x)},${f(y + 10)} ` +
      `Q${f(x)},${f(y)} ${f(x + 10)},${f(y)} L${f(x + w - 10)},${f(y)} ` +
      `Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + 10)} L${f(x + w)},${f(y + HEADER_H)} Z" ` +
      `fill="${P.header}" stroke="${P.ink}" stroke-width="1.5"/>`,
    );
    out.push(`<text x="${f(x + w / 2)}" y="${f(y + HEADER_H / 2 + 5)}" font-size="12.5" font-weight="600" text-anchor="middle" fill="${P.ink}">${esc(def.label)}</text>`);

    for (const [side, ports] of [["in", inputs], ["out", outputs]] as const) {
      ports.forEach((port) => {
        const [cx, cy] = portXY(n, w, side, ports, port.id);
        out.push(portShape(cx, cy, TYPE_SHAPE[port.type] ?? "disc"));
        if (showPortLabels) {
          out.push(
            side === "in"
              ? `<text x="${(cx + 12).toFixed(0)}" y="${(cy + 4).toFixed(0)}" font-size="11" fill="${P.muted}">${esc(port.label || port.id)}</text>`
              : `<text x="${(cx - 12).toFixed(0)}" y="${(cy + 4).toFixed(0)}" font-size="11" text-anchor="end" fill="${P.muted}">${esc(port.label || port.id)}</text>`,
          );
        }
      });
    }
  }

  out.push("</svg>");
  return out.join("\n");
}

/**
 * Save an exported SVG via the native save dialog (Tauri) or a browser
 * download (dev/web) — same isTauri() split storage.ts/videoExport.ts use for
 * project files and video exports. Returns the saved filename, or null if
 * the user cancelled.
 */
export async function saveGraphSvg(svg: string, suggestedFilename: string): Promise<string | null> {
  if (!isTauri()) {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedFilename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return suggestedFilename;
  }

  const filePath = await dialogSave({
    defaultPath: suggestedFilename,
    filters: [{ name: "SVG", extensions: ["svg"] }],
  });
  if (!filePath) return null;

  await writeTextFile(filePath, svg);
  const parts = filePath.split(/[\/\\]/);
  return parts[parts.length - 1] || suggestedFilename;
}
