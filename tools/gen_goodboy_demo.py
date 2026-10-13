#!/usr/bin/env python3
"""Title-sequence demo in the style of a printed-collage opening: six canvases = six scenes.

Built from Tsuji's own nodes (see goodboy_lib.py): Appear for every entrance, Curve to Line / Array / Curve Array for lines
and rings, Grease Pencil for what is drawn by hand, Wiggle for the boil of cut paper, Pivot Transform + Oscillator for the
swinging medal, badges and banners, Rolling for the bowling ball.

Run tools/prep_goodboy_assets.py first (photos → motion_demo/assets/). Text is Simplified Chinese, set with Noto Sans SC Black
(motion_demo/assets/noto_sans_sc_black.json, built by scripts/convertFontSubset.mjs).
"""
import os, sys, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from goodboy_lib import *


def torn(rnd, n=14, amp=0.035, inset=0.03):
    """A torn-paper rectangle in UV: jittered points along the four edges."""
    pts = []
    for i in range(n):  pts.append((inset + (1 - 2 * inset) * i / n, inset + rnd.uniform(-amp, amp)))
    for i in range(n):  pts.append((1 - inset + rnd.uniform(-amp, amp), inset + (1 - 2 * inset) * i / n))
    for i in range(n):  pts.append((1 - inset - (1 - 2 * inset) * i / n, 1 - inset + rnd.uniform(-amp, amp)))
    for i in range(n):  pts.append((inset + rnd.uniform(-amp, amp), 1 - inset - (1 - 2 * inset) * i / n))
    return pts


# --------------------------------------------------------------------------- 1. L'ARÈNE
def scene1():
    c = Canvas(236, warp=[(0, 0), (38, 45), (64, 62), (113, 114), (161, 167), (240, 236)])
    c.setup(bg=INK, next_canvas=2, index=1)
    rnd = random.Random(11)
    c.wiggle("boil", pos=(0.05, 0.04, 0), rot=0.9, seed=1)
    c.paper("bg", INK, dark=True, z=-6)

    c.label("Arène : couleur puis noir et blanc")
    asp = aspect("01_arena_wide.jpg")
    for tag, tone, t in (("arenaC", "bluegold", (0, 38)), ("arenaB", "inkwhite", (38, 64))):
        c.roto(f"{tag}_roto", torn(rnd), asp=asp)
        # The black-and-white plate runs through a Super 8 projector: gate weave and flicker, no hand-keyed flash.
        c.photo(tag, "01_arena_wide.jpg", 0, 0, H * 0.96, z=0, tone=tone, sticker=None, halftone=0 if tag == "arenaC" else 3,
                rot=0.035 if tag == "arenaC" else 0.02, mask=f"{tag}_roto", t=t, pop=3, drift=0.04, extra="super8" if tag == "arenaB" else None)
    c.star("bigstar", 0.5, 0.2, 3.4, WHITE, z=4, points=4, inner=0.08, t=(2, 16), pop=6)
    c.spin("bigstar", 2, 16, -0.6, 0.9)
    for i, (sx, sy, col, t) in enumerate([(-5.5, 2.2, MUSTARD, 3), (-1.5, 1.2, PINK, 6), (4.5, 2.4, WHITE, 9), (-3.0, -1.6, TEAL, 20),
                                          (5.8, -1.2, WHITE, 28), (2.0, 2.5, MUSTARD, 33)]):
        c.star(f"spark{i}", sx, sy, 0.55 + 0.25 * (i % 3), col, z=4, points=4, inner=0.14, rot=0.2 * i, t=(t, t + 9), pop=4)
        c.spin(f"spark{i}", t, t + 9, 0, 1.2)
    c.text("round", "第一回合", -4.6, -2.15, 0.7, CREAM, z=4, t=(46, 64), pop=5)

    c.label("Le champion")
    c.burst("b_teal", 0.2, -0.2, 3.8, TEAL, z=-3, n=11, inner=0.5, jag=0.3, seed=3, t=(64, 113), pop=6)
    c.burst("b_gold", 0.2, -0.2, 3.1, MUSTARD, z=-2.5, n=9, inner=0.45, jag=0.3, seed=4, rot=0.3, t=(66, 113), pop=6)
    c.spin("b_teal", 64, 113, 0, 0.25); c.spin("b_gold", 66, 113, 0.3, -0.1)
    drop = c.slide("boxer_in", (0, -6), 64, dur=7)
    c.photo("boxer", "02_boxer_victory.png", -0.6, -0.1, 5.7, z=0.5, tone="ink", matrix=c.mul("boxer_mx", "boil", drop), t=(64, 113), pop=6, drift=0.05)
    c.text("name_boxer", "设计师", 4.4, 0.3, 1.3, CREAM, z=4, matrix="boil", t=(72, 113), pop=5)

    c.label("L'adversaire")
    asp3 = aspect("03_boxer_face_clinch.jpg")
    c.roto("clinch_roto", torn(random.Random(7), amp=0.05, inset=0.08), asp=asp3)
    c.burst("b_red", 1.5, 0, 4.2, CRIMSON, z=-3, n=10, inner=0.42, jag=0.3, seed=9, t=(113, 161), pop=5)
    c.burst("b_red2", 1.5, 0, 3.3, MUSTARD, z=-2.8, n=8, inner=0.5, jag=0.3, seed=10, rot=0.4, t=(115, 161), pop=5)
    c.spin("b_red", 113, 161, 0, 0.3)
    c.photo("clinch", "03_boxer_face_clinch.jpg", 1.6, 0.1, 4.6, z=0.5, tone="ink", sticker=CREAM, thick=10, halftone=2,
            mask="clinch_roto", t=(113, 161), pop=4, drift=0.08)
    c.text("name_ae", "后期特效", -4.3, -0.2, 0.95, MUSTARD, z=4, t=(121, 161), pop=5)

    c.label("Le coach")
    c.burst("b_jade", -1.4, -0.2, 3.9, JADE, z=-3, n=12, inner=0.5, jag=0.3, seed=21, t=(161, 241), pop=6)
    c.burst("b_gold2", -1.4, -0.2, 3.0, MUSTARD, z=-2.8, n=10, inner=0.45, jag=0.3, seed=22, rot=0.2, t=(163, 241), pop=6)
    c.spin("b_jade", 161, 241, 0, -0.3)
    c.photo("coach", "04_coach_cap.png", -1.2, -0.3, 5.8, z=0.5, tone="ink", sticker=TEAL, thick=12,
            matrix=c.mul("coach_mx", "boil", c.slide("coach_in", (-8, 0), 161, dur=9)), t=(161, 241), pop=6, drift=0.06)
    c.text("name_coach", "教练", 4.6, 0.2, 1.8, CREAM, z=4, matrix="boil", t=(172, 241), pop=5)
    return c


