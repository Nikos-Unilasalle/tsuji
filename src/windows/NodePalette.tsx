import { memo, useState } from "react";
import { CATEGORY_COLOR, CATEGORY_LABEL, CATEGORY_ORDER } from "../shared/graph/categories";
import { NodeDefinition } from "../shared/graph/types";
import "./node-palette.css";

interface NodePaletteProps {
  nodes: NodeDefinition[];
  onAddNode: (type: string) => void;
}

/** Grouped by category, in BIBLE.md's catalog order; a category with nothing registered in it yet just doesn't render a section. Every category starts collapsed — click a header to expand it. */
/** Memoized: it re-rendered with every edit to the graph beside it, and has nothing to do with any of them. */
export const NodePalette = memo(function NodePalette({ nodes, onAddNode }: NodePaletteProps) {
  const [openCategories, setOpenCategories] = useState<Set<string>>(() => new Set());

  const toggleCategory = (category: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  return (
    <div className="node-palette">
      {CATEGORY_ORDER.map((category) => {
        const inCategory = nodes
          .filter((def) => def.category === category)
          .sort((a, b) => a.label.localeCompare(b.label));
        if (inCategory.length === 0) return null;
        const color = CATEGORY_COLOR[category];
        const isOpen = openCategories.has(category);
        return (
          <div className="palette-category" key={category}>
            <button
              type="button"
              className="palette-category-title"
              style={{ color }}
              onClick={() => toggleCategory(category)}
              title={isOpen ? "Collapse category" : "Expand category"}
            >
              <span className="palette-category-chevron">{isOpen ? "▾" : "▸"}</span>
              {CATEGORY_LABEL[category]}
            </button>
            {isOpen &&
              inCategory.map((def) => (
                <button
                  key={def.type}
                  type="button"
                  className="palette-node-button"
                  style={{ borderLeftColor: color }}
                  onClick={() => onAddNode(def.type)}
                >
                  {def.label}
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
});
