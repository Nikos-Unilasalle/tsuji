import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { velocityKey } from "./motionBlur";
import { deserializeProject } from "../graph/storage";
import { DEFAULT_REGISTRY } from "../graph/nodes";
import { evaluateGraph } from "../graph/evaluate";

/** The scene meshes of one evaluation, in traversal order — what the velocity pass walks. */
function evaluateMeshes(file: string, outputNode: string, time: number): THREE.Mesh[] {
  const project = deserializeProject(readFileSync(file, "utf8"), DEFAULT_REGISTRY);
  const graph = project.canvases.find((c) => c.nodes.length > 0)!;
  const results = evaluateGraph(graph, DEFAULT_REGISTRY, {
    time,
    step: Math.round(time * 60),
    nodeId: "velocity-test",
    currentFrame: Math.round(time * 60),
    keyframes: graph.keyframes,
  } as never);

  const root = results.get(outputNode)!.geometry as THREE.Object3D;
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
}

function keysOf(meshes: THREE.Mesh[]): string[] {
  const ordinals = new Map<string, number>();
  return meshes.map((mesh) => velocityKey(mesh, ordinals));
}

const WAVE = "public/demos/demo_stagger_wave.tsuji";

describe.skipIf(!existsSync(WAVE))("velocity keys (stagger wave demo)", () => {
  it("instanced geometry keeps its objects from one frame to the next", () => {
    // The structure nodes used to hand out a fresh set of clones every frame,
    // which is what the keying was built for; they now re-sync the copies they
    // keep (nodes/syncedClone.ts). Keys still matter — a graph reloaded, a
    // shape that changed, a pane's own clones — but the objects are stable.
    const a = evaluateMeshes(WAVE, "tint", 1.0);
    const uuids = new Set(a.map((m) => m.uuid));
    const b = evaluateMeshes(WAVE, "tint", 1.0 + 1 / 60);
    expect(a.length).toBe(144);
    expect(b.filter((m) => uuids.has(m.uuid))).toHaveLength(144);
  });

  it("names the same instances on consecutive frames", () => {
    // Read each frame before evaluating the next: the meshes are the same objects.
    const a = evaluateMeshes(WAVE, "tint", 1.0);
    const keysA = keysOf(a);
    const b = evaluateMeshes(WAVE, "tint", 1.0 + 1 / 60);
    expect(keysOf(b)).toEqual(keysA);
    expect(new Set(keysA).size).toBe(a.length);
  });

  it("follows an instance rather than a slot — the key's whole point", () => {
    // Only Y animates in this graph, so an instance's XZ is its identity: if a
    // key pointed at a different cube from one frame to the next, the previous
    // matrix would report a sideways jump that never happened.
    const groundPlan = (meshes: THREE.Mesh[]) => {
      const ordinals = new Map<string, number>();
      return new Map(
        meshes.map((mesh) => {
          const position = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
          return [velocityKey(mesh, ordinals), `${position.x.toFixed(4)},${position.z.toFixed(4)}`];
        }),
      );
    };
    const before = groundPlan(evaluateMeshes(WAVE, "tint", 1.0));
    const after = groundPlan(evaluateMeshes(WAVE, "tint", 1.0 + 1 / 60));
    expect(after).toEqual(before);
  });

  it("reports real movement between the frames it keys", () => {
    // The end result the whole pass is after: a non-zero per-instance delta,
    // which is exactly what the old per-object storage could never produce for
    // cloned geometry.
    const heights = (meshes: THREE.Mesh[]) => {
      const ordinals = new Map<string, number>();
      return new Map(
        meshes.map((mesh) => [
          velocityKey(mesh, ordinals),
          new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld).y,
        ]),
      );
    };
    const before = heights(evaluateMeshes(WAVE, "tint", 1.0));
    const after = heights(evaluateMeshes(WAVE, "tint", 1.0 + 1 / 60));
    const deltas = [...after].map(([key, y]) => Math.abs(y - before.get(key)!));
    expect(Math.max(...deltas)).toBeGreaterThan(0.01);
  });
});

describe("velocity keys unit", () => {
  it("keeps instances of different source nodes apart", () => {
    const ordinals = new Map<string, number>();
    const fromNode = (nodeId: string) => {
      const mesh = new THREE.Mesh();
      mesh.userData.nodeId = nodeId;
      return velocityKey(mesh, ordinals);
    };
    expect([fromNode("cube"), fromNode("cube"), fromNode("sphere")]).toEqual([
      "cube#0",
      "cube#1",
      "sphere#0",
    ]);
    // Geometry with no owning node (helpers, imported scenes) still gets a key
    // rather than sharing one bucket with everything else.
    expect(velocityKey(new THREE.Mesh(), ordinals)).toBe("anon#0");
  });

  it("keys particle points and objects consistently", () => {
    const ordinals = new Map<string, number>();
    const points = new THREE.Points();
    points.userData.nodeId = "particle-node";
    points.userData.isParticleSystem = true;
    expect(velocityKey(points, ordinals)).toBe("particle-node#0");
    expect(velocityKey(points, ordinals)).toBe("particle-node#1");
  });
});

