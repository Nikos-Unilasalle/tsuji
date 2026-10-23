import * as THREE from "three";
import { worldMatrixOf } from "../objectPosition";

/**
 * Reading metaball elements out of what the graph carries: point lists,
 * geometry wires (children and instances, with their rotation × scale and
 * colour), segment lists and polylines, per-element lists. Shared by the
 * Metaballs node and the Blob Field nodes (blobField.ts).
 */

/** A single NaN centre poisons every cell of the field, so finiteness is checked here rather than trusted. */
export function asPoint(value: unknown): THREE.Vector3 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { x?: unknown; y?: unknown; z?: unknown };
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const z = Number(candidate.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return new THREE.Vector3(x, y, z);
}

const tmpMatrix = new THREE.Matrix4();
const tmpInstance = new THREE.Matrix4();
const tmpColor = new THREE.Color();

/** A ball centre plus what its source object says about it. */
export interface Centre {
  point: THREE.Vector3;
  /** Row-major 3×3 of the source's rotation × scale, relative to the wired root. */
  shape?: number[];
  /** Instance colour, or the source mesh's material colour. */
  color?: [number, number, number];
}

export function shapeOf(m: THREE.Matrix4): number[] {
  const e = m.elements;
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

export function materialColor(object: THREE.Object3D): [number, number, number] | undefined {
  const material = (object as THREE.Mesh).material;
  const first = Array.isArray(material) ? material[0] : material;
  const color = (first as THREE.MeshStandardMaterial | undefined)?.color;
  return color instanceof THREE.Color ? [color.r, color.g, color.b] : undefined;
}

/**
 * Ball centres from a geometry wire: one per drawable descendant, plus one per
 * instance of an InstancedMesh, so an Array / Spawner / Instance Positions
 * chain feeds this node without an explicit point list in between. Positions
 * come out in the source root's own space, so moving that root moves the blobs
 * with it rather than dragging the field cube across them. Each centre keeps
 * its source's rotation × scale (an ellipsoid, if Instance Shape is on — off
 * by default, since scenes often scale their marker objects without meaning
 * the blobs to follow) and colour.
 */
export function centresFromObject(object: THREE.Object3D, out: Centre[], frame?: THREE.Matrix4): void {
  // `frame` (world → the space to express centres in) defaults to the wired
  // root's own space — a Merge / Group is a container whose children are the
  // centres. A lone mesh wired straight in is the centre itself, though: its
  // own location, rotation and scale have to count, so it is read in its
  // parent's space instead (not an InstancedMesh: its instances are the
  // centres, relative to it, as before).
  const lone = ((object as THREE.Mesh).isMesh || (object as THREE.Points).isPoints) && !(object as THREE.InstancedMesh).isInstancedMesh;
  const rootInverse =
    frame ??
    (lone
      ? object.parent
        ? worldMatrixOf(object.parent, tmpMatrix).clone().invert()
        : new THREE.Matrix4()
      : worldMatrixOf(object, tmpMatrix).clone().invert());
  object.traverse((child) => {
    const instanced = child as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      const childWorld = worldMatrixOf(child, tmpMatrix).clone();
      const fallback = materialColor(child);
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, tmpInstance);
        tmpInstance.premultiply(childWorld).premultiply(rootInverse);
        let color = fallback;
        if (instanced.instanceColor) {
          instanced.getColorAt(i, tmpColor);
          color = [tmpColor.r, tmpColor.g, tmpColor.b];
        }
        out.push({ point: new THREE.Vector3().setFromMatrixPosition(tmpInstance), shape: shapeOf(tmpInstance), color });
      }
      return;
    }
    if (!(child as THREE.Mesh).isMesh && !(child as THREE.Points).isPoints) return;
    const local = worldMatrixOf(child, tmpMatrix).clone().premultiply(rootInverse);
    out.push({ point: new THREE.Vector3().setFromMatrixPosition(local), shape: shapeOf(local), color: materialColor(child) });
  });
}

/** Centres from a point list and a geometry wire, in that order. */
export function collectCentres(points: unknown, geometry: unknown, frame?: THREE.Matrix4): Centre[] {
  const centres: Centre[] = [];
  if (Array.isArray(points)) {
    for (const entry of points) {
      const point = asPoint(entry);
      if (point) centres.push({ point });
    }
  }
  if (geometry instanceof THREE.Object3D) centresFromObject(geometry, centres, frame);
  return centres;
}

