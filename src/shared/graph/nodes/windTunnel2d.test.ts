import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { WIND_TUNNEL_2D_NODE, windTunnelState } from "./windTunnel2d";
import { chainSegments, isClosed, rasterise, sliceObject, TunnelFrame } from "../../three/fluid/tunnelSection";

const frameX: TunnelFrame = {
  origin: new THREE.Vector3(0, 0, 0),
  flow: new THREE.Vector3(0, 0, 1),
  up: new THREE.Vector3(0, 1, 0),
  normal: new THREE.Vector3(1, 0, 0),
};

describe("tunnel section", () => {
  test("a cylinder along the slice normal cuts into one closed loop, filled by the raster", () => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 4, 48).rotateZ(Math.PI / 2));
    const segs = sliceObject(mesh, frameX, (o) => o.matrixWorld);
    const chains = chainSegments(segs, 1e-7);
    expect(chains).toHaveLength(1);
    expect(isClosed(chains[0], 1e-7)).toBe(true);
    const grid = { nx: 40, ny: 40, x0: -1, y0: -1, dx: 0.05 };
    const mask = rasterise(chains, grid, 0.5, 1e-7);
    const filled = mask.reduce((a, b) => a + b, 0);
    // π r² / dx² ≈ 314 cells, plus the stroke.
    expect(filled).toBeGreaterThan(300);
    expect(filled).toBeLessThan(420);
    expect(mask[20 * 40 + 20]).toBe(1);
  });

  test("a thin plate cuts into one open line, stroked without diagonal gaps", () => {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(4, 1, 8, 7).rotateX(-Math.PI / 2).rotateX(0.3));
    const chains = chainSegments(sliceObject(plate, frameX, (o) => o.matrixWorld), 1e-7);
    expect(chains).toHaveLength(1);
    expect(isClosed(chains[0], 1e-7)).toBe(false);
    const grid = { nx: 60, ny: 40, x0: -1.5, y0: -1, dx: 0.05 };
    const mask = rasterise(chains, grid, 0, 1e-7);
    // No cell is only diagonally connected to the rest of the stroke.
    for (let j = 1; j < 39; j++) for (let i = 1; i < 59; i++) {
      const c = j * 60 + i;
      if (!mask[c]) continue;
      const side = mask[c - 1] + mask[c + 1] + mask[c - 60] + mask[c + 60];
      expect(side).toBeGreaterThan(0);
    }
  });
});

