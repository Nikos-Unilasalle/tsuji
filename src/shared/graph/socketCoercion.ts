import * as THREE from "three";
import { readPolyMesh, polyMeshToGeometry } from "./mesh/polyIO";
import { worldMatrixOf } from "./objectPosition";
import type { SocketType } from "./sockets";

/*
 * The few socket types that carry the same thing in two shapes, and convert
 * on the wire, so every node that deals in points (or curves) plugs into
 * every other:
 *
 *   geometry → list    the mesh's points, as a list of positions (world space)
 *   list → geometry    a list of positions becomes a point-only mesh (dots),
 *                      which Copy to Points, Select, the SDF nodes… read
 *   curve → list       one curve becomes a list of one
 *   list → curve       a list of positions becomes a smooth curve through
 *                      them (a list of curves passes as it is)
 *
 * The editor accepts these wires (canConnectSockets) and the evaluator
 * converts the value on its way in (coerceInput). A value that already has
 * the target's shape is never touched, so existing graphs evaluate exactly
 * as before. Conversions are cached on the value object.
 */

const PAIRS = new Set(["geometry>list", "list>geometry", "curve>list", "list>curve"]);

/** Can a wire run from a socket of type `from` into one of type `to`? */
export function canConnectSockets(from: SocketType, to: SocketType): boolean {
  if (from === "any" || to === "any" || from === to) return true;
  return PAIRS.has(`${from}>${to}`);
}

/** True when the pair converts on the wire (the editor can mark such wires). */
export function isCoercedWire(from: SocketType, to: SocketType): boolean {
  return from !== to && PAIRS.has(`${from}>${to}`);
}

const isVectorLike = (v: unknown): v is { x: number; y: number; z: number } =>
  v instanceof THREE.Vector3 || (typeof v === "object" && v !== null && typeof (v as { x?: unknown }).x === "number" && typeof (v as { y?: unknown }).y === "number");

const toVector = (v: { x: number; y: number; z?: number }) => (v instanceof THREE.Vector3 ? v : new THREE.Vector3(v.x, v.y, v.z ?? 0));

// ---------------------------------------------------------------- geometry → points

const pointsCache = new WeakMap<THREE.Object3D, { key: string; points: THREE.Vector3[] }>();

/** The points of a mesh (or of everything under an object), in world space: one per PolyMesh point, else per buffer vertex. */
export function pointsOfGeometry(object: THREE.Object3D): THREE.Vector3[] {
  const read = readPolyMesh(object);
  const matrix = read ? worldMatrixOf(read.srcMesh) : worldMatrixOf(object);
  const position = read?.srcMesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const key = `${read ? read.mesh.positions.length : -1}|${position?.version ?? -1}|${matrix.elements.join(",")}`;
  const hit = pointsCache.get(object);
  if (hit && hit.key === key) return hit.points;
  let points: THREE.Vector3[];
  if (read) {
    points = read.mesh.positions.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(matrix));
  } else {
    points = [];
    object.updateWorldMatrix(true, true);
    object.traverse((child) => {
      const g = (child as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      const pos = g?.getAttribute?.("position") as THREE.BufferAttribute | undefined;
      if (!pos) return;
      for (let i = 0; i < pos.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld));
    });
  }
  pointsCache.set(object, { key, points });
  return points;
}

// ---------------------------------------------------------------- points → geometry

const meshCache = new WeakMap<unknown[], THREE.Object3D>();
const dotMaterial = new THREE.PointsMaterial({ color: 0xf8fafc, size: 6, sizeAttenuation: false });

/**
 * A point-only mesh for a list of positions: a PolyMesh with points and no
 * faces (so every modelling node can read it), shown as dots.
 */
export function geometryOfPoints(list: unknown[]): THREE.Object3D {
  const hit = meshCache.get(list);
  if (hit) return hit;
  const points = list.filter(isVectorLike).map(toVector);
  const geometry = polyMeshToGeometry({ positions: points.map((p) => [p.x, p.y, p.z] as [number, number, number]), faces: [] });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
  const dotGeometry = new THREE.BufferGeometry().setFromPoints(points);
  const dots = new THREE.Points(dotGeometry, dotMaterial);
  dots.raycast = () => {};
  mesh.add(dots);
  meshCache.set(list, mesh);
  return mesh;
}

// ---------------------------------------------------------------- points → curve

const curveCache = new WeakMap<unknown[], THREE.Curve<THREE.Vector3>>();

function curveOfPoints(list: unknown[]): THREE.Curve<THREE.Vector3> | null {
  const hit = curveCache.get(list);
  if (hit) return hit;
  const points = list.filter(isVectorLike).map(toVector);
  if (points.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  curveCache.set(list, curve);
  return curve;
}

// ---------------------------------------------------------------- entry point

/**
 * The value a connected input socket of type `target` receives: unchanged
 * when it already has that shape, converted when it is the other shape of a
 * convertible pair.
 */
export function coerceInput(value: unknown, target: SocketType): unknown {
  if (value === undefined || value === null) return value;
  switch (target) {
    case "list":
      if (value instanceof THREE.Object3D) return pointsOfGeometry(value);
      if (value instanceof THREE.Curve) return [value];
      return value;
    case "geometry":
      if (Array.isArray(value) && value.length > 0 && value.every(isVectorLike)) return geometryOfPoints(value);
      return value;
    case "curve":
      if (Array.isArray(value) && value.length > 0 && value.every(isVectorLike)) return curveOfPoints(value) ?? value;
      return value;
    default:
      return value;
  }
}
