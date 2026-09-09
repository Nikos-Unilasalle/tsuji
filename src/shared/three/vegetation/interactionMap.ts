import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * A top-down map of what has touched the ground, painted every frame and
 * fading back over time.
 *
 * This is the piece that makes a world feel walked-on rather than decorated:
 * an orthographic camera looks straight down at a square of world, whatever
 * is moving through it paints into a render target, and the target is fed
 * back into itself each frame slightly dimmer. Grass reads it and lies flat
 * where you have been; anything else that samples a texture can read it too —
 * snow, sand, heat, wetness, a trail of light. The node paints; what the mark
 * *means* is the consumer's business.
 *
 * Two decisions worth stating:
 *
 * - **It scrolls with its centre.** Wire a character's position in and the map
 *   follows them, its contents shifting by the same delta in UV so marks stay
 *   put in world space. A fixed map would either cover the whole world at
 *   useless resolution or run out under the player.
 * - **Ping-pong, not read-write.** A render target cannot be sampled and
 *   written in the same pass, so the fade reads A and writes B, then the
 *   brushes draw into B, and the two swap. The alternative — reading back to
 *   the CPU — would cost a pipeline stall every frame.
 */

/** World size of one map, and where it sits, as carried on the output texture. */
export interface MapPlacement {
  center: THREE.Vector2;
  size: number;
}

/**
 * The world↔map convention, shared by every shader that samples one of these.
 *
 * v is flipped because a top-down camera necessarily mirrors one axis, and
 * this is the choice that matches how a map image reads: v = 1 is the top of
 * the image, which is −Z, i.e. north. Grass's density map uses the same
 * function, so a hand-painted map and a live interaction map line up.
 */
export const MAP_UV_GLSL = /* glsl */ `
  vec2 mapUv(vec2 worldXZ, vec2 mapCenter, float mapSize) {
    return vec2(
      (worldXZ.x - mapCenter.x) / mapSize + 0.5,
      0.5 - (worldXZ.y - mapCenter.y) / mapSize
    );
  }

  float mapInside(vec2 uv) {
    return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  }
`;

/** The TypeScript twin of `mapUv`. */
export function worldToMapUv(
  worldX: number,
  worldZ: number,
  center: THREE.Vector2,
  size: number,
  target = new THREE.Vector2(),
): THREE.Vector2 {
  return target.set((worldX - center.x) / size + 0.5, 0.5 - (worldZ - center.y) / size);
}

/**
 * How much of the previous frame survives into this one.
 *
 * Expressed as a half-life in seconds rather than a per-frame multiplier, so
 * the mark lasts the same wall-clock time whether the graph is running at 30
 * or 144 fps — a per-frame constant would make tracks vanish faster on a
 * faster machine. A half-life of 0 means "never fades".
 */
export function interactionFade(halfLifeSeconds: number, deltaSeconds: number): number {
  if (halfLifeSeconds <= 0) return 1;
  if (deltaSeconds <= 0) return 1;
  return Math.pow(0.5, deltaSeconds / halfLifeSeconds);
}

/**
 * Where the brushes go this frame.
 *
 * Takes both a geometry and a list because both are how a graph names moving
 * things: an object (a character, a vehicle) contributes its own world
 * position and that of every mesh under it, so a rigged group leaves one mark
 * per foot rather than one at its origin; a list of vectors covers everything
 * else — instance positions, particle points, raycast hits.
 */
export function collectPaintPoints(source: unknown, positions: unknown): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];

  if (source instanceof THREE.Object3D) {
    source.updateWorldMatrix(true, true);
    const seen = new Set<string>();
    const add = (object: THREE.Object3D) => {
      const point = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
      // Two meshes at the same spot would just burn brush slots.
      const key = `${point.x.toFixed(3)}|${point.z.toFixed(3)}`;
      if (seen.has(key)) return;
      seen.add(key);
      points.push(point);
    };
    add(source);
    source.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) add(child);
    });
  }

  if (Array.isArray(positions)) {
    for (const entry of positions) {
      if (entry instanceof THREE.Vector3) points.push(entry.clone());
    }
  }

  return points;
}

const BRUSH_CAPACITY = 512;

const FADE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FADE_FRAGMENT = /* glsl */ `
  uniform sampler2D uPrevious;
  uniform vec2 uScroll;
  uniform float uFade;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv + uScroll;
    // Whatever scrolled in from outside the old map was never painted.
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    float previous = texture2D(uPrevious, clamp(uv, 0.0, 1.0)).r * inside;
    gl_FragColor = vec4(vec3(previous * uFade), 1.0);
  }
`;

const BRUSH_VERTEX = /* glsl */ `
  varying vec2 vBrushUv;
  void main() {
    vBrushUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const BRUSH_FRAGMENT = /* glsl */ `
  uniform float uStrength;
  uniform float uHardness;
  varying vec2 vBrushUv;

  void main() {
    float distance = length(vBrushUv - 0.5) * 2.0;
    float mark = smoothstep(1.0, uHardness, distance) * uStrength;
    gl_FragColor = vec4(vec3(mark), 1.0);
  }
