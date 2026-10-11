import * as THREE from "three";
import { Brush, Evaluator, INTERSECTION } from "three-bvh-csg";
import { bakeMeshesToGeometry, collectMeshMaterials } from "../bakeGeometry";
import { sideSignature } from "../geometrySignature";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { cellToTriangles, tessellate, Vec3 } from "../voronoi";
import { asVector3 } from "./transform";
import { applyMaterialParams, materialParamsFromValue, MaterialParams, numberInput } from "./object";
import { isSimulating } from "./rapier";
import { isEpochCurrent } from "../simulationEpoch";

const MODES = ["mesh", "cells"] as const;
type FractureMode = (typeof MODES)[number];

interface FractureState {
  group?: THREE.Group;
  pieces?: THREE.Mesh[];
  centers?: THREE.Vector3[];
  /** Holds the inside material: applyMaterialParams manages `.material` on a mesh, not on a bare material. */
  inner?: THREE.Mesh;
  signature?: string;
  /** The source mesh's own materials, in CSG group order — the default surface look. */
  sourceMaterials?: THREE.Material[];
  /** Simulation epoch the pieces were last put at their authored pose in. */
  epoch?: number;
}

/** three-bvh-csg stores its MeshBVH on `geometry.n` — null it before disposing. */
function disposeGeometry(g: THREE.BufferGeometry): void {
  (g as { n?: unknown }).n = null;
  g.dispose();
}

function disposePieces(state: FractureState): void {
  for (const piece of state.pieces ?? []) disposeGeometry(piece.geometry);
  state.group?.clear();
  state.pieces = [];
  state.centers = [];
}

const stateCache = createNodeCache<FractureState>((s) => {
  disposePieces(s);
  const m = s.inner?.material;
  if (m instanceof THREE.MeshStandardMaterial) m.dispose();
});

function getState(nodeId: string): FractureState {
  let state = stateCache.get(nodeId);
  if (!state) {
    state = {};
    stateCache.set(nodeId, state);
  }
  return state;
}

/** Small deterministic PRNG — evaluate() has to be pure, so no Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One cell as an outward-wound triangle soup, cut faces in group 1, wall faces in group 0. */
function cellGeometry(cell: ReturnType<typeof tessellate>[number]): THREE.BufferGeometry | null {
  const { positions, normals, neighbors } = cellToTriangles(cell);
  if (positions.length === 0) return null;

  const wall: number[] = [];
  const cut: number[] = [];
  neighbors.forEach((nb, tri) => (nb < 0 ? wall : cut).push(tri));
  const order = [...wall, ...cut];

  const pos = new Float32Array(order.length * 9);
  const nrm = new Float32Array(order.length * 9);
  order.forEach((tri, i) => {
    pos.set(positions.slice(tri * 9, tri * 9 + 9), i * 9);
    nrm.set(normals.slice(tri * 9, tri * 9 + 9), i * 9);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(order.length * 6), 2));
  if (wall.length) geometry.addGroup(0, wall.length * 3, 0);
  if (cut.length) geometry.addGroup(wall.length * 3, cut.length * 3, 1);
  return geometry;
}

/**
 * Recentres a piece on its own bounding-box middle: the geometry is moved so
 * its local origin sits at the centre, and the mesh takes the offset as its
 * position. A physics body takes its origin from the mesh pose, so without
 * this every piece would pivot around the world origin and fling itself
 * around it instead of tumbling in place.
 */
function makePiece(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], roles: number[], nodeId: string): THREE.Mesh {
  geometry.computeBoundingBox();
  const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(center);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Rigid Body keys its collider cache on this — see describeTarget in rapier.ts.
  mesh.userData.nodeId = nodeId;
  mesh.userData.roles = roles;
  return mesh;
}

/**
 * The inside (cut-face) material. A Material node hands over a *description*
 * (MaterialParams: colour, roughness, emissive…) rather than a THREE material,
 * so it goes through applyMaterialParams like every other object does. Without
 * one wired, the Cut Face Color / Glow params describe it.
 */
function innerMaterialFor(state: FractureState, wired: unknown, cutColor: THREE.Color, cutGlow: number): THREE.Material {
  if (!state.inner) state.inner = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.6 }));
  const description: MaterialParams = materialParamsFromValue(wired) ?? {
    color: cutColor,
    emissive: cutColor,
    emissiveIntensity: cutGlow,
    shadeless: false,
    roughness: 0.6,
    metalness: 0.1,
    wireframe: false,
    opacity: 1,
    transmission: 0,
    thickness: 0.5,
  };
  applyMaterialParams(state.inner, description, THREE.FrontSide);
  return state.inner.material as THREE.Material;
}

/**
 * Surface look, applied every evaluation rather than baked in at build time:
 * changing the Inside Material must not re-run the (slow) fracture. Each piece
 * gets one material array lined up with its geometry groups — the source's own
 * materials for the original surface, the inside material for the cuts.
 */
