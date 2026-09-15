import * as THREE from "three";
import { bakeMeshesToGeometry } from "../bakeGeometry";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { sideSignature } from "../geometrySignature";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { numberInput, primitiveOutputs } from "./object";
import { disposeGeometryBvh } from "../../three/bvh";
import { sampleSignedDistance, smoothMax, smoothMin, voxelGridFor } from "../../three/sdf/meshSdf";
import { VoxelGrid, gridSampleCount, relaxGeometry, surfaceNets } from "../../three/sdf/surfaceNets";

/**
 * Weld — two shapes joined with a soft fillet at their intersection, so they
 * read as one object rather than two that overlap.
 *
 * Boolean (CSG) already unions two meshes, but it unions them *exactly*: the
 * seam is the sharp crease where the two surfaces cross. Welding needs the
 * surface to be re-derived, not re-cut, so this goes through a distance field —
 * both shapes are sampled into one voxel grid, combined with a smooth minimum
 * (the fillet is a property of the blend, no seam to find or bevel), and the
 * result re-meshed with Surface Nets.
 *
 * What that costs, and what it gives up, both follow from the grid: the output
 * is a fresh uniform mesh, so the inputs' UVs, materials-per-face and topology
 * are gone (a box projection is generated to keep textured materials drawing),
 * and detail finer than one voxel is gone with them. Raise Resolution until the
 * shape holds; the work is cubic in it.
 */

interface WeldState {
  mesh?: THREE.Mesh;
  lastSignature?: string;
}

const weldCache = createNodeCache<WeldState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(nodeId: string): WeldState {
  let state = weldCache.get(nodeId);
  if (!state) {
    state = {};
    weldCache.set(nodeId, state);
  }
  return state;
}

function disposeBaked(geometry: THREE.BufferGeometry): void {
  disposeGeometryBvh(geometry);
  geometry.dispose();
}

/**
 * Past this many samples the voxel pass stops being a pause and starts being a
 * hang. Hit by aspect ratio rather than by the Resolution knob: Resolution
 * counts samples along the LONGEST axis, so two shapes welded end to end at 96
 * are a slab of grid that is mostly empty space.
 */
const MAX_SAMPLES = 6_000_000;

/** The resolution that keeps `box` under the sample cap, at most the one asked for. */
function affordableResolution(box: THREE.Box3, requested: number): number {
  let resolution = requested;
  while (resolution > 8 && gridSampleCount(voxelGridFor(box, resolution)) > MAX_SAMPLES) {
    resolution = Math.floor(resolution * 0.8);
  }
  return resolution;
}

/**
 * Box-projected UVs, per vertex, off the dominant axis of its normal.
 *
 * The welded surface has no UV of its own to inherit — the inputs' parameter
 * spaces do not survive being turned into a distance field. A projection is not
 * a substitute for a real unwrap (it seams wherever the dominant axis flips),
 * but a textured material with no uv attribute at all draws as a flat colour,
 * which reads as the node having broken the material.
 */
function applyBoxUvs(geometry: THREE.BufferGeometry, box: THREE.Box3): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || !normal) return;
  const size = box.getSize(new THREE.Vector3());
  const sx = size.x || 1;
  const sy = size.y || 1;
  const sz = size.z || 1;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const px = position.getX(i);
    const py = position.getY(i);
    const pz = position.getZ(i);
    const ax = Math.abs(normal.getX(i));
    const ay = Math.abs(normal.getY(i));
    const az = Math.abs(normal.getZ(i));
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) {
      u = (pz - box.min.z) / sz;
      v = (py - box.min.y) / sy;
    } else if (ay >= az) {
      u = (px - box.min.x) / sx;
      v = (pz - box.min.z) / sz;
    } else {
      u = (px - box.min.x) / sx;
      v = (py - box.min.y) / sy;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function combine(operation: string, a: number, b: number, k: number): number {
  if (operation === "subtract") return smoothMax(a, -b, k);
  if (operation === "intersect") return smoothMax(a, b, k);
  return smoothMin(a, b, k);
}

/** The welded surface of two baked, world-space geometries. Exported for the tests. */
export function weldGeometries(
  geometryA: THREE.BufferGeometry,
  geometryB: THREE.BufferGeometry,
  options: { blend: number; resolution: number; operation: string; relax: number },
): { geometry: THREE.BufferGeometry; grid: VoxelGrid; box: THREE.Box3 } {
  geometryA.computeBoundingBox();
  geometryB.computeBoundingBox();
  const box = new THREE.Box3();
  if (geometryA.boundingBox) box.union(geometryA.boundingBox);
  if (geometryB.boundingBox) box.union(geometryB.boundingBox);

  const blend = Math.max(0, options.blend);
  // Pad first with a guess at the voxel size, then measure the real one: the
  // surface has to have empty samples on every side of it or it is clipped flat
  // against the edge of the grid, and the fillet itself bulges outside the
  // union of the two shapes by up to the blend radius.
  const probe = voxelGridFor(box, options.resolution);
  const padded = box.clone().expandByScalar(blend + probe.spacing * 3);
  const grid = voxelGridFor(padded, affordableResolution(padded, options.resolution));

  // Distances are only ever compared against each other within the blend
  // radius, so the samplers may clamp beyond that — but the clamp has to sit
  // far enough out that two clamped values never produce a fillet of their own
  // (smoothMin pulls a pair of equal values down by k/4).
  const band = blend + grid.spacing * 3;
  const fieldA = sampleSignedDistance(geometryA, grid, band);
  const fieldB = sampleSignedDistance(geometryB, grid, band);
  for (let i = 0; i < fieldA.length; i++) {
    fieldA[i] = combine(options.operation, fieldA[i], fieldB[i], blend);
  }

  const geometry = surfaceNets(fieldA, grid);
  if (options.relax > 0) relaxGeometry(geometry, Math.round(options.relax), 0.5);
  applyBoxUvs(geometry, padded);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, grid, box: padded };
}

