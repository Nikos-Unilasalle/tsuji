import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { UV_DENSITY } from "../mesh/uv";
import { BALL_STRIDE, MeshBuffers, MetaballsJob } from "../offthread/marchingCubes";
import { BLOB_POINT, BLOB_SEGMENT, BLOB_STRIDE, blobIso, BlobsJob, writeBlobElement } from "../offthread/surfaceNets";
import { requestJob } from "../offthread/jobs";
import { worldMatrixOf } from "../objectPosition";
import { asRgb, Centre, collectCentres, collectSegments, finiteAt, isBlobField, listAt } from "./blobElements";
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
import { bindRaymarch, createRaymarchState, disposeRaymarchState, RaymarchState, unbindRaymarch, uploadElements } from "./metaballsRaymarch";

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
/** GPU raymarch state (element texture, shadow materials) of nodes in Raymarched display. */
const raymarchCache = createNodeCache<RaymarchState>(disposeRaymarchState);

/** Matches the 60000-polygon buffer the node used to give three's MarchingCubes. */
const MAX_VERTICES = 180000;
/** Surface Nets shares its vertices (about one per two triangles), so the same memory carries far more surface. */
const SN_MAX_VERTICES = 600000;
const SN_MAX_INDICES = SN_MAX_VERTICES * 6;

