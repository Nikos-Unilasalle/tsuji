import * as THREE from "three";
import { LightProbeGenerator } from "three/examples/jsm/lights/LightProbeGenerator.js";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { asVector3, extractPositionFromInput } from "./transform";

/**
 * Light Probe — samples the scene from a point and lights objects with what
 * it found there.
 *
 * A cube camera photographs all six directions from the probe's position; the
 * result is reduced to nine spherical-harmonic coefficients, which is enough
 * to reproduce smooth low-frequency lighting from every direction at once and
 * costs the shader almost nothing. That is the difference from an Ambient
 * Light: ambient is one flat colour from everywhere, a probe knows the wall on
 * its left is red and the sky above it is blue.
 *
 * What it captures is the scene as the last frame left it — walls, floor,
 * the environment background — so bounced colour comes for free without any
 * global-illumination machinery. What it can't do is vary across an object:
 * one probe is one point in space, and everything lit by it gets the same
 * nine coefficients.
 */

const DEFAULT_RESOLUTION = 64;

interface ProbeState {
  probe: THREE.LightProbe;
  icon: THREE.Object3D;
  target?: THREE.WebGLCubeRenderTarget;
  camera?: THREE.CubeCamera;
  /** What `camera`/`target` were built for — CubeCamera fixes near/far and size at construction. */
  rigSignature?: string;
  /** What the last bake was taken from — a change here is what asks for another. */
  bakedSignature?: string;
  /** A bake is a round trip to the GPU and back; only one may be in flight. */
  baking: boolean;
}

const probeCache = createNodeCache<ProbeState>((state) => {
  disposeObject3D(state.probe);
  state.target?.dispose();
});

/** A wireframe ball so the probe is visible and clickable, like the other lights' icons. */
function createProbeIcon(): THREE.Object3D {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({ color: 0x818cf8 });
  group.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.18, 1)), material));
  group.traverse((child) => {
    child.userData.isHelper = true;
  });
  return group;
}

function getState(nodeId: string): ProbeState {
  let state = probeCache.get(nodeId);
  if (!state) {
    const probe = new THREE.LightProbe();
    probe.intensity = 1;
    probe.userData.nodeId = nodeId;
    const icon = createProbeIcon();
    probe.add(icon);
    state = { probe, icon, baking: false };
    probeCache.set(nodeId, state);
  }
  return state;
}

/**
 * Whether the probe should photograph its surroundings again this frame.
 *
 * "always" is honest about its cost — six scene renders plus a GPU readback —
 * and exists for a probe that has to track something moving. "once" is the
 * default because a probe's whole appeal is being nearly free at render time,
 * and re-baking a static room every frame throws that away.
 *
 * "once" cannot mean *literally* once, though. A node evaluates before the
 * frame's objects have been put into the scene, so the first bake of a fresh
 * graph photographs an almost empty world and comes back black — which is
 * exactly what it did until the signature below started counting the scene's
 * contents. Re-baking whenever that count changes lets the probe settle as
 * the scene fills, and picks up an object added later, at the cost of one
 * bake per change rather than one per frame.
 */
export function shouldRebake(mode: string, signature: string, bakedSignature: string | undefined): boolean {
  if (mode === "always") return true;
  return signature !== bakedSignature;
}

/**
 * What a "once" probe watches for a reason to bake again: its own settings,
 * plus a cheap stand-in for "the scene changed". Counting the scene's direct
 * children catches objects and lights arriving or leaving, which is what
 * actually invalidates a bake; it does not catch an object moving or
 * recolouring in place, which is what "always" is for.
 */
export function bakeSignature(
  position: THREE.Vector3,
  resolution: number,
  near: number,
  far: number,
  sceneChildCount: number,
): string {
  return [position.toArray().join(","), resolution, near, far, sceneChildCount].join("|");
}

/**
 * Runs `render` with the probe hidden, then puts it back.
 *
 * A probe must not photograph itself: its icon sits exactly at the capture
 * point and would fill every face, and its own light would feed back,
 * brightening each successive bake. Hiding it covers both — three skips
 * invisible objects when it gathers lights, so the light and its icon go
 * together.
 *
 * The window is deliberately only the render. Holding it across the readback
 * that follows — which just reads a texture already on the GPU — left the
 * probe dark for however many frames that await spanned, so a probe set to
 * re-bake every frame spent most of its life contributing nothing.
 */
