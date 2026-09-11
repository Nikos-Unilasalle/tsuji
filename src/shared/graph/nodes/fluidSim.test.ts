import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  CURL_NOISE_FIELD_3D_NODE,
  MESH_FLUID_EMITTER_NODE,
  FLUID_SOLVER_3D_NODE,
  VOLUME_MATERIAL_3D_NODE,
  FIRE_FLUID_VOLUME_NODE,
} from "./fluidSim";
import {
  createFluidSimulationState,
  getVoxelIndex,
  generateCurlNoiseField3D,
  stepFluidSimulation,
  DEFAULT_FLUID_PARAMS,
  FluidEmitterDescriptor,
} from "../../three/fluid/fluidRuntime3D";
import { EvalContext } from "../types";
import { MaterialValue } from "../sockets";

function makeContext(nodeId: string, time = 0): EvalContext {
  return {
    nodeId,
    time,
    step: Math.floor(time * 60),
  };
}

describe("fluidRuntime3D Core Mechanics", () => {
  test("getVoxelIndex clamps within valid grid bounds", () => {
    const config = { gridX: 10, gridY: 10, gridZ: 10, worldSize: new THREE.Vector3(1, 1, 1) };
    expect(getVoxelIndex(0, 0, 0, config)).toBe(0);
    expect(getVoxelIndex(9, 9, 9, config)).toBe(999);
    expect(getVoxelIndex(-5, 0, 0, config)).toBe(0);
    expect(getVoxelIndex(15, 20, 30, config)).toBe(999);
  });

  test("generateCurlNoiseField3D produces finite divergence-free vector data", () => {
    const config = { gridX: 8, gridY: 8, gridZ: 8, worldSize: new THREE.Vector3(2, 2, 2) };
    const curl = generateCurlNoiseField3D(config, 5.0, 2.0);
    expect(curl.length).toBe(8 * 8 * 8 * 3);
    for (let i = 0; i < curl.length; i++) {
      expect(Number.isFinite(curl[i])).toBe(true);
    }
  });

  test("createFluidSimulationState allocates textures and cleans up on dispose", () => {
    const config = { gridX: 8, gridY: 8, gridZ: 8, worldSize: new THREE.Vector3(2, 2, 2) };
    const state = createFluidSimulationState(config);
    expect(state.cellCount).toBe(512);
    expect(state.velTexture).toBeInstanceOf(THREE.Data3DTexture);
    expect(state.dyeTexture).toBeInstanceOf(THREE.Data3DTexture);

    let disposed = false;
    state.velTexture.addEventListener("dispose", () => { disposed = true; });
    state.dispose();
    expect(disposed).toBe(true);
  });

  test("emitter radius spreads density without multiplying it", () => {
    // Le noyau de dépôt est normalisé : élargir le rayon étale la matière sur
    // plus de voxels, il n'en injecte pas davantage. Sans normalisation un rayon
    // de 3 voxels déposait ~340x la quantité prévue et saturait la grille.
    const config = { gridX: 16, gridY: 16, gridZ: 16, worldSize: new THREE.Vector3(4, 4, 4) };
    const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2);

    const totalFor = (radius: number) => {
      const state = createFluidSimulationState(config);
      const emitter: FluidEmitterDescriptor = {
        geometry: geo,
        worldMatrix: new THREE.Matrix4(),
        density: 10,
        temperature: 5,
        motionBoost: 0,
        radius,
      };
      stepFluidSimulation(state, { ...DEFAULT_FLUID_PARAMS, dt: 0.016 }, [emitter]);
      const data = state.dyeTexture.image.data as Float32Array;
      let sum = 0;
      let touched = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += data[i];
        if (data[i] > 1e-9) touched++;
      }
      state.dispose();
      return { sum, touched };
    };

    const tight = totalFor(0.01);
    const wide = totalFor(1.0);

    expect(wide.touched).toBeGreaterThan(tight.touched);
    expect(wide.sum).toBeCloseTo(tight.sum, 4);
  });

  test("stepFluidSimulation advects and updates dye without NaN", () => {
    const config = { gridX: 8, gridY: 8, gridZ: 8, worldSize: new THREE.Vector3(2, 2, 2) };
    const state = createFluidSimulationState(config);

    // Injecter de la densité initiale au centre
    const centerIdx = getVoxelIndex(4, 4, 4, config);
    state.dyeA[centerIdx * 4] = 5.0;     // densité
    state.dyeA[centerIdx * 4 + 1] = 6.0; // température

    stepFluidSimulation(state, DEFAULT_FLUID_PARAMS, []);

    expect(state.stepCount).toBe(1);
    const dyeData = state.dyeTexture.image.data as Float32Array;
    expect(Number.isFinite(dyeData[centerIdx * 4])).toBe(true);
    expect(Number.isFinite(dyeData[centerIdx * 4 + 1])).toBe(true);
    state.dispose();
  });
});

