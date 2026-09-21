import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { VignetteShader } from "three/examples/jsm/shaders/VignetteShader.js";
import { RGBShiftShader } from "three/examples/jsm/shaders/RGBShiftShader.js";
import { FilmPass } from "three/examples/jsm/postprocessing/FilmPass.js";
import { GlitchPass } from "three/examples/jsm/postprocessing/GlitchPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { ColorCorrectionShader } from "three/examples/jsm/shaders/ColorCorrectionShader.js";
import { KaleidoShader } from "three/examples/jsm/shaders/KaleidoShader.js";
import { HalftonePass } from "three/examples/jsm/postprocessing/HalftonePass.js";
import { PostProcessConfig } from "../graph/nodes/postprocessing";
import { DryBrushShader, DuotoneShader, FilmTextureShader, Super8Shader } from "./postShaders";
import { createMotionBlur } from "./motionBlur";
import { VolumetricPass, VolumetricSettings } from "./volumetricPass";

const CustomPixelShader = {
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    pixelSize: { value: 6.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float pixelSize;
    varying vec2 vUv;
    void main() {
      vec2 dxy = pixelSize / resolution;
      vec2 coord = dxy * floor(vUv / dxy);
      gl_FragColor = texture2D(tDiffuse, coord);
    }
  `,
};

interface CachedPass {
  type: string;
  pass: any;
}

/** Passes are instantiated once and kept; only their uniforms change per frame. */
function instantiatePass(
  type: string,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
): any {
  switch (type) {
    case "bloom":
      return new UnrealBloomPass(new THREE.Vector2(width, height), 1.5, 0.4, 0.1);
    case "vignette":
      return new ShaderPass(VignetteShader);
    case "rgb-shift":
      return new ShaderPass(RGBShiftShader);
    case "dof":
      return new BokehPass(scene, camera, { focus: 10.0, aperture: 0.025, maxblur: 0.01 });
    case "outline":
      return new OutlinePass(new THREE.Vector2(width, height), scene, camera);
    case "ao":
      // `output` is set per-frame in configurePass from the node's View
      // param — GTAOPass.OUTPUT.Default is the only mode that actually
      // multiplies AO onto the scene (copies the frame through, then blends
      // the AO term on top); every other mode, "Denoise" included despite
      // sounding like the finished result, replaces the frame with a flat
      // grayscale AO map instead of compositing it.
      return new GTAOPass(scene, camera, width, height);
    case "film-grain":
      return new FilmPass(0.35, false);
    case "glitch":
      return new GlitchPass();
    case "pixelate":
      return new ShaderPass(CustomPixelShader);
    case "kaleidoscope":
      return new ShaderPass(KaleidoShader);
    case "color-correction":
      return new ShaderPass(ColorCorrectionShader);
    case "antialias":
      return new FXAAPass();
    case "duotone":
      return new ShaderPass(DuotoneShader);
    case "halftone":
      return new HalftonePass({});
    case "film-texture":
      return new ShaderPass(FilmTextureShader);
    case "super8":
      return new ShaderPass(Super8Shader);
    case "dry-brush":
      return new ShaderPass(DryBrushShader);
    default:
      return null;
  }
}

function patchOutlinePassSide(pass: any) {
  if (pass && pass.overlayMaterial && !pass.overlayMaterial.uniforms["outlineSide"]) {
    pass.overlayMaterial.uniforms["outlineSide"] = { value: 0.0 };
    pass.overlayMaterial.fragmentShader = pass.overlayMaterial.fragmentShader
      .replace(
        "uniform bool usePatternTexture;",
        "uniform bool usePatternTexture;\nuniform float outlineSide;"
      )
      .replace(
        "vec4 finalColor = edgeStrength * maskColor.r * edgeValue;",
        "float sideFactor = outlineSide < 0.5 ? maskColor.r : (outlineSide < 1.5 ? (1.0 - maskColor.r) : 1.0);\nvec4 finalColor = edgeStrength * sideFactor * edgeValue;"
      );
    pass.overlayMaterial.needsUpdate = true;
  }
}

function configurePass(
  pass: any,
  cfg: PostProcessConfig,
  width: number,
  height: number,
  pixelRatio: number,
  outlineTarget: THREE.Object3D | null,
  time = 0,
): void {
  switch (cfg.type) {
    case "bloom": {
      pass.strength = Number(cfg.params.strength) ?? 1.5;
      pass.radius = Number(cfg.params.radius) ?? 0.4;
      pass.threshold = Number(cfg.params.threshold) ?? 0.85;
      if (pass.resolution) pass.resolution.set(width, height);
      break;
    }
    case "vignette": {
      if (pass.uniforms["offset"]) pass.uniforms["offset"].value = Number(cfg.params.offset) ?? 1.0;
      if (pass.uniforms["darkness"]) pass.uniforms["darkness"].value = Number(cfg.params.darkness) ?? 1.5;
      break;
    }
    case "rgb-shift": {
      if (pass.uniforms["amount"]) pass.uniforms["amount"].value = Number(cfg.params.amount) ?? 0.005;
      if (pass.uniforms["angle"]) pass.uniforms["angle"].value = Number(cfg.params.angle) ?? 0;
      break;
    }
    case "dof": {
      if (pass.uniforms["focus"]) pass.uniforms["focus"].value = Math.max(0.1, Number(cfg.params.focus) ?? 10.0);
      if (pass.uniforms["aperture"]) pass.uniforms["aperture"].value = Math.max(0, Number(cfg.params.aperture) ?? 0.025);
      if (pass.uniforms["maxblur"]) pass.uniforms["maxblur"].value = Math.max(0, Number(cfg.params.maxblur) ?? 0.01);
      break;
    }
    case "outline": {
      patchOutlinePassSide(pass);
      const edgeColor = cfg.params.edgeColor instanceof THREE.Color ? cfg.params.edgeColor : new THREE.Color(0xffffff);
      pass.edgeStrength = typeof cfg.params.edgeStrength === "number" && !isNaN(cfg.params.edgeStrength)
        ? cfg.params.edgeStrength
        : 3.0;
      pass.edgeGlow = typeof cfg.params.edgeGlow === "number" && !isNaN(cfg.params.edgeGlow) ? cfg.params.edgeGlow : 0.0;
      pass.edgeThickness = typeof cfg.params.edgeThickness === "number" && !isNaN(cfg.params.edgeThickness)
        ? cfg.params.edgeThickness
        : 1.0;
      pass.visibleEdgeColor.copy(edgeColor);
      if (cfg.params.hiddenEdgeColor instanceof THREE.Color) {
        pass.hiddenEdgeColor.copy(cfg.params.hiddenEdgeColor);
      } else {
        pass.hiddenEdgeColor.set(0x000000);
      }

      const outlineSide = typeof cfg.params.outlineSide === "number" && !isNaN(cfg.params.outlineSide)
        ? cfg.params.outlineSide
        : 0.0;
      if (pass.overlayMaterial?.uniforms?.["outlineSide"]) {
        pass.overlayMaterial.uniforms["outlineSide"].value = outlineSide;
      }

      if (Array.isArray(cfg.params.selectedObjects)) {
        pass.selectedObjects = cfg.params.selectedObjects;
      } else {
        const target = cfg.params.targetObject instanceof THREE.Object3D ? cfg.params.targetObject : outlineTarget;
        const meshes: THREE.Mesh[] = [];
        if (target) {
          target.traverse((c) => {
            if (c instanceof THREE.Mesh) meshes.push(c);
          });
        }
        pass.selectedObjects = meshes;
      }
      break;
    }
    case "ao": {
      const view = String(cfg.params.view || "multiply");
      pass.output =
        view === "off" ? GTAOPass.OUTPUT.Off : view === "ao-only" ? GTAOPass.OUTPUT.AO : GTAOPass.OUTPUT.Default;
      pass.blendIntensity = Number(cfg.params.blendIntensity) ?? 1.0;
      pass.updateGtaoMaterial({
        radius: Number(cfg.params.radius) ?? 0.25,
        distanceExponent: Number(cfg.params.distanceExponent) ?? 1.0,
        thickness: Number(cfg.params.thickness) ?? 1.0,
        samples: Math.max(1, Math.round(Number(cfg.params.samples) || 16)),
        screenSpaceRadius: Boolean(cfg.params.screenSpaceRadius),
      });
      break;
    }
    case "film-grain": {
      if (pass.uniforms["nIntensity"]) pass.uniforms["nIntensity"].value = Number(cfg.params.noiseIntensity) ?? 0.35;
      if (pass.uniforms["sIntensity"]) pass.uniforms["sIntensity"].value = Number(cfg.params.scanlinesIntensity) ?? 0.05;
      if (pass.uniforms["sCount"]) pass.uniforms["sCount"].value = Number(cfg.params.scanlinesCount) ?? 2048;
      if (pass.uniforms["grayscale"]) pass.uniforms["grayscale"].value = Boolean(cfg.params.grayscale) ? 1 : 0;
      if (pass.uniforms["time"]) pass.uniforms["time"].value = time;
      break;
    }
    case "glitch": {
      pass.enabled = Boolean(cfg.params.active ?? true);
      pass.goWild = Boolean(cfg.params.wild);
      break;
    }
    case "pixelate": {
      if (pass.uniforms["resolution"]) pass.uniforms["resolution"].value.set(width, height);
      if (pass.uniforms["pixelSize"]) pass.uniforms["pixelSize"].value = Math.max(1, Number(cfg.params.pixelSize) || 6);
      break;
    }
    case "kaleidoscope": {
      if (pass.uniforms["sides"]) pass.uniforms["sides"].value = Math.max(1, Number(cfg.params.sides) || 6);
      if (pass.uniforms["angle"]) pass.uniforms["angle"].value = Number(cfg.params.angle) || 0;
      break;
    }
    case "color-correction": {
      const brightness = Number(cfg.params.brightness) || 0;
      const contrast = Number(cfg.params.contrast) || 1;
      const saturation = Number(cfg.params.saturation) || 1;
      if (pass.uniforms["powRGB"]) pass.uniforms["powRGB"].value.set(contrast, contrast, contrast);
      if (pass.uniforms["mulRGB"]) pass.uniforms["mulRGB"].value.set(saturation, saturation, saturation);
      if (pass.uniforms["addRGB"]) pass.uniforms["addRGB"].value.set(brightness, brightness, brightness);
      break;
    }
    case "duotone": {
      const shadow = cfg.params.shadowColor instanceof THREE.Color ? cfg.params.shadowColor : new THREE.Color(0x1b2a4a);
      const highlight =
        cfg.params.highlightColor instanceof THREE.Color ? cfg.params.highlightColor : new THREE.Color(0xffd9a0);
      pass.uniforms["shadowColor"].value.copy(shadow);
      pass.uniforms["highlightColor"].value.copy(highlight);
      pass.uniforms["balance"].value = Number(cfg.params.balance) ?? 0.5;
      pass.uniforms["softness"].value = Number(cfg.params.softness) ?? 0.5;
      pass.uniforms["amount"].value = Number(cfg.params.amount) ?? 1.0;
      break;
    }
    case "halftone": {
      const rotation = Number(cfg.params.rotation) || 0;
      const shape = String(cfg.params.shape || "dot");
      // HalftoneShader numbers its shapes 1..4 in this order.
      pass.uniforms["shape"].value = ["dot", "ellipse", "line", "square"].indexOf(shape) + 1 || 1;
      pass.uniforms["radius"].value = Math.max(1, Number(cfg.params.radius) || 4);
      // The three screens sit 30° apart from the one the node sets, the
      // classic offsets that keep the grids from beating into a moiré.
      pass.uniforms["rotateR"].value = rotation;
      pass.uniforms["rotateG"].value = rotation + Math.PI / 6;
      pass.uniforms["rotateB"].value = rotation + Math.PI / 3;
      pass.uniforms["scatter"].value = Math.max(0, Number(cfg.params.scatter) || 0);
      pass.uniforms["blending"].value = Number(cfg.params.amount) ?? 1;
      pass.uniforms["greyscale"].value = Boolean(cfg.params.greyscale);
      pass.uniforms["width"].value = width;
      pass.uniforms["height"].value = height;
      break;
    }
    case "film-texture": {
      pass.uniforms["time"].value = time;
      pass.uniforms["rate"].value = Math.max(1, Number(cfg.params.rate) || 16);
      pass.uniforms["grain"].value = Number(cfg.params.grain) ?? 0.12;
      pass.uniforms["dust"].value = Number(cfg.params.dust) ?? 0.2;
      pass.uniforms["scratches"].value = Number(cfg.params.scratches) ?? 0.15;
      pass.uniforms["blotches"].value = Number(cfg.params.blotches) ?? 0.15;
      pass.uniforms["seed"].value = Number(cfg.params.seed) || 0;
      pass.uniforms["resolution"].value.set(width, height);
      break;
    }
    case "super8": {
      pass.uniforms["time"].value = time;
      pass.uniforms["rate"].value = Math.max(1, Number(cfg.params.rate) || 18);
      pass.uniforms["softness"].value = Number(cfg.params.softness) ?? 1.2;
      pass.uniforms["flicker"].value = Number(cfg.params.flicker) ?? 0.12;
      pass.uniforms["weave"].value = Number(cfg.params.weave) ?? 0.35;
      pass.uniforms["warmth"].value = Number(cfg.params.warmth) ?? 0.35;
      pass.uniforms["vignette"].value = Number(cfg.params.vignette) ?? 0.45;
      pass.uniforms["seed"].value = Number(cfg.params.seed) || 0;
      pass.uniforms["resolution"].value.set(width, height);
      break;
    }
    case "dry-brush": {
      const paper = cfg.params.paperColor instanceof THREE.Color ? cfg.params.paperColor : new THREE.Color(0xffffff);
      pass.uniforms["time"].value = time;
      pass.uniforms["rate"].value = Math.max(1, Number(cfg.params.rate) || 12);
      pass.uniforms["animate"].value = cfg.params.animate ? 1 : 0;
      pass.uniforms["coverage"].value = Number(cfg.params.coverage) ?? 0.25;
      pass.uniforms["scale"].value = Math.max(1, Number(cfg.params.scale) || 200);
      pass.uniforms["softness"].value = Number(cfg.params.softness) ?? 0.25;
      pass.uniforms["stretch"].value = Math.max(0.1, Number(cfg.params.stretch) || 1);
      pass.uniforms["angle"].value = Number(cfg.params.angle) || 0;
      pass.uniforms["followInk"].value = cfg.params.followInk ? 1 : 0;
      pass.uniforms["paperColor"].value.copy(paper);
      pass.uniforms["resolution"].value.set(width, height);
      pass.uniforms["seed"].value = Number(cfg.params.seed) || 0;
      break;
    }
    case "antialias": {
      pass.enabled = Boolean(cfg.params.enabled ?? true);
      if (pass.material?.uniforms["resolution"]) {
        pass.material.uniforms["resolution"].value.set(1 / (width * pixelRatio), 1 / (height * pixelRatio));
      }
      break;
    }
  }
}

export interface PostProcessChainDeps {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  renderPass: RenderPass;
  outputPass: OutputPass;
  motionBlurEffect: ReturnType<typeof createMotionBlur>;
  /**
   * Passe volumétrique en résolution réduite. Insérée juste après le rendu de
   * scène pour que les effets suivants (bloom en tête) voient le volume composé.
   * Ignorée tant qu'aucun maillage ne la demande.
   */
  volumetricPass?: VolumetricPass;
}

export interface PostProcessFrame {
  scene: THREE.Scene;
  camera: THREE.Camera;
  configs: PostProcessConfig[];
  /** 0 disables the motion-blur path entirely. */
  motionBlur: number;
  width: number;
  height: number;
  /** Root whose meshes the Outline pass highlights, if that pass is active. */
  outlineTarget: THREE.Object3D | null;
  /** Current playback or wallclock time in seconds for animated passes. */
  time?: number;
  /** Réglages de la passe volumétrique, ou null si aucun volume ne la demande. */
  volumetric?: VolumetricSettings | null;
}

/**
 * Owns the EffectComposer's pass chain: which passes exist, in what order,
 * with what uniforms, and when a pass whose node has gone away gets released.
 *
 * Pass *instances* are cached per node id and reused across frames — they own
 * render targets and compiled shaders, so rebuilding them every frame would
 * churn GPU memory. Only the chain's composition is rebuilt each frame, which
 * is cheap and is what lets a node reordering take effect immediately.
 */
export function createPostProcessChain(deps: PostProcessChainDeps) {
  const { renderer, composer, renderPass, outputPass, motionBlurEffect, volumetricPass } = deps;
  const passCache = new Map<string, CachedPass>();

  function disposePass(entry: CachedPass) {
    try {
      if (typeof entry.pass.dispose === "function") {
        entry.pass.dispose();
      } else if (entry.pass.material && typeof entry.pass.material.dispose === "function") {
        entry.pass.material.dispose();
      }
    } catch {
      // A failed release must not stop the rest of the chain from rebuilding.
    }
  }

  return {
    /** True when anything in this frame needs the composer path at all. */
    isActive(configs: PostProcessConfig[], motionBlur: number, volumetric?: VolumetricSettings | null): boolean {
      return configs.length > 0 || motionBlur > 0 || Boolean(volumetric);
    },

    /** Rebuild the chain for this frame and draw it. */
    render(frame: PostProcessFrame): void {
      const { scene, camera, configs, motionBlur, width, height, outlineTarget } = frame;

      if (motionBlur > 0) {
        motionBlurEffect.renderVelocity(renderer, scene, camera);
      }

      // Handle Fog postprocess configuration
      const fogCfg = configs.find((c) => c && c.type === "fog");
      if (fogCfg) {
        const color = fogCfg.params.color instanceof THREE.Color ? fogCfg.params.color : new THREE.Color(0x8899aa);
        const mode = String(fogCfg.params.mode || "linear");
        const density = Number(fogCfg.params.density) || 0.02;
        const near = Number(fogCfg.params.near) || 1.0;
        const far = Number(fogCfg.params.far) || 30.0;

        if (mode === "exponential") {
          scene.fog = new THREE.FogExp2(color, density);
        } else {
          scene.fog = new THREE.Fog(color, near, far);
        }
      } else {
        scene.fog = null;
      }

      const activeNodeIds = new Set<string>();

      composer.passes.length = 0;
      composer.addPass(renderPass);
      renderPass.clearColor = new THREE.Color(0x000000);
      renderPass.clearAlpha = 1;
      renderPass.clear = true;
      renderPass.clearDepth = true;

      // Volume en résolution réduite : rendu à part puis composé, avant tout
      // effet, pour que le bloom s'applique bien aux flammes.
      if (frame.volumetric && volumetricPass) {
        volumetricPass.configure(frame.volumetric);
        volumetricPass.setSize(width, height);
        composer.addPass(volumetricPass);
      }

      for (const cfg of configs) {
        if (!cfg || !cfg.type || !cfg.nodeId) continue;
        activeNodeIds.add(cfg.nodeId);

        let cached = passCache.get(cfg.nodeId);
        if (!cached || cached.type !== cfg.type) {
          if (cached) disposePass(cached);
          const pass = instantiatePass(cfg.type, scene, camera, width, height);
          if (!pass) continue;
          cached = { type: cfg.type, pass };
          passCache.set(cfg.nodeId, cached);
        }

        configurePass(cached.pass, cfg, width, height, renderer.getPixelRatio(), outlineTarget, frame.time ?? 0);
        // A cached pass owns render targets sized on its first instantiation;
        // EffectComposer.setSize only reaches the passes currently in
        // composer.passes, and this one only rejoins the chain here, after the
        // last resize — so re-apply the size or a pass baked before a window
        // resize would keep rendering at the stale resolution.
        if (typeof cached.pass.setSize === "function") {
          try {
            cached.pass.setSize(width, height);
          } catch {
            // Some materials reject (0,0) framebuffers; resize next frame.
          }
        }
        composer.addPass(cached.pass);
      }

      // Appended last, after every postprocess effect: the smear should be of
      // the finished frame (bloom, grading and all), not of a raw one that
      // later passes would then re-process.
      if (motionBlur > 0) {
        motionBlurEffect.setIntensity(motionBlur);
        composer.addPass(motionBlurEffect.pass);
      }

      composer.addPass(outputPass);

      for (const [nodeId, entry] of passCache.entries()) {
        if (!activeNodeIds.has(nodeId)) {
          disposePass(entry);
          passCache.delete(nodeId);
        }
      }

      composer.render();
    },

    /** Release every cached pass — on teardown, or when the chain goes idle. */
    dispose(): void {
      passCache.forEach(disposePass);
      passCache.clear();
    },

    get size(): number {
      return passCache.size;
    },
  };
}
