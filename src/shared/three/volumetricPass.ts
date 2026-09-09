import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Passe volumétrique en résolution réduite, sur le modèle de l'exemple
 * three.js webgpu_volume_fire.
 *
 * Le raymarching d'un volume coûte cher par pixel. L'exemple le rend à 50 % de
 * la résolution, le débruite par un flou gaussien, puis le compose sur la scène.
 * Ici la même chose en WebGL : les maillages volumétriques sont isolés sur un
 * layer, rendus dans une cible réduite, floutés, puis recomposés.
 *
 * ENTIÈREMENT OPT-IN : à résolution 1 le node laisse son maillage sur le layer
 * par défaut et cette passe ne s'active jamais — le volume est alors rendu
 * inline dans la scène comme avant, et le chemin de rendu historique n'est pas
 * touché.
 *
 * Contrairement à l'exemple, un pré-passage de profondeur en résolution réduite
 * est rendu d'abord : sans lui le volume s'afficherait par-dessus tout objet
 * opaque situé devant lui, puisqu'il ne partage plus le depth buffer de la
 * passe principale.
 */

/** Layer réservé aux maillages volumétriques rendus en passe séparée. */
export const LAYER_VOLUMETRIC = 10;

/** Réglages lus sur le maillage volumétrique via userData. */
export interface VolumetricSettings {
  /** Facteur de résolution dans ]0, 1]. 1 = passe séparée inutile. */
  resolutionScale: number;
  /** Force du flou de débruitage, 0 = aucun. */
  denoise: number;
}

/**
 * Cherche dans la scène un maillage demandant la passe volumétrique.
 * Renvoie null si aucun — auquel cas le rendu suit le chemin habituel.
 */
export function findVolumetricSettings(scene: THREE.Object3D): VolumetricSettings | null {
  let found: VolumetricSettings | null = null;
  scene.traverse((obj) => {
    if (found) return;
    const settings = obj.userData?.volumetric as VolumetricSettings | undefined;
    if (!settings || !obj.visible) return;
    if (!(settings.resolutionScale > 0) || settings.resolutionScale >= 1) return;
    found = settings;
  });
  return found;
}

const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tVolume;
  varying vec2 vUv;

  void main() {
    vec4 scene = texture2D(tDiffuse, vUv);
    vec3 volume = texture2D(tVolume, vUv).rgb;
    // Addition pure : c'est exactement ce que faisait le AdditiveBlending du
    // maillage rendu inline, donc basculer la résolution ne change pas l'aspect.
    gl_FragColor = vec4(scene.rgb + volume, scene.a);
  }
`;

const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uDirection;   // (texelX, 0) puis (0, texelY)
  uniform float uStrength;
  varying vec2 vUv;

  void main() {
    // Gaussienne séparable à 9 taps. Poids binomiaux normalisés.
    vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
    vec2 o1 = uDirection * 1.3846153846 * uStrength;
    vec2 o2 = uDirection * 3.2307692308 * uStrength;
    sum += (texture2D(tDiffuse, vUv + o1) + texture2D(tDiffuse, vUv - o1)) * 0.3162162162;
    sum += (texture2D(tDiffuse, vUv + o2) + texture2D(tDiffuse, vUv - o2)) * 0.0702702703;
    gl_FragColor = sum;
  }
`;

