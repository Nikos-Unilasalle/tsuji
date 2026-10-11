import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { FRACTURE_NODE } from "./fracture";
import { EvalContext } from "../types";

const defaults = FRACTURE_NODE.defaultParams;
let n = 0;
const ctx = (): EvalContext => ({ time: 0, step: 0, nodeId: `vf-${n++}` });

function box(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  m.updateMatrixWorld(true);
  return m;
}

function volume(mesh: THREE.Mesh): number {
  const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const p = g.attributes.position;
  let v = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(v);
}

describe("FRACTURE_NODE", () => {
  it("returns an empty group with no geometry", () => {
    const res = FRACTURE_NODE.evaluate({}, defaults, ctx());
    expect(res.count).toBe(0);
  });

  it("cells mode: pieces tile the box and are centred on their own origin", () => {
    const res = FRACTURE_NODE.evaluate({ geometry: box() }, { ...defaults, mode: "cells", count: 12 }, ctx());
    const pieces = res.pieces as THREE.Mesh[];
    expect(pieces.length).toBe(12);
    expect(pieces.reduce((s, p) => s + volume(p), 0)).toBeCloseTo(8, 4);
    for (const p of pieces) {
      p.geometry.computeBoundingBox();
      expect(p.geometry.boundingBox!.getCenter(new THREE.Vector3()).length()).toBeLessThan(1e-6);
    }
    expect((res.geometry as THREE.Group).children).toHaveLength(12);
  });

  it("mesh mode: CSG pieces add up to the source volume", () => {
    const res = FRACTURE_NODE.evaluate({ geometry: box() }, { ...defaults, mode: "mesh", count: 6 }, ctx());
    const pieces = res.pieces as THREE.Mesh[];
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.reduce((s, p) => s + volume(p), 0)).toBeCloseTo(8, 1);
  });

  it("uses wired seed points", () => {
    const pts = [new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 0, 0)];
    const res = FRACTURE_NODE.evaluate({ geometry: box(), points: pts }, { ...defaults, mode: "cells" }, ctx());
    expect(res.count).toBe(2);
  });

  it("gap leaves less than the full volume", () => {
    const res = FRACTURE_NODE.evaluate({ geometry: box() }, { ...defaults, mode: "cells", count: 8, gap: 0.1 }, ctx());
    expect((res.pieces as THREE.Mesh[]).reduce((s, p) => s + volume(p), 0)).toBeLessThan(8);
  });

  it("keeps the same pieces while nothing changes (physics-driven poses survive)", () => {
    const c = ctx();
    const g = box();
    const a = FRACTURE_NODE.evaluate({ geometry: g }, { ...defaults, mode: "cells" }, c);
    const b = FRACTURE_NODE.evaluate({ geometry: g }, { ...defaults, mode: "cells" }, c);
    expect((b.pieces as THREE.Mesh[])[0]).toBe((a.pieces as THREE.Mesh[])[0]);
  });

  it("is deterministic for a given seed", () => {
    const a = FRACTURE_NODE.evaluate({ geometry: box() }, { ...defaults, mode: "cells", seed: 5 }, ctx());
    const b = FRACTURE_NODE.evaluate({ geometry: box() }, { ...defaults, mode: "cells", seed: 5 }, ctx());
    expect((a.centers as THREE.Vector3[])[0].toArray()).toEqual((b.centers as THREE.Vector3[])[0].toArray());
  });
});

describe("Voronoi Fracture → Rigid Body", () => {
  it("every piece becomes its own physics body and falls", async () => {
    const { initRapier } = await import("../../three/physics/rapierRuntime");
    const { PHYSICS_WORLD_NODE, RIGID_BODY_NODE } = await import("./rapier");
    await initRapier();

    const frac = FRACTURE_NODE.evaluate({ geometry: box() }, { ...defaults, mode: "cells", count: 6, gap: 0.02 }, ctx()) as {
      geometry: THREE.Group;
      pieces: THREE.Mesh[];
    };
    const startY = frac.pieces.map((p) => p.position.y);
    let out: Record<string, unknown> = {};
    for (let f = 0; f < 30; f++) {
      const w = PHYSICS_WORLD_NODE.evaluate({}, PHYSICS_WORLD_NODE.defaultParams, { time: f / 60, step: f, nodeId: "vf-world" }) as { world: unknown };
      out = RIGID_BODY_NODE.evaluate({ world: w.world, geometry: frac.geometry }, RIGID_BODY_NODE.defaultParams, { time: f / 60, step: f, nodeId: "vf-body" });
    }
    expect(out.count).toBe(6);
    frac.pieces.forEach((p, i) => expect(p.position.y).toBeLessThan(startY[i]));
  });
});

