import type { NodeDefinition } from "../types";
import { deleteFaces, extractFaces, type PolyMesh } from "../quadMesh";
import { domainEdges, setGroup } from "../mesh/polyAttributes";
import { withAttributes, type PropagationMaps } from "../mesh/propagate";
import { getTopology, buildTopology } from "../mesh/topology";
import { bevelEdges } from "../mesh/bevel";
import { edgeChains } from "../mesh/bridge";
import { dissolveEdges, dissolveFaces, dissolveVertices, flipFaces, insetRegion, mergeByDistance, subdivideFaces } from "../mesh/tools";
import { edgeKey } from "../mesh/attributes";
import { PointTree } from "../mesh/spatial";
import {
  UNKNOWN,
  bevelVertices,
  bridgeChains,
  clipMesh,
  completeMaps,
  faceIslands,
  faceNormalOf,
  fillHoles,
  mirrorMesh,
  regionBorder,
  revolveEdges,
  splitEdges,
  subsetMaps,
  triangulateFaces,
  trianglesToQuads,
  type Chain,
  type ClipKeep,
} from "../mesh/modelingKernel";
import { definePolyNode, type PolyRunContext } from "./polyModifier";

/*
 * Modeling operations (phase 5 of docs/parametric-modeling-plan.md): the
 * Edit Mesh kernel exposed as parametric nodes. Each one reads the PolyMesh,
 * works only on the elements of its Group field, carries every named
 * attribute and group through the operation (withAttributes, with exact
 * provenance wherever the operation knows it) and writes output groups where
 * Houdini / Blender would — `inset_inner`, `bevel_faces`, `cut`, `cap`… — so
 * the next node can pick up exactly what this one made.
 *
 * Everything works in the mesh's own (local) space, as SOPs do.
 */

type V3 = [number, number, number];

const CATEGORY = "modeling" as const;

// ---------------------------------------------------------------- helpers

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Face indices → a face mask, written as a group. */
function writeFaceGroup(mesh: PolyMesh, name: string, faces: Iterable<number>): PolyMesh {
  const mask = new Uint8Array(mesh.faces.length);
  for (const f of faces) if (f >= 0 && f < mask.length) mask[f] = 1;
  return setGroup(mesh, "face", name, mask);
}

/** Vertex pairs → an edge mask in domain order, written as a group. */
function writeEdgeGroup(mesh: PolyMesh, name: string, edges: Iterable<readonly [number, number]>): PolyMesh {
  const keys = new Set<string>();
  for (const [a, b] of edges) keys.add(edgeKey(a, b));
  const mask = domainEdges(mesh).map(([a, b]) => (keys.has(edgeKey(a, b)) ? 1 : 0));
  return setGroup(mesh, "edge", name, mask);
}

/** The group's edges as vertex pairs. */
function groupEdges(run: PolyRunContext, mesh: PolyMesh = run.mesh, expression?: string): [number, number][] {
  const edges = domainEdges(mesh);
  return run.group("edge", expression).indices.map((i) => [edges[i][0], edges[i][1]] as [number, number]);
}

/** True when the Group field (or another expression param) is left blank — every element. */
function groupIsAll(run: PolyRunContext, id = "group"): boolean {
  return run.str(id, "").trim() === "" || run.str(id, "").trim() === "*";
}

/** A number param, finite and within [lo, hi]. */
function num(run: PolyRunContext, id: string, fallback: number, lo = -Infinity, hi = Infinity): number {
  return clamp(run.num(id, fallback), lo, hi);
}

const axisIndex = (a: string): 0 | 1 | 2 => (a === "x" ? 0 : a === "z" ? 2 : 1);
const unitAxis = (a: number): V3 => [a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0];

/** Runs an op that reports its own maps; geometric provenance fills whatever it left UNKNOWN. */
function propagated(src: PolyMesh, op: (mesh: PolyMesh) => { mesh: PolyMesh; maps?: PropagationMaps | null }): PolyMesh {
  return withAttributes(src, (bare) => {
    const r = op(bare);
    return { mesh: r.mesh, maps: completeMaps(bare, r.mesh, r.maps?.point, r.maps?.face) };
  });
}


