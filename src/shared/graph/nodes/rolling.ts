import * as THREE from "three";
import { DEFAULT_ROTATION_MODE, ROTATION_ORDER_FIELD, quaternionToRotation } from "../rotationMode";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { asVector3 } from "./transform";

interface RollingState {
  prevPosition?: THREE.Vector3;
  /** The rotation accumulated so far — has to persist across frames, unlike Velocity's speed: rolling is the *integral* of motion, not an instantaneous reading of it. */
  quaternion: THREE.Quaternion;
  /**
   * Signed angle accumulated so far, for a polygonal shape's bob. Signed (not
   * a running |angle|): the bob has to come back *down* when the object rolls
   * backward, and the sign of each step is taken from whether the roll axis
   * flipped (see evaluate). Never used in round mode.
   */
  totalAngle: number;
  /** The last step's roll axis, for the sign test above. */
  lastRollAxis?: THREE.Vector3;
}

const rollingCache = createNodeCache<RollingState>();

function getState(nodeId: string): RollingState {
  let state = rollingCache.get(nodeId);
  if (!state) {
    state = { quaternion: new THREE.Quaternion(), totalAngle: 0 };
    rollingCache.set(nodeId, state);
  }
  return state;
}

const DEFAULT_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * The cross-section shapes Rolling can tumble. "round" is the original
 * ball — a constant-radius roll. The polygonal ones are *prisms*: a square
 * (or triangle, hexagon, octagon) seen from the end, rolling by tipping over
 * one edge after another.
 */
export const ROLLING_SHAPES = ["round", "triangle", "square", "hexagon", "octagon"] as const;
export type RollingShape = (typeof ROLLING_SHAPES)[number];

/** Number of sides each shape presents to the rolling plane (0 = round). */
function sidesOf(shape: RollingShape): number {
  switch (shape) {
    case "triangle":
      return 3;
    case "square":
      return 4;
    case "hexagon":
      return 6;
    case "octagon":
      return 8;
    default:
      return 0;
  }
}

/**
 * Rolling — turns an object's own movement into the spin a ball rolling on
 * the ground without slipping would have, so a sphere driven by Location
 * looks like it's actually rolling there instead of sliding while it spins
 * on noise.
 *
 * Unlike Velocity (`math/velocity`), which only ever reports the current
 * instant, a rolling ball's orientation is the *sum* of every bit of travel
 * since it started — so this keeps its own running rotation (a quaternion,
 * not degrees-per-frame) and adds to it, the same "state has to survive
 * between evaluate() calls" shape Trail keeps its sample history in.
 *
 * Per frame: the displacement since the last read is flattened onto the
 * rolling plane (whatever moved along Axis is climbing/falling, not
 * rolling), rotated by Axis × displacement to get the physically correct
 * roll axis, and turned by distance / r_eff radians — the standard
 * rolling-without-slipping relation. Reversing direction naturally unrolls
 * it; no separate "reverse" logic needed.
 *
 * `Size` is the shape's own natural dimension — a sphere's *diameter*, a
 * polygon's *side length* — and the node derives the radii from it
 * (r = size/(2·tan(π/N)), R = size/(2·sin(π/N))), so nobody has to compute
 * a cube's inradius themselves (s√3/2 is its circumradius, a different
 * number, which is exactly the kind of mistake this saves).
 *
 * With a polygonal `shape` (square, hexagon, ...) the same displacement is
 * turned into a *tumble*: the object tips over one edge at a time, so the
 * rotation per unit distance uses the polygon's effective radius
 * (r_eff = N·r·tan(π/N)/π, the rolling-without-slipping radius whose full
 * turn equals the polygon's perimeter), and its centre bobs with the tip —
 * up to the circumradius at the diagonal, down to the inscribed radius on
 * each flat. That bob is what couples a cube's vertical motion to its
 * rotation: wire `position` into the object's Location and it visibly rolls
 * instead of grinding along one face.
 *
 * This is a kinematic model — constant contact, uniform tip rate, a
 * sinusoidal bob — not the free-fall dynamics of a real tumbling cube. That
 * is the right trade for a tool where something else owns the motion: a
 * genuinely ballistic tumble would have to take the position over.
 */
