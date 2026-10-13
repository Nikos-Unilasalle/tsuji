import { describe, expect, it } from "vitest";
import { buildImageNodes, isDroppableImage, projectDrop, setDropProjector } from "./imageDrop";

describe("image drop", () => {
  it("accepts the image formats Image Texture loads, whatever the case", () => {
    expect(isDroppableImage("photo.PNG")).toBe(true);
    expect(isDroppableImage("/a/b/c.jpeg")).toBe(true);
    expect(isDroppableImage("notes.txt")).toBe(false);
    expect(isDroppableImage("noext")).toBe(false);
  });

  it("makes an Image Texture wired to a Texture to Plane for each image, side by side", () => {
    const { nodes, connections } = buildImageNodes(
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

  it("projects a drop only when a canvas registered", () => {
    setDropProjector(null);
    expect(projectDrop(10, 10)).toBeNull();
    setDropProjector((x, y) => ({ x: x * 2, y: y * 2 }));
    expect(projectDrop(10, 20)).toEqual({ x: 20, y: 40 });
    setDropProjector(null);
  });
});
