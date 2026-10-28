/**
 * The music engine, without Web Audio: tracks (an FmSynth each, through one Mixer), a transport, and the scheduler
 * that turns the sequencer's notes into note-ons and note-offs on their exact samples. The AudioWorklet wraps it for
 * live playback; the export (step 6) will run the same class offline from sample 0.
 *
 * Transport:
 * - play / pause / seek, in song samples (sample 0 = step 0 of every sequence);
 * - `follow(playing, wanted, tolerance)`: what the graph calls each frame with where the playhead says the song is.
 *   The engine keeps its own sample-exact clock and only jumps when it is further than `tolerance` from the playhead
 *   (a seek, a loop of the timeline, a drift), so the frame rate's coarse steps never reach the sound.
 *
 * No clicks: pausing and seeking release the notes (their tails ring out under their envelopes), a seek starts the
 * notes that should already be sounding at the new position, and a stolen voice fades (see FmSynth).
 */
import { DrumSynth } from "../dsp/drums";
import { FmSynth } from "../dsp/fm";
import { Mixer, MonoSource } from "../dsp/mix";
import { NoteEvent, Sequence, notesSoundingAt, notesStartingIn } from "../seq/sequencer";
import { MusicDescription, PreviewSound, TrackDescription } from "./description";

/** What a track plays through: an FmSynth or a DrumSynth. */
interface Instrument extends MonoSource {
  readonly voices: number;
  noteOn(note: number, velocity: number, glide?: { from: number; seconds: number }): number;
  noteOff(note: number): void;
  allNotesOff(): void;
  activeVoices(): number;
}

interface Track {
  id: string;
  kind: TrackDescription["kind"];
  synth: Instrument;
  seq: Sequence;
  /** JSON of what was last applied, to tell a real change from the same description sent again. */
  patchKey: string;
  seqKey: string;
  /** Notes started and not yet ended, with their note-off as a song sample. */
  offs: { at: number; note: number }[];
}

interface Due {
  /** Offset in the block. */
  at: number;
  off: boolean;
  track: Track;
  note: number;
  e: NoteEvent | null;
}

const MAX_VOICES = 16;
const PREVIEW_ID = "__preview";

function glideOf(e: NoteEvent): { from: number; seconds: number } | undefined {
  return e.glideFrom === undefined ? undefined : { from: e.glideFrom, seconds: e.glideSeconds ?? 0 };
}

/** Offs before ons on the same sample: a note that ends where it starts again is let go before it is struck. */
function insertDue(list: Due[], from: number, item: Due): void {
  let i = from;
  while (i < list.length && (list[i].at < item.at || (list[i].at === item.at && (list[i].off || !item.off)))) i++;
  list.splice(i, 0, item);
}

