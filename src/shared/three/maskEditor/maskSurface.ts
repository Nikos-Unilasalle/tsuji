import * as THREE from "three";
import { Connection, Graph } from "../../graph/types";
import { worldMatrixOf } from "../../graph/objectPosition";

/**
 * The surface a Roto Mask is drawn on, and the maths between its UVs and the
 * screen.
 *
 * The mask itself lives in UV space (see maskShapes.ts); the viewport shows a
 * 3D scene. A shape is drawn on the picture it will cut, so the editor needs
 * to know which mesh that is, where its UV square sits in the world, and how
 * that projects to the screen — and back, for a click.
 */

/** A mesh's UV square in world space: `origin + u·U + v·V`. */
export interface UvFrame {
  origin: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  normal: THREE.Vector3;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * The affine UV → world map of a mesh, read from three of its vertices.
 *
 * Exact for a plane (or anything else whose UVs are a flat linear map of its
 * surface), which is what an image is shown on. A mesh with no UVs, or whose
 * first three vertices are collinear in UV, gets null — there is nothing to
 * draw on.
 */
export function uvFrameOf(mesh: THREE.Mesh): UvFrame | null {
  const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
  const position = geometry?.getAttribute("position");
  const uv = geometry?.getAttribute("uv");
  if (!position || !uv || position.count < 3) return null;

  // Three vertices spanning a non-degenerate UV triangle: the first one, then
  // the first two that differ from it in different directions.
  const index = geometry!.getIndex();
  const vertex = (i: number) => (index ? index.getX(i) : i);
  const count = index ? index.count : position.count;
  let best: [number, number, number] | null = null;
  let bestArea = 1e-9;
  const limit = Math.min(count, 12);
  for (let i = 0; i + 2 < limit; i += 3) {
    const [i0, i1, i2] = [vertex(i), vertex(i + 1), vertex(i + 2)];
    const area = Math.abs(
      (uv.getX(i1) - uv.getX(i0)) * (uv.getY(i2) - uv.getY(i0)) - (uv.getX(i2) - uv.getX(i0)) * (uv.getY(i1) - uv.getY(i0)),
    );
    if (area > bestArea) {
      bestArea = area;
      best = [i0, i1, i2];
    }
  }
  if (!best) return null;
  const [i0, i1, i2] = best;

  const du1 = uv.getX(i1) - uv.getX(i0);
  const dv1 = uv.getY(i1) - uv.getY(i0);
  const du2 = uv.getX(i2) - uv.getX(i0);
  const dv2 = uv.getY(i2) - uv.getY(i0);
  const det = du1 * dv2 - du2 * dv1;

  const matrix = worldMatrixOf(mesh);
  const p0 = _a.fromBufferAttribute(position, i0).applyMatrix4(matrix).clone();
  const p1 = _b.fromBufferAttribute(position, i1).applyMatrix4(matrix).clone();
  const p2 = _c.fromBufferAttribute(position, i2).applyMatrix4(matrix).clone();
  const d1 = p1.sub(p0);
  const d2 = p2.sub(p0);

  // Solve [du1 dv1; du2 dv2] · [U; V] = [d1; d2].
  const u = d1.clone().multiplyScalar(dv2).addScaledVector(d2, -dv1).divideScalar(det);
  const v = d2.clone().multiplyScalar(du1).addScaledVector(d1, -du2).divideScalar(det);
  const origin = p0.clone().addScaledVector(u, -uv.getX(i0)).addScaledVector(v, -uv.getY(i0));
  const normal = new THREE.Vector3().crossVectors(u, v);
  if (normal.lengthSq() < 1e-18) return null;
  return { origin, u, v, normal: normal.normalize() };
}

export function uvToWorld(frame: UvFrame, u: number, v: number, target = new THREE.Vector3()): THREE.Vector3 {
  return target.copy(frame.origin).addScaledVector(frame.u, u).addScaledVector(frame.v, v);
}

/** World point → UV, by projecting onto the frame's two axes (which need not be orthogonal). */
export function worldToUv(frame: UvFrame, point: THREE.Vector3): { x: number; y: number } {
  const d = point.clone().sub(frame.origin);
  const uu = frame.u.dot(frame.u);
  const vv = frame.v.dot(frame.v);
  const uv = frame.u.dot(frame.v);
  const du = d.dot(frame.u);
  const dv = d.dot(frame.v);
  const det = uu * vv - uv * uv;
  return { x: (du * vv - dv * uv) / det, y: (dv * uu - du * uv) / det };
}

export interface ScreenRect {
  width: number;
  height: number;
}

/** UV → pixels within the viewport, or null for a point behind the camera. */
export function uvToScreen(
  frame: UvFrame,
  camera: THREE.Camera,
  rect: ScreenRect,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const p = uvToWorld(frame, x, y).project(camera);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.z > 1 || p.z < -1) return null;
  return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height };
}

