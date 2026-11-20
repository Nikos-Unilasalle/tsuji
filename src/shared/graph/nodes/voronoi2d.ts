import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { distanceToPolyline, insetPolygon, P2, polygonArea, simplePolygon } from "../voronoi2d";
import { bounds, chainEdges, directionField, tessellate } from "../voronoi2dLayout";
import { fieldTessellate, splitRing } from "../voronoi2dField";
import { composeNativeMatrix } from "./transform";
import {
  applyMaterialParams,
  buildPrimitiveDynamicParamFields,
  COMMON_DEFAULT_PARAMS,
  COMMON_PRIMITIVE_INPUTS,
  COMMON_PRIMITIVE_OUTPUTS,
  extractMaterialParams,
  extractTextureParams,
  numberInput,
  primitiveOutputs,
} from "./object";
import {
  asPlane,
  asVec,
  clipPolylineToOutline,
  GUIDES_INPUT,
  hashNumbers,
  makeStretch,
  Plane,
  PLANE_FIELD,
  readPolylines,
  sampleOutline,
  STRETCH_FIELDS,
  to2,
  to3,
  vectorNumbers,
} from "./voronoi2dShared";

interface VoronoiState {
  mesh?: THREE.Mesh;
  signature?: string;
  outputs?: Record<string, unknown>;
}

const voronoiCache = createNodeCache<VoronoiState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

const EXTRA_FIELDS: ParamFieldDef[] = [
  { ...PLANE_FIELD, group: "Voronoi" },
  { id: "relax", label: "Relax (Lloyd iterations)", kind: "number", step: 1, group: "Voronoi" },
  { id: "inset", label: "Cell Inset (gap for veins)", kind: "number", step: 0.005, group: "Voronoi" },
  { id: "wallSpacing", label: "Wall Cell Spacing (0 = from seeds)", kind: "number", step: 0.01, group: "Voronoi" },
  { id: "wallRows", label: "Wall Rows (1 = pair only; more = grid beside walls)", kind: "number", step: 1, group: "Voronoi" },
  ...STRETCH_FIELDS.map((f) => ({ ...f, group: "Voronoi" })),
  { id: "chainAngle", label: "Chains: Max Turn (°)", kind: "number", step: 5, group: "Chains" },
  { id: "minChainLength", label: "Chains: Min Length", kind: "number", step: 0.05, group: "Chains" },
  { id: "chainClearance", label: "Chains: Min Mean Distance to Walls", kind: "number", step: 0.01, group: "Chains" },
  { id: "fieldResolution", label: "Follow Guides: Grid Resolution", kind: "number", step: 50, group: "Voronoi" },
  { id: "boundarySamples", label: "Boundary Samples", kind: "number", step: 16, group: "Voronoi" },
  { id: "wallSamples", label: "Samples per Wall Curve", kind: "number", step: 16, group: "Voronoi" },
];

/** Edge chains, minus those running on average closer than `clearance` to a wall (a wall's own shadow line). */
function chainsAwayFromWalls(edges: P2[][], walls: P2[][], outline: P2[], angleDeg: number, minLength: number, clearance: number, snap: number): P2[][] {
  const box = bounds(outline);
  const segments = edges.flatMap((l) => l.slice(1).map((b, i): [P2, P2] => [l[i], b]));
  const lengths = segments.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])).sort((x, y) => x - y);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const chains = chainEdges(segments, (angleDeg * Math.PI) / 180, minLength, Math.max(1e-9, (box.x1 - box.x0) * 1e-6, snap * median));
  if (clearance <= 0 || walls.length === 0) return chains;
  return chains.filter((c) => {
    let sum = 0;
    for (const p of c) sum += Math.min(...walls.map((w) => distanceToPolyline(p, w)));
    return sum / c.length >= clearance;
  });
}

