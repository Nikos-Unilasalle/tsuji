import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition, ParamFieldDef } from "../types";
import { asColor, numberInput } from "./object";
import { asVector3 } from "./transform";
import { createFireballGeometry, createFireballMaterial } from "../../three/shaders/fireballShader";
import { toBoolean } from "../sockets";

interface ExplosionState {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  prevTrigger: boolean;
  startTime: number;
  burst: number;
}

const explosionCache = createNodeCache<ExplosionState>((s) => {
  s.mesh.geometry.dispose();
  s.material.dispose();
});

function hash11(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** gsap's power3.out, the ease the original expands the fireball with. */
function power3Out(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

const EXPLOSION_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "location", label: "Location", kind: "vector", group: "Transform" },
  { id: "fireRadius", label: "Fire Radius", kind: "number", step: 0.5, group: "Transform" },

  { id: "loop", label: "Loop Every (s, 0 = trigger only)", kind: "number", step: 0.5, group: "Timing" },
  { id: "loopOffset", label: "Loop Offset (s)", kind: "number", step: 0.1, group: "Timing" },
  { id: "lifetime", label: "Lifetime (s)", kind: "number", step: 0.05, group: "Timing" },
  { id: "growDuration", label: "Grow Duration (s)", kind: "number", step: 0.05, group: "Timing" },
  { id: "burnDelay", label: "Burn Delay (s)", kind: "number", step: 0.05, group: "Timing" },
  { id: "burnDuration", label: "Burn Duration (s)", kind: "number", step: 0.05, group: "Timing" },
  { id: "spin", label: "Spin (turns)", kind: "number", step: 0.1, group: "Timing" },

  { id: "emissiveColorA", label: "Core Color", kind: "color", group: "Fire" },
  { id: "emissiveColorB", label: "Flame Color", kind: "color", group: "Fire" },
  { id: "emissiveStrength", label: "Emissive Strength", kind: "number", step: 0.5, group: "Fire" },
  { id: "gooColor", label: "Rim Color", kind: "color", group: "Fire" },
  { id: "gooEdge", label: "Rim Width", kind: "number", step: 0.01, group: "Fire" },
  { id: "glowGain", label: "Overbright (for Bloom)", kind: "number", step: 0.25, group: "Fire" },
  { id: "glowThreshold", label: "Overbright Threshold", kind: "number", step: 0.05, group: "Fire" },

  { id: "noiseScale", label: "Noise Scale", kind: "number", step: 0.5, group: "Shape" },
  { id: "noiseLow", label: "Noise Low", kind: "number", step: 0.05, group: "Shape" },
  { id: "noiseHigh", label: "Noise High", kind: "number", step: 0.05, group: "Shape" },
  { id: "floorLevel", label: "Floor Level (Y)", kind: "number", step: 0.1, group: "Shape" },
  { id: "floorFade", label: "Floor Fade", kind: "number", step: 0.1, group: "Shape" },
];