describe("Wind Tunnel 2D node (CPU)", () => {
  const plate = () => new THREE.Mesh(new THREE.PlaneGeometry(4, 1, 4, 16).rotateX(-Math.PI / 2));
  const run = (id: string, angle: number, frames: number) => {
    const obstacle = plate();
    const params = { ...WIND_TUNNEL_2D_NODE.defaultParams, angle, reynolds: 500, cellsPerChord: 24, stepsPerFrame: 8, tracerCount: 50, showStreamlines: true };
    let out: Record<string, unknown> = {};
    for (let f = 0; f < frames; f++) {
      out = WIND_TUNNEL_2D_NODE.evaluate({ obstacle }, params, { time: f / 60, step: f, nodeId: id } as EvalContext) as Record<string, unknown>;
    }
    return out;
  };

  test("a flat plate at 8° lifts and drags; at 0° it does not lift", () => {
    const up = run("wt-8", 8, 400);
    const flat = run("wt-0", 0, 400);
    expect(up.chord as number).toBeCloseTo(1, 6);
    expect(up.cl as number).toBeGreaterThan(0.3);
    expect(up.cd as number).toBeGreaterThan(0.05);
    expect(Math.abs(flat.cl as number)).toBeLessThan(0.1);
    expect(up.cl as number).toBeGreaterThan((flat.cl as number) + 0.3);
    // Airspeed for Re 500 on a 1 cm chord in air.
    expect(up.airspeed as number).toBeCloseTo((500 * 1.5e-5) / 0.01, 9);
    expect((up.streamlines as unknown[]).length).toBeGreaterThan(10);
    expect((up.section as unknown[]).length).toBe(1);
    const g = up.geometry as THREE.Group;
    expect(g).toBeInstanceOf(THREE.Group);
    expect(windTunnelState("wt-8")!.slices[0].backend).toBe("cpu");
  }, 60_000);

  test("Compute runs the flow to a settled state in one evaluation, without playing", () => {
    const obstacle = plate();
    const params = { ...WIND_TUNNEL_2D_NODE.defaultParams, angle: 8, reynolds: 500, cellsPerChord: 24, tracerCount: 50 };
    const ctx = { time: 0, step: 0, nodeId: "wt-compute" } as EvalContext;
    WIND_TUNNEL_2D_NODE.evaluate({ obstacle }, params, ctx) as Record<string, unknown>;
    const stepsBefore = windTunnelState("wt-compute")!.slices[0].sim!.steps;
    const after = WIND_TUNNEL_2D_NODE.evaluate({ obstacle }, { ...params, computeRequest: 1 }, ctx) as Record<string, unknown>;
    // 8 chords of air: 8 × 24 cells / 0.08 cells per step.
    expect(windTunnelState("wt-compute")!.slices[0].sim!.steps - stepsBefore).toBe(2400);
    expect(after.cl as number).toBeGreaterThan(0.3);
    // Same request again: nothing more to compute.
    WIND_TUNNEL_2D_NODE.evaluate({ obstacle }, { ...params, computeRequest: 1 }, ctx);
    expect(windTunnelState("wt-compute")!.slices[0].sim!.steps - stepsBefore).toBe(2400);
  }, 60_000);

  test("display checkboxes follow the 1 / 0 the param panel writes", () => {
    const obstacle = plate();
    const base = { ...WIND_TUNNEL_2D_NODE.defaultParams, cellsPerChord: 16, tracerCount: 20 };
    const ctx = { time: 0, step: 0, nodeId: "wt-flags" } as EvalContext;
    const parts = () => {
      const st = windTunnelState("wt-flags")!.slices[0];
      return [st.fieldMesh, st.tracers, st.streamLines, st.pressureBars, st.liftArrow].map((o) => o.visible);
    };
    const on = { showField: 1, showTracers: 1, showStreamlines: 1, showPressure: 1, showForces: 1 };
    const off = { showField: 0, showTracers: 0, showStreamlines: 0, showPressure: 0, showForces: 0 };
    WIND_TUNNEL_2D_NODE.evaluate({ obstacle }, { ...base, ...on }, ctx);
    expect(parts()).toEqual([true, true, true, true, true]);
    WIND_TUNNEL_2D_NODE.evaluate({ obstacle }, { ...base, ...off }, ctx);
    expect(parts()).toEqual([false, false, false, false, false]);
  });

  test("several slices: one flow each, per-slice lists, chord-weighted totals, lift curve", () => {
    // A trapezoid wing along X: chord 1 at x = -2, 0.5 at x = +2.
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-2, 0, -0.5, -2, 0, 0.5, 2, 0, 0.25, -2, 0, -0.5, 2, 0, 0.25, 2, 0, -0.25], 3));
    const obstacle = new THREE.Mesh(g);
    const params = {
      ...WIND_TUNNEL_2D_NODE.defaultParams, sliceCount: 3, stationFrom: -1, stationTo: 1, angle: 8,
      reynolds: 400, cellsPerChord: 20, computeRequest: 1, tracerCount: 0,
    };
    const ctx = { time: 0, step: 0, nodeId: "wt-multi" } as EvalContext;
    // As the evaluator does: an unwired input receives the param of the same id.
    const fallback = { station: 0, angle: params.angle, reynolds: params.reynolds };
    WIND_TUNNEL_2D_NODE.evaluate({ obstacle, ...fallback }, { ...params, computeRequest: 0 }, ctx);
    const out = WIND_TUNNEL_2D_NODE.evaluate({ obstacle, ...fallback }, params, ctx) as Record<string, unknown>;
    const st = windTunnelState("wt-multi")!;
    expect(st.slices).toHaveLength(3);
    expect(out.stations).toEqual([-1, 0, 1]);
    const chords = st.slices.map((s) => s.chord);
    expect(chords[0]).toBeCloseTo(0.875, 6);
    expect(chords[2]).toBeCloseTo(0.625, 6);
    // Same airspeed: Re follows the local chord, the set value is the mean chord's.
    const re = st.slices.map((s) => s.sim!.reynolds);
    expect(re[0] / re[2]).toBeCloseTo(0.875 / 0.625, 6);
    expect(re[1]).toBeCloseTo(400, 6);
    const cls = out.clPerSlice as number[];
    expect(cls).toHaveLength(3);
    for (const c of cls) expect(c).toBeGreaterThan(0.2);
    const weighted = cls.reduce((s, c, i) => s + c * chords[i], 0) / chords.reduce((s, c) => s + c, 0);
    expect(out.cl as number).toBeCloseTo(weighted, 9);
    expect(out.liftCurve as unknown[]).toHaveLength(3);
    // Fewer slices: the extra ones are let go.
    WIND_TUNNEL_2D_NODE.evaluate({ obstacle }, { ...params, sliceCount: 2 }, ctx);
    expect(windTunnelState("wt-multi")!.slices).toHaveLength(2);
    expect(windTunnelState("wt-multi")!.group.children.filter((c) => c.type === "Group")).toHaveLength(2);
  }, 60_000);

  test("a list wired into Station gives one slice per value; same-Reynolds mode keeps the number set", () => {
    const obstacle = plate();
    const params = { ...WIND_TUNNEL_2D_NODE.defaultParams, reynoldsMode: "reynolds", reynolds: 300, cellsPerChord: 16, tracerCount: 0 };
    const out = WIND_TUNNEL_2D_NODE.evaluate({ obstacle, stations: [-1.5, 0.2, 1.1, 1.8] }, params, { time: 0, step: 0, nodeId: "wt-list" } as EvalContext) as Record<string, unknown>;
    expect(out.stations).toEqual([-1.5, 0.2, 1.1, 1.8]);
    const st = windTunnelState("wt-list")!;
    expect(st.slices).toHaveLength(4);
    for (const s of st.slices) expect(s.sim!.reynolds).toBe(300);
  });

  test("no obstacle: hidden, zero outputs", () => {
    const out = WIND_TUNNEL_2D_NODE.evaluate({}, WIND_TUNNEL_2D_NODE.defaultParams, { time: 0, step: 0, nodeId: "wt-none" } as EvalContext) as Record<string, unknown>;
    expect((out.geometry as THREE.Object3D).visible).toBe(false);
    expect(out.cl).toBe(0);
  });
});