// ---------------------------------------------------------------- Bevel

export const BEVEL_NODE = definePolyNode({
  type: "modeling/bevel",
  label: "Bevel",
  category: CATEGORY,
  group: { domain: "edge", label: "Group (edges / points)" },
  inputs: [{ id: "width", label: "Width", type: "value" }],
  defaultParams: { affect: "edges", width: 0.1, segments: 1 },
  paramFields: [
    { id: "affect", label: "Affect", kind: "select", options: ["edges", "vertices"], group: "Bevel" },
    { id: "width", label: "Width", kind: "number", step: 0.01, group: "Bevel" },
    { id: "segments", label: "Segments (edges)", kind: "number", step: 1, group: "Bevel" },
  ],
  run: (run) => {
    const width = num(run, "width", 0.1, 0, 1e6);
    if (!(width > 0)) return run.mesh;
    let created: number[] = [];
    let mesh: PolyMesh;
    if (run.str("affect", "edges") === "vertices") {
      const points = run.group("point").indices;
      if (points.length === 0) return run.mesh;
      mesh = propagated(run.mesh, (m) => {
        const r = bevelVertices(m, points, width);
        created = r.newFaces;
        return r;
      });
    } else {
      const edges = groupEdges(run);
      if (edges.length === 0) return run.mesh;
      const segments = Math.round(num(run, "segments", 1, 1, 16));
      mesh = propagated(run.mesh, (m) => {
        const r = bevelEdges(m, edges, width, segments);
        created = r.newFaces;
        return { mesh: r.mesh };
      });
    }
    if (created.length === 0) run.note("Nothing bevelled (bevel needs edges with a face on each side)", true);
    else run.note(`${created.length} bevel faces`);
    return writeFaceGroup(mesh, "bevel_faces", created);
  },
});

// ---------------------------------------------------------------- Inset

export const INSET_NODE = definePolyNode({
  type: "modeling/inset",
  label: "Inset",
  category: CATEGORY,
  group: { domain: "face" },
  inputs: [
    { id: "thickness", label: "Thickness", type: "value" },
    { id: "depth", label: "Depth", type: "value" },
  ],
  defaultParams: { mode: "region", thickness: 0.1, depth: 0 },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["region", "individual"], group: "Inset" },
    { id: "thickness", label: "Thickness", kind: "number", step: 0.01, group: "Inset" },
    { id: "depth", label: "Depth", kind: "number", step: 0.01, group: "Inset" },
  ],
  run: (run) => {
    const faces = run.group("face").indices;
    const thickness = num(run, "thickness", 0.1, 0, 1e6);
    const depth = num(run, "depth", 0, -1e6, 1e6);
    if (faces.length === 0 || (thickness <= 0 && depth === 0)) return run.mesh;
    const before = run.mesh.faces.length;
    // insetRegion keeps every index and appends: inner faces stay where the
    // selected ones were, the side quads come after.
    const mesh = propagated(run.mesh, (m) => insetRegion(m, faces, thickness, depth, run.str("mode", "region") === "individual"));
    const side: number[] = [];
    for (let f = before; f < mesh.faces.length; f++) side.push(f);
    run.note(`${faces.length} inset, ${side.length} side faces`);
    return writeFaceGroup(writeFaceGroup(mesh, "inset_inner", faces), "inset_side", side);
  },
});

// ---------------------------------------------------------------- Bridge

