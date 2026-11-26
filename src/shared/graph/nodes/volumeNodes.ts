import * as THREE from "three";
import type { NodeDefinition, NodeInstance, ParamFieldDef, EvalContext } from "../types";
import type { SocketDef } from "../sockets";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { worldMatrixOf } from "../objectPosition";
import { findFirstMesh } from "../meshRequired";
import { quadMeshSignature, type PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh, transferByNearest } from "../mesh/polyIO";
import { evaluateGroup, maskIndices } from "../mesh/groupExpr";
import { readAttribute } from "../mesh/polyAttributes";
import {
  combineSdf,
  isSdfGrid,
  meshToSdf,
  noiseSdf,
  offsetSdf,
  pointsToSdf,
  sdfSignature,
  sdfToPolyMesh,
  smoothSdf,
  type SdfCombineOp,
  type SdfGrid,
  type Vec3,
} from "../mesh/sdfGrid";
import { createModifierMesh, emitModifiedMesh, primitiveOutputs } from "./object";
import { valueSignature } from "./polyModifier";

/*
 * Volume / SDF nodes (phase 8 of docs/parametric-modeling-plan.md).
 *
 * Transport (the plan's deferred §6, settled): a volume travels in the
 * ordinary `geometry` socket. The value is a THREE.Mesh whose geometry is
 * the volume's zero iso-surface — PolyMesh-backed, so it draws in the
 * viewport and every mesh node can read it — and whose `userData.sdfGrid`
 * holds the grid itself:
 *
 *   { dims: [nx, ny, nz], origin: [x, y, z], voxel: number, values: Float32Array }
 *
 * x-fastest, negative inside, in the mesh's local space (the mesh keeps the
 * pose of the shape it came from, like any modifier output). Grids are never
 * mutated once handed out: a node that changes one builds a new one, which is
 * what lets downstream nodes key their caches on grid identity.
 *
 * Every SDF input also accepts a plain mesh: it is converted on the fly (the
 * node's Resolution, or 48 cells), so "Mesh → SDF Smooth" works without an
 * explicit Mesh to SDF in between.
 *
 * Cost: all kernels are dense over the grid, capped at 128³ samples (the
 * voxel grows past that and the node says so). Results are memoised on the
 * inputs' signatures, so only a changed parameter or upstream rebuilds.
 */

// ---------------------------------------------------------------- transport

/** The grid an object carries, or null. Looks at the first mesh and its geometry. */
export function readSdfGrid(object: unknown): SdfGrid | null {
  if (!(object instanceof THREE.Object3D)) return null;
  const mesh = findFirstMesh(object);
  const fromMesh = mesh?.userData?.sdfGrid ?? object.userData?.sdfGrid ?? mesh?.geometry?.userData?.sdfGrid;
  return isSdfGrid(fromMesh) ? fromMesh : null;
}

const convertCache = new WeakMap<PolyMesh, { key: string; grid: SdfGrid | null }>();

/** A mesh's SDF at a given resolution, memoised per PolyMesh. */
function convertedSdf(mesh: PolyMesh, resolution: number): SdfGrid | null {
  const key = `r${resolution}`;
  const hit = convertCache.get(mesh);
  if (hit && hit.key === key) return hit.grid;
  const grid = meshToSdf(mesh, { resolution, padding: 0, band: 3 })?.grid ?? null;
  convertCache.set(mesh, { key, grid });
  return grid;
}

interface VolumeInput {
  inputObj: THREE.Object3D;
  srcMesh: THREE.Mesh;
  poly: PolyMesh;
  /** Its SDF: carried, or converted from the mesh. */
  grid: SdfGrid | null;
  converted: boolean;
  world: THREE.Matrix4;
}

function readVolumeInput(value: unknown, resolution: number, needGrid: boolean): VolumeInput | null {
  if (!(value instanceof THREE.Object3D)) return null;
  const read = readPolyMesh(value);
  if (!read) return null;
  const carried = readSdfGrid(value);
  let grid = carried;
  let converted = false;
  if (!grid && needGrid) {
    grid = convertedSdf(read.mesh, resolution);
    converted = Boolean(grid);
  }
  return { inputObj: value, srcMesh: read.srcMesh, poly: read.mesh, grid, converted, world: worldMatrixOf(read.srcMesh) };
}

