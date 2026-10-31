import * as THREE from "three";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import type { NodeDefinition, ParamFieldDef } from "../types";
import { clearMeshWarning, findFirstMesh, warnMeshRequired } from "../meshRequired";
import { createModifierMesh, emitModifiedMesh, numberInput, primitiveOutputs } from "./object";
import type { QuadMesh } from "../quadMesh";
import { smartUnwrap } from "../mesh/unwrap";
import { unwrapFaces } from "../mesh/lscm";
import { cubeProject, cylinderProject, sphereProject, type ProjectionAxis } from "../mesh/project";
import { faceUVIslands, packFaceIslands } from "../mesh/pack";

/*
 * UV Unwrap — new UVs for whatever arrives, with the same unwrapping Edit
 * Mesh uses: a Boolean's or a Solidify's output, an import with none, a
 * merge of parts whose layouts overlap. What the output needs to take a
 * texture, a decal, or a Worn bake.
 *
 * The surface is read as triangles welded by position (a split normal or an
 * old UV seam is one place, not a cut), unwrapped there, and the UVs written
 * per corner onto a non-indexed copy of the input — everything else
 * (positions, normals, colours, material groups) passes through untouched.
 *
 * By default the layout is computed once per topology: a mesh that deforms
 * (a Twist, a Wave, a skin) keeps the UVs it had, so the texture stays glued
 * to the surface instead of sliding, and nothing is unwrapped again each
 * frame. "always" redoes it whenever a vertex moves; "manual" keeps it
 * until the Unwrap Now button, so tuning a heavy mesh's settings doesn't
 * unwrap it again at every step.
 */

export const UV_METHODS = ["smart", "conformal", "box", "cylinder", "sphere"] as const;
export type UVMethod = (typeof UV_METHODS)[number];
export const UV_UPDATE_MODES = ["topology", "always", "manual"] as const;

/** App.tsx's onAction id for the Unwrap Now button: bumps `unwrapRequest`, which forces a new layout. */
export const UV_UNWRAP_ACTION = "uv-unwrap/unwrap-now";

/** What each method does, shown under Method for the one chosen. */
const METHOD_NOTES: Record<UVMethod, string> = {
  smart:
    "Smart: cuts the surface into islands wherever it turns more than the Angle Limit, lays each island flat along its "
    + "own average direction and packs them into the 0–1 square, all at the same texel density (Blender's Smart UV "
    + "Project). Lower the angle for more, flatter islands with less stretch; raise it for fewer, larger islands. The safe "
    + "choice for hard-surface and mixed shapes.",
  conformal:
    "Conformal: flattens each connected piece in one go keeping its angles (least-squares conformal maps, Blender's "
    + "Unwrap), so a texture keeps its shape with as few cuts as possible; sizes may vary across the piece. Best on open "
    + "surfaces (a cloth, a face, a terrain). This node has no seams to cut along, so a closed shape (a ball, a box) "
    + "flattens badly: use smart for those.",
  box:
    "Box: each face takes its UVs from the side of a cube it faces most (front, back, left, right, top, bottom), at "
    + "scene scale. Instant, no stretch on boxy shapes, visible seams where the side changes; the classic choice for "
    + "walls, crates, architecture and tiling textures. Pack fits the islands into 0–1; off, UVs stay in scene units "
    + "so a tiling texture keeps the same size on every object.",
  cylinder:
    "Cylinder: wraps the UVs around the Axis, U going round, V along it, at scene scale. For bottles, trunks, columns, "
    + "limbs; the caps (faces looking along the axis) come out squeezed. One seam where U wraps. Pack fits the result "
    + "into 0–1; off, UVs stay in scene units.",
  sphere:
    "Sphere: longitude and latitude around the Axis as the pole, like a world map. For balls, planets, heads, eyes; "
    + "texels bunch up toward the poles. One seam where the longitude wraps. Pack fits the result into 0–1; off, UVs "
    + "stay in scene units.",
};

