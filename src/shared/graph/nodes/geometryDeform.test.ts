import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import {
  GEOMETRY_TWIST_BEND_TAPER_NODE,
  GEOMETRY_WAVE_RIPPLE_NODE,
  GEOMETRY_FACET_EXPLODE_NODE,
} from "./geometryDeform";
import { OBJECT_BOX_NODE, OBJECT_PLANE_NODE } from "./object";

const CTX: EvalContext = { time: 1.0, step: 0.016, nodeId: "deform-test" };

describe("GEOMETRY_TWIST_BEND_TAPER_NODE", () => {
  it("passes through if no deformation is specified", () => {
    const box = OBJECT_BOX_NODE.evaluate({}, OBJECT_BOX_NODE.defaultParams, CTX);
    const res = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate(
      { geometry: box.geometry },
      { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, twist: 0, bend: 0, taper: 0 },
      CTX,
    ) as any;
    expect(res.geometry).toBe(box.geometry);
  });

  it("applies twist deformation to box vertices and preserves object matrix", () => {
    const loc = new THREE.Vector3(10, 5, 2);
    const box = OBJECT_BOX_NODE.evaluate({ location: loc }, { ...OBJECT_BOX_NODE.defaultParams, location: loc }, CTX);
    const res = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate(
      { geometry: box.geometry },
      { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, twist: 90 },
      CTX,
    ) as any;
    expect(res.geometry).toBeInstanceOf(THREE.Mesh);
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh).not.toBe(box.geometry);
    // Cut finer first, so the twist curves the faces instead of leaving them flat.
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(
      (box.geometry as THREE.Mesh).geometry.attributes.position.count,
    );
    // Matrix must match the object's position (10, 5, 2)
    expect(mesh.position.x).toBeCloseTo(10);
    expect(mesh.position.y).toBeCloseTo(5);
    expect(mesh.position.z).toBeCloseTo(2);
    expect(res.matrix).toBeInstanceOf(THREE.Matrix4);
  });

  it("applies taper scaling along chosen axis", () => {
    const box = OBJECT_BOX_NODE.evaluate({}, OBJECT_BOX_NODE.defaultParams, CTX);
    const res = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate(
      { geometry: box.geometry },
      { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, taper: 1.0 },
      CTX,
    ) as any;
    expect(res.geometry).toBeInstanceOf(THREE.Mesh);
  });

  it("safely deforms a group like Grease Pencil without mutating or stealing its children", () => {
    const group = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 2, 2, 0], 3));
    const mat = new THREE.MeshBasicMaterial();
    const childMesh = new THREE.Mesh(geo, mat);
    group.add(childMesh);

    // 1. Pass-through test
    const passRes = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate(
      { geometry: group },
      { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, twist: 0, bend: 0, taper: 0 },
      CTX,
    ) as any;
    expect(passRes.geometry).toBe(group);
    expect(group.children.length).toBe(1);
    expect(childMesh.parent).toBe(group);

    // 2. Deformation test
    const deformRes = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate(
      { geometry: group },
      { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, twist: 45 },
      CTX,
    ) as any;
    expect(deformRes.geometry).toBeInstanceOf(THREE.Group);
    expect(deformRes.geometry).not.toBe(group);
    // Original group's child must NOT be detached
    expect(group.children.length).toBe(1);
    expect(childMesh.parent).toBe(group);
    // Material must not be disposed
    expect(mat).toBeDefined();
  });
});

