import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { COLOR_RAMP_INTERPOLATIONS, ColorRamp, ColorRampInterpolation, ColorStop, DEFAULT_COLOR_RAMP, evalColorRamp } from "../shared/graph/colorRamp";
import { ColorPickerInput } from "./ColorPickerInput";
import { DragNumberInput } from "./DragNumberInput";
import "./color-ramp-editor.css";

interface ColorRampEditorProps {
  value: ColorRamp;
  onChange: (ramp: ColorRamp) => void;
}

const BAR_HEIGHT = 28;
const MARKER_ROW_HEIGHT = 18;
const MARKER_SIZE = 10;

/** The midpoint of the largest empty span between (or before/after) existing stops — where a new one lands with no explicit position to go on. */
function widestGapMidpoint(stops: ColorStop[]): number {
  if (stops.length === 0) return 0.5;
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  let bestGap = sorted[0].position - 0; // before the first stop
  let bestMid = sorted[0].position / 2;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].position - sorted[i].position;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (sorted[i].position + sorted[i + 1].position) / 2;
    }
  }
  const tailGap = 1 - sorted[sorted.length - 1].position; // after the last stop
  if (tailGap > bestGap) bestMid = (sorted[sorted.length - 1].position + 1) / 2;
  return Math.max(0, Math.min(1, bestMid));
}

