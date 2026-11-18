import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { classifyVowel, LipsyncAnalyzer, lpc, lpcFormants, pickFormants, VISEMES } from "../../audio/lipsync";
import { EvalContext } from "../types";
import { LIPSYNC_NODE, MORPH_TARGETS_NODE } from "./lipsync";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "test" };

/** A voiced vowel: a 120 Hz glottal pulse train through two resonators at the vowel's formants. */
function vowel(f1: number, f2: number, rate: number, length: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(length);
  const resonate = (input: Float32Array, freq: number, bandwidth: number) => {
    const r = Math.exp((-Math.PI * bandwidth) / rate);
    const c1 = 2 * r * Math.cos((2 * Math.PI * freq) / rate);
    const c2 = -r * r;
    const y = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) y[i] = input[i] + c1 * (y[i - 1] ?? 0) + c2 * (y[i - 2] ?? 0);
    return y;
  };
  const period = Math.round(rate / 120);
  for (let i = 0; i < length; i += period) out[i] = 1;
  const a = resonate(out, f1, 80);
  const b = resonate(out, f2, 120);
  let peak = 0;
  for (let i = 0; i < length; i++) {
    out[i] = a[i] + 0.5 * b[i];
    peak = Math.max(peak, Math.abs(out[i]));
  }
  for (let i = 0; i < length; i++) out[i] *= 0.3 / peak;
  return out;
}

/** White noise, high-passed by first difference: the hiss of an s. */
function hiss(length: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(length);
  let seed = 1;
  let prev = 0;
  for (let i = 0; i < length; i++) {
    seed = (seed * 16807) % 2147483647;
    const x = seed / 2147483647 - 0.5;
    out[i] = (x - prev) * 0.4;
    prev = x;
  }
  return out;
}

/** Feeds a signal through the detector frame by frame, as the audio graph would at 60 fps. */
function detect(signal: Float32Array, rate = 48000): string[] {
  let cursor = 0;
  const source = {
    fftSize: 1024,
    context: { sampleRate: rate },
    getFloatTimeDomainData: (out: Float32Array) => out.set(signal.subarray(cursor - 1024, cursor)),
  };
  const detector = new LipsyncAnalyzer(source);
  const seen: string[] = [];
  for (cursor = 1024; cursor <= signal.length; cursor += rate / 60) seen.push(detector.process());
  return seen;
}

const mostly = (seen: string[]) => {
  const counts = new Map<string, number>();
  for (const v of seen.slice(4)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

describe("viseme detection", () => {
  test("vowels land on their mouth shape by formants", () => {
    expect(mostly(detect(vowel(700, 1250, 48000, 24000)))).toBe("viseme_aa");
    expect(mostly(detect(vowel(250, 2350, 48000, 24000)))).toBe("viseme_I");
    expect(mostly(detect(vowel(270, 680, 48000, 24000)))).toBe("viseme_U");
    expect(mostly(detect(vowel(380, 2050, 48000, 24000)))).toBe("viseme_E");
  });

  test("hiss is a fricative, silence is silence", () => {
    expect(mostly(detect(hiss(24000)))).toBe("viseme_SS");
    expect(mostly(detect(new Float32Array(24000)))).toBe("viseme_sil");
  });

  test("classifyVowel: nearest formant pair, and F3 tells the French u from i", () => {
    expect(classifyVowel(650, 1300)).toBe("viseme_aa");
    expect(classifyVowel(500, 950)).toBe("viseme_O");
    expect(classifyVowel(290, 2150, 3100)).toBe("viseme_I");
    expect(classifyVowel(290, 2000, 2250)).toBe("viseme_U");
  });

  test("LPC root finding recovers the formants of a synthetic vowel", () => {
    const rate = 11025;
    const x = Float64Array.from(vowel(500, 1500, rate, 512));
    for (let i = 0; i < x.length; i++) x[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (x.length - 1));
    const a = lpc(x, 12)!;
    const { f1, f2 } = pickFormants(lpcFormants(a, rate));
    expect(Math.abs(f1 - 500)).toBeLessThan(60);
    expect(Math.abs(f2 - 1500)).toBeLessThan(120);
  });
});

describe("LIPSYNC_NODE", () => {
  test("with no audio context it stays silent and finite", () => {
    const out = LIPSYNC_NODE.evaluate({}, LIPSYNC_NODE.defaultParams, CTX);
    expect(out.viseme).toBe("viseme_sil");
    expect(out.weights).toHaveLength(VISEMES.length);
    for (const key of ["index", "open", "wide", "round", "volume"]) expect(Number.isFinite(out[key])).toBe(true);
  });
});

describe("MORPH_TARGETS_NODE", () => {
  const meshWithKeys = () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.morphTargetDictionary = { viseme_aa: 0, viseme_O: 1, blink: 2 };
    mesh.morphTargetInfluences = [0, 0, 0];
    return mesh;
  };

  test("writes weights onto the matching keys and passes the object through", () => {
    const mesh = meshWithKeys();
    const group = new THREE.Group().add(mesh);
    const weights = VISEMES.map((v) => (v === "viseme_aa" ? 0.8 : v === "viseme_O" ? 0.4 : 0));
    const out = MORPH_TARGETS_NODE.evaluate({ geometry: group, weights }, MORPH_TARGETS_NODE.defaultParams, CTX);
    expect(out.geometry).toBe(group);
    expect(out.matched).toBe(2);
    expect(mesh.morphTargetInfluences).toEqual([0.8, 0.4, 0]);
  });

  test("custom names and strength", () => {
    const mesh = meshWithKeys();
    MORPH_TARGETS_NODE.evaluate({ geometry: mesh, weights: [1] }, { names: "blink", strength: 0.5 }, CTX);
    expect(mesh.morphTargetInfluences![2]).toBe(0.5);
  });

  test("no geometry, no crash", () => {
    expect(MORPH_TARGETS_NODE.evaluate({}, MORPH_TARGETS_NODE.defaultParams, CTX).matched).toBe(0);
  });
});
