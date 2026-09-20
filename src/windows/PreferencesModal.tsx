import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./preferences-modal.css";

interface PreferencesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  description: string;
  recommendedExpressKey?: string;
}

interface ShortcutSection {
  category: string;
  items: ShortcutItem[];
}

const TABLET_SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    category: "General & Playback",
    items: [
      { keys: ["Space"], description: "Play / Pause rendering and simulations", recommendedExpressKey: "Button 1" },
      { keys: ["⌘ / Ctrl", "Z"], description: "Undo last action", recommendedExpressKey: "Button 2" },
      { keys: ["⌘ / Ctrl", "⇧ Shift", "Z"], description: "Redo last undone action", recommendedExpressKey: "Button 3" },
      { keys: ["⌘ / Ctrl", "S"], description: "Save project (.tsuji)" },
      { keys: ["F11"], description: "Toggle Full Screen" },
    ],
  },
  {
    category: "Transform & 3D Gizmo",
    items: [
      { keys: ["T"], description: "Activate Translate Gizmo", recommendedExpressKey: "Button 4" },
      { keys: ["R"], description: "Activate Rotate Gizmo" },
      { keys: ["S"], description: "Activate Scale Gizmo" },
      { keys: ["Shift"], description: "Hold for snapping / increments (1 unit / 15°)", recommendedExpressKey: "Stylus Button" },
    ],
  },
  {
    category: "Navigation & Workspaces",
    items: [
      { keys: ["Click / Drag"], description: "3D Orbit or Direct Timeline Scrub" },
      { keys: ["Right Click"], description: "3D Camera Pan / Graph Context Search" },
      { keys: ["Wheel"], description: "Zoom in / out" },
      { keys: ["X", "Y", "Z"], description: "Orthogonal views: Right, Top, Front" },
    ],
  },
  {
    category: "Animation & Timeline",
    items: [
      { keys: ["T"], description: "Open / Close Timeline Dope Sheet drawer", recommendedExpressKey: "Button 5" },
      { keys: ["←", "→"], description: "Previous Frame / Next Frame" },
      { keys: ["J", "K"], description: "Previous Keyframe / Next Keyframe" },
      { keys: ["M"], description: "Add / Remove marker at playhead" },
      { keys: ["K"], description: "Insert keyframe (hovering over parameter)" },
      { keys: ["Delete"], description: "Delete selected keyframes" },
    ],
  },
  {
    category: "Node Graph Editor (Canvas)",
    items: [
      { keys: ["Shift", "A"], description: "Open node creation palette", recommendedExpressKey: "Button 6" },
      { keys: ["Right Click"], description: "Quick node search at cursor" },
      { keys: ["⌘ / Ctrl", "D"], description: "Duplicate selected node" },
      { keys: ["Delete / Backspace"], description: "Delete selected node or wire" },
    ],
  },
];

