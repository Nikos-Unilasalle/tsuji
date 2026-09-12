import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition, ParamFieldDef } from "../types";
import { asColor, numberInput } from "./object";
import { asVector3 } from "./transform";
import { toBoolean } from "../sockets";
import { resolveWind } from "./vegetation";
import {
  LeavesState,
  createLeafGeometry,
  seedLeaves,
  stepLeaves,
  writeLeafColors,
  writeLeafMatrices,
} from "../../three/vegetation/leaves";
import { GroundHeightField, bakeGroundHeight, groundSignature } from "../../three/vegetation/groundHeight";

interface LeavesNodeState {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  sim: LeavesState;
  signature: string;
  lastTime: number;
  prevBlast: boolean;
  ground?: GroundHeightField;
  colorSignature?: string;
}

const leavesCache = createNodeCache<LeavesNodeState>((state) => {
  state.mesh.geometry.dispose();
  state.material.dispose();
  state.ground?.texture.dispose();
});

/** The same scrub threshold the physics and integrator nodes use. */
const REWIND_THRESHOLD = 0.5;

const LEAVES_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "count", label: "Count", kind: "number", step: 128, group: "Field" },
  { id: "size", label: "Field Size (wrap square)", kind: "number", step: 1, group: "Field" },
  { id: "seed", label: "Seed", kind: "number", step: 1, group: "Field" },
  { id: "scale", label: "Leaf Scale", kind: "number", step: 0.01, group: "Field" },
  { id: "groundResolution", label: "Ground Height Samples (n²)", kind: "number", step: 32, group: "Field" },

  { id: "windMultiplier", label: "Wind Multiplier", kind: "number", step: 0.1, group: "Motion" },
  { id: "upwardMultiplier", label: "Upward Multiplier", kind: "number", step: 0.05, group: "Motion" },
  { id: "gravity", label: "Sink Rate", kind: "number", step: 0.1, group: "Motion" },
  { id: "damping", label: "Damping", kind: "number", step: 0.05, group: "Motion" },
  { id: "floorOffset", label: "Floor Offset", kind: "number", step: 0.01, group: "Motion" },
  { id: "rotationFrequency", label: "Tumble Frequency", kind: "number", step: 0.1, group: "Motion" },
  { id: "rotationElevation", label: "Tumble with Height", kind: "number", step: 0.05, group: "Motion" },

  { id: "pushMultiplier", label: "Push (mover's velocity)", kind: "number", step: 5, group: "Push" },
  { id: "pushSidewaysMultiplier", label: "Push (out of the way)", kind: "number", step: 1, group: "Push" },

  { id: "blastRadius", label: "Blast Radius", kind: "number", step: 0.5, group: "Blast" },
  { id: "blastStrength", label: "Blast Strength", kind: "number", step: 1, group: "Blast" },

  { id: "colorA", label: "Colour A", kind: "color", group: "Look" },
  { id: "colorB", label: "Colour B", kind: "color", group: "Look" },
  { id: "roughness", label: "Roughness", kind: "number", step: 0.05, group: "Look" },
  { id: "metalness", label: "Metalness", kind: "number", step: 0.05, group: "Look" },
];

/**
 * Leaves — a field of leaves that settle, skitter and take off on the wind.
 *
 * A port of brunosimon/folio-2025's Leaves.js. Wind comes from this project's own Wind Field so
 * leaves gust in step with the grass; Ground takes any mesh and the leaves land on it; and a
 * blast, wired from an Explosion's trigger, throws them outward.
 *
 * The field wraps around Focus, so a few thousand leaves cover wherever the camera is rather than
 * the whole world.
 */