/** Pixels within the viewport → the UV the ray through them meets on the surface, or null if it never does. */
export function screenToUv(
  frame: UvFrame,
  camera: THREE.Camera,
  rect: ScreenRect,
  px: number,
  py: number,
): { x: number; y: number } | null {
  const ndc = new THREE.Vector3((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1, 0.5).unproject(camera);
  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  const direction =
    (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? camera.getWorldDirection(new THREE.Vector3())
      : ndc.sub(origin).normalize();
  const rayOrigin =
    (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? new THREE.Vector3((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1, -1).unproject(camera)
      : origin;
  const denominator = frame.normal.dot(direction);
  if (Math.abs(denominator) < 1e-9) return null;
  const t = frame.normal.dot(frame.origin.clone().sub(rayOrigin)) / denominator;
  if (!(t > 0)) return null;
  return worldToUv(frame, rayOrigin.clone().addScaledVector(direction, t));
}

/** On-screen size of one UV unit along each axis, in pixels (for tolerances), at the middle of the image. */
export function pixelsPerUv(frame: UvFrame, camera: THREE.Camera, rect: ScreenRect): { x: number; y: number } {
  const o = uvToScreen(frame, camera, rect, 0.5, 0.5);
  const a = uvToScreen(frame, camera, rect, 1, 0.5);
  const b = uvToScreen(frame, camera, rect, 0.5, 1);
  if (!o || !a || !b) return { x: 1, y: 1 };
  return { x: Math.hypot(a.x - o.x, a.y - o.y) * 2, y: Math.hypot(b.x - o.x, b.y - o.y) * 2 };
}

/** World width / height of the UV square: the aspect a mask drawn here should have. */
export function frameAspect(frame: UvFrame): number {
  const h = frame.v.length();
  return h > 1e-9 ? frame.u.length() / h : 1;
}

/* -------------------------------------------------------------------------- */
/* Which mesh is it drawn on?                                                 */
/* -------------------------------------------------------------------------- */

function meshesIn(object: unknown): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  if (!(object instanceof THREE.Object3D)) return out;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh && mesh.geometry?.getAttribute("uv")) out.push(mesh);
  });
  return out;
}

/**
 * The meshes a mask ends up cutting: found by following the wires out of the
 * mask node until a node that produced geometry — typically the Texture to
 * Plane it feeds, possibly through an Apply Mask or a Blur on the way.
 *
 * Breadth-first, so the nearest drawn surface wins. Empty when the mask feeds
 * nothing visible yet; the editor then has nowhere to draw and says so.
 */
export function findMaskSurfaces(
  graph: Pick<Graph, "connections">,
  results: Map<string, Record<string, unknown>> | null | undefined,
  maskNodeId: string,
): { nodeId: string; meshes: THREE.Mesh[] } | null {
  if (!results) return null;
  const outgoing = new Map<string, Connection[]>();
  for (const c of graph.connections) {
    const list = outgoing.get(c.fromNode);
    if (list) list.push(c);
    else outgoing.set(c.fromNode, [c]);
  }

  const seen = new Set<string>([maskNodeId]);
  let frontier = [maskNodeId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of outgoing.get(id) ?? []) {
        if (seen.has(c.toNode)) continue;
        seen.add(c.toNode);
        const meshes = meshesIn(results.get(c.toNode)?.geometry);
        if (meshes.length > 0) return { nodeId: c.toNode, meshes };
        next.push(c.toNode);
      }
    }
    frontier = next;
  }
  return null;
}
