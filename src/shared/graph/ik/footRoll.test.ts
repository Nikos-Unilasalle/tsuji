import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { autoFootPitch, buildHumanSkeleton, footPivot, HumanSkeleton, rollFoot, solveHuman } from "./skeletons";
import { blendPose, CONTROL, readPoseList } from "./humanPose";
import { bodyMetrics, NATURAL_STYLE, solveGait, stancePitch, swingPitch } from "./gaitModel";
import { RIG_HUMAN_NODE } from "../nodes/rig";
import { SKIN_NODE } from "../nodes/skin";
import { RIG_BIPED_MOTION_NODE } from "../nodes/bipedMotion";
import { EvalContext } from "../types";

const DEG = Math.PI / 180;
const skeleton = buildHumanSkeleton();
const { joint } = skeleton;

/** The angle at the ball between the foot (ankle → ball) and the toes (ball → tips). */
const toeBend = (sk: HumanSkeleton, p: THREE.Vector3[], s: 0 | 1) => {
  const foot = p[sk.joint.ball[s]].clone().sub(p[sk.joint.foot[s]]).normalize();
  const toes = p[sk.joint.toes[s]].clone().sub(p[sk.joint.ball[s]]).normalize();
  return Math.acos(Math.max(-1, Math.min(1, foot.dot(toes))));
};
const footPitchOf = (sk: HumanSkeleton, p: THREE.Vector3[], s: 0 | 1) => {
  const v = p[sk.joint.ball[s]].clone().sub(p[sk.joint.foot[s]]);
  const rest = sk.rig.rest[sk.joint.ball[s]].clone().sub(sk.rig.rest[sk.joint.foot[s]]);
  return Math.atan2(-v.y, Math.hypot(v.x, v.z)) - Math.atan2(-rest.y, Math.hypot(rest.x, rest.z));
};

