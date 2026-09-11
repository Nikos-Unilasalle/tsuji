import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import {
  buildLatticeControlPoints,
  createLatticeCageGeometry,
  defaultLatticePoints,
  evaluateFFDPoint,
  evaluateLatticeControlPoint,
  LATTICE_DEFORM_NODE,
  LATTICE_GRID_PARAM_IDS,
  latticeBasePointForTarget,
  latticeBasePoints,
  latticeEvaluatedPoints,
  latticeParamsWithRebuiltGrid,
  LatticeGridConfig,
} from "./lattice";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "lattice-test-node" };

describe("LATTICE DEFORM NODE", () => {
  const baseConfig: LatticeGridConfig = {
    sizeX: 2.0,
    sizeY: 2.0,
    sizeZ: 2.0,
    subdivU: 2,
    subdivV: 2,
    subdivW: 2,
    interpolation: "linear",
    strength: 1.0,
    deformAxis: "y",
    bulge: 0.0,
    twist: 0.0,
    taper: 0.0,
    bend: 0.0,
    shearX: 0.0,
    shearZ: 0.0,
  };

  it("builds an undeformed 2x2x2 control points grid correctly", () => {
    const grid = buildLatticeControlPoints(baseConfig);
    expect(grid.length).toBe(2);
    expect(grid[0].length).toBe(2);
    expect(grid[0][0].length).toBe(2);

    expect(grid[0][0][0].x).toBeCloseTo(-1.0);
    expect(grid[1][1][1].x).toBeCloseTo(1.0);
  });

  it("evaluates linear FFD at center without modification on identity grid", () => {
    const grid = buildLatticeControlPoints(baseConfig);
    const center = evaluateFFDPoint(grid, 0.5, 0.5, 0.5, "linear");
    expect(center.x).toBeCloseTo(0);
    expect(center.y).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(0);
  });

  it("applies taper deformation narrowing the base/top", () => {
    const taperConfig: LatticeGridConfig = {
      ...baseConfig,
      taper: -0.4,
    };
    const ptTop = evaluateLatticeControlPoint(0.5, 0.5, 0.5, taperConfig, 0);
    const ptBot = evaluateLatticeControlPoint(0.5, -0.5, 0.5, taperConfig, 0);

    // Top should have smaller radius than bottom
    expect(Math.abs(ptTop.x)).toBeLessThan(Math.abs(ptBot.x));
  });

  it("applies twist deformation rotating vertices as a function of height", () => {
    const twistConfig: LatticeGridConfig = {
      ...baseConfig,
      twist: 90,
    };
    const ptTop = evaluateLatticeControlPoint(0.5, 0.5, 0.0, twistConfig, 0);
    // At height 0.5 (angle = 90 deg), x moves to z
    expect(ptTop.x).toBeCloseTo(0, 1);
    expect(ptTop.z).toBeCloseTo(1.0, 1);
  });

  it("bend curves symmetrically around the centre without lifting the lattice in Y", () => {
    const bendConfig: LatticeGridConfig = {
      ...baseConfig,
      bend: 1.0,
    };
    // deformAxis = y, so the bend pivot is the lattice centre (h = v).
    const ptTop = evaluateLatticeControlPoint(0.5, 0.5, 0.5, bendConfig, 0);
    const ptBot = evaluateLatticeControlPoint(0.5, -0.5, 0.5, bendConfig, 0);

    // The Y extent stays centred on 0 — no rise.
    expect((ptTop.y + ptBot.y) / 2).toBeCloseTo(0, 5);
    expect(ptTop.y).toBeGreaterThan(0);
    expect(ptBot.y).toBeLessThan(0);
    // And it actually curves laterally.
    expect(Math.abs(ptTop.x)).toBeGreaterThan(0.01);
  });

  it("bend on the X axis curves without translating the lattice along X", () => {
    const bendConfig: LatticeGridConfig = { ...baseConfig, deformAxis: "x", bend: 1.0 };
    // deformAxis = x, so h = u; the X extent must stay centred on 0.
    const near = evaluateLatticeControlPoint(0.5, 0.5, 0.5, bendConfig, 0);
    const far = evaluateLatticeControlPoint(-0.5, 0.5, 0.5, bendConfig, 0);
    expect((near.x + far.x) / 2).toBeCloseTo(0, 5);
    expect(Math.abs(near.y)).toBeGreaterThan(0.01);
  });

  it("none of the deformations translate the lattice along the deform axis", () => {
    const cases: Record<string, Partial<LatticeGridConfig>> = {
      taper: { taper: -0.4 },
      twist: { twist: 90 },
      bulge: { bulge: 0.5 },
      shearX: { shearX: 0.5 },
      shearZ: { shearZ: 0.5 },
      bend: { bend: 1.0 },
    };
    for (const [name, patch] of Object.entries(cases)) {
      const cfg: LatticeGridConfig = { ...baseConfig, ...patch };
      const top = evaluateLatticeControlPoint(0.5, 0.5, 0.5, cfg, 0);
      const bot = evaluateLatticeControlPoint(0.5, -0.5, 0.5, cfg, 0);
      // deformAxis = y: the Y extent must stay centred on 0 for every modulator.
      expect((top.y + bot.y) / 2, `${name} lifts the lattice`).toBeCloseTo(0, 3);
    }
  });

  it("applies bulge deformation expanding the center", () => {
    const bulgeConfig: LatticeGridConfig = {
      ...baseConfig,
      bulge: 0.5,
    };
    const ptCenter = evaluateLatticeControlPoint(0.1, 0.1, 0.1, bulgeConfig, 0);
    const ptUndeformed = evaluateLatticeControlPoint(0.1, 0.1, 0.1, baseConfig, 0);
    expect(ptCenter.length()).toBeGreaterThan(ptUndeformed.length());
  });

  it("generates valid cage line geometry", () => {
    const grid = buildLatticeControlPoints(baseConfig);
    const cageGeom = createLatticeCageGeometry(grid);
    expect(cageGeom).toBeInstanceOf(THREE.BufferGeometry);
    expect(cageGeom.attributes.position.count).toBeGreaterThan(0);
  });

  it("deforms a 3D box mesh and recalculates normals", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4), new THREE.MeshStandardMaterial());
    const res = LATTICE_DEFORM_NODE.evaluate(
      { geometry: box, twist: 45, bulge: 0.3 },
      LATTICE_DEFORM_NODE.defaultParams,
      CTX
    );

    const group = res.geometry as THREE.Group;
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBeGreaterThanOrEqual(1);

    const deformedMesh = group.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    expect(deformedMesh).toBeDefined();
    expect(deformedMesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(deformedMesh.geometry.attributes.normal).toBeDefined();
  });

  it("outputs a Points list matching the deformed mesh's own vertex buffer, index-for-index — for Points Selection / Spring", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4), new THREE.MeshStandardMaterial());
    const res = LATTICE_DEFORM_NODE.evaluate(
      { geometry: box, twist: 45, bulge: 0.3 },
      LATTICE_DEFORM_NODE.defaultParams,
      CTX,
    );

    const group = res.geometry as THREE.Group;
    const deformedMesh = group.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    const posAttr = deformedMesh.geometry.attributes.position as THREE.BufferAttribute;
    const points = res.points as THREE.Vector3[];

    expect(points).toHaveLength(posAttr.count);
    // Same values as the deformed geometry's own buffer, not the undeformed input.
    for (let i = 0; i < posAttr.count; i += Math.max(1, Math.floor(posAttr.count / 5))) {
      expect(points[i].x).toBeCloseTo(posAttr.getX(i));
      expect(points[i].y).toBeCloseTo(posAttr.getY(i));
      expect(points[i].z).toBeCloseTo(posAttr.getZ(i));
    }
  });

  it("outputs cagePoints matching pointsList's count, in lattice-local space, for Points Influence to paint on", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const res = LATTICE_DEFORM_NODE.evaluate({ geometry: box }, LATTICE_DEFORM_NODE.defaultParams, CTX);
    const cagePoints = res.cagePoints as THREE.Vector3[];
    expect(cagePoints).toHaveLength(2 * 2 * 2); // default subdivisions
  });

  it("a per-point influence of 0 leaves that control point undeformed, while others still deform fully", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4), new THREE.MeshStandardMaterial());
    const params = { ...LATTICE_DEFORM_NODE.defaultParams, twist: 45 };

    const fullyDeformed = LATTICE_DEFORM_NODE.evaluate({ geometry: box }, params, CTX);
    const fullCage = fullyDeformed.cagePoints as THREE.Vector3[];

    // Twist pivots from the h=-0.5 face (zero rotation there), so the point
    // to zero out is the opposite, h=+0.5 corner — index 7 of a 2x2x2 grid
    // (i=1,j=1,k=1) — where twist's rotation is actually nonzero.
    const targetIdx = fullCage.length - 1;
    const zeroedLast = new Array(fullCage.length).fill(1);
    zeroedLast[targetIdx] = 0;
    const partial = LATTICE_DEFORM_NODE.evaluate({ geometry: box, pointInfluence: zeroedLast }, params, CTX);
    const partialCage = partial.cagePoints as THREE.Vector3[];

    // The zeroed point stayed at (a very close approximation of) its undeformed base position...
    const base = defaultLatticePoints(2, 2, 2, 2, 2, 2)[targetIdx];
    expect(partialCage[targetIdx].distanceTo(base)).toBeLessThan(1e-6);
    // ...while the same point in the fully-deformed pass moved (twist rotated it).
    expect(fullCage[targetIdx].distanceTo(base)).toBeGreaterThan(1e-3);
    // Every other point still deformed exactly as before — only the target was dialled down.
    for (let i = 0; i < fullCage.length; i++) {
      if (i === targetIdx) continue;
      expect(partialCage[i].distanceTo(fullCage[i])).toBeLessThan(1e-6);
    }
  });

  it("no pointInfluence wired behaves exactly as before — full deformation everywhere", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4), new THREE.MeshStandardMaterial());
    const params = { ...LATTICE_DEFORM_NODE.defaultParams, twist: 30 };
    const withoutInfluence = LATTICE_DEFORM_NODE.evaluate({ geometry: box }, params, CTX);
    const withFullInfluence = LATTICE_DEFORM_NODE.evaluate(
      { geometry: box, pointInfluence: new Array(8).fill(1) },
      params,
      CTX,
    );
    const a = withoutInfluence.cagePoints as THREE.Vector3[];
    const b = withFullInfluence.cagePoints as THREE.Vector3[];
    for (let i = 0; i < a.length; i++) expect(a[i].distanceTo(b[i])).toBeLessThan(1e-9);
  });
});

