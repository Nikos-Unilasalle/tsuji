import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import "./shortcuts-modal.css";

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  category: string;
  items: ShortcutItem[];
}

const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    category: "General & Project",
    items: [
      { keys: ["⌘ / Ctrl", "Z"], description: "Undo last action" },
      { keys: ["⌘ / Ctrl", "⇧ Shift", "Z"], description: "Redo last action" },
      { keys: ["⌘ / Ctrl", "S"], description: "Save Project (.tsuji)" },
      { keys: ["⌘ / Ctrl", "O"], description: "Open Project file" },
      { keys: ["⌘ / Ctrl", "Click / Drag"], description: "Resize Viewport & Canvas Split height" },
    ],
  },
  {
    category: "3D Viewport & Navigation",
    items: [
      { keys: ["Left Drag"], description: "Orbit 3D Camera" },
      { keys: ["Right Drag"], description: "Pan 3D Camera" },
      { keys: ["Mouse Wheel"], description: "Zoom 3D View in / out" },
      { keys: ["X", "Y", "Z"], description: "Snap 3D Camera to orthogonal view (Right, Top, Front)" },
      { keys: ["T", "R", "S"], description: "Gizmo transform mode (Translate / Rotate / Scale)" },
      { keys: ["Shift", "Drag Gizmo"], description: "Snap transform to increments (1 unit / 15°)" },
    ],
  },
  {
    category: "Curve Editing",
    items: [
      { keys: ["Click Node"], description: "Select a Curve node to show its control points in the 3D view" },
      { keys: ["Click Point"], description: "Pick a control point — the gizmo moves it instead of the object" },
      { keys: ["A"], description: "Add a control point after the picked one" },
      { keys: ["D"], description: "Delete the picked control point (minimum of two)" },
      { keys: ["Click Empty"], description: "Drop the picked point, gizmo returns to the object" },
    ],
  },
  {
    category: "Graph Editor & Node Spawning",
    items: [
      { keys: ["Click Canvas"], description: "Set yellow Spawn Cursor position for new nodes" },
      { keys: ["Shift", "A"], description: "Open Node Creation Palette" },
      { keys: ["Right Click"], description: "Open Context Menu / Node Search Palette" },
      { keys: ["⌘ / Ctrl", "Click Wire"], description: "Insert Reroute Dot node on wire" },
      { keys: ["Shift + Drag Node"], description: "Drop node onto wire to auto-insert" },
      { keys: ["⌘ / Ctrl", "D"], description: "Duplicate selected node" },
      { keys: ["⌘ / Ctrl", "C", "/", "V"], description: "Copy / Paste selected nodes" },
      { keys: ["Left Drag"], description: "Pan Graph Canvas" },
      { keys: ["Mouse Wheel"], description: "Zoom Graph Canvas" },
      { keys: ["Delete / Backspace"], description: "Delete selected node or connection wire" },
      { keys: ["Click Node"], description: "Select Node & view parameters in ParamPanel" },
    ],
  },
  {
    category: "Canvases",
    items: [
      { keys: ["1", "…", "6"], description: "Canvas selector, top right of the node editor — click to switch" },
      { keys: ["Go To Canvas node"], description: "Switch canvas from the graph itself, on a trigger (key, beat, condition)" },
    ],
  },
  {
    category: "Timeline & Keyframe Animation",
    items: [
      { keys: ["T"], description: "Toggle Advanced Timeline Drawer (Open / Close)" },
      { keys: ["Space"], description: "Play / Pause timeline playback" },
      {
        keys: ["Esc"],
        description: "Stop playback — the way out when the scene has taken Space for itself",
      },
      { keys: ["←", "→"], description: "Previous / Next frame (Shift + Arrow: 10 frames)" },
      { keys: ["J", "K"], description: "Jump to Previous / Next keyframe" },
      { keys: ["M"], description: "Add or remove Marker on active frame" },
      { keys: ["⌘", "D"], description: "Duplicate selected keyframes" },
      { keys: ["⌘", "C"], description: "Copy selected keyframes" },
      { keys: ["⌘", "V"], description: "Paste keyframes at playhead" },
      { keys: ["Delete"], description: "Delete selected keyframes" },
      { keys: ["Drag Playhead"], description: "Scrub timeline animation frames" },
    ],
  },
  {
    category: "Interactive Playback",
    items: [
      {
        keys: ["While Playing"],
        description:
          "Keys a Keyboard node listens for belong to the scene, not the editor: S walks the character instead of arming the scale gizmo",
      },
      {
        keys: ["Other Keys"],
        description: "Every shortcut the scene does not use keeps working, playing or not",
      },
      { keys: ["Esc"], description: "Stop playback and hand the keys back to the editor" },
    ],
  },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="shortcuts-backdrop" onClick={onClose}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-modal-header">
          <div className="shortcuts-modal-title-group">
            <svg
              className="shortcuts-modal-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
            </svg>
            <div>
              <h2 className="shortcuts-modal-title">Keyboard Shortcuts</h2>
              <p className="shortcuts-modal-subtitle">Quick reference guide for Tsuji</p>
            </div>
          </div>
          <button type="button" className="shortcuts-modal-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="shortcuts-modal-content">
          {SHORTCUT_SECTIONS.map((section) => (
            <div key={section.category} className="shortcuts-section">
              <h3 className="shortcuts-section-title">{section.category}</h3>
              <div className="shortcuts-grid">
                {section.items.map((item, idx) => (
                  <div key={idx} className="shortcuts-row">
                    <div className="shortcuts-keys">
                      {item.keys.map((k, kIdx) => (
                        <React.Fragment key={kIdx}>
                          <kbd className="shortcuts-kbd">{k}</kbd>
                          {kIdx < item.keys.length - 1 && <span className="shortcuts-plus">+</span>}
                        </React.Fragment>
                      ))}
                    </div>
                    <span className="shortcuts-desc">{item.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};