`;

export interface InteractionMapState {
  resolution: number;
  read: THREE.WebGLRenderTarget;
  write: THREE.WebGLRenderTarget;
  fadeMaterial: THREE.ShaderMaterial;
  fadeQuad: FullScreenQuad;
  brushMaterial: THREE.ShaderMaterial;
  brushes: THREE.InstancedMesh;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /** Where the map was last frame, so the scroll delta is known. */
  center: THREE.Vector2;
  size: number;
  /** Last evaluated time, for a frame-rate-independent fade. */
  time: number;
  dispose: () => void;
}

export function createInteractionMapState(resolution: number): InteractionMapState {
  const options = {
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  } as const;

  const read = new THREE.WebGLRenderTarget(resolution, resolution, options);
  const write = new THREE.WebGLRenderTarget(resolution, resolution, options);

  const fadeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uPrevious: { value: null },
      uScroll: { value: new THREE.Vector2() },
      uFade: { value: 1 },
    },
    vertexShader: FADE_VERTEX,
    fragmentShader: FADE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });

  const brushMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uStrength: { value: 1 },
      uHardness: { value: 0.2 },
    },
    vertexShader: BRUSH_VERTEX,
    fragmentShader: BRUSH_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });

  const brushGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const brushes = new THREE.InstancedMesh(brushGeometry, brushMaterial, BRUSH_CAPACITY);
  brushes.frustumCulled = false;
  brushes.count = 0;

  const scene = new THREE.Scene();
  scene.add(brushes);

  // Straight down, with screen-right = +X and screen-up = −Z. That pairing is
  // what `mapUv` above encodes; changing one without the other mirrors every
  // mark.
  const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.01, 100);
  camera.up.set(0, 0, -1);

  const fadeQuad = new FullScreenQuad(fadeMaterial);

  const state: InteractionMapState = {
    resolution,
    read,
    write,
    fadeMaterial,
    fadeQuad,
    brushMaterial,
    brushes,
    scene,
    camera,
    center: new THREE.Vector2(),
    size: 0,
    time: 0,
    dispose: () => {
      read.dispose();
      write.dispose();
      fadeMaterial.dispose();
      fadeQuad.dispose();
      brushMaterial.dispose();
      brushGeometry.dispose();
    },
  };

  return state;
}

export interface InteractionMapStep {
  center: THREE.Vector2;
  size: number;
  points: THREE.Vector3[];
  radius: number;
  strength: number;
  hardness: number;
  /** Seconds for a mark to lose half its intensity. 0 = permanent. */
  halfLife: number;
  time: number;
}

/**
 * Advances the map one frame and returns the texture holding it.
 *
 * The size of one frame's work is one full-screen quad plus one instanced
 * draw of however many brushes there are — the map does not get more
 * expensive as the world fills up with marks, only as more things paint at
 * once.
 */
export function stepInteractionMap(
  renderer: THREE.WebGLRenderer,
  state: InteractionMapState,
  step: InteractionMapStep,
): THREE.Texture {
  const size = Math.max(0.001, step.size);

  // A resized or teleported map has nothing meaningful to scroll: fall back to
  // no offset rather than smearing the old contents across the new extent.
  const sizeChanged = Math.abs(size - state.size) > 1e-6;
  const scrollX = sizeChanged ? 0 : (step.center.x - state.center.x) / size;
  const scrollY = sizeChanged ? 0 : -(step.center.y - state.center.y) / size;

  const delta = Math.max(0, step.time - state.time);
  const fade = sizeChanged ? 0 : interactionFade(step.halfLife, delta);

  state.fadeMaterial.uniforms.uPrevious.value = state.read.texture;
  (state.fadeMaterial.uniforms.uScroll.value as THREE.Vector2).set(scrollX, scrollY);
  state.fadeMaterial.uniforms.uFade.value = fade;

  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;

  renderer.setRenderTarget(state.write);
  state.fadeQuad.render(renderer);

  const count = Math.min(step.points.length, BRUSH_CAPACITY);
  state.brushes.count = count;
  if (count > 0) {
    const scale = new THREE.Vector3(step.radius * 2, 1, step.radius * 2);
    const quaternion = new THREE.Quaternion();
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const point = step.points[i];
      matrix.compose(new THREE.Vector3(point.x, 0, point.z), quaternion, scale);
      state.brushes.setMatrixAt(i, matrix);
    }
    state.brushes.instanceMatrix.needsUpdate = true;

    state.brushMaterial.uniforms.uStrength.value = step.strength;
    state.brushMaterial.uniforms.uHardness.value = step.hardness;

    const half = size / 2;
    state.camera.left = -half;
    state.camera.right = half;
    state.camera.top = half;
    state.camera.bottom = -half;
    state.camera.position.set(step.center.x, 10, step.center.y);
    state.camera.lookAt(step.center.x, 0, step.center.y);
    state.camera.updateProjectionMatrix();

    // The fade pass already wrote every pixel; clearing here would erase it.
    renderer.autoClear = false;
    renderer.render(state.scene, state.camera);
  }

  renderer.autoClear = previousAutoClear;
  renderer.setRenderTarget(previousTarget);

  // Ping-pong: what was just written becomes next frame's history.
  const written = state.write;
  state.write = state.read;
  state.read = written;

  state.center.copy(step.center);
  state.size = size;
  state.time = step.time;

  return written.texture;
}