/** Earcut triangulation of each cell, flat in the plane at height 0, UVs across the outline's bounds. */
function buildMembrane(cells: P2[][], plane: Plane, box: { x0: number; y0: number; x1: number; y1: number }): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const w = Math.max(1e-9, box.x1 - box.x0);
  const h = Math.max(1e-9, box.y1 - box.y0);
  for (const poly of cells) {
    const ring = polygonArea(poly) < 0 ? [...poly].reverse() : poly;
    const tris = THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p[0], p[1])), []);
    const base = positions.length / 3;
    for (const p of ring) {
      const v = to3(p, 0, plane);
      positions.push(v.x, v.y, v.z);
      uvs.push((p[0] - box.x0) / w, (p[1] - box.y0) / h);
    }
    for (const [a, b, c] of tris) indices.push(base + a, base + b, base + c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Voronoi 2D — the plane cut into the cells of a set of seed points, clipped
 * to any closed outline (concave too), the way a dragonfly wing, a giraffe's
 * coat, a cracked mud flat or a lattice panel is cut.
 *
 * Walls are curves the cells must line up against: a wall becomes a row of
 * cell edges with cells set square to it on both sides — how the cross-veins
 * of an insect wing meet its main veins (Hoffmann et al. 2018, PNAS: primary
 * veins first, then a Voronoi tessellation of evenly spaced centres between
 * them). Relax runs Lloyd's algorithm on the free seeds (not the wall rows),
 * evening the cells out while keeping a density gradient's overall drift.
 *
 * Out: the cells as a flat membrane mesh (inset leaves a gap per cell, e.g.
 * for a laser-cut panel), and as point lists for tubes or other nodes — the
 * cross edges once each (2 points apiece, Profiled Tubes ready), the walls
 * cut to the outline (their own heights kept, for Height from Lines), the
 * closed outline, the relaxed seeds and every cell's area.
 *
 * Wall Rows lays further rows of fixed seeds beside every wall: where two
 * walls run close and parallel the rows fill the strip — a ladder of straight
 * cross-veins for one row, a brick grid for more — and only wide fields keep
 * irregular cells in their middle, as on a real wing. Stretch elongates every
 * cell along a direction; on a sparse set of seeds its Edge Chains (edges
 * joined where they carry on nearly straight) make long zigzag lanes.
 *
 * Stretch Follows Guides turns the stretch with the Direction Guides (or the
 * walls): cells are then computed on a fine grid (Grid Resolution) so they
 * still tile the outline exactly, and walls become hard borders no cell
 * crosses — a loose, stretched diagram fanning out like a wing's main veins.
 * Wall Rows does not apply in that mode.
 *
 * Regions (closed point lists, e.g. another Voronoi 2D's Cells) replaces the
 * boundary: each region is tessellated on its own with its border as walls,
 * so cells never straddle a border — the cross-veins of each panel between
 * a wing's thick veins.
 */
export const VORONOI_2D_NODE: NodeDefinition = {
  type: "curve/voronoi-2d",
  label: "Voronoi 2D",
  category: "curve",
  inputs: [
    { id: "points", label: "Seed Points", type: "list" },
    { id: "boundary", label: "Boundary (closed curve)", type: "curve" },
    { id: "walls", label: "Walls (curves / point lists)", type: "list" },
    { id: "regions", label: "Regions (closed point lists; replace Boundary)", type: "list" },
    { id: "relax", label: "Relax", type: "value" },
    { id: "inset", label: "Cell Inset", type: "value" },
    GUIDES_INPUT,
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [
    ...COMMON_PRIMITIVE_OUTPUTS,
    { id: "cells", label: "Cells (point lists)", type: "list" },
    { id: "edges", label: "Cross Edges (point lists)", type: "list" },
    { id: "chains", label: "Edge Chains (point lists)", type: "list" },
    { id: "walls", label: "Walls in Outline (point lists)", type: "list" },
    { id: "outline", label: "Outline (point list)", type: "list" },
    { id: "sites", label: "Sites", type: "list" },
    { id: "areas", label: "Cell Areas", type: "list" },
    { id: "count", label: "Cell Count", type: "value" },
  ],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    plane: "XY",
    relax: 2,
    inset: 0,
    wallSpacing: 0,
    wallRows: 1,
    stretch: 1,
    stretchAngle: 0,
    stretchFollow: false,
    chainAngle: 35,
    minChainLength: 0,
    chainClearance: 0,
    fieldResolution: 400,
    boundarySamples: 160,
    wallSamples: 64,
    roughness: 0.4,
  },
  paramFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS),
  evaluate: (inputs, params, ctx) => {
    let state = voronoiCache.get(ctx.nodeId);
    if (!state) voronoiCache.set(ctx.nodeId, (state = {}));
    if (!state.mesh) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state.mesh = mesh;
    }
    const mesh = state.mesh;

    const plane = asPlane(params.plane);
    const relax = Math.max(0, Math.min(50, Math.round(numberInput(inputs.relax, params.relax, 2))));
    const inset = Math.max(0, numberInput(inputs.inset, params.inset, 0));
    const wallSpacing = Math.max(0, numberInput(undefined, params.wallSpacing, 0));
    const boundarySamples = Math.max(8, Math.min(4096, Math.round(numberInput(undefined, params.boundarySamples, 160))));
    const wallSamples = Math.max(2, Math.min(2048, Math.round(numberInput(undefined, params.wallSamples, 64))));
    const wallRows = Math.max(1, Math.min(12, Math.round(numberInput(undefined, params.wallRows, 1))));
    const stretchK = Math.max(0.05, Math.min(20, numberInput(undefined, params.stretch, 1)));
    const stretchAngle = numberInput(undefined, params.stretchAngle, 0);
    const stretchFollow = Boolean(params.stretchFollow);
    const guides3 = readPolylines(inputs.guides, wallSamples);
    const chainAngle = Math.max(0, Math.min(90, numberInput(undefined, params.chainAngle, 35)));
    const minChainLength = Math.max(0, numberInput(undefined, params.minChainLength, 0));
    const chainClearance = Math.max(0, numberInput(undefined, params.chainClearance, 0));
    const fieldResolution = Math.max(32, Math.min(2000, Math.round(numberInput(undefined, params.fieldResolution, 400))));
    const regions3 = readPolylines(inputs.regions, boundarySamples).filter((r) => r.length >= 3);

    const outline3 = sampleOutline(inputs.boundary, boundarySamples);
    const seeds3 = Array.isArray(inputs.points) ? inputs.points.map(asVec).filter((p): p is THREE.Vector3 => p !== null) : [];
    const walls3 = readPolylines(inputs.walls, wallSamples);

    const signature = [
      plane,
      relax,
      inset,
      wallSpacing,
      wallRows,
      stretchK,
      stretchAngle,
      chainAngle,
      minChainLength,
      chainClearance,
      stretchFollow,
      fieldResolution,
      hashNumbers(vectorNumbers(regions3)),
      hashNumbers(vectorNumbers(guides3)),
      hashNumbers(vectorNumbers([outline3])),
      hashNumbers(vectorNumbers([seeds3])),
      hashNumbers(vectorNumbers(walls3)),
    ].join("|");

    if (signature !== state.signature || !state.outputs) {
      state.signature = signature;
      const outline = outline3.map((p) => to2(p, plane));
      const wallsIn = outline.length >= 3 ? walls3.flatMap((w) => clipPolylineToOutline(w, outline, plane)) : [];
      const walls2 = wallsIn.map((w) => w.map((p) => to2(p, plane)));
      const seeds2 = seeds3.map((p) => to2(p, plane));
      // Tessellated in a squeezed copy of the plane, then mapped back: the cells come out stretched.
      const st = makeStretch(stretchFollow ? 1 : stretchK, stretchAngle);
      type Result = { sites: P2[]; cells: { site: number; verts: P2[] }[]; crossEdges: P2[][] };
      let t: Result = { sites: [], cells: [], crossEdges: [] };
      if (regions3.length > 0) {
        // One tessellation per region, its border as walls (split where it turns, so
        // facing sides of a narrow region are separate walls): cells never cross a border.
        for (const r3 of regions3) {
          let ring = r3.map((p) => to2(p, plane));
          const [f, l] = [ring[0], ring[ring.length - 1]];
          if ((f[0] - l[0]) ** 2 + (f[1] - l[1]) ** 2 < 1e-18) ring = ring.slice(0, -1);
          if (ring.length < 3 || Math.abs(polygonArea(ring)) < 1e-12) continue;
          const part = tessellate({ outline: ring, seeds: seeds2, walls: [...splitRing(ring), ...walls2], wallSpacing, relax, wallRows });
          const base = t.sites.length;
          t.sites.push(...part.sites);
          for (const c of part.cells) t.cells.push({ site: c.site + base, verts: c.verts });
          t.crossEdges.push(...part.crossEdges);
        }
      } else if (outline.length >= 3 && stretchFollow) {
        // Following guides, the stretch turns with them: cells from a fine grid, gap-free (see ../voronoi2dField).
        const field = directionField((guides3.length > 0 ? guides3.map((g) => g.map((p) => to2(p, plane))) : walls2));
        t = fieldTessellate({ outline, seeds: seeds2, walls: walls2, relax, k: stretchK, angleAt: field, resolution: fieldResolution });
      } else if (outline.length >= 3) {
        const part = tessellate({
          outline: outline.map(st.fwd),
          seeds: seeds2.map(st.fwd),
          walls: walls2.map((w) => w.map(st.fwd)),
          wallSpacing,
          relax,
          wallRows,
        });
        t = {
          sites: part.sites.map(st.inv),
          cells: part.cells.map((c) => ({ site: c.site, verts: c.verts.map(st.inv) })),
          crossEdges: part.crossEdges.map((e) => e.map(st.inv)),
        };
      }
      const regionRings = regions3.map((r) => r.map((p) => to2(p, plane)));
      const cellPolys: P2[][] = [];
      const areas: number[] = [];
      const sites: THREE.Vector3[] = [];
      for (const cell of t.cells) {
        const verts = cell.verts.length >= 3 ? simplePolygon(cell.verts) : null;
        if (!verts) continue;
        const shrunk = insetPolygon(verts, inset);
        areas.push(Math.abs(polygonArea(verts)));
        sites.push(to3(t.sites[cell.site], 0, plane));
        if (shrunk) cellPolys.push(shrunk);
      }
      mesh.geometry.dispose();
      const extent = regionRings.length > 0 ? regionRings.flat() : outline;
      mesh.geometry = buildMembrane(cellPolys, plane, extent.length >= 3 ? bounds(extent) : { x0: 0, y0: 0, x1: 1, y1: 1 });
      const lift = (poly: P2[]) => poly.map((p) => to3(p, 0, plane));
      state.outputs = {
        cells: cellPolys.map((c) => [...lift(c), to3(c[0], 0, plane)]),
        edges: t.crossEdges.map((e) => lift(e)),
        chains: extent.length >= 3 ? chainsAwayFromWalls(t.crossEdges, walls2, extent, chainAngle, minChainLength, chainClearance, 0).map(lift) : [],
        walls: wallsIn,
        outline:
          regions3.length > 0
            ? regions3.map((r) => [...r, r[0].clone()])
            : outline3.length >= 3
              ? [[...outline3, outline3[0].clone()]]
              : [],
        sites,
        areas,
        count: cellPolys.length,
      };
    }

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }
    applyMaterialParams(mesh, extractMaterialParams(inputs, params), THREE.DoubleSide, extractTextureParams(inputs, params, ctx.nodeId));
    return { ...state.outputs, ...primitiveOutputs(mesh, params) };
  },
};
