import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { clockInput, numberInput } from "./object";
import { asVector3 } from "./transform";
import {
  CapsuleMotionState,
  DEFAULT_CAPSULE_PARAMS,
  collectColliders,
  createCapsuleState,
  stepCapsule,
} from "../../three/controls/capsuleController";

interface ControllerState extends CapsuleMotionState {
  lastTime?: number;
}

const controllerCache = createNodeCache<ControllerState>();

/** Same scrub threshold the integrators and Spring use. */
const REWIND_THRESHOLD = 0.5;

/**
 * Capsule Controller — a body that walks on geometry.
 *
 * Wire a movement vector in (an Action Map's two axes composed into one, a
 * gamepad stick, anything) and a collider mesh, and get back a position that
 * stands on floors, slides along walls and falls off ledges. It is the piece
 * that turns "which way is the player pushing" into "where the player is",
 * which no combination of the existing nodes can do: an Integrate Vector
 * accumulates movement but knows nothing about the world it moves through.
 *
 * Kinematic, not rigid-body. A solver would give momentum for free at the cost
 * of exact control, and character movement is precisely where an author wants
 * exact control — this speed, this jump, no bouncing off walls, no tipping
 * over. The body is moved directly and pushed back out of anything it entered.
 *
 * The collider is any geometry: a ground plane, an imported level, a Merge of
 * both. Collision runs on the CPU against a BVH (`three-mesh-bvh`), so it costs
 * nothing on the GPU and works the same in an export as in the viewport.
 */
