import * as THREE from "three";
import { BrushScene, brushSceneSignature } from "./brushScene";
import { renderBrushScene } from "./brushEngine";

interface Entry {
  signature: string;
  size: string;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  frameKey?: number;
}

/**
 * The last few painted results of one node, keyed by scene signature.
 *
 * One entry is not enough: a node edited back and forth, or two viewports
 * on slightly different scenes, would evict each other's result every time.
 *
 * During playback a time-driven input changes every evaluation, and every
 * viewport (3D, 2D Render, camera view) evaluates on its own clock a few
 * milliseconds apart — so no two scenes are ever equal and each viewport
 * would repaint. Pass the timeline frame as `frameKey` while playing: one
 * repaint per frame, shared by every evaluation of that frame, paced by the
 * timeline's fps instead of the display's. Each viewport also runs its own
 * playhead, so around a frame boundary one is a frame ahead of the other —
 * the key is remembered per entry, so both frames stay cached.
 */
export class BrushTextureCache {
  private entries: Entry[] = [];

  constructor(private readonly capacity = 2) {}

  /** The texture for `scene`, painted only on a miss. Null when p5.brush could not run. */
  resolve(scene: BrushScene, frameKey?: number): THREE.CanvasTexture | null {
    // Out of playback a frame no longer pins a picture: params may change
    // while the playhead sits still.
    if (frameKey === undefined) for (const e of this.entries) e.frameKey = undefined;
    const signature = brushSceneSignature(scene);
    const hit = this.entries.findIndex(
      (e) => e.signature === signature || (frameKey !== undefined && e.frameKey === frameKey),
    );
    if (hit >= 0) {
      const [entry] = this.entries.splice(hit, 1);
      if (frameKey !== undefined) entry.frameKey = frameKey;
      this.entries.push(entry);
      return entry.texture;
    }

    const recycled = this.entries.length >= this.capacity ? this.evict(frameKey) : undefined;
    const canvas = recycled?.canvas ?? document.createElement("canvas");
    if (!renderBrushScene(canvas, scene)) {
      recycled?.texture.dispose();
      return null;
    }

    // three.js allocates immutable GPU storage on first upload, so a size
    // change needs a fresh texture rather than needsUpdate.
    const size = `${scene.width}x${scene.height}`;
    let texture: THREE.CanvasTexture;
    if (recycled && recycled.size === size) {
      texture = recycled.texture;
      texture.needsUpdate = true;
    } else {
      recycled?.texture.dispose();
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    this.entries.push({ signature, size, canvas, texture, frameKey });
    return texture;
  }

  // During playback the playhead lagging behind still needs the earlier of
  // the frames it straddles, so the earliest timeline frame goes — not the
  // least recently used, which would be exactly that one.
  private evict(frameKey: number | undefined): Entry | undefined {
    let victim = 0;
    if (frameKey !== undefined && this.entries.every((e) => e.frameKey !== undefined)) {
      for (let i = 1; i < this.entries.length; i++) {
        if (this.entries[i].frameKey! < this.entries[victim].frameKey!) victim = i;
      }
    }
    return this.entries.splice(victim, 1)[0];
  }

  dispose(): void {
    for (const e of this.entries) e.texture.dispose();
    this.entries = [];
  }
}
