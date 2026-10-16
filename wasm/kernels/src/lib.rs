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
mod tables;

use std::cell::RefCell;

thread_local! {
    static STATE: RefCell<marching_cubes::Metaballs> = RefCell::new(marching_cubes::Metaballs::default());
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
