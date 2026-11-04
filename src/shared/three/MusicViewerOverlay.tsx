import { useEffect, useRef, useState } from "react";
import type { NodeInstance } from "../graph/types";
import type { ViewerScore } from "../music/viewer/score";
import { drawViewer, viewerOptions, type ViewerOptions } from "../music/viewer/draw";

/**
 * A shown Music Viewer over the 3D view: the song drawn as light (music/viewer/draw.ts), following the playhead, with
 * a full-screen button. Clicks pass through to the view except on its own buttons.
 */
export function MusicViewerOverlay({
  node,
  title,
  readScore,
  readTime,
  onHide,
}: {
  node: NodeInstance;
  title: string;
  readScore: () => ViewerScore | null;
  /** Seconds into the song (negative before it starts). */
  readTime: () => number;
  onHide: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const optsRef = useRef<ViewerOptions>(viewerOptions(node.params, title));
  optsRef.current = viewerOptions(node.params, title);
  const readRef = useRef({ readScore, readTime });
  readRef.current = { readScore, readTime };
  const [full, setFull] = useState(false);

  useEffect(() => {
    let id = 0;
    const tick = () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (canvas && wrap) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(wrap.clientWidth * dpr));
        const h = Math.max(1, Math.round(wrap.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const score = readRef.current.readScore();
        const ctx = canvas.getContext("2d");
        if (ctx && score) drawViewer(ctx, w, h, score, readRef.current.readTime(), optsRef.current);
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    // Leaving the system's full screen (Esc there) leaves ours too.
    const onFs = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);

  // Full screen: the viewer covers the whole window — and the whole screen where the webview allows it. Esc leaves.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFull(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);
  const toggleFull = () => {
    if (full) {
      setFull(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    } else {
      setFull(true);
      void wrapRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  return (
    <div
      ref={wrapRef}
      className="music-viewer-overlay"
      style={{ position: full ? "fixed" : "absolute", inset: 0, zIndex: full ? 10000 : 4, pointerEvents: full ? "auto" : "none", background: "#000" }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      <div className="music-viewer-buttons" style={{ position: "absolute", right: 12, bottom: 14, display: "flex", gap: 6, pointerEvents: "auto", opacity: full ? 0.35 : 1 }}>
        <button
          type="button"
          className="viewport-hud-button"
          style={{ width: "auto", padding: "0 9px" }}
          title={full ? "Leave full screen (Esc)" : "Full screen"}
          onClick={toggleFull}
        >
          {full ? "Exit full screen" : "⛶ Full screen"}
        </button>
        {!full && (
          <button type="button" className="viewport-hud-button" style={{ width: "auto", padding: "0 9px" }} title="Hide the viewer (its node's Show)" onClick={onHide}>
            Hide
          </button>
        )}
      </div>
    </div>
  );
}
