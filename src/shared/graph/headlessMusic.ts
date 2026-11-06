/**
 * Music with every view closed.
 *
 * The viewport is what evaluates the graph, once a frame; with the 3D, 2D and camera views all closed it is suspended,
 * so a Music Out was never evaluated and the song fell silent — while App's fallback timer went on moving the
 * playhead. This keeps the sound going: while no view is open, only the nodes a Music Out depends on are evaluated,
 * a few dozen times a second, at the playhead App's timer moves. Nothing is drawn.
 *
 * The engine smooths its own time (the Music Out tells it where the song should be, with a tolerance), so this
 * timer's coarser beat is not heard. When a view opens again, its viewport takes over: Music Out keeps one driver per
 * session and yields to the one that drove last.
 */
import { useEffect, useMemo, useRef } from "react";
import { STEP_SECONDS } from "./clock";
import { evaluateGraph } from "./evaluate";
import { Graph, NodeRegistry } from "./types";

const MUSIC_OUT = "music/out";
const SESSION = "headless-music";
const INTERVAL_MS = 1000 / 30;

/** The Music Out nodes and everything upstream of them, or null when there is no Music Out. */
export function musicSubgraph(graph: Graph): Graph | null {
  const outs = graph.nodes.filter((n) => n.type === MUSIC_OUT);
  if (outs.length === 0) return null;
  const into = new Map<string, string[]>();
  for (const c of graph.connections) {
    const list = into.get(c.toNode);
    if (list) list.push(c.fromNode);
    else into.set(c.toNode, [c.fromNode]);
  }
  const keep = new Set<string>();
  const stack = outs.map((n) => n.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const from of into.get(id) ?? []) stack.push(from);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    connections: graph.connections.filter((c) => keep.has(c.fromNode) && keep.has(c.toNode)),
  };
}

export interface HeadlessMusicOptions {
  /** True while no viewport is evaluating (every view closed) and no export runs. */
  active: boolean;
  graph: Graph;
  registry: NodeRegistry;
  isPlaying: boolean;
  /** The playhead, read when each evaluation runs. */
  frame: () => number;
  fps: number;
}

export function useHeadlessMusic({ active, graph, registry, isPlaying, frame, fps }: HeadlessMusicOptions): void {
  const sub = useMemo(() => musicSubgraph(graph), [graph]);
  const live = useRef({ sub, registry, isPlaying, frame, fps });
  live.current = { sub, registry, isPlaying, frame, fps };
  const hasMusic = sub !== null;

  useEffect(() => {
    if (!active || !hasMusic) return;
    const evaluate = () => {
      const { sub, registry, isPlaying, frame, fps } = live.current;
      if (!sub) return;
      const currentFrame = frame();
      const time = Math.max(0, currentFrame) / fps;
      try {
        evaluateGraph(sub, registry, {
          time,
          step: Math.round(time / STEP_SECONDS),
          nodeId: "",
          fps,
          sessionId: SESSION,
          currentFrame,
          keyframes: sub.keyframes,
          isPlaying,
        });
      } catch (err) {
        console.error("headless music evaluation failed", err);
      }
    };
    evaluate();
    const id = setInterval(evaluate, INTERVAL_MS);
    // One last pass on the way out, so a Stop made while the views were closed still reaches the engine.
    return () => {
      clearInterval(id);
      evaluate();
    };
  }, [active, hasMusic]);
}