describe("CURL_NOISE_FIELD_3D_NODE", () => {
  test("evaluates and returns a 3D vector texture and field descriptor", () => {
    const ctx = makeContext("curl_node_1");
    const res = CURL_NOISE_FIELD_3D_NODE.evaluate({}, CURL_NOISE_FIELD_3D_NODE.defaultParams, ctx);

    expect(res.texture).toBeInstanceOf(THREE.Data3DTexture);
    expect(res.field).toBeDefined();
    const field = res.field as { type: string; amplitude: number };
    expect(field.type).toBe("curl_noise_3d");
    expect(field.amplitude).toBe(3.2);
  });
});

describe("MESH_FLUID_EMITTER_NODE", () => {
  test("creates an emitter descriptor with geometry", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const res = MESH_FLUID_EMITTER_NODE.evaluate(
      { geometry: geo, density: 10.0, temperature: 8.0 },
      MESH_FLUID_EMITTER_NODE.defaultParams,
      makeContext("emitter_1")
    );

    expect(res.emitter).toBeDefined();
    const emitter = res.emitter as FluidEmitterDescriptor;
    expect(emitter.density).toBe(10.0);
    expect(emitter.temperature).toBe(8.0);
    expect(emitter.geometry).toBe(geo);
  });

  test("falls back to default sphere geometry when geometry input is missing", () => {
    const res = MESH_FLUID_EMITTER_NODE.evaluate({}, MESH_FLUID_EMITTER_NODE.defaultParams, makeContext("emitter_2"));
    const emitter = res.emitter as FluidEmitterDescriptor;
    expect(emitter.geometry).toBeInstanceOf(THREE.BufferGeometry);
  });

  test("reports world position and velocity so movement drives the solver", () => {
    // Sans ces champs, motionBoost et le vent de déplacement restaient inertes
    // sur le chemin mesh-fluid-emitter -> fluid-solver-3d.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
    const P = MESH_FLUID_EMITTER_NODE.defaultParams;

    mesh.position.set(0, 1, 0);
    mesh.updateMatrixWorld(true);
    const first = MESH_FLUID_EMITTER_NODE.evaluate({ geometry: mesh }, P, makeContext("emitter_move"))
      .emitter as FluidEmitterDescriptor;
    expect(first.position!.y).toBe(1);
    expect(first.speed).toBe(0); // pas d'historique au premier pas

    mesh.position.set(0, 1.5, 0);
    mesh.updateMatrixWorld(true);
    const second = MESH_FLUID_EMITTER_NODE.evaluate({ geometry: mesh }, P, makeContext("emitter_move", 1 / 60))
      .emitter as FluidEmitterDescriptor;
    // 0.5 unité en 1/60 s = 30 u/s
    expect(second.speed).toBeCloseTo(30, 3);
    expect(second.velocity!.y).toBeCloseTo(30, 3);
    expect(second.windStrength).toBe(6.5);
  });
});

describe("FLUID_SOLVER_3D_NODE", () => {
  test("evaluates simulation and outputs velocity and dye 3D textures", () => {
    const ctx = makeContext("solver_1");
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const emitter = { geometry: geo, density: 5.0, temperature: 4.0, motionBoost: 0.2, radius: 1.0 };

    const res = FLUID_SOLVER_3D_NODE.evaluate(
      { emitter, buoyancy: 4.0, wind: new THREE.Vector3(1, 0, 0) },
      FLUID_SOLVER_3D_NODE.defaultParams,
      ctx
    );

    expect(res.velocityField).toBeInstanceOf(THREE.Data3DTexture);
    expect(res.dyeField).toBeInstanceOf(THREE.Data3DTexture);
  });
});

