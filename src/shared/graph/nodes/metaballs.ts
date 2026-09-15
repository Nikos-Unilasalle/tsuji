import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
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

interface FieldState {
  field: MarchingCubes;
  resolution: number;
}

const meshCache = createNodeCache<THREE.Mesh>(disposeObject3D);
const fieldCache = createNodeCache<FieldState>((state) => state.field.geometry.dispose());
const signatureCache = createNodeCache<string>();

function getField(nodeId: string, resolution: number): MarchingCubes {
  const existing = fieldCache.get(nodeId);
  if (existing && existing.resolution === resolution) return existing.field;
  if (existing) existing.field.geometry.dispose();
  // Not added to any scene — this instance is only ever the field sampler and
  // the marching-cubes implementation, never the thing that gets drawn.
  // UVs on: the node offers the common texture-map inputs, and without them a
  // wired map would sample a single texel across the whole surface.
  const field = new MarchingCubes(resolution, new THREE.MeshBasicMaterial(), true, false, 60000);
  fieldCache.set(nodeId, { field, resolution });
  return field;
}

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

/**
 * Ball centres from a geometry wire: one per drawable descendant, plus one per
 * instance of an InstancedMesh, so an Array / Spawner / Instance Positions
 * chain feeds this node without an explicit point list in between. Positions
 * come out in the source root's own space, so moving that root moves the blobs
 * with it rather than dragging the field cube across them.
 */
function pointsFromObject(object: THREE.Object3D, out: THREE.Vector3[]): void {
  const rootInverse = worldMatrixOf(object, tmpMatrix).clone().invert();
  object.traverse((child) => {
    const instanced = child as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      const childWorld = worldMatrixOf(child, tmpMatrix).clone();
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, tmpInstance);
        tmpInstance.premultiply(childWorld).premultiply(rootInverse);
        out.push(new THREE.Vector3().setFromMatrixPosition(tmpInstance));
      }
      return;
    }
    if (!(child as THREE.Mesh).isMesh && !(child as THREE.Points).isPoints) return;
    const local = worldMatrixOf(child, tmpMatrix).clone().premultiply(rootInverse);
    out.push(new THREE.Vector3().setFromMatrixPosition(local));
  });
}

function collectPoints(inputs: Record<string, unknown>): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  if (Array.isArray(inputs.points)) {
    for (const entry of inputs.points) {
      const point = asPoint(entry);
      if (point) points.push(point);
    }
  }
  if (inputs.geometry instanceof THREE.Object3D) pointsFromObject(inputs.geometry, points);
  return points;
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

/**
 * Writes the marching-cubes result into the node's own geometry, mapped out of
 * the field's [-1, 1] cube and into the node's local space.
 *
 * Writing into one geometry rather than handing back the MarchingCubes mesh
 * keeps §9b's identity contract: the object downstream caches key on never
 * changes, and its draw range covers the whole buffer instead of a slice of a
 * 60k-poly scratch buffer that would otherwise have to travel with it.
 */
function writeFieldGeometry(geometry: THREE.BufferGeometry, field: MarchingCubes, bounds: FieldBounds): void {
  const vertices = field.count;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  if (position.count !== vertices) {
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(vertices * 2), 2));
  }
  const dst = geometry.getAttribute("position") as THREE.BufferAttribute;
  const dstNormal = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const dstUv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const half = bounds.size / 2;
  for (let i = 0; i < vertices * 3; i += 3) {
    dst.array[i] = field.positionArray[i] * half + bounds.center.x;
    dst.array[i + 1] = field.positionArray[i + 1] * half + bounds.center.y;
    dst.array[i + 2] = field.positionArray[i + 2] * half + bounds.center.z;
    dstNormal.array[i] = field.normalArray[i];
    dstNormal.array[i + 1] = field.normalArray[i + 1];
    dstNormal.array[i + 2] = field.normalArray[i + 2];
  }
  dstUv.array.set(field.uvArray.subarray(0, vertices * 2));
  dst.needsUpdate = true;
  dstNormal.needsUpdate = true;
  dstUv.needsUpdate = true;
  geometry.setDrawRange(0, vertices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
}

const METABALL_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "radius", label: "Radius", kind: "number", step: 0.05, group: "Metaballs" },
  { id: "smooth", label: "Smooth (blend reach)", kind: "number", step: 0.05, group: "Metaballs" },
  { id: "resolution", label: "Resolution", kind: "number", step: 1, group: "Metaballs" },
  { id: "autoFit", label: "Auto Fit Field", kind: "boolean", group: "Metaballs" },
  { id: "fieldSize", label: "Field Size (manual)", kind: "number", step: 0.5, group: "Metaballs" },
];

/**
 * Metaballs — an implicit surface over a set of centres, meshed with marching
 * cubes. Wire a point list (Mesh to Points, Instance Positions, Spawn Points)
 * or any geometry whose children are the centres.
 */
export const METABALLS_NODE: NodeDefinition = {
  type: "object/metaballs",
  label: "Metaballs",
  category: "object",
  inputs: [
    { id: "geometry", label: "Centres (Geometry)", type: "geometry", owns: true },
    { id: "points", label: "Centres (Points)", type: "list" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "smooth", label: "Smooth", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS, { id: "count", label: "Ball Count", type: "value" }],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    radius: 0.5,
    smooth: 1.6,
    resolution: 32,
    autoFit: true,
    fieldSize: 8,
  },
  paramFields: buildPrimitiveDynamicParamFields(METABALL_PARAM_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(METABALL_PARAM_FIELDS),
  evaluate: (inputs, params, ctx) => {
    const mesh = getMesh(ctx.nodeId);
    const radius = Math.max(0.0001, numberInput(inputs.radius, params.radius, 0.5));
    // Below 1 the blend reach would be shorter than the ball itself, which
    // makes `subtract` negative and the field never fall off.
    const smooth = Math.min(4, Math.max(1.05, numberInput(inputs.smooth, params.smooth, 1.6)));
    const resolution = Math.min(96, Math.max(8, Math.round(numberInput(undefined, params.resolution, 32))));

    const points = collectPoints(inputs);
    const bounds = fieldBounds(points, radius * smooth, params as Record<string, unknown>);
    const signature = signatureOf(points, bounds, radius, smooth, resolution);

    if (signatureCache.get(ctx.nodeId) !== signature) {
      const field = getField(ctx.nodeId, resolution);
      field.isolation = ISOLATION;
      field.reset();
      const normalizedRadius = radius / bounds.size;
      const subtract = ISOLATION / (smooth * smooth - 1);
      const strength = (ISOLATION + subtract) * normalizedRadius * normalizedRadius;
      for (const point of points) {
        field.addBall(
          (point.x - bounds.center.x) / bounds.size + 0.5,
          (point.y - bounds.center.y) / bounds.size + 0.5,
          (point.z - bounds.center.z) / bounds.size + 0.5,
          strength,
          subtract,
        );
      }
      field.update();
      writeFieldGeometry(mesh.geometry, field, bounds);
      signatureCache.set(ctx.nodeId, signature);
    }

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);

    return { ...primitiveOutputs(mesh, params), count: points.length };
  },
};
