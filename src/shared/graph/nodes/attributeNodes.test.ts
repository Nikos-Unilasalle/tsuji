import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EvalContext, NodeDefinition } from "../types";
import { createQuadBox, createQuadPlane, createQuadSphere, type PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { readAttribute, setAttribute, setGroup, type AttrDomain } from "../mesh/polyAttributes";
import { polyNodeStatus } from "./polyModifier";
import {
  ATTRIBUTE_BLUR_NODE,
  ATTRIBUTE_COPY_NODE,
  ATTRIBUTE_CREATE_NODE,
  ATTRIBUTE_DELETE_NODE,
  ATTRIBUTE_EXPRESSION_NODE,
  ATTRIBUTE_FROM_TEXTURE_NODE,
  ATTRIBUTE_MEASURE_NODE,
  ATTRIBUTE_NODES,
  ATTRIBUTE_NOISE_NODE,
  ATTRIBUTE_PROMOTE_NODE,
  ATTRIBUTE_RANDOMIZE_NODE,
  ATTRIBUTE_RENAME_NODE,
  ATTRIBUTE_TO_LIST_NODE,
  ATTRIBUTE_TRANSFER_NODE,
  ATTRIBUTE_VISUALIZE_NODE,
  LIST_TO_ATTRIBUTE_NODE,
} from "./attributeNodes";
import { blurValues, elementAdjacency, listToValues, matchNames, measure, pointCurvature, samplePixels, transferAttributes } from "../mesh/attribOps";

let n = 0;
const ctx = (time = 0): EvalContext => ({ time, step: 0, nodeId: `attr-${n++}` });
const meshObj = (m: PolyMesh) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial());

function run(def: NodeDefinition, input: THREE.Object3D | PolyMesh, params: Record<string, unknown>, inputs: Record<string, unknown> = {}, c = ctx()) {
  const obj = input instanceof THREE.Object3D ? input : meshObj(input);
  const out = def.evaluate({ geometry: obj, ...inputs }, { ...def.defaultParams, ...params }, c);
  const mesh = readPolyMesh(out.geometry as THREE.Object3D)!.mesh;
  const status = polyNodeStatus(c.nodeId)?.lines.map((l) => l.text).join(" | ") ?? "";
  return { out, mesh, status };
}
const values = (m: PolyMesh, domain: AttrDomain, name: string) => Array.from(readAttribute(m, domain, name)?.values ?? []);
const plane = (s = 2) => createQuadPlane(1, 1, s, s);

describe("registry", () => {
  it("every node is an attribute node with a unique type", () => {
    const types = ATTRIBUTE_NODES.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
    for (const d of ATTRIBUTE_NODES) {
      expect(d.category).toBe("attribute");
      expect(d.type.startsWith("attribute/")).toBe(true);
    }
  });
  it("no node throws on a missing input", () => {
    for (const d of ATTRIBUTE_NODES) expect(() => d.evaluate({}, d.defaultParams, ctx())).not.toThrow();
  });
});

