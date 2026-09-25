import * as THREE from "three";
import { DecalGeometry } from "three/examples/jsm/geometries/DecalGeometry.js";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { asVector3 } from "./transform";
import { asColor } from "./object";

/**
 * Decal — a texture projected onto whatever surface is already there, the way
 * a bullet hole or a puddle of paint is dropped onto level geometry in a game
 * engine.
 *
 * A box-shaped projector is pushed into the target; every triangle inside the
 * box is clipped to it and re-emitted as a separate little mesh that hugs the
 * surface, with UVs taken from the projector's own frame. Because it is real
 * geometry rather than a second texture blended into the target's material,
 * the target needs no spare UV channel and nothing about its material has to
 * change — and the same projector can cross several meshes at once.
 *
 * The projected mesh sits a hair above the surface it copies, which is what
 * `polygonOffset` on the material is for: at exactly equal depth the two
 * surfaces would z-fight into stripes.
 */

const DEFAULT_SIZE = new THREE.Vector3(1, 1, 1);

/**
 * The image a Decal projects when nothing is wired into its Texture input —
 * so the node shows something the moment it is dropped, the same reasoning
 * Particle Render's sprite presets follow (see particles.ts's
 * SPRITE_PATHS/getSpriteTexture). A static public/ asset, not a baked-in
 * primitive like Raccoon's geometry: a decal's whole point is projecting an
 * *arbitrary* texture, and this is only ever the placeholder before the user
 * wires or picks their own.
 */
const DEFAULT_TEXTURE_PATH = "/img/decal_default.png";
let defaultTexture: THREE.Texture | null = null;

function getDefaultTexture(): THREE.Texture | null {
  // TextureLoader reaches for document.createElementNS — same DOM guard the
  // other texture loaders carry, so evaluating headlessly (a test, the demo
  // check) degrades to an untextured decal rather than throwing.
  if (typeof document === "undefined") return null;
  if (!defaultTexture) {
    defaultTexture = new THREE.TextureLoader().load(DEFAULT_TEXTURE_PATH);
    defaultTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return defaultTexture;
}

/**
 * Whether a decal's texture has real antialiased/soft edges, needing alpha
 * *blending* rather than the alphaTest cutout alone. Unlike object.ts's own
 * `textureHasAlpha` (any pixel below full alpha counts, background included)
 * this only counts alpha strictly between 0 and 255 — a decal's fully
 * transparent surround (the overwhelming majority of most decal art) is
 * exactly what alphaTest already punches a clean hole for, so counting it
 * here would make nearly every decal PNG "need blending" and permanently
 * exclude it from three.js's transmission buffer, i.e. invisible behind any
 * glass/transmission material regardless of how opaque it actually looks.
 */
const softAlphaCache = new WeakMap<THREE.Texture, boolean>();

function textureHasSoftAlpha(tex: THREE.Texture): boolean {
  const cached = softAlphaCache.get(tex);
  if (cached !== undefined) return cached;

  let soft = false;
  const img = tex.image as unknown;
  try {
    if (img && typeof img === "object" && "data" in img) {
      const data = (img as { data: ArrayLike<number> }).data;
      if (data && typeof data.length === "number") {
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 0 && data[i] < 255) {
            soft = true;
            break;
          }
        }
      }
    } else if (typeof document !== "undefined" && img) {
      const el = img as {
        width?: number;
        height?: number;
        getContext?: (type: string, opts?: object) => { getImageData: (x: number, y: number, w: number, h: number) => { data: ArrayLike<number> } } | null;
      };
      const w = el.width || 0;
      const h = el.height || 0;
      if (w > 0 && h > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img as CanvasImageSource, 0, 0);
          const data = ctx.getImageData(0, 0, w, h).data;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0 && data[i] < 255) {
              soft = true;
              break;
            }
          }
        }
      }
    }
  } catch {
    soft = false;
  }

  softAlphaCache.set(tex, soft);
  return soft;
}

interface DecalState {
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  /** Everything the projected geometry was built from — see the rebuild guard. */
  signature?: string;
}

const decalCache = createNodeCache<DecalState>((state) => {
  disposeObject3D(state.group);
  state.material.dispose();
});

