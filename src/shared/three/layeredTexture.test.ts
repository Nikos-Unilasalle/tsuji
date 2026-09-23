import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyTextureToGeometry,
  clampRegion,
  compositeLayers,
  ensureLayeredCanvases,
  geometryVersionKey,
  getLayerBitmap,
  layersSignature,
  resolveLayers,
  syncCanvasTexture,
  syncLayeredMaterial,
  type LayeredTextureState,
} from "./layeredTexture";
import { createPaintCanvas } from "./texturePainter";
import { LayerSource, createSplatBuffer, heightBandWeights } from "./textureMixEngine";

function fakeTexture(): THREE.Texture {
  return new THREE.Texture();
}

describe("resolveLayers", () => {
  it("reports at least the requested minimum of layer slots", () => {
    const layers = resolveLayers({}, {}, { prefix: "texture", minLayers: 3 });
    expect(layers).toHaveLength(3);
    expect(layers.every((l) => l.texture === null)).toBe(true);
    // Each empty slot still gets a distinct fallback swatch.
    expect(new Set(layers.map((l) => l.color)).size).toBe(3);
  });

  it("stops at the first unwired socket past the minimum", () => {
    const t0 = fakeTexture();
    const t1 = fakeTexture();
    const layers = resolveLayers({ texture0: t0, texture1: t1 }, {}, { prefix: "texture", minLayers: 1 });
    expect(layers).toHaveLength(2);
    expect(layers[0].texture).toBe(t0);
    expect(layers[1].texture).toBe(t1);
  });

  it("carries per-layer uv scale through from the params", () => {
    const layers = resolveLayers(
      { texture0: fakeTexture(), texture1: fakeTexture() },
      { uvScale0: 4, uvScale1: 0.5 },
      { prefix: "texture", minLayers: 1 },
    );
    expect(layers[0].uvScale).toBe(4);
    expect(layers[1].uvScale).toBe(0.5);
  });

  it("ignores non-texture values wired into a texture socket", () => {
    const layers = resolveLayers({ texture0: 42 }, {}, { prefix: "texture", minLayers: 1 });
    expect(layers[0].texture).toBeNull();
  });

  it("respects the hard layer cap", () => {
    const inputs: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) inputs[`texture${i}`] = fakeTexture();
    expect(resolveLayers(inputs, {}, { prefix: "texture", maxLayers: 8 })).toHaveLength(8);
  });
});

describe("getLayerBitmap", () => {
  it("returns null rather than throwing when there is no DOM", () => {
    // The node test environment has no document; extraction must degrade.
    expect(getLayerBitmap(fakeTexture(), 64)).toBeNull();
  });
});

describe("layersSignature", () => {
  it("changes when a texture is swapped, replaced or retiled", () => {
    const a = fakeTexture();
    const b = fakeTexture();
    const base: LayerSource[] = [{ texture: a, uvScale: 1 }];

    const sig = layersSignature(base);
    expect(layersSignature([{ texture: a, uvScale: 1 }])).toBe(sig);
    expect(layersSignature([{ texture: b, uvScale: 1 }])).not.toBe(sig);
    expect(layersSignature([{ texture: a, uvScale: 2 }])).not.toBe(sig);

    a.version++;
    expect(layersSignature(base)).not.toBe(sig);
  });

  it("distinguishes an empty slot from a wired one", () => {
    expect(layersSignature([{ texture: null }])).not.toBe(layersSignature([{ texture: fakeTexture() }]));
  });
});

describe("geometryVersionKey", () => {
  const meshWithGeometry = () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    return new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
  };

  it("is stable while nothing changes", () => {
    const mesh = meshWithGeometry();
    expect(geometryVersionKey(mesh)).toBe(geometryVersionKey(mesh));
  });

  it("changes when the vertices are edited in place", () => {
    const mesh = meshWithGeometry();
    const before = geometryVersionKey(mesh);

    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    pos.setY(0, 5);
    pos.needsUpdate = true; // what a sculpt does

    // Object3D.id is untouched here — the old key would have missed this.
    expect(geometryVersionKey(mesh)).not.toBe(before);
  });

  it("changes when the vertex count changes", () => {
    const a = meshWithGeometry();
    const before = geometryVersionKey(a);
    a.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3),
    );
    expect(geometryVersionKey(a)).not.toBe(before);
  });

  it("handles a missing geometry", () => {
    expect(geometryVersionKey(null)).toBe("none");
    expect(geometryVersionKey(new THREE.Group())).toBeTruthy();
  });
});

