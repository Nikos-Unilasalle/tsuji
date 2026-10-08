import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "./storage";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { evaluateGraph } from "./evaluate";
import { initBvhRaycast } from "../three/bvh";
import { consumeCanvasSwitchRequest } from "./canvasSwitchStore";
import { CANVAS_COUNT, Graph } from "./types";

/**
 * The showreel (tools/gen_showreel.py) is one film spread over all six
 * canvases. What makes it play as one is structural — every canvas hands
 * over to the next on its last frame, on the same beat grid — and nothing in
 * the generic demo checks (which evaluate only the first canvas) would notice
 * that breaking.
 */
const FILE = join(process.cwd(), "public/demos/demo_showreel.tsuji");
const BAR = 60; // frames: 120 BPM at 30 fps

function load() {
  return deserializeProject(readFileSync(FILE, "utf8"), DEFAULT_REGISTRY);
}

function frameCount(graph: Graph): number {
  const render = graph.nodes.find((n) => n.type === "render");
  return Number(render?.params.frameCount);
}

function evaluateAt(graph: Graph, frame: number) {
  return evaluateGraph(graph, DEFAULT_REGISTRY, {
    time: frame / 30,
    step: frame * 2,
    nodeId: "showreel-check",
    renderSize: { width: 1920, height: 1080 },
    currentFrame: frame,
    keyframes: graph.keyframes,
    markers: graph.markers,
    fps: 30,
    sessionId: "showreel-check",
  } as never);
}

describe("demo_showreel.tsuji", () => {
  it("fills every canvas, each a whole number of bars at 30 fps", () => {
    const project = load();
    expect(project.canvases).toHaveLength(CANVAS_COUNT);
    for (const graph of project.canvases) {
      const render = graph.nodes.find((n) => n.type === "render");
      expect(render).toBeDefined();
      expect(Number(render!.params.fps)).toBe(30);
      expect(frameCount(graph) % BAR).toBe(0);
    }
  });

  it("chains the canvases 1 → 2 → … → 6 → 1", () => {
    const project = load();
    project.canvases.forEach((graph, i) => {
      const gotos = graph.nodes.filter((n) => n.type === "canvas/goto");
      expect(gotos).toHaveLength(1);
      expect(Number(gotos[0].params.canvas)).toBe(((i + 1) % CANVAS_COUNT) + 1);
    });
  });

  it("evaluates every canvas cleanly, and hands over on the last frame only", () => {
    initBvhRaycast();
    const project = load();
    project.canvases.forEach((graph, i) => {
      const last = frameCount(graph) - 1;
      consumeCanvasSwitchRequest();
      for (const frame of [0, BAR, Math.floor(last / 2), last - 1]) {
        const results = evaluateAt(graph, frame);
        for (const node of graph.nodes) {
          expect(results.get(node.id), `canvas ${i + 1}: ${node.id} at frame ${frame}`).toHaveProperty("__evaluatedInputs");
        }
        expect(consumeCanvasSwitchRequest(), `canvas ${i + 1} switched early, at frame ${frame}`).toBeNull();
      }
      evaluateAt(graph, last);
      expect(consumeCanvasSwitchRequest()).toBe((i + 1) % CANVAS_COUNT);
    });
  }, 30_000);
});
