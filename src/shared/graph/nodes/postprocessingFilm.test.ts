import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { PostProcessConfig } from "./postprocessing";
import {
  POSTPROCESS_DRY_BRUSH_NODE,
  POSTPROCESS_DUOTONE_NODE,
  POSTPROCESS_FILM_TEXTURE_NODE,
  POSTPROCESS_HALFTONE_NODE,
  POSTPROCESS_SUPER8_NODE,
} from "./postprocessingFilm";
import { EvalContext, NodeDefinition } from "../types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "test" };

const NODES = [
  POSTPROCESS_DUOTONE_NODE,
  POSTPROCESS_HALFTONE_NODE,
  POSTPROCESS_FILM_TEXTURE_NODE,
  POSTPROCESS_SUPER8_NODE,
  POSTPROCESS_DRY_BRUSH_NODE,
];

function run(def: NodeDefinition, inputs: Record<string, unknown> = {}): PostProcessConfig {
  const list = def.evaluate(inputs, def.defaultParams, CTX).effect as PostProcessConfig[];
  return list[list.length - 1];
}

describe("the film-look post-process nodes, as a set", () => {
  test("each appends itself to the chain it was handed, keeping wire order", () => {
    const upstream: PostProcessConfig = { type: "bloom", nodeId: "up", params: {} };
    for (const def of NODES) {
      const list = def.evaluate({ effect: [upstream] }, def.defaultParams, CTX).effect as PostProcessConfig[];
      expect(list).toHaveLength(2);
      expect(list[0]).toBe(upstream);
      expect(list[1].nodeId).toBe("test");
    }
  });

  test("nothing wired: every param resolves to a finite number from defaultParams", () => {
    for (const def of NODES) {
      const cfg = run(def);
      for (const [key, value] of Object.entries(cfg.params)) {
        if (typeof value === "number") expect(Number.isFinite(value), `${def.type}.${key}`).toBe(true);
      }
    }
  });

  test("garbage on a socket falls back rather than poisoning the chain with NaN", () => {
    for (const def of NODES) {
      const junk = Object.fromEntries(def.inputs.map((s) => [s.id, "not a number"]));
      const cfg = run(def, { ...junk, effect: undefined });
      for (const [key, value] of Object.entries(cfg.params)) {
        if (typeof value === "number") expect(Number.isFinite(value), `${def.type}.${key}`).toBe(true);
      }
    }
  });
});

describe("POSTPROCESS_DUOTONE_NODE", () => {
  test("passes both colours and the blend through", () => {
    const cfg = run(POSTPROCESS_DUOTONE_NODE, {
      shadowColor: new THREE.Color(0x000000),
      highlightColor: new THREE.Color(0xffffff),
      amount: 0.4,
    });

    expect(cfg.type).toBe("duotone");
    expect((cfg.params.shadowColor as THREE.Color).getHex()).toBe(0x000000);
    expect((cfg.params.highlightColor as THREE.Color).getHex()).toBe(0xffffff);
    expect(cfg.params.amount).toBe(0.4);
  });

  test("balance, softness and amount are clamped to 0..1", () => {
    const cfg = run(POSTPROCESS_DUOTONE_NODE, { balance: 5, softness: -3, amount: 12 });
    expect(cfg.params.balance).toBe(1);
    expect(cfg.params.softness).toBe(0);
    expect(cfg.params.amount).toBe(1);
  });
});

describe("POSTPROCESS_HALFTONE_NODE", () => {
  test("rotation is handed over in radians, the unit the pass wants", () => {
    expect(run(POSTPROCESS_HALFTONE_NODE, { rotation: 180 }).params.rotation).toBeCloseTo(Math.PI);
  });

  test("a radius below one pixel would collapse the screen — clamped", () => {
    expect(run(POSTPROCESS_HALFTONE_NODE, { radius: 0 }).params.radius).toBe(1);
    expect(run(POSTPROCESS_HALFTONE_NODE, { radius: -20 }).params.radius).toBe(1);
  });

  test("an unknown shape falls back to dots rather than an undefined screen", () => {
    const cfg = POSTPROCESS_HALFTONE_NODE.evaluate(
      {},
      { ...POSTPROCESS_HALFTONE_NODE.defaultParams, shape: "hexagon" },
      CTX,
    ).effect as PostProcessConfig[];
    expect(cfg[0].params.shape).toBe("dot");
  });
});

