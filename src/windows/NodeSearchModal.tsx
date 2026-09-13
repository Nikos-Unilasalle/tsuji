import React, { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_COLOR, CATEGORY_LABEL } from "../shared/graph/categories";
import { GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE, GROUP_TYPE } from "../shared/graph/groups";
import { NodeRegistry } from "../shared/graph/types";
import "./node-search-modal.css";

interface NodeSearchModalProps {
  registry: NodeRegistry;
  onSelectNodeType: (type: string) => void;
  onClose: () => void;
}

/**
 * Quick Add Node Search Dialog triggered by Space key.
 * Features real-time filtering, category badges, keyboard arrow navigation, and instant placement.
 */
export function NodeSearchModal({ registry, onSelectNodeType, onClose }: NodeSearchModalProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);

  const availableNodes = useMemo(() => {
    // A group and its boundary nodes are made by Cmd+G, never placed by hand
    // — one dropped from here would have no interior and no ports.
    return Array.from(registry.values()).filter(
      (def) => def.type !== GROUP_TYPE && def.type !== GROUP_INPUT_TYPE && def.type !== GROUP_OUTPUT_TYPE,
    );
  }, [registry]);

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return availableNodes;
    return availableNodes.filter(
      (node) =>
        node.label.toLowerCase().includes(q) ||
        node.type.toLowerCase().includes(q) ||
        (CATEGORY_LABEL[node.category] ?? node.category).toLowerCase().includes(q)
    );
  }, [availableNodes, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the keyboard selection visible: when arrow navigation moves past the
  // list's viewport, scroll the selected item into view.
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, filteredNodes.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredNodes.length > 0 ? (prev + 1) % filteredNodes.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredNodes.length > 0 ? (prev - 1 + filteredNodes.length) % filteredNodes.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredNodes[selectedIndex]) {
        onSelectNodeType(filteredNodes[selectedIndex].type);
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="node-search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="node-search-modal" onKeyDown={handleKeyDown}>
        <div className="node-search-header">
          <svg className="node-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="node-search-input"
            placeholder="Search node (Space / Enter to add)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="node-search-list">
          {filteredNodes.length === 0 ? (
            <div className="node-search-empty">No nodes matching "{query}"</div>
          ) : (
            filteredNodes.map((nodeDef, index) => {
              const categoryColor = CATEGORY_COLOR[nodeDef.category] ?? "#38bdf8";
              const categoryLabel = CATEGORY_LABEL[nodeDef.category] ?? nodeDef.category;
              const isSelected = index === selectedIndex;

              return (
                <div
                  key={nodeDef.type}
                  ref={isSelected ? selectedItemRef : undefined}
                  className={`node-search-item ${isSelected ? "active" : ""}`}
                  onClick={() => {
                    onSelectNodeType(nodeDef.type);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="node-search-item-info">
                    <span className="node-search-item-label">{nodeDef.label}</span>
                    <span className="node-search-item-type">{nodeDef.type}</span>
                  </div>
                  <span
                    className="node-search-badge"
                    style={{ backgroundColor: categoryColor }}
                  >
                    {categoryLabel}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
