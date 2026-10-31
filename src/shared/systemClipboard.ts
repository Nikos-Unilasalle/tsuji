import { isTauri } from "./isTauri";

/**
 * Plain-text access to the OS clipboard.
 *
 * The desktop app goes through tauri-plugin-clipboard-manager: WKWebView's
 * navigator.clipboard.readText pops a "Paste" confirmation bubble on every
 * read, and its copy/paste events only fire while something editable has
 * focus. The browser build uses navigator.clipboard (writeText needs no
 * permission inside a user gesture; reads go through the `paste` event where
 * possible — see GraphEditor — which needs none either).
 *
 * Both never throw: a denied permission or a missing API just reads as null /
 * writes as false, and callers fall back to the in-memory clipboard.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (isTauri()) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return true;
    }
    // Synchronously, while the Cmd/Ctrl+C keypress still counts as a user
    // gesture: unlike navigator.clipboard this needs no clipboard-write
    // permission, which embedded browsers and some policies deny.
    if (copyViaCopyEvent(text)) return true;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn("tsuji: could not write to the system clipboard", err);
  }
  return false;
}

function copyViaCopyEvent(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  let written = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    written = true;
  };
  document.addEventListener("copy", onCopy, true);
  try {
    document.execCommand("copy");
  } catch {
    // Not allowed outside a user gesture.
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
  return written;
}

export async function readClipboardText(): Promise<string | null> {
  try {
    if (isTauri()) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    }
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {
    // Permission denied, document not focused, or non-text content.
  }
  return null;
}
