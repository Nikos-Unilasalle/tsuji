import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { CLOTH_NODE } from "./cloth";
import { DEFAULT_REGISTRY } from "./index";
import { evaluateGraph } from "../evaluate";
import { EvalContext, Graph } from "../types";
import { buildClothTopology, createClothState, nearestParticle, stepCloth } from "../../three/physics/clothSolver";

function ctx(time: number, step: number): EvalContext {
  return { time, step, nodeId: `cloth-${Math.random()}`, simulationEpoch: 0 };
}

function clothMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 4, 4), new THREE.MeshStandardMaterial());
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Runs the node for `frames` frames at 60fps against one stable node id. */
function run(inputs: Record<string, unknown>, frames: number, nodeId = "cloth-run"): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (let f = 0; f < frames; f++) {
    out = CLOTH_NODE.evaluate(inputs, CLOTH_NODE.defaultParams as Record<string, unknown>, {
      ...ctx(f / 60, f),
      nodeId,
    });
  }
  return out;
}

function meshOf(out: Record<string, unknown>): THREE.Mesh {
  const object = out.geometry as THREE.Object3D;
  let found: THREE.Mesh | null = null;
  object.traverse((child) => {
    if (!found && (child as THREE.Mesh).isMesh) found = child as THREE.Mesh;
  });
  return found as unknown as THREE.Mesh;
}

function lowestY(mesh: THREE.Mesh): number {
  const attr = mesh.geometry.getAttribute("position");
  let min = Infinity;
  for (let v = 0; v < attr.count; v++) min = Math.min(min, attr.getY(v));
  return min;
}

function lowestWorldY(mesh: THREE.Mesh): number {
  const attr = mesh.geometry.getAttribute("position");
  const world = mesh.matrix;
  const point = new THREE.Vector3();
  let min = Infinity;
  for (let v = 0; v < attr.count; v++) {
    min = Math.min(min, point.fromBufferAttribute(attr, v).applyMatrix4(world).y);
  }
  return min;
}

describe("cloth topology", () => {
  test("welds duplicate positions and builds edges", () => {
    const topology = buildClothTopology(new THREE.PlaneGeometry(1, 1, 2, 2), 0.0001)!;
    expect(topology.count).toBe(9);
    expect(topology.edges.length / 2).toBe(topology.restLengths.length);
    expect(topology.restLengths.length).toBeGreaterThan(0);
    expect([...topology.restLengths].every((l) => l > 0)).toBe(true);
  });

  test("a red vertex-color channel becomes the cloth mask", () => {
    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    const colors = new Float32Array(geometry.getAttribute("position").count * 3);
    colors.fill(0);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const topology = buildClothTopology(geometry, 0.0001)!;
    expect([...topology.influence].every((i) => i === 0)).toBe(true);
  });

  test("no color attribute means cloth everywhere", () => {
    const topology = buildClothTopology(new THREE.PlaneGeometry(1, 1, 1, 1), 0.0001)!;
    expect([...topology.influence].every((i) => i === 1)).toBe(true);
  });

  test("geometry with no position attribute is refused rather than simulated", () => {
    expect(buildClothTopology(new THREE.BufferGeometry(), 0.0001)).toBeNull();
  });
});

describe("cloth solver", () => {
  const baseParams = {
    dt: 1 / 60,
    time: 0,
    gravity: new THREE.Vector3(0, -9.81, 0),
    wind: new THREE.Vector3(),
    windFlutter: 0,
    damping: 0.97,
    stiffness: 0,
    iterations: 4,
    pins: [],
    colliders: [],
  };

  function freshState() {
    const topology = buildClothTopology(new THREE.PlaneGeometry(1, 1, 3, 3), 0.0001)!;
    const state = createClothState(topology, new THREE.Matrix4());
    const restWorld = state.position.slice();
    return { state, restWorld };
  }

  test("dt of 0 leaves the cloth exactly where it was", () => {
    const { state, restWorld } = freshState();
    const before = state.position.slice();
    stepCloth(state, { ...baseParams, dt: 0, restWorld });
    expect([...state.position]).toEqual([...before]);
  });

  test("gravity pulls the cloth down", () => {
    const { state, restWorld } = freshState();
    for (let f = 0; f < 30; f++) stepCloth(state, { ...baseParams, time: f / 60, restWorld });
    expect(state.position[1]).toBeLessThan(restWorld[1]);
    expect([...state.position].every(Number.isFinite)).toBe(true);
  });

  test("a pinned particle stays on its pin", () => {
    const { state, restWorld } = freshState();
    const anchor = new THREE.Vector3(restWorld[0], restWorld[1], restWorld[2]);
    const particle = nearestParticle(state, anchor);
    for (let f = 0; f < 30; f++) {
      stepCloth(state, { ...baseParams, time: f / 60, restWorld, pins: [{ particle, position: anchor }] });
    }
    expect(state.position[particle * 3 + 1]).toBeCloseTo(anchor.y, 5);
  });

  test("a collider pushes vertices out of its sphere", () => {
    const { state, restWorld } = freshState();
    const collider = { center: new THREE.Vector3(0, -0.4, 0), radius: 0.5 };
    for (let f = 0; f < 30; f++) {
      stepCloth(state, { ...baseParams, time: f / 60, restWorld, colliders: [collider] });
    }
    for (let p = 0; p < state.topology.count; p++) {
      const point = new THREE.Vector3(state.position[p * 3], state.position[p * 3 + 1], state.position[p * 3 + 2]);
      expect(point.distanceTo(collider.center)).toBeGreaterThanOrEqual(collider.radius - 1e-4);
    }
  });

  test("full stiffness holds the cloth on its rest shape", () => {
    const { state, restWorld } = freshState();
    for (let f = 0; f < 60; f++) {
      stepCloth(state, { ...baseParams, time: f / 60, restWorld, stiffness: 1 });
    }
    for (let i = 0; i < restWorld.length; i++) expect(state.position[i]).toBeCloseTo(restWorld[i], 2);
  });
});

