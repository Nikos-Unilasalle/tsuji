import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import {
  LIGHT_AMBIENT_NODE,
  LIGHT_DIRECTIONAL_NODE,
  LIGHT_POINT_NODE,
  LIGHT_SPOT_NODE,
} from "./light";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "light-1" };

describe("LIGHT NODES", () => {
  it("LIGHT_DIRECTIONAL_NODE evaluates directional light and updates target position", () => {
    const targetVec = new THREE.Vector3(1, 2, 3);
    const res = LIGHT_DIRECTIONAL_NODE.evaluate(
      { intensity: 2.0, castShadow: 1, target: targetVec },
      { intensity: 1.5 },
      { ...CTX, nodeId: "dir-1" }
    );
    const light = res.light as THREE.DirectionalLight;
    expect(light).toBeInstanceOf(THREE.DirectionalLight);
    expect(light.intensity).toBe(2.0);
    expect(light.castShadow).toBe(true);
    expect(light.target.position.x).toBeCloseTo(1);
    expect(light.target.position.y).toBeCloseTo(2);
    expect(light.target.position.z).toBeCloseTo(3);
  });

  it("LIGHT_POINT_NODE evaluates point light", () => {
    const res = LIGHT_POINT_NODE.evaluate(
      { distance: 20 },
      { intensity: 1.0, distance: 15 },
      { ...CTX, nodeId: "pt-1" }
    );
    const light = res.light as THREE.PointLight;
    expect(light).toBeInstanceOf(THREE.PointLight);
    expect(light.distance).toBe(20);
  });

  it("LIGHT_SPOT_NODE evaluates spot light", () => {
    const res = LIGHT_SPOT_NODE.evaluate(
      { angle: 60 },
      { angle: 45 },
      { ...CTX, nodeId: "spot-1" }
    );
    const light = res.light as THREE.SpotLight;
    expect(light).toBeInstanceOf(THREE.SpotLight);
    expect(light.angle).toBeCloseTo((60 * Math.PI) / 180);
  });

  it("LIGHT_AMBIENT_NODE evaluates ambient light", () => {
    const res = LIGHT_AMBIENT_NODE.evaluate(
      { intensity: 0.8 },
      { intensity: 0.4 },
      { ...CTX, nodeId: "amb-1" }
    );
    const light = res.light as THREE.AmbientLight;
    expect(light).toBeInstanceOf(THREE.AmbientLight);
    expect(light.intensity).toBe(0.8);
  });

  it("LIGHT_DIRECTIONAL_NODE applies shadowSoftness to shadow.radius", () => {
    const res = LIGHT_DIRECTIONAL_NODE.evaluate(
      { shadowSoftness: 3.5 },
      { shadowSoftness: 1 },
      { ...CTX, nodeId: "dir-softness" }
    );
    const light = res.light as THREE.DirectionalLight;
    expect(light.shadow.radius).toBeCloseTo(3.5);
  });

  it("LIGHT_POINT_NODE applies shadowSoftness to shadow.radius", () => {
    const res = LIGHT_POINT_NODE.evaluate(
      {},
      { shadowSoftness: 2.5 },
      { ...CTX, nodeId: "pt-softness" }
    );
    const light = res.light as THREE.PointLight;
    expect(light.shadow.radius).toBeCloseTo(2.5);
  });

  it("LIGHT_SPOT_NODE applies shadowSoftness to shadow.radius", () => {
    const res = LIGHT_SPOT_NODE.evaluate(
      { shadowSoftness: 4.0 },
      { shadowSoftness: 1 },
      { ...CTX, nodeId: "spot-softness" }
    );
    const light = res.light as THREE.SpotLight;
    expect(light.shadow.radius).toBeCloseTo(4.0);
  });
});
