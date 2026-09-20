import React, { useEffect, useRef, useState } from "react";
import {
  ensureOvmExtension,
  openProjectWithFilePicker,
  saveProjectAsWithFilePicker,
  saveProjectToPath,
} from "../shared/graph/storage";
import { Project } from "../shared/graph/types";
import {
  closeOutputWindow,
  listMonitors,
  onOutputClosed,
  openOutputWindow,
  toggleFullscreen,
  watchFullscreen,
} from "../shared/ipc";
import logoUrl from "../assets/logo.png";
import { ShortcutsModal } from "./ShortcutsModal";
import { DemosMenu } from "./DemosMenu";
import { ShareMenu } from "./ShareMenu";
import { DownloadMenu } from "./DownloadMenu";
import { PreferencesModal } from "./PreferencesModal";
import { createStarterProject } from "../shared/graph/starterGraph";
import "./top-bar.css";

export interface TopBarProps {
  /** The whole document — every canvas, not just the one on screen: saving writes them all. */
  project: Project;
  onLoadProject: (project: Project, filename?: string) => void;
  /** Fired after a Save/Save As/Incremental Save actually wrote a file — clears the unsaved-changes guard in App. */
  onProjectSaved?: () => void;
  currentFilename: string;
  currentFilePath: string | null;
  onFilenameChange: (name: string, path: string | null) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Absent hides the button entirely — e.g. no Render node to read frame count/fps from. */
  onExportVideo?: () => void;
  onExportSequence?: () => void;
  isExporting?: boolean;
  exportMode?: "video" | "sequence" | null;
  /** 0-1. */
  exportProgress?: number;
  isTimelineOpen?: boolean;
  onToggleTimeline?: () => void;
  is2DMode?: boolean;
  onToggle2DMode?: () => void;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  /** Discards every simulation's accumulated state and returns to frame 0. */
  onResetSimulations?: () => void;
  /** Workspace space toggles (3D View, Camera, Canvas, Timeline) */
  spaces?: { view3D: boolean; camera: boolean; canvas: boolean; timeline?: boolean };
  onToggleSpace?: (space: "view3D" | "camera" | "canvas" | "timeline") => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  project,
  onLoadProject,
  onProjectSaved,
  currentFilename,
  currentFilePath,
  onFilenameChange,
  onUndo,
  onRedo,
  onExportVideo,
  onExportSequence,
  isExporting = false,
  exportMode = null,
  exportProgress = 0,
  isTimelineOpen: _isTimelineOpen = false,
  onToggleTimeline: _onToggleTimeline,
  is2DMode = false,
  onToggle2DMode,
  isPlaying = false,
  onTogglePlay,
  onResetSimulations,
  spaces,
  onToggleSpace,
}) => {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastError, setToastError] = useState(false);
  const [isEditingFilename, setIsEditingFilename] = useState(false);
  const [filenameInput, setFilenameInput] = useState(currentFilename);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Owned so a second toast doesn't get cut short by the first's leftover
  // timer, and cleared on unmount to avoid a setState on a dead component.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, error = false) => {
    setToastMessage(msg);
    setToastError(error);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      setToastMessage(null);
      setToastError(false);
      toastTimer.current = null;
    }, 3500);
  };

  useEffect(() => () => clearTimeout(toastTimer.current ?? undefined), []);

  // Tracks the OS-level close (red X on the output window), not just our own button.
  useEffect(() => onOutputClosed(() => setIsOutputOpen(false)), []);

  // Keeps the Full Screen button's icon honest — Esc leaves fullscreen too,
  // not just this button, so the state is watched rather than flipped.
  useEffect(() => watchFullscreen(setIsFullscreen), []);

  const handleToggleFullscreen = () => {
    void toggleFullscreen().catch((err) => {
      console.warn("fullscreen toggle failed:", err);
      showToast("Fullscreen is not available in this window", true);
    });
  };

  // The projector: opens fullscreen on the second monitor when there is one,
  // otherwise the only one there is. "Il faudrait une fenêtre plein écran
  // pour le deuxième écran" — one click, no monitor picker, since that's
  // the actual ask; a picker is easy to add later if a third display shows up.
  const handleToggleOutput = async () => {
    try {
      if (isOutputOpen) {
        await closeOutputWindow();
        setIsOutputOpen(false);
        return;
      }
      const monitors = await listMonitors();
      const target = monitors[1] ?? monitors[0];
      if (!target) {
        showToast("No display detected", true);
        return;
      }
      await openOutputWindow(target, true);
      setIsOutputOpen(true);
    } catch (err: unknown) {
      const error = err as Error;
      showToast(`Output error: ${error.message}`, true);
    }
  };

  // 0. NEW GRAPH
  const handleNewGraph = () => {
    const hasContent = project.canvases.some((canvas) => canvas.nodes.length > 0);
    if (
      hasContent &&
      !window.confirm("Create a new graph? Unsaved changes will be lost.")
    ) {
      return;
    }
    onLoadProject(createStarterProject(is2DMode ? "2d" : "3d"), "project_v1.tsuji");
    onFilenameChange("project_v1.tsuji", null);
    showToast("New project created!");
  };

  // 1. LOAD GRAPH — native Tauri open dialog
  const handleLoadClick = async () => {
    try {
      const res = await openProjectWithFilePicker();
      if (res) {
        onLoadProject(res.project, res.filename);
        showToast(`"${res.filename}" loaded!`);
      }
    } catch (err: unknown) {
      const error = err as Error;
      showToast(`Error: ${error.message}`, true);
    }
  };

  // 2. SAVE — write directly to current path, or open Save As if no path
  const handleSave = async () => {
    try {
      if (currentFilePath) {
        await saveProjectToPath(project, currentFilePath);
        onProjectSaved?.();
        showToast(`Saved: ${currentFilename}`);
      } else {
        // No path yet — fall through to Save As
        await handleSaveAs();
      }
    } catch (err: unknown) {
      const error = err as Error;
      showToast(`Save error: ${error.message}`, true);
    }
  };

  // 3. SAVE AS — native Tauri save dialog
  const handleSaveAs = async () => {
    try {
      const safeName = ensureOvmExtension(currentFilename);
      const savedName = await saveProjectAsWithFilePicker(project, safeName);
      if (savedName) {
        onProjectSaved?.();
        // We don't have the full path back from just the name, so reset path to null
        // and the next Save will prompt again, OR we store from dialog
        onFilenameChange(savedName, null);
        showToast(`Saved as: ${savedName}`);
      }
    } catch (err: unknown) {
      const error = err as Error;
      showToast(`Error: ${error.message}`, true);
    }
  };

  // FILENAME EDIT
  const handleFilenameSubmit = () => {
    setIsEditingFilename(false);
    let val = filenameInput.trim();
    if (!val) return;
    val = ensureOvmExtension(val);
    onFilenameChange(val, currentFilePath);
  };

  return (
    <header className="top-bar">
      {/* Left section: Logo + File Operations */}
      <div className="top-bar-left">
        <div className="top-bar-logo">
          <img src={logoUrl} alt="Tsuji" className="top-bar-logo-img" />
          <span className="top-bar-logo-text">
            tsu<span className="top-bar-logo-v">ji</span>
          </span>
        </div>
        <div className="top-bar-divider" />

        {/* NEW */}
        <button className="top-bar-button top-bar-button-new top-bar-button-icon-only" onClick={handleNewGraph} title="New empty project">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>

        {/* LOAD */}
        <button className="top-bar-button top-bar-button-load top-bar-button-icon-only" onClick={handleLoadClick} title="Load project (.tsuji)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <polyline points="9 14 12 11 15 14" />
          </svg>
        </button>

        {/* SAVE */}
        <button className="top-bar-button top-bar-button-save top-bar-button-icon-only" onClick={handleSave} title="Save (.tsuji)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </button>

        {/* DEMOS — small categorized graphs teaching one node/combination each */}
        <DemosMenu
          onLoadDemo={(demoProject, filename) => {
            onLoadProject(demoProject, filename);
            showToast(`"${filename}" loaded!`);
          }}
          onError={(message) => showToast(message, true)}
        />
      </div>

      {/* Center section: Undo & Redo */}
      <div className="top-bar-center">
        {/* UNDO (U+21B0) */}
        <button className="top-bar-button top-bar-button-icon-only" onClick={onUndo} title="Undo (Ctrl+Z / ⌘Z)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="11 5 6 10 11 15" />
            <path d="M6 10h11v9" />
          </svg>
        </button>

        {/* REDO (U+21B1) */}
        <button className="top-bar-button top-bar-button-icon-only" onClick={onRedo} title="Redo (Ctrl+Shift+Z / ⌘⇧Z)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="13 5 18 10 13 15" />
            <path d="M18 10H7v9" />
          </svg>
        </button>

        {onTogglePlay && (
          <>
            <div className="top-bar-divider" />
            <button
              className={`top-bar-button top-bar-button-icon-only ${isPlaying ? "top-bar-button-active" : ""}`}
              onClick={onTogglePlay}
              title={isPlaying ? "Pause (Space)" : "Play (Space) — runs the live scene even with no Render node or Frame Count off"}
            >
              {isPlaying ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
              )}
            </button>
            <button
              className="top-bar-button top-bar-button-icon-only"
              onClick={onResetSimulations}
              title="Reset simulations (Shift + Space) — rebuild physics, fluids and integrators, and return to frame 0"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Center area: 2D/3D Mode selector & Workspaces switches (3D View, Camera, Canvas) */}
      <div className="top-bar-center">
        {onToggle2DMode && (
          <div className="top-bar-mode-group">
            <button
              type="button"
              className={`top-bar-mode-btn ${!is2DMode ? "active" : ""}`}
              onClick={is2DMode ? onToggle2DMode : undefined}
              title="3D Mode — Free orbit 3D viewport (Click to switch to 3D)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
              3D
            </button>
            <button
              type="button"
              className={`top-bar-mode-btn ${is2DMode ? "active" : ""}`}
              onClick={!is2DMode ? onToggle2DMode : undefined}
              title="2D Mode — Orthographic drawing plane & elevation view (Ideal for Grease Pencil & tablets)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              2D
            </button>
          </div>
        )}

        {onToggle2DMode && spaces && onToggleSpace && <div className="top-bar-divider" />}

        {spaces && onToggleSpace && (
          <div className="top-bar-spaces-group">
            <button
              type="button"
              className={`top-bar-space-btn ${spaces.view3D ? "active" : ""}`}
              onClick={() => onToggleSpace("view3D")}
              title={is2DMode ? "Toggle 2D Viewport" : "Toggle 3D Viewport"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {is2DMode ? (
                  <>
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="3" y1="9" x2="21" y2="9" />
                    <line x1="9" y1="21" x2="9" y2="9" />
                  </>
                ) : (
                  <>
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </>
                )}
              </svg>
              {is2DMode ? "2D View" : "3D View"}
            </button>
            <button
              type="button"
              className={`top-bar-space-btn ${spaces.camera ? "active" : ""}`}
              onClick={() => onToggleSpace("camera")}
              title="Toggle Camera View (Projected view)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              Camera
            </button>
            <button
              type="button"
              className={`top-bar-space-btn ${spaces.canvas ? "active" : ""}`}
              onClick={() => onToggleSpace("canvas")}
              title="Toggle Canvas (Node Graph)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
              Canvas
            </button>
            {spaces.timeline !== undefined && (
              <button
                type="button"
                className={`top-bar-space-btn ${spaces.timeline ? "active" : ""}`}
                onClick={() => onToggleSpace("timeline")}
                title="Toggle Timeline (Animation & Playhead)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
                </svg>
                Timeline
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right area: Toast + Shortcuts + Preferences + Filename + Download + Share */}
      <div className="top-bar-right">
        {toastMessage && (
          <div className={`top-bar-toast${toastError ? " top-bar-toast-error" : ""}`}>
            {toastError ? "⚠ " : "✓ "}{toastMessage}
          </div>
        )}

        {/* SHORTCUTS — keyboard shortcuts reference popup */}
        <button
          className="top-bar-button top-bar-button-shortcuts"
          onClick={() => setIsShortcutsOpen(true)}
          title="Keyboard Shortcuts Guide"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
          </svg>
          Shortcuts
        </button>

        {/* PREFERENCES — tablet expresskeys and app configuration modal */}
        <button
          className="top-bar-button top-bar-button-prefs"
          onClick={() => setIsPreferencesOpen(true)}
          title="Preferences & Tablet Setup"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Preferences
        </button>

        {isEditingFilename ? (
          <input
            className="top-bar-filename-edit-input"
            autoFocus
            value={filenameInput}
            onChange={(e) => setFilenameInput(e.target.value)}
            onBlur={handleFilenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleFilenameSubmit();
              if (e.key === "Escape") setIsEditingFilename(false);
            }}
          />
        ) : (
          <div
            className="top-bar-filename"
            onClick={() => {
              setFilenameInput(currentFilename);
              setIsEditingFilename(true);
            }}
            title={currentFilePath || "Not yet saved"}
          >
            📄 {currentFilename}
          </div>
        )}

        {/* DOWNLOAD — the desktop builds, for visitors on the web version */}
        <DownloadMenu />

        {/* SHARE — the two ways a graph leaves the app, grouped */}
        <ShareMenu
          isOutputOpen={isOutputOpen}
          onToggleOutput={handleToggleOutput}
          onExportVideo={onExportVideo}
          onExportSequence={onExportSequence}
          isExporting={isExporting}
          exportMode={exportMode}
          exportProgress={exportProgress}
        />

        {/* FULL SCREEN — whole-window fullscreen toggle (browser API or native window flag) */}
        <button
          className="top-bar-button top-bar-button-icon-only"
          onClick={handleToggleFullscreen}
          title={isFullscreen ? "Exit Full Screen" : "Full Screen"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {isFullscreen ? (
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
            ) : (
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            )}
          </svg>
        </button>
      </div>

      <ShortcutsModal isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />
      <PreferencesModal isOpen={isPreferencesOpen} onClose={() => setIsPreferencesOpen(false)} />
    </header>
  );
};
