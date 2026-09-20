import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ThemeColors,
  ThemeDefinition,
  PRESET_THEMES,
  getAllThemes,
  getActiveTheme,
  getCurrentColors,
  setActiveTheme,
  saveCustomTheme,
  deleteCustomTheme,
  exportThemeToJSON,
  importThemeFromJSON,
  applyThemeColors,
} from "../shared/theme/themeStore";
import { extractThemeFromFile } from "../shared/theme/themeFromImage";
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

interface ColorCategory {
  category: string;
  fields: { key: keyof ThemeColors; label: string; desc: string }[];
}

const COLOR_CATEGORIES: ColorCategory[] = [
  {
    category: "Accent & Highlights",
    fields: [
      { key: "accentColor", label: "Accent Color", desc: "Active buttons, space toggles, timeline playhead, slider tracks, resize guides" },
    ],
  },
  {
    category: "3D Viewport",
    fields: [
      { key: "viewportBgTop", label: "3D Background Top", desc: "Top gradient hue of the 3D scene background" },
      { key: "viewportBgBottom", label: "3D Background Bottom", desc: "Bottom gradient hue of the 3D scene background" },
      { key: "viewportGrid", label: "Floor Grid Lines", desc: "Ground grid reference lines on the 3D floor plane" },
    ],
  },
  {
    category: "Application Chrome",
    fields: [
      { key: "chromeBg", label: "Window Background", desc: "Main window background and deep chrome canvas" },
      { key: "chromeSurface", label: "Panels & Bars", desc: "Top bar, floating panels, and timeline drawer" },
      { key: "chromeSurfaceRaised", label: "Raised Surfaces", desc: "Buttons, numerical inputs, and active rows" },
      { key: "chromeBorder", label: "Borders & Lines", desc: "Workspace split dividers and panel borders" },
      { key: "chromeText", label: "Primary Text", desc: "Main UI text, titles, and active labels" },
      { key: "chromeTextMuted", label: "Secondary Text", desc: "Hints, units, and secondary descriptions" },
    ],
  },
  {
    category: "Node Graph Canvas",
    fields: [
      { key: "canvasBg", label: "Graph Background", desc: "Node graph workspace background" },
      { key: "canvasNodeList", label: "Node List (Palette)", desc: "Left sidebar node list background on the canvas" },
      { key: "canvasSceneBg", label: "Scenes Bar Background", desc: "Top-right canvas scenes selector bar background" },
      { key: "canvasSceneActive", label: "Active Scene Slot", desc: "Active scene number slot highlight color" },
      { key: "canvasNode", label: "Node Body", desc: "Node cards background color" },
      { key: "canvasNodeRaised", label: "Node Header", desc: "Node title bars and highlighted headers" },
    ],
  },
];

