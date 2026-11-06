import { describe, expect, it } from "vitest";
import { musicSubgraph } from "./headlessMusic";
import { Graph } from "./types";

const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, params: {} });
const wire = (from: string, to: string) => ({ id: `${from}-${to}`, fromNode: from, fromSocket: "out", toNode: to, toSocket: "in" });

describe("musicSubgraph", () => {
  it("keeps a Music Out and everything upstream of it, nothing else", () => {
    const graph = {
      nodes: [node("clock", "music/clock"), node("pat", "music/pattern"), node("voice", "music/fm-voice"), node("out", "music/out"), node("box", "object/box"), node("render", "render")],
      connections: [wire("clock", "pat"), wire("pat", "voice"), wire("voice", "out"), wire("box", "render"), wire("out", "render")],
    } as unknown as Graph;
    const sub = musicSubgraph(graph)!;
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(["clock", "out", "pat", "voice"]);
    expect(sub.connections.map((c) => c.id)).toEqual(["clock-pat", "pat-voice", "voice-out"]);
  });
  it("is null without a Music Out", () => {
    expect(musicSubgraph({ nodes: [node("box", "object/box")], connections: [] } as unknown as Graph)).toBeNull();
  });
});
