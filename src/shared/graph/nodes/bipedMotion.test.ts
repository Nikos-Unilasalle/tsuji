import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RIG_HUMAN_NODE } from "./rig";
import { bipedPresetParams, BipedGaitInfo, readGaitStyle, RIG_BIPED_MOTION_NODE } from "./bipedMotion";
import { EvalContext } from "../types";
import { evaluateKeyframeValue } from "../evaluate";
import { bodyMetrics, NATURAL_STYLE, solveGait, wantsToRun } from "../ik/gaitModel";
import { GAIT_PRESET_KEYS } from "../ik/gaitPresets";
import { HumanSkeleton } from "../ik/skeletons";

const ctx = (nodeId: string, extra: Partial<EvalContext> = {}): EvalContext => ({ time: 0, step: 0, nodeId, ...extra });

function human(id: string, params: Record<string, unknown> = {}) {
  const geometry = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, ...params }, ctx(id)).geometry as THREE.Object3D;
  return { geometry, skeleton: geometry.userData.humanRig.skeleton as HumanSkeleton };
}

const adult = human("bm-adult");
const metrics = bodyMetrics(adult.skeleton);

type Out = Record<string, unknown> & { __gaitInfo: BipedGaitInfo; feet: THREE.Vector3[]; joints: THREE.Vector3[]; matrix: THREE.Matrix4 };

/** Plays the node frame by frame on the graph clock; `params(frame)` may change over time. */
function play(id: string, frames: number, params: (frame: number) => Record<string, unknown>, skeleton = adult.geometry): Out[] {
  const outs: Out[] = [];
  for (let frame = 0; frame <= frames; frame++) {
    outs.push(
      RIG_BIPED_MOTION_NODE.evaluate(
        { skeleton },
        { ...RIG_BIPED_MOTION_NODE.defaultParams, ...params(frame) },
        ctx(id, { time: frame / 60, capturing: true, sessionId: "test" }),
      ) as Out,
    );
  }
  return outs;
}

const ikError = (out: Out, skeleton = adult.skeleton) => Math.max(...[0, 1].map((s) => out.joints[skeleton.joint.foot[s]].distanceTo(out.feet[s])));

describe("gait equations", () => {
  it("auto-tunes an adult walk to measured human values", () => {
    const walk = solveGait(metrics, NATURAL_STYLE, 1.3, 0);
    expect(walk.cadence).toBeGreaterThan(100);
    expect(walk.cadence).toBeLessThan(130);
    expect(walk.stride).toBeGreaterThan(1.1);
    expect(walk.stride).toBeLessThan(1.6);
    expect(walk.duty).toBeGreaterThan(0.5);
    expect(walk.doubleSupport).toBeGreaterThan(0);
    expect(walk.flightTime).toBe(0);
    expect(walk.sway).toBeGreaterThan(0.01);
    expect(walk.sway).toBeLessThan(0.04);
  });

  it("runs past the Froude transition, with a flight phase and a faster cadence", () => {
    const fr = (v: number) => (v * v) / (9.81 * metrics.hipHeight);
    expect(wantsToRun(fr(1.3), 0.5, false)).toBe(false);
    expect(wantsToRun(fr(3), 0.5, false)).toBe(true);
    // Hysteresis: just under the line, a run stays a run and a walk a walk.
    expect(wantsToRun(0.47, 0.5, true)).toBe(true);
    expect(wantsToRun(0.53, 0.5, false)).toBe(false);
    const run = solveGait(metrics, NATURAL_STYLE, 4, 1);
    expect(run.duty).toBeLessThan(0.5);
    expect(run.flightTime).toBeGreaterThan(0);
    expect(run.cadence).toBeGreaterThan(solveGait(metrics, NATURAL_STYLE, 1.3, 0).cadence);
  });

  it("scales with the skeleton: shorter legs take shorter, quicker steps at the same speed", () => {
    const child = bodyMetrics(human("bm-child", { height: 1.1 }).skeleton);
    const a = solveGait(metrics, NATURAL_STYLE, 1.2, 0);
    const c = solveGait(child, NATURAL_STYLE, 1.2, 0);
    expect(c.stride).toBeLessThan(a.stride);
    expect(c.cadence).toBeGreaterThan(a.cadence);
    expect(c.froude).toBeGreaterThan(a.froude);
  });

  it("is finite for any input", () => {
    for (const v of [0, -2, NaN, Infinity, 1e6]) {
      const sol = solveGait(metrics, NATURAL_STYLE, v, 0.5);
      for (const [key, value] of Object.entries(sol)) if (key !== "stopSpeed") expect(Number.isFinite(value) || value === Infinity).toBe(true);
      expect(Number.isFinite(sol.stride)).toBe(true);
    }
  });
});

