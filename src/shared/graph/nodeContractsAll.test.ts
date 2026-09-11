import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "./nodes";
import { evaluateGraph } from "./evaluate";
import { cloneGraph } from "./cloneGraph";
import { deserializeProject, serializeProject } from "./storage";
import { rehydrateGraphParams } from "./rehydrateParams";
import { emptyProject, Graph, NodeDefinition } from "./types";

/**
 * The contracts that apply to **every** node, not just the ones that pass
 * geometry through (those are in nodeContracts.test.ts).
 *
 * These are the "user processes" rather than the data flow: saving a file and
 * opening it again, undoing, unplugging a wire, and the purity rule that makes
 * a render agree with the preview it was authored in. Each was covered by a
 * handful of hand-picked cases spread across storage.test.ts,
 * rehydrateParams.test.ts, cloneGraph.test.ts and disconnectReactivity.test.ts
 * — between 2 and 8 nodes each, out of 255. A node added tomorrow was checked
 * by none of them.
 *
 * Every sweep below walks the registry instead, so the answer is "all of them"
 * or a named list.
 */

function allNodes(): NodeDefinition[] {
  return [...DEFAULT_REGISTRY.values()].sort((a, b) => a.type.localeCompare(b.type));
}

function defaultParams(def: NodeDefinition): Record<string, unknown> {
  const raw = typeof def.defaultParams === "function" ? (def.defaultParams as () => unknown)() : def.defaultParams;
  return { ...(raw as Record<string, unknown>) };
}

function graphOf(def: NodeDefinition, id = "n"): Graph {
  return {
    nodes: [{ id, type: def.type, params: defaultParams(def), position: { x: 0, y: 0 } }],
    connections: [],
    keyframes: {},
    markers: [],
    exposedParams: [],
  } as never as Graph;
}

/** What a param *is*, to the precision that matters: a Vector3 that comes back as {x,y,z} is a bug. */
function classOf(value: unknown): string {
  if (value instanceof THREE.Vector3) return "Vector3";
  if (value instanceof THREE.Vector2) return "Vector2";
  if (value instanceof THREE.Color) return "Color";
  if (value instanceof THREE.Matrix4) return "Matrix4";
  if (value instanceof THREE.Quaternion) return "Quaternion";
  if (value instanceof THREE.Texture) return "Texture";
  if (Array.isArray(value)) return "Array";
  if (value === null) return "null";
  if (value && typeof value === "object") return (value as object).constructor?.name ?? "object";
  return typeof value;
}

function valueOf(value: unknown): string {
  if (value instanceof THREE.Color) return value.getHexString();
  if (value && typeof (value as { toArray?: unknown }).toArray === "function") {
    return (value as { toArray: () => number[] }).toArray().join(",");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, 200);
    } catch {
      return "[cyclic]";
    }
  }
  return String(value);
}

function comparableParams(before: Record<string, unknown>, after: Record<string, unknown>, type: string): string[] {
  const damage: string[] = [];
  for (const key of Object.keys(before)) {
    const a = before[key];
    const b = after[key];
    if (typeof a === "function") continue;
    if (classOf(a) !== classOf(b)) {
      damage.push(`${type}.${key}: ${classOf(a)} -> ${classOf(b)}`);
      continue;
    }
    if (valueOf(a) !== valueOf(b)) damage.push(`${type}.${key}: ${valueOf(a)} -> ${valueOf(b)}`);
  }
  return damage;
}

describe("every node: a saved file reopens as what it was", () => {
  it("keeps every param's class and value through serialize -> deserialize -> rehydrate", () => {
    // The rehydrate step is part of the load path, not of deserializeProject:
    // JSON has no Vector3, so the raw round-trip hands back {x,y,z} and a Color
    // as a bare number for *every* node in the registry. What makes that safe
    // is rehydrateGraphParams, which App.tsx and ipc.ts call on the way in.
    // Which is also the risk worth naming: a third load path that forgets it
    // does not fail, it silently degrades every vector param in the file.
    const damage: string[] = [];

    for (const def of allNodes()) {
      const before = defaultParams(def);
      const project = emptyProject();
      project.canvases[0] = graphOf(def);

      let after: Record<string, unknown>;
      try {
        const reopened = deserializeProject(serializeProject(project), DEFAULT_REGISTRY);
        after = rehydrateGraphParams(reopened.canvases[0], DEFAULT_REGISTRY).nodes[0].params;
      } catch (error) {
        damage.push(`${def.type}: threw ${String(error).slice(0, 60)}`);
        continue;
      }
      damage.push(...comparableParams(before, after, def.type));
    }

    expect(damage).toEqual([]);
  });
});

