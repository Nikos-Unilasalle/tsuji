import * as THREE from "three";
import type { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

/*
 * The scale gizmo, made easier to drive than three's own:
 *
 * - The centre handle (uniform scale) used to scale by the pointer's distance
 *   to the gizmo's centre against where the drag began — so shrinking meant
 *   steering into a few pixels around the centre. Now any movement grows the
 *   object, by how far the pointer has travelled on screen, and Shift turns
 *   that into shrinking: the same gesture, inverted.
 * - Dragging an axis handle (X, Y, Z) with Shift held scales all three axes
 *   by that axis's amount.
 */

/** Screen pixels of travel that double the size (centre handle). */
export const CENTRE_SCALE_PX = 150;

/** The centre handle's factor for `travelPx` of pointer travel: growing, or with `shrink` the inverse. */
export function centreScaleFactor(travelPx: number, shrink: boolean): number {
  const grow = 1 + Math.max(0, travelPx) / CENTRE_SCALE_PX;
  return shrink ? 1 / grow : grow;
}

/** Three's own rounding for a scale step, never down to zero. */
function snapScale(scale: THREE.Vector3, step: number | null) {
  if (!step) return;
  scale.set(
    Math.round(scale.x / step) * step || step,
    Math.round(scale.y / step) * step || step,
    Math.round(scale.z / step) * step || step,
  );
}

type Pointer = { x: number; y: number; button: number } | null;
type Controls = TransformControls & {
  pointerDown(pointer: Pointer): void;
  pointerMove(pointer: Pointer): void;
  _scaleStart: THREE.Vector3;
};

/**
 * Wraps a TransformControls instance's scale dragging (see above).
 * `viewportSize` is the canvas size in CSS pixels; `shiftHeld` the live
 * state of the Shift key.
 */
export function installScaleGizmoTweaks(
  transformControls: TransformControls,
  viewportSize: () => { width: number; height: number },
  shiftHeld: () => boolean,
): void {
  const controls = transformControls as Controls;
  const down = controls.pointerDown.bind(controls);
  const move = controls.pointerMove.bind(controls);
  let start: { x: number; y: number } | null = null;

  controls.pointerDown = (pointer: Pointer) => {
    start = pointer ? { x: pointer.x, y: pointer.y } : null;
    down(pointer);
  };

  controls.pointerMove = (pointer: Pointer) => {
    const object = controls.object;
    const axis = controls.axis;
    if (controls.mode !== "scale" || !controls.dragging || !axis || !object) return move(pointer);
    if (pointer !== null && pointer.button !== -1) return;

    if (axis === "XYZ") {
      if (!start || !pointer) return;
      // NDC to pixels: half the canvas per unit.
      const { width, height } = viewportSize();
      const travel = Math.hypot(((pointer.x - start.x) * width) / 2, ((pointer.y - start.y) * height) / 2);
      object.scale.copy(controls._scaleStart).multiplyScalar(centreScaleFactor(travel, shiftHeld()));
      snapScale(object.scale, controls.scaleSnap);
      controls.dispatchEvent({ type: "change" } as never);
      controls.dispatchEvent({ type: "objectChange" } as never);
      return;
    }

    move(pointer);
    if (shiftHeld() && (axis === "X" || axis === "Y" || axis === "Z")) {
      const k = axis.toLowerCase() as "x" | "y" | "z";
      const from = controls._scaleStart[k];
      const factor = Math.abs(from) > 1e-12 ? object.scale[k] / from : 1;
      object.scale.copy(controls._scaleStart).multiplyScalar(factor);
      snapScale(object.scale, controls.scaleSnap);
      controls.dispatchEvent({ type: "objectChange" } as never);
    }
  };
}
