import { FmPatch, FmSynth } from "./fm";

/**
 * Every operator sounding, nothing ever decaying to silence: what a voice costs at most, whatever the patch. The
 * algorithm with the most routing work (1, a full stack, three modulations per sample) and full feedback.
 */
const sustained = { ratio: 1, detune: 0, level: 0.5, velocitySens: 0, attack: 0.001, decay: 1, sustain: 1, release: 1 };
export const WORST_CASE_PATCH: FmPatch = {
  algorithm: 1,
  feedback: 1,
  ops: [sustained, { ...sustained, ratio: 2 }, { ...sustained, ratio: 3 }, { ...sustained, ratio: 0.5 }],
};

/** The MVP's voice budget at its peak: 3 FM tracks × 8 voices, all held. */
export function worstCaseSynths(sampleRate: number): FmSynth[] {
  return [0, 1, 2].map((t) => {
    const synth = new FmSynth(8, sampleRate);
    synth.setPatch(WORST_CASE_PATCH);
    for (let v = 0; v < 8; v++) synth.noteOn(36 + t * 12 + v * 2, 1);
    return synth;
  });
}
