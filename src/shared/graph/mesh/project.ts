import type { QuadMesh } from "../quadMesh";
import { boxProjectFace, fillNewFaceUVs, UV_DENSITY, type UV } from "./uv";

/*
 * UV projections, Blender's U-menu counterparts, on a set of faces (every
 * face when empty); faces outside it keep their UVs. Cube, Cylinder and
 * Sphere work in object space at UV_DENSITY — the same texel density as
 * every other projection here; From View maps the selection as the camera
 * sees it into 0..1; Follow Active Quads continues one face's UVs across the
 * rest, quad by quad.
 */

type V3 = [number, number, number];
export type ProjectionAxis = "x" | "y" | "z";

function targetFaces(mesh: QuadMesh, faces: number[]): number[] {
  const list = faces.length > 0 ? [...new Set(faces)] : mesh.faces.map((_, f) => f);
  return list.filter((f) => (mesh.faces[f]?.length ?? 0) >= 3);
}

function copyUVs(mesh: QuadMesh): UV[][] {
  return mesh.faces.map((face, f) =>
    (mesh.faceUVs?.[f]?.length === face.length ? mesh.faceUVs[f] : face.map(() => [0, 0])).map((uv) => [uv[0], uv[1]] as UV),
  );
}

function centreOf(mesh: QuadMesh, faces: number[]): V3 {
  const seen = new Set<number>();
  const c: V3 = [0, 0, 0];
  for (const f of faces) for (const v of mesh.faces[f]) {
    if (seen.has(v)) continue;
    seen.add(v);
    const p = mesh.positions[v];
    c[0] += p[0]; c[1] += p[1]; c[2] += p[2];
  }
  const n = Math.max(1, seen.size);
  return [c[0] / n, c[1] / n, c[2] / n];
}

/** A point in the frame whose "up" is `axis`: [across 1, across 2, along]. */
function inAxisFrame(p: readonly number[], c: V3, axis: ProjectionAxis): V3 {
  const d: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  if (axis === "x") return [d[1], d[2], d[0]];
  if (axis === "z") return [d[0], d[1], d[2]];
  return [d[2], d[0], d[1]]; // y: angle measured from +Z towards +X, as Blender faces it
}

/**
 * Around-the-axis coordinates for one face, with the wrap fixed: a face
 * straddling the angle's seam gets its low side moved up a full turn, so it
 * isn't stretched back across the whole layout.
 */
function wrapped(values: number[], period: number): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min <= period / 2) return values;
  return values.map((u) => (u < (min + max) / 2 ? u + period : u));
}

/** Box / cube projection (the same projection as a mesh with no UVs gets). */
export function cubeProject(mesh: QuadMesh, faces: number[]): QuadMesh {
  const faceUVs = copyUVs(mesh);
  for (const f of targetFaces(mesh, faces)) {
    faceUVs[f] = boxProjectFace(mesh, mesh.faces[f], faceNormal(mesh, mesh.faces[f]));
  }
  return { ...mesh, faceUVs };
}

/**
 * Cylinder projection around `axis` through the selection's centre: U the
 * arc length round the axis (at the selection's mean radius), V the height —
 * both in scene units at UV_DENSITY, so a cylinder of any size keeps the
 * texture's proportions.
 */
export function cylinderProject(mesh: QuadMesh, faces: number[], axis: ProjectionAxis = "y"): QuadMesh {
  const target = targetFaces(mesh, faces);
  const faceUVs = copyUVs(mesh);
  const c = centreOf(mesh, target);
  const radius = meanRadius(mesh, target, c, axis, true);
  const period = 2 * Math.PI * radius * UV_DENSITY;
  for (const f of target) {
    const pts = mesh.faces[f].map((v) => inAxisFrame(mesh.positions[v], c, axis));
    const us = wrapped(pts.map(([a, b]) => Math.atan2(b, a) * radius * UV_DENSITY), period);
    faceUVs[f] = pts.map((p, i) => [us[i], p[2] * UV_DENSITY]);
  }
  return { ...mesh, faceUVs };
}

