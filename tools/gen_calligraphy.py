#!/usr/bin/env python3
"""Generate a calligraphy demo — a character written stroke by stroke with
p5.brush: a Grease Pencil drawing (as if traced with a tablet) fed through
Write On into Brush Canvas, with a dilute ink wash rising under each stroke
once it is written (Stroke Outline and Stroke Style into a second Brush
Canvas, multiplied under the ink).

Two stroke sources, both giving each stroke's centreline in stroke order:

- KanjiVG (https://kanjivg.tagaini.net), Japanese stroke order, © Ulrich Apel,
  CC BY-SA 3.0. Centrelines only, so pressure comes from each stroke's
  type — a horizontal pressed at both ends, a vertical drawn out to a needle,
  a dot landing light and pressing, the long sweep swelling then lifting —
  plus a press at every corner. 辻 (tsuji) is embedded below, so the default
  demo builds offline. The demo file it writes carries KanjiVG data and is
  therefore CC BY-SA 3.0, unlike the rest of Tsuji (MIT).
- Make Me a Hanzi (https://github.com/skishore/makemeahanzi), Chinese, stroke
  graphics derived from Arphic PL fonts (Arphic Public License). Each stroke
  also has its outline, so pressure is measured: twice the distance from the
  median to the outline is the width of the real brush mark at that point.
  永 is embedded below.

Usage:
  tools/gen_calligraphy.py                 # 辻, KanjiVG
  tools/gen_calligraphy.py yong            # 永, Make Me a Hanzi
  tools/gen_calligraphy.py char.svg        # any KanjiVG file
  tools/gen_calligraphy.py char.json       # any hanzi-writer-data file
"""
import json, math, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMOS = os.path.join(ROOT, "public/demos")

YONG = {
    "strokes": [
        "M 440 788 Q 497 731 535 718 Q 553 717 562 732 Q 569 748 564 767 Q 546 815 477 828 Q 438 841 421 834 Q 414 831 418 817 Q 421 804 440 788 Z",
        "M 532 448 Q 532 547 546 570 Q 559 589 546 601 Q 524 620 486 636 Q 462 645 413 615 Q 371 599 306 589 Q 290 588 299 578 Q 309 568 324 562 Q 343 558 370 565 Q 406 575 441 587 Q 460 594 467 584 Q 473 566 475 538 Q 482 271 470 110 Q 469 80 459 67 Q 453 61 369 82 Q 342 95 344 79 Q 411 27 450 -13 Q 463 -32 480 -38 Q 490 -42 499 -32 Q 541 16 540 77 Q 533 207 532 403 L 532 448 Z",
        "M 117 401 Q 104 401 102 392 Q 101 385 117 377 Q 163 352 192 363 Q 309 397 320 395 Q 333 392 323 365 Q 280 256 240 205 Q 200 147 126 86 Q 111 73 122 71 Q 132 70 153 80 Q 220 114 275 172 Q 327 224 394 362 Q 404 384 416 397 Q 431 409 422 419 Q 412 432 374 445 Q 353 455 305 434 Q 215 412 117 401 Z",
        "M 567 407 Q 639 452 745 526 Q 767 542 793 552 Q 817 562 806 582 Q 793 601 765 618 Q 740 634 725 632 Q 712 631 715 616 Q 719 582 641 505 Q 601 465 556 420 C 535 399 542 391 567 407 Z",
        "M 556 420 Q 543 436 532 448 C 512 470 515 427 532 403 Q 737 114 799 116 Q 871 126 933 135 Q 960 138 960 145 Q 961 152 930 165 Q 777 217 733 253 Q 678 296 567 407 L 556 420 Z",
    ],
    "medians": [
        [[428, 824], [503, 781], [533, 756], [539, 741]],
        [[309, 579], [358, 580], [462, 613], [482, 608], [508, 581], [505, 121], [500, 59], [478, 24], [355, 78]],
        [[110, 391], [149, 384], [198, 387], [322, 418], [339, 417], [367, 402], [345, 333], [273, 208], [201, 129], [125, 78]],
        [[725, 621], [743, 596], [749, 578], [743, 570], [656, 489], [569, 421], [569, 415]],
        [[532, 441], [551, 399], [568, 378], [678, 259], [750, 194], [801, 163], [954, 145]],
    ],
}

