import * as THREE from "three";
import type { NodeDefinition, NodeInstance, ParamFieldDef, EvalContext } from "../types";
import type { NodeCategory } from "../categories";
import { worldMatrixOf } from "../objectPosition";
import type { SocketDef } from "../sockets";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { clearMeshWarning, warnMeshRequired } from "../meshRequired";
import { quadMeshSignature, type PolyMesh, type QuadMeshShading } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { evaluateGroup, maskIndices } from "../mesh/groupExpr";
import { ATTR_DOMAINS, domainSize, listAttributeNames, listGroups, type AttrDomain } from "../mesh/polyAttributes";
import { createModifierMesh, emitModifiedMesh, primitiveOutputs } from "./object";

/*
 * The scaffolding every parametric mesh node shares — read the PolyMesh off
 * the input, evaluate the Group field, run the operation only when something
 * it depends on changed, write the result back as a mesh that inherits the
 * source's pose, material and userData (emitModifiedMesh). A node built on it
 * is a `run` function from PolyMesh to PolyMesh plus its fields.
 *
 * Status (selected count, unknown group names, expression errors, the
 * groups and attributes the input carries) is kept per node and shown at the
 * bottom of its panel, so a Group field that matches nothing says so.
 */

export interface PolyRunContext {
  /** The input mesh (immutable — return a new one). */
  mesh: PolyMesh;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
  nodeId: string;
  ctx: EvalContext;
  /** A wired input if present, else the param of the same id, else the fallback. */
  num(id: string, fallback: number): number;
  bool(id: string, fallback: boolean): boolean;
  vec(id: string, fallback: [number, number, number]): THREE.Vector3;
  str(id: string, fallback: string): string;
  /** The node's Group field evaluated on a domain (or another expression). */
  group(domain: AttrDomain, expression?: string): { mask: Uint8Array; indices: number[] };
  /** Another geometry input's PolyMesh, in this mesh's local space. */
  otherMesh(id: string): PolyMesh | null;
  /** Adds a line to the node's status note. */
  note(message: string, warn?: boolean): void;
  /** The source mesh's world matrix (local → world). Set `dependsOnPose` for the node to rebuild when it changes. */
  worldMatrix: THREE.Matrix4;
}

export type PolyRunResult = PolyMesh | { mesh: PolyMesh; outputs?: Record<string, unknown>; shading?: QuadMeshShading };

export interface PolyNodeSpec {
  type: string;
  label: string;
  category?: NodeCategory;
  /** Extra inputs after Geometry. */
  inputs?: SocketDef[];
  /** Extra outputs after Geometry and Matrix (values the run reports). */
  outputs?: SocketDef[];
  defaultParams?: Record<string, unknown>;
  paramFields?: ParamFieldDef[];
  /**
   * Adds the standard Group field (and a Domain select when `domain` is
   * "choose"). The run reads it with `group(domain)`.
   */
  group?: { domain: AttrDomain | "choose"; label?: string; defaultDomain?: AttrDomain } | false;
  /** Parameters that only matter to the panel, left out of the rebuild signature. */
  volatileParams?: string[];
  /** Rebuild every frame (reads ctx.time). */
  animated?: boolean;
  /** The result depends on where the object is in the world (world-space selections). */
  dependsOnPose?: boolean;
  upgradeParams?: (params: Record<string, unknown>) => Record<string, unknown>;
  run(ctx: PolyRunContext): PolyRunResult;
}

interface PolyNodeState {
  object?: THREE.Mesh;
  signature?: string;
  outputs?: Record<string, unknown>;
}

const states = createNodeCache<PolyNodeState>((s) => {
  if (s.object) disposeObject3D(s.object);
});

interface PolyNodeStatus {
  lines: { text: string; warn: boolean }[];
  groups: string[];
  attributes: string[];
}
const statuses = new Map<string, PolyNodeStatus>();

/** The status lines of a node's last build (for tests and the panel). */
export function polyNodeStatus(nodeId: string): PolyNodeStatus | undefined {
  return statuses.get(nodeId);
}

export const GROUP_HELP =
  "Group: empty or * = all · name · a b (union) · a & !b · a ^ b · rim_* · 0-10:2 (indices) · @P.y>0 · @piece==1";

export function groupFields(spec: { domain: AttrDomain | "choose"; label?: string }, group = "Group"): ParamFieldDef[] {
  const fields: ParamFieldDef[] = [{ id: "group", label: spec.label ?? "Group", kind: "text", group }];
  if (spec.domain === "choose") fields.push({ id: "domain", label: "Domain", kind: "select", options: [...ATTR_DOMAINS], group });
  return fields;
}

