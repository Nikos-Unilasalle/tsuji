/**
 * A 2D wave field — the classic two-buffer height-field ripple: each cell
 * accelerates toward the average of its four neighbours, so a dent spreads
 * out as a ring, rings pass through each other, and edges bounce or swallow
 * them. Water, a drum skin, a trampoline, a jelly floor are all this with
 * other speeds and damping.
 *
 * The grid lies on a rectangle in XZ. Heights are in world units, so a drop
 * of strength 0.05 dents the surface by about 5 cm. Plain typed arrays and no
 * THREE: the node turns the field into meshes and textures, this only steps it.
 */

export const EDGE_MODES = ["reflect", "absorb"] as const;
export type EdgeMode = (typeof EDGE_MODES)[number];

export interface FieldArea {
  centerX: number;
  centerZ: number;
  sizeX: number;
  sizeZ: number;
}

export interface WaveField {
  nx: number;
  nz: number;
  area: FieldArea;
  /** Current and previous heights, row-major (x fastest). */
  height: Float32Array;
  previous: Float32Array;
  /** 1 where the surface is blocked (a rock, a pier): held still, and waves bounce off its edge. */
  solid: Uint8Array | null;
}

export interface StepParams {
  /** World units per second. */
  speed: number;
  /** Fraction of the motion lost per second, as a rate constant. */
  damping: number;
  edges: EdgeMode;
  /** Absorbing border width in cells: wider swallows more and reflects less. */
  border: number;
}

/** Grid dimensions for an area, the longer side getting `resolution` cells. */
export function gridSize(area: FieldArea, resolution: number): { nx: number; nz: number } {
  const longest = Math.max(area.sizeX, area.sizeZ, 1e-6);
  const nx = Math.max(4, Math.round((resolution * area.sizeX) / longest));
  const nz = Math.max(4, Math.round((resolution * area.sizeZ) / longest));
  return { nx, nz };
}

export function createWaveField(area: FieldArea, resolution: number): WaveField {
  const { nx, nz } = gridSize(area, resolution);
  return { nx, nz, area: { ...area }, height: new Float32Array(nx * nz), previous: new Float32Array(nx * nz), solid: null };
}

export function cellSize(field: WaveField): number {
  return Math.max(field.area.sizeX / field.nx, field.area.sizeZ / field.nz, 1e-6);
}

/** Continuous grid coordinates of a world point (cell centres at integer + 0.5 → index). */
export function toGrid(field: WaveField, x: number, z: number): { gx: number; gz: number } {
  const { area, nx, nz } = field;
  return {
    gx: ((x - (area.centerX - area.sizeX / 2)) / area.sizeX) * nx - 0.5,
    gz: ((z - (area.centerZ - area.sizeZ / 2)) / area.sizeZ) * nz - 0.5,
  };
}

/**
 * Pushes the surface down (or up, negative strength) in a smooth round bump
 * of the given world radius — a stone, a fingertip, a fish's wake. Applied to
 * both buffers so it starts at rest and springs back as a ring, rather than
 * flying off with a velocity of its own.
 */
export function disturb(field: WaveField, x: number, z: number, radius: number, strength: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(strength) || strength === 0) return;
  const { gx, gz } = toGrid(field, x, z);
  // Narrower than ~2 cells, a bump is mostly grid-scale wiggle, which a
  // discrete wave barely carries: it would sit and shimmer where it landed
  // instead of leaving as a ring.
  const r = Math.max(2, radius / cellSize(field));
  const reach = Math.ceil(r * 2);
  const x0 = Math.max(0, Math.floor(gx - reach)), x1 = Math.min(field.nx - 1, Math.ceil(gx + reach));
  const z0 = Math.max(0, Math.floor(gz - reach)), z1 = Math.min(field.nz - 1, Math.ceil(gz + reach));
  for (let j = z0; j <= z1; j++) {
    for (let i = x0; i <= x1; i++) {
      const d2 = ((i - gx) ** 2 + (j - gz) ** 2) / (r * r);
      if (d2 > 4) continue;
      const k = j * field.nx + i;
      const dent = strength * Math.exp(-d2 * 2);
      field.height[k] -= dent;
      field.previous[k] -= dent;
    }
  }
}

/**
 * Advances the field by `dt` seconds, in as many substeps as the wave speed
 * needs to stay stable (a wave may not cross more than ~0.7 cells a step).
 */
