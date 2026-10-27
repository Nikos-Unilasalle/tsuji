"""Generates proba_demo/large_numbers_coins.tsuji (law of large numbers). Usage: python3 proba_demo/gen_lln.py proba_demo/large_numbers_coins.tsuji"""
import json
import sys

out_path = sys.argv[1]
nodes, conns = [], []


def V(x=0, y=0, z=0):
    return {"x": x, "y": y, "z": z}


def node(nid, ntype, gx, gy, **params):
    nodes.append({"id": nid, "type": ntype, "position": {"x": gx, "y": gy}, "params": params})


def wire(a, sa, b, sb):
    conns.append({"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb})


def text(id, x, y, at, txt, size, color, shown_by=None):
    """Text of letter height `size`, centred on `at` (Text sizes in px: 64 px ≈ 1 unit)."""
    node(id, "object/text", x, y, visible=1, location=V(*at), rotation=V(), scale=V(1, 1, 1),
         text=txt, fontPreset="Poppins", fontSize=round(size / 0.015, 2), depth=0.001, color=color, shadeless=1)
    if shown_by:
        wire(shown_by, "value", id, "visible")


def expr(nid, gx, gy, formula, **params):
    node(nid, "math/expression", gx, gy, **{**dict(formula=formula, a=0, b=0, c=0, d=0, x=0, y=0, z=0), **params})


# Plot area: x = log10 n over 0..3 (10 world units), y = proportion of heads over 0..1 (6 units).
UX, UY = 10 / 3, 6.0
N_MAX = 1000
T_INTRO = 9.5         # scene 1 (the intro card) hands over to scene 2 (the graph) then
T_END = 9             # in scene 2, n reaches N_MAX at 9 s
# Axes scales its ticks and arrows by the mean of its units: divide it out.
LABEL = round(0.28 / ((UX + UY) / 2), 4)

def setting(frame_count, fov=20, target_y=3.3):
    """Background, render settings and camera."""
    node("env", "lighting/environment", -200, -400, color=0xFFFFFF, intensity=1, background=1, blurriness=0,
         filePath="", backgroundImagePath="", backgroundFit="cover", backgroundScale=V(1, 1, 1),
         backgroundOffset=V(), backgroundRotation=0, ambientIntensity=0.6, sunIntensity=0)
    node("render", "render", 60, -400, frameCount=frame_count, fps=30, motionBlur=0,
         resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
    wire("env", "environment", "render", "environment")
    node("cam", "calibration/camera", 320, -400, location=V(5.2, target_y, 30), rotation=V(), useTarget=True,
         target=V(5.2, target_y, 0), up=V(0, 1, 0), fov=fov, active=True, mode="manual", projectionType="orthographic")


# --- scene 1: the intro card ------------------------------------------------------
setting(int((T_INTRO + 0.5) * 30))
# Each block of the card appears at its time and stays (the title from the first frame, so the
# scene is never blank); at T_INTRO the card hands over to scene 2.
INTRO = [
    (0, 5.2, 6.9, 0.62, 0x222222, "Une pièce, encore et encore"),
    (1.3, 5.2, 5.5, 0.4, 0x333333, "On lance une pièce équilibrée :\npile ou face, une chance sur deux."),
    (3.3, 5.2, 4.0, 0.4, 0x333333, "Sur 10 lancers, on peut très bien obtenir 7 piles."),
    (5.0, 5.2, 3.1, 0.4, 0x1F6FEB, "Mais sur 1 000 lancers ?"),
    (6.5, 5.2, 1.7, 0.4, 0x333333, "Suivons la proportion de piles de cinq joueurs\nqui lancent chacun leur pièce."),
]
for k, (start, x, y, size, color, line) in enumerate(INTRO):
    expr(f"intro{k}Shown", -200, -150 + k * 180, "t >= a", a=start)
    text(f"intro{k}", 60, -150 + k * 180, (x, y, 0), line, size, color, shown_by=f"intro{k}Shown")
expr("handOver", -200, 800, "t >= a", a=T_INTRO)
node("toGraph", "canvas/goto", 60, 800, canvas=2, trigger=0, onlyWhilePlaying=True)
wire("handOver", "value", "toGraph", "trigger")

intro_canvas = {"nodes": nodes, "connections": conns, "keyframes": {}, "markers": [], "exposedParams": []}
nodes, conns = [], []

# --- scene 2: the graph ---------------------------------------------------------
# Wider than scene 1, to leave room for the coin piles on either side of the graph.
setting(int((T_END + 4) * 30), fov=25, target_y=3.6)
# Lights the coins only: lines and text are shadeless.
node("light", "light/point", 580, -400, location=V(5.2, 9, 12), rotation=V(), scale=V(1, 1, 1),
     color=0xFFFFFF, intensity=120, distance=60, decay=1.5, castShadow=0)
node("axes", "math/axes", -200, -200, dimension="2D", xMin=0, xMax=3.15, xStep=1, yMin=0, yMax=1.05, yStep=0.25,
     unit=V(UX, UY, 1), grid="xy", labels=False, piTicks=False, names="", labelSize=LABEL,
     arrows=True, axisColor=0x222222, gridColor=0xD5DCE4, axisWidth=2, gridWidth=1)

# --- shared inputs -------------------------------------------------------
# p: the probability of heads — the one knob exposed in the panel.
node("p", "math/expression", -1400, 0, formula="a", a=0.5, b=0, c=0, d=0, x=0, y=0, z=0)
# n grows exponentially, so it sweeps the log axis at a steady pace: 1 000 flips at t = 9 s.
expr("n", -1400, 200, f"max(2, min({N_MAX}, floor(2·10^(0.3 t))))")
# 1, 2, 3 … n — the running total of a list of ones.
node("ones", "list/random-list", -1150, 200, count=2, algorithm="uniform", seed=0, min=1, max=1)
wire("n", "value", "ones", "count")
node("counts", "list/math", -900, 200, op="cumulative_sum", b=0, factor=1, offset=0)
wire("ones", "list", "counts", "a")

# --- one series per seed -------------------------------------------------
COLORS = [0x1F6FEB, 0xE5484D, 0x30A46C, 0xF5A524, 0x8E4EC6]
for i, color in enumerate(COLORS):
    row = 500 + i * 260
    s = f"s{i + 1}"
    node(f"{s}_draws", "list/random-list", -1150, row, count=2, algorithm="uniform", seed=11 + 17 * i, min=0, max=1)
    wire("n", "value", f"{s}_draws", "count")
    # A uniform draw u gives heads (1) when u + p ≥ 1, which happens with probability p.
    node(f"{s}_flips", "math/expression", -900, row, formula="floor(x + a)", a=0.5, b=0, c=0, d=0, x=0, y=0, z=0)
    wire(f"{s}_draws", "list", f"{s}_flips", "x")
    wire("p", "value", f"{s}_flips", "a")
    node(f"{s}_heads", "list/math", -650, row, op="cumulative_sum", b=0, factor=1, offset=0)
    wire(f"{s}_flips", "list", f"{s}_heads", "a")
    # Point k of the curve: (log10 k, heads among the first k / k).
    node(f"{s}_points", "math/expression", -400, row, formula="(log10(y), x/y, 0)",
         a=0, b=0, c=0, d=0, x=0, y=0, z=0)
    wire(f"{s}_heads", "list", f"{s}_points", "x")
    wire("counts", "list", f"{s}_points", "y")
    node(f"{s}_curve", "curve/from_points", -150, row, type="linear", closed=False, tension=0.5, sag=0,
         visible=0, showPivot=False, pivot=V(), location=V(), rotation=V(), scale=V(1, 1, 1))
    wire(f"{s}_points", "list", f"{s}_curve", "points")
    node(f"{s}_line", "curve/to_line", 100, row, visible=1, location=V(), rotation=V(), scale=V(1, 1, 1),
         linewidth=2.5, dashed=False, worldUnits=False, color=color, emissive=0, emissiveIntensity=1,
         shadeless=1, roughness=0.4, metalness=0.1, wireframe=0, opacity=0.9)
    wire(f"{s}_curve", "curve", f"{s}_line", "curve")
    wire("axes", "space", f"{s}_line", "matrix")

# --- theory: p and the ±2σ/√n band ------------------------------------------
node("drawn", "math/expression", -900, -150, formula="log10(x)/3", a=0, b=0, c=0, d=0, x=0, y=0, z=0)
wire("n", "value", "drawn", "x")
CURVE = dict(mode="function", from_=0, to=3, samples=400, yMin=0, yMax=1.05, progress=1, visible=True,
             fill=False, fillFrom=0, fillTo=3, fillColor=0x888888, fillNegativeColor=0x888888, fillOpacity=0.15,
             a=0.5, b=0, c=0, d=0)
for cid, formula, color, width, dashed, row in [
    ("limit", "a", 0x222222, 2, True, -320),
    ("bandHigh", "a + 2 sqrt(a(1 − a)/10^x)", 0x9AA4B2, 1.5, False, -200),
    ("bandLow", "a − 2 sqrt(a(1 − a)/10^x)", 0x9AA4B2, 1.5, False, -80),
]:
    params = dict(CURVE, formula=formula, color=color, width=width, dashed=dashed)
    params["from"] = params.pop("from_")
    node(cid, "math/function-curve", -650, row, **params)
    wire("axes", "space", cid, "space")
    wire("p", "value", cid, "a")
    wire("drawn", "value", cid, "progress")

# --- labels ----------------------------------------------------------------
for k, label in enumerate(["1", "10", "100", "1 000"]):
    text(f"xTick{k}", 400, -200 + k * 90, (k * UX, -0.45, 0), label, 0.3, 0x555555)
for k, label in enumerate(["0", "0,25", "0,5", "0,75", "1"]):
    y = k * 0.25 * UY
    text(f"yTick{k}", 650, -200 + k * 90, (-0.55, y, 0), label, 0.3, 0x555555)
text("xName", 400, 280, (1.5 * UX, -1.05, 0), "nombre de lancers n", 0.32, 0x222222)
text("yName", 650, 280, (1.6, 1.05 * UY + 0.35, 0), "proportion de pile", 0.32, 0x222222)

node("title", "math/latex", 900, -320, visible=1, location=V(), rotation=V(), scale=V(1, 1, 1),
     tex=r"\overline{X}_n = \frac{X_1 + X_2 + \cdots + X_n}{n} \;\xrightarrow[\;n \to \infty\;]{}\; p",
     inline=False, size=0.42, align="center", valign="middle", at=V(6.2, 7.75, 0), progress=1,
     color=0x222222, opacity=1, faceCamera=False)

node("nText", "converter/value-to-text", 650, 420, value=0, decimals=0, prefix="n = ", suffix="")
wire("n", "value", "nText", "value")
text("nLabel", 900, 420, (8.6, 5.6, 0), "n", 0.42, 0x222222)
wire("nText", "text", "nLabel", "text")

node("lastHeads", "list/get-item", -400, 1800, index=-1)
wire("s1_heads", "list", "lastHeads", "list")
node("mean", "math/expression", 100, 1800, formula="x/y", a=0, b=0, c=0, d=0, x=0, y=0, z=0)
wire("lastHeads", "val", "mean", "x")
wire("n", "value", "mean", "y")
node("meanText", "converter/value-to-text", 400, 1800, value=0, decimals=4, prefix="série bleue : ", suffix="")
wire("mean", "value", "meanText", "value")
text("meanLabel", 650, 1800, (8.6, 5.0, 0), "moyenne", 0.36, COLORS[0])
wire("meanText", "text", "meanLabel", "text")

node("pText", "converter/value-to-text", 400, 2000, value=0, decimals=2, prefix="p = ", suffix="")
wire("p", "value", "pText", "value")
text("pLabel", 650, 2000, (8.6, 4.45, 0), "p", 0.36, 0x222222)
wire("pText", "text", "pLabel", "text")
node("bandLabel", "math/latex", 650, 2100, visible=1, location=V(), rotation=V(), scale=V(1, 1, 1),
     tex=r"\text{bande grise : } p \pm \frac{2\sigma}{\sqrt{n}}", inline=False, size=0.42, align="center",
     valign="middle", at=V(8.6, 0.95, 0), progress=1, color=0x7A8494, opacity=1, faceCamera=False)

# --- the blue series' coins: heads piled left of the graph, tails right ----------------
# One coin per flip, in columns of 125 marching outward from the graph. Alternate coins are a
# little narrower and every coin sits slightly off-centre, so each one reads in the column.
COIN_PITCH = 0.044
node("tails", "math/expression", 100, 2400, formula="y − x", a=0, b=0, c=0, d=0, x=0, y=0, z=0)
wire("lastHeads", "val", "tails", "x")
wire("n", "value", "tails", "y")
# Sized for the tallest possible pile, so both piles read their coins' scales from the same list.
node("coinIndex", "list/generate", -400, 2400, count=N_MAX, start=0, step=1)
node("coinScale", "math/expression", -150, 2400, formula="(0.84 (1 − 0.07 mod(x, 2)), 0.036, 0.84 (1 − 0.07 mod(x, 2)))",
     a=0, b=0, c=0, d=0, x=0, y=0, z=0)
wire("coinIndex", "list", "coinScale", "x")
for side, count_from, socket, x0, step, color, label_x, prefix in [
    ("heads", "lastHeads", "val", -1.9, 1, 0xD9A400, -3.9, "pile : "),
    ("tails", "tails", "value", 12.4, -1, 0xB4BAC4, 14.4, "face : "),
]:
    gy = 2600 if side == "heads" else 2900
    node(f"{side}Coin", "object/cylinder", -400, gy, visible=1, location=V(), rotation=V(), scale=V(1, 1, 1),
         heightSegments=1, color=color, emissive=0, emissiveIntensity=1, shadeless=0, roughness=0.35,
         metalness=0.6, wireframe=0, opacity=1, transmission=0, thickness=0.5)
    node(f"{side}Index", "list/generate", -400, gy + 150, count=0, start=0, step=1)
    wire(count_from, socket, f"{side}Index", "count")
    node(f"{side}Spots", "math/expression", -150, gy + 150,
         formula=f"(a − b floor(x/125) + 0.04 sin(12.9 x), {COIN_PITCH / 2} + {COIN_PITCH} mod(x, 125), 0.04 cos(7.3 x))",
         a=x0, b=step, c=0, d=0, x=0, y=0, z=0)
    wire(f"{side}Index", "list", f"{side}Spots", "x")
    node(f"{side}Pile", "structure/instance-on-points", 100, gy, visible=1, scaleMin=1, scaleMax=1,
         rotationJitter=0, axis="Y", randomFlip=False, seed=0)
    wire(f"{side}Coin", "geometry", f"{side}Pile", "geometry")
    wire(f"{side}Spots", "list", f"{side}Pile", "points")
    wire("coinScale", "list", f"{side}Pile", "scales")
    node(f"{side}Text", "converter/value-to-text", 100, gy + 150, value=0, decimals=0, prefix=prefix, suffix="")
    wire(count_from, socket, f"{side}Text", "value")
    text(f"{side}Label", 350, gy + 150, (label_x, 6.0, 0), side, 0.42, 0x222222)
    wire(f"{side}Text", "text", f"{side}Label", "text")

# The name comes last, once every curve has settled.
expr("named", 400, 2250, "t >= a", a=T_END + 0.5)
text("lawName", 650, 2250, (8.6, 1.75, 0), "Loi des grands nombres", 0.45, 0x222222, shown_by="named")

graph_canvas = {"nodes": nodes, "connections": conns, "keyframes": {}, "markers": [],
                "exposedParams": [{"nodeId": "p", "paramId": "a", "label": "p (probabilité de pile)"}]}
empty = {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []}
with open(out_path, "w") as f:
    json.dump({"canvases": [intro_canvas, graph_canvas] + [dict(empty) for _ in range(4)], "activeCanvas": 0}, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(len(intro_canvas["nodes"]), "+", len(nodes), "nodes")
