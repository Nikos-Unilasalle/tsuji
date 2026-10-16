import * as THREE from "three";
import { describe, expect, test, vi } from "vitest";
import { EvalContext } from "../types";
import { getOrCreatePlayer } from "../../audio/audioStore";
import { CLAMP_NODE, MAP_RANGE_NODE, VALUE_MATH_NODE } from "./valueMath";
import { TRANSFORM_NODE, DECOMPOSE_MATRIX_NODE, PARENT_NODE, LOOK_AT_NODE, MATRIX_TRANSFORM_NODE, TRANSFORM_VECTOR_NODE } from "./transform";
import { VECTOR_COMPOSE_NODE, VECTOR_MATH_NODE, getUnusedAxes } from "./vector";
import { COMPARE_NODE, BOOLEAN_LOGIC_NODE, TRIGGER_NODE, TOGGLE_NODE, GATE_NODE, LOGIC_BRIDGE_NODE } from "./logic";
import { OSCILLATOR_NODE, ENVELOPE_NODE, PULSE_NODE } from "./oscillator";
import { COLOR_COMPOSE_NODE, COLOR_DECOMPOSE_NODE, COLOR_MATH_NODE } from "./color";
import { OBJECT_BAR_GRAPH_NODE, OBJECT_BOX_NODE, OBJECT_DISC_NODE, OBJECT_EMPTY_NODE, OBJECT_PLANE_NODE, OBJECT_SPHERE_NODE, OBJECT_TEXT_NODE } from "./object";

import { COLOR_TO_VECTOR_NODE, VALUE_TO_COLOR_NODE, VALUE_TO_TEXT_NODE, VALUE_TO_VECTOR_NODE, VECTOR_TO_COLOR_NODE } from "./converter";
import { TEXT_CONSTANT_NODE } from "./text";
import { COLOR_PALETTE_LIST_NODE, GENERATE_LIST_NODE, GET_LIST_ITEM_NODE, LIST_COMBINE_MATH_NODE, LIST_LENGTH_NODE, LIST_MATH_NODE, LIST_STATISTICS_NODE, SLICE_LIST_NODE } from "./list";
import { INSPECTOR_NODE } from "./inspector";
import { AUDIO_PEAK_DETECTOR_NODE, AUDIO_PLAYER_NODE, AUDIO_SPECTRUM_NODE, AUDIO_SYNTH_NODE, MICROPHONE_INPUT_NODE } from "./sound";
import { RANDOM_LIST_NODE, RANDOM_MATRIX_NODE, RANDOM_VALUE_NODE, RANDOM_VECTOR_NODE } from "./random";

import { FRAME_NODE, TIME_NODE } from "./time";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "test" };

describe("TIME_NODE and FRAME_NODE", () => {
  test("TIME_NODE outputs seconds and step", () => {
    const res = TIME_NODE.evaluate({}, TIME_NODE.defaultParams, { time: 2.5, step: 150, nodeId: "t" });
    expect(res.seconds).toBe(2.5);
    expect(res.step).toBe(150);
  });

  test("FRAME_NODE outputs currentFrame or step", () => {
    const res1 = FRAME_NODE.evaluate({}, FRAME_NODE.defaultParams, { time: 1.0, step: 60, currentFrame: 42, nodeId: "f" });
    expect(res1.frame).toBe(42);

    const res2 = FRAME_NODE.evaluate({}, FRAME_NODE.defaultParams, { time: 1.0, step: 60, nodeId: "f" });
    expect(res2.frame).toBe(60);
  });
});

describe("VALUE_MATH_NODE", () => {
  test("adds by default", () => {
    expect(VALUE_MATH_NODE.evaluate({ a: 2, b: 3 }, VALUE_MATH_NODE.defaultParams, CTX).out).toBe(5);
  });

  test("switches operation via the op param", () => {
    const params = { ...VALUE_MATH_NODE.defaultParams, op: "multiply" };
    expect(VALUE_MATH_NODE.evaluate({ a: 4, b: 5 }, params, CTX).out).toBe(20);
  });

  test("clamps values in Value Math using clamp operation", () => {
    const params = { ...VALUE_MATH_NODE.defaultParams, op: "clamp" };
    expect(VALUE_MATH_NODE.evaluate({ a: 2.5, b: 1 }, params, CTX).out).toBe(1);
    expect(VALUE_MATH_NODE.evaluate({ a: -0.5, b: 1 }, params, CTX).out).toBe(0);
    expect(VALUE_MATH_NODE.evaluate({ a: 0.5, b: 1 }, params, CTX).out).toBe(0.5);
  });

  test("divide by zero is 0, not Infinity or NaN — a live signal hitting this must not poison downstream nodes", () => {
    const params = { ...VALUE_MATH_NODE.defaultParams, op: "divide" };
    const result = VALUE_MATH_NODE.evaluate({ a: 5, b: 0 }, params, CTX).out;

    expect(result).toBe(0);
    expect(Number.isFinite(result)).toBe(true);
  });

  test("abs ignores B — a wire into it keeps working, just unused", () => {
    const params = { ...VALUE_MATH_NODE.defaultParams, op: "abs" };
    expect(VALUE_MATH_NODE.evaluate({ a: -4.5, b: 99 }, params, CTX).out).toBe(4.5);
    expect(VALUE_MATH_NODE.evaluate({ a: 3, b: 99 }, params, CTX).out).toBe(3);
  });
});

