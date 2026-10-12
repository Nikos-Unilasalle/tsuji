/**
 * Files a browser can read for a project: the ones in a folder the user chose.
 *
 * A web page cannot open `assets/photo.png` by path. What it can do is ask the user for the project's folder — once —
 * and read from it. The folder is walked into a table of relative path -> File, and a file param's path is looked up in it
 * the way a desktop app would read it from disk.
 */

const folderFiles = new Map<string, File>();

const normalise = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

export function setBrowserFolder(files: { path: string; file: File }[]): void {
  folderFiles.clear();
  for (const { path, file } of files) folderFiles.set(normalise(path), file);
}

export function clearBrowserFolder(): void {
  folderFiles.clear();
}

/**
 * The file a param path points at: an exact match first, then the chosen folder being a parent or a child of the
 * project's own (`assets/a.png` found as `proj/assets/a.png`), then — for an absolute path from another machine — the
 * one file with that name.
 */
export function findBrowserFile(path: string): File | null {
  const wanted = normalise(path);
  const exact = folderFiles.get(wanted);
  if (exact) return exact;
  for (const [key, file] of folderFiles) {
    if (key.endsWith(`/${wanted}`)) return file;
  }
  const name = wanted.split("/").pop() ?? wanted;
  const sameName = [...folderFiles].filter(([key]) => key === name || key.endsWith(`/${name}`));
  return sameName.length === 1 ? sameName[0][1] : null;
}

const MAX_FILES = 5000;
const MAX_DEPTH = 6;

/** The File System Access API (Chromium): one prompt, the folder stays readable. */
async function walkDirectory(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  out: { path: string; file: File }[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [name, handle] of entries) {
    if (out.length >= MAX_FILES) return;
    if (name.startsWith(".")) continue;
    if (handle.kind === "directory") await walkDirectory(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, depth + 1, out);
    else out.push({ path: `${prefix}${name}`, file: await (handle as FileSystemFileHandle).getFile() });
  }
}

/** Every browser: an <input webkitdirectory> hands back the whole tree with each file's relative path. */
function pickWithInput(): Promise<{ path: string; file: File }[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.multiple = true;
    input.onchange = () => {
      const list = [...(input.files ?? [])];
      resolve(
        list.length
          ? list.slice(0, MAX_FILES).map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }))
          : null,
      );
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Asks the user for the project folder and makes its files readable. Must run from a click. Resolves to the number of
 * files found, or 0 when the user cancelled.
 */
export async function pickProjectFolder(): Promise<number> {
  let files: { path: string; file: File }[] | null = null;
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  try {
    if (picker) {
      const dir = await picker.call(window, { mode: "read" });
      files = [];
      await walkDirectory(dir, "", 0, files);
    } else {
      files = await pickWithInput();
    }
  } catch (err) {
    // A cancelled picker rejects with AbortError; anything else is a real failure worth surfacing.
    if ((err as Error).name !== "AbortError") throw err;
    return 0;
  }
  if (!files || files.length === 0) return 0;
  setBrowserFolder(files);
  return files.length;
}