const UPDATE_NOTE =
  "Recompute — topology: computed again only when the mesh gets a new topology or a setting changes, so a deforming "
  + "mesh keeps its layout and the texture stays glued to it. always: unwrapped again whenever a vertex moves (slow on "
  + "a heavy mesh). manual: kept as it is until Unwrap Now, so changing settings on a heavy mesh costs nothing until "
  + "you ask. Unwrap Now recomputes the layout in any mode.";

interface UVState {
  mesh?: THREE.Mesh;
  /** Topology + settings the corner UVs were computed for. */
  layoutKey: string;
  /** One UV per triangle corner, in the input's triangle order, before the transform. */
  cornerUVs: Float32Array | null;
  transformKey: string;
  islands: number;
  /** The Unwrap Now count the layout was computed at. */
  request?: number;
  /** The source the output was last built from (array identity + version). */
  srcArray?: unknown;
  srcVersion: number;
  srcGeometry?: THREE.BufferGeometry;
}

const uvCache = createNodeCache<UVState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function triangleCorners(geometry: THREE.BufferGeometry): Uint32Array {
  const index = geometry.getIndex();
  const count = index ? index.count : geometry.getAttribute("position").count;
  const corners = new Uint32Array(count - (count % 3));
  for (let i = 0; i < corners.length; i++) corners[i] = index ? index.getX(i) : i;
  return corners;
}

/** Vertex count, triangle count and a sample of the index: what must match to keep a layout. */
function topologyKey(geometry: THREE.BufferGeometry, corners: Uint32Array): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(corners.length / 256));
  for (let i = 0; i < corners.length; i += step) h = Math.imul(h ^ corners[i], 16777619) >>> 0;
  return `${geometry.getAttribute("position").count}:${corners.length}:${h.toString(36)}`;
}

/**
 * The input as a QuadMesh of triangles, welded by position, and for each
 * input triangle the face it became (-1: degenerate once welded).
 */
export function weldedTriangles(geometry: THREE.BufferGeometry, corners: Uint32Array): { mesh: QuadMesh; faceOf: Int32Array } {
  const pos = geometry.getAttribute("position");
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  const q = 1e5 / Math.max(size.x, size.y, size.z, 1e-9);
  const ids = new Map<string, number>();
  const weld = new Int32Array(pos.count);
  const positions: [number, number, number][] = [];
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length;
      ids.set(key, id);
      positions.push([x, y, z]);
    }
    weld[v] = id;
  }
  const faces: number[][] = [];
  const faceOf = new Int32Array(corners.length / 3).fill(-1);
  for (let t = 0; t < faceOf.length; t++) {
    const a = weld[corners[t * 3]], b = weld[corners[t * 3 + 1]], c = weld[corners[t * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    faceOf[t] = faces.length;
    faces.push([a, b, c]);
  }
  return { mesh: { positions, faces }, faceOf };
}

export interface UVLayoutOptions {
  method: UVMethod;
  angleLimit: number;
  margin: number;
  axis: ProjectionAxis;
  /** Pack a projection's islands into 0..1 (smart and conformal always are). */
  pack: boolean;
}

export interface UVTransform {
  scale: number;
  /** Degrees. */
  rotation: number;
  offset: [number, number];
}

/** Lays out UVs for the triangles: one [u, v] per corner, plus the island count. */
export function layoutUVs(geometry: THREE.BufferGeometry, corners: Uint32Array, options: UVLayoutOptions): { uvs: Float32Array; islands: number } {
  const { mesh, faceOf } = weldedTriangles(geometry, corners);
  const all = mesh.faces.map((_, f) => f);
  let out: QuadMesh;
  if (mesh.faces.length === 0) out = mesh;
  else if (options.method === "smart") out = smartUnwrap(mesh, { angleLimitDeg: options.angleLimit, margin: options.margin });
  else if (options.method === "conformal") out = unwrapFaces(mesh, null, options.margin).mesh;
  else {
    out = options.method === "box" ? cubeProject(mesh, []) : options.method === "cylinder" ? cylinderProject(mesh, [], options.axis) : sphereProject(mesh, [], options.axis);
    if (options.pack) out = packFaceIslands(out, all, options.margin);
  }
  const islands = out.faceUVs ? faceUVIslands(out, all).length : 0;
  const uvs = new Float32Array(corners.length * 2);
  for (let t = 0; t < faceOf.length; t++) {
    const f = faceOf[t];
    for (let c = 0; c < 3; c++) {
      const uv = f >= 0 ? out.faceUVs?.[f]?.[c] : undefined;
      uvs[(t * 3 + c) * 2] = uv?.[0] ?? 0;
      uvs[(t * 3 + c) * 2 + 1] = uv?.[1] ?? 0;
    }
  }
  return { uvs, islands };
}

/** The user's transform, about the 0..1 square's centre: scale, then turn, then offset. */
export function transformUVs(uvs: Float32Array, transform: UVTransform): Float32Array {
  const { scale, rotation, offset } = transform;
  if (scale === 1 && rotation === 0 && offset[0] === 0 && offset[1] === 0) return uvs;
  const cos = Math.cos((rotation * Math.PI) / 180), sin = Math.sin((rotation * Math.PI) / 180);
  const out = new Float32Array(uvs.length);
  for (let i = 0; i < uvs.length; i += 2) {
    const u = uvs[i] - 0.5, v = uvs[i + 1] - 0.5;
    out[i] = (u * cos - v * sin) * scale + 0.5 + offset[0];
    out[i + 1] = (u * sin + v * cos) * scale + 0.5 + offset[1];
  }
  return out;
}

/** A non-indexed copy of `source` (every attribute, groups too) carrying `uvs` per corner. */
function withCornerUVs(source: THREE.BufferGeometry, uvs: Float32Array): THREE.BufferGeometry {
  const out = source.index ? source.toNonIndexed() : source.clone();
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uvs.slice(0, out.getAttribute("position").count * 2), 2));
  out.userData = { ...source.userData };
  return out;
}

