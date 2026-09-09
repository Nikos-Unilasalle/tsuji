import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { asColor, numberInput, primitiveOutputs } from "./object";
import { composeNativeMatrix } from "./transform";
import { collectMeshes } from "../meshRequired";
import {
  DEFAULT_WIND,
  WindFieldDescriptor,
  applyWindUniforms,
  isWindField,
  sampleWind,
} from "../../three/vegetation/windField";
import {
  buildGrassGeometry,
  buildGroundShadowCanvas,
  createGrassMaterial,
} from "../../three/vegetation/grassField";
import { drawSourceToCanvas, replaceCanvasTexture } from "./texture";
import {
  DEFAULT_TREE_PARAMS,
  FOLIAGE_MODE_OPTIONS,
  FoliageModeOption,
  LEAF_SHAPES,
  LeafShape,
  TREE_SPECIES,
  TreeParams,
  TreeSpecies,
  buildBranchGeometry,
  buildLeafMatrices,
  createLeafCardGeometry,
  createLeafMaterial,
  createLeafHeightAttribute,
  createLeafRandomAttribute,
  generateTreeSkeleton,
  leafShapeId,
  resolveLeafShape,
} from "../../three/vegetation/treeGenerator";
import {
  WindSwayUniforms,
  createSwayingMaterial,
  createWindSwayUniforms,
  isPatchedForSway,
  updateSwayMatrix,
} from "../../three/vegetation/windSway";
import {
  InteractionMapState,
  MapPlacement,
  collectPaintPoints,
  createInteractionMapState,
  stepInteractionMap,
} from "../../three/vegetation/interactionMap";

function asVector(value: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  return value instanceof THREE.Vector3 ? value : fallback;
}

/**
 * The wind every vegetation node falls back on when nothing is wired into it.
 *
 * Dropping a Grass node into an empty graph and getting a *still* lawn would
 * read as a broken node, so an unwired field is a light breeze on the clock
 * rather than nothing. Wire a Wind Field in and the whole scene agrees on one
 * wind instead of each node inventing its own.
 */
function resolveWind(input: unknown, time: number): WindFieldDescriptor {
  if (isWindField(input)) return input;
  return { ...DEFAULT_WIND, direction: DEFAULT_WIND.direction.clone(), phase: time * 0.1 };
}

/**
 * Where a map texture sits in the world.
 *
 * An Interaction Map moves with whatever it is following, so its placement
 * changes every frame and cannot live in a consumer's params. Rather than make
 * the user wire centre and size alongside the texture — three wires that must
 * never disagree — the producing node stamps them onto the texture's userData
 * and every consumer reads them from there, falling back to its own params for
 * a plain image map that carries no such stamp.
 */
export function readMapPlacement(
  texture: THREE.Texture | null,
  fallbackCenter: THREE.Vector2,
  fallbackSize: number,
): MapPlacement {
  const stamped = texture?.userData?.mapPlacement as MapPlacement | undefined;
  if (stamped && stamped.center instanceof THREE.Vector2 && Number.isFinite(stamped.size)) {
    return { center: stamped.center, size: stamped.size };
  }
  return { center: fallbackCenter, size: fallbackSize };
}

