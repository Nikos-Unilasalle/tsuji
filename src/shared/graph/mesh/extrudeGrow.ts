import * as THREE from "three";
import { extrudeFaces, type PolyMesh } from "../quadMesh";
import { extrudeFacesIndividual } from "./tools";
import { createPRNG } from "../../math/random";
import { facePieces } from "./polyAttributes";

/**
 * Extrude Mesh's multi-pass "grow" on the PolyMesh: each pass extrudes the
 * same cap faces again (extrudeFaces keeps the caps' indices and appends the
 * walls), then turns, scales and moves the cap about its own centroid — the
 * recursion that grows a tube's top into a branch. Same semantics as the
 * triangle version in nodes/meshEdit.ts, but on real faces (quads stay quads,
 * n-gons stay n-gons) so the result keeps its topology, UVs and attributes.
 *
 * `individual` extrudes every face on its own (walls between neighbours) and
 * transforms each cap about its own centroid; otherwise each connected region
 * of the selection moves as one.
 */
export interface GrowOptions {
  passes: number;
  rotation: THREE.Vector3;
  scale: THREE.Vector3;
  location: THREE.Vector3;
  random: number;
  seed: number;
  individual?: boolean;
}

export function polyExtrudeGrow(mesh: PolyMesh, faces: number[], distance: number, options: GrowOptions): { mesh: PolyMesh; caps: number[]; walls: number[] } {
  const caps = [...new Set(faces)].filter((f) => f >= 0 && f < mesh.faces.length).sort((a, b) => a - b);
  if (caps.length === 0 || options.passes <= 0) return { mesh, caps, walls: [] };
  const rng = createPRNG(options.seed);
  const jit = (base: number) => base * (1 + (rng() * 2 - 1) * options.random);
  const hasTransform =
    options.rotation.lengthSq() > 0 || options.scale.x !== 1 || options.scale.y !== 1 || options.scale.z !== 1 || options.location.lengthSq() > 0;

  let current = mesh;
  const walls: number[] = [];
  for (let pass = 0; pass < options.passes; pass++) {
    const before = current.faces.length;
    const d = Math.max(0, jit(distance));
    current = (options.individual ? extrudeFacesIndividual(current, caps, d) : extrudeFaces(current, caps, d)).mesh;
    for (let f = before; f < current.faces.length; f++) walls.push(f);
    if (hasTransform || options.random > 0) {
      const rotation = new THREE.Vector3(jit(options.rotation.x), jit(options.rotation.y), jit(options.rotation.z));
      const scale = new THREE.Vector3(jit(options.scale.x), jit(options.scale.y), jit(options.scale.z));
      const location = new THREE.Vector3(jit(options.location.x), jit(options.location.y), jit(options.location.z));
      current = transformCaps(current, caps, rotation, scale, location, Boolean(options.individual));
    }
  }
  return { mesh: current, caps, walls };
}

function transformCaps(mesh: PolyMesh, caps: number[], rotation: THREE.Vector3, scale: THREE.Vector3, location: THREE.Vector3, individual: boolean): PolyMesh {
  // Groups of cap faces that move together: each face, or each connected region.
  const groups: number[][] = [];
  if (individual) for (const f of caps) groups.push([f]);
  else {
    const sub: PolyMesh = { positions: mesh.positions, faces: caps.map((f) => mesh.faces[f]) };
    const pieces = facePieces(sub);
    const byPiece = new Map<number, number[]>();
    pieces.forEach((p, i) => byPiece.set(p, [...(byPiece.get(p) ?? []), caps[i]]));
    groups.push(...byPiece.values());
  }
  const positions = mesh.positions.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
  const p = new THREE.Vector3();
  for (const group of groups) {
    const verts = new Set<number>();
    for (const f of group) for (const v of mesh.faces[f]) verts.add(v);
    let cx = 0, cy = 0, cz = 0;
    for (const v of verts) {
      cx += mesh.positions[v][0];
      cy += mesh.positions[v][1];
      cz += mesh.positions[v][2];
    }
    cx /= verts.size;
    cy /= verts.size;
    cz /= verts.size;
    for (const v of verts) {
      const q = mesh.positions[v];
      p.set(q[0] - cx, q[1] - cy, q[2] - cz).applyQuaternion(quat).multiply(scale);
      positions[v] = [p.x + cx + location.x, p.y + cy + location.y, p.z + cz + location.z];
    }
  }
  return { ...mesh, positions };
}
