import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { isFatLine, isRealMesh } from "./objectKinds";

/**
 * Velocity-buffer motion blur — the GPU Gems 3 ch.27 idea (per-pixel screen
 * velocity, then blur along it), extended past what the three.js forum
 * write-up of that technique does.
 *
 * That write-up reconstructs velocity from the depth buffer and the previous
 * *camera* matrix, which makes it blur camera movement only: with a static
 * camera it produces nothing at all. In this app the camera is often parked
 * while Transform nodes animate the objects, so it would have blurred
 * nothing in the common case. Rendering a real velocity buffer instead —
 * each vertex projected through both its current and its previous model
 * matrix — costs one extra depth-less scene pass and covers object motion
 * and camera motion in the same buffer.
 *
 * Replaces the AfterimagePass this started as. That pass just faded old
 * frames on top of new ones, so it smeared *everything* uniformly (a still
 * object ghosted as much as a fast one), trails persisted well after motion
 * stopped, and the direction of travel was nowhere in the result. This is
 * directional, proportional to actual speed, and stops the instant motion
 * does.
 */

/**
 * Fixed, not a uniform: GLSL ES 1.00 (what three compiles ShaderMaterial to
 * unless asked otherwise) requires a constant loop bound, and a dynamic
 * `break` against a uniform is exactly the pattern some drivers reject.
 */
const SAMPLES = 16;

/**
 * Ceiling on per-pixel velocity, in UV units. Something crossing the whole
 * screen in one frame would otherwise ask for a smear the size of the
 * viewport, which reads as a broken frame rather than fast motion.
 */
const MAX_VELOCITY_UV = 0.05;

/**
 * Maps the node's 0..1 knob onto shutter length, counted in frames of travel.
 *
 * The velocity buffer measures exactly one frame of movement, so a scale of 1
 * capped the smear at "however far this thing moved since the last frame" —
 * about 1% of the screen for something crossing the viewport in a second at
 * 60fps, which read as no blur at all. A camera shutter integrates over a
 * slice of *time*, not over one display refresh, so the knob buys several
 * frames of travel instead; 4 puts a full-strength setting in the same range
 * as a 180° shutter on 15fps footage, i.e. visibly smeared but not a streak.
 */
const SHUTTER_SCALE = 4.0;

/**
 * A stable identity for an instance, across frames.
 *
 * Array/Instance/Merge nodes rebuild their output every evaluation —
 * `structure/array` clones its source per item, so the 144 meshes on this
 * frame are 144 *different objects* from the 144 on the last one (verified:
 * zero shared uuids between two evaluations of the same graph). A previous
 * matrix parked on the object therefore died with it, every mesh reported
 * "previous == current", and object motion blurred nothing at all. Only the
 * camera term survived, because that one is per-frame rather than per-object.
 * (The structure nodes now keep and re-sync their copies — nodes/syncedClone.ts
 * — so most objects do survive; a reloaded graph, a source whose shape
 * changed or a pane's own clones still don't, so the key stays.)
 *
 * The owning node id rides along in userData (object.ts stamps it, and
 * Object3D.clone copies userData), and traversal order is deterministic for a
 * given graph, so node id + ordinal names the same instance on both frames.
 * When a count changes, keys shift by one and those instances read one bogus
 * frame of velocity — bounded by MAX_VELOCITY_UV and gone the next frame.
 */
export function velocityKey(mesh: THREE.Object3D, ordinals: Map<string, number>): string {
  const owner = typeof mesh.userData.nodeId === "string" ? mesh.userData.nodeId : "anon";
  const ordinal = ordinals.get(owner) ?? 0;
  ordinals.set(owner, ordinal + 1);
  return `${owner}#${ordinal}`;
}

const VELOCITY_VERTEX_SHADER = /* glsl */ `
  uniform mat4 prevModelMatrix;
  uniform mat4 prevViewProjectionMatrix;
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;

  void main() {
    vec4 localPosition = vec4(position, 1.0);
    vCurrentClip = projectionMatrix * viewMatrix * modelMatrix * localPosition;
    vPreviousClip = prevViewProjectionMatrix * prevModelMatrix * localPosition;
    gl_Position = vCurrentClip;
  }
`;