describe("every node: undo restores what it snapshotted", () => {
  it("keeps every param's class and value through cloneGraph, without aliasing it", () => {
    // Undo snapshots go through cloneGraph rather than JSON, and the two fail
    // differently: JSON loses classes, a shallow clone keeps them and shares
    // them — so editing the restored graph writes back into the snapshot it
    // was restored from, and the next undo returns the edit.
    const damage: string[] = [];

    for (const def of allNodes()) {
      const before = defaultParams(def);
      let after: Record<string, unknown>;
      try {
        after = cloneGraph(graphOf(def)).nodes[0].params;
      } catch (error) {
        damage.push(`${def.type}: threw ${String(error).slice(0, 60)}`);
        continue;
      }
      damage.push(...comparableParams(before, after, def.type));

      for (const key of Object.keys(before)) {
        const a = before[key];
        // A THREE.Texture is a shared GPU resource and is passed by reference
        // on purpose — see cloneGraph's own note.
        if (!a || typeof a !== "object" || a instanceof THREE.Texture) continue;
        if (a === after[key]) damage.push(`${def.type}.${key}: aliased, not cloned (${classOf(a)})`);
      }
    }

    expect(damage).toEqual([]);
  });
});

/** Outputs worth comparing by value. An Object3D or a curve is identity, which is a different contract. */
function scalarOf(value: unknown): string | null {
  if (value == null) return String(value);
  if (typeof value === "number") return value.toFixed(6);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (value instanceof THREE.Color) return value.getHexString();
  if (value instanceof THREE.Matrix4) return value.elements.map((n) => n.toFixed(6)).join(",");
  const maybeVector = value as { isVector3?: boolean; isVector2?: boolean; isQuaternion?: boolean; toArray?: () => number[] };
  if ((maybeVector.isVector3 || maybeVector.isVector2 || maybeVector.isQuaternion) && maybeVector.toArray) {
    return maybeVector.toArray().map((n) => n.toFixed(6)).join(",");
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return value.map((n) => n.toFixed(4)).join(",");
  }
  return null;
}

/**
 * Nodes with an opt-in mode that is genuinely impure, by choice rather than by
 * accident. Not reachable from the defaults this sweep evaluates — listed so
 * that "the registry is pure" is not read as more than it says.
 */
const IMPURE_BY_OPTION: Record<string, string> = {
  "math/random-value": 'algorithm "white" draws from Math.random(), so a render disagrees with the preview it was authored in',
  "list/random-list": 'algorithm "white", same',
};

describe("every node: evaluate is pure", () => {
  it("gives the same outputs for the same inputs, params and time", () => {
    // NODE_AUTHORING §2 states this and nothing enforced it. Two fresh
    // sessions at the same frozen frame: anything that reads a wall clock or
    // an unseeded random diverges here.
    const impure: string[] = [];

    for (const def of allNodes()) {
      const graph = graphOf(def);
      const run = (session: string) => {
        try {
          return (
            (evaluateGraph(graph, DEFAULT_REGISTRY, {
              nodeId: "",
              time: 1.5,
              step: 90,
              currentFrame: 90,
              keyframes: {},
              simulationEpoch: 0,
              sessionId: session,
            } as never) as never as Map<string, Record<string, unknown>>).get("n") ?? {}
          );
        } catch {
          return {};
        }
      };

      const first = run(`pure-a-${def.type}`);
      const second = run(`pure-b-${def.type}`);
      for (const key of Object.keys(first)) {
        if (key.startsWith("__")) continue;
        const a = scalarOf(first[key]);
        const b = scalarOf(second[key]);
        if (a === null || b === null) continue;
        if (a !== b) impure.push(`${def.type}.${key}`);
      }
    }

    expect(impure).toEqual([]);
    expect(Object.keys(IMPURE_BY_OPTION).every((type) => DEFAULT_REGISTRY.has(type))).toBe(true);
  });
});