export const PreferencesModal: React.FC<PreferencesModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<"tablet" | "ergonomics">("tablet");

  // Ergonomics state loaded from localStorage
  const [tabletMode, setTabletMode] = useState(() => {
    return localStorage.getItem("tsuji_pref_tablet_mode") !== "false";
  });
  const [paramPanelPinned, setParamPanelPinned] = useState(() => {
    return localStorage.getItem("tsuji_pref_panel_pinned") === "true";
  });

  // Stylus pressure testing
  const [currentPressure, setCurrentPressure] = useState(0);
  const testCanvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleToggleTabletMode = (checked: boolean) => {
    setTabletMode(checked);
    localStorage.setItem("tsuji_pref_tablet_mode", checked ? "true" : "false");
  };

  const handleToggleParamPinned = (checked: boolean) => {
    setParamPanelPinned(checked);
    localStorage.setItem("tsuji_pref_panel_pinned", checked ? "true" : "false");
  };

  // Canvas drawing test for stylus pressure
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = testCanvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    const rect = canvas.getBoundingClientRect();
    lastPointRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const p = e.pressure > 0 ? e.pressure : 0.5;
    setCurrentPressure(p);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const canvas = testCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const p = e.pressure > 0 ? e.pressure : 0.5;
    setCurrentPressure(p);

    if (lastPointRef.current) {
      ctx.beginPath();
      ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
      ctx.lineTo(curX, curY);
      ctx.strokeStyle = `rgba(56, 189, 248, ${Math.max(0.2, p)})`;
      ctx.lineWidth = Math.max(1, p * 16);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    lastPointRef.current = { x: curX, y: curY };
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = testCanvasRef.current;
    if (canvas) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}
    }
    isDrawingRef.current = false;
    lastPointRef.current = null;
    setCurrentPressure(0);
  };

  const clearTestCanvas = () => {
    const canvas = testCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="prefs-header">
          <div className="prefs-title-group">
            <svg
              className="prefs-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="prefs-title">Preferences & Tablet Setup</span>
          </div>
          <button type="button" className="prefs-close-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="prefs-tabs">
          <button
            type="button"
            className={`prefs-tab-btn ${activeTab === "tablet" ? "active" : ""}`}
            onClick={() => setActiveTab("tablet")}
          >
            ⌨️ Physical Buttons (ExpressKeys)
          </button>
          <button
            type="button"
            className={`prefs-tab-btn ${activeTab === "ergonomics" ? "active" : ""}`}
            onClick={() => setActiveTab("ergonomics")}
          >
            🖊️ Ergonomics & Pressure Test
          </button>
        </div>

        <div className="prefs-body">
          {activeTab === "tablet" && (
            <>
              <div className="prefs-intro-banner">
                💡 <strong>Mapping Physical Buttons:</strong> In your tablet driver control panel
                (XP-Pen, Huion, Wacom), assign the shortcuts below to your tablet's <strong>ExpressKeys</strong> or
                stylus barrel buttons for instant, seamless control.
              </div>

              {TABLET_SHORTCUT_SECTIONS.map((section) => (
                <div key={section.category}>
                  <div className="prefs-section-title">{section.category}</div>
                  <div className="prefs-shortcut-grid">
                    {section.items.map((item, idx) => (
                      <div className="prefs-shortcut-card" key={idx}>
                        <div className="prefs-shortcut-desc">{item.description}</div>
                        <div className="prefs-keys-group">
                          {item.keys.map((k, kIdx) => (
                            <span className="prefs-key-badge" key={kIdx}>
                              {k}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

          {activeTab === "ergonomics" && (
            <>
              <div className="prefs-option-row">
                <div className="prefs-option-info">
                  <span className="prefs-option-label">Pen Display & Tablet Mode</span>
                  <span className="prefs-option-hint">
                    Enlarges invisible node socket hit areas (28px) and adapts click thresholds for stylus taps.
                  </span>
                </div>
                <label className="prefs-toggle-switch">
                  <input
                    type="checkbox"
                    checked={tabletMode}
                    onChange={(e) => handleToggleTabletMode(e.target.checked)}
                  />
                  <span className="prefs-toggle-slider" />
                </label>
              </div>

              <div className="prefs-option-row">
                <div className="prefs-option-info">
                  <span className="prefs-option-label">Persistent Parameters Panel</span>
                  <span className="prefs-option-hint">
                    Keeps the parameters panel pinned to prevent it from closing when hovering away with a stylus.
                  </span>
                </div>
                <label className="prefs-toggle-switch">
                  <input
                    type="checkbox"
                    checked={paramPanelPinned}
                    onChange={(e) => handleToggleParamPinned(e.target.checked)}
                  />
                  <span className="prefs-toggle-slider" />
                </label>
              </div>

              {/* Hardware stylus live pressure test */}
              <div className="prefs-pressure-testpad">
                <div className="prefs-pressure-header">
                  <span className="prefs-option-label">Hardware Stylus Pressure Test</span>
                  <button
                    type="button"
                    onClick={clearTestCanvas}
                    style={{
                      background: "transparent",
                      border: "1px solid #334155",
                      color: "#94a3b8",
                      borderRadius: 4,
                      padding: "2px 8px",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    Clear Drawing
                  </button>
                </div>
                <span className="prefs-option-hint">
                  Press with your stylus tip below. The gauge and stroke thickness react in real time.
                </span>

                <div className="prefs-pressure-bar-container">
                  <div className="prefs-pressure-bar-fill" style={{ width: `${Math.round(currentPressure * 100)}%` }} />
                </div>
                <div style={{ fontSize: 11, color: "#38bdf8", textAlign: "right" }}>
                  Pressure: {Math.round(currentPressure * 100)}%
                </div>

                <canvas
                  ref={testCanvasRef}
                  width={700}
                  height={120}
                  className="prefs-test-canvas"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                />
              </div>
            </>
          )}
        </div>

        <div className="prefs-footer">
          <button type="button" className="prefs-btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
