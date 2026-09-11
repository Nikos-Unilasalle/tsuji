import * as THREE from "three";
import { Font, FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import { NodeDefinition, ParamFieldDef } from "../types";
import { toBoolean } from "../sockets";
import { defaultFont } from "../../three/fonts/helvetikerFont";
import { BUILTIN_FONTS, FONT_NAMES } from "../../three/fonts/fonts";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { asVector3, composeNativeMatrix } from "./transform";
import { createQuadBox, createQuadPlane, quadMeshToBufferGeometry } from "../quadMesh";

export function numberInput(input: unknown, param: unknown, fallback: number): number {
  const raw = input !== undefined ? input : param;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * A scalar angle socket, in the unit the panel already claims.
 *
 * Angle params marked `degrees: true` are *stored* in radians and only
 * converted for display (ParamPanel's toDisplayUnit/toStoredUnit), which is
 * right for the stored number but wrong for a wired one: a Value node
 * carries a plain unitless number, so `numberInput` handed the raw 36
 * straight through as 36 *radians* while the field beside it said "Arc
 * Angle (°)". Driving an angle from the graph therefore meant silently
 * working in a different unit than typing the same number by hand.
 *
 * So the wired value is read as degrees — matching the label — while the
 * param keeps its stored radians.
 *
 * This is deliberately only for `value`-typed angle sockets. Vector
 * `rotation` sockets stay radians: those are fed by other nodes' rotation
 * *outputs* (Rolling, Decompose Matrix, Wiggle), so the unit has to survive
 * a round trip through a wire rather than match a text field.
 *
 * It takes the whole `inputs`/`params`/`ctx` triple rather than one value on
 * purpose: the conversion may ONLY happen for a socket a wire actually
 * reaches. The evaluator fills every unconnected socket from the node's own
 * params (see evaluate.ts), so `inputs[key] !== undefined` is true either way
 * — reading it as "is this driven" converts the panel's own stored radians a
 * second time, and the field needs ~10300 to mean 180°. `connectedInputs` is
 * the only reliable test, and hiding it in here means a call site cannot get
 * it wrong.
 */
export function degreesInput(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  key: string,
  ctx: { connectedInputs?: ReadonlySet<string> },
  fallbackRadians: number,
): number {
  if (ctx.connectedInputs?.has(key)) {
    const wired = Number(inputs[key]);
    if (Number.isFinite(wired)) return wired * DEG_TO_RAD;
  }
  const stored = Number(params[key]);
  return Number.isFinite(stored) ? stored : fallbackRadians;
}

/**
 * The time a time-driven node should run on.
 *
 * A node can't just test `inputs.time !== undefined` to see whether its Time
 * socket is wired: the evaluator fills every unconnected socket with that
 * socket's default param, so an unwired Time reads as a perfectly valid 0 and
 * the node freezes at the first frame forever. `connectedInputs` is the only
 * thing that actually knows, which is why it exists (see EvalContext).
 *
 * Wired: use the incoming value, so a Time Remap or a scrubbed clock drives the
 * node. Unwired: fall back to the graph's own clock, so the node animates out
 * of the box instead of standing still.
 */
export function clockInput(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: { time?: number; connectedInputs?: ReadonlySet<string> },
  socketId = "time",
): number {
  if (ctx.connectedInputs ? ctx.connectedInputs.has(socketId) : inputs[socketId] !== undefined) {
    return numberInput(inputs[socketId], params[socketId], 0);
  }
  const clock = Number(ctx.time);
  return Number.isFinite(clock) ? clock : 0;
}

export function asColor(v: unknown, fallback = new THREE.Color(0xffffff)): THREE.Color {
  if (v instanceof THREE.Color) return v;
  if (typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v) {
    const { r, g, b } = v as { r: number; g: number; b: number };
    return new THREE.Color(r, g, b);
  }
  if (typeof v === "string" || typeof v === "number") {
    try {
      return new THREE.Color(v as any);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

interface PrimitiveTextureState {
  textureMap?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  lastTexturePath?: string;
  lastNormalPath?: string;
  lastRoughnessPath?: string;
}

const primitiveTextureCache = createNodeCache<PrimitiveTextureState>();

function getOrCreatePrimitiveTextureState(nodeId: string): PrimitiveTextureState {
  let state = primitiveTextureCache.get(nodeId);
  if (!state) {
    state = {};
    primitiveTextureCache.set(nodeId, state);
  }
  return state;
}

export interface TextureParams {
  activeDiffuse: THREE.Texture | null;
  activeNormal: THREE.Texture | null;
  activeRoughness: THREE.Texture | null;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Whether a diffuse texture actually carries transparent pixels. A material
 * must be `transparent` for PNG alpha to show, but marking it so for *every*
 * textured material would push those objects into three.js's transparent pass —
 * and the transmission buffer only renders opaque objects, so textured objects
 * would silently vanish behind glass. The check is one-time per texture.
 */
const textureAlphaCache = new WeakMap<THREE.Texture, boolean>();

function textureHasAlpha(tex: THREE.Texture): boolean {
  const cached = textureAlphaCache.get(tex);
  if (cached !== undefined) return cached;

  let hasAlpha = false;
  const img = tex.image as unknown;
  try {
    if (img && typeof img === "object" && "data" in img) {
      const data = (img as { data: ArrayLike<number> }).data;
      if (data && typeof data.length === "number") {
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 255) {
            hasAlpha = true;
            break;
          }
        }
      }
    } else if (typeof document !== "undefined" && img) {
      const el = img as {
        width?: number;
        height?: number;
        videoWidth?: number;
        videoHeight?: number;
        getContext?: (type: string, opts?: object) => { getImageData: (x: number, y: number, w: number, h: number) => { data: ArrayLike<number> } } | null;
      };
      const w = el.width || el.videoWidth || 0;
      const h = el.height || el.videoHeight || 0;
      if (w > 0 && h > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img as CanvasImageSource, 0, 0);
          const data = ctx.getImageData(0, 0, w, h).data;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 255) {
              hasAlpha = true;
              break;
            }
          }
        }
      }
    }
  } catch {
    hasAlpha = false;
  }

  textureAlphaCache.set(tex, hasAlpha);
  return hasAlpha;
}

/** `prefix` + `key` with the first letter of key capitalised — "surface" + "color" → "surfaceColor". */
export function prefixedParamKey(prefix: string, key: string): string {
  return prefix ? `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}` : key;
}

export function extractTextureParams(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  nodeId: string,
  prefix = ""
): TextureParams {
  const state = getOrCreatePrimitiveTextureState(nodeId);
  const p = (key: string) => prefixedParamKey(prefix, key);

  const texPath = typeof params[p("texturePath")] === "string" ? (params[p("texturePath")] as string) : "";
  if (!texPath && state.textureMap) {
    state.textureMap.dispose();
    state.textureMap = undefined;
    state.lastTexturePath = "";
  }
  const normPath = typeof params[p("normalMapPath")] === "string" ? (params[p("normalMapPath")] as string) : "";
  if (!normPath && state.normalMap) {
    state.normalMap.dispose();
    state.normalMap = undefined;
    state.lastNormalPath = "";
  }
  const roughPath = typeof params[p("roughnessMapPath")] === "string" ? (params[p("roughnessMapPath")] as string) : "";
  if (!roughPath && state.roughnessMap) {
    state.roughnessMap.dispose();
    state.roughnessMap = undefined;
    state.lastRoughnessPath = "";
  }

  const diffuseVal = inputs[p("texture")];
  const normalVal = inputs[p("normal")];
  const roughnessVal = inputs[p("roughnessMap")];
  const inputDiffuse = diffuseVal instanceof THREE.Texture && diffuseVal.image ? diffuseVal : null;
  const inputNormal = normalVal instanceof THREE.Texture && normalVal.image ? normalVal : null;
  const inputRoughness = roughnessVal instanceof THREE.Texture && roughnessVal.image ? roughnessVal : null;

  const activeDiffuse = inputDiffuse || state.textureMap || null;
  const activeNormal = inputNormal || state.normalMap || null;
  const activeRoughness = inputRoughness || state.roughnessMap || null;

  let scaleX = Number(params[p("uvScaleX")]);
  if (!Number.isFinite(scaleX)) scaleX = 1;
  let scaleY = Number(params[p("uvScaleY")]);
  if (!Number.isFinite(scaleY)) scaleY = 1;

  if (inputs[p("uvScale")] instanceof THREE.Vector3) {
    scaleX = (inputs[p("uvScale")] as THREE.Vector3).x;
    scaleY = (inputs[p("uvScale")] as THREE.Vector3).y;
  }

  let offsetX = Number(params[p("uvOffsetX")]);
  if (!Number.isFinite(offsetX)) offsetX = 0;
  let offsetY = Number(params[p("uvOffsetY")]);
  if (!Number.isFinite(offsetY)) offsetY = 0;

  if (inputs[p("uvOffset")] instanceof THREE.Vector3) {
    offsetX = (inputs[p("uvOffset")] as THREE.Vector3).x;
    offsetY = (inputs[p("uvOffset")] as THREE.Vector3).y;
  }

  return { activeDiffuse, activeNormal, activeRoughness, scaleX, scaleY, offsetX, offsetY };
}

export interface MaterialParams {
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
  shadeless: boolean;
  roughness: number;
  metalness: number;
  wireframe: boolean;
  opacity: number;
  /** 0..1 — how much light passes through the surface (0 = opaque). Upgrades the material to MeshPhysicalMaterial. */
  transmission: number;
  /** Physical-material thickness in world units — how glass-like the transmission looks. */
  thickness: number;
  /** Custom shader material, if provided by a specialized material node */
  customMaterial?: THREE.Material;
}

export function materialParamsFromValue(v: unknown): MaterialParams | null {
  if (typeof v !== "object" || v === null) return null;
  if (v instanceof THREE.Material) {
    return {
      color: new THREE.Color(0xffffff),
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 1.0,
      shadeless: false,
      roughness: 0.4,
      metalness: 0.1,
      wireframe: false,
      opacity: (v as any).opacity ?? 1.0,
      transmission: 0,
      thickness: 0.5,
      customMaterial: v,
    };
  }
  const m = v as Record<string, unknown>;
  if ("customMaterial" in m && m.customMaterial instanceof THREE.Material) {
    return {
      color: asColor(m.color, new THREE.Color(0xffffff)),
      emissive: asColor(m.emissive, new THREE.Color(0x000000)),
      emissiveIntensity: Math.max(0, numberInput(m.emissiveIntensity, undefined, 1.0)),
      shadeless: toBoolean(m.shadeless),
      roughness: numberInput(m.roughness, undefined, 0.4),
      metalness: numberInput(m.metalness, undefined, 0.1),
      wireframe: toBoolean(m.wireframe),
      opacity: Math.min(1, Math.max(0, numberInput(m.opacity, undefined, 1.0))),
      transmission: Math.min(1, Math.max(0, numberInput(m.transmission, undefined, 0))),
      thickness: Math.max(0, numberInput(m.thickness, undefined, 0.5)),
      customMaterial: m.customMaterial as THREE.Material,
    };
  }
  if (!("color" in m) && !("roughness" in m) && !("opacity" in m)) return null;
  return {
    color: asColor(m.color, new THREE.Color(0xffffff)),
    emissive: asColor(m.emissive, new THREE.Color(0x000000)),
    emissiveIntensity: Math.max(0, numberInput(m.emissiveIntensity, undefined, 1.0)),
    shadeless: toBoolean(m.shadeless),
    roughness: numberInput(m.roughness, undefined, 0.4),
    metalness: numberInput(m.metalness, undefined, 0.1),
    wireframe: toBoolean(m.wireframe),
    opacity: Math.min(1, Math.max(0, numberInput(m.opacity, undefined, 1.0))),
    transmission: Math.min(1, Math.max(0, numberInput(m.transmission, undefined, 0))),
    thickness: Math.max(0, numberInput(m.thickness, undefined, 0.5)),
  };
}

export function extractMaterialParams(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  prefix = ""
): MaterialParams {
  const p = (key: string) => prefixedParamKey(prefix, key);

  const connected = materialParamsFromValue(inputs[p("material")]);
  if (connected) return connected;

  const color = asColor(inputs[p("color")], asColor(params[p("color")], new THREE.Color(0xffffff)));
  const emissive = asColor(inputs[p("emissive")], asColor(params[p("emissive")], new THREE.Color(0x000000)));
  const emissiveIntensity = Math.max(0, numberInput(inputs[p("emissiveIntensity")], params[p("emissiveIntensity")], 1.0));
  const shadeless = toBoolean(inputs[p("shadeless")] !== undefined ? inputs[p("shadeless")] : params[p("shadeless")] ?? 0);
  const roughness = numberInput(inputs[p("roughness")], params[p("roughness")], 0.4);
  const metalness = numberInput(inputs[p("metalness")], params[p("metalness")], 0.1);
  const wireframe = toBoolean(inputs[p("wireframe")] !== undefined ? inputs[p("wireframe")] : params[p("wireframe")] ?? 0);
  const opacity = Math.min(1, Math.max(0, numberInput(inputs[p("opacity")], params[p("opacity")], 1.0)));
  const transmission = Math.min(1, Math.max(0, numberInput(inputs[p("transmission")], params[p("transmission")], 0)));
  const thickness = Math.max(0, numberInput(inputs[p("thickness")], params[p("thickness")], 0.5));

  return { color, emissive, emissiveIntensity, shadeless, roughness, metalness, wireframe, opacity, transmission, thickness };
}

/**
 * Applied-signature cache: evaluate runs every frame and would otherwise set
 * `material.needsUpdate = true` (shader recompile) and `texture.needsUpdate =
 * true` (full GPU re-upload) on every single frame — catastrophic with a big
 * texture. We only touch the material when something it depends on changed.
 */
const appliedMaterialSignatures = new WeakMap<THREE.Mesh, string>();

export function applyMaterialParams(
  mesh: THREE.Mesh,
  matParams: MaterialParams,
  defaultSide: THREE.Side = THREE.FrontSide,
  texParams?: TextureParams
) {
  if (matParams.customMaterial) {
    const customSig = "custom:" + (matParams.customMaterial as THREE.Material).uuid;
    if (appliedMaterialSignatures.get(mesh) === customSig && mesh.material === matParams.customMaterial) return;
    appliedMaterialSignatures.set(mesh, customSig);
    if (mesh.material !== matParams.customMaterial) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else if (
        mesh.material &&
        !(mesh.material as any).__isSharedCustom &&
        !(mesh.material instanceof THREE.MeshStandardMaterial) &&
        !(mesh.material instanceof THREE.MeshBasicMaterial) &&
        !(mesh.material instanceof THREE.MeshPhysicalMaterial)
      ) {
        mesh.material.dispose();
      }
      mesh.material = matParams.customMaterial;
    }
    return;
  }

  const alpha = texParams?.activeDiffuse ? textureHasAlpha(texParams.activeDiffuse) : false;
  const signature = [
    matParams.customMaterial ? (matParams.customMaterial as THREE.Material).uuid : "standard",
    matParams.color.getHex(),
    matParams.emissive.getHex(),
    matParams.emissiveIntensity,
    matParams.shadeless,
    matParams.roughness,
    matParams.metalness,
    matParams.wireframe,
    matParams.opacity,
    matParams.transmission,
    matParams.thickness,
    defaultSide,
    texParams?.activeDiffuse?.uuid ?? "",
    texParams?.activeNormal?.uuid ?? "",
    texParams?.activeRoughness?.uuid ?? "",
    texParams?.scaleX,
    texParams?.scaleY,
    texParams?.offsetX,
    texParams?.offsetY,
    alpha,
  ].join("|");

  if (appliedMaterialSignatures.get(mesh) === signature && (mesh.material as any)?.__appliedSig === signature) return;
  appliedMaterialSignatures.set(mesh, signature);

  const isTransparent = matParams.opacity < 0.999 || alpha;

  if (matParams.shadeless) {
    if (!(mesh.material instanceof THREE.MeshBasicMaterial)) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else if (mesh.material) {
        mesh.material.dispose();
      }
      mesh.material = new THREE.MeshBasicMaterial({ side: defaultSide });
    }
    const mat = mesh.material as THREE.MeshBasicMaterial;
    (mat as any).__appliedSig = signature;
    const prevMap = mat.map ?? null;
    const prevTransparent = mat.transparent;
    mat.color.copy(matParams.color);
    mat.wireframe = matParams.wireframe;
    mat.transparent = isTransparent;
    mat.opacity = matParams.opacity;
    mat.side = defaultSide;

    if (texParams?.activeDiffuse) {
      mat.map = texParams.activeDiffuse;
      mat.map.colorSpace = THREE.SRGBColorSpace;
      mat.map.wrapS = THREE.RepeatWrapping;
      mat.map.wrapT = THREE.RepeatWrapping;
      mat.map.repeat.set(texParams.scaleX, texParams.scaleY);
      mat.map.offset.set(texParams.offsetX, texParams.offsetY);
      mat.map.needsUpdate = true;
    } else {
      mat.map = null;
    }

    // needsUpdate forces a full shader recompile — only the *defines* (which
    // map slots are filled, whether it draws transparent) actually need
    // that. Plain uniform changes (color, opacity, wireframe...) already
    // reach the GPU without one; setting it unconditionally here would
    // recompile on every color drag.
    if (mat.map !== prevMap || mat.transparent !== prevTransparent) {
      mat.needsUpdate = true;
    }
  } else {
    const wantPhysical = matParams.transmission > 0;
    if (wantPhysical) {
      if (!(mesh.material instanceof THREE.MeshPhysicalMaterial)) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else if (mesh.material) {
          mesh.material.dispose();
        }
        mesh.material = new THREE.MeshPhysicalMaterial({ side: defaultSide });
      }
    } else if (mesh.material instanceof THREE.MeshPhysicalMaterial) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else if (mesh.material) {
        mesh.material.dispose();
      }
      mesh.material = new THREE.MeshStandardMaterial({ side: defaultSide });
    } else if (!(mesh.material instanceof THREE.MeshStandardMaterial)) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else if (mesh.material) {
        mesh.material.dispose();
      }
      mesh.material = new THREE.MeshStandardMaterial({ side: defaultSide });
    }
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const prevMap = mat.map ?? null;
    const prevNormalMap = mat.normalMap ?? null;
    const prevTransparent = mat.transparent;
    mat.color.copy(matParams.color);
    mat.emissive.copy(matParams.emissive);
    mat.emissiveIntensity = matParams.emissiveIntensity;
    mat.roughness = matParams.roughness;
    mat.metalness = matParams.metalness;
    mat.wireframe = matParams.wireframe;
    mat.transparent = isTransparent;
    mat.opacity = matParams.opacity;
    mat.side = defaultSide;

    if (wantPhysical) {
      const physical = mat as THREE.MeshPhysicalMaterial;
      physical.transmission = matParams.transmission;
      physical.thickness = matParams.thickness;
    }

    if (texParams?.activeDiffuse) {
      mat.map = texParams.activeDiffuse;
      mat.map.colorSpace = THREE.SRGBColorSpace;
      mat.map.wrapS = THREE.RepeatWrapping;
      mat.map.wrapT = THREE.RepeatWrapping;
      mat.map.repeat.set(texParams.scaleX, texParams.scaleY);
      mat.map.offset.set(texParams.offsetX, texParams.offsetY);
      mat.map.needsUpdate = true;
    } else {
      mat.map = null;
    }

    if (texParams?.activeNormal) {
      mat.normalMap = texParams.activeNormal;
      mat.normalMap.wrapS = THREE.RepeatWrapping;
      mat.normalMap.wrapT = THREE.RepeatWrapping;
      mat.normalMap.repeat.set(texParams.scaleX, texParams.scaleY);
      mat.normalMap.offset.set(texParams.offsetX, texParams.offsetY);
      mat.normalMap.needsUpdate = true;
    } else {
      mat.normalMap = null;
    }

    const prevRoughnessMap = mat.roughnessMap ?? null;
    if (texParams?.activeRoughness) {
      mat.roughnessMap = texParams.activeRoughness;
      mat.roughnessMap.wrapS = THREE.RepeatWrapping;
      mat.roughnessMap.wrapT = THREE.RepeatWrapping;
      mat.roughnessMap.repeat.set(texParams.scaleX, texParams.scaleY);
      mat.roughnessMap.offset.set(texParams.offsetX, texParams.offsetY);
      mat.roughnessMap.needsUpdate = true;
    } else {
      mat.roughnessMap = null;
    }

    // See the shadeless branch above: only the *defines* need a recompile.
    if (
      mat.map !== prevMap ||
      mat.normalMap !== prevNormalMap ||
      mat.roughnessMap !== prevRoughnessMap ||
      mat.transparent !== prevTransparent
    ) {
      mat.needsUpdate = true;
    }
    (mat as any).__appliedSig = signature;
  }
}

