import type { NodeDefinition } from "../types";

/*
 * Search synonyms per node type: what someone coming from Blender Geometry
 * Nodes or Houdini would type, and the names a node had before it was
 * renamed. Matched by the palette filter and the node search (Tab), never
 * shown as labels.
 */
export const NODE_KEYWORDS: Record<string, readonly string[]> = {
  // Geometry
  "attribute/expression": ["wrangle", "vex", "attribute wrangle", "point wrangle", "formula"],
  "attribute/create": ["store named attribute", "add attribute"],
  "attribute/transfer": ["attribute transfer", "sample nearest", "copy attributes"],
  "attribute/promote": ["domain", "capture attribute"],
  "attribute/spreadsheet": ["spreadsheet", "inspect", "debug", "geometry spreadsheet"],
  "attribute/visualize": ["heatmap", "color by attribute", "debug"],
  "modeling/geodesic-distance": ["shortest path", "distance along surface", "heat method"],
  "select/basic": ["group create", "select", "bounding", "random selection"],
  "select/manual": ["pick", "click selection", "paint selection"],
  "group/combine": ["group combine", "boolean group", "union", "intersect"],
  "group/expand": ["grow", "shrink", "group expand"],
  "group/path": ["shortest path", "edge path"],
  "modifier/extrude": ["poly extrude", "extrude faces"],
  "modeling/inset": ["poly extrude inset", "inset faces"],
  "modeling/bevel": ["polybevel", "chamfer", "round edges"],
  "modeling/mirror": ["symmetrize", "symmetry"],
  "modeling/fuse": ["merge by distance", "weld", "consolidate"],
  "modeling/extract": ["blast", "separate", "split"],
  "modeling/keep-group": ["blast", "delete", "isolate"],
  "modifier/delete-geometry": ["blast", "delete", "remove"],
  "modeling/divide": ["tessellate", "subdivide grid"],
  "modeling/decimate": ["polyreduce", "reduce", "simplify"],
  "modeling/join": ["merge", "join geometry", "combine meshes"],
  "modeling/dual-mesh": ["dual", "voronoi", "hexagons"],
  "modeling/fill-holes": ["polycap", "cap", "close holes"],
  "modeling/clip": ["cut", "bisect", "slice"],
  "modifier/boolean": ["csg", "difference", "union", "intersect"],
  "modifier/weld": ["merge by distance", "fuse"],
  "modifier/subdivide": ["catmull-clark", "smooth subdivision", "subsurf"],
  "modifier/solidify": ["thickness", "polyextrude thickness", "shell"],
  "modeling/smooth": ["relax", "laplacian"],
  "modeling/displace": ["offset", "noise displace"],
  "modeling/ray-project": ["shrinkwrap", "ray", "project", "snap to surface"],
  "modeling/transform-elements": ["move faces", "transform group"],
  "modifier/lattice": ["ffd", "cage deform"],
  "geometry/twist-bend-taper": ["simple deform", "bend", "twist", "taper"],
  "volume/mesh-to-sdf": ["vdb from polygons", "volume", "signed distance"],
  "volume/points-to-sdf": ["vdb from particles", "points to volume"],
  "volume/combine": ["vdb combine", "smooth union", "csg"],
  "volume/sdf-to-mesh": ["convert vdb", "volume to mesh", "marching cubes"],
  "volume/voxel-remesh": ["remesh", "vdb remesh"],
  "modeling/copy-to-points": ["instance", "copy", "instance on points"],
  "structure/instance-on-points": ["copy to points", "instance"],
  "modeling/group-to-points": ["points from group", "scatter"],
  "physics/sample": ["scatter", "distribute points on faces"],
  "physics/volume_scatter": ["scatter", "distribute points in volume"],
  "list/poisson-disk-2d": ["scatter", "blue noise"],
  "modeling/l-system": ["lsystem", "plant", "branching"],
  "modeling/heightfield-erode": ["erosion", "heightfield", "terrain"],
  "curve/sweep": ["curve to mesh", "tube", "pipe", "sweep"],
  "curve/resample": ["resample", "subdivide curve"],
  "curve/fillet": ["round corners", "fillet"],
  "object/text": ["text", "3d text", "string to curves"],
  // Scene & appearance
  "structure/group": ["subnet", "node group", "loop", "for each", "repeat zone"],
  "structure/loop-info": ["for each", "iteration", "repeat zone"],
  "utility/frame": ["frame", "comment", "note", "backdrop"],
  "calibration/camera": ["camera", "view"],
  "modeling/material-by-group": ["set material", "assign material"],
  "physics/spawner": ["spawner", "emit rigid bodies"],
  "texture/map-range": ["map range"],
  "texture/bloom": ["bloom", "glow"],
  "texture/film-grain": ["film grain", "noise"],
  "texture/transform": ["transform", "uv transform"],
  "texture/blur": ["blur"],
  "texture/threshold": ["threshold"],
  "texture/invert": ["invert"],
  // Data
  "math/expression": ["formula", "math expression"],
  "value/map-range": ["fit", "remap"],
};


