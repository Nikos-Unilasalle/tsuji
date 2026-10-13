/**
 * Web Audio API manager for Tsuji — manages AudioContext, media element players,
 * FFT spectrum analysers, synth oscillators, filters, and microphone streams.
 */

import { createNodeCache } from "../graph/nodeCaches";
import { ClipPlan, clipDrift } from "./clipPlan";

let globalAudioCtx: AudioContext | null = null;
let gestureListenerInstalled = false;

/** Players that want to play but whose AudioContext is (or was) suspended. Retried on the first user gesture, when the autoplay policy is relaxed. */
const pendingPlayers = new Set<PlayerState>();

function ensureAudioUnblocked(): void {
  if (!globalAudioCtx) return;
  if (globalAudioCtx.state === "running") return;
  globalAudioCtx.resume().catch(() => {});
}

/**
 * Web Audio starts suspended until a user gesture (the autoplay policy). The
 * context may first be created — and resume() attempted — before any gesture,
 * at which point the browser refuses. Install a one-shot gesture listener so
 * the first real pointer/keyboard interaction retries: resume the context and
 * then kick off every player that wanted to play but was parked while
 * suspended. Without this, audio stays silent in stricter environments (the
 * Tauri WKWebView) until a node happens to be re-evaluated after a click.
 *
 * The plays are kicked off *synchronously* inside the gesture handler (not
 * after awaiting resume()): WKWebView only treats a play() as user-gesture
 * approved when it runs within the gesture's own call stack.
 */
function installFirstGestureResume(): void {
  if (gestureListenerInstalled || typeof window === "undefined") return;
  gestureListenerInstalled = true;
  const wake = () => {
    ensureAudioUnblocked();
    for (const p of pendingPlayers) {
      p.audioEl.play().catch(() => {});
    }
    pendingPlayers.clear();
    window.removeEventListener("pointerdown", wake);
    window.removeEventListener("keydown", wake);
    window.removeEventListener("mousedown", wake);
    window.removeEventListener("touchstart", wake);
  };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("keydown", wake);
  window.addEventListener("mousedown", wake);
  window.addEventListener("touchstart", wake);
}

/** Stop a media-element player and drop any pending retry for it. */
export function requestPause(player: PlayerState): void {
  pendingPlayers.delete(player);
  player.audioEl.pause();
}

/**
 * Start a media-element player. If the AudioContext is running this just plays;
 * if it is suspended (autoplay policy, before any gesture) the context is
 * resumed and the play parked so it can be retried on the first real user
 * gesture. Attempts play immediately either way — the resume makes the sound
 * start as soon as the policy allows instead of waiting for a later gesture.
 */
export function requestPlay(player: PlayerState): void {
  const ctx = globalAudioCtx;
  if (ctx) {
    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
      pendingPlayers.add(player);
    }
    player.audioEl.play().catch(() => {});
  } else {
    player.audioEl.play().catch(() => {});
  }
}

/**
 * The single bus every sound-producing node connects to instead of
 * `ctx.destination`. It feeds the speakers as before, and — once
 * `getAudioExportStream()` has been called — a MediaStreamDestination as well,
 * which is what lets the video export carry an audio track. Connecting nodes
 * straight to `destination` made the audio physically unreachable from
 * MediaRecorder: exported files were silent no matter what the graph played.
 */
let outputBus: GainNode | null = null;
let exportDestination: MediaStreamAudioDestinationNode | null = null;

export function getAudioOutput(): AudioNode | null {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (!outputBus) {
    outputBus = ctx.createGain();
    outputBus.gain.value = 1;
    outputBus.connect(ctx.destination);
    if (exportDestination) outputBus.connect(exportDestination);
  }
  return outputBus;
}

/**
 * A live MediaStream carrying everything the graph is playing, for the video
 * export to merge into its recording. Created on first use and kept — a
 * MediaStreamDestination is cheap and tearing it down mid-session would drop
 * the tap for any export that follows.
 */
export function getAudioExportStream(): MediaStream | null {
  const ctx = getAudioContext();
  if (!ctx) return null;
  const bus = getAudioOutput();
  if (!bus) return null;
  if (!exportDestination) {
    exportDestination = ctx.createMediaStreamDestination();
    bus.connect(exportDestination);
  }
  return exportDestination.stream;
}

export function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!globalAudioCtx) {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      globalAudioCtx = new AudioContextClass();
    }
  }
  installFirstGestureResume();
  ensureAudioUnblocked();
  return globalAudioCtx;
}

