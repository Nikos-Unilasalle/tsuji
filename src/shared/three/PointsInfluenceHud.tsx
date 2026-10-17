import type { ReactNode } from "react";
import { HudBar, HudSeparator, HudToolColumn } from "./HudToolbars";
import { POINTS_INFLUENCE_DISCRETE_LEVELS, type PointsInfluenceMode } from "../graph/nodes/pointsInfluence";
import type { NodeInstance } from "../graph/types";

/**
 * The Points Influence palette, laid out like Edit Mesh's and the rig
 * palettes: the tools in a column on the left, the options for the armed
 * tool in a bar along the bottom. It replaces modifier keys as the way in —
 * pick a tool, then drag on the points (a drag that starts off the points
 * still orbits). Cmd and Shift keep working as shortcuts: Cmd forces the
 * tool from anywhere, Shift erases for one stroke.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const icon = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const TOOLS: { mode: PointsInfluenceMode; title: string; glyph: ReactNode }[] = [
  {
    mode: "brush",
    title: "Brush — drag over the points to paint, strongest at the centre (radius in the bar)",
    glyph: (
      <>
        <circle cx="12" cy="12" r="8" strokeDasharray="2.5 2" />
        <circle cx="12" cy="12" r="3.5" fill="currentColor" fillOpacity="0.5" />
      </>
    ),
  },
  {
    mode: "discrete",
    title: "Assign — click a point, or drag a box from a point, to set the chosen level exactly",
    glyph: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="3 2" />
        <circle cx="9" cy="10" r="1.8" fill="currentColor" />
        <circle cx="15" cy="9" r="1.8" fill="currentColor" />
        <circle cx="12" cy="15" r="1.8" fill="currentColor" />
      </>
    ),
  },
  {
    mode: "gradient",
    title: "Gradient — drag a line across the object: 100% where it starts, 0% where it ends",
    glyph: (
      <>
        <rect x="3" y="6" width="18" height="12" rx="1.5" />
        <path d="M7 6v12M11 6v12" strokeOpacity="0.9" />
        <path d="M15 6v12" strokeOpacity="0.5" />
        <path d="M18.5 6v12" strokeOpacity="0.25" />
      </>
    ),
  },
];

export interface PointsInfluenceHudProps {
  node: NodeInstance;
  /** `#rrggbb` for each of POINTS_INFLUENCE_DISCRETE_LEVELS — the heatmap's own colours, so a swatch matches what it paints. */
  levelColors: string[];
  erase: boolean;
  onErase: (erase: boolean) => void;
  maxRows: number;
  left: number;
  onParams: OnParams;
  /** The armed level, which is not an undo step of its own (it never changes the output). */
  onLevel: (level: number) => void;
}

export function readPointsInfluenceMode(node: NodeInstance): PointsInfluenceMode {
  const mode = node.params.mode;
  return mode === "discrete" || mode === "gradient" ? mode : "brush";
}

export function PointsInfluenceHud({ node, levelColors, erase, onErase, maxRows, left, onParams, onLevel }: PointsInfluenceHudProps) {
  const mode = readPointsInfluenceMode(node);
  const activeLevel = typeof node.params.activeLevel === "number" ? node.params.activeLevel : POINTS_INFLUENCE_DISCRETE_LEVELS[2];
  const radius = Number(node.params.brushRadius) || 40;
  const stored = node.params.influences;
  const painted = stored && typeof stored === "object" ? Object.keys(stored).length : 0;
  const usesLevel = mode !== "gradient";

  return (
    <>
      <HudToolColumn maxRows={maxRows} left={left}>
        {TOOLS.map((tool) => (
          <button
            key={tool.mode}
            type="button"
            className={`viewport-hud-button ${mode === tool.mode ? "viewport-hud-button-active" : ""}`}
            onClick={() => mode !== tool.mode && onParams({ mode: tool.mode }, node.id)}
            title={tool.title}
          >
            {icon(tool.glyph)}
          </button>
        ))}
        <button
          type="button"
          className={`viewport-hud-button ${erase && usesLevel ? "viewport-hud-button-active" : ""}`}
          disabled={!usesLevel}
          onClick={() => onErase(!erase)}
          title={
            usesLevel
              ? erase
                ? "Erase ON — strokes lower or remove influence (click to paint again; Shift erases for one stroke)"
                : "Erase OFF — strokes add influence (click to erase; Shift erases for one stroke)"
              : "Erase — not used by Gradient, which redefines every point"
          }
        >
          {icon(
            <>
              <path d="M7 20h13" />
              <path d="M4.5 15.5 14 6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8z" />
              <path d="m9.5 10.5 5 5" />
            </>,
          )}
        </button>
      </HudToolColumn>
      <HudBar>
        {usesLevel ? (
          <>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>{mode === "brush" ? "Max" : "Level"}</span>
            {POINTS_INFLUENCE_DISCRETE_LEVELS.map((level, i) => (
              <button
                key={level}
                type="button"
                className={`viewport-influence-level ${activeLevel === level ? "viewport-influence-level-active" : ""}`}
                style={{ backgroundColor: levelColors[i] }}
                onClick={() => onLevel(level)}
                title={
                  mode === "brush"
                    ? `${Math.round(level * 100)}% — the strongest the brush paints, at its centre`
                    : `${Math.round(level * 100)}% — the value a click or box assigns`
                }
              >
                {Math.round(level * 100)}
              </button>
            ))}
          </>
        ) : (
          <span style={{ fontSize: 11, color: "#94a3b8" }}>Drag across the object: 100% at the start, 0% at the end</span>
        )}
        {mode === "brush" && (
          <>
            <HudSeparator />
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 40 }} title="Brush radius, in screen pixels">
                R: {radius}px
              </span>
              <input
                type="range"
                min={5}
                max={200}
                step={5}
                value={radius}
                onChange={(e) => onParams({ brushRadius: Number(e.target.value) }, node.id)}
                style={{ width: 70, accentColor: "#38bdf8", cursor: "pointer" }}
                title="Brush Radius (px)"
              />
            </div>
          </>
        )}
        <HudSeparator />
        <span style={{ fontSize: 11, color: "#94a3b8" }}>
          {painted} point{painted === 1 ? "" : "s"} painted
        </span>
        <button
          type="button"
          className="viewport-hud-button"
          disabled={painted === 0}
          onClick={() => onParams({ influences: {} }, node.id)}
          title="Clear — set every point back to 0% (undoable)"
          style={{ fontSize: 11, padding: "2px 6px", width: "auto" }}
        >
          Clear
        </button>
      </HudBar>
    </>
  );
}
