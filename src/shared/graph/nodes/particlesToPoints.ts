import * as THREE from "three";
import { NodeDefinition } from "../types";
import { readPositionsSync, textureSizeFor } from "../particleRuntime";
import { isAlive } from "./particleTrails";

function numberInput(input: unknown, param: unknown, fallback: number): number {
  const raw = input !== undefined ? input : param;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Particles to Points Node — the bridge the particle system was missing.
 *
 * Every other pairing of types in this app already meets in the x/y/z list
 * format (Point Cloud, CSV Reader, Particle Emitter (From Points), Curve from
 * Points all speak it), and particles could already be *fed* from lists — but
 * nothing read their current state back out. The one existing particles→list
 * path, Capture Trails, hands back position *history*, which answers a
 * different question. This node answers "where are they right now", and with
 * it particles reach Point Cloud, Curve from Points, Spawner, and every list
 * node, without any of those learning anything about GPU textures.
 *
 * Only live particles are emitted, using the same `age >= 0` test
 * particles/render's own vertex shader uses for `vAlive` — a texel that is
 * dead or still inside its staggered pre-spawn delay is parked at the world
 * origin with no meaningful position, and including those would put a phantom
 * cluster at (0,0,0) in whatever consumes the list.
 *
 * Costs one GPU→CPU readback per frame (the same one connect-nearby and
 * capture-trails already pay, via the same cached helper).
 */
export const PARTICLES_TO_POINTS_NODE: NodeDefinition = {
  type: "particles/to-points",
  label: "Particles to Points",
  category: "particles",
  inputs: [
    { id: "positions", label: "Positions", type: "texture" },
    { id: "count", label: "Count", type: "value" },
  ],
  outputs: [
    { id: "xValues", label: "X Values (List)", type: "list" },
    { id: "yValues", label: "Y Values (List)", type: "list" },
    { id: "zValues", label: "Z Values (List)", type: "list" },
    { id: "points", label: "Points", type: "list" },
    { id: "count", label: "Live Count", type: "value" },
  ],
  defaultParams: {},
  evaluate: (inputs, params, ctx) => {
    const empty = { xValues: [], yValues: [], zValues: [], points: [], count: 0 };

    const texture = inputs.positions instanceof THREE.Texture ? inputs.positions : null;
    // Same ceiling connect-nearby uses on its own CPU pass over the readback.
    const capacity = Math.max(0, Math.min(6000, Math.round(numberInput(inputs.count, params.count, 0))));
    if (!texture || capacity === 0 || !ctx.renderer) return empty;

    const size = textureSizeFor(capacity);
    const buffer = readPositionsSync(ctx.renderer, texture, size, ctx.nodeId);

    const xValues: number[] = [];
    const yValues: number[] = [];
    const zValues: number[] = [];
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < capacity; i++) {
      if (!isAlive(buffer[i * 4 + 3])) continue;
      const x = buffer[i * 4];
      const y = buffer[i * 4 + 1];
      const z = buffer[i * 4 + 2];
      xValues.push(x);
      yValues.push(y);
      zValues.push(z);
      points.push(new THREE.Vector3(x, y, z));
    }

    // Both shapes from one readback: the three flat lists are what Point
    // Cloud and Particle Emitter (From Points) take, `points` is what Curve
    // from Points and the vector-list nodes take. Splitting these across two
    // nodes would just mean paying the readback twice.
    return { xValues, yValues, zValues, points, count: points.length };
  },
};
