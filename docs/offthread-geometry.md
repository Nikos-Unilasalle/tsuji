# Heavy geometry off the main thread

Status: prototype, shipped on one node (`object/metaballs`). Code in
`src/shared/graph/offthread/`, Rust in `wasm/kernels/`.

## Why

`evaluateGraph` runs every frame inside the viewport tick, on the main
thread, synchronously. A few geometry nodes do one big computation there each
time their inputs move, and that blocks the frame, the UI and input together.
From `npm run stress` (animated, ms per frame):

| node | ms/frame | what it does |
|---|---|---|
| `curve/to_mesh` (4 nodes) | ~8 | tube sweep along each curve, plus a `JSON.stringify` of every curve for its signature |
| `object/metaballs` | ~6.4 (7 ms/call on the metaballs demo) | marching cubes over a res³ field |
| `modifier/boolean` | ~4.8 | three-bvh-csg: BVH build + CSG |

(`simulation/fire-fluid-volume`'s 37 ms is the bench's headless CPU fallback;
in the app it runs on the GPU.)

## The shape of it

A node cannot wait for a worker, so it stops asking for *the* answer and
asks for *the newest answer there is*:

```ts
const job = requestJob(ctx.nodeId, "metaballs", signature, () => buildPayload(), { sync: ctx.capturing });
if (job.result && job.signature !== applied) attach(job.result);
```

`requestJob` (`offthread/jobs.ts`) returns at once with `{ result, signature, fresh }`:
the last finished result, the signature it was computed for, and whether
that is the signature just asked for. Behind it, one slot per node:

- **Cache by input signature.** The node builds a signature of everything the
  result depends on (it already had one, for skipping unchanged frames). Equal
  signature ⇒ the slot's result is returned and nothing runs. The node keeps
  its own "signature last attached" so it only touches its geometry when a
  *new* result lands.
- **At most one job in flight per node, latest wins.** A new signature while a
  job runs replaces whatever was queued; when the job lands, the queued one is
  sent. Dragging a slider through 40 states computes the first and the last,
  not 40. Going back to the signature already shown (or already in flight)
  drops the queue.
- **Inline when it must be exact or cannot be async**: no executor (Node,
  tests — so the whole suite runs as before), `sync` (export capture, below),
  or no result yet (first evaluation after load/creation: one blocking frame
  instead of a frame with nothing in it).
- **Results land between frames.** The node is not `pure`, so the viewport's
  per-frame evaluate calls it and it picks the result up on the next tick. A
  node using this must never be marked `pure`: the memo would never call it
  again to collect the result. Downstream nodes see the same `Mesh` object
  throughout (the node writes into its own geometry), so downstream caches keyed
  on identity behave as before.
- **Versioned writes.** A result computed inline (a captured frame) bumps the
  slot's version; a worker result that was dispatched before it is discarded
  when it lands instead of overwriting the newer one.
- **Lifetime.** Slots live in a `createNodeCache`, so deleting a node drops
  its slot; a job that lands for a deleted (or deleted-and-re-added) node is
  ignored by identity.
- **Failure.** An executor that rejects once (worker failed to load, crashed)
  is dropped for the session and everything runs inline — slower, never wrong.

Latency: while inputs move, the surface trails by the job's run time (one
frame or more); once they stop it is exact.

### Export / capture

`ctx.capturing` → `sync: true` → the JS kernel runs inline for that frame. Every
recorded frame is exact and current, with no waiting machinery and no timeout to
tune; export is offline, so blocking its frame costs nothing the user sees. The
alternative — keep the job async and hold the capture until every slot is
fresh, like `Viewport.tsx` already holds a frame for HUD image decodes
(`capture.waited`, `MAX_CAPTURE_WAIT_TICKS`) — is the fallback for a future
kernel that *cannot* run on the main thread (needs OffscreenCanvas, or only
exists as WASM). It would need a `jobsPendingFor(signatureNow)` query; not
built, since nothing needs it yet.

## Worker protocol

One dedicated module worker (`geometry.worker.ts`), started lazily on the
first job (`installGeometryWorker()` in `main.tsx` only registers the factory).
It holds no graph state and runs jobs one at a time in arrival order.

