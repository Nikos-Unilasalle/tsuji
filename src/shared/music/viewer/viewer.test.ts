import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "../../graph/storage";
import { DEFAULT_REGISTRY } from "../../graph/nodes/index";
import { evaluateGraph } from "../../graph/evaluate";
import { viewerScoreFromGraph } from "./fromGraph";
import { VIEWER_PALETTE_NAMES, VIEWER_STYLES, drawViewer, envelope, viewerOptions } from "./draw";
import { firstAt } from "./score";

const symphony = () => {
  const project = deserializeProject(readFileSync(join(process.cwd(), "public/demos/demo_music_symphony.tsuji"), "utf8"), DEFAULT_REGISTRY);
  const graph = project.canvases[0];
  const results = evaluateGraph(graph, DEFAULT_REGISTRY, { time: 0, step: 0, nodeId: "t", currentFrame: 0, fps: 30, isPlaying: true } as never);
  return viewerScoreFromGraph(graph, results, 170);
};

/** A 2D context that only counts what it is asked to draw — and fails on a non-finite coordinate. */
function fakeContext() {
  const calls = { fill: 0, stroke: 0, text: 0 };
  const check = (...xs: unknown[]) => {
    for (const x of xs) if (typeof x === "number" && !Number.isFinite(x)) throw new Error(`non-finite ${x}`);
  };
  const gradient = { addColorStop: (o: number) => check(o) };
  const ctx = new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === "fill" || key === "fillRect") return (...a: unknown[]) => (check(...a), calls.fill++);
        if (key === "stroke") return () => calls.stroke++;
        if (key === "fillText") return (...a: unknown[]) => (check(...a), calls.text++);
        if (key === "createRadialGradient" || key === "createLinearGradient") return (...a: unknown[]) => (check(...a), gradient);
        if (key === "roundRect") return (...a: unknown[]) => check(...a);
        return (...a: unknown[]) => check(...a);
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("Music Viewer", () => {
  it("reads the whole Symphony: its 21 voices named, their notes in time, its form", () => {
    const score = symphony();
    expect(score.tracks).toHaveLength(21);
    expect(score.tracks.map((t) => t.name)).toContain("II · Counterpoint");
    expect(score.tracks.filter((t) => t.drums).map((t) => t.name)).toEqual(["Kick", "Snare", "Hats"]);
    expect(score.notes.length).toBeGreaterThan(500);
    for (let i = 1; i < score.notes.length; i++) expect(score.notes[i].on).toBeGreaterThanOrEqual(score.notes[i - 1].on);
    expect(score.bpm).toBe(96);
    expect(score.form.map((f) => f.letter).join(" ")).toBe("A B C D E B′");
    // The counterpoint only plays in the fugato (bars 21–28: 50–70 s).
    const cp = score.tracks.findIndex((t) => t.name === "II · Counterpoint");
    const ons = score.notes.filter((n) => n.track === cp).map((n) => n.on);
    expect(Math.min(...ons)).toBeCloseTo(50, 0);
    expect(Math.max(...ons)).toBeLessThan(70);
  });

  it("finds notes by time, and lights a note from its onset, fading after it ends", () => {
    const score = symphony();
    const i = firstAt(score.notes, 60);
    expect(score.notes[i].on).toBeGreaterThanOrEqual(60);
    expect(score.notes[i - 1].on).toBeLessThan(60);
    const n = { track: 0, on: 1, off: 2, pitch: 60, velocity: 1 };
    expect(envelope(n, 0.9)).toBe(0);
    expect(envelope(n, 1)).toBe(1);
    expect(envelope(n, 2.05)).toBeGreaterThan(0);
    expect(envelope(n, 4)).toBeLessThan(0.01);
  });

  it("draws every style and palette at any time, before the start and past the end included", () => {
    const score = symphony();
    for (const style of VIEWER_STYLES)
      for (const palette of VIEWER_PALETTE_NAMES) {
        const { ctx, calls } = fakeContext();
        for (const t of [-1, 0, 12.3, 61, 120.5, 169.9, 200]) drawViewer(ctx, 1920, 1080, score, t, viewerOptions({ style, palette, title: "x" }, "y"));
        expect(calls.fill).toBeGreaterThan(100);
        expect(calls.text).toBeGreaterThan(10);
      }
  });

  it("reads its node's params, falling back on sane ones", () => {
    expect(viewerOptions({ style: "nope", palette: "nope", intensity: "x", ahead: 0, title: " " }, "Song")).toEqual({ style: "galaxy", palette: "neon", title: "Song", intensity: 1, ahead: 6, legend: true });
  });
});