describe("CLAMP_NODE", () => {
  test("clamps value between min and max limits", () => {
    expect(CLAMP_NODE.evaluate({ value: 5 }, { min: 0, max: 10 }, CTX).out).toBe(5);
    expect(CLAMP_NODE.evaluate({ value: 15 }, { min: 0, max: 10 }, CTX).out).toBe(10);
    expect(CLAMP_NODE.evaluate({ value: -5 }, { min: 0, max: 10 }, CTX).out).toBe(0);
  });

  test("handles inverted min and max parameters gracefully", () => {
    expect(CLAMP_NODE.evaluate({ value: 15 }, { min: 10, max: 0 }, CTX).out).toBe(10);
  });
});

describe("VECTOR_COMPOSE_NODE", () => {
  test("composes vector components when enabled, and records disabled components as unused axes", () => {
    const allEnabled = VECTOR_COMPOSE_NODE.evaluate({ x: 10, y: 20, z: 30 }, VECTOR_COMPOSE_NODE.defaultParams, CTX).out as THREE.Vector3;
    expect(allEnabled.x).toBe(10);
    expect(allEnabled.y).toBe(20);
    expect(allEnabled.z).toBe(30);
    expect(getUnusedAxes(allEnabled)).toEqual([]);

    const xDisabled = VECTOR_COMPOSE_NODE.evaluate({ x: 10, y: 20, z: 30 }, { ...VECTOR_COMPOSE_NODE.defaultParams, useX: false }, CTX).out as THREE.Vector3;
    expect(getUnusedAxes(xDisabled)).toEqual(["x"]);
    expect(xDisabled.y).toBe(20);
    expect(xDisabled.z).toBe(30);
  });
});

describe("OBJECT_EMPTY_NODE", () => {
  test("creates empty group with helper and outputs location and matrix", () => {
    const res = OBJECT_EMPTY_NODE.evaluate(
      {},
      { location: new THREE.Vector3(2, 3, 4) },
      CTX
    );
    expect(res.geometry).toBeInstanceOf(THREE.Group);
    expect(res.matrix).toBeInstanceOf(THREE.Matrix4);
    expect((res.location as THREE.Vector3).x).toBeCloseTo(2);
    expect((res.location as THREE.Vector3).y).toBeCloseTo(3);
    expect((res.location as THREE.Vector3).z).toBeCloseTo(4);
  });
});

describe("MAP_RANGE_NODE", () => {
  test("rescales the midpoint of the input range to the midpoint of the output range", () => {
    const params = { inMin: 0, inMax: 10, outMin: 100, outMax: 200, clamp: 1 };
    expect(MAP_RANGE_NODE.evaluate({ value: 5 }, params, CTX).out).toBe(150);
  });

  test("clamps to the output range by default", () => {
    const params = { inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: 1 };
    expect(MAP_RANGE_NODE.evaluate({ value: 5 }, params, CTX).out).toBe(1);
    expect(MAP_RANGE_NODE.evaluate({ value: -5 }, params, CTX).out).toBe(0);
  });

  test("extrapolates past the range when clamp is off", () => {
    const params = { inMin: 0, inMax: 1, outMin: 0, outMax: 10, clamp: 0 };
    expect(MAP_RANGE_NODE.evaluate({ value: 2 }, params, CTX).out).toBe(20);
  });

  test("a zero-width input range does not divide by zero", () => {
    const params = { inMin: 5, inMax: 5, outMin: 0, outMax: 1, clamp: 1 };
    const result = MAP_RANGE_NODE.evaluate({ value: 5 }, params, CTX).out as number;

    expect(Number.isFinite(result)).toBe(true);
  });
});

describe("TRANSFORM_NODE / DECOMPOSE_MATRIX_NODE round trip", () => {
  test("composing then decomposing returns the original location/rotation/scale", () => {
    const location = new THREE.Vector3(1, 2, 3);
    const rotation = new THREE.Vector3(0.1, 0.4, -0.2);
    const scale = new THREE.Vector3(2, 0.5, 1);

    const { matrix } = TRANSFORM_NODE.evaluate({ location, rotation, scale }, TRANSFORM_NODE.defaultParams, CTX);
    const decomposed = DECOMPOSE_MATRIX_NODE.evaluate({ matrix }, DECOMPOSE_MATRIX_NODE.defaultParams, CTX);

    expect((decomposed.location as THREE.Vector3).x).toBeCloseTo(location.x);
    expect((decomposed.location as THREE.Vector3).y).toBeCloseTo(location.y);
    expect((decomposed.scale as THREE.Vector3).x).toBeCloseTo(scale.x);
    expect((decomposed.scale as THREE.Vector3).y).toBeCloseTo(scale.y);
    expect((decomposed.rotation as THREE.Vector3).x).toBeCloseTo(rotation.x);
    expect((decomposed.rotation as THREE.Vector3).y).toBeCloseTo(rotation.y);
  });

  test("an unconnected transform defaults to identity — origin, no rotation, unit scale", () => {
    const { matrix } = TRANSFORM_NODE.evaluate({}, TRANSFORM_NODE.defaultParams, CTX);

    expect((matrix as THREE.Matrix4).equals(new THREE.Matrix4())).toBe(true);
  });
});