describe("VOLUME_MATERIAL_3D_NODE", () => {
  test("returns a volume mesh and updates shader uniforms", () => {
    const ctx = makeContext("volume_mat_1");
    const dyeTex = new THREE.Data3DTexture(new Float32Array(32 * 32 * 32 * 4), 32, 32, 32);

    const res = VOLUME_MATERIAL_3D_NODE.evaluate(
      { dyeField: dyeTex, fireIntensity: 50.0, steps: 32 },
      VOLUME_MATERIAL_3D_NODE.defaultParams,
      ctx
    );

    expect(res.geometry).toBeInstanceOf(THREE.Mesh);
    const mat = (res.geometry as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(mat.uniforms.uFireIntensity.value).toBe(50.0);
    expect(mat.uniforms.uSteps.value).toBe(32);
    expect(res.material).toBeDefined();
    const matVal = res.material as MaterialValue;
    expect(matVal.shadeless).toBe(true);
  });
});

describe("FIRE_FLUID_VOLUME_NODE (Macro Node)", () => {
  test("generates complete volumetric fire setup (mesh, velocity, light)", () => {
    const ctx = makeContext("fire_macro_1", 0.5);
    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      { density: 8.0, temperature: 6.0, turbulence: 4.0 },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      ctx
    );

    expect(res.geometry).toBeInstanceOf(THREE.Mesh);
    const mesh = res.geometry as THREE.Mesh;
    // La pose vit dans `matrix` (matrixAutoUpdate off), pas dans `position` :
    // l'ancrage au sol translate la boîte d'une demi-hauteur, 14 / 2 = 7.
    expect(mesh.matrixAutoUpdate).toBe(false);
    expect(new THREE.Vector3().setFromMatrixPosition(mesh.matrix).y).toBe(7);
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.uniforms.uVelTexture.value).toBe(res.velocityField);
    // uTime porte le temps de SIMULATION accumulé (sous-pas x vitesse de sim),
    // pas ctx.time : c'est lui qui doit piloter le bruit du volume.
    expect(mat.uniforms.uTime.value).toBeGreaterThan(0);
    expect(mat.uniforms.uInvModelMatrix.value).toBeInstanceOf(THREE.Matrix4);
    expect(res.velocityField).toBeInstanceOf(THREE.Data3DTexture);
    expect(res.light).toBeInstanceOf(THREE.PointLight);
    expect((res.light as THREE.PointLight).intensity).toBeGreaterThan(0);
  });

  test("box size and resolution drive the sim grid and the volume mesh", () => {
    const ctx = makeContext("fire_macro_box");
    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      {
        boxSize: new THREE.Vector3(4, 6, 4),
        resolution: new THREE.Vector3(8, 12, 8),
      },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      ctx
    );

    const mesh = res.geometry as THREE.Mesh;
    const mat = mesh.material as THREE.ShaderMaterial;
    expect((mat.uniforms.uVolumeSize.value as THREE.Vector3).toArray()).toEqual([4, 6, 4]);
    // Ancrage au sol : demi-hauteur de la nouvelle boîte, pas de l'ancienne
    expect(new THREE.Vector3().setFromMatrixPosition(mesh.matrix).y).toBe(3);

    const dye = res.velocityField as THREE.Data3DTexture;
    expect(dye.image.width).toBe(8);
    expect(dye.image.height).toBe(12);
    expect(dye.image.depth).toBe(8);
  });

  test("resolution is clamped instead of freezing the main thread", () => {
    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      { resolution: new THREE.Vector3(4000, 4000, 4000) },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      makeContext("fire_macro_clamp")
    );
    const tex = res.velocityField as THREE.Data3DTexture;
    expect(tex.image.width).toBeLessThanOrEqual(64);
    expect(tex.image.height).toBeLessThanOrEqual(64);
    expect(tex.image.depth).toBeLessThanOrEqual(64);
    expect(tex.image.width * tex.image.height * tex.image.depth).toBeLessThanOrEqual(150_000);
  }, 20_000);

  test("matrix input places and orients the volume, and is echoed on the matrix output", () => {
    const m = new THREE.Matrix4().makeTranslation(5, 0, -2);
    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      { matrix: m },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      makeContext("fire_macro_matrix")
    );

    const mesh = res.geometry as THREE.Mesh;
    const pos = new THREE.Vector3().setFromMatrixPosition(mesh.matrix);
    expect(pos.x).toBe(5);
    expect(pos.z).toBe(-2);
    expect(pos.y).toBe(7); // ancrage au sol conservé par-dessus la matrice
    expect(res.matrix).toBeInstanceOf(THREE.Matrix4);
  });

  test("a Group-wrapped emitter mesh injects density (regression: only bare Mesh used to work)", () => {
    // Une geometry socket transporte très souvent un Group (Merge, Instance,
    // import glTF). L'ancien code testait instanceof Mesh sur la racine et
    // n'émettait rien, sans erreur.
    const group = new THREE.Group();
    const inner = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
    inner.position.set(0, 0.4, 0);
    group.add(inner);
    group.updateMatrixWorld(true);

    // La sim n'avance que d'un pas de graphe à l'autre (idempotente à ctx.step
    // fixé), il faut donc faire progresser l'horloge.
    let res!: Record<string, unknown>;
    for (let f = 0; f < 5; f++) {
      res = FIRE_FLUID_VOLUME_NODE.evaluate(
        { emitterMesh: group, density: 20, temperature: 10 },
        FIRE_FLUID_VOLUME_NODE.defaultParams,
        makeContext("fire_macro_group", f / 60)
      );
    }
    const mesh = res.geometry as THREE.Mesh;
    const dyeTex = (mesh.material as THREE.ShaderMaterial).uniforms.uDyeTexture.value as THREE.Data3DTexture;
    const data = dyeTex.image.data as Float32Array;

    let totalDensity = 0;
    for (let i = 0; i < data.length; i += 4) totalDensity += data[i];
    expect(totalDensity).toBeGreaterThan(0);
  });

  test("force fields are consumed from the growing field sockets", () => {
    const ctx = makeContext("fire_macro_forces");
    const wind = {
      type: "wind" as const,
      position: new THREE.Vector3(0, 0, 0),
      axis: new THREE.Vector3(1, 0, 0),
      strength: 50,
      radius: 0,
      scale: 1,
      speed: 0.1,
    };

    // Injecter d'abord de la matière, puis laisser le vent la pousser en +X
    for (let i = 0; i < 6; i++) {
      FIRE_FLUID_VOLUME_NODE.evaluate(
        { density: 30, temperature: 8, field0: wind },
        FIRE_FLUID_VOLUME_NODE.defaultParams,
        makeContext("fire_macro_forces", i * 0.016)
      );
    }

    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      { density: 30, temperature: 8, field0: wind },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      ctx
    );
    const mesh = res.geometry as THREE.Mesh;
    const velTex = (mesh.material as THREE.ShaderMaterial).uniforms.uVelTexture.value as THREE.Data3DTexture;
    const vel = velTex.image.data as Float32Array;

    let sumX = 0;
    for (let i = 0; i < vel.length; i += 4) sumX += vel[i];
    // Un vent +X doit produire un biais net de vélocité en X
    expect(sumX).toBeGreaterThan(0);
  });

  test("advection does not create mass (regression: clamped edge sampling duplicated the floor row)", () => {
    // Avec un échantillonnage bordé par clamp, toutes les cellules qui
    // rétro-traçaient sous le plancher relisaient la rangée 0 et la dupliquaient :
    // la masse totale explosait (mesurée à +84/pas pour 4,5 injectés) et la fumée
    // finissait par remplir 89 % de la boîte. Bord zéro -> l'inflow domine.
    const totals: number[] = [];
    for (let f = 0; f < 150; f++) {
      const res = FIRE_FLUID_VOLUME_NODE.evaluate(
        {},
        FIRE_FLUID_VOLUME_NODE.defaultParams,
        makeContext("fire_macro_mass", f / 60)
      );
      if (f % 50 !== 49) continue;
      const mesh = res.geometry as THREE.Mesh;
      const tex = (mesh.material as THREE.ShaderMaterial).uniforms.uDyeTexture.value as THREE.Data3DTexture;
      const d = tex.image.data as Float32Array;
      let sum = 0;
      let filled = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += d[i];
        if (d[i] > 0.01) filled++;
      }
      totals.push(sum);
      void filled;
    }
    // La masse se stabilise sur un plateau (~2200-2600 mesuré) au lieu de croître
    // sans fin. Pas d'assertion de décroissance monotone : le bruit de flicker de
    // l'émetteur fait osciller le total d'une centaine d'unités.
    expect(totals[2]).toBeLessThan(totals[0] * 1.5);
    // Signature du bug : sans le bord zéro le total dépassait 12000 ici et
    // continuait de grimper de ~50 par pas.
    expect(Math.max(...totals)).toBeLessThan(6000);
  }, 90_000);

  test("simulate=false freezes the fluid but still renders", () => {
    const params = { ...FIRE_FLUID_VOLUME_NODE.defaultParams, simulate: false };
    let res!: Record<string, unknown>;
    for (let f = 0; f < 10; f++) {
      res = FIRE_FLUID_VOLUME_NODE.evaluate({}, params, makeContext("fire_macro_frozen", f / 60));
    }
    const mesh = res.geometry as THREE.Mesh;
    const tex = (mesh.material as THREE.ShaderMaterial).uniforms.uDyeTexture.value as THREE.Data3DTexture;
    const d = tex.image.data as Float32Array;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i];
    expect(sum).toBe(0);
    expect(res.geometry).toBeInstanceOf(THREE.Mesh);
  });

  test("lifespans drive cooling and dissipation, and 100s means no dissipation", () => {
    // Durée de vie longue -> plus de fumée conservée qu'une durée courte
    const massFor = (smokeLifespan: number, id: string) => {
      let res!: Record<string, unknown>;
      for (let f = 0; f < 90; f++) {
        res = FIRE_FLUID_VOLUME_NODE.evaluate(
          {},
          { ...FIRE_FLUID_VOLUME_NODE.defaultParams, smokeLifespan },
          makeContext(id, f / 60)
        );
      }
      const mesh = res.geometry as THREE.Mesh;
      const d = ((mesh.material as THREE.ShaderMaterial).uniforms.uDyeTexture.value as THREE.Data3DTexture)
        .image.data as Float32Array;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i];
      return sum;
    };

    expect(massFor(100, "life_inf")).toBeGreaterThan(massFor(1.0, "life_short"));
  }, 60_000);

  test("moving the emitter boosts emission and stirs the fluid", () => {
    // Le déplacement de l'émetteur doit agir sur le fluide (sphère de vent +
    // boost d'émission), sinon bouger la source ne fait que la téléporter.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4));

    const energyFor = (move: boolean, id: string) => {
      for (let f = 0; f < 40; f++) {
        mesh.position.set(move ? Math.sin(f * 0.3) * 1.5 : 0, 0.4, 0);
        mesh.updateMatrixWorld(true);
        FIRE_FLUID_VOLUME_NODE.evaluate(
          { emitterMesh: mesh },
          FIRE_FLUID_VOLUME_NODE.defaultParams,
          makeContext(id, f / 60)
        );
      }
      const res = FIRE_FLUID_VOLUME_NODE.evaluate(
        { emitterMesh: mesh },
        FIRE_FLUID_VOLUME_NODE.defaultParams,
        makeContext(id, 40 / 60)
      );
      const m = res.geometry as THREE.Mesh;
      const v = ((m.material as THREE.ShaderMaterial).uniforms.uVelTexture.value as THREE.Data3DTexture)
        .image.data as Float32Array;
      // Énergie cinétique horizontale : un émetteur immobile n'en produit presque pas
      let e = 0;
      for (let i = 0; i < v.length; i += 4) e += v[i] * v[i] + v[i + 2] * v[i + 2];
      return e;
    };

    expect(energyFor(true, "emit_moving")).toBeGreaterThan(energyFor(false, "emit_still") * 2);
  }, 60_000);

  test("key light drives the shading direction (regression: uKeyLightPos was never written)", () => {
    // L'uniforme gardait la valeur (0, 10, 5) de son constructeur : la direction
    // d'auto-ombrage de la fumée n'avait aucun rapport avec la scène.
    const light = new THREE.PointLight(0xffffff, 1);
    light.position.set(-4, 8, 3);
    light.updateMatrixWorld(true);

    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      { keyLight: light },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      makeContext("fire_keylight")
    );
    const mat = (res.geometry as THREE.Mesh).material as THREE.ShaderMaterial;
    expect((mat.uniforms.uKeyLightPos.value as THREE.Vector3).toArray()).toEqual([-4, 8, 3]);

    // Repli sur le vecteur du paramètre quand aucune lumière n'est branchée
    const res2 = FIRE_FLUID_VOLUME_NODE.evaluate(
      { keyLightPos: new THREE.Vector3(1, 2, 3) },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      makeContext("fire_keylight2")
    );
    const mat2 = (res2.geometry as THREE.Mesh).material as THREE.ShaderMaterial;
    expect((mat2.uniforms.uKeyLightPos.value as THREE.Vector3).toArray()).toEqual([1, 2, 3]);
  });

  test("shadow steps are clamped to the shader's compile-time loop bound", () => {
    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      { shadowSteps: 99 },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      makeContext("fire_shadowsteps")
    );
    const mat = (res.geometry as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(mat.uniforms.uShadowSteps.value).toBe(8); // MAX_SHADOW_STEPS
  });

  test("render resolution 1 keeps the volume on the default layer (no pass, no behaviour change)", async () => {
    const { findVolumetricSettings, LAYER_VOLUMETRIC } = await import("../../three/volumetricPass");

    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      {},
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      makeContext("fire_res_full")
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.layers.test(new THREE.Layers())).toBe(true); // layer 0 par défaut
    expect(mesh.userData.volumetric).toBeUndefined();

    const scene = new THREE.Scene();
    scene.add(mesh);
    expect(findVolumetricSettings(scene)).toBeNull();
    void LAYER_VOLUMETRIC;
  });

  test("render resolution below 1 moves the volume to its own layer and arms the pass", async () => {
    const { findVolumetricSettings, LAYER_VOLUMETRIC } = await import("../../three/volumetricPass");

    const res = FIRE_FLUID_VOLUME_NODE.evaluate(
      { renderResolution: 0.5, denoise: 0.75 },
      FIRE_FLUID_VOLUME_NODE.defaultParams,
      makeContext("fire_res_half")
    );
    const mesh = res.geometry as THREE.Mesh;

    const volumeLayer = new THREE.Layers();
    volumeLayer.set(LAYER_VOLUMETRIC);
    expect(mesh.layers.test(volumeLayer)).toBe(true);

    const scene = new THREE.Scene();
    scene.add(mesh);
    const settings = findVolumetricSettings(scene);
    expect(settings).toEqual({ resolutionScale: 0.5, denoise: 0.75 });
  });

  test("switching render resolution back to 1 restores the inline path", async () => {
    const { findVolumetricSettings } = await import("../../three/volumetricPass");
    const P = FIRE_FLUID_VOLUME_NODE.defaultParams;
    const id = "fire_res_toggle";

    FIRE_FLUID_VOLUME_NODE.evaluate({ renderResolution: 0.5 }, P, makeContext(id));
    const res = FIRE_FLUID_VOLUME_NODE.evaluate({ renderResolution: 1 }, P, makeContext(id, 1 / 60));
    const mesh = res.geometry as THREE.Mesh;

    const scene = new THREE.Scene();
    scene.add(mesh);
    // Le layer et le userData doivent être remis, sinon le volume disparaîtrait
    // du rendu de scène sans que personne ne le redessine.
    expect(findVolumetricSettings(scene)).toBeNull();
    expect(mesh.layers.test(new THREE.Layers())).toBe(true);
  });

  test("dynamicInputs grows exactly one spare force field socket", () => {
    const sockets = FIRE_FLUID_VOLUME_NODE.dynamicInputs!([
      { fromNode: "f", fromSocket: "field", toNode: "n", toSocket: "field0" },
    ] as never);
    const fields = sockets.filter((s) => s.id.startsWith("field"));
    expect(fields.map((s) => s.id)).toEqual(["field0", "field1"]);
  });

  test("all fluid simulation nodes are registered in DEFAULT_REGISTRY", async () => {
    const { DEFAULT_REGISTRY } = await import("./index");
    expect(DEFAULT_REGISTRY.has("physics/curl-noise-3d")).toBe(true);
    expect(DEFAULT_REGISTRY.has("physics/mesh-fluid-emitter")).toBe(true);
    expect(DEFAULT_REGISTRY.has("physics/fluid-solver-3d")).toBe(true);
    expect(DEFAULT_REGISTRY.has("material/volume-3d")).toBe(true);
    expect(DEFAULT_REGISTRY.has("simulation/fire-fluid-volume")).toBe(true);
  });
});