export function clearAppliedMaterialSignature(mesh: THREE.Mesh): void {
  appliedMaterialSignatures.delete(mesh);
  if (mesh.material) {
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => delete (m as any).__appliedSig);
    } else {
      delete (mesh.material as any).__appliedSig;
    }
  }
}

export const COMMON_PRIMITIVE_INPUTS = [
  { id: "visible", label: "Visible", type: "value" as const },
  { id: "texture", label: "Texture Map", type: "texture" as const },
  { id: "normal", label: "Normal Map", type: "texture" as const },
  { id: "roughnessMap", label: "Roughness Map", type: "texture" as const },
  { id: "matrix", label: "Matrix", type: "matrix" as const },
  { id: "material", label: "Material", type: "material" as const },
  { id: "uvScale", label: "UV Scale", type: "vector" as const },
  { id: "uvOffset", label: "UV Offset", type: "vector" as const },
];

export const COMMON_PRIMITIVE_OUTPUTS = [
  { id: "geometry", label: "Geometry", type: "geometry" as const },
  { id: "matrix", label: "Matrix", type: "matrix" as const },
];

/**
 * Geometry plus the object's own pose. The geometry socket carries a live
 * THREE object, and reading a position back out of it means walking a parent
 * chain whose cached `matrixWorld` is stale during evaluation — the Matrix4 is
 * the direct handle downstream nodes (Distance, Proximity, Pivot, Look At…)
 * need. It is the object's *local* pose, exactly what this node applied, not
 * its world transform: whatever an Array or Set Instance Transform does to a
 * copy of it later is not part of this node's own state.
 *
 * Cloned, so a downstream node mutating the matrix cannot move the object
 * behind its back.
 */