function objectSignature(value: unknown): string {
  if (!(value instanceof THREE.Object3D)) return valueSignature(value);
  const grid = readSdfGrid(value);
  return grid ? `${sdfSignature(grid)}@${valueSignature(worldMatrixOf(findFirstMesh(value) ?? value))}` : valueSignature(value);
}

// ---------------------------------------------------------------- params

function num(raw: unknown, fallback: number): number {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function vec(raw: unknown): Vec3 | null {
  if (raw instanceof THREE.Vector3) return [raw.x, raw.y, raw.z];
  if (Array.isArray(raw) && raw.length >= 3) {
    const v = [Number(raw[0]), Number(raw[1]), Number(raw[2])];
    return v.every(Number.isFinite) ? (v as Vec3) : null;
  }
  if (raw && typeof raw === "object" && "x" in raw && "y" in raw && "z" in raw) {
    const r = raw as { x: unknown; y: unknown; z: unknown };
    const v = [Number(r.x), Number(r.y), Number(r.z)];
    return v.every(Number.isFinite) ? (v as Vec3) : null;
  }
  return null;
}

const SIZING_FIELDS: ParamFieldDef[] = [
  { id: "sizing", label: "Size By", kind: "select", options: ["resolution", "voxel"], optionLabels: ["Resolution (cells)", "Voxel Size"], group: "Grid" },
  { id: "resolution", label: "Resolution (longest side)", kind: "number", step: 1, group: "Grid" },
  { id: "voxel", label: "Voxel Size", kind: "number", step: 0.005, group: "Grid" },
  { id: "padding", label: "Padding", kind: "number", step: 0.05, group: "Grid" },
  { id: "band", label: "Exact Band (voxels)", kind: "number", step: 0.5, group: "Grid" },
];
const SIZING_DEFAULTS = { sizing: "resolution", resolution: 48, voxel: 0.05, padding: 0.1, band: 3 };

function sizing(p: (id: string, fb: number) => number, s: (id: string, fb: string) => string) {
  const byVoxel = s("sizing", "resolution") === "voxel";
  return {
    voxel: byVoxel ? Math.max(1e-4, p("voxel", 0.05)) : undefined,
    resolution: Math.max(4, Math.min(128, Math.round(p("resolution", 48)))),
    padding: Math.max(0, p("padding", 0.1)),
    band: Math.max(1.5, Math.min(16, p("band", 3))),
  };
}

// ---------------------------------------------------------------- node scaffolding

interface VolumeRun {
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
  ctx: EvalContext;
  num(id: string, fallback: number): number;
  str(id: string, fallback: string): string;
  bool(id: string, fallback: boolean): boolean;
  /** The primary geometry input (null for a node whose primary input is optional and absent). */
  primary: VolumeInput | null;
  /** Another geometry input's SDF, resolved into the primary's frame. */
  otherSdf(id: string): { grid: SdfGrid; frames?: Parameters<typeof combineSdf>[4]; converted: boolean } | null;
  note(text: string, warn?: boolean): void;
}

interface VolumeResult {
  /** The grid to carry downstream (null: a plain mesh output). */
  grid: SdfGrid | null;
  /** The surface to show / output. */
  mesh: PolyMesh;
  outputs?: Record<string, unknown>;
}

interface VolumeSpec {
  type: string;
  label: string;
  /** How the "geometry" input is read: as an SDF (converted if needed), as a mesh, or optional. */
  primary: "sdf" | "mesh" | "optional";
  inputs?: SocketDef[];
  outputs?: SocketDef[];
  defaultParams: Record<string, unknown>;
  paramFields: ParamFieldDef[];
  build(run: VolumeRun): VolumeResult;
}

interface VolumeState {
  object?: THREE.Mesh;
  signature?: string;
  grid?: SdfGrid | null;
  outputs?: Record<string, unknown>;
}

const states = createNodeCache<VolumeState>((s) => {
  if (s.object) disposeObject3D(s.object);
});
const statuses = new Map<string, { text: string; warn: boolean }[]>();

/** Status lines of a node's last build (tests, panel). */
export function volumeNodeStatus(nodeId: string): { text: string; warn: boolean }[] | undefined {
  return statuses.get(nodeId);
}

const defaultMaterial = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.6 });

/** Extracts the zero surface for the viewport — the volume's preview. */
export function previewOf(grid: SdfGrid): PolyMesh {
  return sdfToPolyMesh(grid, { iso: 0, relax: 0 });
}

