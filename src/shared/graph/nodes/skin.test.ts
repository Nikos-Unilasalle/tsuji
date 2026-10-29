import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { hasJointPaint, readJointInfluence, SKIN_NODE, skinStoredPaint, skinWeightDab, withJointInfluence, withoutJointPaint } from "./skin";
import { RIG_HUMAN_NODE, RIG_POLYPEDE_NODE } from "./rig";
import { OBJECT_SPHERE_NODE } from "./object";
import { EvalContext } from "../types";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });
const params = (extra: Record<string, unknown> = {}) => ({ ...SKIN_NODE.defaultParams, ...extra });
const body = () => new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.7, 12, 24).translate(0, 0.85, 0), new THREE.MeshStandardMaterial());
const positionsOf = (mesh: unknown) => Array.from((mesh as THREE.Mesh).geometry.attributes.position.array as Float32Array);

describe("Skin node", () => {
  it("passes through with no rig", () => {
    const mesh = body();
    expect(SKIN_NODE.evaluate({ geometry: mesh }, params(), ctx("skin-none")).geometry).toBe(mesh);
  });

  it("leaves a mesh alone on a rig at rest, and moves it with a posed human", () => {
    const rest = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("skin-human")).geometry;
    const mesh = body();
    const still = SKIN_NODE.evaluate({ geometry: mesh, rig: rest }, params(), ctx("skin-a")).geometry;
    const base = positionsOf(mesh);
    positionsOf(still).forEach((value, i) => expect(value).toBeCloseTo(base[i], 3));

    const controls = (RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("skin-human")).__controlPoints as THREE.Vector3[]).map((p) => p.clone());
    controls[2] = new THREE.Vector3(0.9, 1.7, 0.2);
    const posed = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, pointsList: controls }, ctx("skin-human")).geometry;
    const moved = SKIN_NODE.evaluate({ geometry: mesh, rig: posed }, params(), ctx("skin-a")).geometry;
    const after = positionsOf(moved);
    expect(after.some((value, i) => Math.abs(value - base[i]) > 0.05)).toBe(true);
    // Reused across frames: the same mesh, not a new one.
    expect(moved).toBe(still);
  });

  it("follows the rig's own transform in rig space, and stays put in world space", () => {
    const at = (x: number) => RIG_POLYPEDE_NODE.evaluate({}, { ...RIG_POLYPEDE_NODE.defaultParams, location: new THREE.Vector3(x, 0, 0) }, ctx("skin-poly")).geometry;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8).translate(0, 0.4, 0), new THREE.MeshStandardMaterial());

    const rigOut = SKIN_NODE.evaluate({ geometry: mesh, rig: at(0) }, params({ bindSpace: "Rig" }), ctx("skin-rig-space")).geometry as THREE.Mesh;
    const rigMoved = SKIN_NODE.evaluate({ geometry: mesh, rig: at(5) }, params({ bindSpace: "Rig" }), ctx("skin-rig-space")).geometry as THREE.Mesh;
    expect(rigMoved).toBe(rigOut);
    expect(rigMoved.matrix.elements[12]).toBeCloseTo(5, 4);

    const worldOut = SKIN_NODE.evaluate({ geometry: mesh, rig: at(0) }, params({ bindSpace: "World" }), ctx("skin-world-space")).geometry as THREE.Mesh;
    const ax = positionsOf(worldOut).filter((_, i) => i % 3 === 0);
    const worldMoved = SKIN_NODE.evaluate({ geometry: mesh, rig: at(5) }, params({ bindSpace: "World" }), ctx("skin-world-space")).geometry as THREE.Mesh;
    // The matrix stays the mesh's own; the vertices went along with the rig.
    expect(worldMoved.matrix.elements[12]).toBeCloseTo(0, 4);
    const bx = positionsOf(worldMoved).filter((_, i) => i % 3 === 0);
    expect(bx.reduce((s, x) => s + x, 0) / bx.length - ax.reduce((s, x) => s + x, 0) / ax.length).toBeCloseTo(5, 3);
  });

  it("skins to a plain list of joints, bound at the first pose it sees", () => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2, 8, 16).translate(0, 1, 0), new THREE.MeshStandardMaterial());
    const joints = (top: THREE.Vector3) => [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), top];
    SKIN_NODE.evaluate({ geometry: mesh, joints: joints(new THREE.Vector3(0, 2, 0)) }, params(), ctx("skin-list"));
    const bent = SKIN_NODE.evaluate({ geometry: mesh, joints: joints(new THREE.Vector3(-1, 1, 0)) }, params(), ctx("skin-list")).geometry;
    const xs = positionsOf(bent).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeLessThan(-0.7);
  });
});