```
main → worker   { type: "init", backend: "wasm" | "js" }
main → worker   { type: "job", id, kind, payload }          payload buffers transferred
worker → main   { type: "ready", backend }                   backend actually in use
worker → main   { type: "done", id, result, ms, backend }    result buffers transferred
worker → main   { type: "failed", id, message }
```

`kind` indexes `JobTypes` in `kernels.ts` (payload type, result type, JS
kernel). Payloads and results are plain objects of numbers and typed arrays.

### Transferable buffers

- **Payload** (metaballs: `Float64Array` of ball centres/strengths, 5 per ball)
  is built fresh per job, so it is transferred, not copied.
- **Result** (`position`, `normal`, `uv` as `Float32Array` exactly vertex-count
  long, plus `bounds`) is transferred back. On the main thread the node either
  hands those arrays straight to new `BufferAttribute`s (vertex count changed)
  or copies them into the existing ones (same count — the GPU buffer is then
  updated in place, not reallocated). Bounding box/sphere come precomputed, so
  the main thread does at most one memcpy per attribute: ~0.1 ms per landed result.
- **WASM**: outputs live in the module's linear memory, which cannot be
  transferred; `finishMesh` copies them out once (it has to produce the
  node-space positions, UVs and bounds anyway) into fresh arrays, which are
  then transferred.
