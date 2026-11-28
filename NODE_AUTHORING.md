# Writing a node for Tsuji

This is a step-by-step guide for adding ONE node type to the graph engine.
Follow it exactly. Do not improvise file locations or the shape of
`NodeDefinition` — copy the patterns below.

The full target node list (what to build, organized by category) is in
`BIBLE.md` at the repo root. Pick one node from there, build it following
this guide, then stop — one node per task, don't try to build several at once.

## 1. Where files live

```
src/shared/graph/
  sockets.ts          <- the 7 socket types (read-only, don't edit)
  types.ts             <- NodeDefinition/EvalContext shape (read-only, don't edit)
  nodes/
    time.ts
    valueMath.ts
    vector.ts
    transform.ts
    object.ts
    render.ts
    <yourfile>.ts      <- you add a node here, in an existing file or a new one
    index.ts            <- you register your node here
    nodes.test.ts        <- you add a test here
```

Group related nodes in one file (e.g. all Value-type nodes are in
`valueMath.ts`). If your node doesn't fit an existing file, create a new
one named after the category (e.g. `logic.ts`, `particles.ts`).

**Never touch:** anything under `src/windows/` (the node editor UI) or
`src/shared/three/Viewport.tsx`. Node appearance (box shape, socket colors,
handle position) is 100% generic and driven by your node's `inputs`/
`outputs` list — you never write UI code for a new node.

## 2. The shape you must produce

```ts
import { NodeDefinition } from "../types";

export const MY_NODE: NodeDefinition = {
  type: "category/my-node",      // unique, lowercase, "category/name"
  label: "My Node",               // shown in the editor
  category: "math",               // which palette section it lives in — see section 3
  inputs: [
    { id: "a", label: "A", type: "value" },
  ],
  outputs: [
    { id: "out", label: "Out", type: "value" },
  ],
  defaultParams: { a: 0 },        // fallback value when "a" has no wire, plus any per-instance knobs
  evaluate: (inputs, params, ctx) => {
    const a = Number(inputs.a) || 0;
    return { out: a * 2 };
  },
};
```

Rules for `evaluate`:
- **Pure.** Same `inputs`/`params`/`ctx.time` in → same output out, every
  time. No reading `Date.now()`, no `Math.random()`, no reading any
  variable that isn't one of the three arguments. Time comes from
  `ctx.time` (seconds) or `ctx.step` (frame count) — never a wall clock.
- **Never mutate `inputs` or `params`.** They may be shared with other
  nodes reading the same wire. If you need to change a `THREE.Vector3`
  etc., make a new one (`inputs.vector.clone()`), don't call `.set()` on
  the one you were handed. (Exception: see §5, GPU resources.)
- Return an object with exactly the keys in your `outputs` list.
- Handle bad/missing input defensively — an unconnected input arrives as
  `undefined`, not your default. Always do `Number(inputs.a) || 0` or an
  `instanceof` check with a fallback, never assume the type is right.
  Look at `value/math`'s divide-by-zero handling in `valueMath.ts` for
  the pattern: return a safe finite number, never `NaN`/`Infinity` — a bad
  value must not poison every node downstream of it.

## 3. The category

`category` picks which section of the node palette your node shows up in,
and its colour — the same colour shows on the node's header in the graph and
on its param panel when selected. Categories are grouped into six families;
the palette lists the families in workflow order and, inside each, the
categories and their nodes alphabetically. All of it lives in
`src/shared/graph/categories.ts`.

| family | category key → palette section |
|---|---|
| Geometry | `attribute` Attributes · `curve` Curves · `deform` Deform · `generators` Generators · `import` Import · `instance` Instances & Points · `modeling` Modeling · `primitives` Primitives · `selection` Selection & Groups · `strokes` Strokes & Drawing · `volume` Volumes (SDF) |
| Scene | `camera` Camera · `lighting` Lighting · `structure` Scene & Graph · `transform` Transform |
| Appearance | `fx` Object FX · `material` Materials · `postprocess` Post-Process & Stylize · `texture` Textures · `textureTools` Texture Tools |
| Animation & Simulation | `particles` Particles · `physics` Physics & Fluids · `rig` Rig / IK · `time` Time & Animation |
| Data | `convert` Compose & Convert · `dataviz` Data Viz · `list` Lists · `logic` Logic · `math` Math · `text` Text |
| Interaction & Audio | `io` Input & HUD · `music` Music · `sound` Sound |

