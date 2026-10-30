import { useId, useRef } from "react";
import { ViRange, dragValue, knobFraction } from "../shared/graph/nodes/virtualInterface";

/**
 * The Virtual Interface's hardware: a knob, a switch and a stepped selector, drawn in SVG so they stay sharp at any
 * size and take the accent they are given. They hold no value of their own: each shows what it is handed and reports
 * a change, and the HUD writes it (a drag's changes fold into one undo step there).
 */

/** The knob's travel: 270°, from 7:30 round to 4:30. */
const SWEEP = 270;
const START = -135;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  if (to - from < 0.01) return "";
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

export function formatValue(v: number, step?: number): string {
  if (!Number.isFinite(v)) return "—";
  const digits = step && step >= 1 ? 0 : Math.abs(v) >= 100 ? 1 : 2;
  return Number(v.toFixed(digits)).toString();
}

export function Knob({
  value,
  range,
  step,
  size,
  accent,
  label,
  unit,
  disabled,
  title,
  onChange,
  onReset,
}: {
  value: number;
  range: ViRange;
  step?: number;
  size: number;
  accent: string;
  label: string;
  unit?: string;
  disabled?: boolean;
  title?: string;
  onChange: (v: number) => void;
  /** Double-click: back to the param's default. */
  onReset?: () => void;
}) {
  const gid = useId().replace(/:/g, "");
  const drag = useRef<{ y: number; start: number } | null>(null);
  const f = knobFraction(value, range);
  // A range across zero lights from the centre, the way a pan or a bipolar amount reads.
  const zero = range[0] < 0 && range[1] > 0 ? knobFraction(0, range) : 0;
  const s = size;
  const c = s / 2;
  const r = s * 0.44;
  const angle = START + SWEEP * f;
  const [px, py] = polar(c, c, r * 0.56, angle);
  const [px2, py2] = polar(c, c, r * 0.22, angle);
  const from = START + SWEEP * Math.min(f, zero);
  const to = START + SWEEP * Math.max(f, zero);

  return (
    <div className={`vi-control vi-knob${disabled ? " vi-disabled" : ""}`} title={title} style={{ width: Math.max(s, 64) }}>
      <svg
        width={s}
        height={s}
        viewBox={`0 0 ${s} ${s}`}
        style={{ touchAction: "none", cursor: disabled ? "default" : "ns-resize" }}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.preventDefault();
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, start: value };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          onChange(dragValue(d.start, d.y - e.clientY, range, { fine: e.shiftKey, step }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => !disabled && onReset?.()}
        onWheel={(e) => {
          if (disabled) return;
          // A notch is a hundredth of the range (a five-hundredth with Shift).
          const notch = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.4 : 2);
          onChange(dragValue(value, notch, range, { step }));
        }}
      >
        <defs>
          {/* The body in the theme's surfaces: lit from the top left, falling off to the background. */}
          <radialGradient id={`body${gid}`} cx="40%" cy="32%" r="75%">
            <stop offset="0%" className="vi-knob-hi" />
            <stop offset="55%" className="vi-knob-mid" />
            <stop offset="100%" className="vi-knob-lo" />
          </radialGradient>
          <filter id={`glow${gid}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={s * 0.03} result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* Scale: a tick every tenth of the travel */}
        {Array.from({ length: 11 }, (_, i) => {
          const a = START + (SWEEP * i) / 10;
          const [x0, y0] = polar(c, c, r * 1.08, a);
          const [x1, y1] = polar(c, c, r * (i % 5 === 0 ? 1.22 : 1.15), a);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className="vi-knob-tick" strokeWidth={1} />;
        })}
        <path d={arc(c, c, r * 0.92, START, START + SWEEP)} fill="none" className="vi-knob-track" strokeWidth={s * 0.06} strokeLinecap="round" />
        <path d={arc(c, c, r * 0.92, from, to)} fill="none" style={{ stroke: accent }} strokeWidth={s * 0.06} strokeLinecap="round" filter={`url(#glow${gid})`} />
        <circle cx={c} cy={c + s * 0.02} r={r * 0.74} className="vi-knob-shadow" />
        <circle cx={c} cy={c} r={r * 0.72} fill={`url(#body${gid})`} className="vi-knob-rim" strokeWidth={1} />
        <circle cx={c} cy={c} r={r * 0.58} fill="none" className="vi-knob-ring" strokeWidth={1} />
        <line x1={px2} y1={py2} x2={px} y2={py} style={{ stroke: accent }} strokeWidth={Math.max(2, s * 0.045)} strokeLinecap="round" />
      </svg>
      <span className="vi-value">
        {formatValue(value, step)}
        {unit}
      </span>
      <span className="vi-label">{label}</span>
    </div>
  );
}

export function Switch({ on, accent, label, disabled, title, onChange }: { on: boolean; accent: string; label: string; disabled?: boolean; title?: string; onChange: (on: boolean) => void }) {
  return (
    <div className={`vi-control vi-switch${disabled ? " vi-disabled" : ""}`} title={title}>
      <button
        type="button"
        className={`vi-switch-body${on ? " vi-on" : ""}`}
        style={{ ["--vi-accent" as string]: accent }}
        disabled={disabled}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => onChange(!on)}
        aria-pressed={on}
      >
        <span className="vi-led" />
        <span className="vi-switch-cap" />
      </button>
      <span className="vi-value">{on ? "ON" : "OFF"}</span>
      <span className="vi-label">{label}</span>
    </div>
  );
}

export function Selector({
  value,
  options,
  labels,
  accent,
  label,
  disabled,
  title,
  onChange,
}: {
  value: string;
  options: readonly string[];
  labels?: readonly string[];
  accent: string;
  label: string;
  disabled?: boolean;
  title?: string;
  onChange: (v: string) => void;
}) {
  const i = Math.max(0, options.indexOf(value));
  const n = options.length;
  const go = (by: number) => n > 0 && onChange(options[(((i + by) % n) + n) % n]);
  const text = labels?.[i] ?? options[i] ?? "—";
  return (
    <div className={`vi-control vi-selector${disabled ? " vi-disabled" : ""}`} title={title} style={{ ["--vi-accent" as string]: accent }}>
      <div
        className="vi-lcd"
        onWheel={(e) => !disabled && go(e.deltaY < 0 ? -1 : 1)}
      >
        <button type="button" disabled={disabled} onPointerDown={(e) => e.preventDefault()} onClick={() => go(-1)} aria-label="Previous">
          ◀
        </button>
        <span className="vi-lcd-text" title={text}>
          {text}
        </span>
        <button type="button" disabled={disabled} onPointerDown={(e) => e.preventDefault()} onClick={() => go(1)} aria-label="Next">
          ▶
        </button>
      </div>
      {n <= 16 && (
        <div className="vi-steps">
          {options.map((o, k) => (
            <button
              type="button"
              key={o}
              disabled={disabled}
              className={k === i ? "vi-on" : ""}
              title={labels?.[k] ?? o}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onChange(o)}
            />
          ))}
        </div>
      )}
      <span className="vi-label">{label}</span>
    </div>
  );
}