# Make Me a Hanzi draws in a 1024 em square, y up, baseline at 900 - 1024.
CENTER = (512, 388)
UNITS = 200.0  # em units per world unit: the character is ~5 world units tall
STEP = 12.0  # em units between resampled median points

# KanjiVG draws in a 109 unit square, y down.
KVG_CENTER = (54.5, 54.5)
KVG_UNITS = 20.0
KVG_STEP = 1.2

TSUJI = [  # KanjiVG 08fbb.svg: (stroke type, centreline), in stroke order
    ("㇐", "M42.32,43.34c1.15,0.41,3.26,0.54,4.4,0.41C58,42.5,78.83,39.69,88.91,39.53c1.91-0.03,3.06,0.2,4.02,0.4"),
    ("㇑", "M65.78,13.88c0.57,0.46,1.79,3.42,1.9,4.33c0.12,0.91-0.07,55.21-0.19,60.92"),
    ("㇔", "M22.71,16.5c3.63,1.74,9.38,7.17,10.29,9.88"),
    ("㇔", "M15.96,39c4.34,0.99,11.21,4.09,12.29,5.63"),
    ("㇋", "M14.5,60.94c2.25,0.85,3.75,0.43,4.75,0.21c1-0.21,8-2.99,9.5-3.42c1.5-0.43,3.75,1.07,2.75,2.35s-4,6.19-4.75,7.26c-0.75,1.07-0.5,2.99,1,4.48s2.75,3.2,3.5,4.48C32,77.59,32,78.66,30.5,79.73c-1.5,1.07-9,7.04-10.5,7.47"),
    ("㇏", "M15.75,88.07c2.96-0.24,8.88-0.85,13.33-0.37c4.44,0.49,29.69,3.76,34.06,4.39C74.98,93.8,84.12,94.29,93,93.43"),
]


def flatten_path(d, steps=8):
    """An SVG path (M/L/Q/C/Z, absolute) as a polygon."""
    tokens = re.findall(r"[MLQCZ]|-?\d+(?:\.\d+)?", d)
    pts, i, cmd, cur = [], 0, None, (0.0, 0.0)
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd == "Z":
                continue
        nums = lambda n: [float(t) for t in tokens[i:i + n]]
        if cmd in ("M", "L"):
            cur = tuple(nums(2)); i += 2; pts.append(cur)
        elif cmd == "Q":
            x1, y1, x, y = nums(4); i += 4
            for k in range(1, steps + 1):
                t = k / steps
                pts.append(((1 - t) ** 2 * cur[0] + 2 * (1 - t) * t * x1 + t * t * x,
                            (1 - t) ** 2 * cur[1] + 2 * (1 - t) * t * y1 + t * t * y))
            cur = (x, y)
        elif cmd == "C":
            x1, y1, x2, y2, x, y = nums(6); i += 6
            for k in range(1, steps + 1):
                t = k / steps
                a, b, c, e = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
                pts.append((a * cur[0] + b * x1 + c * x2 + e * x, a * cur[1] + b * y1 + c * y2 + e * y))
            cur = (x, y)
        else:
            i += 1
    return pts


def seg_dist(p, a, b):
    ax, ay = b[0] - a[0], b[1] - a[1]
    l2 = ax * ax + ay * ay or 1e-9
    t = max(0.0, min(1.0, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / l2))
    return math.hypot(p[0] - a[0] - t * ax, p[1] - a[1] - t * ay)


def inside(p, poly):
    hit = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < x1 + (p[1] - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def half_width(p, poly):
    if not inside(p, poly):
        return 0.0
    return min(seg_dist(p, a, b) for a, b in zip(poly, poly[1:] + poly[:1]))


def resample(median):
    out = [tuple(map(float, median[0]))]
    for a, b in zip(median, median[1:]):
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / STEP))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    return out


def strokes_from_hanzi(data, prefix):
    raw = []
    for path, median in zip(data["strokes"], data["medians"]):
        poly = flatten_path(path)
        pts = resample(median)
        raw.append((pts, [half_width(p, poly) for p in pts]))
    widest = max(max(w) for _, w in raw) or 1.0
    strokes = []
    for k, (pts, widths) in enumerate(raw):
        # A median starts and ends just outside its outline (width 0); the
        # brush still touches the paper there, lightly.
        points = [{
            "x": round((x - CENTER[0]) / UNITS, 4),
            "y": round((y - CENTER[1]) / UNITS, 4),
            "z": 0,
            "pressure": round(max(0.18, w / widest), 3),
        } for (x, y), w in zip(pts, widths)]
        strokes.append({"id": f"{prefix}_{k}", "points": points, "color": "#111111", "width": 4,
                        "brushType": "ink_pen", "fill": False, "closed": False})
    return strokes