**File a node by what it does to its data, not by the data it touches.**
Extrude is Modeling even though it moves points; Lattice is Deform even
though it takes a matrix; a scatter is Instances & Points wherever its
points come from. Some hints:
- *Modeling* changes topology (adds, removes, rebuilds faces); *Deform*
  only moves existing points.
- *Generators* build something procedural from parameters (terrain, tree,
  L-system); *Primitives* are the plain shapes.
- *Compose & Convert* holds every compose/decompose and type conversion.
- *Object FX* are effects on one object; *Post-Process & Stylize* act on the
  render (the stylize looks offer "Apply To: Screen / Object" in one node).

**Never decide behaviour from a category.** Re-filing a node must not change
what it does. Use an explicit flag on the definition instead:
`ownershipPassThrough` (geometry wired in is not drawn on its own),
`managedByViewport` (lights). `nodeCatalog.test.ts` fails on any
`def.category === "…"` test outside the palette.

**Labels are unique** among the nodes the palette offers (the same test
checks it): when two nodes would share a name, qualify one ("Texture Blur",
"Physics Spawner").

**A sentence of help**: every node in the Geometry family has a
`description` (one or two plain sentences: what it does, what to wire in),
shown at the top of its param panel. Set it on the definition or add it to
`nodes/nodeDescriptions.ts`; `nodeCatalog.test.ts` fails on a geometry node
without one.

**Fields that belong to one mode**: give them `showIf: { mode: ["box"] }`
(any param, several values, several params) and the panel hides them while
the node is in another mode. Give a select's options readable
`optionLabels` ("Inside a box", not "box").

**Search synonyms** go in `nodes/nodeKeywords.ts`: what a Blender or Houdini
user would type ("wrangle", "shrinkwrap", "VDB"), and a node's former name
when it is renamed. The palette filter and the node search both match them.

## 4. The socket types

Pick types for `inputs`/`outputs` from exactly these seven — no others exist:

| type       | carries                    | color   |
|------------|-----------------------------|---------|
| `value`    | `number` (also booleans: 0/1) | yellow |
| `vector`   | `THREE.Vector3`             | blue    |
| `matrix`   | `THREE.Matrix4`             | purple  |
| `color`    | `THREE.Color`               | pink    |
| `geometry` | `THREE.Object3D`            | green   |
| `texture`  | `THREE.Texture`             | teal    |
| `list`     | `unknown[]`                 | gray    |
| `music`    | `TrackDescription` (a music track to play, see `docs/music-nodes-mvp.md`) | red |

There is no Boolean or Trigger type. A boolean travels as a `value`
socket carrying `0` or `1` — use `toBoolean`/`fromBoolean` from
`sockets.ts` to convert.

The editor connects two sockets of the same type (or `any`), plus a few
pairs that carry the same thing in two shapes and convert on the wire
(`socketCoercion.ts`) — so every node that deals in points or curves plugs
into every other:

| wire               | the input receives                                   |
|--------------------|------------------------------------------------------|
| `geometry` → `list`  | the mesh's points, as positions (world space)        |
| `list` → `geometry`  | a point-only mesh (a PolyMesh with points, no faces) |
| `curve` → `list`     | a list of one curve                                  |
| `list` → `curve`     | a curve through the positions                        |

That's enforced automatically, you don't need to check it yourself.

**Naming the sockets that carry points and curves** (ids are saved in
files, so they never change once shipped; labels can):
- a list of positions: id `points`, label "Points" — with aligned lists
  `normals` ("Normals") and `scales` ("Scales") when the node has them;
- a mesh: id `geometry`, label "Geometry";
- one curve: type `curve`, id `curve`, label "Curve"; several: type `list`,
  id `curves`, label "Curves". Don't add "(List)" to a label — the socket's
  colour already says it is a list.

## 5. Dynamic input count (rare — skip unless your node explicitly needs it)

Most nodes have a fixed `inputs` list. A few (Merge is the example — see
`merge.ts`) need the number of inputs to grow as the node gets wired up:
one empty socket at first, and wiring it creates a new empty one below it,
forever. That's `dynamicInputs`:

