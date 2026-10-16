import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { afterAll, describe, expect, it } from "vitest";
import { deserializeProject } from "./storage";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { EvalResult, disposeEvalSession, evaluateGraph, setEvalMemoEnabled } from "./evaluate";
import { initBvhRaycast } from "../three/bvh";
import { setSyncedCloneEnabled } from "./nodes/syncedClone";
import { setGlyphCacheEnabled } from "../three/fonts/textGeometry";
import { Graph, NodeDefinition, NodeInstance } from "./types";

/**
 * The evaluation shortcuts must be invisible: the pure-node memo
 * (NodeDefinition.pure), the re-synced copies of the structure nodes
 * (nodes/syncedClone.ts) and the Text node's glyph cache
 * (three/fonts/textGeometry.ts). Every demo, run frame by frame with both on and
 * with both off, has to produce the same outputs — including after a param
 * edit mid-run, which has to reach the edited node and everything
 * downstream of it.
 *
 * Node caches are keyed by node id, so the two runs use differently
 * prefixed copies of the graph and never share a cached mesh.
 */

const DEMO_DIR = join(process.cwd(), "public/demos");
const FRAMES = 6;
const EDIT_FRAME = 3;

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prefixed(source: Graph, prefix: string): Graph {
  const ids = new Map(source.nodes.map((n) => [n.id, `${prefix}${n.id}`]));
  return {
    ...source,
    nodes: source.nodes.map((n) => ({ ...n, id: ids.get(n.id)! })),
    connections: source.connections.map((c) => ({
      ...c,
      id: `${prefix}${c.id}`,
      fromNode: ids.get(c.fromNode) ?? c.fromNode,
      toNode: ids.get(c.toNode) ?? c.toNode,
    })),
    keyframes: Object.fromEntries(Object.entries(source.keyframes ?? {}).map(([id, t]) => [ids.get(id) ?? id, t])),
  };
}



/** Every `step`-th value, so a big mesh compares in bounded time. */
function sample(array: ArrayLike<number> | undefined, max = 3000): number[] | null {
  if (!array) return null;
  const step = Math.max(1, Math.ceil(array.length / max));
  const out: number[] = [];
  for (let i = 0; i < array.length; i += step) out.push(array[i]);
  return out;
}

function geometrySnapshot(geometry: THREE.BufferGeometry): unknown {
  return {
    vertices: geometry.getAttribute("position")?.count ?? 0,
    groups: geometry.groups.map((g) => [g.start, g.count, g.materialIndex]),
    position: sample(geometry.getAttribute("position")?.array),
    uv: sample(geometry.getAttribute("uv")?.array),
  };
}

/**
 * The first difference between two snapshots, or null. Floats compare with
 * a small tolerance: a shortcut may legitimately reach the same value by
 * another order of operations, so the last bits can differ; anything visible
 * cannot. One plain function rather than an expect() per number — the
 * snapshots hold tens of thousands of them.
 */
