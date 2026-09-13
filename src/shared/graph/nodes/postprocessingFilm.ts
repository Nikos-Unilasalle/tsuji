import * as THREE from "three";
import { NodeDefinition } from "../types";
import { toBoolean } from "../sockets";
import { asColor, numberInput } from "./object";
import { accumulateEffect } from "./postprocessing";

/**
 * The film-look half of the post-process catalogue: the effects that make a
 * render look like it went through an emulsion and a lens rather than a
 * framebuffer. Separate file from postprocessing.ts, which holds the
 * optical/technical passes (bloom, DOF, AO, antialiasing) — same `effect`
 * chain, same accumulation, they just belong to different jobs.
 *
 * All four are pure descriptions: the node hands the chain a type and a bag
 * of numbers, and postProcessChain.ts owns the pass that reads them.
 */

/** Dual Tone — the whole image graded onto a ramp between two colours. */
export const POSTPROCESS_DUOTONE_NODE: NodeDefinition = {
  type: "postprocess/duotone",
  label: "Dual Tone",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "shadowColor", label: "Shadow Color", type: "color" },
    { id: "highlightColor", label: "Highlight Color", type: "color" },
    { id: "balance", label: "Balance", type: "value" },
    { id: "softness", label: "Softness", type: "value" },
    { id: "amount", label: "Amount", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    shadowColor: new THREE.Color(0x1b2a4a),
    highlightColor: new THREE.Color(0xffd9a0),
    balance: 0.5,
    softness: 0.5,
    amount: 1.0,
  },
  paramFields: [
    { id: "shadowColor", label: "Shadow Color", kind: "color" },
    { id: "highlightColor", label: "Highlight Color", kind: "color" },
    { id: "balance", label: "Balance", kind: "number", step: 0.02 },
    { id: "softness", label: "Softness", kind: "number", step: 0.02 },
    { id: "amount", label: "Amount", kind: "number", percent: true, step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const shadowColor = asColor(inputs.shadowColor, asColor(params.shadowColor, new THREE.Color(0x1b2a4a)));
    const highlightColor = asColor(inputs.highlightColor, asColor(params.highlightColor, new THREE.Color(0xffd9a0)));
    const balance = Math.max(0, Math.min(1, numberInput(inputs.balance, params.balance, 0.5)));
    const softness = Math.max(0, Math.min(1, numberInput(inputs.softness, params.softness, 0.5)));
    const amount = Math.max(0, Math.min(1, numberInput(inputs.amount, params.amount, 1.0)));

    return {
      effect: accumulateEffect(inputs, {
        type: "duotone",
        nodeId: ctx.nodeId,
        params: { shadowColor, highlightColor, balance, softness, amount },
      }),
    };
  },
};

const HALFTONE_SHAPES = ["dot", "ellipse", "line", "square"];

/**
 * Halftone — the printed-dot grid, one screen per channel.
 *
 * Rotation is the *red* screen's angle; green and blue follow at the classic
 * 30° offsets, which is what stops the three grids from beating against each
 * other into a moiré. Greyscale collapses them onto one screen instead, for
 * the single-colour newsprint look.
 */
export const POSTPROCESS_HALFTONE_NODE: NodeDefinition = {
  type: "postprocess/halftone",
  label: "Halftone",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "radius", label: "Dot Radius (px)", type: "value" },
    { id: "rotation", label: "Rotation (°)", type: "value" },
    { id: "scatter", label: "Scatter", type: "value" },
    { id: "amount", label: "Amount", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    radius: 4,
    rotation: 15,
    scatter: 0,
    amount: 1.0,
    shape: "dot",
    greyscale: 0,
  },
  paramFields: [
    { id: "shape", label: "Shape", kind: "select", options: HALFTONE_SHAPES },
    { id: "radius", label: "Dot Radius (px)", kind: "number", step: 1 },
    { id: "rotation", label: "Rotation (°)", kind: "number", step: 5 },
    { id: "scatter", label: "Scatter", kind: "number", step: 0.05 },
    { id: "amount", label: "Amount", kind: "number", percent: true, step: 0.05 },
    { id: "greyscale", label: "Greyscale (one screen)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const radius = Math.max(1, numberInput(inputs.radius, params.radius, 4));
    const rotation = numberInput(inputs.rotation, params.rotation, 15);
    const scatter = Math.max(0, numberInput(inputs.scatter, params.scatter, 0));
    const amount = Math.max(0, Math.min(1, numberInput(inputs.amount, params.amount, 1.0)));
    const shape = HALFTONE_SHAPES.includes(String(params.shape)) ? String(params.shape) : "dot";
    const greyscale = toBoolean(params.greyscale ?? 0);

    return {
      effect: accumulateEffect(inputs, {
        type: "halftone",
        nodeId: ctx.nodeId,
        // Radians here, as the pass wants them — degrees are the panel's unit
        // only, same convention as RGB Shift's angle.
        params: { radius, rotation: (rotation * Math.PI) / 180, scatter, amount, shape, greyscale },
      }),
    };
  },
};

