import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { walkNodes } from "./groups";
import { DEFAULT_REGISTRY } from "./nodes";
import { isTauri } from "./storage";
import { Graph } from "./types";

/**
 * Every "file" param field (CSV Reader's filePath, OBJ Model's filePath/
 * texturePath/normalMapPath, Image Texture's filePath, Audio Player's
 * filePath, ...) only ever populates its node's actual data — parsed CSV
 * rows, a decoded THREE.Texture, a loaded THREE.OBJLoader group, an audio
 * Blob URL — via its `onLoaded` callback, fired from the file picker
 * button (see ParamPanel's fileField). serializeGraph only round-trips the
 * path string through the saved .ovm, never that data (see storage.ts),
 * and it all lives in module-level caches that don't survive a reload.
 * So a freshly opened project has every file-backed node's path pointing
 * at the right file but nothing actually loaded: its geometry/texture/
 * audio evaluates to whatever empty fallback the node uses, even though
 * the param panel's file button still shows the correct filename.
 *
 * Called once after a graph loads, this re-reads every such field's file
 * from disk and re-fires its own onLoaded — the exact same path a manual
 * re-pick takes — so every node's cache is populated before the first
 * tick() evaluates the graph. Generic over node type: it drives whatever
 * `dynamicParamFields` + `onLoaded` a node already defines for its own
 * file-picking, rather than special-casing CSV/OBJ/texture/audio here.
 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "bmp", "hdr", "exr", "tif", "tiff",
  "mp3", "wav", "ogg", "flac", "m4a", "aac",
  "glb", "ply", "mp4", "ttf", "otf", "woff",
]);

/**
 * Result of re-reading a project's file-backed nodes from disk.
 * `attempted` is how many files were actually read (0 when the project has no
 * file nodes, or we're running in a plain browser). `failed` counts the reads
 * that errored. An app that wants the UI to reflect that a reload *happened*
 * should refresh whenever `attempted > 0`, regardless of `failed` — a failed
 * read still "did something" and should clear any loading state; treating a
 * zero-job graph the same as an aborted one was the confusion the old boolean
 * return caused.
 */
export interface RehydrateFileResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

/**
 * Folder of the project file last opened (desktop only). A file param that is not an absolute path —
 * `assets/photo.png` — is read relative to it, so a project and its `assets/` folder can move together.
 */
let projectDirectory: string | null = null;

export function setProjectDirectory(projectFilePath: string | null): void {
  const cut = projectFilePath ? Math.max(projectFilePath.lastIndexOf("/"), projectFilePath.lastIndexOf("\\")) : -1;
  projectDirectory = projectFilePath && cut >= 0 ? projectFilePath.slice(0, cut) : null;
}

export function resolveProjectPath(path: string): string {
  const absolute = path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
  if (absolute || !projectDirectory) return path;
  return `${projectDirectory}/${path.replace(/^\.\//, "")}`;
}

/**
 * A path the app can fetch itself — an http(s) URL, or a file under the bundled `demos/` folder — as opposed to a file on
 * the user's disk. The browser build cannot read the disk, but it can load these, so a project that names its images this
 * way opens with them.
 */
export function isFetchablePath(path: string): boolean {
  return /^(https?:\/\/|\.?\/?demos\/)/.test(path);
}

async function fetchFile(path: string, binary: boolean): Promise<Uint8Array | string> {
  const res = await fetch(new URL(path.replace(/^\//, ""), document.baseURI).href);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return binary ? new Uint8Array(await res.arrayBuffer()) : res.text();
}

export async function rehydrateFileNodesFromDisk(graph: Graph): Promise<RehydrateFileResult> {
  const desktop = isTauri();

  const jobs: Promise<boolean>[] = [];
  // Interiors included: a CSV Reader or a GLTF loader inside a group has the
  // same path in its params and the same nothing-in-memory problem on load.
  for (const node of walkNodes(graph)) {
    const def = DEFAULT_REGISTRY.get(node.type);
    const fields = def?.dynamicParamFields?.(node) ?? [];
    for (const field of fields) {
      if (field.kind !== "file" || !field.onLoaded) continue;
      const path = node.params?.[field.id];
      if (typeof path !== "string" || !path) continue;
      const fetchable = isFetchablePath(path);
      // A plain browser can only load what the app serves; a disk path needs the desktop app.
      if (!fetchable && !desktop) continue;
      const onLoaded = field.onLoaded;

      jobs.push(
        (async () => {
          try {
            const ext = path.split(".").pop()?.toLowerCase() ?? "";
            const binary = BINARY_EXTENSIONS.has(ext);
            const real = resolveProjectPath(path);
            const content = fetchable ? await fetchFile(path, binary) : binary ? await readFile(real) : await readTextFile(real);
            onLoaded(node.id, path, content);
            return true;
          } catch (err) {
            console.error(`Failed to reload file for node ${node.id} (${field.id}) from ${path}:`, err);
            return false;
          }
        })(),
      );
    }
  }

  const results = await Promise.all(jobs);
  return {
    attempted: results.length,
    succeeded: results.filter(Boolean).length,
    failed: results.length - results.filter(Boolean).length,
  };
}
