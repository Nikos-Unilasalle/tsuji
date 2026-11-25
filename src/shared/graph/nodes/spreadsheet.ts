import * as THREE from "three";
import type { NodeDefinition } from "../types";
import { setInspectorValue } from "../inspectorStore";
import { readPolyMesh } from "../mesh/polyIO";
import { quadMeshSignature } from "../quadMesh";
import { ATTR_DOMAINS, domainSize, listAttributeNames, listGroups, readAttribute, type AttrDomain } from "../mesh/polyAttributes";
import { evaluateGroup } from "../mesh/groupExpr";

/*
 * Geometry Spreadsheet — Houdini's Geometry Spreadsheet / Blender's
 * Spreadsheet editor, inside the node: one row per element of a domain, one
 * column per attribute, shown in the node body (GraphNode renders the table
 * the node leaves in the inspector store). The geometry passes through
 * untouched, so the node can sit anywhere in a chain.
 */

export const SPREADSHEET_TYPE = "attribute/spreadsheet";

export interface SpreadsheetTable {
  kind: "spreadsheet";
  domain: AttrDomain;
  /** Elements in the domain (and in the Group filter). */
  count: number;
  total: number;
  columns: string[];
  rows: { index: number; cells: string[] }[];
  groups: string[];
}

export function isSpreadsheetTable(v: unknown): v is SpreadsheetTable {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "spreadsheet";
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

const lastKey = new Map<string, string>();

export const SPREADSHEET_NODE: NodeDefinition = {
  type: SPREADSHEET_TYPE,
  label: "Geometry Spreadsheet",
  category: "attribute",
  inputs: [{ id: "geometry", label: "Geometry", type: "geometry", owns: true }],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { domain: "point", columns: "", group: "", rows: 12, offset: 0 },
  paramFields: [
    { id: "domain", label: "Domain", kind: "select", options: [...ATTR_DOMAINS] },
    { id: "columns", label: "Columns (empty = P + stored attributes)", kind: "text" },
    { id: "group", label: "Only Group", kind: "text" },
    { id: "rows", label: "Rows", kind: "number", step: 1 },
    { id: "offset", label: "First Row", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const obj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const read = obj ? readPolyMesh(obj) : null;
    if (!obj || !read) {
      setInspectorValue(ctx.nodeId, null);
      return { geometry: obj, count: 0 };
    }
    const domain = (ATTR_DOMAINS as readonly string[]).includes(String(params.domain)) ? (params.domain as AttrDomain) : "point";
    const key = [quadMeshSignature(read.mesh), domain, params.columns, params.group, params.rows, params.offset].join("|");
    const mesh = read.mesh;
    const total = domainSize(mesh, domain);
    if (lastKey.get(ctx.nodeId) === key) return { geometry: obj, count: total };
    lastKey.set(ctx.nodeId, key);

    const wanted = String(params.columns ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const columns = wanted.length ? wanted : ["P", ...listAttributeNames(mesh, domain, false)];
    const reads = columns.map((c) => readAttribute(mesh, domain, c));
    const mask = evaluateGroup(mesh, domain, String(params.group ?? "")).mask;
    const indices: number[] = [];
    for (let i = 0; i < total; i++) if (mask[i]) indices.push(i);
    const rowCount = Math.max(1, Math.min(200, Math.round(Number(params.rows) || 12)));
    const offset = Math.max(0, Math.min(indices.length - 1, Math.round(Number(params.offset) || 0)));
    const rows = indices.slice(offset, offset + rowCount).map((index) => ({
      index,
      cells: reads.map((r) => {
        if (!r) return "—";
        if (r.size === 1) return fmt(r.values[index]);
        return `(${[0, 1, 2].map((k) => fmt(r.values[index * r.size + k])).join(", ")})`;
      }),
    }));
    const table: SpreadsheetTable = {
      kind: "spreadsheet",
      domain,
      count: indices.length,
      total,
      columns: columns.map((c, i) => (reads[i] ? c : `${c}?`)),
      rows,
      groups: listGroups(mesh).map((g) => `${g.name}(${g.domain})`),
    };
    setInspectorValue(ctx.nodeId, table);
    return { geometry: obj, count: total };
  },
};