describe("LATTICE_DEFORM_NODE source transform tracking", () => {
  /** A graph-driven mesh: matrixAutoUpdate off, `matrix` written by its node. */
  function graphDrivenMesh(matrix: THREE.Matrix4): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    return mesh;
  }

  function deformedBoundsCentre(res: Record<string, unknown>): THREE.Vector3 {
    const group = res.geometry as THREE.Group;
    const mesh = group.children.find(
      (c): c is THREE.Mesh => (c as THREE.Mesh).isMesh === true,
    )!;
    mesh.geometry.computeBoundingBox();
    // Through the mesh's own matrix: the deformed geometry is recentred on its
    // own origin and the offset rides on the matrix, so the vertices alone no
    // longer say where the object is (see recentreGeometry).
    return mesh.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrix);
  }

  it("follows an animated source, whose matrixWorld nothing refreshes once it is consumed", () => {
    // A node feeding the lattice is no longer drawn itself — only the
    // deformed result is — so nothing traverses it and matrixWorld goes
    // stale. Reading matrixWorld therefore froze the deformation at the
    // source's last drawn pose: a rotating cube stopped rotating the moment
    // a lattice was connected.
    const source = graphDrivenMesh(new THREE.Matrix4().makeTranslation(0, 0, 0));

    // A cage whose control points match its size, so the lattice itself is
    // neutral and any movement seen is purely the source's own.
    const neutral = {
      ...LATTICE_DEFORM_NODE.defaultParams,
      sizeX: 10,
      sizeY: 10,
      sizeZ: 10,
      pointsList: defaultLatticePoints(10, 10, 10, 2, 2, 2),
    };

    const before = deformedBoundsCentre(
      LATTICE_DEFORM_NODE.evaluate({ geometry: source }, neutral, { nodeId: "lat-anim" } as any),
    );

    // The source's node moves it on the next frame, exactly as an animated
    // Transform would.
    source.matrix.copy(new THREE.Matrix4().makeTranslation(3, 0, 0));

    const after = deformedBoundsCentre(
      LATTICE_DEFORM_NODE.evaluate({ geometry: source }, neutral, { nodeId: "lat-anim" } as any),
    );

    expect(after.x - before.x).toBeCloseTo(3, 1);
  });
});

