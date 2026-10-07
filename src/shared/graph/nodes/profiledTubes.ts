import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { evalProfileCurve, ProfilePoint } from "../profileCurve";
import { composeNativeMatrix, asVector3 } from "./transform";
import {
  applyMaterialParams,
  asColor,
  buildPrimitiveDynamicParamFields,
  COMMON_DEFAULT_PARAMS,
  COMMON_PRIMITIVE_INPUTS,
  COMMON_PRIMITIVE_OUTPUTS,
  extractMaterialParams,
  extractTextureParams,
  numberInput,
  primitiveOutputs,
} from "./object";
import { createTubeGeometry, smoothSeams, vertsPerStrand, writeTube } from "../tubes/tubeMesh";
import { clearPatches, paintPatches, PATCH_PRESETS } from "../tubes/patches";

const FLAT: ProfilePoint[] = [{ x: 0, y: 1 }, { x: 1, y: 1 }];

/** Body shapes by name: picking one fills in the profiles and proportions; every value stays editable after. */
const SHAPE_PRESETS: Record<string, Record<string, unknown>> = {
  Koi: {
    widthProfile: [{ x: 0, y: 0.55 }, { x: 0.08, y: 0.85 }, { x: 0.22, y: 1 }, { x: 0.42, y: 0.9 }, { x: 0.62, y: 0.58 }, { x: 0.8, y: 0.28 }, { x: 0.87, y: 0.2 }, { x: 0.94, y: 0.55 }, { x: 1, y: 0.85 }],
    heightProfile: [{ x: 0, y: 0.5 }, { x: 0.15, y: 0.85 }, { x: 0.35, y: 0.8 }, { x: 0.6, y: 0.55 }, { x: 0.8, y: 0.3 }, { x: 0.88, y: 0.15 }, { x: 1, y: 0.05 }],
    radius: 0.16, relativeRadius: true, heightRatio: 0.55, upright: true,
  },
  Eel: {
    widthProfile: [{ x: 0, y: 0.6 }, { x: 0.1, y: 1 }, { x: 0.7, y: 0.7 }, { x: 1, y: 0.12 }],
    heightProfile: [{ x: 0, y: 0.6 }, { x: 0.1, y: 1 }, { x: 0.7, y: 0.85 }, { x: 1, y: 0.3 }],
    radius: 0.05, relativeRadius: true, heightRatio: 1.4, upright: true,
  },
  Snake: {
    widthProfile: [{ x: 0, y: 0.75 }, { x: 0.06, y: 1 }, { x: 0.1, y: 0.8 }, { x: 0.7, y: 0.75 }, { x: 1, y: 0.05 }],
    heightProfile: FLAT,
    radius: 0.035, relativeRadius: true, heightRatio: 0.75, upright: true,
  },
  Tentacle: {
    widthProfile: [{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.04 }],
    heightProfile: FLAT,
    radius: 0.06, relativeRadius: true, heightRatio: 1, upright: false,
  },
  Worm: {
    widthProfile: [{ x: 0, y: 0.6 }, { x: 0.08, y: 1 }, { x: 0.92, y: 1 }, { x: 1, y: 0.6 }],
    heightProfile: FLAT,
    radius: 0.05, relativeRadius: true, heightRatio: 1, upright: false,
  },
};

interface TubeState {
  mesh?: THREE.Mesh;
  layout?: string;
  paint?: string;
  counts: number[];
  strands: Float64Array[];
}

const tubeCache = createNodeCache<TubeState>((state) => {
  if (state.mesh) disposeObject3D(state.mesh);
});

/** Reads each sub-list into a flat x,y,z buffer, dropping bad points and lists too short to sweep. */
function readStrands(raw: unknown, state: TubeState): void {
  state.counts.length = 0;
  if (!Array.isArray(raw)) return;
  let s = 0;
  for (const list of raw) {
    if (!Array.isArray(list)) continue;
    let buf = state.strands[s];
    if (!buf || buf.length < list.length * 3) buf = state.strands[s] = new Float64Array(list.length * 3);
    let m = 0;
    for (const p of list) {
      const v = asVector3(p, new THREE.Vector3(Number.NaN, 0, 0));
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
      buf[m * 3] = v.x;
      buf[m * 3 + 1] = v.y;
      buf[m * 3 + 2] = v.z;
      m++;
    }
    if (m < 2) continue;
    state.counts.push(m);
    s++;
  }
}

