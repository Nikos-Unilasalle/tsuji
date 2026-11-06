import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../isTauri";

/**
 * MIDI input: a keyboard or a controller (an Arturia MiniLab…) played into the app.
 *
 * Inside Tauri the messages come from the Rust side (`midi.rs`, the `midir` crate) as `midi:message` events: macOS's
 * WKWebView has no Web MIDI. In a plain browser (the Vite dev page in Chrome) Web MIDI is used instead. Either way the
 * listeners below get the same decoded messages. `decodeMidi` is pure, to be tested without a device.
 */

/** `time`: when the message arrived, in ms — the device's clock, not the moment a busy page got round to it. */
type Common = { channel: number; port: string; time: number };
export type MidiEvent =
  | ({ type: "noteon"; note: number; velocity: number } & Common)
  | ({ type: "noteoff"; note: number } & Common)
  | ({ type: "cc"; controller: number; value: number } & Common)
  | ({ type: "pitchbend"; value: number } & Common);

/**
 * One raw message → an event, or null for what nothing here reads (aftertouch, program change, SysEx, clock).
 * Channels are 0–15 (the 10th, drums by convention, is 9); velocity is 0–1; a note on at velocity 0 is a note off,
 * as the MIDI spec has it; pitch bend is −1…1.
 */
export function decodeMidi(bytes: ArrayLike<number>, port = "", time = 0): MidiEvent | null {
  if (bytes.length < 2) return null;
  const status = bytes[0] & 0xf0;
  const channel = bytes[0] & 0x0f;
  const a = bytes[1] & 0x7f;
  const b = (bytes[2] ?? 0) & 0x7f;
  switch (status) {
    case 0x90:
      if (bytes.length < 3) return null;
      return b === 0 ? { type: "noteoff", channel, note: a, port, time } : { type: "noteon", channel, note: a, velocity: b / 127, port, time };
    case 0x80:
      return { type: "noteoff", channel, note: a, port, time };
    case 0xb0:
      if (bytes.length < 3) return null;
      return { type: "cc", channel, controller: a, value: b, port, time };
    case 0xe0: {
      if (bytes.length < 3) return null;
      const v = (b << 7) | a; // 0…16383, 8192 at rest
      return { type: "pitchbend", channel, value: Math.max(-1, (v - 8192) / 8191), port, time };
    }
    default:
      return null;
  }
}

type MidiListener = (event: MidiEvent) => void;
type PortsListener = (ports: string[]) => void;

const listeners = new Set<MidiListener>();
const portListeners = new Set<PortsListener>();
let ports: string[] = [];
let started = false;

/** Hands a message to every listener — what the bridges call, and tests. */
export function dispatchMidi(bytes: ArrayLike<number>, port = "", time = performance.now()): void {
  const event = decodeMidi(bytes, port, time);
  if (!event) return;
  for (const l of listeners) {
    try {
      l(event);
    } catch (err) {
      // One listener failing must not silence the rest.
      console.warn("midi listener failed:", err);
    }
  }
}

function setPorts(next: string[]): void {
  if (next.length === ports.length && next.every((p, i) => p === ports[i])) return;
  ports = next;
  for (const l of portListeners) l(ports);
}

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  if (isTauri()) {
    void listen<{ port: string; bytes: number[]; time: number }>("midi:message", (e) => dispatchMidi(e.payload.bytes, e.payload.port, e.payload.time))
      .then(() => listen<string[]>("midi:ports", (e) => setPorts(e.payload)))
      .then(() => invoke<string[]>("list_midi_inputs"))
      .then(setPorts)
      .catch((err) => console.warn("native MIDI bridge unavailable:", err));
    return;
  }
  const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> };
  if (typeof nav.requestMIDIAccess !== "function") return;
  nav
    .requestMIDIAccess()
    .then((access) => {
      const attach = () => {
        const names: string[] = [];
        access.inputs.forEach((input) => {
          const name = input.name ?? input.id;
          names.push(name);
          input.onmidimessage = (m) => m.data && dispatchMidi(m.data, name, m.timeStamp);
        });
        setPorts(names.sort());
      };
      attach();
      access.onstatechange = attach;
    })
    .catch((err) => console.warn("Web MIDI unavailable:", err));
}

/** Every MIDI message from every input, from now on. Returns the unsubscribe. */
export function subscribeMidi(listener: MidiListener): () => void {
  start();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The names of the MIDI inputs open, delivered now and whenever one is plugged in or out. */
export function subscribeMidiPorts(listener: PortsListener): () => void {
  start();
  portListeners.add(listener);
  listener(ports);
  return () => void portListeners.delete(listener);
}
