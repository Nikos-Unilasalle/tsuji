import {
  clipOffsetNow,
  decodePlayerBuffer,
  enableMicrophone,
  getAudioContext,
  getAudioOutput,
  getOrCreateAnalyser,
  getOrCreateMic,
  getOrCreatePeakDetector,
  getOrCreatePlayer,
  getOrCreateSynth,
  requestPause,
  requestPlay,
  stopClip,
  syncClip,
} from "../../audio/audioStore";
import { planClip } from "../../audio/clipPlan";
import { Rolloff, ROLLOFFS, SpatialMode, spatialGain } from "../../audio/spatial";
import * as THREE from "three";
import { asVector3 } from "./transform";
import { NodeDefinition } from "../types";
import { numberInput } from "./object";

/**
 * Audio Player — plays a local sound file.
 *
 * Two ways to drive it:
 *  - Anchored (Start Frame ≥ 0): the sound is part of the timeline. It starts at Start Frame, plays only while the timeline
 *    plays, stays in step with the playhead, begins again at its start point whenever the timeline comes back round, and
 *    lands on the same frame in an export. The playhead decides; the speaker follows (see audio/clipPlan.ts).
 *  - Free (Start Frame −1): driven by the Play and Trigger inputs, as a game or an installation would.
 *
 * In both, "Start in file" and "Stop in file" cut the region of the file that plays, so one long track can serve several
 * scenes without being split.
 */
/**
 * When an export last captured a frame. The viewport on screen keeps evaluating the same graph while an export runs, from a
 * paused timeline; if it were allowed to say "silence" it would cut the sound the export is asking for, every frame.
 */