def kvg_points(d, steps=10):
    """A KanjiVG centreline (M/C/S/L, absolute or relative) as a polyline."""
    tokens = re.findall(r"[MmCcSsLlHhVvZz]|-?\d*\.?\d+(?:e-?\d+)?", d)
    pts, i, cmd = [], 0, None
    cur, last_ctrl = (0.0, 0.0), None
    def cubic(p0, p1, p2, p3):
        for k in range(1, steps + 1):
            t = k / steps
            a, b, c, e = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
            pts.append((a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]))
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]; i += 1
            if cmd in "Zz":
                continue
        rel = cmd.islower()
        nums = lambda n: [float(t) for t in tokens[i:i + n]]
        off = lambda x, y: (cur[0] + x, cur[1] + y) if rel else (x, y)
        c = cmd.upper()
        if c == "M":
            cur = off(*nums(2)); i += 2; pts.append(cur); last_ctrl = None
            cmd = "l" if rel else "L"
        elif c == "L":
            nxt = off(*nums(2)); i += 2; pts.append(nxt); cur = nxt; last_ctrl = None
        elif c == "H":
            x = nums(1)[0]; i += 1; nxt = (cur[0] + x if rel else x, cur[1]); pts.append(nxt); cur = nxt
        elif c == "V":
            y = nums(1)[0]; i += 1; nxt = (cur[0], cur[1] + y if rel else y); pts.append(nxt); cur = nxt
        elif c == "C":
            v = nums(6); i += 6
            p1, p2, p3 = off(v[0], v[1]), off(v[2], v[3]), off(v[4], v[5])
            cubic(cur, p1, p2, p3); last_ctrl = p2; cur = p3
        elif c == "S":
            v = nums(4); i += 4
            p1 = (2 * cur[0] - last_ctrl[0], 2 * cur[1] - last_ctrl[1]) if last_ctrl else cur
            p2, p3 = off(v[0], v[1]), off(v[2], v[3])
            cubic(cur, p1, p2, p3); last_ctrl = p2; cur = p3
        else:
            i += 1
    return pts


def resample_by(points, step):
    out = [points[0]]
    for a, b in zip(points, points[1:]):
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    return out


def bump(t, at, width):
    return math.exp(-((t - at) / width) ** 2)


def type_pressure(kind, t):
    """Kaisho (楷書) pressure along a stroke, by KanjiVG stroke type."""
    k = kind[:1]
    if k == "㇔":  # dot: lands light, presses down
        return 0.3 + 0.7 * t ** 0.7
    if k in "㇒㇓㇢":  # left-falling: pressed entry, drawn out to a point
        return 0.85 * bump(t, 0, 0.12) + (0.75 - 0.6 * t ** 1.2) * (1 - bump(t, 0, 0.12))
    if k in "㇏㇝":  # right-falling sweep: thin, swells, then the brush lifts
        return 0.35 + 0.6 * min(1, max(0, (t - 0.1) / 0.75)) ** 1.4 if t < 0.85 else 0.95 - 5.3 * (t - 0.85)
    if k == "㇑":  # vertical: pressed entry, hanging needle (悬针)
        return 0.9 * bump(t, 0, 0.1) + (0.75 - 0.6 * t ** 2) * (1 - bump(t, 0, 0.1))
    if k == "㇋":  # zigzag ending in a sweep left
        return 0.8 * bump(t, 0, 0.1) + 0.6 * (1 - bump(t, 0, 0.1)) - (0.4 * ((t - 0.75) / 0.25) if t > 0.75 else 0)
    # horizontal and everything else: pressed at both ends, lighter between
    return 0.55 + 0.3 * (bump(t, 0, 0.12) + bump(t, 1, 0.12))


