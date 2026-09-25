import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DEFAULT_REGISTRY } from "./graph/nodes";
import { rehydrateGraphParams } from "./graph/rehydrateParams";
import { Graph } from "./graph/types";
import { isTauri } from "./isTauri";

// Re-exported so existing `from "../ipc"` importers keep working.
export { isTauri };

export async function maximizeMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const appWindow = getCurrentWindow();
    await appWindow.maximize();
  } catch (err) {
    console.warn("Could not maximize window:", err);
  }
}

export interface MonitorInfo {
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  isPrimary: boolean;
}

let browserChannel: BroadcastChannel | null = null;
function getBrowserChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || isTauri()) return null;
  if (!browserChannel) {
    browserChannel = new BroadcastChannel("tsuji_ipc");
  }
  return browserChannel;
}

export async function listMonitors(): Promise<MonitorInfo[]> {
  if (!isTauri()) {
    return [
      {
        name: "Navigateur",
        width: window.innerWidth || 1280,
        height: window.innerHeight || 720,
        x: 0,
        y: 0,
        isPrimary: true,
      },
    ];
  }
  return invoke<MonitorInfo[]>("list_monitors");
}

export async function openOutputWindow(monitor: MonitorInfo, fullscreen: boolean): Promise<void> {
  if (!isTauri()) {
    const url = window.location.origin + window.location.pathname + "#/output";
    window.open(url, "tsujiOutput", "width=1280,height=720,resizable=yes");
    return;
  }
  await invoke("open_output_window", {
    monitorX: monitor.x,
    monitorY: monitor.y,
    monitorWidth: monitor.width,
    monitorHeight: monitor.height,
    fullscreen,
  });
}

export async function closeOutputWindow(): Promise<void> {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    ch?.postMessage({ event: OUTPUT_CLOSED_EVENT });
    return;
  }
  await invoke("close_output_window");
}

/**
 * The 2D View window — a plain resizable window, no monitor targeting or
 * fullscreen (unlike Output, which is projector-facing). Same "open or
 * focus" Rust-side behavior as open_output_window; see view2d_window.rs.
 */
export async function openView2DWindow(): Promise<void> {
  if (!isTauri()) {
    const url = window.location.origin + window.location.pathname + "#/view2d";
    window.open(url, "tsujiView2D", "width=960,height=540,resizable=yes");
    return;
  }
  await invoke("open_view2d_window");
}

export async function closeView2DWindow(): Promise<void> {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    ch?.postMessage({ event: VIEW2D_CLOSED_EVENT });
    return;
  }
  await invoke("close_view2d_window");
}

const GRAPH_UPDATE_EVENT = "graph:update";
const OUTPUT_READY_EVENT = "output:ready";
const OUTPUT_CLOSED_EVENT = "output:closed";
const VIEW2D_CLOSED_EVENT = "view2d:closed";

export interface GraphPayload {
  graph: Graph;
  epochMs: number;
  calibratingNodeId: string | null;
  previewCamera: PreviewCameraPose | null;
}

export interface PreviewCameraPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export function startBroadcasting(getPayload: () => GraphPayload): () => void {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    const handler = (ev: MessageEvent) => {
      if (ev.data?.event === OUTPUT_READY_EVENT) {
        broadcastGraph(getPayload());
      }
    };
    ch?.addEventListener("message", handler);
    return () => ch?.removeEventListener("message", handler);
  }
  const readyPromise = listen(OUTPUT_READY_EVENT, () => {
    void emit(GRAPH_UPDATE_EVENT, getPayload());
  });
  return () => {
    void readyPromise.then((unlisten) => unlisten());
  };
}

export function broadcastGraph(payload: GraphPayload): void {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    ch?.postMessage({ event: GRAPH_UPDATE_EVENT, payload });
    return;
  }
  void emit(GRAPH_UPDATE_EVENT, payload);
}

export function startReceiving(onUpdate: (payload: GraphPayload) => void): () => void {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    const handler = (ev: MessageEvent) => {
      if (ev.data?.event === GRAPH_UPDATE_EVENT && ev.data?.payload) {
        onUpdate({ ...ev.data.payload, graph: rehydrateGraphParams(ev.data.payload.graph, DEFAULT_REGISTRY) });
      }
    };
    ch?.addEventListener("message", handler);
    ch?.postMessage({ event: OUTPUT_READY_EVENT });
    return () => ch?.removeEventListener("message", handler);
  }
  const listenPromise = listen<GraphPayload>(GRAPH_UPDATE_EVENT, (event) => {
    onUpdate({ ...event.payload, graph: rehydrateGraphParams(event.payload.graph, DEFAULT_REGISTRY) });
  });
  void emit(OUTPUT_READY_EVENT);
  return () => {
    void listenPromise.then((unlisten) => unlisten());
  };
}

export function notifyOutputClosed(): void {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    ch?.postMessage({ event: OUTPUT_CLOSED_EVENT });
    return;
  }
  void emit(OUTPUT_CLOSED_EVENT);
}

export function onOutputClosed(callback: () => void): () => void {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    const handler = (ev: MessageEvent) => {
      if (ev.data?.event === OUTPUT_CLOSED_EVENT) {
        callback();
      }
    };
    ch?.addEventListener("message", handler);
    return () => ch?.removeEventListener("message", handler);
  }
  const listenPromise = listen(OUTPUT_CLOSED_EVENT, callback);
  return () => {
    void listenPromise.then((unlisten) => unlisten());
  };
}

export function notifyView2DClosed(): void {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    ch?.postMessage({ event: VIEW2D_CLOSED_EVENT });
    return;
  }
  void emit(VIEW2D_CLOSED_EVENT);
}

export function onView2DClosed(callback: () => void): () => void {
  if (!isTauri()) {
    const ch = getBrowserChannel();
    const handler = (ev: MessageEvent) => {
      if (ev.data?.event === VIEW2D_CLOSED_EVENT) {
        callback();
      }
    };
    ch?.addEventListener("message", handler);
    return () => ch?.removeEventListener("message", handler);
  }
  const listenPromise = listen(VIEW2D_CLOSED_EVENT, callback);
  return () => {
    void listenPromise.then((unlisten) => unlisten());
  };
}

/**
 * Fills the whole screen: the browser Fullscreen API in a plain browser, the
 * native window's fullscreen flag under Tauri — `requestFullscreen()` exists
 * in WebKitGTK but is gated behind user-gesture plumbing the native call
 * sidesteps, and the native one also drops the window chrome, which is the
 * point.
 */
export async function toggleFullscreen(): Promise<void> {
  if (!isTauri()) {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
    return;
  }
  const appWindow = getCurrentWindow();
  await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
}

/**
 * Reports the current fullscreen state to `callback` now and whenever it
 * changes. The browser's `fullscreenchange` event covers the web build; under
 * Tauri there is no DOM event for a native window toggle (Esc included), so
 * the resize signal — which every fullscreen transition fires — re-reads the
 * window's flag instead.
 */
export function watchFullscreen(callback: (fullscreen: boolean) => void): () => void {
  if (!isTauri()) {
    const sync = () => callback(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    sync();
    return () => document.removeEventListener("fullscreenchange", sync);
  }

  let disposed = false;
  let unlisten: (() => void) | null = null;
  const appWindow = getCurrentWindow();
  const sync = () => {
    if (disposed) return;
    void appWindow
      .isFullscreen()
      .then((value) => {
        if (!disposed) callback(value);
      })
      .catch(() => {});
  };
  void appWindow
    .onResized(() => sync())
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  sync();
  return () => {
    disposed = true;
    unlisten?.();
  };
}
