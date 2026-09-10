import { Graph, NodeDefinition } from "../types";
import { numberInput } from "./object";

/**
 * Terminal node. Today: a single Geometry input, passed straight through as
 * its own output — the viewport reads whichever node in the graph is a
 * `render` type and adds that output to its THREE.Scene. Simplified from
 * BIBLE.md's `Sequence (N ports) -> Render` on purpose, to prove the
 * evaluate-to-viewport pipe first: a `list` input fed by however Sequence
 * ends up fanning multiple objects in is a follow-up, not a redesign — the
 * socket type is already `list`-shaped for exactly that.
 */
export const RENDER_NODE: NodeDefinition = {
  type: "render",
  label: "Render",
  category: "structure",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "environment", label: "Environment", type: "any" },
    { id: "postprocess", label: "Post-Process", type: "postprocess" },
    { id: "motionBlur", label: "Motion Blur", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "environment", label: "Environment", type: "any" },
    { id: "postprocess", label: "Post-Process", type: "postprocess" },
  ],
  defaultParams: {
    frameCount: 120,
    fps: 30,
    motionBlur: 0,
    resolutionPreset: "16:9 (1920x1080)",
    width: 1920,
    height: 1080,
    holdout: false,
    timelineEnabled: true,
  },
  paramFields: [
    { id: "timelineEnabled", label: "Timeline (Frame Count)", kind: "boolean" },
    {
      id: "timelineNote",
      label:
        "Off for games and simulations: no fixed length, no scrub bar. Shift+Space still resets.",
      kind: "note",
    },
    { id: "frameCount", label: "Frame Count", kind: "number", step: 1 },
    { id: "fps", label: "FPS (video export)", kind: "number", step: 1 },
    {
      id: "resolutionPreset",
      label: "Aspect / Resolution",
      kind: "select",
      options: [
        "16:9 (1920x1080)",
        "16:10 (1920x1200)",
        "4:3 (1440x1080)",
        "1:1 (1080x1080)",
        "9:16 (1080x1920)",
        "21:9 (2560x1080)",
        "Custom",
      ],
    },
    { id: "width", label: "Width (px)", kind: "number", step: 1 },
    { id: "height", label: "Height (px)", kind: "number", step: 1 },
    { id: "holdout", label: "Holdout (mask outside camera view)", kind: "boolean" },
    { id: "motionBlur", label: "Motion Blur", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params) => {
    let width = Math.max(1, Number(params.width) || 1920);
    let height = Math.max(1, Number(params.height) || 1080);

    const preset = String(params.resolutionPreset ?? "16:9 (1920x1080)");
    if (preset === "16:9 (1920x1080)") { width = 1920; height = 1080; }
    else if (preset === "16:10 (1920x1200)") { width = 1920; height = 1200; }
    else if (preset === "4:3 (1440x1080)") { width = 1440; height = 1080; }
    else if (preset === "1:1 (1080x1080)") { width = 1080; height = 1080; }
    else if (preset === "9:16 (1080x1920)") { width = 1080; height = 1920; }
    else if (preset === "21:9 (2560x1080)") { width = 2560; height = 1080; }

    const aspect = width / height;
    const n = Number(params.frameCount);
    const frameCount = Math.max(0, Number.isFinite(n) ? n : 120);
    const fps = Math.max(1, Number(params.fps) || 30);

    return {
      geometry: inputs.geometry,
      environment: inputs.environment,
      postprocess: inputs.postprocess,
      motionBlur: Math.max(0, Math.min(1, numberInput(inputs.motionBlur, params.motionBlur, 0))),
      holdout: Boolean(params.holdout),
      width,
      height,
      aspect,
      frameCount,
      fps,
    };
  },
};

/** First `render`-type node in the graph — what a Viewport draws when it isn't told a specific node id to use. Multiple Render nodes: first one wins, arbitrary order, not an error. */
export function findRenderNodeId(graph: Graph): string | undefined {
  return graph.nodes.find((n) => n.type === RENDER_NODE.type)?.id;
}
