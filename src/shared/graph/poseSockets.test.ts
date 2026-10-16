import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { evaluateGraph } from "./evaluate";
import { DEFAULT_REGISTRY } from "./nodes";
import { applyRotationScalePatch } from "./poseSockets";
import { Connection, EvalContext, Graph, NodeInstance } from "./types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "" };

function node(id: string, type: string, params: Record<string, unknown> = {}): NodeInstance {
  return { id, type, params, position: { x: 0, y: 0 } };
}

function edge(fromNode: string, fromSocket: string, toNode: string, toSocket: string): Connection {
  return { id: `${fromNode}.${fromSocket}->${toNode}.${toSocket}`, fromNode, fromSocket, toNode, toSocket };
}

function graph(nodes: NodeInstance[], connections: Connection[]): Graph {
  return { nodes, connections, keyframes: {}, markers: [], exposedParams: [] };
}

function poseOf(results: ReturnType<typeof evaluateGraph>, id: string) {
  const obj = results.get(id)?.geometry as THREE.Object3D;
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  obj.matrix.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
}

const AT = new THREE.Vector3(3, 0.5, 0);

describe("pose sockets", () => {
  it("objects get Parent, Location, Rotation, Scale in that order", () => {
    const ids = DEFAULT_REGISTRY.get("object/cylinder")!.inputs.map((s) => s.id);
    const i = ids.indexOf("matrix");
    expect(ids.slice(i, i + 4)).toEqual(["matrix", "location", "rotation", "scale"]);
    expect(DEFAULT_REGISTRY.get("object/cylinder")!.inputs[i].label).toBe("Parent");
  });

  it("a value wired into Rotation turns the object where it stands, not around the world origin", () => {
    const results = evaluateGraph(
      graph(
        [
          node("angle", "value/constant", { value: Math.PI / 2 }),
          node("vec", "vector/compose", { useX: false, useZ: false }),
          node("wheel", "object/cylinder", { location: AT.clone(), rotation: new THREE.Vector3(0, 0, Math.PI / 2) }),
        ],
        [edge("angle", "out", "vec", "y"), edge("vec", "out", "wheel", "rotation")],
      ),
      DEFAULT_REGISTRY,
      CTX,
    );
    const pose = poseOf(results, "wheel");
    expect(pose.position.distanceTo(AT)).toBeLessThan(1e-9);
    // Y was driven, X and Z were left unticked: Z keeps the 90° typed in the panel.
    const turned = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, Math.PI / 2, "YZX"));
    expect(pose.quaternion.angleTo(turned)).toBeLessThan(1e-6);
  });

  it("Location and Scale sockets drive their params too", () => {
    const results = evaluateGraph(
      graph(
        [
          node("loc", "vector/compose", { x: 1, y: 2, z: 3 }),
          node("scl", "vector/compose", { x: 2, y: 2, z: 2 }),
          node("box", "object/box"),
        ],
        [edge("loc", "out", "box", "location"), edge("scl", "out", "box", "scale")],
      ),
      DEFAULT_REGISTRY,
      CTX,
    );
    const pose = poseOf(results, "box");
    expect(pose.position.toArray()).toEqual([1, 2, 3]);
    expect(pose.scale.x).toBeCloseTo(2, 9);
  });

  it("the Parent input still carries the object along", () => {
    const results = evaluateGraph(
      graph(
        [
          node("parent", "transform", { location: new THREE.Vector3(10, 0, 0) }),
          node("box", "object/box", { location: AT.clone() }),
        ],
        [edge("parent", "matrix", "box", "matrix")],
      ),
      DEFAULT_REGISTRY,
      CTX,
    );
    expect(poseOf(results, "box").position.distanceTo(new THREE.Vector3(13, 0.5, 0))).toBeLessThan(1e-9);
  });

  it("does not touch nodes whose own Location/Rotation/Scale mean something else", () => {
    expect(DEFAULT_REGISTRY.get("transform")!.poseSockets).toBeFalsy();
    expect(DEFAULT_REGISTRY.get("object/laser-beam")!.poseSockets).toBeFalsy();
  });
});

