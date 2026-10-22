import * as THREE from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { composeNativeMatrix } from "./transform";
import { COMMON_PRIMITIVE_OUTPUTS, primitiveOutputs } from "./object";

interface PlyState {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  hasVertexColor: boolean;
  lastPath?: string;
  /**
   * Real-world point clouds (LiDAR, photogrammetry) are routinely exported
   * in absolute survey coordinates — UTM eastings/northings in the hundreds
   * of thousands or millions — which sit nowhere near the scene origin the
   * camera starts framed on. Loaded that way, the cloud IS there, just far
   * outside the frustum: "viewport empty" even though nothing failed.
   * `rawCentroid` is the parsed geometry's own bounding-box center, captured
   * once at parse time so evaluate() can shift positions to/from the origin
   * as the Auto-Center toggle changes without re-parsing the file.
   */
  rawCentroid?: THREE.Vector3;
  centerApplied: boolean;
}

// A binary PLY's position+color alone is ~15 bytes/point on disk, but each
// point costs 4 bytes/channel once decoded into a Float32Array attribute —
// a decoded position+color pair is closer to 28 bytes/point in JS/GPU
// memory, before any of the app's own per-frame overhead. Past a few
// million points that upload can exceed what an integrated/low-VRAM GPU can
// take in one `bufferData` call, which loses the WebGL context outright —
// the canvas goes solid black and stays that way, not just missing the
// cloud. Stride-subsampling down to this cap trades density for actually
// rendering; it's the same "clamp the resource, don't let it crash the tab"
// fix as the Array node's grid instance cap.
const POINT_CLOUD_CAP = 3_000_000;

/** Every `stride`-th point, keeping whichever of position/color/normal the source geometry has. */
export function decimateGeometry(geometry: THREE.BufferGeometry, cap: number): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  if (!position || position.count <= cap) return geometry;

  const stride = Math.ceil(position.count / cap);
  const keep = Math.ceil(position.count / stride);
  const out = new THREE.BufferGeometry();

  for (const name of ["position", "color", "normal"]) {
    const attr = geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!attr) continue;
    const itemSize = attr.itemSize;
    const array = new Float32Array(keep * itemSize);
    let o = 0;
    for (let i = 0; i < position.count; i += stride) {
      for (let c = 0; c < itemSize; c++) array[o++] = attr.getComponent(i, c);
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }

  console.warn(
    `PLY Point Cloud: ${position.count.toLocaleString()} points exceeds the ${cap.toLocaleString()}-point render cap — decimated to ${keep.toLocaleString()} (every ${stride}th point) to avoid losing the WebGL context.`,
  );
  return out;
}

const plyStateCache = createNodeCache<PlyState>((s) => {
  s.points.geometry.dispose();
  s.material.dispose();
});

function getOrCreatePlyState(nodeId: string): PlyState {
  const existing = plyStateCache.get(nodeId);
  if (existing) return existing;
  const material = new THREE.PointsMaterial({ size: 0.02, vertexColors: false, sizeAttenuation: true });
  const points = new THREE.Points(new THREE.BufferGeometry(), material);
  points.userData.nodeId = nodeId;
  const state: PlyState = { points, material, hasVertexColor: false, centerApplied: false };
  plyStateCache.set(nodeId, state);
  return state;
}

/**
 * PLY Point Cloud node — imports large colored point clouds (LiDAR scans,
 * photogrammetry exports, ...) via PLYLoader straight into a single
 * `THREE.Points` draw call. Unlike the .xyz-based Point Cloud node (see
 * chart.ts), this never round-trips through per-point JS arrays/Color
 * objects: PLYLoader.parse hands back a BufferGeometry with position/color
 * already as typed arrays, which is what keeps a multi-million-point binary
 * PLY (the common case for anything tens of MB+) from stalling the tab on
 * import. ASCII PLY parses too, just slower — same tradeoff binary vs. text
 * point-cloud formats always have.
 */
