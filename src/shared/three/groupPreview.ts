import * as THREE from "three";
import type { EvalResult } from "../graph/evaluate";
import { resolveDefinition } from "../graph/groups";
import { evaluateGroup } from "../graph/mesh/groupExpr";
import { ATTR_DOMAINS, domainSize, listGroups, type AttrDomain } from "../graph/mesh/polyAttributes";
import { readPolyMesh } from "../graph/mesh/polyIO";
import { worldMatrixOf } from "../graph/objectPosition";
import type { PolyMesh } from "../graph/quadMesh";
import type { Graph, NodeDefinition, NodeInstance, NodeRegistry, ParamFieldDef } from "../graph/types";
import type { ExpressionHover, ElementRef } from "../graph/groupPreviewStore";
import type { GroupLayer } from "./groupOverlay";

/*
 * Decides what the viewport's group overlay shows, from the graph, the last
 * evaluation and the selection:
 *
 *  - the selected node's own group: what a Group field picks on the node's
 *    input (what it will work on), or for a Select / Group node, the group
 *    it writes on its output;
 *  - a formula hovered in the group help, previewed the same way;
 *  - the groups ticked in the viewport's Groups menu, each in its colour;
 *  - the element under a Geometry Spreadsheet row the pointer is on.
 *
 * Plus the line of text the viewport shows about it (the badge) and the
 * groups the Groups menu offers.
 */

export const SELECTION_COLOR = "#ff8a3d";
export const HOVER_COLOR = "#fde047";
export const SHEET_COLOR = "#22d3ee";
export const GROUP_PALETTE = ["#38bdf8", "#a3e635", "#f472b6", "#fbbf24", "#c084fc", "#2dd4bf", "#f87171", "#e2e8f0"];

const PLURAL: Record<AttrDomain, string> = { point: "points", edge: "edges", face: "faces", corner: "corners" };

export interface AvailableGroup {
  key: string;
  name: string;
  domain: AttrDomain;
  count: number;
  total: number;
}

export interface LegendEntry extends AvailableGroup {
  color: string;
}

export interface GroupPreview {
  layers: GroupLayer[];
  /** One line about the selected node's group, or null when it has none. */
  badge: { text: string; error: boolean } | null;
  legend: LegendEntry[];
  /** Groups on the selected node's mesh, for the Groups menu. */
  available: AvailableGroup[];
}

export interface PreviewInput {
  graph: Graph;
  registry: NodeRegistry;
  results: EvalResult | null;
  selectedNodeId: string | null;
  /** Ticked in the Groups menu: `domain:name`. */
  shownGroups: readonly string[];
  expressionHover: ExpressionHover | null;
  sheetHover: ElementRef | null;
}

// ---------------------------------------------------------------- caches

const meshIds = new WeakMap<PolyMesh, number>();
let nextMeshId = 1;
function meshId(mesh: PolyMesh): number {
  let id = meshIds.get(mesh);
  if (!id) meshIds.set(mesh, (id = nextMeshId++));
  return id;
}

const evalCache = new Map<string, { mask: Uint8Array; count: number; unknown: string[]; error?: string }>();
function evaluate(mesh: PolyMesh, domain: AttrDomain, expression: string) {
  const key = `${meshId(mesh)}|${domain}|${expression}`;
  let hit = evalCache.get(key);
  if (!hit) {
    const r = evaluateGroup(mesh, domain, expression);
    let count = 0;
    for (const v of r.mask) if (v) count++;
    hit = { mask: r.mask, count, unknown: r.unknown, error: r.error };
    if (evalCache.size > 64) evalCache.delete(evalCache.keys().next().value!);
    evalCache.set(key, hit);
  }
  return hit;
}

// ---------------------------------------------------------------- graph helpers

function fieldsOf(def: NodeDefinition, node: NodeInstance): ParamFieldDef[] {
  try {
    return def.dynamicParamFields ? def.dynamicParamFields(node) : (def.paramFields ?? []);
  } catch {
    return def.paramFields ?? [];
  }
}

type GroupField = Extract<ParamFieldDef, { kind: "text" }>;

function groupFieldsOf(def: NodeDefinition, node: NodeInstance): GroupField[] {
  return fieldsOf(def, node).filter((f): f is GroupField => f.kind === "text" && (f as GroupField).help === "group");
}

function inputGeometry(graph: Graph, results: EvalResult, nodeId: string): unknown {
  const wire = graph.connections.find((c) => c.toNode === nodeId && c.toSocket === "geometry");
  return wire ? results.get(wire.fromNode)?.[wire.fromSocket] : undefined;
}

function polyOf(value: unknown): { mesh: PolyMesh; matrix: THREE.Matrix4 } | null {
  if (!(value instanceof THREE.Object3D)) return null;
  const read = readPolyMesh(value);
  return read ? { mesh: read.mesh, matrix: worldMatrixOf(read.srcMesh) } : null;
}

const isDomain = (v: unknown): v is AttrDomain => typeof v === "string" && (ATTR_DOMAINS as readonly string[]).includes(v);

/** The domain a group expression is read on: the field's own, the node's Domain param, else where its names live. */
function domainFor(field: GroupField | null, node: NodeInstance, mesh: PolyMesh, expression: string): AttrDomain {
  if (field?.domain && isDomain(field.domain)) return field.domain;
  if (isDomain(node.params.domain)) return node.params.domain;
  const names = expression.replace(/@[\w.]+\s*(==|!=|<=|>=|<|>)?\s*-?[\d.]*/g, " ").match(/[A-Za-z_][\w*]*/g) ?? [];
  const groups = listGroups(mesh);
  for (const name of names) {
    const re = new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const g = groups.find((x) => re.test(x.name));
    if (g) return g.domain;
  }
  return mesh.faces.length > 0 ? "face" : "point";
}