function strandLength(buf: Float64Array, m: number): number {
  let len = 0;
  for (let k = 1; k < m; k++) len += Math.hypot(buf[k * 3] - buf[k * 3 - 3], buf[k * 3 + 1] - buf[k * 3 - 2], buf[k * 3 + 2] - buf[k * 3 - 1]);
  return len;
}

function sampleProfile(points: unknown, m: number): Float64Array {
  const pts = Array.isArray(points) ? (points as ProfilePoint[]) : FLAT;
  const out = new Float64Array(m);
  for (let k = 0; k < m; k++) out[k] = evalProfileCurve(pts, m > 1 ? k / (m - 1) : 0);
  return out;
}

const EXTRA_FIELDS: ParamFieldDef[] = [
  {
    id: "shapePreset",
    label: "Shape Preset",
    kind: "select",
    options: ["Custom", ...Object.keys(SHAPE_PRESETS)],
    presets: SHAPE_PRESETS,
    group: "Tube",
  },
  { id: "radius", label: "Radius", kind: "number", step: 0.01, group: "Tube" },
  { id: "relativeRadius", label: "Radius × Strand Length", kind: "boolean", group: "Tube" },
  { id: "heightRatio", label: "Height Ratio", kind: "number", step: 0.05, group: "Tube" },
  { id: "widthProfile", label: "Width Profile", kind: "curve_profile", group: "Tube" },
  { id: "heightProfile", label: "Height Profile", kind: "curve_profile", group: "Tube" },
  { id: "radialSegments", label: "Sides", kind: "number", step: 1, group: "Tube" },
  { id: "upright", label: "Keep Upright", kind: "boolean", group: "Tube" },
  { id: "patches", label: "Patches", kind: "boolean", group: "Patches" },
  {
    id: "patchPreset",
    label: "Patch Preset",
    kind: "select",
    options: ["Custom", ...Object.keys(PATCH_PRESETS)],
    presets: Object.fromEntries(Object.entries(PATCH_PRESETS).map(([k, v]) => [k, { ...v, patches: true }])),
    group: "Patches",
  },
  { id: "patchBase", label: "Base", kind: "color", group: "Patches" },
  { id: "patchA", label: "Patch Colour A", kind: "color", group: "Patches" },
  { id: "coverageA", label: "Coverage A", kind: "number", step: 0.05, group: "Patches" },
  { id: "patchB", label: "Patch Colour B", kind: "color", group: "Patches" },
  { id: "coverageB", label: "Coverage B", kind: "number", step: 0.05, group: "Patches" },
  { id: "patchScale", label: "Patch Frequency", kind: "number", step: 0.5, group: "Patches" },
  { id: "topBias", label: "Top Bias", kind: "number", step: 0.1, group: "Patches" },
  { id: "patchVariation", label: "Variation per Strand", kind: "number", step: 0.05, group: "Patches" },
  { id: "patchSeed", label: "Seed", kind: "number", step: 1, group: "Patches" },
];

/**
 * Profiled Tubes — a tube swept along every point list, its width and height
 * shaped from start to end by two profile curves, all merged into one mesh.
 *
 * Built for strands that move every frame (Spine Chain, trails, ropes): the
 * mesh is kept and only its vertices are rewritten, unless the number of
 * strands or their point counts change. Shape Preset fills the profiles for a
 * koi, an eel, a snake, a tentacle or a worm; Patches paints blotches of two
 * colours over a base, differently on every strand.
 */
