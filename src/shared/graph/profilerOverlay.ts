import { getEvalProfiler, startEvalProfiling, stopEvalProfiling } from "./evalProfiler";

/**
 * Ctrl+Shift+P (Cmd+Shift+P on macOS) toggles a live profile panel over the
 * app: frame times, viewport phases, GPU/heap gauges and the slowest node
 * types and nodes, refreshed twice a second. Works in the release binary,
 * where there is no devtools console — "Copy" puts the full report on the
 * clipboard to paste into an issue.
 *
 * Plain DOM, outside React: the panel must keep updating while the React
 * tree is the thing that is struggling. Same functions on
 * `window.__tsuji.profile` for the console.
 */

const REFRESH_MS = 500;

let panel: HTMLDivElement | null = null;
let body: HTMLPreElement | null = null;
let timer: number | null = null;

function refresh(): void {
  const profiler = getEvalProfiler();
  if (!body || !profiler) return;
  body.textContent = profiler.frameTotal === 0 ? "waiting for the first evaluated frame…" : profiler.format(15);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText = "font:inherit;padding:2px 8px;margin-left:6px;cursor:pointer;";
  b.addEventListener("click", onClick);
  return b;
}

function show(): void {
  startEvalProfiling().reset();
  if (panel) return;
  panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:2147483647",
    "max-height:70vh",
    "overflow:auto",
    "background:rgba(10,10,14,0.92)",
    "color:#d8f5d0",
    "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace",
    "padding:8px 10px",
    "border-radius:6px",
    "box-shadow:0 4px 18px rgba(0,0,0,0.5)",
  ].join(";");

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;margin-bottom:6px;color:#fff;";
  const title = document.createElement("strong");
  title.textContent = "Tsuji profiler";
  title.style.flex = "1";
  bar.append(
    title,
    button("Reset", () => getEvalProfiler()?.reset()),
    button("Copy", () => {
      const text = getEvalProfiler()?.format(60);
      if (text) void navigator.clipboard?.writeText(text);
    }),
    button("×", hide),
  );

  body = document.createElement("pre");
  body.style.cssText = "margin:0;white-space:pre;";
  panel.append(bar, body);
  document.body.appendChild(panel);
  refresh();
  timer = window.setInterval(refresh, REFRESH_MS);
}

function hide(): void {
  stopEvalProfiling();
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  panel?.remove();
  panel = null;
  body = null;
}

export function installProfilerOverlay(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        e.stopPropagation();
        if (panel) hide();
        else show();
      }
    },
    // Capture phase: ahead of the graph editor's own shortcut handlers.
    true,
  );

  (window as unknown as { __tsuji?: Record<string, unknown> }).__tsuji = {
    ...(window as unknown as { __tsuji?: Record<string, unknown> }).__tsuji,
    profile: {
      show,
      hide,
      start: () => startEvalProfiling(),
      stop: () => stopEvalProfiling(),
      report: () => getEvalProfiler()?.report(),
      print: (top = 30) => console.log(getEvalProfiler()?.format(top) ?? "profiler not running"),
    },
  };
}
