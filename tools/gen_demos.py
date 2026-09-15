#!/usr/bin/env python3
"""Generate Tsuji demo .tsuji graphs: shared setup nodes + per-demo subject nodes."""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMOS = os.path.join(ROOT, "public/demos")

BLUE, PINK, MID = 0x38BDF8, 0xEC4899, 0x8B5CF6
CYAN, WARM = 0x06B6D4, 0xFFDC6E


def setup_blocks():
    """The shared setup's nodes+connections, re-keyed with a `setup_` prefix."""
    with open(os.path.join(DEMOS, "setup.tsuji")) as f:
        data = json.load(f)
    canvas = data["canvases"][data.get("activeCanvas", 0)]
    remap = {n["id"]: f"setup_{i}" for i, n in enumerate(canvas["nodes"])}
    nodes = [{**n, "id": remap[n["id"]]} for n in canvas["nodes"]]
    conns = [
        {**c, "id": f"setup_c{i}", "fromNode": remap[c["fromNode"]], "toNode": remap[c["toNode"]]}
        for i, c in enumerate(canvas["connections"])
    ]
    return nodes, conns


def setup_id(node_type):
    """The setup's node of this type, by its re-keyed id (post-processing wires into Render)."""
    nodes, _ = setup_blocks()
    for n in nodes:
        if n["type"] == node_type:
            return n["id"]
    raise KeyError(node_type)


RENDER = setup_id("render")


def v3(x=0.0, y=0.0, z=0.0):
    return {"x": x, "y": y, "z": z}


def node(nid, ntype, px, py, **params):
    return {"id": nid, "type": ntype, "position": {"x": px, "y": py}, "params": params}