export function captureWithProbeHidden(probe: THREE.Object3D, render: () => void): void {
  const wasVisible = probe.visible;
  probe.visible = false;
  try {
    render();
  } finally {
    probe.visible = wasVisible;
  }
}

/** Light Probe node — nine-coefficient ambient lighting sampled from the scene at a point. */
export const LIGHT_PROBE_NODE: NodeDefinition = {
  type: "light/probe",
  label: "Light Probe",
  category: "lighting",
  managedByViewport: true,
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "intensity", label: "Intensity", type: "value" },
  ],
  outputs: [{ id: "light", label: "Light", type: "geometry" }],
  defaultParams: {
    location: new THREE.Vector3(0, 1.5, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    intensity: 1.0,
    resolution: DEFAULT_RESOLUTION,
    updateMode: "once",
    near: 0.1,
    far: 100,
  },
  paramFields: [
    { id: "location", label: "Location", kind: "vector" },
    { id: "intensity", label: "Intensity", kind: "number", step: 0.1 },
    { id: "updateMode", label: "Update", kind: "select", options: ["once", "always"] },
    { id: "resolution", label: "Capture Resolution", kind: "number", step: 16 },
    { id: "near", label: "Capture Near", kind: "number", step: 0.05 },
    { id: "far", label: "Capture Far", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    const probe = state.probe;

    const location = extractPositionFromInput(inputs.matrix, asVector3(params.location, new THREE.Vector3(0, 1.5, 0)));
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      probe.position.copy(location);
    }

    probe.intensity = Math.max(
      0,
      inputs.intensity !== undefined ? Number(inputs.intensity) : Number(params.intensity) ?? 1,
    );

    const resolution = Math.max(8, Math.min(256, Math.round(Number(params.resolution) || DEFAULT_RESOLUTION)));
    const near = Math.max(0.001, Number(params.near) || 0.1);
    const far = Math.max(near + 0.001, Number(params.far) || 100);
    const mode = String(params.updateMode || "once");

    // Headless (tests) or a viewport that hasn't handed over its scene: the
    // probe is still a perfectly valid light, it just carries whatever it was
    // last baked with — an unlit probe contributes nothing rather than failing.
    const scene = ctx.scene;
    const renderer = ctx.renderer;
    if (!renderer || !scene || state.baking) return { light: probe };

    const signature = bakeSignature(probe.position, resolution, near, far, scene.children.length);
    if (!shouldRebake(mode, signature, state.bakedSignature)) return { light: probe };

    // CubeCamera bakes near/far into its six cameras and the target's size at
    // construction, so a change to any of them means a new rig rather than a
    // property assignment.
    const rigSignature = [resolution, near, far].join("|");
    if (!state.camera || state.rigSignature !== rigSignature) {
      state.target?.dispose();
      state.target = new THREE.WebGLCubeRenderTarget(resolution);
      state.camera = new THREE.CubeCamera(near, far, state.target);
      state.rigSignature = rigSignature;
    }
    const camera = state.camera;
    const target = state.target!;
    camera.position.copy(probe.position);
    camera.updateMatrixWorld(true);

    state.baking = true;
    try {
      captureWithProbeHidden(probe, () => camera.update(renderer, scene));
    } catch (err) {
      console.error("Light Probe: capture failed", err);
      state.baking = false;
      return { light: probe };
    }

    void (async () => {
      try {
        const baked = await LightProbeGenerator.fromCubeRenderTarget(renderer, target);
        probe.sh.copy(baked.sh);
        state.bakedSignature = signature;
      } catch (err) {
        console.error("Light Probe: readback failed", err);
      } finally {
        // try/finally around the await rather than a .finally() on a chain:
        // this flag gates every later frame, so a path that skipped clearing
        // it would wedge the probe on whatever it first captured, forever.
        state.baking = false;
      }
    })();

    return { light: probe };
  },
};
