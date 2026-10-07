import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { evalProfileCurve, ProfilePoint } from "../profileCurve";
import { clockInput, numberInput } from "./object";
import { asVector3 } from "./transform";
import { perSession, sessionKey } from "../sessionState";
import {
  advancePhase,
  ChainSet,
  createChainSet,
  followChain,
  resizeChains,
  seedChain,
  trackSpeed,
  Vec3,
  WAVE_AXES,
  WaveAxis,
  WaveParams,
  wavedSpine,
} from "../spine/chain";

const DEG = Math.PI / 180;
/** Same scrub threshold as Spring and Integrate: a jump back this far is a rewind, not jitter. */
const REWIND_THRESHOLD = 0.5;
const MAX_CHAINS = 2000;
/** Little at the start, all of it at the end — a swimming fish, a flag, a tail. */
const DEFAULT_ENVELOPE: ProfilePoint[] = [{ x: 0, y: 0.08 }, { x: 0.5, y: 0.3 }, { x: 1, y: 1 }];

/** One render loop's chains — see sessionState.ts for why each viewport keeps its own. */
interface SpineRun {
  chains: ChainSet;
  lastTime?: number;
  epoch?: number;
}

interface SpineState {
  sessions: Map<string, SpineRun>;
  spine: Float64Array;
  envelope: Float64Array;
  envelopeKey?: string;
  pointLists: THREE.Vector3[][];
  preview?: THREE.LineSegments;
}

const spineCache = createNodeCache<SpineState>((state) => {
  if (state.preview) disposeObject3D(state.preview);
});

function readHeads(inputs: Record<string, unknown>, params: Record<string, unknown>): Vec3[] {
  if (Array.isArray(inputs.heads)) {
    const out: Vec3[] = [];
    for (const raw of inputs.heads.slice(0, MAX_CHAINS)) {
      const v = asVector3(raw, new THREE.Vector3(Number.NaN, 0, 0));
      if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) out.push({ x: v.x, y: v.y, z: v.z });
    }
    return out;
  }
  const v = asVector3(inputs.head ?? params.head, new THREE.Vector3(0, 0, 0));
  return [{ x: v.x, y: v.y, z: v.z }];
}

function listNumber(list: unknown, i: number): number | null {
  if (!Array.isArray(list)) return null;
  const n = Number(list[i]);
  return Number.isFinite(n) ? n : null;
}

function listVector(list: unknown, i: number): Vec3 | null {
  if (!Array.isArray(list)) return null;
  const v = asVector3(list[i], new THREE.Vector3(Number.NaN, 0, 0));
  return Number.isFinite(v.x) ? { x: v.x, y: v.y, z: v.z } : null;
}

/** The line preview: one segment per link, rewritten in place each frame. */
function previewFor(state: SpineState, count: number, segments: number, nodeId: string): THREE.LineSegments {
  const needed = Math.max(1, count * (segments - 1) * 2) * 3;
  if (!state.preview || (state.preview.geometry.getAttribute("position") as THREE.BufferAttribute).array.length !== needed) {
    if (state.preview) disposeObject3D(state.preview);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(needed), 3).setUsage(THREE.DynamicDrawUsage));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x9be37a }));
    line.frustumCulled = false;
    line.matrixAutoUpdate = false;
    line.userData.nodeId = nodeId;
    state.preview = line;
  }
  return state.preview;
}

/**
 * Spine Chain — chains of points dragged along by their heads. Every point
 * follows the one in front at a fixed spacing, so the chain traces the path
 * its head took and curls through a turn instead of swinging round stiffly;
 * a bend limit per joint keeps it from folding on itself.
 *
 * An optional wave travels from head to end — side to side for a fish or a
 * snake, up and down for a dolphin or a caterpillar — with the Swing Profile
 * saying how much of it each part of the chain takes. Speed Driven ties the
 * swing and beat to how fast the head moves.
 *
 * Out come Point Lists, head first, one per chain: give them a skin with
 * Profiled Tubes, or use them as paths. Wire many heads (Flock's Points, a
 * particle list) or a single moving Head; with nothing wired, one chain sits
 * at the origin.
 */