describe("POSTPROCESS_FILM_TEXTURE_NODE", () => {
  test("each kind of wear travels separately", () => {
    const cfg = run(POSTPROCESS_FILM_TEXTURE_NODE, { grain: 0.5, dust: 0.25, scratches: 0.75, blotches: 0.1 });
    expect(cfg.type).toBe("film-texture");
    expect(cfg.params).toMatchObject({ grain: 0.5, dust: 0.25, scratches: 0.75, blotches: 0.1 });
  });

  test("rate stays at least one frame per second — the shader divides by it", () => {
    expect(run(POSTPROCESS_FILM_TEXTURE_NODE, { rate: 0 }).params.rate).toBe(1);
    expect(run(POSTPROCESS_FILM_TEXTURE_NODE, { rate: -5 }).params.rate).toBe(1);
  });
});

describe("POSTPROCESS_DRY_BRUSH_NODE", () => {
  test("the paper colour showing through is the one asked for", () => {
    const cfg = run(POSTPROCESS_DRY_BRUSH_NODE, { paperColor: new THREE.Color(0xf5efe0) });
    expect(cfg.type).toBe("dry-brush");
    expect((cfg.params.paperColor as THREE.Color).getHex()).toBe(0xf5efe0);
  });

  test("Speck Size is inverted into the shader's frequency — bigger specks, fewer of them", () => {
    const small = run(POSTPROCESS_DRY_BRUSH_NODE, { scale: 20 }).params.scale as number;
    const big = run(POSTPROCESS_DRY_BRUSH_NODE, { scale: 200 }).params.scale as number;
    expect(big).toBeLessThan(small);
    expect(big).toBeGreaterThan(0);
  });

  test("a Speck Size of zero would divide by nothing — clamped, and still finite", () => {
    const cfg = run(POSTPROCESS_DRY_BRUSH_NODE, { scale: 0 });
    expect(Number.isFinite(cfg.params.scale as number)).toBe(true);
  });

  test("stroke angle crosses over in radians, like every other angle on a socket", () => {
    expect(run(POSTPROCESS_DRY_BRUSH_NODE, { angle: 90 }).params.angle).toBeCloseTo(Math.PI / 2);
  });

  test("still by default: the pattern only boils when Animate is on", () => {
    expect(run(POSTPROCESS_DRY_BRUSH_NODE).params.animate).toBe(false);
    const boiling = POSTPROCESS_DRY_BRUSH_NODE.evaluate(
      {},
      { ...POSTPROCESS_DRY_BRUSH_NODE.defaultParams, animate: 1 },
      CTX,
    ).effect as PostProcessConfig[];
    expect(boiling[0].params.animate).toBe(true);
  });

  test("specks land on the artwork by default rather than over the whole frame", () => {
    expect(run(POSTPROCESS_DRY_BRUSH_NODE).params.followInk).toBe(true);
  });
});

describe("POSTPROCESS_SUPER8_NODE", () => {
  test("the projector's settings travel as given", () => {
    const cfg = run(POSTPROCESS_SUPER8_NODE, { softness: 2, flicker: 0.3, weave: 1, warmth: 0.6, vignette: 0.2 });
    expect(cfg.type).toBe("super8");
    expect(cfg.params).toMatchObject({ softness: 2, flicker: 0.3, weave: 1, warmth: 0.6, vignette: 0.2 });
  });

  test("softness is capped: past a few pixels the tent kernel is a smear, not a lens", () => {
    expect(run(POSTPROCESS_SUPER8_NODE, { softness: 500 }).params.softness).toBe(8);
    expect(run(POSTPROCESS_SUPER8_NODE, { softness: -1 }).params.softness).toBe(0);
  });

  test("the same time gives the same description — the pass animates, the node does not", () => {
    const early = POSTPROCESS_SUPER8_NODE.evaluate({}, POSTPROCESS_SUPER8_NODE.defaultParams, { ...CTX, time: 3 });
    const later = POSTPROCESS_SUPER8_NODE.evaluate({}, POSTPROCESS_SUPER8_NODE.defaultParams, { ...CTX, time: 9 });
    expect(early).toEqual(later);
  });
});
