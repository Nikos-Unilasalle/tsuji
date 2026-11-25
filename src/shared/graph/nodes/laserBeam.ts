import * as THREE from "three";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { asColor, numberInput, primitiveOutputs } from "./object";
import { composeNativeMatrix } from "./transform";
import { toBoolean } from "../sockets";

interface LaserState {
  group?: THREE.Group;
  baseMesh?: THREE.Mesh;
  headGroup?: THREE.Group;
  headMesh?: THREE.Mesh;
  beamMesh?: THREE.Mesh;
  hitMesh?: THREE.Mesh;
  lastLength?: number;
  lastRadius?: number;
  lastConeAngle?: number;
  lastSpotSize?: number;
}

const laserCache = createNodeCache<LaserState>((s) => {
  if (s.group) disposeObject3D(s.group);
});

/**
 * Volumetric Stage Laser Beam Fixture with Motorized Pan/Tilt Head
 * Fully compliant with Tsuji transform, gizmo interaction, visibility, and dynamic controls.
 */
export const OBJECT_LASER_BEAM_NODE: NodeDefinition = {
  type: "object/laser-beam",
  label: "Laser Beam (Stage FX)",
  category: "fx",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "location", label: "Location", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "scale", label: "Scale", type: "vector" },
    { id: "pan", label: "Pan (°)", type: "value" },
    { id: "tilt", label: "Tilt (°)", type: "value" },
    { id: "color", label: "Laser Color", type: "color" },
    { id: "intensity", label: "Intensity", type: "value" },
    { id: "length", label: "Beam Length", type: "value" },
    { id: "radius", label: "Beam Thickness", type: "value" },
    { id: "coneAngle", label: "Divergence", type: "value" },
    { id: "pulseFrequency", label: "Strobe Pulse", type: "value" },
    { id: "beamFade", label: "Beam Opacity", type: "value" },
    { id: "spotSize", label: "Spot Size", type: "value" },
    { id: "showHitSpot", label: "Show Hit Spot", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "direction", label: "Direction", type: "vector" },
    { id: "hitPosition", label: "Hit Position", type: "vector" },
  ],
  defaultParams: {
    visible: true,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    showPivot: false,
    pivot: new THREE.Vector3(0, 0, 0),
    inheritRotation: true,
    inheritScale: true,
    pan: 0,
    tilt: -30,
    color: new THREE.Color(0x00ff66),
    intensity: 1.5,
    length: 25.0,
    radius: 0.035,
    coneAngle: 0.3,
    pulseFrequency: 0,
    beamFade: 0.75,
    spotSize: 3.5,
    showHitSpot: true,
  },
  paramFields: [
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
    { id: "showPivot", label: "Show Pivot", kind: "boolean", group: "Transform" },
    { id: "pivot", label: "Pivot Offset", kind: "vector", group: "Transform" },
    { id: "inheritRotation", label: "Inherit Rotation", kind: "boolean", group: "Transform" },
    { id: "inheritScale", label: "Inherit Scale", kind: "boolean", group: "Transform" },

    { id: "pan", label: "Pan (°)", kind: "number", step: 5.0, group: "Laser FX" },
    { id: "tilt", label: "Tilt (°)", kind: "number", step: 5.0, group: "Laser FX" },
    { id: "color", label: "Laser Color", kind: "color", group: "Laser FX" },
    { id: "intensity", label: "Intensity", kind: "number", step: 0.2, group: "Laser FX" },
    { id: "length", label: "Beam Length", kind: "number", step: 1.0, group: "Laser FX" },
    { id: "radius", label: "Beam Thickness", kind: "number", step: 0.005, group: "Laser FX" },
    { id: "coneAngle", label: "Beam Divergence", kind: "number", step: 0.05, group: "Laser FX" },
    { id: "pulseFrequency", label: "Strobe / Pulse (Hz)", kind: "number", step: 0.5, group: "Laser FX" },
    { id: "beamFade", label: "Beam Opacity", kind: "number", step: 0.05, group: "Laser FX" },
    { id: "spotSize", label: "Hit Spot Size", kind: "number", step: 0.5, group: "Laser FX" },
    { id: "showHitSpot", label: "Show Hit Spot", kind: "boolean", group: "Laser FX" },
  ],
  evaluate: (inputs, params, ctx) => {
    let state = laserCache.get(ctx.nodeId);
    if (!state) {
      state = {};
      laserCache.set(ctx.nodeId, state);
    }

    const isVisible = toBoolean(inputs.visible !== undefined ? inputs.visible : (params.visible ?? true));
    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0x00ff66)));
    const panDeg = numberInput(inputs.pan, params.pan, 0);
    const tiltDeg = numberInput(inputs.tilt, params.tilt, -30);
    const length = Math.max(0.5, numberInput(inputs.length, params.length, 25.0));
    const radius = Math.max(0.002, numberInput(inputs.radius, params.radius, 0.035));
    const coneAngle = Math.max(0.0, numberInput(inputs.coneAngle, params.coneAngle, 0.3));
    const intensity = Math.max(0.05, numberInput(inputs.intensity, params.intensity, 1.5));
    const pulseFreq = Math.max(0, numberInput(inputs.pulseFrequency, params.pulseFrequency, 0));
    const beamFade = Math.max(0.05, Math.min(1.0, numberInput(inputs.beamFade, params.beamFade, 0.75)));
    const spotSize = Math.max(0.5, numberInput(inputs.spotSize, params.spotSize, 3.5));
    const showHit = toBoolean(inputs.showHitSpot !== undefined ? inputs.showHitSpot : params.showHitSpot);
    const time = ctx.time ?? 0;

    // Optional stroboscopic pulse
    let strobeFactor = 1.0;
    if (pulseFreq > 0) {
      const s = Math.sin(time * pulseFreq * Math.PI * 2);
      strobeFactor = s > 0 ? 1.0 : 0.05;
    }

    // Initialize hierarchy once
    if (!state.group) {
      const group = new THREE.Group();
      group.userData.nodeId = ctx.nodeId;

      // Fixture base
      const baseGeo = new THREE.CylinderGeometry(0.2, 0.25, 0.2, 16);
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.4, metalness: 0.8 });
      const baseMesh = new THREE.Mesh(baseGeo, baseMat);
      baseMesh.position.y = 0.1;
      baseMesh.userData.nodeId = ctx.nodeId;
      group.add(baseMesh);

      // Rotating head gimbal
      const headGroup = new THREE.Group();
      headGroup.position.y = 0.25;
      headGroup.userData.nodeId = ctx.nodeId;

      const headGeo = new THREE.SphereGeometry(0.15, 16, 16);
      const headMat = new THREE.MeshStandardMaterial({ color: 0x27272a, roughness: 0.3, metalness: 0.9 });
      const headMesh = new THREE.Mesh(headGeo, headMat);
      headMesh.userData.nodeId = ctx.nodeId;
      headGroup.add(headMesh);

      // Volumetric laser beam mesh
      const beamMat = new THREE.MeshBasicMaterial({
        color: color.clone().multiplyScalar(intensity * strobeFactor),
        transparent: true,
        opacity: beamFade,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const beamMesh = new THREE.Mesh(new THREE.BufferGeometry(), beamMat);
      beamMesh.userData.nodeId = ctx.nodeId;
      headGroup.add(beamMesh);

      // Hit spot glow mesh
      const hitMat = new THREE.MeshBasicMaterial({
        color: color.clone().multiplyScalar(intensity * strobeFactor * 1.5),
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const hitMesh = new THREE.Mesh(new THREE.BufferGeometry(), hitMat);
      hitMesh.userData.nodeId = ctx.nodeId;
      headGroup.add(hitMesh);

      group.add(headGroup);

      state.group = group;
      state.baseMesh = baseMesh;
      state.headGroup = headGroup;
      state.headMesh = headMesh;
      state.beamMesh = beamMesh;
      state.hitMesh = hitMesh;
    }

    // Dynamically rebuild geometries if length, radius, coneAngle or spotSize changed
    if (
      length !== state.lastLength ||
      radius !== state.lastRadius ||
      coneAngle !== state.lastConeAngle ||
      spotSize !== state.lastSpotSize
    ) {
      // Rebuild beam cylinder
      state.beamMesh!.geometry.dispose();
      const endRadius = radius * (1.0 + coneAngle * 3.0);
      const beamGeo = new THREE.CylinderGeometry(radius, endRadius, length, 16, 1, true);
      beamGeo.translate(0, length / 2, 0);
      beamGeo.rotateX(Math.PI / 2); // align along +Z
      state.beamMesh!.geometry = beamGeo;

      // Rebuild hit spot
      state.hitMesh!.geometry.dispose();
      const hitGeo = new THREE.SphereGeometry(radius * spotSize, 12, 12);
      state.hitMesh!.geometry = hitGeo;
      state.hitMesh!.position.set(0, 0, length);

      state.lastLength = length;
      state.lastRadius = radius;
      state.lastConeAngle = coneAngle;
      state.lastSpotSize = spotSize;
    }

    state.group.visible = isVisible;

    // Pan & Tilt local head rotation
    const panRad = (panDeg * Math.PI) / 180;
    const tiltRad = (tiltDeg * Math.PI) / 180;
    state.headGroup!.rotation.set(0, 0, 0);
    state.headGroup!.rotateY(panRad);
    state.headGroup!.rotateX(tiltRad);

    // Color, intensity, opacity & strobe
    const effectiveIntensity = intensity * strobeFactor;
    const beamMat = state.beamMesh!.material as THREE.MeshBasicMaterial;
    beamMat.color.copy(color).multiplyScalar(effectiveIntensity);
    beamMat.opacity = beamFade * (strobeFactor > 0.5 ? 1.0 : 0.1);

    const hitMat = state.hitMesh!.material as THREE.MeshBasicMaterial;
    hitMat.color.copy(color).multiplyScalar(effectiveIntensity * 1.5);
    state.hitMesh!.visible = showHit && strobeFactor > 0.5;

    // Tsuji Native Matrix & Gizmo protection
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.group.matrixAutoUpdate = false;
      const loc = inputs.location !== undefined ? inputs.location : params.location;
      const rot = inputs.rotation !== undefined ? inputs.rotation : params.rotation;
      const scl = inputs.scale !== undefined ? inputs.scale : params.scale;
      const m = composeNativeMatrix(inputs.matrix, loc, rot, scl, params);
      state.group.matrix.copy(m);
      m.decompose(state.group.position, state.group.quaternion, state.group.scale);
      state.group.matrixWorldNeedsUpdate = true;
    }

    // Direction & hit position
    const forward = new THREE.Vector3(0, 0, 1);
    forward.applyEuler(state.headGroup!.rotation);
    if (state.group.matrix) {
      forward.transformDirection(state.group.matrix);
    }
    const direction = forward.clone().normalize();

    const worldPos = new THREE.Vector3();
    state.group.getWorldPosition(worldPos);
    const hitPosition = worldPos.clone().addScaledVector(direction, length);

    return {
      ...primitiveOutputs(state.group),
      direction,
      hitPosition,
    };
  },
};