describe("Skin node: modes and binding", () => {
  const humanRig = (nodeId: string, hand?: THREE.Vector3) => {
    const controls = (RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx(nodeId)).__controlPoints as THREE.Vector3[]).map((p) => p.clone());
    if (hand) controls[2] = hand;
    return RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, ...(hand ? { pointsList: controls } : {}) }, ctx(nodeId)).geometry;
  };

  it("skins on the GPU with a SkinnedMesh whose bones carry the pose", () => {
    const mesh = body();
    const out = SKIN_NODE.evaluate({ geometry: mesh, rig: humanRig("gpu-rig") }, params({ mode: "GPU" }), ctx("skin-gpu")).geometry as THREE.SkinnedMesh;
    expect(out).toBeInstanceOf(THREE.SkinnedMesh);
    expect(out.geometry.attributes.skinIndex.itemSize).toBe(4);
    expect(out.skeleton.bones.length).toBe(20);
    const at = (bones: THREE.Bone[]) => bones.map((b) => b.matrixWorld.elements.slice());
    const before = at(out.skeleton.bones);
    const moved = SKIN_NODE.evaluate({ geometry: mesh, rig: humanRig("gpu-rig", new THREE.Vector3(0.9, 1.7, 0.2)) }, params({ mode: "GPU" }), ctx("skin-gpu")).geometry as THREE.SkinnedMesh;
    expect(moved).toBe(out);
    expect(at(moved.skeleton.bones)).not.toEqual(before);
  });

  it("chooses the GPU on its own for a big mesh, and never for a custom shader", () => {
    const big = new THREE.Mesh(new THREE.SphereGeometry(0.5, 200, 120).translate(0, 0.85, 0), new THREE.MeshStandardMaterial());
    expect(SKIN_NODE.evaluate({ geometry: big, rig: humanRig("auto-rig") }, params(), ctx("skin-auto-big")).geometry).toBeInstanceOf(THREE.SkinnedMesh);
    expect(SKIN_NODE.evaluate({ geometry: body(), rig: humanRig("auto-rig") }, params(), ctx("skin-auto-small")).geometry).not.toBeInstanceOf(THREE.SkinnedMesh);
    const shader = new THREE.Mesh(big.geometry, new THREE.ShaderMaterial());
    expect(SKIN_NODE.evaluate({ geometry: shader, rig: humanRig("auto-rig") }, params({ mode: "GPU" }), ctx("skin-shader")).geometry).not.toBeInstanceOf(THREE.SkinnedMesh);
  });

  it("does not weigh again when the mesh moves, only when asked", () => {
    const mesh = body();
    const rig = humanRig("rebind-rig");
    const first = SKIN_NODE.evaluate({ geometry: mesh, rig }, params(), ctx("skin-rebind")).geometry as THREE.Mesh;
    const geometry = first.geometry;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeTranslation(1, 0, 0);
    mesh.matrixWorldNeedsUpdate = true;
    const moved = SKIN_NODE.evaluate({ geometry: mesh, rig }, params(), ctx("skin-rebind")).geometry as THREE.Mesh;
    expect(moved.geometry).toBe(geometry);
    expect(moved.matrix.elements[12]).toBeCloseTo(1, 4);
    const rebound = SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ rebind: true }), ctx("skin-rebind")).geometry as THREE.Mesh;
    expect(rebound.geometry).not.toBe(geometry);
  });

  it("follows a source that an upstream deformer rewrites in place", () => {
    const mesh = body();
    const rig = humanRig("sync-rig");
    const first = SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU" }), ctx("skin-sync")).geometry as THREE.Mesh;
    const before = positionsOf(first)[1];
    const position = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) position.setY(i, position.getY(i) + 1);
    position.needsUpdate = true;
    const after = positionsOf(SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU" }), ctx("skin-sync")).geometry)[1];
    expect(after - before).toBeCloseTo(1, 3);
  });
});

