import { beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

// No DOM in this suite: a canvas whose 2D context swallows every call.
beforeAll(() => {
  const context = new Proxy({}, { get: () => () => {}, set: () => true });
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  });
});

describe("UV checker swap", () => {
  it("puts the checker on every material slot for the draw, then gives each mesh its own back", async () => {
    const { swapInUVChecker, getUVCheckerMaterial } = await import("./uvChecker");
    const own = new THREE.MeshStandardMaterial({ color: 0x336699 });
    const slots = [new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial()];
    const single = new THREE.Mesh(new THREE.BoxGeometry(), own);
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), slots);

    const restore = swapInUVChecker([single, multi]);
    const checker = getUVCheckerMaterial();
    expect(single.material).toBe(checker);
    expect(multi.material).toEqual([checker, checker]);
    expect((checker.map as THREE.Texture).wrapS).toBe(THREE.RepeatWrapping);

    restore();
    expect(single.material).toBe(own);
    expect(multi.material).toBe(slots);
    // The object's own material is never touched.
    expect(own.map).toBeNull();
  });

  it("is a no-op with nothing to swap", async () => {
    const { swapInUVChecker } = await import("./uvChecker");
    expect(() => swapInUVChecker([])()).not.toThrow();
  });
});
