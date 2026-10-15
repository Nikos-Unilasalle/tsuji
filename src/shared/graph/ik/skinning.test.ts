import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildBones, computeSkinWeights, poseBones, skinNormals, skinPositions } from "./skinning";

const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
const chainRest = [v(0, 0), v(0, 1), v(0, 2)];
const chainParents = [-1, 0, 1];

function skinned(positions: number[], pose: THREE.Vector3[], options = { stretch: false, amount: 1 }, weightOptions = { influences: 2, falloff: 4, smooth: 0 }) {
  const bones = buildBones(chainParents, chainRest);
  const base = new Float32Array(positions);
  const skin = computeSkinWeights(base, null, new THREE.Matrix4(), bones, weightOptions);
  const posed = poseBones(bones, pose, new THREE.Matrix4(), options);
  const out = new Float32Array(base.length);
  skinPositions(out, base, skin, posed.pos);
  return { out, skin, posed, base };
}

describe("skin weights", () => {
  it("sum to one and favour the nearest bone", () => {
    const bones = buildBones(chainParents, chainRest);
    const { weights, indices, influences } = computeSkinWeights(new Float32Array([0.1, 0.5, 0, 0.1, 1.9, 0]), null, new THREE.Matrix4(), bones, { influences: 3, falloff: 4, smooth: 0 });
    for (let vtx = 0; vtx < 2; vtx++) {
      let total = 0;
      for (let k = 0; k < influences; k++) total += weights[vtx * influences + k];
      expect(total).toBeCloseTo(1, 5);
    }
    expect(indices[0]).toBe(1); // bone 0->1
    expect(indices[influences]).toBe(2); // bone 1->2
  });

  it("is rigid with one influence", () => {
    const { weights, influences } = computeSkinWeights(new Float32Array([0.1, 0.9, 0]), null, new THREE.Matrix4(), buildBones(chainParents, chainRest), { influences: 1, falloff: 4, smooth: 0 });
    expect(influences).toBe(1);
    expect(weights[0]).toBeCloseTo(1, 6);
  });

  it("smoothing keeps weights normalised", () => {
    const geometry = new THREE.CylinderGeometry(0.2, 0.2, 2, 8, 8).translate(0, 1, 0);
    const { weights, influences } = computeSkinWeights(geometry.attributes.position.array, geometry.index!.array, new THREE.Matrix4(), buildBones(chainParents, chainRest), { influences: 3, falloff: 4, smooth: 3 });
    for (let vtx = 0; vtx < geometry.attributes.position.count; vtx++) {
      let total = 0;
      for (let k = 0; k < influences; k++) total += weights[vtx * influences + k];
      expect(total).toBeCloseTo(1, 4);
    }
  });
});

describe("skinning", () => {
  it("leaves vertices alone at the rest pose", () => {
    const { out, base } = skinned([0.1, 0.5, 0, 0.1, 1.5, 0, 0, 2, 0.1], chainRest.map((p) => p.clone()));
    base.forEach((value, i) => expect(out[i]).toBeCloseTo(value, 5));
  });

  it("carries a vertex with the bone it is on, and leaves the root bone's alone", () => {
    // The top bone folds 90° about the middle joint: its tip goes to (-1, 1, 0).
    const pose = [v(0, 0), v(0, 1), v(-1, 1)];
    const { out } = skinned([0, 0.2, 0, 0, 1.9, 0], pose, { stretch: false, amount: 1 }, { influences: 1, falloff: 4, smooth: 0 });
    expect([out[0], out[1], out[2]]).toEqual([0, expect.closeTo(0.2, 5), 0]);
    expect(out[3]).toBeCloseTo(-0.9, 4);
    expect(out[4]).toBeCloseTo(1, 4);
  });

  it("follows a rig that moves as a whole", () => {
    const pose = chainRest.map((p) => p.clone().add(v(5, 0, 0)));
    const { out } = skinned([0.1, 0.5, 0], pose);
    expect(out[0]).toBeCloseTo(5.1, 4);
    expect(out[1]).toBeCloseTo(0.5, 4);
  });

  it("stretches along the bone only when asked", () => {
    const pose = [v(0, 0), v(0, 1), v(0, 4)];
    const rigid = skinned([0, 2, 0], pose, { stretch: false, amount: 1 }, { influences: 1, falloff: 4, smooth: 0 });
    const stretchy = skinned([0, 2, 0], pose, { stretch: true, amount: 1 }, { influences: 1, falloff: 4, smooth: 0 });
    expect(rigid.out[1]).toBeCloseTo(2, 4);
    expect(stretchy.out[1]).toBeCloseTo(4, 4);
  });

  it("blends back to rest with amount", () => {
    const pose = [v(0, 0), v(0, 1), v(-1, 1)];
    const { out } = skinned([0, 1.9, 0], pose, { stretch: false, amount: 0 }, { influences: 1, falloff: 4, smooth: 0 });
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(1.9, 5);
  });

  it("turns normals with their bone", () => {
    const pose = [v(0, 0), v(0, 1), v(-1, 1)];
    const { skin, posed } = skinned([0, 1.9, 0], pose, { stretch: false, amount: 1 }, { influences: 1, falloff: 4, smooth: 0 });
    const out = new Float32Array(3);
    skinNormals(out, new Float32Array([0, 1, 0]), skin, posed.nrm);
    expect(out[0]).toBeCloseTo(-1, 4);
    expect(out[1]).toBeCloseTo(0, 4);
  });

  it("gives a point bone the turn of the bones leaving it", () => {
    // Root joint with one child bone that swings 90°.
    const bones = buildBones([-1, 0], [v(0, 0), v(0, 1)]);
    const posed = poseBones(bones, [v(0, 0), v(1, 0)], new THREE.Matrix4(), { stretch: false, amount: 1 });
    const out = new Float32Array(3);
    skinPositions(out, new Float32Array([0, 0.5, 0]), { influences: 1, indices: new Uint16Array([0]), weights: new Float32Array([1]) }, posed.pos);
    expect(out[0]).toBeCloseTo(0.5, 4);
    expect(out[1]).toBeCloseTo(0, 4);
  });
});
