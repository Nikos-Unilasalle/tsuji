#!/usr/bin/env bash
# Builds wasm/kernels (Rust) into the .wasm the geometry worker loads.
# Needs: rustup target add wasm32-unknown-unknown
# The built file is committed, so `npm run build` / `tauri build` do not need
# the Rust wasm target — re-run this only after changing wasm/kernels.
set -euo pipefail
cd "$(dirname "$0")/../wasm/kernels"
# No +simd128: tried, and the output was byte-identical — the marching-cubes
# loops are scalar and branchy, LLVM finds nothing to vectorise.
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/tsuji_kernels.wasm ../../src/shared/graph/offthread/tsuji_kernels.wasm
ls -l ../../src/shared/graph/offthread/tsuji_kernels.wasm
