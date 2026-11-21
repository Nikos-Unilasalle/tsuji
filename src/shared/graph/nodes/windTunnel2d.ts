import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { stepsSince } from "../clock";
import { toBoolean } from "../sockets";
import { worldMatrixOf } from "../objectPosition";
import { numberInput } from "./object";
import { asVec, hashNumbers } from "./voronoi2dShared";
import {
  createLbm2D, Lbm2D, pressureCoefficient, sampleVelocity, setReynolds, setSolid, stepLbm2D, U_LATTICE,
} from "../../three/fluid/lbm2d";
import {
  createLbm2DGPU, isLbmGPUSupported, Lbm2DGPU, setReynoldsGPU, setSolidGPU, stepLbm2DGPU,
} from "../../three/fluid/lbm2dGPU";
import {
  bounds, chainSegments, fromCell, fromFrame, Grid, isClosed, rasterise, sliceObject, toCell, TunnelFrame, V2,
} from "../../three/fluid/tunnelSection";

/**
 * Wind Tunnel 2D — a lattice Boltzmann wind tunnel in a slice of the scene.
 *
 * The obstacle geometry (a wing, a profile, a building…) is cut by a plane;
 * the cut becomes the obstacle of a 2D flow at the Reynolds number asked for,
 * with the wind along a chosen axis, tilted by the angle of attack. Everything
 * the flow produces is drawn back in 3D, in the slice: the field (vorticity,
 * speed or pressure) on a plane, tracers carried by the flow, streamlines,
 * pressure bars on the section and the lift / drag arrows.
 *
 * Slice Count > 1 stacks slices from Station From to Station To (or a list
 * of stations wired into Station), each its own flow on its own local chord,
 * like a scanner along a wing. The lift arrows' tips are joined into the
 * spanwise lift curve, and Cl / Cd come out per slice and chord-weighted for
 * the whole stack.
 *
 * Reynolds number Re = U·c/ν. With one slice it is on that slice's chord.
 * With several, "Same Airspeed" (default) gives every slice the same wind, so
 * Re scales with the local chord (the Reynolds number set is the one of the
 * mean chord); "Same Reynolds" gives every slice the number set. The airspeed
 * it means for a real object follows from the scene's unit and the fluid's
 * viscosity (air: 1.5e-5 m²/s), and comes out as Airspeed.
 *
 * The flow advances while the timeline plays, or all at once with Compute;
 * it runs on the GPU when it can (lbm2dGPU.ts), on the CPU otherwise.
 */

type Field = "vorticity" | "speed" | "pressure";
const FIELDS: Field[] = ["vorticity", "speed", "pressure"];
const AXES = ["X", "Y", "Z"] as const;
const FLOW_AXES = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] as const;
/** CPU steps per frame are capped: the CPU solver runs at ~25 M cells/s. */
const CPU_MAX_STEPS = 8;
const MAX_CELLS = 400_000;
/** Slices per node: each holds its own solver (~15 MB of GPU memory at the default resolution). */
const MAX_SLICES = 32;
/** CPU Compute is capped (≈ 25 M cells/s): it exists for headless runs and tests. */
const CPU_MAX_COMPUTE = 3000;

/** The Compute button's action (App.tsx bumps `computeRequest`). */
export const WIND_TUNNEL_COMPUTE_ACTION = "windTunnel2d.compute";
/** Same, for every Wind Tunnel 2D node of the canvas. */
export const WIND_TUNNEL_COMPUTE_ALL_ACTION = "windTunnel2d.computeAll";

/** One slice: its section, its solver and what it draws. */
interface SliceState {
  backend: "gpu" | "cpu";
  sim: Lbm2D | Lbm2DGPU | null;
  gridKey: string;
  sliceKey: string;
  /** Section in the un-tilted frame (angle of attack 0). */
  baseChains: V2[][];
  chord: number;
  maskKey: string;
  group: THREE.Group;
  fieldMesh: THREE.Mesh;
  fieldTex: THREE.DataTexture | null;
  tracers: THREE.Points;
  tracerPos: Float32Array;
  tracerAge: Float32Array;
  streamLines: THREE.LineSegments;
  pressureBars: THREE.LineSegments;
  liftArrow: THREE.ArrowHelper;
  dragArrow: THREE.ArrowHelper;
  seed: number;
}

interface TunnelState {
  group: THREE.Group;
  slices: SliceState[];
  liftCurve: THREE.Line;
  lastStep: number;
  epoch: number;
  lastCompute: number;
}

function disposeSlice(s: SliceState): void {
  if (s.sim && "dispose" in s.sim) s.sim.dispose();
  s.sim = null;
  s.fieldTex?.dispose();
  s.group.removeFromParent();
  disposeObject3D(s.group);
}

const tunnelCache = createNodeCache<TunnelState>((s) => {
  s.slices.forEach(disposeSlice);
  disposeObject3D(s.group);
});

