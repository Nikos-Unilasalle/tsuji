import * as THREE from "three";
import { resolveDefinition } from "./groups";
import { Graph, NodeRegistry } from "./types";

/**
 * Undoes the one real cost of broadcasting the graph across the Tauri IPC
 * boundary (see ipc.ts): the event bridge round-trips every payload through
 * Rust as JSON, so a THREE.Vector3/Color param — a real class instance in
 * the main window — arrives in the output window as a plain object with the
 * same fields and no prototype. Every node's `evaluate()` checks
 * `instanceof THREE.Vector3` before trusting an input/param (see
 * asVector3() in transform.ts, camera.ts, etc.), so a stripped instance
 * silently fails that check and falls back to the node's default — any
 * edited Vector3/Color param (a Transform node's location dragged via the
 * viewport gizmo, a Box's color, ...) reads as unedited in the output
 * window specifically, even though the raw numbers did arrive correctly.
 *
 * Ground truth for what a param is *supposed* to be comes from the node's
 * own `defaultParams` — the same registry both windows already share
 * locally, never itself sent over IPC — rather than guessing from the
 * received value's shape, which would be ambiguous (a Vector3 and a
 * Quaternion look identical minus the `w`).
 */
/**
 * A THREE.Color's own `toJSON()` (which `JSON.stringify` calls automatically)
 * returns its hex value as a plain *number* — `16711680`, not `{r,g,b}` — so
 * a value that went through an actual JSON round-trip (this app's .tsuji
 * save/load; IPC only strips the prototype, not the shape) is a number, not
 * an object. Mirrors the top-level Color branch below, which already
 * handled the number/string case — only the nested Color Ramp branch missed
 * it, because it's a shape only Color Ramp's stops have.
 */
function parseColorValue(v: unknown): THREE.Color {
  if (typeof v === "number" || typeof v === "string") return new THREE.Color(v);
  const c = v as { r?: unknown; g?: unknown; b?: unknown } | undefined;
  return new THREE.Color(Number(c?.r) || 0, Number(c?.g) || 0, Number(c?.b) || 0);
}

/** Structural check for a colorRamp.ts ColorStop — position/color don't survive JSON with their real types, so this can't check `instanceof` on color yet. */
function isColorStopShape(v: unknown): v is { position: unknown; color: unknown } {
  return typeof v === "object" && v !== null && "position" in v && "color" in v;
}

/** Structural check for a colorRamp.ts ColorRamp ({stops, interpolation}). */
function isColorRampShape(v: unknown): v is { stops: unknown[] } {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { stops?: unknown }).stops) &&
    (v as { stops: unknown[] }).stops.length > 0 &&
    isColorStopShape((v as { stops: unknown[] }).stops[0])
  );
}

export function rehydrateGraphParams(graph: Graph, registry: NodeRegistry): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((instance) => {
      // A group's interior crossed the same IPC boundary and lost the same
      // THREE instances on the way — rehydrate it before its own params.
      if (instance.subgraph) {
        instance = { ...instance, subgraph: rehydrateGraphParams(instance.subgraph, registry) };
      }
      const def = resolveDefinition(instance, registry);
      if (!def) return instance;

      let changed = false;
      const params: Record<string, unknown> = { ...instance.params };

      for (const key of Object.keys(instance.params)) {
        const defaultValue = def.defaultParams[key];
        const value = instance.params[key];
        if (value === null || value === undefined) continue;

        if (defaultValue instanceof THREE.Quaternion && !(value instanceof THREE.Quaternion)) {
          if (typeof value === "object") {
            const v = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
            // Vector3 has no w, so its presence un-ambiguates a Quaternion.
            if (Number.isFinite(Number(v.w))) {
              params[key] = new THREE.Quaternion(
                Number(v.x) || 0,
                Number(v.y) || 0,
                Number(v.z) || 0,
                Number(v.w) || 0,
              );
              changed = true;
            }
          }
        } else if (defaultValue instanceof THREE.Vector3 && !(value instanceof THREE.Vector3)) {
          if (typeof value === "object") {
            const v = value as { x?: unknown; y?: unknown; z?: unknown };
            params[key] = new THREE.Vector3(Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0);
            changed = true;
          }
        } else if (defaultValue instanceof THREE.Color && !(value instanceof THREE.Color)) {
          if (typeof value === "number" || typeof value === "string" || typeof value === "object") {
            params[key] = parseColorValue(value);
            changed = true;
          }
        } else if (isColorRampShape(defaultValue) && typeof value === "object") {
          // Color Ramp's stops (see colorRamp.ts) — a THREE.Color nested two
          // levels inside the param value ({stops:[{position,color}]}), not
          // the param value itself, so the instanceof checks above never see
          // it. Same IPC/file-round-trip problem, one level deeper.
          const v = value as { stops?: unknown; interpolation?: unknown };
          if (Array.isArray(v.stops)) {
            let stopsChanged = false;
            const newStops = v.stops.map((stop) => {
              if (!isColorStopShape(stop) || stop.color instanceof THREE.Color) return stop;
              stopsChanged = true;
              return { ...stop, color: parseColorValue(stop.color) };
            });
            if (stopsChanged) {
              params[key] = { ...v, stops: newStops };
              changed = true;
            }
          }
        }
      }

      return changed ? { ...instance, params } : instance;
    }),
  };
}
