# Tsuji — Bible

Working title. Rename freely — nothing below depends on the name.

**Status:** design captured 2026-08-11, night before the build starts. Nothing
coded yet. [OpenVMap](../VideoMapping) (Tauri + React + PixiJS 2D) keeps
running as-is — this is a separate future project, not a branch of it, and
the old one is not blocked on this one.

## Why this exists

Building OpenVMap surfaced a repeated pattern: every new capability (physics,
per-shape collision states, animations, crop panning) needed its own bespoke
UI panel and its own hardcoded wiring into the renderer. A node graph is the
right shape for this — one system where "wire X into Y" is a connection, not
a new feature to build.

## Who it's for

Installations combining video-mapping with dataviz, science popularization,
and IoT (real-time sensor data driving visuals). **Not** primarily a
touring-VJ tool — this shapes priorities below. OSC was considered and
rejected as overkill for the actual need (streaming sensor data, not syncing
with a lighting/sound console); MQTT/WebSocket fits better. A keyboard is
enough for interactivity for now — MIDI is a later nice-to-have, not a launch
requirement.

## Core architectural decisions

- **Single engine, full 3D.** three.js. 2D shapes (polygons) are flat 3D
  geometry (z=0 plane), not a separate 2D pipeline. This isn't just
  simplicity for its own sake — it makes corner-pin warp (OpenVMap's
  signature feature) trivial: four vertices of a textured quad moved in 3D
  space, with perspective projection doing the rest, instead of the bilinear
  Coons-patch math the 2D version needed.
- **Node graph**, structure inspired by cable.gl (the Sequence node concept),
  logic/data-flow philosophy inspired by Blender's Animation Nodes and
  Geometry Nodes. The user was a contributor to Animation Nodes — that
  reference carries real weight, not aesthetic preference.
- **A real node system, not a hybrid.** Explicitly rejected: bolting a small
  node graph onto an otherwise-imperative app (the "modulation only" idea).
  A node system has to be the source of truth for everything it touches, or
  you get two competing execution models fighting each other.
- **VNStudio's existing node engine is a candidate foundation** rather than
  building a graph engine from scratch — VNStudio (this user's other app) is
  already a general node-based tool. Worth evaluating before writing a new
  graph runtime: how much of its evaluation model, socket system, and UI
  actually transfers to a 3D/real-time context versus VNStudio's own
  batch/CV-pipeline assumptions. **Open question for day one, not decided.**

## Scene hierarchy & vocabulary

```
Scene ──▶ Sequence ──▶ (branches, one per object) ──▶ Render
```

- **Scene** — the root of one independent tree. Holds: `fps`, canvas size,
  `name`, and a `caller` (an identifier used to trigger that scene live —
  bound to a keyboard shortcut today, MIDI/OSC-equivalent later).
- **Multiple scenes = multiple independent trees**, not one mega-graph. Each
  scene is triggered/switched independently, same mental model as OpenVMap's
  scene list today.
- **Sequence** — named after the cable.gl node of the same role. The point
  where the tree branches into the scene's individual visual elements.
  Purely organizational — keeps a scene's tree legible by separating its
  elements, nothing more. Has as many output ports as it has objects.
- Each branch under a Sequence is one **Object** (a node subtree describing
  one visual element: geometry, transform, appearance, physics, animation).
- **Render** — terminal node(s) that actually draw to the output.

## Socket type system

`Value` (scalar) · `Vector` (Vec3 — 2D is just z=0, no separate Vec2 type) ·
`Matrix` (4×4, position+rotation+scale fused) · `Color` (RGBA — kept distinct
from Vector despite the overlap, because color has different UI and blend
semantics) · `Geometry` (a mesh — 2D polygon and imported 3D model are the
same underlying thing) · `Texture` (image/video/cable.gl/render-target) ·
`List` (a collection of any of the above — what gives Sequence its N output
ports, and what most list-processing math nodes operate on).

**No dedicated Trigger/pulse type.** A plain `Boolean` is enough; a
rising-edge-detector node turns a continuous boolean into a discrete "just
happened" event where that distinction actually matters. Decided explicitly
— simpler than Animation Nodes' event system, and this app doesn't need
Blender's execution-order guarantees around events.

## Base node catalog

Grouped by category. Not exhaustive, not final — the working list as of
tonight, meant to grow once real graphs get built and gaps show up.

**Structure**
`Scene` · `Sequence` · `Object` (polygon or imported mesh, same node type —
gains `castShadow`/`receiveShadow` toggles) · `Light` (point/spot/
directional/ambient — color, intensity, cone angle for spot, cast-shadow
toggle; native three.js shadow-mapping, nothing exotic) · `Group` (reusable
sub-tree, instanced) · `Render`

Lets a virtual light cast a virtual object's shadow onto real geometry (if
the physical space is roughly modelled in 3D) — the projected result reads as
part of the space instead of floating on top of it, same spirit as `Manual
Alignment`. Practical limit, not a blocker: each shadow-casting light is one
extra depth pass per frame — fine for a handful, budget accordingly past
that.

