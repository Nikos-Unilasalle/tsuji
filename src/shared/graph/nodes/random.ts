import * as THREE from "three";
import {
  createPRNG,
  randomExponential,
  randomGaussian,
  randomNoise1D,
  randomUniform,
} from "../../math/random";
import { NodeDefinition } from "../types";

const ALGO_VALUE_OPTIONS = ["uniform", "gaussian", "noise", "exponential", "white"];
const ALGO_VECTOR_OPTIONS = ["uniform", "gaussian", "noise", "sphere_surface", "sphere_volume"];
const ALGO_MATRIX_OPTIONS = ["uniform", "gaussian", "noise"];

/** Random Value node — generates a pseudo-random scalar value based on a seed and distribution algorithm. */
export const RANDOM_VALUE_NODE: NodeDefinition = {
  type: "math/random-value",
  label: "Random Value",
  category: "math",
  inputs: [
    { id: "seed", label: "Seed", type: "value" },
    { id: "min", label: "Min", type: "value" },
    { id: "max", label: "Max", type: "value" },
  ],
  outputs: [{ id: "value", label: "Value", type: "value" }],
  defaultParams: { algorithm: "uniform", seed: 0, min: 0, max: 1 },
  paramFields: [
    { id: "algorithm", label: "Algorithm", kind: "select", options: ALGO_VALUE_OPTIONS },
    { id: "min", label: "Min", kind: "number", step: 0.1 },
    { id: "max", label: "Max", kind: "number", step: 0.1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, _ctx) => {
    const seed = inputs.seed !== undefined ? Number(inputs.seed) : Number(params.seed) || 0;
    const min = inputs.min !== undefined ? Number(inputs.min) : Number(params.min) ?? 0;
    const max = inputs.max !== undefined ? Number(inputs.max) : Number(params.max) ?? 1;
    const algo = String(params.algorithm || "uniform");

    let val = 0;
    if (algo === "white") {
      val = min + Math.random() * (max - min);
    } else if (algo === "noise") {
      const noiseNorm = randomNoise1D(seed * 0.5, 0);
      val = min + noiseNorm * (max - min);
    } else {
      const rng = createPRNG(seed);
      if (algo === "gaussian") {
        const mean = (min + max) / 2;
        const stdDev = Math.abs(max - min) / 4;
        val = randomGaussian(rng, mean, stdDev);
        val = Math.max(min, Math.min(max, val));
      } else if (algo === "exponential") {
        val = min + randomExponential(rng, 2) * (max - min);
        val = Math.max(min, Math.min(max, val));
      } else {
        // Uniform
        val = randomUniform(rng, min, max);
      }
    }

    return { value: val };
  },
};

/** Random Vector node — generates a 3D vector with components sampled from chosen PRNG algorithm. */
export const RANDOM_VECTOR_NODE: NodeDefinition = {
  type: "vector/random-vector",
  label: "Random Vector",
  category: "math",
  inputs: [
    { id: "seed", label: "Seed", type: "value" },
    { id: "min", label: "Min", type: "value" },
    { id: "max", label: "Max", type: "value" },
  ],
  outputs: [{ id: "vector", label: "Vector", type: "vector" }],
  defaultParams: { algorithm: "uniform", seed: 0, min: -1, max: 1 },
  paramFields: [
    { id: "algorithm", label: "Algorithm", kind: "select", options: ALGO_VECTOR_OPTIONS },
    { id: "min", label: "Min", kind: "number", step: 0.1 },
    { id: "max", label: "Max", kind: "number", step: 0.1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, _ctx) => {
    const seed = inputs.seed !== undefined ? Number(inputs.seed) : Number(params.seed) || 0;
    const min = inputs.min !== undefined ? Number(inputs.min) : Number(params.min) ?? -1;
    const max = inputs.max !== undefined ? Number(inputs.max) : Number(params.max) ?? 1;
    const algo = String(params.algorithm || "uniform");

    const rng = createPRNG(seed);

    let x = 0, y = 0, z = 0;

    if (algo === "sphere_surface") {
      const u = randomGaussian(rng, 0, 1);
      const v = randomGaussian(rng, 0, 1);
      const w = randomGaussian(rng, 0, 1);
      const dir = new THREE.Vector3(u, v, w).normalize();
      const radius = Math.abs(max);
      dir.multiplyScalar(radius);
      return { vector: dir };
    } else if (algo === "sphere_volume") {
      const u = randomGaussian(rng, 0, 1);
      const v = randomGaussian(rng, 0, 1);
      const w = randomGaussian(rng, 0, 1);
      const dir = new THREE.Vector3(u, v, w).normalize();
      const r = Math.pow(rng(), 1 / 3) * Math.abs(max);
      dir.multiplyScalar(r);
      return { vector: dir };
    } else if (algo === "gaussian") {
      const mean = (min + max) / 2;
      const stdDev = Math.abs(max - min) / 4;
      x = randomGaussian(rng, mean, stdDev);
      y = randomGaussian(rng, mean, stdDev);
      z = randomGaussian(rng, mean, stdDev);
    } else if (algo === "noise") {
      x = min + randomNoise1D(seed * 0.5, 10.1) * (max - min);
      y = min + randomNoise1D(seed * 0.5 + 100, 20.2) * (max - min);
      z = min + randomNoise1D(seed * 0.5 + 200, 30.3) * (max - min);
    } else {
      // Uniform
      x = randomUniform(rng, min, max);
      y = randomUniform(rng, min, max);
      z = randomUniform(rng, min, max);
    }

    return { vector: new THREE.Vector3(x, y, z) };
  },
};

/** Random Matrix node — generates a random transformation matrix (position, rotation, scale). */
export const RANDOM_MATRIX_NODE: NodeDefinition = {
  type: "transform/random-matrix",
  label: "Random Matrix",
  category: "transform",
  inputs: [
    { id: "seed", label: "Seed", type: "value" },
    { id: "posRange", label: "Pos Range", type: "value" },
    { id: "rotRange", label: "Rot Range (°)", type: "value" },
    { id: "scaleMin", label: "Scale Min", type: "value" },
    { id: "scaleMax", label: "Scale Max", type: "value" },
  ],
  outputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  defaultParams: {
    algorithm: "uniform",
    seed: 0,
    posRange: 1,
    rotRange: 360,
    scaleMin: 0.5,
    scaleMax: 1.5,
  },
  paramFields: [
    { id: "algorithm", label: "Algorithm", kind: "select", options: ALGO_MATRIX_OPTIONS },
    { id: "posRange", label: "Pos Range", kind: "number", step: 0.5 },
    { id: "rotRange", label: "Rot Range (°)", kind: "number", step: 15 },
    { id: "scaleMin", label: "Scale Min", kind: "number", step: 0.1 },
    { id: "scaleMax", label: "Scale Max", kind: "number", step: 0.1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, _ctx) => {
    const seed = inputs.seed !== undefined ? Number(inputs.seed) : Number(params.seed) || 0;
    const posRange = Math.abs(inputs.posRange !== undefined ? Number(inputs.posRange) : Number(params.posRange) ?? 1);
    const rotRange = (inputs.rotRange !== undefined ? Number(inputs.rotRange) : Number(params.rotRange) ?? 360) * (Math.PI / 180);
    const scaleMin = inputs.scaleMin !== undefined ? Number(inputs.scaleMin) : Number(params.scaleMin) ?? 0.5;
    const scaleMax = inputs.scaleMax !== undefined ? Number(inputs.scaleMax) : Number(params.scaleMax) ?? 1.5;
    const algo = String(params.algorithm || "uniform");

    const rng = createPRNG(seed);

    let px = 0, py = 0, pz = 0;
    let rx = 0, ry = 0, rz = 0;
    let sx = 1, sy = 1, sz = 1;

    if (algo === "gaussian") {
      px = randomGaussian(rng, 0, posRange / 2);
      py = randomGaussian(rng, 0, posRange / 2);
      pz = randomGaussian(rng, 0, posRange / 2);
      rx = randomGaussian(rng, 0, rotRange / 2);
      ry = randomGaussian(rng, 0, rotRange / 2);
      rz = randomGaussian(rng, 0, rotRange / 2);
      const sMean = (scaleMin + scaleMax) / 2;
      const sStd = Math.abs(scaleMax - scaleMin) / 4;
      const s = Math.max(scaleMin, Math.min(scaleMax, randomGaussian(rng, sMean, sStd)));
      sx = sy = sz = s;
    } else if (algo === "noise") {
      px = (randomNoise1D(seed * 0.5, 1) * 2 - 1) * posRange;
      py = (randomNoise1D(seed * 0.5 + 10, 2) * 2 - 1) * posRange;
      pz = (randomNoise1D(seed * 0.5 + 20, 3) * 2 - 1) * posRange;
      rx = (randomNoise1D(seed * 0.5 + 30, 4) * 2 - 1) * rotRange;
      ry = (randomNoise1D(seed * 0.5 + 40, 5) * 2 - 1) * rotRange;
      rz = (randomNoise1D(seed * 0.5 + 50, 6) * 2 - 1) * rotRange;
      const sNorm = randomNoise1D(seed * 0.5 + 60, 7);
      sx = sy = sz = scaleMin + sNorm * (scaleMax - scaleMin);
    } else {
      // Uniform
      px = randomUniform(rng, -posRange, posRange);
      py = randomUniform(rng, -posRange, posRange);
      pz = randomUniform(rng, -posRange, posRange);
      rx = randomUniform(rng, -rotRange / 2, rotRange / 2);
      ry = randomUniform(rng, -rotRange / 2, rotRange / 2);
      rz = randomUniform(rng, -rotRange / 2, rotRange / 2);
      const s = randomUniform(rng, scaleMin, scaleMax);
      sx = sy = sz = s;
    }

    const pos = new THREE.Vector3(px, py, pz);
    const euler = new THREE.Euler(rx, ry, rz);
    const quat = new THREE.Quaternion().setFromEuler(euler);
    const scale = new THREE.Vector3(sx, sy, sz);

    const mat = new THREE.Matrix4().compose(pos, quat, scale);
    return { matrix: mat };
  },
};

/** Random List node — generates an array of PRNG random values. */
export const RANDOM_LIST_NODE: NodeDefinition = {
  type: "list/random-list",
  label: "Random List",
  category: "list",
  inputs: [
    { id: "count", label: "Count", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "min", label: "Min", type: "value" },
    { id: "max", label: "Max", type: "value" },
  ],
  outputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: { count: 10, algorithm: "noise", seed: 0, min: 0, max: 1 },
  paramFields: [
    { id: "count", label: "List Size", kind: "number", step: 1 },
    { id: "algorithm", label: "Algorithm", kind: "select", options: ALGO_VALUE_OPTIONS },
    { id: "min", label: "Min", kind: "number", step: 0.1 },
    { id: "max", label: "Max", kind: "number", step: 0.1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, _ctx) => {
    const count = Math.max(0, Math.floor(inputs.count !== undefined ? Number(inputs.count) : Number(params.count) ?? 10));
    const seed = inputs.seed !== undefined ? Number(inputs.seed) : Number(params.seed) || 0;
    const min = inputs.min !== undefined ? Number(inputs.min) : Number(params.min) ?? 0;
    const max = inputs.max !== undefined ? Number(inputs.max) : Number(params.max) ?? 1;
    const algo = String(params.algorithm || "noise");

    const rng = createPRNG(seed);
    const list: number[] = [];

    for (let i = 0; i < count; i++) {
      let val = 0;
      if (algo === "white") {
        val = min + Math.random() * (max - min);
      } else if (algo === "noise") {
        // Continuous smooth 1D Perlin noise for fluid animation
        const noiseNorm = randomNoise1D(seed * 0.5 + i * 0.25, i * 0.5);
        val = min + noiseNorm * (max - min);
      } else if (algo === "gaussian") {
        const mean = (min + max) / 2;
        const stdDev = Math.abs(max - min) / 4;
        val = randomGaussian(rng, mean, stdDev);
        val = Math.max(min, Math.min(max, val));
      } else if (algo === "exponential") {
        val = min + randomExponential(rng, 2) * (max - min);
        val = Math.max(min, Math.min(max, val));
      } else {
        val = randomUniform(rng, min, max);
      }
      list.push(val);
    }

    return { list };
  },
};
