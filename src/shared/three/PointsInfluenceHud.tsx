import type { ReactNode } from "react";
import { HudBar, HudSeparator, HudToolColumn } from "./HudToolbars";
import {
  POINTS_INFLUENCE_LEVELS,
  readPointsInfluenceTool,
  readPointsInfluenceValue,
  type PointsInfluenceTool,
} from "../graph/nodes/pointsInfluence";
import type { NodeInstance } from "../graph/types";

/**
 * The Points Influence palette, laid out like Edit Mesh's and the rig
 * palettes: the tools in a column on the left, the options for the armed
 * tool in a bar along the bottom. The tools paint the node's influence map
 * on the surface (Texture Paint's strokes); Compute, in the parameters,
 * hands it to the points.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const icon = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const TOOLS: { tool: PointsInfluenceTool; title: string; glyph: ReactNode }[] = [
  {
    tool: "paint",
    title: "Paint — drag on the surface to paint the chosen influence",
    glyph: (
      <>
        <circle cx="12" cy="12" r="8" strokeDasharray="2.5 2" />
        <circle cx="12" cy="12" r="3.5" fill="currentColor" fillOpacity="0.5" />
      </>
    ),
  },
  {
    tool: "erase",
    title: "Erase — drag to paint influence back to 0%",
    glyph: (
      <>
        <path d="M7 20h13" />
        <path d="M4.5 15.5 14 6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8z" />
        <path d="m9.5 10.5 5 5" />
      </>
    ),
  },
  {
    tool: "smooth",
    title: "Smooth — drag to blur the edges of what is painted",
    glyph: (
      <>
        <path d="M3 15c3-6 6-6 9 0s6 6 9 0" />
        <path d="M3 9c3-3 6-3 9 0s6 3 9 0" strokeOpacity="0.5" />
      </>
    ),
  },
  {
    tool: "fill",
    title: "Fill — click the surface to set the whole map to the chosen influence",
    glyph: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="1.5" />
        <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" fillOpacity="0.5" stroke="none" />
      </>
    ),
  },
];

export interface PointsInfluenceHudProps {
  node: NodeInstance;
  /** `#rrggbb` for each of POINTS_INFLUENCE_LEVELS — the heatmap's own colours, so a swatch matches what it paints. */
  levelColors: string[];
  maxRows: number;
  left: number;
  onParams: OnParams;
  /** Clears the map to 0% everywhere (undoable). */
  onClear: () => void;
}

export function PointsInfluenceHud({ node, levelColors, maxRows, left, onParams, onClear }: PointsInfluenceHudProps) {
  const tool = readPointsInfluenceTool(node.params);
  const value = readPointsInfluenceValue(node.params);
  const size = Number(node.params.brushSize) || 24;
  const usesValue = tool === "paint" || tool === "fill";
  const usesSize = tool !== "fill";
  const stored = node.params.influences;
  const computed = stored && typeof stored === "object" ? Object.keys(stored).length : 0;

  return (
    <>
      <HudToolColumn maxRows={maxRows} left={left}>
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            className={`viewport-hud-button ${tool === t.tool ? "viewport-hud-button-active" : ""}`}
            onClick={() => tool !== t.tool && onParams({ brushTool: t.tool }, node.id)}
            title={t.title}
          >
            {icon(t.glyph)}
          </button>
        ))}
      </HudToolColumn>
      <HudBar>
        {usesValue && (
          <>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>Influence</span>
            {POINTS_INFLUENCE_LEVELS.map((level, i) => (
              <button
                key={level}
                type="button"
                className={`viewport-influence-level ${Math.abs(value - level) < 1e-6 ? "viewport-influence-level-active" : ""}`}
                style={{ backgroundColor: levelColors[i] }}
                onClick={() => onParams({ brushValue: level }, node.id)}
                title={`${Math.round(level * 100)}% — the influence the ${tool === "fill" ? "fill" : "brush"} paints`}
              >
                {Math.round(level * 100)}
              </button>
            ))}
          </>
        )}
        {usesSize && (
          <>
            {usesValue && <HudSeparator />}
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 40 }} title="Brush size, in pixels of the influence map ([ and ] resize)">
                Size: {size}
              </span>
              <input
                type="range"
                min={2}
                max={200}
                step={1}
                value={size}
                onChange={(e) => onParams({ brushSize: Number(e.target.value) }, node.id)}
                style={{ width: 70, accentColor: "#38bdf8", cursor: "pointer" }}
                title="Brush size (map px)"
              />
            </div>
          </>
        )}
        <HudSeparator />
        <span style={{ fontSize: 11, color: "#94a3b8" }} title="Points with influence after the last Compute (in the parameters)">
          {computed} point{computed === 1 ? "" : "s"} computed
        </span>
        <button
          type="button"
          className="viewport-hud-button"
          onClick={onClear}
          title="Clear — paint the whole map back to 0% (undoable; Compute to apply it to the points)"
          style={{ fontSize: 11, padding: "2px 6px", width: "auto" }}
        >
          Clear
        </button>
      </HudBar>
    </>
  );
}