export const BRIDGE_NODE = definePolyNode({
  type: "modeling/bridge",
  label: "Bridge",
  category: CATEGORY,
  group: { domain: "edge", label: "Group A" },
  defaultParams: { elements: "edges", groupB: "", segments: 1, twist: 0 },
  paramFields: [
    { id: "groupB", label: "Group B (blank: split Group A in two)", kind: "text", group: "Group" },
    { id: "elements", label: "Bridge", kind: "select", options: ["edges", "faces"], optionLabels: ["Edge loops", "Face groups (holes)"], group: "Bridge" },
    { id: "segments", label: "Segments", kind: "number", step: 1, group: "Bridge" },
    { id: "twist", label: "Twist (vertices)", kind: "number", step: 1, group: "Bridge" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    if (groupIsAll(run)) {
      run.note("Set Group A to the edges (or faces) to bridge", true);
      return mesh;
    }
    const twoSides = !groupIsAll(run, "groupB");
    let sides: Chain[] = [];
    let removeFaces: number[] | undefined;
    if (run.str("elements", "edges") === "faces") {
      const a = run.group("face").indices;
      const b = twoSides ? run.group("face", run.str("groupB", "")).indices : [];
      const regions = twoSides ? [a, b] : faceIslands(mesh, a);
      if (regions.length !== 2 || regions.some((r) => r.length === 0)) {
        run.note(twoSides ? "Group A and Group B must both hold faces" : `Group A has ${regions.length} pieces — it needs exactly 2 (or set Group B)`, true);
        return mesh;
      }
      for (const region of regions) {
        const chains = edgeChains(regionBorder(mesh, region));
        if (!chains || chains.length !== 1 || !chains[0].closed) {
          run.note("Each face group must have one simple border loop", true);
          return mesh;
        }
        sides.push(chains[0]);
      }
      removeFaces = [...regions[0], ...regions[1]];
    } else {
      const a = edgeChains(groupEdges(run));
      const b = twoSides ? edgeChains(groupEdges(run, mesh, run.str("groupB", ""))) : [];
      if (!a || !b) {
        run.note("The edges branch — select simple loops or chains", true);
        return mesh;
      }
      sides = twoSides ? [...a, ...b] : a;
      if (sides.length !== 2 || (twoSides && (a.length !== 1 || b.length !== 1))) {
        run.note(twoSides ? `Group A has ${a.length} chains and Group B ${b.length} — each needs one` : `Group A has ${a.length} chains — it needs exactly 2 (or set Group B)`, true);
        return mesh;
      }
    }
    let created: number[] = [];
    let error: string | undefined;
    const out = propagated(mesh, (m) => {
      const r = bridgeChains(m, sides[0], sides[1], {
        segments: Math.round(num(run, "segments", 1, 1, 64)),
        twist: Math.round(num(run, "twist", 0, -1e4, 1e4)),
        removeFaces,
      });
      created = r.newFaces;
      error = r.error;
      return r;
    });
    if (error) {
      run.note(`Bridge: ${error}`, true);
      return mesh;
    }
    run.note(`${created.length} bridge faces`);
    return writeFaceGroup(out, "bridge_faces", created);
  },
});

// ---------------------------------------------------------------- Revolve

export const REVOLVE_NODE = definePolyNode({
  type: "modeling/revolve",
  label: "Revolve",
  category: CATEGORY,
  group: { domain: "edge", label: "Profile edges (blank: open borders + loose edges)" },
  inputs: [
    { id: "angle", label: "Angle", type: "value" },
    { id: "center", label: "Center", type: "vector" },
    { id: "direction", label: "Axis Direction", type: "vector" },
  ],
  defaultParams: { axis: "y", direction: [0, 1, 0], center: [0, 0, 0], angle: 360, segments: 16, weldSeam: true, flip: false },
  paramFields: [
    { id: "axis", label: "Axis", kind: "select", options: ["x", "y", "z", "custom"], group: "Revolve" },
    { id: "direction", label: "Axis Direction (custom)", kind: "vector", step: 0.1, group: "Revolve" },
    { id: "center", label: "Center", kind: "vector", step: 0.1, group: "Revolve" },
    { id: "angle", label: "Angle (°)", kind: "number", step: 5, group: "Revolve" },
    { id: "segments", label: "Segments", kind: "number", step: 1, group: "Revolve" },
    { id: "weldSeam", label: "Weld seam (full turn)", kind: "boolean", group: "Revolve" },
    { id: "flip", label: "Flip normals", kind: "boolean", group: "Revolve" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    let edges: [number, number][];
    if (groupIsAll(run)) {
      // A profile is a wire or the open edge of a surface: revolving every
      // edge of a closed surface would only stack strips on top of it.
      const topo = getTopology(mesh);
      edges = topo.edges.filter((_, id) => topo.isBoundaryEdge(id)).map(([a, b]) => [a, b] as [number, number]);
      for (const [a, b] of mesh.edges ?? []) edges.push([a, b]);
      if (edges.length === 0) {
        run.note("No open border or loose edges to revolve — set the Group to the profile edges", true);
        return mesh;
      }
    } else edges = groupEdges(run);
    if (edges.length === 0) return mesh;
    const axisName = run.str("axis", "y");
    const dir = run.vec("direction", [0, 1, 0]);
    const axis: V3 = axisName === "custom" ? [dir.x, dir.y, dir.z] : unitAxis(axisIndex(axisName));
    const c = run.vec("center", [0, 0, 0]);
    let created: number[] = [];
    const out = propagated(mesh, (m) => {
      const r = revolveEdges(m, edges, {
        axis,
        center: [c.x, c.y, c.z],
        angle: num(run, "angle", 360, -360, 360),
        steps: Math.round(num(run, "segments", 16, 1, 256)),
        weldSeam: run.bool("weldSeam", true),
        flip: run.bool("flip", false),
      });
      created = r.newFaces;
      return r;
    });
    run.note(`${edges.length} profile edges → ${created.length} faces`);
    return writeFaceGroup(out, "revolve_faces", created);
  },
});

// ---------------------------------------------------------------- Mirror / Symmetrize

export const MIRROR_NODE = definePolyNode({
  type: "modeling/mirror",
  label: "Mirror",
  category: CATEGORY,
  group: { domain: "face", label: "Group (mirror mode)" },
  inputs: [{ id: "offset", label: "Plane Offset", type: "value" }],
  defaultParams: { mode: "mirror", axis: "x", offset: 0, keep: "positive", weld: true, tolerance: 0.0001, flip: true },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["mirror", "symmetrize"], optionLabels: ["Mirror (keep both)", "Symmetrize (one side → other)"], group: "Mirror" },
    { id: "axis", label: "Plane Axis", kind: "select", options: ["x", "y", "z"], group: "Mirror" },
    { id: "offset", label: "Plane Offset", kind: "number", step: 0.05, group: "Mirror" },
    { id: "keep", label: "Source Side (symmetrize)", kind: "select", options: ["positive", "negative"], group: "Mirror" },
    { id: "weld", label: "Weld seam", kind: "boolean", group: "Mirror" },
    { id: "tolerance", label: "Weld Tolerance", kind: "number", step: 0.0001, group: "Mirror" },
    { id: "flip", label: "Fix winding of copies", kind: "boolean", group: "Mirror" },
  ],
  run: (run) => {
    const axis = axisIndex(run.str("axis", "x"));
    const offset = num(run, "offset", 0, -1e6, 1e6);
    const tolerance = run.bool("weld", true) ? num(run, "tolerance", 1e-4, 0, 1e3) : -1;
    const flip = run.bool("flip", true);
    let mesh = run.mesh;
    let faces: number[];
    let includeLoose: boolean;
    if (run.str("mode", "mirror") === "symmetrize") {
      if (!groupIsAll(run)) run.note("Symmetrize works on the whole mesh — the Group is ignored", true);
      const positive = run.str("keep", "positive") !== "negative";
      const point: V3 = [0, 0, 0];
      point[axis] = offset;
      mesh = propagated(mesh, (m) => clipMesh(m, { point, normal: unitAxis(axis), keep: positive ? "above" : "below", cap: false }));
      faces = mesh.faces.map((_, f) => f);
      includeLoose = true;
    } else {
      faces = run.group("face").indices;
      includeLoose = groupIsAll(run);
      if (faces.length === 0 && !(includeLoose && mesh.edges?.length)) return mesh;
    }
    let created: number[] = [];
    const out = propagated(mesh, (m) => {
      const r = mirrorMesh(m, { axis, offset, faces, tolerance, flip, includeLoose });
      created = r.newFaces;
      return r;
    });
    run.note(`${created.length} mirrored faces`);
    return writeFaceGroup(out, "mirror_faces", created);
  },
});