```ts
import { growingSockets } from "../dynamicInputs";

export const MY_NODE: NodeDefinition = {
  // ...
  inputs: [{ id: "in0", label: "In 1", type: "geometry" }],  // the starting state, 0 connections
  dynamicInputs: (connections) =>
    growingSockets(connections, "in", (i) => ({ id: `in${i}`, label: `In ${i + 1}`, type: "geometry" })),
  evaluate: (inputs) => {
    // inputs has whatever keys are currently connected — in0, in1, ... —
    // iterate Object.values(inputs), don't assume a fixed set of keys.
  },
};
```

Only add this if your node's whole point is "however many things get wired
in" (a mixer, a combiner, a fan-in). If it has a known fixed set of inputs,
just use `inputs` normally — don't reach for this.

## 6. `ctx` — what your node knows about "now"

```ts
interface EvalContext {
  time: number;    // seconds since the graph started (deterministic, not wall-clock)
  step: number;     // frame count since start (whole number)
  nodeId: string;    // this specific node instance's id — see §7
}
```

### `pure: true` — skip the node when nothing changed

If your node's outputs depend on **nothing but its params and its inputs**, set
`pure: true` on the definition. A pure node whose params, wiring and upstream are
all unchanged since the last frame is not evaluated again: `evaluateGraph` hands
back its previous outputs. That is what keeps a big, mostly still scene cheap.

Do **not** set it if the node reads `ctx.time` / `ctx.step` / `ctx.currentFrame`
/ `isPlaying` / `scene` / `renderer` / the camera, calls `Math.random()` or the
wall clock, keeps state that changes from frame to frame (springs, triggers,
simulations, input devices), or finishes an async load (font, file, CSV) without
a param changing. Wrongly marked, the node freezes. `evalMemo.test.ts` runs every
demo with the memo on and off and must stay green.

### Heavy one-shot computations — the geometry worker

A node whose evaluate is one big self-contained computation (marching cubes, a
sweep, a CSG) can run it in the geometry worker instead of the frame: see
[docs/offthread-geometry.md](docs/offthread-geometry.md) and `object/metaballs`.
Such a node collects finished results on later frames, so it must **not** be `pure`.

## 7. If your node needs a GPU resource (mesh, texture, render target)

Most nodes don't need this section — skip it unless you're building
something like Object, Particles, or a texture generator.

`evaluate()` runs every frame and must be pure, but a `THREE.Mesh` (say)
needs to be the SAME object every frame, not a fresh one 60 times a
second. Pattern (copy this from `object.ts`):

```ts
const myCache = new Map<string, THREE.Mesh>();

function getOrCreate(nodeId: string): THREE.Mesh {
  const existing = myCache.get(nodeId);
  if (existing) return existing;
  const mesh = new THREE.Mesh(/* ... */);
  myCache.set(nodeId, mesh);
  return mesh;
}
```

