# Heavy geometry off the main thread

Status: shipped on three nodes — `object/metaballs` (Surface Nets or legacy
marching cubes, each JS or Rust/WASM),
`curve/to_mesh` and `modifier/boolean` (JS kernels). Code in
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

A pool of dedicated module workers (`geometry.worker.ts`), `min(4,
hardwareConcurrency - 1)` of them (`poolSize`, at least one). `WorkerPool`
(`workerExecutor.ts`) routes each job by the asking node's id: `JobExecutor.run`
takes the node id as `route`, and `LaneRouter` puts a node it has not seen on
the worker with the fewest nodes and keeps it there. So one node's jobs always
run on one worker, in order, and that worker's scratch (marching-cubes field,
WASM memory) stays sized for that node. Each worker starts on the first job
routed to it (`installGeometryWorker()` in `main.tsx` only registers the
factory), so a project with one heavy node spawns one worker. A worker holds no
graph state and runs its jobs one at a time in arrival order. Any worker
failing rejects that job, and the scheduler drops the whole pool and goes
inline. `__tsuji.offthread.use(...)` builds a fresh pool.

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
  is built fresh per job, so it is transferred, not copied. `transferablesOf`
  looks into nested objects (a boolean's two sides and their attribute maps).
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
- **Inputs owned upstream** (boolean's two meshes) must be *copied*
  into the payload, never transferred: transferring detaches the upstream
  node's live attribute arrays. Boolean's bake (`bakeMeshesToGeometry`, which
  clones every attribute and applies the world matrix) is that copy, so its
  arrays are the node's own and *are* transferred. `offthread/testing.ts`'s
  `CloningExecutor` runs jobs through `structuredClone` with transfer, so the
  node tests fail if a node hands over an array it still uses.

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
   metaballs node regardless of language. With one worker serving every node,
   four metaballs at 22 ms of JS kernel per frame updated at ~45 Hz and trailed
   further behind; at 8.5 ms in WASM they kept up with 60 fps. (There is now a
   pool of workers, see "Worker pool"; WASM still means fewer cores busy.) So: worker
   for every heavy node, WASM *inside* the worker for kernels that are tight
   numeric loops over flat arrays.
2. **Ship metaballs on WASM** (default `DEFAULT_BACKEND = "wasm"`, JS fallback
   automatic). 30 KB `.wasm`, no dependencies, bit-identical output.
3. **Raw `extern "C"` exports, not wasm-bindgen.** Kernels take typed arrays in
   and give typed arrays back; the JS glue is a dozen lines of views over
   `memory.buffer` (`wasmKernels.ts`). No `wasm-bindgen-cli` version to keep
   in lockstep with a crate, no generated JS. Revisit if a kernel needs strings,
   closures or structured errors.
4. **`curve/to_mesh` — worker, JS. Done**, see below. The sweep is three's math
   (curves, Frenet frames) emitting vertices; porting curve evaluation to Rust is
   a lot of surface for ~2×.
5. **`modifier/boolean` — worker, JS (three-bvh-csg in the worker). Done**, see
   below. CSG in Rust means `manifold-3d` (C++→WASM, needs watertight inputs,
   different output) — a behaviour change, not a port; only if three-bvh-csg in
   a worker is still too slow.
6. **Not the fire sim** — already on the GPU in the app.

## Metaballs: Surface Nets (`blobs` job)

`object/metaballs` has two meshers, picked by its `mesher` param:

- **`surfaceNets`** (default) — job kind `blobs`, `surfaceNets.ts` /
  `wasm/kernels/src/surface_nets.rs`, bit-identical (`surfaceNets.test.ts`).
- **`marchingCubes`** — job kind `metaballs`, the original three port above,
  unchanged, so an old scene can be matched exactly.

What `blobs` changes:

- **Field**: a sum of compact bumps `w·(1 − d²/R²)³`, R = radius × smooth,
  zero past R; iso = `(1 − 1/smooth²)³`, so a lone element's surface is
  exactly at its radius (same meaning of Radius/Smooth as before).
- **Elements**: spheres, ellipsoids (an instance's or child's rotation ×
  scale, `instanceShape`, off by default so scaled marker objects don't shrink old scenes), capsules (`segments` input: a point list is a polyline, e.g. Curve → To Points; a list of point lists is several). A polyline's capsules share a chain id: inside a chain the nearest segment wins instead of their bumps adding up, so tubes don't bulge at joints. Per element: radius
  (`radii`), signed weight (`weights`, < 0 carves), colour (`colors`, or the
  instance/material colour with `inheritColors`). Element layout: 28 f64,
  `BLOB_STRIDE` in `surfaceNets.ts`; `writeBlobElement` fills one.
- **Grid**: fitted to the positive elements' boxes (not a cube), `resolution`
  cells along the longest side (8–256), 2 empty cells of padding. Only
  8³-cell bricks some positive element reaches are sampled; each element
  splats just the samples inside its own box. The grid is laid out on the JS
  side (`blobGrid`) and handed to Rust, so both sample the same points.
- **Mesh**: naive Surface Nets — a vertex per crossed cell (mean of its edge
  crossings), a quad per crossed edge. Indexed, closed, outward-wound;
  normals are the analytic gradient; colours blended by bump weight.
  `MeshBuffers` gained optional `index` and `color`.

Kernel times (Node 24 / V8, median ms,
`TSUJI_KERNEL_BENCH=1 npx vitest run src/shared/graph/offthread/surfaceNets.bench.test.ts`).
Like for like — marching cubes' bench scene as elements, same cell size:

| MC res | balls | MC verts / tris | MC WASM | SN res | SN verts / tris | SN WASM |
|---|---|---|---|---|---|---|
| 32 | 8 | 5 268 / 1 756 | 0.25 | 26 | 888 / 1 760 | 0.21 |
| 48 | 24 | 35 208 / 11 736 | 1.44 | 40 | 5 737 / 11 448 | 1.41 |
| 64 | 24 | 62 496 / 20 832 | 2.80 | 54 | 10 419 / 20 804 | 2.63 |
| 64 | 128 | 108 852 / 36 284 | 4.94 | 55 | 19 139 / 38 324 | 8.25 |
| 96 | 64 | 180 000 (capped) / 60 000 | 8.96 | 83 | 39 876 / 79 764 | 12.88 |

Same speed at equal cell size for ordinary scenes, ~6× fewer vertices (shared,
smooth-shaded), and no 180k cap truncating the surface (SN caps at 600k
vertices). Dense overlaps (128 balls) cost ~1.7×: samples on brick faces are
computed twice ((9/8)³ ≈ 1.4×) and every element's bump is f64. Mixed scene
(spheres, ellipsoids, capsules, carving), WASM: res 64 / 128 elements 9 ms,
res 128 / 64 elements 33 ms, res 256 / 256 elements 400 ms — high
resolutions are for stills and export (capture runs the job synchronously),
not for dragging.

Not done yet: remeshing only the bricks an element moved through (the worker
keeps a node on the same lane, so a per-node brick cache is possible), and
sharing brick-face samples between neighbours.

## `curve/to_mesh` and `modifier/boolean`

### Where Curve to Mesh's time went

Timers around the two halves of the node, curve demos (`curve_primitive`,
`spiderweb`, `trail`) × 4, 121 frames, 16 nodes, 976 rebuilds:

| part | total | per frame |
|---|---|---|
| `curve.toJSON()` | 3.5 ms | 0.03 ms |
| `JSON.stringify` of the signature (8.4 MB in all) | 44 ms | 0.37 ms |
| tube sweep (`createVariableThicknessTubeGeometry`) | 3 466 ms | 28.6 ms (3.6 ms per rebuild) |

The signature is ~1.5% of it, so it stays a `JSON.stringify` (and the
`curve.toJSON()` it is built from doubles as the payload); no control-point
hash. Most of the sweep is `getPointAt`/`getTangentAt` on curves that are new
objects every frame, so every rebuild also rebuilds the curve's arc-length
table.

### Curve to Mesh

- **Kernel** `curveTube` (`offthread/curveTube.ts`): rebuilds the curve from
  its `toJSON()` (`curveFromJSON`, `curveClasses.ts`) and runs the same
  `createVariableThicknessTubeGeometry` (moved to `tubeGeometry.ts` so the
  worker can load it without the node registry). Result: `position`, `normal`,
  `uv`, `index`; the node swaps them into a fresh geometry on the same mesh, as
  the inline rebuild always did.
- **Curve classes.** `CurvePath.fromJSON` only knows three's own classes, and
  a subclass's `toJSON()` says `type: "Curve"`. `SaggedLineCurve3` and
  `RadialOffsetCurve3` (moved to `curveClasses.ts`) now set their own `type`;
  `curveFromJSON` handles those, three's `LineCurve3`, `QuadraticBezierCurve3`,
  `CubicBezierCurve3`, `CatmullRomCurve3`, and `CurvePath`s of them, nested.
  Anything else (`canRebuildCurve` false) is swept inline on the main thread as
  before.
- **Parity** (`curveTube.test.ts`): every curve class the curve nodes build,
  plain and trimmed/capped/profiled, rebuilt and swept bit for bit like the live
  curve; the node through a cloning executor matches the old inline sweep.
- **Not moved:** the Surface mode's fill (only when Surface is on) and
  `curve/to_mesh_list` (same sweep, one per curve in a list) — same kernel
  would serve the latter, as N jobs or one job with a list.

### Boolean

- **Kernel** `boolean` (`offthread/csg.ts`): the two sides arrive as the flat
  arrays + groups of their baked world-space geometry; the worker rebuilds the
  brushes (and their BVHs) and runs three-bvh-csg. Result: attributes, Uint32
  index, groups, draw count.
- **Materials** cannot cross, but three-bvh-csg only compares them by identity
  (which slots merge, which get dropped). The node numbers its distinct
  materials, each side lists the number per group, the worker stands one
  placeholder `Material` in for each number, and the result lists the number
  of each of its slots. Two meshes sharing a material keep sharing a number,
  so groups merge exactly as before.
- **Failures** come back as a result (`error`), not a rejected job — a CSG
  that throws on bad input must not turn the worker off for the session. The
  node passes its first input through, as before, and logs once per input
  change instead of every frame.
- The main thread still runs `sideSignature` every frame and, when a job is
  started, the bake (clone + world matrix + merge).
- **Parity** (`csg.test.ts`): the old inline evaluate, copied into the test,
  against the node inline and through a cloning executor — subtract/add/
  intersect × useGroups on/off × one mesh per side and several meshes per side
  sharing materials: same attributes, index, groups, draw range, and the same
  material objects slot for slot.

### Numbers

Stress bench, the demos with these nodes (`curve_primitive`, `spiderweb`,
`trail`, `modifier_boolean`, `modifier_weld`; 6 files) × 4, 120 animated frames
(`TSUJI_STRESS_FILTER=curve_primitive,spiderweb,trail,modifier_boolean,modifier_weld TSUJI_STRESS_COPIES=4`):

| | evaluate mean ms/frame | `curve/to_mesh` (16) | `modifier/boolean` (8) | worker kernels ms/frame |
|---|---|---|---|---|
| before (ef0ca04), `npm run stress` | 50.11 | 28.95 | 13.48 | — |
| before (ef0ca04), `TSUJI_STRESS_OFFTHREAD=1` | 52.51 | 30.57 | 13.85 | — (not off-thread yet) |
| after, `npm run stress` (inline) | 50.74 | 29.44 | 13.63 | — |
| after, `TSUJI_STRESS_OFFTHREAD=1` | **9.07** | **0.87** | **0.66** | 43.58 (12 jobs/frame) |

Per job in the worker: tube 3.75 ms mean, CSG 3.39 ms mean. In the app
(dev server, Chromium, background pane): `worker: boolean` ~4.7 ms/job and
0.37 ms/call on the main thread on the boolean demo; `worker: curveTube`
~4 ms/job on the trail demo; no console errors.

Inline (headless, capture, first frame) costs what it did, plus one
throwaway geometry per run (the kernel builds geometry, hands back its
arrays). The worker bundle grew from the marching-cubes kernel to 268 KB
(three + three-bvh-csg); it still loads only on the first job.

**A single worker was then the limit.** At ×4 these demos queue ~44–49 ms of
kernel per 16.7 ms frame: the main thread is free, but with one worker tubes
and CSGs land at ~20 Hz and trail further while things move. The worker pool
(next section) fixes that.

## Worker pool

Same bench, same flags plus `TSUJI_STRESS_WORKERS=N`. The bench's
`DeferredExecutor` routes jobs through the same `LaneRouter` as the app and
times each lane's kernels on its own; "busiest lane" is the slowest worker's
kernel time per frame, which is how long the pool needs to deliver a frame's
results (kernels still run one after another in the bench process, so this is
the ideal with no contention between cores). 8-core Apple M1, so the app
would pick 4. 24 job-running nodes, 12 jobs/frame:

| workers | kernels, all lanes ms/frame | busiest lane ms/frame | per lane ms/frame | results land at |
|---|---|---|---|---|
| 1 | 46.72 | 46.72 | 46.72 | ~21 Hz |
| 2 | 48.26 | 25.87 | 24.35 / 23.91 | ~39 Hz |
| 3 | 49.53 | 19.18 | 16.03 / 17.15 / 16.36 | ~52 Hz |
| 4 (default here) | 49.26 | **14.94** | 12.50 / 12.05 / 12.57 / 12.14 | 60 Hz |

Main-thread evaluate is unchanged by the pool (9.6–10.8 ms/frame mean across
these runs, run-to-run noise). Counting nodes balances well here (lanes
within 5% of each other) because the job-running nodes cost about the same
(tube ~4.2 ms/job, CSG ~3.7 ms/job); `LaneRouter` does not know a node's cost.

In the app (dev server, Chromium, background pane — throttled frames, per-job
times valid): the profiler overlay has a `worker #N busy` row per worker next
to the per-kind `worker: …` rows. On the Orbit Trails demo the two
`curve/to_mesh` nodes ran on two workers (~5 ms/job each), evaluate 0.6–0.7 ms;
`__tsuji.offthread.use("off")` → 8.3 ms evaluate, `use("js")`/`use("wasm")` →
back to two workers. No console errors.

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

- **Pool of at most 4.** The ×4 curve/boolean bench needs 46.7 ms of kernel
  per frame; four workers bring the busiest lane to 14.9 ms, just inside a
  60 fps frame. More nodes, or a machine with fewer cores (a 4-core one gets 3
  workers: 19.2 ms), trail again. Routing counts nodes, not their cost: one
  expensive node and three cheap ones on a lane can lag while others idle.
  Assignments are kept for the session, including for deleted nodes.
- **One scratch field per worker**, sized to the last resolution: two metaballs
  nodes at different resolutions on the *same* worker reallocate per job
  (on different workers, now the usual case with ≤4 such nodes, they do not).
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
