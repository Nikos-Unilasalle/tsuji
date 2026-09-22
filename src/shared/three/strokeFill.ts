/**
 * Boundary-detecting fill for Grease Pencil, in the style of Blender's Fill
 * tool.
 *
 * Vector "fill the shape I just drew" cannot be solved by triangulating one
 * stroke: artists close a region with several overlapping strokes that never
 * share endpoints, and they expect small gaps to be tolerated. So this works
 * the way paint programs do — rasterize the strokes into a coarse occupancy
 * grid, flood fill the region the user clicked, then trace the filled region's
 * outline back into a polygon.
 *
 * Everything here is plain arrays in screen space: the caller rasterizes with
 * its own projection and unprojects the resulting contour.
 */

export interface FillPoint {
  x: number;
  y: number;
}

export interface FillGrid {
  width: number;
  height: number;
  /** 1 where a stroke covers the cell, 0 elsewhere. */
  cells: Uint8Array;
}

export function createFillGrid(width: number, height: number): FillGrid {
  return { width, height, cells: new Uint8Array(width * height) };
}

/** Rasterizes a polyline into the grid with a given pen radius, in cells. */
export function rasterizePolyline(grid: FillGrid, points: FillPoint[], radius = 1): void {
  if (points.length === 0) return;
  if (points.length === 1) {
    stampDisc(grid, points[0].x, points[0].y, radius);
    return;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stampDisc(grid, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, radius);
    }
  }
}

function stampDisc(grid: FillGrid, cx: number, cy: number, radius: number): void {
  const r = Math.max(0, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(grid.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(grid.height - 1, Math.ceil(cy + r));
  const rSq = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (r < 0.5 || dx * dx + dy * dy <= rSq) grid.cells[y * grid.width + x] = 1;
    }
  }
}

/**
 * Closes gaps up to `radius` cells wide by dilating the occupancy grid.
 *
 * This is the "leak size" control every fill tool exposes: sketched corners
 * rarely meet exactly, and without it the fill escapes through the gap and
 * floods the whole canvas.
 */
export function dilateGrid(grid: FillGrid, radius: number): FillGrid {
  if (radius <= 0) return grid;
  const out = createFillGrid(grid.width, grid.height);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (!grid.cells[y * grid.width + x]) continue;
      stampDisc(out, x, y, radius);
    }
  }
  return out;
}

export interface FloodResult {
  /** 1 for cells reached from the seed. */
  region: Uint8Array;
  count: number;
  /** True when the fill reached the canvas border, i.e. the region leaked. */
  leaked: boolean;
}

/** Four-connected flood fill of the empty cells reachable from the seed. */
export function floodFill(grid: FillGrid, seedX: number, seedY: number): FloodResult {
  const { width, height, cells } = grid;
  const region = new Uint8Array(width * height);
  const sx = Math.round(seedX);
  const sy = Math.round(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return { region, count: 0, leaked: false };
  if (cells[sy * width + sx]) return { region, count: 0, leaked: false };

  const stack: number[] = [sy * width + sx];
  region[sy * width + sx] = 1;
  let count = 0;
  let leaked = false;

  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const x = idx % width;
    const y = (idx - x) / width;
    count++;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) leaked = true;

    const push = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      const n = ny * width + nx;
      if (region[n] || cells[n]) return;
      region[n] = 1;
      stack.push(n);
    };
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  return { region, count, leaked };
}

/**
 * Traces the outline of a filled region with the Moore neighbourhood
 * (square-tracing) algorithm, returning grid-space points in order.
 */