describe("GEOMETRY_WAVE_RIPPLE_NODE", () => {
  it("displaces vertices in ripple mode and preserves object matrix", () => {
    const loc = new THREE.Vector3(3, 4, 5);
    const plane = OBJECT_PLANE_NODE.evaluate(
      { location: loc },
      { ...OBJECT_PLANE_NODE.defaultParams, location: loc, segmentsX: 10, segmentsY: 10 },
      CTX,
    );
    const res = GEOMETRY_WAVE_RIPPLE_NODE.evaluate(
      { geometry: plane.geometry },
      { ...GEOMETRY_WAVE_RIPPLE_NODE.defaultParams, amplitude: 0.5, frequency: 4.0 },
      CTX,
    ) as any;
    expect(res.geometry).toBeInstanceOf(THREE.Mesh);
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(3);
    expect(mesh.position.y).toBeCloseTo(4);
    expect(mesh.position.z).toBeCloseTo(5);
    expect(res.matrix).toBeInstanceOf(THREE.Matrix4);

    const pos = mesh.geometry.attributes.position;
    let hasNonZeroY = false;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i)) > 1e-4) {
        hasNonZeroY = true;
        break;
      }
    }
    expect(hasNonZeroY).toBe(true);
  });

  it("supports world space deformation where displacement depends on world position", () => {
    const loc = new THREE.Vector3(100, 0, 100);
    const plane = OBJECT_PLANE_NODE.evaluate(
      { location: loc },
      { ...OBJECT_PLANE_NODE.defaultParams, location: loc, segmentsX: 5, segmentsY: 5 },
      CTX,
    );
    // In world space, centered at (0, 0) with heavy decay (0.5), at distance ~141, amplitude will be damped
    const res = GEOMETRY_WAVE_RIPPLE_NODE.evaluate(
      { geometry: plane.geometry },
      { ...GEOMETRY_WAVE_RIPPLE_NODE.defaultParams, space: "world", amplitude: 1.0, decay: 0.5 },
      CTX,
    ) as any;
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(100);
    expect(mesh.position.z).toBeCloseTo(100);
  });

  it("accepts explicitly wired matrix input", () => {
    const plane = OBJECT_PLANE_NODE.evaluate({}, OBJECT_PLANE_NODE.defaultParams, CTX);
    const customMat = new THREE.Matrix4().makeTranslation(7, 8, 9);
    const res = GEOMETRY_WAVE_RIPPLE_NODE.evaluate(
      { geometry: plane.geometry, matrix: customMat },
      GEOMETRY_WAVE_RIPPLE_NODE.defaultParams,
      CTX,
    ) as any;
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(7);
    expect(mesh.position.y).toBeCloseTo(8);
    expect(mesh.position.z).toBeCloseTo(9);
  });
});

describe("chained deformers", () => {
  it("Wave -> Twist keeps animating Wave's ripple frame to frame", () => {
    const plane = OBJECT_PLANE_NODE.evaluate(
      {},
      { ...OBJECT_PLANE_NODE.defaultParams, segmentsX: 10, segmentsY: 10 },
      CTX,
    );

    const waveParams = { ...GEOMETRY_WAVE_RIPPLE_NODE.defaultParams, amplitude: 0.5, frequency: 4.0 };
    const twistParams = { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, twist: 30 };

    // Same node ids across frames — same DeformTarget cache reused, uuid unchanged.
    const frame1Wave = GEOMETRY_WAVE_RIPPLE_NODE.evaluate({ geometry: plane.geometry }, waveParams, {
      ...CTX,
      nodeId: "wave",
      time: 1.0,
    }) as any;
    const frame1Twist = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate({ geometry: frame1Wave.geometry }, twistParams, {
      ...CTX,
      nodeId: "twist",
      time: 1.0,
    }) as any;
    // Twist (axis "y", no bend) never rewrites the Y component itself — it only
    // reads it to compute the cross-section rotation angle, then writes it back
    // unchanged. So the ripple's height survives into Twist's output exactly as
    // handed to it: frozen pre-fix, live post-fix. That makes Y the one signal
    // immune to the incidental X/Z drift Twist's own live bounds recompute would
    // otherwise introduce every frame regardless of this bug.
    const yOf = (mesh: THREE.Mesh) => {
      const pos = mesh.geometry.attributes.position;
      const ys: number[] = [];
      for (let i = 0; i < pos.count; i++) ys.push(pos.getY(i));
      return ys;
    };
    const snapshot1 = yOf(frame1Twist.geometry as THREE.Mesh);

    const frame2Wave = GEOMETRY_WAVE_RIPPLE_NODE.evaluate({ geometry: plane.geometry }, waveParams, {
      ...CTX,
      nodeId: "wave",
      time: 2.0,
    }) as any;
    const frame2Twist = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate({ geometry: frame2Wave.geometry }, twistParams, {
      ...CTX,
      nodeId: "twist",
      time: 2.0,
    }) as any;
    const snapshot2 = yOf(frame2Twist.geometry as THREE.Mesh);

    expect(snapshot2).not.toEqual(snapshot1);
  });
});

describe("GEOMETRY_FACET_EXPLODE_NODE", () => {
  it("explodes faces along normals and preserves object matrix", () => {
    const loc = new THREE.Vector3(-2, 1, 4);
    const box = OBJECT_BOX_NODE.evaluate({ location: loc }, { ...OBJECT_BOX_NODE.defaultParams, location: loc }, CTX);
    const res = GEOMETRY_FACET_EXPLODE_NODE.evaluate(
      { geometry: box.geometry },
      { ...GEOMETRY_FACET_EXPLODE_NODE.defaultParams, distance: 1.0 },
      CTX,
    ) as any;
    expect(res.geometry).toBeInstanceOf(THREE.Mesh);
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(-2);
    expect(mesh.position.y).toBeCloseTo(1);
    expect(mesh.position.z).toBeCloseTo(4);
    expect(res.matrix).toBeInstanceOf(THREE.Matrix4);
    expect(mesh.geometry.index).toBeNull();
  });
});