export function primitiveOutputs(object: THREE.Object3D, params?: Record<string, unknown>): Record<string, unknown> {
  if (params && "pivot" in params) {
    object.userData.pivot = asVector3(params.pivot, new THREE.Vector3());
  }
  if (object.matrixAutoUpdate) object.updateMatrix();
  return { geometry: object, matrix: object.matrix.clone() };
}

export const COMMON_MATERIAL_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "color", label: "Color (fallback)", kind: "color", group: "Material" },
  { id: "emissive", label: "Emissive (Glow)", kind: "color", group: "Material" },
  { id: "emissiveIntensity", label: "Emissive Intensity", kind: "number", step: 0.1, group: "Material" },
  { id: "shadeless", label: "Shadeless (Unlit)", kind: "boolean", group: "Material" },
  { id: "roughness", label: "Roughness", kind: "number", step: 0.05, group: "Material" },
  { id: "metalness", label: "Metalness", kind: "number", step: 0.05, group: "Material" },
  { id: "wireframe", label: "Wireframe", kind: "boolean", group: "Material" },
  { id: "opacity", label: "Opacity", kind: "number", step: 0.05, group: "Material" },
  { id: "transmission", label: "Transmission (Glass)", kind: "number", step: 0.05, group: "Material" },
  { id: "thickness", label: "Glass Thickness", kind: "number", step: 0.05, group: "Material" },
];

/**
 * A second, independent set of material params (for a node that needs to style
 * two objects differently, e.g. a curve and its surface): every field of
 * `COMMON_MATERIAL_PARAM_FIELDS` with a `prefix`ed id and a new group. Keys line
 * up with `extractMaterialParams(..., prefix)`.
 */
export function prefixedMaterialParamFields(prefix: string, group: string): ParamFieldDef[] {
  return COMMON_MATERIAL_PARAM_FIELDS.map((f) => ({
    ...f,
    id: prefixedParamKey(prefix, f.id),
    group,
  }));
}