describe("CLOTH_NODE", () => {
  test("nothing wired in does not throw and returns no mesh", () => {
    const out = CLOTH_NODE.evaluate({}, CLOTH_NODE.defaultParams as Record<string, unknown>, ctx(0, 0));
    expect(out.geometry).toBeUndefined();
    expect(out.matrix).toBeInstanceOf(THREE.Matrix4);
  });

  test("a non-mesh object is passed straight through", () => {
    const points = new THREE.Points(new THREE.BufferGeometry());
    const out = CLOTH_NODE.evaluate({ geometry: points }, CLOTH_NODE.defaultParams as Record<string, unknown>, ctx(0, 0));
    expect(out.geometry).toBe(points);
  });

  test("the cloth falls under gravity", () => {
    const source = clothMesh();
    const start = lowestY(source);
    const out = run({ geometry: source }, 40, "cloth-fall");
    expect(lowestY(meshOf(out))).toBeLessThan(start);
  });

  test("the same mesh comes back every frame", () => {
    const source = clothMesh();
    const first = run({ geometry: source }, 1, "cloth-identity");
    const second = run({ geometry: source }, 1, "cloth-identity");
    expect(second.geometry).toBe(first.geometry);
  });

  test("the source material is passed through untouched", () => {
    const source = clothMesh();
    const out = run({ geometry: source }, 2, "cloth-material");
    expect(meshOf(out).material).toBe(source.material);
  });

  test("an Empty's pivot pins the nearest vertex to it", () => {
    const source = clothMesh();
    const pin = new THREE.Group();
    pin.position.set(-0.5, 0.5, 0);
    pin.updateMatrix();
    const out = run({ geometry: source, pin0: pin }, 40, "cloth-pin");

    const attr = meshOf(out).geometry.getAttribute("position");
    let nearest = Infinity;
    for (let v = 0; v < attr.count; v++) {
      nearest = Math.min(nearest, new THREE.Vector3().fromBufferAttribute(attr, v).distanceTo(pin.position));
    }
    expect(nearest).toBeLessThan(1e-4);
  });

  test("scrubbing backwards puts the cloth back on its rest shape", () => {
    const source = clothMesh();
    const params = CLOTH_NODE.defaultParams as Record<string, unknown>;
    const rest = lowestY(source);
    for (let f = 0; f < 40; f++) {
      CLOTH_NODE.evaluate({ geometry: source }, params, { ...ctx(f / 60, f), nodeId: "cloth-scrub" });
    }
    const out = CLOTH_NODE.evaluate({ geometry: source }, params, { ...ctx(0, 0), nodeId: "cloth-scrub" });
    expect(lowestY(meshOf(out))).toBeCloseTo(rest, 5);
  });

  test("a wired Reset holds the cloth at rest", () => {
    const source = clothMesh();
    const rest = lowestY(source);
    const out = run({ geometry: source, reset: 1 }, 40, "cloth-reset");
    expect(lowestY(meshOf(out))).toBeCloseTo(rest, 5);
  });

  test("positions stay finite under an absurd wind", () => {
    const source = clothMesh();
    const out = run({ geometry: source, wind: new THREE.Vector3(1e4, 0, 1e4) }, 40, "cloth-wind");
    const attr = meshOf(out).geometry.getAttribute("position");
    for (let v = 0; v < attr.count; v++) {
      expect(Number.isFinite(attr.getX(v))).toBe(true);
      expect(Number.isFinite(attr.getY(v))).toBe(true);
    }
  });

  test("a Plane wired through the evaluator falls and keeps the plane's material", () => {
    const defaults = (type: string) => ({ ...(DEFAULT_REGISTRY.get(type)!.defaultParams as Record<string, unknown>) });
    const graph = {
      nodes: [
        { id: "plane", type: "object/plane", params: defaults("object/plane"), position: { x: 0, y: 0 } },
        { id: "cloth", type: "physics/cloth", params: defaults("physics/cloth"), position: { x: 0, y: 0 } },
      ],
      connections: [{ id: "c1", fromNode: "plane", fromSocket: "geometry", toNode: "cloth", toSocket: "geometry" }],
      keyframes: {},
      markers: [],
      exposedParams: [],
    } as never as Graph;

    let results = new Map<string, Record<string, unknown>>();
    for (let f = 0; f < 40; f++) {
      results = evaluateGraph(graph, DEFAULT_REGISTRY, {
        nodeId: "",
        time: f / 60,
        step: f,
        currentFrame: f,
        keyframes: {},
        simulationEpoch: 0,
        sessionId: "cloth-graph",
      } as never) as never;
    }

    const clothMeshOut = meshOf(results.get("cloth") as Record<string, unknown>);
    const planeMeshOut = meshOf(results.get("plane") as Record<string, unknown>);
    expect(clothMeshOut.material).toBe(planeMeshOut.material);
    // World space, not the geometry's own: the Plane node lays its mesh flat
    // by rotating it, so a sheet falling straight down moves along local Z.
    expect(lowestWorldY(clothMeshOut)).toBeLessThan(lowestWorldY(planeMeshOut));
  });

  test("flat shading emits one vertex per face corner with per-face normals", () => {
    const source = clothMesh();
    const params = { ...(CLOTH_NODE.defaultParams as Record<string, unknown>), shade: "flat" };
    const out = CLOTH_NODE.evaluate({ geometry: source }, params, { ...ctx(0, 0), nodeId: "cloth-flat" });
    const geometry = meshOf(out).geometry;

    expect(geometry.getIndex()).toBeNull();
    expect(geometry.getAttribute("position").count).toBe(source.geometry.getIndex()!.count);

    const normal = geometry.getAttribute("normal");
    for (let f = 0; f < normal.count; f += 3) {
      expect(normal.getX(f + 1)).toBeCloseTo(normal.getX(f), 6);
      expect(normal.getY(f + 2)).toBeCloseTo(normal.getY(f), 6);
    }
  });

  test("smooth shading keeps the source's vertex count and unit normals", () => {
    const source = clothMesh();
    const out = run({ geometry: source }, 2, "cloth-smooth");
    const geometry = meshOf(out).geometry;

    expect(geometry.getAttribute("position").count).toBe(source.geometry.getAttribute("position").count);
    const normal = geometry.getAttribute("normal");
    for (let v = 0; v < normal.count; v++) {
      expect(new THREE.Vector3().fromBufferAttribute(normal, v).length()).toBeCloseTo(1, 5);
    }
  });

  test("switching shade rebuilds the geometry without resetting the simulation", () => {
    const source = clothMesh();
    const smooth = { ...(CLOTH_NODE.defaultParams as Record<string, unknown>) };
    const flat = { ...smooth, shade: "flat" };
    let out: Record<string, unknown> = {};
    for (let f = 0; f < 30; f++) {
      out = CLOTH_NODE.evaluate({ geometry: source }, smooth, { ...ctx(f / 60, f), nodeId: "cloth-shade-switch" });
    }
    const fallen = lowestY(meshOf(out));

    out = CLOTH_NODE.evaluate({ geometry: source }, flat, { ...ctx(30 / 60, 30), nodeId: "cloth-shade-switch" });
    expect(meshOf(out).geometry.getIndex()).toBeNull();
    expect(lowestY(meshOf(out))).toBeLessThanOrEqual(fallen);
  });

  test("Shade is offered in the param panel as a select", () => {
    const field = CLOTH_NODE.paramFields!.find((f) => f.id === "shade");
    expect(field).toMatchObject({ kind: "select", options: ["smooth", "flat"] });
  });

  test("an unknown shade value falls back to smooth", () => {
    const source = clothMesh();
    const params = { ...(CLOTH_NODE.defaultParams as Record<string, unknown>), shade: "banana" };
    const out = CLOTH_NODE.evaluate({ geometry: source }, params, { ...ctx(0, 0), nodeId: "cloth-shade-bad" });
    expect(meshOf(out).geometry.getIndex()).not.toBeNull();
  });

  test("pin sockets grow as they are wired", () => {
    const sockets = CLOTH_NODE.dynamicInputs!([
      { id: "c", fromNode: "a", fromSocket: "geometry", toNode: "b", toSocket: "pin0" },
    ]);
    expect(sockets.filter((s) => s.id.startsWith("pin")).map((s) => s.id)).toEqual(["pin0", "pin1"]);
    expect(sockets.filter((s) => s.id.startsWith("collider")).map((s) => s.id)).toEqual(["collider0"]);
  });
});