const TRANSFORM_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
  { id: "location", label: "Location", kind: "vector", group: "Transform" },
  { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
  { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
];

const TRANSFORM_DEFAULT_PARAMS = {
  visible: 1,
  location: new THREE.Vector3(0, 0, 0),
  rotation: new THREE.Vector3(0, 0, 0),
  scale: new THREE.Vector3(1, 1, 1),
};

/* -------------------------------------------------------------------------- */
/* 1. Wind Field                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Wind Field — one wind for the whole scene.
 *
 * It renders nothing. Its entire job is to be the single place the wind is
 * described, so that grass, a tree's leaves and a swaying banner three metres
 * apart lean the same way at the same moment. That agreement is the reason
 * this is a node and not five copies of the same four parameters: wind read
 * from two different noises is instantly legible as fake.
 *
 * The `Wind` vector output is the same field sampled on the CPU at Sample
 * Position, which is what lets the wind drive things that are not shaders —
 * a Force Field, a Transform, a boat's heading.
 */
export const WIND_FIELD_NODE: NodeDefinition = {
  type: "physics/wind-field",
  label: "Wind Field",
  category: "physics",
  inputs: [
    { id: "angle", label: "Direction (°)", type: "value" },
    { id: "strength", label: "Strength", type: "value" },
    { id: "positionFrequency", label: "Gust Scale", type: "value" },
    { id: "timeFrequency", label: "Speed", type: "value" },
    { id: "gustiness", label: "Gustiness", type: "value" },
    { id: "samplePosition", label: "Sample Position", type: "vector" },
  ],
  outputs: [
    { id: "field", label: "Wind Field", type: "any" },
    { id: "wind", label: "Wind (Vector)", type: "vector" },
    { id: "speed", label: "Speed", type: "value" },
  ],
  defaultParams: {
    angle: Math.PI * 0.6,
    strength: 0.5,
    positionFrequency: 0.5,
    timeFrequency: 0.1,
    gustiness: 1,
    samplePosition: new THREE.Vector3(0, 0, 0),
  },
  paramFields: [
    { id: "angle", label: "Direction (°)", kind: "number", step: 5, degrees: true },
    { id: "strength", label: "Strength", kind: "number", step: 0.05 },
    { id: "positionFrequency", label: "Gust Scale (low = broad)", kind: "number", step: 0.05 },
    { id: "timeFrequency", label: "Speed", kind: "number", step: 0.01 },
    { id: "gustiness", label: "Gustiness (slow swell)", kind: "number", step: 0.05 },
    { id: "samplePosition", label: "Sample Position", kind: "vector", group: "CPU Readout" },
  ],
  evaluate: (inputs, params, ctx) => {
    const angle = numberInput(inputs.angle, params.angle, Math.PI * 0.6);
    const strength = Math.max(0, numberInput(inputs.strength, params.strength, 0.5));
    const positionFrequency = Math.max(0.001, numberInput(inputs.positionFrequency, params.positionFrequency, 0.5));
    const timeFrequency = numberInput(inputs.timeFrequency, params.timeFrequency, 0.1);
    const gustiness = Math.max(0, numberInput(inputs.gustiness, params.gustiness, 1));

    const field: WindFieldDescriptor = {
      kind: "wind",
      direction: new THREE.Vector2(Math.sin(angle), Math.cos(angle)),
      strength,
      positionFrequency,
      // Folded here rather than in the shader so an exported frame depends only
      // on its frame number — see WindFieldDescriptor.phase.
      phase: (ctx.time ?? 0) * timeFrequency,
      gustiness,
    };

    const samplePosition = asVector(inputs.samplePosition, asVector(params.samplePosition, new THREE.Vector3()));
    const sampled = sampleWind(field, samplePosition.x, samplePosition.z);

    return {
      field,
      wind: new THREE.Vector3(sampled.x, 0, sampled.y),
      speed: sampled.length(),
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 2. Grass Field                                                             */
/* -------------------------------------------------------------------------- */

interface GrassState {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  signature: string;
  bladeCount: number;
  /** Ground shadow texture, rebuilt only when what it depends on changes. */
  shadowCanvas?: HTMLCanvasElement;
  shadowTexture?: THREE.CanvasTexture;
  shadowSignature?: string;
}

const grassCache = createNodeCache<GrassState>((state) => {
  state.mesh.geometry.dispose();
  state.material.dispose();
  state.shadowTexture?.dispose();
});

/**
 * Grass Field — a dense, wind-blown lawn that follows a moving centre.
 *
 * The blade count is fixed by Subdivisions² and never changes; what changes is
 * *where* the square of blades sits, which is wrapped around the Center input
 * in the vertex shader. So wiring a character's position into Center gives an
 * endless field for the cost of the patch immediately around them. Leave it
 * unwired and it is simply a square lawn at the origin.
 *
 * Density Map is what turns it from a texture into a scene: red channel drives
 * blade height, and below the threshold nothing grows — paths, riverbanks and
 * bare patches are painted, not modelled.
 */
export const GRASS_FIELD_NODE: NodeDefinition = {
  type: "structure/grass-field",
  label: "Grass Field",
  category: "structure",
  inputs: [
    { id: "wind", label: "Wind Field", type: "any" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "center", label: "Center (Follow)", type: "vector" },
    { id: "densityMap", label: "Density Map", type: "texture" },
    { id: "trampleMap", label: "Trample Map", type: "texture" },
    { id: "size", label: "Size", type: "value" },
    { id: "bladeHeight", label: "Blade Height", type: "value" },
    { id: "bladeWidth", label: "Blade Width", type: "value" },
    { id: "windInfluence", label: "Wind Influence", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "bladeCount", label: "Blade Count", type: "value" },
    { id: "groundShadow", label: "Ground Shadow", type: "texture" },
  ],
  defaultParams: {
    ...TRANSFORM_DEFAULT_PARAMS,
    subdivisions: 160,
    size: 40,
    seed: 1,
    bladeWidth: 0.09,
    bladeHeight: 0.55,
    heightRandomness: 0.6,
    windInfluence: 1,
    center: new THREE.Vector3(0, 0, 0),
    densityThreshold: 0.05,
    densitySize: 40,
    densityCenter: new THREE.Vector3(0, 0, 0),
    trampleStrength: 1,
    trampleSize: 40,
    trampleCenter: new THREE.Vector3(0, 0, 0),
    baseColor: new THREE.Color(0x2f5d2a),
    tipColor: new THREE.Color(0xa8c34a),
    lightDirection: new THREE.Vector3(0.5, 1, 0.3),
    ambient: 0.35,
    shadowColor: new THREE.Color(0x000000),
    shadowIntensity: 0.55,
    groundShadowIntensity: 0.6,
    groundShadowSoftness: 0.04,
    groundShadowResolution: 256,
  },
  paramFields: [
    ...TRANSFORM_PARAM_FIELDS,
    { id: "subdivisions", label: "Subdivisions (blades = n²)", kind: "number", step: 10, group: "Field" },
    { id: "size", label: "Size (wrap square)", kind: "number", step: 1, group: "Field" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Field" },
    { id: "center", label: "Center (Follow)", kind: "vector", group: "Field" },
    { id: "bladeWidth", label: "Blade Width", kind: "number", step: 0.01, group: "Blade" },
    { id: "bladeHeight", label: "Blade Height", kind: "number", step: 0.05, group: "Blade" },
    { id: "heightRandomness", label: "Height Randomness", kind: "number", step: 0.05, group: "Blade" },
    { id: "windInfluence", label: "Wind Influence", kind: "number", step: 0.05, group: "Blade" },
    { id: "baseColor", label: "Base Color", kind: "color", group: "Shading" },
    { id: "tipColor", label: "Tip Color", kind: "color", group: "Shading" },
    { id: "lightDirection", label: "Light Direction", kind: "vector", group: "Shading" },
    { id: "ambient", label: "Ambient", kind: "number", step: 0.05, group: "Shading" },
    { id: "shadowColor", label: "Shadow Color", kind: "color", group: "Shading" },
    { id: "shadowIntensity", label: "Blade Root Shadow", kind: "number", step: 0.05, group: "Shading" },
    {
      id: "groundShadowIntensity",
      label: "Intensity (0 = white, no darkening)",
      kind: "number",
      step: 0.05,
      group: "Ground Shadow",
    },
    {
      id: "groundShadowSoftness",
      label: "Blur (fraction of map width)",
      kind: "number",
      step: 0.01,
      group: "Ground Shadow",
    },
    { id: "groundShadowResolution", label: "Resolution (px)", kind: "number", step: 64, group: "Ground Shadow" },
    { id: "densityThreshold", label: "Density Threshold", kind: "number", step: 0.01, group: "Density Map" },
    { id: "densitySize", label: "Map World Size", kind: "number", step: 1, group: "Density Map" },
    { id: "densityCenter", label: "Map Center", kind: "vector", group: "Density Map" },
    { id: "trampleStrength", label: "Trample Strength", kind: "number", step: 0.05, group: "Trample Map" },
    {
      id: "trampleSize",
      label: "Map World Size (ignored when wired to Interaction Map)",
      kind: "number",
      step: 1,
      group: "Trample Map",
    },
    { id: "trampleCenter", label: "Map Center", kind: "vector", group: "Trample Map" },
  ],
  evaluate: (inputs, params, ctx) => {
    const subdivisions = Math.max(1, Math.min(400, Math.floor(numberInput(undefined, params.subdivisions, 160))));
    const size = Math.max(0.1, numberInput(inputs.size, params.size, 40));
    const seed = Math.floor(numberInput(undefined, params.seed, 1));

    const signature = `${subdivisions}|${size}|${seed}`;
    let state = grassCache.get(ctx.nodeId);

    if (!state || state.signature !== signature) {
      if (state) {
        state.mesh.geometry.dispose();
      }
      const geometry = buildGrassGeometry({ subdivisions, size, seed });
      const material = state?.material ?? createGrassMaterial();
      const mesh = state?.mesh ?? new THREE.Mesh(geometry, material);
      mesh.geometry = geometry;
      // The shader relocates every vertex, so three's culling test — which
      // reads the authored bounds — would be answering the wrong question.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.nodeId = ctx.nodeId;
      state = { mesh, material, signature, bladeCount: subdivisions * subdivisions };
      grassCache.set(ctx.nodeId, state);
    }

    const { mesh, material } = state;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }
    mesh.visible = Boolean(numberInput(undefined, params.visible, 1));

    const wind = resolveWind(inputs.wind, ctx.time ?? 0);
    applyWindUniforms(material.uniforms, wind);

    const center = asVector(inputs.center, asVector(params.center, new THREE.Vector3()));
    (material.uniforms.uCenter.value as THREE.Vector2).set(center.x, center.z);
    material.uniforms.uSize.value = size;
    material.uniforms.uBladeWidth.value = Math.max(0.001, numberInput(inputs.bladeWidth, params.bladeWidth, 0.09));
    material.uniforms.uBladeHeight.value = Math.max(0, numberInput(inputs.bladeHeight, params.bladeHeight, 0.55));
    material.uniforms.uHeightRandomness.value = Math.max(
      0,
      Math.min(1, numberInput(undefined, params.heightRandomness, 0.6)),
    );
    material.uniforms.uWindInfluence.value = numberInput(inputs.windInfluence, params.windInfluence, 1);
    material.uniforms.uAmbient.value = numberInput(undefined, params.ambient, 0.35);
    material.uniforms.uShadowIntensity.value = Math.max(
      0,
      Math.min(1, numberInput(undefined, params.shadowIntensity, 0.55)),
    );
    const shadowColor = asColor(params.shadowColor, new THREE.Color(0x000000));
    (material.uniforms.uShadowColor.value as THREE.Color).copy(shadowColor);
    (material.uniforms.uBaseColor.value as THREE.Color).copy(asColor(params.baseColor, new THREE.Color(0x2f5d2a)));
    (material.uniforms.uTipColor.value as THREE.Color).copy(asColor(params.tipColor, new THREE.Color(0xa8c34a)));
    (material.uniforms.uLightDirection.value as THREE.Vector3)
      .copy(asVector(params.lightDirection, new THREE.Vector3(0.5, 1, 0.3)))
      .normalize();

    const densityMap = inputs.densityMap instanceof THREE.Texture ? inputs.densityMap : null;
    material.uniforms.uDensityMap.value = densityMap;
    material.uniforms.uHasDensityMap.value = densityMap ? 1 : 0;
    material.uniforms.uDensityThreshold.value = numberInput(undefined, params.densityThreshold, 0.05);

    const densityFallback = asVector(params.densityCenter, new THREE.Vector3());
    const densityPlacement = readMapPlacement(
      densityMap,
      new THREE.Vector2(densityFallback.x, densityFallback.z),
      Math.max(0.001, numberInput(undefined, params.densitySize, size)),
    );
    material.uniforms.uDensitySize.value = densityPlacement.size;
    (material.uniforms.uDensityCenter.value as THREE.Vector2).copy(densityPlacement.center);

    // The trample map is usually a live Interaction Map, which moves — so its
    // placement comes off the texture rather than out of these params.
    const trampleMap = inputs.trampleMap instanceof THREE.Texture ? inputs.trampleMap : null;
    material.uniforms.uTrampleMap.value = trampleMap;
    material.uniforms.uHasTrampleMap.value = trampleMap ? 1 : 0;
    material.uniforms.uTrampleStrength.value = numberInput(undefined, params.trampleStrength, 1);

    const trampleFallback = asVector(params.trampleCenter, new THREE.Vector3());
    const tramplePlacement = readMapPlacement(
      trampleMap,
      new THREE.Vector2(trampleFallback.x, trampleFallback.z),
      Math.max(0.001, numberInput(undefined, params.trampleSize, size)),
    );
    material.uniforms.uTrampleSize.value = tramplePlacement.size;
    (material.uniforms.uTrampleCenter.value as THREE.Vector2).copy(tramplePlacement.center);

    // The ground shadow: the same density map the blades grow from, blurred
    // and tinted, for the ground's own material to multiply in. Rebuilt only
    // when its inputs change — a blur over a 256² canvas is not a per-frame
    // cost, and the map usually never changes at all.
    const groundShadowIntensity = Math.max(0, Math.min(1, numberInput(undefined, params.groundShadowIntensity, 0.6)));
    const groundShadowSoftness = Math.max(0, Math.min(0.5, numberInput(undefined, params.groundShadowSoftness, 0.04)));
    const groundShadowResolution = Math.max(
      16,
      Math.min(1024, Math.round(numberInput(undefined, params.groundShadowResolution, 256))),
    );
    const shadowSignature = [
      densityMap?.uuid ?? "",
      densityMap?.version ?? 0,
      groundShadowIntensity,
      groundShadowSoftness,
      groundShadowResolution,
      shadowColor.getHex(),
    ].join("|");

    if (typeof document !== "undefined" && shadowSignature !== state.shadowSignature) {
      state.shadowSignature = shadowSignature;
      state.shadowCanvas = state.shadowCanvas ?? document.createElement("canvas");
      const drawn = buildGroundShadowCanvas(
        state.shadowCanvas,
        (resolution) => {
          const source = document.createElement("canvas");
          drawSourceToCanvas(source, densityMap, resolution);
          return source.getContext("2d")?.getImageData(0, 0, resolution, resolution).data ?? null;
        },
        {
          density: densityMap,
          color: shadowColor,
          intensity: groundShadowIntensity,
          softness: groundShadowSoftness,
          resolution: groundShadowResolution,
        },
      );
      if (drawn) {
        state.shadowTexture = replaceCanvasTexture(state.shadowTexture, state.shadowCanvas, THREE.SRGBColorSpace);
        // Same placement as the density map it was made from, so a downstream
        // node can line it up with the world exactly as the field does.
        state.shadowTexture.userData.mapPlacement = {
          center: densityPlacement.center.clone(),
          size: densityPlacement.size,
        };
      }
    }

    return {
      ...primitiveOutputs(mesh, params),
      bladeCount: state.bladeCount,
      groundShadow: state.shadowTexture ?? null,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 3. Parametric Tree                                                         */
/* -------------------------------------------------------------------------- */

interface TreeState {
  group: THREE.Group;
  barkMaterial: THREE.MeshStandardMaterial;
  barkUniforms: WindSwayUniforms;
  leafMaterial: THREE.ShaderMaterial;
  leaves: THREE.InstancedMesh | null;
  bark: THREE.Mesh;
  signature: string;
  tips: THREE.Vector3[];
  branchCount: number;
  height: number;
}

const treeCache = createNodeCache<TreeState>((state) => {
  disposeObject3D(state.group);
  state.barkMaterial.dispose();
  state.leafMaterial.dispose();
});

function asSpecies(value: unknown): TreeSpecies {
  return (TREE_SPECIES as readonly string[]).includes(value as string)
    ? (value as TreeSpecies)
    : DEFAULT_TREE_PARAMS.species;
}

function asFoliageMode(value: unknown): FoliageModeOption {
  return (FOLIAGE_MODE_OPTIONS as readonly string[]).includes(value as string)
    ? (value as FoliageModeOption)
    : DEFAULT_TREE_PARAMS.foliageMode;
}

function asLeafShape(value: unknown): LeafShape {
  return (LEAF_SHAPES as readonly string[]).includes(value as string)
    ? (value as LeafShape)
    : DEFAULT_TREE_PARAMS.leafShape;
}

function treeParamsFrom(inputs: Record<string, unknown>, params: Record<string, unknown>): TreeParams {
  const number = (key: keyof TreeParams, wired: unknown, min: number, max = Infinity): number => {
    const value = numberInput(wired, params[key], DEFAULT_TREE_PARAMS[key] as number);
    return Math.max(min, Math.min(max, value));
  };
  const integer = (key: keyof TreeParams, wired: unknown, min: number, max: number): number =>
    Math.floor(number(key, wired, min, max));

  return {
    seed: Math.floor(number("seed", inputs.seed, -1e9)),
    species: asSpecies(params.species),
    sizeScale: number("sizeScale", inputs.sizeScale, 0.01, 100),
    // Levels and children multiply: the branch count is childCount^levels, so
    // both are capped here rather than trusting the panel's step size.
    levels: integer("levels", inputs.levels, 0, 6),
    trunkHeight: number("trunkHeight", inputs.trunkHeight, 0.01),
    trunkRadius: number("trunkRadius", inputs.trunkRadius, 0.001),
    trunkFlare: number("trunkFlare", undefined, 0, 5),
    taper: number("taper", undefined, 0.05, 8),
    childCount: integer("childCount", inputs.childCount, 0, 6),
    lengthFalloff: number("lengthFalloff", inputs.lengthFalloff, 0.05, 1.2),
    radiusFalloff: number("radiusFalloff", inputs.radiusFalloff, 0.05, 1),
    branchAngle: number("branchAngle", inputs.branchAngle, -Math.PI, Math.PI),
    branchStart: number("branchStart", undefined, 0, 0.95),
    curvature: number("curvature", inputs.curvature, -Math.PI, Math.PI),
    droop: number("droop", inputs.droop, -Math.PI * 0.5, Math.PI * 0.5),
    phototropism: number("phototropism", undefined, -Math.PI * 0.5, Math.PI * 0.5),
    gnarl: number("gnarl", undefined, 0, 3),
    segments: integer("segments", undefined, 1, 24),
    radialSegments: integer("radialSegments", undefined, 3, 24),
    leavesPerBranch: integer("leavesPerBranch", inputs.leavesPerBranch, 0, 60),
    leafSize: number("leafSize", inputs.leafSize, 0),
    leafAspect: number("leafAspect", inputs.leafAspect, 0.02, 4),
    leafLevels: integer("leafLevels", undefined, 1, 6),
    leafDroop: number("leafDroop", inputs.leafDroop, -1, 1),
    leafShape: asLeafShape(params.leafShape),
    leafTip: number("leafTip", undefined, 0, 1),
    foliageMode: asFoliageMode(params.foliageMode),
    clumpsPerBranch: integer("clumpsPerBranch", inputs.clumpsPerBranch, 1, 8),
    clumpRadius: number("clumpRadius", inputs.clumpRadius, 0, 40),
  };
}

/**
 * Tree (Parametric) — a whole tree from a seed and a set of numbers.
 *
 * Two meshes, two draw calls: the branches are swept into a single tube mesh,
 * the leaves are one InstancedMesh of cards cut to shape in the fragment
 * shader (no texture to ship, no alpha sorting to get wrong). Both sway in the
 * same wind as everything else in the scene.
 *
 * **Species is a growth habit, not a preset.** It changes how the recursion
 * behaves — whether the trunk keeps a central leader or forks into equals,
 * whether laterals rise or hang, whether there is any branching at all — and
 * every numeric parameter still scales that behaviour on top. A preset would
 * overwrite the numbers already dialled in and leave no way of telling which
 * edits survived; this way, picking Willow and raising Branch Angle gives a
 * wilder willow rather than a willow silently replaced.
 *
 * The geometry is rebuilt only when a *shape* parameter changes — colour, wind
 * and transform are uniforms, so dragging them is free while dragging Levels
 * is not. Changing Seed re-rolls the tree without touching its statistics,
 * which is how you fill a forest: one node, an Array, and a seed per instance.
 */
export const TREE_NODE: NodeDefinition = {
  type: "object/tree",
  label: "Tree (Parametric)",
  category: "object",
  inputs: [
    { id: "wind", label: "Wind Field", type: "any" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "sizeScale", label: "Size", type: "value" },
    { id: "trunkHeight", label: "Trunk Height", type: "value" },
    { id: "trunkRadius", label: "Trunk Radius", type: "value" },
    { id: "levels", label: "Levels", type: "value" },
    { id: "childCount", label: "Branches / Node", type: "value" },
    { id: "branchAngle", label: "Branch Angle (°)", type: "value" },
    { id: "curvature", label: "Curvature (°)", type: "value" },
    { id: "droop", label: "Droop (°)", type: "value" },
    { id: "lengthFalloff", label: "Length Falloff", type: "value" },
    { id: "radiusFalloff", label: "Radius Falloff", type: "value" },
    { id: "leavesPerBranch", label: "Leaves / Branch", type: "value" },
    { id: "leafSize", label: "Leaf Size", type: "value" },
    { id: "leafAspect", label: "Leaf Width", type: "value" },
    { id: "leafDroop", label: "Leaf Droop", type: "value" },
    { id: "clumpsPerBranch", label: "Clumps / Branch", type: "value" },
    { id: "clumpRadius", label: "Clump Radius", type: "value" },
    { id: "season", label: "Season (0 = summer, 1 = late autumn)", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "tips", label: "Branch Tips", type: "list" },
    { id: "branchCount", label: "Branch Count", type: "value" },
  ],
  defaultParams: {
    ...TRANSFORM_DEFAULT_PARAMS,
    ...DEFAULT_TREE_PARAMS,
    barkColor: new THREE.Color(0x5a4130),
    leafColorA: new THREE.Color(0x4d7c2a),
    leafColorB: new THREE.Color(0x8bbf3d),
    lightDirection: new THREE.Vector3(0.5, 1, 0.3),
    ambient: 0.4,
    windInfluence: 1,
    trunkStiffness: 2.2,
    barkRoughness: 0.9,
    season: 0,
    seasonVariance: 0.35,
    autumnColorA: new THREE.Color(0xe0a52c),
    autumnColorB: new THREE.Color(0xa8321f),
    canopyShade: 0.45,
    canopyShadePower: 1.4,
  },
  paramFields: [
    ...TRANSFORM_PARAM_FIELDS,
    { id: "species", label: "Species (growth habit)", kind: "select", options: [...TREE_SPECIES], group: "Species" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Species" },
    { id: "sizeScale", label: "Size (master scale)", kind: "number", step: 0.1, group: "Species" },
    { id: "levels", label: "Levels", kind: "number", step: 1, group: "Structure" },
    { id: "childCount", label: "Branches / Node", kind: "number", step: 1, group: "Structure" },
    { id: "branchStart", label: "First Branch At", kind: "number", step: 0.05, group: "Structure" },
    { id: "branchAngle", label: "Branch Angle (°)", kind: "number", step: 2, degrees: true, group: "Structure" },
    { id: "lengthFalloff", label: "Length Falloff", kind: "number", step: 0.02, group: "Structure" },
    { id: "radiusFalloff", label: "Radius Falloff", kind: "number", step: 0.02, group: "Structure" },
    { id: "curvature", label: "Curvature (°)", kind: "number", step: 2, degrees: true, group: "Structure" },
    { id: "droop", label: "Droop (° — negative lifts)", kind: "number", step: 2, degrees: true, group: "Structure" },
    { id: "phototropism", label: "Phototropism (° toward light)", kind: "number", step: 2, degrees: true, group: "Structure" },
    { id: "gnarl", label: "Gnarl", kind: "number", step: 0.02, group: "Structure" },
    { id: "trunkHeight", label: "Trunk Height", kind: "number", step: 0.2, group: "Trunk" },
    { id: "trunkRadius", label: "Trunk Radius", kind: "number", step: 0.01, group: "Trunk" },
    { id: "trunkFlare", label: "Base Flare", kind: "number", step: 0.05, group: "Trunk" },
    { id: "taper", label: "Taper (1 = cone)", kind: "number", step: 0.1, group: "Trunk" },
    { id: "segments", label: "Spine Segments", kind: "number", step: 1, group: "Mesh" },
    { id: "radialSegments", label: "Radial Segments", kind: "number", step: 1, group: "Mesh" },
    {
      id: "foliageMode",
      label: "Foliage Mode",
      kind: "select",
      options: [...FOLIAGE_MODE_OPTIONS],
      group: "Foliage",
    },
    { id: "clumpsPerBranch", label: "Clumps / Branch (clump mode)", kind: "number", step: 1, group: "Foliage" },
    { id: "clumpRadius", label: "Clump Radius (× leaf size)", kind: "number", step: 0.2, group: "Foliage" },
    { id: "leafShape", label: "Leaf Shape", kind: "select", options: [...LEAF_SHAPES], group: "Foliage" },
    { id: "leavesPerBranch", label: "Leaves / Branch", kind: "number", step: 1, group: "Foliage" },
    { id: "leafLevels", label: "Foliage Depth (levels)", kind: "number", step: 1, group: "Foliage" },
    { id: "leafSize", label: "Leaf Size", kind: "number", step: 0.05, group: "Foliage" },
    { id: "leafAspect", label: "Leaf Width", kind: "number", step: 0.05, group: "Foliage" },
    { id: "leafTip", label: "Tip Sharpness", kind: "number", step: 0.05, group: "Foliage" },
    { id: "leafDroop", label: "Leaf Droop", kind: "number", step: 0.05, group: "Foliage" },
    { id: "leafColorA", label: "Leaf Color A", kind: "color", group: "Foliage" },
    { id: "leafColorB", label: "Leaf Color B", kind: "color", group: "Foliage" },
    { id: "season", label: "Season (0 = summer, 1 = late autumn)", kind: "number", step: 0.05, group: "Season" },
    { id: "seasonVariance", label: "Turn Spread (per leaf)", kind: "number", step: 0.05, group: "Season" },
    { id: "autumnColorA", label: "Autumn Color (mid)", kind: "color", group: "Season" },
    { id: "autumnColorB", label: "Autumn Color (late)", kind: "color", group: "Season" },
    { id: "canopyShade", label: "Canopy Shade (bottom darkening)", kind: "number", step: 0.05, group: "Season" },
    { id: "canopyShadePower", label: "Canopy Shade Falloff", kind: "number", step: 0.1, group: "Season" },
    { id: "barkColor", label: "Bark Color", kind: "color", group: "Shading" },
    { id: "barkRoughness", label: "Bark Roughness", kind: "number", step: 0.05, group: "Shading" },
    { id: "lightDirection", label: "Light Direction", kind: "vector", group: "Shading" },
    { id: "ambient", label: "Ambient", kind: "number", step: 0.05, group: "Shading" },
    { id: "shadowColor", label: "Shadow Color", kind: "color", group: "Shading" },
    { id: "shadowIntensity", label: "Blade Root Shadow", kind: "number", step: 0.05, group: "Shading" },
    { id: "windInfluence", label: "Wind Influence", kind: "number", step: 0.05, group: "Wind" },
    { id: "trunkStiffness", label: "Trunk Stiffness", kind: "number", step: 0.1, group: "Wind" },
  ],
  evaluate: (inputs, params, ctx) => {
    const treeParams = treeParamsFrom(inputs, params);
    // Leaf silhouette is a fragment-shader uniform, so it is deliberately not
    // part of the rebuild key: dragging through leaf shapes should cost
    // nothing, while dragging Levels rebuilds the tree.
    const { leafShape: _leafShape, leafTip: _leafTip, ...shapeParams } = treeParams;
    const signature = JSON.stringify(shapeParams);

    let state = treeCache.get(ctx.nodeId);

    if (!state || state.signature !== signature) {
      const branches = generateTreeSkeleton(treeParams);
      const barkGeometry = buildBranchGeometry(
        branches,
        treeParams.radialSegments,
        treeParams.taper,
        treeParams.trunkFlare,
      );
      const leafMatrices = buildLeafMatrices(branches, treeParams);

      const barkUniforms = state?.barkUniforms ?? createWindSwayUniforms();
      const barkMaterial =
        state?.barkMaterial ??
        (createSwayingMaterial(
          new THREE.MeshStandardMaterial({ color: 0x5a4130, roughness: 0.9, metalness: 0 }),
          barkUniforms,
          ctx.nodeId,
        ) as THREE.MeshStandardMaterial);
      const leafMaterial = state?.leafMaterial ?? createLeafMaterial();

      const group = state?.group ?? new THREE.Group();
      // Rebuilding shape means the old GPU buffers go, but the materials —
      // and so the compiled programs — are kept across rebuilds.
      if (state) {
        state.bark.geometry.dispose();
        if (state.leaves) {
          state.leaves.geometry.dispose();
          group.remove(state.leaves);
        }
      }

      const bark = state?.bark ?? new THREE.Mesh(barkGeometry, barkMaterial);
      bark.geometry = barkGeometry;
      bark.castShadow = true;
      bark.receiveShadow = true;
      if (!bark.parent) group.add(bark);

      let leaves: THREE.InstancedMesh | null = null;
      if (leafMatrices.length > 0) {
        leaves = new THREE.InstancedMesh(createLeafCardGeometry(), leafMaterial, leafMatrices.length);
        for (let i = 0; i < leafMatrices.length; i++) leaves.setMatrixAt(i, leafMatrices[i]);
        leaves.instanceMatrix.needsUpdate = true;
        leaves.geometry.setAttribute(
          "aLeafRandom",
          createLeafRandomAttribute(leafMatrices.length, treeParams.seed),
        );
        leaves.geometry.setAttribute("aLeafHeight", createLeafHeightAttribute(leafMatrices));
        leaves.castShadow = true;
        leaves.frustumCulled = false;
        group.add(leaves);
      }

      barkGeometry.computeBoundingBox();
      const height = barkGeometry.boundingBox ? barkGeometry.boundingBox.max.y : treeParams.trunkHeight;

      group.userData.nodeId = ctx.nodeId;

      state = {
        group,
        bark,
        barkMaterial,
        barkUniforms,
        leafMaterial,
        leaves,
        signature,
        tips: branches.map((branch) => branch.points[branch.points.length - 1].clone()),
        branchCount: branches.length,
        height: Math.max(0.001, height),
      };
      treeCache.set(ctx.nodeId, state);
    }

    const { group, barkMaterial, barkUniforms, leafMaterial } = state;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }
    group.visible = Boolean(numberInput(undefined, params.visible, 1));

    const wind = resolveWind(inputs.wind, ctx.time ?? 0);
    const windInfluence = numberInput(undefined, params.windInfluence, 1);

    applyWindUniforms(barkUniforms, wind);
    barkUniforms.uSwayInfluence.value = windInfluence;
    barkUniforms.uSwayAnchorY.value = 0;
    barkUniforms.uSwayHeight.value = state.height;
    barkUniforms.uSwayStiffness.value = Math.max(0.1, numberInput(undefined, params.trunkStiffness, 2.2));
    updateSwayMatrix(group, barkUniforms);

    barkMaterial.color.copy(asColor(params.barkColor, new THREE.Color(0x5a4130)));
    barkMaterial.roughness = Math.max(0, Math.min(1, numberInput(undefined, params.barkRoughness, 0.9)));

    applyWindUniforms(leafMaterial.uniforms, wind);
    leafMaterial.uniforms.uLeafWindInfluence.value = windInfluence;
    (leafMaterial.uniforms.uLeafColorA.value as THREE.Color).copy(asColor(params.leafColorA, new THREE.Color(0x4d7c2a)));
    (leafMaterial.uniforms.uLeafColorB.value as THREE.Color).copy(asColor(params.leafColorB, new THREE.Color(0x8bbf3d)));
    (leafMaterial.uniforms.uLightDirection.value as THREE.Vector3)
      .copy(asVector(params.lightDirection, new THREE.Vector3(0.5, 1, 0.3)))
      .normalize();
    leafMaterial.uniforms.uAmbient.value = numberInput(undefined, params.ambient, 0.4);
    // Shape and tip sharpness are uniforms, not geometry: an author dragging
    // through leaf silhouettes should not pay a full tree rebuild per step.
    leafMaterial.uniforms.uLeafShape.value = leafShapeId(
      resolveLeafShape(treeParams.leafShape, treeParams.species),
    );
    leafMaterial.uniforms.uLeafTip.value = treeParams.leafTip;

    // Season, its per-leaf spread and the canopy gradient are all uniforms:
    // animating a tree from summer to late autumn is a curve on one socket,
    // not a rebuild per frame.
    leafMaterial.uniforms.uSeason.value = Math.max(
      0,
      Math.min(1, numberInput(inputs.season, params.season, 0)),
    );
    leafMaterial.uniforms.uSeasonVariance.value = Math.max(
      0,
      Math.min(2, numberInput(undefined, params.seasonVariance, 0.35)),
    );
    leafMaterial.uniforms.uCanopyShade.value = Math.max(
      0,
      Math.min(1, numberInput(undefined, params.canopyShade, 0.45)),
    );
    leafMaterial.uniforms.uCanopyShadePower.value = Math.max(
      0.05,
      numberInput(undefined, params.canopyShadePower, 1.4),
    );
    (leafMaterial.uniforms.uAutumnColorA.value as THREE.Color).copy(
      asColor(params.autumnColorA, new THREE.Color(0xe0a52c)),
    );
    (leafMaterial.uniforms.uAutumnColorB.value as THREE.Color).copy(
      asColor(params.autumnColorB, new THREE.Color(0xa8321f)),
    );

    return {
      ...primitiveOutputs(group, params),
      tips: state.tips.map((tip) => tip.clone()),
      branchCount: state.branchCount,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 4. Interaction Map                                                         */
/* -------------------------------------------------------------------------- */

// Per-renderer, same reasoning as particleRuntime's caches: two viewports
// running the same graph each need their own render targets, or they read
// back whichever one drew last.
const interactionCache = createNodeCache<Map<THREE.WebGLRenderer, InteractionMapState>>((perRenderer) => {
  for (const state of perRenderer.values()) state.dispose();
});

/** Which simulation epoch each node's map was painted in — see simulationEpoch.ts. */
const interactionEpochs = createNodeCache<number>();

const RESOLUTIONS: Record<string, number> = { "256": 256, "512": 512, "1024": 1024 };

/** Warned-about node ids, so a headless graph logs once rather than every frame. */
const warnedNoRenderer = new Set<string>();

/**
 * Interaction Map — a top-down record of what has been through here.
 *
 * Whatever is wired into Source and Positions paints white into a square of
 * world seen from above; the square follows Center, and marks fade back over
 * Recovery seconds. Feed the result to a Grass Field's Trample Map and the
 * grass lies flat in your wake and stands back up behind you.
 *
 * Nothing about it is grass-specific, which is the point of it being its own
 * node: the same texture is a snow track, a sand drag, a heat map, a wetness
 * mask, or a Sample Texture lookup driving anything at all.
 *
 * It needs a live renderer (it draws into a render target), so in a headless
 * evaluation it returns no texture rather than throwing — consumers already
 * treat a missing map as "no marks".
 */
export const INTERACTION_MAP_NODE: NodeDefinition = {
  type: "texture/interaction-map",
  label: "Interaction Map",
  category: "texture",
  inputs: [
    { id: "source", label: "Source (Object)", type: "geometry" },
    { id: "positions", label: "Positions", type: "list" },
    { id: "center", label: "Center (Follow)", type: "vector" },
    { id: "size", label: "Size", type: "value" },
    { id: "radius", label: "Brush Radius", type: "value" },
    { id: "strength", label: "Strength", type: "value" },
    { id: "recovery", label: "Recovery (s)", type: "value" },
  ],
  outputs: [
    { id: "texture", label: "Map", type: "texture" },
    { id: "center", label: "Center", type: "vector" },
    { id: "size", label: "Size", type: "value" },
    { id: "count", label: "Painted Count", type: "value" },
  ],
  defaultParams: {
    center: new THREE.Vector3(0, 0, 0),
    size: 40,
    radius: 0.6,
    strength: 1,
    hardness: 0.2,
    // 0 keeps every mark for ever — a drawing surface rather than a trail.
    recovery: 4,
    resolution: "512",
  },
  paramFields: [
    { id: "center", label: "Center (Follow)", kind: "vector" },
    { id: "size", label: "Size (world)", kind: "number", step: 1 },
    { id: "resolution", label: "Resolution", kind: "select", options: ["256", "512", "1024"] },
    { id: "radius", label: "Brush Radius", kind: "number", step: 0.05, group: "Brush" },
    { id: "strength", label: "Strength", kind: "number", step: 0.05, group: "Brush" },
    { id: "hardness", label: "Hardness (edge)", kind: "number", step: 0.05, group: "Brush" },
    { id: "recovery", label: "Recovery Half-Life (s, 0 = permanent)", kind: "number", step: 0.5, group: "Fade" },
  ],
  evaluate: (inputs, params, ctx) => {
    const centerVector = asVector(inputs.center, asVector(params.center, new THREE.Vector3()));
    const center = new THREE.Vector2(centerVector.x, centerVector.z);
    const size = Math.max(0.001, numberInput(inputs.size, params.size, 40));
    const points = collectPaintPoints(inputs.source, inputs.positions);

    const renderer = ctx.renderer;
    if (!renderer) {
      if (!warnedNoRenderer.has(ctx.nodeId)) {
        warnedNoRenderer.add(ctx.nodeId);
        console.warn("texture/interaction-map: no WebGLRenderer in EvalContext — map not painted");
      }
      return { texture: null, center: centerVector.clone(), size, count: points.length };
    }

    const resolution = RESOLUTIONS[String(params.resolution ?? "512")] ?? 512;

    let perRenderer = interactionCache.get(ctx.nodeId);
    if (!perRenderer) {
      perRenderer = new Map();
      interactionCache.set(ctx.nodeId, perRenderer);
    }
    // Everything the map holds is a record of what has already happened, so a
    // new simulation epoch can only start it blank.
    const epoch = ctx.simulationEpoch ?? 0;
    const staleEpoch = interactionEpochs.get(ctx.nodeId) !== epoch;
    interactionEpochs.set(ctx.nodeId, epoch);

    let state = perRenderer.get(renderer);
    if (!state || state.resolution !== resolution || staleEpoch) {
      state?.dispose();
      state = createInteractionMapState(resolution);
      perRenderer.set(renderer, state);
    }

    const texture = stepInteractionMap(renderer, state, {
      center,
      size,
      points,
      radius: Math.max(0.001, numberInput(inputs.radius, params.radius, 0.6)),
      strength: Math.max(0, numberInput(inputs.strength, params.strength, 1)),
      hardness: Math.max(0, Math.min(0.99, numberInput(undefined, params.hardness, 0.2))),
      halfLife: Math.max(0, numberInput(inputs.recovery, params.recovery, 4)),
      time: ctx.time ?? 0,
    });

    // Stamped so a consumer needs one wire, not three — see readMapPlacement.
    texture.userData.mapPlacement = { center: center.clone(), size };

    return { texture, center: centerVector.clone(), size, count: points.length };
  },
};

/* -------------------------------------------------------------------------- */
/* 5. Wind Sway                                                               */
/* -------------------------------------------------------------------------- */

interface SwayState {
  uniforms: WindSwayUniforms;
  /** Patched clone per source material, so one node can sway a multi-material import. */
  materials: Map<string, THREE.Material>;
}

const swayCache = createNodeCache<SwayState>((state) => {
  for (const material of state.materials.values()) material.dispose();
});

/**
 * Wind Sway — bends anything already in the graph.
 *
 * Not a deformer: it does not touch vertex data at all, it patches the
 * material so the GPU does the bending. That is the difference between a
 * modifier you can put on a 200k-vertex import and one you cannot. The
 * consequence is that downstream nodes reading vertices (Mesh to Points,
 * Raycast) see the *unbent* mesh — the sway is a look, not a simulation.
 *
 * The mask is vertical: Anchor Y stays planted, everything above it bends by
 * a power curve up to Height. Set Anchor to the base of a trunk and Height to
 * its top and the tree bends the way a tree bends.
 */
export const WIND_SWAY_NODE: NodeDefinition = {
  type: "geometry/wind-sway",
  label: "Wind Sway",
  category: "structure",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "wind", label: "Wind Field", type: "any" },
    { id: "influence", label: "Influence", type: "value" },
    { id: "anchorY", label: "Anchor Y", type: "value" },
    { id: "height", label: "Height", type: "value" },
    { id: "stiffness", label: "Stiffness", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    influence: 1,
    anchorY: 0,
    height: 2,
    stiffness: 1.6,
    autoHeight: true,
  },
  paramFields: [
    { id: "influence", label: "Influence", kind: "number", step: 0.05 },
    { id: "autoHeight", label: "Auto Height (from bounds)", kind: "boolean" },
    { id: "anchorY", label: "Anchor Y (planted)", kind: "number", step: 0.1 },
    { id: "height", label: "Height (fully bending)", kind: "number", step: 0.1 },
    { id: "stiffness", label: "Stiffness (mask power)", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const source = inputs.geometry;
    if (!(source instanceof THREE.Object3D)) {
      return { geometry: source, matrix: (source as any)?.matrix };
    }

    let state = swayCache.get(ctx.nodeId);
    if (!state) {
      state = { uniforms: createWindSwayUniforms(), materials: new Map() };
      swayCache.set(ctx.nodeId, state);
    }

    const meshes = collectMeshes(source);
    const autoHeight = Boolean(params.autoHeight ?? true);

    let anchorY = numberInput(inputs.anchorY, params.anchorY, 0);
    let height = Math.max(0.0001, numberInput(inputs.height, params.height, 2));

    if (autoHeight && meshes.length > 0) {
      // Measuring beats asking: the common case is "make this thing sway",
      // and the answer to "how tall is it" is already in the geometry.
      const box = new THREE.Box3();
      for (const mesh of meshes) {
        mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox);
      }
      if (!box.isEmpty()) {
        anchorY = box.min.y;
        height = Math.max(0.0001, box.max.y - box.min.y);
      }
    }

    const wind = resolveWind(inputs.wind, ctx.time ?? 0);
    applyWindUniforms(state.uniforms, wind);
    state.uniforms.uSwayInfluence.value = numberInput(inputs.influence, params.influence, 1);
    state.uniforms.uSwayAnchorY.value = anchorY;
    state.uniforms.uSwayHeight.value = height;
    state.uniforms.uSwayStiffness.value = Math.max(0.1, numberInput(inputs.stiffness, params.stiffness, 1.6));

    for (const mesh of meshes) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const patched = materials.map((material) => {
        if (!material) return material;
        if (isPatchedForSway(material, ctx.nodeId)) return material;
        const cached = state.materials.get(material.uuid);
        if (cached) return cached;
        const clone = createSwayingMaterial(material, state.uniforms, ctx.nodeId);
        state.materials.set(material.uuid, clone);
        return clone;
      });
      mesh.material = Array.isArray(mesh.material) ? (patched as THREE.Material[]) : (patched[0] as THREE.Material);
    }

    updateSwayMatrix(source, state.uniforms);

    if (source.matrixAutoUpdate) source.updateMatrix();
    return { geometry: source, matrix: source.matrix.clone() };
  },
};