export interface PlayerState {
  audioEl: HTMLAudioElement;
  sourceNode?: MediaElementAudioSourceNode;
  gainNode?: GainNode;
  /** Left/right position of a local sound (see spatial.ts); centred when global. */
  pannerNode?: StereoPannerNode;
  loadedPath?: string;
  isPlaying: boolean;
  /** Last value of the Trigger input — used to detect the rising edge (one-shot start). */
  lastTrigger?: boolean;
  /** A trigger-driven playback is running to completion: the trigger can't re-fire and the Play input is ignored until the sound ends. */
  triggerLocked?: boolean;
  /** The decoded file, for timeline playback (Web Audio buffer sources start and stop at exact points; a media element does not). */
  buffer?: AudioBuffer;
  /** The render loop that last drove the clip. Several viewports evaluate the same graph (editor, camera view, output); if each told the speaker a slightly different position it would restart the sound all the time. */
  driver?: { id: string; at: number };
  /** The running buffer source and where it was started from — enough to tell later how far it has drifted from the plan. */
  clip?: { source: AudioBufferSourceNode; ctxStart: number; offset: number; rate: number; loop: boolean; inPoint: number; outPoint: number };
}

/** Decodes a file for timeline playback. Resolves without a buffer when decoding is impossible (no Web Audio, bad file). */
export async function decodePlayerBuffer(player: PlayerState, bytes: ArrayBuffer | Uint8Array): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  const copy = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0);
  try {
    player.buffer = await ctx.decodeAudioData(copy as ArrayBuffer);
  } catch {
    player.buffer = undefined;
  }
}

export function stopClip(player: PlayerState): void {
  const clip = player.clip;
  if (!clip) return;
  player.clip = undefined;
  clip.source.onended = null;
  try {
    clip.source.stop();
  } catch {}
  try {
    clip.source.disconnect();
  } catch {}
}

/** Where the running source is in the file now (s), or null when nothing is sounding. */
export function clipOffsetNow(player: PlayerState): number | null {
  const ctx = getAudioContext();
  const clip = player.clip;
  if (!ctx || !clip) return null;
  const advanced = clip.offset + (ctx.currentTime - clip.ctxStart) * clip.rate;
  const region = clip.outPoint - clip.inPoint;
  if (clip.loop && region > 0) return clip.inPoint + (((advanced - clip.inPoint) % region) + region) % region;
  return advanced;
}

/**
 * Makes the speaker agree with the plan: silent when the plan is, otherwise a buffer source at the planned offset. A
 * source that is already playing is left alone while it stays within `tolerance` seconds of the plan — a restart is
 * audible — and replaced as soon as it is not, which is what a timeline jump (loop back to the start, a scrub while
 * playing, Reset) looks like from here.
 */
export function syncClip(player: PlayerState, plan: ClipPlan, opts: { rate: number; loop: boolean; tolerance: number }): void {
  const ctx = getAudioContext();
  if (!ctx || !player.buffer) return;
  if (!plan.active) {
    stopClip(player);
    return;
  }
  if (ctx.state !== "running") {
    // Autoplay policy: nothing can sound yet. Asked again every frame, so it starts at the right place the moment it can.
    ctx.resume().catch(() => {});
    return;
  }
  const cur = player.clip;
  if (cur) {
    const actual = clipOffsetNow(player) ?? cur.offset;
    const same = cur.loop === opts.loop && cur.rate === opts.rate && cur.inPoint === plan.inPoint && cur.outPoint === plan.outPoint;
    if (same && Math.abs(clipDrift(actual, plan.offset, plan.inPoint, plan.outPoint, opts.loop)) <= opts.tolerance) return;
    stopClip(player);
  }
  const source = ctx.createBufferSource();
  source.buffer = player.buffer;
  source.playbackRate.value = opts.rate;
  if (opts.loop) {
    source.loop = true;
    source.loopStart = plan.inPoint;
    source.loopEnd = plan.outPoint;
  }
  source.connect(player.gainNode ?? getAudioOutput() ?? ctx.destination);
  source.onended = () => {
    if (player.clip?.source === source) player.clip = undefined;
  };
  if (opts.loop || plan.remaining === null) source.start(0, plan.offset);
  else source.start(0, plan.offset, plan.remaining);
  player.clip = { source, ctxStart: ctx.currentTime, offset: plan.offset, rate: opts.rate, loop: opts.loop, inPoint: plan.inPoint, outPoint: plan.outPoint };
}

const playerCache = createNodeCache<PlayerState>((state) => {
  stopClip(state);
  if (state.loadedPath) {
    try {
      URL.revokeObjectURL(state.loadedPath);
    } catch {}
  }
  try {
    state.audioEl.pause();
    state.audioEl.src = "";
  } catch {}
  state.sourceNode?.disconnect();
  state.gainNode?.disconnect();
  state.pannerNode?.disconnect();
});

