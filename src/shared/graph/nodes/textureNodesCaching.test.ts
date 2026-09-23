import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { EvalContext } from "../types";
import { TEXTURE_MIX_PAINT_NODE, getTextureMixPaintState } from "./textureMixPaint";
import { TEXTURE_HEIGHT_SLOPE_MIX_NODE, getHeightSlopeMixState } from "./textureHeightSlopeMix";
import { TEXTURE_PAINT_NODE, getTexturePaintState } from "./texturePaint";

/**
 * The graph re-evaluates every node every frame, so these nodes' cost is
 * decided by whether they can tell "nothing moved" cheaply. A composite pass
 * is ~res² × layers, which at 1024² and four layers is millions of operations
 * per frame — these tests pin down that it only happens when it must.
 */

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });

function plane(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 2, 2), new THREE.MeshStandardMaterial());
  mesh.geometry.computeVertexNormals();
  return mesh;
}

/** A composite writes to the canvas, which bumps the CanvasTexture version. */
function textureVersion(texture: unknown): number {
  return texture instanceof THREE.Texture ? texture.version : -1;
}

describe("TEXTURE_MIX_PAINT_NODE caching", () => {
  const params = { ...TEXTURE_MIX_PAINT_NODE.defaultParams, resolution: 128 };

  it("composites once and then skips identical evaluations", () => {
    const c = ctx("mix_idle");
    const inputs = { geometry: plane(), texture0: new THREE.Texture() };

    const first = TEXTURE_MIX_PAINT_NODE.evaluate(inputs, params, c);
    const afterFirst = textureVersion(first.texture);
    expect(afterFirst).toBeGreaterThan(0);

    for (let frame = 0; frame < 5; frame++) {
      TEXTURE_MIX_PAINT_NODE.evaluate(inputs, params, c);
    }
    // Five more frames of an untouched node must cost no compositing at all.
    expect(textureVersion(first.texture)).toBe(afterFirst);
  });

  it("recomposites when a parameter changes", () => {
    const c = ctx("mix_params");
    const inputs = { geometry: plane(), texture0: new THREE.Texture() };

    const res = TEXTURE_MIX_PAINT_NODE.evaluate(inputs, params, c);

    // A resolution change reallocates the canvas, so the texture wrapping it
    // is a different object rather than a newer version of the same one.
    const resized = TEXTURE_MIX_PAINT_NODE.evaluate(inputs, { ...params, resolution: 256 }, c);
    expect(resized.texture).not.toBe(res.texture);
    expect(getTextureMixPaintState("mix_params").res).toBe(256);
  });

  it("recomposites when a layer texture is replaced or retiled", () => {
    const c = ctx("mix_layers");
    const geometry = plane();
    const t0 = new THREE.Texture();

    TEXTURE_MIX_PAINT_NODE.evaluate({ geometry, texture0: t0 }, params, c);
    const state = getTextureMixPaintState("mix_layers");
    const before = textureVersion(state.texture);

    TEXTURE_MIX_PAINT_NODE.evaluate({ geometry, texture0: new THREE.Texture() }, params, c);
    const afterSwap = textureVersion(state.texture);
    expect(afterSwap).not.toBe(before);

    TEXTURE_MIX_PAINT_NODE.evaluate({ geometry, texture0: t0 }, { ...params, uvScale0: 4 }, c);
    expect(textureVersion(state.texture)).not.toBe(afterSwap);
  });

  it("recomposites after the brush edits the weights", () => {
    const c = ctx("mix_paint");
    const inputs = { geometry: plane(), texture0: new THREE.Texture() };

    TEXTURE_MIX_PAINT_NODE.evaluate(inputs, params, c);
    const state = getTextureMixPaintState("mix_paint");
    const before = textureVersion(state.texture);

    // What the viewport does mid-stroke: edit the weights, bump the version.
    state.splatBuffer![0] = 0.25;
    state.splatVersion = (state.splatVersion ?? 0) + 1;

    TEXTURE_MIX_PAINT_NODE.evaluate(inputs, params, c);
    expect(textureVersion(state.texture)).not.toBe(before);
  });

  it("publishes the resolved layers for the viewport brush to recomposite with", () => {
    const c = ctx("mix_layers_published");
    const t0 = new THREE.Texture();
    const t1 = new THREE.Texture();

    TEXTURE_MIX_PAINT_NODE.evaluate({ geometry: plane(), texture0: t0, texture1: t1 }, params, c);

    // This used to be left undefined, so painting composited against an empty
    // layer list and the artwork flashed back to the debug palette.
    const state = getTextureMixPaintState("mix_layers_published");
    expect(state.layers).toHaveLength(2);
    expect(state.layers?.[0].texture).toBe(t0);
    expect(state.layerCount).toBe(2);
  });
});

