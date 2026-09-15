import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "./storage";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { evaluateGraph } from "./evaluate";
import { initBvhRaycast } from "../three/bvh";
import { Connection, Graph, NodeDefinition } from "./types";
import { DEMO_CATALOG } from "../demos";

// Lives under public/ (not a top-level demos/ folder) so Vite ships these
// files verbatim into dist and the in-app Demos menu can fetch() them at
// runtime — a top-level demos/ folder is source-tree-only and isn't bundled.
const DEMO_DIR = join(process.cwd(), "public/demos");

/**
 * The socket ids a node instance actually exposes, dynamic ones resolved.
 *
 * Merge grows `in1` once two wires are attached and Logic Bridge retypes
 * itself off what it is fed, so the static `inputs`/`outputs` arrays are only
 * half the answer — a connection into a grown socket is perfectly valid and
 * must not be reported as a typo.
 */
function socketIds(
  def: NodeDefinition,
  side: "inputs" | "outputs",
  connections: Connection[],
): Set<string> {
  const dynamic = side === "inputs" ? def.dynamicInputs : def.dynamicOutputs;
  const sockets = dynamic ? dynamic(connections) ?? def[side] : def[side];
  return new Set(sockets.map((s) => s.id));
}

/**
 * Every wire in the file on disk lands on a socket that exists.
 *
 * Deliberately reads the *raw* JSON rather than the deserialized graph:
 * `deserializeProject` runs `pruneDanglingConnections`, which quietly drops
 * any wire naming a socket that isn't there (it exists so a retired socket
 * can't strand old saves). That is right for loading a file, and useless as
 * a check on one we just hand-authored — the typo is gone before anything
 * can complain about it, and the demo opens with a wire silently missing.
 */
function assertSocketsExist(raw: string, file: string): void {
  const data = JSON.parse(raw);
  const canvases: Graph[] = Array.isArray(data.canvases) ? data.canvases : [data];

  for (const canvas of canvases) {
    const nodes = canvas.nodes ?? [];
    const connections: Connection[] = canvas.connections ?? [];

    for (const connection of connections) {
      const from = nodes.find((n) => n.id === connection.fromNode);
      const to = nodes.find((n) => n.id === connection.toNode);
      expect(from, `${file}: connection "${connection.id}" names no source node`).toBeDefined();
      expect(to, `${file}: connection "${connection.id}" names no target node`).toBeDefined();

      const fromDef = DEFAULT_REGISTRY.get(from!.type);
      const toDef = DEFAULT_REGISTRY.get(to!.type);
      // Unknown node types come from legacy demos — skipped, same as below.
      if (!fromDef || !toDef) continue;

      const outgoing = connections.filter((c) => c.toNode === connection.fromNode);
      const incoming = connections.filter((c) => c.toNode === connection.toNode);

      expect(
        [...socketIds(fromDef, "outputs", outgoing)],
        `${file}: ${from!.type} has no output socket "${connection.fromSocket}"`,
      ).toContain(connection.fromSocket);
      expect(
        [...socketIds(toDef, "inputs", incoming)],
        `${file}: ${to!.type} has no input socket "${connection.toSocket}"`,
      ).toContain(connection.toSocket);
    }
  }
}

describe("demo catalog", () => {
  const onDisk = new Set(readdirSync(DEMO_DIR).filter((f) => f.endsWith(".tsuji")));
  const listed = DEMO_CATALOG.flatMap((c) => c.demos.map((d) => d.file));

  // A catalog entry naming a file that isn't there fails at runtime as
  // "not valid JSON", not as a 404: the dev server and the built app both
  // answer an unknown path with index.html, so the menu item just breaks
  // with a baffling message. Cheaper to catch here.
  it.each(listed)("%s exists in public/demos", (file) => {
    expect(onDisk).toContain(file);
  });

  it("lists every demo file", () => {
    // setup.tsuji is the shared base copied into each demo, not a demo.
    const unlisted = [...onDisk].filter((f) => f !== "setup.tsuji" && !listed.includes(f));
    expect(unlisted, "demo files missing from DEMO_CATALOG").toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(listed).toEqual([...new Set(listed)]);
  });
});

describe("demo .tsuji files", () => {
  const files = readdirSync(DEMO_DIR).filter((f) => f.endsWith(".tsuji"));
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    it(`loads and evaluates ${file}`, () => {
      initBvhRaycast();
      const text = readFileSync(join(DEMO_DIR, file), "utf8");
      // deserializeProject, not deserializeGraph: saving a demo from the app
      // writes the multi-canvas project shape, and a demo re-saved that way
      // used to fail this test on its format rather than on its content.
      const project = deserializeProject(text, DEFAULT_REGISTRY);
      const graph = project.canvases.find((c) => c.nodes.length > 0) ?? project.canvases[0];
      expect(graph.nodes.length).toBeGreaterThan(0);

      assertSocketsExist(text, file);

      const results = evaluateGraph(graph, DEFAULT_REGISTRY, {
        time: 1.2,
        step: 36,
        nodeId: "demo-check",
        renderSize: { width: 1920, height: 1080 },
        currentFrame: 36,
        keyframes: graph.keyframes,
      } as never);

      // Unknown types come from legacy demos and are skipped.
      for (const node of graph.nodes) {
        if (!DEFAULT_REGISTRY.has(node.type)) continue;
        const res = results.get(node.id);
        expect(res, `${file}: node ${node.id} (${node.type}) produced no result`).toBeDefined();
        // A node whose evaluate threw is stored as a bare {} (see evaluate.ts),
        // which `toBeDefined` happily accepts — so "it ran" has to be tested
        // on the marker the success path adds, not on the result existing.
        expect(
          res,
          `${file}: node ${node.id} (${node.type}) threw during evaluate`,
        ).toHaveProperty("__evaluatedInputs");
      }
    }, 15_000);
  }
});