export const UV_UNWRAP_NODE: NodeDefinition = {
  type: "modifier/uv-unwrap",
  label: "UV Unwrap",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "scale", label: "UV Scale", type: "value" },
    { id: "rotation", label: "UV Rotation", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "islands", label: "Islands", type: "value" },
  ],
  defaultParams: {
    method: "smart",
    angleLimit: 66,
    margin: 0.02,
    axis: "y",
    pack: true,
    scale: 1,
    rotation: 0,
    offsetU: 0,
    offsetV: 0,
    update: "topology",
    // Bumped by the Unwrap Now button: a new value forces a new layout.
    unwrapRequest: 0,
  },
  paramFields: uvUnwrapFields("smart"),
  dynamicParamFields: (instance) =>
    uvUnwrapFields((UV_METHODS as readonly string[]).includes(String(instance.params.method)) ? (instance.params.method as UVMethod) : "smart"),
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) return { geometry: null, matrix: new THREE.Matrix4(), islands: 0 };

    const srcMesh = findFirstMesh(inputObj);
    const srcGeom = srcMesh?.geometry;
    if (!srcMesh || !srcGeom || !srcGeom.getAttribute("position")) {
      warnMeshRequired(ctx.nodeId, "UV Unwrap", inputObj);
      return { ...primitiveOutputs(inputObj), islands: 0 };
    }
    clearMeshWarning(ctx.nodeId);

    const method: UVMethod = (UV_METHODS as readonly string[]).includes(String(params.method)) ? (params.method as UVMethod) : "smart";
    const axis: ProjectionAxis = params.axis === "x" || params.axis === "z" ? params.axis : "y";
    const options: UVLayoutOptions = {
      method,
      axis,
      angleLimit: Math.max(1, Math.min(89, numberInput(undefined, params.angleLimit, 66))),
      margin: Math.max(0, Math.min(0.2, numberInput(undefined, params.margin, 0.02))),
      pack: params.pack !== false && params.pack !== 0,
    };
    const transform: UVTransform = {
      scale: numberInput(inputs.scale, params.scale, 1),
      rotation: numberInput(inputs.rotation, params.rotation, 0),
      offset: [numberInput(undefined, params.offsetU, 0), numberInput(undefined, params.offsetV, 0)],
    };
    const always = params.update === "always";
    const manual = params.update === "manual";
    const request = Number(params.unwrapRequest) || 0;

    let state = uvCache.get(ctx.nodeId);
    if (!state) {
      state = { layoutKey: "", cornerUVs: null, transformKey: "", islands: 0, srcVersion: -1 };
      uvCache.set(ctx.nodeId, state);
    }

    const position = srcGeom.getAttribute("position") as THREE.BufferAttribute;
    const sourceChanged = state.srcGeometry !== srcGeom || state.srcArray !== position.array || state.srcVersion !== position.version;
    const corners = triangleCorners(srcGeom);
    const layoutKey = `${topologyKey(srcGeom, corners)}|${JSON.stringify(options)}`;
    const transformKey = JSON.stringify(transform);

    // The unwrap is the expensive part: only for a new topology or new
    // settings (or any move, on "always"). The transform is cheap, and a
    // moved vertex only needs the shape copied across.
    // Manual keeps the layout through setting changes, but not through a new
    // corner count: last layout's UVs would no longer line up with anything.
    const stale = manual
      ? state.cornerUVs?.length !== corners.length * 2
      : layoutKey !== state.layoutKey || (always && sourceChanged);
    const relayout = !state.cornerUVs || stale || request !== state.request;
    if (relayout) {
      const { uvs, islands } = layoutUVs(srcGeom, corners, options);
      state.cornerUVs = uvs;
      state.islands = islands;
      state.layoutKey = layoutKey;
      state.request = request;
    }
    let geometry: THREE.BufferGeometry | undefined;
    if (relayout || sourceChanged || transformKey !== state.transformKey || !state.mesh) {
      geometry = withCornerUVs(srcGeom, transformUVs(state.cornerUVs!, transform));
      state.transformKey = transformKey;
    }
    state.srcGeometry = srcGeom;
    state.srcArray = position.array;
    state.srcVersion = position.version;

    if (!state.mesh) state.mesh = createModifierMesh();
    state.mesh.castShadow = srcMesh.castShadow;
    state.mesh.receiveShadow = srcMesh.receiveShadow;
    return { ...emitModifiedMesh(state.mesh, { inputObj, srcMesh, geometry, nodeId: ctx.nodeId }), islands: state.islands };
  },
};

