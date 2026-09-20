import React, { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_CATALOG, DemoEntry } from "../shared/demos";
import { deserializeProject } from "../shared/graph/storage";
import { Project } from "../shared/graph/types";
import "./demos-menu.css";

export interface DemosMenuProps {
  onLoadDemo: (project: Project, filename: string) => void;
  onError: (message: string) => void;
}

function matches(demo: DemoEntry, category: string, query: string): boolean {
  const haystack = `${demo.label} ${demo.description} ${category}`.toLowerCase();
  return query.split(/\s+/).every((term) => haystack.includes(term));
}

/**
 * Anchored dropdown, not a full-screen popover — a demo list is read top to
 * bottom and picked once, unlike EasingPopover's positioned editor, so it
 * doesn't need x/y placement math, just to hang off its own trigger button.
 *
 * Categories collapse because the catalog outgrew a plain list: fully
 * expanded it is ~2700px of content in a ~520px panel, so five sixths of the
 * demos sat below the fold with nothing to navigate by. Collapsed, all
 * fourteen headings fit at once and the panel becomes a table of contents;
 * the filter box is the shortcut for when you already know the name.
 */
export const DemosMenu: React.FC<DemosMenuProps> = ({ onLoadDemo, onError }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const toggleOpen = () => {
    if (!isOpen && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setPanelPos({
        top: rect.bottom + 6,
        left: Math.max(12, rect.left),
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

  // Reopening should feel like opening, not like resuming someone else's scroll.
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setOpenCategory(null);
    }
  }, [isOpen]);

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      DEMO_CATALOG.map((category) => ({
        ...category,
        demos: trimmed ? category.demos.filter((d) => matches(d, category.title, trimmed)) : category.demos,
      })).filter((category) => category.demos.length > 0),
    [trimmed],
  );

  const total = filtered.reduce((n, c) => n + c.demos.length, 0);

  const handlePick = async (file: string) => {
    setLoadingFile(file);
    try {
      const res = await fetch(`/demos/${file}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = await res.text();
      const project = deserializeProject(text);
      onLoadDemo(project, file);
      setIsOpen(false);
    } catch (err: unknown) {
      const error = err as Error;
      onError(`Demo error: ${error.message}`);
    } finally {
      setLoadingFile(null);
    }
  };

  return (
    <div className="demos-menu-root" ref={rootRef}>
      <button
        className={`top-bar-button top-bar-button-demos top-bar-button-icon-only${isOpen ? " top-bar-button-output-active" : ""}`}
        onClick={toggleOpen}
        title="Browse Demos"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      </button>

      {isOpen && (
        <div
          className="demos-menu-panel"
          style={panelPos ? { top: panelPos.top, left: panelPos.left } : { top: 44, left: 12 }}
        >
          <input
            className="demos-menu-search"
            autoFocus
            value={query}
            placeholder="Filter demos…"
            onChange={(e) => setQuery(e.target.value)}
          />

          {filtered.length === 0 && <div className="demos-menu-empty">No demos found for "{query}"</div>}

          {filtered.map((category) => {
            // A search already narrows things down — keep every hit visible
            // rather than making the reader open each category to find it.
            const expanded = trimmed !== "" || openCategory === category.title;
            return (
              <div className="demos-menu-category" key={category.title}>
                <button
                  type="button"
                  className={`demos-menu-category-title${expanded ? " is-open" : ""}`}
                  onClick={() => setOpenCategory(expanded && !trimmed ? null : category.title)}
                >
                  <span className="demos-menu-caret">{expanded ? "▾" : "▸"}</span>
                  {category.title}
                  <span className="demos-menu-count">{category.demos.length}</span>
                </button>

                {expanded &&
                  category.demos.map((demo) => (
                    <button
                      key={demo.file}
                      type="button"
                      className="demos-menu-item"
                      disabled={loadingFile !== null}
                      onClick={() => handlePick(demo.file)}
                      title={demo.description}
                    >
                      <span className="demos-menu-item-label">{demo.label}</span>
                      <span className="demos-menu-item-desc">{demo.description}</span>
                      {loadingFile === demo.file && <span className="demos-menu-item-loading">…</span>}
                    </button>
                  ))}
              </div>
            );
          })}

          <div className="demos-menu-footer">{total} demos</div>
        </div>
      )}
    </div>
  );
};