function getState(nodeId: string): DecalState {
  let state = decalCache.get(nodeId);
  if (!state) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.userData.nodeId = nodeId;
    const material = new THREE.MeshStandardMaterial({
      depthTest: true,
      // The decal is a copy of the surface it lies on, at the same depth.
      // Without an offset the two fight for every pixel; without depthWrite
      // off, overlapping decals fight each other.
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    state = { group, material };
    decalCache.set(nodeId, state);
  }
  return state;
}

/** Every mesh a projector could land on — a Group of them (an imported model) is the normal case. */
export function collectDecalTargets(object: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    // Helper geometry (a clip cap's stencil draw, a light's icon) is not
    // surface anyone means to paint on.
    if (child.userData.__clipCapHelper || child.userData.isHelper) return;
    if (child.geometry?.getAttribute("position")) meshes.push(child);
  });
  return meshes;
}

/**
 * What the projection depends on. Rebuilding a decal means re-clipping every
 * triangle of every target against six planes, so it must happen when
 * something actually moved and not once a frame.
 *
 * The targets' world matrices are part of it: a decal is glued to a surface,
 * so the projection has to be redone when that surface moves, not just when
 * the projector does.
 */
export function decalSignature(
  targets: THREE.Mesh[],
  position: THREE.Vector3,
  rotation: THREE.Vector3,
  size: THREE.Vector3,
): string {
  const targetPart = targets
    .map((mesh) => `${mesh.geometry.uuid}:${mesh.matrixWorld.elements.map((n) => n.toFixed(4)).join(",")}`)
    .join(";");
  return [
    targetPart,
    position.toArray().map((n) => n.toFixed(4)).join(","),
    rotation.toArray().map((n) => n.toFixed(4)).join(","),
    size.toArray().map((n) => n.toFixed(4)).join(","),
  ].join("|");
}