describe("Biped Motion node", () => {
  it("walks a body moved at 1.2 m/s: never both feet in the air, the legs reach their feet", () => {
    const outs = play("bm-follow", 300, (f) => ({ location: new THREE.Vector3(0, 0, (f / 60) * 1.2) }));
    let worst = 0;
    outs.slice(120).forEach((o) => {
      expect(o.__gaitInfo.swing.filter(Boolean).length).toBeLessThanOrEqual(1);
      worst = Math.max(worst, ikError(o));
    });
    expect(worst).toBeLessThan(0.04);
    const last = outs[outs.length - 1];
    expect(last.__gaitInfo.state).toBe("Walking");
    expect(last.__gaitInfo.cadence).toBeGreaterThan(90);
    last.feet.forEach((f) => expect(f.z).toBeGreaterThan(4));
    // The arms swing against the legs.
    const { hand } = adult.skeleton.joint;
    const swing = outs.slice(120).reduce((sum, o) => sum + (o.joints[hand[0]].z - o.joints[hand[1]].z) * (o.feet[1].z - o.feet[0].z), 0);
    expect(swing).toBeGreaterThan(0);
  });

  it("drives itself into a run with a flight phase", () => {
    const outs = play("bm-run", 300, () => ({ locomotion: "drive", speed: 4 }));
    expect(outs[outs.length - 1].__gaitInfo.state).toBe("Running");
    expect(outs.slice(120).some((o) => o.__gaitInfo.swing.every(Boolean))).toBe(true);
    expect(Math.max(...outs.slice(120).map((o) => ikError(o)))).toBeLessThan(0.06);
    // Four metres a second for five seconds.
    expect(new THREE.Vector3().setFromMatrixPosition(outs[outs.length - 1].matrix).z).toBeCloseTo(20, 0);
  });

  it("stops: once the speed goes to zero the feet settle under the hips and the clock stops", () => {
    const outs = play("bm-stop", 360, (f) => ({ locomotion: "drive", speed: f < 150 ? 1.3 : 0 }));
    const last = outs[outs.length - 1];
    expect(last.__gaitInfo.state).toBe("Standing");
    expect(last.__gaitInfo.swing.some(Boolean)).toBe(false);
    const body = new THREE.Vector3().setFromMatrixPosition(last.matrix);
    last.feet.forEach((f) => expect(Math.abs(f.z - body.z)).toBeLessThan(0.12));
    expect(outs[outs.length - 2].__gaitInfo.phase).toBe(last.__gaitInfo.phase);
  });

  it("stands without stepping when nothing moves", () => {
    const outs = play("bm-still", 120, () => ({}));
    expect(outs.every((o) => !o.__gaitInfo.swing.some(Boolean))).toBe(true);
  });

  it("turns on the spot by stepping round", () => {
    const outs = play("bm-turn", 240, () => ({ locomotion: "drive", speed: 0, turnRate: 90 }));
    expect(outs.some((o) => o.__gaitInfo.swing.some(Boolean))).toBe(true);
    const last = outs[outs.length - 1];
    const toLocal = last.matrix.clone().invert();
    // Feet still beside the body after a full turn, not left where it started.
    last.feet.forEach((f) => expect(f.clone().applyMatrix4(toLocal).length()).toBeLessThan(0.45));
  });

  it("walks in place on a treadmill: the body stays, the feet cycle", () => {
    const outs = play("bm-inplace", 240, () => ({ locomotion: "inPlace", speed: 1.3 }));
    const last = outs[outs.length - 1];
    expect(new THREE.Vector3().setFromMatrixPosition(last.matrix).length()).toBeLessThan(1e-9);
    const zs = outs.slice(120).map((o) => o.feet[0].z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.5);
    expect(Math.max(...zs.map(Math.abs))).toBeLessThan(0.8);
  });

  it("plays every preset with finite poses and legs that reach", () => {
    for (const key of GAIT_PRESET_KEYS) {
      const outs = play(`bm-preset-${key}`, 180, () => ({ ...bipedPresetParams(key), locomotion: "drive" }));
      const last = outs[outs.length - 1];
      last.joints.forEach((j) => expect(Number.isFinite(j.x + j.y + j.z)).toBe(true));
      expect(Math.max(...outs.slice(90).map((o) => ikError(o)))).toBeLessThan(0.12);
    }
  });

  it("follows a scaled skeleton by its proportions", () => {
    const small = human("bm-small", { height: 1 });
    const outs = play("bm-small-walk", 240, () => ({ locomotion: "drive", speed: 0.9 }), small.geometry);
    const info = outs[outs.length - 1].__gaitInfo;
    expect(info.cadence).toBeGreaterThan(play("bm-adult-walk", 240, () => ({ locomotion: "drive", speed: 0.9 }))[240].__gaitInfo.cadence);
    expect(Math.max(...outs.slice(120).map((o) => ikError(o, small.skeleton)))).toBeLessThan(0.04);
  });

  it("walks a skeleton bound with its legs spread as it walks one with them straight", () => {
    const spread = human("bm-spread", { bindLegAngle: 30 });
    const a = play("bm-spread-walk", 180, () => ({ locomotion: "drive" }), spread.geometry)[180];
    const b = play("bm-straight-walk", 180, () => ({ locomotion: "drive" }))[180];
    expect(a.__gaitInfo.cadence).toBeCloseTo(b.__gaitInfo.cadence, 6);
    a.feet.forEach((f, i) => expect(f.distanceTo(b.feet[i])).toBeLessThan(1e-6));
    expect(ikError(a, spread.skeleton)).toBeLessThan(0.04);
  });

  it("stands empty without a skeleton", () => {
    const out = RIG_BIPED_MOTION_NODE.evaluate({}, { ...RIG_BIPED_MOTION_NODE.defaultParams }, ctx("bm-empty"));
    expect(out.feet).toEqual([]);
  });
});