/**
 * Film Texture — the wear of a print rather than a look: grain, dust on the
 * gate, scratches down the frame, and chemical blotches.
 *
 * Rate is what keeps it from reading as digital noise: imperfections belong to
 * an exposed frame, so they change 16 times a second (Super 8's own rate),
 * not once per drawn frame.
 */
export const POSTPROCESS_FILM_TEXTURE_NODE: NodeDefinition = {
  type: "postprocess/film-texture",
  label: "Film Texture",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "grain", label: "Grain", type: "value" },
    { id: "dust", label: "Dust", type: "value" },
    { id: "scratches", label: "Scratches", type: "value" },
    { id: "blotches", label: "Blotches", type: "value" },
    { id: "rate", label: "Rate (fps)", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    grain: 0.12,
    dust: 0.2,
    scratches: 0.15,
    blotches: 0.15,
    rate: 16,
    seed: 0,
  },
  paramFields: [
    { id: "grain", label: "Grain", kind: "number", step: 0.02 },
    { id: "dust", label: "Dust", kind: "number", step: 0.05 },
    { id: "scratches", label: "Scratches", kind: "number", step: 0.05 },
    { id: "blotches", label: "Blotches", kind: "number", step: 0.05 },
    { id: "rate", label: "Rate (fps)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const grain = Math.max(0, Math.min(1, numberInput(inputs.grain, params.grain, 0.12)));
    const dust = Math.max(0, Math.min(1, numberInput(inputs.dust, params.dust, 0.2)));
    const scratches = Math.max(0, Math.min(1, numberInput(inputs.scratches, params.scratches, 0.15)));
    const blotches = Math.max(0, Math.min(1, numberInput(inputs.blotches, params.blotches, 0.15)));
    const rate = Math.max(1, numberInput(inputs.rate, params.rate, 16));
    const seed = numberInput(undefined, params.seed, 0);

    return {
      effect: accumulateEffect(inputs, {
        type: "film-texture",
        nodeId: ctx.nodeId,
        params: { grain, dust, scratches, blotches, rate, seed },
      }),
    };
  },
};

/**
 * Dry Brush — the little unpainted specks a loaded brush leaves behind, the
 * ones every 70s title sequence is made of.
 *
 * It punches the paper colour *through* the image rather than sprinkling white
 * on top: the specks are places that were never painted. Follow Ink keeps them
 * on the artwork (a brush can only miss where it was painting); off, they rain
 * over the whole frame like a badly inked screen print.
 *
 * Animate is off by default. A dry-brush texture that reshuffles every frame
 * boils, and boiling is a choice — a deliberate one at 8–12 fps, which is why
 * Rate is there and why it is nowhere near 60.
 */
