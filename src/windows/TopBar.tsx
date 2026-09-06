import React, { useEffect, useRef, useState } from "react";
import {
  ensureOvmExtension,
  openProjectWithFilePicker,
  saveProjectAsWithFilePicker,
  saveProjectToPath,
} from "../shared/graph/storage";
import { Project } from "../shared/graph/types";
import { closeOutputWindow, listMonitors, onOutputClosed, openOutputWindow } from "../shared/ipc";
import logoUrl from "../assets/logo.png";
import { ShortcutsModal } from "./ShortcutsModal";
import { DemosMenu } from "./DemosMenu";
import { ShareMenu } from "./ShareMenu";
import { DownloadMenu } from "./DownloadMenu";
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
  isTimelineOpen = false,
  onToggleTimeline,
  is2DMode = false,
  onToggle2DMode,
}) => {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastError, setToastError] = useState(false);
  const [isEditingFilename, setIsEditingFilename] = useState(false);
  const [filenameInput, setFilenameInput] = useState(currentFilename);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
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
        {/* UNDO */}
        <button className="top-bar-button top-bar-button-icon-only" onClick={onUndo} title="Undo (Ctrl+Z / ⌘Z)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>

        {/* REDO */}
        <button className="top-bar-button top-bar-button-icon-only" onClick={onRedo} title="Redo (Ctrl+Shift+Z / ⌘⇧Z)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
          </svg>
        </button>

        {onToggle2DMode && (
          <>
            <div className="top-bar-divider" />
            <button
              className={`top-bar-button top-bar-button-mode ${is2DMode ? "top-bar-button-mode-active" : ""}`}
              onClick={onToggle2DMode}
              title={is2DMode ? "2D Mode active (click to switch to 3D Orbit Mode)" : "3D Mode active (click to switch to 2D Mode)"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              {is2DMode ? "2D" : "3D"}
            </button>
          </>
        )}
      </div>

      {/* Right area: Toast + Timeline + Shortcuts + Filename + Download + Share */}
      <div className="top-bar-right">
        {toastMessage && (
          <div className={`top-bar-toast${toastError ? " top-bar-toast-error" : ""}`}>
            {toastError ? "⚠ " : "✓ "}{toastMessage}
          </div>
        )}

        {/* TIMELINE — advanced keyframe dope sheet drawer */}
        {onToggleTimeline && (
          <button
            className={`top-bar-button${isTimelineOpen ? " top-bar-button-output-active" : ""}`}
            onClick={onToggleTimeline}
            title={isTimelineOpen ? "Close Timeline (T)" : "Open advanced Timeline (T)"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
            </svg>
            Timeline
          </button>
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
      </div>

      <ShortcutsModal isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />
    </header>
  );
};