function defineVolumeNode(spec: VolumeSpec): NodeDefinition {
  const extraOutputs = spec.outputs ?? [];
  return {
    type: spec.type,
    label: spec.label,
    category: "volume",
    inputs: [{ id: "geometry", label: spec.primary === "mesh" ? "Mesh" : spec.primary === "optional" ? "Points (Geometry)" : "SDF", type: "geometry", owns: true }, ...(spec.inputs ?? [])],
    outputs: [{ id: "geometry", label: spec.primary === "mesh" || spec.type === "volume/sdf-to-mesh" ? "Mesh" : "SDF", type: "geometry" }, { id: "matrix", label: "Matrix", type: "matrix" }, ...extraOutputs],
    defaultParams: spec.defaultParams,
    paramFields: spec.paramFields,
    dynamicParamFields: (instance: NodeInstance) => [...spec.paramFields, ...statusFields(instance.id)],
    evaluate: (inputs, params, ctx) => {
      const empty = () => ({ geometry: null, matrix: new THREE.Matrix4(), ...Object.fromEntries(extraOutputs.map((o) => [o.id, o.type === "list" ? [] : 0])) });
      const param = (id: string) => (inputs[id] !== undefined ? inputs[id] : params[id] !== undefined ? params[id] : spec.defaultParams[id]);
      const getNum = (id: string, fb: number) => num(param(id), fb);
      const getStr = (id: string, fb: string) => {
        const v = param(id);
        return v === undefined || v === null ? fb : String(v);
      };
      const getBool = (id: string, fb: boolean) => {
        const v = param(id);
        return v === undefined ? fb : typeof v === "number" ? v !== 0 : Boolean(v);
      };
      const resolution = Math.max(4, Math.min(128, Math.round(getNum("resolution", 48))));

      const primary = spec.primary === "optional" && !(inputs.geometry instanceof THREE.Object3D) ? null : readVolumeInput(inputs.geometry, resolution, spec.primary === "sdf");
      if (spec.primary !== "optional" && !primary) {
        statuses.set(ctx.nodeId, [{ text: inputs.geometry ? "The input has no mesh" : "Connect a geometry", warn: Boolean(inputs.geometry) }]);
        return inputs.geometry instanceof THREE.Object3D ? { ...primitiveOutputs(inputs.geometry), ...empty(), geometry: inputs.geometry } : empty();
      }

      let state = states.get(ctx.nodeId);
      if (!state) states.set(ctx.nodeId, (state = {}));

      const parts: string[] = [spec.type];
      if (primary) parts.push(primary.grid && !primary.converted ? sdfSignature(primary.grid) : quadMeshSignature(primary.poly));
      for (const key of Object.keys(params).sort()) parts.push(`${key}=${valueSignature(params[key])}`);
      for (const socket of spec.inputs ?? []) parts.push(`${socket.id}<${objectSignature(inputs[socket.id])}`);
      if (spec.inputs?.some((s) => s.type === "geometry") && primary) parts.push(`pose=${valueSignature(primary.world)}`);
      if (spec.primary === "optional" && primary) parts.push(`pose=${valueSignature(primary.world)}`);
      const signature = parts.join("|");

      const finish = (object: THREE.Mesh, grid: SdfGrid | null, outputs: Record<string, unknown>, geometry?: THREE.BufferGeometry) => {
        let out: Record<string, unknown>;
        if (primary) {
          out = emitModifiedMesh(object, { inputObj: primary.inputObj, srcMesh: primary.srcMesh, geometry, nodeId: ctx.nodeId });
        } else {
          if (geometry && geometry !== object.geometry) {
            object.geometry?.dispose();
            object.geometry = geometry;
          }
          object.material = defaultMaterial;
          object.matrixAutoUpdate = false;
          object.matrix.identity();
          object.userData = { nodeId: ctx.nodeId };
          out = primitiveOutputs(object);
        }
        // emitModifiedMesh copied the source's userData, which may hold the
        // upstream grid: replace it with ours (or drop it for a plain mesh).
        if (grid) object.userData.sdfGrid = grid;
        else delete object.userData.sdfGrid;
        return { ...out, ...outputs };
      };

      if (state.object && state.signature === signature) return finish(state.object, state.grid ?? null, state.outputs ?? {});

      const lines: { text: string; warn: boolean }[] = [];
      const note = (text: string, warn = false) => lines.push({ text, warn });
      if (primary?.converted) note(`Input is a plain mesh: converted at ${resolution} cells`);
      const run: VolumeRun = {
        inputs,
        params,
        ctx,
        num: getNum,
        str: getStr,
        bool: getBool,
        primary,
        note,
        otherSdf: (id) => {
          const other = readVolumeInput(inputs[id], resolution, true);
          if (!other?.grid) return null;
          if (!primary) return { grid: other.grid, converted: other.converted };
          // A-local → B-local, and B's distances back into A's units.
          const aToB = other.world.clone().invert().multiply(primary.world);
          const e = aToB.elements;
          if (e.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9)) return { grid: other.grid, converted: other.converted };
          const det = Math.abs(aToB.determinant());
          const scale = det > 1e-12 ? 1 / Math.cbrt(det) : 1;
          const bToA = aToB.clone().invert();
          const t = new THREE.Vector3();
          return {
            grid: other.grid,
            converted: other.converted,
            frames: {
              aToB: {
                scale,
                apply(x, y, z, out) {
                  t.set(x, y, z).applyMatrix4(aToB);
                  out[0] = t.x;
                  out[1] = t.y;
                  out[2] = t.z;
                },
              },
              bToA: (p) => {
                const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(bToA);
                return [v.x, v.y, v.z];
              },
            },
          };
        },
      };

      let result: VolumeResult;
      try {
        result = spec.build(run);
      } catch (e) {
        note(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
        console.warn(`${spec.label}:`, e);
        result = { grid: primary?.grid ?? null, mesh: primary?.poly ?? { positions: [], faces: [] } };
      }
      if (result.grid) note(`Grid ${result.grid.dims.join(" × ")}, voxel ${result.grid.voxel.toPrecision(3)}`);
      note(`${result.mesh.positions.length} points, ${result.mesh.faces.length} faces`);
      statuses.set(ctx.nodeId, lines);

      if (!state.object) state.object = createModifierMesh();
      const geometry = polyMeshToGeometry(result.mesh);
      state.signature = signature;
      state.grid = result.grid;
      state.outputs = result.outputs ?? {};
      return finish(state.object, result.grid, state.outputs, geometry);
    },
  };
}