/** The parameters for `method`: only the settings it reads, and what it does. */
function uvUnwrapFields(method: UVMethod): ParamFieldDef[] {
  const projection = method === "box" || method === "cylinder" || method === "sphere";
  const fields: ParamFieldDef[] = [
    { id: "method", label: "Method", kind: "select", options: [...UV_METHODS] },
    { id: "methodNote", label: METHOD_NOTES[method], kind: "note" },
    { id: "unwrapNow", label: "Unwrap Now", kind: "button", action: UV_UNWRAP_ACTION },
  ];
  if (method === "smart") fields.push({ id: "angleLimit", label: "Angle Limit (°)", kind: "number", step: 1, group: "Smart" });
  if (method === "cylinder" || method === "sphere") fields.push({ id: "axis", label: "Axis", kind: "select", options: ["x", "y", "z"], group: "Projection" });
  if (projection) fields.push({ id: "pack", label: "Pack into 0–1", kind: "boolean", group: "Projection" });
  fields.push(
    { id: "margin", label: "Island Margin", kind: "number", step: 0.005, group: "Layout" },
    { id: "scale", label: "UV Scale", kind: "number", step: 0.1, group: "Layout" },
    { id: "rotation", label: "UV Rotation (°)", kind: "number", step: 5, group: "Layout" },
    { id: "offsetU", label: "Offset U", kind: "number", step: 0.05, group: "Layout" },
    { id: "offsetV", label: "Offset V", kind: "number", step: 0.05, group: "Layout" },
    {
      id: "update",
      label: "Recompute",
      kind: "select",
      options: [...UV_UPDATE_MODES],
      optionLabels: ["On topology / settings", "Always", "Manual (Unwrap Now)"],
      group: "Layout",
    },
    { id: "updateNote", label: UPDATE_NOTE, kind: "note", group: "Layout" },
  );
  return fields;
}