export const PROFILED_TUBES_NODE: NodeDefinition = {
  type: "curve/profiled-tubes",
  label: "Profiled Tubes",
  category: "curve",
  inputs: [{ id: "pointLists", label: "Point Lists", type: "list" }, ...COMMON_PRIMITIVE_INPUTS],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    shapePreset: "Custom",
    radius: 0.1,
    relativeRadius: false,
    heightRatio: 1,
    widthProfile: [{ x: 0, y: 1 }, { x: 0.7, y: 0.8 }, { x: 1, y: 0.15 }],
    heightProfile: FLAT,
    radialSegments: 10,
    upright: true,
    patches: false,
    patchPreset: "Custom",
    ...PATCH_PRESETS.Koi,
    patchSeed: 1,
  },
  paramFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS),
  evaluate: (inputs, params, ctx) => {
    let state = tubeCache.get(ctx.nodeId);
    if (!state) {
      state = { counts: [], strands: [] };
      tubeCache.set(ctx.nodeId, state);
    }
    readStrands(inputs.pointLists, state);
    const counts = state.counts;
    const radial = Math.max(3, Math.min(48, Math.round(numberInput(undefined, params.radialSegments, 10))));

    const layout = `${counts.join(",")}:${radial}`;
    if (!state.mesh) {
      const mesh = new THREE.Mesh(createTubeGeometry(counts, radial), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.userData.nodeId = ctx.nodeId;
      state.mesh = mesh;
      state.layout = layout;
    } else if (state.layout !== layout) {
      state.mesh.geometry.dispose();
      state.mesh.geometry = createTubeGeometry(counts, radial);
      state.layout = layout;
      state.paint = undefined;
    }
    const mesh = state.mesh;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const radius = Math.max(0, numberInput(undefined, params.radius, 0.1));
    const relative = toBoolean(params.relativeRadius);
    const heightRatio = Math.max(0, numberInput(undefined, params.heightRatio, 1));
    const upright = toBoolean(params.upright ?? true);
    const positions = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const profiles = new Map<number, { w: Float64Array; h: Float64Array }>();
    let offset = 0;
    counts.forEach((m, s) => {
      let prof = profiles.get(m);
      if (!prof) profiles.set(m, (prof = { w: sampleProfile(params.widthProfile, m), h: sampleProfile(params.heightProfile, m) }));
      const buf = state!.strands[s];
      const r = relative ? radius * strandLength(buf, m) : radius;
      writeTube(positions, offset, buf, m, radial, prof.w, prof.h, { radius: r, heightRatio, upright });
      offset += vertsPerStrand(m, radial);
    });
    positions.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    smoothSeams(mesh.geometry, counts, radial);
    mesh.geometry.computeBoundingSphere();

    const patches = toBoolean(params.patches);
    const patch = {
      base: asColor(params.patchBase, new THREE.Color(0xffffff)),
      colorA: asColor(params.patchA, new THREE.Color(0xd9452b)),
      colorB: asColor(params.patchB, new THREE.Color(0x1c1b1d)),
      coverageA: numberInput(undefined, params.coverageA, 0.45),
      coverageB: numberInput(undefined, params.coverageB, 0.12),
      scale: Math.max(0, numberInput(undefined, params.patchScale, 2.5)),
      topBias: numberInput(undefined, params.topBias, 0),
      variation: Math.max(0, Math.min(1, numberInput(undefined, params.patchVariation, 0))),
      seed: numberInput(undefined, params.patchSeed, 1),
    };
    const paintKey = patches
      ? `${layout}|${patch.base.getHexString()}${patch.colorA.getHexString()}${patch.colorB.getHexString()}|${patch.coverageA}|${patch.coverageB}|${patch.scale}|${patch.topBias}|${patch.variation}|${patch.seed}`
      : `${layout}|off`;
    if (state.paint !== paintKey) {
      if (patches) paintPatches(mesh.geometry, counts, radial, patch);
      else clearPatches(mesh.geometry);
      state.paint = paintKey;
    }

    applyMaterialParams(mesh, extractMaterialParams(inputs, params), THREE.FrontSide, extractTextureParams(inputs, params, ctx.nodeId));
    const material = mesh.material;
    if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial) {
      if (material.vertexColors !== patches) {
        material.vertexColors = patches;
        material.needsUpdate = true;
      }
    }
    return primitiveOutputs(mesh, params);
  },
};
