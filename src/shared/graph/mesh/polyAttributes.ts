import type { PolyMesh } from "../quadMesh";
import { getTopology } from "./topology";
import { edgeKey } from "./attributes";

/*
 * Named attributes on a PolyMesh — the Houdini/Blender idea that every point,
 * edge, face and face-corner can carry values the graph reads and writes by
 * name. A *group* is nothing more than a `bool` attribute: Select nodes write
 * one, modifiers read it through a group expression (groupExpr.ts).
 *
 * Storage is plain JSON-friendly arrays (a PolyMesh is saved inside .tsuji
 * files by Edit Mesh and Frozen Geometry):
 *  - point / face / corner: `data` is flat, `size` numbers per element
 *    (1, or 3 for vec3/color), parallel to positions / faces / the face
 *    corners in face order;
 *  - edge: `values` keyed by edgeKey(a, b), so the value follows the vertex
 *    pair through any operation that keeps those two vertices.
 *
 * Arrays shorter than the domain read as 0 past their end: an Edit Mesh
 * operation that appends faces without knowing about attributes leaves them
 * short, and that must read as "not in the group", never as a crash.
 *
 * Built-in names are readable on every mesh without being stored:
 *   point: P (vec3), N (vec3), id, uv (vec3, z = 0)
 *   face:  P (centroid), N, id, area, material_index, sides, piece
 *   edge:  id, length, sharp, seam, crease, boundary, angle (dihedral, degrees)
 *   corner: id, uv, Cd
 * Writing a built-in name is refused by setAttribute, except P on points,
 * which moves the vertices (Attribute Expression writing P).
 */

export type AttrDomain = "point" | "edge" | "face" | "corner";
export type AttrType = "float" | "int" | "bool" | "vec3" | "color";

export const ATTR_DOMAINS: readonly AttrDomain[] = ["point", "edge", "face", "corner"];
export const ATTR_TYPES: readonly AttrType[] = ["float", "int", "bool", "vec3", "color"];

export interface PolyAttribute {
  type: AttrType;
  data: number[];
}

export interface PolyEdgeAttribute {
  type: AttrType;
  values: Record<string, number[]>;
}

export interface PolyAttributes {
  point?: Record<string, PolyAttribute>;
  face?: Record<string, PolyAttribute>;
  corner?: Record<string, PolyAttribute>;
  edge?: Record<string, PolyEdgeAttribute>;
}

export const attrSize = (type: AttrType): number => (type === "vec3" || type === "color" ? 3 : 1);

export const BUILTIN_ATTRIBUTES: Record<AttrDomain, Record<string, AttrType>> = {
  point: { P: "vec3", N: "vec3", id: "int", uv: "vec3" },
  face: { P: "vec3", N: "vec3", id: "int", area: "float", material_index: "int", sides: "int", piece: "int" },
  edge: { id: "int", length: "float", sharp: "bool", seam: "bool", crease: "float", boundary: "bool", angle: "float" },
  corner: { id: "int", uv: "vec3", Cd: "color" },
};

export function isBuiltinAttribute(domain: AttrDomain, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_ATTRIBUTES[domain], name);
}

// ---------------------------------------------------------------- clone/hash

export function clonePolyAttributes(attributes: PolyAttributes | undefined): PolyAttributes | undefined {
  if (!attributes) return undefined;
  const out: PolyAttributes = {};
  for (const domain of ["point", "face", "corner"] as const) {
    const src = attributes[domain];
    if (!src) continue;
    const copy: Record<string, PolyAttribute> = {};
    for (const [name, attr] of Object.entries(src)) copy[name] = { type: attr.type, data: [...attr.data] };
    out[domain] = copy;
  }
  if (attributes.edge) {
    const copy: Record<string, PolyEdgeAttribute> = {};
    for (const [name, attr] of Object.entries(attributes.edge)) {
      const values: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(attr.values)) values[k] = [...v];
      copy[name] = { type: attr.type, values };
    }
    out.edge = copy;
  }
  return out;
}

/** Feeds the attributes into a signature hash (quadMeshSignature). */
export function mixPolyAttributes(attributes: PolyAttributes | undefined, mix: (n: number) => void): void {
  if (!attributes) return;
  const mixName = (s: string) => {
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
  };
  for (const domain of ["point", "face", "corner"] as const) {
    const src = attributes[domain];
    if (!src) continue;
    for (const name of Object.keys(src).sort()) {
      mixName(domain + name);
      const attr = src[name];
      mixName(attr.type);
      for (const v of attr.data) mix(Math.round(v * 1e4));
    }
  }
  if (attributes.edge) {
    for (const name of Object.keys(attributes.edge).sort()) {
      mixName("edge" + name);
      const values = attributes.edge[name].values;
      for (const key of Object.keys(values).sort()) {
        mixName(key);
        for (const v of values[key]) mix(Math.round(v * 1e4));
      }
    }
  }
}

