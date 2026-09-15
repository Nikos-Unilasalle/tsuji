import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import { toBoolean } from "../sockets";
import { getRapier, isPhysicsWorld, isRapierReady } from "../../three/physics/rapierRuntime";

interface ImpulseState {
  prevTrigger: boolean;
  lastHits: number;
  lastTime: number;
}

const impulseCache = createNodeCache<ImpulseState>();

/** The original's remapClamp: value in [low, high] mapped onto [toLow, toHigh], clamped. */
function remapClamp(value: number, low: number, high: number, toLow: number, toHigh: number): number {
  if (high === low) return toLow;
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return toLow + t * (toHigh - toLow);
}

export interface BlastSettings {
  radius: number;
  strength: number;
  innerRadius: number;
  lift: number;
}

/**
 * The impulse one body takes from a blast, or null when it is out of range.
 *
 * A port of the body of `applyPhysicsExplosion` in Explosions.js, kept apart from the node so it
 * can be exercised without rapier — the engine is WebAssembly and never loads under test.
 */
export function blastImpulse(
  bodyPosition: THREE.Vector3,
  centre: THREE.Vector3,
  mass: number,
  settings: BlastSettings,
): THREE.Vector3 | null {
  // Flattened to the horizontal, exactly as the original: how far a body is thrown depends on
  // its distance across the ground, not on how high above the blast it happens to sit.
  const direction = new THREE.Vector3().subVectors(bodyPosition, centre);
  direction.y = 0;
  const distance = Math.hypot(direction.x, direction.z);

  const fadedStrength = remapClamp(distance, settings.innerRadius, settings.radius, 1, 0);
  if (fadedStrength <= 0) return null;

  // A body sitting exactly on the blast point has no direction to be thrown in: it goes straight
  // up rather than nowhere.
  const impulse = distance < 1e-4
    ? new THREE.Vector3(0, 1, 0)
    : direction.setLength(settings.lift).setY(1).normalize();

  return impulse.multiplyScalar(fadedStrength * settings.strength * mass);
}

/**
 * Explosion Impulse — the physics half of brunosimon/folio-2025's explosions
 * (sources/Game/Explosions.js), which kicks every dynamic body away from a point.
 *
 * The `world` socket is passed straight through so this can sit between Physics World and the
 * bodies it kicks: the impulse has to be applied to a world that already exists, and threading
 * it through the graph is how evaluation order is expressed here.
 */
export const PHYSICS_EXPLOSION_NODE: NodeDefinition = {
  type: "physics/explosion",
  label: "Explosion Impulse",
  category: "physics",
  inputs: [
    { id: "world", label: "World", type: "any" },
    { id: "trigger", label: "Trigger", type: "value" },
    { id: "location", label: "Location", type: "vector" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "strength", label: "Strength", type: "value" },
  ],
  outputs: [
    { id: "world", label: "World", type: "any" },
    { id: "hits", label: "Bodies Hit", type: "value" },
  ],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 0),
    radius: 5,
    strength: 8,
    innerRadius: 1,
    lift: 0.5,
  },
  paramFields: [
    { id: "location", label: "Location", kind: "vector" },
    { id: "radius", label: "Radius", kind: "number", step: 0.5 },
    { id: "strength", label: "Strength", kind: "number", step: 0.5 },
    { id: "innerRadius", label: "Full Strength Radius", kind: "number", step: 0.1 },
    {
      id: "lift",
      label: "Sideways / Up Ratio",
      kind: "number",
      step: 0.05,
    },
    {
      id: "liftNote",
      label:
        "The original flattens the blast to the horizontal, then adds a full unit of up before " +
        "normalising: at 0.5 a body is thrown out at about 63 degrees. Lower it to skim them " +
        "along the ground, raise it to shove them sideways.",
      kind: "note",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const handle = isPhysicsWorld(inputs.world) ? inputs.world : null;
    const passthrough = inputs.world ?? null;

    let state = impulseCache.get(ctx.nodeId);
    if (!state) {
      state = { prevTrigger: false, lastHits: 0, lastTime: ctx.time };
      impulseCache.set(ctx.nodeId, state);
    }

    const trigger = toBoolean(inputs.trigger);
    // Scrubbing backwards re-arms the edge, so replaying the timeline explodes again instead of
    // staying silent because the trigger was already high when the playhead jumped.
    if (ctx.time < state.lastTime) state.prevTrigger = false;
    state.lastTime = ctx.time;

    const fired = trigger && !state.prevTrigger;
    state.prevTrigger = trigger;

    if (!fired || !handle || !getRapier() || !isRapierReady()) {
      return { world: passthrough, hits: fired ? 0 : state.lastHits };
    }

    const centre = asVector3(inputs.location, asVector3(params.location, new THREE.Vector3()));
    const radius = Math.max(0.001, numberInput(inputs.radius, params.radius, 5));
    const strength = numberInput(inputs.strength, params.strength, 8);
    const innerRadius = Math.max(0, numberInput(undefined, params.innerRadius, 1));
    const lift = Math.max(0, numberInput(undefined, params.lift, 0.5));

    const settings: BlastSettings = { radius, strength, innerRadius, lift };
    const position = new THREE.Vector3();
    let hits = 0;

    // Straight from rapier's own set, not from the world handle's `bodies` map: that map holds
    // one entry per Rigid Body *node* (its first body), so a node standing for a whole Array of
    // crates would contribute a single crate and the rest of the grid would sit there unmoved.
    for (const body of handle.world.bodies.getAll()) {
      if (!body.isDynamic() || !body.isEnabled()) continue;

      const translation = body.translation();
      position.set(translation.x, translation.y, translation.z);

      const impulse = blastImpulse(position, centre, body.mass(), settings);
      if (!impulse) continue;

      body.applyImpulseAtPoint(impulse, position, true);
      hits++;
    }

    state.lastHits = hits;
    return { world: passthrough, hits };
  },
};
