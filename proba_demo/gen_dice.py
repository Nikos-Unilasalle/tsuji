"""Generates proba_demo/bell_curve_dice.tsuji — from one die to the bell curve, in six scenes. Usage: python3 proba_demo/gen_dice.py proba_demo/bell_curve_dice.tsuji"""
import json
import math
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
from dicelib import Canvas, V, exact_pmf, place_dice, ramp, rest_rotation, roll_engine  # noqa: E402

out_path = sys.argv[1]

CREAM, AMBER, CYAN, ROSE = 0xF1F5F9, 0xFBBF24, 0x38BDF8, 0xFB7185
COLUMN_COLORS = [0x22D3EE, 0x38BDF8, 0x60A5FA, 0x818CF8, 0xA78BFA, 0xC084FC]


def scene_one_die():
    """Scene 2 — one die, rolled slowly then faster and faster; its six columns stay level."""
    c = Canvas()
    START, SLOW, N_SLOW, FAST, N_MAX = 1.6, 1.1, 8, 5.0, 600
    T_FAST = START + SLOW * N_SLOW            # the montage starts
    T_DONE = T_FAST + FAST                    # all N_MAX rolls are in
    END = T_DONE + 5.0
    DIE_X, X0, STEP, H = -3.7, -0.6, 1.3, 4.2
    c.setting(END, cam_loc=(1.2, 4.6, 14.5), cam_target=(1.2, 2.4, 0), fov=32, cam_drift=(0, -0.2, -0.7))

    # --- the rolls: φ counts throws; roll k is in the air for φ ∈ [k, k + 0.7) and lands at k + 0.7.
    c.section()
    # Capped just short of N_MAX so the last roll ends at rest rather than back in the air.
    c.expr("phase", f"min({N_MAX} − 0.001, t < a ? max(0, (t − c)/b) : {N_SLOW} + {N_MAX - N_SLOW}·min(1, (t − a)/d)^2.5)",
           a=T_FAST, b=SLOW, c=START, d=FAST)
    c.expr("thrown", f"min({N_MAX - 1}, floor(x))", x=("phase", "value"))
    c.expr("landed", f"min({N_MAX}, floor(x + 0.3))", x=("phase", "value"))
    # Before the first throw the die waits on the table (at rest = late in a roll).
    c.expr("u", "t < a ? 0.99 : x − floor(x)", x=("phase", "value"), a=START)
    # Slow rolls tumble fully; in the montage the die only flicks between results.
    c.expr("calm", "t < a ? 1 : max(0.12, 1 − (t − a)/1.2)", a=T_FAST)
    c.expr("drawCount", "x + 1", x=("thrown", "value"))
    c.node("draws", "list/random-list", count=1, algorithm="uniform", seed=6, min=0, max=1)
    c.wire("drawCount", "value", "draws", "count")
    c.expr("faces", "floor(6 x) + 1", x=("draws", "list"))
    c.node("landedFaces", "list/slice", start=0, count=0)
    c.wire("faces", "list", "landedFaces", "list")
    c.wire("landed", "value", "landedFaces", "count")
    c.node("hist", "list/histogram", bins=6, min=0.5, max=6.5, scale="count")
    c.wire("landedFaces", "list", "hist", "list")
    c.node("current", "list/get-item", index=0)
    c.wire("faces", "list", "current", "list")
    c.wire("thrown", "value", "current", "index")
    c.node("lastLanded", "list/get-item", index=-1)
    c.wire("landedFaces", "list", "lastLanded", "list")

    # --- the die: tumbles along an arc with shrinking bounces, comes to rest on the drawn face.
    asset = c.die_asset()
    c.section()
    p = "min(x/0.7, 1)"
    c.expr("diePos", f"(a − 0.9 (1 − {p})·y, 0.5 + 2.2 (1 − {p})²·|cos(2.5π {p})|·y, 0.35 (1 − {p})·y)",
           a=DIE_X, x=("u", "value"), y=("calm", "value"))
    rx, ry, rz = rest_rotation("z", "28 sin(12.9 c)")
    spin = f"(1 − {p})^3·y"
    c.expr("dieRot", f"({rx} + 640 {spin}, {ry} + 420 {spin}, {rz} + 530 {spin})",
           x=("u", "value"), y=("calm", "value"), z=("current", "val"), c=("thrown", "value"))
    c.node("dieRoll", "structure/instance-on-points", visible=1, scaleMin=1, scaleMax=1, rotationJitter=0,
           axis="Y", randomFlip=False, seed=0)
    c.wire(asset, "geometry", "dieRoll", "geometry")
    c.wire("diePos", "list", "dieRoll", "points")
    c.wire("dieRot", "list", "dieRoll", "rotations")

    # --- the histogram: one glowing block per landed roll, in its face's column. The whole stack
    # rescales so the tallest column stays H high — the heights stay proportional to the counts.
    c.section()
    c.expr("block", f"{H} / max(x, 6)", x=("hist", "peak"))
    c.expr("settle", "clamp((x − 0.7)/0.3, 0, 1)", x=("u", "value"))
    for j in range(1, 7):
        xj = X0 + (j - 1) * STEP
        c.section()
        c.node(f"count{j}", "list/get-item", index=j - 1)
        c.wire("hist", "counts", f"count{j}", "list")
        # The block just landed falls into place while the die rests (slow rolls only).
        c.expr(f"drop{j}", f"(x == {j})·z·3.5·(1 − y)²", x=("lastLanded", "val"), y=("settle", "value"),
               z=("calm", "value"))
        c.node(f"stack{j}", "list/generate", count=0, start=0, step=1)
        c.wire(f"count{j}", "val", f"stack{j}", "count")
        c.expr(f"spots{j}", f"({xj}, (x + 0.5)·z + (x == y − 1)·a, 0)", x=(f"stack{j}", "list"),
               y=(f"count{j}", "val"), z=("block", "value"), a=(f"drop{j}", "value"))
        c.expr(f"sizes{j}", "(0.98, 0.86 z, 0.72)", x=(f"stack{j}", "list"), z=("block", "value"))
        col = COLUMN_COLORS[j - 1]
        c.node(f"brick{j}", "object/box", visible=1, location=V(), rotation=V(), scale=V(1, 1, 1),
               color=col, emissive=col, emissiveIntensity=0.35, shadeless=0, roughness=0.6, metalness=0.1,
               wireframe=0, opacity=1, transmission=0, thickness=0.5)
        c.node(f"column{j}", "structure/instance-on-points", visible=1, scaleMin=1, scaleMax=1,
               rotationJitter=0, axis="Y", randomFlip=False, seed=0)
        c.wire(f"brick{j}", "geometry", f"column{j}", "geometry")
        c.wire(f"spots{j}", "list", f"column{j}", "points")
        c.wire(f"sizes{j}", "list", f"column{j}", "scales")
        # The face under its column, lying on the floor.
        c.node(f"face{j}", "object/text", visible=1, location=V(xj, 0.28, 1.3), rotation=V(),
               scale=V(1, 1, 1), text=str(j), fontPreset="Poppins", fontSize=round(0.42 / 0.015, 2),
               depth=0.001, faceCamera=False, color=CREAM, shadeless=1)

    # --- one sixth of the rolls: where every column should stand.
    c.section()
    mid = X0 + 2.5 * STEP
    c.expr("expected", "(a, (y/6)·z, 0.5)", a=mid, y=("landed", "value"), z=("block", "value"))
    c.node("levelBar", "object/box", visible=1, location=V(), rotation=V(), scale=V(STEP * 6 + 0.4, 0.035, 0.035),
           color=AMBER, emissive=AMBER, emissiveIntensity=2.2, shadeless=1, roughness=1, metalness=0,
           wireframe=0, opacity=1, transmission=0, thickness=0.5)
    c.expr("levelShown", "t >= a", a=T_FAST + 1.0)
    c.node("level", "structure/instance-on-points", visible=1, scaleMin=1, scaleMax=1, rotationJitter=0,
           axis="Y", randomFlip=False, seed=0)
    c.wire("levelBar", "geometry", "level", "geometry")
    c.wire("expected", "list", "level", "points")
    c.wire("levelShown", "value", "level", "visible")
    c.expr("expectedTag", "(a, (y/6)·z + 0.3, 0.5)", a=X0 - 1.05, y=("landed", "value"),
           z=("block", "value"))
    c.node("tagText", "object/text", visible=1, location=V(), rotation=V(), scale=V(1, 1, 1), text="1/6",
           fontPreset="Poppins", fontSize=round(0.42 / 0.015, 2), depth=0.001, faceCamera=False,
           color=AMBER, shadeless=1)
    c.node("tag", "structure/instance-on-points", visible=1, scaleMin=1, scaleMax=1, rotationJitter=0,
           axis="Y", randomFlip=False, seed=0)
    c.wire("tagText", "geometry", "tag", "geometry")
    c.wire("expectedTag", "list", "tag", "points")
    c.wire("levelShown", "value", "tag", "visible")

    # --- words
    c.section()
    c.text("title", (1.2, 6.6, -6), "Un dé", 0.95, CREAM, show=0.2)
    c.text("rule", (1.2, 5.75, -6), "six faces, une chance sur six chacune", 0.44, CYAN, show=0.7, hide=T_DONE)
    c.text("verdict", (1.2, 5.75, -6), "aucune face n'est favorisée : la répartition est plate", 0.44, AMBER,
           show=T_DONE + 0.3)
    c.node("rollsText", "converter/value-to-text", value=0, decimals=0, prefix="lancers : ", suffix="")
    c.wire("landed", "value", "rollsText", "value")
    c.text("rolls", (DIE_X + 0.3, 3.75, 0), "lancers", 0.36, CREAM, wire_text=("rollsText", "text"))
    hand_over(c, END, 3)
    return c, END



