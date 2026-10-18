import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PARTICLES_TO_POINTS_NODE } from "./particlesToPoints";
import { PARTICLE_RENDER_INSTANCES_NODE } from "./particleInstances";
import { OBJECT_BOX_NODE, OBJECT_DISC_NODE } from "./object";
import { EvalContext } from "../types";

const CTX = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });

describe("PARTICLES_TO_POINTS_NODE", () => {
  it("returns empty lists with nothing wired", () => {
    const res = PARTICLES_TO_POINTS_NODE.evaluate({}, PARTICLES_TO_POINTS_NODE.defaultParams, CTX("p2p-a"));
    expect(res.xValues).toEqual([]);
    expect(res.yValues).toEqual([]);
    expect(res.zValues).toEqual([]);
    expect(res.points).toEqual([]);
    expect(res.count).toBe(0);
  });

  it("returns empty rather than throwing when a texture is wired but no renderer exists", () => {
    // Headless evaluation (tests, a renderer-less pass) must degrade, not crash.
    const res = PARTICLES_TO_POINTS_NODE.evaluate(
      { positions: new THREE.Texture(), count: 64 },
      PARTICLES_TO_POINTS_NODE.defaultParams,
      CTX("p2p-b"),
    );
    expect(res.count).toBe(0);
  });

  it("declares both list shapes its consumers need", () => {
    const ids = PARTICLES_TO_POINTS_NODE.outputs.map((o) => o.id);
    // x/y/z for Point Cloud and Emitter (From Points); points for Curve from Points.
    expect(ids).toEqual(expect.arrayContaining(["xValues", "yValues", "zValues", "points", "count"]));
  });
});

describe("PARTICLE_RENDER_INSTANCES_NODE", () => {
  it("builds an InstancedMesh even before a Shape is wired", () => {
    const res = PARTICLE_RENDER_INSTANCES_NODE.evaluate({}, PARTICLE_RENDER_INSTANCES_NODE.defaultParams, CTX("pri-a"));
    const mesh = res.geometry as THREE.InstancedMesh;
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
  });

  it("draws nothing when no particle texture is wired", () => {
    const res = PARTICLE_RENDER_INSTANCES_NODE.evaluate({}, PARTICLE_RENDER_INSTANCES_NODE.defaultParams, CTX("pri-b"));
    expect((res.geometry as THREE.InstancedMesh).count).toBe(0);
  });

  it("takes its geometry from the wired Shape mesh", () => {
    const shape = new THREE.Mesh(new THREE.ConeGeometry(1, 2, 8), new THREE.MeshStandardMaterial());
    const res = PARTICLE_RENDER_INSTANCES_NODE.evaluate(
      { shape, count: 16 },
      PARTICLE_RENDER_INSTANCES_NODE.defaultParams,
      CTX("pri-c"),
    );
    const mesh = res.geometry as THREE.InstancedMesh;
    // Cloned, not shared — the Shape node still owns and draws the original.
    expect(mesh.geometry).not.toBe(shape.geometry);
    expect(mesh.geometry.attributes.position.count).toBe(shape.geometry.attributes.position.count);
  });

  it("ignores a fat line wired into Shape rather than instancing its quad template", () => {
    // findFirstMesh refuses fat lines, so the node falls back to its default
    // box instead of instancing an 8-vertex template (see meshRequired.ts).
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const notALine = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    const res = PARTICLE_RENDER_INSTANCES_NODE.evaluate(
      { shape: notALine },
      PARTICLE_RENDER_INSTANCES_NODE.defaultParams,
      CTX("pri-d"),
    );
    expect(res.geometry).toBeInstanceOf(THREE.InstancedMesh);
  });

  it("applies a wired material like every other primitive node", () => {
    const res = PARTICLE_RENDER_INSTANCES_NODE.evaluate(
      { material: { color: new THREE.Color(0xff0000), roughness: 0.8 } },
      PARTICLE_RENDER_INSTANCES_NODE.defaultParams,
      CTX("pri-e"),
    );
    const mat = (res.geometry as THREE.InstancedMesh).material as THREE.MeshStandardMaterial;
    expect(mat.color.getHex()).toBe(0xff0000);
    expect(mat.roughness).toBeCloseTo(0.8);
  });

  it("instances a flat Disc lying down and double-sided, like the Disc itself", () => {
    // Disc is XY geometry laid flat only by its node's default -90° X
    // rotation and drawn DoubleSide — instancing the raw geometry with a
    // FrontSide material gave upright discs culled from behind: nothing.
    const disc = OBJECT_DISC_NODE.evaluate({}, OBJECT_DISC_NODE.defaultParams, CTX("pri-disc-src")).geometry as THREE.Mesh;
    const res = PARTICLE_RENDER_INSTANCES_NODE.evaluate(
      { shape: disc, count: 8 },
      PARTICLE_RENDER_INSTANCES_NODE.defaultParams,
      CTX("pri-disc"),
    );
    const mesh = res.geometry as THREE.InstancedMesh;
    expect((mesh.material as THREE.Material).side).toBe(THREE.DoubleSide);
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    // Lies in XZ (normal up), not XY.
    expect(size.x).toBeCloseTo(1);
    expect(size.z).toBeCloseTo(1);
    expect(size.y).toBeCloseTo(0);
    const normal = mesh.geometry.getAttribute("normal");
    expect(Math.abs(normal.getY(0))).toBeCloseTo(1);
  });

  it("bakes the Shape's rotation and scale but not its location, and rebuilds when they change", () => {
    const shape = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
    shape.position.set(5, 5, 5);
    shape.scale.set(2, 3, 1);
    const run = () =>
      PARTICLE_RENDER_INSTANCES_NODE.evaluate({ shape, count: 4 }, PARTICLE_RENDER_INSTANCES_NODE.defaultParams, CTX("pri-basis"))
        .geometry as THREE.InstancedMesh;
    const first = run();
    first.geometry.computeBoundingBox();
    const box = first.geometry.boundingBox!;
    expect(box.getCenter(new THREE.Vector3()).length()).toBeCloseTo(0);
    expect(box.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4))).toEqual([2, 3, 0]);
    shape.rotation.set(Math.PI / 2, 0, 0);
    const second = run();
    expect(second).not.toBe(first);
    second.geometry.computeBoundingBox();
    const size = second.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.y).toBeCloseTo(0);
    expect(size.z).toBeCloseTo(3);
  });

  it("keeps a closed Shape (Box) front-sided", () => {
    const box = OBJECT_BOX_NODE.evaluate({}, OBJECT_BOX_NODE.defaultParams, CTX("pri-box-src")).geometry as THREE.Mesh;
    const res = PARTICLE_RENDER_INSTANCES_NODE.evaluate({ shape: box, count: 4 }, PARTICLE_RENDER_INSTANCES_NODE.defaultParams, CTX("pri-box"));
    expect(((res.geometry as THREE.InstancedMesh).material as THREE.Material).side).toBe(THREE.FrontSide);
  });
});
