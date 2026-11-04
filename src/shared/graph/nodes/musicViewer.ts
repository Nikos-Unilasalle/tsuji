import { NodeDefinition } from "../types";
import { VIEWER_PALETTE_NAMES, VIEWER_STYLES } from "../../music/viewer/draw";

/**
 * Music Viewer — the song as a show: every note Music Out mixes drawn as light over the 3D view (see
 * three/MusicViewerOverlay.tsx and music/viewer/draw.ts) — a mandala on the circle of fifths, a river of notes, the
 * form of the song, a legend with meters — with a full-screen button. Like the Virtual Interface it evaluates to
 * nothing; it is what it shows. The Share menu's video export can film it instead of the 3D view, with the music.
 */
export const MUSIC_VIEWER_NODE: NodeDefinition = {
  type: "music/viewer",
  label: "Music Viewer",
  category: "music",
  pure: true,
  inputs: [],
  outputs: [],
  defaultParams: { title: "", show: true, style: "galaxy", palette: "neon", intensity: 1, ahead: 6, legend: true },
  paramFields: [
    { id: "title", label: "Title (blank: the file's name)", kind: "text" },
    { id: "show", label: "Show over the 3D view", kind: "boolean" },
    { id: "style", label: "Style", kind: "select", options: [...VIEWER_STYLES], optionLabels: ["Galaxy — mandala and river", "Mandala", "River of notes"] },
    { id: "palette", label: "Palette", kind: "select", options: VIEWER_PALETTE_NAMES, optionLabels: VIEWER_PALETTE_NAMES.map((p) => p[0].toUpperCase() + p.slice(1)) },
    { id: "intensity", label: "Intensity (0–2: glow, aurora, ripples)", kind: "number", step: 0.1 },
    { id: "ahead", label: "River — seconds ahead of the playhead", kind: "number", step: 1 },
    { id: "legend", label: "Track names and meters", kind: "boolean" },
  ],
  evaluate: () => ({}),
};
