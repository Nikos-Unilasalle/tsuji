import React, { useEffect, useRef, useState } from "react";

/**
 * A step of 1 or more, with no sub-unit meaning (Count, Subdivisions,
 * Segments...), marks the field as integer — its wheel/display rounds to
 * whole numbers instead of the usual 3 decimals. A sub-1 step (Location,
 * Scale...) stays float. Free typing (click to edit) still accepts any
 * value either way.
 */
function isIntegerField(step: number): boolean {
  return Number.isInteger(step) && step >= 1;
}

function formatValue(v: number, integer: boolean): string {
  if (!Number.isFinite(v)) return "0";
  return integer ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000);
}

export type KeyframeStatus = "none" | "exact" | "interpolated";

export interface DragNumberChangeMeta {
  shiftKey?: boolean;
  startValue?: number;
  isDrag?: boolean;
}

interface DragNumberInputProps {
  value: number;
  onChange: (value: number, meta?: DragNumberChangeMeta) => void;
  step?: number;
  status?: KeyframeStatus;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  min?: number;
  max?: number;
  isVector?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export function DragNumberInput({
  value,
  onChange,
  step = 0.1,
  status = "none",
  onMouseEnter,
  onMouseLeave,
  min,
  max,
  isVector = false,
  onDragStart,
  onDragEnd,
}: DragNumberInputProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const integer = isIntegerField(step);

  const clamp = (v: number) => {
    let r = v;
    if (min !== undefined) r = Math.max(min, r);
    if (max !== undefined) r = Math.min(max, r);
    return r;
  };

  // Mirrors `value` for the duration of a drag gesture, so the running total
  // is computed from wherever the pointer actually is now rather than from
  // the (possibly one-render-stale) `value` prop.
  const liveValueRef = useRef(value);
  useEffect(() => {
    liveValueRef.current = value;
  }, [value]);

  // Set only while an actual drag (movement past the threshold) has
  // happened, and read once by onClick right after mouseup — a plain click
  // (mousedown+mouseup with no real movement) should still open text-edit,
  // but the click that ends a drag gesture must not.
  const justDraggedRef = useRef(false);

  const commitEdit = (raw: string) => {
    const parsed = Number.parseFloat(raw);
    const next = Number.isFinite(parsed) ? parsed : value;
    onChange(clamp(integer ? Math.round(next) : next), { isDrag: false });
    setEditing(false);
  };

  const PIXELS_PER_STEP = 4;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const isPen = e.pointerType === "pen" || e.pointerType === "touch";
    const dragThreshold = isPen ? 4 : 3;

    const el = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // ignore
    }

    const startValue = liveValueRef.current;
    let accumulatedDy = 0;
    let lastClientY = e.clientY;
    let dragged = false;
    let lockRequested = false;

    const handlePointerMove = (ev: PointerEvent) => {
      // For pen/touch inputs, movementY can be 0 or erratic. We safely compute dy from clientY.
      const dy = isPen || ev.movementY === undefined ? -(ev.clientY - lastClientY) : -ev.movementY;
      lastClientY = ev.clientY;
      accumulatedDy += dy;

      if (!dragged) {
        if (Math.abs(accumulatedDy) < dragThreshold) return;
        dragged = true;
        onDragStart?.();
        // Only request Pointer Lock for mouse, never for styluses/touch (prevents driver/cursor jumps)
        if (!isPen && !lockRequested) {
          lockRequested = true;
          el.requestPointerLock?.()?.catch(() => {});
        }
      }

      const currentStep = (isVector || !ev.shiftKey) ? (step || 0.1) : (step || 0.1) * 0.1;
      const raw = startValue + (accumulatedDy / PIXELS_PER_STEP) * currentStep;
      const newValue = clamp(integer ? Math.round(raw) : Math.round(raw * 1000) / 1000);
      liveValueRef.current = newValue;
      onChange(newValue, { shiftKey: ev.shiftKey, startValue, isDrag: true });
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      try {
        if (el.hasPointerCapture(pointerId)) {
          el.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore
      }
      if (document.pointerLockElement === el) document.exitPointerLock();
      justDraggedRef.current = dragged;
      if (dragged) {
        onDragEnd?.();
      } else {
        setText(formatValue(liveValueRef.current, integer));
        setEditing(true);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  let boxStyle: React.CSSProperties = {};
  if (status === "exact") {
    boxStyle = {
      backgroundColor: "#76C560",
      color: "#0f172a",
      fontWeight: "700",
      borderColor: "#5aa746",
    };
  } else if (status === "interpolated") {
    boxStyle = {
      backgroundColor: "#EDA446",
      color: "#0f172a",
      fontWeight: "700",
      borderColor: "#d48b32",
    };
  }

  if (editing) {
    return (
      <input
        className="drag-number drag-number-editing"
        type="text"
        inputMode="decimal"
        autoFocus
        style={boxStyle}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => commitEdit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitEdit(text);
          if (e.key === "Escape") setEditing(false);
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />
    );
  }

  return (
    <div
      className="drag-number"
      style={boxStyle}
      onClick={() => {
        if (justDraggedRef.current) {
          justDraggedRef.current = false;
          return;
        }
        setText(formatValue(value, integer));
        setEditing(true);
      }}
      onPointerDown={handlePointerDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      title="Drag to scrub, click to type (Shift = finer)"
    >
      {formatValue(value, integer)}
    </div>
  );
}