**Transform** — the flagship node, called out first for a reason: almost
every other node ends up feeding this one.
`Transform` (location/scale/rotate → outputs a Matrix) ·
`Compose/Decompose Matrix` (Matrix ↔ separate loc/rot/scale) ·
`Parent` (chains matrices) ·
`Look At` (orient toward a target point — camera, audience position, another object)

**Math**
`Value Math` (add/mul/clamp/min/max/mod…) ·
`Vector Math` (dot/cross/normalize/lerp/length) ·
`Map Range` — expect this one to be the single most-used node in the whole
catalog; it's the universal "rescale a value from one range to another,"
which is what every sensor→parameter or audio→parameter mapping reduces to ·
`Easing/Curve` (interpolation shape — linear/quad/expo/custom) · `Noise` (Perlin/Simplex)

**Time / Animation**
`Time` — the master clock; see below, this reuses a proven mechanism, not a
new design · `Oscillator` (sine/saw/square/triangle over time — this one
generic node replaces OpenVMap's five hardcoded animation types: strobe,
colour-slide, pan, rotation-spin, scale-pingpong all become "an oscillator
wired into a different property") · `Envelope` (attack/sustain/release —
doubles as the ease-in/ease-out shaping for trigger-driven animation, with
`Easing/Curve` supplying the shape of each segment; the two are
complementary, not redundant) · `Pulse` (trigger-driven physical impulse —
exponential decay back to 0, retriggers stack additively; complementary to
`Envelope`'s explicit attack/release shaping) · `Delay`

**Logic**
`Compare` · `Boolean Logic` (AND/OR/NOT/XOR) · `Gate/Switch` ·
`Trigger` (rising-edge detector — produces/consumes plain Booleans, see
socket types above) · `Toggle` (flip-flop, remembers on/off across pulses)

**I/O**
`Listen` — subscribe to a named port; doubles as a generic anti-spaghetti
reroute *and* the entry point for a live sensor feed, same mechanism, two
uses · `MQTT/WebSocket In` (the concrete IoT sensor ingestion node) ·
`Keyboard In` · `Audio Analysis` (RMS / FFT band / beat) ·
`MIDI In` (later, not a launch requirement) ·
`CSV Reader` (static/tabular data for dataviz — load a file, output columns
as `List`; pairs directly with `Map Range` to drive any visual parameter
from a real dataset, no new socket type needed)

**Physics** — direct carry-over of a system already built and validated in
OpenVMap this session, including real collision detection (not proximity
guessing) via nape-js's InteractionListener BEGIN/END events.
`Physics World` (gravity, deterministic epoch — see Time below) ·
`Physics Body` (role static/dynamic, elasticity/friction/density) ·
`Cloth` (a mesh whose edges become distance constraints — gravity, wind,
pinned Empties and sphere colliders; the red vertex-color channel masks which
parts are free cloth, see nodes/cloth.ts) ·
`Collision Event` (outputs a Boolean while two bodies touch — this alone
generalizes OpenVMap's hardcoded two-state Normal/Collision appearance system
into "wire a collision into literally any parameter," strictly more capable
for no extra node)

**Particles** — texture-based (GPGPU pattern: particle state — position,
velocity — encoded in a floating-point texture, updated by a fragment shader,
ping-ponged between two render targets) rather than a CPU array, to stay
cheap at scale. three.js has an established pattern for this
(`GPUComputationRenderer`).
`Particle Emitter` (spawn rate, initial position/velocity) ·
`Particle Simulate` (the update shader — gravity, wind, lifetime) ·
`Particle Render` (draws the cloud — points or sprites)

**Post-render 2D** (renamed from "Grading" — `Glow` belongs here too, decided
2026-08-11: it's a screen-space post-render effect, not a per-object 3D
property. Standard bloom technique — bright-pass threshold, blur, additive
composite onto the rendered frame — the classic three.js `EffectComposer`
pass shape. This groups it with grading as the same *kind* of node: each
takes the rendered frame as a Texture in, hands back a modified Texture, no
3D/object awareness needed. Worth noticing that shape is exactly what a
generic stackable `Filter` node would model well — narrows the still-open
question below, without deciding it outright.)
`Glow` · `Brightness/Contrast` · `Levels` · `HSV Shift` — simple, standard shader uniforms.

**Calibration**
`3D Grid` (visual overlay for millimetring animations against the real
space) · `Manual Alignment` — **not** fSpy's actual method after all: no
photo, no vanishing-point computation. The real projector is the calibration
feedback loop. Reference geometry (lines, a wireframe, the edges of the 3D
object being mapped) is projected live through the actual output, and the
operator drags its control points by hand until it matches the physical
space — the same direct-manipulation model OpenVMap's corner-pin handles
already use today, just extended from a flat quad to arbitrary 3D geometry.
fSpy (<https://github.com/stuffmatic/fSpy>) was the initial reference point
for "recover spatial alignment," but its actual technique — a single static
photo plus vanishing-point picks — isn't the approach here; noted so nobody
goes implementing a vanishing-point picker UI expecting it to be used.

**Settled 2026-08-12, after building the wrong one first.** A vanishing-point
picker *was* built (draggable lines over the live view, no photo), and it
failed on the real install for three reasons worth recording so the mistake
isn't repeated:

1. Two vanishing points recover rotation and focal length — **never
   position**. The projector sits somewhere specific in the room, so the
   scene landed nowhere near the physical space however carefully the lines
   were traced. An object at the world origin simply vanished off-frame.
2. A projector's principal point is far off-centre (lens shift / throw
   offset — the image is thrown well above the lens axis). The
   vanishing-point formula assumes it centred, so the model could not
   describe the actual hardware at all.
3. A small projection area — one or two walls, the usual room corner — means
   the traced lines are nearly parallel, so the vanishing points sit near
   infinity and the solve is wildly ill-conditioned: a couple of pixels of
   drag swinging the focal length by tens of percent.

What replaced it is still exactly the direct-manipulation model described
above, with one change that fixes all three at once: **each dragged control
point carries a known 3D coordinate.** A `Room Corner` node takes three tape
measurements of the actual room and emits both a reference wireframe (with a
subdivision grid — a bare outline gives the eye nothing to judge alignment
by once it lands on a real wall) and the six room corners as named reference
points. The operator drags one handle onto each matching physical corner,
and a Direct Linear Transform solves the projector's *whole* state at once:
position, orientation, both focal lengths, and the off-centre principal
point that is its lens shift.

The DLT's one degeneracy is all reference points lying on a single plane —
which a room *corner* avoids by construction. So the cramped two-wall
install that broke the vanishing-point method is precisely the configuration
this one wants. Solved pose feeds the camera as a full asymmetric projection
matrix, not an fov, since `fov` cannot express a lens shift by definition.

Reprojection error is surfaced as an output and in the overlay: with more
equations than unknowns the solve always returns *something*, so the operator
needs the residual to know whether it returned something true.

**Open, not yet decided:** `Outline` specifically — unlike Glow, an outline
is normally a *per-object* 3D technique (edge detection or an
inverted-normals duplicate-shell trick), not a screen-space pass, so it may
not end up in the same bucket as Glow/grading even though OpenVMap's 2D
version treats them as siblings today. Whether it and the post-render 2D
nodes are dedicated node types or entries in one generalized stackable
`Filter` node is still open — revisit once a couple of real graphs exist.

## Reusable engineering, not just concepts

- **The Time node's synchronization model already exists and is proven.**
  OpenVMap's physics system keeps two independent windows (editor + output,
  separate JS runtimes, no shared memory) in exact lockstep with **zero
  per-frame IPC**: both sides derive "how many fixed steps should have
  happened by now" purely from a shared epoch timestamp and the current wall
  clock, then step their own simulation forward to match — a window that
  reconnects mid-show just fast-forwards from the epoch instead of asking the
  other side for state. This is exactly the contract a `Time` node needs
  across an editor/output split, and it's already implemented and tested
  (`physicsClock.ts` in the OpenVMap repo) — port the pattern, don't
  re-derive it.