/** A stable, cheap fingerprint of any socket value, for rebuild signatures. */
export function valueSignature(value: unknown): string {
  if (value === undefined || value === null) return "_";
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : "nan";
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (value instanceof THREE.Vector3 || value instanceof THREE.Vector2 || value instanceof THREE.Vector4 || value instanceof THREE.Color) {
    return value.toArray().map((v) => Math.round(v * 1e6)).join(",");
  }
  if (value instanceof THREE.Matrix4) return value.elements.map((v) => Math.round(v * 1e6)).join(",");
  if (value instanceof THREE.Object3D) {
    const read = readPolyMesh(value);
    const m = read ? quadMeshSignature(read.mesh) : value.uuid;
    return `obj:${m}:${worldMatrixOf(read?.srcMesh ?? value).elements.map((v) => Math.round(v * 1e5)).join(",")}`;
  }
  if (value instanceof THREE.Curve) {
    const pts = value.getPoints(16);
    return "curve:" + pts.map((p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`).join(";");
  }
  if (value instanceof THREE.Texture) return `tex:${value.uuid}:${value.version}`;
  if (Array.isArray(value)) {
    let h = 0x811c9dc5;
    for (const v of value) {
      const s = valueSignature(v);
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    }
    return `[${value.length}:${h.toString(36)}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function asVector(raw: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (raw instanceof THREE.Vector3) return raw.clone();
  if (Array.isArray(raw) && raw.length >= 3) return new THREE.Vector3(asNumber(raw[0], 0), asNumber(raw[1], 0), asNumber(raw[2], 0));
  if (raw && typeof raw === "object" && "x" in raw) {
    const r = raw as { x: unknown; y: unknown; z: unknown };
    return new THREE.Vector3(asNumber(r.x, 0), asNumber(r.y, 0), asNumber(r.z, 0));
  }
  if (typeof raw === "number") return new THREE.Vector3(raw, raw, raw);
  return new THREE.Vector3(...fallback);
}

/**
 * Brings another object's mesh into `target`'s local space, so a node that
 * reads two geometries (Bridge, Attribute Transfer, Boolean) compares them
 * where they actually are on screen.
 */
export function polyMeshInSpace(object: THREE.Object3D, target: THREE.Object3D | null): PolyMesh | null {
  const read = readPolyMesh(object);
  if (!read) return null;
  const m = worldMatrixOf(read.srcMesh);
  if (target) m.premultiply(worldMatrixOf(target).invert());
  if (isIdentity(m)) return read.mesh;
  const v = new THREE.Vector3();
  return {
    ...read.mesh,
    positions: read.mesh.positions.map((p) => {
      v.set(p[0], p[1], p[2]).applyMatrix4(m);
      return [v.x, v.y, v.z] as [number, number, number];
    }),
  };
}

function isIdentity(m: THREE.Matrix4): boolean {
  const e = m.elements;
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return e.every((v, i) => Math.abs(v - id[i]) < 1e-9);
}

export function definePolyNode(spec: PolyNodeSpec): NodeDefinition {
  const groupSpec = spec.group === false || spec.group === undefined ? null : spec.group;
  const baseFields: ParamFieldDef[] = [...(groupSpec ? groupFields(groupSpec) : []), ...(spec.paramFields ?? [])];
  const defaults: Record<string, unknown> = {
    ...(groupSpec ? { group: "" } : {}),
    ...(groupSpec?.domain === "choose" ? { domain: groupSpec.defaultDomain ?? "face" } : {}),
    ...(spec.defaultParams ?? {}),
  };
  const volatile = new Set(spec.volatileParams ?? []);

  return {
    type: spec.type,
    label: spec.label,
    category: spec.category ?? "transform",
    inputs: [{ id: "geometry", label: "Geometry", type: "geometry", owns: true }, ...(spec.inputs ?? [])],
    outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }, { id: "matrix", label: "Matrix", type: "matrix" }, ...(spec.outputs ?? [])],
    defaultParams: defaults,
    paramFields: baseFields,
    upgradeParams: spec.upgradeParams,
    dynamicParamFields: (instance: NodeInstance) => [...baseFields, ...statusFields(instance.id, Boolean(groupSpec))],
    evaluate: (inputs, params, ctx) => {
      const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
      const emptyOutputs = () => Object.fromEntries((spec.outputs ?? []).map((o) => [o.id, o.type === "list" ? [] : o.type === "value" ? 0 : null]));
      if (!inputObj) return { geometry: null, matrix: new THREE.Matrix4(), ...emptyOutputs() };
      const read = readPolyMesh(inputObj);
      if (!read) {
        warnMeshRequired(ctx.nodeId, spec.label, inputObj);
        return { ...primitiveOutputs(inputObj), ...emptyOutputs() };
      }
      clearMeshWarning(ctx.nodeId);

      let state = states.get(ctx.nodeId);
      if (!state) {
        state = {};
        states.set(ctx.nodeId, state);
      }

      const parts: string[] = [quadMeshSignature(read.mesh)];
      for (const key of Object.keys(params).sort()) if (!volatile.has(key)) parts.push(`${key}=${valueSignature(params[key])}`);
      for (const socket of spec.inputs ?? []) parts.push(`${socket.id}<${valueSignature(inputs[socket.id])}`);
      if (spec.animated) parts.push(`t=${ctx.time}`);
      const worldMatrix = worldMatrixOf(read.srcMesh);
      if (spec.dependsOnPose) parts.push(`pose=${valueSignature(worldMatrix)}`);
      const signature = parts.join("|");

      if (state.object && state.signature === signature) {
        // Pose and material can change without the mesh changing.
        return { ...emitModifiedMesh(state.object, { inputObj, srcMesh: read.srcMesh, nodeId: ctx.nodeId }), ...state.outputs };
      }

      const status: PolyNodeStatus = {
        lines: [],
        groups: listGroups(read.mesh).map((g) => (g.domain === "face" ? g.name : `${g.name} (${g.domain})`)),
        attributes: ATTR_DOMAINS.flatMap((d) => listAttributeNames(read.mesh, d, false).map((n) => `${n} (${d})`)),
      };
      const note = (text: string, warn = false) => status.lines.push({ text, warn });
      const param = (id: string) => (inputs[id] !== undefined ? inputs[id] : params[id] !== undefined ? params[id] : defaults[id]);
      const run: PolyRunContext = {
        mesh: read.mesh,
        inputs,
        params,
        nodeId: ctx.nodeId,
        ctx,
        num: (id, fb) => asNumber(param(id), fb),
        bool: (id, fb) => {
          const v = param(id);
          return v === undefined ? fb : typeof v === "number" ? v !== 0 : Boolean(v);
        },
        vec: (id, fb) => asVector(param(id), fb),
        str: (id, fb) => {
          const v = param(id);
          return v === undefined || v === null ? fb : String(v);
        },
        group: (domain, expression) => {
          const expr = expression ?? String(params.group ?? defaults.group ?? "");
          const result = evaluateGroup(read.mesh, domain, expr);
          if (result.error) note(`Group: ${result.error} — using every element`, true);
          if (result.unknown.length) note(`Group: no ${result.unknown.join(", ")} on ${domain}s`, true);
          const indices = maskIndices(result.mask);
          if (expr.trim()) note(`${indices.length} / ${domainSize(read.mesh, domain)} ${domain}s in group`);
          return { mask: result.mask, indices };
        },
        otherMesh: (id) => {
          const v = inputs[id];
          return v instanceof THREE.Object3D ? polyMeshInSpace(v, read.srcMesh) : null;
        },
        note,
        worldMatrix,
      };

      let result: PolyRunResult;
      try {
        result = spec.run(run);
      } catch (e) {
        note(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
        console.warn(`${spec.label}:`, e);
        result = read.mesh;
      }
      const mesh = "positions" in result ? result : result.mesh;
      const outputs = "positions" in result ? {} : (result.outputs ?? {});
      const shading = "positions" in result ? undefined : result.shading;
      statuses.set(ctx.nodeId, status);

      if (!state.object) state.object = createModifierMesh();
      const geometry = polyMeshToGeometry(mesh, shading);
      state.signature = signature;
      state.outputs = outputs;
      return { ...emitModifiedMesh(state.object, { inputObj, srcMesh: read.srcMesh, geometry, nodeId: ctx.nodeId }), ...outputs };
    },
  };
}

function statusFields(nodeId: string, hasGroup: boolean): ParamFieldDef[] {
  const status = statuses.get(nodeId);
  const fields: ParamFieldDef[] = [];
  if (hasGroup) fields.push({ id: "_groupHelp", label: GROUP_HELP, kind: "note", group: "Group" });
  if (!status) return fields;
  status.lines.forEach((line, i) =>
    fields.push({ id: `_status${i}`, label: (line.warn ? "⚠ " : "") + line.text, kind: "note", ...(line.warn ? { tone: "warn" as const } : {}), group: "Status" }),
  );
  if (status.groups.length) fields.push({ id: "_groups", label: `Groups in: ${status.groups.join(", ")}`, kind: "note", group: "Status" });
  if (status.attributes.length) fields.push({ id: "_attrs", label: `Attributes in: ${status.attributes.join(", ")}`, kind: "note", group: "Status" });
  return fields;
}
