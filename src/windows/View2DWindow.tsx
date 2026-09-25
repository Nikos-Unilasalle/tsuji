import { useEffect, useState } from "react";
import { DEFAULT_REGISTRY } from "../shared/graph/nodes";
import { findRenderNodeId } from "../shared/graph/nodes/render";
import { findView2DNodeId } from "../shared/graph/nodes/view2d";
import { emptyGraph, Graph } from "../shared/graph/types";
import { GraphPayload, notifyView2DClosed, startReceiving } from "../shared/ipc";
import { Viewport } from "../shared/three/Viewport";

/**
 * The 2D View window — a separate OS window (see ipc.ts/view2d_window.rs),
 * same reasoning as OutputWindow: its own webview means whatever's wired
 * into the `view2d` node (a CPU-heavy texture chain, in particular) runs on
 * its own thread/rAF, so it can never make the main editor's 3D viewport
 * stutter. Receives its graph from the main window over the same broadcast
 * OutputWindow uses; renders nothing until the first one arrives, and
 * nothing at all if the graph has no `view2d` node (see TopBar's gating).
 */
export function View2DWindow() {
  const [payload, setPayload] = useState<GraphPayload | null>(null);

  useEffect(() => {
    const stop = startReceiving(setPayload);
    return () => {
      stop();
      notifyView2DClosed();
    };
  }, []);

  const graph: Graph = payload?.graph ?? emptyGraph();
  const view2DNodeId = findView2DNodeId(graph);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", position: "relative" }}>
      {view2DNodeId ? (
        <Viewport
          graph={graph}
          registry={DEFAULT_REGISTRY}
          renderNodeId={findRenderNodeId(graph) ?? ""}
          view2DNodeId={view2DNodeId}
          epochMs={payload?.epochMs}
          outputMode
        />
      ) : null}
    </div>
  );
}
