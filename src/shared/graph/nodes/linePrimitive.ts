import * as THREE from "three";
import type { NodeDefinition } from "../types";
import type { PolyMesh } from "../quadMesh";
import { polyMeshToGeometry } from "../mesh/polyIO";
import { setAttribute, setGroup } from "../mesh/polyAttributes";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { numberInput } from "./object";
import { asVector3, composeNativeMatrix } from "./transform";

/*
 * Line — the straight wire most parametric modelling starts from: a profile
 * to Revolve into a vase, a spine to Sweep a section along, a row of points
 * to Copy objects onto, a polyline to bend.
 *
 * One output per way it gets used, all the same line:
 *  - Geometry: a wire PolyMesh (points joined by loose edges, no faces) —
 *    Revolve, Copy to Points, Select, Displace, Attribute Expression… read it
 *    like any mesh. Its points carry `u` (0 at Start, 1 at End) and the groups
 *    `start` and `end`.
 *  - Curve: the same line as a curve, for Sweep, Follow Path, Curve Deform.
 *  - Points: its points as a list (world space), for list and instancing nodes.
 */

const lineCache = createNodeCache<THREE.Mesh>(disposeObject3D);

const LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0xe2e8f0 });

export function linePolyMesh(start: THREE.Vector3, end: THREE.Vector3, segments: number): PolyMesh {
  const n = Math.max(1, Math.min(10000, Math.round(segments)));
  const positions: [number, number, number][] = [];
  const edges: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const p = new THREE.Vector3().lerpVectors(start, end, i / n);
    positions.push([p.x, p.y, p.z]);
    if (i > 0) edges.push([i - 1, i]);
  }
  let mesh: PolyMesh = { positions, faces: [], edges };
  const u = Float64Array.from({ length: n + 1 }, (_, i) => i / n);
  mesh = setAttribute(mesh, "point", "u", "float", u);
  mesh = setGroup(mesh, "point", "start", Uint8Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 1 : 0)));
  mesh = setGroup(mesh, "point", "end", Uint8Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : 0)));
  return mesh;
}

export const LINE_NODE: NodeDefinition = {
  type: "object/line",
  label: "Line",
  category: "primitives",
  inputs: [
    { id: "start", label: "Start", type: "vector" },
    { id: "end", label: "End", type: "vector" },
    { id: "segments", label: "Segments", type: "value" },
    { id: "matrix", label: "Parent", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "curve", label: "Curve", type: "curve" },
    { id: "points", label: "Points", type: "list" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    start: new THREE.Vector3(0, 0, 0),
    end: new THREE.Vector3(0, 1, 0),
    segments: 8,
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  },
  paramFields: [
    { id: "start", label: "Start", kind: "vector", step: 0.1, group: "Line" },
    { id: "end", label: "End", kind: "vector", step: 0.1, group: "Line" },
    { id: "segments", label: "Segments", kind: "number", step: 1, group: "Line" },
    { id: "location", label: "Location", kind: "vector", step: 0.1 },
    { id: "rotation", label: "Rotation", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const start = asVector3(inputs.start ?? params.start, new THREE.Vector3(0, 0, 0));
    const end = asVector3(inputs.end ?? params.end, new THREE.Vector3(0, 1, 0));
    const segments = Math.max(1, Math.round(numberInput(inputs.segments, params.segments, 8)));
    const matrix = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);

    const poly = linePolyMesh(start, end, segments);
    let mesh = lineCache.get(ctx.nodeId);
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
      mesh.add(new THREE.LineSegments(new THREE.BufferGeometry(), LINE_MATERIAL));
      lineCache.set(ctx.nodeId, mesh);
    }
    mesh.geometry.dispose();
    mesh.geometry = polyMeshToGeometry(poly);
    const wire = mesh.children[0] as THREE.LineSegments;
    wire.geometry.dispose();
    wire.geometry = new THREE.BufferGeometry().setFromPoints(poly.edges!.flatMap(([a, b]) => [new THREE.Vector3(...poly.positions[a]), new THREE.Vector3(...poly.positions[b])]));
    mesh.userData.nodeId = ctx.nodeId;
    wire.userData.nodeId = ctx.nodeId;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.updateMatrixWorld(true);
    mesh.visible = numberInput(inputs.visible, params.visible, 1) !== 0;

    const worldPoints = poly.positions.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(matrix));
    const curve = new THREE.LineCurve3(worldPoints[0], worldPoints[worldPoints.length - 1]);
    return { geometry: mesh, curve, points: worldPoints, matrix: matrix.clone() };
  },
};
