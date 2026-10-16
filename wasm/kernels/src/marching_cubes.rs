//! Metaballs → triangle soup. A line-for-line port of
//! src/shared/graph/offthread/marchingCubes.ts (itself three's MarchingCubes
//! without the colour palette): same field, same Float32 storage and Float64
//! arithmetic, so the output matches it bit for bit — the tests compare them.

use crate::tables::{EDGE_TABLE, TRI_TABLE};

pub const BALL_STRIDE: usize = 5;

#[derive(Default)]
pub struct Metaballs {
    resolution: usize,
    field: Vec<f32>,
    normal_cache: Vec<f32>,
    balls: Vec<f64>,
    pub position: Vec<f32>,
    pub normal: Vec<f32>,
}

impl Metaballs {
    pub fn balls_ptr(&mut self, count: usize) -> *mut f64 {
        self.balls.resize(count * BALL_STRIDE, 0.0);
        self.balls.as_mut_ptr()
    }

    fn reset(&mut self, resolution: usize) {
        let size3 = resolution * resolution * resolution;
        if self.resolution != resolution {
            self.resolution = resolution;
            self.field = vec![0.0; size3];
            self.normal_cache = vec![0.0; size3 * 3];
        } else {
            self.field.fill(0.0);
            self.normal_cache.fill(0.0);
        }
    }

    fn add_ball(&mut self, bx: f64, by: f64, bz: f64, strength: f64, subtract: f64) {
        let size = self.resolution as i64;
        let sizef = size as f64;
        let sign = if strength > 0.0 { 1.0 } else if strength < 0.0 { -1.0 } else { 0.0 };
        let strength = strength.abs();
        let radius = sizef * (strength / subtract).sqrt();
        let (zs, ys, xs) = (bz * sizef, by * sizef, bx * sizef);
        let min_z = ((zs - radius).floor() as i64).max(1);
        let max_z = ((zs + radius).floor() as i64).min(size - 1);
        let min_y = ((ys - radius).floor() as i64).max(1);
        let max_y = ((ys + radius).floor() as i64).min(size - 1);
        let min_x = ((xs - radius).floor() as i64).max(1);
        let max_x = ((xs + radius).floor() as i64).min(size - 1);
        let field = &mut self.field;
        for z in min_z..max_z {
            let z_offset = size * size * z;
            let fz = z as f64 / sizef - bz;
            let fz2 = fz * fz;
            for y in min_y..max_y {
                let y_offset = z_offset + size * y;
                let fy = y as f64 / sizef - by;
                let fy2 = fy * fy;
                for x in min_x..max_x {
                    let fx = x as f64 / sizef - bx;
                    let val = strength / (0.000001 + fx * fx + fy2 + fz2) - subtract;
                    if val > 0.0 {
                        let cell = &mut field[(y_offset + x) as usize];
                        *cell = (*cell as f64 + val * sign) as f32;
                    }
                }
            }
        }
    }

    pub fn run(&mut self, resolution: usize, isolation: f64, ball_count: usize, max_vertices: usize) -> usize {
        self.reset(resolution);
        let ball_count = ball_count.min(self.balls.len() / BALL_STRIDE);
        for i in 0..ball_count {
            let b = i * BALL_STRIDE;
            let (x, y, z, s, sub) = (self.balls[b], self.balls[b + 1], self.balls[b + 2], self.balls[b + 3], self.balls[b + 4]);
            self.add_ball(x, y, z, s, sub);
        }
        self.polygonize(isolation, max_vertices)
    }

