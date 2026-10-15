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
