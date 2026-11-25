/**
 * The node catalogue's sections. Every node belongs to one category, every
 * category to one family; the palette lists families in workflow order
 * (geometry first, audio last) and, inside a family, categories and nodes
 * alphabetically.
 *
 * The placement rule: a node is filed by what it *does* to its data, not by
 * the data it happens to touch — Extrude is Modeling even though it moves
 * points, Lattice is Deform even though it takes a matrix.
 *
 * Colours: one hue range per family, a step within it per category, so a
 * node header says which family it is from at a glance. They carry meaning,
 * which is why they live here and not in the theme.
 *
 * Nothing may test a category to decide behaviour (what the viewport draws,
 * which sockets a node grows…): use an explicit NodeDefinition flag instead,
 * so re-filing a node never changes what it does.
 */

export type NodeFamily = "geometry" | "scene" | "appearance" | "animation" | "data" | "interaction";

export type NodeCategory =
  // Geometry
  | "attribute"
  | "curve"
  | "deform"
  | "generators"
  | "import"
  | "instance"
  | "modeling"
  | "primitives"
  | "selection"
  | "strokes"
  | "volume"
  // Scene
  | "camera"
  | "lighting"
  | "structure"
  | "transform"
  // Appearance
  | "fx"
  | "material"
  | "postprocess"
  | "texture"
  | "textureTools"
  // Animation & simulation
  | "particles"
  | "physics"
  | "rig"
  | "time"
  // Data
  | "convert"
  | "dataviz"
  | "list"
  | "logic"
  | "math"
  | "text"
  // Interaction & audio
  | "io"
  | "music"
  | "sound";

export const FAMILY_ORDER: NodeFamily[] = ["geometry", "scene", "appearance", "animation", "data", "interaction"];

export const FAMILY_LABEL: Record<NodeFamily, string> = {
  geometry: "Geometry",
  scene: "Scene",
  appearance: "Appearance",
  animation: "Animation & Simulation",
  data: "Data",
  interaction: "Interaction & Audio",
};

export const CATEGORY_FAMILY: Record<NodeCategory, NodeFamily> = {
  attribute: "geometry",
  curve: "geometry",
  deform: "geometry",
  generators: "geometry",
  import: "geometry",
  instance: "geometry",
  modeling: "geometry",
  primitives: "geometry",
  selection: "geometry",
  strokes: "geometry",
  volume: "geometry",
  camera: "scene",
  lighting: "scene",
  structure: "scene",
  transform: "scene",
  fx: "appearance",
  material: "appearance",
  postprocess: "appearance",
  texture: "appearance",
  textureTools: "appearance",
  particles: "animation",
  physics: "animation",
  rig: "animation",
  time: "animation",
  convert: "data",
  dataviz: "data",
  list: "data",
  logic: "data",
  math: "data",
  text: "data",
  io: "interaction",
  music: "interaction",
  sound: "interaction",
};

export const CATEGORY_LABEL: Record<NodeCategory, string> = {
  attribute: "Attributes",
  curve: "Curves",
  deform: "Deform",
  generators: "Generators",
  import: "Import",
  instance: "Instances & Points",
  modeling: "Modeling",
  primitives: "Primitives",
  selection: "Selection & Groups",
  strokes: "Strokes & Drawing",
  volume: "Volumes (SDF)",
  camera: "Camera",
  lighting: "Lighting",
  structure: "Scene & Graph",
  transform: "Transform",
  fx: "Object FX",
  material: "Materials",
  postprocess: "Post-Process & Stylize",
  texture: "Textures",
  textureTools: "Texture Tools",
  particles: "Particles",
  physics: "Physics & Fluids",
  rig: "Rig / IK",
  time: "Time & Animation",
  convert: "Compose & Convert",
  dataviz: "Data Viz",
  list: "Lists",
  logic: "Logic",
  math: "Math",
  text: "Text",
  io: "Input & HUD",
  music: "Music",
  sound: "Sound",
};

/** Families in workflow order; inside each, categories alphabetically by their label. */
export const CATEGORY_ORDER: NodeCategory[] = FAMILY_ORDER.flatMap((family) =>
  (Object.keys(CATEGORY_FAMILY) as NodeCategory[])
    .filter((category) => CATEGORY_FAMILY[category] === family)
    .sort((a, b) => CATEGORY_LABEL[a].localeCompare(CATEGORY_LABEL[b])),
);

/** A family's own colour: its headings in the palette. */
export const FAMILY_COLOR: Record<NodeFamily, string> = {
  geometry: "#34d399",
  scene: "#60a5fa",
  appearance: "#fbbf24",
  animation: "#f472b6",
  data: "#a78bfa",
  interaction: "#fb7185",
};

/** Per category: a step inside its family's hue range, light enough to read on the dark canvas. */
export const CATEGORY_COLOR: Record<NodeCategory, string> = {
  // Geometry — lime → green → teal → cyan
  strokes: "#a3e635",
  curve: "#84cc16",
  selection: "#bef264",
  generators: "#4ade80",
  deform: "#22c55e",
  modeling: "#10b981",
  instance: "#14b8a6",
  import: "#5eead4",
  volume: "#67e8f9",
  attribute: "#22d3ee",
  primitives: "#38bdf8",
  // Scene — blue → indigo
  structure: "#94a3b8",
  camera: "#60a5fa",
  lighting: "#93c5fd",
  transform: "#818cf8",
  // Appearance — amber → orange
  material: "#f59e0b",
  texture: "#fbbf24",
  textureTools: "#fcd34d",
  fx: "#fb923c",
  postprocess: "#f97316",
  // Animation & simulation — pink → fuchsia
  time: "#f472b6",
  particles: "#ec4899",
  physics: "#e879f9",
  rig: "#d946ef",
  // Data — violet → purple
  math: "#c4b5fd",
  convert: "#a78bfa",
  list: "#8b5cf6",
  logic: "#b794f4",
  text: "#ddd6fe",
  dataviz: "#9f7aea",
  // Interaction & audio — rose → red
  io: "#fb7185",
  sound: "#f43f5e",
  music: "#fda4af",
};

export const UNKNOWN_CATEGORY_COLOR = "#6b7280";