function createSlice(): SliceState {
  const group = new THREE.Group();
  const fieldMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false }),
  );
  fieldMesh.renderOrder = 1;
  fieldMesh.matrixAutoUpdate = false;
  const tracers = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0xe5e7eb, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false }),
  );
  tracers.frustumCulled = false;
  tracers.renderOrder = 2;
  const streamLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
  streamLines.frustumCulled = false;
  const pressureBars = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
  pressureBars.frustumCulled = false;
  const liftArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0x22c55e);
  const dragArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xef4444);
  group.add(fieldMesh, tracers, streamLines, pressureBars, liftArrow, dragArrow);
  return {
    backend: "cpu", sim: null, gridKey: "", sliceKey: "", baseChains: [], chord: 0, maskKey: "",
    group, fieldMesh, fieldTex: null, tracers, tracerPos: new Float32Array(0), tracerAge: new Float32Array(0),
    streamLines, pressureBars, liftArrow, dragArrow, seed: 1,
  };
}

const axisVector = (a: string): THREE.Vector3 => {
  const sign = a.startsWith("-") ? -1 : 1;
  const k = a.replace(/[+-]/, "");
  return new THREE.Vector3(k === "X" ? sign : 0, k === "Y" ? sign : 0, k === "Z" ? sign : 0);
};

/** Meshes, geometries and point lists out of whatever was wired in (a single object or a list of them). */
function collectObstacles(value: unknown): { objects: (THREE.Object3D | THREE.BufferGeometry)[]; lines: THREE.Vector3[][] } {
  const objects: (THREE.Object3D | THREE.BufferGeometry)[] = [];
  const lines: THREE.Vector3[][] = [];
  const visit = (v: unknown) => {
    if (v instanceof THREE.Object3D || v instanceof THREE.BufferGeometry) objects.push(v);
    else if (Array.isArray(v)) {
      if (v.length > 0 && asVec(v[0])) lines.push(v.map(asVec).filter((p): p is THREE.Vector3 => p !== null));
      else v.forEach(visit);
    }
  };
  visit(value);
  return { objects, lines };
}

/** What the slice depends on: geometry identities and versions, world matrices. */
function obstacleSignature(objects: (THREE.Object3D | THREE.BufferGeometry)[], lines: THREE.Vector3[][]): number {
  const nums: number[] = [];
  const geo = (g: THREE.BufferGeometry) => {
    const p = g.getAttribute("position") as THREE.BufferAttribute | undefined;
    nums.push(g.id, p?.version ?? -1, p?.count ?? 0);
  };
  for (const o of objects) {
    if (o instanceof THREE.BufferGeometry) geo(o);
    else o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || !c.visible) return;
      geo(m.geometry);
      nums.push(...worldMatrixOf(c).elements);
    });
  }
  for (const l of lines) for (const p of l) nums.push(p.x, p.y, p.z);
  return hashNumbers(nums);
}

