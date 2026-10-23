import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { UV_DENSITY } from "../mesh/uv";
import { BALL_STRIDE, MeshBuffers, MetaballsJob } from "../offthread/marchingCubes";
import { BLOB_POINT, BLOB_SEGMENT, BLOB_STRIDE, blobIso, BlobsJob, writeBlobElement } from "../offthread/surfaceNets";
import { requestJob } from "../offthread/jobs";
import { worldMatrixOf } from "../objectPosition";
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
import { composeNativeMatrix } from "./transform";

/**
 * The iso level the field is polygonized at. Fixed rather than exposed: on its
 * own it says nothing a user can picture, because the only thing that matters
 * is the ratio between it and each ball's strength — which is exactly what the
 * Radius and Smooth params set below. Changing it alone would just rescale
 * every blob.
 */
const ISOLATION = 20;

const meshCache = createNodeCache<THREE.Mesh>(disposeObject3D);
/** Signature of the result currently written into the node's geometry. */
const appliedCache = createNodeCache<string>();

/** Matches the 60000-polygon buffer the node used to give three's MarchingCubes. */
const MAX_VERTICES = 180000;
/** Surface Nets shares its vertices (about one per two triangles), so the same memory carries far more surface. */
const SN_MAX_VERTICES = 600000;
const SN_MAX_INDICES = SN_MAX_VERTICES * 6;

export const MESHERS = ["surfaceNets", "marchingCubes"] as const;
type Mesher = (typeof MESHERS)[number];

function getMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(0), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(0), 2));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

/** A single NaN centre poisons every cell of the field, so finiteness is checked here rather than trusted. */
function asPoint(value: unknown): THREE.Vector3 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { x?: unknown; y?: unknown; z?: unknown };
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const z = Number(candidate.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return new THREE.Vector3(x, y, z);
}

const tmpMatrix = new THREE.Matrix4();
const tmpInstance = new THREE.Matrix4();
const tmpColor = new THREE.Color();

/** A ball centre plus what its source object says about it. */
interface Centre {
  point: THREE.Vector3;
  /** Row-major 3×3 of the source's rotation × scale, relative to the wired root. */
  shape?: number[];
  /** Instance colour, or the source mesh's material colour. */
  color?: [number, number, number];
}

function shapeOf(m: THREE.Matrix4): number[] {
  const e = m.elements;
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

function materialColor(object: THREE.Object3D): [number, number, number] | undefined {
  const material = (object as THREE.Mesh).material;
  const first = Array.isArray(material) ? material[0] : material;
  const color = (first as THREE.MeshStandardMaterial | undefined)?.color;
  return color instanceof THREE.Color ? [color.r, color.g, color.b] : undefined;
}

/**
 * Ball centres from a geometry wire: one per drawable descendant, plus one per
 * instance of an InstancedMesh, so an Array / Spawner / Instance Positions
 * chain feeds this node without an explicit point list in between. Positions
 * come out in the source root's own space, so moving that root moves the blobs
 * with it rather than dragging the field cube across them. Each centre keeps
 * its source's rotation × scale (an ellipsoid, if Instance Shape is on — off
 * by default, since scenes often scale their marker objects without meaning
 * the blobs to follow) and colour.
 */
function centresFromObject(object: THREE.Object3D, out: Centre[]): void {
  const rootInverse = worldMatrixOf(object, tmpMatrix).clone().invert();
  object.traverse((child) => {
    const instanced = child as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      const childWorld = worldMatrixOf(child, tmpMatrix).clone();
      const fallback = materialColor(child);
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, tmpInstance);
        tmpInstance.premultiply(childWorld).premultiply(rootInverse);
        let color = fallback;
        if (instanced.instanceColor) {
          instanced.getColorAt(i, tmpColor);
          color = [tmpColor.r, tmpColor.g, tmpColor.b];
        }
        out.push({ point: new THREE.Vector3().setFromMatrixPosition(tmpInstance), shape: shapeOf(tmpInstance), color });
      }
      return;
    }
    if (!(child as THREE.Mesh).isMesh && !(child as THREE.Points).isPoints) return;
    const local = worldMatrixOf(child, tmpMatrix).clone().premultiply(rootInverse);
    out.push({ point: new THREE.Vector3().setFromMatrixPosition(local), shape: shapeOf(local), color: materialColor(child) });
  });
}