def wire(a, sa, b, sb):
    return {"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb}


def write_demo(name, nodes, conns, markers=None, extra_canvas=None, setup_overrides=None):
    """setup_overrides maps a setup node type to params merged into it — for
    the rare demo whose subject the stock setup actively hides (a Light Probe's
    coloured bounce cannot be seen under three white key lights)."""
    base_nodes, base_conns = setup_blocks()
    if setup_overrides:
        base_nodes = [
            {**n, "params": {**n["params"], **setup_overrides[n["type"]]}} if n["type"] in setup_overrides else n
            for n in base_nodes
        ]
    canvas = {
        "nodes": base_nodes + nodes,
        "connections": base_conns + conns,
        "keyframes": {},
        "markers": markers or [],
        "exposedParams": [],
    }
    empty = lambda: {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []}
    canvases = [canvas] + [empty() for _ in range(5)]
    if extra_canvas:
        canvases[1] = {**empty(), **extra_canvas}
    path = os.path.join(DEMOS, f"demo_{name}.tsuji")
    with open(path, "w") as f:
        json.dump({"canvases": canvases, "activeCanvas": 0}, f, indent=2)
        f.write("\n")
    print(f"  wrote demo_{name}.tsuji  ({len(nodes)} subject nodes)")


DEMOS_SPEC = {}


def demo(name):
    def deco(fn):
        DEMOS_SPEC[name] = fn
        return fn
    return deco


# ---------------------------------------------------------------- Objects

@demo("object_primitives")
def _():
    n = [
        node("cyl", "object/cylinder", -900, 40, location=v3(-2.2, 0.5, 0), scale=v3(0.7, 1, 0.7), color=BLUE, roughness=0.25, metalness=0.3),
        node("cone", "object/cone", -900, 240, location=v3(0, 0.5, 0), scale=v3(0.9, 1.2, 0.9), color=MID, roughness=0.25, metalness=0.3),
        node("disc", "object/disc", -900, 440, location=v3(2.2, 0.5, 0), rotation=v3(1.5708, 0, 0), radius=0.8, innerRadius=0.35, depth=0.25, color=PINK, roughness=0.2, metalness=0.4),
        node("merge", "structure/merge", -560, 240),
    ]
    c = [wire(s, "geometry", "merge", f"in{i}") for i, s in enumerate(["cyl", "cone", "disc"])]
    return n, c


# object_text: hand-authored in the app (see public/demos/demo_object_text.tsuji),
# not generated — same arrangement as squash_stretch_bounce and demo_trail.


@demo("object_empty_lookat")
def _():
    n = [
        node("orbit", "transform/orbit", -1080, 60, radius=2.6, speed=40, height=1.1),
        node("empty", "object/empty", -820, 60),
        node("cone", "object/cone", -1080, 300, location=v3(0, 0.6, 0), scale=v3(0.5, 1.1, 0.5), color=PINK, roughness=0.25, metalness=0.35),
        node("aim", "transform/look-at", -560, 220),
    ]
    c = [
        wire("orbit", "matrix", "empty", "matrix"),
        wire("cone", "geometry", "aim", "geometry"),
        wire("empty", "geometry", "aim", "target"),
    ]
    return n, c


# -------------------------------------------------------------- Modifiers

@demo("modifier_boolean")
def _():
    n = [
        node("box", "object/box", -900, 60, location=v3(0, 0.9, 0), scale=v3(1.6, 1.6, 1.6), color=BLUE, roughness=0.2, metalness=0.35),
        node("cut", "object/sphere", -900, 300, location=v3(0.6, 1.4, 0.6), scale=v3(1.1, 1.1, 1.1), color=PINK),
        node("bool", "modifier/boolean", -560, 160, operation="subtract"),
    ]
    c = [wire("box", "geometry", "bool", "geometry"), wire("cut", "geometry", "bool", "boolean")]
    return n, c


@demo("modifier_subdivide_shade")
def _():
    n = [
        node("ico", "object/cone", -1080, 120, location=v3(0, 0.9, 0), scale=v3(1.3, 1.6, 1.3), color=MID, roughness=0.25, metalness=0.4),
        node("sub", "modifier/subdivide", -800, 120, mode="catmull-clark", levels=2),
        node("shade", "modifier/shade", -540, 120, mode="auto", autoAngle=40),
    ]
    c = [wire("ico", "geometry", "sub", "geometry"), wire("sub", "geometry", "shade", "geometry")]
    return n, c


@demo("modifier_lattice")
def _():
    # Reworked by hand in the app, then ported back here — a box reads the
    # twist far better than a sphere (its edges show the shear), and driving
    # `twist` from an oscillator makes the deformation legible without
    # touching a parameter.
    n = [
        node("box", "object/box", -1114, 133, location=v3(0, 1.025, 0), scale=v3(1, 1, 1), color=0xFFFFFF, roughness=0.4, metalness=0.1),
        node("swing", "animation/oscillator", -1113, 336, type="sine", frequency=1, phase=0, amplitude=49.125, offset=0),
        node("cage", "modifier/lattice", -660, 120, location=v3(0, 1.1, 0), scale=v3(1, 0.7, 1),
             sizeX=2.6, sizeY=2.6, sizeZ=2.6, twist=-46, bulge=0.45, strength=1, showCage=True, pointsList=[]),
    ]
    c = [
        wire("box", "geometry", "cage", "geometry"),
        wire("swing", "out", "cage", "twist"),
    ]
    return n, c


@demo("modifier_clipping")
def _():
    n = [
        node("ball", "object/sphere", -1000, 120, location=v3(0, 1.1, 0), scale=v3(1.5, 1.5, 1.5), color=PINK, roughness=0.2, metalness=0.4),
        node("clip", "modifier/clip-box", -660, 120, location=v3(0, 1.1, 0), size=v3(2.2, 2.2, 1.4), clipMode="inside"),
    ]
    return n, [wire("ball", "geometry", "clip", "geometry")]


# ----------------------------------------------------------- Particles

@demo("particles_basic")
def _():
    n = [
        node("emit", "particles/emitter", -1080, 60, position=v3(0, 0.4, 0), velocity=v3(0, 3.2, 0), spawnRate=400, diameter=0.35),
        node("sim", "particles/simulate", -800, 60, gravity=3.4, lifetime=2.6, lifetimeVariance=35, count=2048),
        node("draw", "particles/render", -520, 60, size=5, color=CYAN, sprite="circle", fadeOpacity=True, fadeSize=True),
    ]
    c = [
        wire("emit", "emitter", "sim", "emitter"),
        wire("sim", "positions", "draw", "positions"),
        wire("sim", "count", "draw", "count"),
        wire("sim", "lifetime", "draw", "lifetime"),
    ]
    return n, c


@demo("particles_surface")
def _():
    n = [
        node("src", "object/sphere", -1320, 300, location=v3(0, 1.2, 0), scale=v3(1.2, 1.2, 1.2), visible=0),
        node("emit", "particles/emitter-from-surface", -1060, 300, spawnRate=300, points=400, velocity=v3(0, 0.6, 0)),
        node("pull", "particles/force-field", -1060, 60, fieldType="vortex", position=v3(0, 1.2, 0), axis=v3(0, 1, 0), strength=4, radius=6),
        node("floor", "particles/ground", -1060, 500, enabled=1, height=0, bounce=0.35, friction=0.85),
        node("sim", "particles/simulate", -760, 300, gravity=2.2, lifetime=3.2, lifetimeVariance=30, count=1024),
        node("shape", "object/box", -760, 560, scale=v3(1, 1, 1), color=PINK, emissive=PINK, emissiveIntensity=0.25, visible=0),
        node("draw", "particles/render-instances", -460, 300, instanceScale=0.07, color=PINK, roughness=0.25, metalness=0.4),
    ]
    c = [
        wire("src", "geometry", "emit", "geometry"),
        wire("emit", "emitter", "sim", "emitter"),
        wire("pull", "field", "sim", "field0"),
        wire("floor", "ground", "sim", "ground"),
        wire("sim", "positions", "draw", "positions"),
        wire("sim", "count", "draw", "count"),
        wire("sim", "lifetime", "draw", "lifetime"),
        wire("shape", "geometry", "draw", "shape"),
    ]
    return n, c


@demo("particles_trails")
def _():
    n = [
        node("emit", "particles/emitter", -1160, 60, position=v3(0, 1.4, 0), velocity=v3(0, 1.6, 0), spawnRate=90, diameter=1.1),
        node("swirl", "particles/force-field", -1160, 300, fieldType="vortex", position=v3(0, 1.2, 0), axis=v3(0, 1, 0), strength=5, radius=5),
        # 512, not the 4096 default: capture-trails and connect-nearby each
        # read the position texture back from the GPU every frame.
        node("sim", "particles/simulate", -860, 160, gravity=0.4, lifetime=4, count=512),
        node("trails", "particles/capture-trails", -560, 60, historyLength=48, color=CYAN, linewidth=1.6, fadeAlongTrail=True),
        node("web", "particles/connect-nearby", -560, 300, maxDistance=1.1, maxConnections=4, color=PINK),
    ]
    c = [
        wire("emit", "emitter", "sim", "emitter"),
        wire("swirl", "field", "sim", "field0"),
        wire("sim", "positions", "trails", "positions"),
        wire("sim", "count", "trails", "count"),
        wire("sim", "positions", "web", "positions"),
        wire("sim", "count", "web", "count"),
    ]
    return n, c


# ------------------------------------------------------------- Textures

@demo("texture_procedural")
def _():
    n = [
        node("noise", "texture/procedural", -1240, 60, type="voronoi", colorA=BLUE, colorB=PINK, scale=5, resolution=512),
        node("rings", "texture/procedural", -1240, 300, type="rings", colorA=PINK, colorB=0x101820, scale=6, resolution=512),
        node("mix", "texture/mix", -960, 160, blendMode="mix", factor=0.45),
        node("warp", "texture/transform", -700, 160, rotation=0.5, scale=v3(2, 2, 1)),
        node("bump", "texture/to_normal", -700, 380),
        node("ball", "object/sphere", -420, 160, location=v3(0, 1.2, 0), scale=v3(1.4, 1.4, 1.4), roughness=0.35, metalness=0.3),
    ]
    c = [
        wire("noise", "texture", "mix", "textureA"),
        wire("rings", "texture", "mix", "textureB"),
        wire("mix", "texture", "warp", "texture"),
        wire("mix", "texture", "bump", "texture"),
        wire("warp", "texture", "ball", "texture"),
        wire("bump", "normal", "ball", "normal"),
    ]
    return n, c


@demo("texture_to_geometry")
def _():
    n = [
        node("pattern", "texture/procedural", -1120, 120, type="rings", colorA=BLUE, colorB=PINK, scale=4, resolution=128),
        # No visible:0 here — pixel-spawner *owns* its geometry input, so it
        # clones this template; hiding it would hide every clone too.
        node("cube", "object/box", -1120, 360, scale=v3(1, 1, 1), color=BLUE, roughness=0.25, metalness=0.4),
        # instanceScale multiplies the *cell* size (gridWidth / maxResolution),
        # it is not an absolute scale — at 48px and 0.16 the cubes came out
        # 0.017 units wide and were invisible. xz lays the grid on the floor.
        node("spawner", "texture/pixel-spawner", -800, 200, density=50, gridWidth=5, gridHeight=5, orientation="xz", instanceScale=1, maxResolution=24),
    ]
    c = [
        wire("pattern", "texture", "spawner", "texture"),
        wire("cube", "geometry", "spawner", "geometry"),
    ]
    return n, c


@demo("texture_decal_wall")
def _():
    # A decal is not a texture on a material — it is real geometry, clipped
    # out of whatever surfaces sit inside the projector box. This demo is
    # built to make that difference impossible to miss.
    #
    # The wall is not a wall: it is 27 separate cubes. One projector paints a
    # single graffiti across all of them at once, and because the image is
    # cut in world space rather than mapped per-object, it stays hanging
    # where it is while the cubes move *through* it. Driving the grid spacing
    # from an oscillator opens and closes the wall once per loop: shut, every
    # cube carries its own slice and the picture reads whole; open, the
    # picture tears into fragments and the outermost cubes leave the
    # projector box entirely, coming out blank (27 cubes carry a piece shut,
    # 15 open). A texture map could not do
    # any of that — each cube would simply wear its own copy.
    #
    # No texture is wired: an unwired Decal falls back to the bundled
    # graffiti (public/img/decal_default.png), which is exactly the kind of
    # image this needs — recognisable enough that breaking it apart reads.
    #
    # Wide and low on purpose: 9x3 around y = 1.25 keeps the whole mural
    # inside the default camera's frame — a taller wall put the row carrying
    # most of the image off the top edge — and never dips through the setup's
    # floor (y = 0.11 at the widest spacing, floor at -0.5). The projector is sized
    # to the CLOSED wall, not the open one — that is what makes the outer
    # cubes leave the picture as it spreads, rather than the image simply
    # stretching with them.
    n = [
        node("cube", "object/box", -1200, 300, location=v3(0, 1.25, 0), scale=v3(0.52, 0.52, 0.52),
             color=0xE2E4E9, roughness=0.35, metalness=0.15),
        # 0.70 +/- 0.18 -> 0.52 (shut: cube width, so they touch exactly)
        # .. 0.88 (open), one cycle per 120-frame loop at 30fps.
        node("breathe", "animation/oscillator", -1200, 60, type="sine", frequency=0.25,
             phase=0, amplitude=0.18, offset=0.70),
        node("wall", "structure/array", -900, 180, mode="grid", plane="XY",
             gridCols=9, gridRows=3, centerGrid=True, visible=1),
        # `geometry` is NOT an owning input here, so the cubes keep rendering
        # and the decal is drawn on top of them rather than replacing them.
        node("paint", "object/decal", -600, 180, location=v3(0, 1.25, 0),
             scale=v3(4.6, 1.9, 4), opacity=1, roughness=0.5, metalness=0),
    ]
    c = [
        wire("cube", "geometry", "wall", "geometry"),
        wire("breathe", "out", "wall", "spacingX"),
        wire("breathe", "out", "wall", "spacingY"),
        wire("wall", "geometry", "paint", "geometry"),
    ]
    return n, c


# ------------------------------------------------------------- Dataviz

@demo("chart_bar")
def _():
    n = [
        node("vals", "list/random-list", -1200, 120, count=9, seed=7, min=0.15, max=1.0),
        node("stats", "list/statistics", -940, 320),
        node("palette", "list/color-palette", -1200, 340, count=9),
        node("bars", "object/bar_graph", -660, 120, location=v3(0, 0, 0), count=9, spacing=0.15, barWidth=0.45, barDepth=0.45, maxHeight=2.6, metalness=0.35, roughness=0.25),
        node("axis", "object/chart_axis", -660, 400, location=v3(0, 0, -0.6), min=0, max=1, step=0.25, maxHeight=2.6, width=4.6),
    ]
    c = [
        wire("vals", "list", "bars", "values"),
        wire("vals", "list", "stats", "list"),
        wire("palette", "list", "bars", "colors"),
        wire("stats", "max", "axis", "max"),
    ]
    return n, c


@demo("chart_pie")
def _():
    n = [
        node("vals", "list/random-list", -1060, 120, count=6, seed=3, min=0.2, max=1.0),
        node("palette", "list/color-palette", -1060, 340, count=6),
        node("pie", "object/pie_chart", -720, 200, location=v3(0, 0.15, 0), rotation=v3(-1.5708, 0, 0), radius=1.8, innerRadius=0.7, depth=0.3, gapDegrees=2, metalness=0.35, roughness=0.25),
    ]
    c = [wire("vals", "list", "pie", "values"), wire("palette", "list", "pie", "colors")]
    return n, c


@demo("chart_scatter")
def _():
    n = [
        node("xs", "list/random-list", -1240, 40, count=60, seed=11, min=-2.2, max=2.2),
        node("ys", "list/random-list", -1240, 220, count=60, seed=29, min=0.2, max=2.6),
        node("zs", "list/random-list", -1240, 400, count=60, seed=47, min=-2.2, max=2.2),
        node("palette", "list/color-palette", -1240, 580, count=60),
        node("cloud", "object/scatter_plot", -820, 220, markerSize=0.11, metalness=0.4, roughness=0.2),
    ]
    c = [
        wire("xs", "list", "cloud", "xValues"),
        wire("ys", "list", "cloud", "yValues"),
        wire("zs", "list", "cloud", "zValues"),
        wire("palette", "list", "cloud", "colors"),
    ]
    return n, c


@demo("chart_line")
def _():
    n = [
        node("vals", "list/random-list", -1060, 120, count=14, seed=5, min=0.1, max=1.0),
        node("palette", "list/color-palette", -1060, 340, count=14),
        node("graph", "object/line_graph", -720, 200, location=v3(0, 0, 0), count=14, spacing=0.32, maxHeight=2.4, lineWidth=0.06, showPoints=1, pointSize=0.09, smooth=1),
    ]
    c = [wire("vals", "list", "graph", "values"), wire("palette", "list", "graph", "colors")]
    return n, c


# --------------------------------------------------------------- Lists

@demo("list_basics")
def _():
    n = [
        node("seq", "list/generate", -1300, 120, count=12, start=0.2, step=0.16),
        node("cut", "list/slice", -1040, 120, start=2, count=8),
        node("len", "list/length", -1040, 340),
        node("pick", "list/get-item", -1040, 500, index=3),
        node("look", "io/inspector", -780, 420),
        node("bars", "object/bar_graph", -720, 120, count=8, spacing=0.2, barWidth=0.5, barDepth=0.5, maxHeight=2.4, color=BLUE, metalness=0.35, roughness=0.25),
    ]
    c = [
        wire("seq", "list", "cut", "list"),
        wire("seq", "list", "len", "list"),
        wire("seq", "list", "pick", "list"),
        wire("pick", "val", "look", "input"),
        wire("cut", "list", "bars", "values"),
    ]
    return n, c


@demo("list_vectors")
def _():
    n = [
        node("xs", "list/random-list", -1320, 40, count=40, seed=2, min=-2.4, max=2.4),
        node("ys", "list/random-list", -1320, 220, count=40, seed=13, min=0.3, max=2.4),
        node("zs", "list/random-list", -1320, 400, count=40, seed=23, min=-2.4, max=2.4),
        node("pack", "list/combine-vectors", -1020, 220),
        node("unpack", "list/split-vectors", -780, 220),
        node("cloud", "object/point_cloud", -520, 220, pointSize=0.12, color=PINK),
    ]
    c = [
        wire("xs", "list", "pack", "xList"),
        wire("ys", "list", "pack", "yList"),
        wire("zs", "list", "pack", "zList"),
        wire("pack", "vectorList", "unpack", "vectorList"),
        wire("unpack", "xList", "cloud", "xValues"),
        wire("unpack", "yList", "cloud", "yValues"),
        wire("unpack", "zList", "cloud", "zValues"),
    ]
    return n, c


# ---------------------------------------------------------------- Math

@demo("math_wiggle")
def _():
    n = [
        node("wig", "animation/wiggle", -1000, 60, speed=0.7, amplitudeVector=v3(1.4, 0.5, 1.4), rotationAmplitude=v3(30, 60, 30), scaleAmplitude=v3(0.2, 0.2, 0.2), seed=4),
        node("box", "object/box", -1000, 320, location=v3(0, 1.2, 0), scale=v3(0.9, 0.9, 0.9), color=BLUE, roughness=0.2, metalness=0.4),
    ]
    return n, [wire("wig", "matrix", "box", "matrix")]


@demo("math_random")
def _():
    # A random *list*, not transform/random-matrix: that node yields a single
    # matrix, and Set Instance Transform reads `matrices` positionally, so
    # with index -1 only instance 0 ever moved and the rest sat at identity.
    # One value per instance is what per-instance randomness actually needs.
    n = [
        node("box", "object/box", -1320, 300, scale=v3(0.62, 1, 0.62), color=0xFFFFFF, roughness=0.3, metalness=0.35),
        node("grid", "structure/array", -1080, 300, mode="grid", plane="XZ", gridCols=7, gridRows=7, spacingX=0.85, spacingY=0.85, centerGrid=True),
        node("heights", "list/random-list", -1080, 60, count=49, seed=12, algorithm="noise", min=0.15, max=2.4),
        # The gradient node reads any value list, not just distances — so the
        # same list that sets each tower's height also picks its colour.
        node("tint", "list/distance-gradient", -800, 60, radius=2.4, power=1),
        # Scaling Y happens about each box's centre, so a tower of height h
        # would sink h/2 under the floor. Lift each by half its own height
        # (the box is 1 unit tall and already resting on the plane).
        node("lift", "list/math", -800, 240, op="multiply", b=0.5, factor=1, offset=-0.5),
        node("place", "structure/instance-transform", -540, 300, mode="relative", pivot="individual", index=-1),
        node("paint", "structure/instance-color", -280, 300, index=-1),
    ]
    c = [
        wire("box", "geometry", "grid", "geometry"),
        wire("grid", "geometry", "place", "geometry"),
        wire("heights", "list", "place", "scaleY"),
        wire("heights", "list", "lift", "a"),
        wire("lift", "list", "place", "posY"),
        wire("heights", "list", "tint", "distances"),
        wire("place", "geometry", "paint", "geometry"),
        wire("tint", "list", "paint", "colors"),
    ]
    return n, c


@demo("math_ramp_color")
def _():
    n = [
        node("osc", "animation/oscillator", -1300, 120, type="sine", frequency=0.25, amplitude=1, offset=0),
        node("ramp", "value/map-range", -1040, 120, inMin=-1, inMax=1, outMin=0.15, outMax=1, clamp=1),
        node("hold", "value/clamp", -800, 120, min=0.2, max=0.95),
        node("hue", "color/compose", -800, 320),
        node("tint", "color/math", -560, 220, op="mix"),
        node("base", "color/constant", -1040, 400, color=BLUE),
        node("mat", "material/standard", -320, 220, roughness=0.2, metalness=0.4),
        node("ball", "object/sphere", -80, 220, location=v3(0, 1.2, 0), scale=v3(1.2, 1.2, 1.2)),
    ]
    c = [
        wire("osc", "out", "ramp", "value"),
        wire("ramp", "out", "hold", "value"),
        wire("hold", "out", "hue", "r"),
        wire("base", "out", "tint", "a"),
        wire("hue", "out", "tint", "b"),
        wire("hold", "out", "tint", "factor"),
        wire("tint", "out", "mat", "color"),
        wire("mat", "material", "ball", "material"),
    ]
    return n, c


@demo("math_proximity")
def _():
    n = [
        node("box", "object/box", -1300, 320, scale=v3(0.4, 0.4, 0.4), color=BLUE, roughness=0.25, metalness=0.4),
        node("grid", "structure/array", -1060, 320, mode="grid", plane="XZ", gridCols=7, gridRows=7, spacingX=0.8, spacingY=0.8, centerGrid=True),
        node("orbit", "transform/orbit", -1300, 60, radius=2.2, speed=50, height=1.4),
        node("probe", "object/sphere", -1060, 60, scale=v3(0.35, 0.35, 0.35), color=PINK, emissive=PINK, emissiveIntensity=0.6),
        node("near", "object/proximity", -760, 180, ignoreSelf=True),
        node("dists", "math/distances", -760, 420),
        node("glow", "list/distance-gradient", -520, 420, radius=2.4, power=1.5),
        node("tint", "structure/instance-color", -280, 320, index=-1),
    ]
    c = [
        wire("box", "geometry", "grid", "geometry"),
        wire("orbit", "matrix", "probe", "matrix"),
        wire("probe", "geometry", "near", "target"),
        wire("grid", "geometry", "near", "candidates"),
        wire("grid", "geometry", "dists", "instances"),
        wire("probe", "geometry", "dists", "target"),
        wire("dists", "distances", "glow", "distances"),
        wire("grid", "geometry", "tint", "geometry"),
        wire("glow", "list", "tint", "colors"),
    ]
    return n, c


# -------------------------------------------------------------- Curves

@demo("curve_follow_path")
def _():
    n = [
        node("path", "curve/primitive", -1200, 120, primitiveType="helix", radius=1.8, height=2.6, turns=3, location=v3(0, 0.4, 0)),
        node("line", "curve/to_line", -940, 320, linewidth=2.5, color=CYAN),
        node("t", "animation/oscillator", -1200, 380, type="saw", frequency=0.2, amplitude=0.5, offset=0.5),
        node("rider", "curve/sample", -940, 120),
        node("cone", "object/cone", -700, 120, scale=v3(0.28, 0.5, 0.28), color=PINK, roughness=0.25, metalness=0.4),
    ]
    c = [
        wire("path", "curve", "line", "curve"),
        wire("path", "curve", "rider", "curve"),
        wire("t", "out", "rider", "progress"),
        wire("rider", "matrix", "cone", "matrix"),
    ]
    return n, c


@demo("curve_deform")
def _():
    n = [
        node("path", "curve/primitive", -1160, 120, primitiveType="wave", radius=2.4, height=1.2, turns=2, location=v3(0, 1.1, 0), visible=0),
        node("bar", "object/cylinder", -1160, 340, scale=v3(0.35, 2.4, 0.35), color=MID, roughness=0.2, metalness=0.45),
        node("bend", "curve/deform", -820, 220, axis="y", stretch=1, progress=0),
    ]
    c = [wire("bar", "geometry", "bend", "geometry"), wire("path", "curve", "bend", "curve")]
    return n, c


@demo("curve_array")
def _():
    n = [
        node("ring", "curve/primitive", -1120, 120, primitiveType="circle", radius=1.6, location=v3(0, 0.6, 0), visible=0),
        node("stack", "curve/array", -840, 120, count=9, spacing=0.22, start=0, step=0.06),
        node("lines", "curve/to_line_list", -560, 120, linewidth=2, color=BLUE),
    ]
    c = [wire("ring", "curve", "stack", "curve"), wire("stack", "curves", "lines", "curves")]
    return n, c


# ------------------------------------------------------------ Physics

@demo("physics_scatter")
def _():
    n = [
        node("host", "object/sphere", -1320, 120, location=v3(0, 1.3, 0), scale=v3(1.4, 1.4, 1.4), color=0x1c2530, roughness=0.5, metalness=0.2),
        node("pts", "physics/sample", -1060, 120, count=90, seed=8),
        node("split", "list/split-vectors", -800, 120),
        node("seed_obj", "object/cone", -1060, 400, scale=v3(0.16, 0.32, 0.16), color=PINK, roughness=0.25, metalness=0.4),
        node("scatter", "structure/spawn", -520, 200, count=90, seed=8, scaleMin=0.7, scaleMax=1.3, alignToNormal=1),
    ]
    c = [
        wire("host", "geometry", "pts", "geometry"),
        wire("pts", "points", "split", "vectorList"),
        wire("host", "geometry", "scatter", "support"),
        wire("seed_obj", "geometry", "scatter", "items"),
        wire("split", "xList", "scatter", "xValues"),
        wire("split", "yList", "scatter", "yValues"),
        wire("split", "zList", "scatter", "zValues"),
    ]
    return n, c


@demo("physics_rolling")
def _():
    # A square prism tumbling as it rolls: the Rolling node turns a horizontal
    # drag into a rotation AND a bob — the cube's centre rises to its
    # circumradius at the diagonal and settles back onto each face, so it
    # visibly rolls instead of grinding along one side. A triangle wave gives
    # constant speed; when it turns around, the cube un-rolls back.
    n = [
        node("swing", "animation/oscillator", -1180, 60, type="triangle", frequency=0.12, amplitude=3, offset=0),
        node("move", "vector/compose", -940, 60, y=1),
        # size is the square's *side* — no radius to work out by hand.
        node("roll", "physics/rolling", -680, 60, shape="square", size=2),
        node("matrix", "transform", -420, 60),
        node("cube", "object/box", -160, 60, scale=v3(2, 2, 2), color=BLUE, roughness=0.2, metalness=0.4),
    ]
    c = [
        wire("swing", "out", "move", "x"),
        wire("move", "out", "roll", "position"),
        wire("roll", "position", "matrix", "location"),
        wire("roll", "rotation", "matrix", "rotation"),
        wire("matrix", "matrix", "cube", "matrix"),
    ]
    return n, c


# ------------------------------------------------------------- Lights

@demo("lighting_lights")
def _():
    n = [
        node("ball", "object/sphere", -1180, 320, location=v3(0, 1.1, 0), scale=v3(1.1, 1.1, 1.1), color=0xdddddd, roughness=0.35, metalness=0.2),
        node("amb", "light/ambient", -1180, 60, color=BLUE, intensity=0.25),
        node("sun", "light/directional", -940, 60, color=WARM, intensity=1.6, location=v3(4, 6, 3), castShadow=1),
        node("spot", "light/spot", -700, 60, color=PINK, intensity=40, angle=32, penumbra=0.5, location=v3(-3, 4.5, 2.5), castShadow=1),
        node("orbit", "transform/orbit", -700, 320, radius=3, speed=35, height=2),
        node("moving", "light/point", -460, 320, color=CYAN, intensity=25, distance=10, decay=2),
    ]
    c = [
        wire("ball", "geometry", "spot", "target"),
        wire("orbit", "matrix", "moving", "matrix"),
    ]
    return n, c


# ------------------------------------------------------ Logic & Interaction

@demo("logic_keyboard")
def _():
    n = [
        node("key", "io/keyboard", -1280, 120, key="space"),
        node("flip", "logic/toggle", -1040, 120),
        node("osc", "animation/oscillator", -1280, 340, type="sine", frequency=0.6, amplitude=1.2, offset=1.4),
        node("gate", "logic/gate", -800, 220),
        node("ball", "object/sphere", -1040, 480, location=v3(0, 1.2, 0), scale=v3(0.8, 0.8, 0.8), color=CYAN, emissive=CYAN, emissiveIntensity=0.3, roughness=0.2, metalness=0.4),
        node("cube", "object/box", -800, 480, location=v3(0, 1.2, 0), scale=v3(1.1, 1.1, 1.1), color=PINK, roughness=0.2, metalness=0.4),
        node("pick", "logic/bridge", -520, 360),
    ]
    c = [
        wire("key", "pressed", "flip", "trigger"),
        wire("osc", "out", "gate", "value"),
        wire("flip", "out", "gate", "enable"),
        wire("flip", "out", "pick", "condition"),
        wire("ball", "geometry", "pick", "ifTrue"),
        wire("cube", "geometry", "pick", "ifFalse"),
    ]
    return n, c


@demo("logic_compare")
def _():
    n = [
        node("osc", "animation/oscillator", -1280, 120, type="sine", frequency=0.4, amplitude=1, offset=0),
        node("test", "logic/compare", -1040, 120, op=">", b=0),
        node("edge", "logic/trigger", -800, 120),
        node("env", "animation/envelope", -560, 120, attack=0.08, release=0.9),
        node("pulse", "time/pulse", -560, 340, decay=1.6),
        node("mat", "material/standard", -300, 220, color=PINK, emissive=PINK, roughness=0.2, metalness=0.4),
        node("ball", "object/sphere", -60, 220, location=v3(0, 1.2, 0), scale=v3(1, 1, 1)),
    ]
    c = [
        wire("osc", "out", "test", "a"),
        wire("test", "out", "edge", "in"),
        wire("edge", "trigger", "env", "trigger"),
        wire("edge", "trigger", "pulse", "trigger"),
        wire("env", "out", "mat", "emissiveIntensity"),
        wire("mat", "material", "ball", "material"),
    ]
    return n, c


# ------------------------------------------------------------- HUD & Time

@demo("hud_text")
def _():
    n = [
        node("clock", "time", -1180, 120),
        node("fmt", "converter/value-to-text", -940, 120, decimals=1, prefix="t = ", suffix=" s"),
        node("label", "hub/text", -700, 120, x=120, y=90, fontSize=44, scale=1, enterAnimation="fade"),
        node("ball", "object/sphere", -700, 380, location=v3(0, 1.1, 0), scale=v3(1, 1, 1), color=BLUE, roughness=0.25, metalness=0.4),
    ]
    c = [wire("clock", "seconds", "fmt", "value"), wire("fmt", "text", "label", "text")]
    return n, c


@demo("time_remap")
def _():
    n = [
        node("clock", "time", -1240, 120),
        node("frame", "time/frame", -1240, 340),
        node("loop", "time/remap", -1000, 120, inStart=0, inEnd=4, outStart=0, outEnd=360, ease="smooth", loop=1),
        node("box", "object/box", -760, 220, location=v3(0, 1.1, 0), scale=v3(1.1, 1.1, 1.1), color=MID, roughness=0.2, metalness=0.4),
        node("spin", "structure/geometry-transform", -520, 220, mode="relative"),
    ]
    c = [
        wire("clock", "seconds", "loop", "time"),
        wire("box", "geometry", "spin", "geometry"),
        wire("loop", "time", "spin", "rotY"),
    ]
    return n, c


# ---------------------------------------------------------- Post-Process

@demo("post_stylize")
def _():
    n = [
        node("ball", "object/sphere", -1180, 320, location=v3(0, 1.2, 0), scale=v3(1.3, 1.3, 1.3), color=BLUE, emissive=BLUE, emissiveIntensity=0.5, roughness=0.2, metalness=0.5),
        node("vig", "postprocess/vignette", -1180, 60, offset=1.1, darkness=1.3),
        node("shift", "postprocess/rgb-shift", -940, 60, amount=0.0022, angle=0.6),
        node("grain", "postprocess/film-grain", -700, 60, noiseIntensity=0.45, scanlinesIntensity=0.25, scanlinesCount=700),
        node("grade", "postprocess/color-correction", -460, 60, brightness=0.02, contrast=1.12, saturation=1.25),
    ]
    c = [
        wire("vig", "effect", "shift", "effect"),
        wire("shift", "effect", "grain", "effect"),
        wire("grain", "effect", "grade", "effect"),
        wire("grade", "effect", RENDER, "postprocess"),
    ]
    return n, c


@demo("post_outline")
def _():
    n = [
        node("ball", "object/sphere", -1180, 320, location=v3(0, 1.2, 0), scale=v3(1.2, 1.2, 1.2), color=0x1a2230, roughness=0.4, metalness=0.3),
        node("edge", "postprocess/outline", -880, 120, edgeColor=PINK, edgeStrength=6, edgeThickness=2),
        node("pix", "postprocess/kaleidoscope", -880, 380, sides=6, angle=0),
    ]
    c = [
        wire("ball", "geometry", "edge", "geometry"),
        wire("edge", "effect", RENDER, "postprocess"),
    ]
    return n, c


@demo("sound_reactive")
def _():
    n = [
        # enable: 0 on purpose — loading a demo must not fire a microphone
        # permission prompt. Flip Enable Mic in the panel to run it.
        node("mic", "sound/microphone", -1240, 120, enable=0, gain=1.4),
        node("fft", "sound/spectrum", -980, 120, bins=24, smoothing=0.75),
        node("peak", "sound/peak-detector", -980, 360, threshold=0.35, decay=0.85),
        node("palette", "list/color-palette", -980, 540, count=24),
        node("bars", "object/bar_graph", -640, 220, count=24, spacing=0.06, barWidth=0.16, barDepth=0.16, maxHeight=2.6, metalness=0.35, roughness=0.25),
    ]
    c = [
        wire("mic", "audio", "fft", "audio"),
        wire("fft", "volume", "peak", "volume"),
        wire("fft", "spectrum", "bars", "values"),
        wire("palette", "list", "bars", "colors"),
    ]
    return n, c


@demo("points_roundtrip")
def _():
    n = [
        # visible: 0 — mesh-to-points doesn't take ownership, so the source
        # would otherwise render on top of the rebuilt copy and z-fight.
        node("src", "object/sphere", -1300, 120, location=v3(0, 1.2, 0), scale=v3(1.3, 1.3, 1.3), visible=0),
        node("pts", "converter/mesh-to-points", -1040, 120),
        node("shake", "vector/wiggle-vector", -800, 120, speed=0.5, amplitude=v3(0.12, 0.12, 0.12), seed=3),
        node("back", "converter/points-to-mesh", -540, 120),
        node("split", "list/split-vectors", -800, 380),
        node("cloud", "object/point_cloud", -540, 380, pointSize=0.045, color=CYAN),
    ]
    c = [
        wire("src", "geometry", "pts", "geometry"),
        wire("pts", "points", "shake", "points"),
        wire("src", "geometry", "back", "geometry"),
        wire("shake", "points", "back", "points"),
        wire("shake", "points", "split", "vectorList"),
        wire("split", "xList", "cloud", "xValues"),
        wire("split", "yList", "cloud", "yValues"),
        wire("split", "zList", "cloud", "zValues"),
    ]
    return n, c


@demo("instancing_tools")
def _():
    n = [
        node("box", "object/box", -1300, 220, scale=v3(0.45, 0.45, 0.45), color=BLUE, roughness=0.25, metalness=0.4),
        node("ring", "structure/array", -1060, 220, mode="circular", radius=2.2, count=12, plane="XZ", totalAngle=360, orient=True),
        node("one", "structure/get-instance", -800, 60, index=0),
        node("spots", "structure/instance-positions", -800, 400, heightOffset=1.1),
        node("split", "list/split-vectors", -540, 400),
        node("marks", "object/point_cloud", -300, 400, pointSize=0.14, color=PINK),
    ]
    c = [
        wire("box", "geometry", "ring", "geometry"),
        # get-instance owns what it is given, so the ring itself stops being a
        # scene root — the single instance it returns is what renders, next to
        # the point cloud built from the same array's positions.
        wire("ring", "geometry", "one", "geometry"),
        wire("ring", "geometry", "spots", "geometry"),
        wire("spots", "positions", "split", "vectorList"),
        wire("split", "xList", "marks", "xValues"),
        wire("split", "yList", "marks", "yValues"),
        wire("split", "zList", "marks", "zValues"),
    ]
    return n, c


# ============================================================================
# The originals, rebuilt on the shared setup.
#
# They predate setup.tsuji and each sat on an empty grey void, which made the
# menu read as two unrelated collections. Same lessons, same small node
# counts — just staged on the floor, under the lights, on the blue -> pink
# ramp, and rethought where the original was thin.
# ============================================================================

@demo("transform_basics")
def _():
    n = [
        node("box", "object/box", -1000, 160, scale=v3(1, 1, 1), color=BLUE, roughness=0.25, metalness=0.35),
        # One node showing all three channels at once: moved off centre,
        # turned off-axis, and scaled unevenly.
        node("place", "structure/geometry-transform", -700, 160, mode="relative",
             posX=0.9, posY=0.6, rotY=35, rotZ=12, scaleX=1.4, scaleY=1.4, scaleZ=1.4),
    ]
    return n, [wire("box", "geometry", "place", "geometry")]


@demo("structure_array")
def _():
    n = [
        node("box", "object/box", -1000, 160, location=v3(0, 0.3, 0), scale=v3(0.5, 0.5, 0.5), color=BLUE, roughness=0.25, metalness=0.4),
        node("grid", "structure/array", -700, 160, mode="grid", plane="XZ",
             gridCols=6, gridRows=6, spacingX=0.95, spacingY=0.95, centerGrid=True),
    ]
    return n, [wire("box", "geometry", "grid", "geometry")]


@demo("time_spin")
def _():
    n = [
        node("clock", "time", -1240, 60),
        node("degrees", "value/math", -1000, 60, op="multiply", b=45),
        node("box", "object/box", -1240, 300, location=v3(0, 1, 0), scale=v3(1.2, 1.2, 1.2), color=MID, roughness=0.2, metalness=0.4),
        node("spin", "structure/geometry-transform", -700, 180, mode="relative"),
    ]
    c = [
        wire("clock", "seconds", "degrees", "a"),
        wire("box", "geometry", "spin", "geometry"),
        wire("degrees", "out", "spin", "rotY"),
    ]
    return n, c


@demo("time_oscillator_bob")
def _():
    n = [
        node("bob", "animation/oscillator", -1080, 60, type="sine", frequency=0.5, amplitude=0.7, offset=1.1),
        node("ball", "object/sphere", -1080, 300, scale=v3(0.7, 0.7, 0.7), color=PINK, roughness=0.2, metalness=0.4),
        node("lift", "structure/geometry-transform", -740, 180, mode="relative"),
    ]
    c = [
        wire("ball", "geometry", "lift", "geometry"),
        wire("bob", "out", "lift", "posY"),
    ]
    return n, c


@demo("list_instance_color")
def _():
    n = [
        node("box", "object/box", -1240, 300, location=v3(0, 0.35, 0), scale=v3(0.55, 0.7, 0.55), color=0xFFFFFF, roughness=0.25, metalness=0.4),
        node("grid", "structure/array", -1000, 300, mode="grid", plane="XZ",
             gridCols=8, gridRows=8, spacingX=0.8, spacingY=0.8, centerGrid=True),
        node("palette", "list/color-palette", -1000, 60, count=64),
        node("paint", "structure/instance-color", -680, 200, index=-1),
    ]
    c = [
        wire("box", "geometry", "grid", "geometry"),
        wire("grid", "geometry", "paint", "geometry"),
        wire("palette", "list", "paint", "colors"),
    ]
    return n, c


@demo("curve_primitive")
def _():
    n = [
        # visible 0: the node draws its own thin preview line, which would
        # double up on the tube built from the same curve.
        node("shape", "curve/primitive", -1000, 160, primitiveType="helix",
             radius=1.4, height=2.4, turns=4, location=v3(0, 0.4, 0), visible=0),
        node("tube", "curve/to_mesh", -700, 160, thickness=0.09, color=BLUE,
             emissive=BLUE, emissiveIntensity=0.25, roughness=0.2, metalness=0.45, showCurve=0),
    ]
    return n, [wire("shape", "curve", "tube", "curve")]


@demo("physics_raycast")
def _():
    n = [
        node("target", "object/sphere", -1320, 300, location=v3(0, 1.3, 0), scale=v3(1.5, 1.5, 1.5), color=0x223040, roughness=0.45, metalness=0.25),
        # The ray's origin slides, so the hit point visibly travels over the
        # surface instead of sitting still on a static diagram.
        # Amplitude stays inside the sphere's radius (0.5 x scale 1.5 = 0.75):
        # a ray that misses reports point (0,0,0), which would fling the
        # marker to the origin every time the sweep ran wide.
        node("sweep", "animation/oscillator", -1320, 60, type="sine", frequency=0.3, amplitude=0.55, offset=0),
        node("origin", "vector/compose", -1080, 60, y=4, z=0),
        node("ray", "physics/raycast", -820, 180, direction=v3(0, -1, 0), maxDistance=100),
        node("marker", "object/sphere", -820, 420, scale=v3(0.34, 0.34, 0.34), color=PINK, emissive=PINK, emissiveIntensity=0.9, shadeless=1),
        node("place", "structure/geometry-transform", -520, 320, mode="absolute"),
    ]
    c = [
        wire("sweep", "out", "origin", "x"),
        wire("origin", "out", "ray", "origin"),
        wire("target", "geometry", "ray", "geometry"),
        wire("marker", "geometry", "place", "geometry"),
        wire("ray", "point", "place", "location"),
    ]
    return n, c


@demo("io_mouse_pointer")
def _():
    n = [
        node("mouse", "io/mouse", -1080, 60, target="Ground", height=0, smoothing=0.25),
        node("marker", "object/sphere", -1080, 300, scale=v3(0.32, 0.32, 0.32), color=CYAN, emissive=CYAN, emissiveIntensity=0.6, shadeless=1),
        node("place", "structure/geometry-transform", -740, 180, mode="absolute"),
    ]
    c = [
        wire("marker", "geometry", "place", "geometry"),
        wire("mouse", "point", "place", "location"),
    ]
    return n, c


@demo("mouse_halo")
def _():
    n = [
        node("box", "object/box", -1500, 300, location=v3(0, 0.3, 0), scale=v3(0.6, 0.6, 0.6), color=0xFFFFFF, roughness=0.25, metalness=0.4),
        node("grid", "structure/array", -1260, 300, mode="grid", plane="XZ",
             gridCols=12, gridRows=12, spacingX=0.72, spacingY=0.72, centerGrid=True),
        node("mouse", "io/mouse", -1500, 60, target="Ground", height=0, smoothing=0.15),
        node("dists", "math/distances", -1020, 120),
        node("bump", "list/map-range", -760, 60, inMin=0, inMax=2.6, outMin=1.1, outMax=0, clamp=1, power=1.4),
        node("glow", "list/distance-gradient", -760, 300, radius=2.6, power=1.4),
        node("place", "structure/instance-transform", -480, 180, mode="relative", pivot="individual", index=-1),
        node("paint", "structure/instance-color", -220, 180, index=-1),
    ]
    c = [
        wire("box", "geometry", "grid", "geometry"),
        wire("grid", "geometry", "dists", "instances"),
        wire("mouse", "point", "dists", "target"),
        wire("dists", "distances", "bump", "list"),
        wire("dists", "distances", "glow", "distances"),
        wire("grid", "geometry", "place", "geometry"),
        wire("bump", "list", "place", "posY"),
        wire("place", "geometry", "paint", "geometry"),
        wire("glow", "list", "paint", "colors"),
    ]
    return n, c


# mouse_disc: hand-authored in the app, not generated — the original generated
# version grew into a fuller graph (a checker cube rolling after the disc via
# physics/rolling, a bloom pass) and re-running the generator would overwrite
# it. Same arrangement as object_text, squash_stretch_bounce and demo_trail.


@demo("lighting_environment")
def _():
    # Repurposed: the setup already carries an Environment node, so a second
    # one would just fight it for the scene. What is worth showing instead is
    # what an environment is *for* — three spheres reading it back through
    # different roughness and metalness.
    n = [
        # A roughness sweep at near-constant metalness, not a mirror-to-matte
        # one: the environment here is a flat colour, so a true mirror just
        # reflects an even field and reads as a black ball. Spread highlights
        # are what actually shows the surface responding.
        # y = -0.05 rests each sphere on the floor (radius 0.5 x scale 0.9,
        # plane at -0.5).
        node("sharp", "object/sphere", -1120, 40, location=v3(-1.7, -0.05, 0), scale=v3(0.9, 0.9, 0.9), color=0xFFFFFF, roughness=0.12, metalness=0.9),
        node("satin", "object/sphere", -1120, 240, location=v3(0, -0.05, 0), scale=v3(0.9, 0.9, 0.9), color=0xFFFFFF, roughness=0.38, metalness=0.9),
        node("matte", "object/sphere", -1120, 440, location=v3(1.7, -0.05, 0), scale=v3(0.9, 0.9, 0.9), color=0xFFFFFF, roughness=0.8, metalness=0.85),
        node("row", "structure/merge", -780, 240),
    ]
    c = [wire(s, "geometry", "row", f"in{i}") for i, s in enumerate(["sharp", "satin", "matte"])]
    return n, c


@demo("postprocess_bloom")
def _():
    n = [
        # Same pinning as lighting_probe's backdrop: this ring faced the
        # camera before flat primitives started lying flat by default.
        node("ring", "object/disc", -1080, 240, location=v3(0, 1.2, 0), rotation=v3(0, 0, 0),
             radius=1.1, innerRadius=0.75, depth=0.18,
             color=CYAN, emissive=CYAN, emissiveIntensity=2.4, shadeless=1),
        # threshold above 1, not the usual 0.3: the setup's white checker
        # floor sits near full luminance and its lit hotspots go past it, so
        # anything lower blooms the whole scene and loses the ring it is meant
        # to show. Only the ring, emissive at 2.4, crosses 1.5.
        node("glow", "postprocess/bloom", -1080, 40, strength=0.7, radius=0.35, threshold=1.5),
    ]
    return n, [wire("glow", "effect", RENDER, "postprocess")]


# ============================================================================
# Second wave — families still without a demo.
# ============================================================================

@demo("transform_matrix")
def _():
    # Reworked by hand in the app, then ported back here.
    #
    # Parent multiplies one matrix by another, so the moon inherits the
    # planet's motion without knowing anything about it. Matrix Math then
    # blends that parented pose against a second, tilted orbit — which is
    # what makes the moon's path read as an arc rather than a flat circle.
    n = [
        node("clock", "time", -1940, 398),
        node("spin", "transform/orbit", -1643, 142, radius=2.125, speed=40, height=1.125, tilt=0.24434609527920614),
        node("planet", "object/sphere", -1194, 47, scale=v3(1.1, 1.1, 1.1), color=0x8B5CF6, roughness=0.3, metalness=0.4),
        node("moon", "object/sphere", -1198, 308, location=v3(0, 1.575, 0), scale=v3(0.6, 0.6, 0.6),
             rotation=v3(0, 0.017453292519943295, 0), color=0xEC4899, roughness=0.25, metalness=0.45),
        node("attach", "transform/parent", -806, 196),
        node("swing", "transform/orbit", -835, 551, radius=1.05, speed=100, height=-0.65,
             tilt=0.6632251157578453, faceTarget=1),
        node("blend", "matrix/math", -495, 374, op="mix", factor=2.613),
        node("place", "structure/geometry-transform", -206, 265, rotZ=0, scaleY=1),
    ]
    c = [
        wire("clock", "seconds", "spin", "time"),
        wire("clock", "seconds", "swing", "time"),
        wire("spin", "matrix", "planet", "matrix"),
        wire("spin", "matrix", "swing", "target"),
        # Note the direction: the *moon's* own matrix is the parent here, the
        # planet's the child — this is what the reworked version settled on.
        wire("moon", "matrix", "attach", "parent"),
        wire("planet", "matrix", "attach", "child"),
        wire("attach", "matrix", "blend", "a"),
        wire("swing", "matrix", "blend", "b"),
        wire("moon", "geometry", "place", "geometry"),
        wire("blend", "out", "place", "matrix"),
    ]
    return n, c


@demo("math_vectors")
def _():
    n = [
        node("swing", "animation/oscillator", -1400, 40, type="sine", frequency=0.35, amplitude=2, offset=0),
        node("a", "vector/compose", -1160, 40, y=1.2, z=0),
        node("b", "vector/compose", -1160, 260, x=0, y=0.6, z=1.6),
        node("sum", "vector/math", -900, 140, op="add"),
        node("parts", "vector/decompose", -640, 300),
        node("ball", "object/sphere", -900, 420, scale=v3(0.55, 0.55, 0.55), color=BLUE, roughness=0.25, metalness=0.4),
        node("place", "structure/geometry-transform", -380, 420),
    ]
    c = [
        wire("swing", "out", "a", "x"),
        wire("a", "out", "sum", "a"),
        wire("b", "out", "sum", "b"),
        wire("sum", "out", "parts", "vector"),
        wire("ball", "geometry", "place", "geometry"),
        wire("sum", "out", "place", "location"),
    ]
    return n, c


@demo("math_spring")
def _():
    # Square wave in, spring out: the ball snaps between two heights and the
    # spring is what turns each jump into an overshoot and settle.
    n = [
        node("steps", "animation/oscillator", -1280, 60, type="square", frequency=0.25, amplitude=0.8, offset=1.2),
        node("damped", "math/spring", -1020, 60, smoothing=0.25, bounciness=0.55),
        node("ball", "object/sphere", -1280, 300, scale=v3(0.7, 0.7, 0.7), color=PINK, roughness=0.2, metalness=0.45),
        node("lift", "structure/geometry-transform", -700, 180),
    ]
    c = [
        wire("steps", "out", "damped", "target"),
        wire("ball", "geometry", "lift", "geometry"),
        wire("damped", "value", "lift", "posY"),
    ]
    return n, c


@demo("modifier_mesh_edit")
def _():
    n = [
        node("slab", "object/box", -1280, 60, location=v3(-1.5, 0.6, 0), scale=v3(1.4, 0.5, 1.4), color=BLUE, roughness=0.3, metalness=0.35),
        node("push", "modifier/extrude", -980, 60, distance=0.7, selectMode="normal", axis="y"),
        node("shell", "object/sphere", -1280, 320, location=v3(1.5, 1.1, 0), scale=v3(1.3, 1.3, 1.3), color=PINK, roughness=0.35, metalness=0.3),
        # threshold is in the geometry's own local space (sphere radius 0.5),
        # not world units — 0 is exactly the equator, which is the node's own
        # documented default.
        node("cut", "modifier/delete-geometry", -980, 320, selectMode="height", axis="y", threshold=0),
        # With the top half gone you are looking at back faces; flipping them
        # is what makes the opened shell read as a solid bowl.
        node("flip", "modifier/invert-normals", -700, 320, mode="both"),
    ]
    c = [
        wire("slab", "geometry", "push", "geometry"),
        wire("shell", "geometry", "cut", "geometry"),
        wire("cut", "geometry", "flip", "geometry"),
    ]
    return n, c


@demo("modifier_extrude_tree")
def _():
    # A tube's top ring extruded over and over, tilting and tapering each
    # pass, becomes a tree in one node: Extrude Mesh's Passes re-extrudes the
    # same selection, the per-pass Rotation bends the cap, Scale tapers it and
    # Random % jitters every pass off a seeded PRNG. The Face Selection node
    # picks the top cap and hands its `selection` list straight to Extrude,
    # which is what really drives the grow — swap that node for another
    # formula or a different geometry and the whole tree follows.
    #
    # Threshold is in the cylinder's OWN LOCAL space, where it spans
    # -0.5..+0.5 — NOT the world y the Location/Scale params put it at. 0.49
    # is therefore "the top cap", and the node's Location y=0.6 / Scale y=1.2
    # do not enter into it. (Picking a world-space number here selects
    # nothing at all and the tree silently stays a bare tube.)
    #
    # The geometry runs tube -> sel -> grow rather than the tube feeding both:
    # `geometry` is an owning input on each, so branching it would hand the
    # same object to two owners and leave the raw tube drawn over the tree.
    n = [
        node("tube", "object/cylinder", -1100, 200, location=v3(0, 0.6, 0), scale=v3(0.7, 1.2, 0.7),
             color=0x8B5CF6, roughness=0.4, metalness=0.2),
        node("sel", "modifier/face-selection", -900, 200, selectMode="height", axis="y", threshold=0.49),
        node("grow", "modifier/extrude", -640, 200,
             passes=8, distance=0.32,
             rotation=v3(0.12, 0, 0.07), scale=0.94, location=v3(0, 0, 0),
             random=0.3, seed=6),
    ]
    c = [
        wire("tube", "geometry", "sel", "geometry"),
        wire("sel", "selection", "grow", "selection"),
        wire("sel", "geometry", "grow", "geometry"),
    ]
    return n, c


# text_toolkit: retired — its ground (Trim, Case, Length) is now covered by
# the hand-authored object_text demo above, which chains Random and Concat
# in too.


@demo("post_kaleidoscope")
def _():
    n = [
        node("tower", "object/cylinder", -1180, 320, location=v3(0, 1, 0), scale=v3(0.8, 2, 0.8),
             color=PINK, emissive=PINK, emissiveIntensity=0.4, roughness=0.25, metalness=0.5),
        node("mirror", "postprocess/kaleidoscope", -1180, 40, sides=6, angle=0),
        node("blocky", "postprocess/pixelate", -920, 40, pixelSize=4),
        node("grade", "postprocess/color-correction", -660, 40, brightness=0.02, contrast=1.15, saturation=1.3),
    ]
    c = [
        wire("mirror", "effect", "blocky", "effect"),
        wire("blocky", "effect", "grade", "effect"),
        wire("grade", "effect", RENDER, "postprocess"),
    ]
    return n, c


@demo("lighting_probe")
def _():
    # A Light Probe photographs its surroundings and reduces them to nine
    # spherical-harmonic coefficients, so it knows the wall on its left is
    # blue and the one on its right is pink — an Ambient Light only knows one
    # flat colour. Three shadeless panels give it something unambiguous to
    # read, and a matte white sphere is where you see it: coloured bounce on
    # each flank, which the setup's white point lights cannot produce.
    #
    # updateMode "always" rather than the "once" default: a single bake races
    # the frame the walls first exist on, and re-baking keeps the demo honest
    # if you recolour a panel in the panel.
    wall = dict(shadeless=1, roughness=1, metalness=0)
    n = [
        # rotation pinned upright: flat primitives now default to lying down
        # (FLAT_PRIMITIVE_DEFAULT_PARAMS), and this one is a backdrop wall.
        node("back", "object/plane", -1240, 40, location=v3(0, 1.1, -2.3), rotation=v3(0, 0, 0),
             scale=v3(5, 3.2, 1), color=CYAN, **wall),
        node("left", "object/plane", -1240, 240, location=v3(-2.3, 1.1, 0), rotation=v3(0, 1.5708, 0), scale=v3(5, 3.2, 1), color=BLUE, **wall),
        node("right", "object/plane", -1240, 440, location=v3(2.3, 1.1, 0), rotation=v3(0, -1.5708, 0), scale=v3(5, 3.2, 1), color=PINK, **wall),
        # Above the sphere, not inside it — a probe sitting at the object's
        # own centre photographs the inside of that object and nothing else.
        node("probe", "light/probe", -900, 240, location=v3(0, 2.3, 0), intensity=3.4, updateMode="always", resolution=64),
        node("ball", "object/sphere", -900, 460, location=v3(0, 0.45, 0), scale=v3(1.9, 1.9, 1.9), color=0xFFFFFF, roughness=0.9, metalness=0),
    ]
    # The one demo that dims the shared setup: at their stock intensity the
    # three white key lights bury the probe's coloured bounce under white,
    # which is the whole thing this demo exists to show.
    return n, [], {"light/point": {"intensity": 6}}


@demo("texture_stylized_water")
def _():
    # The water reads the terrain's own heightmap, so the two have to agree on
    # their framing: same width/depth, and the material's Depth Elevation is the
    # terrain's Height Offset — its lowest point, which is where the deep blue is.
    n = [
        node("relief", "texture/procedural", -1320, 60, type="perlin", colorA=0x000000, colorB=0xFFFFFF,
             scale=3, seed=7, octaves=4, resolution=256),
        node("land", "object/terrain", -1020, 60, width=10, depth=10, resolution="128x128",
             heightScale=6.3, heightOffset=-1.87, slopeShading=False, flatShading=True,
             color=0xE9A867, roughness=0.9, metalness=0),
        node("weather", "animation/oscillator", -1320, 420, type="sine", frequency=0.08,
             phase=0, amplitude=0.5, offset=0.5),
        node("water", "material/stylized-water", -700, 240, terrainWidth=10, terrainDepth=10,
             surfaceElevation=-0.35, depthElevation=-1.3, temperature=18),
        node("surface", "object/plane", -380, 240, location=v3(0, -0.35, 0),
             rotation=v3(1.5707963267948966, 0, 0), scale=v3(10, 10, 1)),
    ]
    c = [
        wire("relief", "texture", "land", "heightmap"),
        wire("land", "heightmap", "water", "shoreMap"),
        wire("weather", "out", "water", "rain"),
        wire("water", "material", "surface", "material"),
    ]
    # The stock floor would sit inside the terrain and show through the water.
    return n, c, {"object/plane": {"visible": 0}}


@demo("vegetation_leaves")
def _():
    # Reworked by hand in the app, then ported back here. Terrain first, then everything stands on
    # it: Grass Field and Leaves both take the same mesh on their Ground input and sample its
    # surface, so neither needs to know it is a terrain. Holding b blasts the leaves off it.
    n = [
        node("relief", "texture/procedural", -1720, 60, type="perlin", colorA=0x000000,
             colorB=0xFFFFFF, scale=3, seed=7, octaves=4, resolution=256),
        # A second, much finer perlin as the terrain's colour map: the relief alone reads as a
        # flat wash under all that grass.
        node("dirt", "texture/procedural", -1689, 249, type="perlin", colorA=0xFFFFFF,
             colorB=0x222222, scale=38, seed=1, octaves=3, resolution=256),
        node("land", "object/terrain", -1442, 73, width=30, depth=30, resolution="128x128",
             heightScale=4, heightOffset=-1.2, slopeShading=False, flatShading=True,
             color=0xD89CBA, roughness=0.95, metalness=0),
        node("wind", "physics/wind-field", -1440, 320, strength=5, gustiness=1, timeFrequency=0.35),
        node("grass", "structure/grass-field", -1080, 60, subdivisions=200, size=30,
             bladeHeight=1.488, bladeWidth=0.506, heightRandomness=0.625, windInfluence=0.188,
             baseColor=0x8B7C4C, tipColor=0xB37393),
        # Floor Offset above the blade height, so the leaves ride on top of the grass rather than
        # disappearing into it.
        node("leaves", "object/leaves", -1080, 360, count=1500, size=30, scale=0.135,
             upwardMultiplier=1.026, floorOffset=1.845, colorA=0xEF4444, colorB=0xEC4899,
             roughness=0, metalness=0.012),
        node("key", "io/keyboard", -1718, 576, key="b"),
        node("fuse", "logic/trigger", -1458, 653),
        node("group", "structure/merge", -720, 240),
        node("glow", "postprocess/bloom", 357, 616, strength=0.8, radius=0.5, threshold=1.6),
    ]
    c = [
        wire("relief", "texture", "land", "heightmap"),
        wire("dirt", "texture", "land", "texture"),
        wire("land", "geometry", "grass", "ground"),
        wire("land", "geometry", "leaves", "ground"),
        wire("wind", "field", "grass", "wind"),
        wire("wind", "field", "leaves", "wind"),
        wire("key", "isDown", "fuse", "in"),
        wire("fuse", "trigger", "leaves", "blastTrigger"),
        wire("land", "geometry", "group", "in0"),
        wire("grass", "geometry", "group", "in1"),
        wire("leaves", "geometry", "group", "in2"),
        wire("glow", "effect", RENDER, "postprocess"),
    ]
    # The terrain is the ground here, so the stock floor would sit inside it. The stock lights are
    # aimed at a small stage and leave a 30-unit field of grass murky.
    return n, c, {
        "object/plane": {"visible": 0},
        "render": {"frameCount": 300},
        "lighting/environment": {"ambientIntensity": 1.388, "sunIntensity": 2.9},
    }


@demo("physics_spawner")
def _():
    # The cookie launcher: one biscuit per press of b. The pool is fixed, so the
    # twenty-first cookie recycles the first rather than growing the scene — which is why the
    # launcher can run all day. r throws the whole simulation away and puts the timeline back to
    # frame 0, the same thing the toolbar's reset button does.
    n = [
        node("world", "physics/world", -1560, 320, gravity=v3(0, -9.81, 0)),
        node("launchKey", "io/keyboard", -1560, 40, key="b"),
        node("launchFuse", "logic/trigger", -1300, 40),
        node("resetKey", "io/keyboard", -1560, 700, key="r"),
        node("resetFuse", "logic/trigger", -1300, 700),
        node("reset", "time/reset-simulations", -1040, 700),
        node("cookie", "object/box", -1560, 520, scale=v3(0.6, 0.22, 0.6),
             color=0xC98A3D, roughness=0.75, metalness=0),
        node("launcher", "physics/spawner", -1040, 320, count=20, shape="box", mass=0.6,
             position=v3(0, 1.5, -2), direction=v3(0, 0.4, 1), speed=7,
             spread=0.22, jitter=0.3, spin=0.5, restitution=0.25, friction=0.7),
        node("floor_geo", "object/box", -1560, 900, location=v3(0, -0.5, 4),
             scale=v3(16, 1, 26), color=0x49525F, roughness=0.9, metalness=0),
        node("floor", "physics/rigid-body", -1040, 900, bodyType="fixed", shape="box",
             friction=0.9, restitution=0),
        node("sign", "object/text", -1560, 180, text="b = launch   r = reset",
             fontPreset="Bangers", fontSize=64, depth=0.1, location=v3(0, 0.6, -5.5),
             rotation=v3(-1.1, 0, 0), scale=v3(1.6, 1.6, 1.6), color=0x857070,
             roughness=0.4, metalness=0.1),
        node("group", "structure/merge", -700, 500),
    ]
    c = [
        # `pressed`, not `isDown`: the spawner fires on a rising edge, so holding the key would
        # launch exactly one cookie and look broken.
        wire("launchKey", "pressed", "launchFuse", "in"),
        wire("launchFuse", "trigger", "launcher", "trigger"),
        wire("resetKey", "pressed", "resetFuse", "in"),
        wire("resetFuse", "trigger", "reset", "trigger"),
        wire("world", "world", "launcher", "world"),
        # The spawner passes the world through, so the floor is built after its pool: the order
        # a graph states is the order the world is touched in.
        wire("launcher", "world", "floor", "world"),
        wire("floor_geo", "geometry", "floor", "geometry"),
        wire("cookie", "geometry", "launcher", "prototype"),
        wire("launcher", "geometry", "group", "in0"),
        wire("floor", "geometry", "group", "in1"),
    ]
    # Its own floor, so the stock one would sit inside it.
    return n, c, {"object/plane": {"visible": 0}, "render": {"frameCount": 300}}


@demo("physics_explosion")
def _():
    # Reworked by hand in the app, then ported back here. One key press drives both halves of the
    # original's explosion: the fireball you see and the impulse that throws the crates. Explosion
    # Impulse sits between the world and the bodies it kicks — threading the world socket through
    # it is how the order is stated in a graph.
    n = [
        node("key", "io/keyboard", -1729, 46, key="b"),
        node("fuse", "logic/trigger", -1442, 69),
        node("sign", "object/text", -1781, 172, text="Hit b to blast !", fontPreset="Bangers",
             fontSize=64, depth=0.1, location=v3(0, 0.55, -6.47), rotation=v3(-1.1385, 0, 0),
             scale=v3(2.075, 2.075, 2.075), color=0x857070, roughness=0.4, metalness=0.1),
        node("world", "physics/world", -1500, 300, gravity=v3(0, -9.81, 0)),
        # radius 7 clears the grid's 4.2-unit half-diagonal, so the corner crates still get a
        # usable share of the blast instead of the tail end of the falloff.
        node("blast", "physics/explosion", -1180, 300, location=v3(0, 0.4, 0),
             radius=7, strength=22),
        node("fire", "object/explosion", -1158, 33, location=v3(0, 0.3, 0), fireRadius=8.775,
             loop=0, floorLevel=0, floorFade=1.15, lifetime=2, burnDuration=1,
             emissiveStrength=6, glowThreshold=0.4, gooColor=0x604343, gooEdge=0.04,
             noiseScale=6.375),
        node("ground_geo", "object/box", -1500, 540, location=v3(0, -0.5, 0),
             scale=v3(24, 1, 24), color=0x4A5568, roughness=0.9, metalness=0),
        node("ground", "physics/rigid-body", -1180, 540, bodyType="fixed", shape="trimesh",
             friction=0.9, restitution=0),
        node("crate_geo", "object/box", -1500, 760, location=v3(0, 0.4, 0), scale=v3(0.7, 0.7, 0.7),
             color=0xD98E4A, roughness=0.8, metalness=0),
        node("crates", "structure/array", -1180, 760, mode="grid", plane="XZ", centerGrid=True,
             gridCols=5, gridRows=5, spacingX=1.5, spacingY=1.5),
        node("crate_body", "physics/rigid-body", -860, 760, bodyType="dynamic", shape="box",
             mass=1, friction=0.6, restitution=0.1, angularDamping=0.15),
        node("group", "structure/merge", -560, 400),
        # Same threshold reasoning as object_explosion: only the fireball's deliberately
        # overbright core crosses it, so the crates and floor stay out of the bloom.
        node("glow", "postprocess/bloom", 226, 404, strength=0.3, radius=0.5, threshold=1.8),
    ]
    c = [
        wire("key", "pressed", "fuse", "in"),
        wire("fuse", "trigger", "blast", "trigger"),
        wire("fuse", "trigger", "fire", "trigger"),
        wire("world", "world", "blast", "world"),
        wire("ground_geo", "geometry", "ground", "geometry"),
        wire("blast", "world", "ground", "world"),
        wire("crate_geo", "geometry", "crates", "geometry"),
        wire("crates", "geometry", "crate_body", "geometry"),
        wire("blast", "world", "crate_body", "world"),
        wire("ground", "geometry", "group", "in0"),
        wire("crate_body", "geometry", "group", "in1"),
        wire("fire", "geometry", "group", "in2"),
        wire("glow", "effect", RENDER, "postprocess"),
    ]
    # Its own floor, so the stock one would z-fight with it. And 300 frames, because a blast the
    # user fires by hand needs room to be fired more than once.
    return n, c, {"object/plane": {"visible": 0}, "render": {"frameCount": 300}}


@demo("object_explosion")
def _():
    # Three fireballs on the same 3s loop, half a second apart, so they go off one after the
    # other. Floor Level matches the ground plane: the fireball is flattened against it rather
    # than sinking half a sphere below.
    n = [
        node("blastA", "object/explosion", -1180, 60, location=v3(-1.8, 0, 0), fireRadius=1.7,
             loop=3, loopOffset=0, floorLevel=0),
        node("blastB", "object/explosion", -1180, 300, location=v3(0.3, 0, 0.7), fireRadius=2.2,
             loop=3, loopOffset=0.5, floorLevel=0),
        node("blastC", "object/explosion", -1180, 540, location=v3(2.0, 0, -0.5), fireRadius=1.3,
             loop=3, loopOffset=1.0, floorLevel=0,
             emissiveColorA=0xB3123C, emissiveColorB=0xFFD166),
        node("group", "structure/merge", -820, 300),
        # threshold 1.6, not the usual 0.3, for the same reason as postprocess_bloom: the setup's
        # white checker floor has lit hotspots past 1, and anything lower blooms the whole stage
        # instead of the fire. The fireball's core is pushed to roughly 3x on purpose, so it is
        # the only thing that crosses.
        node("glow", "postprocess/bloom", -820, 60, strength=0.9, radius=0.5, threshold=1.6),
    ]
    c = [wire(s, "geometry", "group", f"in{i}") for i, s in enumerate(["blastA", "blastB", "blastC"])]
    c.append(wire("glow", "effect", RENDER, "postprocess"))
    # The stock stage fights this one: its white checker floor, lit by three lights at intensity
    # 50, sits far above any bloom threshold that would still catch the fire, so the whole frame
    # blooms instead of the explosions. A dark empty stage is also what a fireball wants.
    return n, c, {"object/plane": {"visible": 0}, "light/point": {"intensity": 18}}


@demo("object_raccoon")
def _():
    # The Raccoon is a primitive, so it instances like any other: no loader,
    # no file path, and Array clones it exactly as it would a Box.
    n = [
        node("racc", "object/raccoon", -1180, 220, scale=v3(1.5, 1.5, 1.5), color=0xC9D3DE, roughness=0.55, metalness=0.15),
        node("ring", "structure/array", -900, 220, mode="circular", radius=1.9, count=6,
             plane="XZ", totalAngle=360, orient=True),
        node("palette", "list/color-palette", -900, 440, count=6),
        node("paint", "structure/instance-color", -600, 300, index=-1),
    ]
    c = [
        wire("racc", "geometry", "ring", "geometry"),
        wire("ring", "geometry", "paint", "geometry"),
        wire("palette", "list", "paint", "colors"),
    ]
    return n, c


def main(only=None):
    names = [only] if only else list(DEMOS_SPEC)
    for name in names:
        spec = DEMOS_SPEC[name]()
        nodes, conns = spec[0], spec[1]
        write_demo(name, nodes, conns, setup_overrides=spec[2] if len(spec) > 2 else None)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