// ---------------------------------------------------------------- Fuse

export const FUSE_NODE = definePolyNode({
  type: "modeling/fuse",
  label: "Fuse",
  category: CATEGORY,
  group: { domain: "point" },
  inputs: [{ id: "distance", label: "Distance", type: "value" }],
  outputs: [{ id: "removed", label: "Points Removed", type: "value" }],
  defaultParams: { distance: 0.001 },
  paramFields: [{ id: "distance", label: "Snap Distance", kind: "number", step: 0.001, group: "Fuse" }],
  run: (run) => {
    const points = run.group("point").indices;
    const distance = num(run, "distance", 0.001, 0, 1e6);
    if (points.length < 2) return { mesh: run.mesh, outputs: { removed: 0 } };
    let removed = 0;
    const mesh = propagated(run.mesh, (m) => {
      const r = mergeByDistance(m, distance, groupIsAll(run) ? undefined : points);
      removed = r.removed;
      // Each output point is the first source point merged into it.
      const point = new Int32Array(r.mesh.positions.length).fill(UNKNOWN);
      for (let v = r.remapVertex.length - 1; v >= 0; v--) if (r.remapVertex[v] >= 0) point[r.remapVertex[v]] = v;
      return { mesh: r.mesh, maps: { point } };
    });
    run.note(`${removed} points fused`);
    return { mesh, outputs: { removed } };
  },
});

