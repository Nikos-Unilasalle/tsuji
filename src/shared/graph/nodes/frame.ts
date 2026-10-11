import * as THREE from "three";
import { NodeDefinition } from "../types";

export const FRAME_TYPE = "utility/frame";
export const FRAME_MIN_WIDTH = 120;
export const FRAME_MIN_HEIGHT = 80;

/**
 * Frame — a titled, coloured rectangle drawn *behind* the canvas's nodes to
 * group them visually (Blender's Frame / Nuke's Backdrop). It has no sockets
 * and computes nothing: it is a node only so that saving, copy/paste, undo
 * and deletion treat it like everything else on the canvas.
 *
 * The editor (GraphEditor / GraphNode) renders it specially — lowest z, a
 * drag handle on its title bar only, resizable — see `isFrameInstance`.
 */
export const CANVAS_FRAME_NODE: NodeDefinition = {
  type: FRAME_TYPE,
  label: "Frame",
  category: "utility",
  inputs: [],
  outputs: [],
  defaultParams: {
    title: "Frame",
    color: new THREE.Color(0x3b82f6),
    width: 420,
    height: 280,
  },
  paramFields: [
    { id: "title", label: "Title", kind: "text" },
    { id: "color", label: "Color", kind: "color" },
    { id: "width", label: "Width", kind: "number", step: 10 },
    { id: "height", label: "Height", kind: "number", step: 10 },
  ],
  evaluate: () => ({}),
};

/** A frame's size as the canvas draws it, clamped so a bad param can't collapse it. */
export function frameSize(params: Record<string, unknown> | undefined): { width: number; height: number } {
  const width = Number(params?.width);
  const height = Number(params?.height);
  return {
    width: Number.isFinite(width) ? Math.max(FRAME_MIN_WIDTH, width) : 420,
    height: Number.isFinite(height) ? Math.max(FRAME_MIN_HEIGHT, height) : 280,
  };
}