function mismatch(actual: unknown, expected: unknown, path: string): string | null {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Number.isNaN(expected) && Number.isNaN(actual)) return null;
    return Math.abs(actual - expected) <= 1e-4 * Math.max(1, Math.abs(expected)) ? null : `${path}: ${actual} vs ${expected}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${path}: length ${(actual as unknown[])?.length} vs ${expected.length}`;
    for (let i = 0; i < expected.length; i++) {
      const m = mismatch(actual[i], expected[i], `${path}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return `${path}: not an object`;
    const keys = Object.keys(expected);
    if (keys.length !== Object.keys(actual).length) return `${path}: keys ${Object.keys(actual)} vs ${keys}`;
    for (const k of keys) {
      const m = mismatch((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
      if (m) return m;
    }
    return null;
  }
  return Object.is(actual, expected) ? null : `${path}: ${String(actual)} vs ${String(expected)}`;
}

function snapshotObject(root: THREE.Object3D): unknown[] {
  const out: unknown[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    out.push([
      o.type,
      o.visible,
      o.children.length,
      Array.from(o.matrix.elements),
      o.position.toArray(),
      o.quaternion.toArray(),
      o.scale.toArray(),
      mesh.geometry ? geometrySnapshot(mesh.geometry) : null,
      (material as THREE.MeshStandardMaterial | undefined)?.color?.getHex() ?? null,
      (o as THREE.InstancedMesh).isInstancedMesh ? sample((o as THREE.InstancedMesh).instanceMatrix.array) : null,
    ]);
  });
  return out;
}

function snapshotValue(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
    return v;
  }
  if (v instanceof THREE.Object3D) return snapshotObject(v);
  if (v instanceof THREE.Vector2 || v instanceof THREE.Vector3 || v instanceof THREE.Vector4 || v instanceof THREE.Quaternion) {
    return v.toArray();
  }
  if (v instanceof THREE.Color) return v.getHex();
  if (v instanceof THREE.Matrix4) return Array.from(v.elements);
  if (Array.isArray(v) && depth < 2) return v.slice(0, 64).map((x) => snapshotValue(x, depth + 1));
  // Textures, materials and the like carry fresh uuids per run — not comparable, and not what the memo changes.
  return typeof v;
}

function snapshot(results: EvalResult, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [nodeId, outputs] of results) {
    const key = nodeId.slice(prefix.length);
    const node: Record<string, unknown> = {};
    for (const [socket, value] of Object.entries(outputs)) {
      if (socket === "__evaluatedInputs") continue;
      node[socket] = snapshotValue(value);
    }
    out[key] = node;
  }
  return out;
}

/** The first pure node with a location param, nudged mid-run — the change has to propagate. */
function editTarget(graph: Graph): NodeInstance | undefined {
  return graph.nodes.find((n) => {
    const def = DEFAULT_REGISTRY.get(n.type) as NodeDefinition | undefined;
    return def?.pure && def.defaultParams.location instanceof THREE.Vector3;
  });
}

function run(source: Graph, prefix: string, memo: boolean): Record<string, unknown>[] {
  setEvalMemoEnabled(memo);
  setSyncedCloneEnabled(memo);
  setGlyphCacheEnabled(memo);
  const realRandom = Math.random;
  Math.random = seededRandom(1234);
  let graph = prefixed(source, prefix);
  const sessionId = `memo-test-${prefix}`;
  const frames: Record<string, unknown>[] = [];
  try {
    for (let frame = 0; frame < FRAMES; frame++) {
      if (frame === EDIT_FRAME) {
        const target = editTarget(graph);
        if (target) {
          // Like the app: a new graph, a new node and a new params object, never a mutation.
          graph = {
            ...graph,
            nodes: graph.nodes.map((n) =>
              n === target ? { ...n, params: { ...n.params, location: new THREE.Vector3(0.5, 1.25, -2) } } : n,
            ),
          };
        }
      }
      const results = evaluateGraph(graph, DEFAULT_REGISTRY, {
        time: frame / 30,
        step: frame,
        nodeId: "",
        renderSize: { width: 1920, height: 1080 },
        fps: 30,
        currentFrame: frame,
        keyframes: graph.keyframes,
        sessionId,
        isPlaying: true,
        simulationRun: true,
        // Export mode: the walk cycles (rig.ts) step on the graph clock instead
        // of performance.now(), which would differ between the two runs.
        capturing: true,
      } as never);
      frames.push(snapshot(results, prefix));
    }
  } finally {
    Math.random = realRandom;
    disposeEvalSession(sessionId);
    setEvalMemoEnabled(true);
    setSyncedCloneEnabled(true);
    setGlyphCacheEnabled(true);
  }
  return frames;
}

describe("pure-node memo", () => {
  afterAll(() => setEvalMemoEnabled(true));

  const files = readdirSync(DEMO_DIR).filter((f) => f.endsWith(".tsuji")).sort();

  for (const file of files) {
    it(`changes nothing in ${file}`, () => {
      initBvhRaycast();
      const project = deserializeProject(readFileSync(join(DEMO_DIR, file), "utf8"), DEFAULT_REGISTRY);
      const source = project.canvases.find((c) => c.nodes.length > 0);
      if (!source) return;

      const withMemo = run(source, "memo:", true);
      const without = run(source, "plain:", false);
      for (let frame = 0; frame < FRAMES; frame++) {
        const a = withMemo[frame] as Record<string, Record<string, unknown>>;
        const b = without[frame] as Record<string, Record<string, unknown>>;
        for (const nodeId of Object.keys(b)) {
          const type = source.nodes.find((n) => n.id === nodeId)?.type;
          for (const socket of Object.keys(b[nodeId])) {
            expect(mismatch(a[nodeId]?.[socket], b[nodeId][socket], `${file}, frame ${frame}, ${nodeId} (${type}).${socket}`)).toBeNull();
          }
        }
        expect(Object.keys(a).sort(), `${file}, frame ${frame}: node set`).toEqual(Object.keys(b).sort());
      }
    }, 30_000);
  }
});