function statusFields(nodeId: string): ParamFieldDef[] {
  const lines = statuses.get(nodeId);
  if (!lines) return [];
  return lines.map((line, i) => ({
    id: `_status${i}`,
    label: (line.warn ? "⚠ " : "") + line.text,
    kind: "note" as const,
    ...(line.warn ? { tone: "warn" as const } : {}),
    group: "Status",
  }));
}

function cappedNote(run: VolumeRun, capped: boolean) {
  if (capped) run.note("Grid capped at 128³ samples: the voxel was enlarged", true);
}

const GRID_OUTPUTS: SocketDef[] = [{ id: "voxel", label: "Voxel Size", type: "value" }];

// ============================================================ 1. Mesh to SDF

export const MESH_TO_SDF_NODE = defineVolumeNode({
  type: "volume/mesh-to-sdf",
  label: "Mesh to SDF",
  primary: "mesh",
  outputs: GRID_OUTPUTS,
  defaultParams: { ...SIZING_DEFAULTS, sign: "solid", thickness: 0.02 },
  paramFields: [
    ...SIZING_FIELDS,
    { id: "sign", label: "Inside", kind: "select", options: ["solid", "shell"], optionLabels: ["Solid (closed mesh)", "Shell (open mesh, thickness)"], group: "Distance" },
    { id: "thickness", label: "Shell Thickness", kind: "number", step: 0.005, group: "Distance" },
  ],
  build(run) {
    const opts = sizing(run.num, run.str);
    const sign = run.str("sign", "solid") === "shell" ? "shell" : "solid";
    const res = meshToSdf(run.primary!.poly, { ...opts, sign, thickness: Math.max(0, run.num("thickness", 0.02)) });
    if (!res) {
      run.note("The mesh has no faces", true);
      return { grid: null, mesh: { positions: [], faces: [] }, outputs: { voxel: 0 } };
    }
    cappedNote(run, res.capped);
    return { grid: res.grid, mesh: previewOf(res.grid), outputs: { voxel: res.grid.voxel } };
  },
});

// ============================================================ 2. Points to SDF