describe("Skin on a T-posed mesh", () => {
  it("binds to the rig's default T-pose while the rig stands with its arms hanging", () => {
    const standing = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("t-rig")).geometry as THREE.Object3D;
    const hanging = (standing.userData.humanRig.skeleton.relaxedControls as THREE.Vector3[]).map((p) => p.clone());
    const rig = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, pointsList: hanging }, ctx("t-rig")).geometry as THREE.Object3D;
    const data = rig.userData.rig as { rest: THREE.Vector3[]; pose: THREE.Vector3[] };
    const hand = 8;
    // Bind: arm straight out. Pose: hanging at the A-pose.
    expect(data.rest[hand].y).toBeCloseTo(data.rest[6].y, 1);
    expect(data.pose[hand].y).toBeLessThan(data.rest[6].y - 0.4);

    // An arm modelled out in a T, from the shoulder to the hand.
    const length = data.rest[hand].x - data.rest[6].x;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, length, 8, 24).rotateZ(Math.PI / 2).translate(data.rest[6].x + length / 2, data.rest[6].y, 0), new THREE.MeshStandardMaterial());
    const skinned = SKIN_NODE.evaluate({ geometry: arm, rig }, params({ mode: "CPU", influences: 2 }), ctx("t-skin")).geometry;
    const xs = positionsOf(skinned).filter((_, i) => i % 3 === 0);
    const ys = positionsOf(skinned).filter((_, i) => i % 3 === 1);
    // The tip of the arm has swung down to where the rig's hand hangs.
    const tip = xs.indexOf(Math.max(...xs));
    expect(ys[tip]).toBeLessThan(data.rest[6].y - 0.3);
  });

  it("does not deform the mesh at all when bound, whatever the rest arm angle, until a bone moves", () => {
    for (const bindArmAngle of [90, 22, 45]) {
      const rig = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, bindArmAngle }, ctx(`still-rig-${bindArmAngle}`)).geometry as THREE.Object3D;
      const data = rig.userData.rig as { rest: THREE.Vector3[]; pose: THREE.Vector3[] };
      // The rig stands in the very pose the mesh is bound to.
      data.rest.forEach((r, i) => expect(r.distanceTo(data.pose[i])).toBeLessThan(1e-9));
      const mesh = body();
      const base = positionsOf(mesh);
      const out = SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU" }), ctx(`still-${bindArmAngle}`)).geometry;
      positionsOf(out).forEach((value, i) => expect(Math.abs(value - base[i])).toBeLessThan(1e-6));
    }
  });
});