export function getOrCreatePlayer(nodeId: string): PlayerState {
  const existing = playerCache.get(nodeId);
  if (existing) return existing;

  const audioEl: HTMLAudioElement =
    typeof Audio !== "undefined"
      ? new Audio()
      : ({
          crossOrigin: "anonymous",
          loop: false,
          volume: 1,
          playbackRate: 1,
          duration: 0,
          currentTime: 0,
          paused: true,
          src: "",
          play: () => Promise.resolve(),
          pause: () => {},
        } as unknown as HTMLAudioElement);

  audioEl.crossOrigin = "anonymous";

  // Some WebViews won't start an <audio> element (even through a Web Audio
  // MediaElementSource) until it is actually in the document — a detached
  // `new Audio()` can sit silently forever. Attach it hidden.
  if (typeof document !== "undefined" && document.body) {
    audioEl.style.display = "none";
    audioEl.setAttribute("hidden", "");
    audioEl.muted = false;
    document.body.appendChild(audioEl);
  }

  const state: PlayerState = {
    audioEl,
    isPlaying: false,
  };

  const ctx = getAudioContext();
  if (ctx) {
    try {
      const sourceNode = ctx.createMediaElementSource(audioEl);
      const gainNode = ctx.createGain();
      sourceNode.connect(gainNode);
      // Gain -> stereo panner -> the output bus; the panner sits at the centre until a local sound moves it.
      const out = getAudioOutput() ?? ctx.destination;
      if (typeof ctx.createStereoPanner === "function") {
        const pannerNode = ctx.createStereoPanner();
        gainNode.connect(pannerNode);
        pannerNode.connect(out);
        state.pannerNode = pannerNode;
      } else {
        gainNode.connect(out);
      }
      state.sourceNode = sourceNode;
      state.gainNode = gainNode;
    } catch {
      // Audio element source might already be connected or non-standard
    }
  }

  playerCache.set(nodeId, state);
  return state;
}

export interface AnalyserState {
  analyser: AnalyserNode;
  dataArray: Uint8Array;
}

const analyserCache = createNodeCache<AnalyserState>((state) => {
  try {
    state.analyser.disconnect();
  } catch {}
});

export function getOrCreateAnalyser(nodeId: string, fftSize = 128): AnalyserState | null {
  const ctx = getAudioContext();
  if (!ctx) return null;

  let state = analyserCache.get(nodeId);
  if (state && state.analyser.fftSize !== fftSize) {
    try {
      state.analyser.disconnect();
    } catch {}
    state = undefined;
  }
  if (!state) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0.8;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    state = { analyser, dataArray };
    analyserCache.set(nodeId, state);
  }
  return state;
}

export interface MicState {
  stream?: MediaStream;
  sourceNode?: MediaStreamAudioSourceNode;
  gainNode?: GainNode;
}

const micCache = createNodeCache<MicState>((state) => {
  try {
    state.sourceNode?.disconnect();
  } catch {}
  try {
    state.gainNode?.disconnect();
  } catch {}
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
});

export function getOrCreateMic(nodeId: string): MicState {
  let existing = micCache.get(nodeId);
  if (!existing) {
    existing = {};
    micCache.set(nodeId, existing);
  }
  return existing;
}

export function enableMicrophone(nodeId: string): Promise<MicState> {
  const state = getOrCreateMic(nodeId);
  if (state.stream) return Promise.resolve(state);

  const ctx = getAudioContext();
  if (!ctx || !navigator?.mediaDevices?.getUserMedia) return Promise.resolve(state);

  return navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      state.stream = stream;
      state.sourceNode = ctx.createMediaStreamSource(stream);
      state.gainNode = ctx.createGain();
      state.sourceNode.connect(state.gainNode);
      return state;
    })
    .catch((err) => {
      console.warn("Microphone access denied or error:", err);
      return state;
    });
}

export interface SynthState {
  osc?: OscillatorNode;
  gainNode?: GainNode;
  isPlaying: boolean;
}

const synthCache = createNodeCache<SynthState>((state) => {
  try {
    state.osc?.stop();
  } catch {}
  try {
    state.osc?.disconnect();
  } catch {}
  try {
    state.gainNode?.disconnect();
  } catch {}
  state.osc = undefined;
  state.isPlaying = false;
});

export function getOrCreateSynth(nodeId: string): SynthState {
  let existing = synthCache.get(nodeId);
  if (!existing) {
    existing = { isPlaying: false };
    synthCache.set(nodeId, existing);
  }
  return existing;
}

export interface PeakState {
  lastValue: number;
  envelope: number;
  isBeat: boolean;
}

const peakCache = createNodeCache<PeakState>();

export function getOrCreatePeakDetector(nodeId: string): PeakState {
  let existing = peakCache.get(nodeId);
  if (!existing) {
    existing = { lastValue: 0, envelope: 0, isBeat: false };
    peakCache.set(nodeId, existing);
  }
  return existing;
}
