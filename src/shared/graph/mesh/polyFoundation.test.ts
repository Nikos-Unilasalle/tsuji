import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createQuadBox, createQuadPlane, extrudeFaces, quadMeshSignature, type PolyMesh } from "../quadMesh";
import { domainSize, facePieces, readAttribute, setAttribute, setGroup, listGroups, normalizeAttributes } from "./polyAttributes";
import { evaluateGroup, maskIndices, parseGroupExpr } from "./groupExpr";
import { promoteMask, promoteValues } from "./promote";
import { propagateAttributes, withAttributes } from "./propagate";
import { polyMeshFromGeometry, polyMeshToGeometry, transferByNearest } from "./polyIO";
import { PointTree } from "./spatial";

const box = () => createQuadBox(1, 1, 1);

describe("polyAttributes", () => {
  it("reads built-ins on every domain", () => {
    const m = box();
    expect(domainSize(m, "point")).toBe(8);
    expect(domainSize(m, "face")).toBe(6);
    expect(domainSize(m, "edge")).toBe(12);
    expect(domainSize(m, "corner")).toBe(24);
    const area = readAttribute(m, "face", "area")!;
    for (const a of area.values) expect(a).toBeCloseTo(1);
    const angle = readAttribute(m, "edge", "angle")!;
    for (const a of angle.values) expect(a).toBeCloseTo(90);
    const n = readAttribute(m, "point", "N")!;
    expect(Math.hypot(n.values[0], n.values[1], n.values[2])).toBeCloseTo(1);
  });

  it("stores, groups and normalises", () => {
    let m = setGroup(box(), "face", "top", [0, 0, 1, 0, 0, 0]);
    m = setAttribute(m, "point", "w", "float", [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(listGroups(m)).toEqual([{ domain: "face", name: "top" }]);
    expect(Array.from(readAttribute(m, "point", "w")!.values)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const grown: PolyMesh = { ...m, faces: [...m.faces, [0, 1, 2]] };
    expect(normalizeAttributes(grown).attributes!.face!.top.data).toHaveLength(7);
  });

  it("refuses bad names and writes P", () => {
    const m = box();
    expect(setAttribute(m, "point", "1bad", "float", [])).toBe(m);
    const moved = setAttribute(m, "point", "P", "vec3", new Array(24).fill(0));
    expect(moved.positions[3]).toEqual([0, 0, 0]);
  });

  it("finds pieces", () => {
    const a = box();
    const b = box();
    const two: PolyMesh = { positions: [...a.positions, ...b.positions], faces: [...a.faces, ...b.faces.map((f) => f.map((v) => v + 8))] };
    expect(new Set(facePieces(two))).toEqual(new Set([0, 1]));
  });

  it("signature reacts to attributes", () => {
    const m = box();
    expect(quadMeshSignature(setGroup(m, "face", "g", [1, 0, 0, 0, 0, 0]))).not.toBe(quadMeshSignature(m));
  });
});

describe("group expressions", () => {
  const m = setGroup(setGroup(box(), "face", "a", [1, 1, 0, 0, 0, 0]), "face", "b", [0, 1, 1, 0, 0, 0]);
  const sel = (e: string) => maskIndices(evaluateGroup(m, "face", e).mask);

  it("parses operators", () => {
    expect(() => parseGroupExpr("a & (b | !c)")).not.toThrow();
    expect(() => parseGroupExpr("a & (")).toThrow();
  });
  it("evaluates", () => {
    expect(sel("")).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sel("*")).toHaveLength(6);
    expect(sel("a")).toEqual([0, 1]);
    expect(sel("a b")).toEqual([0, 1, 2]);
    expect(sel("a | b")).toEqual([0, 1, 2]);
    expect(sel("a & b")).toEqual([1]);
    expect(sel("a ^ b")).toEqual([0, 2]);
    expect(sel("!a")).toEqual([2, 3, 4, 5]);
    expect(sel("0-5:2")).toEqual([0, 2, 4]);
    expect(sel("@sides==4")).toHaveLength(6);
    expect(sel("*")).toHaveLength(6);
  });
  it("wildcards and unknown names", () => {
    const r = evaluateGroup(m, "face", "zzz");
    expect(r.unknown).toEqual(["zzz"]);
    expect(maskIndices(r.mask)).toEqual([]);
    const w = setGroup(m, "face", "rim_a", [0, 0, 0, 1, 0, 0]);
    expect(maskIndices(evaluateGroup(w, "face", "rim_*").mask)).toEqual([3]);
  });
  it("selects by position test", () => {
    const top = maskIndices(evaluateGroup(box(), "point", "@P.y>0").mask);
    expect(top).toHaveLength(4);
  });
  it("selects everything on a parse error", () => {
    const r = evaluateGroup(m, "face", "a & (");
    expect(r.error).toBeTruthy();
    expect(maskIndices(r.mask)).toHaveLength(6);
  });
  it("promotes point groups to faces (all) and back (any)", () => {
    const pts = box();
    const topPoints = evaluateGroup(pts, "point", "@P.y>0").mask;
    const faces = promoteMask(pts, "point", "face", topPoints);
    expect(maskIndices(faces)).toHaveLength(1);
    const back = promoteMask(pts, "face", "point", faces);
    expect(maskIndices(back)).toHaveLength(4);
    const avg = promoteValues(pts, "point", "face", Array.from({ length: 8 }, (_, i) => i), 1);
    expect(avg).toHaveLength(6);
  });
});

describe("propagation", () => {
  it("survives extrusion", () => {
    const src = setGroup(setAttribute(box(), "point", "w", "float", [1, 1, 1, 1, 2, 2, 2, 2]), "face", "g", [1, 0, 0, 0, 0, 0]);
    const out = withAttributes(src, (m) => extrudeFaces(m, [0], 0.5).mesh);
    expect(out.attributes!.point!.w.data).toHaveLength(out.positions.length);
    expect(out.attributes!.face!.g.data).toHaveLength(out.faces.length);
    // the extruded cap keeps the group
    expect(out.attributes!.face!.g.data[0]).toBe(1);
  });
  it("uses explicit maps", () => {
    const src = setGroup(box(), "face", "g", [1, 0, 0, 0, 0, 0]);
    const out = propagateAttributes(src, { positions: src.positions, faces: [src.faces[0]] }, { face: [0] });
    expect(out.attributes!.face!.g.data).toEqual([1]);
  });
});

describe("polyIO", () => {
  it("round-trips through geometry and survives a deformer clone", () => {
    const mesh = setGroup(createQuadPlane(2, 2, 4, 4), "face", "g", new Array(16).fill(0).map((_, i) => (i < 4 ? 1 : 0)));
    const geometry = polyMeshToGeometry(mesh);
    expect(polyMeshFromGeometry(geometry)).toBe(geometry.userData.quadMesh);

    const deformed = geometry.clone();
    const pos = deformed.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + 1);
    pos.needsUpdate = true;
    const back = polyMeshFromGeometry(deformed)!;
    expect(back.faces).toEqual(mesh.faces);
    expect(back.attributes!.face!.g.data.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(back.positions[0][1]).toBeCloseTo(mesh.positions[0][1] + 1);
  });
  it("re-imports a plain geometry", () => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const m = polyMeshFromGeometry(g)!;
    expect(m.faces.length).toBe(6);
  });
  it("transfers by nearest", () => {
    const src = setGroup(box(), "face", "g", [1, 0, 0, 0, 0, 0]);
    const out = transferByNearest(src, box());
    expect(out.attributes!.face!.g.data).toEqual([1, 0, 0, 0, 0, 0]);
  });
});

describe("PointTree", () => {
  it("matches brute force", () => {
    const pts: [number, number, number][] = [];
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 500; i++) pts.push([rnd(), rnd(), rnd()]);
    const tree = new PointTree(pts);
    for (let q = 0; q < 50; q++) {
      const p = [rnd(), rnd(), rnd()];
      let best = -1, bd = Infinity;
      pts.forEach((x, i) => {
        const d = (x[0] - p[0]) ** 2 + (x[1] - p[1]) ** 2 + (x[2] - p[2]) ** 2;
        if (d < bd) (bd = d), (best = i);
      });
      expect(tree.nearest(p[0], p[1], p[2]).index).toBe(best);
      const k = tree.kNearest(p[0], p[1], p[2], 5);
      expect(k[0].index).toBe(best);
      expect(k).toHaveLength(5);
      const r = tree.within(p[0], p[1], p[2], 0.3);
      const brute = pts.map((x, i) => [i, (x[0] - p[0]) ** 2 + (x[1] - p[1]) ** 2 + (x[2] - p[2]) ** 2] as const).filter(([, d]) => d <= 0.09);
      expect(r.length).toBe(brute.length);
    }
  });
});