# --------------------------------------------------------------------------- 2. LE CASTING
BADGE_FILE = "06_id_badge_blank.png"
WIN = (0.452, 0.617, 0.175)        # photo window on the badge: centre u, centre v (from top), height / badge height


def badge(c, key, x, y, h, face, amp=0.05, freq=0.8, phase=0.0, t=None, pop=6):
    """A badge on its lanyard: the card and the headshot in its window, hung from (x, y) and swung by one Pivot Transform."""
    wb = h * aspect(BADGE_FILE)
    hs = h * WIN[2] * 1.12
    sw = c.swing(f"{key}_sw", x, y, amp, freq, phase)
    card = c.photo(f"{key}_card", BADGE_FILE, x, y - h / 2, h, z=0.5, tone="gold", sticker=None, halftone=2)
    head = c.photo(f"{key}_face", face, x + (WIN[0] - 0.5) * wb, y - h / 2 + (0.5 - WIN[1]) * h, hs, z=0.6, tone="ink", sticker=None, halftone=2)
    pair = c.group(key, [card, head], matrix=sw)
    return c.reveal(pair, t, pop) if t else pair


def scene2():
    c = Canvas(279, warp=[(0, 0), (60, 70), (100, 105), (205, 209), (226, 227), (270, 279)])
    c.setup(bg=INK, next_canvas=3, index=2)
    c.paper("bg", INK, dark=True, z=-7)

    c.label("Médaille")
    c.burst("m_cream", 0, 0, 5.8, CREAM, z=-3, n=7, inner=0.38, jag=0.25, seed=31, rot=0.2, t=(0, 61), pop=6)
    c.burst("m_jade", 1.8, -1.5, 2.4, JADE, z=-2.8, n=8, inner=0.5, jag=0.3, seed=32, t=(4, 61), pop=6)
    c.spin("m_cream", 0, 61, 0.2, 0.55)
    c.photo("medal", "05_gold_medal.png", 0, -0.2, 6.6, z=0.5, tone="gold", sticker=None, halftone=3,
            matrix=c.swing("medal_sw", 0, 3.0, 0.07, 0.9), t=(0, 61), pop=6)
    c.text("t_champ", "冠军", -4.8, 0.2, 1.5, MUSTARD, z=4, t=(14, 61), pop=5)

    c.label("Badges")
    c.paper("bgj", JADE, dark=True, z=-5.5, t=(60, 226))
    c.burst("j_cream", 0, -0.2, 6.2, CREAM, z=-3, n=8, inner=0.4, jag=0.3, seed=41, t=(60, 201), pop=6)
    c.spin("j_cream", 60, 201, 0, 0.5)
    badge(c, "badge1", 0, 3.0, 5.9, "07a_headshot.png", amp=0.06, t=(60, 100))
    faces = ["07a_headshot.png", "07b_headshot.png", "07c_headshot.png", "07d_headshot.png", "07e_headshot.png"]
    names = ["节点", "实时", "物理", "粒子", "半调"]
    row = [badge(c, f"badge{i + 2}", -5.6 + 2.8 * i, 3.0, 4.7, faces[i], amp=0.05, freq=0.75 + 0.05 * i, phase=0.2 * i) for i in range(5)]
    # Five badges pop one after the other: one Appear, Stagger spreads it over the group.
    c.reveal(c.group("badges", row), (100, 201), pop=22, stagger=0.7)
    labels = [c.text(f"nm{i}", names[i], -5.6 + 2.8 * i, -2.35, 0.62, MUSTARD, z=4) for i in range(5)]
    c.reveal(c.group("nm_all", labels), (108, 201), pop=22, stagger=0.7)

    c.label("Voiture et titre")
    dash = c.mover("car_go", [(205, v3(-12, 0, 0)), (224, v3(12, 0, 0), "linear")])
    c.photo("car", "08_red_sports_car.png", 0, -0.7, 1.5, z=0.5, tone="crimson", sticker=None, halftone=2, matrix=dash, t=(205, 226), pop=1)
    for i, (dy, ln) in enumerate([(0.2, 3.5), (-0.1, 4.5), (-0.4, 3.0)]):
        c.line(f"carl{i}", [(-2.5 - ln, -0.7 + dy), (-2.4, -0.7 + dy)], 0.12, WHITE, z=0.4, matrix=dash, t=(205, 226), pop=1)
    for i, (sx, sy, col, tt) in enumerate([(-5, 2, MUSTARD, 232), (4.8, -2, TEAL, 240), (-3, -2.2, PINK, 248), (5.5, 2.2, CREAM, 256)]):
        c.star(f"sp{i}", sx, sy, 0.6, col, z=4, points=4, inner=0.14, t=(tt, 271), pop=4)
    c.text("t_cast", "演职员表", 0, 0, 1.7, CREAM, z=4, t=(228, 271), pop=6)
    return c