describe("VECTOR_MATH_NODE", () => {
  test("vector addition", () => {
    const a = new THREE.Vector3(1, 2, 3);
    const b = new THREE.Vector3(4, 5, 6);
    const res = VECTOR_MATH_NODE.evaluate({ a, b }, { op: "add" }, CTX).out as THREE.Vector3;
    expect(res.x).toBe(5);
    expect(res.y).toBe(7);
    expect(res.z).toBe(9);
  });

  test("dot product", () => {
    const a = new THREE.Vector3(1, 0, 0);
    const b = new THREE.Vector3(0, 1, 0);
    const val = VECTOR_MATH_NODE.evaluate({ a, b }, { op: "dot" }, CTX).val as number;
    expect(val).toBe(0);
  });

  test("safe division by zero", () => {
    const a = new THREE.Vector3(10, 10, 10);
    const b = new THREE.Vector3(0, 2, 0);
    const res = VECTOR_MATH_NODE.evaluate({ a, b }, { op: "divide" }, CTX).out as THREE.Vector3;
    expect(res.x).toBe(0);
    expect(res.y).toBe(5);
    expect(res.z).toBe(0);
  });
});

describe("PARENT_NODE & LOOK_AT_NODE", () => {
  test("parent matrix multiplication", () => {
    const parentMat = new THREE.Matrix4().makeTranslation(10, 0, 0);
    const childMat = new THREE.Matrix4().makeTranslation(0, 5, 0);
    const res = PARENT_NODE.evaluate({ parent: parentMat, child: childMat }, {}, CTX).matrix as THREE.Matrix4;

    const pos = new THREE.Vector3();
    pos.setFromMatrixPosition(res);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(5);
  });

  test("look at matrix generation", () => {
    const eye = new THREE.Vector3(0, 0, 10);
    const target = new THREE.Vector3(0, 0, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const res = LOOK_AT_NODE.evaluate({ eye, target, up }, {}, CTX).matrix as THREE.Matrix4;
    expect(res).toBeInstanceOf(THREE.Matrix4);
  });

  test("matrix transform incremental composition", () => {
    const base = new THREE.Matrix4().makeTranslation(5, 0, 0);
    const loc = new THREE.Vector3(0, 3, 0);
    const res = MATRIX_TRANSFORM_NODE.evaluate({ matrix: base, location: loc }, MATRIX_TRANSFORM_NODE.defaultParams, CTX).matrix as THREE.Matrix4;

    const pos = new THREE.Vector3();
    pos.setFromMatrixPosition(res);
    expect(pos.x).toBe(5);
    expect(pos.y).toBe(3);
  });

  test("transform vector by matrix", () => {
    const vec = new THREE.Vector3(1, 2, 3);
    const mat = new THREE.Matrix4().makeTranslation(10, 20, 30);
    const res = TRANSFORM_VECTOR_NODE.evaluate({ vector: vec, matrix: mat }, {}, CTX).vector as THREE.Vector3;

    expect(res.x).toBe(11);
    expect(res.y).toBe(22);
    expect(res.z).toBe(33);
  });
});


describe("LOGIC NODES", () => {
  test("compare node", () => {
    expect(COMPARE_NODE.evaluate({ a: 5, b: 3 }, { op: "greater" }, CTX).out).toBe(1);
    expect(COMPARE_NODE.evaluate({ a: 2, b: 3 }, { op: "greater" }, CTX).out).toBe(0);
  });

  test("boolean logic node", () => {
    expect(BOOLEAN_LOGIC_NODE.evaluate({ a: 1, b: 1 }, { op: "and" }, CTX).out).toBe(1);
    expect(BOOLEAN_LOGIC_NODE.evaluate({ a: 1, b: 0 }, { op: "and" }, CTX).out).toBe(0);
    expect(BOOLEAN_LOGIC_NODE.evaluate({ a: 0 }, { op: "not" }, CTX).out).toBe(1);
  });

  test("trigger node rising edge detection", () => {
    const ctxTrigger: EvalContext = { time: 0, step: 0, nodeId: "trig-1" };
    expect(TRIGGER_NODE.evaluate({ in: 0 }, {}, ctxTrigger).trigger).toBe(0);
    expect(TRIGGER_NODE.evaluate({ in: 1 }, {}, ctxTrigger).trigger).toBe(1);
    expect(TRIGGER_NODE.evaluate({ in: 1 }, {}, ctxTrigger).trigger).toBe(0);
  });

  test("toggle flip flop", () => {
    const ctxTog: EvalContext = { time: 0, step: 0, nodeId: "tog-1" };
    expect(TOGGLE_NODE.evaluate({ trigger: 0 }, { initial: 0 }, ctxTog).out).toBe(0);
    expect(TOGGLE_NODE.evaluate({ trigger: 1 }, { initial: 0 }, ctxTog).out).toBe(1);
    expect(TOGGLE_NODE.evaluate({ trigger: 1 }, { initial: 0 }, ctxTog).out).toBe(1);
    expect(TOGGLE_NODE.evaluate({ trigger: 0 }, { initial: 0 }, ctxTog).out).toBe(1);
    expect(TOGGLE_NODE.evaluate({ trigger: 1 }, { initial: 0 }, ctxTog).out).toBe(0);
  });

  test("gate node", () => {
    expect(GATE_NODE.evaluate({ value: 42, enable: 1 }, {}, CTX).out).toBe(42);
    expect(GATE_NODE.evaluate({ value: 42, enable: 0 }, { offValue: 0 }, CTX).out).toBe(0);
  });

  test("logic bridge node (conditional multiplexer & type adaptation)", () => {
    // Condition = 1 -> returns ifTrue (A)
    const resTrue = LOGIC_BRIDGE_NODE.evaluate({ condition: 1, ifTrue: "MatrixA", ifFalse: "MatrixB" }, {}, CTX);
    expect(resTrue.out).toBe("MatrixA");

    // Condition = 0 -> returns ifFalse (B)
    const resFalse = LOGIC_BRIDGE_NODE.evaluate({ condition: 0, ifTrue: "MatrixA", ifFalse: "MatrixB" }, {}, CTX);
    expect(resFalse.out).toBe("MatrixB");

    // Test dynamic input & output type adaptation
    const dynamicInputs = LOGIC_BRIDGE_NODE.dynamicInputs!([], [
      { connection: { id: "c1", fromNode: "n1", fromSocket: "matrix", toNode: "bridge", toSocket: "ifTrue" }, sourceSocketType: "matrix" },
    ]);
    expect(dynamicInputs.find((s) => s.id === "ifTrue")?.type).toBe("matrix");
    expect(dynamicInputs.find((s) => s.id === "ifFalse")?.type).toBe("matrix");

    const dynamicOutputs = LOGIC_BRIDGE_NODE.dynamicOutputs!([], [
      { connection: { id: "c1", fromNode: "n1", fromSocket: "matrix", toNode: "bridge", toSocket: "ifTrue" }, sourceSocketType: "matrix" },
    ]);
    expect(dynamicOutputs.find((s) => s.id === "out")?.type).toBe("matrix");
  });

  test("GET_LIST_ITEM_NODE returns polymorphic items (Object3D, Vector3, etc.) with dynamic typing", () => {
    const mesh = new THREE.Mesh();
    const resMesh = GET_LIST_ITEM_NODE.evaluate({ list: [mesh], index: 0 }, { index: 0 }, CTX);
    expect(resMesh.item).toBe(mesh);

    const vec = new THREE.Vector3(1, 2, 3);
    const resVec = GET_LIST_ITEM_NODE.evaluate({ list: [vec], index: 0 }, { index: 0 }, CTX);
    expect(resVec.item).toBe(vec);

    const dynamicOutputs = GET_LIST_ITEM_NODE.dynamicOutputs!([], []);
    expect(dynamicOutputs.find((s) => s.id === "item")?.type).toBe("any");
  });
});

describe("OSCILLATOR & ENVELOPE NODES", () => {
  test("oscillator produces sine wave over time", () => {
    const res0 = OSCILLATOR_NODE.evaluate({}, { type: "sine", frequency: 1, phase: 0, amplitude: 1, offset: 0 }, { ...CTX, time: 0 }).out as number;
    const resQuarter = OSCILLATOR_NODE.evaluate({}, { type: "sine", frequency: 1, phase: 0, amplitude: 1, offset: 0 }, { ...CTX, time: 0.25 }).out as number;
    expect(res0).toBeCloseTo(0);
    expect(resQuarter).toBeCloseTo(1);
  });

  test("envelope attack phase", () => {
    const ctxEnv: EvalContext = { time: 0, step: 0, nodeId: "env-1" };
    ENVELOPE_NODE.evaluate({ trigger: 1 }, { attack: 1, release: 1 }, ctxEnv); // trigger starts at t=0
    const levelHalf = ENVELOPE_NODE.evaluate({ trigger: 1 }, { attack: 1, release: 1 }, { ...ctxEnv, time: 0.5 }).out as number;
    expect(levelHalf).toBeCloseTo(0.5);
  });

  test("pulse: no trigger stays at 0", () => {
    const ctxPulse: EvalContext = { time: 0, step: 0, nodeId: "pulse-idle" };
    const out = PULSE_NODE.evaluate({}, { decay: 0.3, amplitude: 1 }, ctxPulse).out as number;
    expect(out).toBe(0);
  });

  test("pulse: rising edge spikes to amplitude then decays exponentially", () => {
    const ctxPulse: EvalContext = { time: 0, step: 0, nodeId: "pulse-1" };
    const peak = PULSE_NODE.evaluate({ trigger: 1 }, { decay: 0.3, amplitude: 1 }, ctxPulse).out as number;
    expect(peak).toBeCloseTo(1);

    const decayed = PULSE_NODE.evaluate({ trigger: 1 }, { decay: 0.3, amplitude: 1 }, { ...ctxPulse, time: 0.3 }).out as number;
    expect(decayed).toBeCloseTo(Math.exp(-1), 4); // one time-constant elapsed
    expect(decayed).toBeLessThan(peak);
    expect(decayed).toBeGreaterThan(0);
  });

  test("pulse: long elapsed time with no retrigger decays to ~0", () => {
    const ctxPulse: EvalContext = { time: 0, step: 0, nodeId: "pulse-2" };
    PULSE_NODE.evaluate({ trigger: 1 }, { decay: 0.3, amplitude: 1 }, ctxPulse);
    const settled = PULSE_NODE.evaluate({}, { decay: 0.3, amplitude: 1 }, { ...ctxPulse, time: 3 }).out as number;
    expect(settled).toBeLessThan(0.01);
  });

  test("pulse: retrigger while decaying stacks additively", () => {
    const ctxSingle: EvalContext = { time: 0, step: 0, nodeId: "pulse-single" };
    PULSE_NODE.evaluate({ trigger: 1 }, { decay: 0.3, amplitude: 1 }, ctxSingle);
    const singleAt02 = PULSE_NODE.evaluate({ trigger: 0 }, { decay: 0.3, amplitude: 1 }, { ...ctxSingle, time: 0.2 }).out as number;

    const ctxStack: EvalContext = { time: 0, step: 0, nodeId: "pulse-stack" };
    PULSE_NODE.evaluate({ trigger: 1 }, { decay: 0.3, amplitude: 1 }, ctxStack); // first hit at t=0
    PULSE_NODE.evaluate({ trigger: 0 }, { decay: 0.3, amplitude: 1 }, { ...ctxStack, time: 0.1 }); // clear edge
    const stackedAt02 = PULSE_NODE.evaluate({ trigger: 1 }, { decay: 0.3, amplitude: 1 }, { ...ctxStack, time: 0.2 }).out as number; // retrigger at t=0.2

    expect(stackedAt02).toBeGreaterThan(singleAt02);
  });

  test("pulse: scrubbing backwards resets energy instead of blowing up", () => {
    const ctxPulse: EvalContext = { time: 5, step: 300, nodeId: "pulse-rewind" };
    PULSE_NODE.evaluate({ trigger: 1 }, { decay: 0.3, amplitude: 1 }, ctxPulse);
    const rewound = PULSE_NODE.evaluate({}, { decay: 0.3, amplitude: 1 }, { ...ctxPulse, time: 0, step: 0 }).out as number;
    expect(rewound).toBe(0);
    expect(Number.isFinite(rewound)).toBe(true);
  });
});

describe("COLOR NODES", () => {
  test("compose color", () => {
    const res = COLOR_COMPOSE_NODE.evaluate({ r: 1, g: 0.5, b: 0 }, {}, CTX).out as THREE.Color;
    expect(res.r).toBe(1);
    expect(res.g).toBe(0.5);
    expect(res.b).toBe(0);
  });

  test("decompose color", () => {
    const col = new THREE.Color(0.2, 0.4, 0.8);
    const res = COLOR_DECOMPOSE_NODE.evaluate({ color: col }, {}, CTX);
    expect(res.r).toBeCloseTo(0.2);
    expect(res.g).toBeCloseTo(0.4);
    expect(res.b).toBeCloseTo(0.8);
  });

  test("color math lerp mix", () => {
    const a = new THREE.Color(0, 0, 0);
    const b = new THREE.Color(1, 1, 1);
    const res = COLOR_MATH_NODE.evaluate({ a, b, factor: 0.5 }, { op: "mix" }, CTX).out as THREE.Color;
    expect(res.r).toBeCloseTo(0.5);
    expect(res.g).toBeCloseTo(0.5);
    expect(res.b).toBeCloseTo(0.5);
  });
});

describe("CONVERTER NODES", () => {
  test("value to vector", () => {
    const res = VALUE_TO_VECTOR_NODE.evaluate({ value: 3.5 }, {}, CTX).vector as THREE.Vector3;
    expect(res.x).toBe(3.5);
    expect(res.y).toBe(3.5);
    expect(res.z).toBe(3.5);
  });

  test("color to vector and vector to color round trip", () => {
    const color = new THREE.Color(0.2, 0.6, 0.8);
    const vec = COLOR_TO_VECTOR_NODE.evaluate({ color }, {}, CTX).vector as THREE.Vector3;
    expect(vec.x).toBeCloseTo(0.2);
    expect(vec.y).toBeCloseTo(0.6);
    expect(vec.z).toBeCloseTo(0.8);

    const backColor = VECTOR_TO_COLOR_NODE.evaluate({ vector: vec }, {}, CTX).color as THREE.Color;
    expect(backColor.r).toBeCloseTo(0.2);
    expect(backColor.g).toBeCloseTo(0.6);
    expect(backColor.b).toBeCloseTo(0.8);
  });

  test("value to color", () => {
    const res = VALUE_TO_COLOR_NODE.evaluate({ value: 0.5 }, {}, CTX).color as THREE.Color;
    expect(res.r).toBeCloseTo(0.5);
    expect(res.g).toBeCloseTo(0.5);
    expect(res.b).toBeCloseTo(0.5);
  });

  test("value to text formatting", () => {
    const res = VALUE_TO_TEXT_NODE.evaluate({ value: 12.3456, decimals: 2, prefix: "FPS: ", suffix: " Hz" }, {}, CTX).text as string;
    expect(res).toBe("FPS: 12.35 Hz");
  });

  test("text constant", () => {
    const res = TEXT_CONSTANT_NODE.evaluate({}, { text: "OpenVMap3D" }, CTX).text as string;
    expect(res).toBe("OpenVMap3D");
  });
});

describe("OBJECT PRIMITIVES", () => {
  test("plane object evaluation", () => {
    const res = OBJECT_PLANE_NODE.evaluate({}, OBJECT_PLANE_NODE.defaultParams, CTX).geometry as THREE.Mesh;
    expect(res).toBeInstanceOf(THREE.Mesh);
  });

  test("sphere object evaluation", () => {
    const res = OBJECT_SPHERE_NODE.evaluate({}, OBJECT_SPHERE_NODE.defaultParams, CTX).geometry as THREE.Mesh;
    expect(res).toBeInstanceOf(THREE.Mesh);
  });

  test("text object defaults to the app's own wordmark", () => {
    expect(OBJECT_TEXT_NODE.defaultParams.text).toBe("tsuji");
  });

  test("text object evaluation", () => {
    const color = new THREE.Color(1, 0, 0);
    const res = OBJECT_TEXT_NODE.evaluate({ text: "Test Text", font: "monospace", fontSize: 96 }, { ...OBJECT_TEXT_NODE.defaultParams, color }, CTX).geometry as THREE.Mesh;
    expect(res).toBeInstanceOf(THREE.Mesh);
    const mat = Array.isArray(res.material) ? (res.material[0] as THREE.MeshStandardMaterial) : (res.material as THREE.MeshStandardMaterial);
    expect(mat.color.r).toBe(1);
    expect(mat.color.g).toBe(0);
  });

  test("bar graph object evaluation with labels and positions", () => {
    const values = [0.2, 0.5, 1.0, 0.8];
    const colors = [new THREE.Color(1, 0, 0), new THREE.Color(0, 1, 0)];
    const params = { ...OBJECT_BAR_GRAPH_NODE.defaultParams, count: 4, spacing: 0.1, barWidth: 0.5, maxHeight: 10, showLabels: 1, labelPosition: "below_flat" };
    const group = OBJECT_BAR_GRAPH_NODE.evaluate({ values, colors }, params, CTX).geometry as THREE.Group;

    expect(group).toBeInstanceOf(THREE.Group);
    const barsGroup = group.children[0] as THREE.Group;
    expect(barsGroup.children.length).toBe(4);

    const bar2 = barsGroup.children[2] as THREE.Mesh;
    expect(bar2.scale.y).toBe(10); // value 1.0 * maxHeight 10

    const labelsGroup = group.children[1] as THREE.Group;
    expect(labelsGroup.visible).toBe(true);
    expect(labelsGroup.children.length).toBe(4);
  });

  test("primitives output their own pose as a Matrix4", () => {
    // Arrange
    const params = { ...OBJECT_BOX_NODE.defaultParams, location: new THREE.Vector3(2, 3, 4) };

    // Act
    const res = OBJECT_BOX_NODE.evaluate({}, params, CTX);

    // Assert
    const matrix = res.matrix as THREE.Matrix4;
    expect(matrix).toBeInstanceOf(THREE.Matrix4);
    const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(pos.x).toBeCloseTo(2);
    expect(pos.y).toBeCloseTo(3);
    expect(pos.z).toBeCloseTo(4);
  });

  test("primitives hand out a copy of their matrix, not the live one", () => {
    const res = OBJECT_BOX_NODE.evaluate({}, OBJECT_BOX_NODE.defaultParams, CTX);
    const mesh = res.geometry as THREE.Mesh;

    (res.matrix as THREE.Matrix4).setPosition(99, 99, 99);

    expect(new THREE.Vector3().setFromMatrixPosition(mesh.matrix).x).toBe(0);
  });

  test("a wired matrix comes back out on the matrix output", () => {
    const wired = new THREE.Matrix4().makeTranslation(7, 0, 0);

    const res = OBJECT_SPHERE_NODE.evaluate({ matrix: wired }, OBJECT_SPHERE_NODE.defaultParams, CTX);

    expect(new THREE.Vector3().setFromMatrixPosition(res.matrix as THREE.Matrix4).x).toBeCloseTo(7);
  });
});

describe("LIST NODES", () => {
  test("generate list", () => {
    const list = GENERATE_LIST_NODE.evaluate({ count: 5, start: 10, step: 2 }, {}, CTX).list as number[];
    expect(list).toEqual([10, 12, 14, 16, 18]);
  });

  test("get list item and list length", () => {
    const sample = [10, 20, 30, 40];
    expect(LIST_LENGTH_NODE.evaluate({ list: sample }, {}, CTX).length).toBe(4);
    expect(GET_LIST_ITEM_NODE.evaluate({ list: sample, index: 2 }, {}, CTX).val).toBe(30);
  });

  test("list math operations with two list inputs A and B + legacy factor/offset support", () => {
    const sampleA = [1, 2, 3];
    const mult = LIST_MATH_NODE.evaluate({ a: sampleA, b: 10 }, { op: "multiply" }, CTX).list as number[];
    expect(mult).toEqual([10, 20, 30]);

    const legacyMult = LIST_MATH_NODE.evaluate({ list: sampleA, factor: 10, offset: 5 }, { op: "multiply" }, CTX).list as number[];
    expect(legacyMult).toEqual([15, 25, 35]);

    const combineAdd = LIST_MATH_NODE.evaluate({ a: [10, 20, 30], b: [1, 2, 3] }, { op: "add" }, CTX).list as number[];
    expect(combineAdd).toEqual([11, 22, 33]);

    const remapped = LIST_MATH_NODE.evaluate({ a: [10, 20, 30] }, { op: "remap_01" }, CTX).list as number[];
    expect(remapped[0]).toBeCloseTo(0);
    expect(remapped[2]).toBeCloseTo(1);
  });

  test("color palette list", () => {
    const ramp = {
      stops: [
        { position: 0, color: new THREE.Color(1, 0, 0) },
        { position: 1, color: new THREE.Color(0, 0, 1) },
      ],
      interpolation: "linear" as const,
    };
    const palette = COLOR_PALETTE_LIST_NODE.evaluate({ count: 3 }, { ramp }, CTX).list as THREE.Color[];

    expect(palette.length).toBe(3);
    expect(palette[0].r).toBe(1);
    expect(palette[2].b).toBe(1);
  });

  test("slice list", () => {
    const sample = [10, 20, 30, 40, 50];
    const sliced = SLICE_LIST_NODE.evaluate({ list: sample, start: 1, count: 3 }, {}, CTX).list as number[];
    expect(sliced).toEqual([20, 30, 40]);
  });

  test("list statistics", () => {
    const stats = LIST_STATISTICS_NODE.evaluate({ list: [10, 20, 30, 40] }, {}, CTX);
    expect(stats.sum).toBe(100);
    expect(stats.average).toBe(25);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(40);
    expect(stats.median).toBe(25);
    expect(stats.count).toBe(4);
  });

  test("combine lists math", () => {
    const res = LIST_COMBINE_MATH_NODE.evaluate({ a: [10, 20], b: [5, 2] }, { op: "multiply" }, CTX).list as number[];
    expect(res).toEqual([50, 40]);
  });
});

describe("INSPECTOR NODE", () => {
  test("passes through input value and updates store", () => {
    const vectorVal = new THREE.Vector3(1, 2, 3);
    const res = INSPECTOR_NODE.evaluate({ input: vectorVal }, {}, { ...CTX, nodeId: "inspect-1" });
    expect(res.out).toBe(vectorVal);
  });
});

describe("SOUND NODES", () => {
  test("audio player node evaluation fallback", () => {
    const res = AUDIO_PLAYER_NODE.evaluate({ play: 0, volume: 0.8 }, AUDIO_PLAYER_NODE.defaultParams, { ...CTX, nodeId: "sound-player-1" });
    expect(res.volume).toBe(0);
  });

  test("audio player trigger plays once to completion and ignores a held trigger", () => {
    const nodeId = "sound-trigger-1";
    const player = getOrCreatePlayer(nodeId);

    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    const mockAudio = {
      src: "blob:track",
      paused: true,
      currentTime: 0,
      duration: 10,
      loop: false,
      volume: 1,
      playbackRate: 1,
      play,
      pause,
      onended: null as (() => void) | null,
      style: {},
      setAttribute: () => {},
    };
    player.audioEl = mockAudio as unknown as HTMLAudioElement;

    // Rising edge -> starts playback from the beginning.
    AUDIO_PLAYER_NODE.evaluate({ trigger: 1 }, AUDIO_PLAYER_NODE.defaultParams, { ...CTX, nodeId });
    expect(play).toHaveBeenCalledTimes(1);
    expect(mockAudio.currentTime).toBe(0);

    // Held at 1 while playing -> no restart (trigger inactive).
    mockAudio.paused = false;
    AUDIO_PLAYER_NODE.evaluate({ trigger: 1 }, AUDIO_PLAYER_NODE.defaultParams, { ...CTX, nodeId });
    expect(play).toHaveBeenCalledTimes(1);
    expect(player.triggerLocked).toBe(true);

    // Sound reaches the end -> trigger unlocks.
    mockAudio.paused = true;
    mockAudio.onended?.();
    expect(player.triggerLocked).toBe(false);

    // Release, then a fresh rising edge starts it again.
    AUDIO_PLAYER_NODE.evaluate({ trigger: 0 }, AUDIO_PLAYER_NODE.defaultParams, { ...CTX, nodeId });
    mockAudio.paused = true;
    AUDIO_PLAYER_NODE.evaluate({ trigger: 1 }, AUDIO_PLAYER_NODE.defaultParams, { ...CTX, nodeId });
    expect(play).toHaveBeenCalledTimes(2);
  });

  test("audio spectrum node fallback spectrum generation", () => {
    const res = AUDIO_SPECTRUM_NODE.evaluate({ bins: 16 }, AUDIO_SPECTRUM_NODE.defaultParams, { ...CTX, nodeId: "sound-spectrum-1" });
    expect(Array.isArray(res.spectrum)).toBe(true);
    expect((res.spectrum as number[]).length).toBe(16);
  });

  test("microphone input node evaluation", () => {
    const res = MICROPHONE_INPUT_NODE.evaluate({ enable: 0 }, MICROPHONE_INPUT_NODE.defaultParams, { ...CTX, nodeId: "sound-mic-1" });
    expect(res.volume).toBe(0);
  });

  test("audio peak detector rising edge threshold trigger", () => {
    const res1 = AUDIO_PEAK_DETECTOR_NODE.evaluate({ volume: 0.1 }, { threshold: 0.5, decay: 0.9 }, { ...CTX, nodeId: "peak-1" });
    expect(res1.trigger).toBe(0);

    const res2 = AUDIO_PEAK_DETECTOR_NODE.evaluate({ volume: 0.9 }, { threshold: 0.5, decay: 0.9 }, { ...CTX, nodeId: "peak-1" });
    expect(res2.trigger).toBe(1);
    expect(res2.peak).toBeGreaterThan(0.8);
  });

  test("audio synth node evaluation", () => {
    const res = AUDIO_SYNTH_NODE.evaluate({ frequency: 440, trigger: 0 }, AUDIO_SYNTH_NODE.defaultParams, { ...CTX, nodeId: "synth-1" });
    expect(res.volume).toBe(0);
  });

  test("audio spectrum node with scalar bins input", () => {
    const res = AUDIO_SPECTRUM_NODE.evaluate({ bins: 16 }, { smoothing: 0.8 }, { ...CTX, nodeId: "spec-1" });
    expect(Array.isArray(res.spectrum)).toBe(true);
    expect((res.spectrum as number[]).length).toBe(16);
  });
});

describe("RANDOM NODES", () => {
  test("random value deterministic PRNG", () => {
    const res1 = RANDOM_VALUE_NODE.evaluate({ seed: 42, min: 10, max: 20 }, { algorithm: "uniform" }, CTX);
    const res2 = RANDOM_VALUE_NODE.evaluate({ seed: 42, min: 10, max: 20 }, { algorithm: "uniform" }, CTX);
    expect(res1.value).toBe(res2.value);
    expect(res1.value as number).toBeGreaterThanOrEqual(10);
    expect(res1.value as number).toBeLessThanOrEqual(20);
  });

  test("random vector evaluation with sphere_surface algo", () => {
    const res = RANDOM_VECTOR_NODE.evaluate({ seed: 100, max: 5 }, { algorithm: "sphere_surface" }, CTX);
    const vec = res.vector as THREE.Vector3;
    expect(vec.length()).toBeCloseTo(5, 4);
  });

  test("random matrix evaluation", () => {
    const res = RANDOM_MATRIX_NODE.evaluate({ seed: 77, posRange: 3 }, { algorithm: "gaussian" }, CTX);
    const mat = res.matrix as THREE.Matrix4;
    expect(mat.elements.length).toBe(16);
  });

  test("random list deterministic generation", () => {
    const res = RANDOM_LIST_NODE.evaluate({ count: 5, seed: 123, min: 0, max: 1 }, { algorithm: "gaussian" }, CTX);
    const list = res.list as number[];
    expect(list.length).toBe(5);
    expect(list.every((v) => typeof v === "number" && !isNaN(v))).toBe(true);
  });
});

describe("PRIMITIVES & MATERIAL PROPERTIES (DISC, SHADELESS)", () => {
  test("OBJECT_DISC_NODE renders 2D CircleGeometry when depth is 0", () => {
    const res = OBJECT_DISC_NODE.evaluate({ depth: 0 }, OBJECT_DISC_NODE.defaultParams, { ...CTX, nodeId: "disc-2d" });
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.type).toBe("CircleGeometry");
    expect((mesh.material as THREE.MeshStandardMaterial).wireframe).toBe(false);
  });

  test("OBJECT_DISC_NODE renders 3D CylinderGeometry when depth > 0", () => {
    const res = OBJECT_DISC_NODE.evaluate({ depth: 0.5 }, OBJECT_DISC_NODE.defaultParams, { ...CTX, nodeId: "disc-3d" });
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.type).toBe("CylinderGeometry");
  });

  test("OBJECT_DISC_NODE renders 2D RingGeometry when innerRadius > 0 or arcAngle < 2pi", () => {
    const resHole = OBJECT_DISC_NODE.evaluate({ innerRadius: 0.2 }, OBJECT_DISC_NODE.defaultParams, { ...CTX, nodeId: "disc-ring" });
    expect((resHole.geometry as THREE.Mesh).geometry.type).toBe("RingGeometry");

    // Arc Angle is stored in radians and only converted for a *wired* socket
    // (degreesInput), so a half-circle set by hand is the param, not an input.
    const resArc = OBJECT_DISC_NODE.evaluate(
      {},
      { ...OBJECT_DISC_NODE.defaultParams, arcAngle: Math.PI },
      { ...CTX, nodeId: "disc-arc" },
    );
    expect((resArc.geometry as THREE.Mesh).geometry.type).toBe("RingGeometry");
  });

  test("OBJECT_DISC_NODE renders 3D ExtrudeGeometry when depth > 0 and innerRadius > 0 or arcAngle < 2pi", () => {
    const resExtrude = OBJECT_DISC_NODE.evaluate({ depth: 0.5, innerRadius: 0.2 }, OBJECT_DISC_NODE.defaultParams, { ...CTX, nodeId: "disc-extrude" });
    expect((resExtrude.geometry as THREE.Mesh).geometry.type).toBe("ExtrudeGeometry");
  });

  test("OBJECT_BOX_NODE applies MeshBasicMaterial when shadeless is true", () => {
    const res = OBJECT_BOX_NODE.evaluate({}, { ...OBJECT_BOX_NODE.defaultParams, shadeless: 1 }, { ...CTX, nodeId: "box-shadeless" });
    const mesh = res.geometry as THREE.Mesh;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    expect(mat.type).toBe("MeshBasicMaterial");
  });

  test("OBJECT_BOX_NODE applies texture map and UV scale when texture is provided", () => {
    const texture = new THREE.Texture();
    (texture as any).image = {};
    const res = OBJECT_BOX_NODE.evaluate(
      { texture, uvScale: new THREE.Vector3(2, 3, 1) },
      OBJECT_BOX_NODE.defaultParams,
      { ...CTX, nodeId: "box-tex" }
    );
    const mesh = res.geometry as THREE.Mesh;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    expect(mat.map).toBe(texture);
    expect(mat.map?.repeat.x).toBe(2);
    expect(mat.map?.repeat.y).toBe(3);
  });
});








