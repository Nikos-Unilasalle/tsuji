import { describe, expect, test } from "vitest";
import { Graph } from "./types";
import { isFetchablePath, rehydrateFileNodesFromDisk, resolveProjectPath, setProjectDirectory } from "./rehydrateFiles";

describe("rehydrateFileNodesFromDisk", () => {
  test("no-op outside Tauri (browser dev mode), regardless of file-backed nodes present", async () => {
    const graph: Graph = {
      nodes: [
        { id: "csv-x", type: "io/csv-reader", params: { filePath: "/tmp/data.csv" }, position: { x: 0, y: 0 } },
        { id: "obj-x", type: "object/obj", params: { filePath: "/tmp/model.obj" }, position: { x: 0, y: 0 } },
        { id: "tex-x", type: "texture/image", params: { filePath: "/tmp/image.png" }, position: { x: 0, y: 0 } },
        { id: "aud-x", type: "sound/player", params: { filePath: "/tmp/track.mp3" }, position: { x: 0, y: 0 } },
      ],
      connections: [],
    };

    await expect(rehydrateFileNodesFromDisk(graph)).resolves.toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  });

  test("no-op when no node has a file param set", async () => {
    const graph: Graph = {
      nodes: [{ id: "csv-x", type: "io/csv-reader", params: {}, position: { x: 0, y: 0 } }],
      connections: [],
    };

    await expect(rehydrateFileNodesFromDisk(graph)).resolves.toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  });
});

describe("resolveProjectPath", () => {
  test("a relative path is read next to the project file; an absolute one is left alone", () => {
    setProjectDirectory("/Users/me/work/title.tsuji");
    expect(resolveProjectPath("assets/photo.png")).toBe("/Users/me/work/assets/photo.png");
    expect(resolveProjectPath("./assets/photo.png")).toBe("/Users/me/work/assets/photo.png");
    expect(resolveProjectPath("/tmp/photo.png")).toBe("/tmp/photo.png");
    expect(resolveProjectPath("C:\\media\\photo.png")).toBe("C:\\media\\photo.png");
  });

  test("with no project folder known, the path is untouched", () => {
    setProjectDirectory(null);
    expect(resolveProjectPath("assets/photo.png")).toBe("assets/photo.png");
  });
});

describe("isFetchablePath", () => {
  test("URLs and bundled demo files can be fetched; disk paths cannot", () => {
    expect(isFetchablePath("https://example.com/a.png")).toBe(true);
    expect(isFetchablePath("demos/goodboy/a.png")).toBe(true);
    expect(isFetchablePath("/demos/goodboy/a.png")).toBe(true);
    expect(isFetchablePath("assets/a.png")).toBe(false);
    expect(isFetchablePath("/Users/me/a.png")).toBe(false);
  });
});