describe("every node: cutting a wire is felt immediately", () => {
  /**
   * Wire a producer into `socket`, read the result, unwire it, read again — in
   * the *same* evaluator session, because the whole question is whether the
   * node's own cache lets go.
   *
   * Reading before the next evaluation is not a detail: a node's cached mesh is
   * the same live object in both result maps, so sampling the wired state
   * afterwards samples the unwired one twice and every node looks broken. That
   * mistake produced three false findings before it was caught.
   */
  function sweep<T>(
    socket: string,
    producerType: string,
    producerSocket: string,
    producerParams: Record<string, unknown>,
    probe: (mesh: THREE.Mesh | null) => T,
  ): { type: string; wired: T; unwired: T }[] {
    const results: { type: string; wired: T; unwired: T }[] = [];

    for (const def of allNodes()) {
      if (!def.inputs?.some((input) => input.id === socket)) continue;
      if (!def.outputs?.some((output) => output.id === "geometry")) continue;
      // Primitives take the socket but have nothing to feed geometry into;
      // modifiers need the Box wired in or they have nothing to modify.
      const takesGeometry = def.inputs.some((input) => input.id === "geometry" && input.type === "geometry");

      const uid = def.type.replace(/\W/g, "_");
      const nodeId = `n_${uid}`;
      const base = (): Graph =>
        ({
          nodes: [
            { id: `p_${uid}`, type: producerType, params: { ...defaultParams(DEFAULT_REGISTRY.get(producerType)!), ...producerParams }, position: { x: 0, y: 0 } },
            { id: `b_${uid}`, type: "object/box", params: { ...defaultParams(DEFAULT_REGISTRY.get("object/box")!), color: new THREE.Color(0x0000ff) }, position: { x: 0, y: 0 } },
            { id: nodeId, type: def.type, params: defaultParams(def), position: { x: 0, y: 0 } },
          ],
          connections: takesGeometry
            ? [{ id: "g", fromNode: `b_${uid}`, fromSocket: "geometry", toNode: nodeId, toSocket: "geometry" }]
            : [],
          keyframes: {},
          markers: [],
          exposedParams: [],
        }) as never as Graph;

      const wired = base();
      (wired.connections as unknown[]).push({ id: "x", fromNode: `p_${uid}`, fromSocket: producerSocket, toNode: nodeId, toSocket: socket });

      const evaluate = (graph: Graph, frame: number) => {
        const session = `cut-${socket}-${uid}`;
        const map = evaluateGraph(graph, DEFAULT_REGISTRY, {
          nodeId: "",
          time: frame / 60,
          step: frame,
          currentFrame: frame,
          keyframes: {},
          simulationEpoch: 0,
          sessionId: session,
        } as never) as never as Map<string, Record<string, unknown>>;
        const object = map.get(nodeId)?.geometry as THREE.Object3D | undefined;
        let mesh: THREE.Mesh | null = null;
        object?.traverse?.((child) => {
          if (!mesh && (child as THREE.Mesh).isMesh) mesh = child as THREE.Mesh;
        });
        return probe(mesh);
      };

      try {
        results.push({ type: def.type, wired: evaluate(wired, 0), unwired: evaluate(base(), 1) });
      } catch {
        // A node that cannot run headless (Ray Burst needs the BVH extension)
        // is out of scope here, not a disconnection failure.
      }
    }
    return results;
  }

  const materialOf = (mesh: THREE.Mesh | null) => {
    const material = Array.isArray(mesh?.material) ? mesh?.material[0] : mesh?.material;
    return (material as THREE.MeshStandardMaterial | undefined)?.color?.getHexString() ?? null;
  };

  it("a Material unwired stops colouring the node that had it", () => {
    const rows = sweep("material", "material/standard", "material", { color: new THREE.Color(0xff0000) }, materialOf);
    // A sweep that matched nothing would pass silently.
    expect(rows.length).toBeGreaterThan(10);
    const stuck = rows.filter((row) => row.wired === "ff0000" && row.unwired === "ff0000").map((row) => row.type);
    expect(stuck).toEqual([]);
  });

  it("a Texture unwired stops being mapped", () => {
    const rows = sweep("texture", "texture/procedural", "texture", {}, (mesh) => {
      const material = Array.isArray(mesh?.material) ? mesh?.material[0] : mesh?.material;
      return !!(material as THREE.MeshStandardMaterial | undefined)?.map;
    });
    expect(rows.length).toBeGreaterThan(10);
    const stuck = rows
      .filter((row) => row.wired && row.unwired)
      .map((row) => row.type)
      // The Decal falls back to a built-in placeholder texture rather than to
      // nothing, so its map stays truthy by design — see getDefaultTexture.
      .filter((type) => type !== "object/decal");
    expect(stuck).toEqual([]);
  });
});