export const OBJECT_EXPLOSION_NODE: NodeDefinition = {
  type: "object/explosion",
  label: "Explosion",
  category: "object",
  inputs: [
    { id: "trigger", label: "Trigger", type: "value" },
    { id: "location", label: "Location", type: "vector" },
    { id: "fireRadius", label: "Fire Radius", type: "value" },
    { id: "emissiveColorA", label: "Core Color", type: "color" },
    { id: "emissiveColorB", label: "Flame Color", type: "color" },
    { id: "emissiveStrength", label: "Emissive Strength", type: "value" },
    { id: "glowGain", label: "Overbright (for Bloom)", type: "value" },
    { id: "floorLevel", label: "Floor Level (Y)", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "progress", label: "Burn Progress", type: "value" },
    { id: "active", label: "Active", type: "value" },
  ],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 0),
    fireRadius: 5,

    loop: 3,
    loopOffset: 0,
    lifetime: 2.25,
    growDuration: 0.6,
    burnDelay: 0.25,
    burnDuration: 2,
    spin: -1,

    emissiveColorA: new THREE.Color(0xff0000),
    emissiveColorB: new THREE.Color(0xffa500),
    emissiveStrength: 2.5,
    gooColor: new THREE.Color(0x000000),
    gooEdge: 0.1,
    glowGain: 2.5,
    glowThreshold: 0.25,

    noiseScale: 6,
    noiseLow: 0.15,
    noiseHigh: 0.9,
    floorLevel: 0,
    floorFade: 2,
  },
  paramFields: EXPLOSION_PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    let state = explosionCache.get(ctx.nodeId);
    if (!state) {
      const material = createFireballMaterial();
      const mesh = new THREE.Mesh(createFireballGeometry(), material);
      mesh.matrixAutoUpdate = false;
      state = { mesh, material, prevTrigger: false, startTime: -1e6, burst: 0 };
      explosionCache.set(ctx.nodeId, state);
    }
    const u = state.material.uniforms;

    const time = ctx.time ?? 0;
    const lifetime = Math.max(0.05, numberInput(undefined, params.lifetime, 2.25));
    const loop = Math.max(0, numberInput(undefined, params.loop, 3));

    // Looping is derived from the clock rather than kept in the cache, so scrubbing the timeline
    // lands on the same explosion every time. Only the trigger path needs to remember an edge.
    if (loop > 0) {
      const offset = numberInput(undefined, params.loopOffset, 0);
      state.burst = Math.floor((time - offset) / loop);
      state.startTime = state.burst * loop + offset;
      state.prevTrigger = toBoolean(inputs.trigger);
    } else {
      const trigger = toBoolean(inputs.trigger);
      if (trigger && !state.prevTrigger) {
        state.startTime = time;
        state.burst += 1;
      }
      // Scrubbing back before the burst leaves nothing to show.
      if (time < state.startTime) state.startTime = -1e6;
      state.prevTrigger = trigger;
    }

    const elapsed = time - state.startTime;
    const active = elapsed >= 0 && elapsed <= lifetime;

    const growDuration = Math.max(0.001, numberInput(undefined, params.growDuration, 0.6));
    const burnDelay = Math.max(0, numberInput(undefined, params.burnDelay, 0.25));
    const burnDuration = Math.max(0.001, numberInput(undefined, params.burnDuration, 2));
    const spin = numberInput(undefined, params.spin, -1);

    const fireRadius = Math.max(0.001, numberInput(inputs.fireRadius, params.fireRadius, 5));
    // The geometry is a 0.5-radius sphere, so the original's 0.5 -> fireRadius scale tween is a
    // fireball one unit across at the start and fireRadius across at the end.
    const scale = 0.5 + (fireRadius - 0.5) * power3Out(elapsed / growDuration);
    const progress = 0.15 + 0.85 * Math.min(1, Math.max(0, (elapsed - burnDelay) / burnDuration));

    const location = asVector3(inputs.location, asVector3(params.location, new THREE.Vector3()));
    const rotation = new THREE.Euler(
      hash11(state.burst) * Math.PI * 2,
      hash11(state.burst + 17.3) * Math.PI * 2,
      spin * (elapsed / lifetime),
      "XYZ",
    );

    state.mesh.visible = active;
    state.mesh.matrix.compose(
      location,
      new THREE.Quaternion().setFromEuler(rotation),
      new THREE.Vector3(scale, scale, scale),
    );

    u.progress.value = progress;
    u.noiseScale.value = Math.max(0.001, numberInput(undefined, params.noiseScale, 6));
    u.noiseLow.value = numberInput(undefined, params.noiseLow, 0.15);
    u.noiseHigh.value = numberInput(undefined, params.noiseHigh, 0.9);
    u.floorLevel.value = numberInput(inputs.floorLevel, params.floorLevel, 0);
    u.floorFade.value = numberInput(undefined, params.floorFade, 2);
    u.emissiveStrength.value = numberInput(inputs.emissiveStrength, params.emissiveStrength, 2.5);
    u.gooEdge.value = numberInput(undefined, params.gooEdge, 0.1);
    u.glowGain.value = Math.max(0, numberInput(inputs.glowGain, params.glowGain, 2.5));
    u.glowThreshold.value = numberInput(undefined, params.glowThreshold, 0.25);
    u.emissiveColorA.value.copy(asColor(inputs.emissiveColorA, asColor(params.emissiveColorA, new THREE.Color(0xff0000))));
    u.emissiveColorB.value.copy(asColor(inputs.emissiveColorB, asColor(params.emissiveColorB, new THREE.Color(0xffa500))));
    u.gooColor.value.copy(asColor(params.gooColor, new THREE.Color(0x000000)));

    return {
      geometry: state.mesh,
      matrix: state.mesh.matrix.clone(),
      progress: active ? progress : 0,
      active: active ? 1 : 0,
    };
  },
};
