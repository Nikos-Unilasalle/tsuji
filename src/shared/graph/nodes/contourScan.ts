import * as THREE from "three";
import {
  buildLinesGeometry,
  buildRibbonGeometry,
  buildTubesGeometry,
  interpolateRings,
  MorphEasing,
  RingData,
  ringsToCurves,
  scanMeshRings,
  ScanStyle,
  SliceAxis,
} from "../../three/meshScanlines";
import { sideSignature } from "../geometrySignature";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { NodeDefinition } from "../types";
import {
  inheritSourceMaterial,
  primitiveOutputs,
} from "./object";
import { composeNativeMatrix, preserveModifierUserData } from "./transform";

function numberInput(input: unknown, param: unknown, fallback: number): number {
  const raw = input !== undefined ? input : param;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

interface ContourScanState {
  mesh?: THREE.Mesh | THREE.LineSegments;
  lastScanSignature?: string;
  cachedScanA?: RingData;
  cachedScanB?: RingData | null;
  lastMorphSignature?: string;
  cachedCurves?: THREE.CatmullRomCurve3[];
}

const contourScanCache = createNodeCache<ContourScanState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(nodeId: string): ContourScanState {
  let state = contourScanCache.get(nodeId);
  if (!state) {
    state = {};
    contourScanCache.set(nodeId, state);
  }
  return state;
}

/**
 * Contour Scan Modifier — slices 3D meshes into closed contour rings using
 * radial BVH raycasting, with vertical wave morphing and outward bulge
 * between two shapes, inspired by Makio64's venus.js demo.
 */
export const CONTOUR_SCAN_NODE: NodeDefinition = {
  type: "modifier/contour-scan",
  label: "Contour Scan",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "target", label: "Target (Morph)", type: "geometry", owns: true },
    { id: "progress", label: "Progress", type: "value" },
    { id: "stagger", label: "Stagger", type: "value" },
    { id: "bulge", label: "Bulge", type: "value" },
    { id: "material", label: "Material", type: "material" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "curves", label: "Curves", type: "list" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  dynamicOutputs: (connections, _types, params) => {
    const isCurves = params?.style === "curves";
    const hasCurveConn = connections.some(
      (c) => c.fromSocket === "curves" || c.fromSocket === "curve",
    );
    if (isCurves || hasCurveConn) {
      return [
        { id: "geometry", label: "Geometry", type: "geometry" },
        { id: "curves", label: "Curves", type: "list" },
        { id: "curve", label: "Curve", type: "curve" },
        { id: "matrix", label: "Matrix", type: "matrix" },
      ];
    }
    return [
      { id: "geometry", label: "Geometry", type: "geometry" },
      { id: "matrix", label: "Matrix", type: "matrix" },
    ];
  },
  defaultParams: {
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    numRings: 48,
    samplesPerRing: 64,
    axis: "y",
    style: "ribbons",
    ribbonWidth: 0.02,
    flipNormals: false,
    progress: 0,
    stagger: 0.5,
    bulge: 0.3,
    easing: "backInOut",
  },
  dynamicParamFields: () => [
    { id: "style", label: "Style", kind: "select", options: ["ribbons", "lines", "tubes", "curves"], group: "Scan" },
    { id: "numRings", label: "Rings Count", kind: "number", step: 1, min: 4, max: 256, group: "Scan" },
    { id: "samplesPerRing", label: "Samples per Ring", kind: "number", step: 1, min: 8, max: 256, group: "Scan" },
    { id: "axis", label: "Slice Axis", kind: "select", options: ["y", "x", "z"], group: "Scan" },
    { id: "ribbonWidth", label: "Width / Radius", kind: "number", step: 0.005, group: "Scan" },
    { id: "flipNormals", label: "Flip Normals", kind: "boolean", group: "Scan" },

    { id: "progress", label: "Morph Progress", kind: "number", step: 0.01, min: 0, max: 1, group: "Morph" },
    { id: "stagger", label: "Vertical Stagger", kind: "number", step: 0.05, min: 0, max: 2, group: "Morph" },
    { id: "bulge", label: "Transition Bulge", kind: "number", step: 0.05, min: 0, max: 2, group: "Morph" },
    { id: "easing", label: "Easing", kind: "select", options: ["backInOut", "easeInOut", "linear"], group: "Morph" },

    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
  ],
  evaluate: (inputs, params, ctx) => {
    const inputA = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const inputB = inputs.target instanceof THREE.Object3D ? inputs.target : null;

    if (!inputA) {
      return { geometry: null, curves: [], matrix: new THREE.Matrix4() };
    }

    const meshesA = collectMeshes(inputA);
    if (meshesA.length === 0) {
      warnMeshRequired(ctx.nodeId, "Contour Scan", inputA);
      return primitiveOutputs(inputA);
    }
    clearMeshWarning(ctx.nodeId);

    const meshesB = inputB ? collectMeshes(inputB) : [];

    inputA.updateMatrixWorld(true);
    if (inputB) inputB.updateMatrixWorld(true);

    const numRings = Math.max(4, Math.min(256, Math.round(numberInput(undefined, params.numRings, 48))));
    const samplesPerRing = Math.max(8, Math.min(256, Math.round(numberInput(undefined, params.samplesPerRing, 64))));
    const axis = (params.axis === "x" || params.axis === "z" ? params.axis : "y") as SliceAxis;
    const style = (params.style === "lines" || params.style === "tubes" || params.style === "curves"
      ? params.style
      : "ribbons") as ScanStyle;
    const ribbonWidth = Math.max(0.001, numberInput(undefined, params.ribbonWidth, 0.02));
    const flipNormals = Boolean(params.flipNormals);

    const progress = Math.max(0, Math.min(1, numberInput(inputs.progress, params.progress, 0)));
    const stagger = Math.max(0, numberInput(inputs.stagger, params.stagger, 0.5));
    const bulge = Math.max(0, numberInput(inputs.bulge, params.bulge, 0.3));
    const easing = (params.easing === "easeInOut" || params.easing === "linear" ? params.easing : "backInOut") as MorphEasing;

    const state = getState(ctx.nodeId);

    // Compute signature for BVH scanning (only re-raycasts when shapes, poses, or scan grid change)
    const scanSignature = JSON.stringify({
      sigA: sideSignature(meshesA),
      sigB: meshesB.length > 0 ? sideSignature(meshesB) : null,
      numRings,
      samplesPerRing,
      axis,
    });

    if (scanSignature !== state.lastScanSignature || !state.cachedScanA) {
      state.lastScanSignature = scanSignature;

      let unifiedMin: number | undefined = undefined;
      let unifiedMax: number | undefined = undefined;

      // If morphing between two models, scan along the unified height range so slices match up
      if (inputB && meshesB.length > 0) {
        const boxA = new THREE.Box3().setFromObject(inputA);
        const boxB = new THREE.Box3().setFromObject(inputB);
        if (axis === "x") {
          unifiedMin = Math.min(boxA.min.x, boxB.min.x);
          unifiedMax = Math.max(boxA.max.x, boxB.max.x);
        } else if (axis === "z") {
          unifiedMin = Math.min(boxA.min.z, boxB.min.z);
          unifiedMax = Math.max(boxA.max.z, boxB.max.z);
        } else {
          unifiedMin = Math.min(boxA.min.y, boxB.min.y);
          unifiedMax = Math.max(boxA.max.y, boxB.max.y);
        }
      }

      state.cachedScanA = scanMeshRings(inputA, {
        numRings,
        samplesPerRing,
        axis,
        minCoord: unifiedMin,
        maxCoord: unifiedMax,
      });

      if (inputB && meshesB.length > 0) {
        state.cachedScanB = scanMeshRings(inputB, {
          numRings,
          samplesPerRing,
          axis,
          minCoord: unifiedMin,
          maxCoord: unifiedMax,
        });
      } else {
        state.cachedScanB = null;
      }
    }

    // Check morph/geometry rebuild signature
    const morphSignature = JSON.stringify({
      scanSignature,
      progress,
      stagger,
      bulge,
      easing,
      ribbonWidth,
      style,
      flipNormals,
    });

    if (morphSignature !== state.lastMorphSignature || !state.mesh) {
      state.lastMorphSignature = morphSignature;

      const interpolatedRings = interpolateRings(
        state.cachedScanA,
        state.cachedScanB ?? null,
        { progress, stagger, bulge, easing },
      );

      state.cachedCurves = ringsToCurves(interpolatedRings);

      let newGeometry: THREE.BufferGeometry;
      const isLineStyle = style === "lines" || style === "curves";
      if (isLineStyle) {
        newGeometry = buildLinesGeometry(interpolatedRings);
      } else if (style === "tubes") {
        newGeometry = buildTubesGeometry(interpolatedRings, ribbonWidth * 0.5);
      } else {
        newGeometry = buildRibbonGeometry(interpolatedRings, ribbonWidth, axis, flipNormals);
      }

      // Recreate or replace mesh object
      if (isLineStyle) {
        if (state.mesh && !(state.mesh instanceof THREE.LineSegments)) {
          disposeObject3D(state.mesh);
          state.mesh = undefined;
        }
        if (!state.mesh) {
          const mat = new THREE.LineBasicMaterial({ color: 0xffffff });
          state.mesh = new THREE.LineSegments(newGeometry, mat);
        } else {
          state.mesh.geometry.dispose();
          state.mesh.geometry = newGeometry;
        }
      } else {
        if (state.mesh && state.mesh instanceof THREE.LineSegments) {
          disposeObject3D(state.mesh);
          state.mesh = undefined;
        }
        if (!state.mesh) {
          const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
          });
          state.mesh = new THREE.Mesh(newGeometry, mat);
        } else {
          state.mesh.geometry.dispose();
          state.mesh.geometry = newGeometry;
        }
      }

      state.mesh.castShadow = true;
      state.mesh.receiveShadow = true;
    }

    const mesh = state.mesh;
    mesh.visible = toBoolean(inputs.visible ?? params.visible ?? 1);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const srcMesh = meshesA[0];
    if (mesh instanceof THREE.Mesh) {
      const customMat = (inputs.material instanceof THREE.Material || Array.isArray(inputs.material))
        ? (inputs.material as THREE.Material | THREE.Material[])
        : undefined;
      inheritSourceMaterial(mesh, customMat ?? srcMesh?.material);
    } else if (mesh instanceof THREE.LineSegments) {
      if (inputs.material instanceof THREE.Material) {
        mesh.material = inputs.material;
      } else {
        const srcColor = (srcMesh?.material as any)?.color;
        if (srcColor instanceof THREE.Color && mesh.material instanceof THREE.LineBasicMaterial) {
          mesh.material.color.copy(srcColor);
        }
      }
    }

    preserveModifierUserData(mesh, inputA, srcMesh, ctx.nodeId);

    const curves = state.cachedCurves ?? [];
    return {
      ...primitiveOutputs(mesh),
      curves,
      curve: curves[0] ?? null,
    };
  },
};
