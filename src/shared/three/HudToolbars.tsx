import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Shared look of the floating editing HUDs (Grease Pencil, Edit Mesh). */
const HUD_PANEL_STYLE = {
  boxSizing: "border-box",
  background: "rgba(24, 28, 38, 0.95)",
  backdropFilter: "blur(12px)",
  border: "1px solid rgba(56, 189, 248, 0.4)",
  borderRadius: "8px",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(56, 189, 248, 0.2)",
  color: "#ffffff",
  fontSize: "12px",
  zIndex: 45,
  pointerEvents: "auto",
} as const;

const TOOL_SIZE = 28;
const TOOL_GAP = 2;
/** Below the view controls (top-left). */
const COLUMN_TOP = 60;
/** Above the corner orientation gizmo (12px inset + 110px) plus a margin. */
const COLUMN_BOTTOM_CLEARANCE = 134;
/** The corner gizmo's right edge plus a margin — the bar stays right of it. */
const BAR_LEFT = 134;

/**
 * How many tool rows fit in the pane's height between the view controls and
 * the corner gizmo. Never fewer than 4: a very short pane lets the column
 * overlap the gizmo rather than turn into a long horizontal strip.
 */
export function useHudToolMaxRows(hostRef: RefObject<HTMLElement | null>): number {
  const [maxRows, setMaxRows] = useState(16);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () =>
      setMaxRows(
        Math.max(
          4,
          Math.floor(
            (host.clientHeight - COLUMN_TOP - COLUMN_BOTTOM_CLEARANCE - 2 * 4 + TOOL_GAP) / (TOOL_SIZE + TOOL_GAP),
          ),
        ),
      );
    const observer = new ResizeObserver(update);
    observer.observe(host);
    update();
    return () => observer.disconnect();
  }, [hostRef]);
  return maxRows;
}

/**
 * Tool column on the pane's left edge. Wraps into balanced columns when the
 * pane is too short for `maxRows`. The row count is set from the rendered
 * children rather than CSS `auto-fill`: an absolutely positioned grid sizes its
 * width from the wrong row count and the wrapped columns spill out of the panel.
 */
export function HudToolColumn({ maxRows, left = 12, children }: { maxRows: number; left?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const count = Math.max(1, el.children.length);
    const columns = Math.ceil(count / maxRows);
    el.style.gridTemplateRows = `repeat(${Math.ceil(count / columns)}, ${TOOL_SIZE}px)`;
  });
  return (
    <div
      ref={ref}
      className="viewport-gp-hud"
      style={{
        ...HUD_PANEL_STYLE,
        position: "absolute",
        top: COLUMN_TOP,
        left,
        display: "grid",
        gridAutoFlow: "column",
        gap: TOOL_GAP,
        padding: 4,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Options / actions bar along the pane's bottom, centred in the strip right of
 * the corner gizmo. Wraps instead of overflowing when the pane is narrow
 * (e.g. 3D + Camera split).
 */
export function HudBar({ children }: { children: ReactNode }) {
  return (
    <div
      className="viewport-gp-hud"
      style={{
        ...HUD_PANEL_STYLE,
        position: "absolute",
        bottom: 16,
        left: BAR_LEFT,
        right: 12,
        marginLeft: "auto",
        marginRight: "auto",
        width: "max-content",
        maxWidth: `calc(100% - ${BAR_LEFT + 12}px)`,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "5px 12px",
      }}
    >
      {children}
    </div>
  );
}

/** Vertical rule between groups in a `HudBar`. */
export function HudSeparator() {
  return <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />;
}