describe("Skin node: editing the influence of each joint", () => {
  const rigAt = (nodeId: string, hand?: THREE.Vector3) => {
    const controls = (RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx(nodeId)).__controlPoints as THREE.Vector3[]).map((p) => p.clone());
    if (hand) controls[2] = hand;
    return RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, ...(hand ? { pointsList: controls } : {}) }, ctx(nodeId)).geometry as THREE.Object3D;
  };
  const armMesh = () => {
    const rest = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("arm-rest")).geometry as THREE.Object3D;
    const data = rest.userData.rig as { rest: THREE.Vector3[] };
    const a = data.rest[7];
    const b = data.rest[8];
    const mid = a.clone().add(b).multiplyScalar(0.5);
    // A short cylinder on the forearm, between elbow and hand.
    const geometry = new THREE.CylinderGeometry(0.03, 0.03, a.distanceTo(b) * 0.5, 8, 4);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    geometry.applyQuaternion(q).translate(mid.x, mid.y, mid.z);
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  };
  const meanY = (mesh: unknown) => {
    const ys = positionsOf(mesh).filter((_, i) => i % 3 === 1);
    return ys.reduce((s, y) => s + y, 0) / ys.length;
  };
  const raised = new THREE.Vector3(0.9, 1.7, 0.2);

  it("a joint switched off no longer pulls the mesh", () => {
    const mesh = armMesh();
    const base = meanY(mesh);
    const moves = (extra: Record<string, unknown>, id: string) => {
      SKIN_NODE.evaluate({ geometry: mesh, rig: rigAt("sw-rig") }, params({ mode: "CPU", ...extra }), ctx(id));
      return meanY(SKIN_NODE.evaluate({ geometry: mesh, rig: rigAt("sw-rig", raised) }, params({ mode: "CPU", ...extra }), ctx(id)).geometry) - base;
    };
    expect(Math.abs(moves({}, "sw-on"))).toBeGreaterThan(0.05);
    // Elbow and hand bones (joints 7 and 8) off, the shoulder's the only arm bone left: the forearm barely swings with the hand.
    const strength = Array.from({ length: 18 }, (_, i) => (i === 7 || i === 8 ? 0 : 1));
    expect(Math.abs(moves({ jointStrength: strength }, "sw-off"))).toBeLessThan(Math.abs(moves({}, "sw-on2")));
  });

  it("a wider radius makes a joint win more of the mesh", () => {
    const mesh = armMesh();
    const rig = rigAt("rad-rig");
    const weightOf = (extra: Record<string, unknown>, id: string, joint: number) => {
      const out = SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU", showWeights: true, selectedJoint: joint, influences: 8, smooth: 0, ...extra }), ctx(id)).geometry as THREE.Mesh;
      const heat = out.children.find((c) => c.userData.skinHeat) as THREE.Mesh;
      const colors = heat.geometry.attributes.color.array as Float32Array;
      let red = 0;
      for (let i = 0; i < colors.length; i += 3) red += 1 - colors[i + 2];
      return red;
    };
    const normal = weightOf({}, "rad-a", 7);
    const wide = weightOf({ jointRadius: Array.from({ length: 18 }, (_, i) => (i === 7 ? 6 : 1)) }, "rad-b", 7);
    expect(wide).toBeGreaterThan(normal);
  });

  it("draws the weights of the selected joint as an overlay on the skinned mesh, and only while asked", () => {
    const mesh = armMesh();
    const rig = rigAt("heat-rig");
    const off = SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU" }), ctx("heat")).geometry as THREE.Mesh;
    expect(off.children.some((c) => c.userData.skinHeat)).toBe(false);
    const on = SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU", showWeights: true, selectedJoint: 8 }), ctx("heat")).geometry as THREE.Mesh;
    const heat = on.children.find((c) => c.userData.skinHeat) as THREE.Mesh;
    expect(heat).toBeDefined();
    expect(heat.geometry.attributes.position).toBe(on.geometry.attributes.position);
    const gone = SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU", showWeights: false, selectedJoint: 8 }), ctx("heat")).geometry as THREE.Mesh;
    expect(gone.children.some((c) => c.userData.skinHeat)).toBe(false);
  });

  it("publishes the joints for the viewport to pick, and hides the rig on request", () => {
    const mesh = armMesh();
    const rig = rigAt("pub-rig");
    const out = SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU", selectedJoint: 3 }), ctx("pub")).geometry as THREE.Object3D;
    const edit = out.userData.skinEdit as { joints: THREE.Vector3[]; names?: string[]; selected: number };
    expect(edit.joints.length).toBe(20);
    expect(edit.names?.[0]).toBe("Pelvis");
    expect(edit.selected).toBe(3);

    expect(rig.visible).toBe(true);
    SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU", showRig: false }), ctx("pub"));
    expect(rig.visible).toBe(false);
    SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode: "CPU", showRig: true }), ctx("pub"));
    expect(rig.visible).toBe(true);
  });
});

describe("editing one joint's influence", () => {
  it("reads 1 and 1 until set, and stores only what differs from 1", () => {
    expect(readJointInfluence({}, 4)).toEqual({ strength: 1, radius: 1 });
    const set = withJointInfluence({}, 2, { strength: 0.5, radius: 2 });
    expect(set.jointStrength).toEqual([null, null, 0.5]);
    expect(readJointInfluence(set, 2)).toEqual({ strength: 0.5, radius: 2 });
    expect(readJointInfluence(set, 1)).toEqual({ strength: 1, radius: 1 });
    const other = withJointInfluence({ ...set }, 0, { strength: 0 });
    expect(other.jointStrength).toEqual([0, null, 0.5]);
    // Back to 1: nothing left to store.
    expect(withJointInfluence(set, 2, { strength: 1 }).jointStrength).toEqual([]);
    expect(withJointInfluence(set, 2, { strength: 1 }).jointRadius).toBeUndefined();
  });
});

