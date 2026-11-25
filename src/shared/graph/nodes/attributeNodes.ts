import * as THREE from "three";
import type { EvalContext, NodeDefinition, ParamFieldDef } from "../types";
import type { PolyMesh } from "../quadMesh";
import {
  ATTR_DOMAINS,
  ATTR_TYPES,
  attrSize,
  attributeType,
  domainSize,
  isBuiltinAttribute,
  isValidAttributeName,
  listAttributeNames,
  readAttribute,
  removeAttribute,
  renameAttribute,
  setAttribute,
  type AttrDomain,
  type AttrType,
} from "../mesh/polyAttributes";
import { maskIndices } from "../mesh/groupExpr";
import { promoteValues, type PromoteReduce } from "../mesh/promote";
import { elementNormals, elementPositions } from "../mesh/selectOps";
import {
  ATTRIB_EXPR_FUNCTIONS,
  AttribExprError,
  cachedAttribExpr,
  layoutVariables,
  scanNames,
  type CompiledAttribExpr,
  type ExprKind,
} from "../mesh/attribExpr";
import { curlNoise3, fbmNoise3, hashRandom, randomUnitVector, signedNoise3 } from "../mesh/attribNoise";
import {
  LIST_MISMATCH,
  MEASURE_KINDS,
  TRANSFER_METHODS,
  baseValues,
  blurValues,
  canWrite,
  elementAdjacency,
  itemComponents,
  listItemSize,
  listToValues,
  literalNames,
  matchNames,
  measure,
  samplePixels,
  srgbToLinear,
  transferAttributes,
  type ListMismatch,
  type MeasureKind,
  type PixelSource,
  type TransferMethod,
} from "../mesh/attribOps";
import { ColorRamp, DEFAULT_COLOR_RAMP, sampleColorRamp } from "../colorRamp";
import { textureRevision } from "../gpuTexture";
import { createNodeCache } from "../nodeCaches";
import { getPixelBuffer, type TextureSampleState } from "./sampleTexture";
import { definePolyNode, type PolyRunContext } from "./polyModifier";

/*
 * Attribute nodes (phase 3 of docs/parametric-modeling-plan.md).
 *
 * Each takes a geometry and hands it back with named attributes created,
 * changed, moved between domains or removed (mesh/polyAttributes.ts). They
 * are built on definePolyNode, so all of them rebuild only when their input
 * mesh, params or wired inputs change, report what they did in the node's
 * status, and — where it makes sense — honour the Group field: elements
 * outside the group keep their old value.
 *
 * Writing `P` on points moves the mesh; `Cd` on corners changes the vertex
 * colours; `material_index` on faces the material slots; `sharp` / `seam` /
 * `crease` on edges the edge flags. Other built-ins (N, area, id…) are
 * computed from the geometry and refuse writes, which the status says.
 */

const DOMAIN_FIELD = (id = "domain", label = "Domain", group = "Attribute"): ParamFieldDef => ({ id, label, kind: "select", options: [...ATTR_DOMAINS], group });
const TYPE_FIELD = (id = "type", label = "Type", group = "Attribute", auto = false): ParamFieldDef => ({
  id,
  label,
  kind: "select",
  options: auto ? ["auto", ...ATTR_TYPES] : [...ATTR_TYPES],
  group,
});
const REDUCE_OPTIONS: PromoteReduce[] = ["average", "min", "max", "sum", "first"];

function pickDomain(run: PolyRunContext, id = "domain", fallback: AttrDomain = "point"): AttrDomain {
  const d = run.str(id, fallback);
  return (ATTR_DOMAINS as readonly string[]).includes(d) ? (d as AttrDomain) : fallback;
}

function pickType(raw: string, fallback: AttrType): AttrType {
  return (ATTR_TYPES as readonly string[]).includes(raw) ? (raw as AttrType) : fallback;
}

