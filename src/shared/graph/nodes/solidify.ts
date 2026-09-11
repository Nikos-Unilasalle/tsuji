import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { clearMeshWarning, findFirstMesh, warnMeshRequired } from "../meshRequired";
import { inheritSourceMaterial, numberInput, primitiveOutputs } from "./object";
import { preserveModifierUserData } from "./transform";
import { cloneQuadMesh, computeFaceNormal, QuadMesh, quadMeshToBufferGeometry } from "../quadMesh";

export interface SolidifyOptions {
  thickness: number;
  offset?: number; // -1 (inside) to +1 (outside), default -1
  rim?: boolean; // connect boundary edges, default true
}

/**
 * Solidifies a QuadMesh by creating an offset shell and rim quads along open boundary edges.
 */
export function solidifyQuadMesh(mesh: QuadMesh, options: SolidifyOptions): QuadMesh {
  const thickness = options.thickness;
  const offset = options.offset !== undefined ? options.offset : -1.0;
  const rim = options.rim !== undefined ? Boolean(options.rim) : true;

  const V = mesh.positions.length;
  if (V === 0 || mesh.faces.length === 0 || thickness === 0) {
    return cloneQuadMesh(mesh);
  }

  // 1. Compute vertex normals by accumulating adjacent face normals
  const vertexNormals: THREE.Vector3[] = Array.from({ length: V }, () => new THREE.Vector3());
  for (const face of mesh.faces) {
    const fn = computeFaceNormal(mesh.positions, face);
    for (const vi of face) {
      if (vi >= 0 && vi < V) {
        vertexNormals[vi].add(fn);
      }
    }
  }
  for (let i = 0; i < V; i++) {
    if (vertexNormals[i].lengthSq() > 1e-6) {
      vertexNormals[i].normalize();
    } else {
      vertexNormals[i].set(0, 1, 0);
    }
  }

  // Front offset: (1 + offset) * 0.5 * thickness
  // Back offset:  (offset - 1) * 0.5 * thickness
  // e.g. offset = -1 -> front = 0, back = -thickness
  // e.g. offset =  0 -> front = +0.5 * thickness, back = -0.5 * thickness
  // e.g. offset = +1 -> front = +thickness, back = 0
  const kFront = (1.0 + offset) * 0.5 * thickness;
  const kBack = (offset - 1.0) * 0.5 * thickness;

  const positions: [number, number, number][] = [];
  // Front vertices: 0 .. V-1
  for (let i = 0; i < V; i++) {
    const p = mesh.positions[i];
    const n = vertexNormals[i];
    positions.push([p[0] + n.x * kFront, p[1] + n.y * kFront, p[2] + n.z * kFront]);
  }
  // Back vertices: V .. 2V-1
  for (let i = 0; i < V; i++) {
    const p = mesh.positions[i];
    const n = vertexNormals[i];
    positions.push([p[0] + n.x * kBack, p[1] + n.y * kBack, p[2] + n.z * kBack]);
  }

  const faces: number[][] = [];
  const faceUVs: [number, number][][] = [];

  // Front faces
  for (let f = 0; f < mesh.faces.length; f++) {
    faces.push([...mesh.faces[f]]);
    if (mesh.faceUVs && mesh.faceUVs[f]) {
      faceUVs.push(mesh.faceUVs[f].map((uv) => [uv[0], uv[1]]));
    }
  }

  // Back faces (reversed winding so normals face outward from the solid volume)
  for (let f = 0; f < mesh.faces.length; f++) {
    const origFace = mesh.faces[f];
    const reversed = origFace.slice().reverse().map((vi) => vi + V);
    faces.push(reversed);
    if (mesh.faceUVs && mesh.faceUVs[f]) {
      faceUVs.push(mesh.faceUVs[f].slice().reverse().map((uv) => [uv[0], uv[1]]));
    }
  }

  // Rim faces: connect boundary edges (edges that belong to only 1 face)
  if (rim) {
    const edgeCount = new Map<string, { u: number; v: number; count: number }>();
    for (const face of mesh.faces) {
      for (let i = 0; i < face.length; i++) {
        const u = face[i];
        const v = face[(i + 1) % face.length];
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const existing = edgeCount.get(key);
        if (existing) {
          existing.count++;
        } else {
          edgeCount.set(key, { u, v, count: 1 });
        }
      }
    }

    for (const { u, v, count } of edgeCount.values()) {
      if (count === 1) {
        // Boundary edge running u -> v in the front face. The rim quad has to
        // wind the *other* way round that edge: with the front surface facing
        // +n, the mesh interior lies to the left of u -> v, so [u, v, v+V, u+V]
        // produces a normal of (v-u) × (back-front) = -(edge × n) — pointing
        // back into the solid, i.e. a rim that is entirely backfacing and so
        // invisible under any single-sided material. Reversed, it faces out.
        faces.push([u + V, v + V, v, u]);
        faceUVs.push([
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ]);
      }
    }
  }

  return {
    positions,
    faces,
    faceUVs: faceUVs.length === faces.length ? faceUVs : undefined,
    shading: mesh.shading ?? "auto",
  };
}

