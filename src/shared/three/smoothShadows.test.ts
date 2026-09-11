import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { enableSmoothShadows } from "./smoothShadows";

describe("enableSmoothShadows", () => {
  it("patches THREE.ShaderChunk.shadowmap_pars_fragment with 32 samples", () => {
    enableSmoothShadows(32);
    const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
    expect(chunk).toContain("vogelDiskSample( i, 32, phi )");
    expect(chunk).not.toContain("vogelDiskSample( 0, 5, phi )");
  });
});