describe("gait handles", () => {
  it("hands back the params they stand for when dropped where they are", () => {
    const params = { ...RIG_BIPED_MOTION_NODE.defaultParams, ...bipedPresetParams("swagger"), locomotion: "drive", armBend: 0.3 };
    const outs = play("bm-handles", 30, () => params);
    const handles = outs[outs.length - 1].__controlPoints as THREE.Vector3[];
    expect(handles.length).toBe(6);
    const style = readGaitStyle(params);
    const patch = Object.assign({}, ...handles.map((p, i) => RIG_BIPED_MOTION_NODE.paramHandles!(i, p, params, "bm-handles")));
    for (const key of ["stride", "clearance", "stepWidth", "sway", "bob", "lean", "crouch", "armSwing", "armBend"] as const) {
      expect(patch[key]).toBeCloseTo(style[key], 1);
    }
  });

  it("dragging the stride handle forward lengthens the stride", () => {
    const params = { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "drive" };
    const outs = play("bm-stride", 10, () => params);
    const handle = (outs[outs.length - 1].__controlPoints as THREE.Vector3[])[0];
    const patch = RIG_BIPED_MOTION_NODE.paramHandles!(0, handle.clone().add(new THREE.Vector3(0, 0, 0.1)), params, "bm-stride")!;
    expect(Number(patch.stride)).toBeGreaterThan(1.1);
  });
});

