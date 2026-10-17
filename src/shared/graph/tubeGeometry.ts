import * as THREE from "three";
import { DEFAULT_PROFILE_POINTS, evalProfileCurve, ProfilePoint } from "./profileCurve";

/**
 * Curve to Mesh's tube sweep, on its own so the geometry worker can import it
 * without the node registry (see offthread/curveTube.ts).
 */

/** Generates custom tube geometry with variable radius R(t) = baseRadius * evalProfile(t) and start/end trimming */
/**
 * Fans a flat disc across one end ring of the tube, duplicating its vertices
 * so the cap gets its own flat normal instead of inheriting the tube side's
 * curved-around-the-tube one — sharing indices would light the cap like a
 * continuation of the tube wall instead of a flat plug. Winding is decided
 * per end (not assumed) by checking the first triangle against the desired
 * outward normal and flipping if that particular ring's vertex order came
 * out backwards, so it's correct regardless of which end (start or end,
 * opposite tangent directions) called it.
 */
function addTubeCap(
  positions: number[],
  normalAttrs: number[],
  uvs: number[],
  indices: number[],
  ringStartVertex: number,
  radialSegments: number,
  center: THREE.Vector3,
  capNormal: THREE.Vector3,
): void {
  const duplicatedRingStart = positions.length / 3;
  for (let j = 0; j <= radialSegments; j++) {
    const src = ringStartVertex + j;
    positions.push(positions[src * 3], positions[src * 3 + 1], positions[src * 3 + 2]);
    normalAttrs.push(capNormal.x, capNormal.y, capNormal.z);
    const theta = (j / radialSegments) * Math.PI * 2;
    uvs.push(0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta));
  }
  const centerIndex = positions.length / 3;
  positions.push(center.x, center.y, center.z);
  normalAttrs.push(capNormal.x, capNormal.y, capNormal.z);
  uvs.push(0.5, 0.5);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let j = 0; j < radialSegments; j++) {
    const p0 = duplicatedRingStart + j;
    const p1 = duplicatedRingStart + j + 1;
    a.set(positions[p0 * 3], positions[p0 * 3 + 1], positions[p0 * 3 + 2]).sub(center);
    b.set(positions[p1 * 3], positions[p1 * 3 + 1], positions[p1 * 3 + 2]).sub(center);
    const outward = a.clone().cross(b).dot(capNormal) >= 0;
    if (outward) indices.push(centerIndex, p0, p1);
    else indices.push(centerIndex, p1, p0);
  }
}

export function createVariableThicknessTubeGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  tubularSegments = 64,
  radialSegments = 8,
  baseRadius = 0.1,
  profile: ProfilePoint[] = DEFAULT_PROFILE_POINTS,
  _closed = false,
  startProgress = 0.0,
  endProgress = 1.0,
  caps = false,
): THREE.BufferGeometry {
  const s = Math.max(0, Math.min(1, startProgress));
  const e = Math.max(0, Math.min(1, endProgress));

  // If start and end are virtually identical, produce empty geometry
  if (Math.abs(e - s) < 1e-5) {
    return new THREE.BufferGeometry();
  }

  // Sample points and tangents along the trimmed portion of the curve
  const samplePoints: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];

  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const u = Math.max(0, Math.min(1, s + t * (e - s)));
    samplePoints.push(curve.getPointAt(u));
    const tan = curve.getTangentAt(u);
    if (e < s) tan.negate();
    tangents.push(tan.normalize());
  }

  // Compute parallel-transport Frenet frames along samplePoints
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];

  let normal = new THREE.Vector3();
  const initialTan = tangents[0];
  if (Math.abs(initialTan.x) <= Math.abs(initialTan.y) && Math.abs(initialTan.x) <= Math.abs(initialTan.z)) {
    normal.set(1, 0, 0);
  } else if (Math.abs(initialTan.y) <= Math.abs(initialTan.x) && Math.abs(initialTan.y) <= Math.abs(initialTan.z)) {
    normal.set(0, 1, 0);
  } else {
    normal.set(0, 0, 1);
  }
  const vec = new THREE.Vector3().crossVectors(initialTan, normal).normalize();
  normal.crossVectors(initialTan, vec).normalize();

  normals.push(normal.clone());
  binormals.push(new THREE.Vector3().crossVectors(initialTan, normal).normalize());

  for (let i = 1; i <= tubularSegments; i++) {
    const prevT = tangents[i - 1];
    const currT = tangents[i];
    const prevN = normals[i - 1];

    const axis = new THREE.Vector3().crossVectors(prevT, currT);
    if (axis.lengthSq() > 1e-7) {
      axis.normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(prevT.dot(currT), -1, 1));
      normal = prevN.clone().applyAxisAngle(axis, angle);
    } else {
      normal = prevN.clone();
    }
    normals.push(normal);
    binormals.push(new THREE.Vector3().crossVectors(currT, normal).normalize());
  }

  const positions: number[] = [];
  const normalAttrs: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const vertex = new THREE.Vector3();
  const ringNormal = new THREE.Vector3();

  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments; // 0 to 1 along the active visible trimmed mesh
    const P = samplePoints[i];
    const N = normals[i];
    const B = binormals[i];

    // Evaluate profile curve along the active trimmed mesh [0, 1]
    const radiusMultiplier = evalProfileCurve(profile, t);
    const currentRadius = Math.max(0.0001, baseRadius * radiusMultiplier);

    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments;
      const theta = v * Math.PI * 2;
      const sin = Math.sin(theta);
      const cos = -Math.cos(theta);

      // Normal in circle plane
      ringNormal.x = cos * N.x + sin * B.x;
      ringNormal.y = cos * N.y + sin * B.y;
      ringNormal.z = cos * N.z + sin * B.z;
      ringNormal.normalize();

      normalAttrs.push(ringNormal.x, ringNormal.y, ringNormal.z);

      // Vertex position
      vertex.x = P.x + currentRadius * ringNormal.x;
      vertex.y = P.y + currentRadius * ringNormal.y;
      vertex.z = P.z + currentRadius * ringNormal.z;

      positions.push(vertex.x, vertex.y, vertex.z);
      uvs.push(t, v);
    }
  }

  // Face indices
  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = (radialSegments + 1) * i + j;
      const b = (radialSegments + 1) * (i + 1) + j;
      const c = (radialSegments + 1) * (i + 1) + (j + 1);
      const d = (radialSegments + 1) * i + (j + 1);

      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  if (caps) {
    const startRingVertex = 0;
    const endRingVertex = (radialSegments + 1) * tubularSegments;
    addTubeCap(positions, normalAttrs, uvs, indices, startRingVertex, radialSegments, samplePoints[0], tangents[0].clone().negate());
    addTubeCap(
      positions,
      normalAttrs,
      uvs,
      indices,
      endRingVertex,
      radialSegments,
      samplePoints[tubularSegments],
      tangents[tubularSegments].clone(),
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normalAttrs, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  return geometry;
}
