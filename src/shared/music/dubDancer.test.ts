import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "../graph/storage";
import { DEFAULT_REGISTRY } from "../graph/nodes/index";
import { evaluateGraph } from "../graph/evaluate";
import { initBvhRaycast } from "../three/bvh";

/**
 * Step 7: in the Dub Dancer demo the music drives the scene. Evaluated headless at chosen frames: the dancer's beat is
 * the song's, and the lights flare on the hits of their part and fall back between them.
 */
const FPS = 30;
const BPM = 75;
const project = () => deserializeProject(readFileSync(join(process.cwd(), "public/demos/demo_music_dub_dancer.tsuji"), "utf8"), DEFAULT_REGISTRY);

function at(frame: number) {
  const graph = project().canvases[0];
  return evaluateGraph(graph, DEFAULT_REGISTRY, { time: frame / FPS, step: frame, nodeId: "dub", currentFrame: frame, fps: FPS, isPlaying: true, keyframes: graph.keyframes } as never);
}

describe("Dub Dancer", () => {
  initBvhRaycast();

  it("dances on the song's beat: the dancer's beat is Music Out's", () => {
    for (const frame of [0, 37, 384, 1000]) {
      const r = at(frame);
      const songBeat = r.get("out")!.beat as number;
      expect(songBeat).toBeCloseTo((frame / FPS) * (BPM / 60), 9);
      expect(r.get("dance")!.beat as number).toBeCloseTo(songBeat, 9);
    }
  });

  it("flares the red light on the one-drop hit and lets it fall back after", () => {
    // What the light is set to: the lamp expression wired into its Intensity (the light object itself is kept across
    // evaluations, so it is read here, at once, not after another frame has moved it).
    const lamp = (frame: number) => at(frame).get("lamp_drums")!.value as number;
    // Beat 3 of bar 1 (step 8) at 75 BPM: 8 steps at 5 a second = 1.6 s = frame 48.
    const hit = lamp(48);
    const after = lamp(56);
    expect(hit).toBeGreaterThan(100); // 18 + 90 × an envelope near 1
    expect(after).toBeLessThan(hit * 0.6);
  });

  it("breathes the green orb with the bass", () => {
    const probe = (frame: number) => at(frame).get("probe_bass")!;
    // The bass leaves the one empty (step 0) and comes in on step 2: frame 12.
    expect(probe(3).gate).toBe(0);
    expect(probe(12).gate).toBe(1);
    expect(probe(12).envelope as number).toBeGreaterThan(0.9);
  });
});
