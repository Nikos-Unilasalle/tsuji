import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildHumanSkeleton, solveHuman } from "./skeletons";
import { mirrorJoints, mirrorPaint, mirrorVertices, PaintLayer } from "./weightPaint";
import { RIG_HUMAN_NODE } from "../nodes/rig";
import { RIG_BIPED_MOTION_NODE } from "../nodes/bipedMotion";
import { SKIN_NODE, skinStoredPaint, skinWeightDab, withJointInfluence, withoutJointPaint } from "../nodes/skin";
import { EvalContext } from "../types";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });

describe("Torso Forward", () => {
  const base = buildHumanSkeleton();
  const ahead = buildHumanSkeleton({ torsoForward: 0.1 });
  const at = (sk: typeof base, name: string) => sk.rig.rest[sk.names.indexOf(name)];

  it("carries the chest, head and arms forward of a pelvis and legs that stay put", () => {
    for (const name of ["Chest", "Neck", "Head", "Left Shoulder", "Right Hand", "Left Fingers"]) {
      expect(at(ahead, name).z - at(base, name).z).toBeCloseTo(0.18, 6);
      expect(at(ahead, name).y).toBeCloseTo(at(base, name).y, 6);
    }
    for (const name of ["Pelvis", "Left Hip", "Right Knee", "Left Foot", "Right Toes"]) expect(at(ahead, name).distanceTo(at(base, name))).toBeLessThan(1e-9);
    expect(buildHumanSkeleton({ torsoForward: -0.1 }).rig.rest[ahead.joint.head].z).toBeCloseTo(-0.18, 6);
  });

  it("stands in its rest pose within its joint limits, and walks", () => {
    const solved = solveHuman(ahead, ahead.restControls);
    solved.forEach((p, i) => expect(p.distanceTo(ahead.rig.rest[i])).toBeLessThan(3e-3));
    const rig = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, torsoForward: 0.12 }, ctx("torso-rig")).geometry;
    const params = { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "drive", speed: 1.3 };
    for (let f = 0; f <= 40; f++) {
      const out = RIG_BIPED_MOTION_NODE.evaluate({ skeleton: rig }, params, { ...ctx("torso-walk"), time: f / 30, step: f, currentFrame: f, fps: 30 });
      const joints = out.joints as THREE.Vector3[];
      expect(joints.every((p) => Number.isFinite(p.x + p.y + p.z))).toBe(true);
      for (const s of [0, 1]) expect(joints[ahead.joint.foot[s]].distanceTo((out.feet as THREE.Vector3[])[s])).toBeLessThan(0.05);
    }
  });
});

describe("left ↔ right symmetry", () => {
  const skeleton = buildHumanSkeleton();

  it("pairs each joint with its counterpart, by name or else by position", () => {
    const byName = mirrorJoints(skeleton.rig.rest, skeleton.names);
    const name = (i: number) => skeleton.names[i];
    skeleton.names.forEach((n, i) => {
      expect(name(byName[i])).toBe(n.replace(/Left|Right/, (s) => (s === "Left" ? "Right" : "Left")));
    });
    // Unnamed joints: by where they stand.
    expect(mirrorJoints(skeleton.rig.rest)).toEqual(byName);
    expect(mirrorJoints([new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.3, 0.5, 0), new THREE.Vector3(-0.3, 0.5, 0), new THREE.Vector3(0.9, 2, 0)])).toEqual([0, 2, 1, 3]);
  });

  it("copies a stroke across the centre onto the counterpart joint, seams included", () => {
    // A strip from x = -1 to 1, with a duplicated vertex at x = 0.5 (a seam).
    const xs = [-1, -0.5, 0, 0.5, 1, 0.5];
    const positions = xs.flatMap((x) => [x, 0, 0]);
    const mirror = mirrorVertices(positions);
    const layer: PaintLayer = new Map([[3, new Map([[1, 0.4], [2, 0.2]])]]);
    const written = mirrorPaint(layer, 3, [1, 2], mirror, [0, 1, 2, 7]);
    expect(written.sort()).toEqual([2, 3, 5]);
    expect(layer.get(7)?.get(3)).toBeCloseTo(0.4);
    expect(layer.get(7)?.get(5)).toBeCloseTo(0.4);
    expect(layer.get(7)?.get(2)).toBeCloseTo(0.2);
    // A joint on the centre line maps to itself: the stroke is mirrored onto its own other side.
    const own: PaintLayer = new Map([[0, new Map([[0, 0.3], [4, 0.1]])]]);
    mirrorPaint(own, 0, [0, 4], mirror, [0]);
    expect(own.get(0)?.get(4)).toBeCloseTo(0.3);
    expect(own.get(0)?.get(0)).toBeCloseTo(0.1);
  });

  it("paints both legs from one stroke on a Skin node, and sets and clears both joints", () => {
    const rig = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("sym-rig")).geometry;
    const legs = new THREE.Mesh(
      [0.162, -0.162]
        .map((x) => new THREE.CylinderGeometry(0.06, 0.06, 0.9, 10, 18).translate(x, 0.45, 0))
        .reduce((a, b) => {
          const merged = new THREE.BufferGeometry();
          for (const key of ["position", "normal", "uv"] as const) {
            const pa = a.attributes[key] as THREE.BufferAttribute;
            const pb = b.attributes[key] as THREE.BufferAttribute;
            merged.setAttribute(key, new THREE.BufferAttribute(Float32Array.from([...pa.array, ...pb.array]), pa.itemSize));
          }
          const offset = (a.attributes.position as THREE.BufferAttribute).count;
          merged.setIndex([...Array.from(a.getIndex()!.array), ...Array.from(b.getIndex()!.array, (i) => i + offset)]);
          return merged as THREE.CylinderGeometry;
        }),
      new THREE.MeshStandardMaterial(),
    );
    const knee = { left: skeleton.names.indexOf("Left Knee"), right: skeleton.names.indexOf("Right Knee") };
    const dab = (id: string, symmetry: boolean) => {
      SKIN_NODE.evaluate({ geometry: legs, rig }, { ...SKIN_NODE.defaultParams, mode: "CPU", symmetry }, ctx(id));
      const center = skeleton.rig.rest[knee.left];
      skinWeightDab(id, { joint: knee.left, tool: "Add", center: { x: center.x, y: center.y, z: center.z }, radius: 0.12, strength: 0.6 });
      return skinStoredPaint(id)![0]!.joints;
    };
    const plain = dab("sym-off", false);
    expect(Object.keys(plain)).toEqual([String(knee.left)]);
    const both = dab("sym-on", true);
    expect(Object.keys(both).sort()).toEqual([String(knee.left), String(knee.right)].sort());
    expect(both[knee.right].length).toBe(both[knee.left].length);

    const params = { ...SKIN_NODE.defaultParams, weightPaint: [{ vertices: 1, joints: both }] };
    const set = withJointInfluence(params, knee.left, { strength: 0.5 }, knee.right);
    expect((set.jointStrength as number[])[knee.left]).toBe(0.5);
    expect((set.jointStrength as number[])[knee.right]).toBe(0.5);
    expect(withoutJointPaint(params.weightPaint, knee.left, knee.right)).toEqual([]);
  });
});
