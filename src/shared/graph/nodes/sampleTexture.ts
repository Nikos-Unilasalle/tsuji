import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { extractPositionFromInput } from "./transform";

interface TextureSampleState {
  canvas?: HTMLCanvasElement;
  lastTexture?: THREE.Texture;
  lastVersion?: number;
  pixelData?: Uint8ClampedArray | Uint8Array | Float32Array;
  width?: number;
  height?: number;
}

const stateCache = createNodeCache<TextureSampleState>();

function getState(nodeId: string): TextureSampleState {
  let s = stateCache.get(nodeId);
  if (!s) {
    s = {};
    stateCache.set(nodeId, s);
  }
  return s;
}

function asVector3(v: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (v instanceof THREE.Vector3) return v;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const x = Number(obj.x);
    const y = Number(obj.y);
    const z = Number(obj.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return new THREE.Vector3(x, y, z);
    }
  }
  return fallback;
}

function isDrawable(v: unknown): boolean {
  return (
    (typeof HTMLCanvasElement !== "undefined" && v instanceof HTMLCanvasElement) ||
    (typeof HTMLImageElement !== "undefined" && v instanceof HTMLImageElement) ||
    (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap) ||
    (typeof HTMLVideoElement !== "undefined" && v instanceof HTMLVideoElement)
  );
}

function getPixelBuffer(state: TextureSampleState, texture: THREE.Texture): { data: Uint8ClampedArray | Uint8Array | Float32Array; width: number; height: number } | null {
  const version = texture.version ?? 0;
  if (state.lastTexture === texture && state.lastVersion === version && state.pixelData && state.width && state.height) {
    return { data: state.pixelData, width: state.width, height: state.height };
  }

  // 1. DataTexture with typed array in image.data
  const image = texture.image as any;
  if (image && image.data && image.width && image.height) {
    state.lastTexture = texture;
    state.lastVersion = version;
    state.pixelData = image.data;
    state.width = image.width;
    state.height = image.height;
    return { data: image.data, width: image.width, height: image.height };
  }

  // 2. Drawable HTML Canvas/Image in browser DOM
  if (image && isDrawable(image) && typeof document !== "undefined") {
    if (!state.canvas) {
      state.canvas = document.createElement("canvas");
    }
    const canvas = state.canvas;
    const w = Math.max(1, Math.min(2048, image.width || 256));
    const h = Math.max(1, Math.min(2048, image.height || 256));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(image, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);

    state.lastTexture = texture;
    state.lastVersion = version;
    state.pixelData = imgData.data;
    state.width = w;
    state.height = h;
    return { data: imgData.data, width: w, height: h };
  }

  return null;
}

function toTexelIndex(coord: number, size: number): number {
  if (size <= 1) return 0;
  let f = coord % 1;
  if (f < 0) f += 1;
  if (f === 0 && coord > 0) {
    f = 1.0;
  }
  const idx = Math.floor(f * size);
  return Math.min(size - 1, Math.max(0, idx));
}

/**
 * Sample Texture node — generic atomic node that samples a 2D Texture at given coordinates
 * and returns a simple normalized list of values in [0, 1] according to the selected channel.
 */