const PASSTHROUGH_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class VolumetricPass extends Pass {
  private scene: THREE.Scene;
  private camera: THREE.Camera;

  /** Cible où le volume est rendu, en résolution réduite. */
  private volumeTarget: THREE.WebGLRenderTarget;
  /** Cible de rebond pour la seconde direction du flou séparable. */
  private blurTarget: THREE.WebGLRenderTarget;

  private compositeQuad: FullScreenQuad;
  private blurQuad: FullScreenQuad;
  private compositeMaterial: THREE.ShaderMaterial;
  private blurMaterial: THREE.ShaderMaterial;

  /** Matériau de pré-passage de profondeur : écrit le depth, pas la couleur. */
  private depthOnlyMaterial: THREE.MeshBasicMaterial;

  private width = 1;
  private height = 1;
  private settings: VolumetricSettings = { resolutionScale: 0.5, denoise: 0.5 };

  constructor(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = true;

    const targetOptions: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    };
    this.volumeTarget = new THREE.WebGLRenderTarget(width, height, targetOptions);
    this.blurTarget = new THREE.WebGLRenderTarget(width, height, { ...targetOptions, depthBuffer: false });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tVolume: { value: null } },
      vertexShader: PASSTHROUGH_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new THREE.Vector2() },
        uStrength: { value: 1 },
      },
      vertexShader: PASSTHROUGH_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
    this.blurQuad = new FullScreenQuad(this.blurMaterial);

    this.depthOnlyMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

    this.setSize(width, height);
  }

  /** Réglages du frame courant, lus sur le maillage volumétrique. */
  configure(settings: VolumetricSettings): void {
    const changed = settings.resolutionScale !== this.settings.resolutionScale;
    this.settings = settings;
    if (changed) this.setSize(this.width, this.height);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const scale = Math.min(1, Math.max(0.05, this.settings.resolutionScale));
    const w = Math.max(1, Math.floor(this.width * scale));
    const h = Math.max(1, Math.floor(this.height * scale));
    this.volumeTarget.setSize(w, h);
    this.blurTarget.setSize(w, h);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    renderer.autoClear = false;

    // --- 1) Volume seul, en résolution réduite ---
    renderer.setRenderTarget(this.volumeTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);

    // Pré-passage de profondeur : la scène opaque remplit le depth buffer réduit
    // pour que le volume soit correctement masqué par ce qui est devant lui.
    // Sans lui, sortir le volume de la passe principale lui ferait perdre toute
    // occlusion — l'exemple three.js a d'ailleurs ce défaut.
    const cameraLayers = this.camera.layers.mask;
    this.scene.background = null;
    this.camera.layers.disable(LAYER_VOLUMETRIC);
    this.scene.overrideMaterial = this.depthOnlyMaterial;
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = previousOverride;

    // Puis le volume, testé contre cette profondeur
    this.camera.layers.set(LAYER_VOLUMETRIC);
    renderer.render(this.scene, this.camera);
    this.camera.layers.mask = cameraLayers;
    this.scene.background = previousBackground;

    // --- 2) Débruitage : gaussienne séparable ---
    let volumeTexture = this.volumeTarget.texture;
    const denoise = this.settings.denoise;
    if (denoise > 0) {
      const w = this.volumeTarget.width;
      const h = this.volumeTarget.height;

      this.blurMaterial.uniforms.uStrength.value = denoise;
      this.blurMaterial.uniforms.tDiffuse.value = this.volumeTarget.texture;
      (this.blurMaterial.uniforms.uDirection.value as THREE.Vector2).set(1 / w, 0);
      renderer.setRenderTarget(this.blurTarget);
      renderer.clear(true, false, false);
      this.blurQuad.render(renderer);

      this.blurMaterial.uniforms.tDiffuse.value = this.blurTarget.texture;
      (this.blurMaterial.uniforms.uDirection.value as THREE.Vector2).set(0, 1 / h);
      renderer.setRenderTarget(this.volumeTarget);
      renderer.clear(true, false, false);
      this.blurQuad.render(renderer);

      volumeTexture = this.volumeTarget.texture;
    }

    // --- 3) Composition sur la scène ---
    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tVolume.value = volumeTexture;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      renderer.clear(true, false, false);
    }
    this.compositeQuad.render(renderer);

    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }

  dispose(): void {
    this.volumeTarget.dispose();
    this.blurTarget.dispose();
    this.compositeMaterial.dispose();
    this.blurMaterial.dispose();
    this.depthOnlyMaterial.dispose();
    this.compositeQuad.dispose();
    this.blurQuad.dispose();
  }
}