export function traceRegionContour(region: Uint8Array, width: number, height: number): FillPoint[] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : region[y * width + x]);

  // Find the top-left-most filled cell.
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startY < 0; y++) {
    for (let x = 0; x < width; x++) {
      if (region[y * width + x]) {
        startX = x;
        startY = y;
        break;
      }
    }
  }
  if (startX < 0) return [];

  // Clockwise neighbourhood, starting from "west" so the first probe of the
  // top-left cell is outside the region.
  const dirs = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];

  const contour: FillPoint[] = [{ x: startX, y: startY }];
  let cx = startX;
  let cy = startY;
  let dir = 0;
  const maxSteps = width * height * 4;

  for (let step = 0; step < maxSteps; step++) {
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + k) % 8;
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        // Resume probing from just behind the direction we came in on.
        dir = (d + 6) % 8;
        contour.push({ x: cx, y: cy });
        moved = true;
        break;
      }
    }
    if (!moved) break;
    if (cx === startX && cy === startY) break;
  }

  return contour;
}

/**
 * Ramer–Douglas–Peucker simplification, so a traced contour becomes a handful
 * of points instead of one per pixel.
 */
export function simplifyContour(points: FillPoint[], tolerance = 1.2): FillPoint[] {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;

    const a = points[first];
    const b = points[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;

    let maxDist = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      let dist: number;
      if (lenSq < 1e-12) {
        dist = Math.hypot(p.x - a.x, p.y - a.y);
      } else {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
        dist = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      }
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}

export interface FillRequest {
  /** Screen-space polylines of the strokes that can bound the fill. */
  boundaries: FillPoint[][];
  /** Where the artist clicked, in the same screen space. */
  seed: FillPoint;
  /** Screen-space area to consider, in pixels. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Grid cell size in pixels; larger is faster and coarser. */
  cellSize?: number;
  /** Gap closing, in pixels. */
  gapClose?: number;
  /** Contour simplification tolerance, in pixels. */
  tolerance?: number;
}

export interface FillResult {
  /** Fill outline in screen space, or null when no region could be filled. */
  contour: FillPoint[] | null;
  /** Set when the region escaped the drawing — the caller should warn. */
  leaked: boolean;
}

/**
 * Computes the fill outline for a click, in screen space.
 *
 * Returns `leaked: true` (and no contour) when the clicked region is not
 * enclosed: filling it would cover the whole canvas, which is never what the
 * artist meant, and a warning is more useful than a giant blob.
 */
export function computeFillRegion(req: FillRequest): FillResult {
  const cellSize = Math.max(1, req.cellSize ?? 2);
  const pad = 4;
  const width = Math.ceil((req.bounds.maxX - req.bounds.minX) / cellSize) + pad * 2;
  const height = Math.ceil((req.bounds.maxY - req.bounds.minY) / cellSize) + pad * 2;
  if (width < 3 || height < 3 || width * height > 4_000_000) return { contour: null, leaked: false };

  const toGrid = (p: FillPoint): FillPoint => ({
    x: (p.x - req.bounds.minX) / cellSize + pad,
    y: (p.y - req.bounds.minY) / cellSize + pad,
  });
  const toScreen = (p: FillPoint): FillPoint => ({
    x: (p.x - pad) * cellSize + req.bounds.minX,
    y: (p.y - pad) * cellSize + req.bounds.minY,
  });

  let grid = createFillGrid(width, height);
  for (const line of req.boundaries) {
    rasterizePolyline(grid, line.map(toGrid), 0.5);
  }

  const gapCells = Math.round((req.gapClose ?? 0) / cellSize);
  if (gapCells > 0) grid = dilateGrid(grid, gapCells);

  const seed = toGrid(req.seed);
  const flood = floodFill(grid, seed.x, seed.y);
  if (flood.count === 0) return { contour: null, leaked: false };
  if (flood.leaked) return { contour: null, leaked: true };

  const contour = traceRegionContour(flood.region, width, height);
  if (contour.length < 3) return { contour: null, leaked: false };

  const simplified = simplifyContour(contour, (req.tolerance ?? 1.2) / cellSize);
  if (simplified.length < 3) return { contour: null, leaked: false };

  return { contour: simplified.map(toScreen), leaked: false };
}
