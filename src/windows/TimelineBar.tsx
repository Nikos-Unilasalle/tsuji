import { isKeyReservedForPlayback } from "../shared/graph/playbackKeys";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { EasingType, Marker } from "../shared/graph/types";
import { setInputZone } from "../shared/graph/inputZoneStore";
import { EasingPopover, EASING_STRENGTH_CONFIG, strengthForEasing } from "./EasingPopover";
import { WaveformPeak, clipPixelRange, loadWaveformPeaks } from "./audioWaveform";
import "./timeline-bar.css";

export interface KeyframeDataAtFrame {
  paramKeys: string[];
  easeIn?: EasingType;
  easeStrength?: number;
  easeBezier?: [number, number, number, number];
}

interface TimelineBarProps {
  currentFrame: number;
  totalFrames: number;
  isPlaying: boolean;
  keyframesEnabled: boolean;
  selectedKeyframes?: Record<number, KeyframeDataAtFrame>;
  markers?: Marker[];
  waveformUrl?: string;
  /** Where the audio clip starts on the timeline, and how long it runs. */
  waveformStartFrame?: number;
  waveformDuration?: number;
  fps?: number;
  onToggleMarker?: (frame: number) => void;
  onMoveMarker?: (oldFrame: number, newFrame: number) => void;
  onRenameMarker?: (frame: number, label: string) => void;
  onMoveKeyframe?: (oldFrame: number, newFrame: number) => void;
  onUpdateKeyframeEasing?: (frame: number, easeIn: EasingType, easeStrength?: number, easeBezier?: [number, number, number, number]) => void;
  onDeleteKeyframe?: (frame: number) => void;
  onFrameChange: (frame: number) => void;
  onTogglePlay: () => void;
  /** Discards every simulation's accumulated state and returns to frame 0. */
  onResetSimulations?: () => void;
  onSplitHandleMouseDown: (e: React.MouseEvent) => void;
  isDrawerOpen?: boolean;
  onToggleDrawer?: () => void;
}

function renderKeyframeGlyph(easeIn: EasingType = "smooth") {
  if (easeIn === "hold") {
    // Square hold glyph
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
        <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="#76C560" stroke="#0f172a" strokeWidth="1" />
      </svg>
    );
  }
  if (easeIn === "linear") {
    // Circle linear glyph
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
        <circle cx="6" cy="6" r="3.5" fill="#76C560" stroke="#0f172a" strokeWidth="1" />
      </svg>
    );
  }
  if (easeIn === "bounce" || easeIn === "elastic") {
    // Wavy diamond glyph
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
        <polygon points="6,1 11,6 6,11 1,6" fill="#76C560" stroke="#0f172a" strokeWidth="1" />
        <path d="M 4 6 Q 6 4 8 6" stroke="#0f172a" strokeWidth="1.2" fill="none" />
      </svg>
    );
  }
  // Standard symmetrical diamond
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
      <polygon points="6,1 11,6 6,11 1,6" fill="#76C560" stroke="#0f172a" strokeWidth="1" />
    </svg>
  );
}

/**
 * Decoded audio waveform drawn behind the timeline track — the music-sync
 * reference.
 *
 * The peaks are laid out on the *timeline's* frame axis: the clip begins at
 * `startFrame` and runs for `duration × fps` frames. Stretching the whole file
 * across the whole strip, as this did before, only lined up when the track
 * happened to be exactly as long as the animation — so as a sync reference it
 * was wrong in every other case, which is all of them.
 */