# --------------------------------------------------------------------------- 3. L'IMPACT
def crack(rnd, x, y, ang, length, segs=7, jit=0.45):
    """A straight-segmented crack heading downward: every vertex turns a little, but never back up."""
    pts, a = [(x, y)], ang
    step = length / segs
    for _ in range(segs):
        a = max(-math.pi + 0.3, min(-0.3, a + rnd.uniform(-jit, jit)))
        d = step * rnd.uniform(0.7, 1.3)
        x += math.cos(a) * d; y += math.sin(a) * d
        pts.append((x, y))
    return pts


def path_len(pts, k):
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(k))


def scene3():
    c = Canvas(261, warp=[(0, 0), (40, 35), (96, 104), (151, 157), (216, 226), (270, 261)])
    c.setup(bg=INK, next_canvas=4, index=3)
    c.paper("bg", INK, dark=True, z=-7)

    c.label("Poing et voiture")
    c.photo("fistA", "09_fist_wrapped.png", 3.2, 0.2, 3.0, z=0.6, tone="jade", sticker=None, halftone=3,
            matrix=c.slide("fistA_in", (8.8, 0), 2, dur=9), t=(0, 41), pop=2)
    c.photo("carA", "08_red_sports_car.png", -3.0, 0.0, 1.7, z=0.5, tone="crimson", sticker=None, halftone=2,
            matrix=c.slide("carA_in", (-9, 0), 9, dur=9), t=(0, 41), pop=2)

    c.label("Collision")
    c.paper("bgc", CREAM, dark=False, z=-5.5, t=(40, 151))
    c.burst("z_red", 0, 0.1, 5.4, CRIMSON, z=-3, n=9, inner=0.28, jag=0.4, seed=51, t=(40, 96), pop=4)
    c.spin("z_red", 40, 96, 0, 0.25)
    c.burst("z_gold", 0.3, 0.1, 2.7, MUSTARD, z=-2.5, n=8, inner=0.35, jag=0.4, seed=52, t=(52, 96), pop=4)
    c.photo("fistB", "09_fist_wrapped.png", 2.2, 0.2, 3.2, z=0.6, tone="jade", sticker=None, halftone=3,
            matrix=c.mover("fistB_mv", [(40, v3(4.8, 0, 0)), (50, v3(-1.2, 0, 0), "expo"), (96, v3(-0.8, 0, 0), "linear")]), t=(40, 96), pop=2)
    c.photo("carB", "08_red_sports_car.png", -2.6, 0.2, 1.8, z=0.5, tone="crimson", sticker=None, halftone=2, rot=1.2,
            matrix=c.mover("carB_mv", [(40, v3(-5.4, 0, 0)), (52, v3(0.8, 0, 0), "expo"), (62, v3(-0.8, 0.2, 0), "back"), (96, v3(-1.2, 0.6, 0), "linear")]),
            t=(40, 96), pop=2)
    c.text("t_break", "碎裂", 4.9, 1.9, 1.3, INK, z=4, t=(58, 96), pop=5)

    c.label("Le coup")
    c.poly("slab", [(-9, -0.5), (-6, -0.3), (-4.4, -0.75), (-2.2, -0.45), (0.1, -0.6), (2.0, -0.3), (4.3, -0.7), (6.2, -0.4), (9, -0.6), (9, -5), (-9, -5)],
           INK, 0, 0, -2.0, t=(96, 151), pop=1)
    c.photo("fistC", "09_fist_wrapped.png", 0.3, 2.3, 3.4, z=0.6, tone="jade", sticker=None, halftone=3, rot=math.pi / 2,
            matrix=c.mover("fistC_mv", [(96, v3(0, 6.7, 0)), (101, v3(0, 0, 0), "expo"), (151, v3(0, -0.1, 0), "linear")]), t=(96, 151), pop=1)
    c.burst("hit_red", 0.3, -0.5, 1.8, CRIMSON, z=-1, n=9, inner=0.3, jag=0.5, seed=53, t=(101, 124), pop=3)
    c.burst("hit_gold", 0.3, -0.5, 1.3, MUSTARD, z=-0.9, n=7, inner=0.3, jag=0.5, seed=54, t=(102, 120), pop=3)

    c.label("Fissures")
    # Each crack is a Curve from Points (straight segments) -> Curve to Mesh, its End animated from 0 to 1: the crack grows
    # from the impact downward. A branch starts when its parent's tip reaches the branching point.
    rnd = random.Random(5)
    SPEED = 0.2          # world units per frame
    cracks = []          # (points, start frame)
    for _ in range(10):
        pts = crack(rnd, 0.3, -0.5, -math.pi / 2 + rnd.uniform(-1.1, 1.1), rnd.uniform(3.2, 7.0), segs=8)
        cracks.append((pts, 106 + rnd.uniform(0, 4)))
    for _ in range(14):
        pts0, t0 = rnd.choice(cracks[:10]); k = rnd.randrange(1, len(pts0) - 2)
        x0, y0 = pts0[k]
        cracks.append((crack(rnd, x0, y0, -math.pi / 2 + rnd.uniform(-1.2, 1.2), rnd.uniform(1.4, 3.2), segs=5, jit=0.6),
                       t0 + path_len(pts0, k) / SPEED))
    for n, (pts, t0) in enumerate(cracks):
        t1 = t0 + path_len(pts, len(pts) - 1) / SPEED
        with c.block():
          c.add(f"cr{n}_p", "curve/from_points", type="linear", closed=False, tension=0.5, sag=0,
              pointsList=[v3(px, py, 0) for px, py in pts], location=v3(), rotation=v3(), scale=v3(1, 1, 1))
          c.add(f"cr{n}", "curve/to_mesh", thickness=0.05 if n < 10 else 0.035, startProgress=0.0, endProgress=1.0, tubularSegments=96, radialSegments=3,
                closed=False, visible=1, location=v3(0, 0, 0.2), rotation=v3(), scale=v3(1, 1, 1), color=CREAM, shadeless=1)
          c.wire(f"cr{n}_p", "curve", f"cr{n}", "curve")
        c.key(f"cr{n}", "endProgress", [(t0, 0.0), (t1, 1.0, "linear")])
        c.key(f"cr{n}", "visible", [(0, 0), (t0, 1, "hold"), (216, 0, "hold")])

    c.label("Visage dans la déchirure")
    asp = aspect("10_woman_face_intense.jpg")
    c.roto("face_roto", torn(random.Random(9), amp=0.05, inset=0.1), asp=asp)
    c.poly("wedge", [(1.4, 0.2), (7.4, 3.4), (7.4, -3.2)], CREAM, 0, 0, -1.8, t=(216, 271), pop=3)
    c.rays("face_rays", 1.4, 0.2, -0.5, 58, 7, 0.4, 11, 0.35, 0x9A9C94, z=-1.5, t=(216, 271), pop=3)
    c.photo("face", "10_woman_face_intense.jpg", -2.2, -0.1, 4.8, z=0.5, tone="ink", sticker=None, halftone=2, mask="face_roto",
            t=(216, 271), pop=3, drift=0.05)
    c.text("t_phys", "物理", 5.2, -0.3, 1.25, INK, z=4, t=(230, 271), pop=5)
    return c