describe("TEXTURE_HEIGHT_SLOPE_MIX_NODE caching", () => {
  const params = { ...TEXTURE_HEIGHT_SLOPE_MIX_NODE.defaultParams, resolution: 128 };

  it("bakes once and then skips identical evaluations", () => {
    const c = ctx("topo_idle");
    const inputs = { geometry: plane() };

    TEXTURE_HEIGHT_SLOPE_MIX_NODE.evaluate(inputs, params, c);
    const state = getHeightSlopeMixState("topo_idle");
    const before = textureVersion(state.texture);
    expect(before).toBeGreaterThan(0);

    for (let frame = 0; frame < 5; frame++) {
      TEXTURE_HEIGHT_SLOPE_MIX_NODE.evaluate(inputs, params, c);
    }
    expect(textureVersion(state.texture)).toBe(before);
  });

  it("re-bakes when the terrain is sculpted in place", () => {
    const c = ctx("topo_sculpt");
    const geometry = plane();

    TEXTURE_HEIGHT_SLOPE_MIX_NODE.evaluate({ geometry }, params, c);
    const state = getHeightSlopeMixState("topo_sculpt");
    const before = textureVersion(state.texture);

    // Raise a vertex, as a sculpt brush does. The node used to key its cache
    // on Object3D.id, which never changes — so this went unnoticed and the
    // mix kept showing the flat-terrain bake.
    const pos = geometry.geometry.getAttribute("position") as THREE.BufferAttribute;
    pos.setZ(0, 4);
    pos.needsUpdate = true;

    TEXTURE_HEIGHT_SLOPE_MIX_NODE.evaluate({ geometry }, params, c);
    expect(textureVersion(state.texture)).not.toBe(before);
  });

  it("re-bakes when a slope or altitude threshold moves", () => {
    const c = ctx("topo_params");
    const inputs = { geometry: plane() };

    TEXTURE_HEIGHT_SLOPE_MIX_NODE.evaluate(inputs, params, c);
    const state = getHeightSlopeMixState("topo_params");
    const before = textureVersion(state.texture);

    TEXTURE_HEIGHT_SLOPE_MIX_NODE.evaluate(inputs, { ...params, slopeAngle: 55 }, c);
    expect(textureVersion(state.texture)).not.toBe(before);
  });

  it("keeps at least three layer slots so the default flat/slope/snow set works", () => {
    const c = ctx("topo_layers");
    TEXTURE_HEIGHT_SLOPE_MIX_NODE.evaluate({ geometry: plane() }, params, c);
    expect(getHeightSlopeMixState("topo_layers").layerCount).toBeGreaterThanOrEqual(3);
  });
});

describe("TEXTURE_PAINT_NODE texture lifecycle", () => {
  it("keeps the same CanvasTexture across frames instead of rebuilding it", () => {
    const c = ctx("paint_reuse");
    const params = { ...TEXTURE_PAINT_NODE.defaultParams, resolution: 128 };
    const inputs = { geometry: plane() };

    const first = TEXTURE_PAINT_NODE.evaluate(inputs, params, c);
    const second = TEXTURE_PAINT_NODE.evaluate(inputs, params, c);

    // Rebuilding disposes a live GPU texture and re-uploads it every frame.
    expect(second.texture).toBe(first.texture);
    expect(getTexturePaintState("paint_reuse").texture).toBe(first.texture);
  });

  it("rebuilds the canvas when the resolution or base colour changes", () => {
    const c = ctx("paint_res");
    const params = { ...TEXTURE_PAINT_NODE.defaultParams, resolution: 128 };
    const inputs = { geometry: plane() };

    const first = TEXTURE_PAINT_NODE.evaluate(inputs, params, c);
    const resized = TEXTURE_PAINT_NODE.evaluate(inputs, { ...params, resolution: 256 }, c);
    expect(resized.texture).not.toBe(first.texture);

    const recoloured = TEXTURE_PAINT_NODE.evaluate(
      inputs,
      { ...params, resolution: 256, baseColor: "#123456" },
      c,
    );
    expect(recoloured.texture).not.toBe(resized.texture);
  });

  it("tags the painted meshes so the viewport can find its target", () => {
    const c = ctx("paint_target");
    const mesh = plane();
    TEXTURE_PAINT_NODE.evaluate({ geometry: mesh }, TEXTURE_PAINT_NODE.defaultParams, c);
    expect(mesh.userData.isTexturePaintTarget).toBe(true);
    expect(mesh.userData.nodeId).toBe("paint_target");
  });
});
