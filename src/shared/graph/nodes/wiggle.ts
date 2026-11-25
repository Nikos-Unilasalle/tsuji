import * as THREE from "three";
import { NodeDefinition } from "../types";
import { fbm1D, fbm3D } from "../../math/noise";
import { asVector3 } from "./transform";

export function asNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Universal Wiggle node inspired by Jacques Lucke's Blender Animation Nodes.
 * Generates smooth, coherent fractal noise oscillations over time / evolution.
 * Simultaneously provides scalar, vector, Euler rotation, scale, and transform matrix outputs.
 */
export const WIGGLE_NODE: NodeDefinition = {
  type: "animation/wiggle",
  label: "Wiggle",
  category: "time",
  inputs: [
    { id: "evolution", label: "Evolution", type: "value" },
    { id: "speed", label: "Speed", type: "value" },
    { id: "amplitude", label: "Amplitude", type: "value" },
    { id: "amplitudeVector", label: "Vector Amp", type: "vector" },
    { id: "rotationAmplitude", label: "Rot Amp (°)", type: "vector" },
    { id: "scaleAmplitude", label: "Scale Amp", type: "vector" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "octaves", label: "Octaves", type: "value" },
    { id: "persistance", label: "Persistance", type: "value" },
    { id: "lacunarity", label: "Lacunarity", type: "value" },
    { id: "offset", label: "Offset", type: "value" },
    { id: "baseVector", label: "Base Vector", type: "vector" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [
    { id: "value", label: "Value", type: "value" },
    { id: "vector", label: "Vector", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "scale", label: "Scale", type: "vector" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    speed: 1.0,
    amplitude: 1.0,
    amplitudeVector: new THREE.Vector3(1, 1, 1),
    rotationAmplitude: new THREE.Vector3(45, 45, 45),
    scaleAmplitude: new THREE.Vector3(0.2, 0.2, 0.2),
    seed: 0,
    octaves: 3,
    persistance: 0.5,
    lacunarity: 2.0,
    offset: 0.0,
    baseVector: new THREE.Vector3(0, 0, 0),
  },
  paramFields: [
    { id: "speed", label: "Speed", kind: "number", step: 0.1 },
    { id: "amplitude", label: "Amplitude", kind: "number", step: 0.1 },
    { id: "amplitudeVector", label: "Vector Amp", kind: "vector" },
    // Degrees, like the (45, 45, 45) default and the `* Math.PI / 180` this
    // gets in evaluate — not radians, so no `degrees: true` (which would have
    // the panel store 45 as 0.785 and wiggle by half a degree).
    { id: "rotationAmplitude", label: "Rot Amp (°)", kind: "vector", step: 5 },
    { id: "scaleAmplitude", label: "Scale Amp", kind: "vector", step: 0.05 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "octaves", label: "Octaves", kind: "number", step: 1 },
    { id: "persistance", label: "Persistance", kind: "number", step: 0.05 },
    { id: "lacunarity", label: "Lacunarity", kind: "number", step: 0.1 },
    { id: "offset", label: "Offset", kind: "number", step: 0.1 },
    { id: "baseVector", label: "Base Vector", kind: "vector" },
  ],
  evaluate: (inputs, params, ctx) => {
    // 1. Evolution / Time
    const evo = inputs.evolution !== undefined ? asNumber(inputs.evolution, ctx.time) : ctx.time;
    const speed = inputs.speed !== undefined ? asNumber(inputs.speed, 1.0) : asNumber(params.speed, 1.0);
    const t = evo * speed;

    // 2. Parameters
    const globalAmp = inputs.amplitude !== undefined ? asNumber(inputs.amplitude, 1.0) : asNumber(params.amplitude, 1.0);
    const ampVec = asVector3(inputs.amplitudeVector ?? params.amplitudeVector, new THREE.Vector3(1, 1, 1));
    const rotAmp = asVector3(inputs.rotationAmplitude ?? params.rotationAmplitude, new THREE.Vector3(45, 45, 45));
    const scaleAmp = asVector3(inputs.scaleAmplitude ?? params.scaleAmplitude, new THREE.Vector3(0.2, 0.2, 0.2));

    const seed = inputs.seed !== undefined ? asNumber(inputs.seed, 0) : asNumber(params.seed, 0);
    const octaves = Math.max(1, Math.min(8, Math.round(inputs.octaves !== undefined ? asNumber(inputs.octaves, 3) : asNumber(params.octaves, 3))));
    const persistance = Math.max(0, Math.min(1, inputs.persistance !== undefined ? asNumber(inputs.persistance, 0.5) : asNumber(params.persistance, 0.5)));
    const lacunarity = Math.max(1, Math.min(8, inputs.lacunarity !== undefined ? asNumber(inputs.lacunarity, 2.0) : asNumber(params.lacunarity, 2.0)));

    const offset = inputs.offset !== undefined ? asNumber(inputs.offset, 0.0) : asNumber(params.offset, 0.0);
    const baseVec = asVector3(inputs.baseVector ?? params.baseVector, new THREE.Vector3(0, 0, 0));

    // 3. Compute 1D and 3D Fractal Noise
    const n1D = fbm1D(t, seed, octaves, persistance, lacunarity);
    const nPos = fbm3D(t, seed + 100, octaves, persistance, lacunarity);
    const nRot = fbm3D(t, seed + 500, octaves, persistance, lacunarity);
    const nScale = fbm3D(t, seed + 900, octaves, persistance, lacunarity);

    // 4. Scalar Wiggle
    const scalarVal = offset + n1D * globalAmp;

    // 5. Vector 3D Wiggle
    const vectorVal = new THREE.Vector3(
      baseVec.x + nPos.x * ampVec.x * globalAmp,
      baseVec.y + nPos.y * ampVec.y * globalAmp,
      baseVec.z + nPos.z * ampVec.z * globalAmp
    );

    // 6. Euler Rotation Wiggle (in degrees)
    const rotVal = new THREE.Vector3(
      nRot.x * rotAmp.x * globalAmp,
      nRot.y * rotAmp.y * globalAmp,
      nRot.z * rotAmp.z * globalAmp
    );

    // 7. Scale Wiggle
    const scaleVal = new THREE.Vector3(
      Math.max(0.001, 1.0 + nScale.x * scaleAmp.x * globalAmp),
      Math.max(0.001, 1.0 + nScale.y * scaleAmp.y * globalAmp),
      Math.max(0.001, 1.0 + nScale.z * scaleAmp.z * globalAmp)
    );

    // 8. Transform Matrix Wiggle
    // Rot Amp is in degrees (see its param field); a rotation only becomes an
    // angle once it is in radians, which is what both the matrix below and
    // the `rotation` output need.
    const eulerRad = new THREE.Euler(
      (rotVal.x * Math.PI) / 180,
      (rotVal.y * Math.PI) / 180,
      (rotVal.z * Math.PI) / 180,
      "YXZ"
    );
    const quat = new THREE.Quaternion().setFromEuler(eulerRad);

    const deltaMat = new THREE.Matrix4().compose(vectorVal, quat, scaleVal);
    const baseMat = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix : new THREE.Matrix4();
    const finalMat = new THREE.Matrix4().multiplyMatrices(baseMat, deltaMat);

    return {
      value: scalarVal,
      vector: vectorVal,
      // Radians, NOT the degrees Rot Amp is authored in. A `rotation` vector
      // socket is a rotation being handed between nodes, and every consumer
      // of one (composeTransform via resolveRotationVector) reads radians —
      // matching Decompose Matrix and Rolling, which both emit a quaternion's
      // Euler. Emitting degrees here made Wiggle -> Transform.Rotation spin
      // about 57x too far.
      rotation: new THREE.Vector3(eulerRad.x, eulerRad.y, eulerRad.z),
      scale: scaleVal,
      matrix: finalMat,
    };
  },
};

/** Specialized Wiggle Number node (Animation Nodes Number Wiggle) */
export const WIGGLE_NUMBER_NODE: NodeDefinition = {
  type: "math/wiggle-number",
  label: "Wiggle Number",
  category: "time",
  inputs: [
    { id: "evolution", label: "Evolution", type: "value" },
    { id: "speed", label: "Speed", type: "value" },
    { id: "amplitude", label: "Amplitude", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "octaves", label: "Octaves", type: "value" },
    { id: "persistance", label: "Persistance", type: "value" },
    { id: "lacunarity", label: "Lacunarity", type: "value" },
    { id: "offset", label: "Offset", type: "value" },
  ],
  outputs: [{ id: "value", label: "Value", type: "value" }],
  defaultParams: {
    speed: 1.0,
    amplitude: 1.0,
    seed: 0,
    octaves: 3,
    persistance: 0.5,
    lacunarity: 2.0,
    offset: 0.0,
  },
  paramFields: [
    { id: "speed", label: "Speed", kind: "number", step: 0.1 },
    { id: "amplitude", label: "Amplitude", kind: "number", step: 0.1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "octaves", label: "Octaves", kind: "number", step: 1 },
    { id: "persistance", label: "Persistance", kind: "number", step: 0.05 },
    { id: "lacunarity", label: "Lacunarity", kind: "number", step: 0.1 },
    { id: "offset", label: "Offset", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const evo = inputs.evolution !== undefined ? asNumber(inputs.evolution, ctx.time) : ctx.time;
    const speed = inputs.speed !== undefined ? asNumber(inputs.speed, 1.0) : asNumber(params.speed, 1.0);
    const t = evo * speed;

    const amp = inputs.amplitude !== undefined ? asNumber(inputs.amplitude, 1.0) : asNumber(params.amplitude, 1.0);
    const seed = inputs.seed !== undefined ? asNumber(inputs.seed, 0) : asNumber(params.seed, 0);
    const octaves = Math.max(1, Math.min(8, Math.round(inputs.octaves !== undefined ? asNumber(inputs.octaves, 3) : asNumber(params.octaves, 3))));
    const persistance = Math.max(0, Math.min(1, inputs.persistance !== undefined ? asNumber(inputs.persistance, 0.5) : asNumber(params.persistance, 0.5)));
    const lacunarity = Math.max(1, Math.min(8, inputs.lacunarity !== undefined ? asNumber(inputs.lacunarity, 2.0) : asNumber(params.lacunarity, 2.0)));
    const offset = inputs.offset !== undefined ? asNumber(inputs.offset, 0.0) : asNumber(params.offset, 0.0);

    const n = fbm1D(t, seed, octaves, persistance, lacunarity);
    return { value: offset + n * amp };
  },
};

/** Specialized Wiggle Vector node (Animation Nodes Vector Wiggle) */
export const WIGGLE_VECTOR_NODE: NodeDefinition = {
  type: "vector/wiggle-vector",
  label: "Wiggle Vector",
  category: "time",
  inputs: [
    { id: "evolution", label: "Evolution", type: "value" },
    { id: "speed", label: "Speed", type: "value" },
    { id: "amplitude", label: "Amplitude", type: "vector" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "octaves", label: "Octaves", type: "value" },
    { id: "persistance", label: "Persistance", type: "value" },
    { id: "lacunarity", label: "Lacunarity", type: "value" },
    { id: "baseVector", label: "Base Vector", type: "vector" },
    // Wiring Points switches this node into "Individual Points" mode: each
    // point wiggles around its OWN position with independent noise (a
    // different seed offset per index, so they don't all wobble in lockstep)
    // instead of the single shared baseVector. Mask (1=wiggle, 0=hold still)
    // is what lets only *some* points move — same convention, and same
    // motivation, as Spring Vector's Individual Points mode: animate part of
    // a mesh (via Mesh to Points / Points Selection / Points to Mesh) while
    // the rest stays rigid.
    { id: "points", label: "Points (Individual)", type: "list" },
    { id: "mask", label: "Influence (1=wiggle, 0=hold, continuous)", type: "list" },
  ],
  outputs: [
    { id: "vector", label: "Vector", type: "vector" },
    { id: "points", label: "Points", type: "list" },
  ],
  defaultParams: {
    speed: 1.0,
    amplitude: new THREE.Vector3(1, 1, 1),
    seed: 0,
    octaves: 3,
    persistance: 0.5,
    lacunarity: 2.0,
    baseVector: new THREE.Vector3(0, 0, 0),
  },
  paramFields: [
    { id: "speed", label: "Speed", kind: "number", step: 0.1 },
    { id: "amplitude", label: "Amplitude", kind: "vector" },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "octaves", label: "Octaves", kind: "number", step: 1 },
    { id: "persistance", label: "Persistance", kind: "number", step: 0.05 },
    { id: "lacunarity", label: "Lacunarity", kind: "number", step: 0.1 },
    { id: "baseVector", label: "Base Vector", kind: "vector" },
  ],
  evaluate: (inputs, params, ctx) => {
    const evo = inputs.evolution !== undefined ? asNumber(inputs.evolution, ctx.time) : ctx.time;
    const speed = inputs.speed !== undefined ? asNumber(inputs.speed, 1.0) : asNumber(params.speed, 1.0);
    const t = evo * speed;

    const amp = asVector3(inputs.amplitude ?? params.amplitude, new THREE.Vector3(1, 1, 1));
    const seed = inputs.seed !== undefined ? asNumber(inputs.seed, 0) : asNumber(params.seed, 0);
    const octaves = Math.max(1, Math.min(8, Math.round(inputs.octaves !== undefined ? asNumber(inputs.octaves, 3) : asNumber(params.octaves, 3))));
    const persistance = Math.max(0, Math.min(1, inputs.persistance !== undefined ? asNumber(inputs.persistance, 0.5) : asNumber(params.persistance, 0.5)));
    const lacunarity = Math.max(1, Math.min(8, inputs.lacunarity !== undefined ? asNumber(inputs.lacunarity, 2.0) : asNumber(params.lacunarity, 2.0)));
    const baseVec = asVector3(inputs.baseVector ?? params.baseVector, new THREE.Vector3(0, 0, 0));

    if (Array.isArray(inputs.points)) {
      const basePoints = (inputs.points as unknown[]).map((p) => asVector3(p, new THREE.Vector3(0, 0, 0)));
      const mask = Array.isArray(inputs.mask) ? (inputs.mask as unknown[]).map((m) => Number(m)) : null;
      const points = basePoints.map((p, i) => {
        const influence = mask !== null ? Math.max(0, Math.min(1, mask[i] ?? 1)) : 1;
        if (influence <= 0) return p.clone();
        // A large, irrational-feeling per-index offset decorrelates each
        // point's noise from its neighbours' — without it every point reads
        // the same fbm3D sample and the whole selection wiggles as one rigid
        // (if offset) blob instead of rippling independently.
        const pn = fbm3D(t, seed + i * 173.17, octaves, persistance, lacunarity);
        return new THREE.Vector3(
          p.x + pn.x * amp.x * influence,
          p.y + pn.y * amp.y * influence,
          p.z + pn.z * amp.z * influence,
        );
      });
      return { vector: points[0] ?? baseVec.clone(), points };
    }

    const n = fbm3D(t, seed, octaves, persistance, lacunarity);
    const out = new THREE.Vector3(
      baseVec.x + n.x * amp.x,
      baseVec.y + n.y * amp.y,
      baseVec.z + n.z * amp.z
    );
    return { vector: out, points: [out] };
  },
};
