import { useState } from "react";
import "./quick-add-toolbar.css";

interface QuickAddItem {
  type: string;
  label: string;
  icon: React.ReactNode;
}

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/**
 * The node types a new graph almost always starts with — one click each,
 * instead of hunting through the full category tree in NodePalette. That
 * tree is still the complete reference; this is just the well-worn path to
 * it shortcut.
 */
const QUICK_ADD_ITEMS: QuickAddItem[] = [
  {
    type: "object/box",
    label: "Cube",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M12 2 3 7v10l9 5 9-5V7z" />
        <path d="M3 7l9 5 9-5M12 12v10" />
      </svg>
    ),
  },
  {
    type: "object/sphere",
    label: "Sphere",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="9" ry="3.5" />
      </svg>
    ),
  },
  {
    type: "object/obj",
    label: "OBJ Model",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <text x="8" y="18" fontSize="7" stroke="none" fill="currentColor">
          3D
        </text>
      </svg>
    ),
  },
  {
    type: "curve/primitive",
    label: "Curve",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M3 18c4-1 4-13 9-13s3 12 9 13" />
      </svg>
    ),
  },
  {
    type: "light/point",
    label: "Point Light",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
      </svg>
    ),
  },
  {
    type: "calibration/camera",
    label: "Camera",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M23 7l-7 5 7 5V7z" />
        <rect x="1" y="5" width="15" height="14" rx="2" />
      </svg>
    ),
  },
  {
    type: "transform",
    label: "Compose Matrix",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M8 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h3M16 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3" />
      </svg>
    ),
  },
  {
    type: "vector/compose",
    label: "Compose Vector",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="12" r="2.5" />
        <path d="M8.2 7.2 15.8 11M8.2 16.8 15.8 13" />
      </svg>
    ),
  },
  {
    type: "lighting/environment",
    label: "Environment",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
      </svg>
    ),
  },
  {
    type: "utility/frame",
    label: "Frame",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="18" height="16" rx="2" strokeDasharray="3 2" />
        <path d="M3 9h18" />
      </svg>
    ),
  },
  {
    type: "render",
    label: "Render",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
  },
];

interface QuickAddToolbarProps {
  onAddNode: (type: string) => void;
  onOpenSearch?: () => void;
}

export function QuickAddToolbar({ onAddNode, onOpenSearch }: QuickAddToolbarProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <button
        type="button"
        className="quick-add-collapsed"
        onClick={() => setCollapsed(false)}
        title="Show the quick-add toolbar"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    );
  }

  return (
    <div className="quick-add-toolbar">
      {QUICK_ADD_ITEMS.map((item) => (
        <button
          key={item.type}
          type="button"
          className="quick-add-button"
          onClick={() => onAddNode(item.type)}
          title={`Add ${item.label}`}
        >
          {item.icon}
        </button>
      ))}
      <button
        type="button"
        className="quick-add-button"
        onClick={onOpenSearch}
        title="Search nodes (Cmd+Space)"
      >
        <svg {...ICON_PROPS}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      <div className="quick-add-divider" />
      <button
        type="button"
        className="quick-add-button quick-add-hide"
        onClick={() => setCollapsed(true)}
        title="Hide this toolbar"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}