export const OBJECT_LEAVES_NODE: NodeDefinition = {
  type: "object/leaves",
  label: "Leaves",
  category: "object",
  inputs: [
    { id: "wind", label: "Wind Field", type: "any" },
    { id: "ground", label: "Ground", type: "geometry" },
    { id: "focus", label: "Focus (Follow)", type: "vector" },
    { id: "pusher", label: "Mover Position", type: "vector" },
    { id: "pusherVelocity", label: "Mover Velocity", type: "vector" },
    { id: "blastTrigger", label: "Blast Trigger", type: "value" },
    { id: "blastPosition", label: "Blast Position", type: "vector" },
    { id: "blastRadius", label: "Blast Radius", type: "value" },
    { id: "windMultiplier", label: "Wind Multiplier", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "count", label: "Leaf Count", type: "value" },
  ],
  defaultParams: {
    count: 1024,
    size: 40,
    seed: 1,
    scale: 0.25,
    groundResolution: 128,

    windMultiplier: 12,
    upwardMultiplier: 1,
    gravity: 9.807,
    damping: 1.5,
    floorOffset: 0.02,
    rotationFrequency: 3,
    rotationElevation: 1,

    pushMultiplier: 100,
    pushSidewaysMultiplier: 20,

    blastRadius: 5,
    blastStrength: 20,

    colorA: new THREE.Color(0x95513a),
    colorB: new THREE.Color(0xf56a3a),
    roughness: 0.85,
    metalness: 0,
  },
  paramFields: LEAVES_PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const count = Math.max(1, Math.min(16384, Math.floor(numberInput(undefined, params.count, 1024))));
    const size = Math.max(1, numberInput(undefined, params.size, 40));
    const seed = Math.floor(numberInput(undefined, params.seed, 1));
    const time = ctx.time ?? 0;

    const focus = asVector3(inputs.focus, new THREE.Vector3());
    const signature = `${count}|${size}|${seed}`;

    let state = leavesCache.get(ctx.nodeId);
    if (!state || state.signature !== signature) {
      const material =
        state?.material ??
        new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
      state?.mesh.geometry.dispose();

      const mesh = new THREE.InstancedMesh(createLeafGeometry(), material, count);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.userData.nodeId = ctx.nodeId;

      state = {
        mesh,
        material,
        sim: seedLeaves(count, size, seed, focus.x, focus.z),
        signature,
        lastTime: time,
        prevBlast: false,
        ground: state?.ground,
      };
      leavesCache.set(ctx.nodeId, state);
    }

    // Scrubbing backwards invalidates everything the leaves have drifted into, so they are
    // re-scattered rather than carried across the cut.
    const rewound = time < state.lastTime - REWIND_THRESHOLD;
    if (rewound) state.sim = seedLeaves(count, size, seed, focus.x, focus.z);
    const dt = rewound ? 0 : Math.max(0, time - state.lastTime);
    state.lastTime = time;

    const groundObject = inputs.ground instanceof THREE.Object3D ? inputs.ground : null;
    const groundResolution = Math.max(2, Math.min(512, Math.floor(numberInput(undefined, params.groundResolution, 128))));
    if (!groundObject) {
      state.ground?.texture.dispose();
      state.ground = undefined;
    } else if (!state.ground || state.ground.signature !== groundSignature(groundObject, groundResolution)) {
      const baked = bakeGroundHeight(groundObject, groundResolution, state.ground);
      if (baked) state.ground = baked;
    }

    const pusher = inputs.pusher instanceof THREE.Vector3 ? inputs.pusher : null;
    const pusherVelocity = asVector3(inputs.pusherVelocity, new THREE.Vector3());

    // A blast lasts exactly the frame it is fired on, as in the original, which resets its
    // explosion uniform at the end of every update.
    const blastHigh = toBoolean(inputs.blastTrigger);
    const fired = blastHigh && !state.prevBlast;
    state.prevBlast = blastHigh;
    const blastCentre = asVector3(inputs.blastPosition, new THREE.Vector3());

    stepLeaves(state.sim, {
      dt,
      focusX: focus.x,
      focusZ: focus.z,
      size,
      wind: resolveWind(inputs.wind, time),
      windMultiplier: numberInput(inputs.windMultiplier, params.windMultiplier, 12),
      upwardMultiplier: numberInput(undefined, params.upwardMultiplier, 1),
      gravity: numberInput(undefined, params.gravity, 9.807),
      damping: Math.max(0, numberInput(undefined, params.damping, 1.5)),
      floorOffset: numberInput(undefined, params.floorOffset, 0.02),
      ground: state.ground ?? null,
      push: pusher
        ? {
            position: pusher,
            velocity: pusherVelocity,
            multiplier: numberInput(undefined, params.pushMultiplier, 100),
            sidewaysMultiplier: numberInput(undefined, params.pushSidewaysMultiplier, 20),
          }
        : null,
      blast: fired
        ? {
            x: blastCentre.x,
            z: blastCentre.z,
            radius: Math.max(0.001, numberInput(inputs.blastRadius, params.blastRadius, 5)),
            strength: numberInput(undefined, params.blastStrength, 20),
          }
        : null,
    });

    writeLeafMatrices(
      state.sim,
      state.mesh,
      Math.max(0.001, numberInput(undefined, params.scale, 0.25)),
      numberInput(undefined, params.rotationFrequency, 3),
      numberInput(undefined, params.rotationElevation, 1),
    );

    const colorA = asColor(params.colorA, new THREE.Color(0x95513a));
    const colorB = asColor(params.colorB, new THREE.Color(0xf56a3a));
    const colorSignature = `${colorA.getHex()}|${colorB.getHex()}`;
    if (state.colorSignature !== colorSignature) {
      writeLeafColors(state.sim, state.mesh, colorA, colorB);
      state.colorSignature = colorSignature;
    }

    state.material.roughness = numberInput(undefined, params.roughness, 0.85);
    state.material.metalness = numberInput(undefined, params.metalness, 0);

    return { geometry: state.mesh, count };
  },
};
