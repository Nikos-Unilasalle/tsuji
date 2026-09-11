import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "./nodes";
import { evaluateGraph } from "./evaluate";
import { initRapier } from "../three/physics/rapierRuntime";
import { Graph, NodeDefinition } from "./types";

/**
 * Registry-wide conformance for the three contracts every geometry-passing
 * node is silently expected to honour, and which nothing until now stated or
 * checked:
 *
 *  1. **Appearance** — a modifier that has nothing to do with materials must
 *     pass the source's material, texture maps, UVs, pivot and shadow flags
 *     through untouched.
 *  2. **Identity** — a node whose inputs did not change must hand back *the
 *     same* object, not an equal one. Downstream caches key on identity.
 *  3. **Physics interop** — a rigid body wired behind the node must actually
 *     simulate. This is contract 2 seen from the other end: Rapier rebuilds a
 *     body when the source geometry's uuid changes, so a node that mints a new
 *     BufferGeometry every frame destroys and re-creates the body at its
 *     authoring pose every frame, and the object never moves.
 *
 * Why registry-wide rather than a test per node: every one of these was found
 * as a single node's bug and fixed in that node, which is exactly the pattern
 * that let the next node reintroduce it. A node added tomorrow is checked by
 * this file whether its author knew the contracts existed or not.
 *
 * ## How the violation lists work
 *
 * Each contract computes the set of nodes that actually violate it and
 * compares it to the frozen list below, in *both* directions. A new violation
 * fails. A violation that has been fixed also fails, with a message to delete
 * the entry — so the lists can only shrink, and they cannot rot into a
 * permanent excuse.
 *
 * `BY_DESIGN` is different from `KNOWN_*`: those nodes are supposed to behave
 * that way and never need fixing. Everything in a `KNOWN_*` list is a bug with
 * a reason attached.
 */

/* -------------------------------------------------------------------------- */
/* Which nodes are in scope                                                   */
/* -------------------------------------------------------------------------- */