function collectCentres(inputs: Record<string, unknown>): Centre[] {
  const centres: Centre[] = [];
  if (Array.isArray(inputs.points)) {
    for (const entry of inputs.points) {
      const point = asPoint(entry);
      if (point) centres.push({ point });
    }
  }
  if (inputs.geometry instanceof THREE.Object3D) centresFromObject(inputs.geometry, centres);
  return centres;
}

/** A segment entry given as an object: {start, end}, {a, b} or {from, to}. */
function asSegment(value: unknown): [THREE.Vector3, THREE.Vector3] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const pa = asPoint(v.start ?? v.a ?? v.from);
  const pb = asPoint(v.end ?? v.b ?? v.to);
  return pa && pb ? [pa, pb] : null;
}

interface Segment {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** Polyline id (> 0): its capsules join without bulging at the joints. 0 for a lone segment. */
  chain: number;
}

/** Consecutive points joined: n points → n − 1 capsules, one chain. Unreadable points are skipped. */
function chain(points: unknown[], id: number, out: Segment[]): void {
  let previous: THREE.Vector3 | null = null;
  for (const entry of points) {
    const point = asPoint(entry);
    if (!point) continue;
    if (previous) out.push({ a: previous, b: point, chain: id });
    previous = point;
  }
}

/**
 * The Segments input, in whichever shape it arrives:
 *   - a list of points (Curve → To Points) — a polyline, one capsule per span;
 *   - a list of point lists — several polylines ([a, b] pairs are the 2-point case);
 *   - a list of {start, end} objects.
 */
function collectSegments(value: unknown): Segment[] {
  const segments: Segment[] = [];
  if (!Array.isArray(value)) return segments;
  if (value.some((entry) => asPoint(entry))) {
    chain(value, 1, segments);
    return segments;
  }
  let id = 0;
  for (const entry of value) {
    if (Array.isArray(entry)) chain(entry, ++id, segments);
    else {
      const segment = asSegment(entry);
      if (segment) segments.push({ a: segment[0], b: segment[1], chain: 0 });
    }
  }
  return segments;
}

/** THREE.Color, hex number, CSS string or {r, g, b}. */
function asRgb(value: unknown): [number, number, number] | undefined {
  if (value instanceof THREE.Color) return [value.r, value.g, value.b];
  if (typeof value === "number" || typeof value === "string") {
    tmpColor.set(value as THREE.ColorRepresentation);
    return [tmpColor.r, tmpColor.g, tmpColor.b];
  }
  if (value && typeof value === "object") {
    const c = value as { r?: unknown; g?: unknown; b?: unknown };
    const rgb = [Number(c.r), Number(c.g), Number(c.b)];
    if (rgb.every(Number.isFinite)) return rgb as [number, number, number];
  }
  return undefined;
}

function listAt(list: unknown, i: number): unknown {
  return Array.isArray(list) ? list[i] : undefined;
}

