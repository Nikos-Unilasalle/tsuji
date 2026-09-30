import * as THREE from "three";

/**
 * The UV checker: Blender's "Color Grid" idea. An 8 × 8 grid of coloured,
 * labelled cells (A1 … H8) over a fine checker, so stretching (cells no
 * longer square), scale (cells of different sizes), rotation and flips
 * (labels turned or mirrored) and seams (labels jumping) all read at a
 * glance. U runs across the letters, V up the numbers, as in UV space.
 */

const SIZE = 1024;
const CELLS = 8;

let canvas: HTMLCanvasElement | null = null;
let material: THREE.MeshStandardMaterial | null = null;

/** The grid image, drawn once. */
export function getUVCheckerCanvas(): HTMLCanvasElement {
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const cell = SIZE / CELLS;
  const fine = cell / 4;
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      // Hue across U, lightness up V: every cell's colour is its own.
      const hue = (col / CELLS) * 300;
      const light = 38 + (row / (CELLS - 1)) * 24;
      const x = col * cell;
      // Canvas rows run down; V runs up — row 0 is the bottom of UV space.
      const y = SIZE - (row + 1) * cell;
      ctx.fillStyle = `hsl(${hue}, 55%, ${light}%)`;
      ctx.fillRect(x, y, cell, cell);
      ctx.fillStyle = `hsla(${hue}, 55%, ${light + 12}%, 1)`;
      for (let fy = 0; fy < 4; fy++) {
        for (let fx = 0; fx < 4; fx++) if ((fx + fy) % 2 === 0) ctx.fillRect(x + fx * fine, y + fy * fine, fine, fine);
      }
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.font = `bold ${Math.round(cell * 0.3)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${String.fromCharCode(65 + col)}${row + 1}`, x + cell / 2, y + cell / 2);
    }
  }
  // The 0..1 tile's own edge, so repeats show where one tile ends.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, SIZE - 6, SIZE - 6);
  return canvas;
}

/** The material the viewport swaps in while the UV checker is on. Shared, never disposed. */
export function getUVCheckerMaterial(): THREE.MeshStandardMaterial {
  if (material) return material;
  const texture = new THREE.CanvasTexture(getUVCheckerCanvas());
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  (material as unknown as { __isSharedCustom: boolean }).__isSharedCustom = true;
  return material;
}

/**
 * Puts the checker on `meshes` for one draw; call the returned function to
 * put their own materials back (in a finally — the swap must never outlive
 * the frame). A mesh with several materials gets the checker on every slot.
 */
export function swapInUVChecker(meshes: THREE.Mesh[]): () => void {
  if (meshes.length === 0) return () => {};
  const checker = getUVCheckerMaterial();
  const saved = meshes.map((mesh) => mesh.material);
  meshes.forEach((mesh) => {
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => checker) : checker;
  });
  return () => meshes.forEach((mesh, i) => (mesh.material = saved[i]));
}