describe("heightBandWeights", () => {
  const rules = { shoreHeight: 0.2, shoreBlend: 0.1, snowHeight: 0.7, snowBlend: 0.2, hasShore: true };

  it("hands a threshold exactly half to each side", () => {
    // What the panel's bar draws at the handle is the halfway blend, because
    // it calls this same function — that is the point of sharing it.
    expect(heightBandWeights(rules.snowHeight, rules).peak).toBeCloseTo(0.5, 5);
    expect(heightBandWeights(rules.shoreHeight, rules).shore).toBeCloseTo(0.5, 5);
  });

  it("is fully one band well away from the thresholds", () => {
    expect(heightBandWeights(1, rules).peak).toBeCloseTo(1, 5);
    expect(heightBandWeights(0, rules).shore).toBeCloseTo(1, 5);
    const mid = heightBandWeights(0.45, rules);
    expect(mid.base).toBeCloseTo(1, 5);
  });

  it("widens the transition as the softness grows", () => {
    const sharp = heightBandWeights(0.75, { ...rules, snowBlend: 0.02 });
    const soft = heightBandWeights(0.75, { ...rules, snowBlend: 0.5 });
    expect(sharp.peak).toBeGreaterThan(soft.peak);
  });

  it("drops the shore band entirely when it is switched off", () => {
    const off = heightBandWeights(0, { ...rules, hasShore: false });
    expect(off.shore).toBe(0);
    expect(off.base).toBeCloseTo(1, 5);
  });

  it("never reports negative weight where two bands overlap", () => {
    const overlapping = { shoreHeight: 0.6, shoreBlend: 0.6, snowHeight: 0.5, snowBlend: 0.6, hasShore: true };
    for (let h = 0; h <= 1; h += 0.05) {
      const w = heightBandWeights(h, overlapping);
      expect(w.base).toBeGreaterThanOrEqual(0);
      expect(w.peak).toBeGreaterThanOrEqual(0);
      expect(w.shore).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("syncCanvasTexture", () => {
  it("reuses the existing texture when the canvas is the same", () => {
    const canvas = createPaintCanvas(32, 32);
    const first = syncCanvasTexture(undefined, canvas, THREE.SRGBColorSpace);
    const second = syncCanvasTexture(first, canvas, THREE.SRGBColorSpace);
    // Rebuilding would dispose a live GPU texture and re-upload every frame;
    // reuse just bumps the version so the renderer re-uploads the pixels.
    expect(second).toBe(first);
    expect(second.version).toBeGreaterThan(0);
  });

  it("builds a new texture when the canvas is replaced", () => {
    const first = syncCanvasTexture(undefined, createPaintCanvas(32, 32), THREE.SRGBColorSpace);
    const second = syncCanvasTexture(first, createPaintCanvas(64, 64), THREE.SRGBColorSpace);
    expect(second).not.toBe(first);
    expect(second.wrapS).toBe(THREE.RepeatWrapping);
  });
});

describe("clampRegion", () => {
  it("clips a region to the canvas", () => {
    expect(clampRegion({ minX: -5, minY: -5, maxX: 4.2, maxY: 100 }, 10, 10)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 5,
      maxY: 9,
    });
  });

  it("returns null for nothing and for an inverted region", () => {
    expect(clampRegion(null, 10, 10)).toBeNull();
    expect(clampRegion({ minX: 8, minY: 0, maxX: 2, maxY: 4 }, 10, 10)).toBeNull();
    expect(clampRegion({ minX: 20, minY: 20, maxX: 30, maxY: 30 }, 10, 10)).toBeNull();
  });
});

describe("compositeLayers", () => {
  const makeState = (size: number, layerCount: number): LayeredTextureState => {
    const state: LayeredTextureState = {};
    ensureLayeredCanvases(state, size, createPaintCanvas, { splatPreview: false });
    state.splatBuffer = createSplatBuffer(size, size, layerCount);
    return state;
  };

  const readPixel = (state: LayeredTextureState, x: number, y: number) => {
    const ctx = state.outCanvas!.getContext("2d")!;
    return Array.from(ctx.getImageData(x, y, 1, 1).data);
  };

  it("paints the fallback colour of whichever layer holds the weight", () => {
    const state = makeState(16, 2);
    const layers: LayerSource[] = [{ color: "#ff0000" }, { color: "#0000ff" }];

    compositeLayers(state, layers);
    expect(readPixel(state, 0, 0)).toEqual([255, 0, 0, 255]);

    // Hand all the weight to layer 1.
    for (let i = 0; i < 16 * 16; i++) {
      state.splatBuffer![i * 2] = 0;
      state.splatBuffer![i * 2 + 1] = 1;
    }
    compositeLayers(state, layers);
    expect(readPixel(state, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it("blends two layers by their weights", () => {
    const state = makeState(16, 2);
    for (let i = 0; i < 16 * 16; i++) {
      state.splatBuffer![i * 2] = 0.5;
      state.splatBuffer![i * 2 + 1] = 0.5;
    }
    compositeLayers(state, [{ color: "#ff0000" }, { color: "#0000ff" }]);
    const px = readPixel(state, 1, 1);
    expect(px[0]).toBeGreaterThan(100);
    expect(px[0]).toBeLessThan(160);
    expect(px[2]).toBeGreaterThan(100);
    expect(px[2]).toBeLessThan(160);
  });

  it("only repaints the dirty rect it is given", () => {
    const state = makeState(16, 2);
    const layers: LayerSource[] = [{ color: "#ff0000" }, { color: "#0000ff" }];
    compositeLayers(state, layers);

    // Flip every pixel to layer 1, but declare only a 2x2 corner dirty.
    for (let i = 0; i < 16 * 16; i++) {
      state.splatBuffer![i * 2] = 0;
      state.splatBuffer![i * 2 + 1] = 1;
    }
    compositeLayers(state, layers, { minX: 0, minY: 0, maxX: 1, maxY: 1 });

    expect(readPixel(state, 0, 0)).toEqual([0, 0, 255, 255]);
    // Outside the rect the old composite must survive — that is the saving.
    expect(readPixel(state, 5, 5)).toEqual([255, 0, 0, 255]);
  });

  it("does a full pass when the image buffer had to be reallocated", () => {
    const state = makeState(16, 2);
    for (let i = 0; i < 16 * 16; i++) {
      state.splatBuffer![i * 2] = 0;
      state.splatBuffer![i * 2 + 1] = 1;
    }
    // First call ever, with a dirty rect: the rest of the canvas has never
    // been composited, so the rect must be ignored.
    compositeLayers(state, [{ color: "#ff0000" }, { color: "#0000ff" }], { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(readPixel(state, 6, 6)).toEqual([0, 0, 255, 255]);
  });

  it("does nothing without a canvas or a splat buffer", () => {
    expect(() => compositeLayers({}, [{ color: "#ff0000" }])).not.toThrow();
  });
});

describe("syncLayeredMaterial", () => {
  it("creates the material once and then only updates its values", () => {
    const state: LayeredTextureState = {};
    const first = syncLayeredMaterial(state, { roughness: 0.3 }, { roughness: 0.7, metalness: 0 });
    expect(first.roughness).toBeCloseTo(0.3);

    const second = syncLayeredMaterial(state, { roughness: 0.9, metalness: 0.4 }, { roughness: 0.7, metalness: 0 });
    expect(second).toBe(first);
    expect(second.roughness).toBeCloseTo(0.9);
    expect(second.metalness).toBeCloseTo(0.4);
  });

  it("only asks for a shader recompile when the map identity changes", () => {
    const state: LayeredTextureState = {};
    const mat = syncLayeredMaterial(state, {}, { roughness: 0.5, metalness: 0 });

    const before = mat.version;
    syncLayeredMaterial(state, { roughness: 0.6 }, { roughness: 0.5, metalness: 0 });
    // Same (absent) map: recompiling every frame is pure waste.
    expect(mat.version).toBe(before);

    state.texture = syncCanvasTexture(undefined, createPaintCanvas(16, 16), THREE.SRGBColorSpace);
    syncLayeredMaterial(state, {}, { roughness: 0.5, metalness: 0 });
    expect(mat.map).toBe(state.texture);
    expect(mat.version).toBeGreaterThan(before);
  });

  it("falls back to the defaults when the params carry nothing", () => {
    const mat = syncLayeredMaterial({}, {}, { roughness: 0.7, metalness: 0.2 });
    expect(mat.roughness).toBeCloseTo(0.7);
    expect(mat.metalness).toBeCloseTo(0.2);
  });
});

describe("applyTextureToGeometry", () => {
  const scene = () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    group.add(mesh);
    return { group, mesh };
  };

  it("pushes the texture onto every mesh material and tags the mesh", () => {
    const { group, mesh } = scene();
    const texture = new THREE.Texture();
    applyTextureToGeometry(group, texture, new THREE.MeshStandardMaterial(), "node_1", "isTextureMixTarget");

    expect((mesh.material as THREE.MeshStandardMaterial).map).toBe(texture);
    expect(mesh.userData.nodeId).toBe("node_1");
    expect(mesh.userData.isTextureMixTarget).toBe(true);
  });

  it("covers every slot of a multi-material mesh", () => {
    const group = new THREE.Group();
    const mats = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), mats));
    const texture = new THREE.Texture();

    applyTextureToGeometry(group, texture, new THREE.MeshStandardMaterial(), "node_1");
    expect(mats.every((m) => m.map === texture)).toBe(true);
  });

  it("installs the fallback material on a mesh that has none", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    // three gives meshes a default material, so drop it to model the case.
    (mesh as unknown as { material: THREE.Material | null }).material = null;
    const group = new THREE.Group();
    group.add(mesh);

    const fallback = new THREE.MeshStandardMaterial();
    applyTextureToGeometry(group, null, fallback, "node_1");
    expect(mesh.material).toBe(fallback);
  });

  it("does nothing without geometry", () => {
    expect(() => applyTextureToGeometry(null, null, new THREE.MeshStandardMaterial(), "n")).not.toThrow();
  });
});