export class EngineCore {
  readonly sampleRate: number;
  private mixer: Mixer;
  private tracks = new Map<string, Track>();
  private playing = false;
  /** The song sample the next rendered sample is. */
  private pos = 0;
  /** How many times `follow` had to jump: seeks and loops, or drift if it keeps climbing on its own. */
  jumps = 0;
  /** The audition instrument, on its own channel, heard whether the transport runs or not. */
  private preview: { key: string; synth: Instrument; offs: { left: number; note: number }[] } | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.mixer = new Mixer(sampleRate);
  }

  get position(): number {
    return this.pos;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Voices sounding, the audition's included. */
  activeVoices(): number {
    let n = this.preview?.synth.activeVoices() ?? 0;
    for (const t of this.tracks.values()) n += t.synth.activeVoices();
    return n;
  }

  /** Applies a description; tracks are matched by id, and only what changed is touched. */
  describe(desc: MusicDescription): void {
    const seen = new Set<string>();
    for (const d of desc.tracks) {
      seen.add(d.id);
      const voices = d.kind === "fm" ? Math.max(1, Math.min(MAX_VOICES, Math.round(d.voices))) : 0;
      let track = this.tracks.get(d.id);
      if (!track || track.kind !== d.kind || (d.kind === "fm" && track.synth.voices !== voices)) {
        track?.synth.allNotesOff();
        const synth = d.kind === "fm" ? new FmSynth(voices, this.sampleRate) : new DrumSynth(this.sampleRate);
        track = { id: d.id, kind: d.kind, synth, seq: d.seq, patchKey: "", seqKey: "", offs: [] };
        this.tracks.set(d.id, track);
        // With its own settings from the start: a track that appears muted must not glide down from full level.
        this.mixer.addChannel(d.id, track.synth, { level: d.level, pan: d.pan, mute: d.mute });
      }
      const patchKey = JSON.stringify(d.kind === "fm" ? d.patch : d.drums);
      if (patchKey !== track.patchKey) {
        if (d.kind === "fm") (track.synth as FmSynth).setPatch(d.patch);
        else (track.synth as DrumSynth).setSettings(d.drums);
        track.patchKey = patchKey;
      }
      const seqKey = JSON.stringify(d.seq);
      if (seqKey !== track.seqKey) {
        const first = track.seqKey === "";
        track.seq = d.seq;
        track.seqKey = seqKey;
        if (!first) this.releaseWhatTheNewSequenceDoesNotHold(track);
      }
      this.mixer.setChannel(d.id, { level: d.level, pan: d.pan, mute: d.mute });
    }
    for (const [id, track] of this.tracks) {
      if (seen.has(id)) continue;
      track.synth.allNotesOff();
      this.mixer.removeChannel(id);
      this.tracks.delete(id);
    }
    this.mixer.setMaster(desc.master);
  }

  /** A pattern edited under a held note: let go of the notes the new pattern does not have sounding here. */
  private releaseWhatTheNewSequenceDoesNotHold(track: Track): void {
    const keep = new Set(this.playing ? notesSoundingAt(track.seq, this.sampleRate, this.pos).map((e) => e.note) : []);
    track.offs = track.offs.filter((o) => {
      if (keep.has(o.note)) return true;
      track.synth.noteOff(o.note);
      return false;
    });
  }

  /** Sounds one note on `sound` for `seconds`, outside the song (the Pattern HUD's audition). */
  previewNote(sound: PreviewSound, note: number, velocity: number, seconds = 0.35): void {
    const key = JSON.stringify(sound);
    if (!this.preview || this.preview.key !== key) {
      const synth: Instrument = sound.kind === "fm" ? new FmSynth(4, this.sampleRate) : new DrumSynth(this.sampleRate);
      if (sound.kind === "fm") (synth as FmSynth).setPatch(sound.patch);
      else (synth as DrumSynth).setSettings(sound.drums);
      this.preview = { key, synth, offs: [] };
      this.mixer.addChannel(PREVIEW_ID, synth, { level: 0.8, pan: 0, mute: false });
    }
    this.preview.synth.noteOn(note, velocity);
    this.preview.offs.push({ left: Math.round(seconds * this.sampleRate), note });
  }

  /** Lets the audition's notes go once their time is up (to the block: an audition needs no sample accuracy). */
  private tickPreview(n: number): void {
    if (!this.preview) return;
    const p = this.preview;
    p.offs = p.offs.filter((o) => {
      o.left -= n;
      if (o.left > 0) return true;
      p.synth.noteOff(o.note);
      return false;
    });
  }

  play(at: number = this.pos): void {
    if (this.playing && at === this.pos) return;
    this.pos = Math.max(0, Math.round(at));
    this.playing = true;
    this.restartAt(this.pos);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.releaseAll();
  }

  seek(at: number): void {
    this.pos = Math.max(0, Math.round(at));
    if (this.playing) this.restartAt(this.pos);
  }

  /**
   * Each frame: where the playhead says the song is. Starts, stops or jumps only when it has to — a play or pause, or
   * a playhead more than `tolerance` samples away from the engine's own clock (a seek, a loop, a drift).
   */
  follow(playing: boolean, wanted: number, tolerance: number): void {
    if (!playing) {
      this.pause();
      return;
    }
    if (!this.playing) this.play(wanted);
    else if (Math.abs(this.pos - wanted) > tolerance) {
      this.jumps++;
      this.seek(wanted);
    }
  }

  private releaseAll(): void {
    for (const t of this.tracks.values()) {
      t.synth.allNotesOff();
      t.offs = [];
    }
  }

  /**
   * After a play or a seek: every held note let go, then the notes that should already be sounding here started, so
   * a pad held across the jump is heard at once. Those that start exactly here are left to the scheduler.
   */
  private restartAt(at: number): void {
    this.releaseAll();
    for (const t of this.tracks.values()) {
      for (const e of notesSoundingAt(t.seq, this.sampleRate, at)) {
        if (e.on >= at) continue;
        t.synth.noteOn(e.note, e.velocity);
        t.offs.push({ at: e.off, note: e.note });
      }
    }
  }

  /** Writes n samples of the mix into left/right[start ..], scheduling the notes due in them while playing. */
  render(left: Float32Array, right: Float32Array, start: number, n: number): void {
    this.tickPreview(n);
    if (!this.playing) {
      // Paused: no new notes, but the released ones ring out.
      this.mixer.render(left, right, start, n);
      return;
    }
    const t = this.pos;
    const due: Due[] = [];
    for (const track of this.tracks.values()) {
      for (const e of notesStartingIn(track.seq, this.sampleRate, t, t + n)) due.push({ at: e.on - t, off: false, track, note: e.note, e });
      for (const o of track.offs) if (o.at < t + n) due.push({ at: Math.max(0, o.at - t), off: true, track, note: o.note, e: null });
      track.offs = track.offs.filter((o) => o.at >= t + n);
    }
    due.sort((a, b) => a.at - b.at || Number(b.off) - Number(a.off));

    let s = 0;
    let k = 0;
    while (s < n) {
      while (k < due.length && due[k].at <= s) {
        const d = due[k++];
        if (d.off) {
          d.track.synth.noteOff(d.note);
          continue;
        }
        const e = d.e!;
        d.track.synth.noteOn(e.note, e.velocity, glideOf(e));
        if (e.off < t + n) insertDue(due, k, { at: e.off - t, off: true, track: d.track, note: e.note, e: null });
        else d.track.offs.push({ at: e.off, note: e.note });
      }
      const until = k < due.length ? Math.min(n, due[k].at) : n;
      this.mixer.render(left, right, start + s, until - s);
      s = until;
    }
    this.pos = t + n;
  }
}

export type { MusicDescription, TrackDescription };