/** A segment entry given as an object: {start, end}, {a, b} or {from, to}. */
export function asSegment(value: unknown): [THREE.Vector3, THREE.Vector3] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const pa = asPoint(v.start ?? v.a ?? v.from);
  const pb = asPoint(v.end ?? v.b ?? v.to);
  return pa && pb ? [pa, pb] : null;
}

export interface Segment {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** Polyline id (> 0): its capsules join without bulging at the joints. 0 for a lone segment. */
  chain: number;
}

/** Consecutive points joined: n points → n − 1 capsules, one chain. Unreadable points are skipped. */
export function chain(points: unknown[], id: number, out: Segment[]): void {
  let previous: THREE.Vector3 | null = null;
  for (const entry of points) {
    const point = asPoint(entry);
    if (!point) continue;
    if (previous) out.push({ a: previous, b: point, chain: id });
    previous = point;
  }
}

/**
 * The Segments input, in whichever shape it arrives:
 *   - a list of points (Curve → To Points) — a polyline, one capsule per span;
 *   - a list of point lists — several polylines ([a, b] pairs are the 2-point case);
 *   - a list of {start, end} objects.
 */
export function collectSegments(value: unknown): Segment[] {
  const segments: Segment[] = [];
  if (!Array.isArray(value)) return segments;
  if (value.some((entry) => asPoint(entry))) {
    chain(value, 1, segments);
    return segments;
  }
  let id = 0;
  for (const entry of value) {
    if (Array.isArray(entry)) chain(entry, ++id, segments);
    else {
      const segment = asSegment(entry);
      if (segment) segments.push({ a: segment[0], b: segment[1], chain: 0 });
    }
  }
  return segments;
}

/** THREE.Color, hex number, CSS string or {r, g, b}. */
export function asRgb(value: unknown): [number, number, number] | undefined {
  if (value instanceof THREE.Color) return [value.r, value.g, value.b];
  if (typeof value === "number" || typeof value === "string") {
    tmpColor.set(value as THREE.ColorRepresentation);
    return [tmpColor.r, tmpColor.g, tmpColor.b];
  }
  if (value && typeof value === "object") {
    const c = value as { r?: unknown; g?: unknown; b?: unknown };
    const rgb = [Number(c.r), Number(c.g), Number(c.b)];
    if (rgb.every(Number.isFinite)) return rgb as [number, number, number];
  }
  return undefined;
}

export function listAt(list: unknown, i: number): unknown {
  return Array.isArray(list) ? list[i] : undefined;
}

export function finiteAt(list: unknown, i: number, fallback: number): number {
  const v = listAt(list, i);
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}


/**
 * One element of a Blob Field: everything the kernel needs but the reach,
 * which the consuming Metaballs node derives from its own Smooth — so a lone
 * element's surface stays exactly at `radius` whatever node meshes it.
 */
export interface BlobFieldElement {
  kind: 0 | 1;
  a: [number, number, number];
  /** Segment end, for capsules (kind 1). */
  b?: [number, number, number];
  radius: number;
  /** Signed: below zero carves. */
  weight: number;
  color?: [number, number, number];
  /** Row-major 3×3 shaping a point into an ellipsoid. */
  shape?: number[];
  /** Polyline id (> 0): its capsules join without bulging. Unique within one field. */
  chain?: number;
}

/**
 * What a `blobfield` socket carries: metaball elements, in the space of the
 * points / objects they were made from (like a point list on Metaballs'
 * Centres input). Plain data, rebuilt by its node each evaluation.
 */
export interface BlobFieldValue {
  isBlobField: true;
  elements: BlobFieldElement[];
}

export function isBlobField(value: unknown): value is BlobFieldValue {
  return !!value && typeof value === "object" && (value as BlobFieldValue).isBlobField === true && Array.isArray((value as BlobFieldValue).elements);
}

/** Highest chain id in `elements` (0 when none). */
export function maxChain(elements: readonly BlobFieldElement[]): number {
  let max = 0;
  for (const e of elements) if (e.chain && e.chain > max) max = e.chain;
  return max;
}

/**
 * Appends `from` to `to`, renumbering its chains past those already in `to`
 * (two polylines must never share a chain id) and multiplying weights by
 * `weightScale` (−1 subtracts).
 */
export function appendField(to: BlobFieldElement[], from: readonly BlobFieldElement[], weightScale = 1): void {
  const offset = maxChain(to);
  for (const e of from) {
    to.push({ ...e, weight: e.weight * weightScale, chain: e.chain ? e.chain + offset : undefined });
  }
}
