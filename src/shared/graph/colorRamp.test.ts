import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR_STOPS, evalColorRamp, sampleColorRamp } from "./colorRamp";

const red = new THREE.Color(1, 0, 0);
const green = new THREE.Color(0, 1, 0);
const blue = new THREE.Color(0, 0, 1);

describe("evalColorRamp", () => {
  it("returns each endpoint exactly at t=0 and t=1", () => {
    const stops = [
      { position: 0, color: red },
      { position: 1, color: blue },
    ];
    expect(evalColorRamp(stops, 0).getHex()).toBe(red.getHex());
    expect(evalColorRamp(stops, 1).getHex()).toBe(blue.getHex());
  });

  it("linearly interpolates between the two stops straddling t", () => {
    const stops = [
      { position: 0, color: red },
      { position: 1, color: blue },
    ];
    const mid = evalColorRamp(stops, 0.5);
    expect(mid.r).toBeCloseTo(0.5, 4);
    expect(mid.b).toBeCloseTo(0.5, 4);
  });

  it("handles more than two stops, picking the right segment", () => {
    const stops = [
      { position: 0, color: red },
      { position: 0.5, color: green },
      { position: 1, color: blue },
    ];
    expect(evalColorRamp(stops, 0.5).getHex()).toBe(green.getHex());
    const quarter = evalColorRamp(stops, 0.25);
    expect(quarter.r).toBeCloseTo(0.5, 4);
    expect(quarter.g).toBeCloseTo(0.5, 4);
  });

  it("clamps out-of-range t to the nearest endpoint", () => {
    const stops = [
      { position: 0.2, color: red },
      { position: 0.8, color: blue },
    ];
    expect(evalColorRamp(stops, -1).getHex()).toBe(red.getHex());
    expect(evalColorRamp(stops, 5).getHex()).toBe(blue.getHex());
  });

  it("constant interpolation holds the earlier stop's color across its whole segment", () => {
    const stops = [
      { position: 0, color: red },
      { position: 1, color: blue },
    ];
    expect(evalColorRamp(stops, 0.99, "constant").getHex()).toBe(red.getHex());
  });

  it("sorts unsorted stops by position before evaluating", () => {
    const stops = [
      { position: 1, color: blue },
      { position: 0, color: red },
    ];
    expect(evalColorRamp(stops, 0).getHex()).toBe(red.getHex());
    expect(evalColorRamp(stops, 1).getHex()).toBe(blue.getHex());
  });

  it("falls back to the default two-stop ramp when given nothing", () => {
    expect(evalColorRamp(undefined, 0).getHex()).toBe(DEFAULT_COLOR_STOPS[0].color.getHex());
    expect(evalColorRamp([], 0).getHex()).toBe(DEFAULT_COLOR_STOPS[0].color.getHex());
  });

  it("a single stop returns that color everywhere", () => {
    expect(evalColorRamp([{ position: 0.4, color: green }], 0.9).getHex()).toBe(green.getHex());
  });
});

describe("sampleColorRamp", () => {
  it("reads stops and interpolation off a ColorRamp object", () => {
    const ramp = {
      stops: [
        { position: 0, color: red },
        { position: 1, color: blue },
      ],
      interpolation: "constant" as const,
    };
    expect(sampleColorRamp(ramp, 0.9).getHex()).toBe(red.getHex());
  });

  it("falls back to the default ramp when given null", () => {
    expect(sampleColorRamp(null, 0).getHex()).toBe(DEFAULT_COLOR_STOPS[0].color.getHex());
  });

  it("handles deserialized stops with raw numeric colors", () => {
    const ramp = {
      stops: [
        { position: 0, color: 0xff0000 as unknown as THREE.Color },
        { position: 1, color: 0x0000ff as unknown as THREE.Color },
      ],
      interpolation: "constant" as const,
    };
    expect(sampleColorRamp(ramp, 0.9).getHex()).toBe(0xff0000);
  });
});