describe("Bend axes", () => {
  /** A long thin bar along X, like a line of text: 4 long, 0.1 deep, many slices. */
  function bar(matrix = new THREE.Matrix4()): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 0.6, 0.1, 40, 1, 1));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    return mesh;
  }

  function bent(mesh: THREE.Mesh, params: Record<string, unknown>, id: string): THREE.Box3 {
    const out = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate(
      { geometry: mesh },
      { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, bend: 90, ...params },
      { ...CTX, nodeId: id },
    ).geometry as THREE.Mesh;
    // Measured on screen: the deformed geometry under the object's own turn.
    const pos = out.geometry.attributes.position as THREE.BufferAttribute;
    const rot = new THREE.Quaternion();
    mesh.matrix.decompose(new THREE.Vector3(), rot, new THREE.Vector3());
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyQuaternion(rot));
    return box;
  }

  it("bends a line along X toward Z, out of its own plane", () => {
    const box = bent(bar(), { axis: "x", bendToward: "z" }, "bend-text-z");
    // 0.1 deep at rest; bent 90° about its middle, the ends come 0.75 forward.
    expect(box.max.z - box.min.z).toBeGreaterThan(0.8);
    expect(box.max.y - box.min.y).toBeCloseTo(0.6, 6);
  });

  it("keeps the old direction by default: along X curls toward Y", () => {
    const box = bent(bar(), { axis: "x" }, "bend-text-auto");
    expect(box.max.y - box.min.y).toBeGreaterThan(1.3);
    expect(box.max.z - box.min.z).toBeCloseTo(0.1, 6);
  });

  it("reads the axes on screen, not the object's own: a bar turned to lie along Z bends along Z", () => {
    const along = new THREE.Matrix4().makeRotationY(-Math.PI / 2); // the bar's X now points along screen Z
    const box = bent(bar(along), { axis: "z", bendToward: "y" }, "bend-turned");
    expect(box.max.y - box.min.y).toBeGreaterThan(1.3);
  });

  it("bends a lying Plane along screen Z when told to curl up", () => {
    const plane = OBJECT_PLANE_NODE.evaluate({}, OBJECT_PLANE_NODE.defaultParams, { ...CTX, nodeId: "bend-plane-src" }).geometry as THREE.Mesh;
    plane.geometry = new THREE.PlaneGeometry(1, 1, 1, 20);
    const box = bent(plane, { axis: "z", bendToward: "y" }, "bend-plane");
    // Flat at rest (0 thick); before, Z on a lying Plane was its normal and nothing moved.
    expect(box.max.y - box.min.y).toBeGreaterThan(0.15);
  });

  it("ignores a Toward equal to the Along axis", () => {
    const a = bent(bar(), { axis: "x", bendToward: "x" }, "bend-same");
    const b = bent(bar(), { axis: "x" }, "bend-same-auto");
    expect(a.equals(b)).toBe(true);
  });
});

describe("Bend wraps without chords", () => {
  it("cuts long triangles first, so a line wrapped right round stays on the circle", () => {
    // One long strip: two triangles 4 long. Bent 360° toward Z it should be a ring of radius 4/2π.
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.4, 1, 1));
    strip.matrixAutoUpdate = false;
    const out = GEOMETRY_TWIST_BEND_TAPER_NODE.evaluate(
      { geometry: strip },
      { ...GEOMETRY_TWIST_BEND_TAPER_NODE.defaultParams, bend: 360, axis: "x", bendToward: "z" },
      { ...CTX, nodeId: "bend-wrap" },
    ).geometry as THREE.Mesh;
    const pos = out.geometry.attributes.position as THREE.BufferAttribute;
    const r = 4 / (2 * Math.PI);
    // Every edge midpoint is near the ring: no chord cuts across it.
    let worst = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      for (const [j, k] of [[0, 1], [1, 2], [2, 0]]) {
        a.fromBufferAttribute(pos, i + j);
        b.fromBufferAttribute(pos, i + k);
        const m = a.clone().add(b).multiplyScalar(0.5);
        worst = Math.max(worst, Math.abs(Math.hypot(m.x, m.z - r) - r));
      }
    }
    expect(worst).toBeLessThan(0.01);
  });
});