export const SAMPLE_TEXTURE_NODE: NodeDefinition = {
  type: "texture/sample",
  label: "Sample Texture",
  category: "texture",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "positions", label: "Positions", type: "list" },
    { id: "geometry", label: "Geometry (Fallback)", type: "geometry" },
    { id: "plane", label: "Plane", type: "text" },
    { id: "uvScale", label: "UV Scale", type: "vector" },
    { id: "uvOffset", label: "UV Offset", type: "vector" },
  ],
  outputs: [
    { id: "values", label: "Values", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    plane: "XZ",
    mapping: "bounds",
    worldSize: 10,
    channel: "luminance",
    uvScale: new THREE.Vector3(1, 1, 1),
    uvOffset: new THREE.Vector3(0, 0, 0),
  },
  paramFields: [
    { id: "channel", label: "Channel", kind: "select", options: ["luminance", "red", "green", "blue", "alpha"] },
    { id: "mapping", label: "UV Mapping", kind: "select", options: ["bounds", "world", "planar_xz", "planar_xy"] },
    { id: "plane", label: "Plane", kind: "select", options: ["XZ", "XY", "YZ"] },
    { id: "worldSize", label: "World Size (for World mapping)", kind: "number", step: 1 },
    { id: "uvScale", label: "UV Scale", kind: "vector" },
    { id: "uvOffset", label: "UV Offset", kind: "vector" },
  ],
  dynamicParamFields: () => [
    { id: "channel", label: "Channel", kind: "select", options: ["luminance", "red", "green", "blue", "alpha"] },
    { id: "mapping", label: "UV Mapping", kind: "select", options: ["bounds", "world", "planar_xz", "planar_xy"] },
    { id: "plane", label: "Plane", kind: "select", options: ["XZ", "XY", "YZ"] },
    { id: "worldSize", label: "World Size", kind: "number", step: 1 },
    { id: "uvScale", label: "UV Scale", kind: "vector" },
    { id: "uvOffset", label: "UV Offset", kind: "vector" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);

    // Resolve target positions to sample
    let samplePositions: THREE.Vector3[] = [];
    if (Array.isArray(inputs.positions) && inputs.positions.length > 0) {
      samplePositions = inputs.positions
        .map((p) => asVector3(p, new THREE.Vector3()))
        .filter(Boolean);
    } else if (inputs.geometry instanceof THREE.Object3D) {
      const g = inputs.geometry;
      if (g instanceof THREE.InstancedMesh) {
        const mat = new THREE.Matrix4();
        const pos = new THREE.Vector3();
        const rot = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        for (let i = 0; i < g.count; i++) {
          g.getMatrixAt(i, mat);
          mat.decompose(pos, rot, scale);
          samplePositions.push(pos.clone());
        }
      } else if (g instanceof THREE.Group && g.children.length > 0) {
        for (const child of g.children) {
          if (child instanceof THREE.InstancedMesh) {
            const mat = new THREE.Matrix4();
            const pos = new THREE.Vector3();
            const rot = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            for (let i = 0; i < child.count; i++) {
              child.getMatrixAt(i, mat);
              mat.decompose(pos, rot, scale);
              samplePositions.push(pos.clone());
            }
          } else {
            samplePositions.push(extractPositionFromInput(child, new THREE.Vector3()));
          }
        }
      } else if (g instanceof THREE.Mesh && g.geometry) {
        const posAttr = g.geometry.attributes.position;
        if (posAttr && posAttr.count > 0) {
          for (let i = 0; i < posAttr.count; i++) {
            samplePositions.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
          }
        } else {
          samplePositions.push(extractPositionFromInput(g, new THREE.Vector3()));
        }
      } else {
        samplePositions.push(extractPositionFromInput(g, new THREE.Vector3()));
      }
    }

    if (samplePositions.length === 0) {
      return { values: [], list: [], count: 0 };
    }

    const texture = inputs.texture instanceof THREE.Texture ? inputs.texture : null;
    const pixelBuf = texture ? getPixelBuffer(state, texture) : null;

    const plane = String(inputs.plane || params.plane || "XZ").toUpperCase();
    const mapping = String(params.mapping || "bounds");
    const worldSize = Math.max(0.001, Number(params.worldSize) || 10);
    const channel = String(params.channel || "luminance");

    const uvScaleVec = asVector3(inputs.uvScale ?? params.uvScale, new THREE.Vector3(1, 1, 1));
    const uvOffsetVec = asVector3(inputs.uvOffset ?? params.uvOffset, new THREE.Vector3(0, 0, 0));

    // Bounds calculation for "bounds" mapping
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;

    if (mapping === "bounds") {
      for (const p of samplePositions) {
        let uCoord = p.x;
        let vCoord = p.z;
        if (plane === "XY") {
          uCoord = p.x;
          vCoord = p.y;
        } else if (plane === "YZ") {
          uCoord = p.y;
          vCoord = p.z;
        }
        if (uCoord < minU) minU = uCoord;
        if (uCoord > maxU) maxU = uCoord;
        if (vCoord < minV) minV = vCoord;
        if (vCoord > maxV) maxV = vCoord;
      }
    }
    const spanU = Math.max(1e-6, maxU - minU);
    const spanV = Math.max(1e-6, maxV - minV);

    const values: number[] = [];

    const width = pixelBuf?.width || 1;
    const height = pixelBuf?.height || 1;
    const data = pixelBuf?.data || null;

    for (let i = 0; i < samplePositions.length; i++) {
      const p = samplePositions[i];
      let u = 0.5;
      let v = 0.5;

      if (mapping === "bounds") {
        let uCoord = p.x;
        let vCoord = p.z;
        if (plane === "XY") {
          uCoord = p.x;
          vCoord = p.y;
        } else if (plane === "YZ") {
          uCoord = p.y;
          vCoord = p.z;
        }
        u = (uCoord - minU) / spanU;
        v = (vCoord - minV) / spanV;
      } else if (mapping === "planar_xy" || plane === "XY") {
        u = p.x / worldSize + 0.5;
        v = p.y / worldSize + 0.5;
      } else if (plane === "YZ") {
        u = p.y / worldSize + 0.5;
        v = p.z / worldSize + 0.5;
      } else {
        // "world" / "planar_xz"
        u = p.x / worldSize + 0.5;
        v = p.z / worldSize + 0.5;
      }

      // Apply UV Scale & Offset
      u = (u - 0.5) * uvScaleVec.x + 0.5 + uvOffsetVec.x;
      v = (v - 0.5) * uvScaleVec.y + 0.5 + uvOffsetVec.y;

      let r = 1;
      let g = 1;
      let b = 1;
      let a = 1;

      if (data && width > 0 && height > 0) {
        const px = toTexelIndex(u, width);
        const py = toTexelIndex(v, height);
        const idx = (py * width + px) * 4;

        r = (data[idx] ?? 255) / 255;
        g = (data[idx + 1] ?? 255) / 255;
        b = (data[idx + 2] ?? 255) / 255;
        a = (data[idx + 3] ?? 255) / 255;
      }

      let sampledVal = 0.5;
      switch (channel) {
        case "red":
          sampledVal = r;
          break;
        case "green":
          sampledVal = g;
          break;
        case "blue":
          sampledVal = b;
          break;
        case "alpha":
          sampledVal = a;
          break;
        case "luminance":
        default:
          sampledVal = 0.299 * r + 0.587 * g + 0.114 * b;
          break;
      }

      // Clamp strictly to [0, 1]
      const clampedVal = Math.max(0, Math.min(1, sampledVal));
      values.push(clampedVal);
    }

    return {
      values,
      list: values,
      count: values.length,
    };
  },
};
