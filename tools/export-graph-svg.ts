/**
 * export-graph-svg.ts — CLI: rend un .tsuji (ou un Graph JSON brut) en SVG,
 * sans ouvrir l'app. Même moteur que le bouton "Export Graph (SVG)" du Share
 * menu (src/shared/export/graphSvg.ts) — utile pour produire en masse les
 * schémas de documentation (voir docs_vault/Cours_Motion_Design).
 *
 * Usage :
 *   node tools/run-export-graph-svg.mjs <project.tsuji> [out.svg] [--canvas N] [--title "..."]
 *
 * Un fichier multi-canvas exporte le canvas actif (ou --canvas N, 0-indexé) ;
 * un fichier single-graph (sauvegardé avant l'existence des canvases) exporte
 * tel quel.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deserializeProject } from "../src/shared/graph/storage";
import { DEFAULT_REGISTRY } from "../src/shared/graph/nodes";
import { renderGraphToSvg } from "../src/shared/export/graphSvg";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let canvas: number | undefined;
  let title: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--canvas") title === undefined && (canvas = Number(argv[++i]));
    else if (argv[i] === "--title") title = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, canvas, title };
}

function main() {
  const { positional, canvas, title } = parseArgs(process.argv.slice(2));
  const [inputPath, outputPath] = positional;
  if (!inputPath) {
    console.error("Usage: node tools/run-export-graph-svg.mjs <project.tsuji> [out.svg] [--canvas N] [--title \"...\"]");
    process.exit(1);
  }

  const json = readFileSync(inputPath, "utf-8");
  const project = deserializeProject(json, DEFAULT_REGISTRY);
  const canvasIndex = canvas ?? project.activeCanvas;
  const graph = project.canvases[canvasIndex];
  if (!graph) {
    console.error(`Canvas ${canvasIndex} not found — file has ${project.canvases.length} canvas(es).`);
    process.exit(1);
  }

  const base = inputPath.replace(/\.[^./\\]+$/, "").split(/[\/\\]/).pop() ?? "graph";
  const svg = renderGraphToSvg(graph, DEFAULT_REGISTRY, { title: title ?? base });
  const out = outputPath ?? `${base}.svg`;
  writeFileSync(out, svg, "utf-8");
  console.log(`Wrote ${out} (${graph.nodes.length} nodes, ${graph.connections.length} connections)`);
}

main();