// ---------------------------------------------------------------- domains

/** The edges of the edge domain, in domain order: face edges (topology order), then loose edges. */
export function domainEdges(mesh: PolyMesh): ReadonlyArray<readonly [number, number]> {
  const topology = getTopology(mesh);
  if (!mesh.edges || mesh.edges.length === 0) return topology.edges;
  const out: (readonly [number, number])[] = [...topology.edges];
  for (const [a, b] of mesh.edges) if (topology.findEdge(a, b) < 0) out.push(a < b ? [a, b] : [b, a]);
  return out;
}

export function cornerCount(mesh: PolyMesh): number {
  let n = 0;
  for (const f of mesh.faces) n += f.length;
  return n;
}

export function domainSize(mesh: PolyMesh, domain: AttrDomain): number {
  switch (domain) {
    case "point":
      return mesh.positions.length;
    case "face":
      return mesh.faces.length;
    case "corner":
      return cornerCount(mesh);
    case "edge":
      return domainEdges(mesh).length;
  }
}

// ---------------------------------------------------------------- read

export interface DomainValues {
  type: AttrType;
  size: number;
  /** `size` numbers per element of the domain. */
  values: Float64Array;
}

/** Names readable on a domain: built-ins first, then stored attributes. */
export function listAttributeNames(mesh: PolyMesh | null | undefined, domain: AttrDomain, includeBuiltins = true): string[] {
  const stored = mesh?.attributes?.[domain] ? Object.keys(mesh.attributes[domain]!) : [];
  return includeBuiltins ? [...Object.keys(BUILTIN_ATTRIBUTES[domain]), ...stored.filter((n) => !isBuiltinAttribute(domain, n))] : stored;
}

/** Every stored bool attribute (group) of a mesh, per domain. */
export function listGroups(mesh: PolyMesh | null | undefined): { domain: AttrDomain; name: string }[] {
  const out: { domain: AttrDomain; name: string }[] = [];
  if (!mesh?.attributes) return out;
  for (const domain of ATTR_DOMAINS) {
    const src = mesh.attributes[domain] as Record<string, { type: AttrType }> | undefined;
    if (!src) continue;
    for (const [name, attr] of Object.entries(src)) if (attr.type === "bool") out.push({ domain, name });
  }
  return out;
}

export function attributeType(mesh: PolyMesh, domain: AttrDomain, name: string): AttrType | null {
  const stored = mesh.attributes?.[domain]?.[name];
  if (stored) return stored.type;
  return BUILTIN_ATTRIBUTES[domain][name] ?? null;
}

/** Which domains carry an attribute (stored or built-in) of this name. */
export function attributeDomains(mesh: PolyMesh, name: string): AttrDomain[] {
  return ATTR_DOMAINS.filter((d) => attributeType(mesh, d, name) !== null);
}

const readCache = new WeakMap<PolyMesh, Map<string, DomainValues>>();

/**
 * The values of one attribute over a whole domain, or null when the mesh has
 * no attribute of that name there. Cached per mesh (meshes are immutable once
 * built), so a group expression naming the same attribute five times reads it
 * once.
 */
