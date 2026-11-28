import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CATEGORY_COLOR,
  CATEGORY_FAMILY,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  FAMILY_COLOR,
  FAMILY_LABEL,
  FAMILY_ORDER,
  NodeCategory,
} from "../shared/graph/categories";
import { nodeMatchScore, nodeMatches } from "../shared/graph/nodes/nodeKeywords";
import { NodeDefinition } from "../shared/graph/types";
import "./node-palette.css";

interface NodePaletteProps {
  nodes: NodeDefinition[];
  /** Adds the node where the graph's spawn cursor is. */
  onAddNode: (type: string) => void;
  /** Adds the node under a screen point if that point is on the canvas; false when it is not. */
  onDropNode?: (type: string, clientX: number, clientY: number) => boolean;
}

const OPEN_KEY = "tsuji_palette_open";
const COLLAPSED_KEY = "tsuji_palette_collapsed";
const RECENT_KEY = "tsuji_palette_recent";
const RECENT_MAX = 8;
/** Pixels the pointer travels before a press on a node becomes a drag. */
const DRAG_THRESHOLD = 5;

function readList(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Private mode / quota: the palette just forgets.
  }
}

interface DragState {
  type: string;
  label: string;
  color: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
}

/**
 * The node list beside the graph.
 *
 * Families (Geometry, Scene…) in workflow order, then their categories and
 * nodes alphabetically. A filter at the top matches labels, type ids,
 * category names and synonyms (nodeKeywords.ts) and shows every hit at once;
 * ↑/↓ and Enter pick from it without the mouse. A node is added by a click
 * (at the spawn cursor) or dragged onto the canvas (where it is dropped).
 * Open categories and recently added nodes are remembered between sessions.
 *
 * Memoized: it re-rendered with every edit to the graph beside it, and has
 * nothing to do with any of them.
 */