/**
 * The object's own initial pose — see composeNativeMatrix in transform.ts.
 * Listed first, same convention as TRANSFORM_NODE putting location/rotation/
 * scale ahead of everything else: it's the property every other field here
 * is positioned/oriented/sized relative to.
 */
const NATIVE_TRANSFORM_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
  { id: "location", label: "Location", kind: "vector", group: "Transform" },
  { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
  { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
  { id: "showPivot", label: "Show Pivot", kind: "boolean", group: "Transform" },
  { id: "pivot", label: "Pivot Offset", kind: "vector", group: "Transform" },
  // Only meaningful with something wired into Matrix; harmless otherwise,
  // which is why they sit with the transform rather than in a mode of their
  // own. See InheritPivot in transform.ts.
  {
    id: "inheritRotation",
    label: "Inherit Rotation",
    kind: "select",
    options: ["parent", "self", "none"],
    group: "Transform",
  },
  {
    id: "inheritScale",
    label: "Inherit Scale",
    kind: "select",
    options: ["parent", "self", "none"],
    group: "Transform",
  },
];

export function buildPrimitiveDynamicParamFields(extraFields: ParamFieldDef[] = []): () => ParamFieldDef[] {
  return () => [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    ...extraFields,
    {
      id: "texturePath",
      label: "Texture Image",
      kind: "file",
      accept: [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreatePrimitiveTextureState(nodeId);
        state.lastTexturePath = path;
        try {
          const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([content]);
          const url = URL.createObjectURL(blob);
          const texture = new THREE.TextureLoader().load(
            url,
            (loadedTex) => {
              loadedTex.minFilter = THREE.LinearMipmapLinearFilter;
              loadedTex.magFilter = THREE.LinearFilter;
              loadedTex.generateMipmaps = true;
              URL.revokeObjectURL(url);
              textureAlphaCache.delete(texture);
              const mesh = meshCache.get(nodeId);
              if (mesh && mesh.material) {
                if (Array.isArray(mesh.material)) mesh.material.forEach((m) => (m.needsUpdate = true));
                else mesh.material.needsUpdate = true;
              }
            },
            undefined,
            () => URL.revokeObjectURL(url)
          );
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          state.textureMap = texture;
        } catch (err) {
          console.error("Failed to load primitive texture image:", err);
        }
      },
    },
    {
      id: "normalMapPath",
      label: "Normal Map",
      kind: "file",
      accept: [".png", ".jpg", ".jpeg", ".webp", ".bmp"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreatePrimitiveTextureState(nodeId);
        state.lastNormalPath = path;
        try {
          const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([content]);
          const url = URL.createObjectURL(blob);
          const texture = new THREE.TextureLoader().load(
            url,
            () => {
              URL.revokeObjectURL(url);
              const mesh = meshCache.get(nodeId);
              if (mesh && mesh.material) {
                if (Array.isArray(mesh.material)) mesh.material.forEach((m) => (m.needsUpdate = true));
                else mesh.material.needsUpdate = true;
              }
            },
            undefined,
            () => URL.revokeObjectURL(url)
          );
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          state.normalMap = texture;
        } catch (err) {
          console.error("Failed to load primitive normal map image:", err);
        }
      },
    },
    {
      id: "roughnessMapPath",
      label: "Roughness Map",
      kind: "file",
      accept: [".png", ".jpg", ".jpeg", ".webp", ".bmp"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreatePrimitiveTextureState(nodeId);
        state.lastRoughnessPath = path;
        try {
          const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([content]);
          const url = URL.createObjectURL(blob);
          const texture = new THREE.TextureLoader().load(
            url,
            () => {
              URL.revokeObjectURL(url);
              const mesh = meshCache.get(nodeId);
              if (mesh && mesh.material) {
                if (Array.isArray(mesh.material)) mesh.material.forEach((m) => (m.needsUpdate = true));
                else mesh.material.needsUpdate = true;
              }
            },
            undefined,
            () => URL.revokeObjectURL(url)
          );
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          state.roughnessMap = texture;
        } catch (err) {
          console.error("Failed to load primitive roughness map image:", err);
        }
      },
    },
    { id: "uvScaleX", label: "UV Scale X (Tile)", kind: "number", step: 0.1 },
    { id: "uvScaleY", label: "UV Scale Y (Tile)", kind: "number", step: 0.1 },
    { id: "uvOffsetX", label: "UV Offset X", kind: "number", step: 0.05 },
    { id: "uvOffsetY", label: "UV Offset Y", kind: "number", step: 0.05 },
    ...COMMON_MATERIAL_PARAM_FIELDS,
  ];
}

export const COMMON_DEFAULT_PARAMS = {
  visible: 1,
  location: new THREE.Vector3(0, 0, 0),
  rotation: new THREE.Vector3(0, 0, 0),
  scale: new THREE.Vector3(1, 1, 1),
  showPivot: false,
  pivot: new THREE.Vector3(0, 0, 0),
  // "parent" is plain scene-graph parenting — the behaviour before these
  // existed, so every saved scene keeps rendering identically.
  inheritRotation: "parent",
  inheritScale: "parent",
  texturePath: "",
  normalMapPath: "",
  roughnessMapPath: "",
  uvScaleX: 1,
  uvScaleY: 1,
  uvOffsetX: 0,
  uvOffsetY: 0,
  color: new THREE.Color(0xffffff),
  emissive: new THREE.Color(0x000000),
  emissiveIntensity: 1.0,
  shadeless: 0,
  roughness: 0.4,
  metalness: 0.1,
  wireframe: 0,
  opacity: 1.0,
  transmission: 0,
  thickness: 0.5,
};

/**
 * Flat primitives — Plane, Disc, Polygon — lying down rather than standing up.
 *
 * three builds every flat shape in the XY plane facing +Z (PlaneGeometry,
 * CircleGeometry, RingGeometry, ShapeGeometry all do), which in a Y-up world
 * puts a new one on its edge like a billboard. That is almost never what a
 * flat shape is for: it is a floor, a ground plate, a disc to stand things on.
 * Every demo that used one had to type the same -90 degrees by hand.
 *
 * -90 degrees about X, not +90: both lay it down, but only this direction
 * leaves the face normal pointing UP, which is what lighting and shadows
 * read. (The materials are DoubleSide so the wrong one still *renders* —
 * it just lights from underneath, which is why it went unnoticed.)
 *
 * Only new nodes are affected: a saved .tsuji stores its own rotation, so
 * existing projects keep whatever they were authored with.
 */
export const FLAT_PRIMITIVE_DEFAULT_PARAMS = {
  ...COMMON_DEFAULT_PARAMS,
  rotation: new THREE.Vector3(-Math.PI / 2, 0, 0),
};

const meshCache = createNodeCache<THREE.Mesh>(disposeObject3D);

function boxMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const geom = quadMeshToBufferGeometry(createQuadBox(1, 1, 1));
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

/** Box 3D geometry primitive with texture mapping, PBR and Shadeless material controls. */
export const OBJECT_BOX_NODE: NodeDefinition = {
  type: "object/box",
  label: "Box",
  category: "object",
  inputs: [...COMMON_PRIMITIVE_INPUTS],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: { ...COMMON_DEFAULT_PARAMS },
  paramFields: buildPrimitiveDynamicParamFields()(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(),
  evaluate: (inputs, params, ctx) => {
    const mesh = boxMesh(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};

function planeMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const geom = quadMeshToBufferGeometry(createQuadPlane(1, 1, 1, 1));
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

/**
 * The quad's outline at half-extent `h`, as a function of `p` in [0,1)
 * running counter-clockwise from the bottom-left corner.
 */
function quadPerimeterPoint(h: number, p: number): [number, number] {
  const side = Math.min(3, Math.floor(p * 4));
  const t = p * 4 - side;
  switch (side) {
    case 0: return [-h + 2 * h * t, -h];
    case 1: return [h, -h + 2 * h * t];
    case 2: return [h - 2 * h * t, h];
    default: return [-h, h - 2 * h * t];
  }
}

/**
 * A quad with a centred rectangular hole, meshed as a subdivided frame.
 *
 * ShapeGeometry triangulates a holed outline in a single pass with no grid
 * to subdivide, so building the hole that way made Segments silently do
 * nothing. Both boundaries here are centred axis-aligned squares, so the
 * frame between them maps cleanly onto a grid instead: walk `p` around the
 * perimeter and `r` outward from the inner edge to the outer one, and every
 * cell is a well-formed quad — which is what Edit Mesh Points needs to have
 * something to grab.
 */
function holedQuadGeometry(inner: number, segments: number): THREE.BufferGeometry {
  const around = 4 * segments; // `segments` cells per side
  const stride = segments + 1;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= around; i++) {
    // The seam vertex is duplicated (i === around repeats i === 0) so its U
    // can reach 1 instead of wrapping back to 0 and mirroring the texture
    // across the last column of cells.
    const p = (i % around) / around;
    const [ix, iy] = quadPerimeterPoint(inner, p);
    const [ox, oy] = quadPerimeterPoint(0.5, p);
    for (let j = 0; j <= segments; j++) {
      const r = j / segments;
      const x = ix + (ox - ix) * r;
      const y = iy + (oy - iy) * r;
      positions.push(x, y, 0);
      normals.push(0, 0, 1);
      // Planar UVs, the same mapping PlaneGeometry gives, so a texture reads
      // identically whether or not the plane has a hole punched in it.
      uvs.push(x + 0.5, y + 0.5);
    }
  }

  for (let i = 0; i < around; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

/** The quad outline with its rectangular hole, for the extruded (Depth > 0) case. */
function holedQuadShape(inner: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.5, -0.5);
  shape.lineTo(0.5, 0.5);
  shape.lineTo(-0.5, 0.5);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-inner, -inner);
  hole.lineTo(-inner, inner);
  hole.lineTo(inner, inner);
  hole.lineTo(inner, -inner);
  hole.closePath();
  shape.holes.push(hole);
  return shape;
}

const PLANE_FIELDS = [
  { id: "innerRadius", label: "Inner (Hole)", kind: "number" as const, step: 0.02 },
  { id: "segments", label: "Segments (per side)", kind: "number" as const, step: 1 },
  { id: "depth", label: "Depth / Relief", kind: "number" as const, step: 0.05 },
];

/**
 * 2D Plane primitive — a unit quad in XY, laid flat by default (see
 * FLAT_PRIMITIVE_DEFAULT_PARAMS).
 *
 * `Segments` exists for Edit Mesh Points. A plane used to be a single quad,
 * so it was technically editable and practically useless: four corners and
 * nothing in between. Raising Segments subdivides it into a grid whose
 * interior vertices are what a point edit actually has to grab. It defaults
 * to 1 rather than something higher because Edit Mesh Points stores its
 * `pointsList` by vertex index — changing the subdivision of a plane that
 * already has points edited would silently re-map every one of them.
 *
 * `Inner` cuts a rectangular hole, the flat-shape counterpart of Disc's
 * Inner Radius. It is a fraction of the quad's half-extent, so it tracks
 * Scale rather than fighting it, and it combines with Segments: the frame
 * left around the hole is meshed as a grid (see holedQuadGeometry).
 *
 * `Depth` gives the quad relief, on Disc's convention: 0 is the flat,
 * double-sided sheet, and anything above extrudes it symmetrically about
 * its own plane so raising Depth thickens the plane in place instead of
 * shifting it off its position.
 */
export const OBJECT_PLANE_NODE: NodeDefinition = {
  type: "object/plane",
  label: "Plane",
  category: "object",
  inputs: [
    ...COMMON_PRIMITIVE_INPUTS,
    { id: "innerRadius", label: "Inner (Hole)", type: "value" },
    { id: "segments", label: "Segments", type: "value" },
    { id: "depth", label: "Depth", type: "value" },
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: { ...FLAT_PRIMITIVE_DEFAULT_PARAMS, innerRadius: 0, segments: 1, depth: 0 },
  paramFields: buildPrimitiveDynamicParamFields(PLANE_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(PLANE_FIELDS),
  evaluate: (inputs, params, ctx) => {
    const mesh = planeMesh(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    // The quad spans -0.5..0.5, so a hole half-width of 0.5 would leave
    // nothing at all — hence the clamp just short of it.
    const inner = Math.max(0, Math.min(0.499, numberInput(inputs.innerRadius, params.innerRadius, 0)));
    const segments = Math.max(1, Math.min(200, Math.round(numberInput(inputs.segments, params.segments, 1))));
    const depth = Math.max(0, numberInput(inputs.depth, params.depth, 0));

    const key = `${inner}_${segments}_${depth}`;
    const cache = mesh as THREE.Mesh & { _lastPlaneKey?: string };
    if (cache._lastPlaneKey !== key) {
      cache._lastPlaneKey = key;
      mesh.geometry.dispose();
      if (depth > 0) {
        if (inner > 0) {
          // A holed outline has to go through ExtrudeGeometry's
          // triangulation, so this is the one combination Segments cannot
          // reach — there are no straight-edge curves for it to refine.
          const extrudeGeom = new THREE.ExtrudeGeometry(holedQuadShape(inner), {
            depth,
            bevelEnabled: false,
          });
          // Centre the slab on the plane's own position, matching Disc.
          extrudeGeom.translate(0, 0, -depth / 2);
          mesh.geometry = extrudeGeom;
        } else {
          mesh.geometry = new THREE.BoxGeometry(1, 1, depth, segments, segments, 1);
        }
      } else if (inner > 0) {
        mesh.geometry = holedQuadGeometry(inner, segments);
      } else {
        mesh.geometry = new THREE.PlaneGeometry(1, 1, segments, segments);
      }
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    // A flat sheet has to be visible from behind; a solid slab has a real
    // backface and shades better without one. Same split as Disc.
    const defaultSide: THREE.Side = depth > 0 ? THREE.FrontSide : THREE.DoubleSide;
    applyMaterialParams(mesh, matParams, defaultSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};

function sphereMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 32, 16),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

/** Sphere 3D geometry primitive with UV texture mapping. */
export const OBJECT_SPHERE_NODE: NodeDefinition = {
  type: "object/sphere",
  label: "Sphere",
  category: "object",
  inputs: [...COMMON_PRIMITIVE_INPUTS],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: { ...COMMON_DEFAULT_PARAMS },
  paramFields: buildPrimitiveDynamicParamFields()(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(),
  evaluate: (inputs, params, ctx) => {
    const mesh = sphereMesh(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};

function discMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 32),
    new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

/** 2D Disc / Ring / Arc / 3D Extruded geometry primitive with UV texture mapping and opacity. */
export const OBJECT_DISC_NODE: NodeDefinition = {
  type: "object/disc",
  label: "Disc",
  category: "object",
  inputs: [
    { id: "radius", label: "Radius", type: "value" },
    { id: "innerRadius", label: "Inner Radius", type: "value" },
    { id: "startAngle", label: "Start Angle", type: "value" },
    { id: "arcAngle", label: "Arc Angle", type: "value" },
    { id: "depth", label: "Depth", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    radius: 0.5,
    innerRadius: 0,
    startAngle: 0,
    arcAngle: Math.PI * 2,
    depth: 0,
    // Spread LAST, as it always was here — which is exactly why the flat
    // default has to be this one and not a leading spread: whatever comes
    // last wins, and COMMON_DEFAULT_PARAMS would put the disc back upright.
    ...FLAT_PRIMITIVE_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields([
    { id: "radius", label: "Radius", kind: "number", step: 0.05 },
    { id: "innerRadius", label: "Inner Radius (Hole)", kind: "number", step: 0.05 },
    { id: "startAngle", label: "Start Angle (°)", kind: "number", step: 1, degrees: true },
    { id: "arcAngle", label: "Arc Angle (°)", kind: "number", step: 1, degrees: true },
    { id: "depth", label: "Depth / Relief", kind: "number", step: 0.05 },
  ])(),
  dynamicParamFields: buildPrimitiveDynamicParamFields([
    { id: "radius", label: "Radius", kind: "number", step: 0.05 },
    { id: "innerRadius", label: "Inner Radius (Hole)", kind: "number", step: 0.05 },
    { id: "startAngle", label: "Start Angle (°)", kind: "number", step: 1, degrees: true },
    { id: "arcAngle", label: "Arc Angle (°)", kind: "number", step: 1, degrees: true },
    { id: "depth", label: "Depth / Relief", kind: "number", step: 0.05 },
  ]),
  evaluate: (inputs, params, ctx) => {
    const mesh = discMesh(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const radius = Math.max(0.001, numberInput(inputs.radius, params.radius, 0.5));
    const innerRadius = Math.max(0, Math.min(radius - 0.0001, numberInput(inputs.innerRadius, params.innerRadius, 0)));
    // Wired in degrees, stored in radians — see degreesInput.
    const startAngle = degreesInput(inputs, params, "startAngle", ctx, 0);
    const arcAngle = Math.max(0, Math.min(Math.PI * 2, degreesInput(inputs, params, "arcAngle", ctx, Math.PI * 2)));
    const depth = Math.max(0, numberInput(inputs.depth, params.depth, 0));

    const key = `${radius}_${innerRadius}_${startAngle}_${arcAngle}_${depth}`;
    const lastKey = (mesh as any)._lastDiscKey;

    if (lastKey !== key) {
      mesh.geometry.dispose();
      if (depth === 0) {
        if (innerRadius === 0 && startAngle === 0 && arcAngle >= Math.PI * 2 - 1e-4) {
          mesh.geometry = new THREE.CircleGeometry(radius, 64);
        } else {
          mesh.geometry = new THREE.RingGeometry(innerRadius, radius, 64, 1, startAngle, arcAngle);
        }
      } else {
        if (innerRadius === 0 && startAngle === 0 && arcAngle >= Math.PI * 2 - 1e-4) {
          const cylGeom = new THREE.CylinderGeometry(radius, radius, depth, 64);
          cylGeom.rotateX(Math.PI / 2);
          mesh.geometry = cylGeom;
        } else {
          const shape = new THREE.Shape();
          const endAngle = startAngle + arcAngle;
          const isFullCircle = arcAngle >= Math.PI * 2 - 1e-4;

          if (innerRadius === 0 && isFullCircle) {
            shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
          } else if (innerRadius > 0 && isFullCircle) {
            shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
            const holePath = new THREE.Path();
            holePath.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
            shape.holes.push(holePath);
          } else {
            shape.absarc(0, 0, radius, startAngle, endAngle, false);
            if (innerRadius > 0) {
              shape.absarc(0, 0, innerRadius, endAngle, startAngle, true);
            } else {
              shape.lineTo(0, 0);
            }
          }

          const extrudeGeom = new THREE.ExtrudeGeometry(shape, {
            depth,
            bevelEnabled: false,
            curveSegments: 64,
          });
          extrudeGeom.translate(0, 0, -depth / 2);
          mesh.geometry = extrudeGeom;
        }
      }
      (mesh as any)._lastDiscKey = key;
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    const defaultSide: THREE.Side = depth > 0 ? THREE.FrontSide : THREE.DoubleSide;
    applyMaterialParams(mesh, matParams, defaultSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};

function polygonMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

const POLYGON_FIELDS = [
  { id: "sides", label: "Sides", kind: "number" as const, step: 1 },
  { id: "radius", label: "Radius", kind: "number" as const, step: 0.05 },
  { id: "innerRadius", label: "Inner Radius (Hole)", kind: "number" as const, step: 0.05 },
  { id: "depth", label: "Depth / Relief", kind: "number" as const, step: 0.05 },
];

/**
 * Regular N-sided polygon — the third flat primitive, alongside Plane and
 * Disc, and laid flat by default like both.
 *
 * It is deliberately the Disc's construction with `sides` where the Disc
 * hard-codes 64 segments, because that is genuinely all a polygon is: three's
 * CircleGeometry and RingGeometry with a low segment count ARE regular
 * polygons, and CylinderGeometry with a low radial count IS a prism. Reusing
 * them rather than emitting vertices by hand means the hole, the extrusion
 * and the UVs all behave exactly as they already do on a Disc.
 *
 * `Radius` is the circumradius (centre to a corner), which is what those
 * built-ins use — not the inradius, the centre-to-edge distance a
 * "how wide is my hexagon" question usually means. Rotation is left to the
 * node's own Rotation: spinning a triangle to sit flat-side-down is the
 * object turning, not the shape changing.
 *
 * `Sides` is wireable, so an oscillator on it walks a shape from triangle
 * through hexagon to something indistinguishable from a circle.
 */
export const OBJECT_POLYGON_NODE: NodeDefinition = {
  type: "object/polygon",
  label: "Polygon",
  category: "object",
  inputs: [
    { id: "sides", label: "Sides", type: "value" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "innerRadius", label: "Inner Radius", type: "value" },
    { id: "depth", label: "Depth", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    sides: 6,
    radius: 0.5,
    innerRadius: 0,
    depth: 0,
    // Spread last, same reason as Disc: whatever comes last wins, and
    // COMMON_DEFAULT_PARAMS would stand the polygon back up.
    ...FLAT_PRIMITIVE_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields(POLYGON_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(POLYGON_FIELDS),
  evaluate: (inputs, params, ctx) => {
    const mesh = polygonMesh(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    // Below 3 there is no polygon at all — a wired Sides sweeping down to 0
    // would otherwise hand three a degenerate geometry.
    const sides = Math.max(3, Math.min(128, Math.round(numberInput(inputs.sides, params.sides, 6))));
    const radius = Math.max(0.001, numberInput(inputs.radius, params.radius, 0.5));
    const innerRadius = Math.max(0, Math.min(radius - 0.0001, numberInput(inputs.innerRadius, params.innerRadius, 0)));
    const depth = Math.max(0, numberInput(inputs.depth, params.depth, 0));

    const key = `${sides}_${radius}_${innerRadius}_${depth}`;
    const cache = mesh as THREE.Mesh & { _lastPolygonKey?: string };
    if (cache._lastPolygonKey !== key) {
      cache._lastPolygonKey = key;
      mesh.geometry.dispose();
      if (depth === 0) {
        mesh.geometry =
          innerRadius === 0
            ? new THREE.CircleGeometry(radius, sides)
            : new THREE.RingGeometry(innerRadius, radius, sides, 1);
      } else if (innerRadius === 0) {
        // A prism: a cylinder with `sides` radial segments, stood up the same
        // way the Disc stands its own.
        const prism = new THREE.CylinderGeometry(radius, radius, depth, sides);
        prism.rotateX(Math.PI / 2);
        mesh.geometry = prism;
      } else {
        // Extruded ring. Built from explicit corner points rather than
        // absarc, so the hole is a polygon too — an arc here would leave a
        // round hole punched through a faceted plate.
        const corners = (r: number) =>
          Array.from({ length: sides }, (_, i) => {
            const a = (i / sides) * Math.PI * 2;
            return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
          });
        const shape = new THREE.Shape(corners(radius));
        shape.holes.push(new THREE.Path(corners(innerRadius).reverse()));
        const extruded = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: sides });
        extruded.translate(0, 0, -depth / 2);
        mesh.geometry = extruded;
      }
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, depth > 0 ? THREE.FrontSide : THREE.DoubleSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};

function cylinderMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

/** 3D Cylinder geometry primitive with UV texture mapping and opacity. */
export const OBJECT_CYLINDER_NODE: NodeDefinition = {
  type: "object/cylinder",
  label: "Cylinder",
  category: "object",
  inputs: [...COMMON_PRIMITIVE_INPUTS],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: { ...COMMON_DEFAULT_PARAMS },
  paramFields: buildPrimitiveDynamicParamFields()(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(),
  evaluate: (inputs, params, ctx) => {
    const mesh = cylinderMesh(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};

function coneMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const mesh = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1, 32),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

/** 3D Cone geometry primitive with UV texture mapping and opacity. */
export const OBJECT_CONE_NODE: NodeDefinition = {
  type: "object/cone",
  label: "Cone",
  category: "object",
  inputs: [...COMMON_PRIMITIVE_INPUTS],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: { ...COMMON_DEFAULT_PARAMS },
  paramFields: buildPrimitiveDynamicParamFields()(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(),
  evaluate: (inputs, params, ctx) => {
    const mesh = coneMesh(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};

/** 3D Extruded Text Object with texture mapping and vector font glyph outlines. */
export const OBJECT_TEXT_NODE: NodeDefinition = {
  type: "object/text",
  label: "Text",
  category: "object",
  inputs: [
    { id: "text", label: "Text", type: "text" },
    { id: "fontSize", label: "Font Size", type: "value" },
    { id: "depth", label: "Depth", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    text: "tsuji",
    fontPreset: "Helvetiker",
    fontSize: 64,
    depth: 0.1,
    fontPath: "",
    ...COMMON_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields([
    { id: "text", label: "Text (fallback)", kind: "text" },
    { id: "fontPreset", label: "Font", kind: "select", options: FONT_NAMES },
    { id: "fontPath", label: "Custom Font (.json)", kind: "file", accept: [".json"], onLoaded: (nodeId, _path, content) => {
      const state = textMesh(nodeId);
      try {
        state.font = new FontLoader().parse(JSON.parse(String(content)));
      } catch (err) {
        console.error("Failed to parse font:", err);
        state.font = undefined;
      }
    } },
    { id: "fontSize", label: "Font Size (px)", kind: "number" },
    { id: "depth", label: "Depth / Relief", kind: "number", step: 0.05 },
  ])(),
  dynamicParamFields: buildPrimitiveDynamicParamFields([
    { id: "text", label: "Text (fallback)", kind: "text" },
    { id: "fontPreset", label: "Font", kind: "select", options: FONT_NAMES },
    { id: "fontPath", label: "Custom Font (.json)", kind: "file", accept: [".json"], onLoaded: (nodeId, _path, content) => {
      const state = textMesh(nodeId);
      try {
        state.font = new FontLoader().parse(JSON.parse(String(content)));
      } catch (err) {
        console.error("Failed to parse font:", err);
        state.font = undefined;
      }
    } },
    { id: "fontSize", label: "Font Size (px)", kind: "number" },
    { id: "depth", label: "Depth / Relief", kind: "number", step: 0.05 },
  ]),
  evaluate: (inputs, params, ctx) => {
    const textState = textMesh(ctx.nodeId);
    const mesh = textState.mesh;

    const textStr = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "tsuji");
    const fontSize = Math.max(8, inputs.fontSize !== undefined ? Number(inputs.fontSize) || 64 : Number(params.fontSize) || 64);
    const depth = Math.max(0.001, inputs.depth !== undefined ? Number(inputs.depth) : Number(params.depth) ?? 0.1);
    // A custom font loaded via the file field wins; otherwise the Font menu.
    const font = textState.font ?? BUILTIN_FONTS[String(params.fontPreset ?? "Helvetiker")] ?? defaultFont;

    const baseMatrix = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);

    const stateChanged =
      textState.lastText !== textStr ||
      textState.lastFontSize !== fontSize ||
      textState.lastDepth !== depth ||
      textState.lastFont !== font;

    if (stateChanged) {
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }

      const scale = fontSize * 0.015;
      const shapes = font.generateShapes(textStr || " ", scale);

      const geometry = new THREE.ExtrudeGeometry(shapes, {
        depth: depth,
        bevelEnabled: true,
        bevelThickness: Math.min(0.02, depth * 0.2),
        bevelSize: Math.min(0.01, depth * 0.1),
        bevelSegments: 3,
        curveSegments: 12,
      });

      geometry.center();
      mesh.geometry = geometry;

      textState.lastText = textStr;
      textState.lastFontSize = fontSize;
      textState.lastDepth = depth;
      textState.lastFont = font;
    }

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(baseMatrix);
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};

const textMeshCache = createNodeCache<TextMeshState>((s) => disposeObject3D(s.mesh));

interface TextMeshState {
  mesh: THREE.Mesh;
  lastText?: string;
  lastFontSize?: number;
  lastDepth?: number;
  /** The font loaded via the Font (.json) file field — undefined falls back to helvetiker. */
  font?: Font;
  /** Reference for rebuild detection: a newly loaded font object must re-extrude. */
  lastFont?: Font;
}

function textMesh(nodeId: string): TextMeshState {
  const existing = textMeshCache.get(nodeId);
  if (existing) return existing;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.3,
    metalness: 0.1,
    side: THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;

  const state: TextMeshState = { mesh };
  textMeshCache.set(nodeId, state);
  return state;
}

const ALIGNMENT_OPTIONS = ["center", "left", "right"];
const LABEL_POSITION_OPTIONS = ["above", "above_aligned", "below", "below_flat"];

interface LabelMeshState {
  mesh: THREE.Mesh;
  canvas?: HTMLCanvasElement;
  texture?: THREE.CanvasTexture;
  lastText?: string;
  aspect?: number;
}

interface BarGraphState {
  group: THREE.Group;
  unitGeometry: THREE.BoxGeometry;
  barsGroup: THREE.Group;
  labelsGroup: THREE.Group;
  labelStates: Map<number, LabelMeshState>;
}

const barGraphCache = createNodeCache<BarGraphState>((s) => {
  disposeObject3D(s.group);
  s.unitGeometry.dispose();
  s.labelStates.forEach((l) => {
    l.texture?.dispose();
    disposeObject3D(l.mesh);
  });
});

function barGraphState(nodeId: string): BarGraphState {
  const existing = barGraphCache.get(nodeId);
  if (existing) return existing;

  const group = new THREE.Group();
  group.userData.nodeId = nodeId;
  const barsGroup = new THREE.Group();
  const labelsGroup = new THREE.Group();
  group.add(barsGroup);
  group.add(labelsGroup);

  const unitGeometry = new THREE.BoxGeometry(1, 1, 1);
  unitGeometry.translate(0, 0.5, 0); // Origin at bottom center for easy scaling

  const state: BarGraphState = {
    group,
    unitGeometry,
    barsGroup,
    labelsGroup,
    labelStates: new Map(),
  };
  barGraphCache.set(nodeId, state);
  return state;
}

function getOrCreateLabelState(parentState: BarGraphState, index: number): LabelMeshState {
  let labelState = parentState.labelStates.get(index);
  if (!labelState) {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide });
    const geom = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.visible = false;
    parentState.labelsGroup.add(mesh);

    labelState = { mesh };
    parentState.labelStates.set(index, labelState);
  }
  return labelState;
}

/** 3D Bar Graph primitive with data visualization, texture mapping and material controls. */
export const OBJECT_BAR_GRAPH_NODE: NodeDefinition = {
  type: "object/bar_graph",
  label: "Bar Graph",
  category: "object",
  inputs: [
    { id: "values", label: "Values (List)", type: "list" },
    { id: "colors", label: "Colors (List)", type: "list" },
    { id: "count", label: "Bar Count", type: "value" },
    { id: "spacing", label: "Spacing", type: "value" },
    { id: "barWidth", label: "Bar Width", type: "value" },
    { id: "maxHeight", label: "Max Height", type: "value" },
    { id: "barDepth", label: "Bar Depth", type: "value" },
    { id: "showLabels", label: "Show Labels", type: "value" },
    { id: "labelPosition", label: "Label Position", type: "text" },
    { id: "labelDecimals", label: "Decimals", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    count: 5,
    spacing: 0.2,
    barWidth: 0.8,
    maxHeight: 5,
    barDepth: 0.8,
    alignment: "center",
    showLabels: 0,
    labelPosition: "above",
    labelDecimals: 1,
    ...COMMON_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields([
    { id: "count", label: "Bar Count", kind: "number", step: 1 },
    { id: "spacing", label: "Spacing", kind: "number", step: 0.05 },
    { id: "barWidth", label: "Bar Width", kind: "number", step: 0.05 },
    { id: "maxHeight", label: "Max Height", kind: "number", step: 0.5 },
    { id: "barDepth", label: "Bar Depth", kind: "number", step: 0.05 },
    { id: "alignment", label: "Alignment", kind: "select", options: ALIGNMENT_OPTIONS },
    { id: "showLabels", label: "Show Labels", kind: "boolean" },
    { id: "labelPosition", label: "Label Pos", kind: "select", options: LABEL_POSITION_OPTIONS },
    { id: "labelDecimals", label: "Decimals", kind: "number", step: 1 },
  ])(),
  dynamicParamFields: buildPrimitiveDynamicParamFields([
    { id: "count", label: "Bar Count", kind: "number", step: 1 },
    { id: "spacing", label: "Spacing", kind: "number", step: 0.05 },
    { id: "barWidth", label: "Bar Width", kind: "number", step: 0.05 },
    { id: "maxHeight", label: "Max Height", kind: "number", step: 0.5 },
    { id: "barDepth", label: "Bar Depth", kind: "number", step: 0.05 },
    { id: "alignment", label: "Alignment", kind: "select", options: ALIGNMENT_OPTIONS },
    { id: "showLabels", label: "Show Labels", kind: "boolean" },
    { id: "labelPosition", label: "Label Pos", kind: "select", options: LABEL_POSITION_OPTIONS },
    { id: "labelDecimals", label: "Decimals", kind: "number", step: 1 },
  ]),
  evaluate: (inputs, params, ctx) => {
    const state = barGraphState(ctx.nodeId);
    const group = state.group;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const rawValues = Array.isArray(inputs.values)
      ? inputs.values.map(Number)
      : typeof inputs.values === "number"
        ? [inputs.values]
        : [0.4, 0.7, 0.2, 0.9, 0.5];

    const rawColors = Array.isArray(inputs.colors)
      ? inputs.colors.map((c) => asColor(c, new THREE.Color(0xffffff)))
      : [];

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);

    const count = Math.max(1, numberInput(inputs.count, params.count, 5));
    const spacing = numberInput(inputs.spacing, params.spacing, 0.2);
    const barWidth = Math.max(0.01, numberInput(inputs.barWidth, params.barWidth, 0.8));
    const maxHeight = Math.max(0.01, numberInput(inputs.maxHeight, params.maxHeight, 5));
    const barDepth = Math.max(0.01, numberInput(inputs.barDepth, params.barDepth, 0.8));
    const alignment = String(params.alignment ?? "center");
    const showLabels = toBoolean(inputs.showLabels !== undefined ? inputs.showLabels : params.showLabels ?? 0);
    const labelPosition = String(inputs.labelPosition ?? params.labelPosition ?? "above");
    const labelDecimals = Math.max(0, Math.min(6, numberInput(inputs.labelDecimals, params.labelDecimals, 1)));

    const stepWidth = barWidth + spacing;
    const totalWidth = count * barWidth + Math.max(0, count - 1) * spacing;

    let startX = 0;
    if (alignment === "center") {
      startX = -totalWidth / 2 + barWidth / 2;
    } else if (alignment === "right") {
      startX = -totalWidth + barWidth / 2;
    } else {
      startX = barWidth / 2;
    }

    while (state.barsGroup.children.length < count) {
      const mesh = new THREE.Mesh(
        state.unitGeometry,
        matParams.shadeless
          ? new THREE.MeshBasicMaterial({ color: 0xffffff })
          : new THREE.MeshStandardMaterial({ color: 0xffffff })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state.barsGroup.add(mesh);
    }
    while (state.barsGroup.children.length > count) {
      const child = state.barsGroup.children[state.barsGroup.children.length - 1];
      state.barsGroup.remove(child);
      if (child instanceof THREE.Mesh && child.material) {
        (child.material as THREE.Material).dispose();
      }
    }

    state.labelStates.forEach((lState, idx) => {
      if (idx >= count) lState.mesh.visible = false;
    });

    const safeValues = rawValues.map((v) => (Number.isFinite(v) ? v : 0));

    for (let i = 0; i < count; i++) {
      const barMesh = state.barsGroup.children[i] as THREE.Mesh;
      const rawVal = safeValues[i % rawValues.length] ?? 0;
      const barHeight = Math.max(0.001, rawVal * maxHeight);

      const posX = startX + i * stepWidth;
      barMesh.position.set(posX, 0, 0);
      barMesh.scale.set(barWidth, barHeight, barDepth);

      let barColor = matParams.color;
      if (rawColors.length > 0) {
        barColor = rawColors[i % rawColors.length];
      }

      const singleMatParams = { ...matParams, color: barColor };
      applyMaterialParams(barMesh, singleMatParams, THREE.FrontSide, texParams);

      if (showLabels) {
        const labelState = getOrCreateLabelState(state, i);
        const labelMesh = labelState.mesh;
        labelMesh.visible = true;

        const textStr = rawVal.toFixed(labelDecimals);

        if (labelState.lastText !== textStr && typeof document !== "undefined" && document.createElement) {
          if (!labelState.canvas) labelState.canvas = document.createElement("canvas");
          const canvas = labelState.canvas;
          const ctx2d = canvas.getContext ? canvas.getContext("2d") : null;

          if (ctx2d) {
            const fontSize = 256;
            ctx2d.font = `bold ${fontSize}px sans-serif`;
            const metrics = ctx2d.measureText(textStr);
            const w = Math.max(128, Math.ceil((metrics.width || 128) + fontSize * 0.4));
            const h = Math.max(64, Math.ceil(fontSize * 1.4));
            canvas.width = w;
            canvas.height = h;

            ctx2d.font = `bold ${fontSize}px sans-serif`;
            ctx2d.fillStyle = "#ffffff";
            ctx2d.textAlign = "center";
            ctx2d.textBaseline = "middle";
            ctx2d.clearRect(0, 0, w, h);
            ctx2d.fillText(textStr, w / 2, h / 2);

            if (labelState.texture) labelState.texture.dispose();
            const tex = new THREE.CanvasTexture(canvas);
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            tex.anisotropy = 16;
            labelState.texture = tex;
            (labelMesh.material as THREE.MeshBasicMaterial).map = tex;
            (labelMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;

            labelState.aspect = w / h;
          }
          labelState.lastText = textStr;
        }

        const aspect = labelState.aspect ?? 2;
        const labelWorldHeight = 0.4;
        const labelWorldWidth = labelWorldHeight * aspect;
        labelMesh.scale.set(labelWorldWidth, labelWorldHeight, 1);

        if (labelPosition === "below") {
          labelMesh.position.set(posX, -labelGap - labelWorldHeight / 2, barDepth / 2 + 0.01);
          labelMesh.rotation.set(0, 0, 0);
        } else if (labelPosition === "below_flat") {
          labelMesh.position.set(posX, 0.01, barDepth / 2 + labelWorldWidth / 2 + labelGap);
          labelMesh.rotation.set(-Math.PI / 2, 0, 0);
        } else if (labelPosition === "above_aligned") {
          labelMesh.position.set(posX, barHeight + labelGap + labelWorldHeight / 2, 0);
          labelMesh.rotation.set(0, 0, 0);
        } else {
          labelMesh.position.set(posX, barHeight + labelGap + labelWorldHeight / 2, 0);
          labelMesh.rotation.set(0, 0, 0);
        }
      }
    }

    return primitiveOutputs(group, params);
  },
};

const labelGap = 0.2;

const emptyGroupCache = createNodeCache<THREE.Group>(disposeObject3D);

/** Empty object node — null transform anchor helper in 3D viewport, invisible in final camera render. */
export const OBJECT_EMPTY_NODE: NodeDefinition = {
  type: "object/empty",
  label: "Empty",
  category: "object",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "location", label: "Location", type: "vector" },
  ],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  },
  paramFields: [
    { id: "location", label: "Location", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector" },
  ],
  evaluate: (inputs, params, ctx) => {
    let group = emptyGroupCache.get(ctx.nodeId);
    if (!group) {
      group = new THREE.Group();

      const pickGeo = new THREE.SphereGeometry(0.5, 8, 8);
      const pickMat = new THREE.MeshBasicMaterial({ visible: false });
      const pickMesh = new THREE.Mesh(pickGeo, pickMat);
      group.add(pickMesh);

      const axes = new THREE.AxesHelper(0.8);
      axes.userData.isHelper = true;
      group.add(axes);

      const points = [
        new THREE.Vector3(-0.4, 0, 0), new THREE.Vector3(0.4, 0, 0),
        new THREE.Vector3(0, -0.4, 0), new THREE.Vector3(0, 0.4, 0),
        new THREE.Vector3(0, 0, -0.4), new THREE.Vector3(0, 0, 0.4),
      ];
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({ color: 0xffcc00, opacity: 0.9, transparent: true });
      const crosshair = new THREE.LineSegments(geom, mat);
      crosshair.userData.isHelper = true;
      group.add(crosshair);

      group.userData.nodeId = ctx.nodeId;
      group.userData.isEmpty = true;
      group.traverse((c) => {
        c.userData.nodeId = ctx.nodeId;
      });
      emptyGroupCache.set(ctx.nodeId, group);
    }

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    group.matrix.decompose(pos, quat, scl);

    return {
      geometry: group,
      matrix: group.matrix.clone(),
      location: pos,
    };
  },
};