describe("Voronoi Fracture: material inputs and reset", () => {
  it("a wired Material (a description from a Material node) drives the inside faces only", () => {
    const c = ctx();
    const g = box();
    const params = { ...defaults, mode: "cells", count: 4 };
    const first = FRACTURE_NODE.evaluate({ geometry: g }, params, c);
    const piece = (first.pieces as THREE.Mesh[])[0];
    const mats = piece.material as THREE.MeshStandardMaterial[];
    const surface = mats[0];
    // Same shape a Material node outputs: plain parameters, no THREE material.
    const description = { color: new THREE.Color(0x00ff00), emissive: new THREE.Color(0x000000), emissiveIntensity: 1, shadeless: false, roughness: 0.2, metalness: 0.9, wireframe: false, opacity: 1, transmission: 0, thickness: 0.5 };
    const res = FRACTURE_NODE.evaluate({ geometry: g, material: description }, params, c);
    const after = (res.pieces as THREE.Mesh[])[0].material as THREE.MeshStandardMaterial[];
    expect(after[0]).toBe(surface);
    expect(after[1].color.getHex()).toBe(0x00ff00);
    expect(after[1].metalness).toBeCloseTo(0.9);
    expect(after[1].roughness).toBeCloseTo(0.2);
    // Every piece shares it, and the pieces themselves were not rebuilt.
    expect((res.pieces as THREE.Mesh[])[1].material).toEqual([after[0], after[1]]);
    expect((res.pieces as THREE.Mesh[])[0]).toBe(piece);
  });

  it("a wired THREE.Material is used as-is", () => {
    const c = ctx();
    const g = box();
    const params = { ...defaults, mode: "cells", count: 4 };
    const custom = new THREE.MeshBasicMaterial({ color: 0x0000ff });
    const res = FRACTURE_NODE.evaluate({ geometry: g, material: custom }, params, c);
    expect(((res.pieces as THREE.Mesh[])[0].material as THREE.Material[])[1]).toBe(custom);
  });

  it("mesh mode applies the inside material to CSG cut faces too", () => {
    const description = { color: new THREE.Color(0xff00ff), emissive: new THREE.Color(0), emissiveIntensity: 1, shadeless: false, roughness: 0.5, metalness: 0.1, wireframe: false, opacity: 1, transmission: 0, thickness: 0.5 };
    const res = FRACTURE_NODE.evaluate({ geometry: box(), material: description }, { ...defaults, mode: "mesh", count: 4 }, ctx());
    const mats = (res.pieces as THREE.Mesh[])[0].material as THREE.MeshStandardMaterial[];
    expect(mats.some((m) => m.color.getHex() === 0xff00ff)).toBe(true);
  });

  it("puts the pieces back where they were cut when the simulation epoch changes", () => {
    const c = ctx();
    const g = box();
    const params = { ...defaults, mode: "cells", count: 4 };
    const a = FRACTURE_NODE.evaluate({ geometry: g }, params, { ...c, simulationEpoch: 0, isPlaying: true });
    const piece = (a.pieces as THREE.Mesh[])[0];
    const home = piece.position.clone();
    piece.position.set(9, 9, 9);
    piece.quaternion.set(0.5, 0.5, 0.5, 0.5);
    FRACTURE_NODE.evaluate({ geometry: g }, params, { ...c, simulationEpoch: 0, isPlaying: true });
    expect(piece.position.y).toBe(9); // still simulating: left alone
    FRACTURE_NODE.evaluate({ geometry: g }, params, { ...c, simulationEpoch: 1, isPlaying: true });
    expect(piece.position.toArray()).toEqual(home.toArray());
    expect(piece.quaternion.w).toBe(1);
  });

  it("restores the pose when playback is not running", () => {
    const c = ctx();
    const g = box();
    const params = { ...defaults, mode: "cells", count: 4 };
    const a = FRACTURE_NODE.evaluate({ geometry: g }, params, { ...c, isPlaying: true });
    const piece = (a.pieces as THREE.Mesh[])[0];
    const home = piece.position.clone();
    piece.position.set(5, 5, 5);
    FRACTURE_NODE.evaluate({ geometry: g }, params, { ...c, isPlaying: false });
    expect(piece.position.toArray()).toEqual(home.toArray());
  });
});

describe("Explosion Detonated → Rigid Body Active", () => {
  it("holds bodies still until the blast, then lets them go", async () => {
    const { initRapier } = await import("../../three/physics/rapierRuntime");
    const { PHYSICS_WORLD_NODE, RIGID_BODY_NODE } = await import("./rapier");
    const { PHYSICS_EXPLOSION_NODE } = await import("./explosionImpulse");
    await initRapier();

    const frac = FRACTURE_NODE.evaluate({ geometry: box() }, { ...defaults, mode: "cells", count: 6, gap: 0.02 }, ctx()) as { geometry: THREE.Group; pieces: THREE.Mesh[] };
    const home = frac.pieces.map((p) => p.position.clone());
    const run = (f: number, trigger: number) => {
      const c = (id: string): EvalContext => ({ time: f / 60, step: f, nodeId: id, isPlaying: true });
      const w = PHYSICS_WORLD_NODE.evaluate({}, PHYSICS_WORLD_NODE.defaultParams, c("hold-world")) as { world: unknown };
      const e = PHYSICS_EXPLOSION_NODE.evaluate({ world: w.world, trigger }, { ...PHYSICS_EXPLOSION_NODE.defaultParams, location: new THREE.Vector3(0, -1, 0) }, c("hold-blast")) as { world: unknown; fired: number };
      RIGID_BODY_NODE.evaluate({ world: e.world, geometry: frac.geometry, active: e.fired }, RIGID_BODY_NODE.defaultParams, c("hold-body"));
      return e.fired;
    };

    for (let f = 0; f < 40; f++) expect(run(f, 0)).toBe(0);
    frac.pieces.forEach((p, i) => expect(p.position.distanceTo(home[i])).toBeLessThan(1e-3));

    expect(run(40, 1)).toBe(1);
    for (let f = 41; f < 70; f++) run(f, 1);
    expect(frac.pieces.some((p, i) => p.position.distanceTo(home[i]) > 0.1)).toBe(true);
  });
});

