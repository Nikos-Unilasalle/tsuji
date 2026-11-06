/**
 * The page's side of the music engine: one AudioWorkletNode per Music Out node, on the app's shared AudioContext and
 * output bus. Descriptions are only posted when they change; the playhead is posted every frame.
 *
 * The worklet module is loaded on first use, once per context. Until it is there, the latest description and
 * transport are kept and sent the moment the node exists — nothing the graph said is lost to the load.
 */
import { getAudioContext, getAudioOutput } from "../../audio/audioStore";
import { onPlaybackActiveChange } from "../../graph/playbackKeys";
import type { MusicDescription, PreviewSound } from "./description";
import type { EngineMessage, EngineMeters, EngineState } from "./engine.worklet";
import { subscribeMidi } from "../../graph/midiRuntime";
import { LiveRouter, LiveTrack, liveTracksOf } from "./live";

const modules = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * Every live engine. In dev, `window.__tsujiMusic()` lists their last reports, with the context's time now, to check
 * what the speakers do.
 */
const live = new Set<MusicEngineHandle>();
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __tsujiMusic?: () => unknown }).__tsujiMusic = () => ({
    now: getAudioContext()?.currentTime ?? 0,
    sampleRate: getAudioContext()?.sampleRate ?? 0,
    engines: [...live].map((h) => ({ ...h.state, meters: h.meters, tracks: h.trackSummary(), liveTracks: h.liveTracks, liveSent: h.liveSent, worklet: h.loaded })),
    midiSeen: liveMidiSeen,
  });
}

/**
 * Stop stops every song, even when nothing is evaluating Music Out to say so: a suspended viewport (no 3D, 2D or camera
 * view on screen) runs no frames, and the engine would play on to the end from the last "playing" it was told.
 */
onPlaybackActiveChange((active) => {
  if (!active) for (const h of live) h.follow(false, 0, 0);
});

/** One engine per Music Out node, made on first use. */
const byNode = new Map<string, MusicEngineHandle>();

export function musicEngineFor(nodeId: string): MusicEngineHandle {
  let engine = byNode.get(nodeId);
  if (!engine) {
    engine = new MusicEngineHandle();
    byNode.set(nodeId, engine);
  }
  return engine;
}

/** The meters of a Music Out's engine, when it has one — never makes an engine (the Mixing Console only reads). */
export function musicMetersOf(nodeId: string): EngineMeters | null {
  return byNode.get(nodeId)?.meters ?? null;
}

/**
 * The two sides of a Music Out's output, as AnalyserNodes (made with the engine, fed in parallel with the speakers):
 * the Mixing Console's spectrum and goniometer read them. Null until the engine's worklet has loaded.
 */
export function musicAnalysersOf(nodeId: string): { left: AnalyserNode; right: AnalyserNode } | null {
  return byNode.get(nodeId)?.analysers ?? null;
}

/** The node is gone: its engine lets its notes ring out, then disconnects. */
export function releaseMusicEngine(nodeId: string): void {
  byNode.get(nodeId)?.dispose();
  byNode.delete(nodeId);
}

/**
 * Auditions a note on the first engine there is — a scene with no Music Out has no engine, and stays silent. For the
 * Pattern HUD, which sounds what you type.
 */
export function previewNote(sound: PreviewSound, note: number, velocity = 0.8): void {
  const engine = live.values().next().value as MusicEngineHandle | undefined;
  getAudioContext()?.resume().catch(() => {});
  engine?.preview(sound, note, velocity);
}

/**
 * The MIDI keyboard, played on every voice with MIDI Play on (live.ts). Listened to from the first description that
 * has one, and from then on: a listener with nothing to play costs a lookup a message.
 */
const router = new LiveRouter();
let liveListening = false;
/** MIDI messages the live router was handed (dev diagnostics). */
let liveMidiSeen = 0;

function listenLive(): void {
  if (liveListening) return;
  liveListening = true;
  subscribeMidi((e) => {
    liveMidiSeen++;
    for (const h of live) {
      if (h.liveTracks.length === 0) continue;
      const notes = router.route(e, h.liveTracks);
      if (notes.length > 0) getAudioContext()?.resume().catch(() => {});
      for (const n of notes) h.playLive(n.track, n.note, n.velocity);
    }
  });
}

/** Whether some voice is played from the keyboard now — the Pattern HUD then lets it sound the keys, not an audition. */
export function livePlayActive(): boolean {
  for (const h of live) if (h.liveTracks.length > 0) return true;
  return false;
}