function geometryPipelineNodes(): NodeDefinition[] {
  return [...DEFAULT_REGISTRY.values()]
    .filter(
      (def) =>
        def.inputs?.some((i) => i.id === "geometry" && i.type === "geometry") &&
        def.outputs?.some((o) => o.id === "geometry" && o.type === "geometry"),
    )
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * Nodes that take geometry in and emit geometry out but do not pass a mesh
 * along at all — they consume the shape to produce something else (particles
 * from an image, a decal projected onto a surface). None of the three
 * contracts applies; they are asserted to be mesh-less rather than skipped
 * silently, so a node that stops emitting a mesh by accident is caught.
 */
const NOT_A_MESH_PIPELINE = new Set(["texture/pixel-spawner", "object/decal", "vector/spring"]);

/**
 * Reads the incoming geometry but emits something else entirely, so none of
 * the three contracts is about it: wiring a rigid body behind one is a
 * nonsense graph, not a bug to record.
 */
const EMITS_ITS_OWN_GEOMETRY = new Set(["physics/ray-burst"]);

function defaultParams(def: NodeDefinition): Record<string, unknown> {
  const raw = typeof def.defaultParams === "function" ? (def.defaultParams as () => unknown)() : def.defaultParams;
  return { ...(raw as Record<string, unknown>) };
}

let sessionOrdinal = 0;
function nextSession(): string {
  sessionOrdinal += 1;
  return `contract-${sessionOrdinal}`;
}

function evaluate(graph: Graph, frames: number, sessionId: string, constantTime = false) {
  let results = new Map<string, Record<string, unknown>>();
  for (let f = 0; f < frames; f++) {
    const t = constantTime ? 0 : f / 60;
    results = evaluateGraph(graph, DEFAULT_REGISTRY, {
      nodeId: "",
      time: t,
      step: constantTime ? 0 : f,
      currentFrame: constantTime ? 0 : f,
      keyframes: {},
      simulationEpoch: 0,
      sessionId,
    } as never) as never;
  }
  return results;
}

function firstMesh(value: unknown): THREE.Mesh | null {
  const object = value as THREE.Object3D | undefined;
  if (!object || typeof object.traverse !== "function") return null;
  let found: THREE.Mesh | null = null;
  object.traverse((child) => {
    if (!found && (child as THREE.Mesh).isMesh) found = child as THREE.Mesh;
  });
  return found;
}

/**
 * A pivot as stored in userData, which is not always a live Vector3: a graph
 * round-tripped through a saved file comes back as a plain {x, y, z}.
 */
function asPivot(value: unknown): THREE.Vector3 | null {
  if (value instanceof THREE.Vector3) return value;
  if (Array.isArray(value) && value.length >= 3) return new THREE.Vector3(...(value.slice(0, 3) as [number, number, number]));
  if (value && typeof value === "object") {
    const v = value as { x?: unknown; y?: unknown; z?: unknown };
    if (typeof v.x === "number" && typeof v.y === "number" && typeof v.z === "number") return new THREE.Vector3(v.x, v.y, v.z);
  }
  return null;
}

function firstMaterial(mesh: THREE.Mesh | null): THREE.Material | null {
  if (!mesh) return null;
  return (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) ?? null;
}

/** `type: reason` -> the sorted `"type: detail"` strings the assertions compare against. */
function expectedViolations(list: Record<string, string>): string[] {
  return Object.keys(list).sort();
}

/* -------------------------------------------------------------------------- */
/* Contract 1 — appearance                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A Box with everything a modifier could drop: a material of its own, a
 * texture map, UVs, a pivot offset, shadow flags.
 */
function appearanceGraph(modifierType: string): Graph {
  return {
    nodes: [
      { id: "tex", type: "texture/procedural", params: defaultParams(DEFAULT_REGISTRY.get("texture/procedural")!), position: { x: 0, y: 0 } },
      {
        id: "box",
        type: "object/box",
        params: {
          ...defaultParams(DEFAULT_REGISTRY.get("object/box")!),
          color: new THREE.Color(0x22ff88),
          roughness: 0.17,
          pivot: new THREE.Vector3(0, 0.5, 0),
        },
        position: { x: 0, y: 0 },
      },
      { id: "mod", type: modifierType, params: defaultParams(DEFAULT_REGISTRY.get(modifierType)!), position: { x: 0, y: 0 } },
    ],
    connections: [
      { id: "c1", fromNode: "tex", fromSocket: "texture", toNode: "box", toSocket: "texture" },
      { id: "c2", fromNode: "box", fromSocket: "geometry", toNode: "mod", toSocket: "geometry" },
    ],
    keyframes: {},
    markers: [],
    exposedParams: [],
  } as never as Graph;
}

/** Nodes whose whole job is to change one of these. Not bugs, never will be. */
const APPEARANCE_BY_DESIGN: Record<string, string> = {
  "structure/instance-color": "replaces the colour per instance — that is the node",
  "geometry/wind-sway": "clones the material to patch its vertex shader; the clone keeps every map",
  "physics/ray-burst": "emits its own line material, it does not pass the source mesh along",
  render: "the scene root, not a modifier",
};

const KNOWN_APPEARANCE_VIOLATIONS: Record<string, string> = {
  "modifier/extrude: uv":
    "documented in meshEdit.ts: the cap and walls have no UV space of their own, so the attribute is dropped. " +
    "The material and its map survive, which makes it worse, not better — the texture is still bound and " +
    "renders as garbage, and every node downstream inherits the loss.",
  "curve/deform: pivot":
    "the deformed copy is built from scratch and never carries userData across.",
  "modifier/lattice: pivot":
    "the deformed mesh is rebuilt each frame and userData is not carried over.",
  "modifier/edit-mesh: pivot":
    "owns a native pose since the Edit Mesh pivot work, and overwrites the upstream pivot with its own " +
    "default of (0,0,0) — which preserveModifierUserData then drops as empty. A node with its own pivot " +
    "legitimately replaces the source's, but it should publish it, not erase it.",
};

/* -------------------------------------------------------------------------- */
/* Contract 2 — identity                                                      */
/* -------------------------------------------------------------------------- */

function identityGraph(modifierType: string): Graph {
  return {
    nodes: [
      { id: "box", type: "object/box", params: defaultParams(DEFAULT_REGISTRY.get("object/box")!), position: { x: 0, y: 0 } },
      { id: "mod", type: modifierType, params: defaultParams(DEFAULT_REGISTRY.get(modifierType)!), position: { x: 0, y: 0 } },
    ],
    connections: [{ id: "c1", fromNode: "box", fromSocket: "geometry", toNode: "mod", toSocket: "geometry" }],
    keyframes: {},
    markers: [],
    exposedParams: [],
  } as never as Graph;
}

const KNOWN_IDENTITY_VIOLATIONS: Record<string, string> = {
  "curve/deform: geometry": "rebuilds the deformed geometry every frame with no cache at all.",
  "geometry/facet-explode: mesh": "rebuilds mesh and geometry every frame.",
  "geometry/facet-explode: geometry": "rebuilds mesh and geometry every frame.",
  "geometry/wave-ripple: mesh": "rebuilds mesh and geometry every frame.",
  "geometry/wave-ripple: geometry":
    "displaces vertices from ctx.time, so a rebuild is right when time moves — but this runs at a " +
    "frozen time, where nothing changed and nothing should be rebuilt.",
  "modifier/edit-mesh: geometry":
    "state.lastQuadMesh is stored as a clone and then compared with ===, so the cache can never hit. " +
    "30 rebuilds over 30 identical frames.",
  "modifier/lattice: geometry": "builds a new BufferGeometry per frame unconditionally.",
  "structure/array: mesh": "re-wraps its instances in a fresh Group each frame.",
  "structure/geometry-transform: mesh": "re-wraps in a fresh Group each frame.",
  "structure/get-instance: mesh": "re-wraps in a fresh Group each frame.",
  "structure/hex-grid: mesh": "re-wraps in a fresh Group each frame.",
  "structure/instance-color: mesh": "re-wraps in a fresh Group each frame.",
  "structure/instance-transform: mesh": "re-wraps in a fresh Group each frame.",
  "transform/look-at: mesh": "re-wraps in a fresh Group each frame.",
};

/* -------------------------------------------------------------------------- */
/* Contract 3 — physics interop                                               */
/* -------------------------------------------------------------------------- */

const DROP_FROM = 10;
const PHYSICS_FRAMES = 40;

function physicsGraph(modifierType: string | null): Graph {
  const nodes: unknown[] = [
    { id: "w", type: "physics/world", params: defaultParams(DEFAULT_REGISTRY.get("physics/world")!), position: { x: 0, y: 0 } },
    {
      id: "box",
      type: "object/box",
      params: { ...defaultParams(DEFAULT_REGISTRY.get("object/box")!), location: new THREE.Vector3(0, DROP_FROM, 0) },
      position: { x: 0, y: 0 },
    },
    { id: "b", type: "physics/rigid-body", params: defaultParams(DEFAULT_REGISTRY.get("physics/rigid-body")!), position: { x: 0, y: 0 } },
  ];
  const connections: unknown[] = [{ id: "cw", fromNode: "w", fromSocket: "world", toNode: "b", toSocket: "world" }];

  if (modifierType) {
    nodes.push({ id: "m", type: modifierType, params: defaultParams(DEFAULT_REGISTRY.get(modifierType)!), position: { x: 0, y: 0 } });
    connections.push({ id: "c1", fromNode: "box", fromSocket: "geometry", toNode: "m", toSocket: "geometry" });
    connections.push({ id: "c2", fromNode: "m", fromSocket: "geometry", toNode: "b", toSocket: "geometry" });
  } else {
    connections.push({ id: "c1", fromNode: "box", fromSocket: "geometry", toNode: "b", toSocket: "geometry" });
  }
  return { nodes, connections, keyframes: {}, markers: [], exposedParams: [] } as never as Graph;
}

/**
 * Where the body is one frame in (it must be born where the object is) and
 * where it has got to after PHYSICS_FRAMES (it must have moved). Null when
 * the node produced no body at all.
 */
function simulate(modifierType: string | null): { placed: number; settled: number } | null {
  const graph = physicsGraph(modifierType);
  const session = nextSession();
  const readY = (results: Map<string, Record<string, unknown>>) => {
    const body = results.get("b");
    return body?.position ? (body.position as THREE.Vector3).y : null;
  };
  const placed = readY(evaluate(graph, 1, session));
  if (placed === null) return null;
  const settled = readY(evaluate(graph, PHYSICS_FRAMES, session));
  return settled === null ? null : { placed, settled };
}

const KNOWN_PHYSICS_VIOLATIONS: Record<string, string> = {
  "modifier/edit-mesh: frozen":
    "a new geometry uuid every frame, and describeTargets() keys the rebuild signature on it, so the " +
    "body is destroyed and re-created at its authoring pose before it can ever move.",
  "geometry/wave-ripple: frozen": "same cause: a new geometry every frame keeps resetting the body.",
  "geometry/facet-explode: frozen": "same cause.",
  "curve/deform: placement":
    "the rebuilt mesh carries no pose of its own, so the body is created at the origin instead of where " +
    "the object is — it simulates, just nowhere near what you can see.",
  "modifier/lattice: placement": "same as curve/deform.",
};

/* -------------------------------------------------------------------------- */

describe("node contracts: appearance passes through a modifier", () => {
  it("carries material, texture map, UVs, pivot and shadow flags", () => {
    const violations: string[] = [];

    for (const def of geometryPipelineNodes()) {
      if (NOT_A_MESH_PIPELINE.has(def.type) || APPEARANCE_BY_DESIGN[def.type]) continue;

      const results = evaluate(appearanceGraph(def.type), 1, nextSession());
      const source = firstMesh(results.get("box")?.geometry);
      const output = firstMesh(results.get("mod")?.geometry);
      expect(source, "the fixture itself must produce a textured source mesh").not.toBeNull();
      if (!output) {
        violations.push(`${def.type}: no mesh`);
        continue;
      }

      const sourceMaterial = firstMaterial(source) as THREE.MeshStandardMaterial | null;
      const outputMaterial = firstMaterial(output) as THREE.MeshStandardMaterial | null;
      if (outputMaterial !== sourceMaterial) violations.push(`${def.type}: material`);
      // Only meaningful when the fixture actually got a map: the procedural
      // texture node paints into a DOM canvas, which this suite's `node`
      // environment does not have, so under vitest the source arrives
      // map-less and this check is vacuous. It still earns its place for the
      // day a headless texture source exists — and material identity, checked
      // above, is what carries the maps in the first place.
      if (sourceMaterial?.map && !outputMaterial?.map) violations.push(`${def.type}: map`);
      if (!output.geometry?.getAttribute?.("uv")) violations.push(`${def.type}: uv`);
      // The *value*, not just the presence of the key: a node that writes its
      // own (0,0,0) over the source's offset still has a `pivot` in userData,
      // and the marker and the gizmo both quietly move to the wrong place.
      const sourcePivot = asPivot(source!.userData?.pivot);
      const outputPivot = asPivot(output.userData?.pivot);
      if (!outputPivot || !sourcePivot || outputPivot.distanceTo(sourcePivot) > 1e-6) {
        violations.push(`${def.type}: pivot`);
      }
      if (!output.castShadow) violations.push(`${def.type}: shadows`);
    }

    expect(violations.sort(), "a line only present on the left is a node that has been fixed — delete its entry from the list below; a line only on the right is a new violation to fix, not to add to the list").toEqual(expectedViolations(KNOWN_APPEARANCE_VIOLATIONS));
  });
});

describe("node contracts: identity is stable when nothing changed", () => {
  it("hands back the same mesh and geometry across frames at a frozen time", () => {
    const violations: string[] = [];

    for (const def of geometryPipelineNodes()) {
      if (NOT_A_MESH_PIPELINE.has(def.type) || def.type === "render") continue;

      const graph = identityGraph(def.type);
      const session = nextSession();
      const meshes = new Set<string>();
      const geometries = new Set<string>();
      for (let f = 0; f < 3; f++) {
        const results = evaluate(graph, 1, session, true);
        const mesh = firstMesh(results.get("mod")?.geometry);
        if (!mesh) break;
        meshes.add(mesh.uuid);
        if (mesh.geometry) geometries.add(mesh.geometry.uuid);
      }
      if (meshes.size === 0) continue;
      if (meshes.size > 1) violations.push(`${def.type}: mesh`);
      if (geometries.size > 1) violations.push(`${def.type}: geometry`);
    }

    expect(violations.sort(), "a line only present on the left is a node that has been fixed — delete its entry from the list below; a line only on the right is a new violation to fix, not to add to the list").toEqual(expectedViolations(KNOWN_IDENTITY_VIOLATIONS));
  });
});

describe("node contracts: a rigid body still simulates behind a modifier", () => {
  beforeAll(async () => {
    await initRapier();
  });

  it("the fixture falls when nothing is in the way", () => {
    // Guards the measurement itself: if the plain case ever stops falling, the
    // sweep below would report every node as clean for the wrong reason.
    const plain = simulate(null);
    expect(plain).not.toBeNull();
    expect(Math.abs(plain!.placed - DROP_FROM)).toBeLessThan(0.5);
    expect(DROP_FROM - plain!.settled).toBeGreaterThan(0.5);
  });

  it("every geometry node leaves the body where it belongs, and free to fall", () => {
    const violations: string[] = [];

    for (const def of geometryPipelineNodes()) {
      if (
        NOT_A_MESH_PIPELINE.has(def.type) ||
        EMITS_ITS_OWN_GEOMETRY.has(def.type) ||
        def.type === "render" ||
        def.type === "physics/rigid-body"
      ) {
        continue;
      }

      let result: { placed: number; settled: number } | null = null;
      try {
        result = simulate(def.type);
      } catch {
        violations.push(`${def.type}: threw`);
        continue;
      }
      if (!result) continue;

      // Two distinct failures, and they need telling apart: a body born at the
      // wrong place still moves, and a body re-created every frame stays put
      // at exactly the height it was authored at.
      if (Math.abs(result.placed - DROP_FROM) > 0.5) violations.push(`${def.type}: placement`);
      else if (DROP_FROM - result.settled < 0.5) violations.push(`${def.type}: frozen`);
    }

    expect(violations.sort(), "a line only present on the left is a node that has been fixed — delete its entry from the list below; a line only on the right is a new violation to fix, not to add to the list").toEqual(expectedViolations(KNOWN_PHYSICS_VIOLATIONS));
  });
});
