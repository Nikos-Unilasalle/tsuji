import { describe, expect, it } from "vitest";
import { buildDroppedNodes, droppedKind, isDroppableImage, projectDrop, setDropProjector } from "./imageDrop";

describe("image drop", () => {
  it("accepts the image formats Image Texture loads, whatever the case", () => {
    expect(isDroppableImage("photo.PNG")).toBe(true);
    expect(isDroppableImage("/a/b/c.jpeg")).toBe(true);
    expect(isDroppableImage("notes.txt")).toBe(false);
    expect(isDroppableImage("noext")).toBe(false);
  });

  it("makes an Image Texture wired to a Texture to Plane for each image, side by side", () => {
    const { nodes, connections } = buildDroppedNodes(
      [
        { path: "/x/a.png", bytes: new Uint8Array([1]) },
        { path: "b.jpg", bytes: new Uint8Array([2]) },
      ],
      { x: 100, y: 50 },
    );
    expect(nodes.map((n) => n.type)).toEqual(["texture/image", "texture/plane", "texture/image", "texture/plane"]);
    expect(nodes[0].params.filePath).toBe("/x/a.png");
    expect(nodes[0].position).toEqual({ x: 100, y: 50 });
    expect(nodes[1].position.x).toBeGreaterThan(nodes[0].position.x);
    expect(nodes[2].position.y).toBeGreaterThan(nodes[0].position.y);
    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({ fromNode: nodes[0].id, fromSocket: "texture", toNode: nodes[1].id, toSocket: "texture" });
    expect((nodes[3].params.location as { x: number }).x).toBeCloseTo(1.6);
  });

  it("tells images, videos and sounds apart", () => {
    expect(droppedKind("a.mp4")).toBe("video");
    expect(droppedKind("a.MOV")).toBe("video");
    expect(droppedKind("song.m4a")).toBe("audio");
    expect(droppedKind("a.png")).toBe("image");
    expect(droppedKind("a.pdf")).toBeNull();
  });

  it("a video is an Image Texture + plane started with the timeline; a sound is an Audio Player started with it", () => {
    const { nodes, connections } = buildDroppedNodes(
      [
        { path: "clip.mp4", bytes: new Uint8Array([1]) },
        { path: "song.mp3", bytes: new Uint8Array([2]) },
        { path: "notes.txt", bytes: new Uint8Array([3]) },
      ],
      { x: 0, y: 0 },
    );
    expect(nodes.map((n) => n.type)).toEqual(["texture/image", "texture/plane", "sound/player"]);
    expect(nodes[0].params.startFrame).toBe(0);
    expect(nodes[2].params).toMatchObject({ filePath: "song.mp3", startFrame: 0, loop: 0, spatialMode: "global" });
    expect(connections).toHaveLength(1);
  });

  it("projects a drop only when a canvas registered", () => {
    setDropProjector(null);
    expect(projectDrop(10, 10)).toBeNull();
    setDropProjector((x, y) => ({ x: x * 2, y: y * 2 }));
    expect(projectDrop(10, 20)).toEqual({ x: 20, y: 40 });
    setDropProjector(null);
  });
});

describe("3D models dropped", () => {
  it("knows an OBJ, a glTF and a GLB for a model", () => {
    expect(droppedKind("woman.obj")).toBe("model");
    expect(droppedKind("scene.GLTF")).toBe("model");
    expect(droppedKind("/a/b/robot.glb")).toBe("model");
  });

  it("makes an OBJ Model or a glTF Model, loaded, one per file and not wired to anything", () => {
    const cube = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const { nodes, connections } = buildDroppedNodes(
      [
        { path: "tri.obj", bytes: new TextEncoder().encode(cube) },
        { path: "robot.glb", bytes: new Uint8Array([1, 2, 3]) },
      ],
      { x: 10, y: 20 },
    );
    expect(nodes.map((n) => n.type)).toEqual(["object/obj", "object/gltf"]);
    expect(nodes.map((n) => n.params.filePath)).toEqual(["tri.obj", "robot.glb"]);
    expect(nodes[1].position.y).toBeGreaterThan(nodes[0].position.y);
    expect(connections).toEqual([]);
  });
});