export const MESHERS = ["surfaceNets", "marchingCubes"] as const;
type Mesher = (typeof MESHERS)[number];
export const DISPLAYS = ["mesh", "raymarch"] as const;

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
  /** Radius of the Carve inputs' elements. */
  carveRadius: number;
  /** How hard they carve: their weight is −carveStrength. */
  carveStrength: number;
  /**
   * Colour the carvers give the surface they cut, or null to leave it alone.
   * Always Carve Color — not the carver object's own colour, even with Inherit
   * Source Colors: a fresh sphere is white, which silently overrode the colour
   * picked here. Per-hole colours: negative Blob Field elements with Colors.
   */
  carveTint: [number, number, number] | null;
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
  // Carvers come last, so they never shift the Radii / Weights / Colors indices.
  // They are placed where they are in the scene, in the same space as the
  // centres (the centres wire's root, or the world without one) — not in
  // their own root's space, which would pin a lone carver object to the origin.
  const frame = inputs.geometry instanceof THREE.Object3D ? worldMatrixOf(inputs.geometry, new THREE.Matrix4()).invert() : new THREE.Matrix4();
  const carvers = collectCentres(inputs.carvePoints, inputs.carveGeometry, frame);
  // A wired Blob Field: its own radii, weights and colours, meshed with this node's Smooth.
  const fieldElements = isBlobField(inputs.field) ? inputs.field.elements : [];
  const explicitColors = Array.isArray(inputs.colors) && inputs.colors.length > 0;
  const colors =
    explicitColors ||
    (settings.inheritColors && centres.some((c) => c.color)) ||
    fieldElements.some((e) => e.color) ||
    (settings.carveTint !== null && carvers.length > 0);
  const elements = new Float64Array((centres.length + segments.length + fieldElements.length + carvers.length) * BLOB_STRIDE);
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
  // Field chains go after this node's own polylines, so no two share an id.
  const chainOffset = segments.reduce((m, segment) => Math.max(m, segment.chain), 0);
  for (const e of fieldElements) {
    const ok = writeBlobElement(elements, n, {
      kind: e.kind === 1 ? BLOB_SEGMENT : BLOB_POINT,
      a: e.a,
      b: e.b,
      radius: e.radius,
      smooth: settings.smooth,
      weight: e.weight,
      color: e.color,
      shape: e.shape,
      chain: e.chain ? e.chain + chainOffset : 0,
    });
    if (ok) n++;
  }
  if (settings.carveStrength > 0 && settings.carveRadius > 0) {
    for (const carver of carvers) {
      const ok = writeBlobElement(elements, n, {
        kind: BLOB_POINT,
        a: [carver.point.x, carver.point.y, carver.point.z],
        radius: settings.carveRadius,
        smooth: settings.smooth,
        weight: -settings.carveStrength,
        color: settings.carveTint ?? undefined,
        shape: settings.instanceShape ? carver.shape : undefined,
      });
      if (ok) n++;
    }
  }
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
  if (mesher === "surfaceNets") {
    fields.push(
      {
        id: "display",
        label: "Display",
        kind: "select",
        options: [...DISPLAYS],
        optionLabels: ["Mesh (worker)", "Raymarched (GPU, experimental)"],
        group: "Metaballs",
      },
      {
        id: "displayNote",
        label: "Raymarched (experimental) draws the field on the GPU: no mesh, no resolution, no worker. Costs more GPU than the mesh (point-light shadows especially). Falls back to the mesh when the Geometry output is wired or a custom Material is used.",
        kind: "note",
        group: "Metaballs",
      },
    );
  }
  if (mesher === "marchingCubes") {
    fields.push(
      { id: "autoFit", label: "Auto Fit Field", kind: "boolean", group: "Metaballs" },
      { id: "fieldSize", label: "Field Size (manual)", kind: "number", step: 0.5, group: "Metaballs" },
      {
        id: "legacyNote",
        label: "Legacy mesher: one radius for every ball; Radii, Weights, Colors, Segments, Blob Field and Carve are ignored.",
        kind: "note",
        group: "Metaballs",
      },
    );
  } else {
    fields.push(
      { id: "instanceShape", label: "Instance Shape (ellipsoids)", kind: "boolean", group: "Metaballs" },
      { id: "inheritColors", label: "Inherit Source Colors", kind: "boolean", group: "Metaballs" },
      { id: "carveStrength", label: "Carve Strength", kind: "number", step: 0.1, group: "Metaballs" },
      { id: "carveRadius", label: "Carve Radius (0 = Radius)", kind: "number", step: 0.05, group: "Metaballs" },
      { id: "carveTint", label: "Tint Carved Surface", kind: "boolean", group: "Metaballs" },
      { id: "carveColor", label: "Carve Color", kind: "color", group: "Metaballs" },
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
  const points = collectCentres(inputs.points, inputs.geometry).map((c) => c.point);
  const bounds = fieldBounds(points, radius * smooth, params);
  const signature = signatureOf(points, bounds, radius, smooth, resolution);
  // Marching cubes runs in the geometry worker (offthread/jobs.ts): this
  // frame shows the newest finished surface, which trails the inputs by a
  // frame or so while they move and is exact once they stop. Export capture
  // asks for it synchronously, so every recorded frame is exact.
  const job = requestJob(nodeId, "metaballs", signature, () => jobFor(points, bounds, radius, smooth, resolution), { sync: capturing });
  return { job, count: points.length };
}

function blobsPayload(inputs: Record<string, unknown>, params: Record<string, unknown>, radius: number, smooth: number) {
  const resolution = Math.min(256, Math.max(8, Math.round(numberInput(undefined, params.resolution, 64))));
  const carveRadius = numberInput(inputs.carveRadius, params.carveRadius, 0);
  return blobsJobFor(inputs, collectCentres(inputs.points, inputs.geometry), {
    radius,
    // 0 (the default) means "same as Radius".
    carveRadius: carveRadius > 0 ? carveRadius : radius,
    carveStrength: Math.min(10, Math.max(0, numberInput(inputs.carveStrength, params.carveStrength, 1))),
    carveTint: params.carveTint === true ? asRgb(inputs.carveColor ?? params.carveColor) ?? [0.6, 0.15, 0.15] : null,
    smooth,
    resolution,
    instanceShape: params.instanceShape === true,
    inheritColors: params.inheritColors === true,
  });
}

function evaluateSurfaceNets(nodeId: string, inputs: Record<string, unknown>, params: Record<string, unknown>, radius: number, smooth: number, capturing: boolean) {
  const { job: payload, count } = blobsPayload(inputs, params, radius, smooth);
  const job = requestJob(nodeId, "blobs", blobsSignature(payload), () => payload, { sync: capturing });
  return { job, count };
}

const proxyBox = new THREE.BoxGeometry(1, 1, 1);

/**
 * Raymarched display: no mesh at all, the node's geometry is a box around the
 * elements and its material traces the field (metaballsRaymarch.ts). Only
 * re-uploads when the elements changed.
 */
function evaluateRaymarch(nodeId: string, mesh: THREE.Mesh, inputs: Record<string, unknown>, params: Record<string, unknown>, radius: number, smooth: number): number {
  const { job: payload, count } = blobsPayload(inputs, params, radius, smooth);
  let state = raymarchCache.get(nodeId);
  if (!state) {
    state = createRaymarchState();
    raymarchCache.set(nodeId, state);
  }
  const signature = `rm|${blobsSignature(payload)}`;
  if (appliedCache.get(nodeId) !== signature) {
    const box = uploadElements(state, payload.elements, payload.iso, payload.colors);
    const geometry = mesh.geometry;
    geometry.dispose();
    if (box) {
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const position = (proxyBox.getAttribute("position").array as Float32Array).slice();
      for (let i = 0; i < position.length; i += 3) {
        position[i] = position[i] * size.x + center.x;
        position[i + 1] = position[i + 1] * size.y + center.y;
        position[i + 2] = position[i + 2] * size.z + center.z;
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute((proxyBox.getAttribute("normal").array as Float32Array).slice(), 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute((proxyBox.getAttribute("uv").array as Float32Array).slice(), 2));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(proxyBox.getIndex()!.array), 1));
      geometry.setDrawRange(0, proxyBox.getIndex()!.count);
      (geometry.boundingBox ??= new THREE.Box3()).copy(box);
      box.getBoundingSphere((geometry.boundingSphere ??= new THREE.Sphere()));
    } else {
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(0), 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(0), 2));
      geometry.setIndex(null);
      geometry.setDrawRange(0, 0);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    geometry.deleteAttribute("color");
    appliedCache.set(nodeId, signature);
  }
  return count;
}

