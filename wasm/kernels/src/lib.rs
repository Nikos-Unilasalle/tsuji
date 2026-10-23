//! Tsuji's CPU geometry kernels for the geometry worker (see
//! docs/offthread-geometry.md). Plain `extern "C"` exports over linear
//! memory — no wasm-bindgen: a kernel takes typed arrays in and hands typed
//! arrays back, and the JS side (src/shared/graph/offthread/wasmKernels.ts)
//! is a dozen lines of views over `memory.buffer`.
//!
//! Protocol, per call: JS asks for an input buffer (`balls_ptr`), writes into
//! it, calls the kernel, then reads the outputs through `position_ptr` /
//! `normal_ptr` before the next call (a call may grow memory and move them).

mod marching_cubes;
mod surface_nets;
mod tables;

use std::cell::RefCell;

thread_local! {
    static STATE: RefCell<marching_cubes::Metaballs> = RefCell::new(marching_cubes::Metaballs::default());
    static BLOBS: RefCell<surface_nets::Blobs> = RefCell::new(surface_nets::Blobs::default());
}

/// Room for `count` balls (5 f64 each: x, y, z in the field's [0, 1] cube, strength, subtract).
#[no_mangle]
pub extern "C" fn balls_ptr(count: u32) -> *mut f64 {
    STATE.with(|s| s.borrow_mut().balls_ptr(count as usize))
}

/// Builds the field from the first `ball_count` balls and polygonizes it.
/// Returns the vertex count; positions are in the field's [-1, 1] cube.
#[no_mangle]
pub extern "C" fn metaballs(resolution: u32, isolation: f64, ball_count: u32, max_vertices: u32) -> u32 {
    STATE.with(|s| s.borrow_mut().run(resolution as usize, isolation, ball_count as usize, max_vertices as usize) as u32)
}

#[no_mangle]
pub extern "C" fn position_ptr() -> *const f32 {
    STATE.with(|s| s.borrow().position.as_ptr())
}

#[no_mangle]
pub extern "C" fn normal_ptr() -> *const f32 {
    STATE.with(|s| s.borrow().normal.as_ptr())
}

/// Room for `count` blob elements (surface_nets::BLOB_STRIDE f64 each, laid out as in surfaceNets.ts).
#[no_mangle]
pub extern "C" fn blob_elements_ptr(count: u32) -> *mut f64 {
    BLOBS.with(|s| s.borrow_mut().elements_ptr(count as usize))
}

/// Meshes the first `element_count` elements over the given grid (blobGrid on the JS side).
/// Returns the vertex count; `blob_index_count` has the index count.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn blobs(
    nx: u32, ny: u32, nz: u32,
    origin_x: f64, origin_y: f64, origin_z: f64, cell: f64,
    iso: f64, element_count: u32, max_vertices: u32, max_indices: u32, colors: u32,
) -> u32 {
    let grid = surface_nets::Grid { origin: [origin_x, origin_y, origin_z], cell, n: [nx as usize, ny as usize, nz as usize] };
    BLOBS.with(|s| s.borrow_mut().run(&grid, iso, element_count as usize, max_vertices as usize, max_indices as usize, colors != 0) as u32)
}

#[no_mangle]
pub extern "C" fn blob_index_count() -> u32 {
    BLOBS.with(|s| s.borrow().index.len() as u32)
}

#[no_mangle]
pub extern "C" fn blob_position_ptr() -> *const f32 {
    BLOBS.with(|s| s.borrow().position.as_ptr())
}

#[no_mangle]
pub extern "C" fn blob_normal_ptr() -> *const f32 {
    BLOBS.with(|s| s.borrow().normal.as_ptr())
}

#[no_mangle]
pub extern "C" fn blob_color_ptr() -> *const f32 {
    BLOBS.with(|s| s.borrow().color.as_ptr())
}

#[no_mangle]
pub extern "C" fn blob_index_ptr() -> *const u32 {
    BLOBS.with(|s| s.borrow().index.as_ptr())
}