def corner_presses(points, window=4, threshold=30.0):
    """Extra pressure where the stroke turns — the brush stops and presses (顿笔) at a corner.
    KanjiVG rounds its corners over several units, so the turn is measured
    across a window of samples, and only its peak counts."""
    n = len(points)
    turns = [0.0] * n
    for i in range(window, n - window):
        a = math.atan2(points[i][1] - points[i - window][1], points[i][0] - points[i - window][0])
        b = math.atan2(points[i + window][1] - points[i][1], points[i + window][0] - points[i][0])
        turns[i] = math.degrees(abs((b - a + math.pi) % (2 * math.pi) - math.pi))
    extra = [0.0] * n
    for i in range(1, n - 1):
        if turns[i] >= threshold and turns[i] >= turns[i - 1] and turns[i] > turns[i + 1]:
            amount = 0.3 * min(1.0, turns[i] / 60.0)
            for j in range(n):
                extra[j] = max(extra[j], amount * math.exp(-((j - i) / 2.5) ** 2))
    return extra


def strokes_from_kanjivg(paths, prefix):
    strokes = []
    for k, (kind, d) in enumerate(paths):
        pts = resample_by(kvg_points(d), KVG_STEP)
        presses = corner_presses(pts)
        last = max(1, len(pts) - 1)
        points = [{
            "x": round((x - KVG_CENTER[0]) / KVG_UNITS, 4),
            "y": round(-(y - KVG_CENTER[1]) / KVG_UNITS, 4),
            "z": 0,
            "pressure": round(min(1.0, max(0.15, type_pressure(kind, i / last) + presses[i])), 3),
        } for i, (x, y) in enumerate(pts)]
        strokes.append({"id": f"{prefix}_{k}", "points": points, "color": "#111111", "width": 4,
                        "brushType": "ink_pen", "fill": False, "closed": False})
    return strokes


