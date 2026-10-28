/**
 * The page's side of the music engine: one AudioWorkletNode per Music Out node, on the app's shared AudioContext and
 * output bus. Descriptions are only posted when they change; the playhead is posted every frame.
 *
 * The worklet module is loaded on first use, once per context. Until it is there, the latest description and
 * transport are kept and sent the moment the node exists — nothing the graph said is lost to the load.
 */
import { getAudioContext, getAudioOutput } from "../../audio/audioStore";
import type { MusicDescription, PreviewSound } from "./description";
import type { EngineMessage, EngineState } from "./engine.worklet";

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
    engines: [...live].map((h) => h.state),
  });
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
        node.port.onmessage = (e: MessageEvent<EngineState>) => {
          if (e.data?.type === "state") this.state = e.data;
        };
        node.connect(getAudioOutput() ?? ctx.destination);
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
    // Let the released notes ring out before the node goes.
    setTimeout(() => {
      node.port.close();
      node.disconnect();
    }, 1500);
  }
}
