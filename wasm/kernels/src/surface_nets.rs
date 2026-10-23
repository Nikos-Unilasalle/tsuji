//! Blob elements → indexed surface. A line-for-line port of
//! src/shared/graph/offthread/surfaceNets.ts (compact-support field, naive
//! Surface Nets over active 8³ bricks): same f64 arithmetic in the same
//! order, so the output matches it bit for bit — the tests compare them.
//! The sampling grid is computed on the JS side (blobGrid) and handed in.

pub const BLOB_STRIDE: usize = 28;
const KIND: usize = 0;
const A: usize = 1;
const B: usize = 4;
const M: usize = 7;
const AABB: usize = 16;
const REACH: usize = 22;
const WEIGHT: usize = 23;
const COLOR: usize = 24;
const CHAIN: usize = 27;
const SEGMENT: f64 = 1.0;
const ELLIPSOID: f64 = 2.0;

const BRICK: usize = 8;
const S1: usize = BRICK + 1;

const EDGES: [(usize, usize, usize); 12] = [
    (0, 1, 0), (2, 3, 0), (4, 5, 0), (6, 7, 0),
    (0, 2, 1), (1, 3, 1), (4, 6, 1), (5, 7, 1),
    (0, 4, 2), (1, 5, 2), (2, 6, 2), (3, 7, 2),
];

pub struct Grid {
    pub origin: [f64; 3],
    pub cell: f64,
    pub n: [usize; 3],
}

#[derive(Default)]
pub struct Blobs {
    elements: Vec<f64>,
    samples: Vec<f64>,
    vertex_of: Vec<Vec<i32>>,
    edge_bits: Vec<Vec<u8>>,
    pub position: Vec<f32>,
    pub normal: Vec<f32>,
    pub color: Vec<f32>,
    pub index: Vec<u32>,
}

/// The element's offset from its core, seen through its matrix: (ux, uy, uz).
#[inline(always)]
fn local(e: &[f64], seg_len2: f64, px: f64, py: f64, pz: f64) -> (f64, f64, f64) {
    let mut dx = px - e[A];
    let mut dy = py - e[A + 1];
    let mut dz = pz - e[A + 2];
    if e[KIND] == SEGMENT && seg_len2 > 0.0 {
        let sx = e[B] - e[A];
        let sy = e[B + 1] - e[A + 1];
        let sz = e[B + 2] - e[A + 2];
        let mut t = (dx * sx + dy * sy + dz * sz) / seg_len2;
        if t < 0.0 {
            t = 0.0;
        } else if t > 1.0 {
            t = 1.0;
        }
        dx = dx - t * sx;
        dy = dy - t * sy;
        dz = dz - t * sz;
    }
    if e[KIND] == ELLIPSOID {
        (
            e[M] * dx + e[M + 1] * dy + e[M + 2] * dz,
            e[M + 3] * dx + e[M + 4] * dy + e[M + 5] * dz,
            e[M + 6] * dx + e[M + 7] * dy + e[M + 8] * dz,
        )
    } else {
        (dx, dy, dz)
    }
}

/// How far in p is along the element's bump: 1 − d²/R² inside its reach, 0 outside.
#[inline(always)]
fn q_at(o: &[f64], len2: f64, px: f64, py: f64, pz: f64) -> f64 {
    let (ux, uy, uz) = local(o, len2, px, py, pz);
    let d2 = ux * ux + uy * uy + uz * uz;
    let r = o[REACH];
    let r2 = r * r;
    if !(d2 < r2) {
        return 0.0;
    }
    1.0 - d2 / r2
}

/// Brick-local sample range (x0, y0, z0, x1, y1, z1) inside element o's box.
#[inline(always)]
fn local_range(o: &[f64], g: &Grid, g0: [usize; 3]) -> [isize; 6] {
    let h = g.cell;
    let lo = |v: f64, k: usize| -> isize { (((v - g.origin[k]) / h).ceil() as isize - g0[k] as isize).max(0) };
    let hi = |v: f64, k: usize| -> isize { (((v - g.origin[k]) / h).floor() as isize - g0[k] as isize).min(BRICK as isize) };
    [lo(o[AABB], 0), lo(o[AABB + 1], 1), lo(o[AABB + 2], 2), hi(o[AABB + 3], 0), hi(o[AABB + 4], 1), hi(o[AABB + 5], 2)]
}