const VELOCITY_FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;

  void main() {
    vec2 current = vCurrentClip.xy / vCurrentClip.w;
    vec2 previous = vPreviousClip.xy / vPreviousClip.w;
    // NDC spans 2 units across what is 1 unit of UV, hence the halving.
    vec2 velocity = (current - previous) * 0.5;
    // Alpha flags "geometry was here" — the blur pass leaves everything else
    // (the background layer) perfectly sharp.
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const PARTICLE_VELOCITY_VERTEX_SHADER = /* glsl */ `
  uniform sampler2D positions;
  uniform sampler2D velocities;
  uniform float pointSize;
  uniform float lifetime;
  uniform float fadeFraction;
  uniform float fadeSize;
  uniform mat4 prevModelMatrix;
  uniform mat4 prevViewProjectionMatrix;
  attribute vec2 reference;
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;
  varying float vAlive;

  void main() {
    vec4 data = texture2D(positions, reference);
    vAlive = data.a >= 0.0 ? 1.0 : 0.0;
    if (vAlive < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec4 velData = texture2D(velocities, reference);
    vec3 vel = velData.xyz;
    // Step seconds: 1/60s (approx per-frame simulation delta)
    vec3 prevLocalPos = data.xyz - vel * 0.016666667;

    vec4 currentWorld = modelMatrix * vec4(data.xyz, 1.0);
    vec4 prevWorld = prevModelMatrix * vec4(prevLocalPos, 1.0);

    vCurrentClip = projectionMatrix * viewMatrix * currentWorld;
    vPreviousClip = prevViewProjectionMatrix * prevWorld;

    float lifeT = lifetime > 0.0 ? clamp(data.a / lifetime, 0.0, 1.0) : 1.0;
    float fadeIn = smoothstep(0.0, max(fadeFraction, 0.0001), lifeT);
    float fadeOut = 1.0 - smoothstep(1.0 - max(fadeFraction, 0.0001), 1.0, lifeT);
    float vEnvelope = min(fadeIn, fadeOut);

    vec4 mvPosition = viewMatrix * currentWorld;
    float sizeMul = mix(1.0, vEnvelope, fadeSize);
    float baseSize = vAlive * pointSize * sizeMul * (300.0 / -mvPosition.z);

    // Expand point size across travel distance so the velocity buffer covers the entire swept path
    vec4 midClip = (vCurrentClip + vPreviousClip) * 0.5;
    vec2 currentNDC = vCurrentClip.xy / max(vCurrentClip.w, 1e-4);
    vec2 prevNDC = vPreviousClip.xy / max(vPreviousClip.w, 1e-4);
    float travelPixels = length(currentNDC - prevNDC) * 500.0;

    gl_PointSize = max(baseSize, baseSize + travelPixels);
    gl_Position = midClip;
  }
`;

const PARTICLE_VELOCITY_FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;
  varying float vAlive;

  void main() {
    if (vAlive < 0.5) discard;
    vec2 current = vCurrentClip.xy / max(vCurrentClip.w, 1e-4);
    vec2 previous = vPreviousClip.xy / max(vPreviousClip.w, 1e-4);
    vec2 velocity = (current - previous) * 0.5;
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const POINTS_VELOCITY_VERTEX_SHADER = /* glsl */ `
  uniform mat4 prevModelMatrix;
  uniform mat4 prevViewProjectionMatrix;
  uniform float pointSize;
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;

  void main() {
    vec4 localPosition = vec4(position, 1.0);
    vec4 currentWorld = modelMatrix * localPosition;
    vec4 prevWorld = prevModelMatrix * localPosition;
    vCurrentClip = projectionMatrix * viewMatrix * currentWorld;
    vPreviousClip = prevViewProjectionMatrix * prevWorld;

    vec4 mvPosition = modelViewMatrix * localPosition;
    float baseSize = pointSize * (300.0 / -mvPosition.z);

    vec4 midClip = (vCurrentClip + vPreviousClip) * 0.5;
    vec2 currentNDC = vCurrentClip.xy / max(vCurrentClip.w, 1e-4);
    vec2 prevNDC = vPreviousClip.xy / max(vPreviousClip.w, 1e-4);
    float travelPixels = length(currentNDC - prevNDC) * 500.0;

    gl_PointSize = max(baseSize, baseSize + travelPixels);
    gl_Position = midClip;
  }
`;

const POINTS_VELOCITY_FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;

  void main() {
    vec2 current = vCurrentClip.xy / max(vCurrentClip.w, 1e-4);
    vec2 previous = vPreviousClip.xy / max(vPreviousClip.w, 1e-4);
    vec2 velocity = (current - previous) * 0.5;
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const INSTANCED_VELOCITY_VERTEX_SHADER = /* glsl */ `
  attribute mat4 prevInstanceMatrix;
  uniform mat4 prevModelMatrix;
  uniform mat4 prevViewProjectionMatrix;
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;

  void main() {
    vec4 localPosition = vec4(position, 1.0);
    vec4 currentWorld = modelMatrix * instanceMatrix * localPosition;
    vec4 prevWorld = prevModelMatrix * prevInstanceMatrix * localPosition;

    vCurrentClip = projectionMatrix * viewMatrix * currentWorld;
    vPreviousClip = prevViewProjectionMatrix * prevWorld;
    gl_Position = vCurrentClip;
  }
`;

const INSTANCED_VELOCITY_FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;

  void main() {
    vec2 current = vCurrentClip.xy / max(vCurrentClip.w, 1e-4);
    vec2 previous = vPreviousClip.xy / max(vPreviousClip.w, 1e-4);
    vec2 velocity = (current - previous) * 0.5;
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const MOTION_BLUR_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tVelocity: { value: null as THREE.Texture | null },
    intensity: { value: 0 },
    maxVelocity: { value: MAX_VELOCITY_UV },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #define SAMPLES ${SAMPLES}

    uniform sampler2D tDiffuse;
    uniform sampler2D tVelocity;
    uniform float intensity;
    uniform float maxVelocity;
    varying vec2 vUv;

    void main() {
      vec4 velocitySample = texture2D(tVelocity, vUv);
      vec4 sharp = texture2D(tDiffuse, vUv);

      if (velocitySample.a < 0.5 || intensity <= 0.0) {
        gl_FragColor = sharp;
        return;
      }

      vec2 velocity = velocitySample.xy * intensity;
      float speed = length(velocity);
      if (speed < 0.0005) {
        gl_FragColor = sharp;
        return;
      }
      if (speed > maxVelocity) velocity *= maxVelocity / speed;

      vec4 sum = vec4(0.0);
      for (int i = 0; i < SAMPLES; i++) {
        float t = float(i) / float(SAMPLES - 1) - 0.5;
        vec2 sampleUv = vUv + velocity * t;
        sum += texture2D(tDiffuse, sampleUv);
      }

      gl_FragColor = sum / float(SAMPLES);
    }
  `,
};

export interface MotionBlur {
  pass: ShaderPass;
  /** Renders this frame's velocity buffer. Call before the composer runs, only when the effect is on. */
  renderVelocity: (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => void;
  /** Feeds the knob through to the blur shader. */
  setIntensity: (amount: number) => void;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
}

function isEffectivelyVisible(object: THREE.Object3D): boolean {
  let curr: THREE.Object3D | null = object;
  while (curr) {
    if (!curr.visible) return false;
    curr = curr.parent;
  }
  return true;
}

export function createMotionBlur(width: number, height: number): MotionBlur {
  const velocityTarget = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    // Velocity is signed, so an ordinary 8-bit target would clip every
    // leftward/downward movement to zero.
    type: THREE.HalfFloatType,
    depthBuffer: true,
  });

  const velocityMaterial = new THREE.ShaderMaterial({
    uniforms: {
      prevModelMatrix: { value: new THREE.Matrix4() },
      prevViewProjectionMatrix: { value: new THREE.Matrix4() },
    },
    vertexShader: VELOCITY_VERTEX_SHADER,
    fragmentShader: VELOCITY_FRAGMENT_SHADER,
    side: THREE.DoubleSide,
  });

  const instancedVelocityMaterial = new THREE.ShaderMaterial({
    uniforms: {
      prevModelMatrix: { value: new THREE.Matrix4() },
      prevViewProjectionMatrix: { value: new THREE.Matrix4() },
    },
    vertexShader: INSTANCED_VELOCITY_VERTEX_SHADER,
    fragmentShader: INSTANCED_VELOCITY_FRAGMENT_SHADER,
    side: THREE.DoubleSide,
  });

  const particleVelocityMaterial = new THREE.ShaderMaterial({
    uniforms: {
      positions: { value: null as THREE.Texture | null },
      velocities: { value: null as THREE.Texture | null },
      pointSize: { value: 4 },
      lifetime: { value: 0 },
      fadeFraction: { value: 0.15 },
      fadeSize: { value: 0 },
      prevModelMatrix: { value: new THREE.Matrix4() },
      prevViewProjectionMatrix: { value: new THREE.Matrix4() },
    },
    vertexShader: PARTICLE_VELOCITY_VERTEX_SHADER,
    fragmentShader: PARTICLE_VELOCITY_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

  const pointsVelocityMaterial = new THREE.ShaderMaterial({
    uniforms: {
      pointSize: { value: 4 },
      prevModelMatrix: { value: new THREE.Matrix4() },
      prevViewProjectionMatrix: { value: new THREE.Matrix4() },
    },
    vertexShader: POINTS_VELOCITY_VERTEX_SHADER,
    fragmentShader: POINTS_VELOCITY_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

  const pass = new ShaderPass(MOTION_BLUR_SHADER);
  pass.uniforms.tVelocity.value = velocityTarget.texture;

  const previousViewProjection = new THREE.Matrix4();
  const currentViewProjection = new THREE.Matrix4();
  let hasPreviousFrame = false;

  /**
   * Last frame's world matrix per instance, keyed by identity rather than held
   * on the object — see velocityKey. Lives in the closure, so the two split
   * viewport panes keep separate histories.
   */
  const previousMatrices = new Map<string, THREE.Matrix4>();

  // Per-object previous model matrix has to reach a material that every
  // object shares, so it can only be set per draw call. `onBeforeRender`
  // fires immediately before each object's draw, which is exactly that hook;
  // `uniformsNeedUpdate` is what stops three from deciding the material is
  // unchanged since the last object and skipping the re-upload.
  const velocityHook: THREE.Object3D["onBeforeRender"] = function (this: THREE.Object3D) {
    if (!isRenderingVelocity) return;
    const key = this.userData.__velocityKey as string | undefined;
    const previousMatrix = key !== undefined ? previousMatrices.get(key) : undefined;
    velocityMaterial.uniforms.prevModelMatrix.value.copy(previousMatrix ?? this.matrixWorld);
    velocityMaterial.uniformsNeedUpdate = true;
  };
  let isRenderingVelocity = false;

  function renderVelocity(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    currentViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // Nothing to compare against on the very first frame — a zeroed previous
    // camera would report every pixel as moving at once.
    velocityMaterial.uniforms.prevViewProjectionMatrix.value.copy(
      hasPreviousFrame ? previousViewProjection : currentViewProjection,
    );

    const meshes: THREE.Mesh[] = [];
    const instancedMeshes: THREE.InstancedMesh[] = [];
    const hooked: THREE.Mesh[] = [];
    const particlePoints: THREE.Points[] = [];
    const genericPoints: THREE.Points[] = [];
    const hidden: THREE.Object3D[] = [];
    const ordinals = new Map<string, number>();

    scene.traverse((object) => {
      if (!isEffectivelyVisible(object)) return;

      if (object instanceof THREE.InstancedMesh) {
        object.userData.__velocityKey = velocityKey(object, ordinals);
        instancedMeshes.push(object);
        return;
      }
      if (isRealMesh(object)) {
        if (object.onBeforeRender !== velocityHook) {
          object.onBeforeRender = velocityHook;
          hooked.push(object);
        }
        object.userData.__velocityKey = velocityKey(object, ordinals);
        meshes.push(object);
        return;
      }
      if (object instanceof THREE.Points) {
        object.userData.__velocityKey = velocityKey(object, ordinals);
        if (object.userData.isParticleSystem) {
          particlePoints.push(object);
        } else {
          genericPoints.push(object);
        }
        return;
      }
      if (object instanceof THREE.Line || object instanceof THREE.Sprite || isFatLine(object)) {
        object.visible = false;
        hidden.push(object);
      }
    });

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;
    const previousBackground = scene.background;
    const previousClearColor = new THREE.Color();
    renderer.getClearColor(previousClearColor);
    const previousClearAlpha = renderer.getClearAlpha();

    isRenderingVelocity = true;
    scene.background = null;
    renderer.setRenderTarget(velocityTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);

    // Pass 1: Render standard meshes with scene.overrideMaterial
    if (meshes.length > 0) {
      for (const im of instancedMeshes) im.visible = false;
      for (const p of particlePoints) p.visible = false;
      for (const p of genericPoints) p.visible = false;
      scene.overrideMaterial = velocityMaterial;
      renderer.render(scene, camera);
      scene.overrideMaterial = null;
      for (const im of instancedMeshes) im.visible = true;
      for (const p of particlePoints) p.visible = true;
      for (const p of genericPoints) p.visible = true;
    }

    // Pass 2: Render instanced meshes with per-instance previous matrix tracking
    if (instancedMeshes.length > 0) {
      for (const m of meshes) m.visible = false;
      for (const p of particlePoints) p.visible = false;
      for (const p of genericPoints) p.visible = false;
      const originalInstMaterials = new Map<THREE.InstancedMesh, THREE.Material | THREE.Material[]>();

      for (const instMesh of instancedMeshes) {
        originalInstMaterials.set(instMesh, instMesh.material);
        instMesh.material = instancedVelocityMaterial;

        let prevAttr = instMesh.geometry.getAttribute("prevInstanceMatrix") as THREE.InstancedBufferAttribute | undefined;
        if (!prevAttr || prevAttr.array.length !== instMesh.instanceMatrix.array.length) {
          prevAttr = new THREE.InstancedBufferAttribute(new Float32Array(instMesh.instanceMatrix.array), 16);
          instMesh.geometry.setAttribute("prevInstanceMatrix", prevAttr);
        }

        const key = instMesh.userData.__velocityKey as string;
        const prevMtx = previousMatrices.get(key);
        instancedVelocityMaterial.uniforms.prevModelMatrix.value.copy(prevMtx ?? instMesh.matrixWorld);
        instancedVelocityMaterial.uniforms.prevViewProjectionMatrix.value.copy(
          hasPreviousFrame ? previousViewProjection : currentViewProjection,
        );
        instancedVelocityMaterial.uniformsNeedUpdate = true;
      }

      scene.overrideMaterial = null;
      renderer.render(scene, camera);

      // Restore original materials and update prevInstanceMatrix buffer
      for (const [instMesh, mat] of originalInstMaterials) {
        instMesh.material = mat;
        const prevAttr = instMesh.geometry.getAttribute("prevInstanceMatrix") as THREE.InstancedBufferAttribute | undefined;
        if (prevAttr) {
          prevAttr.copyArray(instMesh.instanceMatrix.array);
          prevAttr.needsUpdate = true;
        }
      }
      for (const m of meshes) m.visible = true;
      for (const p of particlePoints) p.visible = true;
      for (const p of genericPoints) p.visible = true;
    }

    // Pass 3: Render particle systems and point clouds with their custom velocity materials
    if (particlePoints.length > 0 || genericPoints.length > 0) {
      for (const m of meshes) m.visible = false;
      for (const im of instancedMeshes) im.visible = false;
      const originalMaterials = new Map<THREE.Points, THREE.Material | THREE.Material[]>();

      for (const p of particlePoints) {
        originalMaterials.set(p, p.material);
        p.material = particleVelocityMaterial;
        particleVelocityMaterial.uniforms.positions.value = p.userData.particlePositionsTexture ?? null;
        particleVelocityMaterial.uniforms.velocities.value = p.userData.particleVelocitiesTexture ?? null;
        particleVelocityMaterial.uniforms.pointSize.value = p.userData.particlePointSize ?? 4;
        particleVelocityMaterial.uniforms.lifetime.value = p.userData.particleLifetime ?? 0;
        particleVelocityMaterial.uniforms.fadeFraction.value = p.userData.particleFadeFraction ?? 0.15;
        particleVelocityMaterial.uniforms.fadeSize.value = p.userData.particleFadeSize ?? 0;
        const key = p.userData.__velocityKey as string;
        const prevMtx = previousMatrices.get(key);
        particleVelocityMaterial.uniforms.prevModelMatrix.value.copy(prevMtx ?? p.matrixWorld);
        particleVelocityMaterial.uniforms.prevViewProjectionMatrix.value.copy(
          hasPreviousFrame ? previousViewProjection : currentViewProjection,
        );
        particleVelocityMaterial.uniformsNeedUpdate = true;
      }

      for (const p of genericPoints) {
        originalMaterials.set(p, p.material);
        p.material = pointsVelocityMaterial;
        const pointSize =
          (p.material as { size?: number })?.size ??
          (p.material as { uniforms?: { pointSize?: { value: number } } })?.uniforms?.pointSize?.value ??
          4;
        pointsVelocityMaterial.uniforms.pointSize.value = pointSize;
        const key = p.userData.__velocityKey as string;
        const prevMtx = previousMatrices.get(key);
        pointsVelocityMaterial.uniforms.prevModelMatrix.value.copy(prevMtx ?? p.matrixWorld);
        pointsVelocityMaterial.uniforms.prevViewProjectionMatrix.value.copy(
          hasPreviousFrame ? previousViewProjection : currentViewProjection,
        );
        pointsVelocityMaterial.uniformsNeedUpdate = true;
      }

      scene.overrideMaterial = null;
      renderer.render(scene, camera);

      // Restore original materials and mesh visibility
      for (const [p, mat] of originalMaterials) {
        p.material = mat;
      }
      for (const m of meshes) m.visible = true;
      for (const im of instancedMeshes) im.visible = true;
    }

    isRenderingVelocity = false;
    scene.overrideMaterial = previousOverride;
    scene.background = previousBackground;
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.setRenderTarget(previousTarget);
    for (const object of hidden) object.visible = true;

    for (const mesh of hooked) delete (mesh as { onBeforeRender?: unknown }).onBeforeRender;

    // Snapshot *after* drawing — these become "previous" for the next frame.
    const live = new Set<string>();
    for (const mesh of meshes) {
      const key = mesh.userData.__velocityKey as string;
      live.add(key);
      const stored = previousMatrices.get(key);
      if (stored) stored.copy(mesh.matrixWorld);
      else previousMatrices.set(key, mesh.matrixWorld.clone());
    }
    for (const im of instancedMeshes) {
      const key = im.userData.__velocityKey as string;
      live.add(key);
      const stored = previousMatrices.get(key);
      if (stored) stored.copy(im.matrixWorld);
      else previousMatrices.set(key, im.matrixWorld.clone());
    }
    for (const p of [...particlePoints, ...genericPoints]) {
      const key = p.userData.__velocityKey as string;
      live.add(key);
      const stored = previousMatrices.get(key);
      if (stored) stored.copy(p.matrixWorld);
      else previousMatrices.set(key, p.matrixWorld.clone());
    }

    // Drop instances that left the scene, so a graph edit that halves an
    // Array's count doesn't leave the other half's matrices in memory for
    // the rest of the session.
    if (previousMatrices.size > live.size) {
      for (const key of previousMatrices.keys()) {
        if (!live.has(key)) previousMatrices.delete(key);
      }
    }
    previousViewProjection.copy(currentViewProjection);
    hasPreviousFrame = true;
  }

  return {
    pass,
    renderVelocity,
    setIntensity: (amount: number) => {
      pass.uniforms.intensity.value = Math.max(0, amount) * SHUTTER_SCALE;
    },
    setSize: (nextWidth: number, nextHeight: number) => {
      velocityTarget.setSize(Math.max(1, nextWidth), Math.max(1, nextHeight));
    },
    dispose: () => {
      previousMatrices.clear();
      velocityTarget.dispose();
      velocityMaterial.dispose();
      instancedVelocityMaterial.dispose();
      particleVelocityMaterial.dispose();
      pointsVelocityMaterial.dispose();
      pass.dispose();
    },
  };
}