function loadModule(ctx: AudioContext): Promise<void> {
  let p = modules.get(ctx);
  if (!p) {
    // Imported here, not at the top: only a browser ever reaches this, and the test runner never has to resolve the
    // worklet bundle.
    p = import("./engine.worklet.ts?worker&url").then(({ default: url }) => ctx.audioWorklet.addModule(url));
    modules.set(ctx, p);
  }
  return p;
}

export class MusicEngineHandle {
  private node: AudioWorkletNode | null = null;
  private failed = false;
  private disposed = false;
  private descKey = "";
  private pendingDesc: MusicDescription | null = null;
  private pendingFollow: Extract<EngineMessage, { type: "follow" }> | null = null;
  /** The engine's last report, for the node's outputs. */
  state: EngineState = { type: "state", playing: false, position: 0, at: 0, voices: 0, jumps: 0 };
  /** The engine's last meter reading (a few dozen a second), for the Mixing Console. */
  meters: EngineMeters | null = null;
  analysers: { left: AnalyserNode; right: AnalyserNode } | null = null;
  /** The tracks of the last description played from the MIDI keyboard. */
  liveTracks: LiveTrack[] = [];
  /** Live notes posted to the worklet (dev diagnostics). */
  liveSent = 0;

  constructor() {
    live.add(this);
    const ctx = getAudioContext();
    if (!ctx?.audioWorklet) {
      this.failed = true;
      return;
    }
    loadModule(ctx)
      .then(() => {
        if (this.disposed) return;
        const node = new AudioWorkletNode(ctx, "tsuji-music-engine", { numberOfInputs: 0, outputChannelCount: [2] });
        node.port.onmessage = (e: MessageEvent<EngineState | EngineMeters>) => {
          if (e.data?.type === "state") this.state = e.data;
          else if (e.data?.type === "meters") this.meters = e.data;
        };
        node.connect(getAudioOutput() ?? ctx.destination);
        // A tap for the console's analysis: each side to its own analyser, which outputs nothing.
        const split = ctx.createChannelSplitter(2);
        const analyser = () => {
          const a = ctx.createAnalyser();
          a.fftSize = 2048;
          a.smoothingTimeConstant = 0.6;
          return a;
        };
        const left = analyser();
        const right = analyser();
        node.connect(split);
        split.connect(left, 0);
        split.connect(right, 1);
        this.analysers = { left, right };
        this.node = node;
        if (this.pendingDesc) this.post({ type: "describe", desc: this.pendingDesc });
        if (this.pendingFollow) this.post(this.pendingFollow);
      })
      .catch((err) => {
        this.failed = true;
        console.warn("[music] the engine's AudioWorklet did not load:", err);
      });
  }

  /** False where there is no AudioWorklet (or it failed to load): the graph still evaluates, silently. */
  get available(): boolean {
    return !this.failed;
  }

  private post(m: EngineMessage): void {
    this.node?.port.postMessage(m);
  }

  describe(desc: MusicDescription): void {
    const key = JSON.stringify(desc);
    if (key === this.descKey) return;
    this.descKey = key;
    this.pendingDesc = desc;
    this.liveTracks = liveTracksOf(desc.tracks);
    if (this.liveTracks.length > 0) listenLive();
    this.post({ type: "describe", desc });
  }

  /** `wanted` in song samples; `tolerance` in samples. */
  follow(playing: boolean, wanted: number, tolerance: number): void {
    const ctx = getAudioContext();
    const m: EngineMessage = { type: "follow", playing, wanted, at: ctx?.currentTime ?? 0, tolerance };
    this.pendingFollow = m;
    this.post(m);
  }

  preview(sound: PreviewSound, note: number, velocity: number): void {
    this.post({ type: "preview", sound, note, velocity });
  }

  playLive(track: string, note: number, velocity: number): void {
    this.liveSent++;
    this.post({ type: "live", track, note, velocity });
  }

  /** The tracks last described, by id and kind, and whether each is played live (dev diagnostics). */
  trackSummary(): string[] {
    return (this.pendingDesc?.tracks ?? []).map((t) => `${t.id} ${t.kind}${t.live ? " LIVE" : ""}`);
  }

  get loaded(): boolean {
    return this.node !== null;
  }

  get sampleRate(): number {
    return getAudioContext()?.sampleRate ?? 48_000;
  }

  dispose(): void {
    this.disposed = true;
    live.delete(this);
    if (!this.node) return;
    this.post({ type: "follow", playing: false, wanted: 0, at: 0, tolerance: 0 });
    const node = this.node;
    this.node = null;
    this.analysers = null;
    // Let the released notes ring out before the node goes.
    setTimeout(() => {
      node.port.close();
      node.disconnect();
    }, 1500);
  }
}