/// Calls f(sample index, px, py, pz) for every brick-local sample in range r.
#[inline(always)]
fn for_samples(r: [isize; 6], g: &Grid, g0: [usize; 3], mut f: impl FnMut(usize, f64, f64, f64)) {
    let h = g.cell;
    let mut lz = r[2];
    while lz <= r[5] {
        let pz = g.origin[2] + (g0[2] as isize + lz) as f64 * h;
        let mut ly = r[1];
        while ly <= r[4] {
            let py = g.origin[1] + (g0[1] as isize + ly) as f64 * h;
            let row = S1 * (ly as usize + S1 * lz as usize);
            let mut lx = r[0];
            while lx <= r[3] {
                let px = g.origin[0] + (g0[0] as isize + lx) as f64 * h;
                f(lx as usize + row, px, py, pz);
                lx += 1;
            }
            ly += 1;
        }
        lz += 1;
    }
}

fn clamp_b(v: f64, n: usize) -> usize {
    let v = v.floor();
    if v < 0.0 {
        0
    } else if v >= n as f64 {
        n - 1
    } else {
        v as usize
    }
}

impl Blobs {
    pub fn elements_ptr(&mut self, count: usize) -> *mut f64 {
        self.elements.resize(count * BLOB_STRIDE, 0.0);
        self.elements.as_mut_ptr()
    }

