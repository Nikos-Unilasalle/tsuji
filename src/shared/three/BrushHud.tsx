import { ReactNode } from "react";

/**
 * The floating brush palette shared by the Terrain and Sculpt nodes. Both
 * used to carry their own near-identical copy; one component keeps the
 * tool icons, ordering, wording and controls the same on both, and a tool
 * both nodes offer looks and reads the same wherever it appears.
 */

/** One shared vocabulary of brush tools. A node maps its own tool ids onto these. */
export type BrushToolKind =
  | "draw"
  | "clay"
  | "inflate"
  | "smooth"
  | "pinch"
  | "crease"
  | "flatten"
  | "grab"
  | "noise"
  | "erode"
  | "mask";

const svgProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const BRUSH_TOOL_META: Record<BrushToolKind, { label: string; title: string; icon: ReactNode }> = {
  draw: {
    label: "Draw",
    title: "Draw: Raise / Lower (Hold Alt to invert)",
    icon: (
      <svg {...svgProps}>
        <path d="m8 3 4 8 5-5 5 15H2L8 3z" />
      </svg>
    ),
  },
  clay: {
    label: "Clay",
    title: "Clay: Build up material toward the brush-local average",
    icon: (
      <svg {...svgProps}>
        <rect x="3" y="9" width="18" height="7" rx="1.5" />
      </svg>
    ),
  },
  inflate: {
    label: "Inflate",
    title: "Inflate: Puff the surface out along each vertex's own normal",
    icon: (
      <svg {...svgProps}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
      </svg>
    ),
  },
  smooth: {
    label: "Smooth",
    title: "Smooth: Soften sharp slopes and rough peaks",
    icon: (
      <svg {...svgProps}>
        <path d="M2 12c3-4 6-4 9 0s6 4 9 0" />
        <path d="M2 17c3-4 6-4 9 0s6 4 9 0" />
      </svg>
    ),
  },
  pinch: {
    label: "Pinch",
    title: "Pinch: Sharpen ridges (opposite of Smooth)",
    icon: (
      <svg {...svgProps}>
        <path d="M4 4 20 20M20 4 4 20" />
      </svg>
    ),
  },
  crease: {
    label: "Crease",
    title: "Crease: Carve a sharp valley line",
    icon: (
      <svg {...svgProps}>
        <path d="M3 12h7l2 6 4-14 2 8h3" />
      </svg>
    ),
  },
  flatten: {
    label: "Flatten",
    title: "Flatten: Level to the plane where the stroke started (roads, plateaus)",
    icon: (
      <svg {...svgProps}>
        <path d="M3 15h18" />
        <path d="M7 10h10" />
        <path d="M10 5h4" />
      </svg>
    ),
  },
  grab: {
    label: "Grab",
    title: "Grab: Drag the brush footprint with the pointer",
    icon: (
      <svg {...svgProps}>
        <path d="M12 3v18M3 12h18" />
        <path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
      </svg>
    ),
  },
  noise: {
    label: "Noise",
    title: "Noise: Add natural rockiness and rough texture",
    icon: (
      <svg {...svgProps}>
        <path d="M2 13.5 5 11l4 5 5-9 4 6 4-3" />
      </svg>
    ),
  },
  erode: {
    label: "Erode",
    title: "Erode: Simulate natural sediment and thermal erosion",
    icon: (
      <svg {...svgProps}>
        <path d="M12 2v6" />
        <path d="m4.93 10.93 4.24 4.24" />
        <path d="m14.83 15.17 4.24-4.24" />
        <path d="M2 18h20" />
      </svg>
    ),
  },
  mask: {
    label: "Mask",
    title: "Mask: Paint protection (Hold Shift to erase)",
    icon: (
      <svg {...svgProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
};

export interface BrushHudTool {
  /** The node's own tool id (what gets written to its `brushTool` param). */
  id: string;
  kind: BrushToolKind;
  /** Overrides the shared tooltip when a node's tool behaves differently from the shared description. */
  title?: string;
}

export interface BrushHudProps {
  badge: string;
  badgeTitle: string;
  /** RGB triplet, e.g. "16, 185, 129" — drives the border, glow and badge tint. */
  accentRgb: string;
  accentHex: string;
  tools: BrushHudTool[];
  currentTool: string;
  onTool: (id: string) => void;
  invert: boolean;
  invertTitles: { on: string; off: string };
  onInvert: () => void;
  symmetry: { axis: string; active: boolean; onToggle: () => void }[];
  radius: { value: number; min: number; max: number; step: number; label: string; onChange: (v: number) => void };
  strength: { value: number; onChange: (v: number) => void };
  falloff: { value: string; onChange: (v: string) => void };
  /** Node-specific controls (dyntopo detail, stylus toggle…) shown between falloff and Reset. */
  extras?: ReactNode;
  resetTitle: string;
  onReset: () => void;
}

const SEPARATOR = <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />;

const FALLOFFS: [string, string][] = [
  ["smooth", "Smooth"],
  ["linear", "Linear"],
  ["sphere", "Sphere"],
  ["flat", "Flat"],
];

export function BrushHud(props: BrushHudProps) {
  const { accentRgb, accentHex } = props;
  return (
    <div
      className="viewport-terrain-hud"
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexWrap: "wrap",
        maxWidth: "calc(100% - 24px)",
        gap: 8,
        padding: "6px 14px",
        background: "var(--chrome-surface-raised)",
        backdropFilter: "blur(12px)",
        border: `1px solid rgba(${accentRgb}, 0.45)`,
        borderRadius: "8px",
        boxShadow: `0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(${accentRgb}, 0.2)`,
        color: "#ffffff",
        fontSize: "12px",
        zIndex: 45,
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          fontWeight: 700,
          color: accentHex,
          padding: "2px 8px",
          background: `rgba(${accentRgb}, 0.15)`,
          borderRadius: "4px",
          letterSpacing: "0.04em",
          userSelect: "none",
        }}
        title={props.badgeTitle}
      >
        {props.badge}
      </div>

      {SEPARATOR}

      {props.tools.map((tool) => {
        const meta = BRUSH_TOOL_META[tool.kind];
        return (
          <button
            key={tool.id}
            type="button"
            className={`viewport-hud-button ${props.currentTool === tool.id ? "viewport-hud-button-active" : ""}`}
            onClick={() => props.onTool(tool.id)}
            title={tool.title ?? meta.title}
            aria-label={meta.label}
          >
            {meta.icon}
          </button>
        );
      })}

      {SEPARATOR}

      <button
        type="button"
        className={`viewport-hud-button ${props.invert ? "viewport-hud-button-active" : ""}`}
        onClick={props.onInvert}
        title={props.invert ? props.invertTitles.on : props.invertTitles.off}
        style={{ fontWeight: 700, fontSize: "13px", minWidth: 26 }}
      >
        {props.invert ? "−" : "+"}
      </button>

      {props.symmetry.map(({ axis, active, onToggle }) => (
        <button
          key={axis}
          type="button"
          className={`viewport-hud-button ${active ? "viewport-hud-button-active" : ""}`}
          onClick={onToggle}
          title={`Symmetry ${axis}: Mirror strokes across the ${axis} axis`}
          style={{ fontWeight: 700, fontSize: "11px", minWidth: 22 }}
        >
          {axis}
        </button>
      ))}

      {SEPARATOR}

      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: "11px", color: "#94a3b8", minWidth: 32 }} title="Radius (use [ and ] shortcuts)">
          {props.radius.label}
        </span>
        <input
          type="range"
          min={props.radius.min}
          max={props.radius.max}
          step={props.radius.step}
          value={props.radius.value}
          onChange={(e) => props.radius.onChange(Number(e.target.value))}
          style={{ width: 56, accentColor: accentHex, cursor: "pointer" }}
          title="Brush Radius"
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: "11px", color: "#94a3b8", minWidth: 30 }} title="Brush Strength">
          {Math.round(props.strength.value * 100)}%
        </span>
        <input
          type="range"
          min={0.05}
          max={1.0}
          step={0.05}
          value={props.strength.value}
          onChange={(e) => props.strength.onChange(Number(e.target.value))}
          style={{ width: 50, accentColor: accentHex, cursor: "pointer" }}
          title="Brush Strength"
        />
      </div>

      <select
        value={props.falloff.value}
        onChange={(e) => props.falloff.onChange(e.target.value)}
        style={{
          background: "rgba(255, 255, 255, 0.08)",
          color: "#f1f5f9",
          border: "1px solid rgba(255, 255, 255, 0.15)",
          borderRadius: 4,
          fontSize: "11px",
          height: 24,
          padding: "0 6px",
          outline: "none",
          cursor: "pointer",
        }}
        title="Brush Falloff Shape"
      >
        {FALLOFFS.map(([value, label]) => (
          <option key={value} value={value} style={{ background: "#1e293b", color: "#fff" }}>
            {label}
          </option>
        ))}
      </select>

      {props.extras ? (
        <>
          {SEPARATOR}
          {props.extras}
        </>
      ) : null}

      {SEPARATOR}

      <button
        type="button"
        className="viewport-hud-button"
        onClick={props.onReset}
        title={props.resetTitle}
        style={{ fontSize: "11px", padding: "2px 6px", width: "auto" }}
      >
        Reset
      </button>
    </div>
  );
}
