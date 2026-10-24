import { useState } from "react";
import * as THREE from "three";
import { HUD_PANEL_STYLE } from "./HudToolbars";
import { CommitSlider } from "./RigHuds";
import type { BipedGaitInfo } from "../graph/nodes/bipedMotion";
import { readRoutePoints, ROUTE_COLORS } from "../graph/nodes/bipedRoute";
import { readRouteMarks, type RouteMark, type RouteMarkKind } from "../graph/ik/route";
import { POSE_PRESET_KEYS, POSE_PRESETS } from "../graph/ik/humanPose";
import type { NodeInstance } from "../graph/types";

/**
 * Biped Motion's route palette (top right, in Route locomotion): add or drop
 * route points, drop a walk / run / stop mark where the walker is at the
 * current frame, and edit the marks — each listed with the time it is
 * reached. The route and its marks are dragged in the viewport.
 */

type OnParams = (params: Record<string, unknown>, nodeId: string) => void;

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const KIND_LABEL: Record<RouteMarkKind, string> = { walk: "Walk", run: "Run", stop: "Stop" };
const markColor = (m: RouteMark) => hex(m.kind === "run" ? ROUTE_COLORS.run : m.kind === "walk" ? ROUTE_COLORS.walk : m.pose ? ROUTE_COLORS.pose : ROUTE_COLORS.stop);
const button = { width: "auto", padding: "0 8px", height: 24 } as const;
const select = { background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "2px 4px", fontSize: 11 } as const;

export function RouteHud({ node, info, onParams }: { node: NodeInstance; info: BipedGaitInfo | null; onParams: OnParams }) {
  const [picked, setPicked] = useState(-1);
  const points = readRoutePoints(node.params.route);
  const marks = readRouteMarks(node.params.routeMarks);
  const route = info?.route ?? null;
  const here = route ? Math.round(route.at * 10000) / 10000 : 0;
  const set = (params: Record<string, unknown>) => onParams(params, node.id);
  const setMarks = (next: RouteMark[]) => set({ routeMarks: next });
  const addMark = (mark: RouteMark) => {
    const next = [...marks, mark].sort((a, b) => a.at - b.at);
    setMarks(next);
    setPicked(next.indexOf(mark));
  };
  const editMark = (index: number, patch: Partial<RouteMark>) => setMarks(marks.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const addPoint = () => {
    const last = points[points.length - 1];
    const dir = last.clone().sub(points[points.length - 2]).setY(0);
    set({ route: [...points, last.clone().add(dir.lengthSq() > 1e-9 ? dir.setLength(2) : new THREE.Vector3(0, 0, 2))] });
  };
  const current = picked >= 0 && picked < marks.length ? marks[picked] : null;

  return (
    <div className="viewport-gp-hud" style={{ ...HUD_PANEL_STYLE, position: "absolute", top: 60, right: 12, padding: "8px 10px", width: 250, display: "flex", flexDirection: "column", gap: 6, fontSize: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 600, fontSize: 12 }}>Route</span>
        <span style={{ color: "#94a3b8" }}>{route ? `${route.length.toFixed(1)} m · ${route.duration.toFixed(1)} s` : "—"}</span>
      </div>
      {route && (
        <div style={{ height: 4, background: "rgba(255,255,255,0.12)", borderRadius: 2 }} title="Where the walker is on the route at this frame">
          <div style={{ width: `${route.at * 100}%`, height: 4, background: hex(ROUTE_COLORS.path), borderRadius: 2 }} />
        </div>
      )}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <button type="button" className="viewport-hud-button" style={button} onClick={addPoint} title="Add a point at the end of the route (then drag it)">
          + Point
        </button>
        <button
          type="button"
          className="viewport-hud-button"
          style={button}
          disabled={points.length <= 2}
          onClick={() => set({ route: points.slice(0, -1) })}
          title="Remove the route's last point"
        >
          − Point
        </button>
      </div>
      <span style={{ color: "#94a3b8" }}>Where the walker is now ({Math.round(here * 100)} %):</span>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <button type="button" className="viewport-hud-button" style={button} onClick={() => addMark({ kind: "stop", at: here, hold: 1.5, pose: "" })} title="Stop here: slow down into it, stand, then set off again">
          ■ Stop
        </button>
        <button type="button" className="viewport-hud-button" style={button} onClick={() => addMark({ kind: "stop", at: here, hold: 2.5, pose: "wave" })} title="Stop here and hold a pose">
          ✋ Pose
        </button>
        <button type="button" className="viewport-hud-button" style={button} onClick={() => addMark({ kind: "run", at: here, speed: 0 })} title="Break into a run from here">
          » Run
        </button>
        <button type="button" className="viewport-hud-button" style={button} onClick={() => addMark({ kind: "walk", at: here, speed: 0 })} title="Back to a walk from here">
          › Walk
        </button>
      </div>
      {marks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {marks.map((m, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPicked(i === picked ? -1 : i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: i === picked ? "rgba(56,189,248,0.2)" : "transparent",
                border: "none",
                color: "#fff",
                fontSize: 11,
                padding: "2px 4px",
                borderRadius: 4,
                cursor: "pointer",
                textAlign: "left",
              }}
              title="Edit this mark (drag its ball in the viewport to move it along the route)"
            >
              <span style={{ width: 8, height: 8, borderRadius: 4, background: markColor(m), flex: "none" }} />
              <span style={{ flex: 1 }}>
                {KIND_LABEL[m.kind]}
                {m.kind === "stop" && m.pose ? ` · ${m.pose === "wired" ? "wired pose" : POSE_PRESETS[m.pose as keyof typeof POSE_PRESETS]?.label ?? m.pose}` : ""}
              </span>
              <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>{route ? `${route.markTimes[i]?.toFixed(1) ?? "—"} s` : ""}</span>
            </button>
          ))}
        </div>
      )}
      {current && (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          {current.kind === "stop" ? (
            <>
              <CommitSlider label="Hold s" value={current.hold ?? 1.5} min={0} max={10} step={0.1} title="How long it stands here" onCommit={(hold) => editMark(picked, { hold })} />
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <select value={current.pose ?? ""} onChange={(e) => editMark(picked, { pose: e.target.value })} style={select} title="The pose held while standing here">
                  <option value="">No pose</option>
                  <option value="wired">Pose wired in (Biped Pose)</option>
                  {POSE_PRESET_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {POSE_PRESETS[key].label}
                    </option>
                  ))}
                </select>
                <label style={{ display: "flex", gap: 4, alignItems: "center" }} title="The pose takes the legs too (they slide into it); otherwise the feet stay planted">
                  <input type="checkbox" checked={Boolean(current.whole)} onChange={(e) => editMark(picked, { whole: e.target.checked })} />
                  Whole body
                </label>
              </div>
            </>
          ) : (
            <CommitSlider
              label="m/s"
              value={current.speed ?? 0}
              min={0}
              max={8}
              step={0.1}
              title={`Speed from here — 0 is the node's ${current.kind === "run" ? "Run Speed" : "Speed"}`}
              onCommit={(speed) => editMark(picked, { speed })}
            />
          )}
          <button
            type="button"
            className="viewport-hud-button"
            style={button}
            onClick={() => {
              setMarks(marks.filter((_, i) => i !== picked));
              setPicked(-1);
            }}
          >
            Delete mark
          </button>
        </div>
      )}
      <span style={{ color: "#94a3b8" }}>Drag the white balls to reshape the route, the coloured ones to slide a mark along it.</span>
    </div>
  );
}