// ---- Colour maps ----------------------------------------------------------------------------
/** Writes RGB; returns |t| clamped to 1, used to fade calm air out. */
function diverging(t: number, out: Uint8Array, o: number): number {
  // Blue (−) → white → red (+).
  const x = Math.max(-1, Math.min(1, t));
  const a = Math.abs(x);
  if (x < 0) { out[o] = 255 * (1 - 0.85 * a); out[o + 1] = 255 * (1 - 0.6 * a); out[o + 2] = 255; }
  else { out[o] = 255; out[o + 1] = 255 * (1 - 0.7 * a); out[o + 2] = 255 * (1 - 0.85 * a); }
  return a;
}
const SEQ: [number, number, number][] = [[13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137], [219, 92, 104], [244, 136, 73], [254, 188, 43], [240, 249, 33]];
function sequential(t: number, out: Uint8Array, o: number) {
  // Plasma-like: dark blue (still air) → yellow (fast).
  const x = Math.max(0, Math.min(1, t)) * (SEQ.length - 1);
  const i = Math.min(SEQ.length - 2, Math.floor(x));
  const f = x - i;
  for (let k = 0; k < 3; k++) out[o + k] = SEQ[i][k] + (SEQ[i + 1][k] - SEQ[i][k]) * f;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A boolean param: checkboxes store 1 / 0, presets and code may store true / false. */
function flag(value: unknown, fallback: boolean): boolean {
  return value === undefined || value === null ? fallback : toBoolean(value);
}

function isSolidAt(s: Lbm2D | Lbm2DGPU, x: number, y: number): boolean {
  const i = Math.round(x), j = Math.round(y);
  if (i < 0 || j < 0 || i >= s.nx || j >= s.ny) return true;
  return s.solid[j * s.nx + i] === 1;
}

/** RK2 through the velocity field; `h` is the step in cells. */
function advect(s: Lbm2D | Lbm2DGPU, x: number, y: number, h: number): V2 {
  const [u1, v1] = sampleVelocity(s, x, y);
  const k = h / U_LATTICE;
  const [u2, v2] = sampleVelocity(s, x + 0.5 * k * u1, y + 0.5 * k * v1);
  return [x + k * u2, y + k * v2];
}

const PARAM_FIELDS: ParamFieldDef[] = [
  { id: "sliceAxis", label: "Slice Normal Axis", kind: "select", options: [...AXES], group: "Tunnel" },
  { id: "sliceCount", label: "Slice Count", kind: "number", step: 1, group: "Tunnel" },
  { id: "station", label: "Station (1 slice: position on that axis)", kind: "number", step: 0.05, group: "Tunnel" },
  { id: "stationFrom", label: "Station From (several slices)", kind: "number", step: 0.05, group: "Tunnel" },
  { id: "stationTo", label: "Station To (several slices)", kind: "number", step: 0.05, group: "Tunnel" },
  { id: "flowAxis", label: "Wind Direction", kind: "select", options: [...FLOW_AXES], group: "Tunnel" },
  { id: "angle", label: "Angle of Attack", kind: "number", step: 1, group: "Tunnel" },
  { id: "reynolds", label: "Reynolds Number (on the chord)", kind: "number", step: 100, group: "Tunnel" },
  {
    id: "reynoldsMode", label: "Several Slices", kind: "select", options: ["airspeed", "reynolds"],
    optionLabels: ["Same Airspeed (Re ∝ local chord)", "Same Reynolds Number"], group: "Tunnel",
  },
  { id: "cellsPerChord", label: "Resolution (cells per chord)", kind: "number", step: 8, group: "Tunnel" },
  { id: "upstream", label: "Upstream (chords)", kind: "number", step: 0.25, group: "Tunnel" },
  { id: "downstream", label: "Downstream (chords)", kind: "number", step: 0.25, group: "Tunnel" },
  { id: "height", label: "Height (chords)", kind: "number", step: 0.25, group: "Tunnel" },
  { id: "thickness", label: "Min Obstacle Thickness (cells)", kind: "number", step: 0.25, group: "Tunnel" },
  { id: "computeButton", label: "Compute (run until the flow settles)", kind: "button", action: WIND_TUNNEL_COMPUTE_ACTION, group: "Solver" },
  { id: "computeAllButton", label: "Compute All Tunnels", kind: "button", action: WIND_TUNNEL_COMPUTE_ALL_ACTION, group: "Solver" },
  { id: "computeChords", label: "Compute Length (chords of air travelled)", kind: "number", step: 1, group: "Solver" },
  { id: "simulate", label: "Simulate While Playing", kind: "boolean", group: "Solver" },
  { id: "stepsPerFrame", label: "Steps per Frame", kind: "number", step: 5, group: "Solver" },
  { id: "solver", label: "Solver", kind: "select", options: ["auto", "gpu", "cpu"], group: "Solver" },
  { id: "unitMeters", label: "Scene Unit (m)", kind: "number", step: 0.01, group: "Real World" },
  { id: "viscosity", label: "Kinematic Viscosity (m²/s, air 1.5e-5)", kind: "number", step: 0.000001, group: "Real World" },
  { id: "field", label: "Field", kind: "select", options: [...FIELDS], optionLabels: ["Vorticity", "Speed", "Pressure (Cp)"], group: "Display" },
  { id: "range", label: "Colour Range (ω·c/U, U/U∞ or Cp)", kind: "number", step: 0.5, group: "Display" },
  { id: "opacity", label: "Field Opacity", kind: "number", step: 0.05, group: "Display" },
  { id: "fadeCalm", label: "Fade Calm Air (vorticity, pressure)", kind: "boolean", group: "Display" },
  { id: "showField", label: "Show Field", kind: "boolean", group: "Display" },
  { id: "showTracers", label: "Show Tracers", kind: "boolean", group: "Display" },
  { id: "tracerCount", label: "Tracer Count (per slice)", kind: "number", step: 100, group: "Display" },
  { id: "showStreamlines", label: "Show Streamlines", kind: "boolean", group: "Display" },
  { id: "streamlineCount", label: "Streamline Count (per slice)", kind: "number", step: 2, group: "Display" },
  { id: "showPressure", label: "Show Pressure Bars", kind: "boolean", group: "Display" },
  { id: "pressureScale", label: "Pressure Bar Scale (chords per Cp)", kind: "number", step: 0.02, group: "Display" },
  { id: "showForces", label: "Show Lift / Drag (+ lift curve)", kind: "boolean", group: "Display" },
  { id: "forceScale", label: "Force Arrow Scale (chords per coeff.)", kind: "number", step: 0.1, group: "Display" },
];

/** Settings shared by every slice of a node, read once per evaluation. */
interface Shared {
  sliceAxis: string;
  flowAxis: string;
  angle: number;
  cellsPerChord: number;
  upstream: number;
  downstream: number;
  heightC: number;
  thickness: number;
  backend: "gpu" | "cpu";
  epoch: number;
  field: Field;
  range: number;
  opacity: number;
  params: Record<string, unknown>;
}

interface SliceResult {
  cl: number;
  cd: number;
  chord: number;
  streamlines: THREE.Vector3[][];
  section: THREE.Vector3[][];
  /** Lift arrow foot and tip (world). */
  liftFoot: THREE.Vector3;
  liftTip: THREE.Vector3;
}

/** The stations: a wired value or list, else Slice Count between From and To, else Station. */
function resolveStations(input: unknown, params: Record<string, unknown>): number[] {
  const fromList = (Array.isArray(input) ? input : []).map(Number).filter(Number.isFinite);
  if (fromList.length > 0) return fromList.slice(0, MAX_SLICES);
  if (typeof input === "number" && Number.isFinite(input)) return [input];
  const count = Math.max(1, Math.min(MAX_SLICES, Math.round(numberInput(undefined, params.sliceCount, 1))));
  if (count === 1) return [numberInput(undefined, params.station, 0)];
  const a = numberInput(undefined, params.stationFrom, -1);
  const b = numberInput(undefined, params.stationTo, 1);
  return Array.from({ length: count }, (_, i) => a + ((b - a) * i) / (count - 1));
}

function baseFrame(sh: Shared, station: number): TunnelFrame {
  const normal = axisVector(sh.sliceAxis);
  const flow = axisVector(sh.flowAxis);
  const up = new THREE.Vector3().crossVectors(flow, normal);
  return { origin: normal.clone().multiplyScalar(station), flow, up, normal };
}

/** Cuts the obstacle at this slice's station (cached on the obstacle and the plane). */
function updateSection(sl: SliceState, sh: Shared, station: number, objects: (THREE.Object3D | THREE.BufferGeometry)[], lines: THREE.Vector3[][], obstacleSig: number): void {
  const sliceKey = `${sh.sliceAxis}|${sh.flowAxis}|${station}|${obstacleSig}`;
  if (sliceKey === sl.sliceKey) return;
  sl.sliceKey = sliceKey;
  const base = baseFrame(sh, station);
  const segs = objects.flatMap((o) => sliceObject(o, base, (x) => worldMatrixOf(x)));
  const box = bounds(segs.map((s) => [s[0], s[1]]));
  const eps = box ? Math.max(1e-9, 1e-6 * Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1])) : 1e-9;
  const toBase = (p: THREE.Vector3): V2 => {
    const d = p.clone().sub(base.origin);
    return [d.dot(base.flow), d.dot(base.up)];
  };
  // Point lists are profiles already drawn in the slice plane: projected as they are.
  sl.baseChains = [...chainSegments(segs, eps), ...lines.map((l) => l.map(toBase))];
  const b = bounds(sl.baseChains);
  sl.chord = b ? b.max[0] - b.min[0] : 0;
}