// ---------------------------------------------------------------- Dissolve

/** Valence-2 vertices sitting on a straight run (within `maxAngle`) — what a limited dissolve also drops. */
function straightVertices(mesh: PolyMesh, candidates: ReadonlyArray<readonly number[]>, maxAngle: number): number[] {
  if (candidates.length === 0) return [];
  const topo = buildTopology(mesh);
  const tree = new PointTree(candidates);
  const neighbours: number[][] = Array.from({ length: mesh.positions.length }, () => []);
  for (const [a, b] of topo.edges) {
    neighbours[a].push(b);
    neighbours[b].push(a);
  }
  const loose = new Set<number>();
  for (const [a, b] of mesh.edges ?? []) loose.add(a).add(b);
  const out: number[] = [];
  const cosMax = Math.cos((maxAngle * Math.PI) / 180);
  mesh.positions.forEach((p, v) => {
    if (neighbours[v].length !== 2 || loose.has(v)) return;
    if (tree.nearest(p[0], p[1], p[2]).distSq > 1e-18) return;
    const [a, b] = neighbours[v].map((n) => mesh.positions[n]);
    const u = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const w = [b[0] - p[0], b[1] - p[1], b[2] - p[2]];
    const lu = Math.hypot(u[0], u[1], u[2]);
    const lw = Math.hypot(w[0], w[1], w[2]);
    if (lu < 1e-12 || lw < 1e-12) return;
    if ((u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (lu * lw) >= cosMax) out.push(v);
  });
  return out;
}

export const DISSOLVE_NODE = definePolyNode({
  type: "modeling/dissolve",
  label: "Dissolve",
  category: CATEGORY,
  group: { domain: "face", label: "Group (of the mode's elements)" },
  defaultParams: { mode: "faces", angle: 5, delimitMaterial: true, delimitSharp: true },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["faces", "edges", "points", "limited"], optionLabels: ["Faces", "Edges", "Points", "Limited (by angle)"], group: "Dissolve" },
    { id: "angle", label: "Max Angle (°, limited)", kind: "number", step: 1, group: "Dissolve" },
    { id: "delimitMaterial", label: "Keep material borders (limited)", kind: "boolean", group: "Dissolve" },
    { id: "delimitSharp", label: "Keep sharp edges and seams (limited)", kind: "boolean", group: "Dissolve" },
  ],
  run: (run) => {
    const mode = run.str("mode", "faces");
    const src = run.mesh;
    let created: number[] = [];
    let mesh: PolyMesh;
    if (mode === "faces") {
      const faces = run.group("face").indices;
      if (faces.length < 2) return src;
      mesh = propagated(src, (m) => {
        const r = dissolveFaces(m, faces);
        created = r.newFaces;
        return { mesh: r.mesh };
      });
    } else if (mode === "points") {
      const points = run.group("point").indices;
      if (points.length === 0) return src;
      mesh = propagated(src, (m) => {
        const r = dissolveVertices(m, points);
        created = r.newFaces;
        return { mesh: r.mesh };
      });
    } else {
      let edges = groupEdges(run);
      const angle = num(run, "angle", 5, 0, 180);
      if (mode === "limited") {
        // Flat enough, between two faces, and not a border the user marked.
        const topo = getTopology(src);
        const normals = src.faces.map((face) => faceNormalOf(src.positions, face));
        const sharp = new Set([...(src.sharpEdges ?? []), ...(src.seamEdges ?? [])].map(([a, b]) => edgeKey(a, b)));
        const cosMax = Math.cos((angle * Math.PI) / 180);
        edges = edges.filter(([a, b]) => {
          const faces = topo.edgeFaces(a, b);
          if (faces.length !== 2) return false;
          if (run.bool("delimitSharp", true) && sharp.has(edgeKey(a, b))) return false;
          if (run.bool("delimitMaterial", true) && (src.faceMaterials?.[faces[0]] ?? 0) !== (src.faceMaterials?.[faces[1]] ?? 0)) return false;
          const [n0, n1] = faces.map((f) => normals[f]);
          return n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] >= cosMax - 1e-12;
        });
      }
      if (edges.length === 0) return src;
      mesh = propagated(src, (m) => {
        const r = dissolveEdges(m, edges);
        created = r.newFaces;
        return { mesh: r.mesh };
      });
      if (mode === "limited") {
        // Then the points left in the middle of straight runs along the
        // dissolved region's border — the corners of a merged grid stay.
        mesh = writeFaceGroup(mesh, "dissolve_faces", created);
        const ends: number[][] = [];
        for (const [a, b] of edges) ends.push(src.positions[a], src.positions[b]);
        const straight = straightVertices(mesh, ends, angle);
        if (straight.length) mesh = propagated(mesh, (m) => ({ mesh: dissolveVertices(m, straight).mesh }));
        run.note(`${src.faces.length - mesh.faces.length} faces and ${src.positions.length - mesh.positions.length} points dissolved`);
        return mesh;
      }
    }
    run.note(`${src.faces.length - mesh.faces.length} faces fewer`);
    return writeFaceGroup(mesh, "dissolve_faces", created);
  },
});

