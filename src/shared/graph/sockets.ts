import * as THREE from "three";

/**
 * The type system BIBLE.md settled on: seven socket kinds, no dedicated
 * Trigger/pulse type — a rising-edge-detector node turns a continuous
 * boolean into a discrete "just happened" event where that distinction
 * actually matters, instead of the graph needing a second primitive for it.
 *
 * Built directly on three.js's own math/scene classes (Vector3, Matrix4,
 * Color, Object3D, Texture) rather than parallel value types — this engine
 * exists to feed a three.js renderer, so there is no independent math layer
 * to keep in sync with it.
 */
export type SocketType =
  | "value"
  | "vector"
  | "matrix"
  | "color"
  | "geometry"
  | "texture"
  | "curve"
  | "material"
  | "list"
  | "text"
  | "postprocess"
  | "any";

/**
 * The plain material descriptor a `material` socket carries. Deliberately not
 * a live THREE.Material: a material is *described* by a node and *consumed* by
 * an object that still owns its own mesh, texture and side — so the value is a
 * small pure data object, not a shared GPU resource. Field-for-field the same
 * shape as object.ts's MaterialParams, so it drops straight into
 * applyMaterialParams.
 */
export interface MaterialValue {
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
  shadeless: boolean;
  roughness: number;
  metalness: number;
  wireframe: boolean;
  opacity: number;
  transmission: number;
  thickness: number;
  customMaterial?: THREE.Material;
}

/** The runtime value a socket of each type actually carries during evaluation. */
export interface SocketValueMap {
  /** Also carries booleans (0/1) — no separate boolean socket type, see BIBLE.md. */
  value: number;
  vector: THREE.Vector3;
  matrix: THREE.Matrix4;
  color: THREE.Color;
  geometry: THREE.Object3D;
  texture: THREE.Texture;
  curve: THREE.Curve<THREE.Vector3>;
  material: MaterialValue;
  list: unknown[];
  text: string;
  postprocess: unknown[];
  any: unknown;
}

export type SocketValue<T extends SocketType = SocketType> = SocketValueMap[T];

export interface SocketDef {
  id: string;
  label: string;
  type: SocketType;
  /**
   * Input sockets only: this node takes ownership of the geometry wired into
   * it — it reparents, clones, deforms or passes on the object, and is from
   * then on responsible for putting it on screen. The source node stops
   * being drawn in its own right (see sceneRoots.ts).
   *
   * Off by default, and deliberately not inferred from the socket type: a
   * Spot Light's `target` and a Look At's `target` are geometry-typed too,
   * but they only read a position off the object — it has to keep rendering
   * where it is.
   */
  owns?: boolean;
}

/**
 * One color per socket type, shared by node handles and the wires between
 * them — a wire is always the color of the type flowing through it, so a
 * mismatched drag reads as wrong before the connection is even attempted.
 */
export const SOCKET_COLOR: Record<SocketType, string> = {
  value: "#f2c14e",
  vector: "#38bdf8",
  matrix: "#a855f7",
  color: "#ec4899",
  geometry: "#22c55e",
  texture: "#2dd4bf",
  curve: "#84cc16",
  material: "#d97706",
  list: "#94a3b8",
  text: "#f97316",
  postprocess: "#c084fc",
  any: "#e2e8f0",
};

export function toBoolean(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0" && v !== "false";
  return Boolean(v);
}

export function fromBoolean(b: boolean): number {
  return b ? 1 : 0;
}
