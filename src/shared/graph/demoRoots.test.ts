import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "./storage";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { evaluateGraph } from "./evaluate";
import { resolveSceneRoots } from "./sceneRoots";
import { initBvhRaycast } from "../three/bvh";

/**
 * A demo that evaluates cleanly can still draw nothing at all — the failure
 * the socket/throw checks in demos.test.ts cannot see. Several chart nodes
 * render zero marks unless their lists are wired (scatter and point cloud
 * have no fallback data), and a wire into an `owns` socket silently removes
 * its source from the scene, so a mis-built demo opens on an empty floor.
 *
 * This walks each demo's actual scene roots and counts the drawable objects
 * underneath them.
 */
const DEMO_DIR = join(process.cwd(), "public/demos");

/**
 * Demos whose subject only exists once there is a WebGL context or a DOM —
 * they are correct, and unprovable in this environment. Keep this list as
 * short as the code allows: everything on it is a demo nobody is checking.
 */
const GPU_ONLY = new Set([
  // Pixel Spawner reads the texture back through a 2D canvas (texture.ts
  // guards on `typeof document`), so headless it yields an empty group.
  "demo_texture_to_geometry.tsuji",
]);

function drawableCount(object: THREE.Object3D): number {
  let n = 0;
  object.traverse((child) => {
    const c = child as THREE.Mesh & THREE.Points & THREE.Line;
    if (c.isMesh || c.isPoints || c.isLine) n++;
  });
  return n;
}

describe("demo scene roots", () => {
  const files = readdirSync(DEMO_DIR).filter((f) => f.endsWith(".tsuji"));

  for (const file of files) {
    it(`${file} draws something`, () => {
      initBvhRaycast();
      const project = deserializeProject(readFileSync(join(DEMO_DIR, file), "utf8"), DEFAULT_REGISTRY);
      const graph = project.canvases.find((c) => c.nodes.length > 0) ?? project.canvases[0];

      const results = evaluateGraph(graph, DEFAULT_REGISTRY, {
        time: 1.2,
        step: 36,
        nodeId: "demo-check",
        renderSize: { width: 1920, height: 1080 },
        currentFrame: 36,
        keyframes: graph.keyframes,
      } as never);

      let total = 0;
      for (const nodeId of resolveSceneRoots(graph, DEFAULT_REGISTRY)) {
        // Any output socket, not just `geometry`: Logic Bridge hands its
        // object back on `out`, and lights on `light`.
        const out = Object.values(results.get(nodeId) ?? {}).find((v) => v instanceof THREE.Object3D);
        if (out instanceof THREE.Object3D) total += drawableCount(out);
      }

      // Demos built on the shared base carry its floor plane (ids prefixed
      // `setup_`), which draws 1 on its own — so their subject only counts
      // above that. The older demos predate the base and have no floor.
      const baseline = graph.nodes.some((n) => n.id.startsWith("setup_") && n.type === "object/plane") ? 1 : 0;
      if (GPU_ONLY.has(file)) {
        expect(total, `${file} lost even the setup floor`).toBeGreaterThanOrEqual(baseline);
        return;
      }
      expect(total, `${file} renders nothing of its own`).toBeGreaterThan(baseline);
    }, 15_000);
  }
});