// ---------------------------------------------------------------- Fill Holes

export const FILL_HOLES_NODE = definePolyNode({
  type: "modeling/fill-holes",
  label: "Fill Holes",
  category: CATEGORY,
  group: { domain: "edge", label: "Group (border edges)" },
  defaultParams: { maxSides: 0 },
  paramFields: [{ id: "maxSides", label: "Max Sides (0 = any)", kind: "number", step: 1, group: "Fill" }],
  run: (run) => {
    const { mask } = run.group("edge");
    const topo = getTopology(run.mesh);
    const maxSides = Math.round(num(run, "maxSides", 0, 0, 1e6));
    let created: number[] = [];
    const out = propagated(run.mesh, (m) => {
      const r = fillHoles(
        m,
        (a, b) => {
          const id = topo.findEdge(a, b);
          return id >= 0 && mask[id] === 1;
        },
        maxSides,
      );
      created = r.newFaces;
      return r;
    });
    run.note(`${created.length} holes filled`);
    return writeFaceGroup(out, "fill_faces", created);
  },
});

// ---------------------------------------------------------------- Clip

export const CLIP_NODE = definePolyNode({
  type: "modeling/clip",
  label: "Clip",
  category: CATEGORY,
  group: { domain: "face", label: "Group (faces cut)" },
  inputs: [
    { id: "point", label: "Plane Point", type: "vector" },
    { id: "normal", label: "Plane Normal", type: "vector" },
  ],
  defaultParams: { point: [0, 0, 0], normal: [0, 1, 0], keep: "above", cap: true },
  paramFields: [
    { id: "point", label: "Plane Point", kind: "vector", step: 0.05, group: "Clip" },
    { id: "normal", label: "Plane Normal", kind: "vector", step: 0.1, group: "Clip" },
    { id: "keep", label: "Keep", kind: "select", options: ["above", "below", "both"], optionLabels: ["Above (normal side)", "Below", "Both (split)"], group: "Clip" },
    { id: "cap", label: "Cap the cut", kind: "boolean", group: "Clip" },
  ],
  run: (run) => {
    const p = run.vec("point", [0, 0, 0]);
    const nrm = run.vec("normal", [0, 1, 0]);
    if (!(nrm.lengthSq() > 1e-18) || ![p.x, p.y, p.z, nrm.x, nrm.y, nrm.z].every(Number.isFinite)) {
      run.note("The plane normal is zero", true);
      return run.mesh;
    }
    const keepRaw = run.str("keep", "above");
    const keep: ClipKeep = keepRaw === "below" || keepRaw === "both" ? keepRaw : "above";
    const scope = groupIsAll(run) ? null : new Set(run.group("face").indices);
    let result: ReturnType<typeof clipMesh> | null = null;
    let mesh = propagated(run.mesh, (m) => {
      result = clipMesh(m, { point: [p.x, p.y, p.z], normal: [nrm.x, nrm.y, nrm.z], keep, cap: run.bool("cap", true), faces: scope });
      return result;
    });
    const r = result as ReturnType<typeof clipMesh> | null;
    if (!r) return mesh;
    mesh = writeFaceGroup(writeEdgeGroup(mesh, "cut", r.cutEdges), "cap", r.capFaces);
    if (keep === "both") mesh = writeFaceGroup(writeFaceGroup(mesh, "clip_above", r.above), "clip_below", r.below);
    run.note(`${r.cutEdges.length} cut edges, ${r.capFaces.length} caps`);
    return mesh;
  },
});

