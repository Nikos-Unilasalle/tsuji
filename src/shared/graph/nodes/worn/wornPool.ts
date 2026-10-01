import * as THREE from "three";

/**
 * The data every Worn material reads, shared by all of them: two float
 * textures holding, for every prepared geometry, its feature edges and, per
 * triangle, the list of edges near that triangle.
 *
 * Shared rather than per material (or per mesh) on purpose. One Worn material
 * routinely draws several different meshes — a modifier inherits it, a Merge
 * override hands it out, an Array copies it — and three only re-uploads a
 * built-in material's uniforms when the material changes between two draws,
 * so a texture bound per mesh would silently be the previous mesh's. Here
 * each geometry owns a range in one global table instead, and its triangles
 * carry absolute offsets into it: the uniforms never change.
 *
 * Edges: 2 texels each — (A.xyz, signed dihedral angle in degrees: + convex,
 * − concave), (B.xyz, unused). Positions are in the geometry's normalised
 * rest space (see wornGeometry.ts).
 * Lists: edge indices, 4 per texel; a triangle's list is a run of texels.
 */

export const POOL_WIDTH = 1024;
/** How many edges one triangle's list may hold — the shader's loop bound. */
export const MAX_EDGES_PER_TRIANGLE = 8;

interface Block {
  /** Edge texels (8 floats per edge), rest space. */
  edges: Float32Array;
  /** List texels (4 indices per texel), indices local to this block's edges. */
  lists: Float32Array;
  /** Where the block landed: first edge, first list texel. */
  edgeBase: number;
  listBase: number;
  /** Rewrites the owner's per-triangle offsets after the block moved. */
  relocate: (edgeBase: number, listBase: number) => void;
  live: boolean;
}

function makeTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Float32Array(POOL_WIDTH * 4), POOL_WIDTH, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

class WornPool {
  readonly edgeTexture = makeTexture();
  readonly listTexture = makeTexture();
  private blocks: Block[] = [];
  private edgeCount = 0;
  private listTexels = 0;
  private dead = 0;

  /**
   * Adds a geometry's data; `relocate` is told the global offsets now and
   * again whenever compaction moves the block. Returns a release function.
   */
  add(edges: Float32Array, lists: Float32Array, relocate: Block["relocate"]): () => void {
    const block: Block = { edges, lists, edgeBase: this.edgeCount, listBase: this.listTexels, relocate, live: true };
    this.blocks.push(block);
    this.edgeCount += edges.length / 8;
    this.listTexels += lists.length / 4;
    relocate(block.edgeBase, block.listBase);
    this.upload();
    return () => {
      if (!block.live) return;
      block.live = false;
      this.dead += edges.length / 8 + lists.length / 4;
      // Compact once half of the table is garbage.
      if (this.dead > 4096 && this.dead * 2 > this.edgeCount + this.listTexels) this.compact();
    };
  }

  private compact() {
    this.blocks = this.blocks.filter((b) => b.live);
    this.edgeCount = 0;
    this.listTexels = 0;
    this.dead = 0;
    for (const b of this.blocks) {
      b.edgeBase = this.edgeCount;
      b.listBase = this.listTexels;
      this.edgeCount += b.edges.length / 8;
      this.listTexels += b.lists.length / 4;
      b.relocate(b.edgeBase, b.listBase);
    }
    this.upload();
  }

  /** Rewrites both textures from the live blocks (edge indices made global). */
  private upload() {
    const edgeTexels = Math.max(1, this.edgeCount * 2);
    const edgeRows = Math.max(1, Math.ceil(edgeTexels / POOL_WIDTH));
    const edgeData = new Float32Array(POOL_WIDTH * edgeRows * 4);
    const listRows = Math.max(1, Math.ceil(Math.max(1, this.listTexels) / POOL_WIDTH));
    const listData = new Float32Array(POOL_WIDTH * listRows * 4);
    for (const b of this.blocks) {
      if (!b.live) continue;
      edgeData.set(b.edges, b.edgeBase * 8);
      for (let i = 0; i < b.lists.length; i++) {
        const local = b.lists[i];
        listData[b.listBase * 4 + i] = local < 0 ? -1 : local + b.edgeBase;
      }
    }
    setImage(this.edgeTexture, edgeData, edgeRows);
    setImage(this.listTexture, listData, listRows);
  }
}

function setImage(texture: THREE.DataTexture, data: Float32Array, rows: number) {
  const image = texture.image as { data: Float32Array; width: number; height: number };
  if (image.height !== rows) {
    // A new size needs a new GPU allocation: three reallocates on dispose + update.
    texture.dispose();
  }
  texture.image = { data, width: POOL_WIDTH, height: rows } as never;
  texture.needsUpdate = true;
}

export const wornPool = new WornPool();
