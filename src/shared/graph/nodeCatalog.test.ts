import * as THREE from "three";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORY_FAMILY, CATEGORY_LABEL, CATEGORY_ORDER, FAMILY_ORDER, type NodeCategory } from "./categories";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE, GROUP_TYPE } from "./groups";
import { nodeMatches } from "./nodes/nodeKeywords";
import { resolveSceneRoots } from "./sceneRoots";
import type { Graph, NodeDefinition } from "./types";

/*
 * The node catalogue as the palette shows it: every node filed in a known
 * category, every category with something in it, no two offered nodes with
 * the same name, and nothing in the engine that decides behaviour from a
 * category (re-filing a node must never change what it does).
 */

const all = [...DEFAULT_REGISTRY.values()] as NodeDefinition[];
const offered = all.filter((d) => !d.hidden && d.type !== GROUP_TYPE && d.type !== GROUP_INPUT_TYPE && d.type !== GROUP_OUTPUT_TYPE);

describe("node catalogue", () => {
  it("files every node in a known category, every category in a family", () => {
    const unknown = all.filter((d) => !CATEGORY_ORDER.includes(d.category)).map((d) => `${d.type}: ${d.category}`);
    expect(unknown).toEqual([]);
    for (const c of CATEGORY_ORDER) expect(FAMILY_ORDER).toContain(CATEGORY_FAMILY[c]);
  });

  it("leaves no category empty in the palette", () => {
    const empty = CATEGORY_ORDER.filter((c) => !offered.some((d) => d.category === c));
    expect(empty).toEqual([]);
  });

  it("orders categories alphabetically inside each family", () => {
    for (const family of FAMILY_ORDER) {
      const labels = CATEGORY_ORDER.filter((c) => CATEGORY_FAMILY[c] === family).map((c) => CATEGORY_LABEL[c]);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    }
  });

  it("offers no two nodes under the same name", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const d of offered) {
      const key = d.label.trim().toLowerCase();
      if (seen.has(key)) clashes.push(`"${d.label}": ${seen.get(key)} / ${d.type}`);
      else seen.set(key, d.type);
    }
    expect(clashes).toEqual([]);
  });

  it("finds nodes by their Blender / Houdini names", () => {
    const find = (q: string) => offered.filter((d) => nodeMatches(d, q, CATEGORY_LABEL[d.category as NodeCategory])).map((d) => d.type);
    expect(find("wrangle")).toContain("attribute/expression");
    expect(find("shrinkwrap")).toContain("modeling/ray-project");
    expect(find("vdb remesh")).toContain("volume/voxel-remesh");
  });

  it("gives every Group field the group-syntax help", () => {
    const missing: string[] = [];
    for (const d of offered) {
      for (const f of d.paramFields ?? []) {
        if (f.kind === "text" && f.id === "group" && f.help !== "group") missing.push(`${d.type}.${f.id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("never decides behaviour from a category in engine or editor code", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = readFileSync(path, "utf8");
          if (/\.category\s*[!=]==\s*["']|\.has\(\w+\.category\)/.test(text)) offenders.push(path);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    // The palette groups by category — that is what categories are for.
    expect(offenders.filter((p) => !p.endsWith("NodePalette.tsx"))).toEqual([]);
  });
});

describe("screen / object effects", () => {
  const dualTone = DEFAULT_REGISTRY.get("postprocess/duotone")!;
  const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());

  it("is one node offered, its object-only original kept hidden for old files", () => {
    expect(dualTone.label).toBe("Dual Tone");
    expect(DEFAULT_REGISTRY.get("modifier/duotone")?.hidden).toBe(true);
  });

  it("switches sockets and evaluation on Apply To", () => {
    const screen = { ...dualTone.defaultParams };
    const object = { ...dualTone.defaultParams, applyTo: "object" };
    expect(dualTone.dynamicOutputs!([], undefined, screen).map((s) => s.id)).toEqual(["effect"]);
    expect(dualTone.dynamicOutputs!([], undefined, object).map((s) => s.id)).toContain("geometry");
    expect(dualTone.dynamicInputs!([], undefined, object).find((s) => s.id === "geometry")?.owns).toBe(true);
    const out = dualTone.evaluate({ geometry: mesh() }, object, { time: 0, step: 0, nodeId: "dt-object" });
    expect(out.geometry).toBeInstanceOf(THREE.Object3D);
    const fx = dualTone.evaluate({}, screen, { time: 0, step: 0, nodeId: "dt-screen" });
    expect(fx.effect).toBeTruthy();
  });

  it("on an object, draws the styled object instead of the source", () => {
    const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, params, position: { x: 0, y: 0 } });
    const graph: Graph = {
      nodes: [node("box", "object/box"), node("fx", "postprocess/duotone", { ...dualTone.defaultParams, applyTo: "object" })],
      connections: [{ id: "c", fromNode: "box", fromSocket: "geometry", toNode: "fx", toSocket: "geometry" }],
      keyframes: {},
      markers: [],
      exposedParams: [],
    } as unknown as Graph;
    expect(resolveSceneRoots(graph, DEFAULT_REGISTRY)).toEqual(["fx"]);
  });
});
