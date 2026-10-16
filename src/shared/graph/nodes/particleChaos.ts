import * as THREE from "three";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { ForceFieldDescriptor } from "../particleRuntime";
import { asColor, numberInput, primitiveOutputs } from "./object";
import { composeNativeMatrix } from "./transform";
import { toBoolean } from "../sockets";

interface AttractorState {
  object?: THREE.Object3D;
}

const attractorCache = createNodeCache<AttractorState>((s) => {
  if (s.object) disposeObject3D(s.object);
});

function asVector(v: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (v instanceof THREE.Vector3) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return new THREE.Vector3(x, y, z);
    }
  }
  return fallback;
}

/**
 * 1. Curl Noise / Incompressible Turbulence Vector Field Node
 */
export const PARTICLE_CURL_NOISE_NODE: NodeDefinition = {
  type: "particles/curl-noise",
  label: "Curl Noise Field",
  category: "particles",
  pure: true,
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "position", label: "Position", type: "vector" },
    { id: "strength", label: "Strength", type: "value" },
    { id: "scale", label: "Frequency / Scale", type: "value" },
    { id: "speed", label: "Evolution Speed", type: "value" },
    { id: "radius", label: "Influence Radius", type: "value" },
  ],
  outputs: [{ id: "field", label: "Force Field", type: "any" }],
  defaultParams: {
    position: new THREE.Vector3(0, 0, 0),
    strength: 3.0,
    scale: 0.8,
    speed: 0.2,
    radius: 0.0,
  },
  paramFields: [
    { id: "position", label: "Position", kind: "vector" },
    { id: "strength", label: "Strength", kind: "number", step: 0.2 },
    { id: "scale", label: "Frequency / Scale", kind: "number", step: 0.05 },
    { id: "speed", label: "Evolution Speed", kind: "number", step: 0.05 },
    { id: "radius", label: "Influence Radius", kind: "number", step: 0.5 },
  ],
  evaluate: (inputs, params): { field: ForceFieldDescriptor } => {
    const basePos = asVector(inputs.position, asVector(params.position, new THREE.Vector3()));
    const pos = basePos.clone();
    const axis = new THREE.Vector3(0, 1, 0);

    if (inputs.matrix instanceof THREE.Matrix4) {
      pos.applyMatrix4(inputs.matrix);
      axis.transformDirection(inputs.matrix).normalize();
    }

    const strength = numberInput(inputs.strength, params.strength, 3.0);
    const scale = Math.max(0.01, numberInput(inputs.scale, params.scale, 0.8));
    const speed = numberInput(inputs.speed, params.speed, 0.2);
    const radius = Math.max(0, numberInput(inputs.radius, params.radius, 0));

    return {
      field: {
        type: "turbulence",
        position: pos,
        axis,
        strength,
        radius,
        scale,
        speed,
      },
    };
  },
};

type DerivativeFn = (x: number, y: number, z: number, t: number, a: number, b: number, c: number) => number;
const formulaCache = new Map<string, DerivativeFn>();

/**
 * JIT compiles a user-defined mathematical expression into a high-performance function.
 */
function compileFormula(expr: string, fallback: string): DerivativeFn {
  const trimmed = (expr || "").trim() || fallback;
  const cached = formulaCache.get(trimmed);
  if (cached) return cached;

  try {
    const jsExpr = trimmed.replace(/\^/g, "**");
    const fn = new Function(
      "x", "y", "z", "t", "a", "b", "c", "Math",
      `"use strict";
       const { sin, cos, tan, asin, acos, atan, atan2, abs, sqrt, exp, log, pow, min, max, PI, floor, ceil, round, sign } = Math;
       try {
         const res = Number(${jsExpr});
         return Number.isFinite(res) ? res : 0;
       } catch (e) {
         return 0;
       }`
    );
    const wrapped: DerivativeFn = (x, y, z, t, a, b, c) => fn(x, y, z, t, a, b, c, Math);
    wrapped(0.1, 0.1, 0.1, 0, 1, 1, 1);
    formulaCache.set(trimmed, wrapped);
    return wrapped;
  } catch (err) {
    const fallbackFn: DerivativeFn = () => 0;
    formulaCache.set(trimmed, fallbackFn);
    return fallbackFn;
  }
}

/**
 * 4th-Order Runge-Kutta (RK4) integration step for 3D dynamical systems.
 */