function pointsFromList(raw: unknown): Vec3[] {
  if (!Array.isArray(raw)) return [];
  const out: Vec3[] = [];
  for (const item of raw) {
    const v = vec(item);
    if (v) out.push(v);
  }
  return out;
}

export const POINTS_TO_SDF_NODE = defineVolumeNode({
  type: "volume/points-to-sdf",
  label: "Points to SDF",
  primary: "optional",
  inputs: [
    { id: "points", label: "Points (Vector List)", type: "list" },
    { id: "radii", label: "Radii (List)", type: "list" },
    { id: "radius", label: "Radius", type: "value" },
  ],
  outputs: [...GRID_OUTPUTS, { id: "count", label: "Point Count", type: "value" }],
  defaultParams: { ...SIZING_DEFAULTS, radius: 0.1, usePscale: true, group: "" },
  paramFields: [
    { id: "radius", label: "Radius", kind: "number", step: 0.01, group: "Spheres" },
    { id: "usePscale", label: "Scale by pscale attribute", kind: "boolean", group: "Spheres" },
    { id: "group", label: "Point Group", kind: "text", group: "Spheres", help: "group", domain: "point" },
    ...SIZING_FIELDS,
  ],
  build(run) {
    const radius = Math.max(0, run.num("radius", 0.1));
    const xyz: number[] = [];
    const radii: number[] = [];
    const primary = run.primary;
    if (primary) {
      const mesh = primary.poly;
      const g = evaluateGroup(mesh, "point", run.str("group", ""));
      if (g.error) run.note(`Group: ${g.error}`, true);
      const pscale = run.bool("usePscale", true) ? readAttribute(mesh, "point", "pscale") : null;
      for (const i of maskIndices(g.mask)) {
        const p = mesh.positions[i];
        xyz.push(p[0], p[1], p[2]);
        const s = pscale ? pscale.values[i * pscale.size] : 1;
        radii.push(radius * (Number.isFinite(s) ? s : 1));
      }
    }
    // List points are world positions: bring them into the geometry's frame.
    const list = pointsFromList(run.inputs.points);
    const listRadii = Array.isArray(run.inputs.radii) ? run.inputs.radii.map((r) => num(r, radius)) : null;
    const toLocal = primary ? primary.world.clone().invert() : null;
    const v = new THREE.Vector3();
    list.forEach((p, i) => {
      v.set(p[0], p[1], p[2]);
      if (toLocal) v.applyMatrix4(toLocal);
      xyz.push(v.x, v.y, v.z);
      radii.push(listRadii && i < listRadii.length ? Math.max(0, listRadii[i]) : radius);
    });
    const count = radii.length;
    if (!count) {
      run.note("No points: connect a geometry or a vector list", true);
      return { grid: null, mesh: { positions: [], faces: [] }, outputs: { voxel: 0, count: 0 } };
    }
    if (count > 200_000) run.note(`${count} points: this will be slow`, true);
    const res = pointsToSdf(xyz, radii, sizing(run.num, run.str));
    if (!res) {
      run.note("Every radius is zero", true);
      return { grid: null, mesh: { positions: [], faces: [] }, outputs: { voxel: 0, count } };
    }
    cappedNote(run, res.capped);
    return { grid: res.grid, mesh: previewOf(res.grid), outputs: { voxel: res.grid.voxel, count } };
  },
});

// ============================================================ 3. SDF Combine

export const SDF_COMBINE_OPS: SdfCombineOp[] = ["union", "subtract", "intersect"];

export const SDF_COMBINE_NODE = defineVolumeNode({
  type: "volume/combine",
  label: "SDF Combine",
  primary: "sdf",
  inputs: [
    { id: "b", label: "SDF B", type: "geometry", owns: true },
    { id: "smooth", label: "Smooth Radius", type: "value" },
  ],
  outputs: GRID_OUTPUTS,
  defaultParams: { operation: "union", smooth: 0, resolution: 48 },
  paramFields: [
    { id: "operation", label: "Operation", kind: "select", options: SDF_COMBINE_OPS, optionLabels: ["Union (A + B)", "Subtract (A − B)", "Intersect (A ∩ B)"] },
    { id: "smooth", label: "Smooth Radius", kind: "number", step: 0.01 },
    { id: "resolution", label: "Resolution (plain mesh inputs)", kind: "number", step: 1 },
  ],
  build(run) {
    const a = run.primary!.grid;
    const b = run.otherSdf("b");
    if (!a) {
      run.note("A has no volume", true);
      return { grid: null, mesh: run.primary!.poly };
    }
    if (!b) {
      run.note("Connect B: passing A through");
      return { grid: a, mesh: previewOf(a), outputs: { voxel: a.voxel } };
    }
    const op = (SDF_COMBINE_OPS as string[]).includes(run.str("operation", "union")) ? (run.str("operation", "union") as SdfCombineOp) : "union";
    const res = combineSdf(a, b.grid, op, Math.max(0, run.num("smooth", 0)), b.frames);
    cappedNote(run, res.capped);
    return { grid: res.grid, mesh: previewOf(res.grid), outputs: { voxel: res.grid.voxel } };
  },
});