/**
 * One slice's flow: grid, solver, obstacle mask, stepping (playback and
 * Compute), and everything it draws.
 */
function runSlice(
  sl: SliceState, sh: Shared, station: number, reynolds: number,
  ctx: { renderer?: THREE.WebGLRenderer },
  playSteps: number, computeSteps: number, tracerTicks: number,
): SliceResult {
  const params = sh.params;
  const base = baseFrame(sh, station);
  const a = (sh.angle * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  // Tilted frame (angle of attack): the wind comes from below the leading edge.
  const frame: TunnelFrame = {
    origin: base.origin,
    flow: base.flow.clone().multiplyScalar(ca).addScaledVector(base.up, sa),
    up: base.up.clone().multiplyScalar(ca).addScaledVector(base.flow, -sa),
    normal: base.normal,
  };
  const chains = sl.baseChains.map((l) => l.map(([x, y]): V2 => [x * ca + y * sa, -x * sa + y * ca]));
  const b = bounds(chains)!;
  const chord = sl.chord;
  let dx = chord / sh.cellsPerChord;
  const width = b.max[0] - b.min[0] + (sh.upstream + sh.downstream) * chord;
  const height = Math.max(b.max[1] - b.min[1] + chord, sh.heightC * chord);
  if ((width / dx) * (height / dx) > MAX_CELLS) dx = Math.sqrt((width * height) / MAX_CELLS);
  const nx = Math.ceil(width / dx), ny = Math.ceil(height / dx);
  const yc = (b.min[1] + b.max[1]) / 2;
  const grid: Grid = { nx, ny, x0: b.min[0] - sh.upstream * chord, y0: yc - (ny * dx) / 2, dx };
  const lengthCells = chord / dx;
  const backend = sh.backend;

  // ---- Solver ---------------------------------------------------------------------------------
  const gridKey = `${nx}x${ny}|${backend}|${sh.epoch}`;
  if (!sl.sim || gridKey !== sl.gridKey) {
    if (sl.sim && "dispose" in sl.sim) sl.sim.dispose();
    sl.sim = backend === "gpu"
      ? createLbm2DGPU(ctx.renderer!, nx, ny, lengthCells, reynolds)
      : createLbm2D(nx, ny, lengthCells, reynolds);
    sl.backend = backend;
    sl.gridKey = gridKey;
    sl.maskKey = "";
    sl.tracerPos = new Float32Array(0);
  }
  const sim = sl.sim;
  if (Math.abs(sim.reynolds - reynolds) > 1e-9 || Math.abs(sim.length - lengthCells) > 1e-9) {
    if (backend === "gpu") setReynoldsGPU(sim as Lbm2DGPU, reynolds, lengthCells);
    else setReynolds(sim as Lbm2D, reynolds, lengthCells);
  }
  const maskKey = `${sl.sliceKey}|${sh.angle}|${grid.x0}|${grid.y0}|${dx}|${sh.thickness}|${gridKey}`;
  if (maskKey !== sl.maskKey) {
    sl.maskKey = maskKey;
    const mask = rasterise(chains, grid, sh.thickness / 2, 1e-6 * chord);
    if (backend === "gpu") setSolidGPU(sim as Lbm2DGPU, mask);
    else setSolid(sim as Lbm2D, mask);
  }

  if (playSteps > 0) {
    if (backend === "gpu") stepLbm2DGPU(ctx.renderer!, sim as Lbm2DGPU, playSteps);
    else stepLbm2D(sim as Lbm2D, playSteps);
  }
  let ran = playSteps;

  // Compute: one batch long enough for the air to travel `computeChords` chords past the
  // section, forces averaged over its second half (vortex shedding makes them oscillate).
  if (computeSteps > 0) {
    let total = Math.ceil((computeSteps * lengthCells) / U_LATTICE);
    if (backend === "cpu") total = Math.min(total, CPU_MAX_COMPUTE);
    const chunk = Math.max(50, Math.ceil(total / 40));
    // First half: no read-back (it stalls the GPU). Second half: forces sampled per chunk.
    const half = Math.floor(total / 2);
    if (backend === "gpu") stepLbm2DGPU(ctx.renderer!, sim as Lbm2DGPU, half, false);
    else stepLbm2D(sim as Lbm2D, half);
    let done = half, sumX = 0, sumY = 0, samples = 0;
    while (done < total) {
      const k = Math.min(chunk, total - done);
      if (backend === "gpu") stepLbm2DGPU(ctx.renderer!, sim as Lbm2DGPU, k);
      else stepLbm2D(sim as Lbm2D, k);
      done += k;
      sumX += sim.fx; sumY += sim.fy; samples++;
    }
    const dyn = 0.5 * U_LATTICE * U_LATTICE * lengthCells;
    if (samples > 0) { sim.cd = sumX / samples / dyn; sim.cl = sumY / samples / dyn; }
    sl.tracerPos = new Float32Array(0); // re-seeded over the settled flow
    ran = 0;
  }

  // ---- Field plane ----------------------------------------------------------------------------
  const n = nx * ny;
  if (!sl.fieldTex || sl.fieldTex.image.width !== nx || sl.fieldTex.image.height !== ny) {
    sl.fieldTex?.dispose();
    sl.fieldTex = new THREE.DataTexture(new Uint8Array(4 * n), nx, ny, THREE.RGBAFormat);
    sl.fieldTex.magFilter = THREE.LinearFilter;
    sl.fieldTex.minFilter = THREE.LinearFilter;
    sl.fieldTex.colorSpace = THREE.SRGBColorSpace;
    (sl.fieldMesh.material as THREE.MeshBasicMaterial).map = sl.fieldTex;
    (sl.fieldMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }
  const showField = flag(params.showField, true);
  const { ux, uy, rho, solid } = sim;
  if (showField) {
    const px = sl.fieldTex.image.data as Uint8Array;
    const vortK = lengthCells / U_LATTICE / 2;
    const alpha = Math.round(255 * sh.opacity);
    const fadeCalm = flag(params.fadeCalm, true);
    const { field, range } = sh;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const o = 4 * c;
        if (solid[c]) { px[o] = 25; px[o + 1] = 22; px[o + 2] = 20; px[o + 3] = 255; continue; }
        let strength = 1;
        if (field === "speed") sequential(Math.hypot(ux[c], uy[c]) / U_LATTICE / range, px, o);
        else if (field === "pressure") strength = diverging(-pressureCoefficient(rho[c]) / range, px, o);
        else {
          const w = i > 0 && j > 0 && i < nx - 1 && j < ny - 1
            ? (uy[c + 1] - uy[c - 1] - (ux[c + nx] - ux[c - nx])) * vortK : 0;
          strength = diverging(w / range, px, o);
        }
        // Calm air fades out (a faint veil keeps the tunnel visible): only the wake shows.
        px[o + 3] = fadeCalm ? alpha * Math.min(1, 0.06 + 2 * strength) : alpha;
      }
    }
    sl.fieldTex.needsUpdate = true;
    const centre = fromFrame(fromCell([(nx - 1) / 2, (ny - 1) / 2], grid), frame);
    const side = new THREE.Vector3().crossVectors(frame.flow, frame.up);
    sl.fieldMesh.matrix.makeBasis(frame.flow.clone().multiplyScalar(nx * dx), frame.up.clone().multiplyScalar(ny * dx), side).setPosition(centre);
  }
  sl.fieldMesh.visible = showField;

  const toWorld = (q: V2, out = new THREE.Vector3()) => fromFrame(fromCell(q, grid), frame, out);

  // ---- Tracers --------------------------------------------------------------------------------
  const tracerCount = Math.max(0, Math.min(20000, Math.round(numberInput(undefined, params.tracerCount, 800))));
  const showTracers = flag(params.showTracers, false) && tracerCount > 0;
  if (showTracers) {
    const rand = mulberry(sl.seed++);
    const respawn = (k: number, anywhere: boolean) => {
      for (let tries = 0; tries < 8; tries++) {
        const x = anywhere ? 1 + rand() * (nx - 3) : 1 + rand() * 2;
        const y = 2 + rand() * (ny - 5);
        if (!isSolidAt(sim, x, y)) { sl.tracerPos[2 * k] = x; sl.tracerPos[2 * k + 1] = y; break; }
      }
      sl.tracerAge[k] = rand() * 0.3;
    };
    if (sl.tracerPos.length !== 2 * tracerCount) {
      sl.tracerPos = new Float32Array(2 * tracerCount);
      sl.tracerAge = new Float32Array(tracerCount);
      for (let k = 0; k < tracerCount; k++) respawn(k, true);
    }
    if (ran > 0) {
      // Sub-steps of at most half a cell.
      const sub = Math.max(1, Math.ceil((ran * U_LATTICE) / 0.5));
      const h = (ran * U_LATTICE) / sub;
      for (let k = 0; k < tracerCount; k++) {
        let x = sl.tracerPos[2 * k], y = sl.tracerPos[2 * k + 1];
        for (let s = 0; s < sub; s++) [x, y] = advect(sim, x, y, h);
        sl.tracerAge[k] += tracerTicks / 600;
        if (x >= nx - 2 || x < 0 || y < 1 || y > ny - 2 || isSolidAt(sim, x, y) || sl.tracerAge[k] > 1) respawn(k, false);
        else { sl.tracerPos[2 * k] = x; sl.tracerPos[2 * k + 1] = y; }
      }
    }
    const tp = new Float32Array(3 * tracerCount);
    const v = new THREE.Vector3();
    for (let k = 0; k < tracerCount; k++) {
      toWorld([sl.tracerPos[2 * k], sl.tracerPos[2 * k + 1]], v);
      tp[3 * k] = v.x; tp[3 * k + 1] = v.y; tp[3 * k + 2] = v.z;
    }
    sl.tracers.geometry.setAttribute("position", new THREE.BufferAttribute(tp, 3));
  }
  sl.tracers.visible = showTracers;

  // ---- Streamlines ----------------------------------------------------------------------------
  const lineCount = Math.max(0, Math.min(200, Math.round(numberInput(undefined, params.streamlineCount, 24))));
  const streamlines: THREE.Vector3[][] = [];
  const showStream = flag(params.showStreamlines, true);
  for (let k = 0; k < lineCount; k++) {
    let x = 1.5, y = 2 + ((k + 0.5) / lineCount) * (ny - 5);
    const pts: THREE.Vector3[] = [toWorld([x, y])];
    for (let s = 0; s < 4 * nx; s++) {
      [x, y] = advect(sim, x, y, 0.75);
      if (x >= nx - 1.5 || x < 0 || y < 1 || y > ny - 2 || isSolidAt(sim, x, y)) break;
      if (s % 2 === 1) pts.push(toWorld([x, y]));
    }
    if (pts.length > 1) streamlines.push(pts);
  }
  if (showStream) {
    const seg: number[] = [];
    for (const l of streamlines) for (let i = 0; i + 1 < l.length; i++) seg.push(l[i].x, l[i].y, l[i].z, l[i + 1].x, l[i + 1].y, l[i + 1].z);
    sl.streamLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  }
  sl.streamLines.visible = showStream;

  // ---- Pressure bars on the section: one per cell of section, on both faces --------------------
  const showPressure = flag(params.showPressure, true);
  if (showPressure) {
    const pScale = numberInput(undefined, params.pressureScale, 0.08) * chord;
    const bars: number[] = [];
    const colors: number[] = [];
    const r = Math.max(0.75, sh.thickness / 2);
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    for (const line of chains) {
      if (isClosed(line, 1e-6 * chord) && line.length < 6) continue;
      let carry = 0;
      for (let k = 0; k + 1 < line.length; k++) {
        const [ax, ay] = line[k], [bx, by] = line[k + 1];
        const len = Math.hypot(bx - ax, by - ay);
        if (len === 0) continue;
        const tx = (bx - ax) / len, ty = (by - ay) / len;
        for (let d = carry; d < len; d += dx) {
          const p: V2 = [ax + tx * d, ay + ty * d];
          for (const sgn of [1, -1]) {
            const nxv = -ty * sgn, nyv = tx * sgn;
            const probe = toCell([p[0] + nxv * (r + 1.5) * dx, p[1] + nyv * (r + 1.5) * dx], grid);
            const i = Math.round(probe[0]), j = Math.round(probe[1]);
            if (i < 0 || j < 0 || i >= nx || j >= ny || solid[j * nx + i]) continue;
            const cp = pressureCoefficient(rho[j * nx + i]);
            const start: V2 = [p[0] + nxv * r * dx, p[1] + nyv * r * dx];
            const end: V2 = [start[0] + nxv * Math.abs(cp) * pScale, start[1] + nyv * Math.abs(cp) * pScale];
            fromFrame(start, frame, p0);
            fromFrame(end, frame, p1);
            bars.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
            // Blue: suction (Cp < 0). Red: overpressure (Cp > 0).
            const col = cp < 0 ? [0.25, 0.55, 1] : [1, 0.3, 0.25];
            colors.push(...col, ...col);
          }
        }
        carry = (carry - len) % dx;
        if (carry < 0) carry += dx;
      }
    }
    sl.pressureBars.geometry.setAttribute("position", new THREE.Float32BufferAttribute(bars, 3));
    sl.pressureBars.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  }
  sl.pressureBars.visible = showPressure;

  // ---- Forces ---------------------------------------------------------------------------------
  const cl = sim.steps > 0 ? sim.cl : 0;
  const cd = sim.steps > 0 ? sim.cd : 0;
  const fScale = numberInput(undefined, params.forceScale, 0.5) * chord;
  const showForces = flag(params.showForces, true);
  let cx = 0, cy = 0, cn = 0;
  for (const l of chains) for (const [x, y] of l) { cx += x; cy += y; cn++; }
  const origin = fromFrame([cx / cn, cy / cn], frame);
  sl.liftArrow.position.copy(origin);
  sl.liftArrow.setDirection(frame.up.clone().multiplyScalar(cl >= 0 ? 1 : -1));
  sl.liftArrow.setLength(Math.max(1e-4, Math.abs(cl) * fScale), 0.12 * chord, 0.06 * chord);
  sl.dragArrow.position.copy(origin);
  sl.dragArrow.setDirection(frame.flow.clone().multiplyScalar(cd >= 0 ? 1 : -1));
  sl.dragArrow.setLength(Math.max(1e-4, Math.abs(cd) * fScale), 0.12 * chord, 0.06 * chord);
  sl.liftArrow.visible = showForces;
  sl.dragArrow.visible = showForces;

  return {
    cl, cd, chord, streamlines,
    section: chains.map((l) => l.map((q) => fromFrame(q, frame))),
    liftFoot: origin,
    liftTip: origin.clone().addScaledVector(frame.up, cl * fScale),
  };
}

