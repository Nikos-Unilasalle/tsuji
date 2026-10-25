import * as THREE from "three";
import { HUD_PANEL_STYLE, HudBar, HudSeparator } from "./HudToolbars";
import { CommitSlider } from "./RigHuds";
import { flipPose, mirrorPose, POSE_PRESET_KEYS, POSE_PRESETS, readPoseList, type PosePresetKey } from "../graph/ik/humanPose";
import type { HumanSkeleton } from "../graph/ik/skeletons";
import { TOGGLE_POINTS_KEYFRAME_ACTION } from "../graph/nodes/curve";
import type { NodeInstance } from "../graph/types";

/**
 * The posing palette, for a Human Skeleton or a Biped Pose: presets, mirror
 * and flip, keyframe and reset along the bottom — plus, for a Biped Pose, its
 * influence — and a key to the handles. Every button is one param change.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const wide = { width: "auto", padding: "0 9px" } as const;
const KEY: [string, string][] = [
  ["#22d3ee", "Pelvis — rotate (E) to turn the hips"],
  ["#a78bfa", "Head"],
  ["#f472b6", "Hands"],
  ["#f97316", "Feet"],
  ["#facc15", "Elbow & knee poles"],
];

export function PoseHud({
  node,
  skeleton,
  controls,
  influence,
  onParams,
  onAction,
}: {
  node: NodeInstance;
  /** The posed skeleton, for presets; null until something is wired in. */
  skeleton: HumanSkeleton | null;
  /** The ten controls as the node shows them now. */
  controls: THREE.Vector3[];
  /** Biped Pose only: its influence slider. */
  influence: boolean;
  onParams: OnParams;
  onAction: (nodeId: string, action: string) => void;
}) {
  const set = (params: Record<string, unknown>) => onParams(params, node.id);
  // Keep the pelvis turn (a Biped Pose's 11th entry) through every rewrite of the ten controls.
  const extra = Array.isArray(node.params.pointsList) ? node.params.pointsList.slice(10) : [];
  const current = readPoseList(node.params.pointsList, controls).controls;
  const write = (next: THREE.Vector3[], keepTurn = true) => set({ pointsList: [...next, ...(keepTurn ? extra : [])] });
  const solo = Boolean(node.params.solo);

  return (
    <>
      <HudBar>
        <select
          value=""
          disabled={!skeleton}
          onChange={(e) => skeleton && e.target.value && write(POSE_PRESETS[e.target.value as PosePresetKey].build(skeleton), false)}
          title="Start from a ready-made pose, fitted to this skeleton's proportions"
          style={{ background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}
        >
          <option value="" disabled>
            Pose…
          </option>
          {POSE_PRESET_KEYS.map((key) => (
            <option key={key} value={key} title={POSE_PRESETS[key].hint}>
              {POSE_PRESETS[key].label}
            </option>
          ))}
        </select>
        <HudSeparator />
        <button type="button" className="viewport-hud-button" style={wide} onClick={() => write(mirrorPose(current, "left"))} title="Copy the left side onto the right, mirrored">
          L → R
        </button>
        <button type="button" className="viewport-hud-button" style={wide} onClick={() => write(mirrorPose(current, "right"))} title="Copy the right side onto the left, mirrored">
          R → L
        </button>
        <button type="button" className="viewport-hud-button" style={wide} onClick={() => write(flipPose(current), false)} title="Swap left and right: the whole pose mirrored">
          Flip
        </button>
        <HudSeparator />
        <button type="button" className="viewport-hud-button" style={wide} onClick={() => onAction(node.id, TOGGLE_POINTS_KEYFRAME_ACTION)} title="Keyframe the pose at the current frame (again to remove the key)">
          ◆ Key
        </button>
        <button type="button" className="viewport-hud-button" style={wide} onClick={() => set({ pointsList: [] })} title="Back to the natural stance">
          Reset
        </button>
        {influence && (
          <>
            <HudSeparator />
            <CommitSlider
              label="Influence"
              value={Number(node.params.influence ?? 1)}
              min={0}
              max={1}
              step={0.05}
              title="How much of this pose goes over the one wired in: keyframe it 0 → 1 → 0 to stop, hold the pose and walk on"
              onCommit={(value) => set({ influence: value })}
            />
            <CommitSlider
              label="Wiggle"
              value={Number(node.params.wiggle ?? 0)}
              min={0}
              max={2}
              step={0.05}
              title="Keep the held pose alive: breathing, weight shifting, head and hands drifting (0 still, 1 natural, more restless). Feet stay planted"
              onCommit={(value) => set({ wiggle: value })}
            />
            <button
              type="button"
              className={`viewport-hud-button ${solo ? "viewport-hud-button-active" : ""}`}
              style={wide}
              onClick={() => set({ solo: !solo })}
              title="Show the pose at 100 % while editing it, whatever the influence"
            >
              Solo
            </button>
          </>
        )}
      </HudBar>
      <div className="viewport-gp-hud" style={{ ...HUD_PANEL_STYLE, position: "absolute", top: 60, right: 12, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
        <span style={{ color: "#94a3b8" }}>Drag a handle (W) · turn it to swing the limb (E)</span>
        {KEY.map(([color, label]) => (
          <span key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
            {label}
          </span>
        ))}
      </div>
    </>
  );
}
