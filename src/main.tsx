import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";
import { initBvhRaycast } from "./shared/three/bvh";
import { initTheme } from "./shared/theme/themeStore";
import { initInstantTooltips } from "./shared/instantTooltips";
import { installProfilerOverlay } from "./shared/graph/profilerOverlay";
import { installGeometryWorker } from "./shared/graph/offthread/workerExecutor";

// Initialize saved or default theme CSS variables
initTheme();

// Hover tooltips without the browser's delay (see instantTooltips.ts).
initInstantTooltips();

// Opt three's raycasting into the BVH-accelerated path globally (see bvh.ts).
initBvhRaycast();

// Ctrl/Cmd+Shift+P: live per-node profile panel (see profilerOverlay.ts).
installProfilerOverlay();

// Heavy geometry kernels (metaballs' marching cubes) run in a Web Worker,
// Rust/WASM inside it — see docs/offthread-geometry.md.
installGeometryWorker();

// Ctrl/Cmd+Alt+Shift+M: the music engine spike, dev builds only (see src/shared/music/spike).
if (import.meta.env.DEV) void import("./shared/music/spike/spikePanel").then((m) => m.installMusicSpike());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