Then inside `evaluate`, look it up via `ctx.nodeId`, mutate ITS properties
in place (this is the one place mutation is correct — you own this object,
nothing else does), and return it. Note in a comment that the cache has no
delete-node cleanup yet (known gap, don't try to solve it in your node).

## 8. Register your node

Open `src/shared/graph/nodes/index.ts`. Add your node to `STARTER_NODES`,
and if you made a new file, add an `export * from "./yourfile";` line too.

## 9. Write a test

Open `src/shared/graph/nodes/nodes.test.ts` (or add a new `<file>.test.ts`
next to your node file, same pattern). Use this `CTX`:

```ts
const CTX: EvalContext = { time: 0, step: 0, nodeId: "test" };
```

Test at minimum:
- The normal case with plausible inputs.
- What happens with NO inputs connected (uses `defaultParams` — must not
  throw, must not return `NaN`).
- Any edge case that could divide by zero, index out of range, or produce
  `Infinity`.

Example (copy the shape, change the numbers):

```ts
describe("MY_NODE", () => {
  test("doubles the input", () => {
    expect(MY_NODE.evaluate({ a: 3 }, MY_NODE.defaultParams, CTX).out).toBe(6);
  });

  test("unconnected input falls back to defaultParams", () => {
    expect(MY_NODE.evaluate({}, MY_NODE.defaultParams, CTX).out).toBe(0);
  });
});
```

## 9b. If your node takes geometry in and hands geometry out

Three contracts apply on top of everything above, and
`src/shared/graph/nodeContracts.test.ts` checks all three across the whole
registry — your node is in that sweep whether you read this section or not.

Do not hand-roll them. `emitModifiedMesh()` (object.ts) is the one way a
mesh modifier hands its result back, and it does all three in the right
order — geometry, then material (so a material with a geometry hook prepares
what will be drawn), then pose, then userData:

```ts
if (!state.mesh) state.mesh = createModifierMesh();
return emitModifiedMesh(state.mesh, { inputObj, srcMesh, geometry, nodeId: ctx.nodeId });
```

Pass `geometry` only when you rebuilt it — omit it on a cache hit and the
existing one is kept, which is contract 2 below. A node that owns a pose of
its own (Lattice Deform's cage, Curve Deform) cannot use it, since the pose
is the one thing it does differently; those still call
`preserveModifierUserData()` by hand.

- **Appearance.** A node that isn't about materials passes the source's
  material *by reference*, plus its texture maps, UVs, `userData.pivot` and
  shadow flags. Never `mesh.material = srcMesh.material` by hand — that skips
  the material's own geometry hook, which is how the Worn node came to look
  like it did nothing at all.
- **Identity.** Same inputs in, *the same object* back — not an equal one.
  Downstream caches key on `geometry.uuid` and `mesh.uuid`, so a node that
  mints a fresh `BufferGeometry` every frame silently breaks them. Cache on
  a signature and return the cached mesh.
- **Pose.** Read a source's world matrix with `worldMatrixOf()`, never from
  `matrixWorld` — that value is stale mid-evaluation. Write your output's
  matrix with `matrixAutoUpdate = false`.

Contract 2 is the one nobody guesses, and it used to be the expensive one:
a rigid body's rebuild signature keyed on the source geometry's uuid, so an
identity leak in a *modelling* node froze physics two nodes downstream.
Physics no longer keys on identity, but plenty of other things still do — and
rebuilding a mesh sixty times a second is wasteful even when nothing breaks.

## 10. Mesh nodes: PolyMesh, attributes and groups

A node that reads or builds a mesh works on the **PolyMesh** (`quadMesh.ts`),
not on triangles: n-gon faces over shared vertices, carrying UVs, colours,
material slots, edge marks and **named attributes** per point / edge / face /
corner (`mesh/polyAttributes.ts`). A **group** is a `bool` attribute.

- **Read and write through `mesh/polyIO.ts`** (`readPolyMesh`,
  `polyMeshToGeometry`) — never `geometry.userData.quadMesh` directly: a
  deformer upstream may have cloned the geometry (three shares `userData` on
  clone), and polyIO is what recovers the moved positions, or re-imports
  with the attributes carried over.
- **Prefer `definePolyNode` (`nodes/polyModifier.ts`).** It gives you the
  Group field, caching on the input signature, status notes, and the output
  mesh that inherits pose, material and userData. Your node is a
  `run(ctx) => PolyMesh` function; see `nodes/selectNodes.ts`.
- **Groups in, groups out.** Restrict the effect with `ctx.group(domain)`;
  write groups for what you made (`extrude_top`, `inset_side`…) with
  `setGroup`. Group expressions (`mesh/groupExpr.ts`) accept names, `a b`,
  `a & !b`, wildcards, index ranges and `@P.y>0`.
- **Keep the attributes.** Wrap every topology-changing operation in
  `withAttributes(src, op)` (`mesh/propagate.ts`); return explicit
  `{ point, face }` provenance maps when you know them (deleting or
  reordering always does — see `mesh/subset.ts`).
- Deformers that move a vertex buffer in place get Group / Weight Attribute
  for free through `nodes/deformGroup.ts`.

## 11. Before you say you're done

Run both, from the repo root, and both must be clean:

```bash
npx tsc --noEmit
npx vitest run
```

If either fails, fix it — don't hand back code that doesn't pass these.

## 12. Style rules (project-wide, apply to your node too)

- `camelCase` for variables/functions, `PascalCase` only for types.
- No `any`. Cast with `instanceof` checks or `Number(...)`/`String(...)`,
  like the examples above.
- No comments explaining WHAT the code does — code should read that on
  its own. A comment is only for a non-obvious WHY (a workaround, a
  deliberate tradeoff) — see the comments in `valueMath.ts`/`object.ts`
  for the level of comment this project actually wants.
- Keep the file under ~300 lines. If a category grows past that, split it.