- **Inputs owned upstream** (a future boolean's two meshes) must be *copied*
  into the payload, never transferred: transferring detaches the upstream
  node's live attribute arrays.

## Rust/WASM: where it is worth it

Same jobs, kernel time only. Node 24 / V8, median ms
(`TSUJI_KERNEL_BENCH=1 npx vitest run src/shared/graph/offthread/marchingCubes.bench.test.ts`):

| res | balls | verts | old path (three's MarchingCubes) | JS kernel | Rust→WASM | WASM vs JS |
|---|---|---|---|---|---|---|
| 32 | 8 | 5 268 | 0.89 | 0.68 | 0.25 | 2.7× |
| 32 | 64 | 25 632 | 3.13 | 1.94 | 0.93 | 2.1× |
| 48 | 24 | 35 208 | 5.83 | 3.53 | 1.44 | 2.5× |
| 64 | 24 | 62 496 | 12.94 | 7.36 | 2.92 | 2.5× |
| 64 | 128 | 108 852 | 20.82 | 11.05 | 5.18 | 2.1× |
| 96 | 64 | 180 000 | 48.74 | 26.57 | 9.64 | 2.8× |

The JS kernel is a port of three's class without the colour palette three's
`addBall` fills (a sqrt and a smoothstep per touched cell) even with colours
off — that alone is 1.3–1.9×. Both ports produce three's output bit for bit
(`marchingCubes.test.ts`). `+simd128` changed nothing: the build was
byte-identical (scalar, branchy loops; nothing for LLVM to vectorise).

Stress bench, metaballs demo × 4 (`TSUJI_STRESS_FILTER=metaballs TSUJI_STRESS_COPIES=4`):

| | main thread, metaballs ms/frame | evaluate mean ms/frame | kernel ms/frame (worker) |
|---|---|---|---|
| before (HEAD, three's class inline) | 27.86 | 28.55 | — |
| JS kernel inline (`npm run stress`) | 22.41 | 23.07 | — |
| worker, JS kernel (`TSUJI_STRESS_OFFTHREAD=1`) | 0.17 | 0.94 | 22.42 |
| worker, WASM kernel (`TSUJI_STRESS_OFFTHREAD=wasm`) | 0.17 | 0.87 | 8.46 |

In the app (dev server in Chromium, metaballs demo, profiler overlay; the pane
was in the background so frames were throttled — per-job kernel times are
valid, frame rates are not):

| backend | evaluate mean | metaballs on main | worker kernel per job |
|---|---|---|---|
| off (inline JS kernel) | 3.71 ms | 3.42 ms | — |
| worker + JS | 0.40 ms | 0.11 ms | 4.4–5.6 ms |
| worker + WASM | 0.40 ms | 0.10 ms | 2.7–3.1 ms |

Not yet measured in WKWebView (the macOS Tauri webview is JavaScriptCore, not
V8): open the demo in the app, Ctrl/Cmd+Shift+P, and compare the
`worker: metaballs` row under `__tsuji.offthread.use("js")` vs `use("wasm")`.

### Recommendation

1. **The worker is what fixes the lag; WASM is what keeps the worker keeping up.**
   Moving the kernel off-thread takes the main thread from ~7 ms to ~0.04 ms per
   metaballs node regardless of language. But one worker serves every node: four
   metaballs at 22 ms of JS kernel per frame means the surfaces update at ~45 Hz
   and trail further behind; at 8.5 ms in WASM they keep up with 60 fps. So: worker
   for every heavy node, WASM *inside* the worker for kernels that are tight
   numeric loops over flat arrays.
2. **Ship metaballs on WASM** (default `DEFAULT_BACKEND = "wasm"`, JS fallback
   automatic). 30 KB `.wasm`, no dependencies, bit-identical output.
3. **Raw `extern "C"` exports, not wasm-bindgen.** Kernels take typed arrays in
   and give typed arrays back; the JS glue is a dozen lines of views over
   `memory.buffer` (`wasmKernels.ts`). No `wasm-bindgen-cli` version to keep
   in lockstep with a crate, no generated JS. Revisit if a kernel needs strings,
   closures or structured errors.
4. **`curve/to_mesh` — worker, JS.** The sweep is three's math (curves,
   Frenet frames) emitting vertices; porting curve evaluation to Rust is a lot of
   surface for ~2×. First split its 8 ms: the `JSON.stringify` of every curve for
   the signature runs on the main thread every frame and has to stay there (it is
   also the payload — `curve.toJSON()` rebuilt in the worker with
   `ObjectLoader`-style parsing). If the signature turns out to dominate, hash the
   control points instead of stringifying.
5. **`modifier/boolean` — worker, JS (three-bvh-csg in the worker).** Copy both
   input meshes' attributes into the payload, rebuild the brushes and BVHs in the
   worker, send back attributes + groups. CSG in Rust means `manifold-3d` (C++→WASM,
   needs watertight inputs, different output) — a behaviour change, not a port;
   only if three-bvh-csg in a worker is still too slow.
6. **Not the fire sim** — already on the GPU in the app.

## Adding a node

1. Write the kernel as a pure function over typed arrays in `offthread/`
   (no THREE objects in or out), add it to `JobTypes` / `JS_KERNELS`.
2. In the node: compute the signature, call `requestJob(..., { sync: ctx.capturing })`,
   attach the result to the node's own long-lived geometry when its signature
   differs from the one last attached. Do not mark the node `pure`.
3. Tests: kernel parity against the old main-thread path; scheduler behaviour
   comes for free (`jobs.test.ts`).
4. Optionally a Rust port in `wasm/kernels`, behind the same job kind, with a
   parity test against the JS kernel; `npm run build:wasm` and commit the `.wasm`.

## Known limits / next steps

- **One worker.** Jobs from all nodes queue behind each other. A small pool
  (`min(2, hardwareConcurrency - 1)`), routed by node id so each node's
  scratch stays warm, is the next step once a second node moves over.
- **One scratch field per worker**, sized to the last resolution: two metaballs
  nodes at different resolutions reallocate per job.
- **Allocation churn.** Every result is fresh arrays (~2 MB/job at 60k verts),
  garbage after being copied into same-size attributes. Return them to the
  worker for reuse (ping-pong pool) if GC shows up in the profile.
- **Slots are per node, not per session.** Two viewports at different times
  (editor + split preview) ask for different signatures and alternate — as the
  node's single mesh already did before.
- **No cancellation** of a running job; latest-wins only skips queued ones.
- **`.wasm` is committed** so `npm run build` / `tauri build` need no Rust wasm
  target; `npm run build:wasm` (needs `rustup target add wasm32-unknown-unknown`)
  after changing `wasm/kernels`. The WASM parity test fails if the two drift.
