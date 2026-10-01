import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { addImpact, impactRadius, MAX_IMPACTS, MIN_IMPACT_SPEED, setWornImpacts, type WornImpact } from "./wornImpacts";
import { prepareWornGeometry, wornEntryOf } from "./wornGeometry";
import { MATERIAL_WORN_NODE } from "../materialWorn";
import { PHYSICS_WORLD_NODE, RIGID_BODY_NODE } from "../rapier";
import { applyMaterialParams } from "../object";
import { initRapier } from "../../../three/physics/rapierRuntime";
import { EvalContext } from "../../types";

const ctx = (nodeId: string, time: number, isPlaying = true): EvalContext => ({ nodeId, time, step: Math.round(time * 60), isPlaying });

describe("impact list", () => {
  it("ignores resting contacts and merges one knock reported over several steps", () => {
    const list: WornImpact[] = [];
    expect(addImpact(list, { x: 0, y: -0.5, z: 0, speed: MIN_IMPACT_SPEED * 0.5 }, 1)).toBe(false);
    expect(addImpact(list, { x: 0, y: -0.5, z: 0, speed: 3 }, 1)).toBe(true);
    // The same spot, softer: nothing new. Harder: the knock grows.
    expect(addImpact(list, { x: 0.005, y: -0.5, z: 0, speed: 2 }, 1)).toBe(false);
    expect(addImpact(list, { x: 0.005, y: -0.5, z: 0, speed: 5 }, 1)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].speed).toBe(5);
    // Elsewhere: a second one.
    addImpact(list, { x: 0.5, y: 0.5, z: 0, speed: 3 }, 1);
    expect(list).toHaveLength(2);
    expect(impactRadius(8)).toBeGreaterThan(impactRadius(2));
  });

  it("keeps the hardest knocks once full", () => {
    const list: WornImpact[] = [];
    for (let i = 0; i < MAX_IMPACTS + 5; i++) addImpact(list, { x: i, y: 0, z: 0, speed: 2 + i }, 1);
    expect(list).toHaveLength(MAX_IMPACTS);
    expect(Math.min(...list.map((h) => h.speed))).toBe(2 + 5);
  });

  it("puts a geometry's knocks in the pool, in rest space, and points every vertex at them", () => {
    const prepared = prepareWornGeometry(new THREE.BoxGeometry(2, 2, 2));
    const entry = wornEntryOf(prepared)!;
    expect(setWornImpacts(prepared, [{ x: 0, y: -1, z: 0, speed: 4 }], "a")).toBe(true);
    const attribute = prepared.getAttribute("aWornImpacts");
    expect(attribute.getY(0)).toBe(1);
    for (let i = 1; i < attribute.count; i++) expect(attribute.getX(i)).toBe(attribute.getX(0));
    expect(entry.impactKey).toBe("a");
    setWornImpacts(prepared, [], "b");
    expect(attribute.getY(0)).toBe(0);
    // Not a prepared geometry: nowhere to put them.
    expect(setWornImpacts(new THREE.BoxGeometry(), [], "c")).toBe(false);
  });
});

describe("impacts from the physics", () => {
  beforeAll(async () => {
    await initRapier();
  });

  it("chips a Worn crate where it hits the floor, and forgets it when the simulation stops", () => {
    const worn = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, ctx("impact-worn", 0)) as any;
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    crate.position.set(0, 4, 0);
    crate.updateMatrixWorld(true);
    applyMaterialParams(crate, worn.material);
    expect(crate.geometry.getAttribute("aWornImpacts")).toBeDefined();

    const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    floor.scale.set(20, 1, 20);
    floor.position.set(0, -0.5, 0);
    floor.updateMatrixWorld(true);

    const worldParams = { ...PHYSICS_WORLD_NODE.defaultParams };
    for (let frame = 0; frame < 150; frame++) {
      const time = frame / 60;
      const w = PHYSICS_WORLD_NODE.evaluate({}, worldParams, ctx("impact-world", time)) as { world: unknown };
      RIGID_BODY_NODE.evaluate({ world: w.world, geometry: floor }, { ...RIGID_BODY_NODE.defaultParams, bodyType: "fixed" }, ctx("impact-floor", time));
      RIGID_BODY_NODE.evaluate({ world: w.world, geometry: crate }, { ...RIGID_BODY_NODE.defaultParams, shape: "box", restitution: 0 }, ctx("impact-crate", time));
    }

    const attribute = crate.geometry.getAttribute("aWornImpacts");
    const count = attribute.getY(0);
    expect(count).toBeGreaterThan(0);
    // It landed flat: the knocks are on its bottom face (mesh space y = −0.5), in rest space −0.5 / size 1.
    const entry = wornEntryOf(crate.geometry)!;
    expect(entry.impactKey).toMatch(/^impact-crate:/);

    // Stop: back to the authored crate, unmarked.
    const w = PHYSICS_WORLD_NODE.evaluate({}, worldParams, ctx("impact-world", 3, false)) as { world: unknown };
    RIGID_BODY_NODE.evaluate({ world: w.world, geometry: crate }, { ...RIGID_BODY_NODE.defaultParams, shape: "box" }, ctx("impact-crate", 3, false));
    expect(attribute.getY(0)).toBe(0);
  });

  it("records the knocks on the face that took them", async () => {
    const { wornPool } = await import("./wornPool");
    const worn = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, ctx("impact-worn-2", 0)) as any;
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    crate.position.set(0, 3, 0);
    crate.updateMatrixWorld(true);
    applyMaterialParams(crate, worn.material);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    floor.scale.set(20, 1, 20);
    floor.position.set(0, -0.5, 0);
    floor.updateMatrixWorld(true);
    const worldParams = { ...PHYSICS_WORLD_NODE.defaultParams };
    for (let frame = 0; frame < 120; frame++) {
      const time = frame / 60;
      const w = PHYSICS_WORLD_NODE.evaluate({}, worldParams, ctx("impact-world-2", time)) as { world: unknown };
      RIGID_BODY_NODE.evaluate({ world: w.world, geometry: floor }, { ...RIGID_BODY_NODE.defaultParams, bodyType: "fixed" }, ctx("impact-floor-2", time));
      RIGID_BODY_NODE.evaluate({ world: w.world, geometry: crate }, { ...RIGID_BODY_NODE.defaultParams, shape: "box", restitution: 0 }, ctx("impact-crate-2", time));
    }
    const attribute = crate.geometry.getAttribute("aWornImpacts");
    expect(attribute.getY(0)).toBeGreaterThan(0);
    const start = attribute.getX(0);
    const data = (wornPool.edgeTexture.image as { data: Float32Array }).data;
    for (let i = 0; i < attribute.getY(0); i++) {
      const o = (start + i) * 8;
      expect(data[o + 1]).toBeCloseTo(-0.5, 1); // bottom face, rest space
      expect(data[o + 4]).toBeGreaterThan(MIN_IMPACT_SPEED); // how hard
    }
  });
});