/**
 * Solidifies a Three.js BufferGeometry.
 */
export function solidifyGeometry(geometry: THREE.BufferGeometry, options: SolidifyOptions): THREE.BufferGeometry {
  const thickness = options.thickness;
  const offset = options.offset !== undefined ? options.offset : -1.0;
  const rim = options.rim !== undefined ? Boolean(options.rim) : true;

  if (thickness === 0) return geometry.clone();

  // If a QuadMesh exists on userData, solidify it directly and generate BufferGeometry
  if (geometry.userData?.quadMesh) {
    const solidifiedQuad = solidifyQuadMesh(geometry.userData.quadMesh as QuadMesh, options);
    const outGeom = quadMeshToBufferGeometry(solidifiedQuad);
    outGeom.userData.quadMesh = solidifiedQuad;
    return outGeom;
  }

  // Ensure indexed geometry with merged vertices for clean boundary detection
  const indexed = geometry.index ? geometry.clone() : mergeVertices(geometry, 1e-4);
  const posAttr = indexed.getAttribute("position");
  if (!posAttr) return geometry.clone();

  const V = posAttr.count;
  const index = indexed.getIndex();
  if (!index) return geometry.clone();

  // Accumulate vertex normals from triangles
  const vertexNormals: THREE.Vector3[] = Array.from({ length: V }, () => new THREE.Vector3());
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  const triCount = index.count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);

    vA.fromBufferAttribute(posAttr, a);
    vB.fromBufferAttribute(posAttr, b);
    vC.fromBufferAttribute(posAttr, c);

    cb.subVectors(vC, vB);
    ab.subVectors(vA, vB);
    cb.cross(ab);
    if (cb.lengthSq() > 1e-8) cb.normalize();

    vertexNormals[a].add(cb);
    vertexNormals[b].add(cb);
    vertexNormals[c].add(cb);
  }

  for (let i = 0; i < V; i++) {
    if (vertexNormals[i].lengthSq() > 1e-6) {
      vertexNormals[i].normalize();
    } else {
      vertexNormals[i].set(0, 1, 0);
    }
  }

  const kFront = (1.0 + offset) * 0.5 * thickness;
  const kBack = (offset - 1.0) * 0.5 * thickness;

  const positions = new Float32Array(V * 2 * 3);
  const p = new THREE.Vector3();

  // Front positions: 0 .. V-1
  for (let i = 0; i < V; i++) {
    p.fromBufferAttribute(posAttr, i);
    const n = vertexNormals[i];
    positions[i * 3] = p.x + n.x * kFront;
    positions[i * 3 + 1] = p.y + n.y * kFront;
    positions[i * 3 + 2] = p.z + n.z * kFront;
  }
  // Back positions: V .. 2V-1
  for (let i = 0; i < V; i++) {
    p.fromBufferAttribute(posAttr, i);
    const n = vertexNormals[i];
    const bi = V + i;
    positions[bi * 3] = p.x + n.x * kBack;
    positions[bi * 3 + 1] = p.y + n.y * kBack;
    positions[bi * 3 + 2] = p.z + n.z * kBack;
  }

  const indices: number[] = [];

  // Front triangles
  for (let t = 0; t < triCount; t++) {
    indices.push(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2));
  }

  // Back triangles (reversed winding)
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3) + V;
    const b = index.getX(t * 3 + 1) + V;
    const c = index.getX(t * 3 + 2) + V;
    indices.push(c, b, a);
  }

  // Rim side walls
  if (rim) {
    const edgeMap = new Map<string, { u: number; v: number; count: number }>();
    for (let t = 0; t < triCount; t++) {
      const a = index.getX(t * 3);
      const b = index.getX(t * 3 + 1);
      const c = index.getX(t * 3 + 2);

      const edges = [
        [a, b],
        [b, c],
        [c, a],
      ];
      for (const [u, v] of edges) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          edgeMap.set(key, { u, v, count: 1 });
        }
      }
    }

    for (const { u, v, count } of edgeMap.values()) {
      if (count === 1) {
        // Boundary edge (u -> v). Same outward winding as the QuadMesh path
        // above: the quad (u+V, v+V, v, u) faces away from the solid.
        indices.push(u + V, v + V, v);
        indices.push(u + V, v, u);
      }
    }
  }

  const outGeom = new THREE.BufferGeometry();
  outGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  outGeom.setIndex(indices);

  // UV coordinates if present
  const uvAttr = indexed.getAttribute("uv");
  if (uvAttr) {
    const uvs = new Float32Array(V * 2 * 2);
    for (let i = 0; i < V; i++) {
      uvs[i * 2] = uvAttr.getX(i);
      uvs[i * 2 + 1] = uvAttr.getY(i);
      // Back vertices share original UV
      uvs[(V + i) * 2] = uvAttr.getX(i);
      uvs[(V + i) * 2 + 1] = uvAttr.getY(i);
    }
    outGeom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  }

  outGeom.computeVertexNormals();
  outGeom.computeBoundingBox();
  outGeom.computeBoundingSphere();
  return outGeom;
}

