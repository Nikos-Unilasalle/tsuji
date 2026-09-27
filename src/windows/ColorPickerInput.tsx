import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { clamp01, hexToHsv, hsvToHex, isValidHex, normalizeHex, parseColorToHex, Hsv } from "./color-utils";
import "./color-picker.css";

const PRESETS = [
  "#ffffff", "#c9d1d9", "#8b949e", "#000000",
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#a855f7", "#ec4899",
];

interface ColorPickerInputProps {
  value: unknown;
  onChange: (v: THREE.Color) => void;
  /**
   * Where the picker opens: below, left-aligned (the default, for the param
   * panel), or above, right-aligned — for a picker near the bottom-right of
   * the viewport, where the default would open off-screen.
   */
  placement?: "below" | "above-right";
}

/**
 * Self-contained HSV picker. The native <input type="color"> is deliberately
 * avoided: in WKWebView (Tauri on macOS) the OS colour panel does not emit
 * input/change events for swatches picked from its "Color Palettes" tab.
 */
export function ColorPickerInput({ value, onChange, placement = "below" }: ColorPickerInputProps) {
  const colorHex = parseColorToHex(value);

  const containerRef = useRef<HTMLDivElement>(null);
  const squareRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(colorHex));
  const [textValue, setTextValue] = useState(colorHex);

  // Always-current hsv read by the sync effect below. The effect reacts only to
  // external `colorHex` changes and must compare against the *latest* HSV, not
  // the value captured when the effect last ran — putting `hsv` in the deps
  // array instead would re-trigger the effect on every drag.
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;

  // Sync from the outside only when the incoming colour is not what our own
  // HSV state already represents; otherwise dragging into pure black/white
  // would lose the hue on the round-trip through hex.
  useEffect(() => {
    if (hsvToHex(hsvRef.current) !== colorHex) {
      setHsv(hexToHsv(colorHex));
    }
    setTextValue(colorHex);
  }, [colorHex]);

  const commitHex = (hex: string) => {
    try {
      onChange(new THREE.Color(hex));
    } catch {
      // Ignore unparseable colours (partial typing)
    }
  };

  const commitHsv = (next: Hsv) => {
    setHsv(next);
    commitHex(hsvToHex(next));
  };

  const handleTextChange = (raw: string) => {
    setTextValue(raw);
    if (!isValidHex(raw)) return;
    const hex = normalizeHex(raw);
    setHsv(hexToHsv(hex));
    commitHex(hex);
  };

  const handlePresetClick = (preset: string) => {
    setHsv(hexToHsv(preset));
    commitHex(preset);
  };

  const trackPointer = (
    event: React.PointerEvent,
    ref: React.RefObject<HTMLDivElement | null>,
    toHsv: (xRatio: number, yRatio: number) => Hsv,
  ) => {
    const element = ref.current;
    if (!element) return;

    const apply = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      const xRatio = clamp01((clientX - rect.left) / rect.width);
      const yRatio = clamp01((clientY - rect.top) / rect.height);
      commitHsv(toHsv(xRatio, yRatio));
    };

    element.setPointerCapture(event.pointerId);
    apply(event.clientX, event.clientY);

    const onMove = (e: PointerEvent) => apply(e.clientX, e.clientY);
    const onUp = (e: PointerEvent) => {
      element.releasePointerCapture(e.pointerId);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const hueHex = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return (
    <div className="cp-container" ref={containerRef} onMouseDown={(e) => e.stopPropagation()}>
      <div className="cp-main">
        <button
          type="button"
          className="cp-swatch"
          style={{ backgroundColor: colorHex }}
          onClick={() => setIsOpen((open) => !open)}
          title="Click to pick color"
        />
        <input
          type="text"
          className="cp-hex-input"
          value={textValue}
          onChange={(e) => handleTextChange(e.target.value)}
          onBlur={() => setTextValue(colorHex)}
        />
      </div>

      {isOpen && (
        <div className={`cp-popover${placement === "above-right" ? " cp-popover-above-right" : ""}`}>
          <div
            className="cp-square"
            ref={squareRef}
            style={{ backgroundColor: hueHex }}
            onPointerDown={(e) => trackPointer(e, squareRef, (x, y) => ({ h: hsv.h, s: x, v: 1 - y }))}
          >
            <div className="cp-square-white" />
            <div className="cp-square-black" />
            <div
              className="cp-square-cursor"
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: colorHex }}
            />
          </div>

          <div
            className="cp-hue"
            ref={hueRef}
            onPointerDown={(e) => trackPointer(e, hueRef, (x) => ({ ...hsv, h: x * 360 }))}
          >
            <div className="cp-hue-cursor" style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: hueHex }} />
          </div>

          <div className="cp-presets">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="cp-preset-btn"
                style={{ backgroundColor: preset }}
                onClick={() => handlePresetClick(preset)}
                title={preset}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