const EMPTY = { streamlines: [], section: [], cl: 0, cd: 0, chord: 0, airspeed: 0, clPerSlice: [], cdPerSlice: [], stations: [], liftCurve: [] };

export const WIND_TUNNEL_2D_NODE: NodeDefinition = {
  type: "physics/wind-tunnel-2d",
  label: "Wind Tunnel 2D (Lattice Boltzmann)",
  category: "physics",
  inputs: [
    { id: "obstacle", label: "Obstacle (meshes, or point lists in the slice)", type: "any" },
    // Not "station": an unwired input falls back to the param of the same id, which would
    // read as one wired station and override Slice Count.
    { id: "stations", label: "Stations (value or list; overrides Slice Count)", type: "any" },
    { id: "angle", label: "Angle of Attack", type: "value" },
    { id: "reynolds", label: "Reynolds Number", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "streamlines", label: "Streamlines (point lists)", type: "list" },
    { id: "section", label: "Section (point lists)", type: "list" },
    { id: "cl", label: "Lift Coefficient Cl (chord-weighted)", type: "value" },
    { id: "cd", label: "Drag Coefficient Cd (chord-weighted)", type: "value" },
    { id: "clPerSlice", label: "Cl per Slice", type: "list" },
    { id: "cdPerSlice", label: "Cd per Slice", type: "list" },
    { id: "stations", label: "Stations", type: "list" },
    { id: "liftCurve", label: "Lift Curve (point list)", type: "list" },
    { id: "chord", label: "Mean Chord", type: "value" },
    { id: "airspeed", label: "Airspeed (m/s)", type: "value" },
  ],
  defaultParams: {
    sliceAxis: "X", sliceCount: 1, station: 0, stationFrom: -1, stationTo: 1,
    flowAxis: "+Z", angle: 5, reynolds: 2000, reynoldsMode: "airspeed",
    cellsPerChord: 96, upstream: 1, downstream: 3, height: 2.5, thickness: 1.5,
    simulate: true, stepsPerFrame: 40, solver: "auto", computeChords: 8, computeRequest: 0,
    unitMeters: 0.01, viscosity: 1.5e-5,
    field: "vorticity", range: 12, opacity: 0.9, fadeCalm: true,
    showField: true, showTracers: false, tracerCount: 800, showStreamlines: true, streamlineCount: 24,
    showPressure: true, pressureScale: 0.08, showForces: true, forceScale: 0.5,
  },
  paramFields: PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    let state = tunnelCache.get(ctx.nodeId);
    if (!state) {
      const group = new THREE.Group();
      group.userData.nodeId = ctx.nodeId;
      const liftCurve = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x22c55e }));
      liftCurve.frustumCulled = false;
      group.add(liftCurve);
      state = {
        group, slices: [], liftCurve, lastStep: ctx.step - 1, epoch: ctx.simulationEpoch ?? 0,
        lastCompute: Number(params.computeRequest) || 0,
      };
      tunnelCache.set(ctx.nodeId, state);
    }
    const st = state;

    const sliceAxis = AXES.includes(params.sliceAxis as never) ? (params.sliceAxis as string) : "X";
    let flowAxis = FLOW_AXES.includes(params.flowAxis as never) ? (params.flowAxis as string) : "+Z";
    if (flowAxis.endsWith(sliceAxis)) flowAxis = sliceAxis === "Z" ? "+X" : "+Z";
    const requested = (params.solver as string) ?? "auto";
    const sh: Shared = {
      sliceAxis, flowAxis,
      angle: numberInput(inputs.angle, params.angle, 5),
      cellsPerChord: Math.max(16, Math.min(512, Math.round(numberInput(undefined, params.cellsPerChord, 96)))),
      upstream: Math.max(0.25, numberInput(undefined, params.upstream, 1)),
      downstream: Math.max(0.5, numberInput(undefined, params.downstream, 3)),
      heightC: Math.max(0.5, numberInput(undefined, params.height, 2.5)),
      thickness: Math.max(0, numberInput(undefined, params.thickness, 1.5)),
      backend: requested !== "cpu" && isLbmGPUSupported(ctx.renderer) ? "gpu" : "cpu",
      epoch: ctx.simulationEpoch ?? 0,
      field: FIELDS.includes(params.field as Field) ? (params.field as Field) : "vorticity",
      range: Math.max(1e-3, numberInput(undefined, params.range, 12)),
      opacity: Math.max(0, Math.min(1, numberInput(undefined, params.opacity, 0.9))),
      params,
    };
    const reynolds = Math.max(10, Math.min(1e6, numberInput(inputs.reynolds, params.reynolds, 2000)));
    const sameAirspeed = params.reynoldsMode !== "reynolds";

    // ---- Slices: one per station, sections first (the Reynolds numbers need every chord) -------
    const stations = resolveStations(inputs.stations, params);
    while (st.slices.length > stations.length) disposeSlice(st.slices.pop()!);
    while (st.slices.length < stations.length) {
      const sl = createSlice();
      st.slices.push(sl);
      st.group.add(sl.group);
    }
    const { objects, lines } = collectObstacles(inputs.obstacle);
    const obstacleSig = obstacleSignature(objects, lines);
    st.slices.forEach((sl, i) => updateSection(sl, sh, stations[i], objects, lines, obstacleSig));
    const live = st.slices.map((sl) => sl.baseChains.length > 0 && sl.chord > 0);
    st.slices.forEach((sl, i) => { sl.group.visible = live[i]; });
    const chords = st.slices.filter((_, i) => live[i]).map((sl) => sl.chord);
    if (chords.length === 0) {
      st.group.visible = false;
      return { geometry: st.group, ...EMPTY };
    }
    st.group.visible = true;
    const meanChord = chords.reduce((s, c) => s + c, 0) / chords.length;

    // ---- Stepping: playback, then Compute ---------------------------------------------------------
    const graphSteps = flag(params.simulate, true) ? stepsSince(st.lastStep, ctx.step, 1) : 0;
    st.lastStep = ctx.step;
    const perFrame = Math.max(0, Math.round(numberInput(undefined, params.stepsPerFrame, 40)));
    const playSteps = graphSteps > 0 ? (sh.backend === "gpu" ? perFrame : Math.min(perFrame, CPU_MAX_STEPS)) : 0;
    const computeRequest = Number(params.computeRequest) || 0;
    const computeChords = computeRequest !== st.lastCompute ? Math.max(1, numberInput(undefined, params.computeChords, 8)) : 0;
    st.lastCompute = computeRequest;
    st.epoch = sh.epoch;

    const results: (SliceResult | null)[] = st.slices.map((sl, i) => {
      if (!live[i]) return null;
      const re = sameAirspeed ? (reynolds * sl.chord) / meanChord : reynolds;
      return runSlice(sl, sh, stations[i], Math.max(10, re), ctx, playSteps, computeChords, graphSteps);
    });
    const ok = results.filter((r): r is SliceResult => r !== null);

    // ---- Whole stack: chord-weighted coefficients, spanwise lift curve --------------------------
    const sumC = ok.reduce((s, r) => s + r.chord, 0);
    const cl = ok.reduce((s, r) => s + r.cl * r.chord, 0) / sumC;
    const cd = ok.reduce((s, r) => s + r.cd * r.chord, 0) / sumC;
    const liftCurve = ok.length > 1 ? ok.map((r) => r.liftTip) : [];
    const showCurve = flag(params.showForces, true) && liftCurve.length > 1;
    if (showCurve) st.liftCurve.geometry.setFromPoints(liftCurve);
    st.liftCurve.visible = showCurve;

    const unit = Math.max(1e-9, numberInput(undefined, params.unitMeters, 0.01));
    const nu = Math.max(1e-12, numberInput(undefined, params.viscosity, 1.5e-5));
    const airspeed = (reynolds * nu) / ((sameAirspeed ? meanChord : ok[0].chord) * unit);
    return {
      geometry: st.group,
      streamlines: ok.flatMap((r) => r.streamlines),
      section: ok.flatMap((r) => r.section),
      cl, cd,
      clPerSlice: results.map((r) => r?.cl ?? 0),
      cdPerSlice: results.map((r) => r?.cd ?? 0),
      stations,
      liftCurve,
      chord: meanChord,
      airspeed,
    };
  },
};

/** For tests: the live state of a node. */
export function windTunnelState(nodeId: string): TunnelState | undefined {
  return tunnelCache.get(nodeId);
}
