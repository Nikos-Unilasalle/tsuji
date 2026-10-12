import { describe, expect, test } from "vitest";
import { Graph } from "./types";
import { clearBrowserFolder, findBrowserFile, setBrowserFolder } from "./browserFiles";
import { countUnreadableFiles, isFetchablePath, rehydrateFileNodesFromDisk, resolveProjectPath, setProjectDirectory } from "./rehydrateFiles";

describe("rehydrateFileNodesFromDisk", () => {
  test("outside Tauri (browser), disk paths are reported missing until a project folder is chosen", async () => {
    const graph: Graph = {
      nodes: [
        { id: "csv-x", type: "io/csv-reader", params: { filePath: "/tmp/data.csv" }, position: { x: 0, y: 0 } },
        { id: "obj-x", type: "object/obj", params: { filePath: "/tmp/model.obj" }, position: { x: 0, y: 0 } },
        { id: "tex-x", type: "texture/image", params: { filePath: "/tmp/image.png" }, position: { x: 0, y: 0 } },
        { id: "aud-x", type: "sound/player", params: { filePath: "/tmp/track.mp3" }, position: { x: 0, y: 0 } },
      ],
      connections: [],
    };

    await expect(rehydrateFileNodesFromDisk(graph)).resolves.toEqual({ attempted: 0, succeeded: 0, failed: 0, missing: 4 });
    expect(countUnreadableFiles([graph])).toBe(4);
  });

  test("no-op when no node has a file param set", async () => {
    const graph: Graph = {
      nodes: [{ id: "csv-x", type: "io/csv-reader", params: {}, position: { x: 0, y: 0 } }],
      connections: [],
    };

    await expect(rehydrateFileNodesFromDisk(graph)).resolves.toEqual({ attempted: 0, succeeded: 0, failed: 0, missing: 0 });
  });

  test("a file in the chosen folder is read, the others stay missing", async () => {
    setBrowserFolder([{ path: "proj/assets/photo.png", file: new File([new Uint8Array([1, 2, 3])], "photo.png") }]);
    const graph: Graph = {
      nodes: [
        { id: "a", type: "texture/image", params: { filePath: "assets/photo.png" }, position: { x: 0, y: 0 } },
        { id: "b", type: "texture/image", params: { filePath: "assets/other.png" }, position: { x: 0, y: 0 } },
      ],
      connections: [],
    };
    const res = await rehydrateFileNodesFromDisk(graph);
    expect(res.attempted).toBe(1);
    expect(res.missing).toBe(1);
    expect(countUnreadableFiles([graph])).toBe(1);
    clearBrowserFolder();
  });
});

describe("findBrowserFile", () => {
  const file = (name: string) => new File(["x"], name);

  test("matches the project-relative path inside the chosen folder, whichever level was picked", () => {
    setBrowserFolder([
      { path: "proj/title.tsuji", file: file("title.tsuji") },
      { path: "proj/assets/photo.png", file: file("photo.png") },
    ]);
    expect(findBrowserFile("assets/photo.png")?.name).toBe("photo.png");
    expect(findBrowserFile("./assets/photo.png")?.name).toBe("photo.png");
    expect(findBrowserFile("assets/none.png")).toBeNull();
    clearBrowserFolder();
  });

  test("an absolute path from another machine falls back to the one file of that name", () => {
    setBrowserFolder([
      { path: "assets/photo.png", file: file("photo.png") },
      { path: "assets/dup.png", file: file("dup.png") },
      { path: "other/dup.png", file: file("dup.png") },
    ]);
    expect(findBrowserFile("/Users/me/Desktop/photo.png")?.name).toBe("photo.png");
    expect(findBrowserFile("/Users/me/Desktop/dup.png")).toBeNull();
    clearBrowserFolder();
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
