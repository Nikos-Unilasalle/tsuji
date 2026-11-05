import { NodeDefinition } from "../types";

/**
 * Mixing Console — the song's mixing desk over the 3D view, in the music HUDs' style (see
 * three/MixingConsoleOverlay.tsx): a channel strip per track Music Out mixes, with its fader, pan, dub sends, mute and
 * solo, its meter and what it plays; and a master section with the spectrum, a phase scope, R128 loudness, the send
 * returns and the master fader. Every control writes the param it stands for on the voice (or on Music Out), so the
 * graph stays the one truth and a move is undone like any edit; with Write on, moves made while the song plays become
 * keyframes (automation), which the console then plays back. Like the Music Viewer it evaluates to nothing; it is what
 * it shows.
 */
export const MIXING_CONSOLE_NODE: NodeDefinition = {
  type: "music/mixing-console",
  label: "Mixing Console",
  category: "music",
  pure: true,
  inputs: [],
  outputs: [],
  defaultParams: { show: true, scale: 1, height: 1 },
  paramFields: [
    { id: "show", label: "Show over the 3D view", kind: "boolean" },
    { id: "scale", label: "Scale (0.6–1.6)", kind: "number", step: 0.1 },
    { id: "height", label: "Height (share of the view, 0.3–1)", kind: "number", step: 0.05 },
  ],
  evaluate: () => ({}),
};