/** Decal node — projects a texture onto the surface of whatever geometry is wired in. */
export const DECAL_NODE: NodeDefinition = {
  type: "object/decal",
  label: "Decal",
  category: "material",
  inputs: [
    // Deliberately not `owns`: the surface being painted on has to keep
    // rendering. A decal adds to a scene, it does not consume its target.
    { id: "geometry", label: "Target Surface", type: "geometry" },
    { id: "texture", label: "Texture", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "color", label: "Color", type: "color" },
    { id: "opacity", label: "Opacity", type: "value" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: DEFAULT_SIZE.clone(),
    color: new THREE.Color(0xffffff),
    opacity: 1,
    roughness: 0.6,
    metalness: 0,
    alphaCutoff: 0.01,
  },
  paramFields: [
    { id: "location", label: "Projector Position", kind: "vector" },
    { id: "rotation", label: "Projector Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Projector Size", kind: "vector", step: 0.1 },
    { id: "color", label: "Color", kind: "color" },
    { id: "opacity", label: "Opacity", kind: "number", step: 0.05 },
    { id: "roughness", label: "Roughness", kind: "number", step: 0.05 },
    { id: "metalness", label: "Metalness", kind: "number", step: 0.05 },
    { id: "alphaCutoff", label: "Alpha Cutoff", kind: "number", step: 0.01 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    const group = state.group;

    const target = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!target) {
      group.clear();
      state.signature = undefined;
      return { geometry: group, matrix: new THREE.Matrix4() };
    }

    // DecalGeometry reads each target's matrixWorld, and during evaluation
    // those are whatever the last frame left — stale for anything that moved
    // this frame. `updateWorldMatrix(true, true)` (no third argument) only
    // recomputes a matrixWorld whose own `matrixWorldNeedsUpdate` flag is
    // set — never true for a mesh with matrixAutoUpdate off that writes
    // `.matrix` directly (every primitive here), so it was silently a
    // no-op: the target's matrixWorld stayed whatever the last *forced*
    // update elsewhere in the graph happened to leave it, which is why a
    // moving/rotating target only *sometimes* landed on stale data — an
    // intermittent flicker, not a constant one. `updateMatrixWorld(true)`
    // from the root forces every descendant regardless of its own dirty
    // flag; see pointsGeometry.ts/shade.ts/lattice.ts for the same fix.
    target.updateMatrixWorld(true);

    const targets = collectDecalTargets(target);

    // A wired matrix drives the projector's full pose, not just its position
    // — the projector has to move, turn and scale with whatever it's parented
    // to (typically the same transform driving the target object itself), or
    // the decal drifts and skews the moment that object rotates or scales.
    // Only extracting position here used to leave rotation/scale glued to the
    // static params no matter what was wired.
    let position: THREE.Vector3;
    let rotationVec: THREE.Vector3;
    let size: THREE.Vector3;
    if (inputs.matrix instanceof THREE.Matrix4) {
      const quat = new THREE.Quaternion();
      position = new THREE.Vector3();
      size = new THREE.Vector3();
      inputs.matrix.decompose(position, quat, size);
      const euler = new THREE.Euler().setFromQuaternion(quat);
      rotationVec = new THREE.Vector3(euler.x, euler.y, euler.z);
    } else {
      position = asVector3(params.location, new THREE.Vector3());
      rotationVec = asVector3(params.rotation, new THREE.Vector3());
      size = asVector3(params.scale, DEFAULT_SIZE);
    }
    // A zero on any axis collapses the projector to a plane and the decal to
    // nothing, with no hint as to why.
    size.set(Math.max(1e-4, size.x), Math.max(1e-4, size.y), Math.max(1e-4, size.z));

    const signature = decalSignature(targets, position, rotationVec, size);
    if (signature !== state.signature) {
      state.signature = signature;
      // The projected meshes are ours, so their geometry is ours to release;
      // the material is shared across all of them and outlives the rebuild.
      for (const child of group.children) {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      group.clear();

      const orientation = new THREE.Euler(rotationVec.x, rotationVec.y, rotationVec.z);
      for (const mesh of targets) {
        const geometry = new DecalGeometry(mesh, position, orientation, size);
        // A projector that missed this mesh entirely produces an empty
        // geometry — keeping it would mean a draw call per miss, which for a
        // model with hundreds of parts is most of them.
        if ((geometry.getAttribute("position")?.count ?? 0) === 0) {
          geometry.dispose();
          continue;
        }
        const decal = new THREE.Mesh(geometry, state.material);
        decal.userData.nodeId = ctx.nodeId;
        decal.castShadow = false;
        decal.receiveShadow = true;
        // Same depth as its target, so opaque distance-sort can flip which
        // one draws first frame to frame — fine while depthWrite is off and
        // the target draws last, but flickers the moment the target moves
        // and occasionally wins the sort instead. renderOrder pins the
        // decal after its target regardless of distance.
        decal.renderOrder = mesh.renderOrder + 1;
        // DecalGeometry emits world-space vertices, so the mesh carrying them
        // must add no transform of its own.
        decal.matrixAutoUpdate = false;
        group.add(decal);
      }
    }

    const material = state.material;
    const wiredTexture = inputs.texture instanceof THREE.Texture && inputs.texture.image ? inputs.texture : null;
    const texture = wiredTexture ?? getDefaultTexture();
    if (material.map !== texture) {
      material.map = texture;
      // Only the wired-in case needs its color space set here — the default
      // texture's is set once, at load, in getDefaultTexture.
      if (wiredTexture) wiredTexture.colorSpace = THREE.SRGBColorSpace;
      material.needsUpdate = true;
    }
    material.color.copy(asColor(inputs.color, asColor(params.color, new THREE.Color(0xffffff))));
    material.opacity = Math.max(0, Math.min(1, inputs.opacity !== undefined ? Number(inputs.opacity) : Number(params.opacity) ?? 1));
    material.roughness = Math.max(0, Math.min(1, Number(params.roughness) ?? 0.6));
    material.metalness = Math.max(0, Math.min(1, Number(params.metalness) ?? 0));
    // A decal texture is mostly empty space; without a cutoff its transparent
    // corners still write a transparent quad over whatever is behind them.
    material.alphaTest = Math.max(0, Number(params.alphaCutoff) ?? 0.01);
    // `transparent: true` unconditionally used to push every decal into
    // three.js's transparent pass — which the transmission buffer behind a
    // glass/transmission material skips entirely, so decals never showed up
    // through glass. Same rule COMMON_PRIMITIVE materials already follow
    // (see object.ts's textureHasAlpha): stay opaque, punched out by
    // alphaTest alone, unless a soft-alpha texture or a fade below full
    // opacity genuinely needs blending.
    material.transparent = material.opacity < 0.999 || (material.map ? textureHasSoftAlpha(material.map) : false);

    return { geometry: group, matrix: new THREE.Matrix4() };
  },
};
