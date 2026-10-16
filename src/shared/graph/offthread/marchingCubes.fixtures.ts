import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { expect } from "vitest";
import { projectGeometryUVs } from "../mesh/geometryUV";
import { UV_DENSITY } from "../mesh/uv";
import { BALL_STRIDE, MeshBuffers, MetaballsJob } from "./marchingCubes";

/** Shared by the kernel tests and the kernel bench: deterministic jobs, and the old main-thread path as the reference. */

/** mulberry32, so every run sees the same balls. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleJob(resolution: number, ballCount: number, seed = 7): MetaballsJob {
  const rand = seeded(seed);
  const isolation = 20;
  const radius = 0.5;
  const smooth = 1.6;
  const size = 6;
  const normalizedRadius = radius / size;
  const subtract = isolation / (smooth * smooth - 1);
  const strength = (isolation + subtract) * normalizedRadius * normalizedRadius;
  const balls = new Float64Array(ballCount * BALL_STRIDE);
  for (let i = 0; i < ballCount; i++) {
    balls.set([0.2 + rand() * 0.6, 0.2 + rand() * 0.6, 0.2 + rand() * 0.6, strength, subtract], i * BALL_STRIDE);
  }
  return { resolution, isolation, balls, centerX: 0.5, centerY: -1, centerZ: 2, size, maxVertices: 180000, uvDensity: UV_DENSITY };
}

const referenceFields = new Map<string, MarchingCubes>();

/** What metaballs.ts did before the kernel: three's class, then the node's own mapping into local space. */
export function referenceMesh(job: MetaballsJob): MeshBuffers {
  // Kept between calls, as the node kept it in its fieldCache — so a bench times the work, not the allocation.
  const key = `${job.resolution}:${job.maxVertices}`;
  let field = referenceFields.get(key);
  if (!field) {
    field = new MarchingCubes(job.resolution, new THREE.MeshBasicMaterial(), false, false, job.maxVertices / 3);
    referenceFields.set(key, field);
  }
  field.isolation = job.isolation;
  field.reset();
  for (let i = 0; i < job.balls.length; i += BALL_STRIDE) {
    const b = job.balls;
    field.addBall(b[i], b[i + 1], b[i + 2], b[i + 3], b[i + 4]);
  }
  field.update();
  const count = field.count;
  const half = job.size / 2;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i += 3) {
    position[i] = field.positionArray[i] * half + job.centerX;
    position[i + 1] = field.positionArray[i + 1] * half + job.centerY;
    position[i + 2] = field.positionArray[i + 2] * half + job.centerZ;
    normal.set(field.normalArray.subarray(i, i + 3), i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  projectGeometryUVs(geometry, count);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const box = geometry.boundingBox!;
  const sphere = geometry.boundingSphere!;
  const bounds = new Float64Array([...box.min.toArray(), ...box.max.toArray(), ...sphere.center.toArray(), sphere.radius]);
  return { count, position, normal, uv: geometry.getAttribute("uv").array as Float32Array, bounds };
}

export function expectSameMesh(actual: MeshBuffers, expected: MeshBuffers): void {
  expect(actual.count).toBe(expected.count);
  expect(actual.position).toEqual(expected.position);
  expect(actual.normal).toEqual(expected.normal);
  expect(actual.uv).toEqual(expected.uv);
  for (let i = 0; i < 10; i++) expect(actual.bounds[i]).toBeCloseTo(expected.bounds[i], 5);
}
