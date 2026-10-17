import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createPointCloudHandles } from "./pointCloudHandles";

function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function grid(n: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = new THREE.Vector3((i % 10) - 5, Math.floor(i / 10) - 5, 0);
  return pts;
}

describe("createPointCloudHandles", () => {
  it("draws any point count as a single object — the whole reason this exists", () => {
    const handles = createPointCloudHandles();
    const identity = new THREE.Matrix4();

    handles.sync(grid(10), identity, null);
    expect(handles.group.children).toHaveLength(1);
    expect(handles.count()).toBe(10);

    // Curve-style handles would be 50,000 Meshes here.
    handles.sync(grid(50_000), identity, null);
    expect(handles.group.children).toHaveLength(1);
    expect(handles.count()).toBe(50_000);
    expect(handles.group.children[0]).toBeInstanceOf(THREE.Points);
  });

  it("writes positions and per-point colors into the cloud's own buffers", () => {
    const handles = createPointCloudHandles();
    const pts = [new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 5, 6)];
    handles.sync(pts, new THREE.Matrix4(), [1]);

    const cloud = handles.group.children[0] as THREE.Points;
    const position = cloud.geometry.attributes.position as THREE.BufferAttribute;
    const color = cloud.geometry.attributes.color as THREE.BufferAttribute;

    expect(position.count).toBe(2);
    expect(Array.from(position.array.slice(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(position.array.slice(3, 6))).toEqual([4, 5, 6]);
    // Point 1 is selected, point 0 is not — so their colors must differ.
    expect(Array.from(color.array.slice(0, 3))).not.toEqual(Array.from(color.array.slice(3, 6)));
  });

  it("a colorOverride wins over the selected/unselected color (the influence heatmap)", () => {
    const handles = createPointCloudHandles();
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];
    handles.sync(pts, new THREE.Matrix4(), null, (i) => (i === 0 ? 0xff0000 : 0x0000ff));

    const cloud = handles.group.children[0] as THREE.Points;
    const color = cloud.geometry.attributes.color as THREE.BufferAttribute;
    const red = new THREE.Color(0xff0000);
    const blue = new THREE.Color(0x0000ff);

    expect(color.array[0]).toBeCloseTo(red.r, 5);
    expect(color.array[1]).toBeCloseTo(red.g, 5);
    expect(color.array[3]).toBeCloseTo(blue.r, 5);
    expect(color.array[5]).toBeCloseTo(blue.b, 5);
  });

  it("recolors on the next sync with the same linear values three would give (hex → RGB is cached)", () => {
    const handles = createPointCloudHandles();
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];
    handles.sync(pts, new THREE.Matrix4(), null, () => 0x2563eb);
    handles.sync(pts, new THREE.Matrix4(), null, (i) => (i === 0 ? 0xef4444 : 0x2563eb));

    const color = (handles.group.children[0] as THREE.Points).geometry.attributes.color as THREE.BufferAttribute;
    const hot = new THREE.Color(0xef4444);
    const cold = new THREE.Color(0x2563eb);
    expect([color.array[0], color.array[1], color.array[2]]).toEqual([hot.r, hot.g, hot.b].map((v) => Math.fround(v)));
    expect([color.array[3], color.array[4], color.array[5]]).toEqual([cold.r, cold.g, cold.b].map((v) => Math.fround(v)));
  });

  it("picks the point nearest the pointer, and nothing when the pointer is far away", () => {
    const handles = createPointCloudHandles();
    const camera = makeCamera();
    const pts = [new THREE.Vector3(-2, 0, 0), new THREE.Vector3(2, 0, 0)];
    handles.sync(pts, new THREE.Matrix4(), null);

    // Project point 1 ourselves, then aim the pointer exactly at it.
    const projected = handles.projectAll(camera, 800, 800);
    expect(projected).toHaveLength(2);
    const target = projected.find((p) => p.index === 1)!;
    const ndc = new THREE.Vector2((target.x / 800) * 2 - 1, -((target.y / 800) * 2 - 1));
    expect(handles.pick(ndc, camera, 800, 800)).toBe(1);

    // A corner of the screen is nowhere near either point.
    expect(handles.pick(new THREE.Vector2(-0.99, -0.99), camera, 800, 800)).toBeNull();
  });

  it("pickRect selects exactly the points inside the marquee", () => {
    const handles = createPointCloudHandles();
    const camera = makeCamera();
    handles.sync([new THREE.Vector3(-2, 0, 0), new THREE.Vector3(2, 0, 0)], new THREE.Matrix4(), null);

    const projected = handles.projectAll(camera, 800, 800);
    const p0 = projected.find((p) => p.index === 0)!;
    const picked = handles.pickRect({ minX: p0.x - 5, minY: p0.y - 5, maxX: p0.x + 5, maxY: p0.y + 5 }, camera, 800, 800);
    expect(picked).toEqual([0]);
  });

  it("pickCircle reports distance, so the brush can fall off with it", () => {
    const handles = createPointCloudHandles();
    const camera = makeCamera();
    handles.sync([new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0)], new THREE.Matrix4(), null);

    const projected = handles.projectAll(camera, 800, 800);
    const p0 = projected.find((p) => p.index === 0)!;
    const hits = handles.pickCircle({ x: p0.x, y: p0.y }, 400, camera, 800, 800);

    expect(hits.length).toBeGreaterThan(0);
    const self = hits.find((h) => h.index === 0)!;
    expect(self.distance).toBeCloseTo(0, 3);
    const other = hits.find((h) => h.index === 1);
    if (other) expect(other.distance).toBeGreaterThan(self.distance);
  });

  it("respects the space matrix when projecting, so a posed object's points still hit-test correctly", () => {
    const handles = createPointCloudHandles();
    const camera = makeCamera();
    const pts = [new THREE.Vector3(0, 0, 0)];

    handles.sync(pts, new THREE.Matrix4(), null);
    const atOrigin = handles.projectAll(camera, 800, 800)[0];

    handles.sync(pts, new THREE.Matrix4().makeTranslation(3, 0, 0), null);
    const shifted = handles.projectAll(camera, 800, 800)[0];

    expect(shifted.x).toBeGreaterThan(atOrigin.x);
  });

  it("clear() tears the cloud down and reports an empty count", () => {
    const handles = createPointCloudHandles();
    handles.sync(grid(100), new THREE.Matrix4(), null);
    expect(handles.count()).toBe(100);

    handles.clear();
    expect(handles.count()).toBe(0);
    expect(handles.group.children).toHaveLength(0);
    // Hit tests on an empty cloud must stay safe, not throw.
    expect(handles.pick(new THREE.Vector2(0, 0), makeCamera(), 800, 800)).toBeNull();
    expect(handles.pickRect({ minX: 0, minY: 0, maxX: 800, maxY: 800 }, makeCamera(), 800, 800)).toEqual([]);
  });
});