/**
 * Sphere projection about the selection's centre: longitude and latitude,
 * as arc lengths at the mean radius (UV_DENSITY), `axis` the pole.
 */
export function sphereProject(mesh: QuadMesh, faces: number[], axis: ProjectionAxis = "y"): QuadMesh {
  const target = targetFaces(mesh, faces);
  const faceUVs = copyUVs(mesh);
  const c = centreOf(mesh, target);
  const radius = meanRadius(mesh, target, c, axis, false);
  const period = 2 * Math.PI * radius * UV_DENSITY;
  for (const f of target) {
    const pts = mesh.faces[f].map((v) => inAxisFrame(mesh.positions[v], c, axis));
    const us = wrapped(pts.map(([a, b]) => Math.atan2(b, a) * radius * UV_DENSITY), period);
    faceUVs[f] = pts.map((p, i) => {
      const r = Math.hypot(p[0], p[1], p[2]) || 1;
      return [us[i], Math.asin(Math.max(-1, Math.min(1, p[2] / r))) * radius * UV_DENSITY];
    });
  }
  return { ...mesh, faceUVs };
}

function meanRadius(mesh: QuadMesh, faces: number[], c: V3, axis: ProjectionAxis, aroundAxis: boolean): number {
  let sum = 0;
  let count = 0;
  const seen = new Set<number>();
  for (const f of faces) for (const v of mesh.faces[f]) {
    if (seen.has(v)) continue;
    seen.add(v);
    const [a, b, h] = inAxisFrame(mesh.positions[v], c, axis);
    sum += aroundAxis ? Math.hypot(a, b) : Math.hypot(a, b, h);
    count++;
  }
  return count > 0 && sum > 1e-9 ? sum / count : 1;
}

/**
 * Project From View: the selection as seen through `toView` (a function
 * from a local-space point to normalised device coordinates), scaled
 * uniformly into 0..1 — its on-screen proportions kept.
 */
export function viewProject(mesh: QuadMesh, faces: number[], toView: (p: V3) => [number, number]): QuadMesh {
  const target = targetFaces(mesh, faces);
  const faceUVs = copyUVs(mesh);
  const projected = new Map<number, [number, number]>();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of target) for (const v of mesh.faces[f]) {
    if (projected.has(v)) continue;
    const p = toView(mesh.positions[v] as V3);
    projected.set(v, p);
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  for (const f of target) {
    faceUVs[f] = mesh.faces[f].map((v) => {
      const [x, y] = projected.get(v)!;
      return [(x - minX) / size, (y - minY) / size];
    });
  }
  return { ...mesh, faceUVs };
}

/**
 * Follow Active Quads: `active` keeps its UVs (a projection, if it has
 * none); every other face of the set takes its UVs by unfolding across from
 * a neighbour in the set — so a strip or grid of quads comes out as one
 * straight, continuous layout following the active face.
 */
export function followActiveQuads(mesh: QuadMesh, faces: number[], active: number): QuadMesh {
  const target = targetFaces(mesh, faces);
  const faceUVs = copyUVs(mesh);
  const next: QuadMesh = { ...mesh, faceUVs };
  if (!(mesh.faceUVs?.[active]?.length === mesh.faces[active]?.length)) {
    faceUVs[active] = boxProjectFace(mesh, mesh.faces[active], faceNormal(mesh, mesh.faces[active]));
  }
  const rest = target.filter((f) => f !== active);
  for (const f of rest) faceUVs[f] = [];
  fillNewFaceUVs(next, rest, new Set([active]));
  return next;
}

function faceNormal(mesh: QuadMesh, face: number[]): { x: number; y: number; z: number } {
  const n = [0, 0, 0];
  for (let i = 0; i < face.length; i++) {
    const a = mesh.positions[face[i]];
    const b = mesh.positions[face[(i + 1) % face.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return { x: n[0], y: n[1], z: n[2] };
}