export const NodePalette = memo(function NodePalette({ nodes, onAddNode, onDropNode }: NodePaletteProps) {
  const [query, setQuery] = useState("");
  // Tucked away: the palette shrinks to a thin rail and the canvas takes the room.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const setCollapsedSaved = (value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(COLLAPSED_KEY, String(value));
    } catch {
      // Private mode: the palette just forgets.
    }
  };
  const [open, setOpen] = useState<Set<string>>(() => new Set(readList(OPEN_KEY)));
  const [recent, setRecent] = useState<string[]>(() => readList(RECENT_KEY));
  const [highlight, setHighlight] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const byType = useMemo(() => new Map(nodes.map((def) => [def.type, def])), [nodes]);

  const grouped = useMemo(() => {
    const map = new Map<NodeCategory, NodeDefinition[]>();
    for (const category of CATEGORY_ORDER) map.set(category, []);
    for (const def of nodes) map.get(def.category)?.push(def);
    for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    return map;
  }, [nodes]);

  const searching = query.trim().length > 0;
  const matches = useMemo(() => {
    if (!searching) return [] as NodeDefinition[];
    return CATEGORY_ORDER.flatMap((category) =>
      (grouped.get(category) ?? []).filter((def) => nodeMatches(def, query, CATEGORY_LABEL[category])),
    )
      .map((def, i) => ({ def, i, score: nodeMatchScore(def, query) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((r) => r.def);
  }, [grouped, query, searching]);

  useEffect(() => setHighlight(0), [query]);
  useEffect(() => writeList(OPEN_KEY, [...open]), [open]);

  const remember = useCallback((type: string) => {
    setRecent((prev) => {
      const next = [type, ...prev.filter((t) => t !== type)].slice(0, RECENT_MAX);
      writeList(RECENT_KEY, next);
      return next;
    });
  }, []);

  const add = useCallback(
    (type: string) => {
      onAddNode(type);
      remember(type);
    },
    [onAddNode, remember],
  );

  const toggle = (category: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

  const allOpen = CATEGORY_ORDER.every((c) => (grouped.get(c)?.length ?? 0) === 0 || open.has(c));
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(CATEGORY_ORDER.filter((c) => (grouped.get(c)?.length ?? 0) > 0)));

  // Keep the highlighted search hit in view while stepping through with the arrows.
  useEffect(() => {
    if (!searching) return;
    listRef.current?.querySelector<HTMLElement>(".palette-node.is-highlighted")?.scrollIntoView({ block: "nearest" });
  }, [highlight, searching]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (query) setQuery("");
      else searchRef.current?.blur();
      e.preventDefault();
    } else if (e.key === "ArrowDown" && matches.length > 0) {
      setHighlight((h) => (h + 1) % matches.length);
      e.preventDefault();
    } else if (e.key === "ArrowUp" && matches.length > 0) {
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
      e.preventDefault();
    } else if (e.key === "Enter" && matches[highlight]) {
      add(matches[highlight].type);
      e.preventDefault();
    }
  };

  // ---- dragging a node onto the canvas (pointer events: HTML5 drag-and-drop
  // is unreliable in the desktop webview, which claims drops for files).
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const onNodePointerDown = (def: NodeDefinition, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setDrag({
      type: def.type,
      label: def.label,
      color: CATEGORY_COLOR[def.category],
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
    });
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const active = d.active || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD;
      setDrag({ ...d, x: e.clientX, y: e.clientY, active });
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (!d.active) {
        add(d.type);
        return;
      }
      if (onDropNode?.(d.type, e.clientX, e.clientY)) remember(d.type);
    };
    const cancel = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    // Re-bound only when a drag starts or ends, not on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, add, remember, onDropNode]);

  const nodeButton = (def: NodeDefinition, options: { highlighted?: boolean; showCategory?: boolean } = {}) => {
    const color = CATEGORY_COLOR[def.category];
    return (
      <button
        key={def.type}
        type="button"
        className={`palette-node${options.highlighted ? " is-highlighted" : ""}`}
        style={{ "--node-color": color } as React.CSSProperties}
        onPointerDown={(e) => onNodePointerDown(def, e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            add(def.type);
            e.preventDefault();
          }
        }}
      >
        <span className="palette-node-dot" />
        <span className="palette-node-label">{def.label}</span>
        {options.showCategory && <span className="palette-node-category">{CATEGORY_LABEL[def.category]}</span>}
      </button>
    );
  };

  const recentDefs = recent.map((t) => byType.get(t)).filter((d): d is NodeDefinition => Boolean(d));

  if (collapsed) {
    return (
      <aside className="node-palette is-collapsed" aria-label="Nodes">
        <button type="button" className="palette-rail" onClick={() => setCollapsedSaved(false)} title="Show the node list">
          <svg className="palette-collapse-icon" viewBox="0 0 16 16" aria-hidden="true">
            <polyline points="6,4 10,8 6,12" />
          </svg>
          <span className="palette-rail-label">Nodes</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="node-palette" aria-label="Nodes">
      <div className="palette-header">
        <div className="palette-search">
          <svg className="palette-search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <line x1="10.4" y1="10.4" x2="14" y2="14" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            placeholder="Search nodes"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            aria-label="Search nodes"
          />
          {query && (
            <button type="button" className="palette-search-clear" onClick={() => setQuery("")} title="Clear search">
              ×
            </button>
          )}
          <button type="button" className="palette-collapse" onClick={() => setCollapsedSaved(true)} title="Hide the node list">
            <svg className="palette-collapse-icon" viewBox="0 0 16 16" aria-hidden="true">
              <polyline points="10,4 6,8 10,12" />
            </svg>
          </button>
        </div>
        {!searching && (
          <div className="palette-toolbar">
            <span className="palette-count">{nodes.length} nodes</span>
            <button type="button" className="palette-toolbar-button" onClick={toggleAll}>
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}
      </div>

      <div className="palette-list" ref={listRef}>
        {searching ? (
          matches.length === 0 ? (
            <div className="palette-empty">No node matches “{query.trim()}”</div>
          ) : (
            <div className="palette-results">
              <div className="palette-results-count">
                {matches.length} {matches.length === 1 ? "match" : "matches"} · ↑↓ Enter
              </div>
              {matches.map((def, i) => nodeButton(def, { highlighted: i === highlight, showCategory: true }))}
            </div>
          )
        ) : (
          <>
            {recentDefs.length > 0 && (
              <section className="palette-family">
                <h3 className="palette-family-title" style={{ "--family-color": "var(--canvas-text-muted)" } as React.CSSProperties}>
                  Recent
                </h3>
                <div className="palette-recent">{recentDefs.map((def) => nodeButton(def))}</div>
              </section>
            )}
            {FAMILY_ORDER.map((family) => {
              const categories = CATEGORY_ORDER.filter((c) => CATEGORY_FAMILY[c] === family && (grouped.get(c)?.length ?? 0) > 0);
              if (categories.length === 0) return null;
              return (
                <section className="palette-family" key={family}>
                  <h3 className="palette-family-title" style={{ "--family-color": FAMILY_COLOR[family] } as React.CSSProperties}>
                    {FAMILY_LABEL[family]}
                  </h3>
                  {categories.map((category) => {
                    const list = grouped.get(category)!;
                    const isOpen = open.has(category);
                    return (
                      <div
                        className={`palette-category${isOpen ? " is-open" : ""}`}
                        key={category}
                        style={{ "--cat-color": CATEGORY_COLOR[category] } as React.CSSProperties}
                      >
                        <button
                          type="button"
                          className="palette-category-title"
                          onClick={() => toggle(category)}
                          aria-expanded={isOpen}
                        >
                          <span className="palette-category-swatch" />
                          <span className="palette-category-label">{CATEGORY_LABEL[category]}</span>
                          <span className="palette-category-count">{list.length}</span>
                          <svg className="palette-category-chevron" viewBox="0 0 10 10" aria-hidden="true">
                            <polyline points="3,2 7,5 3,8" />
                          </svg>
                        </button>
                        {isOpen && <div className="palette-category-nodes">{list.map((def) => nodeButton(def))}</div>}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </>
        )}
      </div>

      {drag?.active && (
        <div className="palette-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 8, "--node-color": drag.color } as React.CSSProperties}>
          <span className="palette-node-dot" />
          {drag.label}
        </div>
      )}
    </aside>
  );
});
