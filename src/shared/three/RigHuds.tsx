import { useEffect, useState, type ReactNode } from "react";
import { HudBar, HudSeparator, HudToolColumn } from "./HudToolbars";
import { readSkeleton } from "../graph/ik/skeletonEdit";
import { readJointInfluence, withJointInfluence } from "../graph/nodes/skin";
import type { SkeletonOp } from "./skeletonEditor";
import type { NodeInstance } from "../graph/types";

/**
 * The two rig palettes: the Skeleton node's tools for building a rig, and the
 * Skin node's bar for editing how strongly each joint pulls on the mesh.
 * Both drive the node through its params only (`onParams`), so every click is
 * one undo step and nothing here holds state the graph does not.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const icon = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const TOOLS: { op: SkeletonOp; title: string; edits: boolean; glyph: ReactNode }[] = [
  {
    op: "add",
    title: "Add a joint under the selected one (A)",
    edits: true,
    glyph: (
      <>
        <circle cx="7" cy="17" r="3" fill="currentColor" fillOpacity="0.3" />
        <circle cx="17" cy="7" r="3" />
        <line x1="9" y1="15" x2="15" y2="9" />
      </>
    ),
  },
  {
    op: "subdivide",
    title: "Split the bone ending at the selected joint in two",
    edits: true,
    glyph: (
      <>
        <circle cx="5" cy="19" r="2.5" />
        <circle cx="12" cy="12" r="2.5" fill="currentColor" fillOpacity="0.4" />
        <circle cx="19" cy="5" r="2.5" />
        <line x1="6.8" y1="17.2" x2="10.2" y2="13.8" />
        <line x1="13.8" y1="10.2" x2="17.2" y2="6.8" />
      </>
    ),
  },
  {
    op: "delete",
    title: "Delete the selected joints; their children move up to the parent (D)",
    edits: true,
    glyph: (
      <>
        <circle cx="12" cy="12" r="4" />
        <line x1="4" y1="4" x2="20" y2="20" />
      </>
    ),
  },
  {
    op: "mirror",
    title: "Mirror the selected joints across X",
    edits: true,
    glyph: (
      <>
        <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2" />
        <circle cx="6" cy="12" r="2.5" fill="currentColor" fillOpacity="0.4" />
        <circle cx="18" cy="12" r="2.5" />
      </>
    ),
  },
  {
    op: "selectParent",
    title: "Select the parent joint",
    edits: false,
    glyph: (
      <>
        <circle cx="12" cy="19" r="3" />
        <path d="M12 16V5M7 10l5-5 5 5" />
      </>
    ),
  },
  {
    op: "selectChildren",
    title: "Select the child joints",
    edits: false,
    glyph: (
      <>
        <circle cx="12" cy="5" r="3" />
        <path d="M12 8v11M7 14l5 5 5-5" />
      </>
    ),
  },
  {
    op: "selectAll",
    title: "Select every joint",
    edits: false,
    glyph: (
      <>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="18" r="2" />
        <rect x="3" y="3" width="18" height="18" strokeDasharray="2 2" />
      </>
    ),
  },
];

export function SkeletonHud({
  node,
  selection,
  maxRows,
  left,
  onOp,
  onParams,
}: {
  node: NodeInstance;
  /** Joints picked in the viewport, the last one active. */
  selection: number[];
  maxRows: number;
  left: number;
  onOp: (op: SkeletonOp) => void;
  onParams: OnParams;
}) {
  const data = readSkeleton(node.params);
  const editing = String(node.params.mode ?? "Edit") !== "Pose";
  const active = selection.length ? selection[selection.length - 1] : -1;
  const inRange = active >= 0 && active < data.points.length;

  return (
    <>
      <HudToolColumn maxRows={maxRows} left={left}>
        {TOOLS.map((tool) => (
          <button
            key={tool.op}
            type="button"
            className="viewport-hud-button"
            disabled={tool.edits && !editing}
            onClick={() => onOp(tool.op)}
            title={tool.edits && !editing ? `${tool.title} — Edit mode only` : tool.title}
          >
            {icon(tool.glyph)}
          </button>
        ))}
      </HudToolColumn>
      <HudBar>
        <button
          type="button"
          className={`viewport-hud-button ${editing ? "viewport-hud-button-active" : ""}`}
          style={{ width: "auto", padding: "0 10px" }}
          onClick={() => !editing && onOp("mode")}
          title="Edit: the joints are the rest pose — build and shape the rig"
        >
          Edit
        </button>
        <button
          type="button"
          className={`viewport-hud-button ${!editing ? "viewport-hud-button-active" : ""}`}
          style={{ width: "auto", padding: "0 10px" }}
          onClick={() => editing && onOp("mode")}
          title="Pose: the rest pose is kept (Skin binds to it) and moving the joints poses the rig — keyframe them to animate"
        >
          Pose
        </button>
        <HudSeparator />
        <span style={{ fontSize: 11, color: "#94a3b8" }}>
          {data.points.length} joint{data.points.length === 1 ? "" : "s"}
        </span>
        {inRange ? (
          <input
            type="text"
            value={data.names[active]}
            onChange={(e) => onParams({ names: data.names.map((name, i) => (i === active ? e.target.value : name)) }, node.id)}
            style={{ width: 120, background: "rgba(0,0,0,0.3)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "2px 6px", fontSize: 12 }}
            title={selection.length > 1 ? `${selection.length} joints picked — naming the active one` : "Name of the selected joint"}
          />
        ) : (
          <span style={{ fontSize: 11, color: "#94a3b8" }}>Click a joint to select it, Shift+click for several</span>
        )}
      </HudBar>
    </>
  );
}

/** A slider that applies on release: a Skin node weighs its mesh again with every change, so not on every pixel of the drag. */
function CommitSlider({ label, value, min, max, step, title, onCommit }: { label: string; value: number; min: number; max: number; step: number; title: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [value]);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }} title={title}>
      <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 50, textAlign: "right" }}>
        {label} {shown.toFixed(2)}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        style={{ width: 90, accentColor: "#38bdf8", cursor: "pointer" }}
      />
    </div>
  );
}