// ---------------------------------------------------------------- Triangulate / Quadrangulate

export const TRIANGULATE_NODE = definePolyNode({
  type: "modeling/triangulate",
  label: "Triangulate",
  category: CATEGORY,
  group: { domain: "face" },
  run: (run) => {
    const faces = run.group("face").indices;
    if (faces.length === 0) return run.mesh;
    const before = run.mesh.faces.length;
    const mesh = propagated(run.mesh, (m) => triangulateFaces(m, faces));
    run.note(`${mesh.faces.length - before} triangles added`);
    return mesh;
  },
});

export const QUADRANGULATE_NODE = definePolyNode({
  type: "modeling/quadrangulate",
  label: "Quadrangulate",
  category: CATEGORY,
  group: { domain: "face" },
  outputs: [{ id: "merged", label: "Quads Made", type: "value" }],
  defaultParams: { maxAngle: 40, maxShapeError: 40, respectSharp: true, respectSeams: true, respectMaterials: true, respectUVs: true },
  paramFields: [
    { id: "maxAngle", label: "Max Face Angle (°)", kind: "number", step: 1, group: "Quadrangulate" },
    { id: "maxShapeError", label: "Max Shape Error (°)", kind: "number", step: 1, group: "Quadrangulate" },
    { id: "respectSharp", label: "Keep sharp edges", kind: "boolean", group: "Quadrangulate" },
    { id: "respectSeams", label: "Keep seams", kind: "boolean", group: "Quadrangulate" },
    { id: "respectMaterials", label: "Keep material borders", kind: "boolean", group: "Quadrangulate" },
    { id: "respectUVs", label: "Keep UV cuts", kind: "boolean", group: "Quadrangulate" },
  ],
  run: (run) => {
    const faces = run.group("face").indices;
    let merged = 0;
    const mesh = propagated(run.mesh, (m) => {
      const r = trianglesToQuads(m, faces, {
        maxAngle: num(run, "maxAngle", 40, 0, 180),
        maxShapeError: num(run, "maxShapeError", 40, 0, 180),
        respectSharp: run.bool("respectSharp", true),
        respectSeams: run.bool("respectSeams", true),
        respectMaterials: run.bool("respectMaterials", true),
        respectUVs: run.bool("respectUVs", true),
      });
      merged = r.merged;
      return r;
    });
    run.note(`${merged} quads made`);
    return { mesh, outputs: { merged } };
  },
});

// ---------------------------------------------------------------- Split Edges / Extract

export const SPLIT_EDGES_NODE = definePolyNode({
  type: "modeling/split-edges",
  label: "Split Edges",
  category: CATEGORY,
  group: { domain: "edge" },
  run: (run) => {
    const edges = groupEdges(run);
    if (edges.length === 0) return run.mesh;
    const before = run.mesh.positions.length;
    const mesh = propagated(run.mesh, (m) => splitEdges(m, edges));
    run.note(`${mesh.positions.length - before} points added`);
    return mesh;
  },
});