let lastCaptureAt = -Infinity;
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const AUDIO_PLAYER_NODE: NodeDefinition = {
  type: "sound/player",
  label: "Audio Player",
  category: "sound",
  inputs: [
    { id: "play", label: "Play", type: "value" },
    { id: "trigger", label: "Trigger", type: "value" },
    { id: "volume", label: "Volume", type: "value" },
    { id: "playbackRate", label: "Speed", type: "value" },
    { id: "seek", label: "Seek (s)", type: "value" },
    { id: "startFrame", label: "Start Frame", type: "value" },
    { id: "clipStart", label: "Start in File (s)", type: "value" },
    { id: "clipEnd", label: "Stop in File (s)", type: "value" },
    { id: "position", label: "Position (local)", type: "vector" },
    { id: "innerRadius", label: "Full-Volume Radius", type: "value" },
    { id: "outerRadius", label: "Fade-Out Radius", type: "value" },
  ],
  outputs: [
    { id: "audio", label: "Audio", type: "any" },
    { id: "volume", label: "Volume", type: "value" },
    { id: "duration", label: "Duration", type: "value" },
    { id: "position", label: "Position", type: "value" },
    // The decoded file's object URL, published as a socket so the timeline's
    // waveform strip can find it through the graph like any other value. It
    // used to be read straight out of the audio store's module cache, which
    // React had no way of knowing had changed.
    { id: "url", label: "Audio URL", type: "text" },
    { id: "startFrame", label: "Start Frame", type: "value" },
    // Where the file's first second sits relative to Start Frame, and where the played region ends: the waveform strip
    // draws the whole file at its true place and shades what will not sound.
    { id: "clipOffsetFrames", label: "Clip Offset (frames)", type: "value" },
    { id: "clipEndFrames", label: "Clip End (frames)", type: "value" },
    { id: "loop", label: "Loop", type: "value" },
  ],
  defaultParams: {
    filePath: "",
    loop: 1,
    volume: 1,
    playbackRate: 1,
    startFrame: -1,
    clipStart: 0,
    clipEnd: 0,
    spatialMode: "global",
    position: new THREE.Vector3(0, 0, 0),
    innerRadius: 2,
    outerRadius: 12,
    rolloff: "linear",
  },
  dynamicParamFields: () => [
    {
      id: "filePath",
      label: "Audio File",
      kind: "file",
      accept: [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"],
      onLoaded: (nodeId, path, content) => {
        const player = getOrCreatePlayer(nodeId);
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        const mime: Record<string, string> = {
          mp3: "audio/mpeg",
          wav: "audio/wav",
          ogg: "audio/ogg",
          flac: "audio/flac",
          m4a: "audio/mp4",
          aac: "audio/aac",
        };
        stopClip(player);
        player.buffer = undefined;
        const blob = new Blob([content], { type: mime[ext] || "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        // Preload + force a load now so a later play() starts instantly instead
        // of buffering the whole file on the trigger's rising edge.
        player.audioEl.preload = "auto";
        player.audioEl.src = url;
        player.audioEl.load?.();
        player.loadedPath = url;
        // The same bytes, decoded, for timeline playback.
        if (content instanceof Uint8Array || content instanceof ArrayBuffer) void decodePlayerBuffer(player, content);
      },
    },
    { id: "loop", label: "Loop (the start→stop region)", kind: "boolean" },
    {
      id: "startFrame",
      label: "Start Frame on the timeline (-1 = driven by Play / Trigger)",
      kind: "number",
      step: 1,
    },
    { id: "clipStart", label: "Start in File (s)", kind: "number", step: 0.1 },
    { id: "clipEnd", label: "Stop in File (s, 0 = end of file)", kind: "number", step: 0.1 },
    { id: "volume", label: "Volume", kind: "number", step: 0.05 },
    { id: "playbackRate", label: "Speed", kind: "number", step: 0.1 },
    {
      id: "spatialMode",
      label: "Sound (global: the same everywhere · local: heard inside a sphere that fades out, from the camera)",
      kind: "select",
      options: ["global", "local"],
    },
    { id: "position", label: "Position (local)", kind: "vector", group: "Local sound" },
    { id: "innerRadius", label: "Full-Volume Radius", kind: "number", step: 0.5, group: "Local sound" },
    { id: "outerRadius", label: "Fade-Out Radius (silent beyond)", kind: "number", step: 0.5, group: "Local sound" },
    { id: "rolloff", label: "Fall-Off", kind: "select", options: [...ROLLOFFS], group: "Local sound" },
  ],
  evaluate: (inputs, params, ctx) => {
    const player = getOrCreatePlayer(ctx.nodeId);
    const audioEl = player.audioEl;

    const playInput = inputs.play !== undefined ? Number(inputs.play) > 0 : false;
    const volume = Math.max(0, Math.min(1, inputs.volume !== undefined ? Number(inputs.volume) : Number(params.volume) || 1));
    const rate = Math.max(0.25, Math.min(4, inputs.playbackRate !== undefined ? Number(inputs.playbackRate) : Number(params.playbackRate) || 1));
    const loop = params.loop !== undefined ? Boolean(params.loop) : true;
    const clipStart = Math.max(0, numberInput(inputs.clipStart, params.clipStart, 0));
    const clipEnd = Math.max(0, numberInput(inputs.clipEnd, params.clipEnd, 0));
    const fps = Math.max(1, Number(ctx.fps) || 30);

    // Global: the same everywhere. Local: a sphere around Position that fades out; the listener is the active camera.
    const mode: SpatialMode = params.spatialMode === "local" ? "local" : "global";
    const rolloff: Rolloff = (ROLLOFFS as string[]).includes(String(params.rolloff)) ? (params.rolloff as Rolloff) : "linear";
    let listener: { x: number; y: number; z: number } | null = null;
    if (ctx.activeCameraPose) listener = new THREE.Vector3().setFromMatrixPosition(ctx.activeCameraPose.matrix);
    const heard = spatialGain(
      mode,
      listener,
      asVector3(inputs.position ?? params.position, new THREE.Vector3()),
      numberInput(inputs.innerRadius, params.innerRadius, 2),
      numberInput(inputs.outerRadius, params.outerRadius, 12),
      rolloff,
    );
    const level = volume * heard;

    audioEl.volume = Math.max(0, Math.min(1, level));
    audioEl.playbackRate = rate;
    if (player.gainNode) player.gainNode.gain.value = level;

    const fileLength = player.buffer?.duration ?? (isNaN(audioEl.duration) ? 0 : audioEl.duration);
    const inPoint = Math.min(clipStart, fileLength || clipStart);
    const outPoint = clipEnd > 0 ? Math.min(clipEnd, fileLength || clipEnd) : fileLength;
    const regionActive = clipStart > 0 || clipEnd > 0;
    const published = {
      audio: player,
      url: player.loadedPath ?? "",
      clipOffsetFrames: clipStart * fps,
      clipEndFrames: outPoint * fps,
      loop: loop ? 1 : 0,
    };

    // Anchoring the clip to a frame. -1 (the default) keeps the node exactly as
    // it was — driven by Play and Trigger — so nothing already built changes
    // behaviour. Set to a frame and the clip becomes part of the timeline.
    const startFrame = Math.round(numberInput(inputs.startFrame, params.startFrame, -1));
    if (startFrame >= 0) {
      audioEl.loop = false;
      // Sound only while the timeline runs (or while a frame is being captured for an export); a paused timeline is silent.
      const running = ctx.isPlaying !== false || ctx.capturing === true;
      const frame = ctx.currentFrame ?? -1;
      if (ctx.capturing) lastCaptureAt = nowMs();
      const yieldToExport = !ctx.capturing && nowMs() - lastCaptureAt < 400;
      // One render loop at a time tells the speaker where to be: whichever drove it last keeps it while it keeps driving.
      const sessionId = ctx.sessionId ?? "main";
      const now = nowMs();
      const taken = player.driver !== undefined && player.driver.id !== sessionId && now - player.driver.at < 300;
      if (!taken) player.driver = { id: sessionId, at: now };
      const plan = planClip({ frame, fps, startFrame, clipStart, clipEnd, clipLength: fileLength, loop, rate });

      if (yieldToExport || taken) {
        // An export, or another viewport, is driving the sound; leave it alone.
      } else if (player.buffer) {
        syncClip(player, running ? plan : { ...plan, active: false }, { rate, loop, tolerance: ctx.capturing ? 0.15 : 0.08 });
        player.isPlaying = player.clip !== undefined;
      } else if (audioEl.src) {
        // No decoded buffer (no Web Audio here, or the file would not decode): a media element does what it can.
        if (running && plan.active) {
          if (Math.abs(audioEl.currentTime - plan.offset) > 0.25) audioEl.currentTime = plan.offset;
          if (audioEl.paused) {
            requestPlay(player);
            player.isPlaying = true;
          }
        } else if (!audioEl.paused) {
          requestPause(player);
          player.isPlaying = false;
        }
      }

      return {
        ...published,
        volume: player.isPlaying ? level : 0,
        duration: fileLength,
        position: plan.active ? plan.offset : clipOffsetNowOrZero(player, audioEl),
        startFrame,
      };
    }

    // Free-running: the clip is not on the timeline, so any buffer source it had must not go on sounding.
    stopClip(player);

    // The region: a media element plays the whole file unless told otherwise, so with a start or stop point the loop is
    // done by hand below.
    audioEl.loop = loop && !regionActive;

    if (inputs.seek !== undefined && !isNaN(Number(inputs.seek))) {
      const targetPos = Math.max(0, Math.min(audioEl.duration || 0, Number(inputs.seek)));
      if (Math.abs(audioEl.currentTime - targetPos) > 0.5) {
        audioEl.currentTime = targetPos;
      }
    }

    // Trigger: a rising edge (0 -> 1) starts the sound from its start point and
    // plays it to completion. While that playback is running the trigger is
    // inactive — holding it at 1 (or re-pulsing it) does not restart until the
    // sound has actually ended.
    const trigger = inputs.trigger !== undefined ? Number(inputs.trigger) > 0 : false;
    const risingTrigger = trigger && !player.lastTrigger;
    player.lastTrigger = trigger;

    if (risingTrigger && audioEl.src) {
      audioEl.currentTime = inPoint;
      requestPlay(player);
      player.isPlaying = true;
      player.triggerLocked = true;
    }

    if (player.triggerLocked) {
      audioEl.onended = () => {
        player.triggerLocked = false;
        player.isPlaying = false;
      };
    } else {
      audioEl.onended = null;
      if (playInput && audioEl.paused && audioEl.src) {
        // Starting (or resuming past the end): begin at the start point.
        if (audioEl.currentTime < inPoint || (outPoint > 0 && audioEl.currentTime >= outPoint)) audioEl.currentTime = inPoint;
        requestPlay(player);
        player.isPlaying = true;
      } else if (!playInput && !audioEl.paused) {
        requestPause(player);
        player.isPlaying = false;
      }
    }

    // The stop point: loop back to the start point, or end the sound there.
    if (regionActive && !audioEl.paused && outPoint > 0 && audioEl.currentTime >= outPoint) {
      if (loop) {
        audioEl.currentTime = inPoint;
      } else {
        requestPause(player);
        player.isPlaying = false;
        player.triggerLocked = false;
      }
    }

    return {
      ...published,
      volume: audioEl.paused ? 0 : level,
      duration: fileLength,
      position: isNaN(audioEl.currentTime) ? 0 : audioEl.currentTime,
      // Published so the timeline's waveform strip can draw the clip where it
      // will actually be heard.
      startFrame,
    };
  },
};

function clipOffsetNowOrZero(player: Parameters<typeof clipOffsetNow>[0], audioEl: HTMLAudioElement): number {
  const now = clipOffsetNow(player);
  if (now !== null) return now;
  return isNaN(audioEl.currentTime) ? 0 : audioEl.currentTime;
}

/** Resamples a numeric array to a target length via linear interpolation */
function resampleArray(source: number[], targetLength: number): number[] {
  if (targetLength <= 0) return [];
  if (source.length === targetLength) return source;
  if (source.length === 0) return new Array(targetLength).fill(0);
  if (targetLength === 1) {
    const sum = source.reduce((a, b) => a + b, 0);
    return [sum / source.length];
  }

  const result: number[] = new Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const srcIndex = (i / (targetLength - 1)) * (source.length - 1);
    const low = Math.floor(srcIndex);
    const high = Math.min(source.length - 1, Math.ceil(srcIndex));
    const frac = srcIndex - low;
    result[i] = source[low] * (1 - frac) + source[high] * frac;
  }
  return result;
}

/** Audio Spectrum (FFT) node — performs real-time frequency analysis and outputs spectrum array & bass/mid/treble volume levels. */
export const AUDIO_SPECTRUM_NODE: NodeDefinition = {
  type: "sound/spectrum",
  label: "Audio Spectrum",
  category: "sound",
  inputs: [
    { id: "audio", label: "Audio In", type: "any" },
    { id: "bins", label: "Bins", type: "value" },
    { id: "smoothing", label: "Smoothing", type: "value" },
  ],
  outputs: [
    { id: "spectrum", label: "Spectrum List", type: "list" },
    { id: "bass", label: "Bass", type: "value" },
    { id: "mid", label: "Mid", type: "value" },
    { id: "treble", label: "Treble", type: "value" },
    { id: "volume", label: "Volume", type: "value" },
  ],
  defaultParams: { bins: 32, smoothing: 0.8 },
  paramFields: [
    { id: "bins", label: "Frequency Bins", kind: "number", step: 1 },
    { id: "smoothing", label: "Smoothing", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const targetBins = Math.max(1, Math.min(256, Math.floor(Number(inputs.bins) || Number(params.bins) || 32)));
    // Web Audio FFT size must be a power of 2 >= 32
    const fftSize = Math.max(32, Math.pow(2, Math.ceil(Math.log2(Math.max(16, targetBins * 2)))));
    const smoothing = Math.max(0, Math.min(0.99, inputs.smoothing !== undefined ? Number(inputs.smoothing) : Number(params.smoothing) ?? 0.8));

    const analyserState = getOrCreateAnalyser(ctx.nodeId, fftSize);

    if (!analyserState) {
      const dummySpectrum = new Array(targetBins).fill(0);
      return { spectrum: dummySpectrum, bass: 0, mid: 0, treble: 0, volume: 0 };
    }

    const { analyser, dataArray } = analyserState;
    analyser.smoothingTimeConstant = smoothing;

    const audioInput = inputs.audio as { sourceNode?: AudioNode; gainNode?: AudioNode } | undefined;
    if (audioInput?.gainNode) {
      try {
        audioInput.gainNode.connect(analyser);
      } catch {}
    } else if (audioInput?.sourceNode) {
      try {
        audioInput.sourceNode.connect(analyser);
      } catch {}
    }

    analyser.getByteFrequencyData(dataArray);

    const rawSpectrum: number[] = [];
    let sumTotal = 0;
    let sumBass = 0;
    let sumMid = 0;
    let sumTreble = 0;

    const len = dataArray.length;
    const bassEnd = Math.floor(len * 0.15);
    const midEnd = Math.floor(len * 0.65);

    for (let i = 0; i < len; i++) {
      const norm = dataArray[i] / 255;
      rawSpectrum.push(norm);
      sumTotal += norm;

      if (i <= bassEnd) sumBass += norm;
      else if (i <= midEnd) sumMid += norm;
      else sumTreble += norm;
    }

    const volume = len > 0 ? sumTotal / len : 0;
    const bass = bassEnd > 0 ? sumBass / (bassEnd + 1) : 0;
    const mid = midEnd > bassEnd ? sumMid / (midEnd - bassEnd) : 0;
    const treble = len > midEnd ? sumTreble / (len - midEnd) : 0;

    // Resample raw FFT spectrum to EXACTLY targetBins count
    const spectrum = resampleArray(rawSpectrum, targetBins);

    return { spectrum, bass, mid, treble, volume };
  },
};

/** Microphone Input node — captures live audio input from the user's microphone. */
export const MICROPHONE_INPUT_NODE: NodeDefinition = {
  type: "sound/microphone",
  label: "Microphone Input",
  category: "sound",
  inputs: [
    { id: "enable", label: "Enable", type: "value" },
    { id: "gain", label: "Gain", type: "value" },
  ],
  outputs: [
    { id: "audio", label: "Audio", type: "any" },
    { id: "volume", label: "Volume", type: "value" },
  ],
  defaultParams: { enable: 1, gain: 1 },
  paramFields: [
    { id: "enable", label: "Enable Mic", kind: "boolean" },
    { id: "gain", label: "Gain", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const enable = inputs.enable !== undefined ? Number(inputs.enable) > 0 : Boolean(params.enable ?? true);
    const gain = Math.max(0, inputs.gain !== undefined ? Number(inputs.gain) : Number(params.gain) ?? 1);

    const micState = getOrCreateMic(ctx.nodeId);

    if (enable && !micState.stream) {
      enableMicrophone(ctx.nodeId).catch(() => {});
    }

    if (micState.gainNode) {
      micState.gainNode.gain.value = gain;
    }

    return {
      audio: micState,
      volume: enable ? 1 : 0,
    };
  },
};

/** Audio Peak / Beat Detector node — triggers a pulse and peak envelope when volume exceeds threshold. */
export const AUDIO_PEAK_DETECTOR_NODE: NodeDefinition = {
  type: "sound/peak-detector",
  label: "Audio Peak Detector",
  category: "sound",
  inputs: [
    { id: "volume", label: "Volume In", type: "value" },
    { id: "threshold", label: "Threshold", type: "value" },
    { id: "decay", label: "Decay", type: "value" },
  ],
  outputs: [
    { id: "trigger", label: "Beat Pulse", type: "value" },
    { id: "peak", label: "Envelope", type: "value" },
  ],
  defaultParams: { threshold: 0.5, decay: 0.9 },
  paramFields: [
    { id: "threshold", label: "Threshold (0..1)", kind: "number", step: 0.05 },
    { id: "decay", label: "Decay Speed", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const val = Math.max(0, Number(inputs.volume) || 0);
    const threshold = Math.max(0, Math.min(1, inputs.threshold !== undefined ? Number(inputs.threshold) : Number(params.threshold) ?? 0.5));
    const decay = Math.max(0.1, Math.min(0.99, inputs.decay !== undefined ? Number(inputs.decay) : Number(params.decay) ?? 0.9));

    const peakState = getOrCreatePeakDetector(ctx.nodeId);

    peakState.envelope = Math.max(val, peakState.envelope * decay);

    const isOverThreshold = val >= threshold;
    const isRising = val > peakState.lastValue + 0.05;
    const trigger = isOverThreshold && isRising && !peakState.isBeat ? 1 : 0;

    peakState.isBeat = isOverThreshold;
    peakState.lastValue = val;

    return {
      trigger,
      peak: peakState.envelope,
    };
  },
};

const WAVEFORM_OPTIONS = ["sine", "square", "sawtooth", "triangle"];

/** Audio Synth node — generates synthetic audio tones with controllable frequency, waveform, and volume. */
export const AUDIO_SYNTH_NODE: NodeDefinition = {
  type: "sound/synth",
  label: "Audio Synth",
  category: "sound",
  inputs: [
    { id: "frequency", label: "Pitch (Hz)", type: "value" },
    { id: "trigger", label: "Gate", type: "value" },
    { id: "volume", label: "Volume", type: "value" },
  ],
  outputs: [
    { id: "audio", label: "Audio", type: "any" },
    { id: "volume", label: "Volume", type: "value" },
  ],
  defaultParams: { waveform: "sine", frequency: 440, volume: 0.5 },
  paramFields: [
    { id: "waveform", label: "Waveform", kind: "select", options: WAVEFORM_OPTIONS },
    { id: "frequency", label: "Frequency (Hz)", kind: "number", step: 10 },
    { id: "volume", label: "Volume", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const synthState = getOrCreateSynth(ctx.nodeId);
    const ctxWeb = getAudioContext();

    const freq = Math.max(20, Math.min(20000, inputs.frequency !== undefined ? Number(inputs.frequency) : Number(params.frequency) || 440));
    const volume = Math.max(0, Math.min(1, inputs.volume !== undefined ? Number(inputs.volume) : Number(params.volume) || 0.5));
    const gate = inputs.trigger !== undefined ? Number(inputs.trigger) > 0 : true;
    const waveform = (params.waveform as OscillatorType) || "sine";

    if (ctxWeb && gate) {
      if (!synthState.osc) {
        try {
          const osc = ctxWeb.createOscillator();
          const gain = ctxWeb.createGain();
          osc.type = waveform;
          osc.frequency.value = freq;
          gain.gain.value = volume;
          osc.connect(gain);
          gain.connect(getAudioOutput() ?? ctxWeb.destination);
          osc.start();
          synthState.osc = osc;
          synthState.gainNode = gain;
          synthState.isPlaying = true;
        } catch {}
      } else {
        if (synthState.osc.type !== waveform) synthState.osc.type = waveform;
        synthState.osc.frequency.value = freq;
        if (synthState.gainNode) synthState.gainNode.gain.value = volume;
      }
    } else if (!gate && synthState.osc) {
      try {
        synthState.osc.stop();
        synthState.osc.disconnect();
      } catch {}
      synthState.osc = undefined;
      synthState.isPlaying = false;
    }

    return {
      audio: synthState,
      volume: gate ? volume : 0,
    };
  },
};