def hand_over(c, end, next_scene):
    """Go To Canvas `next_scene` (1-based) when this scene's time runs out."""
    c.section()
    c.expr("handOver", "t >= a", a=end - 0.15)
    c.node("next", "canvas/goto", canvas=next_scene, trigger=0, onlyWhilePlaying=True)
    c.wire("handOver", "value", "next", "trigger")


SUM_COLORS = [0x22D3EE, 0x2DD4BF, 0x38BDF8, 0x60A5FA, 0x818CF8, 0xA78BFA, 0x818CF8, 0x60A5FA, 0x38BDF8, 0x2DD4BF, 0x22D3EE]


def captions(c, lines, at, height=0.44):
    """Captions shown one after another in the same place: (start, end, text, colour)."""
    for k, (a, b, txt, col) in enumerate(lines):
        c.text(f"cap{k}", at, txt, height, col, show=a, hide=b)


def scene_title():
    """Scene 1 — one big die turning slowly in the dark; the question."""
    c = Canvas()
    END = 7.0
    c.setting(END, cam_loc=(0, 3.4, 12), cam_target=(0, 2.6, 0), fov=30, cam_drift=(0, 0.2, -1.2))
    asset = c.die_asset()
    c.section()
    c.expr("float", "(0, 2.35 + 0.12 sin(1.3 t), 0)")
    c.expr("turn", "(24 t + 18, 41 t + 30, 13 t)")
    c.node("hero", "structure/instance-on-points", visible=1, scaleMin=1.7, scaleMax=1.7, rotationJitter=0,
           axis="Y", randomFlip=False, seed=0)
    c.wire(asset, "geometry", "hero", "geometry")
    c.wire("float", "list", "hero", "points")
    c.wire("turn", "list", "hero", "rotations")
    c.section()
    c.text("title", (0, 5.6, -4), "Le hasard a-t-il une forme ?", 0.85, CREAM, show=0.6)
    c.text("sub", (0, 4.75, -4), "une expérience avec des dés", 0.42, CYAN, show=1.8)
    c.text("hint", (0, 4.05, -4), "du dé seul à la courbe en cloche", 0.3, 0x94A3B8, show=3.2)
    hand_over(c, END, 2)
    return c, END