export const POSTPROCESS_DRY_BRUSH_NODE: NodeDefinition = {
  type: "postprocess/dry-brush",
  label: "Dry Brush",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "coverage", label: "Coverage", type: "value" },
    { id: "scale", label: "Speck Size", type: "value" },
    { id: "softness", label: "Softness", type: "value" },
    { id: "stretch", label: "Stroke Length", type: "value" },
    { id: "angle", label: "Stroke Angle (°)", type: "value" },
    { id: "paperColor", label: "Paper Color", type: "color" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    coverage: 0.25,
    scale: 60,
    softness: 0.25,
    stretch: 3,
    angle: 0,
    paperColor: new THREE.Color(0xffffff),
    followInk: 1,
    animate: 0,
    rate: 12,
    seed: 0,
  },
  paramFields: [
    { id: "coverage", label: "Coverage", kind: "number", percent: true, step: 0.05 },
    { id: "scale", label: "Speck Size", kind: "number", step: 5 },
    { id: "softness", label: "Softness", kind: "number", step: 0.05 },
    { id: "stretch", label: "Stroke Length", kind: "number", step: 0.5 },
    { id: "angle", label: "Stroke Angle (°)", kind: "number", step: 5 },
    { id: "paperColor", label: "Paper Color", kind: "color" },
    { id: "followInk", label: "Only Where Painted", kind: "boolean" },
    { id: "animate", label: "Animate (boil)", kind: "boolean" },
    { id: "rate", label: "Rate (fps)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const coverage = Math.max(0, Math.min(1, numberInput(inputs.coverage, params.coverage, 0.25)));
    // Speck Size reads as "how big", the shader wants "how many per screen" —
    // so the panel's number is inverted here rather than asking the author to
    // think backwards.
    const size = Math.max(1, Math.min(400, numberInput(inputs.scale, params.scale, 60)));
    const softness = Math.max(0, Math.min(1, numberInput(inputs.softness, params.softness, 0.25)));
    const stretch = Math.max(0.1, Math.min(20, numberInput(inputs.stretch, params.stretch, 3)));
    const angle = numberInput(inputs.angle, params.angle, 0);
    const paperColor = asColor(inputs.paperColor, asColor(params.paperColor, new THREE.Color(0xffffff)));
    const followInk = toBoolean(params.followInk ?? 1);
    const animate = toBoolean(params.animate ?? 0);
    const rate = Math.max(1, numberInput(undefined, params.rate, 12));
    const seed = numberInput(undefined, params.seed, 0);

    return {
      effect: accumulateEffect(inputs, {
        type: "dry-brush",
        nodeId: ctx.nodeId,
        params: {
          coverage,
          // 3000 puts a speck at roughly `size` pixels across on a 1080p-ish
          // frame — chosen by looking at it, not derived.
          scale: 3000 / size,
          softness,
          stretch,
          angle: (angle * Math.PI) / 180,
          paperColor,
          followInk,
          animate,
          rate,
          seed,
        },
      }),
    };
  },
};

/**
 * Super 8 Projector — what the wall shows, not what the camera saw: a lens
 * that never quite resolves, an unsteady gate, lamp flicker, tungsten warmth
 * and the fall-off of the projected rectangle.
 *
 * Pairs with Film Texture, which supplies the print's damage; this node is
 * only the machine showing it. Wired one after the other, put the texture
 * first — the projector's softness should blur the dust too.
 */
export const POSTPROCESS_SUPER8_NODE: NodeDefinition = {
  type: "postprocess/super8",
  label: "Super 8 Projector",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "softness", label: "Softness (px)", type: "value" },
    { id: "flicker", label: "Flicker", type: "value" },
    { id: "weave", label: "Gate Weave", type: "value" },
    { id: "warmth", label: "Warmth", type: "value" },
    { id: "vignette", label: "Vignette", type: "value" },
    { id: "rate", label: "Rate (fps)", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    softness: 1.2,
    flicker: 0.12,
    weave: 0.35,
    warmth: 0.35,
    vignette: 0.45,
    rate: 18,
    seed: 0,
  },
  paramFields: [
    { id: "softness", label: "Softness (px)", kind: "number", step: 0.1 },
    { id: "flicker", label: "Flicker", kind: "number", step: 0.02 },
    { id: "weave", label: "Gate Weave", kind: "number", step: 0.05 },
    { id: "warmth", label: "Warmth", kind: "number", percent: true, step: 0.05 },
    { id: "vignette", label: "Vignette", kind: "number", step: 0.05 },
    { id: "rate", label: "Rate (fps)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    // Softness is in pixels of blur radius; past a few the tent kernel stops
    // reading as a soft lens and starts reading as a smear, so it is capped.
    const softness = Math.max(0, Math.min(8, numberInput(inputs.softness, params.softness, 1.2)));
    const flicker = Math.max(0, Math.min(1, numberInput(inputs.flicker, params.flicker, 0.12)));
    const weave = Math.max(0, Math.min(3, numberInput(inputs.weave, params.weave, 0.35)));
    const warmth = Math.max(0, Math.min(1, numberInput(inputs.warmth, params.warmth, 0.35)));
    const vignette = Math.max(0, Math.min(1, numberInput(inputs.vignette, params.vignette, 0.45)));
    const rate = Math.max(1, numberInput(inputs.rate, params.rate, 18));
    const seed = numberInput(undefined, params.seed, 0);

    return {
      effect: accumulateEffect(inputs, {
        type: "super8",
        nodeId: ctx.nodeId,
        params: { softness, flicker, weave, warmth, vignette, rate, seed },
      }),
    };
  },
};