describe("latticeParamsWithRebuiltGrid", () => {
  function extent(points: THREE.Vector3[], axis: "x" | "y" | "z"): number {
    const vals = points.map((p) => p[axis]);
    return Math.max(...vals) - Math.min(...vals);
  }

  it("rebuilds the stored grid to the new Size, which a count check alone never caught", () => {
    // The point count is unchanged by a resize, so evaluate's own
    // count-mismatch guard never fired and the old, smaller grid was used
    // verbatim — the Size fields did nothing at all.
    const next = latticeParamsWithRebuiltGrid({ ...LATTICE_DEFORM_NODE.defaultParams, sizeX: 8 });
    const points = next.pointsList as THREE.Vector3[];

    expect(points.length).toBe(8);
    expect(extent(points, "x")).toBeCloseTo(8);
    expect(extent(points, "y")).toBeCloseTo(2);
  });

  it("rebuilds to the new subdivision count so the handles match the cage", () => {
    const next = latticeParamsWithRebuiltGrid({
      ...LATTICE_DEFORM_NODE.defaultParams,
      subdivisionsU: 4,
    });
    const points = next.pointsList as THREE.Vector3[];

    expect(points.length).toBe(4 * 2 * 2);
    expect(new Set(points.map((p) => p.x.toFixed(4))).size).toBe(4);
  });

  it("leaves every other param untouched", () => {
    const next = latticeParamsWithRebuiltGrid({
      ...LATTICE_DEFORM_NODE.defaultParams,
      sizeX: 5,
      twist: 33,
      deformAxis: "z",
    });

    expect(next.twist).toBe(33);
    expect(next.deformAxis).toBe("z");
  });

  it("lists exactly the params that define the grid's shape", () => {
    // Deformation modulators must NOT be in here: they are applied on top of
    // the base grid at evaluation time, so rebuilding on those would throw
    // away the user's point edits every time a slider moved.
    expect([...LATTICE_GRID_PARAM_IDS]).toEqual([
      "sizeX",
      "sizeY",
      "sizeZ",
      "subdivisionsU",
      "subdivisionsV",
      "subdivisionsW",
    ]);
  });
});

