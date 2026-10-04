// Bundles tools/export-graph-svg.ts with esbuild (Tsuji's own node_modules,
// no extra dependency — esbuild ships transitively via vite) and runs it in
// Node. TS is compiled on the fly; nothing is written to disk except the
// requested SVG(s). See export-graph-svg.ts for usage.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(__dirname, "export-graph-svg.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

const bundle = result.outputFiles[0].text;
const tmpEntry = join(__dirname, ".export-graph-svg.bundle.mjs");
const { writeFileSync, unlinkSync } = await import("node:fs");
writeFileSync(tmpEntry, bundle);
try {
  await import(`file://${tmpEntry}?t=${Date.now()}`);
} finally {
  unlinkSync(tmpEntry);
}