function finiteAt(list: unknown, i: number, fallback: number): number {
  const v = listAt(list, i);
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

interface FieldBounds {
  center: THREE.Vector3;
  size: number;
}

function fieldBounds(points: THREE.Vector3[], reach: number, params: Record<string, unknown>): FieldBounds {
  if (!params.autoFit) {
    const size = Math.max(0.001, Number(params.fieldSize) || 1);
    return { center: new THREE.Vector3(0, 0, 0), size };
  }
  const box = new THREE.Box3();
  for (const point of points) box.expandByPoint(point);
  const center = box.getCenter(new THREE.Vector3());
  const extent = box.getSize(new THREE.Vector3());
  // The 2.3 margin is the field cube's outer layer, which marching cubes never
  // polygonizes: fit tighter than the reach of the outermost ball and its blob
  // gets sliced flat against the wall of the cube.
  const size = Math.max(extent.x, extent.y, extent.z) + reach * 2.3;
  return { center, size: Math.max(0.001, size) };
}

function signatureOf(points: THREE.Vector3[], bounds: FieldBounds, radius: number, smooth: number, resolution: number): string {
  const parts: string[] = [`${resolution}|${radius.toFixed(4)}|${smooth.toFixed(4)}`];
  parts.push(`${bounds.size.toFixed(4)}|${bounds.center.toArray().map((n) => n.toFixed(4)).join(",")}`);
  for (const point of points) parts.push(point.toArray().map((n) => n.toFixed(4)).join(","));
  return parts.join(";");
}

function jobFor(points: THREE.Vector3[], bounds: FieldBounds, radius: number, smooth: number, resolution: number): MetaballsJob {
  const normalizedRadius = radius / bounds.size;
  const subtract = ISOLATION / (smooth * smooth - 1);
  const strength = (ISOLATION + subtract) * normalizedRadius * normalizedRadius;
  const balls = new Float64Array(points.length * BALL_STRIDE);
  points.forEach((point, i) => {
    balls[i * BALL_STRIDE] = (point.x - bounds.center.x) / bounds.size + 0.5;
    balls[i * BALL_STRIDE + 1] = (point.y - bounds.center.y) / bounds.size + 0.5;
    balls[i * BALL_STRIDE + 2] = (point.z - bounds.center.z) / bounds.size + 0.5;
    balls[i * BALL_STRIDE + 3] = strength;
    balls[i * BALL_STRIDE + 4] = subtract;
  });
  return {
    resolution,
    isolation: ISOLATION,
    balls,
    centerX: bounds.center.x,
    centerY: bounds.center.y,
    centerZ: bounds.center.z,
    size: bounds.size,
    maxVertices: MAX_VERTICES,
    uvDensity: UV_DENSITY,
  };
}

interface BlobSettings {
  radius: number;
  smooth: number;
  resolution: number;
  instanceShape: boolean;
  inheritColors: boolean;
}

/**
 * Every element the Surface Nets kernel sees: the centres (point list first,
 * then the geometry wire's) with their per-ball radius / weight / colour, then
 * the capsules. Radii, Weights and Colors are indexed like the centres.
 */
function blobsJobFor(inputs: Record<string, unknown>, centres: Centre[], settings: BlobSettings): { job: BlobsJob; count: number } {
  const segments = collectSegments(inputs.segments);
  const explicitColors = Array.isArray(inputs.colors) && inputs.colors.length > 0;
  const colors = explicitColors || (settings.inheritColors && centres.some((c) => c.color));
  const elements = new Float64Array((centres.length + segments.length) * BLOB_STRIDE);
  let n = 0;
  centres.forEach((centre, i) => {
    const radius = finiteAt(inputs.radii, i, settings.radius);
    if (!(radius > 0)) return;
    const color = asRgb(listAt(inputs.colors, i)) ?? (settings.inheritColors ? centre.color : undefined);
    const ok = writeBlobElement(elements, n, {
      kind: BLOB_POINT,
      a: [centre.point.x, centre.point.y, centre.point.z],
      radius,
      smooth: settings.smooth,
      weight: finiteAt(inputs.weights, i, 1),
      color,
      shape: settings.instanceShape ? centre.shape : undefined,
    });
    if (ok) n++;
  });
  segments.forEach(({ a, b, chain }, i) => {
    const k = centres.length + i;
    const ok = writeBlobElement(elements, n, {
      kind: BLOB_SEGMENT,
      a: [a.x, a.y, a.z],
      b: [b.x, b.y, b.z],
      radius: finiteAt(inputs.radii, k, settings.radius),
      smooth: settings.smooth,
      weight: finiteAt(inputs.weights, k, 1),
      color: asRgb(listAt(inputs.colors, k)),
      chain,
    });
    if (ok) n++;
  });
  return {
    count: n,
    job: {
      elements: elements.subarray(0, n * BLOB_STRIDE),
      iso: blobIso(settings.smooth),
      resolution: settings.resolution,
      maxVertices: SN_MAX_VERTICES,
      maxIndices: SN_MAX_INDICES,
      colors,
      uvDensity: UV_DENSITY,
    },
  };
}

/** FNV-1a over the job's raw bits: the elements array can be thousands of numbers, too many to stringify every frame. */
function blobsSignature(job: BlobsJob): string {
  const words = new Uint32Array(job.elements.buffer, job.elements.byteOffset, job.elements.length * 2);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < words.length; i++) {
    h1 = Math.imul(h1 ^ words[i], 0x01000193);
    h2 = Math.imul(h2 ^ words[i], 0x5bd1e995) ^ (h2 >>> 15);
  }
  return `sn|${job.resolution}|${job.iso}|${job.colors ? 1 : 0}|${words.length}|${(h1 >>> 0).toString(36)}|${(h2 >>> 0).toString(36)}`;
}