describe("Biped Motion files from before the gait model", () => {
  it("are upgraded to the relative style", () => {
    const up = RIG_BIPED_MOTION_NODE.upgradeParams!({ stepRadius: 0.52, pelvisBob: 0.06, armSwing: 0.3, lean: 0.16, speed: 1, showCircles: true });
    expect(up.stride).toBeCloseTo(2);
    expect(up.bob).toBeCloseTo(2);
    expect(up.armSwing).toBeCloseTo(0.5);
    expect(up.leanResponse).toBeCloseTo(2);
    expect(up.gait).toBe("run");
    expect("stepRadius" in up).toBe(false);
    const current = { stride: 1.2, armSwing: 0.8 };
    expect(RIG_BIPED_MOTION_NODE.upgradeParams!(current)).toBe(current);
  });
});

describe("Biped Motion on the timeline", () => {
  const fps = 30;
  const frameCtx = (id: string, frame: number, extra: Partial<EvalContext> = {}) =>
    ctx(id, { time: frame / fps, currentFrame: frame, fps, sessionId: "timeline", ...extra });
  const at = (id: string, frame: number, params: Record<string, unknown>, extra: Partial<EvalContext> = {}) =>
    RIG_BIPED_MOTION_NODE.evaluate({ skeleton: adult.geometry }, { ...RIG_BIPED_MOTION_NODE.defaultParams, ...params }, frameCtx(id, frame, extra)) as Out;
  const same = (a: Out, b: Out) => a.joints.forEach((j, i) => expect(j.distanceTo(b.joints[i])).toBeLessThan(1e-9));

  it("gives a frame the same pose however it is reached: played through, scrubbed back, jumped to", () => {
    const drive = { locomotion: "drive", speed: 1.6, turnRate: 20 };
    const played: Out[] = [];
    for (let f = 0; f <= 150; f++) played.push(at("tl-play", f, drive));
    expect(played[150].__gaitInfo.state).toBe("Walking");
    // Back to frame 60 and forward again.
    same(at("tl-play", 60, drive), played[60]);
    same(at("tl-play", 150, drive), played[150]);
    // A fresh node sent straight to frame 150.
    same(at("tl-jump", 150, drive), played[150]);
  });

  it("holds still while paused: the same frame twice is the same pose", () => {
    const drive = { locomotion: "drive", speed: 1.3 };
    for (let f = 0; f <= 40; f++) at("tl-pause", f, drive);
    const a = at("tl-pause", 40, drive);
    const b = at("tl-pause", 40, drive, { time: 99 });
    same(a, b);
  });

  it("loops: frame 0 after the end is frame 0 again", () => {
    const drive = { locomotion: "inPlace", speed: 1.3 };
    const first = at("tl-loop", 0, drive);
    for (let f = 1; f <= 90; f++) at("tl-loop", f, drive);
    same(at("tl-loop", 0, drive), first);
  });

  it("replays keyed Drive speed exactly when jumping ahead", () => {
    const keyframes = { "tl-key": { speed: [{ frame: 0, value: 0 }, { frame: 60, value: 3 }] } };
    const keyedSpeed = (f: number) => Number(evaluateKeyframeValue(keyframes, "tl-key", "speed", f, 0));
    let played: Out | null = null;
    for (let f = 0; f <= 90; f++) played = at("tl-key", f, { locomotion: "drive", speed: keyedSpeed(f) }, { keyframes });
    const jumped = RIG_BIPED_MOTION_NODE.evaluate(
      { skeleton: adult.geometry },
      { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "drive", speed: keyedSpeed(90) },
      { ...frameCtx("tl-key-jump", 90), keyframes: { "tl-key-jump": keyframes["tl-key"] } },
    ) as Out;
    same(jumped, played!);
  });

  it("follows a body moved upstream: once played, scrubbing back is exact, and a guess made ahead is corrected", () => {
    const moved = (f: number) => ({ location: new THREE.Vector3(Math.sin(f / 40), 0, (f / fps) * 1.2) });
    // Jumped to frame 120 first: frames 0..119 not seen yet, so only guessed.
    at("tl-follow", 120, moved(120));
    const played: Out[] = [];
    for (let f = 0; f <= 120; f++) played.push(at("tl-follow", f, moved(f)));
    const reference: Out[] = [];
    for (let f = 0; f <= 120; f++) reference.push(at("tl-follow-ref", f, moved(f)));
    same(played[120], reference[120]);
    same(at("tl-follow", 45, moved(45)), reference[45]);
  });

  it("runs on the wall clock instead when set to Live", () => {
    const outs: Out[] = [];
    for (let f = 0; f <= 3; f++) outs.push(at("tl-live", 10, { clock: "live", locomotion: "drive", speed: 1.3 }, { capturing: true, time: f }));
    expect(new THREE.Vector3().setFromMatrixPosition(outs[3].matrix).z).toBeGreaterThan(0.2);
  });
});

