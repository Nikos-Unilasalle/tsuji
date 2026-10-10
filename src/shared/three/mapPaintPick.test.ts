import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { pickMapPaintHit } from "./mapPaintPick";
import { DEFAULT_REGISTRY } from "../graph/nodes";
import {
  MAP_ELEVATION_NODE,
  MAP_MESH_NODE,
  MAP_TO_TEXTURES_NODE,
} from "../graph/nodes/mapGen";
import { MAP_PAINT_NODE, commitMapPaint, getMapPaintState, paintDab } from "../graph/nodes/mapPaint";
import { TERRAIN_NODE } from "../graph/nodes/terrain";

/** A camera straight above (x, z) looking down, and the NDC of the screen centre. */
function overhead(x: number, z: number): { camera: THREE.PerspectiveCamera; ndc: THREE.Vector2 } {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  camera.position.set(x, 60, z);
  camera.up.set(0, 0, -1);
  camera.lookAt(x, 0, z);
  camera.updateMatrixWorld(true);
  return { camera, ndc: new THREE.Vector2(0, 0) };
}

const ctx = (id: string) => ({ time: 0, step: 0, nodeId: id });
const P = (n: { defaultParams: Record<string, unknown> }, o: Record<string, unknown> = {}) => ({ ...n.defaultParams, ...o });

describe("pickMapPaintHit", () => {
  it("falls back to the ground plane using the node's footprint", () => {
    const { camera, ndc } = overhead(10, -10);
    const hit = pickMapPaintHit(new THREE.Raycaster(), camera, ndc, null, { params: { width: 40, depth: 40 } });
    expect(hit).not.toBeNull();
    // x = 10 / 40 + 0.5, y = -10 / 40 + 0.5
    expect(hit!.x).toBeCloseTo(0.75, 3);
    expect(hit!.y).toBeCloseTo(0.25, 3);
    expect(hit!.worldWidth).toBe(40);
  });

  it("misses when the cursor is off the map", () => {
    const { camera, ndc } = overhead(100, 100);
    expect(pickMapPaintHit(new THREE.Raycaster(), camera, ndc, null, { params: { width: 40, depth: 40 } })).toBeNull();
  });

  it("aims at a Terrain mesh and reads its own footprint, location and scale", () => {
    const geo = new THREE.PlaneGeometry(20, 20, 4, 4);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.userData = { isTerrain: true, terrainConfig: { width: 20, depth: 20 } };
    mesh.position.set(100, 3, 50);
    mesh.scale.set(2, 1, 2);
    mesh.updateMatrixWorld(true);

    // The terrain is 40 wide in the world (20 × scale 2) and centred on (100, 50); aim 10 east and 10 north of centre.
    const { camera, ndc } = overhead(110, 40);
    const results = new Map<string, Record<string, unknown>>([["t", { geometry: mesh }]]);
    const hit = pickMapPaintHit(new THREE.Raycaster(), camera, ndc, results, { params: { width: 999, depth: 999 } });
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(0.75, 3);
    expect(hit!.y).toBeCloseTo(0.25, 3);
    expect(hit!.worldWidth).toBeCloseTo(40, 5);
    expect(hit!.point.y).toBeCloseTo(3, 3);
  });

  it("paint dropped where the cursor points shows up at that spot on the real Terrain", () => {
    // Map chain with a flat-ish baseline so the effect of one stroke is unambiguous.
    const mesh = MAP_MESH_NODE.evaluate({}, P(MAP_MESH_NODE, { spacing: 0.02 }), ctx("pk-mesh"));
    const paint = MAP_PAINT_NODE.evaluate({}, P(MAP_PAINT_NODE), ctx("pk-paint")).paint as THREE.Texture;
    const build = (tag: string) => {
      const e = MAP_ELEVATION_NODE.evaluate({ map: mesh.map, paint }, P(MAP_ELEVATION_NODE, { island: 0 }), ctx(`pk-e-${tag}`));
      const t = MAP_TO_TEXTURES_NODE.evaluate({ map: e.map }, P(MAP_TO_TEXTURES_NODE, { resolution: "256" }), ctx(`pk-t-${tag}`));
      const out = TERRAIN_NODE.evaluate(
        { heightmap: t.heightmap },
        P(TERRAIN_NODE, { resolution: "128x128", width: 40, depth: 40, heightScale: 6, slopeShading: false }),
        ctx("pk-terrain"),
      );
      const terrain = out.geometry as THREE.Mesh;
      terrain.updateMatrixWorld(true);
      return terrain;
    };
    const heightAt = (terrain: THREE.Mesh, wx: number, wz: number): number => {
      const ray = new THREE.Raycaster(new THREE.Vector3(wx, 100, wz), new THREE.Vector3(0, -1, 0));
      return ray.intersectObject(terrain, false)[0]?.point.y ?? NaN;
    };

    const before = build("a");
    expect(before.userData.isTerrain).toBe(true);
    const baseline = heightAt(before, -10, 10);
    // The Terrain node reuses its mesh, so read the far-away reference now, before painting rebuilds it.
    const farBefore = heightAt(before, 15, -15);

    // Aim at world (-10, 10), exactly as the viewport would, then paint there.
    const { camera, ndc } = overhead(-10, 10);
    const results = new Map<string, Record<string, unknown>>([["t", { geometry: before }]]);
    const hit = pickMapPaintHit(new THREE.Raycaster(), camera, ndc, results, { params: {} });
    expect(hit).not.toBeNull();
    const state = getMapPaintState("pk-paint", 256, "");
    for (let i = 0; i < 12; i++) {
      paintDab(state, { x: hit!.x, y: hit!.y, radius: 0.06, strength: 1, tool: "raise", falloff: "smooth" });
    }
    commitMapPaint(state);

    const after = build("b");
    expect(heightAt(after, -10, 10)).toBeGreaterThan(baseline + 0.3);
    // ...and far from the stroke nothing moved.
    expect(heightAt(after, 15, -15)).toBeCloseTo(farBefore, 1);
  });

  it("is registered", () => {
    expect(DEFAULT_REGISTRY.get("map/paint")).toBeDefined();
  });
});
