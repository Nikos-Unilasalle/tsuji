import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY, STARTER_NODES } from "./nodes";
import { NodeDefinition, ParamFieldDef } from "./types";

/**
 * The unit conventions for angle params, pinned so they can't drift.
 *
 * There are two ways a node can store an angle, and both are legitimate:
 *
 *  1. **Stored in radians**, marked `degrees: true` so the panel converts on
 *     the way in and out (ParamPanel's toDisplayUnit/toStoredUnit). Right
 *     when the value goes straight into three.js — a Euler, a
 *     texture.rotation, a RingGeometry arc.
 *
 *  2. **Stored in degrees**, with no flag at all. Right when everything that
 *     touches the param already speaks degrees: the node converts once in
 *     evaluate (`* DEG`, `rotate(Xdeg)`), and — for the HUD nodes — the
 *     viewport's rotate handle writes degrees straight back into it.
 *
 * What breaks is mixing them. Marking a degrees-stored param `degrees: true`
 * makes the panel the only writer that converts, so a typed 90 lands as
 * 1.5708 and is then read as 1.5708 degrees: the field says one thing and the
 * render does another (hub rotation, orbit phase/tilt and wiggle's Rot Amp
 * all had exactly this).
 *
 * Convention 1 has a second edge, because a param marked `degrees: true` may
 * also be a socket, and a Value node carries a plain unitless number:
 *
 *  - `value`-typed angle sockets read the wire as DEGREES, matching the label
 *    beside them (degreesInput in nodes/object.ts). Reading raw made "36"
 *    typed and "36" wired two different angles.
 *
 *  - `vector` rotation sockets stay RADIANS. Those are fed by other nodes'
 *    rotation *outputs* (Rolling, Decompose Matrix), so the unit has to
 *    survive a round trip through a wire rather than match a text field.
 *
 * These lists fail the suite when a new angle appears on either side, so
 * whoever adds it has to choose a convention rather than inherit whichever
 * behaviour a raw read happens to give.
 */

/** Convention 1, scalar: radians-stored, wired in degrees — must use degreesInput. */
const DEGREE_SCALAR_SOCKETS = [
  "lighting/environment.backgroundRotation",
  "object/disc.arcAngle",
  "object/disc.startAngle",
  "object/tree.branchAngle",
  "object/tree.curvature",
  "object/tree.droop",
  "physics/wind-field.angle",
].sort();

/** Convention 1, vector: radians-stored and radians on the wire — they carry rotations between nodes. */
const RADIAN_VECTOR_SOCKETS = [
  "calibration/camera.rotation",
  "modifier/clip-box.rotation",
  "modifier/extrude.rotation",
  "structure/geometry-transform.rotation",
  "transform.rotation",
  "transform/matrix-transform.rotation",
  "transform/pivot.rotation",
].sort();

/**
 * Convention 2: angle params stored in degrees. Marking any of these
 * `degrees: true` re-breaks the panel against its own node, so they are
 * pinned as explicitly unflagged.
 */
const DEGREE_STORED_PARAMS: [string, string][] = [
  ["hub/image", "rotation"],
  ["hub/text", "rotation"],
  ["transform/orbit", "phase"],
  ["transform/orbit", "tilt"],
  ["animation/wiggle", "rotationAmplitude"],
];

function degreeFieldIds(def: NodeDefinition): Set<string> {
  const fields: ParamFieldDef[] = [...(def.paramFields ?? [])];
  try {
    const dynamic = def.dynamicParamFields?.({
      id: "probe",
      type: def.type,
      position: { x: 0, y: 0 },
      params: def.defaultParams ?? {},
    } as never);
    if (dynamic) fields.push(...dynamic);
  } catch {
    // A dynamic field builder that needs a real instance contributes nothing
    // here; its static counterpart is already covered.
  }
  return new Set(fields.filter((f) => (f as { degrees?: boolean }).degrees).map((f) => f.id));
}

describe("angle units", () => {
  it("every degrees-marked socket is classified as scalar-degrees or vector-radians", () => {
    const scalars: string[] = [];
    const vectors: string[] = [];
    for (const def of STARTER_NODES) {
      const degreeIds = degreeFieldIds(def);
      if (degreeIds.size === 0) continue;
      for (const input of def.inputs ?? []) {
        if (!degreeIds.has(input.id)) continue;
        const key = `${def.type}.${input.id}`;
        if (input.type === "value") scalars.push(key);
        else vectors.push(key);
      }
    }
    expect([...new Set(scalars)].sort()).toEqual(DEGREE_SCALAR_SOCKETS);
    expect([...new Set(vectors)].sort()).toEqual(RADIAN_VECTOR_SOCKETS);
  });

  it("every rotation vector OUTPUT is in radians, so it can drive a rotation input", () => {
    // The other half of the vector convention. A `rotation` output exists to
    // be wired into a `rotation` input, and every consumer of one reads
    // radians (composeTransform via resolveRotationVector). Wiggle and Curve
    // Sample used to emit degrees — labelled "(°)" and everything — so
    // wiring either into a Transform spun it about 57x too far.
    //
    // A cheap smoke check on the label only — the behaviour is pinned in
    // nodes/angleParams.test.ts, which asserts each node's `rotation` output
    // agrees with the Euler of its own `matrix` output (57x apart if degrees
    // ever creep back in).
    for (const def of STARTER_NODES) {
      for (const out of def.outputs ?? []) {
        if (out.type !== "vector" || !/rot/i.test(out.id)) continue;
        expect(out.label, `${def.type}.${out.id} is labelled as degrees`).not.toContain("°");
      }
    }
  });

  it("degree-stored params are never marked degrees: true", () => {
    for (const [type, paramId] of DEGREE_STORED_PARAMS) {
      const def = DEFAULT_REGISTRY.get(type);
      expect(def, `${type} is missing from the registry`).toBeDefined();
      expect(degreeFieldIds(def!).has(paramId), `${type}.${paramId} must stay unflagged — it is stored in degrees`).toBe(false);
    }
  });
});