describe("LATTICE_DEFORM_NODE cage", () => {
  function cageExtentX(res: Record<string, unknown>): number {
    const attr = (res.cage as THREE.LineSegments).geometry.attributes.position;
    const xs: number[] = [];
    for (let i = 0; i < attr.count; i++) xs.push(attr.getX(i));
    return Math.max(...xs) - Math.min(...xs);
  }

  it("draws the grid the stored points describe", () => {
    const res = LATTICE_DEFORM_NODE.evaluate(
      {},
      latticeParamsWithRebuiltGrid({ ...LATTICE_DEFORM_NODE.defaultParams, sizeX: 8 }),
      { nodeId: "lat-cage-size" } as any,
    );

    expect(cageExtentX(res)).toBeCloseTo(8, 1);
  });
});

describe("lattice handle positions under modulators", () => {
  const tapered = { ...LATTICE_DEFORM_NODE.defaultParams, taper: 0.4 };

  it("evaluated points sit on the deformed cage, not on the raw stored grid", () => {
    // The reported bug: with a taper dialled in, the handles stayed on the
    // undeformed grid and floated off the cage they are meant to edit.
    const base = latticeBasePoints(tapered);
    const shown = latticeEvaluatedPoints(tapered);

    expect(shown.length).toBe(base.length);
    const moved = shown.filter((p, i) => p.distanceTo(base[i]) > 1e-6);
    expect(moved.length).toBeGreaterThan(0);
  });

  it("with no modulators the two coincide, so nothing changes for a plain lattice", () => {
    const plain = { ...LATTICE_DEFORM_NODE.defaultParams };
    const base = latticeBasePoints(plain);
    const shown = latticeEvaluatedPoints(plain);

    for (let i = 0; i < base.length; i++) expect(shown[i].distanceTo(base[i])).toBeCloseTo(0, 6);
  });

  it("solves the base point that lands a handle exactly where it was dragged", () => {
    const index = 0;
    const target = new THREE.Vector3(-1.7, -1.2, 0.6);

    const solvedBase = latticeBasePointForTarget(tapered, index, target);

    // Feeding that base back through the forward pass must reproduce the drag.
    const withEdit = {
      ...tapered,
      pointsList: latticeBasePoints(tapered).map((p, i) => (i === index ? solvedBase : p)),
    };
    expect(latticeEvaluatedPoints(withEdit)[index].distanceTo(target)).toBeLessThan(1e-6);
  });

  it("round-trips under twist and shear too, not just the linear cases", () => {
    const gnarly = { ...LATTICE_DEFORM_NODE.defaultParams, twist: 55, shearX: 0.3, taper: -0.2, bulge: 0.25 };
    const index = 5;
    const target = new THREE.Vector3(0.8, 0.4, -0.9);

    const solvedBase = latticeBasePointForTarget(gnarly, index, target);
    const withEdit = {
      ...gnarly,
      pointsList: latticeBasePoints(gnarly).map((p, i) => (i === index ? solvedBase : p)),
    };

    expect(latticeEvaluatedPoints(withEdit)[index].distanceTo(target)).toBeLessThan(1e-6);
  });

  it("with no modulators the solved base is just the target", () => {
    const plain = { ...LATTICE_DEFORM_NODE.defaultParams };
    const target = new THREE.Vector3(0.3, -0.7, 0.9);

    expect(latticeBasePointForTarget(plain, 3, target).distanceTo(target)).toBeLessThan(1e-9);
  });
});
