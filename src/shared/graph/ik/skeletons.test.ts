import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { boneLengths } from "./fabrik";
import { buildHumanSkeleton, buildPolypedeSkeleton, HUMAN_CONTROLS, solveHuman, solvePolypede } from "./skeletons";
import { createGait, polypedeNeighbors, stepGait, GAIT_DEFAULTS } from "./polypedeGait";

describe("human skeleton", () => {
  const skeleton = buildHumanSkeleton({ height: 1.8 });

  it("stands at rest on the ground, as tall as asked, controls at its joints", () => {
    const rest = skeleton.rig.rest;
    expect(skeleton.restControls.length).toBe(HUMAN_CONTROLS.length);
    expect(rest[skeleton.joint.foot[0]].y).toBeCloseTo(0.04 * 1.8, 6);
    expect(rest[skeleton.joint.head].y).toBeGreaterThan(1.6);
    expect(rest[skeleton.joint.head].y).toBeLessThan(1.8);
    expect(rest[skeleton.joint.hand[0]].x).toBeGreaterThan(0); // left on +X
    expect(rest[skeleton.joint.hand[1]].x).toBeLessThan(0);
  });

  it("holds its rest pose for its rest controls", () => {
    const solved = solveHuman(skeleton, skeleton.restControls);
    solved.forEach((p, i) => expect(p.distanceTo(skeleton.rig.rest[i])).toBeLessThan(1e-3));
  });

  it("reaches moved hands and feet, keeps bones, pins the pelvis, bends knees toward their poles", () => {
    const c = skeleton.restControls.map((p) => p.clone());
    c[0].add(new THREE.Vector3(0, -0.3, 0.1)); // crouch: pelvis down
    c[2].set(0.5, 1.3, 0.4); // left hand forward
    c[4].z += 0.2; // left foot forward
    const solved = solveHuman(skeleton, c);
    expect(solved[skeleton.joint.pelvis].distanceTo(c[0])).toBeLessThan(1e-9);
    expect(solved[skeleton.joint.hand[0]].distanceTo(c[2])).toBeLessThan(2e-3);
    expect(solved[skeleton.joint.foot[0]].distanceTo(c[4])).toBeLessThan(2e-3);
    const lengths = boneLengths(skeleton.rig);
    skeleton.rig.joints.forEach((j, i) => {
      if (j.parent >= 0) expect(solved[i].distanceTo(solved[j.parent])).toBeCloseTo(lengths[i], 4);
    });
    // Crouched: both knees come forward (their poles are in front).
    for (const s of [0, 1]) expect(solved[skeleton.joint.knee[s]].z).toBeGreaterThan(c[0].z);
  });
});

describe("human joint limits", () => {
  const bend = (positions: THREE.Vector3[], a: number, b: number, c: number) =>
    (positions[b].clone().sub(positions[a]).angleTo(positions[c].clone().sub(positions[b])) * 180) / Math.PI;

  it("keeps the knees within their bend while squatting deep, and lets them fold further when off", () => {
    const limited = buildHumanSkeleton({ kneeBend: 90 });
    const free = buildHumanSkeleton({ jointLimits: 0 });
    const squat = (sk: ReturnType<typeof buildHumanSkeleton>) => {
      const c = sk.restControls.map((p) => p.clone());
      c[0].y = 0.35;
      c[1].y = 1.05;
      return solveHuman(sk, c, { maxIterations: 60 });
    };
    const l = squat(limited);
    const f = squat(free);
    const j = limited.joint;
    for (const s of [0, 1]) {
      expect(bend(l, j.hip[s], j.knee[s], j.foot[s])).toBeLessThanOrEqual(90 + 1e-3);
      expect(bend(f, j.hip[s], j.knee[s], j.foot[s])).toBeGreaterThan(95);
    }
  });

  it("limits how far a leg swings back from the hip", () => {
    const sk = buildHumanSkeleton({ hipBack: 20 });
    const c = sk.restControls.map((p) => p.clone());
    c[4].set(c[4].x, 0.5, -0.8); // left foot far behind
    const solved = solveHuman(sk, c, { maxIterations: 60 });
    const thigh = solved[sk.joint.knee[0]].clone().sub(solved[sk.joint.hip[0]]);
    // Backward swing: angle behind straight down, in the sagittal plane.
    const back = (Math.atan2(-thigh.z, -thigh.y) * 180) / Math.PI;
    expect(back).toBeLessThanOrEqual(20 + 0.5);
  });
});