function applyPieceMaterials(state: FractureState, cut: THREE.Material): void {
  const source = state.sourceMaterials ?? [];
  for (const piece of state.pieces ?? []) {
    // roles[k]: index into the source materials, or -1 for the cut face.
    const roles = piece.userData.roles as number[] | undefined;
    if (!roles) continue;
    piece.material = roles.map((r) => (r < 0 ? cut : (source[r] ?? source[0])));
  }
}

/**
 * Puts every piece back where it was cut. A physics body moves the mesh it was
 * built from, and this node keeps the same meshes between frames (so bodies
 * stay valid) — so without this a Reset Simulation, or stopping playback, would
 * leave the shards wherever they last landed.
 */
function restorePose(state: FractureState): void {
  (state.pieces ?? []).forEach((piece, i) => {
    const center = state.centers?.[i];
    if (!center) return;
    piece.matrixAutoUpdate = true;
    piece.position.copy(center);
    piece.quaternion.identity();
    piece.scale.set(1, 1, 1);
    piece.updateMatrix();
  });
}

/**
 * Fracture — shatters a solid into pieces that fit back together.
 *
 * Voronoi cells around a set of seed points (see ../voronoi.ts, after Voro++)
 * partition space, so the pieces cut along them tile the object exactly.
 *
 *  - **mesh** mode intersects the (watertight) source mesh with every cell via
 *    CSG: the pieces keep the real surface, and each cut gets a flat inner face
 *    in the inside material. Slower, and needs a closed mesh.
 *  - **cells** mode skips the CSG and outputs the raw convex cells, clipped to
 *    the object's bounding box. Instant, perfectly closed and convex — the
 *    right choice for a box, for filling a volume, or for thousands of shards.
 *
 * **Made for physics.** `geometry` is one Group with one mesh per piece, each
 * centred on its own origin (see makePiece) and convex in `cells` mode — exactly
 * what Rigid Body's default per-child split and convex-hull collider want. Wire
 * it into Rigid Body and the pieces fall, scatter and pile up; `gap` leaves a
 * little clearance so the solver does not start with every piece overlapping
 * its neighbours. Set the body to kinematic or switch the world on later (Trigger)
 * to hold the object whole until something hits it. `pieces` and `centers`
 * are also exposed as lists for anything that wants to move them by hand.
 */
