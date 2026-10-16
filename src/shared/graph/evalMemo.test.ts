import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { afterAll, describe, expect, it } from "vitest";
import { deserializeProject } from "./storage";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { EvalResult, disposeEvalSession, evaluateGraph, setEvalMemoEnabled } from "./evaluate";
import { hashPositions } from "./geometrySignature";
import { initBvhRaycast } from "../three/bvh";
import { Graph, NodeDefinition, NodeInstance } from "./types";

/**
 * The pure-node memo (NodeDefinition.pure) must be invisible: every demo,
 * run frame by frame with the memo on and with it off, has to produce the
 * same outputs — including after a param edit mid-run, which has to reach
 * the edited node and everything downstream of it.
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

const round = (v: number) => Math.round(v * 1e4) / 1e4;

function snapshotObject(root: THREE.Object3D): unknown[] {
  const out: unknown[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    out.push([
      o.type,
      o.visible,
      o.children.length,
      o.matrix.elements.map(round),
      o.position.toArray().map(round),
      o.quaternion.toArray().map(round),
      o.scale.toArray().map(round),
      mesh.geometry ? hashPositions(mesh.geometry.getAttribute("position") as THREE.BufferAttribute) : null,
      (material as THREE.MeshStandardMaterial | undefined)?.color?.getHex() ?? null,
      (o as THREE.InstancedMesh).isInstancedMesh ? Array.from((o as THREE.InstancedMesh).instanceMatrix.array, round) : null,
    ]);
  });
  return out;
}

function snapshotValue(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
    return typeof v === "number" ? round(v) : v;
  }
  if (v instanceof THREE.Object3D) return snapshotObject(v);
  if (v instanceof THREE.Vector2 || v instanceof THREE.Vector3 || v instanceof THREE.Vector4 || v instanceof THREE.Quaternion) {
    return v.toArray().map(round);
  }
  if (v instanceof THREE.Color) return v.getHex();
  if (v instanceof THREE.Matrix4) return v.elements.map(round);
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
            expect(a[nodeId]?.[socket], `${file}, frame ${frame}, ${nodeId} (${type}).${socket}`).toEqual(b[nodeId][socket]);
          }
        }
        expect(Object.keys(a).sort(), `${file}, frame ${frame}: node set`).toEqual(Object.keys(b).sort());
      }
    }, 30_000);
  }
});