def scene_two_dice():
    """Scene 3 — the 36 pairs fall into a triangle; real throws of two dice fill the same shape."""
    c = Canvas()
    D = 0.62
    W = D / math.sqrt(2)
    CX, CY = 2.2, 2.6
    T_ROT, T_FALL, T_ROLL = 7.0, 9.0, 12.5
    t_fast = None
    c.setting(26, cam_loc=(1.0, 4.4, 14.0), cam_target=(1.0, 2.4, 0), fov=32, cam_drift=(0, -0.2, -0.8))
    c.section()
    c.expr("turnIn", "clamp((t − a)/1.6, 0, 1)^2·(3 − 2 clamp((t − a)/1.6, 0, 1))", a=T_ROT)
    c.expr("fallIn", "clamp((t − a)/1.3, 0, 1)^2·(3 − 2 clamp((t − a)/1.3, 0, 1))", a=T_FALL)
    c.expr("ghost", "1 − 0.8 clamp((t − a)/1.0, 0, 1)", a=T_ROLL + 0.5)
    for s in range(2, 13):
        n = 6 - abs(s - 7)
        lo = max(1, s - 6)
        col = SUM_COLORS[s - 2]
        c.section()
        c.node(f"rank{s}", "list/generate", count=n, start=0, step=1)
        a = f"({lo} + x)"
        b = f"({s} − {lo} − x)"
        pp, qq = f"(({a} − 3.5)·{D})", f"(({b} − 3.5)·{D})"
        th = "(−π/4·y)"
        rx = f"({CX} + {pp} cos{th} − {qq} sin{th})"
        ry = f"({CY} + {pp} sin{th} + {qq} cos{th})"
        c.expr(f"spot{s}", f"({rx}, {ry} + ((x + 0.5)·{W:.4f} − {ry})·z, 0)",
               x=(f"rank{s}", "list"), y=("turnIn", "value"), z=("fallIn", "value"))
        c.expr(f"tilt{s}", "(0, 0, −45·y·(1 − z))", x=(f"rank{s}", "list"), y=("turnIn", "value"), z=("fallIn", "value"))
        k = f"(({a} − 1)·6 + {b} − 1)"
        size = f"clamp((t − 1.4 − 0.06 {k})/0.3, 0, 1)·({0.9 * D:.4f} + {0.92 * W - 0.9 * D:.4f} z)"
        c.expr(f"size{s}", f"({size}, {size}, 0.14)", x=(f"rank{s}", "list"), z=("fallIn", "value"))
        c.node(f"tileMat{s}", "material/standard", color=col, emissive=col, emissiveIntensity=0.45, shadeless=0,
               roughness=0.45, metalness=0.05, wireframe=0, opacity=1, transmission=0, thickness=0)
        c.wire("ghost", "value", f"tileMat{s}", "opacity")
        c.node(f"tile{s}", "object/box", visible=1, location=V(), rotation=V(), scale=V(1, 1, 1), color=col)
        c.wire(f"tileMat{s}", "material", f"tile{s}", "material")
        c.node(f"tiles{s}", "structure/instance-on-points", visible=1, scaleMin=1, scaleMax=1, rotationJitter=0,
               axis="Y", randomFlip=False, seed=0)
        c.wire(f"tile{s}", "geometry", f"tiles{s}", "geometry")
        c.wire(f"spot{s}", "list", f"tiles{s}", "points")
        c.wire(f"tilt{s}", "list", f"tiles{s}", "rotations")
        c.wire(f"size{s}", "list", f"tiles{s}", "scales")
        c.text(f"sum{s}", (CX + (s - 7) * W, 0.22, 1.3), str(s), 0.3, CREAM, show=T_FALL + 1.0)
    # Axis names of the grid while it is a grid.
    c.text("die1", (CX, CY - 3.5 * D - 0.12, 0), "dé 1", 0.3, 0x94A3B8, show=2.0, hide=T_ROT)
    c.text("die2", (CX - 3.5 * D - 0.55, CY, 0), "dé 2", 0.3, 0x94A3B8, show=2.0, hide=T_ROT)

    # Real throws of two dice, whose frequencies × 36 stand on the same scale as the tiles.
    t_fast = roll_engine(c, "r", 2, start=T_ROLL, slow=1.0, n_slow=4, fast=5.0, n_max=1200, seed0=31)
    t_done = t_fast + 5.0
    end = t_done + 4.5
    place_dice(c, "r", c.die_asset(), [(-3.9, 0.2), (-2.6, -0.3)], size=0.85)
    c.section()
    c.node("hist", "list/histogram", bins=11, min=1.5, max=12.5, scale="count")
    c.wire("rSums", "list", "hist", "list")
    # Share of the throws × 36 — but over at least 60 throws, so the first few grow as counts
    # instead of shooting up to 1/2 or 1/3 of everything.
    c.expr("per36", "36 / max(x, 60)", x=("rLanded", "value"))
    c.node("hist36", "list/math", op="multiply", b=1, factor=1, offset=0)
    c.wire("hist", "counts", "hist36", "a")
    c.wire("per36", "value", "hist36", "b")
    c.expr("barsShown", "t >= a", a=T_ROLL + 0.7)
    c.node("bars", "object/bar_graph", visible=1, location=V(CX, 0, 0.32), rotation=V(), scale=V(1, 1, 1),
           count=11, spacing=round(0.24 * W, 4), barWidth=round(0.76 * W, 4), maxHeight=round(W, 4),
           barDepth=0.1, alignment="center", showLabels=0, labelPosition="above", labelDecimals=1,
           color=AMBER, emissive=AMBER, emissiveIntensity=0.5, shadeless=0, roughness=0.5, metalness=0,
           wireframe=0, opacity=0.92, transmission=0, thickness=0.5)
    c.wire("hist36", "list", "bars", "values")
    c.wire("barsShown", "value", "bars", "visible")
    c.node("rollsText", "converter/value-to-text", value=0, decimals=0, prefix="lancers : ", suffix="")
    c.wire("rLanded", "value", "rollsText", "value")
    c.text("rolls", (-3.25, 3.5, 0), "lancers", 0.34, CREAM, show=T_ROLL, wire_text=("rollsText", "text"))
    c.section()
    c.text("title", (1.0, 6.5, -6), "Deux dés", 0.95, CREAM, show=0.2)
    captions(c, [
        (0.8, 4.0, "on additionne les deux faces : de 2 à 12", CYAN),
        (4.0, T_ROT + 0.4, "36 couples (dé 1, dé 2), tous aussi probables", CYAN),
        (T_ROT + 0.4, T_FALL + 1.6, "rangeons-les par somme…", CYAN),
        (T_FALL + 1.6, T_ROLL + 1.2, "7 s'obtient de 6 façons, 2 et 12 d'une seule", AMBER),
        (T_ROLL + 1.2, t_done, "les vrais lancers dessinent le même triangle", CYAN),
        (t_done + 0.2, 99, "la somme favorise le milieu", AMBER),
    ], (1.0, 5.65, -6))
    hand_over(c, end, 4)
    c.set_end(end)
    return c, end