function pick<T extends string>(raw: string, options: readonly T[], fallback: T): T {
  return (options as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** A name the node can write, or null after saying why not. */
function writableName(run: PolyRunContext, domain: AttrDomain, raw: string, what = "Name"): string | null {
  const name = raw.trim();
  if (!name) {
    run.note(`${what} is empty`, true);
    return null;
  }
  if (!isValidAttributeName(name)) {
    run.note(`"${name}" is not a valid attribute name (letters, digits, _)`, true);
    return null;
  }
  if (!canWrite(domain, name)) {
    run.note(`"${name}" is computed from the geometry on ${domain}s and cannot be written — pick another name`, true);
    return null;
  }
  return name;
}

/**
 * An attribute read on `domain`, or — when the mesh only has it elsewhere —
 * promoted from the first domain that has it (averaged). Lets a formula read
 * `Cd` on points although colours live on corners, or `area` on points.
 */
function readAnywhere(mesh: PolyMesh, domain: AttrDomain, name: string): { type: AttrType; size: number; values: Float64Array; from: AttrDomain } | null {
  const own = readAttribute(mesh, domain, name);
  if (own) return { ...own, from: domain };
  for (const other of ATTR_DOMAINS) {
    if (other === domain) continue;
    const src = readAttribute(mesh, other, name);
    if (!src) continue;
    return { type: src.type, size: src.size, values: promoteValues(mesh, other, domain, src.values, src.size, "average"), from: other };
  }
  return null;
}

/** The timeline frame under the playhead (as math/expression's `f`). */
function frameOf(ctx: EvalContext): number {
  if (typeof ctx.currentFrame === "number" && ctx.currentFrame >= 0) return ctx.currentFrame;
  return Math.floor((Number.isFinite(ctx.time) ? ctx.time : 0) * (ctx.fps ?? 30) + 1e-6);
}

/**
 * definePolyNode rebuilds when params or wired inputs change, and only every
 * frame when the spec says `animated` — for all instances. These nodes are
 * animated only *sometimes* (a formula that reads `t`, Noise with Animate
 * on), so the wrapper slips the clock into the params exactly then: the
 * rebuild signature includes every param, and static setups stay cached.
 */
function withExtraParams(def: NodeDefinition, extra: (inputs: Record<string, unknown>, params: Record<string, unknown>, ctx: EvalContext) => Record<string, unknown> | null): NodeDefinition {
  return {
    ...def,
    evaluate: (inputs, params, ctx) => {
      const add = extra(inputs, params, ctx);
      return def.evaluate(inputs, add ? { ...params, ...add } : params, ctx);
    },
  };
}

function toColor(raw: unknown, fallback: number): THREE.Color {
  if (raw instanceof THREE.Color) return raw.clone();
  if (typeof raw === "string" || typeof raw === "number") {
    try {
      return new THREE.Color(raw as THREE.ColorRepresentation);
    } catch {
      return new THREE.Color(fallback);
    }
  }
  if (raw && typeof raw === "object" && "r" in raw) {
    const o = raw as { r: unknown; g: unknown; b: unknown };
    const c = [Number(o.r), Number(o.g), Number(o.b)];
    if (c.every(Number.isFinite)) return new THREE.Color(c[0], c[1], c[2]);
  }
  return new THREE.Color(fallback);
}

// ============================================================ Attribute Expression

const SLOTS = [1, 2, 3] as const;
const PARAM_LETTERS = ["a", "b", "c", "d"] as const;

export const EXPRESSION_HELP =
  "Per element: P N id count t f a–d and any attribute by name (P.x, Cd.r). " +
  "+ - * / % ^, 2x, (x, y, z), |v|, c ? a : b, < == && || !. Functions: " +
  ATTRIB_EXPR_FUNCTIONS.join(" · ");

interface ExprVarSource {
  name: string;
  kind: ExprKind;
  /** Per-element values (size 1 or 3), or a per-element reader, or a constant. */
  values?: Float64Array;
  list?: readonly unknown[];
  constant?: number[];
}

function wiredVariable(name: string, raw: unknown, param: unknown): ExprVarSource {
  if (Array.isArray(raw)) return { name, kind: listItemSize(raw) === 3 ? "vec3" : "float", list: raw };
  if (raw !== undefined && raw !== null) {
    const c = itemComponents(raw);
    if (c && c.length > 1) return { name, kind: "vec3", constant: [c[0] || 0, c[1] || 0, c[2] || 0].map((v) => (Number.isFinite(v) ? v : 0)) };
    if (c) return { name, kind: "float", constant: [Number.isFinite(c[0]) ? c[0] : 0] };
  }
  const n = Number(param);
  return { name, kind: "float", constant: [Number.isFinite(n) ? n : 0] };
}

interface Assignment {
  slot: number;
  name: string;
  type: AttrType;
  compiled: CompiledAttribExpr;
  values: Float64Array;
  old: Float64Array;
  size: number;
}

function formulasOf(params: Record<string, unknown>): string[] {
  return SLOTS.map((k) => String(params[`formula${k}`] ?? "")).filter((s) => s.trim());
}

function runExpression(run: PolyRunContext): PolyMesh {
  const mesh = run.mesh;
  const domain = pickDomain(run, "domain", "point");
  const count = domainSize(mesh, domain);
  const { mask } = run.group(domain);

  // Fixed variables first: they win over attributes of the same name.
  const sources: ExprVarSource[] = [
    { name: "id", kind: "float", values: Float64Array.from({ length: count }, (_, i) => i) },
    { name: "count", kind: "float", constant: [count] },
    { name: "t", kind: "float", constant: [Number.isFinite(run.ctx.time) ? run.ctx.time : 0] },
    { name: "f", kind: "float", constant: [frameOf(run.ctx)] },
    ...PARAM_LETTERS.map((l) => wiredVariable(l, run.inputs[l], run.params[l])),
  ];
  const declared = new Set(sources.map((s) => s.name));

  const rows = SLOTS.map((k) => ({
    slot: k,
    name: run.str(`name${k}`, "").trim(),
    type: run.str(`type${k}`, "auto"),
    formula: run.str(`formula${k}`, "").trim(),
  })).filter((r) => r.name || r.formula);
  if (rows.length === 0) {
    run.note("Write an assignment: Attribute name = formula", true);
    return mesh;
  }

  // Attributes the formulas read, declared from the mesh (promoted from
  // another domain when they live elsewhere).
  for (const r of rows) {
    for (const name of scanNames(r.formula)) {
      if (declared.has(name)) continue;
      const src = readAnywhere(mesh, domain, name);
      if (!src) continue;
      declared.add(name);
      sources.push({ name, kind: src.size === 3 ? "vec3" : "float", values: src.values });
      if (src.from !== domain) run.note(`${name}: read from ${src.from}s (averaged onto ${domain}s)`);
    }
  }
  // New attributes with an explicit type can read themselves (as 0) — `mass = mass + 1` on a fresh mesh.
  for (const r of rows) {
    if (!r.name || declared.has(r.name) || r.type === "auto" || !isValidAttributeName(r.name)) continue;
    const type = pickType(r.type, "float");
    declared.add(r.name);
    sources.push({ name: r.name, kind: attrSize(type) === 3 ? "vec3" : "float", values: baseValues(mesh, domain, r.name, type) });
  }

  const layout = () => layoutVariables(sources.map((s) => ({ name: s.name, kind: s.kind })));
  const assignments: Assignment[] = [];
  for (const r of rows) {
    const label = `Formula ${r.slot}`;
    if (!r.formula) {
      run.note(`${label}: empty — nothing written to "${r.name}"`, true);
      continue;
    }
    const name = writableName(run, domain, r.name, `Attribute ${r.slot}`);
    if (!name) continue;
    const compiled = cachedAttribExpr(r.formula, layout().vars);
    if (compiled instanceof AttribExprError) {
      run.note(`${label}: ${compiled.message} (at ${compiled.position + 1})`, true);
      continue;
    }
    const existing = attributeType(mesh, domain, name);
    const type: AttrType = r.type !== "auto" ? pickType(r.type, "float") : existing ?? (compiled.kind === "vec3" ? "vec3" : "float");
    const size = attrSize(type);
    if (compiled.kind === "vec3" && size === 1) {
      run.note(`${label}: gives a vector but "${name}" is ${type} — take a component (.x) or length()`, true);
      continue;
    }
    if (!declared.has(name)) {
      declared.add(name);
      sources.push({ name, kind: size === 3 ? "vec3" : "float", values: baseValues(mesh, domain, name, type) });
    }
    const old = baseValues(mesh, domain, name, type);
    assignments.push({ slot: r.slot, name, type, compiled, values: Float64Array.from(old), old, size });
  }
  if (assignments.length === 0) return mesh;

  const { vars, size: envSize } = layout();
  const env = new Float64Array(envSize);
  // Constants once; per-element sources every element.
  const perElement: { offset: number; size: number; values?: Float64Array; list?: readonly unknown[] }[] = [];
  for (const s of sources) {
    const slot = vars[s.name];
    const size = s.kind === "vec3" ? 3 : 1;
    if (s.constant) env.set(s.constant.slice(0, size), slot.offset);
    else perElement.push({ offset: slot.offset, size, values: s.values, list: s.list });
  }
  const writeBack = assignments.map((a) => {
    const slot = vars[a.name];
    // A formula that changes an attribute's size cannot feed the old-size slot.
    return slot && (slot.kind === "vec3" ? 3 : 1) === a.size ? slot.offset : -1;
  });
  const tmp = new Float64Array(3);
  let written = 0;
  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue;
    written++;
    for (const p of perElement) {
      if (p.values) {
        for (let c = 0; c < p.size; c++) env[p.offset + c] = p.values[i * p.size + c] ?? 0;
      } else if (p.list) {
        const list = p.list;
        const comps = list.length ? itemComponents(list[Math.min(i, list.length - 1)]) ?? [0] : [0];
        for (let c = 0; c < p.size; c++) {
          const v = comps.length === 1 ? comps[0] : comps[c] ?? 0;
          env[p.offset + c] = Number.isFinite(v) ? v : 0;
        }
      }
    }
    assignments.forEach((a, k) => {
      a.compiled.evaluate(env, tmp);
      if (a.compiled.kind === "float") tmp[1] = tmp[2] = tmp[0];
      for (let c = 0; c < a.size; c++) {
        // A division by zero keeps the old value rather than writing NaN into the mesh.
        const v = Number.isFinite(tmp[c]) ? tmp[c] : a.old[i * a.size + c];
        a.values[i * a.size + c] = v;
        if (writeBack[k] >= 0) env[writeBack[k] + c] = v;
      }
    });
  }

  let out = mesh;
  for (const a of assignments) out = setAttribute(out, domain, a.name, a.type, a.values);
  run.note(`${assignments.map((a) => `${a.name} (${a.type})`).join(", ")} on ${written} / ${count} ${domain}s`);
  return out;
}

const EXPRESSION_FIELDS: ParamFieldDef[] = [
  ...SLOTS.flatMap((k): ParamFieldDef[] => [
    { id: `name${k}`, label: `Attribute ${k}`, kind: "text", group: "Assignments" },
    TYPE_FIELD(`type${k}`, `Type ${k}`, "Assignments", true),
    { id: `formula${k}`, label: `= Formula ${k}`, kind: "text", group: "Assignments" },
  ]),
  { id: "_help", label: EXPRESSION_HELP, kind: "note", group: "Assignments" },
  ...PARAM_LETTERS.map((l): ParamFieldDef => ({ id: l, label: l, kind: "number", step: 0.1, group: "Parameters" })),
];

/**
 * Attribute Expression — the wrangle. Up to three assignments `name =
 * formula`, run per element of a domain, in order (the second sees what the
 * first wrote). Writing P on points moves the mesh. Formulas re-run every
 * frame only when they read t or f.
 */
export const ATTRIBUTE_EXPRESSION_NODE = withExtraParams(
  definePolyNode({
    type: "attribute/expression",
    label: "Attribute Expression",
    category: "attribute",
    group: { domain: "choose", defaultDomain: "point" },
    inputs: PARAM_LETTERS.map((l) => ({ id: l, label: l, type: "any" as const })),
    defaultParams: {
      domain: "point",
      name1: "P",
      type1: "auto",
      formula1: "P + 0.1 * N * noise(3 * P)",
      name2: "",
      type2: "auto",
      formula2: "",
      name3: "",
      type3: "auto",
      formula3: "",
      a: 1,
      b: 0,
      c: 0,
      d: 0,
    },
    paramFields: EXPRESSION_FIELDS,
    run: runExpression,
  }),
  (_inputs, params, ctx) => {
    const names = new Set(formulasOf(params).flatMap(scanNames));
    if (!names.has("t") && !names.has("f")) return null;
    return { _clock: names.has("f") ? frameOf(ctx) : ctx.time };
  },
);

// ============================================================ Create / Delete / Rename

export const ATTRIBUTE_CREATE_NODE = definePolyNode({
  type: "attribute/create",
  label: "Attribute Create",
  category: "attribute",
  group: { domain: "choose", defaultDomain: "point" },
  inputs: [
    { id: "value", label: "Value", type: "value" },
    { id: "vector", label: "Vector / Colour", type: "vector" },
  ],
  defaultParams: { domain: "point", name: "mass", type: "float", value: 1, vector: new THREE.Vector3(1, 1, 1) },
  paramFields: [
    { id: "name", label: "Name", kind: "text", group: "Attribute" },
    TYPE_FIELD(),
    { id: "value", label: "Value (float / int / bool)", kind: "number", step: 0.1, group: "Attribute" },
    { id: "vector", label: "Value (vec3 / color)", kind: "vector", step: 0.1, group: "Attribute" },
  ],
  run: (run) => {
    const domain = pickDomain(run);
    const name = writableName(run, domain, run.str("name", ""));
    if (!name) return run.mesh;
    const type = pickType(run.str("type", "float"), "float");
    const size = attrSize(type);
    const { indices } = run.group(domain);
    const existing = attributeType(run.mesh, domain, name);
    if (existing && existing !== type) run.note(`"${name}" was ${existing}, now ${type}`);
    const values = baseValues(run.mesh, domain, name, type);
    const v = run.vec("vector", [1, 1, 1]);
    const constant = size === 3 ? [v.x, v.y, v.z] : [run.num("value", 1)];
    for (const i of indices) for (let c = 0; c < size; c++) values[i * size + c] = Number.isFinite(constant[c]) ? constant[c] : 0;
    run.note(`"${name}" (${type}) on ${indices.length} / ${domainSize(run.mesh, domain)} ${domain}s`);
    return setAttribute(run.mesh, domain, name, type, values);
  },
});

/** Built-ins that are stored on the mesh (colours, material slots, edge flags) and can be cleared. */
function clearBuiltin(mesh: PolyMesh, domain: AttrDomain, name: string): PolyMesh | null {
  if (domain === "corner" && name === "Cd") return mesh.faceColors ? { ...mesh, faceColors: undefined } : mesh;
  if (domain === "face" && name === "material_index") return mesh.faceMaterials ? { ...mesh, faceMaterials: undefined } : mesh;
  if (domain === "edge" && name === "sharp") return { ...mesh, sharpEdges: undefined };
  if (domain === "edge" && name === "seam") return { ...mesh, seamEdges: undefined };
  if (domain === "edge" && name === "crease") return { ...mesh, edgeCreases: undefined };
  return null;
}

function clearableBuiltins(mesh: PolyMesh, domain: AttrDomain): string[] {
  if (domain === "corner") return mesh.faceColors?.some((c) => c) ? ["Cd"] : [];
  if (domain === "face") return mesh.faceMaterials ? ["material_index"] : [];
  if (domain === "edge") {
    const out: string[] = [];
    if (mesh.sharpEdges?.length) out.push("sharp");
    if (mesh.seamEdges?.length) out.push("seam");
    if (mesh.edgeCreases?.length) out.push("crease");
    return out;
  }
  return [];
}

const DOMAIN_OR_ALL: ParamFieldDef = { id: "domain", label: "Domain", kind: "select", options: ["all", ...ATTR_DOMAINS], group: "Attribute" };
const domainsOf = (raw: string): AttrDomain[] => ((ATTR_DOMAINS as readonly string[]).includes(raw) ? [raw as AttrDomain] : [...ATTR_DOMAINS]);

export const ATTRIBUTE_DELETE_NODE = definePolyNode({
  type: "attribute/delete",
  label: "Attribute Delete",
  category: "attribute",
  defaultParams: { names: "", domain: "all", invert: false },
  paramFields: [
    { id: "names", label: "Names (spaces / commas, * wildcard)", kind: "text", group: "Attribute" },
    DOMAIN_OR_ALL,
    { id: "invert", label: "Keep only these (delete the rest)", kind: "boolean", group: "Attribute" },
  ],
  run: (run) => {
    const pattern = run.str("names", "");
    const invert = run.bool("invert", false);
    if (!pattern.trim() && !invert) {
      run.note("Name the attributes or groups to delete");
      return run.mesh;
    }
    let mesh = run.mesh;
    const deleted: string[] = [];
    for (const domain of domainsOf(run.str("domain", "all"))) {
      const available = [...listAttributeNames(mesh, domain, false), ...clearableBuiltins(mesh, domain)];
      const matched = new Set(matchNames(pattern, available));
      const targets = invert ? available.filter((n) => !matched.has(n)) : [...matched];
      for (const name of targets) {
        const cleared = isBuiltinAttribute(domain, name) ? clearBuiltin(mesh, domain, name) : null;
        mesh = cleared ?? removeAttribute(mesh, domain, name);
        deleted.push(`${name} (${domain})`);
      }
      for (const lit of literalNames(pattern)) {
        if (!invert && isBuiltinAttribute(domain, lit) && !clearBuiltin(mesh, domain, lit)) run.note(`"${lit}" is computed from the geometry on ${domain}s — nothing to delete`, true);
      }
    }
    run.note(deleted.length ? `Deleted ${deleted.join(", ")}` : "Nothing matched", !deleted.length);
    return mesh;
  },
});

export const ATTRIBUTE_RENAME_NODE = definePolyNode({
  type: "attribute/rename",
  label: "Attribute Rename",
  category: "attribute",
  defaultParams: { from: "", to: "", domain: "all" },
  paramFields: [
    { id: "from", label: "From", kind: "text", group: "Attribute" },
    { id: "to", label: "To", kind: "text", group: "Attribute" },
    DOMAIN_OR_ALL,
  ],
  run: (run) => {
    const from = run.str("from", "").trim();
    const to = run.str("to", "").trim();
    if (!from || !to) {
      run.note("Fill From and To");
      return run.mesh;
    }
    if (!isValidAttributeName(to)) {
      run.note(`"${to}" is not a valid attribute name (letters, digits, _)`, true);
      return run.mesh;
    }
    let mesh = run.mesh;
    const done: AttrDomain[] = [];
    for (const domain of domainsOf(run.str("domain", "all"))) {
      if (!mesh.attributes?.[domain]?.[from]) continue;
      if (isBuiltinAttribute(domain, to)) {
        run.note(`"${to}" is a built-in name on ${domain}s`, true);
        continue;
      }
      if (mesh.attributes?.[domain]?.[to]) run.note(`"${to}" on ${domain}s replaced`);
      mesh = renameAttribute(mesh, domain, from, to);
      done.push(domain);
    }
    if (done.length) run.note(`${from} → ${to} on ${done.join(", ")}`);
    else run.note(`No stored attribute "${from}"${isBuiltinAttribute("point", from) || isBuiltinAttribute("face", from) ? " (built-ins can't be renamed — copy them)" : ""}`, true);
    return mesh;
  },
});

// ============================================================ Copy / Promote

function copyBetweenDomains(run: PolyRunContext, opts: { move: boolean }): PolyMesh {
  const mesh = run.mesh;
  const from = pickDomain(run, "from", "point");
  const to = pickDomain(run, "to", "face");
  const name = run.str("name", "").trim();
  if (!name) {
    run.note("Name the attribute");
    return mesh;
  }
  const src = readAttribute(mesh, from, name);
  if (!src) {
    run.note(`No "${name}" on ${from}s`, true);
    return mesh;
  }
  const outName = writableName(run, to, run.str("newName", "").trim() || name, "New name");
  if (!outName) return mesh;
  const reduce = pick(run.str("reduce", "average"), REDUCE_OPTIONS, "average");
  const promoted = promoteValues(mesh, from, to, src.values, src.size, reduce);
  const { indices } = run.group(to);
  const values = baseValues(mesh, to, outName, src.type);
  for (const i of indices) for (let c = 0; c < src.size; c++) values[i * src.size + c] = promoted[i * src.size + c];
  let out = setAttribute(mesh, to, outName, src.type, values);
  if (opts.move && !run.bool("keep", false) && !(from === to && outName === name) && mesh.attributes?.[from]?.[name]) out = removeAttribute(out, from, name);
  run.note(`${name} (${from}) → ${outName} (${to}), ${reduce}${src.type === "bool" ? " (bool: non-zero = in)" : ""}`);
  return out;
}

const COPY_FIELDS: ParamFieldDef[] = [
  { id: "name", label: "Attribute", kind: "text", group: "Attribute" },
  DOMAIN_FIELD("from", "From Domain"),
  DOMAIN_FIELD("to", "To Domain"),
  { id: "newName", label: "New Name (empty: same)", kind: "text", group: "Attribute" },
  { id: "reduce", label: "Combine", kind: "select", options: [...REDUCE_OPTIONS], group: "Attribute" },
];

export const ATTRIBUTE_COPY_NODE = definePolyNode({
  type: "attribute/copy",
  label: "Attribute Copy",
  category: "attribute",
  group: { domain: "point", label: "Group (on the To domain)" },
  defaultParams: { name: "Cd", from: "corner", to: "point", newName: "", reduce: "average" },
  paramFields: COPY_FIELDS,
  run: (run) => copyBetweenDomains(run, { move: false }),
});

export const ATTRIBUTE_PROMOTE_NODE = definePolyNode({
  type: "attribute/promote",
  label: "Attribute Promote",
  category: "attribute",
  group: { domain: "point", label: "Group (on the To domain)" },
  defaultParams: { name: "", from: "point", to: "face", newName: "", reduce: "average", keep: false },
  paramFields: [...COPY_FIELDS, { id: "keep", label: "Keep Original", kind: "boolean", group: "Attribute" }],
  run: (run) => copyBetweenDomains(run, { move: true }),
});

// ============================================================ Noise

const NOISE_MODES = ["displace-normal", "add", "set", "multiply"] as const;
const NOISE_TYPES = ["fbm", "value", "curl"] as const;

function runNoise(run: PolyRunContext): PolyMesh {
  const mesh = run.mesh;
  const domain = pickDomain(run, "domain", "point");
  const name = writableName(run, domain, run.str("name", "P"));
  if (!name) return mesh;
  const count = domainSize(mesh, domain);
  const { indices } = run.group(domain);
  const mode = pick(run.str("mode", "displace-normal"), NOISE_MODES, "displace-normal");
  const kind = pick(run.str("noise", "fbm"), NOISE_TYPES, "fbm");
  const type: AttrType = attributeType(mesh, domain, name) ?? pickType(run.str("type", "float"), "float");
  const size = attrSize(type);
  const scale = run.num("scale", 2);
  const amplitude = run.num("amplitude", 0.1);
  const octaves = Math.max(1, Math.min(10, Math.round(run.num("octaves", 4))));
  const roughness = run.num("roughness", 0.5);
  const seed = run.num("seed", 0);
  const offset = run.vec("offset", [0, 0, 0]);
  const time = run.bool("animate", false) ? (Number.isFinite(run.ctx.time) ? run.ctx.time : 0) * run.num("speed", 0.5) : 0;
  // Seed and time move the sampling point: a new seed is a far-away piece of the same field, time drifts through it.
  const ox = offset.x + seed * 37.1 + time * 0.71, oy = offset.y + seed * 11.7 + time, oz = offset.z + seed * 23.3 + time * 1.31;

  const weightName = run.str("weight", "").trim();
  const weight = weightName ? readAnywhere(mesh, domain, weightName) : null;
  if (weightName && !weight) run.note(`Weight "${weightName}" not found — using 1`, true);

  const P = elementPositions(mesh, domain);
  const N = mode === "displace-normal" && size === 3 ? elementNormals(mesh, domain) : null;
  const old = baseValues(mesh, domain, name, type);
  const values = Float64Array.from(old);
  const scalar = (x: number, y: number, z: number) => (kind === "value" ? signedNoise3(x, y, z) : fbmNoise3(x, y, z, octaves, roughness));
  const vnoise = new Float64Array(3);
  const vector = (x: number, y: number, z: number) => {
    if (kind === "curl") return curlNoise3(x, y, z, vnoise, kind === "curl" ? octaves : 1);
    vnoise[0] = scalar(x, y, z);
    vnoise[1] = scalar(x + 113.5, y + 71.2, z + 19.9);
    vnoise[2] = scalar(x - 57.3, y + 141.7, z - 88.1);
    return vnoise;
  };
  for (const i of indices) {
    const x = P[i * 3] * scale + ox, y = P[i * 3 + 1] * scale + oy, z = P[i * 3 + 2] * scale + oz;
    const w = weight ? weight.values[i * weight.size] : 1;
    const amp = amplitude * (Number.isFinite(w) ? w : 1);
    if (N) {
      const n = kind === "curl" ? vector(x, y, z)[0] : scalar(x, y, z);
      for (let c = 0; c < 3; c++) values[i * 3 + c] += N[i * 3 + c] * n * amp;
      continue;
    }
    const noise = size === 3 ? vector(x, y, z) : [scalar(x, y, z)];
    for (let c = 0; c < size; c++) {
      const o = old[i * size + c];
      const n = noise[c] * amp;
      const v = mode === "set" ? o + (noise[c] * amplitude - o) * (Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 1) : mode === "multiply" ? o * (1 + n) : o + n;
      values[i * size + c] = Number.isFinite(v) ? v : o;
    }
  }
  run.note(`${kind} noise → ${name} (${mode}) on ${indices.length} / ${count} ${domain}s`);
  return setAttribute(mesh, domain, name, type, values);
}

export const ATTRIBUTE_NOISE_NODE = withExtraParams(
  definePolyNode({
    type: "attribute/noise",
    label: "Attribute Noise",
    category: "attribute",
    group: { domain: "choose", defaultDomain: "point" },
    defaultParams: {
      domain: "point",
      name: "P",
      type: "float",
      mode: "displace-normal",
      noise: "fbm",
      scale: 2,
      amplitude: 0.1,
      octaves: 4,
      roughness: 0.5,
      seed: 0,
      offset: new THREE.Vector3(0, 0, 0),
      animate: false,
      speed: 0.5,
      weight: "",
    },
    paramFields: [
      { id: "name", label: "Attribute (P moves the mesh)", kind: "text", group: "Attribute" },
      TYPE_FIELD("type", "Type (when new)"),
      { id: "mode", label: "Mode", kind: "select", options: [...NOISE_MODES], group: "Noise" },
      { id: "noise", label: "Noise", kind: "select", options: [...NOISE_TYPES], group: "Noise" },
      { id: "scale", label: "Frequency", kind: "number", step: 0.1, group: "Noise" },
      { id: "amplitude", label: "Amplitude", kind: "number", step: 0.01, group: "Noise" },
      { id: "octaves", label: "Octaves", kind: "number", step: 1, group: "Noise" },
      { id: "roughness", label: "Roughness", kind: "number", step: 0.05, group: "Noise" },
      { id: "seed", label: "Seed", kind: "number", step: 1, group: "Noise" },
      { id: "offset", label: "Offset", kind: "vector", step: 0.1, group: "Noise" },
      { id: "animate", label: "Animate (drift with time)", kind: "boolean", group: "Noise" },
      { id: "speed", label: "Speed", kind: "number", step: 0.1, group: "Noise" },
      { id: "weight", label: "Weight Attribute (optional)", kind: "text", group: "Noise" },
    ],
    run: runNoise,
  }),
  (_inputs, params, ctx) => (params.animate === true || params.animate === 1 ? { _clock: ctx.time } : null),
);

// ============================================================ Blur

export const ATTRIBUTE_BLUR_NODE = definePolyNode({
  type: "attribute/blur",
  label: "Attribute Blur",
  category: "attribute",
  group: { domain: "choose", defaultDomain: "point" },
  defaultParams: { domain: "point", names: "P", iterations: 5, weight: 0.5, output: "" },
  paramFields: [
    { id: "names", label: "Attributes (spaces / commas, * wildcard)", kind: "text", group: "Attribute" },
    { id: "iterations", label: "Iterations", kind: "number", step: 1, group: "Attribute" },
    { id: "weight", label: "Strength (0–1 per pass)", kind: "number", step: 0.05, group: "Attribute" },
    { id: "output", label: "Output Name (empty: in place; several: suffix)", kind: "text", group: "Attribute" },
  ],
  run: (run) => {
    let mesh = run.mesh;
    const domain = pickDomain(run, "domain", "point");
    const pattern = run.str("names", "");
    const stored = listAttributeNames(mesh, domain, false);
    const names = [...new Set([...matchNames(pattern, stored), ...literalNames(pattern).filter((n) => readAttribute(mesh, domain, n))])];
    for (const lit of literalNames(pattern)) if (!names.includes(lit)) run.note(`No "${lit}" on ${domain}s`, true);
    if (names.length === 0) return mesh;
    const { mask } = run.group(domain);
    const adjacency = elementAdjacency(mesh, domain);
    const iterations = run.num("iterations", 5);
    const weight = run.num("weight", 0.5);
    const output = run.str("output", "").trim();
    for (const name of names) {
      const target = output ? (names.length === 1 ? output : `${name}${output}`) : name;
      const outName = writableName(run, domain, target, "Output");
      if (!outName) continue;
      const src = readAttribute(mesh, domain, name)!;
      const blurred = blurValues(src.values, src.size, adjacency, iterations, weight, mask);
      mesh = setAttribute(mesh, domain, outName, src.type, blurred);
      run.note(`${name} → ${outName}, ${Math.round(iterations)} passes`);
    }
    return mesh;
  },
});

// ============================================================ Transfer

export const ATTRIBUTE_TRANSFER_NODE = definePolyNode({
  type: "attribute/transfer",
  label: "Attribute Transfer",
  category: "attribute",
  dependsOnPose: true,
  group: { domain: "choose", defaultDomain: "point" },
  inputs: [{ id: "source", label: "Source Geometry", type: "geometry" }],
  defaultParams: { domain: "point", names: "*", method: "nearest-surface", maxDistance: 0, falloff: 0 },
  paramFields: [
    { id: "names", label: "Attributes (* = all stored; name built-ins like Cd, P)", kind: "text", group: "Transfer" },
    { id: "method", label: "Method", kind: "select", options: [...TRANSFER_METHODS], group: "Transfer" },
    { id: "maxDistance", label: "Max Distance (0 = any)", kind: "number", step: 0.05, group: "Transfer" },
    { id: "falloff", label: "Falloff (blend width)", kind: "number", step: 0.05, group: "Transfer" },
  ],
  run: (run) => {
    const source = run.otherMesh("source");
    if (!source) {
      run.note("Wire a Source Geometry to copy attributes from", true);
      return run.mesh;
    }
    const domain = pickDomain(run, "domain", "point");
    const { mask } = run.group(domain);
    const result = transferAttributes(run.mesh, source, {
      domain,
      names: run.str("names", "*"),
      method: pick(run.str("method", "nearest-surface"), TRANSFER_METHODS, "nearest-surface") as TransferMethod,
      maxDistance: run.num("maxDistance", 0),
      falloff: run.num("falloff", 0),
      mask,
    });
    if (result.missing.length) run.note(`Source has no ${result.missing.join(", ")} on ${domain}s`, true);
    if (result.readOnly.length) run.note(`${result.readOnly.join(", ")}: computed on ${domain}s, not written`, true);
    if (domain === "edge" && run.str("method", "") !== "nearest-point") run.note("Edges transfer by nearest midpoint");
    run.note(result.written.length ? `${result.written.join(", ")} → ${result.reached} / ${domainSize(run.mesh, domain)} ${domain}s` : "Nothing transferred", !result.written.length);
    return result.mesh;
  },
});

// ============================================================ from Texture

const pixelStates = createNodeCache<TextureSampleState>();
const TEXTURE_CHANNELS = ["rgb", "luminance", "red", "green", "blue", "alpha"] as const;

function pixelSource(texture: THREE.Texture, px: { data: ArrayLike<number>; width: number; height: number }): PixelSource {
  const data = px.data;
  const half = texture.type === THREE.HalfFloatType && data instanceof Uint16Array;
  const scale = data instanceof Float32Array || data instanceof Float64Array || half ? 1 : data instanceof Uint16Array ? 65535 : 255;
  return {
    data,
    width: px.width,
    height: px.height,
    scale,
    // flipY: v = 1 is the first row of the data (image / canvas textures); DataTextures have v = 0 there.
    topDown: texture.flipY,
    decode: half ? (v) => THREE.DataUtils.fromHalfFloat(v) : undefined,
  };
}

export const ATTRIBUTE_FROM_TEXTURE_NODE = withExtraParams(
  definePolyNode({
    type: "attribute/from-texture",
    label: "Attribute from Texture",
    category: "attribute",
    group: { domain: "choose", defaultDomain: "corner" },
    inputs: [{ id: "texture", label: "Texture", type: "texture" }],
    defaultParams: { domain: "corner", name: "Cd", channel: "rgb", uv: "uv", uvScale: new THREE.Vector3(1, 1, 1), uvOffset: new THREE.Vector3(0, 0, 0) },
    paramFields: [
      { id: "name", label: "Attribute (Cd on corners = vertex colours)", kind: "text", group: "Attribute" },
      { id: "channel", label: "Channel", kind: "select", options: [...TEXTURE_CHANNELS], group: "Attribute" },
      { id: "uv", label: "UV Attribute", kind: "text", group: "Texture" },
      { id: "uvScale", label: "UV Scale", kind: "vector", step: 0.1, group: "Texture" },
      { id: "uvOffset", label: "UV Offset", kind: "vector", step: 0.05, group: "Texture" },
    ],
    run: (run) => {
      const mesh = run.mesh;
      const texture = run.inputs.texture instanceof THREE.Texture ? run.inputs.texture : null;
      if (!texture) {
        run.note("Wire a Texture", true);
        return mesh;
      }
      let state = pixelStates.get(run.nodeId);
      if (!state) pixelStates.set(run.nodeId, (state = {}));
      const px = getPixelBuffer(state, texture);
      if (!px) {
        run.note("This texture's pixels can't be read on the CPU (GPU-only or not loaded yet)", true);
        return mesh;
      }
      const domain = pickDomain(run, "domain", "corner");
      const name = writableName(run, domain, run.str("name", "Cd"));
      if (!name) return mesh;
      const uvName = run.str("uv", "uv").trim() || "uv";
      const uv = readAnywhere(mesh, domain, uvName);
      if (!uv) {
        run.note(`No "${uvName}" to sample at`, true);
        return mesh;
      }
      const channel = pick(run.str("channel", "rgb"), TEXTURE_CHANNELS, "rgb");
      const existing = attributeType(mesh, domain, name);
      const type: AttrType = channel === "rgb" ? (existing === "vec3" ? "vec3" : "color") : existing === "int" || existing === "bool" ? existing : "float";
      const size = attrSize(type);
      const src = pixelSource(texture, px);
      const srgb = texture.colorSpace === THREE.SRGBColorSpace;
      const scale = run.vec("uvScale", [1, 1, 1]);
      const offset = run.vec("uvOffset", [0, 0, 0]);
      const { indices } = run.group(domain);
      const values = baseValues(mesh, domain, name, type);
      const rgba = new Float64Array(4);
      for (const i of indices) {
        const u = uv.values[i * uv.size] * scale.x + offset.x;
        const v = (uv.size > 1 ? uv.values[i * uv.size + 1] : 0) * scale.y + offset.y;
        samplePixels(src, u, v, rgba);
        if (channel === "rgb") {
          // Vertex colours are linear; an sRGB image is stored encoded.
          for (let c = 0; c < 3; c++) values[i * 3 + c] = srgb ? srgbToLinear(rgba[c]) : rgba[c];
        } else {
          const k = channel === "red" ? 0 : channel === "green" ? 1 : channel === "blue" ? 2 : channel === "alpha" ? 3 : -1;
          values[i * size] = k >= 0 ? rgba[k] : 0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2];
        }
      }
      run.note(`${channel} → ${name} (${type}) on ${indices.length} ${domain}s, ${px.width}×${px.height}`);
      return setAttribute(mesh, domain, name, type, values);
    },
  }),
  // GPU-rendered textures change revision without bumping texture.version.
  (inputs) => (inputs.texture instanceof THREE.Texture ? { _texture: textureRevision(inputs.texture) } : null),
);