# --------------------------------------------------------------------------- 4. LA CIBLE
def scene4():
    c = Canvas(279, warp=[(0, 0), (46, 52), (96, 105), (146, 157), (216, 227), (263, 268), (270, 279)])
    c.setup(bg=CRIMSON, next_canvas=5, index=4)
    c.paper("bgr", CRIMSON, dark=True, z=-7, t=(0, 263))

    c.label("Lanceuse")
    c.burst("a_gold", 2.4, 0.7, 3.6, MUSTARD, z=-3, n=10, inner=0.35, jag=0.35, seed=61, t=(0, 46), pop=4)
    c.burst("a_cream", 2.4, 0.7, 2.3, CREAM, z=-2.8, n=8, inner=0.4, jag=0.35, seed=62, rot=0.3, t=(3, 46), pop=4)
    c.spin("a_gold", 0, 46, 0, 0.3)
    c.rays("a_rays", 1.4, 0.7, -0.45, 52, 11, 0.8, 12, 0.12, WHITE, z=-3.5, t=(2, 46), pop=3)
    c.photo("thrower", "11_woman_throwing_pose.png", -2.6, -0.1, 5.7, z=0.5, tone="silhouette", sticker=None, halftone=0, t=(0, 46), pop=5, drift=0.04)

    c.label("Fléchette")
    ang = math.atan2(-3.6, 22)
    fly = c.mover("dart_fly", [(46, v3(-11, 2.4, 0)), (60, v3(11, -1.2, 0), "linear")])
    c.photo("dart", "12_dart_flying.png", 0, 0, 2.4, z=0.5, tone="ink", sticker=None, halftone=2, rot=0.65, matrix=fly, t=(46, 61), pop=1)
    for i, dy in enumerate([0.28, 0.0, -0.3, 0.5]):
        ln = 3.5 + i * 1.2
        d0, d1 = 1.6, 1.6 + ln
        ux, uy, vx, vy = math.cos(ang), math.sin(ang), -math.sin(ang), math.cos(ang)
        c.line(f"dl{i}", [(-d1 * ux + dy * vx, -d1 * uy + dy * vy), (-d0 * ux + dy * vx, -d0 * uy + dy * vy)], 0.12, WHITE, z=0.4,
               matrix=fly, t=(46, 61), pop=1)
    c.rays("bd_rays", 0.2, 0, 0.0, 300, 6, 0.0, 12, 0.3, CREAM, z=-3.0, t=(62, 96), pop=3)
    c.photo("dartB", "12_dart_flying.png", 0.2, 0.0, 4.8, z=0.5, tone="ink", sticker=CREAM, thick=10, halftone=3, rot=0.9, t=(62, 96), pop=5, drift=0.08)
    c.spin("dartB", 62, 96, 0.7, 0.95)

    c.label("Montre")
    c.photo("watch", "13_gold_watch.png", 0, -0.1, 5.9, z=0.5, tone="gold", sticker=None, halftone=3,
            matrix=c.swing("watch_sw", 0, -0.1, 0.04, 0.9), t=(96, 146), pop=5)
    sweep = c.mover("streak_go", [(128, v3(-9, 3.4, 0)), (140, v3(9, -3.4, 0), "linear")])
    c.line("streak", [(-1.4, 0.77), (1.4, -0.77)], 0.28, WHITE, z=1.0, matrix=sweep, t=(128, 141), pop=1)

    c.label("Costume et croix")
    c.photo("suit", "14_suit_torso.png", -1.4, -0.2, 6.0, z=0.5, tone="ink", sticker=None, halftone=3, t=(146, 216), pop=5, drift=0.04)
    # The cross is drawn by hand: one Grease Pencil node, two marker strokes growing across the torso.
    xs = [((-3.9, -2.3), (1.1, 3.1)), ((-3.9, 3.1), (1.1, -2.3))]

    def along(a, b, p, n=6):
        return [(a[0] + (b[0] - a[0]) * p * u / (n - 1), a[1] + (b[1] - a[1]) * p * u / (n - 1)) for u in range(n)]

    frames = []
    for k in range(9):
        strokes = [Canvas.stroke(along(a, b, min(1.0, (k - 3 * i) / 5.0)), WHITE, 22, "marker_bold", taper=False)
                   for i, (a, b) in enumerate(xs) if k - 3 * i >= 1]
        frames.append((174 + k, strokes))
    c.gp("cross", frames, z=1.5, t=(174, 216))
    c.text("t_half", "半调", 4.9, -0.3, 1.2, MUSTARD, z=4, t=(158, 216), pop=5)

    c.label("Cible")
    c.paper("bgi", INK, dark=True, z=-5.5, t=(216, 263))
    c.rings("target", 0, 0, 0.9, 0.8, 6, 0.07, CREAM, z=-1.0, t=(216, 263), pop=18)
    digits = []
    for i, (R, ch) in enumerate([(0.0, "X"), (1.3, "9"), (2.1, "9"), (2.9, "8"), (3.7, "7"), (4.5, "7")]):
        for sgn in ((1, -1) if R else (1,)):
            digits.append(c.text(f"dg{i}{sgn}", ch, sgn * R, 0, 0.55 if R else 0.9, CREAM, z=0.5))
    c.reveal(c.group("digits", digits), (218, 263), pop=20, stagger=0.8)
    c.paper("bgt", TEAL, dark=True, z=-5.0, t=(259, 271))
    return c


