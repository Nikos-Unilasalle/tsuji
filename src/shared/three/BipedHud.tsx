import { useEffect, useRef, useState } from "react";
import { HUD_PANEL_STYLE, HudBar, HudSeparator } from "./HudToolbars";
import { CommitSlider } from "./RigHuds";
import { bipedPresetParams, readGaitStyle, type BipedGaitInfo } from "../graph/nodes/bipedMotion";
import { readSavedWalks, savedWalkParams } from "../graph/nodes/bipedWalks";
import { GAIT_HANDLES, HANDLE_COLORS } from "../graph/nodes/bipedHandles";
import { GAIT_PRESET_KEYS, GAIT_PRESETS, type GaitPresetKey } from "../graph/ik/gaitPresets";
import type { NodeInstance } from "../graph/types";
import { RouteHud } from "./RouteHud";

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

const selectStyle = { background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "3px 6px", fontSize: 12 } as const;

/** A labelled dropdown in the bar: the choice shown, the alternatives a click away, one line whatever their number. */
function Choice<T extends string>({ value, options, onChange, title }: { value: T; options: readonly (readonly [T, string, string])[]; onChange: (v: T) => void; title: string }) {
  const current = options.find(([v]) => v === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} title={current ? `${title}: ${current[2]}` : title} style={selectStyle}>
      {options.map(([v, label, hint]) => (
        <option key={v} value={v} title={hint}>
          {label}
        </option>
      ))}
    </select>
  );
}

const LOCOMOTIONS = [
  ["follow", "Follow", "The body goes where the node's pose (or a path) puts it; the gait reads its speed and turns"],
  ["drive", "Drive", "The body walks itself forward at Speed, turning at Turn Rate"],
  ["inPlace", "In Place", "A treadmill: the body stays, the feet cycle under it (loops, game cycles)"],
  ["route", "Route", "Walk a route drawn in the viewport, with stops, runs and poses along it"],
] as const;

const GAITS = [
  ["auto", "Auto gait", "Walk, and run past the Froude transition (≈ 0.5)"],
  ["walk", "Walk", "Always walk, however fast"],
  ["run", "Run", "Always run, both feet leaving the ground"],
] as const;