export const ROLLING_NODE: NodeDefinition = {
  type: "physics/rolling",
  label: "Rolling",
  category: "physics",
  inputs: [
    { id: "position", label: "Position", type: "vector" },
    { id: "size", label: "Size", type: "value" },
    { id: "axis", label: "Rolling Plane Normal (Up)", type: "vector" },
  ],
  outputs: [
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "position", label: "Position (bobbed)", type: "vector" },
    { id: "bob", label: "Bob", type: "value" },
  ],
  defaultParams: {
    shape: "round",
    size: 1,
    axis: DEFAULT_AXIS.clone(),
    rotationMode: DEFAULT_ROTATION_MODE,
  },
  paramFields: [
    { id: "shape", label: "Shape", kind: "select", options: [...ROLLING_SHAPES] },
    ROTATION_ORDER_FIELD,
    { id: "size", label: "Size (diameter for round, side length for polygonal)", kind: "number", step: 0.05 },
    { id: "axis", label: "Rolling Plane Normal (Up)", kind: "vector" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    const position = asVector3(inputs.position, new THREE.Vector3());
    // Size is "how big the thing is", in the shape's own natural unit: a
    // sphere's diameter (its radius is half of it), a polygon's side length.
    // The node derives the inscribed radius r from it, so nobody has to work
    // out e.g. a cube's inradius (s√3/2 is its *circum*radius) to feed it.
    const size = Math.max(1e-4, inputs.size !== undefined ? Number(inputs.size) || 0 : Number(params.size) || 1);
    // asVector3 can hand back the *wired* node's own Vector3 — clone before
    // normalizing so this node never mutates an upstream object (other
    // consumers of the same wire would see a normalized axis).
    const axis = asVector3(inputs.axis, params.axis instanceof THREE.Vector3 ? params.axis : DEFAULT_AXIS)
      .clone()
      .normalize();
    if (axis.lengthSq() < 1e-8) axis.copy(DEFAULT_AXIS);

    const shape: RollingShape = (ROLLING_SHAPES as readonly string[]).includes(String(params.shape))
      ? (params.shape as RollingShape)
      : "round";
    const sides = sidesOf(shape);

    // Inscribed radius (centre to a face) and circumradius (centre to a
    // vertex). For a round shape both are the ball's radius.
    const inscribed = sides >= 3 ? size / (2 * Math.tan(Math.PI / sides)) : size / 2;
    const circum = sides >= 3 ? size / (2 * Math.sin(Math.PI / sides)) : inscribed;

    if (!state.prevPosition) {
      // First read: nothing to have moved from yet. Seeding here (rather
      // than defaulting prevPosition to the origin) is what stops a ball
      // that merely *starts* away from (0,0,0) from spinning once, hard, on
      // its very first frame.
      state.prevPosition = position.clone();
    } else {
      const delta = new THREE.Vector3().subVectors(position, state.prevPosition);
      const alongAxis = delta.dot(axis);
      const deltaFlat = delta.clone().sub(axis.clone().multiplyScalar(alongAxis));
      const distance = deltaFlat.length();

      if (distance > 1e-7) {
        // n × v (not v × n): with axis = +Y and travel along +X, this gives
        // -Z — rotating the ball's top toward +X, the direction it's
        // actually moving. The other cross-product order rolls it backward.
        const rollAxis = new THREE.Vector3().crossVectors(axis, deltaFlat).normalize();
        // Polygons roll further per radian than a ball of the same inscribed
        // radius: r_eff grows from r toward r·N/π as the polygon corners cut
        // the rolling circle down to its inscribed circle. One full turn
        // (= 2π) then covers the polygon's whole perimeter, which is what
        // makes the tips land exactly edge-on-edge instead of accumulating.
        const rEff =
          sides >= 3
            ? (sides * inscribed * Math.tan(Math.PI / sides)) / Math.PI
            : inscribed;
        // The quaternion keeps the *unsigned* angle — reversing direction
        // flips rollAxis 180°, which already unrolls it (the way a ball
        // always unrolled before this node knew about shapes). The bob phase
        // is the one thing that wants a signed angle: it must come back down
        // when the object rolls backward, and the sign of rollAxis's dot with
        // the previous one is the direction.
        const angle = distance / rEff;
        state.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(rollAxis, angle));
        const sign = state.lastRollAxis && rollAxis.dot(state.lastRollAxis) < 0 ? -1 : 1;
        state.totalAngle += angle * sign;
        state.lastRollAxis = rollAxis;
      }
      state.prevPosition.copy(position);
    }

    // A polygonal prism's centre sits at the inscribed radius while a face is
    // down and rises to the circumradius as the diagonal comes up — the bob
    // tracks the phase within the current tip (totalAngle mod 2π/N) so the
    // vertical motion stays coupled to exactly the rotation the cube shows.
    let bob = 0;
    if (sides >= 3) {
      const tip = (2 * Math.PI) / sides;
      const phase = ((state.totalAngle % tip) + tip) % tip;
      bob = circum * Math.cos(Math.PI / sides - phase) - inscribed;
    }

    const { rotation } = quaternionToRotation(state.quaternion, params);
    const correctedPosition = position.clone().addScaledVector(axis, bob);
    return { rotation, position: correctedPosition, bob };
  },
};