# --------------------------------------------------------------------------- 5. LE CHAOS
def scene5():
    c = Canvas(226, warp=[(0, 0), (50, 52), (110, 104), (170, 156), (240, 226)])
    c.setup(bg=TEAL, next_canvas=6, index=5)
    for key, col, t in (("bgA", TEAL, (0, 51)), ("bgB", CRIMSON, (50, 111)), ("bgC", TEAL, (110, 171)), ("bgD", JADE, (170, 241))):
        c.paper(key, col, dark=True, z=-7, t=t)
    c.wiggle("boil", pos=(0.05, 0.04, 0), rot=1.0, seed=4)

    c.label("Lunettes et éclair")
    c.burst("a_cr", 1.2, 0, 6.2, CREAM, z=-3, n=9, inner=0.35, jag=0.3, seed=71, t=(0, 51), pop=5)
    c.spin("a_cr", 0, 51, 0, 0.35)
    c.photo("glasses", "15_man_glasses_pointing.png", -3.9, -0.2, 5.9, z=0.5, tone="ink", sticker=CREAM, thick=10,
            matrix=c.mul("glasses_mx", "boil", c.slide("glasses_in", (-5.1, 0), 0, dur=8)), t=(0, 51), pop=5, drift=0.04)
    c.line("bolt", [(-1.9, 0.75), (1.2, 1.5), (0.6, 0.95), (3.6, 1.4), (2.7, 0.8), (5.6, 0.4)], 0.38, CRIMSON, z=0.4, t=(8, 51), pop=3)
    c.text("t_notl", "没有时间轴", 3.6, -1.7, 0.8, INK, z=4, t=(18, 51), pop=5)

    c.label("Boule de bowling 3D et jambes")
    # A real 3D ball: a marbled sphere and its finger holes, rolled by the Rolling node from one animated position.
    c.add("ball_tex", "texture/procedural", type="turbulence", colorA=0x1D4F94, colorB=0xA6DCF2, size="1024 × 1024", scale=4, seed=7)
    c.add("ball_s", "object/sphere", visible=1, location=v3(), rotation=v3(), scale=v3(2.5, 2.5, 2.5), color=0xFFFFFF, roughness=0.3, metalness=0.1, shadeless=1)
    c.wire("ball_tex", "texture", "ball_s", "texture")
    holes = []
    for i, (hx, hy) in enumerate([(-0.3, 0.45), (0.28, 0.5), (0.0, 0.0)]):
        c.add(f"hole{i}", "object/sphere", visible=1, location=v3(hx, hy, 1.3), rotation=v3(), scale=v3(0.42, 0.42, 0.2), color=INK, shadeless=1)
        holes.append(f"hole{i}")
    c.add("ball_pos", "vector/compose", x=-9.5, y=-1.3, z=1.0)
    c.key("ball_pos", "x", [(52, -9.5), (98, 9.5, "linear")])
    c.add("ball_roll", "physics/rolling", shape="round", size=2.5, axis=v3(0, 0, 1))
    c.add("ball_mx", "transform", location=v3(), rotation=v3(), scale=v3(1, 1, 1))
    c.wire("ball_pos", "out", "ball_roll", "position"); c.wire("ball_pos", "out", "ball_mx", "location"); c.wire("ball_roll", "rotation", "ball_mx", "rotation")
    ball = c.group("ball", ["ball_s"] + holes, matrix="ball_mx")
    c.reveal(ball, (52, 99), pop=2, mode="pop", over=0.0)
    c.photo("legs", "17_legs_red_heels.png", 3.8, -0.4, 5.4, z=0.5, tone="ink", sticker=CREAM, thick=14,
            matrix=c.slide("legs_in", (5.2, 0), 82, dur=9), t=(82, 111), pop=5, drift=0.03)
    c.text("t_coll", "碰撞", -3.9, 1.5, 1.2, MUSTARD, z=4, t=(66, 111), pop=5)

    c.label("Explosion")
    for k, (d, r, col, sd, n, inner) in enumerate((("c_cr", 6.8, CREAM, 81, 12, 0.55), ("c_red", 5.2, CRIMSON, 82, 10, 0.4), ("c_gold", 3.4, MUSTARD, 83, 8, 0.45))):
        c.burst(d, 0, 0, r, col, z=-4 + 0.2 * k, n=n, inner=inner, jag=0.3, seed=sd, t=(110 + 2 * k, 171), pop=5)
        c.spin(d, 110, 171, 0.2 * k, 0.2 * k + (0.5 if k % 2 else -0.5))
    c.photo("joy", "18_man_arms_up_joy.png", -4.7, -0.2, 5.9, z=0.5, tone="ink", sticker=CREAM, thick=10,
            matrix=c.mul("joy_mx", "boil", c.slide("joy_in", (0, -6.8), 114, dur=8)), t=(114, 171), pop=6)
    c.photo("round", "07d_headshot.png", 4.4, -0.3, 4.4, z=0.5, tone="ink", sticker=CREAM, thick=12,
            matrix=c.slide("round_in", (0, -6.7), 124, dur=8), t=(124, 171), pop=6)

    c.label("Deux visages")
    c.burst("d_cr", -3.4, 0, 4.9, CREAM, z=-3, n=10, inner=0.45, jag=0.3, seed=91, t=(170, 241), pop=5)
    c.burst("d_tl", 3.9, 0, 4.4, TEAL, z=-3, n=9, inner=0.45, jag=0.3, seed=92, t=(174, 241), pop=5)
    c.spin("d_cr", 170, 241, 0, 0.3); c.spin("d_tl", 170, 241, 0, -0.3)
    c.photo("faceE", "07e_headshot.png", -3.4, -0.2, 5.5, z=0.5, tone="ink", sticker=CREAM, thick=12, matrix="boil", t=(170, 241), pop=5)
    c.photo("faceB", "07b_headshot.png", 3.9, -0.2, 5.3, z=0.5, tone="ink", sticker=CREAM, thick=12, matrix="boil", t=(178, 241), pop=5)
    c.text("t_rt", "实时", 0.2, -1.9, 0.8, CREAM, z=4, t=(192, 241), pop=5)
    return c


