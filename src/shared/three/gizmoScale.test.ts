import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { CENTRE_SCALE_PX, centreScaleFactor, installScaleGizmoTweaks } from "./gizmoScale";

function setUp(shift: { held: boolean }) {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  const controls = new TransformControls(camera);
  const scene = new THREE.Scene();
  const object = new THREE.Object3D();
  object.scale.set(2, 2, 2);
  scene.add(object);
  scene.add(controls.getHelper());
  controls.attach(object);
  controls.setMode("scale");
  installScaleGizmoTweaks(controls, () => ({ width: 800, height: 600 }), () => shift.held);
  const c = controls as unknown as {
    axis: string | null;
    pointerDown(p: unknown): void;
    pointerMove(p: unknown): void;
    _scaleStart: THREE.Vector3;
  };
  return { controls, c, object };
}

describe("scale gizmo", () => {
  it("grows with travel, and shrinks by the same amount with Shift", () => {
    expect(centreScaleFactor(0, false)).toBe(1);
    expect(centreScaleFactor(CENTRE_SCALE_PX, false)).toBeCloseTo(2);
    expect(centreScaleFactor(CENTRE_SCALE_PX, true)).toBeCloseTo(0.5);
  });

  it("scales from the centre handle by how far the pointer travelled, whichever way", () => {
    const shift = { held: false };
    const { c, object } = setUp(shift);
    c.axis = "XYZ";
    c.pointerDown({ x: 0, y: 0, button: 0 });
    // 150 px to the left (NDC: 2 units across 800 px): towards the centre or not, it grows.
    c.pointerMove({ x: -150 / 400, y: 0, button: -1 });
    expect(object.scale.x).toBeCloseTo(4);
    expect(object.scale.z).toBeCloseTo(4);
    shift.held = true;
    c.pointerMove({ x: -150 / 400, y: 0, button: -1 });
    expect(object.scale.x).toBeCloseTo(1);
    expect(object.scale.y).toBeCloseTo(1);
  });

  it("snaps the centre handle's scale to the step when one is set (Ctrl / Cmd)", () => {
    const { controls, c, object } = setUp({ held: false });
    controls.scaleSnap = 1;
    c.axis = "XYZ";
    c.pointerDown({ x: 0, y: 0, button: 0 });
    // ×1.4 of 2 is 2.8: snapped to 3.
    c.pointerMove({ x: (0.4 * CENTRE_SCALE_PX) / 400, y: 0, button: -1 });
    expect(object.scale.x).toBe(3);
    expect(object.scale.y).toBe(3);
  });

  it("scales all three axes from an axis handle with Shift, only that one without", () => {
    const shift = { held: false };
    const { c, object } = setUp(shift);
    c.axis = "X";
    c.pointerDown({ x: 0.05, y: 0, button: 0 });
    c.pointerMove({ x: 0.1, y: 0, button: -1 });
    const sx = object.scale.x;
    expect(sx).not.toBeCloseTo(2);
    expect(object.scale.y).toBeCloseTo(2);
    shift.held = true;
    c.pointerMove({ x: 0.1, y: 0, button: -1 });
    expect(object.scale.x).toBeCloseTo(sx);
    expect(object.scale.y).toBeCloseTo(sx);
    expect(object.scale.z).toBeCloseTo(sx);
  });
});