export const PreferencesModal: React.FC<PreferencesModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<"tablet" | "themes" | "ergonomics">("themes");

  // Themes state
  const [themesList, setThemesList] = useState<ThemeDefinition[]>([]);
  const [activeTheme, setActiveThemeState] = useState<ThemeDefinition>(() => getActiveTheme());
  const [editColors, setEditColors] = useState<ThemeColors>(() => getCurrentColors());
  const [customNameInput, setCustomNameInput] = useState("");
  const [isSavingCustom, setIsSavingCustom] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Image Theme Generator state
  const [imageMode, setImageMode] = useState<"light" | "dark">("dark");
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [imageThumbnail, setImageThumbnail] = useState<string | null>(null);
  const [isExtractingImage, setIsExtractingImage] = useState(false);
  const [imageThemeError, setImageThemeError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

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
    if (isOpen) {
      const all = getAllThemes();
      const current = getActiveTheme();
      const currentColors = getCurrentColors();
      setThemesList(all);
      setActiveThemeState(current);
      setEditColors({ ...currentColors });
      setImportStatus(null);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleSelectTheme = (theme: ThemeDefinition) => {
    setActiveThemeState(theme);
    setEditColors({ ...theme.colors });
    setActiveTheme(theme);
  };

  const handleColorChange = (key: keyof ThemeColors, hex: string) => {
    const updated = { ...editColors, [key]: hex };
    setEditColors(updated);
    applyThemeColors(updated);
  };

  const handleSaveTheme = () => {
    const name = customNameInput.trim() || `Custom Theme ${themesList.length + 1}`;
    const newTheme: ThemeDefinition = {
      id: `custom-${Date.now()}`,
      name,
      isPreset: false,
      colors: { ...editColors },
    };
    const updatedList = saveCustomTheme(newTheme);
    setThemesList(updatedList);
    setActiveThemeState(newTheme);
    setIsSavingCustom(false);
    setCustomNameInput("");
  };

  const handleDeleteTheme = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updatedList = deleteCustomTheme(id);
    setThemesList(updatedList);
    const active = getActiveTheme();
    setActiveThemeState(active);
    setEditColors({ ...getCurrentColors() });
  };

  const handleExportTheme = () => {
    const jsonStr = exportThemeToJSON({
      ...activeTheme,
      colors: editColors,
    });
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeTheme.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.tsuji-theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const imported = importThemeFromJSON(text);
        const updatedList = saveCustomTheme(imported);
        setThemesList(updatedList);
        setActiveThemeState(imported);
        setEditColors({ ...imported.colors });
        setImportStatus(`Theme "${imported.name}" loaded successfully.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to parse theme file.";
        setImportStatus(`Import error: ${msg}`);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleProcessImage = async (file: File, mode: "light" | "dark") => {
    setIsExtractingImage(true);
    setImageThemeError(null);
    try {
      const generated = await extractThemeFromFile(file, mode);
      applyThemeColors(generated.colors);
      setEditColors({ ...generated.colors });
      setActiveThemeState(generated);
      setCustomNameInput(generated.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to generate theme from image.";
      setImageThemeError(msg);
    } finally {
      setIsExtractingImage(false);
    }
  };

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedImageFile(file);

    const reader = new FileReader();
    reader.onload = (ev) => {
      setImageThumbnail(ev.target?.result as string);
    };
    reader.readAsDataURL(file);

    handleProcessImage(file, imageMode);
    e.target.value = "";
  };

  const handleModeToggle = (newMode: "light" | "dark") => {
    setImageMode(newMode);
    if (selectedImageFile) {
      handleProcessImage(selectedImageFile, newMode);
    }
  };

  const handleResetToDefault = () => {
    const defaultTheme = PRESET_THEMES[0];
    setActiveTheme(defaultTheme);
    setActiveThemeState(defaultTheme);
    setEditColors({ ...defaultTheme.colors });
  };

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
      ctx.strokeStyle = editColors.accentColor || "#38bdf8";
      ctx.lineWidth = Math.max(1, p * 12);
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
        {/* Header matching TopBar 38px height */}
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
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            <span className="prefs-title">Preferences</span>
          </div>
          <button type="button" className="prefs-close-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        {/* Minimalist Tabs without emojis */}
        <div className="prefs-tabs">
          <button
            type="button"
            className={`prefs-tab-btn ${activeTab === "themes" ? "active" : ""}`}
            onClick={() => setActiveTab("themes")}
          >
            Themes & Colors
          </button>
          <button
            type="button"
            className={`prefs-tab-btn ${activeTab === "tablet" ? "active" : ""}`}
            onClick={() => setActiveTab("tablet")}
          >
            Tablet & Shortcuts
          </button>
          <button
            type="button"
            className={`prefs-tab-btn ${activeTab === "ergonomics" ? "active" : ""}`}
            onClick={() => setActiveTab("ergonomics")}
          >
            Ergonomics & Stylus
          </button>
        </div>

        <div className="prefs-body">
          {/* THEMES TAB */}
          {activeTab === "themes" && (
            <div className="prefs-themes-container">
              {/* Presets & Custom Themes row */}
              <div className="prefs-section-header">
                <span className="prefs-section-label">Theme Selection</span>
                <div className="prefs-theme-actions">
                  <button
                    type="button"
                    className="prefs-action-btn"
                    onClick={() => setIsSavingCustom(true)}
                    title="Save current palette as a custom theme"
                  >
                    Save As Custom...
                  </button>
                  <button
                    type="button"
                    className="prefs-action-btn"
                    onClick={handleExportTheme}
                    title="Export current theme to JSON"
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    className="prefs-action-btn"
                    onClick={() => fileInputRef.current?.click()}
                    title="Import theme from JSON"
                  >
                    Import JSON
                  </button>
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept=".json"
                    style={{ display: "none" }}
                    onChange={handleImportFile}
                  />
                  <button
                    type="button"
                    className="prefs-action-btn prefs-action-btn-subtle"
                    onClick={handleResetToDefault}
                    title="Reset to default Tsuji Slate"
                  >
                    Reset Default
                  </button>
                </div>
              </div>

              {/* Theme Cards List */}
              <div className="prefs-theme-pills">
                {themesList.map((t) => {
                  const isSelected = activeTheme.id === t.id;
                  return (
                    <div
                      key={t.id}
                      className={`prefs-theme-pill ${isSelected ? "active" : ""}`}
                      onClick={() => handleSelectTheme(t)}
                    >
                      <div className="prefs-theme-pill-preview">
                        <span style={{ backgroundColor: t.colors.chromeBg }} />
                        <span style={{ backgroundColor: t.colors.viewportBgTop || t.colors.chromeSurface }} />
                        <span style={{ backgroundColor: t.colors.accentColor }} />
                      </div>
                      <span className="prefs-theme-pill-name">{t.name}</span>
                      {!t.isPreset && (
                        <button
                          type="button"
                          className="prefs-theme-pill-del"
                          onClick={(e) => handleDeleteTheme(t.id, e)}
                          title="Delete custom theme"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Inline Save Dialog */}
              {isSavingCustom && (
                <div className="prefs-inline-save-card">
                  <span className="prefs-option-hint">Enter a name for your custom theme:</span>
                  <div className="prefs-inline-save-row">
                    <input
                      type="text"
                      className="prefs-text-input"
                      placeholder="My Custom Theme"
                      value={customNameInput}
                      onChange={(e) => setCustomNameInput(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveTheme();
                        if (e.key === "Escape") setIsSavingCustom(false);
                      }}
                    />
                    <button type="button" className="prefs-btn-confirm" onClick={handleSaveTheme}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="prefs-action-btn"
                      onClick={() => setIsSavingCustom(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {importStatus && (
                <div className="prefs-status-banner">
                  {importStatus}
                </div>
              )}

              {/* Image Theme Generator Card */}
              <div className="prefs-image-theme-card">
                <div className="prefs-image-theme-header">
                  <div className="prefs-image-theme-meta">
                    <span className="prefs-section-label">Theme from Image</span>
                    <span className="prefs-option-hint">Extracts a calibrated, high-contrast palette from any photo or artwork</span>
                  </div>
                  <div className="prefs-mode-segmented-control">
                    <button
                      type="button"
                      className={`prefs-mode-segment ${imageMode === "light" ? "active" : ""}`}
                      onClick={() => handleModeToggle("light")}
                    >
                      ☀ Clair
                    </button>
                    <button
                      type="button"
                      className={`prefs-mode-segment ${imageMode === "dark" ? "active" : ""}`}
                      onClick={() => handleModeToggle("dark")}
                    >
                      ☾ Sombre
                    </button>
                  </div>
                </div>

                <div className="prefs-image-theme-dropzone">
                  <input
                    type="file"
                    ref={imageInputRef}
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    style={{ display: "none" }}
                    onChange={handleImageFileChange}
                  />
                  {imageThumbnail ? (
                    <div className="prefs-image-thumb-preview">
                      <img src={imageThumbnail} alt="Source" className="prefs-image-thumb-img" />
                      <div className="prefs-image-thumb-info">
                        <span className="prefs-image-thumb-name">{selectedImageFile?.name || "Image source"}</span>
                        <div className="prefs-image-thumb-swatches">
                          <span style={{ backgroundColor: editColors.chromeBg }} title="Chrome Background" />
                          <span style={{ backgroundColor: editColors.chromeSurface }} title="Panels & Surface" />
                          <span style={{ backgroundColor: editColors.accentColor }} title="Accent Color" />
                          <span style={{ backgroundColor: editColors.canvasNodeList }} title="Node List Palette" />
                          <span style={{ backgroundColor: editColors.canvasSceneActive }} title="Active Scene Slot" />
                          <span style={{ backgroundColor: editColors.viewportBgTop }} title="3D Viewport Top" />
                        </div>
                      </div>
                      <div className="prefs-image-thumb-actions">
                        <button
                          type="button"
                          className="prefs-action-btn"
                          onClick={() => imageInputRef.current?.click()}
                          disabled={isExtractingImage}
                        >
                          Change Image...
                        </button>
                        <button
                          type="button"
                          className="prefs-btn-confirm"
                          onClick={() => setIsSavingCustom(true)}
                          title="Save this generated theme with a custom name"
                        >
                          Save Theme
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="prefs-image-upload-btn"
                      onClick={() => imageInputRef.current?.click()}
                      disabled={isExtractingImage}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                      <span>{isExtractingImage ? "Analyzing Image..." : "Upload Image to Extract Palette (PNG, JPG, WebP)"}</span>
                    </button>
                  )}
                </div>

                {imageThemeError && (
                  <div className="prefs-image-error-banner">
                    {imageThemeError}
                  </div>
                )}
              </div>

              {/* Color Customizer Section */}
              <div className="prefs-section-header" style={{ marginTop: 20 }}>
                <span className="prefs-section-label">Interface Colors</span>
                <span className="prefs-option-hint">Changes apply immediately to the workspace</span>
              </div>

              {COLOR_CATEGORIES.map((cat) => (
                <div key={cat.category} className="prefs-color-category-block">
                  <div className="prefs-category-header">
                    <span className="prefs-category-title">{cat.category}</span>
                  </div>
                  <div className="prefs-color-grid">
                    {cat.fields.map((field) => (
                      <div key={field.key} className="prefs-color-row">
                        <div className="prefs-color-meta">
                          <span className="prefs-color-label">{field.label}</span>
                          <span className="prefs-color-desc">{field.desc}</span>
                        </div>
                        <div className="prefs-color-controls">
                          <div className="prefs-swatch-wrapper">
                            <input
                              type="color"
                              className="prefs-color-picker"
                              value={editColors[field.key] || "#000000"}
                              onChange={(e) => handleColorChange(field.key, e.target.value)}
                            />
                            <span
                              className="prefs-color-swatch"
                              style={{ backgroundColor: editColors[field.key] }}
                            />
                          </div>
                          <input
                            type="text"
                            className="prefs-hex-input"
                            value={editColors[field.key] || ""}
                            onChange={(e) => handleColorChange(field.key, e.target.value)}
                            spellCheck={false}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* TABLET SHORTCUTS TAB */}
          {activeTab === "tablet" && (
            <>
              <div className="prefs-info-note">
                Assign the shortcuts below to your tablet ExpressKeys or stylus barrel buttons in your tablet driver configuration panel.
              </div>

              {TABLET_SHORTCUT_SECTIONS.map((section) => (
                <div key={section.category} className="prefs-shortcut-section">
                  <div className="prefs-section-label">{section.category}</div>
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

          {/* ERGONOMICS TAB */}
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
                    className="prefs-action-btn prefs-action-btn-subtle"
                  >
                    Clear Drawing
                  </button>
                </div>
                <span className="prefs-option-hint">
                  Press with your stylus tip below. The gauge and stroke thickness react in real time.
                </span>

                <div className="prefs-pressure-bar-container">
                  <div
                    className="prefs-pressure-bar-fill"
                    style={{
                      width: `${Math.round(currentPressure * 100)}%`,
                      backgroundColor: editColors.accentColor || "#38bdf8",
                    }}
                  />
                </div>
                <div className="prefs-pressure-value">
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
          <button type="button" className="prefs-btn-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