/** Names nodes had before they were renamed for clarity — still found by search. */
const FORMER_LABELS: Record<string, readonly string[]> = {
  "list/poisson-disk-2d": ["Poisson Disk 2D"],
  "list/scatter-around": ["Scatter Around"],
  "list/noise-peaks": ["Noise Peaks"],
  "list/points-from-geometry": ["Vertices to Points"],
  "converter/mesh-to-points": ["Mesh to Points"],
  "converter/points-to-mesh": ["Points to Mesh"],
  "physics/sample": ["Surface Scatter"],
  "physics/volume_scatter": ["Volume Scatter"],
  "structure/instance-positions": ["Instance Positions"],
  "structure/spawn": ["Spawner"],
  "texture/pixel-spawner": ["Texture Pixel Spawner"],
  "modeling/ray-project": ["Ray / Project / Shrinkwrap"],
  "modeling/heightfield-erode": ["HeightField Erode"],
  "modeling/geodesic-distance": ["Geodesic Distance"],
  "modeling/divide": ["Divide / Tessellate"],
  "modeling/fuse": ["Fuse"],
  "modeling/edge-mark": ["Edge Crease / Mark"],
  "attribute/measure": ["Measure"],
  "curve/to_mesh": ["Curve to Mesh"],
  "curve/to_mesh_list": ["Curves to Meshes"],
  "curve/sweep": ["Sweep (Curve to Mesh)"],
  "modifier/face-selection": ["Face Selection"],
  "list/points-selection": ["Points Selection"],
  "list/points-influence": ["Points Influence"],
  "object/text": ["Text"],
  "physics/spawner": ["Spawner"],
  "utility/frame": ["Frame"],
};

/** More words people search with, for the renamed and the point/curve nodes. */
const MORE_KEYWORDS: Record<string, readonly string[]> = {
  "list/poisson-disk-2d": ["scatter", "poisson", "distribute", "blue noise", "points"],
  "physics/sample": ["scatter", "distribute points on faces", "points on surface"],
  "physics/volume_scatter": ["scatter", "distribute points in volume"],
  "list/scatter-around": ["scatter", "cluster", "points"],
  "list/noise-peaks": ["scatter", "points", "noise"],
  "curve/scatter": ["scatter", "points on curve"],
  "modeling/fuse": ["weld", "consolidate", "remove doubles"],
  "curve/to_mesh": ["curve to mesh", "tube", "pipe"],
  "curve/sweep": ["curve to mesh", "profile", "loft", "extrude along curve"],
  "object/line": ["line", "segment", "polyline", "profile", "edge"],
  "modeling/divide": ["tessellate", "grid", "subdivide"],
  "modeling/geodesic-distance": ["geodesic", "distance along surface", "heat"],
  "modeling/heightfield-erode": ["erosion", "heightfield", "hydraulic"],
};

/** Words that apply to every node a merged effect covers (screen or object). */
const EFFECT_KEYWORDS = ["stylize", "object", "material"];

/** Adds the node's synonyms in place (as addPoseSockets does), so the registered definition stays the exported one. */
export function withKeywords(def: NodeDefinition): NodeDefinition {
  const extra = [
    ...(NODE_KEYWORDS[def.type] ?? []),
    ...(FORMER_LABELS[def.type] ?? []),
    ...(MORE_KEYWORDS[def.type] ?? []),
    ...("applyTo" in def.defaultParams ? EFFECT_KEYWORDS : []),
  ];
  if (extra.length > 0) def.keywords = [...new Set([...(def.keywords ?? []), ...extra])];
  return def;
}

/**
 * How well a node answers a query, for ordering results (higher first): the
 * exact name, then a name starting with it, a word of the name starting with
 * it, a former name or synonym, and last anything else that matched.
 */
export function nodeMatchScore(def: NodeDefinition, query: string): number {
  const q = query.trim().toLowerCase();
  const label = def.label.toLowerCase();
  if (!q) return 0;
  if (label === q) return 100;
  if (label.startsWith(q)) return 80 - Math.min(20, label.length - q.length);
  if (label.split(/[\s/()&-]+/).some((w) => w.startsWith(q))) return 60;
  if ((def.keywords ?? []).some((k) => k.toLowerCase() === q)) return 50;
  if (label.includes(q)) return 40;
  if ((def.keywords ?? []).some((k) => k.toLowerCase().includes(q))) return 30;
  return 10;
}

/** Does a node match a palette/search query (label, type id, category label or keywords)? */
export function nodeMatches(def: NodeDefinition, query: string, categoryLabel: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [def.label, def.type, categoryLabel, ...(def.keywords ?? [])].join("\n").toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}
