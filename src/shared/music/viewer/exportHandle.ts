/**
 * A video export of the Music Viewer: the export view still steps through every frame (so Music Out records the song
 * for the soundtrack, exactly as for a 3D export — see export/webCodecsExport.ts), but the frame filmed is the viewer,
 * drawn full frame at the Render node's size on a canvas of its own.
 */
import type { Graph, NodeRegistry } from "../../graph/types";
import { evaluateGraph } from "../../graph/evaluate";
import type { ViewportExportHandle } from "../../three/Viewport";
import { drawViewer, viewerOptions } from "./draw";
import { viewerScoreFromGraph } from "./fromGraph";

export function musicViewerExportHandle(base: ViewportExportHandle, graph: Graph, registry: NodeRegistry, width: number, height: number, fallbackTitle: string): ViewportExportHandle {
  const viewer = graph.nodes.find((n) => n.type === "music/viewer");
  const out = graph.nodes.find((n) => n.type === "music/out");
  const render = graph.nodes.find((n) => n.type === "render");
  const renderFps = Number(render?.params.fps) || 30;
  const seconds = Math.max(1, (Number(render?.params.frameCount) || 600) / renderFps);
  const startFrame = Math.round(Number(out?.params.startFrame ?? 0)) || 0;
  // The song's tracks as the graph describes them (pure: one evaluation gives the whole score).
  const results = evaluateGraph(graph, registry, { time: 0, step: 0, nodeId: "music-viewer-export", currentFrame: 0, fps: renderFps, isPlaying: true } as never);
  const score = viewerScoreFromGraph(graph, results, seconds);
  const options = viewerOptions({ ...(registry.get("music/viewer")?.defaultParams ?? {}), ...(viewer?.params ?? {}) }, fallbackTitle);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(width / 2) * 2);
  canvas.height = Math.max(2, Math.round(height / 2) * 2);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas for the Music Viewer export");
  return {
    getCanvas: () => canvas,
    captureFrame: async (frameIndex, fps, timelineFrame) => {
      await base.captureFrame(frameIndex, fps, timelineFrame);
      drawViewer(ctx, canvas.width, canvas.height, score, ((timelineFrame ?? frameIndex) - startFrame) / fps, options);
    },
  };
}