export function readAttribute(mesh: PolyMesh, domain: AttrDomain, name: string): DomainValues | null {
  let cache = readCache.get(mesh);
  const key = `${domain}:${name}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const result = computeAttribute(mesh, domain, name);
  if (result) {
    if (!cache) {
      cache = new Map();
      readCache.set(mesh, cache);
    }
    cache.set(key, result);
  }
  return result;
}

function computeAttribute(mesh: PolyMesh, domain: AttrDomain, name: string): DomainValues | null {
  const count = domainSize(mesh, domain);
  if (domain === "edge") {
    const stored = mesh.attributes?.edge?.[name];
    if (stored) {
      const size = attrSize(stored.type);
      const values = new Float64Array(count * size);
      domainEdges(mesh).forEach(([a, b], i) => {
        const v = stored.values[edgeKey(a, b)];
        if (v) for (let k = 0; k < size; k++) values[i * size + k] = v[k] ?? 0;
      });
      return { type: stored.type, size, values };
    }
  } else {
    const stored = mesh.attributes?.[domain]?.[name];
    if (stored) {
      const size = attrSize(stored.type);
      const values = new Float64Array(count * size);
      const n = Math.min(values.length, stored.data.length);
      for (let i = 0; i < n; i++) values[i] = stored.data[i] ?? 0;
      return { type: stored.type, size, values };
    }
  }
  return builtinAttribute(mesh, domain, name, count);
}

function builtinAttribute(mesh: PolyMesh, domain: AttrDomain, name: string, count: number): DomainValues | null {
  const type = BUILTIN_ATTRIBUTES[domain][name];
  if (!type) return null;
  const size = attrSize(type);
  const values = new Float64Array(count * size);
  const out = (): DomainValues => ({ type, size, values });

  if (name === "id") {
    for (let i = 0; i < count; i++) values[i] = i;
    return out();
  }

  if (domain === "point") {
    if (name === "P") {
      mesh.positions.forEach((p, i) => values.set(p, i * 3));
    } else if (name === "N") {
      const fn = faceNormals(mesh);
      mesh.faces.forEach((face, f) => {
        for (const v of face) {
          values[v * 3] += fn[f * 3];
          values[v * 3 + 1] += fn[f * 3 + 1];
          values[v * 3 + 2] += fn[f * 3 + 2];
        }
      });
      for (let i = 0; i < count; i++) normalizeAt(values, i * 3);
    } else if (name === "uv") {
      if (mesh.uvs && mesh.uvs.length === count) {
        mesh.uvs.forEach((uv, i) => {
          values[i * 3] = uv[0];
          values[i * 3 + 1] = uv[1];
        });
      } else if (mesh.faceUVs) {
        mesh.faces.forEach((face, f) =>
          face.forEach((v, c) => {
            const uv = mesh.faceUVs?.[f]?.[c];
            if (uv) {
              values[v * 3] = uv[0];
              values[v * 3 + 1] = uv[1];
            }
          }),
        );
      }
    }
    return out();
  }

  if (domain === "face") {
    if (name === "P") {
      mesh.faces.forEach((face, f) => {
        for (const v of face) {
          const p = mesh.positions[v];
          values[f * 3] += p[0];
          values[f * 3 + 1] += p[1];
          values[f * 3 + 2] += p[2];
        }
        const n = face.length || 1;
        values[f * 3] /= n;
        values[f * 3 + 1] /= n;
        values[f * 3 + 2] /= n;
      });
    } else if (name === "N") {
      values.set(faceNormals(mesh));
    } else if (name === "area") {
      mesh.faces.forEach((face, f) => (values[f] = faceArea(mesh, face)));
    } else if (name === "material_index") {
      mesh.faces.forEach((_, f) => (values[f] = mesh.faceMaterials?.[f] ?? 0));
    } else if (name === "sides") {
      mesh.faces.forEach((face, f) => (values[f] = face.length));
    } else if (name === "piece") {
      values.set(facePieces(mesh));
    }
    return out();
  }

  if (domain === "edge") {
    const edges = domainEdges(mesh);
    const topology = getTopology(mesh);
    if (name === "length") {
      edges.forEach(([a, b], i) => (values[i] = dist(mesh.positions[a], mesh.positions[b])));
    } else if (name === "sharp" || name === "seam") {
      const list = name === "sharp" ? mesh.sharpEdges : mesh.seamEdges;
      const set = new Set((list ?? []).map(([a, b]) => edgeKey(a, b)));
      edges.forEach(([a, b], i) => (values[i] = set.has(edgeKey(a, b)) ? 1 : 0));
    } else if (name === "crease") {
      const map = new Map((mesh.edgeCreases ?? []).map(([a, b, w]) => [edgeKey(a, b), w]));
      edges.forEach(([a, b], i) => (values[i] = map.get(edgeKey(a, b)) ?? 0));
    } else if (name === "boundary") {
      edges.forEach(([a, b], i) => (values[i] = topology.edgeFaces(a, b).length === 1 ? 1 : 0));
    } else if (name === "angle") {
      const fn = faceNormals(mesh);
      edges.forEach(([a, b], i) => {
        const faces = topology.edgeFaces(a, b);
        if (faces.length !== 2) {
          values[i] = 0;
          return;
        }
        const [f, g] = faces;
        const d = fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2];
        values[i] = (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
      });
    }
    return out();
  }

  // corner
  let c = 0;
  mesh.faces.forEach((face, f) => {
    face.forEach((v, i) => {
      if (name === "uv") {
        const uv = mesh.faceUVs?.[f]?.[i] ?? mesh.uvs?.[v];
        if (uv) {
          values[c * 3] = uv[0];
          values[c * 3 + 1] = uv[1];
        }
      } else if (name === "Cd") {
        const col = mesh.faceColors?.[f]?.[i];
        values[c * 3] = col ? col[0] : 1;
        values[c * 3 + 1] = col ? col[1] : 1;
        values[c * 3 + 2] = col ? col[2] : 1;
      }
      c++;
    });
  });
  return out();
}

// ---------------------------------------------------------------- write

/**
 * A new mesh with one attribute set over a whole domain (positions, faces and
 * the other attributes shared, not copied — meshes are immutable once built).
 * `values` holds `attrSize(type)` numbers per element.
 *
 * Point `P` moves the vertices. Other built-in names are refused (returns the
 * mesh unchanged) except `material_index` on faces, which writes the
 * material slots, and `Cd` on corners, which writes the vertex colours.
 */
export function setAttribute(mesh: PolyMesh, domain: AttrDomain, name: string, type: AttrType, values: ArrayLike<number>): PolyMesh {
  if (!isValidAttributeName(name)) return mesh;
  if (isBuiltinAttribute(domain, name)) {
    if (domain === "point" && name === "P") {
      return { ...mesh, positions: mesh.positions.map((_, i) => [values[i * 3] ?? 0, values[i * 3 + 1] ?? 0, values[i * 3 + 2] ?? 0]) };
    }
    if (domain === "face" && name === "material_index") {
      return { ...mesh, faceMaterials: mesh.faces.map((_, f) => Math.max(0, Math.round(values[f] ?? 0))) };
    }
    if (domain === "corner" && name === "Cd") {
      let c = 0;
      const faceColors = mesh.faces.map((face) =>
        face.map(() => {
          const col: [number, number, number] = [values[c * 3] ?? 1, values[c * 3 + 1] ?? 1, values[c * 3 + 2] ?? 1];
          c++;
          return col;
        }),
      );
      return { ...mesh, faceColors };
    }
    if (domain === "edge" && (name === "sharp" || name === "seam")) {
      const list: [number, number][] = [];
      domainEdges(mesh).forEach(([a, b], i) => {
        if (values[i]) list.push([a, b]);
      });
      return name === "sharp" ? { ...mesh, sharpEdges: list } : { ...mesh, seamEdges: list };
    }
    if (domain === "edge" && name === "crease") {
      const list: [number, number, number][] = [];
      domainEdges(mesh).forEach(([a, b], i) => {
        const w = Math.max(0, Math.min(1, values[i] ?? 0));
        if (w > 0) list.push([a, b, w]);
      });
      return { ...mesh, edgeCreases: list };
    }
    return mesh;
  }
  const size = attrSize(type);
  const attributes: PolyAttributes = { ...(mesh.attributes ?? {}) };
  if (domain === "edge") {
    const store: Record<string, number[]> = {};
    domainEdges(mesh).forEach(([a, b], i) => {
      const v: number[] = [];
      for (let k = 0; k < size; k++) v.push(cleanValue(type, values[i * size + k]));
      if (v.some((x) => x !== 0)) store[edgeKey(a, b)] = v;
    });
    attributes.edge = { ...(attributes.edge ?? {}), [name]: { type, values: store } };
  } else {
    const count = domainSize(mesh, domain) * size;
    const data = new Array<number>(count);
    for (let i = 0; i < count; i++) data[i] = cleanValue(type, values[i]);
    attributes[domain] = { ...(attributes[domain] ?? {}), [name]: { type, data } };
  }
  return { ...mesh, attributes };
}

export function removeAttribute(mesh: PolyMesh, domain: AttrDomain, name: string): PolyMesh {
  const src = mesh.attributes?.[domain] as Record<string, unknown> | undefined;
  if (!src || !(name in src)) return mesh;
  const { [name]: _gone, ...rest } = src;
  return { ...mesh, attributes: { ...mesh.attributes, [domain]: rest } };
}

export function renameAttribute(mesh: PolyMesh, domain: AttrDomain, from: string, to: string): PolyMesh {
  const src = mesh.attributes?.[domain] as Record<string, unknown> | undefined;
  if (!src || !(from in src) || !isValidAttributeName(to) || isBuiltinAttribute(domain, to) || from === to) return mesh;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (k !== from) next[k] = v;
  next[to] = src[from];
  return { ...mesh, attributes: { ...mesh.attributes, [domain]: next } };
}

/** Writes a group (bool attribute) from a 0/1 mask. */
export function setGroup(mesh: PolyMesh, domain: AttrDomain, name: string, mask: ArrayLike<number>): PolyMesh {
  return setAttribute(mesh, domain, name, "bool", mask);
}

/** Attribute names: letters, digits and underscore, not starting with a digit. */
export function isValidAttributeName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function cleanValue(type: AttrType, raw: number | undefined): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  if (type === "bool") return v ? 1 : 0;
  if (type === "int") return Math.round(v);
  return v;
}

/**
 * Brings every stored array back to its domain's length (padding with 0,
 * truncating extra), so code that indexes `data` directly can trust it.
 * Edit Mesh operations append faces without knowing about attributes; this
 * runs on the way out of every node (writePolyMesh).
 */
export function normalizeAttributes(mesh: PolyMesh): PolyMesh {
  const attrs = mesh.attributes;
  if (!attrs) return mesh;
  let changed = false;
  const next: PolyAttributes = { ...attrs };
  for (const domain of ["point", "face", "corner"] as const) {
    const src = attrs[domain];
    if (!src) continue;
    const count = domainSize(mesh, domain);
    let domainChanged = false;
    const copy: Record<string, PolyAttribute> = {};
    for (const [name, attr] of Object.entries(src)) {
      const want = count * attrSize(attr.type);
      if (attr.data.length === want) {
        copy[name] = attr;
        continue;
      }
      domainChanged = true;
      const data = attr.data.slice(0, want);
      while (data.length < want) data.push(0);
      copy[name] = { type: attr.type, data };
    }
    if (domainChanged) {
      next[domain] = copy;
      changed = true;
    }
  }
  return changed ? { ...mesh, attributes: next } : mesh;
}

// ---------------------------------------------------------------- geometry helpers

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalizeAt(values: Float64Array, i: number) {
  const len = Math.hypot(values[i], values[i + 1], values[i + 2]);
  if (len > 1e-12) {
    values[i] /= len;
    values[i + 1] /= len;
    values[i + 2] /= len;
  }
}

const normalCache = new WeakMap<PolyMesh, Float64Array>();

/** Unit face normals (Newell's method, robust for n-gons), 3 per face. Cached per mesh. */
export function faceNormals(mesh: PolyMesh): Float64Array {
  let cached = normalCache.get(mesh);
  if (cached) return cached;
  cached = new Float64Array(mesh.faces.length * 3);
  mesh.faces.forEach((face, f) => {
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let i = 0; i < face.length; i++) {
      const a = mesh.positions[face[i]];
      const b = mesh.positions[face[(i + 1) % face.length]];
      if (!a || !b) continue;
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    cached![f * 3] = nx;
    cached![f * 3 + 1] = ny;
    cached![f * 3 + 2] = nz;
    normalizeAt(cached!, f * 3);
  });
  normalCache.set(mesh, cached);
  return cached;
}

export function faceArea(mesh: PolyMesh, face: readonly number[]): number {
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = mesh.positions[face[i]];
    const b = mesh.positions[face[(i + 1) % face.length]];
    if (!a || !b) continue;
    nx += a[1] * b[2] - a[2] * b[1];
    ny += a[2] * b[0] - a[0] * b[2];
    nz += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(nx, ny, nz) / 2;
}

/** Connected-piece number of every face (faces sharing a vertex are one piece), numbered from 0 in face order. */
export function facePieces(mesh: PolyMesh): Int32Array {
  const parent = new Int32Array(mesh.positions.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const face of mesh.faces) for (let i = 1; i < face.length; i++) {
    const a = find(face[0]);
    const b = find(face[i]);
    if (a !== b) parent[a] = b;
  }
  const label = new Map<number, number>();
  const out = new Int32Array(mesh.faces.length);
  mesh.faces.forEach((face, f) => {
    if (face.length === 0) return;
    const root = find(face[0]);
    let id = label.get(root);
    if (id === undefined) {
      id = label.size;
      label.set(root, id);
    }
    out[f] = id;
  });
  return out;
}

/** Connected-piece number of every point (unused points get their own piece after the face pieces). */
export function pointPieces(mesh: PolyMesh): Int32Array {
  const facePiece = facePieces(mesh);
  const out = new Int32Array(mesh.positions.length).fill(-1);
  mesh.faces.forEach((face, f) => face.forEach((v) => (out[v] = facePiece[f])));
  let next = 0;
  for (const p of facePiece) if (p + 1 > next) next = p + 1;
  for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = next++;
  return out;
}