function WaveformCanvas({
  url,
  startFrame,
  duration,
  fps,
  totalFrames,
}: {
  url?: string;
  startFrame: number;
  duration: number;
  fps: number;
  totalFrames: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<WaveformPeak[] | null>(null);

  useEffect(() => {
    if (!url) {
      setPeaks(null);
      return;
    }
    let alive = true;
    loadWaveformPeaks(url).then((p) => {
      if (alive) setPeaks(p);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w <= 0 || h <= 0) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      if (!peaks || peaks.length === 0) return;
      const range = clipPixelRange(startFrame, duration, fps, totalFrames, w);
      if (!range) return;

      const clipX = range.x;
      const bw = range.width / peaks.length;
      ctx.fillStyle = "rgba(56, 189, 248, 0.22)";
      peaks.forEach((p, i) => {
        const x = clipX + i * bw;
        // A clip can start before the timeline or run off its end; draw only
        // the part that is actually on screen.
        if (x + bw < 0 || x > w) return;
        const top = (0.5 - p.max / 2) * h;
        const bottom = (0.5 - p.min / 2) * h;
        ctx.fillRect(x, top, Math.max(1, bw), Math.max(1, bottom - top));
      });
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, [peaks, startFrame, duration, fps, totalFrames]);

  return <canvas ref={ref} className="timeline-waveform" />;
}

export function TimelineBar({
  currentFrame,
  totalFrames,
  isPlaying,
  keyframesEnabled,
  selectedKeyframes = {},
  markers = [],
  waveformUrl,
  waveformStartFrame,
  waveformDuration,
  fps,
  onToggleMarker,
  onMoveMarker,
  onRenameMarker,
  onMoveKeyframe,
  onUpdateKeyframeEasing,
  onDeleteKeyframe,
  onFrameChange,
  onTogglePlay,
  onResetSimulations,
  onSplitHandleMouseDown,
  isDrawerOpen = false,
  onToggleDrawer,
}: TimelineBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number>(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [isTimelineHovered, setIsTimelineHovered] = useState(false);
  const [hoveredMarkerFrame, setHoveredMarkerFrame] = useState<number | null>(null);
  const [dragMarkerState, setDragMarkerState] = useState<{ oldFrame: number; dragFrame: number } | null>(null);
  const [dragKeyframeState, setDragKeyframeState] = useState<{ oldFrame: number; dragFrame: number } | null>(null);

  // Easing Popover State
  const [easingPopover, setEasingPopover] = useState<{
    frame: number;
    paramKeys: string[];
    easeIn: EasingType;
    strength: number;
    easeBezier: [number, number, number, number];
    x: number;
    y: number;
  } | null>(null);

  const calculateFrameFromEvent = useCallback(
    (e: React.MouseEvent | MouseEvent): { frame: number; x: number } | null => {
      if (!trackRef.current || totalFrames <= 0) return null;
      const rect = trackRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const ratio = rect.width > 0 ? x / rect.width : 0;
      const frame = Math.max(0, Math.min(totalFrames - 1, Math.round(ratio * (totalFrames - 1))));
      return { frame, x };
    },
    [totalFrames],
  );

  const [isCmdPressed, setIsCmdPressed] = useState(false);
  const [isShiftPressed, setIsShiftPressed] = useState(false);

  useEffect(() => {
    function handleKeyChange(e: KeyboardEvent) {
      setIsCmdPressed(e.metaKey || e.ctrlKey);
      setIsShiftPressed(e.shiftKey);
    }
    window.addEventListener("keydown", handleKeyChange);
    window.addEventListener("keyup", handleKeyChange);
    return () => {
      window.removeEventListener("keydown", handleKeyChange);
      window.removeEventListener("keyup", handleKeyChange);
    };
  }, []);

  const startScrubbing = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!keyframesEnabled || totalFrames <= 0) return;

      setIsScrubbing(true);
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      const res = calculateFrameFromEvent(e);
      if (res) {
        onFrameChange(res.frame);
        setHoverFrame(res.frame);
        setHoverX(res.x);
      }

      const onPointerMove = (moveEvent: MouseEvent) => {
        const moveRes = calculateFrameFromEvent(moveEvent);
        if (moveRes) {
          onFrameChange(moveRes.frame);
          setHoverFrame(moveRes.frame);
          setHoverX(moveRes.x);
        }
      };

      const onPointerUp = () => {
        setIsScrubbing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onPointerMove);
        window.removeEventListener("mouseup", onPointerUp);
      };

      window.addEventListener("mousemove", onPointerMove);
      window.addEventListener("mouseup", onPointerUp);
    },
    [calculateFrameFromEvent, keyframesEnabled, onFrameChange, totalFrames],
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (easingPopover && e.key === "Escape") {
        setEasingPopover(null);
        return;
      }

      if (!isTimelineHovered || !keyframesEnabled) return;
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          (activeEl as HTMLElement).isContentEditable);
      if (isInput) return;

      if ((e.key === "m" || e.key === "M") && onToggleMarker && !isKeyReservedForPlayback(e)) {
        e.preventDefault();
        if (hoveredMarkerFrame !== null) {
          onToggleMarker(hoveredMarkerFrame);
          setHoveredMarkerFrame(null);
        } else {
          onToggleMarker(currentFrame);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isTimelineHovered, keyframesEnabled, currentFrame, hoveredMarkerFrame, onToggleMarker, easingPopover]);

  const handlePointerDownTrack = (e: React.MouseEvent) => {
    // 1. Right click OR Shift + Left click: scrub playhead (tête de lecture)
    if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
      startScrubbing(e);
      return;
    }

    // 2. Left click (without Shift): resize split between canvas and viewports
    if (e.button === 0) {
      e.preventDefault();
      onSplitHandleMouseDown(e);
      return;
    }
  };

  const handleMarkerMouseDown = (e: React.MouseEvent, oldFrame: number) => {
    if (e.shiftKey) {
      startScrubbing(e);
      return;
    }
    e.stopPropagation();
    if (e.button !== 0) return;
    if (!keyframesEnabled || !onMoveMarker) return;

    setDragMarkerState({ oldFrame, dragFrame: oldFrame });
    let latestFrame = oldFrame;

    const onPointerMove = (moveEvent: MouseEvent) => {
      const res = calculateFrameFromEvent(moveEvent);
      if (res && res.frame !== latestFrame) {
        latestFrame = res.frame;
        setDragMarkerState({ oldFrame, dragFrame: latestFrame });
      }
    };

    const onPointerUp = () => {
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      setDragMarkerState(null);
      if (latestFrame !== oldFrame) {
        onMoveMarker(oldFrame, latestFrame);
      }
    };

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
  };

  const handleKeyframeMouseDown = (e: React.MouseEvent, oldFrame: number) => {
    if (e.shiftKey) {
      startScrubbing(e);
      return;
    }
    e.stopPropagation();
    if (e.button !== 0) return; // Left button only for drag / select
    if (!keyframesEnabled) return;

    onFrameChange(oldFrame);

    let hasMoved = false;
    let latestFrame = oldFrame;
    const startX = e.clientX;

    const onPointerMove = (moveEvent: MouseEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 3) {
        hasMoved = true;
      }
      if (hasMoved) {
        const res = calculateFrameFromEvent(moveEvent);
        if (res && res.frame !== latestFrame) {
          latestFrame = res.frame;
          setDragKeyframeState({ oldFrame, dragFrame: latestFrame });
          onFrameChange(latestFrame);
        }
      }
    };

    const onPointerUp = () => {
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      setDragKeyframeState(null);
      if (hasMoved && latestFrame !== oldFrame && onMoveKeyframe) {
        onMoveKeyframe(oldFrame, latestFrame);
      }
    };

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
  };

  const handleKeyframeContextMenu = (e: React.MouseEvent, frame: number, data: KeyframeDataAtFrame) => {
    e.preventDefault();
    e.stopPropagation();
    if (!keyframesEnabled) return;

    onFrameChange(frame);

    const targetRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(160, Math.min(window.innerWidth - 160, targetRect.left + targetRect.width / 2));
    const y = Math.max(10, targetRect.top - 180);

    const initialIn = data.easeIn || "smooth";

    setEasingPopover({
      frame,
      paramKeys: data.paramKeys,
      easeIn: initialIn,
      strength: data.easeStrength ?? EASING_STRENGTH_CONFIG[initialIn]?.defaultValue ?? 1,
      easeBezier: data.easeBezier ?? ([0.42, 0, 0.58, 1] as [number, number, number, number]),
      x,
      y,
    });
  };

  const handleMouseMoveTrack = (e: React.MouseEvent) => {
    if (!keyframesEnabled || totalFrames <= 0) return;
    const res = calculateFrameFromEvent(e);
    if (res) {
      setHoverFrame(res.frame);
      setHoverX(res.x);
    }
  };

  const handleMouseLeaveTrack = () => {
    if (!isScrubbing) setHoverFrame(null);
  };

  const handleSelectEasing = (newType: EasingType) => {
    if (!easingPopover) return;
    const strength = strengthForEasing(newType, easingPopover.easeIn, easingPopover.strength);
    setEasingPopover((prev) => (prev ? { ...prev, easeIn: newType, strength: strength ?? prev.strength } : null));
    onUpdateKeyframeEasing?.(easingPopover.frame, newType, strength, easingPopover.easeBezier);
  };

  const handleStrengthChange = (value: number) => {
    if (!easingPopover) return;
    if (!Number.isFinite(value) || value <= 0) return;
    setEasingPopover((prev) => (prev ? { ...prev, strength: value } : null));
    onUpdateKeyframeEasing?.(easingPopover.frame, easingPopover.easeIn, value, easingPopover.easeBezier);
  };

  const handleBezierChange = (b: [number, number, number, number]) => {
    if (!easingPopover) return;
    setEasingPopover((prev) => (prev ? { ...prev, easeBezier: b } : null));
    onUpdateKeyframeEasing?.(easingPopover.frame, "bezier", easingPopover.strength, b);
  };

  const handleDeleteCurrentKeyframe = () => {
    if (!easingPopover) return;
    onDeleteKeyframe?.(easingPopover.frame);
    setEasingPopover(null);
  };

  const progressPct = totalFrames > 1 ? (Math.max(0, Math.min(totalFrames - 1, currentFrame)) / (totalFrames - 1)) * 100 : 0;
  const oneFramePct = totalFrames > 1 ? (1 / (totalFrames - 1)) * 100 : 1;

  const keyframeFrames = Object.keys(selectedKeyframes).map(Number).sort((a, b) => a - b);

  return (
    <div
      className={`timeline-bar-container ${isCmdPressed ? "cmd-active" : ""} ${isShiftPressed ? "shift-active" : ""}`}
      onMouseDown={(e) => {
        if (e.shiftKey) {
          startScrubbing(e);
        } else if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onSplitHandleMouseDown(e);
        }
      }}
      onMouseEnter={() => {
        setIsTimelineHovered(true);
        setInputZone("timeline");
      }}
      onMouseLeave={() => {
        setIsTimelineHovered(false);
        setInputZone(null);
      }}
      title="Click and drag to resize panels | Shift + click and drag to scrub playhead"
    >
      <div
        className="timeline-split-resize-handle"
        onMouseDown={(e) => {
          if (e.shiftKey) {
            startScrubbing(e);
          } else {
            onSplitHandleMouseDown(e);
          }
        }}
        title="Drag to resize panels (Shift+drag to scrub playhead)"
      />

      <div className="timeline-bar-inner">
        <button
          type="button"
          className="timeline-play-btn"
          onClick={onTogglePlay}
          title={isPlaying ? "Pause (Space)" : "Play (Space) — runs the live scene even with no Render node or Frame Count off"}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>

        <button
          type="button"
          className="timeline-play-btn"
          onClick={onResetSimulations}
          title="Reset simulations (Shift + Space) — rebuild physics, fluids and integrators, and return to frame 0"
        >
          ⟲
        </button>

        <div
          ref={trackRef}
          className={`timeline-track ${!keyframesEnabled ? "disabled" : ""}`}
          onMouseDown={handlePointerDownTrack}
          onMouseMove={handleMouseMoveTrack}
          onMouseLeave={handleMouseLeaveTrack}
          onContextMenu={(e) => e.preventDefault()}
          title="Drag to resize split | Shift + drag to scrub playhead"
        >
          <div className="timeline-track-bg" />
          <WaveformCanvas
            url={waveformUrl}
            startFrame={waveformStartFrame ?? 0}
            duration={waveformDuration ?? 0}
            fps={fps ?? 30}
            totalFrames={totalFrames}
          />
          <div className="timeline-track-fill" style={{ width: `${progressPct}%` }} />

          {/* Visual markers */}
          {keyframesEnabled &&
            totalFrames > 0 &&
            markers.map((marker) => {
              const markerFrame = marker.frame;
              const displayFrame =
                dragMarkerState && dragMarkerState.oldFrame === markerFrame
                  ? dragMarkerState.dragFrame
                  : markerFrame;
              const markerPct = totalFrames > 1 ? (Math.max(0, Math.min(totalFrames - 1, displayFrame)) / (totalFrames - 1)) * 100 : 0;
              const isHovered = hoveredMarkerFrame === markerFrame;
              const isDragging = dragMarkerState && dragMarkerState.oldFrame === markerFrame;
              return (
                <div
                  key={markerFrame}
                  className={`timeline-visual-marker ${isHovered ? "hovered" : ""} ${isDragging ? "dragging" : ""}`}
                  style={{
                    left: `${markerPct}%`,
                    width: `max(6px, ${oneFramePct}%)`,
                  }}
                  onMouseEnter={() => setHoveredMarkerFrame(markerFrame)}
                  onMouseLeave={() => setHoveredMarkerFrame((h) => (h === markerFrame ? null : h))}
                  onMouseDown={(e) => handleMarkerMouseDown(e, markerFrame)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!onRenameMarker) return;
                    const next = window.prompt("Marker label", marker.label ?? "");
                    if (next !== null) onRenameMarker(markerFrame, next.trim());
                  }}
                  title={`${marker.label ? `"${marker.label}" ` : ""}Marker (Frame ${displayFrame}) - Press 'm' on hover to delete, drag to move, double-click to label`}
                />
              );
            })}

          {/* Interactive keyframe diamonds with easing glyphs & drag preview */}
          {keyframesEnabled &&
            totalFrames > 0 &&
            keyframeFrames.map((kfFrame) => {
              const data = selectedKeyframes[kfFrame] || { paramKeys: [] };
              const displayFrame =
                dragKeyframeState && dragKeyframeState.oldFrame === kfFrame
                  ? dragKeyframeState.dragFrame
                  : kfFrame;
              const kfPct = totalFrames > 1 ? (Math.max(0, Math.min(totalFrames - 1, displayFrame)) / (totalFrames - 1)) * 100 : 0;
              const isDragging = dragKeyframeState && dragKeyframeState.oldFrame === kfFrame;
              const isSelected = currentFrame === displayFrame;

              return (
                <div
                  key={kfFrame}
                  className={`timeline-keyframe-diamond ${isDragging ? "dragging" : ""} ${isSelected ? "selected" : ""}`}
                  style={{ left: `${kfPct}%` }}
                  onMouseDown={(e) => handleKeyframeMouseDown(e, kfFrame)}
                  onContextMenu={(e) => handleKeyframeContextMenu(e, kfFrame, data)}
                  title={`Keyframe at Frame ${displayFrame} (${data.paramKeys.join(", ")})\nArrival Ease: ${data.easeIn || "smooth"}${data.easeStrength !== undefined && EASING_STRENGTH_CONFIG[data.easeIn || "smooth"] ? ` (strength ${data.easeStrength})` : ""}\n• Left click + drag to move\n• Right click to edit interpolation`}
                >
                  {renderKeyframeGlyph(data.easeIn)}
                </div>
              );
            })}

          {keyframesEnabled && hoverFrame !== null && (
            <div
              className="timeline-hover-badge"
              style={{ left: `${hoverX}px` }}
            >
              Frame {hoverFrame}
            </div>
          )}

          {keyframesEnabled && totalFrames > 0 && (
            <div
              className="timeline-playhead-cursor"
              style={{ left: `${progressPct}%` }}
              title={`Frame ${currentFrame} (Shift+drag to scrub)`}
            />
          )}
        </div>

        {onToggleDrawer && (
          <button
            type="button"
            className={`timeline-drawer-toggle-btn ${isDrawerOpen ? "active" : ""}`}
            onClick={onToggleDrawer}
            title={isDrawerOpen ? "Collapse timeline (T)" : "Open advanced timeline (T)"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              {isDrawerOpen ? (
                <polyline points="6 9 12 15 18 9" />
              ) : (
                <polyline points="18 15 12 9 6 15" />
              )}
            </svg>
          </button>
        )}

        <div className="timeline-total-badge" title="Total frame count">
          {keyframesEnabled ? `${totalFrames} f` : "∞"}
        </div>
      </div>

      {/* Right-click Easing Popover Modal */}
      {easingPopover && (
        <EasingPopover
          x={easingPopover.x}
          y={easingPopover.y}
          badge={`Keyframe ${easingPopover.frame}`}
          subtitle={easingPopover.paramKeys.join(", ")}
          easeIn={easingPopover.easeIn}
          strength={easingPopover.strength}
          easeBezier={easingPopover.easeBezier}
          onSelectEasing={handleSelectEasing}
          onStrengthChange={handleStrengthChange}
          onBezierChange={handleBezierChange}
          onDelete={handleDeleteCurrentKeyframe}
          onClose={() => setEasingPopover(null)}
        />
      )}
    </div>
  );
}