export const SPINE_CHAIN_NODE: NodeDefinition = {
  type: "curve/spine-chain",
  label: "Spine Chain",
  category: "curve",
  inputs: [
    { id: "heads", label: "Heads (Points)", type: "list" },
    { id: "head", label: "Head (single)", type: "vector" },
    { id: "headings", label: "Headings (List)", type: "list" },
    { id: "phases", label: "Wave Phase (List)", type: "list" },
    { id: "sizes", label: "Length Scales (List)", type: "list" },
    { id: "time", label: "Time", type: "value" },
  ],
  outputs: [
    { id: "pointLists", label: "Point Lists", type: "list" },
    { id: "geometry", label: "Preview", type: "geometry" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    head: new THREE.Vector3(0, 0, 0),
    time: 0,
    segments: 14,
    length: 1,
    maxBend: 25,
    waveAxis: "Side to Side",
    amplitude: 0.12,
    wavelength: 0.9,
    frequency: 1.4,
    envelope: DEFAULT_ENVELOPE,
    speedDriven: true,
    refSpeed: 1.2,
    showPreview: true,
  },
  paramFields: [
    { id: "head", label: "Head (fallback)", kind: "vector", group: "Chain" },
    { id: "segments", label: "Points per Chain", kind: "number", step: 1, group: "Chain" },
    { id: "length", label: "Length", kind: "number", step: 0.05, group: "Chain" },
    { id: "maxBend", label: "Max Bend per Joint (°)", kind: "number", step: 1, group: "Chain" },
    { id: "waveAxis", label: "Wave", kind: "select", options: [...WAVE_AXES], group: "Wave" },
    { id: "amplitude", label: "Swing (× length)", kind: "number", step: 0.01, group: "Wave" },
    { id: "wavelength", label: "Waves along Chain", kind: "number", step: 0.05, group: "Wave" },
    { id: "frequency", label: "Beats per Second", kind: "number", step: 0.1, group: "Wave" },
    { id: "envelope", label: "Swing Profile (head → end)", kind: "curve_profile", group: "Wave" },
    { id: "speedDriven", label: "Speed Driven (still idles, fast thrashes)", kind: "boolean", group: "Wave" },
    { id: "refSpeed", label: "Reference Speed", kind: "number", step: 0.1, group: "Wave" },
    { id: "showPreview", label: "Show Line Preview", kind: "boolean", group: "Display" },
  ],
  evaluate: (inputs, params, ctx) => {
    const heads = readHeads(inputs, params);
    const count = heads.length;
    const segments = Math.max(2, Math.min(64, Math.floor(numberInput(undefined, params.segments, 14))));
    const baseLength = Math.max(1e-3, numberInput(undefined, params.length, 1));
    const maxBend = Math.max(1, numberInput(undefined, params.maxBend, 25)) * DEG;
    const axis = (WAVE_AXES as readonly string[]).includes(String(params.waveAxis)) ? (params.waveAxis as WaveAxis) : "Side to Side";
    const wave: WaveParams = {
      axis,
      amplitude: numberInput(undefined, params.amplitude, 0.12),
      wavelength: numberInput(undefined, params.wavelength, 0.9),
      frequency: Math.max(0, numberInput(undefined, params.frequency, 1.4)),
      speedDriven: toBoolean(params.speedDriven ?? true),
      refSpeed: Math.max(1e-3, numberInput(undefined, params.refSpeed, 1.2)),
    };
    const lengthOf = (i: number) => baseLength * Math.max(0, listNumber(inputs.sizes, i) ?? 1);

    let state = spineCache.get(ctx.nodeId);
    if (!state) {
      state = { sessions: new Map(), spine: new Float64Array(0), envelope: new Float64Array(0), pointLists: [] };
      spineCache.set(ctx.nodeId, state);
    }
    const run = perSession<SpineRun>(state.sessions, sessionKey(ctx), () => ({ chains: createChainSet() }));
    const chains = run.chains;
    const seedOne = (i: number) => seedChain(chains, i, heads[i], listVector(inputs.headings, i), lengthOf(i));

    const time = clockInput(inputs, params, ctx);
    const epoch = ctx.simulationEpoch ?? 0;
    const rewound = run.lastTime !== undefined && time < run.lastTime - REWIND_THRESHOLD;
    const reseed = run.lastTime === undefined || rewound || run.epoch !== epoch;
    const dt = reseed ? 0 : Math.max(0, time - (run.lastTime ?? time));
    run.lastTime = time;
    run.epoch = epoch;

    // Forgetting the segment count makes the resize below re-seed every chain.
    if (reseed) chains.segments = 0;
    resizeChains(chains, count, segments, seedOne);

    if (state.spine.length !== segments * 3) state.spine = new Float64Array(segments * 3);
    const envelopePoints = Array.isArray(params.envelope) ? (params.envelope as ProfilePoint[]) : DEFAULT_ENVELOPE;
    const envelopeKey = `${segments}:${JSON.stringify(envelopePoints)}`;
    if (state.envelopeKey !== envelopeKey) {
      state.envelope = new Float64Array(segments);
      for (let k = 0; k < segments; k++) state.envelope[k] = evalProfileCurve(envelopePoints, segments > 1 ? k / (segments - 1) : 0);
      state.envelopeKey = envelopeKey;
    }

    const showPreview = toBoolean(params.showPreview ?? true);
    const preview = previewFor(state, count, segments, ctx.nodeId);
    const linePositions = preview.geometry.getAttribute("position") as THREE.BufferAttribute;

    const lists = state.pointLists;
    lists.length = count;
    for (let i = 0; i < count; i++) {
      const head = heads[i];
      const length = lengthOf(i);
      const b = i * 3;
      // A head that jumped further than two lengths in one frame was
      // teleported (a respawn, a wrap); dragging the chain across that gap
      // would draw it stretched over the whole distance for a frame.
      if (!reseed && Math.hypot(head.x - chains.prevHead[b], head.y - chains.prevHead[b + 1], head.z - chains.prevHead[b + 2]) > length * 2) {
        seedOne(i);
      }
      trackSpeed(chains, i, head, dt);
      followChain(chains, i, head, length, maxBend);
      const wired = listNumber(inputs.phases, i);
      if (wired === null) advancePhase(chains, i, dt, wave);
      wavedSpine(chains, i, length, wired ?? chains.phase[i], wave, state.envelope, state.spine);

      const list = (lists[i] ??= []);
      list.length = segments;
      const sp = state.spine;
      for (let k = 0; k < segments; k++) (list[k] ??= new THREE.Vector3()).set(sp[k * 3], sp[k * 3 + 1], sp[k * 3 + 2]);
      if (showPreview) {
        const o = i * (segments - 1) * 2;
        for (let k = 0; k < segments - 1; k++) {
          linePositions.setXYZ(o + k * 2, sp[k * 3], sp[k * 3 + 1], sp[k * 3 + 2]);
          linePositions.setXYZ(o + k * 2 + 1, sp[k * 3 + 3], sp[k * 3 + 4], sp[k * 3 + 5]);
        }
      }
    }
    linePositions.needsUpdate = true;
    preview.visible = showPreview && count > 0;

    return { pointLists: lists, geometry: preview, count };
  },
};