describe("Biped Motion on a route", () => {
  const fps = 30;
  const route = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 6)];
  const play = (id: string, frames: number, extra: Record<string, unknown> = {}) => {
    const outs: Out[] = [];
    for (let f = 0; f <= frames; f++) {
      outs.push(
        RIG_BIPED_MOTION_NODE.evaluate(
          { skeleton: adult.geometry },
          { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "route", route, ...extra },
          ctx(id, { time: f / fps, currentFrame: f, fps, sessionId: "route" }),
        ) as Out,
      );
    }
    return outs;
  };

  it("walks the route, stops at its marks, holds the pose, and stands at the end", () => {
    const marks = [{ kind: "stop", at: 0.5, hold: 2, pose: "cheer" }];
    const outs = play("route-walk", 330, { routeMarks: marks });
    const info = outs[outs.length - 1].__gaitInfo as BipedGaitInfo & { route: { markTimes: number[]; duration: number } };
    const stopFrame = Math.round((info.route.markTimes[0] + 1) * fps);
    const held = outs[stopFrame];
    const z = new THREE.Vector3().setFromMatrixPosition(held.matrix).z;
    expect(z).toBeCloseTo(3, 1);
    // Mid-hold the cheer's hands are up.
    const { hand } = adult.skeleton.joint;
    expect(held.joints[hand[0]].y).toBeGreaterThan(held.joints[adult.skeleton.joint.head].y);
    // At the end: standing at 6 m, feet down.
    const end = outs[outs.length - 1];
    expect(new THREE.Vector3().setFromMatrixPosition(end.matrix).z).toBeCloseTo(6, 1);
    expect(end.__gaitInfo.state).toBe("Standing");
    expect(Math.max(...outs.slice(30).map((o) => ikError(o)))).toBeLessThan(0.06);
  });

  it("is exact when scrubbed: a jump to a frame gives the frame played through", () => {
    const marks = [{ kind: "run", at: 0.3 }];
    const played = play("route-played", 120, { routeMarks: marks });
    const jumped = RIG_BIPED_MOTION_NODE.evaluate(
      { skeleton: adult.geometry },
      { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "route", route, routeMarks: marks },
      ctx("route-jumped", { time: 4, currentFrame: 120, fps, sessionId: "route" }),
    ) as Out;
    played[120].joints.forEach((j, i) => expect(j.distanceTo(jumped.joints[i])).toBeLessThan(1e-9));
  });

  it("moves a route point and a mark from their handles", () => {
    const marks = [{ kind: "stop", at: 0.5, hold: 1 }];
    const out = play("route-handles", 0, { routeMarks: marks })[0];
    const handles = out.__controlPoints as THREE.Vector3[];
    expect(handles.length).toBe(3);
    const params = { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "route", route, routeMarks: marks };
    const moved = RIG_BIPED_MOTION_NODE.paramHandles!(1, handles[1].clone().add(new THREE.Vector3(1, 0, 0)), params, "route-handles")!;
    expect((moved.route as THREE.Vector3[])[1].x).toBeCloseTo(1, 6);
    const slid = RIG_BIPED_MOTION_NODE.paramHandles!(2, handles[0].clone().lerp(handles[1], 0.8), params, "route-handles")!;
    expect((slid.routeMarks as { at: number }[])[0].at).toBeCloseTo(0.8, 1);
    expect(RIG_BIPED_MOTION_NODE.paramHandleAxes!(0, params)).toEqual(["x", "z"]);
  });
});