/** Select / Group nodes write a group (named by their Name param) rather than read one. */
function writesGroup(node: NodeInstance): boolean {
  return (node.type.startsWith("select/") || node.type.startsWith("group/")) && typeof node.params.name === "string";
}

// ---------------------------------------------------------------- main

export function computeGroupPreview(input: PreviewInput): GroupPreview {
  const out: GroupPreview = { layers: [], badge: null, legend: [], available: [] };
  const { graph, registry, results, selectedNodeId } = input;
  if (!results) return out;

  const node = selectedNodeId ? graph.nodes.find((n) => n.id === selectedNodeId) : undefined;
  const def = node ? resolveDefinition(node, registry) : undefined;

  if (node && def) {
    const fields = groupFieldsOf(def, node);
    const hover = input.expressionHover?.nodeId === node.id ? input.expressionHover : null;
    let target: { mesh: PolyMesh; matrix: THREE.Matrix4 } | null = null;
    let expression = "";
    let domain: AttrDomain = "face";
    let verb = "";

    if (hover) {
      target = polyOf(inputGeometry(graph, results, node.id));
      const field = fields.find((f) => f.id === hover.fieldId) ?? null;
      expression = hover.expression;
      if (target) domain = domainFor(field, node, target.mesh, expression);
      verb = "Preview";
    } else if (writesGroup(node)) {
      target = polyOf(results.get(node.id)?.geometry);
      expression = String(node.params.name ?? "").trim();
      if (target) domain = domainFor(null, node, target.mesh, expression);
      verb = "Writes";
    } else if (fields.length > 0) {
      const field = fields.find((f) => f.id === "group") ?? fields[0];
      target = polyOf(inputGeometry(graph, results, node.id));
      expression = String(node.params[field.id] ?? "").trim();
      if (target) domain = domainFor(field, node, target.mesh, expression);
      verb = "Works on";
    }

    if (target) {
      const total = domainSize(target.mesh, domain);
      const all = expression === "" || expression === "*";
      if (all) {
        out.badge = { text: `${verb}: everything · ${total} ${PLURAL[domain]}`, error: false };
      } else {
        const r = evaluate(target.mesh, domain, expression);
        const problem = r.error ? r.error : r.unknown.length ? `Unknown: ${r.unknown.join(", ")}` : "";
        out.badge = {
          text: `${verb} “${expression}” · ${r.count} / ${total} ${PLURAL[domain]}${problem ? ` · ${problem}` : ""}`,
          error: Boolean(problem) || r.count === 0,
        };
        if (r.count > 0) {
          const color = hover ? HOVER_COLOR : SELECTION_COLOR;
          out.layers.push({
            key: `sel|${meshId(target.mesh)}|${domain}|${expression}|${color}`,
            mesh: target.mesh,
            matrix: target.matrix,
            domain,
            mask: r.mask,
            color,
            context: true,
          });
        }
      }
    }

    // Groups on the node's result (its input when it has none of its own), for the menu.
    const own = polyOf(results.get(node.id)?.geometry) ?? polyOf(inputGeometry(graph, results, node.id));
    if (own) {
      const groups = listGroups(own.mesh);
      out.available = groups.map((g) => {
        const r = evaluate(own.mesh, g.domain, g.name);
        return { key: `${g.domain}:${g.name}`, name: g.name, domain: g.domain, count: r.count, total: domainSize(own.mesh, g.domain) };
      });
      input.shownGroups.forEach((key, i) => {
        const g = out.available.find((a) => a.key === key);
        if (!g) return;
        const color = GROUP_PALETTE[i % GROUP_PALETTE.length];
        out.legend.push({ ...g, color });
        if (g.count === 0) return;
        out.layers.push({
          key: `menu|${meshId(own.mesh)}|${key}|${color}`,
          mesh: own.mesh,
          matrix: own.matrix,
          domain: g.domain,
          mask: evaluate(own.mesh, g.domain, g.name).mask,
          color,
          context: out.layers.length === 0,
        });
      });
    }
  }

  // A spreadsheet row under the pointer: that one element, on the spreadsheet's own mesh.
  const sheet = input.sheetHover;
  if (sheet) {
    const sheetNode = graph.nodes.find((n) => n.id === sheet.nodeId);
    const target = sheetNode ? polyOf(results.get(sheetNode.id)?.geometry) : null;
    if (sheetNode && target) {
      const domain = isDomain(sheetNode.params.domain) ? sheetNode.params.domain : "point";
      const total = domainSize(target.mesh, domain);
      if (sheet.index >= 0 && sheet.index < total) {
        const mask = new Uint8Array(total);
        mask[sheet.index] = 1;
        out.layers.push({
          key: `sheet|${meshId(target.mesh)}|${domain}|${sheet.index}`,
          mesh: target.mesh,
          matrix: target.matrix,
          domain,
          mask,
          color: SHEET_COLOR,
          emphasis: true,
        });
      }
    }
  }
  return out;
}

/** The element of `domain` nearest a point given in the mesh's own space (viewport picking for the spreadsheet). */
export function nearestElement(mesh: PolyMesh, domain: AttrDomain, local: THREE.Vector3, positions: ArrayLike<number>): number {
  let best = -1;
  let bestD = Infinity;
  const n = Math.floor(positions.length / 3);
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - local.x, dy = positions[i * 3 + 1] - local.y, dz = positions[i * 3 + 2] - local.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  void mesh;
  void domain;
  return best;
}
