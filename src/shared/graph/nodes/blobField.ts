import * as THREE from "three";
import { growingSockets } from "../dynamicInputs";
import { NodeDefinition } from "../types";
import {
  appendField,
  asRgb,
  BlobFieldElement,
  BlobFieldValue,
  collectCentres,
  collectSegments,
  finiteAt,
  isBlobField,
  listAt,
} from "./blobElements";
import { numberInput } from "./object";

/**
 * Blob Field nodes: metaball elements as a value on a wire, so fields can be
 * built in parts and composed before a Metaballs node meshes them — each part
 * with its own radius and weight, one part subtracted from another, a curve
 * turned into capsules, without lining up per-element lists on one node.
 *
 * Fields are in the space of whatever made them: point lists as given,
 * geometry wires in world space (unlike Metaballs' own Centres (Geometry),
 * which is relative to the wired root — a field mixes several sources, so
 * they need one common space).
 */

function field(elements: BlobFieldElement[]): BlobFieldValue {
  return { isBlobField: true, elements };
}

const WORLD = new THREE.Matrix4();

export const BLOB_FIELD_POINTS_NODE: NodeDefinition = {
  type: "field/blob-points",
  label: "Blob Field: Points",
  category: "object",
  inputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "geometry", label: "Geometry (children / instances)", type: "geometry", owns: true },
    { id: "radius", label: "Radius", type: "value" },
    { id: "weight", label: "Weight (<0 carves)", type: "value" },
    { id: "radii", label: "Radii (per point)", type: "list" },
    { id: "weights", label: "Weights (per point)", type: "list" },
    { id: "colors", label: "Colors (per point)", type: "list" },
  ],
  outputs: [
    { id: "field", label: "Blob Field", type: "blobfield" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { radius: 0.5, weight: 1, instanceShape: false, inheritColors: false },
  newNodeParams: { instanceShape: true, inheritColors: true },
  paramFields: [
    { id: "radius", label: "Radius", kind: "number", step: 0.05 },
    { id: "weight", label: "Weight (<0 carves)", kind: "number", step: 0.1 },
    { id: "instanceShape", label: "Instance Shape (ellipsoids)", kind: "boolean" },
    { id: "inheritColors", label: "Inherit Source Colors", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const radius = numberInput(inputs.radius, params.radius, 0.5);
    const weight = numberInput(inputs.weight, params.weight, 1);
    const elements: BlobFieldElement[] = [];
    collectCentres(inputs.points, inputs.geometry, WORLD).forEach((centre, i) => {
      const r = finiteAt(inputs.radii, i, radius);
      const w = finiteAt(inputs.weights, i, 1) * weight;
      if (!(r > 0) || !Number.isFinite(w) || w === 0) return;
      elements.push({
        kind: 0,
        a: [centre.point.x, centre.point.y, centre.point.z],
        radius: r,
        weight: w,
        color: asRgb(listAt(inputs.colors, i)) ?? (params.inheritColors === true ? centre.color : undefined),
        shape: params.instanceShape === true ? centre.shape : undefined,
      });
    });
    return { field: field(elements), count: elements.length };
  },
};

export const BLOB_FIELD_POLYLINE_NODE: NodeDefinition = {
  type: "field/blob-polyline",
  label: "Blob Field: Polyline",
  category: "object",
  inputs: [
    { id: "curve", label: "Curve", type: "curve" },
    { id: "points", label: "Points / Polylines", type: "list" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "weight", label: "Weight (<0 carves)", type: "value" },
    { id: "radii", label: "Radii (per segment)", type: "list" },
  ],
  outputs: [
    { id: "field", label: "Blob Field", type: "blobfield" },
    { id: "count", label: "Segments", type: "value" },
  ],
  defaultParams: { radius: 0.25, weight: 1, samples: 32 },
  paramFields: [
    { id: "radius", label: "Radius", kind: "number", step: 0.05 },
    { id: "weight", label: "Weight (<0 carves)", kind: "number", step: 0.1 },
    { id: "samples", label: "Curve Samples", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const radius = numberInput(inputs.radius, params.radius, 0.25);
    const weight = numberInput(inputs.weight, params.weight, 1);
    const elements: BlobFieldElement[] = [];
    if (!(radius > 0) || !Number.isFinite(weight) || weight === 0) return { field: field(elements), count: 0 };
    const listed = collectSegments(inputs.points);
    const segments = [...listed];
    if (inputs.curve instanceof THREE.Curve) {
      // The curve becomes one more polyline, chained after the listed ones.
      const samples = Math.max(2, Math.min(2000, Math.round(numberInput(undefined, params.samples, 32))));
      const chain = listed.reduce((m, segment) => Math.max(m, segment.chain), 0) + 1;
      const points = (inputs.curve as THREE.Curve<THREE.Vector3>).getSpacedPoints(samples - 1);
      for (const segment of collectSegments(points)) segments.push({ ...segment, chain });
    }
    segments.forEach((segment, i) => {
      const r = finiteAt(inputs.radii, i, radius);
      if (!(r > 0)) return;
      elements.push({
        kind: 1,
        a: [segment.a.x, segment.a.y, segment.a.z],
        b: [segment.b.x, segment.b.y, segment.b.z],
        radius: r,
        weight,
        chain: segment.chain || undefined,
      });
    });
    return { field: field(elements), count: elements.length };
  },
};

const IN_PREFIX = "in";

export const BLOB_FIELD_COMBINE_NODE: NodeDefinition = {
  type: "field/blob-combine",
  label: "Blob Field: Combine",
  category: "object",
  inputs: [
    { id: `${IN_PREFIX}0`, label: "Add 1", type: "blobfield" },
    { id: "subtract", label: "Subtract", type: "blobfield" },
  ],
  dynamicInputs: (connections) => [
    ...growingSockets(connections, IN_PREFIX, (i) => ({ id: `${IN_PREFIX}${i}`, label: `Add ${i + 1}`, type: "blobfield" })),
    { id: "subtract", label: "Subtract", type: "blobfield" },
  ],
  outputs: [
    { id: "field", label: "Blob Field", type: "blobfield" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { subtractStrength: 1 },
  paramFields: [{ id: "subtractStrength", label: "Subtract Strength", kind: "number", step: 0.1 }],
  evaluate: (inputs, params) => {
    const elements: BlobFieldElement[] = [];
    const keys = Object.keys(inputs)
      .filter((k) => k.startsWith(IN_PREFIX) && Number.isInteger(Number(k.slice(IN_PREFIX.length))))
      .sort((a, b) => Number(a.slice(IN_PREFIX.length)) - Number(b.slice(IN_PREFIX.length)));
    for (const key of keys) if (isBlobField(inputs[key])) appendField(elements, inputs[key].elements);
    if (isBlobField(inputs.subtract)) {
      // Subtracting flips the sign of every weight: what added now carves, and the reverse.
      const strength = numberInput(undefined, params.subtractStrength, 1);
      if (Number.isFinite(strength) && strength !== 0) appendField(elements, inputs.subtract.elements, -strength);
    }
    return { field: field(elements), count: elements.length };
  },
};