export function BipedHud({ node, readInfo, onParams, poseNames = [] }: { node: NodeInstance; readInfo: () => BipedGaitInfo | null; onParams: OnParams; poseNames?: string[] }) {
  const info = useLiveInfo(readInfo);
  const p = node.params;
  const locomotion = (LOCOMOTIONS.some(([v]) => v === p.locomotion) ? p.locomotion : "follow") as (typeof LOCOMOTIONS)[number][0];
  const gait = (GAITS.some(([v]) => v === p.gait) ? p.gait : "auto") as (typeof GAITS)[number][0];
  const preset = String(p.preset ?? "natural");
  const clock = p.clock === "live" ? "live" : "timeline";
  const showGuides = p.showGuides === undefined ? true : Boolean(p.showGuides);
  // Which handles are on the body: the gait's (designing the walk) or, in Route, the route's (staging it).
  const handleSet = p.handleSet === "gait" || p.handleSet === "route" ? p.handleSet : locomotion === "route" ? "route" : "gait";
  const handles = !showGuides ? "off" : handleSet;
  const set = (params: Record<string, unknown>) => onParams(params, node.id);
  const applyPreset = (key: GaitPresetKey) => set(bipedPresetParams(key, info?.hipHeight));
  const savedWalks = readSavedWalks(p.myWalks);
  const mine = preset.startsWith("mine:") ? savedWalks.find((w) => w.id === preset.slice(5)) : undefined;
  const handleOptions = [
    ["gait", "Gait handles", "Design the walk itself: stride, foot lift, width, pelvis, lean, arms"],
    ...(locomotion === "route" ? ([["route", "Route handles", "Stage it: drag the route's points and slide its marks"]] as const) : []),
    ["off", "No handles", "Hide the handles and guides"],
  ] as const;

  return (
    <>
      <HudBar>
        <select
          value={GAIT_PRESET_KEYS.includes(preset as GaitPresetKey) || mine ? preset : "custom"}
          onChange={(e) => {
            const value = e.target.value;
            if (value.startsWith("mine:")) {
              const walk = savedWalks.find((w) => `mine:${w.id}` === value);
              if (walk) set(savedWalkParams(walk));
            } else if (value !== "custom") applyPreset(value as GaitPresetKey);
          }}
          title={mine ? `Your saved walk “${mine.name}”` : (GAIT_PRESETS[preset as GaitPresetKey]?.hint ?? "Tuned by hand — save it with ★, or pick a walk to start over from")}
          style={selectStyle}
        >
          {savedWalks.length > 0 && (
            <optgroup label="My walks">
              {savedWalks.map((w) => (
                <option key={w.id} value={`mine:${w.id}`}>
                  {w.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Presets">
            {GAIT_PRESET_KEYS.map((key) => (
              <option key={key} value={key}>
                {GAIT_PRESETS[key].label}
              </option>
            ))}
          </optgroup>
          <option value="custom" disabled>
            Custom
          </option>
        </select>
        {mine ? (
          <>
            <input
              type="text"
              value={mine.name}
              onChange={(e) => set({ myWalks: savedWalks.map((w) => (w.id === mine.id ? { ...w, name: e.target.value } : w)) })}
              title="Name of this saved walk"
              style={{ ...selectStyle, width: 110 }}
            />
            <button
              type="button"
              className="viewport-hud-button"
              style={wide}
              onClick={() => set({ myWalks: savedWalks.map((w) => (w.id === mine.id ? { ...w, style: readGaitStyle(p), speed: Number(p.speed ?? 1.3), gait } : w)) })}
              title={`Update “${mine.name}” with the walk as it is tuned now`}
            >
              ↻
            </button>
            <button
              type="button"
              className="viewport-hud-button"
              style={wide}
              onClick={() => set({ myWalks: savedWalks.filter((w) => w.id !== mine.id), preset: "custom" })}
              title={`Delete “${mine.name}” (route marks using it go back to the node's walk)`}
            >
              🗑
            </button>
          </>
        ) : (
          <button
            type="button"
            className="viewport-hud-button"
            style={wide}
            onClick={() => {
              const id = `w${Date.now().toString(36)}`;
              const walk = { id, name: `My walk ${savedWalks.length + 1}`, style: readGaitStyle(p), speed: Number(p.speed ?? 1.3), gait };
              set({ myWalks: [...savedWalks, walk], preset: `mine:${id}` });
            }}
            title="Save this walk under a name, to pick it again — or switch to it at a mark on the route"
          >
            ★ Save
          </button>
        )}
        <Choice value={locomotion} options={LOCOMOTIONS} onChange={(v) => set({ locomotion: v })} title="How the body moves" />
        <Choice value={gait} options={GAITS} onChange={(v) => set({ gait: v })} title="Walk or run" />
        {locomotion !== "follow" && (
          <CommitSlider
            label="m/s"
            value={Number(p.speed ?? 1.3)}
            min={0}
            max={8}
            step={0.05}
            title={locomotion === "route" ? "Walking speed on the route, where no mark says otherwise" : "Walking speed. Stride, cadence and walk or run all follow from it"}
            onCommit={(speed) => set({ speed })}
          />
        )}
        {locomotion === "drive" && (
          <CommitSlider label="°/s" value={Number(p.turnRate ?? 0)} min={-180} max={180} step={5} title="Turn rate: positive turns left. The body leans into the turn" onCommit={(turnRate) => set({ turnRate })} />
        )}
        {info && locomotion === "follow" && (
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
        <button
          type="button"
          className={segment(clock === "timeline")}
          style={wide}
          onClick={() => set({ clock: clock === "timeline" ? "live" : "timeline" })}
          title={
            clock === "timeline"
              ? "Timeline: the walk is replayed from frame 0, so scrubbing, looping and export give the same walk. Click for Live"
              : "Live: real time, keeps walking while paused (drag the body around by hand). Click for Timeline"
          }
        >
          {clock === "timeline" ? "⏱ Timeline" : "● Live"}
        </button>
        <Choice
          value={handles}
          options={handleOptions}
          onChange={(v) => set(v === "off" ? { showGuides: false } : { showGuides: true, handleSet: v })}
          title="Handles on the body"
        />
      </HudBar>
      {locomotion === "route" && handles === "route" ? (
        <RouteHud node={node} info={info} onParams={onParams} poseNames={poseNames} />
      ) : (
        <GaitReadout info={info} showGuides={showGuides} />
      )}
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
      {moving && row("Foot roll", `${info.heelStrike >= 0 ? "heel" : "ball"} ${Math.round(Math.abs(info.heelStrike))}° · push ${Math.round(info.toeOff)}°`, "How the foot lands (toes up on the heel, or on the ball) and its pitch as it pushes off the ball; the toes bend to stay on the ground")}
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