function stepRK4(
  evalDeriv: (x: number, y: number, z: number, t: number) => { dx: number; dy: number; dz: number },
  x: number,
  y: number,
  z: number,
  t: number,
  dt: number,
): { x: number; y: number; z: number } {
  const k1 = evalDeriv(x, y, z, t);
  const k2 = evalDeriv(x + 0.5 * dt * k1.dx, y + 0.5 * dt * k1.dy, z + 0.5 * dt * k1.dz, t + 0.5 * dt);
  const k3 = evalDeriv(x + 0.5 * dt * k2.dx, y + 0.5 * dt * k2.dy, z + 0.5 * dt * k2.dz, t + 0.5 * dt);
  const k4 = evalDeriv(x + dt * k3.dx, y + dt * k3.dy, z + dt * k3.dz, t + dt);

  return {
    x: x + (dt / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx),
    y: y + (dt / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy),
    z: z + (dt / 6) * (k1.dz + 2 * k2.dz + 2 * k3.dz + k4.dz),
  };
}

/**
 * 2. Strange Attractors Node (Lorenz, Aizawa, Thomas, Rössler, Halvorsen, Chen, Chua, Sprott, Four-Wing, Custom)
 */
export const PARTICLE_STRANGE_ATTRACTOR_NODE: NodeDefinition = {
  type: "particles/strange-attractor",
  label: "Strange Attractor",
  category: "particles",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "location", label: "Location", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "scale", label: "Scale", type: "vector" },
    { id: "steps", label: "Point Count", type: "value" },
    { id: "stepSize", label: "dt Step", type: "value" },
    { id: "attractorScale", label: "Attractor Size", type: "value" },
    { id: "speed", label: "Evolution Speed", type: "value" },
    { id: "colorSpeed", label: "Color Speed", type: "value" },
    { id: "color", label: "Color", type: "color" },
    { id: "pointSize", label: "Point Size", type: "value" },
    { id: "paramA", label: "Param a", type: "value" },
    { id: "paramB", label: "Param b", type: "value" },
    { id: "paramC", label: "Param c", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "points", label: "Points List", type: "list" },
  ],
  defaultParams: {
    visible: true,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    showPivot: false,
    pivot: new THREE.Vector3(0, 0, 0),
    inheritRotation: true,
    inheritScale: true,
    attractorType: "lorenz",
    steps: 2500,
    stepSize: 0.01,
    attractorScale: 0.12,
    speed: 1.0,
    colorSpeed: 1.0,
    renderMode: "points",
    color: new THREE.Color(0x00ffff),
    pointSize: 3.0,
    // Custom formulas and parameters
    customDx: "10 * (y - x)",
    customDy: "x * (28 - z) - y",
    customDz: "x * y - (8 / 3) * z",
    paramA: 10.0,
    paramB: 28.0,
    paramC: 2.666,
  },
  paramFields: [
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
    { id: "showPivot", label: "Show Pivot", kind: "boolean", group: "Transform" },
    { id: "pivot", label: "Pivot Offset", kind: "vector", group: "Transform" },
    { id: "inheritRotation", label: "Inherit Rotation", kind: "boolean", group: "Transform" },
    { id: "inheritScale", label: "Inherit Scale", kind: "boolean", group: "Transform" },

    {
      id: "attractorType",
      label: "Attractor System",
      kind: "select",
      options: [
        "lorenz",
        "aizawa",
        "thomas",
        "rossler",
        "halvorsen",
        "chen",
        "chua",
        "sprott",
        "four-wing",
        "custom",
      ],
      group: "Attractor",
    },
    {
      id: "renderMode",
      label: "Render Mode",
      kind: "select",
      options: ["points", "line"],
      group: "Attractor",
    },
    { id: "steps", label: "Steps / Count", kind: "number", step: 500, group: "Attractor" },
    { id: "stepSize", label: "dt Step", kind: "number", step: 0.002, group: "Attractor" },
    { id: "attractorScale", label: "Attractor Size", kind: "number", step: 0.02, group: "Attractor" },
    { id: "speed", label: "Evolution Speed", kind: "number", step: 0.1, group: "Attractor" },
    { id: "colorSpeed", label: "Color Speed", kind: "number", step: 0.1, group: "Attractor" },
    { id: "color", label: "Color", kind: "color", group: "Attractor" },
    { id: "pointSize", label: "Point Size", kind: "number", step: 0.5, group: "Attractor" },

    // Custom Formula Parameters
    {
      id: "customInfo",
      label: "Syntax: variables x, y, z, t, a, b, c. Functions: sin, cos, tan, abs, sqrt, exp, pow, sign.",
      kind: "note",
      group: "Custom Formula",
    },
    { id: "customDx", label: "dx / dt", kind: "text", group: "Custom Formula" },
    { id: "customDy", label: "dy / dt", kind: "text", group: "Custom Formula" },
    { id: "customDz", label: "dz / dt", kind: "text", group: "Custom Formula" },
    { id: "paramA", label: "Parameter a", kind: "number", step: 0.1, group: "Custom Formula" },
    { id: "paramB", label: "Parameter b", kind: "number", step: 0.1, group: "Custom Formula" },
    { id: "paramC", label: "Parameter c", kind: "number", step: 0.1, group: "Custom Formula" },
  ],
  evaluate: (inputs, params, ctx) => {
    const isVisible = toBoolean(inputs.visible !== undefined ? inputs.visible : (params.visible ?? true));
    const type = String(params.attractorType || "lorenz").toLowerCase();
    const renderMode = String(params.renderMode || "points").toLowerCase();
    const steps = Math.min(25000, Math.max(100, Math.round(numberInput(inputs.steps, params.steps, 2500))));
    const dt = Math.max(0.0002, numberInput(inputs.stepSize, params.stepSize, 0.01));
    const scale = numberInput(inputs.attractorScale, params.attractorScale ?? params.scale, 0.12);
    const speed = numberInput(inputs.speed, params.speed, 1.0);
    const colorSpeed = numberInput(inputs.colorSpeed, params.colorSpeed, 1.0);
    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0x00ffff)));
    const pointSize = numberInput(inputs.pointSize, params.pointSize, 3.0);
    const time = (ctx.time ?? 0) * speed;

    const pA = numberInput(inputs.paramA, params.paramA, 10.0);
    const pB = numberInput(inputs.paramB, params.paramB, 28.0);
    const pC = numberInput(inputs.paramC, params.paramC, 2.666);

    let state = attractorCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      attractorCache.set(ctx.nodeId, state);
    }
    if (state.object) {
      disposeObject3D(state.object);
      state.object = undefined;
    }

    // Compile custom equations if selected
    const fnDx = type === "custom" ? compileFormula(String(params.customDx || ""), "10 * (y - x)") : null;
    const fnDy = type === "custom" ? compileFormula(String(params.customDy || ""), "x * (28 - z) - y") : null;
    const fnDz = type === "custom" ? compileFormula(String(params.customDz || ""), "x * y - (8 / 3) * z") : null;

    // Vector field evaluator for RK4
    const evalDeriv = (cx: number, cy: number, cz: number, ct: number) => {
      switch (type) {
        case "aizawa": {
          const dx = (cz - 0.7) * cx - 3.5 * cy;
          const dy = 3.5 * cx + (cz - 0.7) * cy;
          const dz = 0.6 + 0.95 * cz - (cz * cz * cz) / 3 - (cx * cx + cy * cy) * (1 + 0.25 * cz) + 0.1 * cz * (cx * cx * cx);
          return { dx, dy, dz };
        }
        case "thomas": {
          const b = 0.208186;
          const dx = Math.sin(cy) - b * cx;
          const dy = Math.sin(cz) - b * cy;
          const dz = Math.sin(cx) - b * cz;
          return { dx, dy, dz };
        }
        case "rossler": {
          const a = 0.2, b = 0.2, c = 5.7;
          const dx = -cy - cz;
          const dy = cx + a * cy;
          const dz = b + cz * (cx - c);
          return { dx, dy, dz };
        }
        case "halvorsen": {
          const a = 1.89;
          const dx = -a * cx - 4 * cy - 4 * cz - cy * cy;
          const dy = -a * cy - 4 * cz - 4 * cx - cz * cz;
          const dz = -a * cz - 4 * cx - 4 * cy - cx * cx;
          return { dx, dy, dz };
        }
        case "chen": {
          const a = 35, b = 3, c = 28;
          const dx = a * (cy - cx);
          const dy = (c - a) * cx - cx * cz + c * cy;
          const dz = cx * cy - b * cz;
          return { dx, dy, dz };
        }
        case "chua": {
          const m0 = -1.143, m1 = -0.714;
          const h = m1 * cx + 0.5 * (m0 - m1) * (Math.abs(cx + 1) - Math.abs(cx - 1));
          const dx = 15.6 * (cy - cx - h);
          const dy = cx - cy + cz;
          const dz = -28.0 * cy;
          return { dx, dy, dz };
        }
        case "sprott": {
          const dx = cy * cz;
          const dy = cx - cy;
          const dz = 1.0 - cx * cy;
          return { dx, dy, dz };
        }
        case "four-wing": {
          const a = 0.2, b = 0.01, c = -0.4;
          const dx = a * cx + cy * cz;
          const dy = b * cx + c * cy - cx * cz;
          const dz = -cz - cx * cy;
          return { dx, dy, dz };
        }
        case "custom": {
          const dx = fnDx!(cx, cy, cz, ct, pA, pB, pC);
          const dy = fnDy!(cx, cy, cz, ct, pA, pB, pC);
          const dz = fnDz!(cx, cy, cz, ct, pA, pB, pC);
          return { dx, dy, dz };
        }
        case "lorenz":
        default: {
          const sigma = 10.0, rho = 28.0, beta = 8.0 / 3.0;
          const dx = sigma * (cy - cx);
          const dy = cx * (rho - cz) - cy;
          const dz = cx * cy - beta * cz;
          return { dx, dy, dz };
        }
      }
    };

    const positions = new Float32Array(steps * 3);
    const colors = new Float32Array(steps * 3);
    const pointsList: THREE.Vector3[] = [];

    // Starting seeds adjusted per attractor
    let x = 0.1 + Math.sin(time * 0.2) * 0.05;
    let y = 0.1 + Math.cos(time * 0.2) * 0.05;
    let z = type === "halvorsen" ? -1.0 : type === "rossler" ? 0.0 : 0.1;

    // Run-up to settle onto the attractor manifold using RK4
    for (let i = 0; i < 200; i++) {
      const next = stepRK4(evalDeriv, x, y, z, time, dt);
      x = next.x;
      y = next.y;
      z = next.z;
    }

    // Centering offsets
    const zOffset = (type === "lorenz" || type === "custom") ? 25 : type === "chen" ? 28 : 0;

    // Trajectory generation with RK4
    for (let i = 0; i < steps; i++) {
      const next = stepRK4(evalDeriv, x, y, z, time + i * dt * 0.01, dt);
      x = next.x;
      y = next.y;
      z = next.z;

      const px = x * scale;
      const py = y * scale;
      const pz = (z - zOffset) * scale;

      positions[i * 3] = px;
      positions[i * 3 + 1] = py;
      positions[i * 3 + 2] = pz;

      // Color gradient along the curve with animated color cycle
      const t = Math.abs((i / steps + time * colorSpeed * 0.1) % 1.0);
      colors[i * 3] = color.r * (0.4 + 0.6 * t);
      colors[i * 3 + 1] = color.g * (0.6 + 0.4 * Math.sin(t * Math.PI));
      colors[i * 3 + 2] = color.b * (1.0 - 0.5 * t);

      const stride = steps > 10000 ? Math.ceil(steps / 10000) : 1;
      if (i % stride === 0) {
        pointsList.push(new THREE.Vector3(px, py, pz));
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    let obj: THREE.Object3D;
    if (renderMode === "line") {
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
      obj = new THREE.Line(geometry, mat);
    } else {
      const mat = new THREE.PointsMaterial({
        size: pointSize,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      obj = new THREE.Points(geometry, mat);
    }

    obj.userData = { nodeId: ctx.nodeId };
    obj.visible = isVisible;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      obj.matrixAutoUpdate = false;
      const loc = inputs.location !== undefined ? inputs.location : params.location;
      const rot = inputs.rotation !== undefined ? inputs.rotation : params.rotation;
      const scl = inputs.scale !== undefined ? inputs.scale : params.scale;
      const m = composeNativeMatrix(inputs.matrix, loc, rot, scl, params);
      obj.matrix.copy(m);
      m.decompose(obj.position, obj.quaternion, obj.scale);
      obj.matrixWorldNeedsUpdate = true;
    }

    state.object = obj;

    return {
      ...primitiveOutputs(obj),
      points: pointsList,
    };
  },
};