describe("Skin node: the mesh keeps its material", () => {
  it("shows whatever material the source mesh carries now, even one swapped after binding", () => {
    const rig = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("mat-rig")).geometry;
    const sphere = (extra: Record<string, unknown>, inputs: Record<string, unknown> = {}) =>
      OBJECT_SPHERE_NODE.evaluate(inputs, { ...OBJECT_SPHERE_NODE.defaultParams, color: new THREE.Color(0x44aa66), ...extra }, ctx("mat-sphere")).geometry as THREE.Mesh;
    const skinned = (mesh: THREE.Mesh, mode: string) => SKIN_NODE.evaluate({ geometry: mesh, rig }, params({ mode }), ctx(`mat-skin-${mode}`)).geometry as THREE.Mesh;

    for (const mode of ["CPU", "GPU"]) {
      const lit = sphere({});
      expect(skinned(lit, mode).material).toBe(lit.material);
      expect((skinned(lit, mode).material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x44aa66);

      // Shadeless swaps the sphere's material for a MeshBasicMaterial: the skinned mesh follows.
      const flat = sphere({ shadeless: 1 });
      expect(flat.material).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(skinned(flat, mode).material).toBe(flat.material);

      // A Material node wired in replaces it again.
      const custom = new THREE.MeshStandardMaterial({ color: 0xff0000 });
      const wired = sphere({}, { material: custom });
      expect(skinned(wired, mode).material).toBe(custom);
      expect(skinned(wired, mode).castShadow).toBe(wired.castShadow);
    }
  });

  it("paints weights by hand, keeps them in params, and reads them back without weighing again", () => {
    const human = (pose?: THREE.Vector3[]) => RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, ...(pose ? { pointsList: pose } : {}) }, ctx("skin-paint-human"));
    const controls = (human().__controlPoints as THREE.Vector3[]).map((p) => p.clone());
    controls[2] = new THREE.Vector3(0.9, 1.7, 0.2);
    const posed = human(controls).geometry;
    const mesh = body();
    const plain = positionsOf(SKIN_NODE.evaluate({ geometry: mesh, rig: posed }, params(), ctx("skin-paint-a")).geometry);

    const outMesh = SKIN_NODE.evaluate({ geometry: mesh, rig: posed }, params(), ctx("skin-paint-b")).geometry as THREE.Mesh;
    outMesh.updateMatrixWorld(true);
    const joints = outMesh.userData.skinEdit.joints as THREE.Vector3[];
    // Pull the whole body onto the root, hard.
    for (let i = 0; i < 30; i++) expect(skinWeightDab("skin-paint-b", { joint: 0, tool: "Add", center: new THREE.Vector3(0, 0.85, 0), radius: 3, strength: 1 })).toBe(true);
    const stored = skinStoredPaint("skin-paint-b");
    expect(hasJointPaint(stored, 0)).toBe(true);
    expect(joints.length).toBeGreaterThan(1);

    const painted = positionsOf(SKIN_NODE.evaluate({ geometry: mesh, rig: posed }, params({ weightPaint: JSON.parse(JSON.stringify(stored)) }), ctx("skin-paint-c")).geometry);
    expect(painted.some((value, i) => Math.abs(value - plain[i]) > 0.05)).toBe(true);
    // Clearing it gives back the automatic result.
    const cleared = withoutJointPaint(stored, 0);
    expect(cleared).toEqual([]);
    const again = positionsOf(SKIN_NODE.evaluate({ geometry: mesh, rig: posed }, params({ weightPaint: cleared }), ctx("skin-paint-c")).geometry);
    again.forEach((value, i) => expect(value).toBeCloseTo(plain[i], 4));
  });
});