export const CAPSULE_CONTROLLER_NODE: NodeDefinition = {
  type: "physics/capsule-controller",
  label: "Capsule Controller",
  category: "physics",
  inputs: [
    { id: "collider", label: "Collider", type: "geometry" },
    { id: "move", label: "Move (XZ)", type: "vector" },
    { id: "jump", label: "Jump", type: "value" },
    { id: "walkSpeed", label: "Walk Speed", type: "value" },
    { id: "time", label: "Time", type: "value" },
    { id: "reset", label: "Reset", type: "value" },
  ],
  outputs: [
    { id: "position", label: "Position", type: "vector" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "grounded", label: "Grounded", type: "value" },
    { id: "velocity", label: "Velocity", type: "vector" },
    { id: "speed", label: "Speed", type: "value" },
    { id: "groundNormal", label: "Ground Normal", type: "vector" },
  ],
  defaultParams: {
    startPosition: new THREE.Vector3(0, 2, 0),
    radius: DEFAULT_CAPSULE_PARAMS.radius,
    height: DEFAULT_CAPSULE_PARAMS.height,
    walkSpeed: DEFAULT_CAPSULE_PARAMS.walkSpeed,
    acceleration: DEFAULT_CAPSULE_PARAMS.acceleration,
    friction: DEFAULT_CAPSULE_PARAMS.friction,
    gravity: DEFAULT_CAPSULE_PARAMS.gravity,
    jumpSpeed: DEFAULT_CAPSULE_PARAMS.jumpSpeed,
    maxSlope: DEFAULT_CAPSULE_PARAMS.maxSlope,
    airControl: DEFAULT_CAPSULE_PARAMS.airControl,
    iterations: DEFAULT_CAPSULE_PARAMS.iterations,
    // Falling for ever after walking off the edge of a level is a hang, not a
    // feature: below this the character is put back at its start.
    respawnBelow: -50,
    jump: 0,
    reset: 0,
  },
  paramFields: [
    { id: "startPosition", label: "Start Position", kind: "vector" },
    { id: "radius", label: "Capsule Radius", kind: "number", step: 0.05, group: "Body" },
    { id: "height", label: "Capsule Height", kind: "number", step: 0.1, group: "Body" },
    { id: "walkSpeed", label: "Walk Speed (units/s)", kind: "number", step: 0.5, group: "Movement" },
    { id: "acceleration", label: "Acceleration", kind: "number", step: 1, group: "Movement" },
    { id: "friction", label: "Ground Friction", kind: "number", step: 0.5, group: "Movement" },
    { id: "airControl", label: "Air Control (0–1)", kind: "number", step: 0.05, group: "Movement" },
    { id: "gravity", label: "Gravity", kind: "number", step: 0.5, group: "Jump & Gravity" },
    { id: "jumpSpeed", label: "Jump Speed", kind: "number", step: 0.5, group: "Jump & Gravity" },
    {
      id: "maxSlope",
      label: "Max Slope (°)",
      kind: "number",
      step: 1,
      degrees: true,
      group: "Jump & Gravity",
    },
    { id: "iterations", label: "Collision Passes", kind: "number", step: 1, group: "Solver" },
    { id: "respawnBelow", label: "Respawn Below Y", kind: "number", step: 1, group: "Solver" },
  ],
  evaluate: (inputs, params, ctx) => {
    const start = asVector3(params.startPosition, new THREE.Vector3(0, 2, 0));

    let state = controllerCache.get(ctx.nodeId);
    if (!state) {
      state = { ...createCapsuleState(start), lastTime: undefined };
      controllerCache.set(ctx.nodeId, state);
    }

    const time = clockInput(inputs, params, ctx);
    const rewound = state.lastTime !== undefined && time < state.lastTime - REWIND_THRESHOLD;
    const first = state.lastTime === undefined;
    // Clamped: one long stall (a tab in the background, a shader compile)
    // would otherwise teleport the character through a wall in a single step.
    const dt = first || rewound ? 0 : Math.min(0.1, Math.max(0, time - state.lastTime!));
    state.lastTime = time;

    const resetting = Number(inputs.reset !== undefined ? inputs.reset : params.reset) > 0.5;

    if (first || rewound || resetting) {
      // A scrub is a jump to a different point in time, and everything this
      // node holds is history — the only reproducible answer is the start.
      state.position.copy(start);
      state.velocity.set(0, 0, 0);
      state.grounded = false;
      state.groundNormal.set(0, 1, 0);
    } else {
      const colliders = collectColliders(
        inputs.collider instanceof THREE.Object3D ? inputs.collider : null,
      );

      stepCapsule(
        state,
        {
          move: asVector3(inputs.move, new THREE.Vector3()),
          jump: Number(inputs.jump !== undefined ? inputs.jump : params.jump) > 0.5,
        },
        colliders,
        {
          radius: Math.max(0.01, numberInput(undefined, params.radius, DEFAULT_CAPSULE_PARAMS.radius)),
          height: Math.max(0.02, numberInput(undefined, params.height, DEFAULT_CAPSULE_PARAMS.height)),
          walkSpeed: Math.max(0, numberInput(inputs.walkSpeed, params.walkSpeed, DEFAULT_CAPSULE_PARAMS.walkSpeed)),
          acceleration: Math.max(0, numberInput(undefined, params.acceleration, DEFAULT_CAPSULE_PARAMS.acceleration)),
          friction: Math.max(0, numberInput(undefined, params.friction, DEFAULT_CAPSULE_PARAMS.friction)),
          gravity: numberInput(undefined, params.gravity, DEFAULT_CAPSULE_PARAMS.gravity),
          jumpSpeed: numberInput(undefined, params.jumpSpeed, DEFAULT_CAPSULE_PARAMS.jumpSpeed),
          maxSlope: numberInput(undefined, params.maxSlope, DEFAULT_CAPSULE_PARAMS.maxSlope),
          airControl: numberInput(undefined, params.airControl, DEFAULT_CAPSULE_PARAMS.airControl),
          iterations: Math.max(1, Math.min(12, numberInput(undefined, params.iterations, 4))),
        },
        dt,
      );

      const floor = numberInput(undefined, params.respawnBelow, -50);
      if (state.position.y < floor) {
        state.position.copy(start);
        state.velocity.set(0, 0, 0);
      }
    }

    return {
      position: state.position.clone(),
      matrix: new THREE.Matrix4().setPosition(state.position),
      grounded: state.grounded ? 1 : 0,
      velocity: state.velocity.clone(),
      speed: Math.hypot(state.velocity.x, state.velocity.z),
      groundNormal: state.groundNormal.clone(),
    };
  },
};