describe("Attribute Expression", () => {
  it("writes P (moves the mesh)", () => {
    const { mesh } = run(ATTRIBUTE_EXPRESSION_NODE, plane(), { name1: "P", formula1: "P + (0, 0, P.x + 1)" });
    for (const p of mesh.positions) expect(p[2]).toBeCloseTo(p[0] + 1);
  });
  it("creates a float and a vector attribute, sequentially", () => {
    const { mesh } = run(ATTRIBUTE_EXPRESSION_NODE, plane(1), {
      name1: "h",
      formula1: "P.y * 2",
      name2: "v",
      formula2: "(h, id, count)",
    });
    expect(values(mesh, "point", "h")).toEqual([-1, -1, 1, 1]);
    expect(readAttribute(mesh, "point", "v")!.type).toBe("vec3");
    expect(values(mesh, "point", "v").slice(6, 9)).toEqual([1, 2, 4]);
  });
  it("respects the Group field (others keep their value)", () => {
    const src = setGroup(plane(1), "point", "top", [0, 0, 1, 1]);
    const { mesh } = run(ATTRIBUTE_EXPRESSION_NODE, src, { group: "top", name1: "P", formula1: "P + (0, 0, 1)" });
    expect(mesh.positions.map((p) => p[2])).toEqual([0, 0, 1, 1]);
  });
  it("works on faces and reads built-ins and stored attributes", () => {
    const src = setAttribute(createQuadBox(), "face", "w", "float", [1, 2, 3, 4, 5, 6]);
    const { mesh } = run(ATTRIBUTE_EXPRESSION_NODE, src, { domain: "face", name1: "k", formula1: "w * area + N.y" });
    const k = values(mesh, "face", "k");
    const N = values(mesh, "face", "N");
    k.forEach((v, f) => expect(v).toBeCloseTo((f + 1) * 1 + N[f * 3 + 1]));
  });
  it("reads an attribute promoted from another domain (Cd on points)", () => {
    const src = setAttribute(plane(1), "corner", "Cd", "color", [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
    const { mesh } = run(ATTRIBUTE_EXPRESSION_NODE, src, { name1: "red", formula1: "Cd.r" });
    expect(values(mesh, "point", "red")).toEqual([1, 1, 1, 1]);
  });
  it("uses wired a (number, vector, list) and t", () => {
    const { mesh } = run(ATTRIBUTE_EXPRESSION_NODE, plane(1), { name1: "q", formula1: "a + t" }, { a: 2 }, ctx(0.5));
    expect(values(mesh, "point", "q")).toEqual([2.5, 2.5, 2.5, 2.5]);
    const v = run(ATTRIBUTE_EXPRESSION_NODE, plane(1), { name1: "q", formula1: "a.y" }, { a: new THREE.Vector3(0, 7, 0) });
    expect(values(v.mesh, "point", "q")).toEqual([7, 7, 7, 7]);
    const l = run(ATTRIBUTE_EXPRESSION_NODE, plane(1), { name1: "q", formula1: "a * 10" }, { a: [1, 2, 3] });
    expect(values(l.mesh, "point", "q")).toEqual([10, 20, 30, 30]);
  });
  it("a formula reading t rebuilds when time moves; one that doesn't stays cached", () => {
    const c0 = ctx(0);
    const obj = meshObj(plane(1));
    const eval1 = (formula: string, time: number) => {
      // The node hands back its own cached mesh each time: read it right away.
      const out = ATTRIBUTE_EXPRESSION_NODE.evaluate({ geometry: obj }, { ...ATTRIBUTE_EXPRESSION_NODE.defaultParams, name1: "q", formula1: formula }, { ...c0, time });
      return { geometry: (out.geometry as THREE.Mesh).geometry, q: values(readPolyMesh(out.geometry as THREE.Object3D)!.mesh, "point", "q")[0] };
    };
    expect(eval1("t", 0).q).toBe(0);
    expect(eval1("t", 1).q).toBe(1);
    const s0 = eval1("id", 0);
    const s1 = eval1("id", 5);
    expect(s1.geometry).toBe(s0.geometry); // not rebuilt
  });
  it("reports errors with a position and leaves the mesh alone", () => {
    const { mesh, status } = run(ATTRIBUTE_EXPRESSION_NODE, plane(1), { name1: "P", formula1: "P + foo" });
    expect(status).toMatch(/Formula 1: Unknown name "foo" \(at 5\)/);
    expect(mesh.positions).toEqual(plane(1).positions);
  });
  it("refuses read-only built-ins and vector-into-float", () => {
    expect(run(ATTRIBUTE_EXPRESSION_NODE, plane(1), { name1: "N", formula1: "N" }).status).toMatch(/cannot be written/);
    expect(run(ATTRIBUTE_EXPRESSION_NODE, plane(1), { name1: "h", type1: "float", formula1: "P" }).status).toMatch(/gives a vector/);
  });
  it("never writes NaN", () => {
    const { mesh } = run(ATTRIBUTE_EXPRESSION_NODE, plane(1), { name1: "P", formula1: "P / 0" });
    for (const p of mesh.positions) for (const v of p) expect(Number.isFinite(v)).toBe(true);
  });
  it("fresh typed attribute reads itself as 0", () => {
    const { mesh } = run(ATTRIBUTE_EXPRESSION_NODE, plane(1), { name1: "mass", type1: "int", formula1: "mass + 2.4" });
    expect(values(mesh, "point", "mass")).toEqual([2, 2, 2, 2]);
  });
});

describe("Create / Delete / Rename / Copy / Promote", () => {
  it("create with a group", () => {
    const src = setGroup(createQuadBox(), "face", "g", [1, 0, 0, 0, 0, 1]);
    const { mesh } = run(ATTRIBUTE_CREATE_NODE, src, { domain: "face", group: "g", name: "w", type: "float", value: 3 });
    expect(values(mesh, "face", "w")).toEqual([3, 0, 0, 0, 0, 3]);
    const v = run(ATTRIBUTE_CREATE_NODE, src, { domain: "point", name: "c", type: "color", vector: new THREE.Vector3(1, 0.5, 0) });
    expect(values(v.mesh, "point", "c").slice(0, 3)).toEqual([1, 0.5, 0]);
  });
  it("delete by wildcard, invert, and clears stored built-ins", () => {
    let m = setAttribute(plane(1), "point", "rest_a", "float", [1, 1, 1, 1]);
    m = setAttribute(m, "point", "rest_b", "float", [1, 1, 1, 1]);
    m = setAttribute(m, "point", "keep", "float", [1, 1, 1, 1]);
    m = setAttribute(m, "corner", "Cd", "color", new Array(12).fill(0.5));
    const a = run(ATTRIBUTE_DELETE_NODE, m, { names: "rest_*" }).mesh;
    expect(Object.keys(a.attributes!.point!)).toEqual(["keep"]);
    const b = run(ATTRIBUTE_DELETE_NODE, m, { names: "keep", invert: true, domain: "point" }).mesh;
    expect(Object.keys(b.attributes!.point!)).toEqual(["keep"]);
    const c = run(ATTRIBUTE_DELETE_NODE, m, { names: "Cd" }).mesh;
    expect(c.faceColors).toBeUndefined();
  });
  it("rename", () => {
    const m = setAttribute(plane(1), "point", "a", "float", [1, 2, 3, 4]);
    const { mesh } = run(ATTRIBUTE_RENAME_NODE, m, { from: "a", to: "b" });
    expect(values(mesh, "point", "b")).toEqual([1, 2, 3, 4]);
    expect(readAttribute(mesh, "point", "a")).toBeNull();
  });
  it("copy face area to points (sum) and promote moves", () => {
    const m = createQuadPlane(2, 1, 2, 1); // two unit faces
    const { mesh } = run(ATTRIBUTE_COPY_NODE, m, { name: "area", from: "face", to: "point", newName: "a", reduce: "sum" });
    expect(values(mesh, "point", "a")).toEqual([1, 2, 1, 1, 2, 1]);
    const w = setAttribute(m, "point", "w", "float", [0, 1, 2, 3, 4, 5]);
    const p = run(ATTRIBUTE_PROMOTE_NODE, w, { name: "w", from: "point", to: "face", reduce: "max" }).mesh;
    expect(values(p, "face", "w")).toEqual([4, 5]);
    expect(p.attributes?.point?.w).toBeUndefined();
    const kept = run(ATTRIBUTE_PROMOTE_NODE, w, { name: "w", from: "point", to: "face", keep: true }).mesh;
    expect(kept.attributes?.point?.w).toBeDefined();
  });
});

describe("Noise / Blur / Randomize", () => {
  it("noise displaces along the normal only inside the group", () => {
    const src = setGroup(plane(4), "point", "left", plane(4).positions.map((p) => (p[0] < 0 ? 1 : 0)));
    const { mesh } = run(ATTRIBUTE_NOISE_NODE, src, { group: "left", amplitude: 0.5 });
    mesh.positions.forEach((p, i) => {
      const o = src.positions[i];
      expect(p[0]).toBeCloseTo(o[0]);
      expect(p[1]).toBeCloseTo(o[1]);
      if (o[0] >= 0) expect(p[2]).toBe(0);
    });
    expect(mesh.positions.some((p) => Math.abs(p[2]) > 1e-4)).toBe(true);
  });
  it("noise into a new float attribute, and animate rebuilds with time", () => {
    const a = run(ATTRIBUTE_NOISE_NODE, plane(4), { name: "n", mode: "set", amplitude: 1, animate: true }, {}, ctx(0));
    const b = run(ATTRIBUTE_NOISE_NODE, plane(4), { name: "n", mode: "set", amplitude: 1, animate: true }, {}, ctx(3));
    const va = values(a.mesh, "point", "n");
    expect(va.length).toBe(25);
    expect(va.every((v) => v >= -1 && v <= 1)).toBe(true);
    expect(values(b.mesh, "point", "n")).not.toEqual(va);
  });
  it("blur smooths a spike and pins elements outside the group", () => {
    const m = plane(2); // 9 points, centre = 4
    const spike = setAttribute(m, "point", "w", "float", [0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const { mesh } = run(ATTRIBUTE_BLUR_NODE, spike, { names: "w", iterations: 1, weight: 1 });
    const w = values(mesh, "point", "w");
    expect(w[4]).toBe(0);
    expect(w[1]).toBeCloseTo(1 / 3);
    const pinned = setGroup(spike, "point", "edge", [1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const p = run(ATTRIBUTE_BLUR_NODE, pinned, { names: "w", iterations: 3, weight: 1, group: "edge", output: "wb" }).mesh;
    expect(values(p, "point", "wb")[4]).toBe(1);
    expect(values(p, "point", "w")[4]).toBe(1);
  });
  it("blur on faces", () => {
    const m = setAttribute(createQuadPlane(3, 1, 3, 1), "face", "w", "float", [0, 3, 0]);
    const { mesh } = run(ATTRIBUTE_BLUR_NODE, m, { domain: "face", names: "w", iterations: 1, weight: 1 });
    expect(values(mesh, "face", "w")).toEqual([3, 0, 3]);
  });
  it("randomize is stable, in range, unit vectors are unit", () => {
    const a = values(run(ATTRIBUTE_RANDOMIZE_NODE, plane(4), { min: 2, max: 3 }).mesh, "point", "rand");
    expect(a.every((v) => v >= 2 && v < 3)).toBe(true);
    expect(values(run(ATTRIBUTE_RANDOMIZE_NODE, plane(4), { min: 2, max: 3 }).mesh, "point", "rand")).toEqual(a);
    const ints = values(run(ATTRIBUTE_RANDOMIZE_NODE, plane(4), { type: "int", min: 1, max: 3 }).mesh, "point", "rand");
    expect(ints.every((v) => [1, 2, 3].includes(v))).toBe(true);
    const u = values(run(ATTRIBUTE_RANDOMIZE_NODE, plane(4), { name: "dir", type: "vec3", mode: "unit-vector" }).mesh, "point", "dir");
    for (let i = 0; i < u.length; i += 3) expect(Math.hypot(u[i], u[i + 1], u[i + 2])).toBeCloseTo(1);
  });
});

describe("Attribute Transfer", () => {
  const source = () => {
    const s = createQuadPlane(1, 1, 1, 1);
    // A ramp in x on the source points.
    return setAttribute(s, "point", "heat", "float", s.positions.map((p) => p[0] + 0.5));
  };
  it("nearest surface interpolates barycentrically", () => {
    const target = createQuadPlane(1, 1, 4, 4);
    const r = transferAttributes(target, source(), { domain: "point", names: "*", method: "nearest-surface", maxDistance: 0, falloff: 0 });
    expect(r.written).toEqual(["heat"]);
    const heat = values(r.mesh, "point", "heat");
    target.positions.forEach((p, i) => expect(heat[i]).toBeCloseTo(p[0] + 0.5));
  });
  it("nearest point snaps, max distance + falloff blend", () => {
    const target = createQuadPlane(1, 1, 4, 4);
    const nearest = transferAttributes(target, source(), { domain: "point", names: "heat", method: "nearest-point", maxDistance: 0, falloff: 0 });
    expect(new Set(values(nearest.mesh, "point", "heat"))).toEqual(new Set([0, 1]));
    const far = target.positions.map((p) => [p[0], p[1], p[2] + 1] as [number, number, number]);
    const lifted = { ...target, positions: far };
    const none = transferAttributes(lifted, source(), { domain: "point", names: "heat", method: "nearest-surface", maxDistance: 0.5, falloff: 0 });
    expect(none.reached).toBe(0);
    const half = transferAttributes(lifted, source(), { domain: "point", names: "heat", method: "nearest-surface", maxDistance: 1.5, falloff: 1 });
    const h = values(half.mesh, "point", "heat");
    target.positions.forEach((p, i) => expect(h[i]).toBeCloseTo((p[0] + 0.5) * 0.5));
  });
  it("faces by the face hit, through the node, with a group and a world offset", () => {
    let src = createQuadPlane(2, 1, 2, 1);
    src = setAttribute(src, "face", "side", "int", [1, 2]);
    const srcObj = meshObj(src);
    srcObj.position.set(0, 0, 0.1);
    srcObj.updateMatrix();
    const target = setGroup(createQuadPlane(2, 1, 4, 1), "face", "g", [1, 1, 1, 0]);
    const { mesh } = run(ATTRIBUTE_TRANSFER_NODE, target, { domain: "face", names: "side", method: "nearest-face", group: "g" }, { source: srcObj });
    expect(values(mesh, "face", "side")).toEqual([1, 1, 2, 0]);
  });
  it("says when nothing is wired", () => {
    expect(run(ATTRIBUTE_TRANSFER_NODE, plane(1), {}).status).toMatch(/Wire a Source/);
  });
});

describe("Attribute from Texture", () => {
  it("samples a DataTexture at the corner UVs into Cd", () => {
    // 2×1 texture: left red, right blue.
    const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1);
    tex.needsUpdate = true;
    const src = createQuadPlane(1, 1, 2, 1);
    const { mesh } = run(ATTRIBUTE_FROM_TEXTURE_NODE, src, { channel: "rgb" }, { texture: tex });
    expect(mesh.faceColors).toBeDefined();
    // Sample at u = 0.25 (texel centre of the left texel) by scaling uv: every corner lands there.
    const left = run(ATTRIBUTE_FROM_TEXTURE_NODE, src, { uvScale: new THREE.Vector3(0, 0, 1), uvOffset: new THREE.Vector3(0.25, 0, 0) }, { texture: tex }).mesh;
    expect(left.faceColors![0]![0]).toEqual([1, 0, 0]);
    const lum = run(ATTRIBUTE_FROM_TEXTURE_NODE, src, { name: "lum", domain: "point", channel: "blue", uvScale: new THREE.Vector3(0, 0, 1), uvOffset: new THREE.Vector3(0.75, 0, 0) }, { texture: tex }).mesh;
    expect(values(lum, "point", "lum").every((v) => v === 1)).toBe(true);
  });
  it("notes a texture it cannot read", () => {
    const tex = new THREE.Texture();
    expect(run(ATTRIBUTE_FROM_TEXTURE_NODE, plane(1), {}, { texture: tex }).status).toMatch(/can't be read on the CPU/);
  });
  it("samplePixels: one-channel float and flipY", () => {
    const out = [0, 0, 0, 0];
    samplePixels({ data: new Float32Array([0.2, 0.8]), width: 1, height: 2, scale: 1 }, 0.5, 0.25, out);
    expect(out[0]).toBeCloseTo(0.2);
    expect(out[3]).toBe(1);
    samplePixels({ data: new Float32Array([0.2, 0.8]), width: 1, height: 2, scale: 1, topDown: true }, 0.5, 0.25, out);
    expect(out[0]).toBeCloseTo(0.8);
  });
});

describe("Measure", () => {
  it("area and perimeter per face, per piece", () => {
    const m = createQuadPlane(2, 1, 2, 1);
    expect(values(run(ATTRIBUTE_MEASURE_NODE, m, { measure: "perimeter" }).mesh, "face", "perimeter")).toEqual([4, 4]);
    const { mesh, status } = run(ATTRIBUTE_MEASURE_NODE, m, { measure: "area", perPiece: true });
    expect(status).toMatch(/stored as "area_m"/);
    expect(values(mesh, "face", "area_m")).toEqual([2, 2]);
  });
  it("curvature of a sphere ≈ 1/r, and centroid per piece", () => {
    const s = createQuadSphere(2, 8);
    const k = pointCurvature(s);
    const mean = k.reduce((a, b) => a + b, 0) / k.length;
    expect(mean).toBeGreaterThan(0.35);
    expect(mean).toBeLessThan(0.65);
    const c = measure(createQuadBox(), "centroid", true);
    for (const v of c.values) expect(Math.abs(v)).toBeLessThan(1e-9);
    const pts = run(ATTRIBUTE_MEASURE_NODE, createQuadBox(), { measure: "normal", domain: "point" }).mesh;
    expect(readAttribute(pts, "point", "normal")!.type).toBe("vec3");
  });
});

describe("Lists", () => {
  it("attribute to list: numbers, vectors, colours, group order", () => {
    const m = setGroup(setAttribute(plane(1), "point", "w", "float", [5, 6, 7, 8]), "point", "g", [0, 1, 0, 1]);
    expect(run(ATTRIBUTE_TO_LIST_NODE, m, { name: "w" }).out.list).toEqual([5, 6, 7, 8]);
    expect(run(ATTRIBUTE_TO_LIST_NODE, m, { name: "w", group: "g" }).out.list).toEqual([6, 8]);
    const P = run(ATTRIBUTE_TO_LIST_NODE, m, { name: "P" }).out.list as THREE.Vector3[];
    expect(P[0]).toBeInstanceOf(THREE.Vector3);
    expect(P[0].x).toBe(-0.5);
    const c = setAttribute(plane(1), "corner", "Cd", "color", new Array(12).fill(0.5));
    const cl = run(ATTRIBUTE_TO_LIST_NODE, c, { name: "Cd", domain: "corner" }).out.list as THREE.Color[];
    expect(cl[0]).toBeInstanceOf(THREE.Color);
  });
  it("list to attribute with mismatch modes", () => {
    const go = (mismatch: string) => values(run(LIST_TO_ATTRIBUTE_NODE, plane(1), { name: "w", mismatch }, { list: [1, 2] }).mesh, "point", "w");
    expect(go("repeat")).toEqual([1, 2, 1, 2]);
    expect(go("clamp")).toEqual([1, 2, 2, 2]);
    expect(go("zero")).toEqual([1, 2, 0, 0]);
    const v = run(LIST_TO_ATTRIBUTE_NODE, plane(1), { name: "v" }, { list: [new THREE.Vector3(1, 2, 3)] }).mesh;
    expect(readAttribute(v, "point", "v")!.type).toBe("vec3");
    const col = run(LIST_TO_ATTRIBUTE_NODE, plane(1), { name: "c" }, { list: [new THREE.Color(1, 0, 0)] }).mesh;
    expect(readAttribute(col, "point", "c")!.type).toBe("color");
    const pos = run(LIST_TO_ATTRIBUTE_NODE, plane(1), { name: "P" }, { list: [[0, 0, 5]] }).mesh;
    expect(pos.positions.every((p) => p[2] === 5)).toBe(true);
  });
  it("listToValues tolerates junk", () => {
    expect(Array.from(listToValues(["x", null, NaN, 3], [0, 1, 2, 3], 1, new Float64Array(4), "zero"))).toEqual([0, 0, 0, 3]);
  });
});

describe("Attribute Visualize", () => {
  it("paints a group and a ramp onto corner Cd and swaps in a vertex-colour material", () => {
    const m = setGroup(createQuadBox(), "face", "top", [1, 0, 0, 0, 0, 0]);
    const { mesh, out } = run(ATTRIBUTE_VISUALIZE_NODE, m, { name: "top", groupColor: new THREE.Color(1, 0, 0), baseColor: new THREE.Color(0, 0, 1) });
    expect(mesh.faceColors![0]![0]).toEqual([1, 0, 0]);
    expect(mesh.faceColors![1]![0]).toEqual([0, 0, 1]);
    expect(((out.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    const w = setAttribute(plane(1), "point", "w", "float", [0, 1, 2, 3]);
    const r = run(ATTRIBUTE_VISUALIZE_NODE, w, { name: "w" });
    expect(r.out.min).toBe(0);
    expect(r.out.max).toBe(3);
    expect(r.mesh.faceColors).toBeDefined();
  });
});

describe("pure helpers", () => {
  it("matchNames", () => {
    expect(matchNames("rest_* Cd", ["rest_a", "Cd", "N", "rest_b"])).toEqual(["rest_a", "Cd", "rest_b"]);
    expect(matchNames("*", ["a", "b"])).toEqual(["a", "b"]);
    expect(matchNames("", ["a"])).toEqual([]);
  });
  it("blurValues converges to the mean on a connected graph", () => {
    const adj = elementAdjacency(createQuadBox(), "point");
    const vals = [1, 0, 0, 0, 0, 0, 0, 0];
    const out = blurValues(vals, 1, adj, 200, 0.5);
    for (const v of out) expect(v).toBeCloseTo(1 / 8, 3);
  });
});
