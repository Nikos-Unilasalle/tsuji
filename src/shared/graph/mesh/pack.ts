import type { QuadMesh } from "../quadMesh";
import type { UV } from "./uv";

/**
 * UV island packing. An island is the set of UV points (mutable [u, v]
 * pairs, one per face corner) that move together; packing rotates each to
 * its tightest bounding box, lays it landscape, shelves the islands tallest
 * first, and scales the whole layout uniformly into the 0..1 square — one
 * scale for all, so every island keeps the same texel density relative to
 * the others.
 */
export function packIslands(islands: UV[][], margin = 0.02): void {
  const placed = islands.filter((points) => points.length > 0);
  if (placed.length === 0) return;

  const boxes = placed.map((points) => {
    orientTightest(points);
    let { w, h } = normalise(points);
    if (h > w) {
      // Landscape: shelves pack far better with every island lying down.
      for (const uv of points) {
        const u = uv[0];
        uv[0] = uv[1];
        uv[1] = w - u;
      }
      [w, h] = [h, w];
    }
    return { points, w, h };
  });

  const totalArea = boxes.reduce((acc, b) => acc + Math.max(b.w, 1e-9) * Math.max(b.h, 1e-9), 0);
  const side = Math.sqrt(totalArea);
  const gap = side * Math.max(0, Math.min(0.2, margin));
  const rowWidth = Math.max(side * 1.15, ...boxes.map((b) => b.w));
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].h - boxes[a].h);

  let x = gap;
  let y = gap;
  let rowH = 0;
  let usedW = 0;
  for (const i of order) {
    const box = boxes[i];
    if (x > gap && x + box.w > rowWidth) {
      x = gap;
      y += rowH + gap;
      rowH = 0;
    }
    for (const uv of box.points) {
      uv[0] += x;
      uv[1] += y;
    }
    x += box.w + gap;
    usedW = Math.max(usedW, x);
    rowH = Math.max(rowH, box.h);
  }
  const size = Math.max(usedW, y + rowH + gap) || 1;
  for (const box of boxes) for (const uv of box.points) {
    uv[0] /= size;
    uv[1] /= size;
  }
}

/** Turns the points about their centre to the angle (0..90°, 1° steps) with the smallest bounding box. */
function orientTightest(points: UV[]): void {
  let bestAngle = 0;
  let bestArea = Infinity;
  for (let deg = 0; deg < 90; deg += 1) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [u, v] of points) {
      const x = u * c - v * s;
      const y = u * s + v * c;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area < bestArea - 1e-12) {
      bestArea = area;
      bestAngle = r;
    }
  }
  const c = Math.cos(bestAngle);
  const s = Math.sin(bestAngle);
  for (const uv of points) {
    const [u, v] = uv;
    uv[0] = u * c - v * s;
    uv[1] = u * s + v * c;
  }
}

/** Moves the points to start at 0,0; returns their extent. */
function normalise(points: UV[]): { w: number; h: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [u, v] of points) {
    if (u < minX) minX = u;
    if (u > maxX) maxX = u;
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }
  for (const uv of points) {
    uv[0] -= minX;
    uv[1] -= minY;
  }
  return { w: maxX - minX, h: maxY - minY };
}

/**
 * The UV islands among `faces`: faces joined across an edge where both ends
 * carry the same UVs on either side (no seam in the layout there).
 */
export function faceUVIslands(mesh: QuadMesh, faces: number[]): number[][] {
  const inSet = new Set(faces);
  const parent = new Map<number, number>(faces.map((f) => [f, f]));
  const find = (f: number): number => {
    let r = f;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(f, r);
    return r;
  };
  const same = (a: UV | undefined, b: UV | undefined) => !!a && !!b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  const byEdge = new Map<string, { f: number; i: number }[]>();
  for (const f of faces) {
    const face = mesh.faces[f];
    face.forEach((v, i) => {
      const w = face[(i + 1) % face.length];
      const key = v < w ? `${v}_${w}` : `${w}_${v}`;
      const list = byEdge.get(key) ?? [];
      list.push({ f, i });
      byEdge.set(key, list);
    });
  }
  for (const uses of byEdge.values()) {
    if (uses.length !== 2) continue;
    const [p, q] = uses;
    if (!inSet.has(p.f) || !inSet.has(q.f)) continue;
    const fp = mesh.faces[p.f];
    const fq = mesh.faces[q.f];
    const uvp = mesh.faceUVs?.[p.f] as UV[] | undefined;
    const uvq = mesh.faceUVs?.[q.f] as UV[] | undefined;
    if (!uvp || !uvq) continue;
    const a = fp[p.i];
    const b = fp[(p.i + 1) % fp.length];
    if (same(uvp[p.i], uvq[fq.indexOf(a)]) && same(uvp[(p.i + 1) % fp.length], uvq[fq.indexOf(b)])) {
      parent.set(find(p.f), find(q.f));
    }
  }
  const groups = new Map<number, number[]>();
  for (const f of faces) {
    const r = find(f);
    const list = groups.get(r) ?? [];
    list.push(f);
    groups.set(r, list);
  }
  return [...groups.values()];
}

/**
 * Packs the UV islands the given faces already form (Pack Islands): each
 * island moves and turns as one, its shape untouched. Returns a new mesh.
 */
export function packFaceIslands(mesh: QuadMesh, faces: number[], margin = 0.02): QuadMesh {
  const faceUVs = (mesh.faceUVs ?? []).map((uvs) => uvs.map((uv) => [uv[0], uv[1]] as UV));
  const valid = faces.filter((f) => faceUVs[f]?.length === mesh.faces[f]?.length);
  const islands = faceUVIslands({ ...mesh, faceUVs }, valid).map((group) => group.flatMap((f) => faceUVs[f]));
  packIslands(islands, margin);
  return { ...mesh, faceUVs };
}