/** Raymarched only where it can stand in for the mesh: Surface Nets, nothing reading the geometry downstream, no custom material. */
function wantsRaymarch(params: Record<string, unknown>, ctx: { connectedOutputs?: ReadonlySet<string> }, customMaterial: unknown): boolean {
  return params.display === "raymarch" && mesherOf(params) === "surfaceNets" && !ctx.connectedOutputs?.has("geometry") && !customMaterial;
}

/**
 * Metaballs — an implicit surface over a set of elements. Wire a point list
 * (Mesh to Points, Instance Positions, Spawn Points), any geometry whose
 * children or instances are the centres, and/or a list of segments
 * (capsules). Per-element Radii, Weights (negative carves) and Colors are
 * lists indexed like the elements: point list first, then the geometry
 * wire's centres, then the segments. Whatever is wired to Carve (Geometry /
 * Points) becomes negative elements of Carve Radius and Strength — holes and
 * dents without lining up a Weights list. A Blob Field (Blob Field: Points /
 * Polyline / Combine) adds its elements as they are, radii and weights
 * included; only this node's Smooth applies to them.
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
    { id: "field", label: "Blob Field", type: "blobfield" },
    { id: "carveGeometry", label: "Carve (Geometry)", type: "geometry", owns: true },
    { id: "carvePoints", label: "Carve (Points)", type: "list" },
    { id: "radii", label: "Radii (per element)", type: "list" },
    { id: "weights", label: "Weights (per element, <0 carves)", type: "list" },
    { id: "colors", label: "Colors (per element)", type: "list" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "smooth", label: "Smooth", type: "value" },
    { id: "carveStrength", label: "Carve Strength", type: "value" },
    { id: "carveRadius", label: "Carve Radius", type: "value" },
    { id: "carveColor", label: "Carve Color", type: "color" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS, { id: "count", label: "Ball Count", type: "value" }],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    mesher: "surfaceNets",
    display: "mesh",
    radius: 0.5,
    smooth: 1.6,
    resolution: 64,
    autoFit: true,
    fieldSize: 8,
    instanceShape: false,
    inheritColors: false,
    carveStrength: 1,
    carveRadius: 0,
    carveTint: false,
    carveColor: new THREE.Color(0x9b2c2c),
  },
  // Off in defaultParams so scenes saved before these options keep their look
  // (their marker objects are often scaled without meaning the blobs to follow);
  // on for a Metaballs node made now.
  newNodeParams: { instanceShape: true, inheritColors: true, carveTint: true },
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
    const matParams = extractMaterialParams(inputs, params);
    const raymarch = wantsRaymarch(p, ctx, matParams.customMaterial);
    let count: number;
    if (raymarch) {
      count = evaluateRaymarch(ctx.nodeId, mesh, inputs, p, radius, smooth);
    } else {
      const evaluated =
        mesherOf(p) === "marchingCubes"
          ? evaluateLegacy(ctx.nodeId, inputs, p, radius, smooth, capturing)
          : evaluateSurfaceNets(ctx.nodeId, inputs, p, radius, smooth, capturing);
      count = evaluated.count;
      const job = evaluated.job;
      if (job.result && job.signature !== appliedCache.get(ctx.nodeId)) {
        applyMesh(mesh.geometry, job.result);
        appliedCache.set(ctx.nodeId, job.signature!);
      }
    }

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    // The proxy box is drawn from inside out, so the camera can sit inside it.
    applyMaterialParams(mesh, matParams, raymarch ? THREE.BackSide : THREE.FrontSide, texParams);
    const ownMaterial = !matParams.customMaterial && !Array.isArray(mesh.material) ? (mesh.material as THREE.Material) : null;
    // Once a node has raymarched, its state stays (and stays bound, carrying
    // its uniforms) while it shows the mesh — see bindRaymarch for why.
    const state = raymarchCache.get(ctx.nodeId);
    if (ownMaterial && state) bindRaymarch(ownMaterial, state, raymarch);
    else if (ownMaterial) unbindRaymarch(ownMaterial);
    if (ownMaterial) ownMaterial.shadowSide = raymarch && state ? THREE.BackSide : null;
    mesh.customDepthMaterial = raymarch && state ? state.depthMaterial : undefined;
    mesh.customDistanceMaterial = raymarch && state ? state.distanceMaterial : undefined;
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