    /// Returns the vertex count; the index count is `self.index.len()`.
    pub fn run(&mut self, g: &Grid, iso: f64, element_count: usize, max_vertices: usize, max_indices: usize, colors: bool) -> usize {
        let element_count = element_count.min(self.elements.len() / BLOB_STRIDE);
        let e = &self.elements;
        let h = g.cell;
        let bh = h * BRICK as f64;
        let nbx = (g.n[0] + BRICK - 1) / BRICK;
        let nby = (g.n[1] + BRICK - 1) / BRICK;
        let nbz = (g.n[2] + BRICK - 1) / BRICK;
        let brick_count = nbx * nby * nbz;

        let mut seg_len2 = vec![0f64; element_count];
        let mut ranges = vec![0usize; element_count * 6];
        let mut active = vec![false; brick_count];
        let mut list_count = vec![0usize; brick_count + 1];
        for id in 0..element_count {
            let o = &e[id * BLOB_STRIDE..(id + 1) * BLOB_STRIDE];
            let sx = o[B] - o[A];
            let sy = o[B + 1] - o[A + 1];
            let sz = o[B + 2] - o[A + 2];
            seg_len2[id] = sx * sx + sy * sy + sz * sz;
            let x0 = clamp_b((o[AABB] - h - g.origin[0]) / bh, nbx);
            let y0 = clamp_b((o[AABB + 1] - h - g.origin[1]) / bh, nby);
            let z0 = clamp_b((o[AABB + 2] - h - g.origin[2]) / bh, nbz);
            let x1 = clamp_b((o[AABB + 3] + h - g.origin[0]) / bh, nbx);
            let y1 = clamp_b((o[AABB + 4] + h - g.origin[1]) / bh, nby);
            let z1 = clamp_b((o[AABB + 5] + h - g.origin[2]) / bh, nbz);
            ranges[id * 6..id * 6 + 6].copy_from_slice(&[x0, y0, z0, x1, y1, z1]);
            let positive = o[WEIGHT] > 0.0;
            for bz in z0..=z1 {
                for by in y0..=y1 {
                    for bx in x0..=x1 {
                        let b = bx + nbx * (by + nby * bz);
                        if positive {
                            active[b] = true;
                        }
                        list_count[b + 1] += 1;
                    }
                }
            }
        }
        for b in 0..brick_count {
            list_count[b + 1] += list_count[b];
        }
        let mut list = vec![0usize; list_count[brick_count]];
        let mut fill: Vec<usize> = list_count[..brick_count].to_vec();
        for id in 0..element_count {
            let r = &ranges[id * 6..id * 6 + 6];
            for bz in r[2]..=r[5] {
                for by in r[1]..=r[4] {
                    for bx in r[0]..=r[3] {
                        let b = bx + nbx * (by + nby * bz);
                        list[fill[b]] = id;
                        fill[b] += 1;
                    }
                }
            }
        }

        self.samples.resize(S1 * S1 * S1, 0.0);
        self.position.clear();
        self.normal.clear();
        self.color.clear();
        self.index.clear();
        let mut slot = vec![-1i32; brick_count];
        let mut surface_bricks = 0usize;
        let mut vertices = 0usize;
        let mut corner = [0f64; 8];
        let mut chain_q = vec![0f64; S1 * S1 * S1];
        let mut chain_w = vec![0f64; S1 * S1 * S1];

        for bz in 0..nbz {
            for by in 0..nby {
                for bx in 0..nbx {
                    let b = bx + nbx * (by + nby * bz);
                    if !active[b] {
                        continue;
                    }
                    let bricklist = &list[list_count[b]..list_count[b + 1]];
                    let (gx0, gy0, gz0) = (bx * BRICK, by * BRICK, bz * BRICK);
                    // Splat each element over only the samples inside its box, in element
                    // order; a chain goes through chain_q/chain_w (best q per sample) first.
                    let g0 = [gx0, gy0, gz0];
                    let samples = &mut self.samples;
                    samples.fill(0.0);
                    let mut k = 0;
                    while k < bricklist.len() {
                        let chain = e[bricklist[k] * BLOB_STRIDE + CHAIN];
                        let mut end = k + 1;
                        if chain > 0.0 {
                            while end < bricklist.len() && e[bricklist[end] * BLOB_STRIDE + CHAIN] == chain {
                                end += 1;
                            }
                            chain_q.fill(0.0);
                            for &id in &bricklist[k..end] {
                                let o = &e[id * BLOB_STRIDE..(id + 1) * BLOB_STRIDE];
                                let w = o[WEIGHT];
                                let len2 = seg_len2[id];
                                for_samples(local_range(o, g, g0), g, g0, |i, px, py, pz| {
                                    let q = q_at(o, len2, px, py, pz);
                                    if q > chain_q[i] {
                                        chain_q[i] = q;
                                        chain_w[i] = w;
                                    }
                                });
                            }
                            for i in 0..S1 * S1 * S1 {
                                let q = chain_q[i];
                                if q > 0.0 {
                                    samples[i] += chain_w[i] * q * q * q;
                                }
                            }
                        } else {
                            let id = bricklist[k];
                            let o = &e[id * BLOB_STRIDE..(id + 1) * BLOB_STRIDE];
                            let w = o[WEIGHT];
                            let len2 = seg_len2[id];
                            for_samples(local_range(o, g, g0), g, g0, |i, px, py, pz| {
                                let q = q_at(o, len2, px, py, pz);
                                if q > 0.0 {
                                    samples[i] += w * q * q * q;
                                }
                            });
                        }
                        k = end;
                    }
                    let mut inside = 0usize;
                    for v in self.samples.iter_mut() {
                        *v -= iso;
                        if *v > 0.0 {
                            inside += 1;
                        }
                    }
                    if inside == 0 || inside == S1 * S1 * S1 {
                        continue;
                    }
                    let sb = surface_bricks;
                    surface_bricks += 1;
                    slot[b] = sb as i32;
                    if self.vertex_of.len() <= sb {
                        self.vertex_of.push(vec![-1; BRICK * BRICK * BRICK]);
                        self.edge_bits.push(vec![0; BRICK * BRICK * BRICK]);
                    }
                    self.vertex_of[sb].fill(-1);
                    self.edge_bits[sb].fill(0);

                    'z: for lz in 0..BRICK {
                        let cz = gz0 + lz;
                        if cz >= g.n[2] {
                            break 'z;
                        }
                        'y: for ly in 0..BRICK {
                            let cy = gy0 + ly;
                            if cy >= g.n[1] {
                                break 'y;
                            }
                            for lx in 0..BRICK {
                                let cx = gx0 + lx;
                                if cx >= g.n[0] {
                                    break;
                                }
                                let mut mask = 0u32;
                                for c in 0..8 {
                                    let v = self.samples[lx + (c & 1) + S1 * (ly + ((c >> 1) & 1) + S1 * (lz + (c >> 2)))];
                                    corner[c] = v;
                                    if v > 0.0 {
                                        mask |= 1 << c;
                                    }
                                }
                                let cell_index = lx + BRICK * (ly + BRICK * lz);
                                self.edge_bits[sb][cell_index] = ((mask & 1)
                                    | (((mask ^ (mask >> 1)) & 1) << 1)
                                    | (((mask ^ (mask >> 2)) & 1) << 2)
                                    | (((mask ^ (mask >> 4)) & 1) << 3)) as u8;
                                if mask == 0 || mask == 255 || vertices >= max_vertices {
                                    continue;
                                }
                                let (mut ox, mut oy, mut oz) = (0f64, 0f64, 0f64);
                                let mut crossings = 0u32;
                                for &(ca, cb, axis) in EDGES.iter() {
                                    let va = corner[ca];
                                    let vb = corner[cb];
                                    if (va > 0.0) == (vb > 0.0) {
                                        continue;
                                    }
                                    let mu = va / (va - vb);
                                    let (ax, ay, az) = ((ca & 1) as f64, ((ca >> 1) & 1) as f64, (ca >> 2) as f64);
                                    ox += if axis == 0 { mu } else { ax };
                                    oy += if axis == 1 { mu } else { ay };
                                    oz += if axis == 2 { mu } else { az };
                                    crossings += 1;
                                }
                                let n = crossings as f64;
                                let vx = g.origin[0] + (cx as f64 + ox / n) * h;
                                let vy = g.origin[1] + (cy as f64 + oy / n) * h;
                                let vz = g.origin[2] + (cz as f64 + oz / n) * h;
                                write_vertex(e, bricklist, &seg_len2, vx, vy, vz, colors, &mut self.position, &mut self.normal, &mut self.color);
                                self.vertex_of[sb][cell_index] = vertices as i32;
                                vertices += 1;
                            }
                        }
                    }
                }
            }
        }

        let vertex_of = &self.vertex_of;
        let vertex_at = |cx: isize, cy: isize, cz: isize| -> i32 {
            if cx < 0 || cy < 0 || cz < 0 {
                return -1;
            }
            let (cx, cy, cz) = (cx as usize, cy as usize, cz as usize);
            let b = (cx >> 3) + nbx * ((cy >> 3) + nby * (cz >> 3));
            let sb = slot[b];
            if sb < 0 {
                return -1;
            }
            vertex_of[sb as usize][(cx & 7) + BRICK * ((cy & 7) + BRICK * (cz & 7))]
        };
        let index = &mut self.index;
        let mut quad = |v0: i32, v1: i32, v2: i32, v3: i32| {
            if v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0 || index.len() + 6 > max_indices {
                return;
            }
            index.extend_from_slice(&[v0 as u32, v1 as u32, v2 as u32, v0 as u32, v2 as u32, v3 as u32]);
        };
        for b in 0..brick_count {
            let sb = slot[b];
            if sb < 0 {
                continue;
            }
            let bx = b % nbx;
            let by = (b / nbx) % nby;
            let bz = b / (nbx * nby);
            let bits_of = &self.edge_bits[sb as usize];
            for lz in 0..BRICK {
                for ly in 0..BRICK {
                    for lx in 0..BRICK {
                        let bits = bits_of[lx + BRICK * (ly + BRICK * lz)];
                        if bits < 2 {
                            continue;
                        }
                        let cx = (bx * BRICK + lx) as isize;
                        let cy = (by * BRICK + ly) as isize;
                        let cz = (bz * BRICK + lz) as isize;
                        let inside = bits & 1 == 1;
                        if bits & 2 != 0 {
                            let (a, c, d, f) = (vertex_at(cx, cy - 1, cz - 1), vertex_at(cx, cy, cz - 1), vertex_at(cx, cy, cz), vertex_at(cx, cy - 1, cz));
                            if inside { quad(a, c, d, f) } else { quad(a, f, d, c) }
                        }
                        if bits & 4 != 0 {
                            let (a, c, d, f) = (vertex_at(cx - 1, cy, cz - 1), vertex_at(cx - 1, cy, cz), vertex_at(cx, cy, cz), vertex_at(cx, cy, cz - 1));
                            if inside { quad(a, c, d, f) } else { quad(a, f, d, c) }
                        }
                        if bits & 8 != 0 {
                            let (a, c, d, f) = (vertex_at(cx - 1, cy - 1, cz), vertex_at(cx, cy - 1, cz), vertex_at(cx, cy, cz), vertex_at(cx - 1, cy, cz));
                            if inside { quad(a, c, d, f) } else { quad(a, f, d, c) }
                        }
                    }
                }
            }
        }
        vertices
    }
}

