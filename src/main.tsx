import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";
import { initBvhRaycast } from "./shared/three/bvh";
import { initTheme } from "./shared/theme/themeStore";

// Initialize saved or default theme CSS variables
initTheme();

// Opt three's raycasting into the BVH-accelerated path globally (see bvh.ts).
initBvhRaycast();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