export const EXTRACT_NODE = definePolyNode({
  type: "modeling/extract",
  label: "Extract",
  category: CATEGORY,
  group: { domain: "face" },
  defaultParams: { mode: "keep" },
  paramFields: [{ id: "mode", label: "Mode", kind: "select", options: ["keep", "delete"], optionLabels: ["Keep group (extract)", "Delete group"], group: "Extract" }],
  run: (run) => {
    const faces = run.group("face").indices;
    const src = run.mesh;
    if (run.str("mode", "keep") === "delete") {
      if (faces.length === 0) return src;
      const gone = new Set(faces);
      const kept = src.faces.map((_, f) => f).filter((f) => !gone.has(f));
      return propagated(src, (m) => {
        const out = deleteFaces(m, faces);
        // deleteFaces keeps the loose edges, so their points too.
        return { mesh: out, maps: subsetMaps(m, out, kept, m.edges ?? []) };
      });
    }
    return propagated(src, (m) => {
      const out = extractFaces(m, faces);
      return { mesh: out, maps: subsetMaps(m, out, faces, []) };
    });
  },
});

// ---------------------------------------------------------------- Subdivide Faces

export const SUBDIVIDE_FACES_NODE = definePolyNode({
  type: "modeling/subdivide-faces",
  label: "Subdivide Faces",
  category: CATEGORY,
  group: { domain: "face" },
  defaultParams: { iterations: 1 },
  paramFields: [{ id: "iterations", label: "Iterations", kind: "number", step: 1, group: "Subdivide" }],
  run: (run) => {
    let selected = run.group("face").indices;
    if (selected.length === 0) return run.mesh;
    const iterations = Math.round(num(run, "iterations", 1, 1, 4));
    let mesh = run.mesh;
    for (let it = 0; it < iterations && selected.length; it++) {
      const faces = selected;
      let created: number[] = [];
      mesh = propagated(mesh, (m) => {
        const r = subdivideFaces(m, faces);
        created = r.newFaces;
        // subdivideFaces keeps each face as its first quad and appends the
        // others, face by face in ascending order.
        const face: number[] = m.faces.map((_, f) => f);
        for (const f of [...new Set(faces)].sort((a, b) => a - b)) for (let k = 1; k < m.faces[f].length; k++) face.push(f);
        return { mesh: r.mesh, maps: { face: Int32Array.from(face) } };
      });
      selected = created;
    }
    run.note(`${mesh.faces.length - run.mesh.faces.length} faces added`);
    return writeFaceGroup(mesh, "subdivide_faces", selected);
  },
});

// ---------------------------------------------------------------- Flip Faces

export const FLIP_FACES_NODE = definePolyNode({
  type: "modeling/flip-faces",
  label: "Flip Faces",
  category: CATEGORY,
  group: { domain: "face" },
  run: (run) => {
    const faces = run.group("face").indices;
    if (faces.length === 0) return run.mesh;
    return propagated(run.mesh, (m) => {
      const out = flipFaces(m, faces);
      // flipFaces reverses corners and UVs but not the corner colours.
      if (out.faceColors) {
        for (const f of new Set(faces)) {
          const c = out.faceColors[f];
          if (c) out.faceColors[f] = [...c].reverse();
        }
      }
      return { mesh: out, maps: { point: m.positions.map((_, i) => i), face: m.faces.map((_, i) => i) } };
    });
  },
});

export const MODELING_OPS_NODES: NodeDefinition[] = [
  BEVEL_NODE,
  INSET_NODE,
  BRIDGE_NODE,
  REVOLVE_NODE,
  MIRROR_NODE,
  FUSE_NODE,
  DISSOLVE_NODE,
  FILL_HOLES_NODE,
  CLIP_NODE,
  TRIANGULATE_NODE,
  QUADRANGULATE_NODE,
  SPLIT_EDGES_NODE,
  EXTRACT_NODE,
  SUBDIVIDE_FACES_NODE,
  FLIP_FACES_NODE,
];
