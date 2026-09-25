import React, { useEffect, useRef, useState } from "react";
import "./share-menu.css";

export interface ShareMenuProps {
  isOutputOpen: boolean;
  onToggleOutput: () => void;
  /** Only shown when the graph has a `view2d` node — nothing for that window to display otherwise. */
  hasView2DNode?: boolean;
  isView2DOpen?: boolean;
  onToggleView2D?: () => void;
  /** Absent hides the row entirely — e.g. no Render node to read frame count/fps from. */
  onExportVideo?: () => void;
  onExportSequence?: () => void;
  isExporting?: boolean;
  exportMode?: "video" | "sequence" | null;
  /** 0-1. */
  exportProgress?: number;
}

/**
 * The ways a graph leaves the app — the projector window, video file,
 * or image sequence — behind one button.
 *
 * They sat in the toolbar as peers of Timeline and Shortcuts, which put two
 * end-of-session actions in the middle of a row otherwise made of things you
 * touch constantly. Grouping them also gives Export somewhere to live
 * when there is no Render node: the row disappears instead of the whole
 * toolbar reflowing.
 */
export const ShareMenu: React.FC<ShareMenuProps> = ({
  isOutputOpen,
  onToggleOutput,
  hasView2DNode = false,
  isView2DOpen = false,
  onToggleView2D,
  onExportVideo,
  onExportSequence,
  isExporting = false,
  exportMode = null,
  exportProgress = 0,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const toggleOpen = () => {
    if (!isOpen && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setPanelPos({
        top: rect.bottom + 6,
        right: Math.max(12, window.innerWidth - rect.right),
      });
    }
    setIsOpen((v) => !v);
  };

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: MouseEvent | PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    const onScrollOrResize = () => setIsOpen(false);

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [isOpen]);

  return (
    <div className="share-menu-root" ref={rootRef}>
      <button
        className={`top-bar-button top-bar-button-share${isOpen || isOutputOpen ? " top-bar-button-output-active" : ""}`}
        onClick={toggleOpen}
        title="Fullscreen output and export"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.6" y1="10.5" x2="15.4" y2="6.5" />
          <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
        </svg>
        {isExporting ? `Export… ${Math.round(exportProgress * 100)}%` : "Share"}
      </button>

      {isOpen && (
        <div
          className="share-menu-panel"
          style={panelPos ? { top: panelPos.top, right: panelPos.right } : { top: 44, right: 12 }}
        >
          <button
            type="button"
            className={`share-menu-item${isOutputOpen ? " is-active" : ""}`}
            onClick={() => {
              onToggleOutput();
              setIsOpen(false);
            }}
          >
            <span className="share-menu-item-label">{isOutputOpen ? "Close Output" : "Output"}</span>
            <span className="share-menu-item-desc">
              {isOutputOpen ? "Closes the external output window." : "Fullscreen projection on external monitor or projector."}
            </span>
          </button>

          {hasView2DNode && onToggleView2D && (
            <button
              type="button"
              className={`share-menu-item${isView2DOpen ? " is-active" : ""}`}
              onClick={() => {
                onToggleView2D();
                setIsOpen(false);
              }}
            >
              <span className="share-menu-item-label">{isView2DOpen ? "Close 2D View" : "2D View"}</span>
              <span className="share-menu-item-desc">
                {isView2DOpen ? "Closes the 2D View window." : "Preview a view2d node's texture in its own window."}
              </span>
            </button>
          )}

          {onExportVideo && (
            <button
              type="button"
              className="share-menu-item"
              disabled={isExporting}
              onClick={() => {
                onExportVideo();
                setIsOpen(false);
              }}
            >
              <span className="share-menu-item-label">
                {isExporting && exportMode === "video" ? `Exporting Video… ${Math.round(exportProgress * 100)}%` : "Export Video"}
              </span>
              <span className="share-menu-item-desc">
                Render the timeline frame-by-frame (MP4, fallback to WebM).
              </span>
            </button>
          )}

          {onExportSequence && (
            <button
              type="button"
              className="share-menu-item"
              disabled={isExporting}
              onClick={() => {
                onExportSequence();
                setIsOpen(false);
              }}
            >
              <span className="share-menu-item-label">
                {isExporting && exportMode === "sequence" ? `Exporting Sequence… ${Math.round(exportProgress * 100)}%` : "Export PNG Sequence"}
              </span>
              <span className="share-menu-item-desc">
                Lossless frame-by-frame PNG sequence packaged as a ZIP.
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