// ============================================================ 4. SDF Offset

export const SDF_OFFSET_NODE = defineVolumeNode({
  type: "volume/offset",
  label: "SDF Offset",
  primary: "sdf",
  inputs: [{ id: "distance", label: "Distance", type: "value" }],
  outputs: GRID_OUTPUTS,
  defaultParams: { distance: 0.05, resolution: 48 },
  paramFields: [
    { id: "distance", label: "Distance (+ dilate, − erode)", kind: "number", step: 0.01 },
    { id: "resolution", label: "Resolution (plain mesh input)", kind: "number", step: 1 },
  ],
  build(run) {
    const grid = run.primary!.grid;
    if (!grid) return { grid: null, mesh: run.primary!.poly };
    const res = offsetSdf(grid, run.num("distance", 0.05));
    cappedNote(run, res.capped);
    return { grid: res.grid, mesh: previewOf(res.grid), outputs: { voxel: res.grid.voxel } };
  },
});

// ============================================================ 5. SDF Smooth

export const SDF_SMOOTH_NODE = defineVolumeNode({
  type: "volume/smooth",
  label: "SDF Smooth",
  primary: "sdf",
  inputs: [{ id: "iterations", label: "Iterations", type: "value" }],
  outputs: GRID_OUTPUTS,
  defaultParams: { iterations: 2, resolution: 48 },
  paramFields: [
    { id: "iterations", label: "Blur Iterations", kind: "number", step: 1 },
    { id: "resolution", label: "Resolution (plain mesh input)", kind: "number", step: 1 },
  ],
  build(run) {
    const grid = run.primary!.grid;
    if (!grid) return { grid: null, mesh: run.primary!.poly };
    const out = smoothSdf(grid, run.num("iterations", 2));
    return { grid: out, mesh: previewOf(out), outputs: { voxel: out.voxel } };
  },
});

// ============================================================ 6. SDF Noise