export const WELD_NODE: NodeDefinition = {
  type: "modifier/weld",
  label: "Weld",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "weld", label: "Weld Shape", type: "geometry", owns: true },
    { id: "blend", label: "Blend", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    blend: 0.25,
    resolution: 48,
    operation: "add",
    relax: 1,
  },
  paramFields: [
    { id: "operation", label: "Operation", kind: "select", options: ["add", "subtract", "intersect"] },
    { id: "blend", label: "Blend", kind: "number", step: 0.01 },
    { id: "resolution", label: "Resolution", kind: "number", step: 1 },
    { id: "relax", label: "Relax Passes", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const inputA = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const inputB = inputs.weld instanceof THREE.Object3D ? inputs.weld : null;
    if (!inputA || !inputB) {
      return inputA ? primitiveOutputs(inputA) : { geometry: null };
    }

    const meshesA = collectMeshes(inputA);
    const meshesB = collectMeshes(inputB);
    if (meshesA.length === 0 || meshesB.length === 0) {
      warnMeshRequired(ctx.nodeId, "Weld", meshesA.length > 0 ? inputB : inputA);
      return primitiveOutputs(inputA);
    }
    clearMeshWarning(ctx.nodeId);

    // Same reason Boolean forces this from each input's own root rather than
    // from the mesh it found: a mesh feeding a modifier is not drawn, so
    // nothing else keeps its world matrix fresh, and updateWorldMatrix does not
    // propagate `force` up to a posed wrapper group.
    inputA.updateMatrixWorld(true);
    inputB.updateMatrixWorld(true);

    const blend = Math.max(0, numberInput(inputs.blend, params.blend, 0.25));
    const resolution = Math.max(8, Math.min(128, Math.round(numberInput(undefined, params.resolution, 48))));
    const relax = Math.max(0, Math.min(8, Math.round(numberInput(undefined, params.relax, 1))));
    const operation = String(params.operation ?? "add");

    const state = getState(ctx.nodeId);
    const signature = JSON.stringify([
      operation,
      blend,
      resolution,
      relax,
      sideSignature(meshesA),
      sideSignature(meshesB),
    ]);
    if (state.mesh && state.lastSignature === signature) {
      return primitiveOutputs(state.mesh);
    }

    const geometryA = bakeMeshesToGeometry(meshesA);
    const geometryB = bakeMeshesToGeometry(meshesB);
    if (!geometryA || !geometryB) {
      if (geometryA) disposeBaked(geometryA);
      if (geometryB) disposeBaked(geometryB);
      console.error("Weld: could not merge the parts of an input into one shape");
      return primitiveOutputs(inputA);
    }

    try {
      const { geometry } = weldGeometries(geometryA, geometryB, { blend, resolution, operation, relax });
      if (geometry.getAttribute("position").count === 0) {
        // An empty result means the two shapes cancelled out (a subtract that
        // removed everything). Handing back a mesh with no vertices is better
        // than handing back the input unchanged, which would look like the
        // node had silently failed.
        console.warn("Weld: the result is empty");
      }

      if (!state.mesh) {
        state.mesh = new THREE.Mesh(geometry, meshesA[0].material);
        state.mesh.castShadow = true;
        state.mesh.receiveShadow = true;
      } else {
        disposeBaked(state.mesh.geometry);
        state.mesh.geometry = geometry;
        state.mesh.material = meshesA[0].material;
      }
      // Both inputs were baked into world space, so the result is already
      // positioned — its own transform is identity.
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.identity();
      state.lastSignature = signature;
      return primitiveOutputs(state.mesh);
    } catch (err) {
      console.error("Weld failed:", err);
      return primitiveOutputs(inputA);
    } finally {
      disposeBaked(geometryA);
      disposeBaked(geometryB);
    }
  },
};
