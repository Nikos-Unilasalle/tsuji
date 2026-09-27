import * as THREE from "three";
import { QuadMesh, cloneQuadMesh, withFaceUVs } from "../quadMesh";
import { buildTopology } from "./topology";
import { compactMesh, faceUVMapper, projectNewFaceUVs } from "./tools";
import type { UV } from "./uv";

const vec = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);

/**
 * Bevels the selected edges: each becomes a strip `segments` quads wide,
 * `width` from the original edge on either side (measured perpendicular to
 * it, in the faces beside it), rounded when there's more than one segment.
 *
 * Around every vertex a bevelled edge ends at, each face gets one new corner:
 * where the offset lines of its two bevelled edges cross, or — beside a
 * single bevelled edge — on its other, unbevelled edge, sliding along it.
 * Where three or more bevelled edges meet (a cube corner), a new face fills
 * the corner. The original vertex goes, unless one of its edges receives no
 * new point (a bevel ending in the middle of a grid), in which case it stays
 * and the strip ends in a small cap there.
 *
 * Edges with other than two faces (open borders, non-manifold edges) are
 * skipped. New faces are selected in the result.
 */
export function bevelEdges(
  mesh: QuadMesh,
  edges: [number, number][],
  width: number,
  segments = 1,
): { mesh: QuadMesh; newFaces: number[] } {
  const base = withFaceUVs(mesh);
  const topo = buildTopology(base);
  const P = base.positions;
  const segs = Math.max(1, Math.min(16, Math.round(segments)));

  // Bevelled edges: manifold ones only.
  const bevelled = new Set<number>();
  for (const [a, b] of edges) {
    const id = topo.findEdge(a, b);
    if (id < 0) continue;
    const h = topo.findHalfedge(a, b) >= 0 ? topo.findHalfedge(a, b) : topo.findHalfedge(b, a);
    if (h < 0 || topo.heTwin[h] === -1) continue;
    bevelled.add(id);
  }
  if (bevelled.size === 0 || !(width > 0)) return { mesh: cloneQuadMesh(mesh), newFaces: [] };

  const next = cloneQuadMesh(base);
  const addVertex = (p: THREE.Vector3) => {
    next.positions.push([p.x, p.y, p.z]);
    return next.positions.length - 1;
  };

  // --- Around each bevel vertex --------------------------------------------
  const bevelVerts = new Set<number>();
  for (const id of bevelled) for (const v of topo.edges[id]) bevelVerts.add(v);

  /** New corner of face f at vertex v (keyed `${f}:${v}`). */
  const cornerVertex = new Map<string, number>();
  /** Point placed on unbevelled edge `id` near vertex v (keyed `${id}:${v}`), with every face that asked for it. */
  const edgePointParams = new Map<string, { t: number[] }>();
  /** Per bevel vertex: its outgoing half-edges in rotation order, and whether the fan closes. */
  const fans = new Map<number, { hs: number[]; closed: boolean }>();
  const kept = new Set<number>();

  // Pass 1: fans, and where each sliding corner wants its point.
  const slideRequests: { f: number; v: number; edge: number; t: number }[] = [];
  const insideRequests: { f: number; v: number; p: THREE.Vector3 }[] = [];

  for (const v of bevelVerts) {
    // Rotation around v: h (v→x, face F) → twin(prev(h)) (v→y, next face).
    // An open fan (v on a border) is walked from its first face, found by
    // stepping backwards: the h before h is next(twin(h)).
    let start = topo.vertexOut[v];
    if (start < 0) continue;
    for (let g = 0, back = topo.heTwin[start]; back !== -1 && g < 64; g++) {
      const prev = topo.heNext[back];
      if (prev === topo.vertexOut[v]) break; // closed fan: any start will do
      start = prev;
      back = topo.heTwin[start];
    }
    const hs: number[] = [];
    let closed = false;
    for (let h = start, g = 0; h !== -1 && g < 64; g++) {
      hs.push(h);
      const nh = topo.heTwin[topo.hePrev[h]];
      if (nh === start) {
        closed = true;
        break;
      }
      h = nh;
    }
    fans.set(v, { hs, closed });

    for (const h of hs) {
      const f = topo.heFace[h];
      const eOut = topo.heEdge[h]; // v → x
      const eIn = topo.heEdge[topo.hePrev[h]]; // y → v
      const x = topo.heOrigin[topo.heNext[h]];
      const y = topo.heOrigin[topo.hePrev[h]];
      const bOut = bevelled.has(eOut);
      const bIn = bevelled.has(eIn);
      if (!bOut && !bIn) continue;
      const dOut = vec(P[x]).sub(vec(P[v]));
      const dIn = vec(P[y]).sub(vec(P[v]));
      const lOut = dOut.length();
      const lIn = dIn.length();
      dOut.normalize();
      dIn.normalize();
      const sin = Math.max(1e-3, new THREE.Vector3().crossVectors(dOut, dIn).length());
      if (bOut && bIn) {
        // Both bevelled: where the two offset lines cross, inside the face.
        const s = Math.min(width / sin, 0.45 * Math.min(lOut, lIn));
        insideRequests.push({ f, v, p: vec(P[v]).addScaledVector(dOut, s).addScaledVector(dIn, s) });
      } else {
        // Slide along the unbevelled edge until `width` from the bevelled one.
        const slideEdge = bOut ? eIn : eOut;
        const slideLen = bOut ? lIn : lOut;
        const s = Math.min(width / sin, 0.45 * slideLen);
        slideRequests.push({ f, v, edge: slideEdge, t: s / slideLen });
      }
    }
  }

  // Sliding points: one per (edge, vertex), shared by both faces that ask.
  for (const r of slideRequests) {
    const key = `${r.edge}:${r.v}`;
    const entry = edgePointParams.get(key) ?? { t: [] };
    entry.t.push(r.t);
    edgePointParams.set(key, entry);
  }
  const edgePoint = new Map<string, number>();
  for (const [key, { t }] of edgePointParams) {
    const [id, v] = key.split(":").map(Number);
    const other = topo.edges[id][0] === v ? topo.edges[id][1] : topo.edges[id][0];
    const tt = t.reduce((a, b) => a + b, 0) / t.length;
    edgePoint.set(key, addVertex(vec(P[v]).lerp(vec(P[other]), tt)));
  }
  for (const r of slideRequests) cornerVertex.set(`${r.f}:${r.v}`, edgePoint.get(`${r.edge}:${r.v}`)!);
  for (const r of insideRequests) cornerVertex.set(`${r.f}:${r.v}`, addVertex(r.p));

  // A bevel vertex stays when one of its edges got no point (and isn't bevelled).
  for (const [v, { hs }] of fans) {
    const edgesAround = new Set<number>();
    for (const h of hs) {
      edgesAround.add(topo.heEdge[h]);
      edgesAround.add(topo.heEdge[topo.hePrev[h]]);
    }
    for (const e of edgesAround) {
      if (!bevelled.has(e) && !edgePoint.has(`${e}:${v}`)) kept.add(v);
    }
  }

  // --- Profiles: the points across each strip end ---------------------------------------
  /** Intermediate profile points at vertex v between corners a and b, from a to b. */
  const profileCache = new Map<string, number[]>();
  function profile(v: number, a: number, b: number): number[] {
    if (segs === 1) return [];
    const key = a < b ? `${v}:${a}:${b}` : `${v}:${b}:${a}`;
    let pts = profileCache.get(key);
    if (!pts) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const A = vec(next.positions[lo]);
      const B = vec(next.positions[hi]);
      const C = vec(P[v]);
      pts = [];
      for (let k = 1; k < segs; k++) {
        const t = k / segs;
        // Quadratic Bézier with the original corner as control: a rounded fillet.
        const p = A.clone().multiplyScalar((1 - t) * (1 - t)).addScaledVector(C, 2 * t * (1 - t)).addScaledVector(B, t * t);
        pts.push(addVertex(p));
      }
      profileCache.set(key, pts);
    }
    return a < b ? pts : [...pts].reverse();
  }

  // --- Rebuild the original faces ------------------------------------------------------
  const mappers = new Map<number, (p: THREE.Vector3) => UV>();
  const uvAt = (f: number, vIdx: number): UV => {
    let m = mappers.get(f);
    if (!m) mappers.set(f, (m = faceUVMapper(P, base.faces[f], base.faceUVs![f] as UV[])));
    return m(vec(next.positions[vIdx]));
  };

  base.faces.forEach((face, f) => {
    const out: number[] = [];
    const outUVs: UV[] = [];
    const push = (vIdx: number, uv: UV) => {
      if (out.length > 0 && out[out.length - 1] === vIdx) return;
      out.push(vIdx);
      outUVs.push(uv);
    };
    face.forEach((v, i) => {
      const uv = base.faceUVs![f][i] as UV;
      if (!bevelVerts.has(v)) return push(v, uv);
      const own = cornerVertex.get(`${f}:${v}`);
      if (own !== undefined) return push(own, uvAt(f, own));
      // Neither of this corner's edges is bevelled: pick up the points other
      // faces put on them, around the vertex if it stays.
      const h = topo.faceStart[f] + i;
      const eIn = topo.heEdge[topo.hePrev[h]];
      const eOut = topo.heEdge[h];
      const pin = edgePoint.get(`${eIn}:${v}`);
      const pout = edgePoint.get(`${eOut}:${v}`);
      if (pin !== undefined) push(pin, uvAt(f, pin));
      if (kept.has(v) || (pin === undefined && pout === undefined)) push(v, uv);
      if (pout !== undefined) push(pout, uvAt(f, pout));
    });
    if (out.length > 1 && out[0] === out[out.length - 1]) {
      out.pop();
      outUVs.pop();
    }
    next.faces[f] = out;
    next.faceUVs![f] = outUVs;
  });

  // --- Strips and corner patches ---------------------------------------------------------------
  const created: number[] = [];
  const addFace = (face: number[], from: number) => {
    const clean = face.filter((v, i) => v !== face[(i + 1) % face.length]);
    if (new Set(clean).size < 3 || new Set(clean).size !== clean.length) return;
    next.faces.push(clean);
    next.faceUVs!.push([]);
    if (next.faceMaterials) next.faceMaterials.push(next.faceMaterials[from] ?? 0);
    if (next.faceShading && next.faceShading.length > 0) next.faceShading.push(next.faceShading[from] ?? next.shading ?? "auto");
    created.push(next.faces.length - 1);
  };

  for (const id of bevelled) {
    const [a, b] = topo.edges[id];
    const hA = topo.findHalfedge(a, b) >= 0 ? topo.findHalfedge(a, b) : topo.findHalfedge(b, a);
    const fA = topo.heFace[hA];
    const fB = topo.heFace[topo.heTwin[hA]];
    const u = topo.heOrigin[hA];
    const w = topo.heOrigin[topo.heNext[hA]];
    const Au = cornerVertex.get(`${fA}:${u}`)!;
    const Aw = cornerVertex.get(`${fA}:${w}`)!;
    const Bu = cornerVertex.get(`${fB}:${u}`)!;
    const Bw = cornerVertex.get(`${fB}:${w}`)!;
    // fA runs u → w, so the strip runs w → u on its side.
    const rowU = [Au, ...profile(u, Au, Bu), Bu];
    const rowW = [Aw, ...profile(w, Aw, Bw), Bw];
    for (let k = 0; k < segs; k++) addFace([rowW[k], rowU[k], rowU[k + 1], rowW[k + 1]], fA);
  }

  // Corner patch: the polygon left where a bevel vertex was. Walking the fan
  // in order — edge, face, edge, face… — it collects each face's new corner,
  // and for each edge between them: a bevelled edge's profile points, the
  // point slid onto an unbevelled one, or the vertex itself where it stays.
  for (const [v, { hs, closed }] of fans) {
    const n = hs.length;
    const cornerOf = (i: number) => cornerVertex.get(`${topo.heFace[hs[i]]}:${v}`);
    const edgeItems = (e: number, before?: number, after?: number): number[] => {
      if (bevelled.has(e)) return before !== undefined && after !== undefined ? profile(v, before, after) : [];
      return [edgePoint.get(`${e}:${v}`) ?? v];
    };
    const loop: number[] = [];
    for (let i = 0; i < n; i++) {
      const before = i > 0 ? cornerOf(i - 1) : closed ? cornerOf(n - 1) : undefined;
      loop.push(...edgeItems(topo.heEdge[hs[i]], before, cornerOf(i)));
      const c = cornerOf(i);
      if (c !== undefined) loop.push(c);
    }
    if (!closed && n > 0) loop.push(...edgeItems(topo.heEdge[topo.hePrev[hs[n - 1]]]));
    const clean = loop.filter((x, i) => x !== loop[(i + 1) % loop.length]);
    // Two points (a strip passing through, or ending on a triangle's edge)
    // need no patch; a repeated point means the strips meet head-on.
    if (clean.length < 3 || new Set(clean).size !== clean.length) continue;

    // A lone strip end at a vertex that goes (a cube corner with one bevelled
    // edge): its rounded profile lies in the plane of the one face opposite,
    // so it belongs in that face's outline, not in a patch of its own.
    const bare = hs.map((h) => topo.heFace[h]).filter((f) => cornerVertex.get(`${f}:${v}`) === undefined);
    const bevelledHere = hs.filter((h) => bevelled.has(topo.heEdge[h])).length;
    if (!kept.has(v) && bare.length === 1 && bevelledHere === 1) {
      const f = bare[0];
      const face = next.faces[f];
      const uvs = next.faceUVs![f];
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        const mids = profile(v, a, b);
        if (mids.length === 0 || !mids.every((m) => clean.includes(m))) continue;
        face.splice(i + 1, 0, ...mids);
        uvs.splice(i + 1, 0, ...mids.map((m) => uvAt(f, m)));
        break;
      }
      continue;
    }
    addFace(clean, topo.heFace[hs[0]]);
  }

  // Wind every new face against its neighbours (no edge used twice the same way).
  const directed = new Set<string>();
  next.faces.forEach((face, f) => {
    if (created.includes(f)) return;
    face.forEach((v, i) => directed.add(`${v}>${face[(i + 1) % face.length]}`));
  });
  for (const f of created) {
    const face = next.faces[f];
    let clash = 0;
    let agree = 0;
    face.forEach((v, i) => {
      const w = face[(i + 1) % face.length];
      if (directed.has(`${v}>${w}`)) clash++;
      if (directed.has(`${w}>${v}`)) agree++;
    });
    if (clash > agree) next.faces[f] = [...face].reverse();
    next.faces[f].forEach((v, i) => directed.add(`${v}>${next.faces[f][(i + 1) % next.faces[f].length]}`));
  }

  projectNewFaceUVs(next, created);
  const { mesh: out, remapFace } = compactMesh(next);
  return { mesh: out, newFaces: created.map((f) => remapFace[f]).filter((f) => f >= 0) };
}