export function stepWaveField(field: WaveField, dt: number, p: StepParams): void {
  if (dt <= 0) return;
  const cellsPerSecond = Math.max(0, p.speed) / cellSize(field);
  const substeps = Math.max(1, Math.min(16, Math.ceil((cellsPerSecond * dt) / 0.7)));
  const h = dt / substeps;
  const c2 = Math.min(0.49, (cellsPerSecond * h) ** 2);
  const keep = Math.exp(-Math.max(0, p.damping) * h);
  const { nx, nz } = field;
  const border = p.edges === "absorb" ? Math.max(1, Math.floor(p.border)) : 0;
  // A sponge, not a wall: damping that ramps up smoothly across the border.
  // An abrupt one is itself an edge, and bounces the wave straight back.
  const sponge = 30 * h;
  const solid = field.solid;
  for (let s = 0; s < substeps; s++) {
    const cur = field.height;
    const prev = field.previous;
    // The previous buffer is overwritten in place with the next heights, then
    // the two swap roles: each cell reads only the current buffer.
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (solid && solid[k]) {
          prev[k] = 0;
          continue;
        }
        // Reflecting edges, and solid cells, mirror the missing neighbour (no flux through the wall).
        const l = i > 0 && !(solid && solid[k - 1]) ? cur[k - 1] : cur[k];
        const r = i < nx - 1 && !(solid && solid[k + 1]) ? cur[k + 1] : cur[k];
        const d = j > 0 && !(solid && solid[k - nx]) ? cur[k - nx] : cur[k];
        const u = j < nz - 1 && !(solid && solid[k + nx]) ? cur[k + nx] : cur[k];
        let next = (2 * cur[k] - prev[k] + c2 * (l + r + d + u - 4 * cur[k])) * keep;
        if (border > 0) {
          const edge = Math.min(i, j, nx - 1 - i, nz - 1 - j);
          // Friction on the surface's motion, not a pull on its height: a pull
          // would act like a spring, change how the surface carries waves,
          // and reflect them just the same.
          if (edge < border) next = cur[k] + (next - cur[k]) * Math.exp(-sponge * (1 - edge / border) ** 2);
        }
        prev[k] = next;
      }
    }
    field.previous = cur;
    field.height = prev;
  }
}

/** Surface height at a world point, bilinear between cells; 0 outside the area. */
export function sampleHeight(field: WaveField, x: number, z: number): number {
  const { gx, gz } = toGrid(field, x, z);
  if (gx < -0.5 || gz < -0.5 || gx > field.nx - 0.5 || gz > field.nz - 0.5) return 0;
  const cx = Math.max(0, Math.min(field.nx - 1, gx));
  const cz = Math.max(0, Math.min(field.nz - 1, gz));
  const i0 = Math.floor(cx), j0 = Math.floor(cz);
  const i1 = Math.min(field.nx - 1, i0 + 1), j1 = Math.min(field.nz - 1, j0 + 1);
  const fx = cx - i0, fz = cz - j0;
  const h = field.height;
  const a = h[j0 * field.nx + i0] * (1 - fx) + h[j0 * field.nx + i1] * fx;
  const b = h[j1 * field.nx + i0] * (1 - fx) + h[j1 * field.nx + i1] * fx;
  return a * (1 - fz) + b * fz;
}

/** World-space slope (dh/dx, dh/dz) at cell (i, j), by central differences — of the simulated heights, or of `h` if given. */
export function slopeAt(field: WaveField, i: number, j: number, h: Float32Array = field.height): { sx: number; sz: number } {
  const { nx, nz } = field;
  const k = j * nx + i;
  const dx = field.area.sizeX / nx, dz = field.area.sizeZ / nz;
  const l = i > 0 ? h[k - 1] : h[k], r = i < nx - 1 ? h[k + 1] : h[k];
  const d = j > 0 ? h[k - nx] : h[k], u = j < nz - 1 ? h[k + nx] : h[k];
  return { sx: (r - l) / (2 * dx), sz: (u - d) / (2 * dz) };
}

export function clearWaveField(field: WaveField): void {
  field.height.fill(0);
  field.previous.fill(0);
}

/** Sets which cells are blocked (null: none), stilling the water inside them. */
export function setSolid(field: WaveField, solid: Uint8Array | null): void {
  field.solid = solid && solid.length === field.nx * field.nz ? solid : null;
  if (!field.solid) return;
  for (let k = 0; k < field.solid.length; k++) {
    if (field.solid[k]) field.height[k] = field.previous[k] = 0;
  }
}

/** Rows of blocked cells, in from their edge, that take on the water's height for display. */
const SHORE_ROWS = 2;

/**
 * The surface to draw: the simulated heights, carried a couple of cells into
 * blocked ground. Blocked cells hold no water, so drawn as they are the
 * surface would dip to rest wherever it meets a rock, as if pinned there,
 * when at a wall the water is freest of all, rising and falling hardest.
 * Extended from its neighbours, the water climbs and slides on the rock's
 * flank; the rock itself hides the rest.
 */
export function surfaceHeights(field: WaveField, out: Float32Array): Float32Array {
  out.set(field.height);
  const solid = field.solid;
  if (!solid) return out;
  const { nx, nz } = field;
  const known = new Uint8Array(nx * nz);
  for (let k = 0; k < known.length; k++) known[k] = solid[k] ? 0 : 1;
  const next = new Uint8Array(known.length);
  for (let pass = 0; pass < SHORE_ROWS; pass++) {
    next.set(known);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (known[k]) continue;
        let sum = 0, n = 0;
        if (i > 0 && known[k - 1]) { sum += out[k - 1]; n++; }
        if (i < nx - 1 && known[k + 1]) { sum += out[k + 1]; n++; }
        if (j > 0 && known[k - nx]) { sum += out[k - nx]; n++; }
        if (j < nz - 1 && known[k + nx]) { sum += out[k + nx]; n++; }
        if (n > 0) {
          out[k] = sum / n;
          next[k] = 1;
        }
      }
    }
    known.set(next);
  }
  return out;
}