describe("polypede skeleton", () => {
  it("builds pairs of legs with exact segment lengths, feet resting on the ground", () => {
    const skeleton = buildPolypedeSkeleton({ legPairs: 3, legSegments: 3, legLength: 1.5 });
    expect(skeleton.legs.length).toBe(6);
    const lengths = boneLengths(skeleton.rig);
    for (const leg of skeleton.legs) {
      const foot = skeleton.rig.rest[leg.joints[leg.joints.length - 1]];
      expect(foot.distanceTo(leg.restFoot)).toBeLessThan(1e-3);
      expect(foot.y).toBeCloseTo(0, 3);
      for (const j of leg.joints.slice(1)) expect(lengths[j]).toBeCloseTo(0.5, 6);
      // Arched: the knees sit above the body's hips.
      expect(skeleton.rig.rest[leg.joints[1]].y).toBeGreaterThan(skeleton.rig.rest[leg.joints[0]].y);
    }
    expect(skeleton.legs[0].side).toBe(1);
    expect(skeleton.legs[1].side).toBe(-1);
  });

  it("solves feet moved within reach", () => {
    const skeleton = buildPolypedeSkeleton();
    const feet = skeleton.legs.map((leg) => leg.restFoot.clone().add(new THREE.Vector3(0.1, 0, 0.15)));
    const solved = solvePolypede(skeleton, feet);
    skeleton.legs.forEach((leg, i) => expect(solved[leg.joints[leg.joints.length - 1]].distanceTo(feet[i])).toBeLessThan(2e-3));
  });
});

describe("polypede gait", () => {
  const up = new THREE.Vector3(0, 1, 0);
  const params = { ...GAIT_DEFAULTS, stepRadius: 0.3, stepDuration: 0.2 };
  const restHomes = [new THREE.Vector3(1, 0, 0.5), new THREE.Vector3(-1, 0, 0.5), new THREE.Vector3(1, 0, -0.5), new THREE.Vector3(-1, 0, -0.5)];
  const neighbors = polypedeNeighbors(2);

  it("keeps feet planted while the body stays within the circles", () => {
    const gait = createGait(restHomes);
    const moved = restHomes.map((h) => h.clone().add(new THREE.Vector3(0, 0, 0.2)));
    const feet = stepGait(gait, moved, up, neighbors, params, 1 / 60);
    feet.forEach((f, i) => expect(f.distanceTo(restHomes[i])).toBe(0));
  });

  it("walks: feet left behind step ahead, never two neighbours at once, and keep up", () => {
    const gait = createGait(restHomes);
    let z = 0;
    for (let frame = 0; frame < 600; frame++) {
      z += 1 / 60; // 1 unit per second, forward
      const homes = restHomes.map((h) => h.clone().add(new THREE.Vector3(0, 0, z)));
      const feet = stepGait(gait, homes, up, neighbors, params, 1 / 60);
      const inAir = gait.legs.map((l) => l.stepping);
      inAir.forEach((air, i) => {
        if (air) expect(neighbors[i].filter((n) => inAir[n]).length).toBeLessThanOrEqual(1);
      });
      // Nobody falls far behind.
      feet.forEach((f, i) => expect(f.distanceTo(homes[i])).toBeLessThan(params.stepRadius * 2.5));
    }
    expect(z).toBeGreaterThan(9);
  });

  it("snaps the feet home after a teleport", () => {
    const gait = createGait(restHomes);
    const far = restHomes.map((h) => h.clone().add(new THREE.Vector3(50, 0, 0)));
    const feet = stepGait(gait, far, up, neighbors, params, 1 / 60);
    feet.forEach((f, i) => expect(f.distanceTo(far[i])).toBeLessThan(1e-9));
  });
});