export function SkinHud({
  node,
  joints,
  onParams,
}: {
  node: NodeInstance;
  /** What the Skin node published for the viewport: joint names, null when it has no rig yet. */
  joints: { names?: string[]; count: number } | null;
  onParams: OnParams;
}) {
  const selected = Math.round(Number(node.params.selectedJoint ?? -1));
  const count = joints?.count ?? 0;
  const has = selected >= 0 && selected < count;
  const influence = has ? readJointInfluence(node.params, selected) : { strength: 1, radius: 1 };
  const name = has ? joints?.names?.[selected] ?? `Joint ${selected + 1}` : null;
  const step = (by: number) => count > 0 && onParams({ selectedJoint: has ? (selected + by + count) % count : by > 0 ? 0 : count - 1 }, node.id);
  const toggle = (key: string, fallback: boolean) => onParams({ [key]: !(node.params[key] === undefined ? fallback : Boolean(node.params[key])) }, node.id);
  const flag = (key: string, fallback: boolean) => (node.params[key] === undefined ? fallback : Boolean(node.params[key]));

  return (
    <HudBar>
      <button type="button" className="viewport-hud-button" onClick={() => step(-1)} disabled={count === 0} title="Previous joint">
        {icon(<polyline points="15 6 9 12 15 18" />)}
      </button>
      <span style={{ fontSize: 12, minWidth: 110, textAlign: "center", color: has ? "#fff" : "#94a3b8" }}>
        {has ? name : count > 0 ? "Click a joint ball" : "Wire a rig"}
      </span>
      <button type="button" className="viewport-hud-button" onClick={() => step(1)} disabled={count === 0} title="Next joint">
        {icon(<polyline points="9 6 15 12 9 18" />)}
      </button>
      <HudSeparator />
      <div style={{ opacity: has ? 1 : 0.4, pointerEvents: has ? "auto" : "none", display: "flex", gap: 10, alignItems: "center" }}>
        <CommitSlider
          label="Strength"
          value={influence.strength}
          min={0}
          max={2}
          step={0.05}
          title="How strongly this joint pulls on the mesh: 0 switches it off, above 1 it wins over its neighbours"
          onCommit={(strength) => onParams(withJointInfluence(node.params, selected, { strength }), node.id)}
        />
        <CommitSlider
          label="Radius"
          value={influence.radius}
          min={0.1}
          max={4}
          step={0.1}
          title="How far this joint reaches: 2 is twice as far"
          onCommit={(radius) => onParams(withJointInfluence(node.params, selected, { radius }), node.id)}
        />
        <button
          type="button"
          className="viewport-hud-button"
          style={{ width: "auto", padding: "0 8px" }}
          onClick={() => onParams(withJointInfluence(node.params, selected, { strength: 1, radius: 1 }), node.id)}
          title="Back to Strength 1, Radius 1 for this joint"
        >
          Reset
        </button>
      </div>
      <HudSeparator />
      <button
        type="button"
        className={`viewport-hud-button ${flag("showWeights", false) ? "viewport-hud-button-active" : ""}`}
        style={{ width: "auto", padding: "0 8px" }}
        onClick={() => toggle("showWeights", false)}
        title="Paint the mesh with how much it follows the selected joint: blue none, red all"
      >
        Weights
      </button>
      <button
        type="button"
        className={`viewport-hud-button ${flag("showRig", true) ? "viewport-hud-button-active" : ""}`}
        style={{ width: "auto", padding: "0 8px" }}
        onClick={() => toggle("showRig", true)}
        title="Show or hide the rig itself"
      >
        Rig
      </button>
    </HudBar>
  );
}