- **A GPU-state lesson worth not re-learning:** a whole evening this session
  went into a bug where a texture wrap mode was set correctly in JS but never
  reached the GPU, because the underlying graphics API cached a sampler
  object keyed by a resource ID that only gets invalidated by an explicit
  "commit" call — setting the property alone fired no event. Generalizes to:
  whenever a rendering library exposes "set this GPU state" as a plain
  property write, verify (by reading its source, not assuming) whether that
  write alone is sufficient or whether a separate invalidation call is
  required. Cheap to check up front, expensive to debug after the fact.

## Visual identity

Sonic Pi-inspired (dark editor chrome, saturated magenta/cyan accents,
monospace), softened: one notch less saturation, background dark grey rather
than pure black, contrast kept but the neon harshness dialed down. OpenVMap's
existing panel-tone system (physics = green, transform = purple, motion =
pink `#ec4899`, shape = cyan `#38bdf8`, one fixed colour per domain everywhere
it appears) is already in this family and is the starting point, not a
from-scratch palette.

## Explicit non-goals (for now)

- OSC — rejected, MQTT/WebSocket fits the actual IoT use case better.
- Full touring-VJ feature parity (this is not a Resolume/MadMapper competitor).
- MIDI support — later, not launch-blocking.
- Backward compatibility with OpenVMap's `.vmap` project format — this is a
  new engine with a new data model; migration, if it ever matters, is a
  separate later problem.