    fn polygonize(&mut self, isol: f64, max_vertices: usize) -> usize {
        let size = self.resolution;
        let yd = size;
        let zd = size * size;
        let half = size as f64 / 2.0;
        let delta = 2.0 / size as f64;
        let max_floats = max_vertices * 3;
        let field = &self.field;
        let nc = &mut self.normal_cache;
        let position = &mut self.position;
        let normal = &mut self.normal;
        position.clear();
        normal.clear();
        let mut vlist = [0f32; 36];
        let mut nlist = [0f32; 36];

        let comp_norm = |nc: &mut [f32], q: usize| {
            let q3 = q * 3;
            if nc[q3] == 0.0 {
                nc[q3] = (field[q - 1] as f64 - field[q + 1] as f64) as f32;
                nc[q3 + 1] = (field[q - yd] as f64 - field[q + yd] as f64) as f32;
                nc[q3 + 2] = (field[q - zd] as f64 - field[q + zd] as f64) as f32;
            }
        };

        if size < 4 {
            return 0;
        }
        let smin2 = size - 2;
        'outer: for z in 1..smin2 {
            let z_offset = zd * z;
            let fz = (z as f64 - half) / half;
            for y in 1..smin2 {
                let y_offset = z_offset + size * y;
                let fy = (y as f64 - half) / half;
                for x in 1..smin2 {
                    let fx = (x as f64 - half) / half;
                    let q = y_offset + x;
                    let q1 = q + 1;
                    let qy = q + yd;
                    let qz = q + zd;
                    let q1y = q1 + yd;
                    let q1z = q1 + zd;
                    let qyz = q + yd + zd;
                    let q1yz = q1 + yd + zd;
                    let f = [
                        field[q] as f64,
                        field[q1] as f64,
                        field[qy] as f64,
                        field[q1y] as f64,
                        field[qz] as f64,
                        field[q1z] as f64,
                        field[qyz] as f64,
                        field[q1yz] as f64,
                    ];
                    let mut cube = 0usize;
                    if f[0] < isol { cube |= 1; }
                    if f[1] < isol { cube |= 2; }
                    if f[2] < isol { cube |= 8; }
                    if f[3] < isol { cube |= 4; }
                    if f[4] < isol { cube |= 16; }
                    if f[5] < isol { cube |= 32; }
                    if f[6] < isol { cube |= 128; }
                    if f[7] < isol { cube |= 64; }
                    let bits = EDGE_TABLE[cube];
                    if bits == 0 {
                        continue;
                    }
                    let (fx2, fy2, fz2) = (fx + delta, fy + delta, fz + delta);
                    // (edge bit, vlist slot, axis, cell a, cell b, x, y, z, value a, value b)
                    let edges: [(i32, usize, u8, usize, usize, f64, f64, f64, f64, f64); 12] = [
                        (1, 0, 0, q, q1, fx, fy, fz, f[0], f[1]),
                        (2, 3, 1, q1, q1y, fx2, fy, fz, f[1], f[3]),
                        (4, 6, 0, qy, q1y, fx, fy2, fz, f[2], f[3]),
                        (8, 9, 1, q, qy, fx, fy, fz, f[0], f[2]),
                        (16, 12, 0, qz, q1z, fx, fy, fz2, f[4], f[5]),
                        (32, 15, 1, q1z, q1yz, fx2, fy, fz2, f[5], f[7]),
                        (64, 18, 0, qyz, q1yz, fx, fy2, fz2, f[6], f[7]),
                        (128, 21, 1, qz, qyz, fx, fy, fz2, f[4], f[6]),
                        (256, 24, 2, q, qz, fx, fy, fz, f[0], f[4]),
                        (512, 27, 2, q1, q1z, fx2, fy, fz, f[1], f[5]),
                        (1024, 30, 2, q1y, q1yz, fx2, fy2, fz, f[3], f[7]),
                        (2048, 33, 2, qy, qyz, fx, fy2, fz, f[2], f[6]),
                    ];
                    for &(bit, o, axis, a, b, ex, ey, ez, v1, v2) in edges.iter() {
                        if bits & bit == 0 {
                            continue;
                        }
                        comp_norm(nc, a);
                        comp_norm(nc, b);
                        let mu = (isol - v1) / (v2 - v1);
                        vlist[o] = (if axis == 0 { ex + mu * delta } else { ex }) as f32;
                        vlist[o + 1] = (if axis == 1 { ey + mu * delta } else { ey }) as f32;
                        vlist[o + 2] = (if axis == 2 { ez + mu * delta } else { ez }) as f32;
                        let (a3, b3) = (a * 3, b * 3);
                        for k in 0..3 {
                            let na = nc[a3 + k] as f64;
                            let nb = nc[b3 + k] as f64;
                            nlist[o + k] = (na + (nb - na) * mu) as f32;
                        }
                    }
                    let t = cube << 4;
                    let mut i = 0;
                    while TRI_TABLE[t + i] != -1 {
                        if position.len() + 9 > max_floats {
                            break 'outer;
                        }
                        for k in 0..3 {
                            let o = 3 * TRI_TABLE[t + i + k] as usize;
                            position.extend_from_slice(&vlist[o..o + 3]);
                            normal.extend_from_slice(&nlist[o..o + 3]);
                        }
                        i += 3;
                    }
                }
            }
        }
        position.len() / 3
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_ball_closes_into_a_surface() {
        let mut m = Metaballs::default();
        let p = m.balls_ptr(1);
        let isolation = 20.0;
        let subtract = isolation / (1.6f64 * 1.6 - 1.0);
        let r = 0.5 / 6.0;
        unsafe { std::slice::from_raw_parts_mut(p, 5) }.copy_from_slice(&[0.5, 0.5, 0.5, (isolation + subtract) * r * r, subtract]);
        let count = m.run(32, isolation, 1, 180_000);
        assert!(count > 0 && count % 3 == 0);
        assert!(m.position.iter().all(|v| v.abs() <= 1.0));
    }
}