/**
 * Attaches a finished kernel result to the node's own geometry — the arrays
 * as they came back from the worker (transferred, so not copied), the bounds
 * it already computed.
 *
 * Writing into one geometry rather than handing back a new mesh keeps §9b's
 * identity contract: the object downstream caches key on never changes.
 * Same-size results are copied into the existing attributes, so the GPU
 * buffers are updated in place rather than reallocated.
 */
function applyMesh(geometry: THREE.BufferGeometry, mesh: MeshBuffers): void {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const color = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();
  const sameShape =
    position.count === mesh.count &&
    (index?.count ?? -1) === (mesh.index?.length ?? -1) &&
    (color?.count ?? -1) === (mesh.color ? mesh.count : -1);
  if (sameShape) {
    (position.array as Float32Array).set(mesh.position);
    (geometry.getAttribute("normal").array as Float32Array).set(mesh.normal);
    (geometry.getAttribute("uv").array as Float32Array).set(mesh.uv);
    position.needsUpdate = true;
    (geometry.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute("uv") as THREE.BufferAttribute).needsUpdate = true;
    if (index && mesh.index) {
      (index.array as Uint32Array).set(mesh.index);
      index.needsUpdate = true;
    }
    if (color && mesh.color) {
      (color.array as Float32Array).set(mesh.color);
      color.needsUpdate = true;
    }
  } else {
    // New buffers: drop the renderer's copies of the old ones first. Besides
    // freeing them (replaced attributes are otherwise only released with the
    // geometry), this clears three's cached wireframe index, which it never
    // rebuilds for a non-indexed geometry and rebuilds for an indexed one only
    // when the index's version goes up — a fresh index starts back at 0.
    geometry.dispose();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.position, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normal, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uv, 2));
    geometry.setIndex(mesh.index ? new THREE.BufferAttribute(mesh.index, 1) : null);
    if (mesh.color) geometry.setAttribute("color", new THREE.BufferAttribute(mesh.color, 3));
    else geometry.deleteAttribute("color");
  }
  geometry.setDrawRange(0, mesh.index ? mesh.index.length : mesh.count);
  if (mesh.count === 0) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return;
  }
  const b = mesh.bounds;
  (geometry.boundingBox ??= new THREE.Box3()).min.set(b[0], b[1], b[2]);
  geometry.boundingBox.max.set(b[3], b[4], b[5]);
  (geometry.boundingSphere ??= new THREE.Sphere()).center.set(b[6], b[7], b[8]);
  geometry.boundingSphere.radius = b[9];
}

function metaballParamFields(mesher: Mesher): ParamFieldDef[] {
  const fields: ParamFieldDef[] = [
    {
      id: "mesher",
      label: "Mesher",
      kind: "select",
      options: [...MESHERS],
      optionLabels: ["Surface Nets (smooth, indexed)", "Marching Cubes (legacy)"],
      group: "Metaballs",
    },
    { id: "radius", label: "Radius", kind: "number", step: 0.05, group: "Metaballs" },
    { id: "smooth", label: "Smooth (blend reach)", kind: "number", step: 0.05, group: "Metaballs" },
    { id: "resolution", label: "Resolution", kind: "number", step: 1, group: "Metaballs" },
  ];
  if (mesher === "marchingCubes") {
    fields.push(
      { id: "autoFit", label: "Auto Fit Field", kind: "boolean", group: "Metaballs" },
      { id: "fieldSize", label: "Field Size (manual)", kind: "number", step: 0.5, group: "Metaballs" },
      {
        id: "legacyNote",
        label: "Legacy mesher: one radius for every ball; Radii, Weights, Colors and Segments are ignored.",
        kind: "note",
        group: "Metaballs",
      },
    );
  } else {
    fields.push(
      { id: "instanceShape", label: "Instance Shape (ellipsoids)", kind: "boolean", group: "Metaballs" },
      { id: "inheritColors", label: "Inherit Source Colors", kind: "boolean", group: "Metaballs" },
    );
  }
  return fields;
}

function mesherOf(params: Record<string, unknown>): Mesher {
  return params.mesher === "marchingCubes" ? "marchingCubes" : "surfaceNets";
}