describe("human feet", () => {
  it("adds a ball and toes to each foot, after every joint skeletons had before them", () => {
    // Saved per-joint data (Skin's strength, radius and paint) is kept by index: these must not move.
    expect(skeleton.names.slice(0, 20)).toEqual([
      "Pelvis", "Spine 1", "Spine 2", "Chest", "Neck", "Head",
      "Left Shoulder", "Left Elbow", "Left Hand", "Right Shoulder", "Right Elbow", "Right Hand",
      "Left Hip", "Left Knee", "Left Foot", "Right Hip", "Right Knee", "Right Foot",
      "Left Fingers", "Right Fingers",
    ]);
    expect(skeleton.names.slice(20)).toEqual(["Left Ball", "Left Toes", "Right Ball", "Right Toes"]);
    for (const s of [0, 1] as const) {
      expect(skeleton.rig.joints[joint.ball[s]].parent).toBe(joint.foot[s]);
      expect(skeleton.rig.joints[joint.toes[s]].parent).toBe(joint.ball[s]);
      // Flat, pointing ahead, near the ground.
      const ball = skeleton.rig.rest[joint.ball[s]];
      const toes = skeleton.rig.rest[joint.toes[s]];
      expect(toes.z).toBeGreaterThan(ball.z);
      expect(ball.z).toBeGreaterThan(skeleton.rig.rest[joint.foot[s]].z);
      expect(ball.y).toBeGreaterThan(0);
      expect(ball.y).toBeLessThan(0.03);
    }
    // Foot Length scales them.
    const long = buildHumanSkeleton({ feet: 1.3 });
    expect(long.foot.ball.along).toBeCloseTo(skeleton.foot.ball.along * 1.3, 6);
  });

  it("stands flat at rest: the solve gives the rest feet back", () => {
    const solved = solveHuman(skeleton, skeleton.restControls);
    for (const s of [0, 1] as const) {
      expect(solved[joint.ball[s]].distanceTo(skeleton.rig.rest[joint.ball[s]])).toBeLessThan(2e-3);
      expect(solved[joint.toes[s]].distanceTo(skeleton.rig.rest[joint.toes[s]])).toBeLessThan(2e-3);
    }
  });

  it("rolls onto the ball when the ankle rises: the toes stay flat on the ground and bend at the ball", () => {
    const ballY = skeleton.rig.rest[joint.ball[0]].y;
    const toeY = skeleton.rig.rest[joint.toes[0]].y;
    for (const raise of [0.02, 0.04, 0.06]) {
      const c = skeleton.restControls.map((v) => v.clone());
      c[CONTROL.foot[0]].y += raise;
      const p = solveHuman(skeleton, c);
      expect(p[joint.ball[0]].y).toBeCloseTo(ballY, 3);
      expect(p[joint.toes[0]].y).toBeCloseTo(toeY, 3);
      // Heel up by the pitch, toes bent back by the same: they lie as flat as at rest.
      const pitch = footPitchOf(skeleton, p, 0);
      expect(pitch).toBeGreaterThan(5 * DEG);
      expect(toeBend(skeleton, p, 0)).toBeCloseTo(pitch + toeBend(skeleton, skeleton.rig.rest, 0), 2);
      // The other foot is untouched.
      expect(p[joint.toes[1]].distanceTo(skeleton.rig.rest[joint.toes[1]])).toBeLessThan(2e-3);
    }
  });

  it("never puts the ball or the toes under the ground, whatever the ankle and the pitch asked for", () => {
    const shape = skeleton.foot;
    const ballY = shape.ankleY + shape.ball.up;
    const toeY = ballY + shape.toes.up;
    for (const y of [shape.ankleY - 0.02, shape.ankleY, shape.ankleY + 0.03, shape.ankleY + 0.08, 0.4]) {
      for (const pitch of [-60, -20, 0, 20, 45, 80]) {
        const placed = rollFoot(shape, new THREE.Vector3(0.1, y, 0), new THREE.Vector3(0.3, 0, 1), pitch * DEG, shape.maxToeBend);
        expect(placed.ball.y).toBeGreaterThanOrEqual(ballY - 1e-4);
        expect(placed.toes.y).toBeGreaterThanOrEqual(toeY - 1e-4);
        expect(placed.bend).toBeLessThanOrEqual(shape.maxToeBend + 1e-9);
        expect(placed.bend).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps the toes within Toe Bend: past it the foot stays lower instead", () => {
    const stiff = buildHumanSkeleton({ toeBend: 20 });
    const c = stiff.restControls.map((v) => v.clone());
    c[CONTROL.foot[0]].y += 0.08;
    const p = solveHuman(stiff, c);
    expect(toeBend(stiff, p, 0) - toeBend(stiff, stiff.rig.rest, 0)).toBeLessThanOrEqual(20 * DEG + 1e-3);
    expect(p[stiff.joint.toes[0]].y).toBeGreaterThanOrEqual(stiff.rig.rest[stiff.joint.toes[0]].y - 1e-4);
  });

  it("follows a roll handed to it, and its direction", () => {
    const c = skeleton.restControls.map((v) => v.clone());
    // Heel strike: toes up, the foot turned out.
    const out = new THREE.Vector3(Math.sin(0.3), 0, Math.cos(0.3));
    const p = solveHuman(skeleton, c, { feet: [{ pitch: -15 * DEG, forward: out }, undefined] });
    expect(footPitchOf(skeleton, p, 0)).toBeCloseTo(-15 * DEG, 2);
    const along = p[joint.ball[0]].clone().sub(p[joint.foot[0]]).setY(0).normalize();
    expect(along.dot(out)).toBeGreaterThan(0.999);
    // Weight 0 is the automatic foot.
    const auto = solveHuman(skeleton, c, { feet: [{ pitch: -15 * DEG, weight: 0 }, undefined] });
    expect(auto[joint.toes[0]].distanceTo(skeleton.rig.rest[joint.toes[0]])).toBeLessThan(2e-3);
  });

  it("rolls the ankle about the ball for a raised heel, about the heel for raised toes", () => {
    const shape = skeleton.foot;
    const up = footPivot(shape, 30 * DEG);
    // The ankle comes up and forward over the ball, and the automatic roll reads the same pitch back from it.
    expect(up.up).toBeGreaterThan(0);
    expect(up.along).toBeGreaterThan(0);
    expect(autoFootPitch(shape, shape.ankleY + up.up)).toBeCloseTo(30 * DEG, 3);
    const strike = footPivot(shape, -15 * DEG);
    expect(strike.up).toBeGreaterThan(0);
    expect(strike.along).toBeLessThan(0);
  });
});

describe("foot roll in the gait", () => {
  const metrics = bodyMetrics(skeleton);

  it("strikes with the heel, rolls flat, pushes off the ball — steeper running, longer on the ball", () => {
    const walk = solveGait(metrics, NATURAL_STYLE, 1.3, 0);
    expect(stancePitch(walk, 0)).toBeLessThan(-10 * DEG);
    expect(stancePitch(walk, 0.35)).toBeCloseTo(0, 6);
    expect(stancePitch(walk, 1)).toBeGreaterThan(25 * DEG);
    // Continuous from the stance into the swing and back.
    expect(swingPitch(walk, 0)).toBeCloseTo(stancePitch(walk, 1), 6);
    expect(swingPitch(walk, 1)).toBeCloseTo(stancePitch(walk, 0), 6);
    const run = solveGait(metrics, NATURAL_STYLE, 4, 1);
    expect(run.toeOff).toBeGreaterThan(walk.toeOff);
    expect(run.heelShare).toBeGreaterThan(walk.heelShare);
    expect(run.heelStrike).toBeLessThan(walk.heelStrike);
    // Landing on the ball, and a tiptoe never bringing the heel down.
    const forefoot = solveGait(metrics, { ...NATURAL_STYLE, heelStrike: -1 }, 1.3, 0);
    expect(stancePitch(forefoot, 0)).toBeGreaterThan(0);
    const tiptoe = solveGait(metrics, { ...NATURAL_STYLE, heelTime: 5 }, 1.3, 0);
    for (let p = 0; p <= 1; p += 0.05) expect(stancePitch(tiptoe, p)).toBeGreaterThan(-1e-9 - tiptoe.heelStrike);
    expect(stancePitch(tiptoe, 0.4)).toBeGreaterThan(5 * DEG);
  });

  it("rolls the feet of a walking body visibly, the toes never under the ground", () => {
    const rig = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, { time: 0, step: 0, nodeId: "roll-rig" }).geometry;
    const params = { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "drive", speed: 1.3 };
    let maxBend = 0;
    let minPitch = 0;
    for (let f = 0; f <= 90; f++) {
      const out = RIG_BIPED_MOTION_NODE.evaluate({ skeleton: rig }, params, { time: f / 30, step: f, nodeId: "roll-walk", currentFrame: f, fps: 30 });
      const p = out.joints as THREE.Vector3[];
      for (const s of [0, 1] as const) {
        expect(p[joint.toes[s]].y).toBeGreaterThan(skeleton.rig.rest[joint.toes[s]].y - 2e-3);
        expect(p[joint.ball[s]].y).toBeGreaterThan(skeleton.rig.rest[joint.ball[s]].y - 2e-3);
        if (f > 30) {
          maxBend = Math.max(maxBend, toeBend(skeleton, p, s) - toeBend(skeleton, skeleton.rig.rest, s));
          minPitch = Math.min(minPitch, footPitchOf(skeleton, p, s));
        }
      }
    }
    expect(maxBend).toBeGreaterThan(15 * DEG);
    expect(minPitch).toBeLessThan(-8 * DEG);
  });
});

describe("data saved before the feet", () => {
  it("blends poses with no roll as the automatic foot, a walk's roll fading out under them", () => {
    const rest = { controls: skeleton.relaxedControls, pelvisRotation: new THREE.Quaternion() };
    expect(blendPose(rest, rest, () => 0.5, 0.5).feet).toBeUndefined();
    const walk = { ...rest, feet: [{ pitch: 0.4 }, { pitch: -0.2, weight: 0.5 }] };
    const half = blendPose(walk, rest, () => 0.25, 0).feet!;
    expect(half[0]!.pitch).toBeCloseTo(0.4, 6);
    expect(half[0]!.weight).toBeCloseTo(0.75, 6);
    expect(half[1]!.weight).toBeCloseTo(0.375, 6);
  });

  it("reads a pose list of ten controls and a turn, as Biped Pose always stored it", () => {
    const stored = [...skeleton.relaxedControls.map((v) => ({ x: v.x, y: v.y, z: v.z })), { x: 0, y: 0.2, z: 0 }];
    const { controls } = readPoseList(stored, skeleton.relaxedControls);
    expect(controls).toHaveLength(10);
    const p = solveHuman(skeleton, controls);
    expect(p).toHaveLength(skeleton.rig.joints.length);
    expect(p.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z))).toBe(true);
  });

  it("keeps Skin's per-joint settings and paint made on the joints before them", () => {
    const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });
    const rest = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("old-skin-rig")).geometry;
    const controls = skeleton.restControls.map((v) => v.clone());
    controls[CONTROL.foot[0]].add(new THREE.Vector3(0, 0.25, 0.2));
    const posed = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, pointsList: controls }, ctx("old-skin-rig")).geometry;
    const leg = () => new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 8, 18).translate(0.162, 0.45, 0), new THREE.MeshStandardMaterial());
    const knee = skeleton.names.indexOf("Left Knee");
    // Twenty entries, as a Skin saved before the feet has them.
    const strength = Array.from({ length: 20 }, (_, i) => (i === knee ? 0.2 : 1));
    const skin = (id: string, extra: Record<string, unknown>) => {
      const mesh = leg();
      SKIN_NODE.evaluate({ geometry: mesh, rig: rest }, { ...SKIN_NODE.defaultParams, mode: "CPU", ...extra }, ctx(id));
      const out = SKIN_NODE.evaluate({ geometry: mesh, rig: posed }, { ...SKIN_NODE.defaultParams, mode: "CPU", ...extra }, ctx(id)).geometry as THREE.Mesh;
      return Array.from(out.geometry.attributes.position.array as Float32Array);
    };
    const plain = skin("old-skin-a", {});
    const weak = skin("old-skin-b", { jointStrength: strength });
    expect(weak.every(Number.isFinite)).toBe(true);
    expect(weak.some((v, i) => Math.abs(v - plain[i]) > 1e-3)).toBe(true);
    const vertices = plain.length / 3;
    const painted = skin("old-skin-c", { weightPaint: [{ vertices, joints: { [knee]: Array.from({ length: vertices }, (_, v) => [v, 0.5]).flat() } }] });
    expect(painted.some((v, i) => Math.abs(v - plain[i]) > 1e-3)).toBe(true);
  });
});
