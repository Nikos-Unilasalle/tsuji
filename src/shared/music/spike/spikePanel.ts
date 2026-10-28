import { getAudioContext, getAudioOutput } from "../../audio/audioStore";
import { isTauri } from "../../isTauri";
import workletUrl from "./spike.worklet.ts?worker&url";

/**
 * Ctrl+Alt+Shift+M (Cmd+Alt+Shift+M on macOS): the music engine spike (see spike.worklet.ts). Start plays the
 * arpeggio, Stress adds the MVP's worst-case voice load; the panel shows what the worklet reports. Plain DOM, like the
 * profiler overlay, and in dev builds only.
 */

let panel: HTMLDivElement | null = null;
let log: HTMLPreElement | null = null;
let node: AudioWorkletNode | null = null;
let stress = false;
const lines: string[] = [];

function print(line: string): void {
  lines.push(line);
  if (lines.length > 14) lines.shift();
  if (log) log.textContent = lines.join("\n");
  console.info(`[music-spike] ${line}`);
  void fetch("/__music-spike-log", { method: "POST", body: line }).catch(() => {});
}

async function start(): Promise<void> {
  if (node) return;
  const ctx = getAudioContext();
  if (!ctx) return print("no AudioContext");
  if (!ctx.audioWorklet) return print("no audioWorklet on this AudioContext");
  await ctx.resume();
  const t0 = performance.now();
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } catch (err) {
    return print(`addModule failed: ${String(err)}`);
  }
  print(`module loaded in ${(performance.now() - t0).toFixed(0)} ms · ${ctx.sampleRate} Hz · base latency ${(ctx.baseLatency * 1000).toFixed(1)} ms · output latency ${((ctx.outputLatency ?? 0) * 1000).toFixed(1)} ms`);
  node = new AudioWorkletNode(ctx, "tsuji-music-spike", { outputChannelCount: [2] });
  node.port.onmessage = (e: MessageEvent) => {
    const d = e.data;
    if (d.type === "ready") {
      print(`worklet ready · performance.now ${d.hasPerformance ? "yes" : "no"} · worst case ${d.calibration.usPerBlock.toFixed(0)} µs/block = ${d.calibration.loadPercent.toFixed(1)} % of a core`);
    } else if (d.type === "stats") {
      const cost = d.avgUs === null ? "" : ` · avg ${d.avgUs.toFixed(0)} µs, max ${d.maxUs.toFixed(0)} µs of ${d.budgetUs.toFixed(0)}`;
      print(`${d.stress ? "STRESS " : ""}${d.blocks} blocks · ${d.voices} voices · peak ${d.peak.toFixed(2)}${cost}`);
    }
  };
  node.connect(getAudioOutput() ?? ctx.destination);
}

function stop(): void {
  node?.disconnect();
  node?.port.close();
  node = null;
  stress = false;
  print("stopped");
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText = "font:inherit;padding:2px 8px;margin-left:6px;cursor:pointer;";
  b.addEventListener("click", onClick);
  return b;
}

function show(): void {
  if (panel) return;
  panel = document.createElement("div");
  panel.dataset.musicSpike = "";
  panel.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:60px",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "width:560px",
    "background:rgba(10,10,14,0.92)",
    "color:#f5e3d0",
    "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace",
    "padding:8px 10px",
    "border-radius:6px",
    "box-shadow:0 4px 18px rgba(0,0,0,0.5)",
  ].join(";");
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;margin-bottom:6px;color:#fff;";
  const title = document.createElement("strong");
  title.textContent = "Music engine spike";
  title.style.flex = "1";
  bar.append(
    title,
    button("Start", () => void start()),
    button("Stress", () => {
      if (!node) return print("start first");
      stress = !stress;
      node.port.postMessage({ type: "stress", on: stress });
      print(`stress ${stress ? "on" : "off"}`);
    }),
    button("Stop", stop),
    button("Close", hide),
  );
  log = document.createElement("pre");
  log.style.cssText = "margin:0;white-space:pre-wrap;";
  log.textContent = lines.join("\n") || "Start needs a click (autoplay policy).";
  panel.append(bar, log);
  document.body.append(panel);
  const r = panel.getBoundingClientRect();
  print(`panel at ${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.width.toFixed(0)}×${r.height.toFixed(0)} in a ${innerWidth}×${innerHeight} window · visible ${document.visibilityState}`);
}

function hide(): void {
  stop();
  panel?.remove();
  panel = log = null;
}

export function installMusicSpike(): void {
  // Tauri's WKWebView does not pass the shortcut on: there the panel opens by itself.
  if (isTauri()) {
    print("panel installed in Tauri");
    show();
  }
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.altKey || !e.shiftKey || e.code !== "KeyM") return;
    e.preventDefault();
    if (panel) hide();
    else show();
  });
}