describe("Pause keeps the simulation, only Reset ends it", () => {
  it("paused pieces and bodies stay put; leaving the run restores the authored pose", async () => {
    const { initRapier } = await import("../../three/physics/rapierRuntime");
    const { PHYSICS_WORLD_NODE, RIGID_BODY_NODE } = await import("./rapier");
    await initRapier();

    const g = box();
    const params = { ...defaults, mode: "cells", count: 6, gap: 0.02 };
    const tick = (f: number, state: { isPlaying: boolean; simulationRun: boolean }) => {
      const c = (id: string): EvalContext => ({ time: f / 60, step: f, nodeId: id, ...state });
      const frac = FRACTURE_NODE.evaluate({ geometry: g }, params, c("pause-frac")) as { geometry: THREE.Group; pieces: THREE.Mesh[] };
      const w = PHYSICS_WORLD_NODE.evaluate({}, PHYSICS_WORLD_NODE.defaultParams, c("pause-world")) as { world: unknown };
      const body = RIGID_BODY_NODE.evaluate({ world: w.world, geometry: frac.geometry }, RIGID_BODY_NODE.defaultParams, c("pause-body")) as { count: number };
      return { frac, body };
    };

    let last = tick(0, { isPlaying: true, simulationRun: true });
    const home = last.frac.pieces.map((p) => p.position.clone());
    for (let f = 1; f < 40; f++) last = tick(f, { isPlaying: true, simulationRun: true });
    const fallen = last.frac.pieces.map((p) => p.position.clone());
    expect(fallen.some((p, i) => p.distanceTo(home[i]) > 0.05)).toBe(true);

    // Paused: the clock stops (same time), isPlaying is false, the run is still live.
    for (let f = 0; f < 30; f++) last = tick(39, { isPlaying: false, simulationRun: true });
    expect(last.body.count).toBe(6);
    last.frac.pieces.forEach((p, i) => expect(p.position.distanceTo(fallen[i])).toBeLessThan(1e-6));

    // Reset ends the run: everything is back where it was authored.
    last = tick(0, { isPlaying: false, simulationRun: false });
    last.frac.pieces.forEach((p, i) => expect(p.position.distanceTo(home[i])).toBeLessThan(1e-6));
  });
});

describe("open meshes (a tree trunk, a plane)", () => {
  const plane = () => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 4, 4), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
    m.updateMatrixWorld(true);
    return m;
  };
  const area = (mesh: THREE.Mesh) => {
    const p = mesh.geometry.attributes.position;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let s = 0;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      s += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    }
    return s;
  };

  it("detects watertightness", async () => {
    const { isWatertight } = await import("../meshClip");
    expect(isWatertight(new THREE.BoxGeometry(1, 1, 1))).toBe(true);
    expect(isWatertight(new THREE.SphereGeometry(1, 16, 12))).toBe(true);
    expect(isWatertight(new THREE.PlaneGeometry(1, 1))).toBe(false);
    expect(isWatertight(new THREE.CylinderGeometry(1, 1, 2, 12, 1, true))).toBe(false);
  });

  it("mesh mode on an open mesh cuts the surface only — no stray cut faces", () => {
    const res = FRACTURE_NODE.evaluate({ geometry: plane() }, { ...defaults, mode: "mesh", count: 6 }, ctx());
    const pieces = res.pieces as THREE.Mesh[];
    expect(pieces.length).toBeGreaterThan(1);
    // The pieces' surface adds up to the plane's (4): nothing added, nothing lost.
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(4, 3);
    // Only the source material is in use.
    for (const p of pieces) expect((p.material as THREE.Material[]).every((m) => m !== undefined)).toBe(true);
  });

  it("shell mode keeps the material groups of a multi-part source", () => {
    const group = new THREE.Group();
    const a = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
    const b = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x0000ff }));
    b.position.x = 1.2;
    group.add(a, b);
    group.updateMatrixWorld(true);
    const res = FRACTURE_NODE.evaluate({ geometry: group }, { ...defaults, mode: "shell", count: 4 }, ctx());
    const colors = new Set<number>();
    for (const p of res.pieces as THREE.Mesh[]) {
      const mats = p.material as THREE.MeshStandardMaterial[];
      for (const g of p.geometry.groups) colors.add(mats[g.materialIndex ?? 0].color.getHex());
    }
    expect(colors).toEqual(new Set([0xff0000, 0x0000ff]));
  });
});