def scene_many_dice(n_dice, next_scene, spots, size, step, peak, n_max, steady, title, lines, gauss):
    """Scenes 4 and 5 — n dice thrown thousands of times; the histogram of their sum."""
    c = Canvas()
    lo, hi = n_dice, 6 * n_dice
    bins = hi - lo + 1
    mid = (lo + hi) / 2
    CX = 2.6
    max_h = 4.0 / peak
    c.setting(24, cam_loc=(0.8, 4.6, 14.5), cam_target=(0.8, 2.4, 0), fov=32, cam_drift=(0, -0.2, -0.8))
    t_fast = roll_engine(c, "r", n_dice, start=1.6, slow=1.1, n_slow=4, fast=6.0, n_max=n_max, seed0=50 + n_dice)
    t_done = t_fast + 6.0
    end = t_done + (7.0 if gauss else 4.5)
    place_dice(c, "r", c.die_asset(), spots, size=size)
    c.section()
    c.node("hist", "list/histogram", bins=bins, min=lo - 0.5, max=hi + 0.5, scale="count")
    c.wire("rSums", "list", "hist", "list")
    # Share of the throws, over at least `steady` throws: the first ones grow as counts.
    c.expr("share", f"1 / max(x, {steady})", x=("rLanded", "value"))
    c.node("shares", "list/math", op="multiply", b=1, factor=1, offset=0)
    c.wire("hist", "counts", "shares", "a")
    c.wire("share", "value", "shares", "b")
    c.node("bars", "object/bar_graph", visible=1, location=V(CX, 0, 0), rotation=V(), scale=V(1, 1, 1),
           count=bins, spacing=round(0.18 * step, 4), barWidth=round(0.82 * step, 4), maxHeight=round(max_h, 3),
           barDepth=round(min(0.5, 2.5 * step), 3), alignment="center", showLabels=0, labelPosition="above",
           labelDecimals=1, color=0x60A5FA, emissive=0x60A5FA, emissiveIntensity=0.45, shadeless=0, roughness=0.5,
           metalness=0, wireframe=0, opacity=1, transmission=0, thickness=0.5)
    c.node("palette", "list/color-palette", count=bins, ramp=ramp(0x22D3EE, 0x818CF8, 0xC084FC, 0x818CF8, 0x22D3EE))
    c.wire("shares", "list", "bars", "values")
    c.wire("palette", "list", "bars", "colors")
    # Sums under the bars, every five.
    for s in range(lo, hi + 1):
        if s % 5 == 0 or s in (lo, hi):
            c.text(f"sum{s}", (CX + (s - mid) * step, 0.2, 1.1), str(s), 0.26, 0x94A3B8, show=0.8)
    # Hidden axes: math x = the sum, math y = the share of throws, on the bars' scale.
    c.section()
    c.node("axes", "math/axes", visible=0, location=V(CX - mid * step, 0, 0.3), dimension="2D", xMin=lo - 1,
           xMax=hi + 1, xStep=1, yMin=0, yMax=peak * 1.3, yStep=0.01, unit=V(step, max_h, 1), grid="none",
           labels=False, piTicks=False, names="", labelSize=0.01, arrows=False, axisColor=0x222222,
           gridColor=0x222222, axisWidth=1, gridWidth=1)
    if gauss:
        var = 35 * n_dice / 12
        c.expr("drawGauss", "clamp((t − a)/2.2, 0, 1)", a=t_done + 0.4)
        c.node("gauss", "math/function-curve", mode="function", formula="exp(−(x − a)²/(2b)) / sqrt(2π b)",
               **{"from": lo - 1}, to=hi + 1, samples=500, yMin=0, yMax=peak * 1.3, progress=0, visible=True,
               fill=False, fillFrom=lo, fillTo=hi, fillColor=AMBER, fillNegativeColor=AMBER, fillOpacity=0.1,
               a=mid, b=var, c=0, d=0, color=AMBER, width=4.5, dashed=False)
        c.wire("axes", "space", "gauss", "space")
        c.wire("drawGauss", "value", "gauss", "progress")
        c.node("formula", "math/latex", visible=1, location=V(), rotation=V(), scale=V(1, 1, 1),
               tex=r"\mathcal{N}\left(\mu = 35,\ \sigma^2 = \tfrac{350}{12} \approx 29{,}2\right)", inline=False,
               size=0.42, align="center", valign="middle", at=V(CX + 2.6, 4.75, -1), progress=0, color=AMBER,
               opacity=1, faceCamera=False)
        c.wire("drawGauss", "value", "formula", "progress")
    else:
        # The exact law of the sum, as a staircase over the bars.
        c.expr("drawExact", "clamp((t − a)/1.8, 0, 1)", a=t_done + 0.3)
        c.node("exact", "math/function-curve", mode="function", formula=exact_pmf(n_dice, "round(x)"),
               **{"from": lo - 0.5}, to=hi + 0.5, samples=1200, yMin=0, yMax=peak * 1.3, progress=0, visible=True,
               fill=False, fillFrom=lo, fillTo=hi, fillColor=CREAM, fillNegativeColor=CREAM, fillOpacity=0.1,
               a=0, b=0, c=0, d=0, color=CREAM, width=2.5, dashed=False)
        c.wire("axes", "space", "exact", "space")
        c.wire("drawExact", "value", "exact", "progress")
    c.node("rollsText", "converter/value-to-text", value=0, decimals=0, prefix="lancers : ", suffix="")
    c.wire("rLanded", "value", "rollsText", "value")
    c.text("rolls", (spots[len(spots) // 2][0] + 0.9, 3.3, 0), "lancers", 0.34, CREAM, wire_text=("rollsText", "text"))
    c.section()
    c.text("title", (0.8, 6.5, -6), title, 0.95, CREAM, show=0.2)
    captions(c, [(a, b if b else 99, txt, col) for a, b, txt, col in lines(t_done)], (0.8, 5.65, -6))
    hand_over(c, end, next_scene)
    c.set_end(end)
    return c, end


def scene_finale():
    """Scene 6 — every sum, recentred and rescaled, on one set of axes: the same bell."""
    c = Canvas()
    END = 19.0
    c.setting(END, cam_loc=(0, 3.2, 13), cam_target=(0, 2.55, 0), fov=32, cam_drift=(0, 0, -0.6))
    UX, UY = 1.25, 9.5
    c.section()
    c.node("axes", "math/axes", visible=1, location=V(0, 0.15, 0), dimension="2D", xMin=-4.2, xMax=4.4, xStep=1,
           yMin=0, yMax=0.44, yStep=0.1, unit=V(UX, UY, 1), grid="none", labels=False, piTicks=False, names="",
           labelSize=round(0.28 / ((UX + UY) / 2), 4), arrows=True, axisColor=0x64748B, gridColor=0x334155,
           axisWidth=1.5, gridWidth=1)
    curves = [(1, 0x22D3EE, 1.5, "1 dé"), (2, 0x60A5FA, 3.6, "2 dés"), (5, 0xA78BFA, 5.7, "5 dés"), (10, ROSE, 7.8, "10 dés")]
    for k, (n, col, at, label) in enumerate(curves):
        mu, sigma = 3.5 * n, math.sqrt(35 * n / 12)
        # The law of the sum S of n dice, as the density of Z = (S − μ)/σ: a staircase of steps 1/σ wide.
        pmf = exact_pmf(n, f"round({mu} + {sigma:.6f} x)")
        c.expr(f"draw{n}", "clamp((t − a)/1.4, 0, 1)", a=at)
        c.node(f"law{n}", "math/function-curve", mode="function", formula=f"{sigma:.6f}·{pmf}", **{"from": -4.2},
               to=4.2, samples=1400, yMin=0, yMax=0.5, progress=0, visible=True, fill=False, fillFrom=0, fillTo=0,
               fillColor=col, fillNegativeColor=col, fillOpacity=0.1, a=0, b=0, c=0, d=0, color=col, width=2.5,
               dashed=False)
        c.wire("axes", "space", f"law{n}", "space")
        c.wire(f"draw{n}", "value", f"law{n}", "progress")
        c.text(f"tag{n}", (-4.6, 4.3 - 0.45 * k, 0), label, 0.3, col, show=at)
    c.expr("drawBell", "clamp((t − a)/2.0, 0, 1)", a=10.0)
    c.node("bell", "math/function-curve", mode="function", formula="exp(−x²/2)/sqrt(2π)", **{"from": -4.2}, to=4.2,
           samples=500, yMin=0, yMax=0.5, progress=0, visible=True, fill=True, fillFrom=-4.2, fillTo=4.2,
           fillColor=AMBER, fillNegativeColor=AMBER, fillOpacity=0.12, a=0, b=0, c=0, d=0, color=AMBER, width=5,
           dashed=False)
    c.wire("axes", "space", "bell", "space")
    c.wire("drawBell", "value", "bell", "progress")
    # The shaded area follows the pen: from the left end to where the curve has been drawn.
    c.expr("bellFillTo", "−4.2 + 8.4 x", x=("drawBell", "value"))
    c.wire("bellFillTo", "value", "bell", "fillTo")
    c.node("bellTex", "math/latex", visible=1, location=V(), rotation=V(), scale=V(1, 1, 1),
           tex=r"\varphi(z) = \frac{1}{\sqrt{2\pi}}\, e^{-z^2/2}", inline=False, size=0.4, align="center",
           valign="middle", at=V(3.6, 4.0, 0), progress=0, color=AMBER, opacity=1, faceCamera=False)
    c.wire("drawBell", "value", "bellTex", "progress")
    c.text("zAxis", (0, -0.45, 0.6), "écart à la moyenne, en écarts-types", 0.26, 0x94A3B8, show=1.0)
    c.section()
    c.text("title", (0, 6.5, -6), "Toutes les sommes, à la même échelle", 0.8, CREAM, show=0.2, hide=12.4)
    c.text("theorem", (0, 6.5, -6), "Théorème central limite", 0.95, AMBER, show=12.8, emissive=0.6)
    captions(c, [
        (0.9, 12.4, "on recentre chaque somme et on la divise par son écart-type", CYAN),
        (13.4, 99, "additionnez des hasards indépendants : la somme dessine une cloche", CREAM),
    ], (0, 5.65, -6))
    return c, END


def empty():
    return {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []}


title, t1 = scene_title()
one, t2 = scene_one_die()
two, t3 = scene_two_dice()
five, t4 = scene_many_dice(
    5, 5, [(-5.0 + 0.78 * i, 0.4 * (i % 2) - 0.4) for i in range(5)], 0.62, 0.3, 0.1003, 3000, 150, "Cinq dés",
    lambda done: [(0.8, done, "la somme va de 5 à 30", CYAN),
                  (done + 0.2, None, "la bosse s'arrondit : la loi exacte en blanc", AMBER)], gauss=False)
ten, t5 = scene_many_dice(
    10, 6, [(-4.9 + 0.64 * (i % 5), -1.2 + 0.85 * (i // 5)) for i in range(10)], 0.5, 0.17, 0.0727, 4000, 300, "Dix dés",
    lambda done: [(0.8, done, "la somme va de 10 à 60", CYAN),
                  (done + 0.2, None, "la courbe de Gauss de même moyenne et même variance", AMBER)], gauss=True)
finale, t6 = scene_finale()
canvases = [x.out() for x in (title, one, two, five, ten, finale)]
with open(out_path, "w") as f:
    json.dump({"canvases": canvases, "activeCanvas": 0}, f, indent=2, ensure_ascii=False)
    f.write("\n")
for name, x, t in [("titre", title, t1), ("1 dé", one, t2), ("2 dés", two, t3), ("5 dés", five, t4), ("10 dés", ten, t5), ("finale", finale, t6)]:
    print(f"{name}: {len(x.nodes)} nodes, {t:.1f} s")
