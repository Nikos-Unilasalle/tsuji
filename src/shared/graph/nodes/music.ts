import { createNodeCache } from "../nodeCaches";
import { growingSockets } from "../dynamicInputs";
import { NodeDefinition } from "../types";
import { numberInput } from "./object";
import { MusicEngineHandle } from "../../music/engine/bridge";
import type { MusicDescription, TrackDescription } from "../../music/engine/description";
import { DEMO_CLOCK, DEMO_TRACKS } from "../../music/demo";
import { stepAt } from "../../music/seq/sequencer";

/**
 * Music Out — plays the music tracks wired into it, in step with the timeline (see docs/music-nodes-mvp.md).
 *
 * The graph describes, the engine plays: each frame this node gathers the track descriptions, hands them to its
 * AudioWorklet engine (posted only when they change), and tells it where the playhead is. The engine keeps its own
 * sample-exact clock and only jumps when the playhead is further than 80 ms away — a seek, a loop of the timeline —
 * so the frame rate never reaches the sound.
 *
 * The song's step 0 sits on Start Frame. Before it, and while the timeline is paused, nothing new is struck; what
 * was sounding rings out.
 */

const TRACK_PREFIX = "track";
const TOLERANCE_SECONDS = 0.08;

const engines = createNodeCache<MusicEngineHandle>((engine) => engine.dispose());

function engineFor(nodeId: string): MusicEngineHandle {
  let engine = engines.get(nodeId);
  if (!engine) {
    engine = new MusicEngineHandle();
    engines.set(nodeId, engine);
  }
  return engine;
}

/** When an export last captured a frame: the live engine stays quiet meanwhile (as the Audio Player does). */
let lastCaptureAt = -Infinity;
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
/** One render loop at a time drives an engine: whichever drove it last keeps it while it keeps driving. */
const drivers = new Map<string, { id: string; at: number }>();

function isTrack(v: unknown): v is TrackDescription {
  return typeof v === "object" && v !== null && (v as TrackDescription).kind === "fm" && typeof (v as TrackDescription).id === "string";
}

/** The tracks wired in, in socket order; a track wired twice plays twice, under its own id each time. */
export function gatherTracks(inputs: Record<string, unknown>): TrackDescription[] {
  const keys = Object.keys(inputs)
    .filter((k) => k.startsWith(TRACK_PREFIX))
    .sort((a, b) => Number(a.slice(TRACK_PREFIX.length)) - Number(b.slice(TRACK_PREFIX.length)));
  const tracks: TrackDescription[] = [];
  const used = new Map<string, number>();
  for (const k of keys) {
    const v = inputs[k];
    for (const t of Array.isArray(v) ? v : [v]) {
      if (!isTrack(t)) continue;
      const n = used.get(t.id) ?? 0;
      used.set(t.id, n + 1);
      tracks.push(n === 0 ? t : { ...t, id: `${t.id}#${n + 1}` });
    }
  }
  return tracks;
}

export const MUSIC_OUT_NODE: NodeDefinition = {
  type: "music/out",
  label: "Music Out",
  category: "music",
  inputs: [
    { id: "master", label: "Master", type: "value" },
    { id: "startFrame", label: "Start Frame", type: "value" },
    { id: `${TRACK_PREFIX}0`, label: "Track 1", type: "music" },
  ],
  dynamicInputs: (connections) => [
    { id: "master", label: "Master", type: "value" as const },
    { id: "startFrame", label: "Start Frame", type: "value" as const },
    ...growingSockets(connections, TRACK_PREFIX, (i) => ({ id: `${TRACK_PREFIX}${i}`, label: `Track ${i + 1}`, type: "music" })),
  ],
  outputs: [
    { id: "time", label: "Song Time (s)", type: "value" },
    { id: "beat", label: "Beat", type: "value" },
    { id: "step", label: "Step", type: "value" },
    { id: "playing", label: "Playing", type: "value" },
  ],
  defaultParams: { master: 0.8, startFrame: 0, demo: false },
  paramFields: [
    { id: "master", label: "Master", kind: "number", step: 0.05 },
    { id: "startFrame", label: "Start Frame (the song's first step)", kind: "number", step: 1 },
    {
      id: "demo",
      label: "Demo (two built-in tracks, until the track nodes exist)",
      kind: "boolean",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const fps = Math.max(1, Number(ctx.fps) || 30);
    const startFrame = Math.round(numberInput(inputs.startFrame, params.startFrame, 0));
    const master = Math.max(0, Math.min(2, numberInput(inputs.master, params.master, 0.8)));
    const tracks = gatherTracks(inputs);
    if (params.demo) tracks.push(...DEMO_TRACKS);
    const desc: MusicDescription = { tracks, master };

    // Where the playhead puts the song: a pure function of the frame, the same live and in an export.
    const frame = ctx.currentFrame ?? 0;
    const songTime = (frame - startFrame) / fps;
    const running = (ctx.isPlaying !== false || ctx.capturing === true) && songTime >= 0;
    const clock = tracks[0]?.seq.clock ?? DEMO_CLOCK;
    const beat = songTime * (clock.bpm / 60);

    const engine = engineFor(ctx.nodeId);
    const sr = engine.sampleRate;
    if (ctx.capturing) lastCaptureAt = nowMs();
    const yieldToExport = !ctx.capturing && nowMs() - lastCaptureAt < 400;
    const sessionId = ctx.sessionId ?? "main";
    const now = nowMs();
    const driver = drivers.get(ctx.nodeId);
    const taken = driver !== undefined && driver.id !== sessionId && now - driver.at < 300;
    if (!taken) drivers.set(ctx.nodeId, { id: sessionId, at: now });

    engine.describe(desc);
    if (ctx.capturing) {
      // The export's soundtrack is rendered offline (step 6); the speakers stay out of it.
      engine.follow(false, 0, 0);
    } else if (!yieldToExport && !taken) {
      engine.follow(running, Math.max(0, Math.round(songTime * sr)), TOLERANCE_SECONDS * sr);
    }

    return {
      time: songTime,
      beat,
      step: songTime >= 0 ? stepAt(clock, sr, songTime * sr) : -1,
      playing: running ? 1 : 0,
    };
  },
};