/** Marching cubes, exactly as the node meshed before Surface Nets: one radius, a cubic field, three's field function. */
function evaluateLegacy(nodeId: string, inputs: Record<string, unknown>, params: Record<string, unknown>, radius: number, smooth: number, capturing: boolean) {
  const resolution = Math.min(96, Math.max(8, Math.round(numberInput(undefined, params.resolution, 32))));
  const points = collectCentres(inputs).map((c) => c.point);
  const bounds = fieldBounds(points, radius * smooth, params);
  const signature = signatureOf(points, bounds, radius, smooth, resolution);
  // Marching cubes runs in the geometry worker (offthread/jobs.ts): this
  // frame shows the newest finished surface, which trails the inputs by a
  // frame or so while they move and is exact once they stop. Export capture
  // asks for it synchronously, so every recorded frame is exact.
  const job = requestJob(nodeId, "metaballs", signature, () => jobFor(points, bounds, radius, smooth, resolution), { sync: capturing });
  return { job, count: points.length };
}

function evaluateSurfaceNets(nodeId: string, inputs: Record<string, unknown>, params: Record<string, unknown>, radius: number, smooth: number, capturing: boolean) {
  const resolution = Math.min(256, Math.max(8, Math.round(numberInput(undefined, params.resolution, 64))));
  const { job: payload, count } = blobsJobFor(inputs, collectCentres(inputs), {
    radius,
    smooth,
    resolution,
    instanceShape: params.instanceShape === true,
    inheritColors: params.inheritColors === true,
  });
  const job = requestJob(nodeId, "blobs", blobsSignature(payload), () => payload, { sync: capturing });
  return { job, count };
}

/**
 * Metaballs — an implicit surface over a set of elements. Wire a point list
 * (Mesh to Points, Instance Positions, Spawn Points), any geometry whose
 * children or instances are the centres, and/or a list of segments
 * (capsules). Per-element Radii, Weights (negative carves) and Colors are
 * lists indexed like the elements: point list first, then the geometry
 * wire's centres, then the segments.
 *
 * Surface Nets (default): compact field, sparse grid fitted to the elements,
 * indexed smooth-shaded mesh. Marching Cubes: the original mesher, kept so a
 * scene can be matched exactly.
 */
export const METABALLS_NODE: NodeDefinition = {
  type: "object/metaballs",
  label: "Metaballs",
  category: "object",
  inputs: [
    { id: "geometry", label: "Centres (Geometry)", type: "geometry", owns: true },
    { id: "points", label: "Centres (Points)", type: "list" },
    { id: "segments", label: "Segments / Polyline (Capsules)", type: "list" },
    { id: "radii", label: "Radii (per element)", type: "list" },
    { id: "weights", label: "Weights (per element, <0 carves)", type: "list" },
    { id: "colors", label: "Colors (per element)", type: "list" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "smooth", label: "Smooth", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS, { id: "count", label: "Ball Count", type: "value" }],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    mesher: "surfaceNets",
    radius: 0.5,
    smooth: 1.6,
    resolution: 64,
    autoFit: true,
    fieldSize: 8,
    instanceShape: false,
    inheritColors: false,
  },
  paramFields: buildPrimitiveDynamicParamFields(metaballParamFields("surfaceNets"))(),
  dynamicParamFields: (instance) => buildPrimitiveDynamicParamFields(metaballParamFields(mesherOf(instance.params)))(),
  evaluate: (inputs, params, ctx) => {
    const mesh = getMesh(ctx.nodeId);
    const p = params as Record<string, unknown>;
    const radius = Math.max(0.0001, numberInput(inputs.radius, params.radius, 0.5));
    // Below 1 the blend reach would be shorter than the ball itself, which
    // makes `subtract` negative and the field never fall off.
    const smooth = Math.min(4, Math.max(1.05, numberInput(inputs.smooth, params.smooth, 1.6)));
    const capturing = ctx.capturing === true;
    const { job, count } =
      mesherOf(p) === "marchingCubes"
        ? evaluateLegacy(ctx.nodeId, inputs, p, radius, smooth, capturing)
        : evaluateSurfaceNets(ctx.nodeId, inputs, p, radius, smooth, capturing);
    if (job.result && job.signature !== appliedCache.get(ctx.nodeId)) {
      applyMesh(mesh.geometry, job.result);
      appliedCache.set(ctx.nodeId, job.signature!);
    }

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);
    // Blended element colours ride in a vertex attribute; the material's own colour tints them.
    const wantsVertexColors = mesh.geometry.getAttribute("color") !== undefined;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (!matParams.customMaterial && !Array.isArray(material) && material.vertexColors !== wantsVertexColors) {
      material.vertexColors = wantsVertexColors;
      material.needsUpdate = true;
    }

    return { ...primitiveOutputs(mesh, params), count };
  },
};