def v3(x=0.0, y=0.0, z=0.0):
    return {"x": x, "y": y, "z": z}


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "tsuji"
    if arg == "tsuji":
        char, slug, strokes = "辻", "tsuji", strokes_from_kanjivg(TSUJI, "tsuji")
    elif arg == "yong":
        char, slug, strokes = "永", "yong", strokes_from_hanzi(YONG, "yong")
    elif arg.endswith(".svg"):
        svg = open(arg, encoding="utf-8").read()
        paths = re.findall(r'<path[^>]*kvg:type="([^"]*)"[^>]*\sd="([^"]+)"', svg)
        code = re.search(r"kvg:([0-9a-f]{5})", svg).group(1)
        char, slug, strokes = chr(int(code, 16)), code, strokes_from_kanjivg(paths, code)
    else:
        char, slug = os.path.splitext(os.path.basename(arg))[0], "custom"
        strokes = strokes_from_hanzi(json.load(open(arg, encoding="utf-8")), slug)
    out = os.path.join(DEMOS, f"demo_calligraphy_{slug}.tsuji")
    nodes, conns = [], []

    def node(nid, ntype, px, py, **params):
        nodes.append({"id": nid, "type": ntype, "position": {"x": px, "y": py}, "params": params})

    def wire(a, sa, b, sb):
        conns.append({"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb})

    FPS, SECONDS = 30, 10
    node("strokes", "curve/grease-pencil", -900, 0, name=f"{char} — stroke order (hide Paper to redraw)",
         activeColor="#111111", brushSize=4, brushType="ink_pen", onionSkin=False, visible=True,
         location=v3(), rotation=v3(), scale=v3(1, 1, 1),
         frames=[{"frame": 0, "strokes": strokes}])
    node("write", "curve/write-on", -560, 0, timing="time", progress=1, startTime=0.6, speed=2.4, pause=0.35,
         overlap=0, ease="brush")
    wire("strokes", "curves", "write", "curves")
    node("brush", "texture/brush-canvas", -220, 0, resolution="2048x2048", background="#ffffff", transparent=False,
         frameMode="fixed", frameCenter=v3(0, 0, 0), frameSize=6.4, frameMargin=0.1, seed=7, boil=0,
         brushScale=1, curvature=0.5, strokeEnabled=True, strokeBrush="sumi", strokeColor="#111111",
         strokeWeight=9, useStrokeColors=False, fillMode="none", hatchEnabled=False, field="none",
         fieldSpeed=0, wiggle=0)
    wire("write", "curves", "brush", "curves")

    # The wash: each stroke's outline, grown a little, rises as a dilute grey
    # watercolour once the stroke is finished and spreads for a moment —
    # Write On's per-stroke "seconds since done" drives both.
    node("wash_shape", "curve/stroke-outline", -560, 360, width=0.042, minWidth=0.013, spread=0.038,
         usePressure=True, caps="round")
    wire("strokes", "curves", "wash_shape", "curves")
    node("wash_in", "list/map-range", -560, 620, inMin=0, inMax=0.6, outMin=0, outMax=1, clamp=1, power=1)
    node("wash_spread", "list/map-range", -560, 820, inMin=0, inMax=2.5, outMin=0.08, outMax=0.6, clamp=1, power=0.6)
    wire("write", "age", "wash_in", "list")
    wire("write", "age", "wash_spread", "list")
    node("wash_style", "curve/stroke-style", -300, 420, opacity=1, weight=1, setBleed=False, bleed=0.3,
         setFillColor=False, fillColor=0x6B6B6B)
    wire("wash_shape", "curves", "wash_style", "curves")
    wire("wash_in", "list", "wash_style", "opacities")
    wire("wash_spread", "list", "wash_style", "bleeds")
    node("wash", "texture/brush-canvas", -60, 420, resolution="1024x1024", background="#ffffff", transparent=False,
         frameMode="fixed", frameCenter=v3(0, 0, 0), frameSize=6.4, frameMargin=0.1, seed=3, boil=0,
         brushScale=1, curvature=0.5, strokeEnabled=False, strokeBrush="2B", strokeColor="#111111", strokeWeight=1,
         fillMode="watercolor", watercolorLook="custom", fillColor="#6a6a6a", fillOpacity=70, bleed=0.3,
         bleedDirection="out", bleedRandomDirection=True, bleedAngle=0, fillTexture=0.7, fillBorder=0.15,
         fillScatter=True, hatchEnabled=False, field="none", fieldSpeed=0, wiggle=0)
    wire("wash_style", "curves", "wash", "curves")
    node("ink_on_wash", "texture/mix", 120, 220, blendMode="multiply", factor=1)
    wire("brush", "texture", "ink_on_wash", "textureA")
    wire("wash", "texture", "ink_on_wash", "textureB")

    node("paper", "object/plane", 120, 0, visible=1, location=v3(0, 0, 0.05), rotation=v3(), scale=v3(6.4, 6.4, 1),
         color=0xFFFFFF, emissive=0, emissiveIntensity=1, shadeless=1, roughness=1, metalness=0, wireframe=0,
         opacity=1, transmission=0, thickness=0.5)
    wire("ink_on_wash", "texture", "paper", "texture")

    node("camera", "calibration/camera", 120, 320, active=True, mode="manual", projectionType="perspective",
         location=v3(0, 0, 40), rotation=v3(), useTarget=False, target=v3(), up=v3(0, 1, 0), fov=10)
    node("env", "lighting/environment", 120, -320, color=0xFFFFFF, intensity=1, background=1, blurriness=0,
         filePath="", backgroundImagePath="", backgroundFit="cover", backgroundScale=v3(1, 1, 1),
         backgroundOffset=v3(), backgroundRotation=0, ambientIntensity=0, sunIntensity=0)
    node("ink_tone", "postprocess/duotone", 380, -520, shadowColor=0x15110E, highlightColor=0xEFE6D2,
         balance=0.72, softness=0.6, amount=1)
    node("paper_grain", "postprocess/film-texture", 620, -520, grain=0.07, dust=0.03, scratches=0, blotches=0.25,
         rate=0, seed=5)
    wire("ink_tone", "effect", "paper_grain", "effect")
    node("render", "render", 620, -320, frameCount=FPS * SECONDS, fps=FPS, motionBlur=0,
         resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
    wire("env", "environment", "render", "environment")
    wire("paper_grain", "effect", "render", "postprocess")

    empty = lambda: {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []}
    canvas = {"nodes": nodes, "connections": conns, "keyframes": {}, "markers": [], "exposedParams": []}
    with open(out, "w") as f:
        json.dump({"canvases": [canvas] + [empty() for _ in range(5)], "activeCanvas": 0}, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {os.path.relpath(out, ROOT)}  ({len(strokes)} strokes, {sum(len(s['points']) for s in strokes)} points)")


if __name__ == "__main__":
    main()