export const OBJECT_PLY_NODE: NodeDefinition = {
  type: "object/ply_point_cloud",
  label: "PLY Point Cloud",
  category: "object",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "pointSize", label: "Point Size", type: "value" },
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    filePath: "",
    pointSize: 0.02,
    color: new THREE.Color(0x38bdf8),
    autoCenter: 1,
  },
  dynamicParamFields: () => [
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
    {
      id: "filePath",
      label: "Point Cloud (.ply)",
      kind: "file",
      accept: [".ply"],
      onLoaded: (nodeId, path, content) => {
        const state = getOrCreatePlyState(nodeId);
        state.lastPath = path;
        if (!path) {
          state.points.geometry.dispose();
          state.points.geometry = new THREE.BufferGeometry();
          state.hasVertexColor = false;
          state.material.vertexColors = false;
          state.material.needsUpdate = true;
          return;
        }

        try {
          const loader = new PLYLoader();
          // PLYLoader.parse takes ArrayBuffer (binary or ASCII — format is
          // sniffed from the header either way) or a plain string; the file
          // picker always hands .ply through as bytes (see the binary-
          // extension lists in ParamPanel.tsx / rehydrateFiles.ts), so this
          // only ever needs the ArrayBuffer branch, kept generic for safety.
          const data =
            content instanceof Uint8Array
              ? content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength)
              : content;
          const parsed = loader.parse(data);
          const geometry = decimateGeometry(parsed, POINT_CLOUD_CAP);
          if (geometry !== parsed) parsed.dispose();
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();

          state.points.geometry.dispose();
          state.points.geometry = geometry;
          state.hasVertexColor = geometry.hasAttribute("color");
          state.material.vertexColors = state.hasVertexColor;
          // PointsMaterial multiplies vertex colors BY material.color — it's
          // not just a fallback for when there's no per-vertex color, it's
          // always in the mix. Left at whatever the "no vertex colors, use
          // Fallback Color" branch below last set it to (e.g. the default
          // param's light blue, 0x38bdf8), every real per-vertex color gets
          // tinted through that: a low red/high blue-green multiplier reads
          // exactly as "everything is green/blue". White is the
          // multiplicative identity — only meaningful with vertexColors on.
          if (state.hasVertexColor) state.material.color.set(0xffffff);
          state.material.needsUpdate = true;
          state.rawCentroid = geometry.boundingBox?.getCenter(new THREE.Vector3());
          // Freshly parsed positions are never centered yet, regardless of
          // what the last file had — evaluate() applies the shift itself.
          state.centerApplied = false;
        } catch (err) {
          console.error("Failed to parse PLY file content:", err);
        }
      },
    },
    { id: "pointSize", label: "Point Size", kind: "number", step: 0.005 },
    { id: "color", label: "Fallback Color (no vertex colors in file)", kind: "color" },
    {
      id: "autoCenter",
      label: "Auto-Center (recenters raw survey/scan coordinates on origin)",
      kind: "boolean",
      group: "Transform",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getOrCreatePlyState(ctx.nodeId);
    // The Visible field existed but nothing read it: hiding the cloud lets it
    // stay a pure source (Vertices to Points) while something else draws it.
    state.points.visible = inputs.visible !== undefined ? toBoolean(inputs.visible) : toBoolean(params.visible ?? 1);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.points.matrixAutoUpdate = false;
      state.points.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const pointSize = Math.max(0.001, inputs.pointSize !== undefined ? Number(inputs.pointSize) : (Number(params.pointSize) || 0.02));
    state.material.size = pointSize;

    const wantCenter = params.autoCenter !== undefined ? Boolean(params.autoCenter) : true;
    if (wantCenter !== state.centerApplied && state.rawCentroid && (state.rawCentroid.x || state.rawCentroid.y || state.rawCentroid.z)) {
      const position = state.points.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (position) {
        const shift = wantCenter ? state.rawCentroid.clone().negate() : state.rawCentroid;
        const v = new THREE.Vector3();
        for (let i = 0; i < position.count; i++) {
          v.fromBufferAttribute(position, i).add(shift);
          position.setXYZ(i, v.x, v.y, v.z);
        }
        position.needsUpdate = true;
        state.points.geometry.computeBoundingSphere();
        state.centerApplied = wantCenter;
      }
    }

    if (!state.hasVertexColor) {
      const color = params.color instanceof THREE.Color ? params.color : new THREE.Color(0x38bdf8);
      if (!state.material.color.equals(color)) state.material.color.copy(color);
    }

    return primitiveOutputs(state.points);
  },
};
