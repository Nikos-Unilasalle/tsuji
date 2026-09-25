import React, { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PROFILE_POINTS, evalProfileCurve, ProfilePoint } from "../shared/graph/profileCurve";
import { themeVar, themeVarAlpha, useRedrawOnThemeChange } from "./themeVars";
import "./curve-profile-editor.css";

interface CurveProfileEditorProps {
  value: ProfilePoint[];
  onChange: (points: ProfilePoint[]) => void;
}

export const CurveProfileEditor: React.FC<CurveProfileEditorProps> = ({ value, onChange }) => {
  const points = Array.isArray(value) && value.length >= 2 ? value : DEFAULT_PROFILE_POINTS;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const padding = 12;
    const drawW = w - padding * 2;
    const drawH = h - padding * 2;

    ctx.clearRect(0, 0, w, h);

    // Background grid
    ctx.fillStyle = themeVar("--chrome-pill-bg", "#1e2430", canvas);
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = themeVarAlpha("--chrome-text", 0.08, "#eef2f6", canvas);
    ctx.lineWidth = 1;

    // Grid lines
    const gridCols = 4;
    const gridRows = 4;
    for (let c = 0; c <= gridCols; c++) {
      const x = padding + (c / gridCols) * drawW;
      ctx.beginPath();
      ctx.moveTo(x, padding);
      ctx.lineTo(x, h - padding);
      ctx.stroke();
    }
    for (let r = 0; r <= gridRows; r++) {
      const y = padding + (r / gridRows) * drawH;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(w - padding, y);
      ctx.stroke();
    }

    // Draw curve path filled area below curve
    ctx.beginPath();
    ctx.moveTo(padding, h - padding);

    const steps = 100;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const valY = evalProfileCurve(points, t);
      const px = padding + t * drawW;
      const py = h - padding - valY * drawH;
      if (i === 0) ctx.lineTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineTo(w - padding, h - padding);
    ctx.closePath();

    const fillGrad = ctx.createLinearGradient(0, padding, 0, h - padding);
    fillGrad.addColorStop(0, themeVarAlpha("--accent-color", 0.25, "#38bdf8", canvas));
    fillGrad.addColorStop(1, themeVarAlpha("--accent-color", 0.03, "#38bdf8", canvas));
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Draw curve line
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const valY = evalProfileCurve(points, t);
      const px = padding + t * drawW;
      const py = h - padding - valY * drawH;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = themeVar("--chrome-text", "#eef2f6", canvas);
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw control points
    points.forEach((pt, idx) => {
      const px = padding + pt.x * drawW;
      const py = h - padding - pt.y * drawH;

      ctx.fillStyle = themeVar("--chrome-text", "#eef2f6", canvas);
      ctx.strokeStyle = draggingIdx === idx ? themeVar("--accent-color", "#38bdf8", canvas) : themeVarAlpha("--accent-color", 0.6, "#38bdf8", canvas);
      ctx.lineWidth = 2;

      const size = 8;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
      ctx.strokeRect(px - size / 2, py - size / 2, size, size);
    });
  }, [points, draggingIdx]);

  useEffect(() => {
    draw();
  }, [draw]);
  useRedrawOnThemeChange(draw);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padding = 12;
    const drawW = rect.width - padding * 2;
    const drawH = rect.height - padding * 2;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Check if clicked near existing point
    let foundIdx: number | null = null;
    points.forEach((pt, idx) => {
      const px = padding + pt.x * drawW;
      const py = rect.height - padding - pt.y * drawH;
      const dist = Math.hypot(mouseX - px, mouseY - py);
      if (dist < 12) foundIdx = idx;
    });

    if (foundIdx !== null) {
      setDraggingIdx(foundIdx);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padding = 12;
    const drawW = rect.width - padding * 2;
    const drawH = rect.height - padding * 2;

    let nx = (e.clientX - rect.left - padding) / drawW;
    let ny = 1 - (e.clientY - rect.top - padding) / drawH;

    nx = Math.max(0, Math.min(1, nx));
    ny = Math.max(0, Math.min(1, ny));

    // First and last point constrained in X
    if (draggingIdx === 0) nx = 0;
    if (draggingIdx === points.length - 1) nx = 1;

    const updated = points.map((p, idx) => (idx === draggingIdx ? { x: nx, y: ny } : p));
    onChange(updated);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx !== null) {
      setDraggingIdx(null);
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padding = 12;
    const drawW = rect.width - padding * 2;
    const drawH = rect.height - padding * 2;

    let nx = (e.clientX - rect.left - padding) / drawW;
    let ny = 1 - (e.clientY - rect.top - padding) / drawH;

    nx = Math.max(0, Math.min(1, nx));
    ny = Math.max(0, Math.min(1, ny));

    const updated = [...points, { x: nx, y: ny }].sort((a, b) => a.x - b.x);
    onChange(updated);
  };

  return (
    <div className="curve-profile-container">
      <div className="curve-profile-header">
        <span className="curve-profile-title">Thickness Profile</span>
        <button
          type="button"
          className="curve-profile-reset"
          onClick={() => onChange(DEFAULT_PROFILE_POINTS)}
          title="Reset to default curve"
        >
          Reset
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={240}
        height={130}
        className="curve-profile-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      />
      <div className="curve-profile-hint">Double-click canvas to add control point</div>
    </div>
  );
};