describe("Apply Rotation & Scale", () => {
  const tipped = {
    location: new THREE.Vector3(3, 0.5, 0),
    rotation: new THREE.Vector3(0.3, 0.2, Math.PI / 2),
    scale: new THREE.Vector3(1.6, 0.5, 1.6),
    pivot: new THREE.Vector3(0, 0.2, 0.1),
  };

  function matrixOf(params: Record<string, unknown>, extra: { nodes?: NodeInstance[]; connections?: Connection[] } = {}) {
    const results = evaluateGraph(
      graph([node("wheel", "object/cylinder", params), ...(extra.nodes ?? [])], extra.connections ?? []),
      DEFAULT_REGISTRY,
      CTX,
    );
    return (results.get("wheel")?.geometry as THREE.Object3D).matrix.clone();
  }

  function applied(params: Record<string, unknown>) {
    const withDefaults = { ...DEFAULT_REGISTRY.get("object/cylinder")!.defaultParams, ...params };
    return { ...params, ...applyRotationScalePatch(withDefaults) };
  }

  it("leaves the object exactly where it was, with Rotation 0 and Scale 1", () => {
    const before = matrixOf(tipped);
    const after = applied(tipped);
    expect(after.rotation).toEqual(new THREE.Vector3());
    expect(after.scale).toEqual(new THREE.Vector3(1, 1, 1));
    const m = matrixOf(after);
    for (let i = 0; i < 16; i++) expect(m.elements[i]).toBeCloseTo(before.elements[i], 9);
  });

  it("applying twice changes nothing more", () => {
    const once = applied(tipped);
    const twice = applied(once);
    const a = matrixOf(once);
    const b = matrixOf(twice);
    for (let i = 0; i < 16; i++) expect(b.elements[i]).toBeCloseTo(a.elements[i], 9);
  });

  it("afterwards a wire into Rotation X spins the tipped wheel about its own axle, in place", () => {
    const wheel = { location: new THREE.Vector3(3, 0.5, 0), rotation: new THREE.Vector3(0, 0, Math.PI / 2) };
    const after = applied(wheel);
    // The cylinder's axle is its geometry's Y; tipped, it now lies along world -X.
    const axle = (m: THREE.Matrix4) => new THREE.Vector3(0, 1, 0).transformDirection(m);
    const rest = matrixOf(after);
    for (const spin of [0.4, 2.2]) {
      const m = matrixOf(after, {
        nodes: [node("angle", "value/constant", { value: spin }), node("vec", "vector/compose", { useY: false, useZ: false })],
        connections: [edge("angle", "out", "vec", "x"), edge("vec", "out", "wheel", "rotation")],
      });
      expect(axle(m).distanceTo(axle(rest))).toBeLessThan(1e-9);
      expect(new THREE.Vector3().setFromMatrixPosition(m).distanceTo(new THREE.Vector3(3, 0.5, 0))).toBeLessThan(1e-9);
    }
  });

  it("publishes the applied part as the pose offset, for the gizmo", () => {
    const after = applied(tipped);
    const results = evaluateGraph(graph([node("wheel", "object/cylinder", after)], []), DEFAULT_REGISTRY, CTX);
    const obj = results.get("wheel")?.geometry as THREE.Object3D;
    expect(obj.userData.poseOffset).toBeInstanceOf(THREE.Matrix4);
  });

  it("does not offset a matrix twice when the node did not recompose it", () => {
    const after = applied(tipped);
    const g = graph([node("wheel", "object/cylinder", after)], []);
    const first = (evaluateGraph(g, DEFAULT_REGISTRY, CTX).get("wheel")?.geometry as THREE.Object3D).matrix.clone();
    // A live drag: the node leaves its matrix alone and so must the apply step.
    const live = evaluateGraph(g, DEFAULT_REGISTRY, { ...CTX, liveEditNodeId: "wheel" }).get("wheel")?.geometry as THREE.Object3D;
    expect(live.matrix.equals(first)).toBe(true);
  });
});