#[allow(clippy::too_many_arguments)]
fn write_vertex(
    e: &[f64],
    list: &[usize],
    seg_len2: &[f64],
    px: f64,
    py: f64,
    pz: f64,
    colors: bool,
    position: &mut Vec<f32>,
    normal: &mut Vec<f32>,
    color: &mut Vec<f32>,
) {
    let (mut gx, mut gy, mut gz) = (0f64, 0f64, 0f64);
    let (mut cw, mut cr, mut cg, mut cb) = (0f64, 0f64, 0f64, 0f64);
    let mut k = 0;
    while k < list.len() {
        let mut id = list[k];
        let chain = e[id * BLOB_STRIDE + CHAIN];
        let mut end = k + 1;
        if chain > 0.0 {
            // A chain counts once: through the segment reaching furthest in here.
            while end < list.len() && e[list[end] * BLOB_STRIDE + CHAIN] == chain {
                end += 1;
            }
            let mut best = 0.0;
            for &c in &list[k..end] {
                let q = q_at(&e[c * BLOB_STRIDE..(c + 1) * BLOB_STRIDE], seg_len2[c], px, py, pz);
                if q > best {
                    best = q;
                    id = c;
                }
            }
        }
        k = end;
        let o = &e[id * BLOB_STRIDE..(id + 1) * BLOB_STRIDE];
        if px < o[AABB] || py < o[AABB + 1] || pz < o[AABB + 2] || px > o[AABB + 3] || py > o[AABB + 4] || pz > o[AABB + 5] {
            continue;
        }
        let (ux, uy, uz) = local(o, seg_len2[id], px, py, pz);
        let d2 = ux * ux + uy * uy + uz * uz;
        let r = o[REACH];
        let r2 = r * r;
        if !(d2 < r2) {
            continue;
        }
        let q = 1.0 - d2 / r2;
        let w = o[WEIGHT];
        let coef = (w * 3.0 * q * q * -2.0) / r2;
        if o[KIND] == ELLIPSOID {
            gx += coef * (o[M] * ux + o[M + 3] * uy + o[M + 6] * uz);
            gy += coef * (o[M + 1] * ux + o[M + 4] * uy + o[M + 7] * uz);
            gz += coef * (o[M + 2] * ux + o[M + 5] * uy + o[M + 8] * uz);
        } else {
            gx += coef * ux;
            gy += coef * uy;
            gz += coef * uz;
        }
        if colors && w > 0.0 {
            let f = w * q * q * q;
            cw += f;
            cr += f * o[COLOR];
            cg += f * o[COLOR + 1];
            cb += f * o[COLOR + 2];
        }
    }
    position.extend_from_slice(&[px as f32, py as f32, pz as f32]);
    let len = (gx * gx + gy * gy + gz * gz).sqrt();
    if len > 0.0 {
        normal.extend_from_slice(&[(-gx / len) as f32, (-gy / len) as f32, (-gz / len) as f32]);
    } else {
        normal.extend_from_slice(&[0.0, 1.0, 0.0]);
    }
    if colors {
        if cw > 0.0 {
            color.extend_from_slice(&[(cr / cw) as f32, (cg / cw) as f32, (cb / cw) as f32]);
        } else {
            color.extend_from_slice(&[1.0, 1.0, 1.0]);
        }
    }
}
