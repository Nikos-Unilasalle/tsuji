import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SKIN_NODE } from "./skin";
import { RIG_HUMAN_NODE, RIG_POLYPEDE_NODE } from "./rig";
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
    expect(out.skeleton.bones.length).toBe(18);
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