export const SDF_NOISE_NODE = defineVolumeNode({
  type: "volume/noise",
  label: "SDF Noise",
  primary: "sdf",
  inputs: [
    { id: "amplitude", label: "Amplitude", type: "value" },
    { id: "frequency", label: "Frequency", type: "value" },
    { id: "offset", label: "Offset", type: "vector" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: GRID_OUTPUTS,
  defaultParams: { amplitude: 0.05, frequency: 4, octaves: 3, seed: 0, offset: new THREE.Vector3(), resolution: 48 },
  paramFields: [
    { id: "amplitude", label: "Amplitude", kind: "number", step: 0.005 },
    { id: "frequency", label: "Frequency", kind: "number", step: 0.1 },
    { id: "octaves", label: "Octaves", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "offset", label: "Offset", kind: "vector", step: 0.1 },
    { id: "resolution", label: "Resolution (plain mesh input)", kind: "number", step: 1 },
  ],
  build(run) {
    const grid = run.primary!.grid;
    if (!grid) return { grid: null, mesh: run.primary!.poly };
    const res = noiseSdf(grid, {
      amplitude: run.num("amplitude", 0.05),
      frequency: run.num("frequency", 4),
      octaves: run.num("octaves", 3),
      seed: run.num("seed", 0),
      offset: vec(run.inputs.offset ?? run.params.offset) ?? [0, 0, 0],
    });
    cappedNote(run, res.capped);
    return { grid: res.grid, mesh: previewOf(res.grid), outputs: { voxel: res.grid.voxel } };
  },
});

// ============================================================ 7. SDF to Mesh

export const SDF_TO_MESH_NODE = defineVolumeNode({
  type: "volume/sdf-to-mesh",
  label: "SDF to Mesh",
  primary: "sdf",
  inputs: [{ id: "iso", label: "Iso Value", type: "value" }],
  outputs: [{ id: "faces", label: "Face Count", type: "value" }],
  defaultParams: { iso: 0, relax: 2, resolution: 48 },
  paramFields: [
    { id: "iso", label: "Iso Value", kind: "number", step: 0.005 },
    { id: "relax", label: "Relax Iterations", kind: "number", step: 1 },
    { id: "_adaptivity", label: "Adaptivity: none — uniform quads, one per crossed voxel edge", kind: "note" },
    { id: "resolution", label: "Resolution (plain mesh input)", kind: "number", step: 1 },
  ],
  build(run) {
    const grid = run.primary!.grid;
    if (!grid) return { grid: null, mesh: run.primary!.poly, outputs: { faces: 0 } };
    const mesh = sdfToPolyMesh(grid, { iso: run.num("iso", 0), relax: run.num("relax", 2) });
    if (!mesh.faces.length) run.note("No surface at this iso value", true);
    return { grid: null, mesh, outputs: { faces: mesh.faces.length } };
  },
});

// ============================================================ 8. Voxel Remesh

export const VOXEL_REMESH_NODE = defineVolumeNode({
  type: "volume/voxel-remesh",
  label: "Voxel Remesh",
  primary: "mesh",
  inputs: [{ id: "voxel", label: "Voxel Size", type: "value" }],
  outputs: [{ id: "faces", label: "Face Count", type: "value" }],
  defaultParams: { sizing: "voxel", voxel: 0.05, resolution: 48, relax: 2, offset: 0, transfer: true, sign: "solid", thickness: 0.02 },
  paramFields: [
    { id: "sizing", label: "Size By", kind: "select", options: ["voxel", "resolution"], optionLabels: ["Voxel Size", "Resolution (cells)"] },
    { id: "voxel", label: "Voxel Size", kind: "number", step: 0.005 },
    { id: "resolution", label: "Resolution (longest side)", kind: "number", step: 1 },
    { id: "offset", label: "Offset", kind: "number", step: 0.005 },
    { id: "relax", label: "Relax Iterations", kind: "number", step: 1 },
    { id: "transfer", label: "Transfer Attributes (nearest)", kind: "boolean" },
    { id: "sign", label: "Inside", kind: "select", options: ["solid", "shell"], optionLabels: ["Solid (closed mesh)", "Shell (open mesh, thickness)"] },
    { id: "thickness", label: "Shell Thickness", kind: "number", step: 0.005 },
  ],
  build(run) {
    const src = run.primary!.poly;
    const byVoxel = run.str("sizing", "voxel") === "voxel";
    const offset = run.num("offset", 0);
    const res = meshToSdf(src, {
      voxel: byVoxel ? Math.max(1e-4, run.num("voxel", 0.05)) : undefined,
      resolution: Math.max(4, Math.min(128, Math.round(run.num("resolution", 48)))),
      padding: Math.max(0, offset),
      band: 3,
      sign: run.str("sign", "solid") === "shell" ? "shell" : "solid",
      thickness: Math.max(0, run.num("thickness", 0.02)),
    });
    if (!res) {
      run.note("The mesh has no faces", true);
      return { grid: null, mesh: src, outputs: { faces: src.faces.length } };
    }
    cappedNote(run, res.capped);
    let mesh = sdfToPolyMesh(res.grid, { iso: offset, relax: run.num("relax", 2) });
    if (!mesh.faces.length) {
      run.note("Remesh produced nothing (open mesh? try Inside: Shell)", true);
      return { grid: null, mesh: src, outputs: { faces: src.faces.length } };
    }
    if (run.bool("transfer", true)) mesh = transferByNearest(src, mesh);
    return { grid: null, mesh, outputs: { faces: mesh.faces.length } };
  },
});

export const VOLUME_NODES: NodeDefinition[] = [
  MESH_TO_SDF_NODE,
  POINTS_TO_SDF_NODE,
  SDF_COMBINE_NODE,
  SDF_OFFSET_NODE,
  SDF_SMOOTH_NODE,
  SDF_NOISE_NODE,
  SDF_TO_MESH_NODE,
  VOXEL_REMESH_NODE,
];
