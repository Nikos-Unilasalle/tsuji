import { useEffect, useRef, useState } from "react";
import { HUD_PANEL_STYLE, HudBar, HudSeparator } from "./HudToolbars";
import { CommitSlider } from "./RigHuds";
import { bipedPresetParams, type BipedGaitInfo } from "../graph/nodes/bipedMotion";
import { GAIT_HANDLES, HANDLE_COLORS } from "../graph/nodes/bipedHandles";
import { GAIT_PRESET_KEYS, GAIT_PRESETS, type GaitPresetKey } from "../graph/ik/gaitPresets";
import type { NodeInstance } from "../graph/types";

/**
 * Biped Motion's palette: presets, how the body is moved, walk or run, and
 * the speed — along the bottom — and, top right, what the equations make of
 * it right now (cadence, stride, Froude number, ground contact) with the
 * key to the coloured handles and guides drawn on the body. Everything goes
 * through the node's params, one undo step per change.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const segment = (active: boolean) => `viewport-hud-button ${active ? "viewport-hud-button-active" : ""}`;
const wide = { width: "auto", padding: "0 9px" } as const;

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

function useLiveInfo(read: () => BipedGaitInfo | null): BipedGaitInfo | null {
  const readRef = useRef(read);
  readRef.current = read;
  const [info, setInfo] = useState<BipedGaitInfo | null>(() => read());
  useEffect(() => {
    const id = window.setInterval(() => setInfo(readRef.current()), 200);
    return () => window.clearInterval(id);
  }, []);
  return info;
}

export function BipedHud({ node, readInfo, onParams }: { node: NodeInstance; readInfo: () => BipedGaitInfo | null; onParams: OnParams }) {
  const info = useLiveInfo(readInfo);
  const p = node.params;
  const locomotion = String(p.locomotion ?? "follow");
  const gait = String(p.gait ?? "auto");
  const preset = String(p.preset ?? "natural");
  const driven = locomotion !== "follow";
  const showGuides = p.showGuides === undefined ? true : Boolean(p.showGuides);
  const set = (params: Record<string, unknown>) => onParams(params, node.id);
  const applyPreset = (key: GaitPresetKey) => set(bipedPresetParams(key, info?.hipHeight));

  return (
    <>
      <HudBar>
        <select
          value={GAIT_PRESET_KEYS.includes(preset as GaitPresetKey) ? preset : "custom"}
          onChange={(e) => e.target.value !== "custom" && applyPreset(e.target.value as GaitPresetKey)}
          title={GAIT_PRESETS[preset as GaitPresetKey]?.hint ?? "Tuned by hand — pick a preset to start over from one"}
          style={{ background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}
        >
          {GAIT_PRESET_KEYS.map((key) => (
            <option key={key} value={key}>
              {GAIT_PRESETS[key].label}
            </option>
          ))}
          <option value="custom" disabled>
            Custom
          </option>
        </select>
        <HudSeparator />
        {(
          [
            ["follow", "Follow", "The body goes where the node's pose (or a path) puts it; the gait reads its speed and turns"],
            ["drive", "Drive", "The body walks itself forward at Speed, turning at Turn Rate"],
            ["inPlace", "In Place", "A treadmill: the body stays, the feet cycle under it (loops, game cycles)"],
          ] as const
        ).map(([value, label, title]) => (
          <button key={value} type="button" className={segment(locomotion === value)} style={wide} onClick={() => set({ locomotion: value })} title={title}>
            {label}
          </button>
        ))}
        <HudSeparator />
        {(
          [
            ["auto", "Auto", "Walk, and run past the Froude transition (≈ 0.5)"],
            ["walk", "Walk", "Always walk, however fast"],
            ["run", "Run", "Always run, both feet leaving the ground"],
          ] as const
        ).map(([value, label, title]) => (
          <button key={value} type="button" className={segment(gait === value)} style={wide} onClick={() => set({ gait: value })} title={title}>
            {label}
          </button>
        ))}
        <HudSeparator />
        <div style={{ opacity: driven ? 1 : 0.4, pointerEvents: driven ? "auto" : "none", display: "flex", gap: 10, alignItems: "center" }}>
          <CommitSlider
            label="m/s"
            value={Number(p.speed ?? 1.3)}
            min={0}
            max={8}
            step={0.05}
            title="Walking speed in Drive and In Place. Stride, cadence and walk or run all follow from it"
            onCommit={(speed) => set({ speed })}
          />
          <CommitSlider
            label="°/s"
            value={Number(p.turnRate ?? 0)}
            min={-180}
            max={180}
            step={5}
            title="Turn rate in Drive: positive turns left. The body leans into the turn"
            onCommit={(turnRate) => set({ turnRate })}
          />
        </div>
        {info && !driven && (
          <button
            type="button"
            className="viewport-hud-button"
            style={wide}
            onClick={() => set({ locomotion: "drive", speed: Math.round(info.preferredSpeed * 100) / 100 })}
            title="Walk this body at the speed its proportions prefer (Froude 0.18)"
          >
            Walk it
          </button>
        )}
        <HudSeparator />
        <button type="button" className={segment(showGuides)} style={wide} onClick={() => set({ showGuides: !showGuides })} title="Show the gait handles and the guides they shape">
          Handles
        </button>
      </HudBar>
      <GaitReadout info={info} showGuides={showGuides} />
    </>
  );
}

function GaitReadout({ info, showGuides }: { info: BipedGaitInfo | null; showGuides: boolean }) {
  if (!info) {
    return (
      <div className="viewport-gp-hud" style={{ ...HUD_PANEL_STYLE, position: "absolute", top: 60, right: 12, padding: "8px 10px", color: "#94a3b8" }}>
        Wire a Human Skeleton into Skeleton
      </div>
    );
  }
  const row = (label: string, value: string, title: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }} title={title}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
  const moving = info.state !== "Standing";
  return (
    <div className="viewport-gp-hud" style={{ ...HUD_PANEL_STYLE, position: "absolute", top: 60, right: 12, padding: "8px 10px", minWidth: 190, display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <span style={{ fontWeight: 600 }}>{info.state}</span>
        <FootLights swing={info.swing} />
        <PhaseDial phase={info.phase} />
      </div>
      {row("Speed", `${info.measuredSpeed.toFixed(2)} m/s`, "How fast the body is going")}
      {row("Cadence", moving ? `${Math.round(info.cadence)} steps/min` : "—", "Steps per minute: speed ÷ stride, the stride from Alexander's law λ = 2.3·h·Fr^0.3")}
      {row("Stride", moving ? `${info.stride.toFixed(2)} m` : "—", "Left foot down to left foot down again")}
      {row("Froude", info.froude.toFixed(2), "v² / (g·hip height). Walkers of any size move alike at the same number; people break into a run near 0.5")}
      {row("Ground contact", `${Math.round(info.duty * 100)} %`, "Duty factor: share of the stride each foot is down. Over 50 % is a walk, under is a run")}
      {moving && info.doubleSupport > 0 && row("Double support", `${Math.round(info.doubleSupport * 1000)} ms`, "Both feet down, each step")}
      {moving && info.flightTime > 0 && row("Flight", `${Math.round(info.flightTime * 1000)} ms`, "Both feet in the air, each step")}
      {row("Hip height", `${info.hipHeight.toFixed(2)} m`, `From the skeleton: it sets every length and time here. Natural pace ${info.preferredSpeed.toFixed(2)} m/s`)}
      {showGuides && (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.12)", marginTop: 4, paddingTop: 5, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ color: "#94a3b8", fontSize: 11 }}>Drag the handles on the body:</span>
          {GAIT_HANDLES.map((label, i) => (
            <span key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: hex(HANDLE_COLORS[i]) }} />
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Left and right foot: lit while on the ground. */
function FootLights({ swing }: { swing: boolean[] }) {
  return (
    <span style={{ display: "flex", gap: 3 }} title="Feet on the ground (left, right)">
      {[0, 1].map((s) => (
        <span key={s} style={{ width: 9, height: 13, borderRadius: 4, background: swing[s] ? "rgba(255,255,255,0.15)" : "#22c55e" }} />
      ))}
    </span>
  );
}

/** Where in the stride the walk is: left foot strikes at the top. */
function PhaseDial({ phase }: { phase: number }) {
  const a = phase * Math.PI * 2;
  return (
    <svg width="18" height="18" viewBox="-10 -10 20 20" style={{ marginLeft: "auto" }}>
      <title>Stride phase</title>
      <circle r="8" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" />
      <line x1="0" y1="0" x2={Math.sin(a) * 7} y2={-Math.cos(a) * 7} stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
