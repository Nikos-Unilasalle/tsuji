#!/usr/bin/env python3
"""Generate public/demos/demo_shan_shui.tsuji — an endless Shan Shui handscroll
in the manner of LingDong-'s shan-shui-inf, built from Ridge Layers, Strata
Hatch, Scatter on Curves, Ink Stroke, Curve Fill and Instance on Points.

The panorama is one strip of PERIOD world units, repeated three times by an
Array; the camera pans across exactly one period per loop of the timeline, so
the scroll never seams. Everything is drawn in grey ink on white and turned
into ink on paper by a Dual Tone pass — the same trick as the original's
mix-blend-mode: multiply over a paper texture.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public/demos/demo_shan_shui.tsuji")

PERIOD = 48.0
FPS = 30
SECONDS = 48  # one period per loop: 1 world unit per second
INK = 0x646464


def v3(x=0.0, y=0.0, z=0.0):
    return {"x": x, "y": y, "z": z}


nodes, conns = [], []


def node(nid, ntype, px, py, **params):
    # Laid out on a compact grid below, spread out here: most of these nodes
    # are tall, and the layout reads better than it would packed edge to edge.
    nodes.append({"id": nid, "type": ntype, "position": {"x": round(px * 1.5), "y": round(py * 1.7)}, "params": params})
    return nid


def wire(a, sa, b, sb):
    conns.append({"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb})


def ink(nid, px, py, source, socket="curves", **params):
    node(nid, "curve/ink-stroke", px, py, **{"color": INK, **params})
    wire(*source, nid, socket)
    return nid


# ------------------------------------------------------------------ anchors

# Mountains: massifs, as Shan Shui plans them. A noise along the strip peaks
# in a few places (periodic, so the loop has no seam); around each peak a
# cluster of mountains is stacked row behind row in depth, more rows where the
# peak is stronger. Between the peaks there are no mountains at all.
X0, Y0 = -2600, -900
node("m_peaks", "list/noise-peaks", X0, Y0, domain="line", plane="xz", min=0, max=PERIOD, depthMin=-5, depthMax=5,
     origin=v3(0, 0, -4.5), frequency=0.2, octaves=2, threshold=0.25, minDistance=6, invert=False, periodic=True,
     resolution=480, seed=11)
node("m_rows", "list/map-range", X0, Y0 + 260, inMin=0, inMax=1, outMin=6, outMax=12, clamp=1, power=1)
wire("m_peaks", "strengths", "m_rows", "list")
node("m_cluster", "list/scatter-around", X0 + 240, Y0 + 60, count=8, spread=v3(6, 0, 4.5), distribution="uniform",
     layeredAlong="z", seed=11)
wire("m_peaks", "points", "m_cluster", "points")
wire("m_rows", "list", "m_cluster", "counts")
# Layer 0 is the back row: higher on the page, further away; 1 the front row.
node("m_y", "list/map-range", X0 + 480, Y0 + 260, inMin=0, inMax=1, outMin=1.3, outMax=-2.2, clamp=1, power=1)
node("m_s", "list/map-range", X0 + 480, Y0 + 420, inMin=0, inMax=1, outMin=1.25, outMax=1.0, clamp=1, power=1)
for t in ("m_y", "m_s"):
    wire("m_cluster", "layers", t, "list")
node("m_split", "list/split-vectors", X0 + 480, Y0 + 60)
wire("m_cluster", "points", "m_split", "vectorList")
node("m_anchors", "list/combine-vectors", X0 + 720, Y0 + 200)
wire("m_split", "xList", "m_anchors", "xList")
wire("m_y", "list", "m_anchors", "yList")
wire("m_split", "zList", "m_anchors", "zList")

# A back row all along the strip, so the massifs never leave the sky bare
# behind them: one mountain every few units at the far end of the depth,
# joined to the clusters' anchors (and their scales) with List Group.
node("b_x", "list/generate", X0 - 760, Y0 + 640, count=12, start=0, step=PERIOD / 12)
node("b_jit", "list/random-list", X0 - 760, Y0 + 790, count=12, algorithm="uniform", seed=53, min=-1.2, max=1.2)
node("b_xs", "list/math", X0 - 520, Y0 + 700, op="add")
wire("b_x", "list", "b_xs", "a")
wire("b_jit", "list", "b_xs", "b")
node("b_y", "list/random-list", X0 - 760, Y0 + 940, count=12, algorithm="uniform", seed=59, min=1.4, max=2.0)
node("b_anchors", "list/combine-vectors", X0 - 280, Y0 + 760, zDefault=-9.8)
wire("b_xs", "list", "b_anchors", "xList")
wire("b_y", "list", "b_anchors", "yList")
node("b_s", "list/random-list", X0 - 520, Y0 + 940, count=12, algorithm="uniform", seed=61, min=0.9, max=1.3)
node("m_all", "list/group", X0 + 960, Y0 + 300)
wire("m_anchors", "vectorList", "m_all", "in0")
wire("b_anchors", "vectorList", "m_all", "in1")
node("m_all_s", "list/group", X0 + 960, Y0 + 500)
wire("m_s", "list", "m_all_s", "in0")
wire("b_s", "list", "m_all_s", "in1")

# Distant ranges: a pale chain far behind everything.
D0 = Y0 - 700
node("d_x", "list/generate", X0, D0, count=3, start=4, step=PERIOD / 3)
node("d_anchors", "list/combine-vectors", X0 + 480, D0, yDefault=2.6, zDefault=-16)
wire("d_x", "list", "d_anchors", "xList")

# Plateaus: flat-topped banks in the gaps between the massifs — the troughs
# of the same noise — several to a gap, row behind row like the mountains:
# the back rows higher on the page and further away.
P0 = Y0 + 820
node("p_gaps", "list/noise-peaks", X0, P0, domain="line", plane="xz", min=0, max=PERIOD, depthMin=-5, depthMax=5,
     origin=v3(0, 0, 2.0), frequency=0.2, octaves=2, threshold=0.5, minDistance=7, invert=True, periodic=True,
     resolution=480, seed=11)
node("p_cluster", "list/scatter-around", X0 + 240, P0 + 60, count=6, spread=v3(6, 0, 1.6), distribution="uniform",
     layeredAlong="z", seed=31)
wire("p_gaps", "points", "p_cluster", "points")
node("p_y", "list/map-range", X0 + 480, P0 + 260, inMin=0, inMax=1, outMin=-2.5, outMax=-3.4, clamp=1, power=1)
wire("p_cluster", "layers", "p_y", "list")
node("p_split", "list/split-vectors", X0 + 480, P0 + 60)
wire("p_cluster", "points", "p_split", "vectorList")
node("p_anchors", "list/combine-vectors", X0 + 720, P0 + 200)
wire("p_split", "xList", "p_anchors", "xList")
wire("p_y", "list", "p_anchors", "yList")
wire("p_split", "zList", "p_anchors", "zList")

# Water: bands of ripples in the mist between the mountains.
W0 = P0 + 420
node("w_x", "list/generate", X0, W0, count=6, start=0, step=PERIOD / 6)
node("w_y", "list/random-list", X0, W0 + 150, count=6, algorithm="uniform", seed=41, min=-5.4, max=-3.0)
node("w_anchors", "list/combine-vectors", X0 + 480, W0 + 60, zDefault=-9.5)
wire("w_x", "list", "w_anchors", "xList")
wire("w_y", "list", "w_anchors", "yList")

# ------------------------------------------------------------------ prefabs
# A bush is a clump of ink blobs; a tall tree is a trunk with blobs of
# foliage that narrow towards the top. Both are drawn once and instanced.

B0 = Y0 + 1700
node("blob_line", "curve/primitive", X0, B0, primitiveType="line", height=0.14, visible=1)
ink("blob", X0 + 260, B0, ("blob_line", "curve"), socket="curve",
    width=0.04, minWidth=0.003, profile="blob", widthNoise=0.5, opacity=0.55, zOffset=0, seed=3)
node("bush_x", "list/random-list", X0, B0 + 200, count=5, algorithm="gaussian", seed=5, min=-0.14, max=0.14)
node("bush_y", "list/random-list", X0, B0 + 350, count=5, algorithm="gaussian", seed=6, min=-0.1, max=0.1)
node("bush_pts", "list/combine-vectors", X0 + 260, B0 + 260)
wire("bush_x", "list", "bush_pts", "xList")
wire("bush_y", "list", "bush_pts", "yList")
node("bush", "structure/instance-on-points", X0 + 520, B0 + 100, scaleMin=0.6, scaleMax=1.2, rotationJitter=12, axis="Z", randomFlip=False, seed=7)
wire("blob", "geometry", "bush", "geometry")
wire("bush_pts", "vectorList", "bush", "points")

T0 = B0 + 560
node("trunk_line", "curve/primitive", X0, T0, primitiveType="line", height=0.62, location=v3(0, 0.31, 0), visible=1)
ink("trunk", X0 + 260, T0, ("trunk_line", "curve"), socket="curve",
    width=0.007, minWidth=0.004, profile="taper", widthNoise=0.3, wobble=0.012, wobbleScale=0.4, opacity=0.45, zOffset=0, seed=9)
node("leaf_line", "curve/primitive", X0, T0 + 200, primitiveType="line", height=0.22, rotation=v3(0, 0, 1.5708), visible=1)
ink("leaf", X0 + 260, T0 + 200, ("leaf_line", "curve"), socket="curve",
    width=0.03, minWidth=0.003, profile="blob", widthNoise=0.5, opacity=0.3, zOffset=0, seed=10)
node("leaf_h", "list/random-list", X0, T0 + 400, count=16, algorithm="uniform", seed=12, min=0.16, max=0.62)
node("leaf_room", "list/map-range", X0 + 240, T0 + 400, inMin=0.16, inMax=0.62, outMin=0.32, outMax=0.04, clamp=1, power=1)
node("leaf_side", "list/random-list", X0, T0 + 560, count=16, algorithm="uniform", seed=13, min=-1, max=1)
node("leaf_x", "list/math", X0 + 480, T0 + 480, op="multiply")
wire("leaf_h", "list", "leaf_room", "list")
wire("leaf_room", "list", "leaf_x", "a")
wire("leaf_side", "list", "leaf_x", "b")
node("leaf_pts", "list/combine-vectors", X0 + 720, T0 + 420)
wire("leaf_x", "list", "leaf_pts", "xList")
wire("leaf_h", "list", "leaf_pts", "yList")
node("leaf_size", "list/map-range", X0 + 480, T0 + 640, inMin=0.16, inMax=0.62, outMin=1.4, outMax=0.45, clamp=1, power=1)
wire("leaf_h", "list", "leaf_size", "list")
node("foliage", "structure/instance-on-points", X0 + 960, T0 + 260, scaleMin=0.8, scaleMax=1.2, rotationJitter=15, axis="Z", seed=14)
wire("leaf", "geometry", "foliage", "geometry")
wire("leaf_pts", "vectorList", "foliage", "points")
wire("leaf_size", "list", "foliage", "scales")
node("tree", "structure/merge", X0 + 1200, T0 + 100)
wire("trunk", "geometry", "tree", "in0")
wire("foliage", "geometry", "tree", "in1")

# ------------------------------------------------------------------ landforms
C1 = X0 + 900
STROKE_Z = 0.01

# Mountains — fill, outline, fold hatching, and three kinds of vegetation.
node("mount", "curve/ridge-layers", C1, Y0, profile="peak", width=6, height=4.8, sizeJitter=0.35,
     layers=10, resolution=50, frequency=1, shrink=1, drop=0.03, chop=0.55, seed=4)
wire("m_all", "list", "mount", "anchors")
wire("m_all_s", "list", "mount", "scales")
node("mount_fill", "curve/fill", C1 + 300, Y0 - 160, color=0xFFFFFF, opacity=1, baseDrop=0.3, gradient=False, zOffset=0)
wire("mount", "outlines", "mount_fill", "curves")
ink("mount_outline", C1 + 300, Y0 + 40, ("mount", "outlines"),
    width=0.03, minWidth=0.004, profile="sine", widthNoise=1, opacity=0.45, zOffset=STROKE_Z, seed=1)
node("mount_hatch", "curve/strata-hatch", C1 + 300, Y0 + 240, count=140, length=0.2, jitter=0.3, distribution="edges", resolution=50, seed=2)
wire("mount", "stacks", "mount_hatch", "stacks")
ink("mount_tex", C1 + 560, Y0 + 240, ("mount_hatch", "curves"),
    width=0.015, minWidth=0.003, profile="sine", widthNoise=0.5, opacity=0.45, alphaJitter=1, zOffset=STROKE_Z, seed=3)

node("rim_spots", "curve/scatter", C1 + 300, Y0 + 480, resolution=50, layerMin=0, layerMax=0, maskScaleAlong=0.1, maskScaleAcross=0,
     maskPower=3, threshold=0.05, heightMin=0.2, heightMax=1, offset=v3(0, 0.04, -0.03), scaleMin=0.4, scaleMax=0.7, seed=1)
wire("mount", "stacks", "rim_spots", "curves")
node("rim_trees", "structure/instance-on-points", C1 + 560, Y0 + 480, randomFlip=True, seed=21)
wire("bush", "geometry", "rim_trees", "geometry")
wire("rim_spots", "points", "rim_trees", "points")
wire("rim_spots", "scales", "rim_trees", "scales")

node("top_spots", "curve/scatter", C1 + 300, Y0 + 720, resolution=50, layerMin=0, layerMax=99, maskScaleAlong=0.1, maskScaleAcross=0.1,
     maskPower=3, threshold=0.025, heightMin=0.5, heightMax=1, offset=v3(0, 0, 0.02), scaleMin=0.35, scaleMax=0.6, seed=3)
wire("mount", "stacks", "top_spots", "curves")
node("top_trees", "structure/instance-on-points", C1 + 560, Y0 + 720, randomFlip=True, seed=22)
wire("bush", "geometry", "top_trees", "geometry")
wire("top_spots", "points", "top_trees", "points")
wire("top_spots", "scales", "top_trees", "scales")

node("mid_spots", "curve/scatter", C1 + 300, Y0 + 960, resolution=50, layerMin=0, layerMax=99, everyOther=True, maskScaleAlong=0.05,
     maskScaleAcross=0.2, maskPower=4, threshold=0.005, heightMin=0, heightMax=0.3, minNeighbors=2, neighborRadius=0.3,
     offset=v3(0, 0, 0.02), scaleMin=0.5, scaleMax=1.1, seed=5)
wire("mount", "stacks", "mid_spots", "curves")
node("mid_trees", "structure/instance-on-points", C1 + 560, Y0 + 960, randomFlip=True, seed=23)
wire("tree", "geometry", "mid_trees", "geometry")
wire("mid_spots", "points", "mid_trees", "points")
wire("mid_spots", "scales", "mid_trees", "scales")

# Distant ranges — a pale wash, no line work.
node("dist", "curve/ridge-layers", C1, D0, profile="range", width=20, height=4.3, sizeJitter=0.23063,
     layers=1, resolution=120, frequency=1.825, shrink=0, drop=0, seed=8, location=v3(0, 1.275, 0))
wire("d_anchors", "vectorList", "dist", "anchors")
node("dist_fill", "curve/fill", C1 + 300, D0, color=0xD8D8D8, opacity=0.51662, baseDrop=0, gradient=True, bottomColor=0xFFFFFF, zOffset=0)
wire("dist", "outlines", "dist_fill", "curves")

# Plateaus — banks with a flat top, a grove on it, and calmer hatching.
node("plat", "curve/ridge-layers", C1, P0, profile="plateau", width=9, height=1.0, sizeJitter=0.25,
     layers=5, resolution=50, frequency=1, shrink=0.6, drop=0.04, chop=0.6, seed=12)
wire("p_anchors", "vectorList", "plat", "anchors")
node("plat_fill", "curve/fill", C1 + 300, P0 - 160, color=0xFFFFFF, opacity=1, baseDrop=2.0, zOffset=0)
wire("plat", "outlines", "plat_fill", "curves")
ink("plat_outline", C1 + 300, P0 + 40, ("plat", "outlines"),
    width=0.03, minWidth=0.004, profile="sine", widthNoise=1, opacity=0.3, zOffset=STROKE_Z, seed=4)
node("plat_hatch", "curve/strata-hatch", C1 + 300, P0 + 240, count=80, length=0.2, jitter=0.3, distribution="inner", resolution=50, seed=6)
wire("plat", "stacks", "plat_hatch", "stacks")
ink("plat_tex", C1 + 560, P0 + 240, ("plat_hatch", "curves"),
    width=0.02, minWidth=0.003, profile="sine", widthNoise=0.5, opacity=0.3, alphaJitter=1, zOffset=STROKE_Z, seed=5)
node("grove_spots", "curve/scatter", C1 + 300, P0 + 480, resolution=60, layerMin=0, layerMax=0, everyOther=True, maskScaleAlong=0.15,
     maskScaleAcross=0, maskPower=1, threshold=0.3, heightMin=0.92, heightMax=1, offset=v3(0, -0.02, 0.02), scaleMin=0.7, scaleMax=1.1, seed=7)
wire("plat", "stacks", "grove_spots", "curves")
node("grove", "structure/instance-on-points", C1 + 560, P0 + 480, randomFlip=True, seed=24)
wire("tree", "geometry", "grove", "geometry")
wire("grove_spots", "points", "grove", "points")
wire("grove_spots", "scales", "grove", "scales")

# Water — short ripples hatched across flat strata.
node("water", "curve/ridge-layers", C1, W0, profile="flat", width=13.375, height=1.725, sizeJitter=0.05137,
     layers=10, resolution=160, frequency=0.275, shrink=0, drop=0.09, chop=4.75, seed=30, location=v3(0, 0, 6.0300035189909895))
wire("w_anchors", "vectorList", "water", "anchors")
node("ripples", "curve/strata-hatch", C1 + 300, W0, count=70, length=0.15, jitter=0.01, distribution="center", resolution=160, seed=16)
wire("water", "stacks", "ripples", "stacks")
ink("ripple_ink", C1 + 560, W0, ("ripples", "curves"),
    width=0.01, minWidth=0.004, profile="sine", widthNoise=0.5, opacity=0.6, alphaJitter=0.6, zOffset=0, seed=17)

# ------------------------------------------------------------------ scroll
M0 = C1 + 900
node("scroll", "structure/merge", M0, Y0 + 200)
parts = ["dist_fill", "ripple_ink", "mount_fill", "mount_outline", "mount_tex", "rim_trees", "top_trees", "mid_trees",
         "plat_fill", "plat_outline", "plat_tex", "grove"]
for i, p in enumerate(parts):
    wire(p, "geometry", "scroll", f"in{i}")
node("strip", "structure/array", M0 + 260, Y0 + 200, mode="grid", gridRows=1, gridCols=3, spacingX=PERIOD, spacingY=0,
     plane="XY", centerGrid=True, count=3, visible=1)
wire("scroll", "geometry", "strip", "geometry")

node("time", "time", M0, Y0 + 640)
node("travel", "value/math", M0 + 220, Y0 + 640, op="multiply", a=0, b=PERIOD / SECONDS)
node("wrap", "value/math", M0 + 440, Y0 + 640, op="mod", a=0, b=PERIOD)
node("cam_pos", "vector/compose", M0 + 660, Y0 + 640, x=0, y=0.6, z=20)
wire("time", "seconds", "travel", "a")
wire("travel", "out", "wrap", "a")
wire("wrap", "out", "cam_pos", "x")
node("camera", "calibration/camera", M0 + 900, Y0 + 640, active=True, mode="manual", projectionType="perspective",
     location=v3(0, 0.6, 20), rotation=v3(0, 0, 0), useTarget=False, target=v3(0, 0, 0), up=v3(0, 1, 0), fov=27)
wire("cam_pos", "out", "camera", "location")

# ------------------------------------------------------------------ paper
node("env", "lighting/environment", M0 + 260, Y0 - 200, color=0xFFFFFF, intensity=1, background=1, blurriness=0, filePath="",
     backgroundImagePath="", backgroundFit="cover", backgroundScale=v3(1, 1, 1), backgroundOffset=v3(0, 0, 0), backgroundRotation=0,
     ambientIntensity=0, sunIntensity=0)
node("ink_tone", "postprocess/duotone", M0 + 260, Y0 - 420, shadowColor=0x2B2520, highlightColor=0xEDE2CA, balance=0.68, softness=0.75, amount=1)
node("paper", "postprocess/film-texture", M0 + 500, Y0 - 420, grain=0.06, dust=0.04, scratches=0, blotches=0.3, rate=0, seed=3)
wire("ink_tone", "effect", "paper", "effect")
node("render", "render", M0 + 760, Y0 - 200, frameCount=FPS * SECONDS, fps=FPS, motionBlur=0,
     resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
wire("env", "environment", "render", "environment")
wire("paper", "effect", "render", "postprocess")

empty = lambda: {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []}
canvas = {"nodes": nodes, "connections": conns, "keyframes": {}, "markers": [], "exposedParams": []}
with open(OUT, "w") as f:
    json.dump({"canvases": [canvas] + [empty() for _ in range(5)], "activeCanvas": 0}, f, indent=2)
    f.write("\n")
print(f"wrote {os.path.relpath(OUT, ROOT)}  ({len(nodes)} nodes, {len(conns)} wires)")