interface SolidifyState {
  mesh?: THREE.Mesh;
  lastSignature?: string;
}

const solidifyCache = createNodeCache<SolidifyState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(nodeId: string): SolidifyState {
  let state = solidifyCache.get(nodeId);
  if (!state) {
    state = {};
    solidifyCache.set(nodeId, state);
  }
  return state;
}

/**
 * Solidify Modifier Node — gives thickness to any surface or mesh.
 * Analogous to Blender's Solidify modifier.
 */
export const SOLIDIFY_NODE: NodeDefinition = {
  type: "modifier/solidify",
  label: "Solidify",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "thickness", label: "Thickness", type: "value" },
    { id: "offset", label: "Offset", type: "value" },
    { id: "rim", label: "Fill Rim", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    thickness: 0.1,
    offset: -1.0,
    rim: true,
  },
  paramFields: [
    { id: "thickness", label: "Thickness", kind: "number", step: 0.02 },
    { id: "offset", label: "Offset (-1 to 1)", kind: "number", step: 0.1 },
    { id: "rim", label: "Fill Rim", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) return { geometry: null };

    const srcMesh = findFirstMesh(inputObj);
    const srcGeom = srcMesh?.geometry;
    if (!srcMesh || !srcGeom || !srcGeom.attributes.position) {
      warnMeshRequired(ctx.nodeId, "Solidify", inputObj);
      return primitiveOutputs(inputObj);
    }
    clearMeshWarning(ctx.nodeId);

    const thickness = Math.max(0, numberInput(inputs.thickness, params.thickness, 0.1));
    const offset = Math.max(-1, Math.min(1, numberInput(inputs.offset, params.offset, -1.0)));
    const rim = inputs.rim !== undefined ? Boolean(inputs.rim) : Boolean(params.rim ?? true);

    const state = getState(ctx.nodeId);

    const signature = `${thickness}:${offset}:${rim}:${srcGeom.attributes.position.count}:${srcGeom.index?.count ?? -1}`;
    if (state.mesh && state.lastSignature === signature) {
      inputObj.updateMatrixWorld(true);
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.copy(srcMesh.matrixWorld);
      preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
      return primitiveOutputs(state.mesh);
    }

    const solidifiedGeom = solidifyGeometry(srcGeom, { thickness, offset, rim });

    if (!state.mesh) {
      state.mesh = new THREE.Mesh(solidifiedGeom);
      state.mesh.castShadow = true;
      state.mesh.receiveShadow = true;
    } else {
      state.mesh.geometry.dispose();
      state.mesh.geometry = solidifiedGeom;
    }
    inheritSourceMaterial(state.mesh, srcMesh.material);

    inputObj.updateMatrixWorld(true);
    state.mesh.matrixAutoUpdate = false;
    state.mesh.matrix.copy(srcMesh.matrixWorld);
    preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
    state.lastSignature = signature;

    return primitiveOutputs(state.mesh);
  },
};
