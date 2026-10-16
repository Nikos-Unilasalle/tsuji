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

/** Makes more files readable without forgetting the ones already known: the companions of something just dropped. */
export function addBrowserFiles(files: { path: string; file: File }[]): void {
  for (const { path, file } of files) folderFiles.set(normalise(path), file);
}

/**
 * Something that needs files a browser cannot reach (a .gltf with its .bin and textures beside it) asks for the folder
 * the same way a project opened with missing files does: the top bar shows the "Choose project folder" prompt, and the
 * files are read from the folder once it is chosen. `pick` asks the top bar to open the folder picker straight away —
 * only valid from a click.
 */
export interface FolderRequest {
  /** How many files are missing, for the prompt. */
  needed: number;
  pick: boolean;
}

const folderListeners = new Set<(request: FolderRequest) => void>();

export function onFolderRequest(listener: (request: FolderRequest) => void): () => void {
  folderListeners.add(listener);
  return () => {
    folderListeners.delete(listener);
  };
}

export function requestProjectFolder(request: FolderRequest): void {
  for (const listener of folderListeners) listener(request);
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

/**
 * Everything in a drop, folders included, as relative path -> File. The entries are taken from the event up front: a
 * DataTransfer is emptied as soon as the handler yields, and walking a dropped folder is asynchronous.
 */
export async function filesFromDrop(transfer: DataTransfer): Promise<{ path: string; file: File }[]> {
  const entries = Array.from(transfer.items ?? [])
    .map((item) => (item.kind === "file" ? (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null : null));
  const loose = Array.from(transfer.files ?? []);
  const out: { path: string; file: File }[] = [];

  const readEntry = async (entry: FileSystemEntry, prefix: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)));
      if (file) out.push({ path: `${prefix}${entry.name}`, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands back a batch at a time and signals the end with an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (batch.length === 0) break;
        for (const child of batch) if (!child.name.startsWith(".")) await readEntry(child, `${prefix}${entry.name}/`, depth + 1);
      }
    }
  };

  const known = entries.filter((e): e is FileSystemEntry => e !== null);
  if (known.length === 0) return loose.map((file) => ({ path: file.name, file }));
  for (const entry of known) await readEntry(entry, "", 0);
  return out;
}
