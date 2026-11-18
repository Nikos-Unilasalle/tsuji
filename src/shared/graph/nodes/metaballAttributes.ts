import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { BLOB_ATTRIBUTES_KEY, BlobAttributes } from "./blobElements";
import { numberInput } from "./object";

interface Tagged {
  source: THREE.Object3D;
  key: string;
  output: THREE.Object3D;
}

const taggedCache = createNodeCache<Tagged>();

/** Everything a shallow clone snapshots from the source tree: where each part is and whether it shows. */
function poseKey(root: THREE.Object3D): string {
  const parts: number[] = [];
  root.traverse((o) => {
    parts.push(o.id, o.visible ? 1 : 0, o.children.length);
    parts.push(...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray());
    if (!o.matrixAutoUpdate) parts.push(...o.matrix.elements);
  });
  return parts.join(",");
}

/**
 * Metaball Attributes — gives one object (a sphere, a box, a group of them) its own metaball
 * settings, so a single Metaballs node can mix a tight, sharp blob with a soft, wide-blending one.
 * Wire it between the object and Metaballs' Centres or Carve input (or a Blob Field).
 *
 * Radius: the blob's size (0 = Metaballs' Radius, or Carve Radius on a carver).
 * Smooth: how far it reaches to blend with its neighbours, as a multiple of its radius (0 = Metaballs'
 *   Smooth). A lone blob keeps its radius whatever its Smooth; only the blending changes.
 * Weight: field strength — above 1 it swells into its neighbours, below 0 it carves (on a carver, the
 *   carve strength).
 * Resolution: Metaballs meshes the whole field on one grid, so this can only refine the whole mesh —
 *   the finest asked for wins (0 = Metaballs' Resolution).
 *
 * Per-element lists wired into Metaballs (Radii, Weights) still win over these.
 *
 * Tags a shallow copy (geometry and material shared), never the incoming object: that one belongs
 * to the node upstream, and a tag left on it would outlive this node being unwired.
 */
export const METABALL_ATTRIBUTES_NODE: NodeDefinition = {
  type: "object/metaball-attributes",
  label: "Metaball Attributes",
  category: "object",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "smooth", label: "Smooth", type: "value" },
    { id: "weight", label: "Weight", type: "value" },
    { id: "resolution", label: "Resolution", type: "value" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: { radius: 0, smooth: 0, weight: 1, resolution: 0 },
  paramFields: [
    { id: "radius", label: "Radius (0 = Metaballs')", kind: "number", step: 0.05 },
    { id: "smooth", label: "Smooth — blend reach (0 = Metaballs')", kind: "number", step: 0.05 },
    { id: "weight", label: "Weight (<0 carves)", kind: "number", step: 0.1 },
    { id: "resolution", label: "Resolution (0 = Metaballs'; refines the whole mesh)", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const root = inputs.geometry;
    if (!(root instanceof THREE.Object3D)) return { geometry: undefined };

    const radius = numberInput(inputs.radius, params.radius, 0);
    const smooth = numberInput(inputs.smooth, params.smooth, 0);
    const weight = numberInput(inputs.weight, params.weight, 1);
    const resolution = numberInput(inputs.resolution, params.resolution, 0);
    const attributes: BlobAttributes = { weight };
    if (radius > 0) attributes.radius = radius;
    if (smooth > 0) attributes.smooth = smooth;
    if (resolution > 0) attributes.resolution = resolution;

    const key = `${JSON.stringify(attributes)}|${poseKey(root)}`;
    const cached = taggedCache.get(ctx.nodeId);
    if (cached && cached.source === root && cached.key === key) return { geometry: cached.output };

    const output = root.clone();
    output.userData = { ...output.userData, [BLOB_ATTRIBUTES_KEY]: attributes };
    taggedCache.set(ctx.nodeId, { source: root, key, output });
    return { geometry: output };
  },
};
