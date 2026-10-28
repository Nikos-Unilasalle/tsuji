import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "../graph/storage";
import { DEFAULT_REGISTRY } from "../graph/nodes/index";
import { evaluateGraph } from "../graph/evaluate";
import { gatherTracks } from "../graph/nodes/music";
import { EngineCore } from "./engine/core";

/**
 * Every music demo, heard: its graph evaluated as the app does, the tracks Music Out gathers handed to the real
 * engine, and the song rendered offline from start to end — it must sound, stay finite and not clip. demos.test.ts only
 * proves a demo evaluates; this proves its song plays.
 */
const DEMO_DIR = join(process.cwd(), "public/demos");
const SR = 48_000;

describe("music demos", () => {
  const files = readdirSync(DEMO_DIR).filter((f) => f.startsWith("demo_music_") && f.endsWith(".tsuji"));

  it("finds them", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of files) {
    it(`${file} plays`, () => {
      const project = deserializeProject(readFileSync(join(DEMO_DIR, file), "utf8"), DEFAULT_REGISTRY);
      const graph = project.canvases.find((c) => c.nodes.length > 0) ?? project.canvases[0];
      const results = evaluateGraph(graph, DEFAULT_REGISTRY, { time: 0, step: 0, nodeId: "demo-audio", currentFrame: 0, fps: 30, isPlaying: true } as never);
      const out = graph.nodes.find((n) => n.type === "music/out")!;
      // Music Out's inputs, as the evaluator fills them: what is wired into each Track socket.
      const inputs: Record<string, unknown> = {};
      for (const c of graph.connections.filter((c) => c.toNode === out.id)) inputs[c.toSocket] = results.get(c.fromNode)?.[c.fromSocket];
      const tracks = gatherTracks(inputs, out.id);
      expect(tracks.length).toBeGreaterThan(0);

      const engine = new EngineCore(SR);
      engine.describe({ tracks, master: Number(out.params.master ?? 0.8) });
      engine.play(0);
      // The whole song, as long as the timeline (capped at a minute): every part has to come in and be heard.
      const render = graph.nodes.find((n) => n.type === "render");
      const seconds = Math.min(60, Number(render?.params.frameCount ?? 360) / Number(render?.params.fps ?? 30));
      const l = new Float32Array(SR * seconds);
      const r = new Float32Array(SR * seconds);
      for (let s = 0; s < l.length; s += 128) engine.render(l, r, s, Math.min(128, l.length - s));
      let peak = 0;
      let finite = true;
      for (let i = 0; i < l.length; i++) {
        peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
      }
      expect(finite).toBe(true);
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThan(1);
    });
  }
});
