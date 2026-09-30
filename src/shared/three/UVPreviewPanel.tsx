import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { getUVCheckerCanvas } from "./uvChecker";

/**
 * What the UV view draws, filled in by the viewport's render loop for the
 * selected object: its UV polygons (quads and n-gons for an Edit Mesh,
 * triangles otherwise), which of them are selected, and the texture they map.
 * `key` changes exactly when any of that does — the panel redraws only then.
 */
export interface UVPanelData {
  key: string;
  label: string;
  polygons: [number, number][][];
  selected: boolean[];
  image: CanvasImageSource | null;
}

const SIZE = 240;
const MAX_TILES = 8;

/**
 * Read-only UV view of the selected object: its UV layout over the texture
 * (or the checker when it has none), the 0..1 tile outlined, Edit Mesh's
 * selected faces highlighted. Polled once a frame from a ref rather than
 * passed as props: the data lives in the render loop, and most frames nothing
 * changed, which the key makes free.
 */
export function UVPreviewPanel({ source, onClose }: { source: MutableRefObject<UVPanelData | null>; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    let drawnKey: string | null = null;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const data = source.current;
      const key = data?.key ?? "none";
      if (key === drawnKey) return;
      drawnKey = key;
      if (labelRef.current) labelRef.current.textContent = data?.label ?? "Nothing selected";
      const canvas = canvasRef.current;
      if (canvas) draw(canvas, data);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [source]);

  return (
    <div className="viewport-uv-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="viewport-uv-panel-header">
        <span className="viewport-uv-panel-title">UV</span>
        <span ref={labelRef} className="viewport-uv-panel-label" />
        <button type="button" className="viewport-uv-panel-close" onClick={onClose} title="Close the UV view">
          ×
        </button>
      </div>
      <canvas ref={canvasRef} width={SIZE * 2} height={SIZE * 2} style={{ width: SIZE, height: SIZE }} />
    </div>
  );
}

function draw(canvas: HTMLCanvasElement, data: UVPanelData | null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#1e2430";
  ctx.fillRect(0, 0, W, W);

  // The view: the 0..1 tile and every UV, square, with a margin.
  let minU = 0, maxU = 1, minV = 0, maxV = 1;
  for (const poly of data?.polygons ?? []) {
    for (const [u, v] of poly) {
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  const span = Math.max(maxU - minU, maxV - minV) * 1.08;
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  const scale = W / span;
  const x = (u: number) => (u - (cu - span / 2)) * scale;
  const y = (v: number) => W - (v - (cv - span / 2)) * scale;

  // The texture, tiled over the tiles in view (capped — far-flung UVs don't draw hundreds).
  const image = data?.image ?? getUVCheckerCanvas();
  const tiles = (lo: number, hi: number) => {
    const from = Math.floor(lo);
    const to = Math.min(Math.ceil(hi), from + MAX_TILES);
    return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
  };
  ctx.globalAlpha = 0.55;
  for (const tu of tiles(cu - span / 2, cu + span / 2)) {
    for (const tv of tiles(cv - span / 2, cv + span / 2)) {
      try {
        ctx.drawImage(image, x(tu), y(tv + 1), scale, scale);
      } catch {
        // An image not decoded yet: the next change redraws it.
      }
    }
  }
  ctx.globalAlpha = 1;

  // The 0..1 tile.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(x(0), y(1), scale, scale);
  ctx.setLineDash([]);

  if (!data) return;
  const path = (poly: [number, number][]) => {
    ctx.beginPath();
    poly.forEach(([u, v], i) => (i === 0 ? ctx.moveTo(x(u), y(v)) : ctx.lineTo(x(u), y(v))));
    ctx.closePath();
  };
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(226, 232, 240, 0.75)";
  data.polygons.forEach((poly, i) => {
    if (data.selected[i]) return;
    path(poly);
    ctx.stroke();
  });
  // Selected on top, filled.
  ctx.fillStyle = "rgba(255, 119, 0, 0.28)";
  ctx.strokeStyle = "#ff7700";
  ctx.lineWidth = 2.5;
  data.polygons.forEach((poly, i) => {
    if (!data.selected[i]) return;
    path(poly);
    ctx.fill();
    ctx.stroke();
  });
}