# --------------------------------------------------------------------------- 6. LE PODIUM ET LE TITRE
def scene6():
    c = Canvas(225, warp=[(0, 0), (71, 70), (100, 105), (210, 225)])
    c.setup(bg=INK, next_canvas=1, index=6)
    c.paper("bgd", INK, dark=True, z=-7)
    c.wiggle("boil", pos=(0.04, 0.03, 0), rot=0.8, seed=6)

    c.label("Podium")
    c.paper("bgr", CRIMSON, dark=True, z=-6, t=(0, 71))
    c.burst("p_tl", 0, 0.6, 7.0, TEAL, z=-4, n=11, inner=0.45, jag=0.3, seed=101, t=(0, 71), pop=6)
    c.burst("p_gold", 0, 0.6, 5.2, MUSTARD, z=-3.8, n=9, inner=0.4, jag=0.3, seed=102, t=(3, 71), pop=6)
    c.spin("p_tl", 0, 71, 0, 0.3); c.spin("p_gold", 3, 71, 0.2, -0.2)
    banners = []
    for i, (bx, by, rot) in enumerate([(-4.9, 2.1, 0.05), (0.0, 2.4, 0.0), (4.9, 2.1, -0.05)]):
        banners.append(c.photo(f"banner{i}", "23_stamp_ink_texture.jpg", bx, by, 3.0, z=-1.0, tone="gold", sticker=None, halftone=3, rot=rot, wfac=0.55,
                               matrix=c.swing(f"banner{i}_sw", bx, by + 1.5, 0.03, 0.85, 0.3 * i)))
    c.reveal(c.group("banners", banners), (4, 71), pop=20, stagger=0.6)
    c.poly("podium", [(-5.6, -2.55), (5.6, -2.55), (5.6, -4.5), (-5.6, -4.5)], JADE, 0, 0, 0.3, t=(6, 71), pop=6)
    c.photo("lineup", "19_five_lineup.png", 0, -0.8, 3.7, z=0.5, tone="silhouette", sticker=None, halftone=0,
            matrix=c.slide("lineup_in", (0, -6.2), 8, dur=9), t=(8, 71), pop=6)
    c.text("t_one", "1", 0, -3.5, 0.6, CREAM, z=4, t=(16, 71), pop=4)
    c.text("t_champ", "冠军", -5.0, -0.3, 1.2, CREAM, z=4, matrix="boil", t=(22, 71), pop=5)
    c.rays("p_rays", 0, -2.6, 0.35, 130, 8, 0.5, 13, 0.2, WHITE, z=-3.5, t=(2, 71), pop=3)

    c.label("Étincelles")
    for i, (sx, sy, col, tt) in enumerate([(-5.2, 1.5, CRIMSON, 74), (3.3, -1.8, TEAL, 79), (-1.2, 2.0, MUSTARD, 84), (5.6, 1.4, WHITE, 89), (-3.4, -1.4, JADE, 93)]):
        c.star(f"sparkB{i}", sx, sy, 0.7, col, z=4, points=4, inner=0.13, rot=0.2 * i, t=(tt, 100), pop=4)

    c.label("Titre")
    c.poly("card", [(-6.6, 2.5), (-3.8, 2.75), (-0.4, 2.55), (3.1, 2.8), (6.3, 2.45), (6.7, 0.6), (6.45, -1.4), (6.8, -2.6), (3.4, -2.85), (0.2, -2.6),
                    (-3.2, -2.85), (-6.4, -2.7), (-6.7, -0.8), (-6.45, 1.0)], CREAM, 0, 0, -2.0, t=(98, 211), pop=6)
    c.poly("card_shadow", [(-6.2, 2.9), (-3.4, 3.1), (-0.2, 2.9), (3.3, 3.2), (6.7, 2.8), (7.0, 0.6), (6.8, -1.6), (7.1, -2.9), (3.4, -3.2), (0.2, -2.9),
                           (-3.2, -3.2), (-6.8, -3.0), (-7.1, -0.8), (-6.8, 1.0)], 0x2A2F31, 0, 0, -2.5, t=(98, 211), pop=6)
    c.text("t_sub", "节点动画工作室", -3.4, 1.85, 0.52, INK, z=1, t=(112, 211), pop=5)
    c.text("t_title", "TSUJI", 0, 0.45, 2.6, INK, z=1, matrix="boil", t=(104, 211), pop=7)
    c.poly("bar", [(-3.9, -1.0), (3.9, -1.0), (3.9, -1.7), (-3.9, -1.7)], INK, 0, 0, -1.0, t=(124, 211), pop=5)
    shapes = []
    for i, (sides, col) in enumerate([(32, TEAL), (3, MUSTARD), (4, CRIMSON), (6, JADE), (5, CREAM)]):
        c.add(f"p{i}", "object/polygon", sides=sides, radius=0.28, innerRadius=0, depth=0, faces=1, visible=1,
              location=v3(-3.0 + 1.5 * i, -1.35, 0.5), rotation=v3(0, 0, 0.3 * i), scale=v3(1, 1, 1), color=col, shadeless=1)
        shapes.append(f"p{i}")
    c.reveal(c.group("pictos", shapes), (128, 211), pop=20, stagger=0.8)
    c.text("t_tag", "告别时间轴，来玩吧。", 0, -2.3, 0.62, INK, z=1, t=(152, 211), pop=6)
    # Hand-drawn flourishes: a squiggle under the line and a scribbled star, each one Grease Pencil node drawn on.
    squiggle = [(-3.6 + 0.3 * k, -2.72 + 0.07 * math.sin(k * 1.1)) for k in range(25)]
    c.gp("underline", Canvas.draw_on([squiggle], 164, 180, CRIMSON, width=9, brush="marker_bold", steps=10), z=1.4, t=(164, 211))
    star = [(5.4 + 0.9 * math.sin(a), 1.8 + 0.9 * math.cos(a)) for a in [i * 4 * math.pi / 5 for i in range(6)]]
    c.gp("scribble", Canvas.draw_on([star], 176, 194, MUSTARD, width=9, brush="marker_bold", steps=10), z=1.4, t=(176, 211))
    for i, (sx, sy, col, tt) in enumerate([(-6.0, 2.6, CRIMSON, 110), (5.4, -2.5, TEAL, 116), (-5.9, -2.4, MUSTARD, 122), (6.2, -2.2, JADE, 134), (-1.6, 2.9, PINK, 140), (2.7, -2.9, WHITE, 146)]):
        c.star(f"sparkC{i}", sx, sy, 0.62, col, z=4, points=4, inner=0.14, rot=0.2 * i, t=(tt, 211), pop=4)
        c.spin(f"sparkC{i}", tt, 211, 0, 1.6 * (1 if i % 2 else -1))
    return c


if __name__ == "__main__":
    scenes = [scene1(), scene2(), scene3(), scene4(), scene5(), scene6()]
    write_project("motion_title_sequence", scenes)
    build_font()