/** Blender-style color ramp editor: a gradient bar with draggable stops, a color picker for whichever is selected, and Linear/Constant interpolation. */
export const ColorRampEditor: React.FC<ColorRampEditorProps> = ({ value, onChange }) => {
  const ramp: ColorRamp = value && Array.isArray(value.stops) && value.stops.length > 0 ? value : DEFAULT_COLOR_RAMP;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  const clampedSelected = Math.min(selectedIdx, ramp.stops.length - 1);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const padding = 8;
    const barW = w - padding * 2;

    ctx.clearRect(0, 0, w, h);

    // Checkerboard behind the bar, so a transparent-looking stop (there's no
    // alpha channel here, but it reads as "empty" otherwise) still has
    // *something* under it — mirrors the color picker's own convention.
    ctx.fillStyle = "#12161f";
    ctx.fillRect(0, 0, w, h);

    const steps = Math.max(2, Math.floor(barW));
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const c = evalColorRamp(ramp.stops, t, ramp.interpolation);
      ctx.fillStyle = `#${c.getHexString()}`;
      const x = padding + (i / steps) * barW;
      ctx.fillRect(x, padding, Math.ceil(barW / steps) + 1, BAR_HEIGHT);
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.strokeRect(padding + 0.5, padding + 0.5, barW - 1, BAR_HEIGHT - 1);

    // Stop markers — a downward-pointing triangle, filled with the stop's own
    // color, selected one outlined brighter.
    ramp.stops.forEach((stop, idx) => {
      const px = padding + stop.position * barW;
      const py = padding + BAR_HEIGHT + 4;
      const size = MARKER_SIZE;

      ctx.beginPath();
      ctx.moveTo(px - size / 2, py);
      ctx.lineTo(px + size / 2, py);
      ctx.lineTo(px, py + size);
      ctx.closePath();
      ctx.fillStyle = `#${stop.color.getHexString()}`;
      ctx.fill();
      ctx.lineWidth = idx === clampedSelected ? 2 : 1;
      ctx.strokeStyle = idx === clampedSelected ? "#38bdf8" : "#0b1220";
      ctx.stroke();
    });
  }, [ramp, clampedSelected]);

  useEffect(() => {
    draw();
  }, [draw]);

  const posToT = (clientX: number): number => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const padding = 8;
    const barW = rect.width - padding * 2;
    return Math.max(0, Math.min(1, (clientX - rect.left - padding) / barW));
  };

  const hitTestMarker = (clientX: number, clientY: number): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const padding = 8;
    const barW = rect.width - padding * 2;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let found: number | null = null;
    ramp.stops.forEach((stop, idx) => {
      const px = padding + stop.position * barW;
      const py = padding + BAR_HEIGHT + 4 + MARKER_SIZE / 2;
      if (Math.hypot(mx - px, my - py) < 10) found = idx;
    });
    return found;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const hit = hitTestMarker(e.clientX, e.clientY);
    if (hit !== null) {
      setSelectedIdx(hit);
      setDraggingIdx(hit);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx === null) return;
    const t = posToT(e.clientX);
    const nextStops = ramp.stops.map((s, idx) => (idx === draggingIdx ? { ...s, position: t } : s));
    onChange({ ...ramp, stops: nextStops });
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
    if (hitTestMarker(e.clientX, e.clientY) !== null) return;
    const t = posToT(e.clientX);
    const color = evalColorRamp(ramp.stops, t, ramp.interpolation);
    const nextStops = [...ramp.stops, { position: t, color }].sort((a, b) => a.position - b.position);
    onChange({ ...ramp, stops: nextStops });
    setSelectedIdx(nextStops.findIndex((s) => s.position === t));
  };

  const addStop = () => {
    // Land in whatever the emptiest span currently is — same convention as
    // Blender's own "+". Landing a fixed offset past the *last* stop instead
    // put a new stop exactly on top of an existing one the moment that last
    // stop already sat at position 1 (a very common case: a fresh two-stop
    // ramp's own right end).
    const t = widestGapMidpoint(ramp.stops);
    const color = evalColorRamp(ramp.stops, t, ramp.interpolation);
    const nextStops = [...ramp.stops, { position: t, color }].sort((a, b) => a.position - b.position);
    onChange({ ...ramp, stops: nextStops });
    setSelectedIdx(nextStops.findIndex((s) => s.position === t));
  };

  const removeSelected = () => {
    if (ramp.stops.length <= 1) return;
    const nextStops = ramp.stops.filter((_, idx) => idx !== clampedSelected);
    onChange({ ...ramp, stops: nextStops });
    setSelectedIdx(Math.max(0, clampedSelected - 1));
  };

  const setSelectedColor = (color: THREE.Color) => {
    const nextStops = ramp.stops.map((s, idx) => (idx === clampedSelected ? { ...s, color } : s));
    onChange({ ...ramp, stops: nextStops });
  };

  const setSelectedPosition = (position: number) => {
    const clamped = Math.max(0, Math.min(1, position));
    const nextStops = ramp.stops.map((s, idx) => (idx === clampedSelected ? { ...s, position: clamped } : s));
    onChange({ ...ramp, stops: nextStops });
  };

  const selectedStop: ColorStop | undefined = ramp.stops[clampedSelected];

  return (
    <div className="color-ramp-container">
      <div className="color-ramp-header">
        <button type="button" className="color-ramp-btn" onClick={addStop} title="Add stop">
          +
        </button>
        <button type="button" className="color-ramp-btn" onClick={removeSelected} disabled={ramp.stops.length <= 1} title="Remove selected stop">
          −
        </button>
        <select
          className="color-ramp-select"
          value={ramp.interpolation}
          onChange={(e) => onChange({ ...ramp, interpolation: e.target.value as ColorRampInterpolation })}
        >
          {COLOR_RAMP_INTERPOLATIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <canvas
        ref={canvasRef}
        width={240}
        height={BAR_HEIGHT + MARKER_ROW_HEIGHT + 16}
        className="color-ramp-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      />
      {selectedStop && (
        <div className="color-ramp-stop-editor">
          <ColorPickerInput value={selectedStop.color} onChange={setSelectedColor} />
          <DragNumberInput
            value={Math.round(selectedStop.position * 1000) / 1000}
            step={0.01}
            min={0}
            max={1}
            onChange={setSelectedPosition}
          />
        </div>
      )}
      <div className="color-ramp-hint">Double-click bar to add a stop</div>
    </div>
  );
};