export const FRACTURE_NODE: NodeDefinition = {
  type: "modifier/fracture",
  label: "Fracture",
  category: "object",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "points", label: "Seed Points (List)", type: "list" },
    { id: "count", label: "Random Count", type: "value" },
    { id: "gap", label: "Gap", type: "value" },
    { id: "material", label: "Inside Material", type: "material" },
  ],
  outputs: [
    { id: "geometry", label: "Pieces (Group)", type: "geometry" },
    { id: "pieces", label: "Pieces (List)", type: "list" },
    { id: "centers", label: "Centers (List)", type: "list" },
    { id: "count", label: "Piece Count", type: "value" },
  ],
  defaultParams: {
    mode: "mesh",
    count: 16,
    seed: 1,
    gap: 0,
    cutColor: new THREE.Color(0xff6a1a),
    cutGlow: 1.5,
  },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: [...MODES] },
    {
      id: "modeNote",
      label:
        "mesh: cuts the real surface with CSG (closed mesh required, slower). cells: raw convex cells " +
        "clipped to the bounding box — instant, and ideal for physics.",
      kind: "note",
    },
    { id: "count", label: "Random Count (no Seed Points wired)", kind: "number", step: 1 },
    { id: "seed", label: "Random Seed", kind: "number", step: 1 },
    { id: "gap", label: "Gap (clearance between pieces)", kind: "number", step: 0.005 },
    { id: "cutColor", label: "Inside Color (when no Material is wired)", kind: "color", group: "Inside" },
    { id: "cutGlow", label: "Inside Glow (when no Material is wired)", kind: "number", step: 0.1, group: "Inside" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    const input = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const meshes = input ? collectMeshes(input) : [];

    // Back to the authored pose when the simulation is not running, and when a
    // Reset Simulation (new epoch) restarts it — before anything downstream reads us.
    const epoch = ctx.simulationEpoch ?? 0;
    if (!isSimulating(ctx) || (state.epoch !== undefined && !isEpochCurrent(state.epoch, epoch))) restorePose(state);
    state.epoch = epoch;

    const empty = () => ({
      geometry: state.group ?? new THREE.Group(),
      pieces: state.pieces ?? [],
      centers: state.centers ?? [],
      count: state.pieces?.length ?? 0,
    });

    if (!input || meshes.length === 0) {
      warnMeshRequired(ctx.nodeId, "Fracture", input);
      disposePieces(state);
      state.signature = undefined;
      return empty();
    }
    clearMeshWarning(ctx.nodeId);

    const mode: FractureMode = (MODES as readonly string[]).includes(String(params.mode)) ? (params.mode as FractureMode) : "mesh";
    const count = Math.max(2, Math.min(2000, Math.round(numberInput(inputs.count, params.count, 16))));
    const seed = Math.round(numberInput(undefined, params.seed, 1));
    const gap = Math.max(0, numberInput(inputs.gap, params.gap, 0));
    const cutColor = params.cutColor instanceof THREE.Color ? params.cutColor : new THREE.Color(String(params.cutColor ?? "#ff6a1a"));
    const cutGlow = Math.max(0, numberInput(undefined, params.cutGlow, 1.5));

    // Updated in place every evaluation, so tweaking it never re-runs the fracture.
    const inside = innerMaterialFor(state, inputs.material, cutColor, cutGlow);

    input.updateMatrixWorld(true);
    const userPoints = Array.isArray(inputs.points) && inputs.points.length > 0 ? (inputs.points as unknown[]) : null;
    const pointKey = userPoints
      ? userPoints.map((p) => {
          const v = asVector3(p, new THREE.Vector3());
          return `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
        })
      : [`random:${count}:${seed}`];

    const signature = JSON.stringify([mode, gap, pointKey, sideSignature(meshes)]);
    if (state.group && state.signature === signature) {
      applyPieceMaterials(state, inside);
      return empty();
    }

    // World-space bake: the seed points live in the world too.
    const baked = bakeMeshesToGeometry(meshes);
    if (!baked) {
      console.error("Fracture: could not merge the parts of the input into one shape");
      return empty();
    }
    baked.computeBoundingBox();
    const box = baked.boundingBox!.clone();

    // `mesh` mode needs cells that fully contain the surface; `cells` mode is
    // the box itself.
    const pad = mode === "mesh" ? Math.max(box.getSize(new THREE.Vector3()).length() * 0.02, 1e-3) : 0;
    const min: Vec3 = [box.min.x - pad, box.min.y - pad, box.min.z - pad];
    const max: Vec3 = [box.max.x + pad, box.max.y + pad, box.max.z + pad];

    let sites: Vec3[];
    if (userPoints) {
      sites = userPoints.map((p) => {
        const v = asVector3(p, new THREE.Vector3());
        return [v.x, v.y, v.z] as Vec3;
      });
    } else {
      const rand = mulberry32(seed);
      sites = Array.from({ length: count }, () => [
        box.min.x + rand() * (box.max.x - box.min.x),
        box.min.y + rand() * (box.max.y - box.min.y),
        box.min.z + rand() * (box.max.z - box.min.z),
      ]);
    }

    const cells = tessellate(sites, { min, max, gap });

    disposePieces(state);
    if (!state.group) {
      state.group = new THREE.Group();
      state.group.matrixAutoUpdate = false;
    }

    const pieces: THREE.Mesh[] = [];
    const outerMaterials = collectMeshMaterials(meshes);
    state.sourceMaterials = mode === "cells" ? [outerMaterials[0]] : outerMaterials;

    if (mode === "cells") {
      const materials = [outerMaterials[0], inside];
      for (const cell of cells) {
        if (cell.isEmpty) continue;
        const geometry = cellGeometry(cell);
        if (geometry) pieces.push(makePiece(geometry, materials, [0, -1], ctx.nodeId));
      }
    } else {
      const sourceBrush = new Brush(baked, outerMaterials.length > 1 ? outerMaterials : outerMaterials[0]);
      const evaluator = new Evaluator();
      evaluator.useGroups = true;
      try {
        for (const cell of cells) {
          if (cell.isEmpty) continue;
          const cellGeo = cellGeometry(cell);
          if (!cellGeo) continue;
          const cellBrush = new Brush(cellGeo, inside);
          try {
            const result = evaluator.evaluate(sourceBrush, cellBrush, INTERSECTION);
            if (!result.geometry.attributes.position || result.geometry.attributes.position.count < 4) {
              disposeGeometry(result.geometry);
              continue;
            }
            const material = Array.isArray(result.material) ? [...result.material] : [result.material];
            const roles = material.map((m) => (m === inside ? -1 : Math.max(0, outerMaterials.indexOf(m))));
            pieces.push(makePiece(result.geometry, material, roles, ctx.nodeId));
          } catch (err) {
            console.error("Fracture: CSG failed on one cell", err);
          } finally {
            disposeGeometry(cellGeo);
          }
        }
      } finally {
        disposeGeometry(baked);
      }
    }
    if (mode === "cells") disposeGeometry(baked);

    state.group.clear();
    // Pieces inherit the source's pivot offset, as every other modifier does.
    const sourcePivot = meshes[0].userData?.pivot;
    for (const piece of pieces) {
      if (sourcePivot) piece.userData.pivot = sourcePivot instanceof THREE.Vector3 ? sourcePivot.clone() : sourcePivot;
      state.group.add(piece);
    }
    state.group.updateMatrix();
    state.pieces = pieces;
    state.centers = pieces.map((p) => p.position.clone());
    state.signature = signature;
    applyPieceMaterials(state, inside);
    return empty();
  },
};
