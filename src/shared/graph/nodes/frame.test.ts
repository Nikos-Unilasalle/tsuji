import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "./index";
import { CANVAS_FRAME_NODE, FRAME_MIN_HEIGHT, FRAME_MIN_WIDTH, FRAME_TYPE, frameSize } from "./frame";
import { POSE_PROXY_NODES } from "../../three/poseProxyNodes";

describe("canvas frame", () => {
  it("is registered, socket-less and evaluates to nothing", () => {
    const def = DEFAULT_REGISTRY.get(FRAME_TYPE);
    expect(def).toBe(CANVAS_FRAME_NODE);
    expect(def!.inputs).toEqual([]);
    expect(def!.outputs).toEqual([]);
    expect(def!.evaluate({}, def!.defaultParams, {} as never)).toEqual({});
  });

  it("clamps its size so a bad param can't collapse it", () => {
    expect(frameSize({ width: 10, height: -5 })).toEqual({ width: FRAME_MIN_WIDTH, height: FRAME_MIN_HEIGHT });
    expect(frameSize({ width: "abc" })).toEqual({ width: 420, height: 280 });
    expect(frameSize({ width: 600, height: 300 })).toEqual({ width: 600, height: 300 });
  });
});

describe("pose proxy nodes", () => {
  it("only names registered node types that own a location", () => {
    for (const type of Object.keys(POSE_PROXY_NODES)) {
      const def = DEFAULT_REGISTRY.get(type);
      expect(def, type).toBeDefined();
      expect(def!.defaultParams, type).toHaveProperty(POSE_PROXY_NODES[type].locationParam ?? "location");
    }
  });
});