// ============================================================ Measure

export const ATTRIBUTE_MEASURE_NODE = definePolyNode({
  type: "attribute/measure",
  label: "Measure",
  category: "attribute",
  group: { domain: "choose", defaultDomain: "face" },
  defaultParams: { domain: "face", measure: "area", perPiece: false, name: "" },
  paramFields: [
    { id: "measure", label: "Measure", kind: "select", options: [...MEASURE_KINDS], group: "Measure" },
    { id: "perPiece", label: "Per Piece (total / mean of each connected part)", kind: "boolean", group: "Measure" },
    { id: "name", label: "Name (empty: the measure's name)", kind: "text", group: "Measure" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const kind = pick(run.str("measure", "area"), MEASURE_KINDS, "area") as MeasureKind;
    const domain = pickDomain(run, "domain", "face");
    let name = run.str("name", "").trim();
    if (!name) {
      name = kind;
      // `area` and `piece` on faces are built-ins already readable as is;
      // the stored copy (per piece, or for downstream nodes) needs its own name.
      if (isBuiltinAttribute(domain, name)) {
        name = `${kind}_m`;
        run.note(`"${kind}" is built in on ${domain}s — stored as "${name}"`);
      }
    }
    const outName = writableName(run, domain, name);
    if (!outName) return mesh;
    const m = measure(mesh, kind, run.bool("perPiece", false));
    const type: AttrType = kind === "piece" ? "int" : m.size === 3 ? "vec3" : "float";
    const values = promoteValues(mesh, m.domain, domain, m.values, m.size, "average");
    const out = baseValues(mesh, domain, outName, type);
    const { indices } = run.group(domain);
    for (const i of indices) for (let c = 0; c < m.size; c++) out[i * m.size + c] = Number.isFinite(values[i * m.size + c]) ? values[i * m.size + c] : 0;
    run.note(`${kind}${run.bool("perPiece", false) ? " per piece" : ""} → ${outName} on ${indices.length} ${domain}s`);
    return setAttribute(mesh, domain, outName, type, out);
  },
});

// ============================================================ Lists

export const ATTRIBUTE_TO_LIST_NODE = definePolyNode({
  type: "attribute/to-list",
  label: "Attribute to List",
  category: "attribute",
  group: { domain: "choose", defaultDomain: "point" },
  outputs: [
    { id: "list", label: "List", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { domain: "point", name: "P" },
  paramFields: [{ id: "name", label: "Attribute", kind: "text", group: "Attribute" }],
  run: (run) => {
    const domain = pickDomain(run, "domain", "point");
    const name = run.str("name", "P").trim();
    const attr = name ? readAnywhere(run.mesh, domain, name) : null;
    if (!attr) {
      run.note(name ? `No "${name}" on this mesh` : "Name the attribute", true);
      return { mesh: run.mesh, outputs: { list: [], count: 0 } };
    }
    const { indices } = run.group(domain);
    const v = attr.values;
    const list: (number | THREE.Vector3 | THREE.Color)[] = indices.map((i) => {
      if (attr.size === 3) return attr.type === "color" ? new THREE.Color(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]) : new THREE.Vector3(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      return v[i];
    });
    run.note(`${list.length} ${attr.type} values${attr.from !== domain ? ` (from ${attr.from}s)` : ""}`);
    return { mesh: run.mesh, outputs: { list, count: list.length } };
  },
});

export const LIST_TO_ATTRIBUTE_NODE = definePolyNode({
  type: "attribute/from-list",
  label: "List to Attribute",
  category: "attribute",
  group: { domain: "choose", defaultDomain: "point" },
  inputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: { domain: "point", name: "value", type: "auto", mismatch: "repeat" },
  paramFields: [
    { id: "name", label: "Attribute", kind: "text", group: "Attribute" },
    TYPE_FIELD("type", "Type", "Attribute", true),
    { id: "mismatch", label: "List shorter than the elements", kind: "select", options: [...LIST_MISMATCH], group: "Attribute" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const list = Array.isArray(run.inputs.list) ? (run.inputs.list as unknown[]) : null;
    if (!list) {
      run.note("Wire a List", true);
      return mesh;
    }
    const domain = pickDomain(run, "domain", "point");
    const name = writableName(run, domain, run.str("name", "value"));
    if (!name) return mesh;
    const raw = run.str("type", "auto");
    const first = list.find((x) => itemComponents(x));
    const looksColour = first instanceof THREE.Color || (!!first && typeof first === "object" && "r" in (first as object));
    const type: AttrType =
      raw !== "auto" ? pickType(raw, "float") : attributeType(mesh, domain, name) ?? (listItemSize(list) === 3 ? (looksColour ? "color" : "vec3") : "float");
    const { indices } = run.group(domain);
    const mismatch = pick(run.str("mismatch", "repeat"), LIST_MISMATCH, "repeat") as ListMismatch;
    const values = listToValues(list, indices, attrSize(type), baseValues(mesh, domain, name, type), mismatch);
    if (list.length !== indices.length) run.note(`${list.length} items for ${indices.length} ${domain}s (${mismatch})`, list.length < indices.length && mismatch !== "repeat");
    else run.note(`${list.length} items → ${name} (${type})`);
    return setAttribute(mesh, domain, name, type, values);
  },
});

// ============================================================ Visualize

const vizMaterials = createNodeCache<THREE.MeshStandardMaterial>((m) => m.dispose());

/**
 * Attribute Visualize — paints an attribute (or a group) onto the corner
 * colours `Cd` through a colour ramp, so weights, masks and measures can be
 * seen in the viewport. This CHANGES THE RENDERED COLOURS: it is a debug /
 * look node, meant to be bypassed or removed once the attribute is right
 * (or kept, when the ramp is the look). With Display = vertex colours it also
 * swaps in a plain vertex-coloured material, because most source materials
 * ignore vertex colours.
 */
export const ATTRIBUTE_VISUALIZE_NODE = (() => {
  const base = definePolyNode({
    type: "attribute/visualize",
    label: "Attribute Visualize",
    category: "attribute",
    outputs: [
      { id: "min", label: "Min", type: "value" },
      { id: "max", label: "Max", type: "value" },
    ],
    defaultParams: {
      name: "",
      from: "auto",
      range: "auto",
      min: 0,
      max: 1,
      ramp: DEFAULT_COLOR_RAMP,
      vector: "length",
      groupColor: new THREE.Color(0xff6a00),
      baseColor: new THREE.Color(0x4a4f5a),
      display: "vertex-colours",
    },
    volatileParams: ["display"],
    paramFields: [
      { id: "name", label: "Attribute or Group", kind: "text", group: "Visualize" },
      { id: "from", label: "Domain", kind: "select", options: ["auto", ...ATTR_DOMAINS], group: "Visualize" },
      { id: "range", label: "Range", kind: "select", options: ["auto", "manual"], group: "Visualize" },
      { id: "min", label: "Min (manual)", kind: "number", step: 0.1, group: "Visualize" },
      { id: "max", label: "Max (manual)", kind: "number", step: 0.1, group: "Visualize" },
      { id: "ramp", label: "Ramp", kind: "color_ramp", group: "Visualize" },
      { id: "vector", label: "Vectors as", kind: "select", options: ["length", "rgb"], group: "Visualize" },
      { id: "groupColor", label: "Group: in", kind: "color", group: "Visualize" },
      { id: "baseColor", label: "Group: out", kind: "color", group: "Visualize" },
      { id: "display", label: "Display", kind: "select", options: ["vertex-colours", "keep-material"], group: "Visualize" },
    ],
    run: (run) => {
      const mesh = run.mesh;
      const name = run.str("name", "").trim();
      const empty = { mesh, outputs: { min: 0, max: 0 } };
      if (!name) {
        run.note("Name an attribute or group to see it");
        return empty;
      }
      const fromRaw = run.str("from", "auto");
      const domains = (ATTR_DOMAINS as readonly string[]).includes(fromRaw) ? [fromRaw as AttrDomain] : ATTR_DOMAINS;
      const domain = domains.find((d) => readAttribute(mesh, d, name));
      if (!domain) {
        run.note(`No "${name}" on this mesh`, true);
        return empty;
      }
      const attr = readAttribute(mesh, domain, name)!;
      const n = domainSize(mesh, domain);
      const colours = new Float64Array(n * 3);
      let lo = 0, hi = 0;
      if (attr.type === "bool") {
        const on = toColor(run.params.groupColor, 0xff6a00), off = toColor(run.params.baseColor, 0x4a4f5a);
        for (let i = 0; i < n; i++) {
          const c = attr.values[i] ? on : off;
          colours.set([c.r, c.g, c.b], i * 3);
        }
        hi = 1;
        run.note(`${maskIndices(Array.from(attr.values)).length} / ${n} ${domain}s in "${name}"`);
      } else if (attr.size === 3 && run.str("vector", "length") === "rgb") {
        // Directions as colours, the normal-map convention: −1…1 → 0…1.
        for (let i = 0; i < n * 3; i++) colours[i] = attr.type === "color" ? attr.values[i] : attr.values[i] * 0.5 + 0.5;
        hi = 1;
      } else {
        const scalar = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          scalar[i] = attr.size === 3 ? Math.hypot(attr.values[i * 3], attr.values[i * 3 + 1], attr.values[i * 3 + 2]) : attr.values[i];
        }
        if (run.str("range", "auto") === "manual") {
          lo = run.num("min", 0);
          hi = run.num("max", 1);
        } else {
          lo = Infinity;
          hi = -Infinity;
          for (const v of scalar) if (Number.isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
          if (!Number.isFinite(lo)) lo = hi = 0;
        }
        const ramp = run.params.ramp && typeof run.params.ramp === "object" ? (run.params.ramp as ColorRamp) : DEFAULT_COLOR_RAMP;
        const span = hi - lo;
        for (let i = 0; i < n; i++) {
          const t = span > 1e-12 ? (scalar[i] - lo) / span : 0.5;
          const c = sampleColorRamp(ramp, Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0);
          colours.set([c.r, c.g, c.b], i * 3);
        }
        run.note(`${name} (${domain}): ${lo.toPrecision(4)} … ${hi.toPrecision(4)}`);
      }
      const corner = domain === "corner" ? colours : promoteValues(mesh, domain, "corner", colours, 3, "average");
      return { mesh: setAttribute(mesh, "corner", "Cd", "color", corner), outputs: { min: lo, max: hi } };
    },
  });
  return {
    ...base,
    evaluate: (inputs, params, ctx) => {
      const out = base.evaluate(inputs, params, ctx);
      const obj = out.geometry;
      if (params.display !== "keep-material" && obj instanceof THREE.Mesh) {
        let mat = vizMaterials.get(ctx.nodeId);
        if (!mat) vizMaterials.set(ctx.nodeId, (mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 })));
        obj.material = mat;
      }
      return out;
    },
  } satisfies NodeDefinition;
})();

// ============================================================ Randomize

const RANDOM_MODES = ["range", "unit-vector"] as const;
const RANDOM_OPS = ["set", "add", "multiply"] as const;

export const ATTRIBUTE_RANDOMIZE_NODE = definePolyNode({
  type: "attribute/randomize",
  label: "Attribute Randomize",
  category: "attribute",
  group: { domain: "choose", defaultDomain: "point" },
  defaultParams: {
    domain: "point",
    name: "rand",
    type: "float",
    mode: "range",
    min: 0,
    max: 1,
    minVector: new THREE.Vector3(0, 0, 0),
    maxVector: new THREE.Vector3(1, 1, 1),
    probability: 0.5,
    seed: 0,
    operation: "set",
  },
  paramFields: [
    { id: "name", label: "Attribute", kind: "text", group: "Attribute" },
    TYPE_FIELD(),
    { id: "mode", label: "Mode (vec3)", kind: "select", options: [...RANDOM_MODES], group: "Random" },
    { id: "min", label: "Min (float / int)", kind: "number", step: 0.1, group: "Random" },
    { id: "max", label: "Max (float / int)", kind: "number", step: 0.1, group: "Random" },
    { id: "minVector", label: "Min (vec3 / color)", kind: "vector", step: 0.1, group: "Random" },
    { id: "maxVector", label: "Max (vec3 / color)", kind: "vector", step: 0.1, group: "Random" },
    { id: "probability", label: "Probability (bool)", kind: "number", step: 0.05, group: "Random" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Random" },
    { id: "operation", label: "Operation", kind: "select", options: [...RANDOM_OPS], group: "Random" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const domain = pickDomain(run, "domain", "point");
    const name = writableName(run, domain, run.str("name", "rand"));
    if (!name) return mesh;
    const type = pickType(run.str("type", "float"), "float");
    const size = attrSize(type);
    const seed = run.num("seed", 0);
    const op = pick(run.str("operation", "set"), RANDOM_OPS, "set");
    const unit = size === 3 && run.str("mode", "range") === "unit-vector";
    const lo = run.num("min", 0), hi = run.num("max", 1);
    const lov = run.vec("minVector", [0, 0, 0]), hiv = run.vec("maxVector", [1, 1, 1]);
    const lo3 = [lov.x, lov.y, lov.z], hi3 = [hiv.x, hiv.y, hiv.z];
    const probability = run.num("probability", 0.5);
    const { indices } = run.group(domain);
    const old = baseValues(mesh, domain, name, type);
    const values = Float64Array.from(old);
    const r = new Float64Array(3);
    for (const i of indices) {
      // Keyed by element index and seed only: the same element keeps its value when others change.
      if (unit) randomUnitVector(i, seed, r);
      else if (size === 3) for (let c = 0; c < 3; c++) r[c] = lo3[c] + hashRandom(i, seed * 13 + c + 1) * (hi3[c] - lo3[c]);
      else {
        const h = hashRandom(i, seed * 13);
        r[0] = type === "bool" ? (h < probability ? 1 : 0) : type === "int" ? Math.min(Math.floor(lo + h * (Math.floor(hi) - Math.ceil(lo) + 1)), Math.floor(hi)) : lo + h * (hi - lo);
        if (type === "int") r[0] = Math.max(Math.ceil(lo), r[0]);
      }
      for (let c = 0; c < size; c++) {
        const o = old[i * size + c];
        const v = op === "add" ? o + r[c] : op === "multiply" ? o * r[c] : r[c];
        values[i * size + c] = Number.isFinite(v) ? v : o;
      }
    }
    run.note(`${name} (${type}) randomized on ${indices.length} / ${domainSize(mesh, domain)} ${domain}s`);
    return setAttribute(mesh, domain, name, type, values);
  },
});

// ============================================================ registry

/** Every attribute node (phase 3). Not registered in nodes/index.ts yet. */
export const ATTRIBUTE_NODES: NodeDefinition[] = [
  ATTRIBUTE_EXPRESSION_NODE,
  ATTRIBUTE_CREATE_NODE,
  ATTRIBUTE_DELETE_NODE,
  ATTRIBUTE_RENAME_NODE,
  ATTRIBUTE_COPY_NODE,
  ATTRIBUTE_PROMOTE_NODE,
  ATTRIBUTE_NOISE_NODE,
  ATTRIBUTE_BLUR_NODE,
  ATTRIBUTE_TRANSFER_NODE,
  ATTRIBUTE_FROM_TEXTURE_NODE,
  ATTRIBUTE_MEASURE_NODE,
  ATTRIBUTE_TO_LIST_NODE,
  LIST_TO_ATTRIBUTE_NODE,
  ATTRIBUTE_VISUALIZE_NODE,
  ATTRIBUTE_RANDOMIZE_NODE,
];
