#!/usr/bin/env python3
"""Title-sequence demo in the style of a printed-collage opening: six canvases = six scenes.

Run tools/prep_goodboy_assets.py first (photos → public/demos/goodboy/). Text is Simplified Chinese,
set with Noto Sans SC Black (public/demos/goodboy/noto_sans_sc_black.json, built by
scripts/convertFontSubset.mjs).
"""
import os, sys, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from goodboy_lib import *

S = lambda f: f   # frames helper (30 fps)


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
    c.paper("bg", INK, dark=True, z=-6)

    c.label("Arène : couleur puis noir et blanc")
    asp = aspect("01_arena_wide.jpg")
    for tag, tone, t0, t1 in (("arenaC", "bluegold", 0, 38), ("arenaB", "inkwhite", 38, 64)):
        c.add(f"{tag}_roto", "mask/roto", 0, 0, masks=[{"id": "l", "name": "Torn paper", "mode": "add", "opacity": 1.0, "invert": False,
              "feather": 0.0, "expansion": 0.0, "visible": True,
              "points": [{"x": u, "y": v, "ix": 0.0, "iy": 0.0, "ox": 0.0, "oy": 0.0} for u, v in torn(rnd)]}],
              activeLayer=0, resolution="1024", aspect=asp, showFull=False)
        c.photo(tag, "01_arena_wide.jpg", 0, 0, H * 0.96, z=0, tone=tone, sticker=None, halftone=0 if tag == "arenaC" else 3, rot=0.035 if tag == "arenaC" else 0.02,
                mask=f"{tag}_roto")
        c.appear(tag, (H * 0.96 * asp, H * 0.96, 1), t0, t1, pop=3, drift=0.04)
    # the flicker as it flips to black & white
    c.key("arenaB", "visible", [(0, 1), (38, 1), (40, 0, "hold"), (41, 1, "hold")])
    # sparkles and one big white star crossing
    big = c.star("bigstar", 0.5, 0.2, 3.4, WHITE, z=4, points=4, inner=0.08)
    c.key(big, "scale", [(0, v3(0, 0, 0)), (2, v3(0.2, 0.2, 1), "hold"), (8, v3(1.4, 1.4, 1), "expo"), (16, v3(0, 0, 0), "hold")])
    c.spin(big, 2, 16, -0.6, 0.9)
    for i, (sx, sy, col, t) in enumerate([(-5.5, 2.2, MUSTARD, 3), (-1.5, 1.2, PINK, 6), (4.5, 2.4, WHITE, 9), (-3.0, -1.6, TEAL, 20),
                                          (5.8, -1.2, WHITE, 28), (2.0, 2.5, MUSTARD, 33)]):
        st = c.star(f"spark{i}", sx, sy, 0.55 + 0.25 * (i % 3), col, z=4, points=4, inner=0.14, rot=0.2 * i)
        c.appear(st, (1, 1, 1), t, t + 9, pop=4)
        c.key(st, "rotation", [(t, v3(0, 0, 0)), (t + 9, v3(0, 0, 1.2), "linear")])
    t1 = c.text("round", "第一回合", -4.6, -2.15, 0.7, CREAM, z=4)
    c.appear(t1, (1, 1, 1), 46, 64, pop=5)

    c.label("Le champion")
    c.burst("b_teal", 0.2, -0.2, 3.8, TEAL, z=-3, n=11, inner=0.5, jag=0.3, seed=3)
    c.burst("b_gold", 0.2, -0.2, 3.1, MUSTARD, z=-2.5, n=9, inner=0.45, jag=0.3, seed=4, rot=0.3)
    c.appear("b_teal", (1, 1, 1), 64, 113, pop=6); c.appear("b_gold", (1, 1, 1), 66, 113, pop=6)
    c.spin("b_teal", 64, 113, 0, 0.25); c.spin("b_gold", 66, 113, 0.3, -0.1)
    c.photo("boxer", "02_boxer_victory.png", -0.6, -0.1, 5.7, z=0.5, tone="ink", rot=0.0)
    c.appear("boxer", (5.7 * aspect("02_boxer_victory.png"), 5.7, 1), 64, 113, pop=6, drift=0.05)
    c.move("boxer", (-0.6, -6, 0.5), (-0.6, -0.1, 0.5), 64, dur=7)
    nm = c.text("name_boxer", "设计师", 4.4, 0.3, 1.3, CREAM, z=4)
    c.appear(nm, (1, 1, 1), 72, 113, pop=5)

    c.label("L'adversaire")
    asp3 = aspect("03_boxer_face_clinch.jpg")
    c.add("clinch_roto", "mask/roto", 0, 0, masks=[{"id": "l", "name": "Torn paper", "mode": "add", "opacity": 1.0, "invert": False, "feather": 0.0,
          "expansion": 0.0, "visible": True,
          "points": [{"x": u, "y": v, "ix": 0.0, "iy": 0.0, "ox": 0.0, "oy": 0.0} for u, v in torn(random.Random(7), amp=0.05, inset=0.08)]}],
          activeLayer=0, resolution="1024", aspect=asp3, showFull=False)
    c.burst("b_red", 1.5, 0, 4.2, CRIMSON, z=-3, n=10, inner=0.42, jag=0.3, seed=9)
    c.burst("b_red2", 1.5, 0, 3.3, MUSTARD, z=-2.8, n=8, inner=0.5, jag=0.3, seed=10, rot=0.4)
    c.appear("b_red", (1, 1, 1), 113, 161, pop=5); c.appear("b_red2", (1, 1, 1), 115, 161, pop=5)
    c.spin("b_red", 113, 161, 0, 0.3)
    c.photo("clinch", "03_boxer_face_clinch.jpg", 1.6, 0.1, 4.6, z=0.5, tone="ink", sticker=CREAM, thick=10, halftone=2, mask="clinch_roto")
    c.appear("clinch", (4.6 * asp3, 4.6, 1), 113, 161, pop=4, drift=0.08)
    nm = c.text("name_ae", "后期特效", -4.3, -0.2, 0.95, MUSTARD, z=4)
    c.appear(nm, (1, 1, 1), 121, 161, pop=5)

    c.label("Le coach")
    c.burst("b_jade", -1.4, -0.2, 3.9, JADE, z=-3, n=12, inner=0.5, jag=0.3, seed=21)
    c.burst("b_gold2", -1.4, -0.2, 3.0, MUSTARD, z=-2.8, n=10, inner=0.45, jag=0.3, seed=22, rot=0.2)
    c.appear("b_jade", (1, 1, 1), 161, 241, pop=6); c.appear("b_gold2", (1, 1, 1), 163, 241, pop=6)
    c.spin("b_jade", 161, 241, 0, -0.3)
    c.photo("coach", "04_coach_cap.png", -1.2, -0.3, 5.8, z=0.5, tone="ink", sticker=TEAL, thick=12)
    c.appear("coach", (5.8 * aspect("04_coach_cap.png"), 5.8, 1), 161, 241, pop=6, drift=0.06)
    c.move("coach", (-8, -0.3, 0.5), (-1.2, -0.3, 0.5), 161, dur=9)
    nm = c.text("name_coach", "教练", 4.6, 0.2, 1.8, CREAM, z=4)
    c.appear(nm, (1, 1, 1), 172, 241, pop=5)
    return c



def hold_zero(c, nid, t0, t1, base=(1, 1, 1), pop=6):
    c.appear(nid, base, t0, t1, pop=pop)


# --------------------------------------------------------------------------- 2. LE CASTING
BADGE_FILE = "06_id_badge_blank.png"
WIN = (0.452, 0.617, 0.175)        # photo window on the badge: centre u, centre v (from top), height / badge height


def badge(c, key, x, y, h, face, t0, t1, amp=0.05, period=36, phase=0):
    """A badge on its lanyard: hangs from (x, y) and swings; the headshot sits in its window.
    Each part is keyed on its own (Merge groups do not carry animation reliably): both orbit the hanging point."""
    wb = h * aspect(BADGE_FILE)
    hs = h * WIN[2] * 1.12
    parts = {f"{key}_card": (0.0, -h / 2), f"{key}_face": ((WIN[0] - 0.5) * wb, -h / 2 + (0.5 - WIN[1]) * h)}
    c.photo(f"{key}_card", BADGE_FILE, x, y - h / 2, h, z=0.5, tone="gold", sticker=None, halftone=2)
    c.photo(f"{key}_face", face, x + parts[f"{key}_face"][0], y + parts[f"{key}_face"][1], hs, z=0.6, tone="ink", sticker=None, halftone=2)
    c.appear(f"{key}_card", (wb, h, 1), t0, t1, pop=6)
    c.appear(f"{key}_face", (hs * aspect(face), hs, 1), t0, t1, pop=6)
    step = 3
    for nm, (ox, oy) in parts.items():
        locs, rots = [], []
        t = t0 + 6
        while t <= t1:
            th = amp * math.sin((t - t0) / period * math.tau + phase)
            locs.append((t, v3(x + ox * math.cos(th) - oy * math.sin(th), y + ox * math.sin(th) + oy * math.cos(th), 0.5 if nm.endswith("card") else 0.6), "smooth"))
            rots.append((t, v3(0, 0, th), "smooth"))
            t += step
        c.key(nm, "location", locs); c.key(nm, "rotation", rots)
    return key


def scene2():
    c = Canvas(279, warp=[(0, 0), (60, 70), (100, 105), (205, 209), (226, 227), (270, 279)])
    c.setup(bg=INK, next_canvas=3, index=2)
    c.paper("bg", INK, dark=True, z=-7)
    c.label("Médaille")
    c.burst("m_cream", 0, 0, 5.8, CREAM, z=-3, n=7, inner=0.38, jag=0.25, seed=31, rot=0.2)
    c.burst("m_jade", 1.8, -1.5, 2.4, JADE, z=-2.8, n=8, inner=0.5, jag=0.3, seed=32)
    c.appear("m_cream", (1, 1, 1), 0, 61, pop=6); c.spin("m_cream", 0, 61, 0.2, 0.55)
    c.appear("m_jade", (1, 1, 1), 4, 61, pop=6)
    c.photo("medal", "05_gold_medal.png", 0, -0.2, 6.6, z=0.5, tone="gold", sticker=None, halftone=3)
    c.appear("medal", (6.6 * aspect("05_gold_medal.png"), 6.6, 1), 0, 61, pop=6)
    c.sway("medal", 8, 61, 0.07, 34)
    t = c.text("t_champ", "冠军", -4.8, 0.2, 1.5, MUSTARD, z=4); c.appear(t, (1, 1, 1), 14, 61, pop=5)
    c.label("Badges")
    c.paper("bgj", JADE, dark=True, z=-5.5); c.appear("bgj", (W * 1.15, H * 1.25, 1), 60, 226, pop=1)
    c.burst("j_cream", 0, -0.2, 6.2, CREAM, z=-3, n=8, inner=0.4, jag=0.3, seed=41)
    c.appear("j_cream", (1, 1, 1), 60, 201, pop=6); c.spin("j_cream", 60, 201, 0, 0.5)
    badge(c, "badge1", 0, 3.0, 5.9, "07a_headshot.png", 60, 100, amp=0.06)
    faces = ["07a_headshot.png", "07b_headshot.png", "07c_headshot.png", "07d_headshot.png", "07e_headshot.png"]
    names = ["节点", "实时", "物理", "粒子", "半调"]
    for i in range(5):
        t0 = 100 + 4 * i
        badge(c, f"badge{i + 2}", -5.6 + 2.8 * i, 3.0, 4.7, faces[i], t0, 201, amp=0.05, period=34, phase=i)
        tt = c.text(f"nm{i}", names[i], -5.6 + 2.8 * i, -2.35, 0.62, MUSTARD, z=4); c.appear(tt, (1, 1, 1), t0 + 8, 201, pop=5)
    c.label("Voiture et titre")
    car_asp = aspect("08_red_sports_car.png")
    c.photo("car", "08_red_sports_car.png", 0, -0.7, 1.5, z=0.5, tone="crimson", sticker=None, halftone=2)
    c.key("car", "location", [(205, v3(-12, -0.7, 0.5), "hold"), (224, v3(12, -0.7, 0.5), "linear")])
    c.key("car", "scale", [(0, v3(0, 0, 0)), (205, v3(1.5 * car_asp, 1.5, 1), "hold"), (226, v3(0, 0, 0), "hold")])
    for i, (dy, ln) in enumerate([(0.2, 3.5), (-0.1, 4.5), (-0.4, 3.0)]):
        nm = c.bar(f"carl{i}", 0, -0.7 + dy, ln, 0.12, WHITE, z=0.4)
        off = 1.5 * car_asp / 2 + ln / 2 + 0.2
        c.key(nm, "location", [(205, v3(-12 - off, -0.7 + dy, 0.4), "hold"), (224, v3(12 - off, -0.7 + dy, 0.4), "linear")])
        c.key(nm, "scale", [(0, v3(0, 0, 0)), (205, v3(ln, 0.12, 1), "hold"), (226, v3(0, 0, 0), "hold")])
    for i, (sx, sy, col, tt) in enumerate([(-5, 2, MUSTARD, 232), (4.8, -2, TEAL, 240), (-3, -2.2, PINK, 248), (5.5, 2.2, CREAM, 256)]):
        st = c.star(f"sp{i}", sx, sy, 0.6, col, z=4, points=4, inner=0.14); c.appear(st, (1, 1, 1), tt, 271, pop=4)
    t = c.text("t_cast", "演职员表", 0, 0, 1.7, CREAM, z=4); c.appear(t, (1, 1, 1), 228, 271, pop=6)
    return c


# --------------------------------------------------------------------------- 3. L'IMPACT
def crack(rnd, x, y, ang, length, segs=7, jit=0.45):
    pts, a = [(x, y)], ang
    step = length / segs
    for _ in range(segs):
        a += rnd.uniform(-jit, jit)
        x += math.cos(a) * step * rnd.uniform(0.7, 1.3); y += math.sin(a) * step * rnd.uniform(0.7, 1.3)
        pts.append((x, y))
    return pts


def scene3():
    c = Canvas(261, warp=[(0, 0), (40, 35), (96, 104), (151, 157), (216, 226), (270, 261)])
    c.setup(bg=INK, next_canvas=4, index=3)
    c.paper("bg", INK, dark=True, z=-7)
    c.label("Poing et voiture")
    c.photo("fistA", "09_fist_wrapped.png", 3.2, 0.2, 3.0, z=0.6, tone="jade", sticker=None, halftone=3)
    c.appear("fistA", (3.0 * aspect("09_fist_wrapped.png"), 3.0, 1), 0, 41, pop=2)
    c.move("fistA", (12, 0.2, 0.6), (3.2, 0.2, 0.6), 2, dur=9)
    c.photo("carA", "08_red_sports_car.png", -3.0, 0.0, 1.7, z=0.5, tone="crimson", sticker=None, halftone=2)
    c.appear("carA", (1.7 * aspect("08_red_sports_car.png"), 1.7, 1), 0, 41, pop=2)
    c.move("carA", (-12, 0.0, 0.5), (-3.0, 0.0, 0.5), 9, dur=9)
    c.label("Collision")
    c.paper("bgc", CREAM, dark=False, z=-5.5); c.appear("bgc", (W * 1.15, H * 1.25, 1), 40, 151, pop=1)
    c.burst("z_red", 0, 0.1, 5.4, CRIMSON, z=-3, n=9, inner=0.28, jag=0.4, seed=51)
    c.appear("z_red", (1, 1, 1), 40, 96, pop=4); c.spin("z_red", 40, 96, 0, 0.25)
    c.burst("z_gold", 0.3, 0.1, 2.7, MUSTARD, z=-2.5, n=8, inner=0.35, jag=0.4, seed=52)
    c.appear("z_gold", (1, 1, 1), 52, 96, pop=4)
    c.photo("fistB", "09_fist_wrapped.png", 2.2, 0.2, 3.2, z=0.6, tone="jade", sticker=None, halftone=3)
    c.appear("fistB", (3.2 * aspect("09_fist_wrapped.png"), 3.2, 1), 40, 96, pop=2)
    c.key("fistB", "location", [(40, v3(7, 0.2, 0.6), "hold"), (50, v3(1.0, 0.2, 0.6), "expo"), (96, v3(1.4, 0.2, 0.6), "linear")])
    c.photo("carB", "08_red_sports_car.png", -2.6, 0.2, 1.8, z=0.5, tone="crimson", sticker=None, halftone=2, rot=1.2)
    c.appear("carB", (1.8 * aspect("08_red_sports_car.png"), 1.8, 1), 40, 96, pop=2)
    c.key("carB", "location", [(40, v3(-8, 0.2, 0.5), "hold"), (52, v3(-1.8, 0.2, 0.5), "expo"), (62, v3(-3.4, 0.4, 0.5), "back"), (96, v3(-3.8, 0.8, 0.5), "linear")])
    t = c.text("t_break", "碎裂", 4.9, 1.9, 1.3, INK, z=4); c.appear(t, (1, 1, 1), 58, 96, pop=5)
    c.label("Le coup")
    c.poly("slab", [(-9, -0.5), (-6, -0.3), (-4.4, -0.75), (-2.2, -0.45), (0.1, -0.6), (2.0, -0.3), (4.3, -0.7), (6.2, -0.4), (9, -0.6), (9, -5), (-9, -5)],
           INK, 0, 0, -2.0)
    c.appear("slab", (1, 1, 1), 96, 151, pop=1)
    c.photo("fistC", "09_fist_wrapped.png", 0.3, 2.3, 3.4, z=0.6, tone="jade", sticker=None, halftone=3, rot=math.pi / 2)
    c.appear("fistC", (3.4 * aspect("09_fist_wrapped.png"), 3.4, 1), 96, 151, pop=1)
    c.key("fistC", "location", [(96, v3(0.3, 9.0, 0.6), "hold"), (101, v3(0.3, 2.3, 0.6), "expo"), (151, v3(0.3, 2.2, 0.6), "linear")])
    c.burst("hit_red", 0.3, -0.5, 1.8, CRIMSON, z=-1, n=9, inner=0.3, jag=0.5, seed=53)
    c.burst("hit_gold", 0.3, -0.5, 1.3, MUSTARD, z=-0.9, n=7, inner=0.3, jag=0.5, seed=54)
    c.appear("hit_red", (1, 1, 1), 101, 124, pop=3); c.appear("hit_gold", (1, 1, 1), 102, 120, pop=3)
    c.label("Fissures")
    rnd = random.Random(5)
    cr = []
    for i in range(12):
        ang = -math.pi / 2 + rnd.uniform(-1.4, 1.4) + (math.pi if i % 4 == 3 else 0) * 0
        cr.append(crack(rnd, 0.3, -0.5, ang, rnd.uniform(3.2, 7.5), segs=8))
    for i in range(14):
        base = rnd.choice(cr); k = rnd.randrange(2, len(base) - 1)
        cr.append(crack(rnd, base[k][0], base[k][1], rnd.uniform(0, math.tau), rnd.uniform(1.2, 3.2), segs=5, jit=0.6))
    for i, pts in enumerate(cr):
      with c.block():
        c.add(f"cr{i}_p", "curve/from_points", 0, 0, type="linear", closed=False, tension=0.5, sag=0,
              pointsList=[v3(px, py, 0) for px, py in pts], location=v3(0, 0, 0.2), rotation=v3(), scale=v3(1, 1, 1))
        c.add(f"cr{i}", "curve/to_mesh", 0, 0, thickness=0.045 if i < 12 else 0.03, startProgress=0.0, endProgress=0.0, tubularSegments=24, radialSegments=3,
              closed=False, visible=1, location=v3(), rotation=v3(), scale=v3(1, 1, 1), color=CREAM, shadeless=1)
        c.wire(f"cr{i}_p", "curve", f"cr{i}", "curve"); c.put(f"cr{i}")
        d0 = 106 + (0 if i < 12 else 14) + (i % 12) * 1
        c.key(f"cr{i}", "endProgress", [(d0, 0.0), (d0 + (22 if i < 12 else 26), 1.0, "expo")])
        c.key(f"cr{i}", "visible", [(0, 0), (d0, 1, "hold"), (216, 0, "hold")])
    c.label("Visage dans la déchirure")
    asp = aspect("10_woman_face_intense.jpg")
    c.add("face_roto", "mask/roto", 0, 0, masks=[{"id": "l", "name": "Torn paper", "mode": "add", "opacity": 1.0, "invert": False, "feather": 0.0,
          "expansion": 0.0, "visible": True, "points": [{"x": u, "y": v, "ix": 0.0, "iy": 0.0, "ox": 0.0, "oy": 0.0} for u, v in torn(random.Random(9), amp=0.05, inset=0.1)]}],
          activeLayer=0, resolution="1024", aspect=asp, showFull=False)
    c.poly("wedge", [(1.4, 0.2), (7.4, 3.4), (7.4, -3.2)], CREAM, 0, 0, -1.8); c.appear("wedge", (1, 1, 1), 216, 271, pop=3)
    for i in range(7):
        a = -0.5 + i * 0.17
        c.line(f"ray{i}", 2.2, 0.2, 2.2 + 11 * math.cos(a), 0.2 + 11 * math.sin(a), 0.5 + 0.12 * (i % 3), 0x9A9C94 if i % 2 == 0 else 0xBFBCAA, z=-1.5)
        c.appear(f"ray{i}", (1, 1, 1), 216, 271, pop=3)
    c.photo("face", "10_woman_face_intense.jpg", -2.2, -0.1, 4.8, z=0.5, tone="ink", sticker=None, halftone=2, mask="face_roto")
    c.appear("face", (4.8 * asp, 4.8, 1), 216, 271, pop=3, drift=0.05)
    t = c.text("t_phys", "物理", 5.2, -0.3, 1.25, INK, z=4); c.appear(t, (1, 1, 1), 230, 271, pop=5)
    return c



# --------------------------------------------------------------------------- 4. LA CIBLE
def scene4():
    c = Canvas(279, warp=[(0, 0), (46, 52), (96, 105), (146, 157), (216, 227), (263, 268), (270, 279)])
    c.setup(bg=CRIMSON, next_canvas=5, index=4)
    c.paper("bgr", CRIMSON, dark=True, z=-7); c.appear("bgr", (W * 1.15, H * 1.25, 1), 0, 263, pop=1)
    c.label("Lanceuse")
    c.burst("a_gold", 2.4, 0.7, 3.6, MUSTARD, z=-3, n=10, inner=0.35, jag=0.35, seed=61)
    c.burst("a_cream", 2.4, 0.7, 2.3, CREAM, z=-2.8, n=8, inner=0.4, jag=0.35, seed=62, rot=0.3)
    c.appear("a_gold", (1, 1, 1), 0, 46, pop=4); c.appear("a_cream", (1, 1, 1), 3, 46, pop=4)
    c.spin("a_gold", 0, 46, 0, 0.3)
    for i in range(7):
        a = -0.45 + i * 0.15
        c.line(f"ar{i}", 1.4, 0.7, 1.4 + 12 * math.cos(a), 0.7 + 12 * math.sin(a), 0.35 + 0.1 * (i % 3), WHITE if i % 2 == 0 else 0x9A9C94, z=-2.0)
        c.appear(f"ar{i}", (1, 1, 1), 2, 46, pop=3)
    c.photo("thrower", "11_woman_throwing_pose.png", -2.6, -0.1, 5.7, z=0.5, tone="silhouette", sticker=None, halftone=0)
    c.appear("thrower", (5.7 * aspect("11_woman_throwing_pose.png"), 5.7, 1), 0, 46, pop=5, drift=0.04)
    c.label("Fléchette")
    dasp = aspect("12_dart_flying.png")
    c.photo("dart", "12_dart_flying.png", 0, 0, 2.4, z=0.5, tone="ink", sticker=None, halftone=2, rot=0.65)
    c.key("dart", "location", [(46, v3(-11, 2.4, 0.5), "hold"), (60, v3(11, -1.2, 0.5), "linear")])
    c.key("dart", "scale", [(0, v3(0, 0, 0)), (46, v3(2.4 * dasp, 2.4, 1), "hold"), (61, v3(0, 0, 0), "hold")])
    ang = math.atan2(-3.6, 22)
    for i, dy in enumerate([0.28, 0.0, -0.3, 0.5]):
        ln = 3.5 + i * 1.2
        nm = c.bar(f"dl{i}", 0, 0, ln, 0.12, WHITE, rot=ang, z=0.4)
        d = 1.6 + ln / 2
        ox, oy = -d * math.cos(ang) - dy * math.sin(ang) * -1, -d * math.sin(ang) + dy * math.cos(ang)
        c.key(nm, "location", [(46, v3(-11 + ox, 2.4 + oy, 0.4), "hold"), (60, v3(11 + ox, -1.2 + oy, 0.4), "linear")])
        c.key(nm, "scale", [(0, v3(0, 0, 0)), (46, v3(ln, 0.12, 1), "hold"), (61, v3(0, 0, 0), "hold")])
    for i in range(6):
        a = i * 0.9
        c.line(f"bd{i}", 0.2, 0.0, 0.2 + 12 * math.cos(a), 12 * math.sin(a), 0.6, CREAM if i % 2 == 0 else 0x9A9C94, z=-3.0)
        c.appear(f"bd{i}", (1, 1, 1), 62, 96, pop=3)
    c.photo("dartB", "12_dart_flying.png", 0.2, 0.0, 4.8, z=0.5, tone="ink", sticker=CREAM, thick=10, halftone=3, rot=0.9)
    c.appear("dartB", (4.8 * aspect("12_dart_flying.png"), 4.8, 1), 62, 96, pop=5, drift=0.08)
    c.spin("dartB", 62, 96, 0.7, 0.95)
    c.label("Montre")
    c.photo("watch", "13_gold_watch.png", 0, -0.1, 5.9, z=0.5, tone="gold", sticker=None, halftone=3)
    c.appear("watch", (5.9 * aspect("13_gold_watch.png"), 5.9, 1), 96, 146, pop=5)
    c.sway("watch", 100, 146, 0.04, 30)
    c.bar("streak", 0, 0, 3.2, 0.28, WHITE, rot=-0.5, z=1.0)
    c.key("streak", "location", [(128, v3(-9, 3.4, 1.0), "hold"), (140, v3(9, -3.4, 1.0), "linear")])
    c.key("streak", "scale", [(0, v3(0, 0, 0)), (128, v3(3.2, 0.28, 1), "hold"), (141, v3(0, 0, 0), "hold")])
    c.label("Costume et croix")
    c.photo("suit", "14_suit_torso.png", -1.4, -0.2, 6.0, z=0.5, tone="ink", sticker=None, halftone=3)
    c.appear("suit", (6.0 * aspect("14_suit_torso.png"), 6.0, 1), 146, 216, pop=5, drift=0.04)
    for k, a in enumerate((math.pi / 4, -math.pi / 4)):
        c.poly(f"xbar{k}", [(-3.6, -0.45), (3.6, -0.45), (3.6, 0.45), (-3.6, 0.45)], WHITE, -1.4, 0.4, 1.5, rot=a)
        c.appear(f"xbar{k}", (1, 1, 1), 174 + 3 * k, 216, pop=4)
    t = c.text("t_half", "半调", 4.9, -0.3, 1.2, MUSTARD, z=4); c.appear(t, (1, 1, 1), 158, 216, pop=5)
    c.label("Cible")
    c.paper("bgi", INK, dark=True, z=-5.5); c.appear("bgi", (W * 1.15, H * 1.25, 1), 216, 263, pop=1)
    for i, R in enumerate([0.9, 1.7, 2.5, 3.3, 4.1, 4.9]):
        c.add(f"ring{i}", "object/polygon", 0, 0, sides=72, radius=R, innerRadius=R - 0.045, depth=0, faces=1, visible=1,
              location=v3(0, 0, -1.0), rotation=v3(), scale=v3(1, 1, 1), color=CREAM, shadeless=1)
        c.put(f"ring{i}"); c.appear(f"ring{i}", (1, 1, 1), 216 + 3 * i, 263, pop=5)
    for i, (dx, ch) in enumerate([(-4.5, "7"), (-3.7, "8"), (-2.9, "9"), (-2.1, "9"), (-1.3, "9")]):
        pass
    for i, (R, ch) in enumerate([(0.0, "X"), (1.3, "9"), (2.1, "9"), (2.9, "8"), (3.7, "7"), (4.5, "7")]):
        for sgn in ((1, -1) if R else (1,)):
            t = c.text(f"dg{i}{sgn}", ch, sgn * R, 0, 0.55 if R else 0.9, CREAM, z=0.5); c.appear(t, (1, 1, 1), 218 + 3 * i, 263, pop=4)
    c.paper("bgt", TEAL, dark=True, z=-5.0); c.appear("bgt", (W * 1.15, H * 1.25, 1), 259, 271, pop=3)
    return c


# --------------------------------------------------------------------------- 5. LE CHAOS
def scene5():
    c = Canvas(226, warp=[(0, 0), (50, 52), (110, 104), (170, 156), (240, 226)])
    c.setup(bg=TEAL, next_canvas=6, index=5)
    for key, col, t0, t1 in (("bgA", TEAL, 0, 51), ("bgB", CRIMSON, 50, 111), ("bgC", TEAL, 110, 171), ("bgD", JADE, 170, 241)):
        c.paper(key, col, dark=True, z=-7); c.appear(key, (W * 1.15, H * 1.25, 1), t0, t1, pop=1)
    c.label("Lunettes et éclair")
    c.burst("a_cr", 1.2, 0, 6.2, CREAM, z=-3, n=9, inner=0.35, jag=0.3, seed=71)
    c.appear("a_cr", (1, 1, 1), 0, 51, pop=5); c.spin("a_cr", 0, 51, 0, 0.35)
    c.photo("glasses", "15_man_glasses_pointing.png", -3.9, -0.2, 5.9, z=0.5, tone="ink", sticker=CREAM, thick=10)
    c.appear("glasses", (5.9 * aspect("15_man_glasses_pointing.png"), 5.9, 1), 0, 51, pop=5, drift=0.04)
    c.move("glasses", (-9, -0.2, 0.5), (-3.9, -0.2, 0.5), 0, dur=8)
    c.poly("bolt", [(-1.9, 0.9), (1.2, 1.7), (0.6, 0.95), (3.6, 1.5), (2.7, 0.8), (5.6, 0.35), (2.2, 0.5), (3.0, 0.1), (0.2, 0.55), (0.9, 0.05), (-1.9, 0.6)],
           CRIMSON, 0, 0, 0.4)
    c.appear("bolt", (1, 1, 1), 8, 51, pop=3)
    t = c.text("t_notl", "没有时间轴", 3.6, -1.7, 0.8, INK, z=4); c.appear(t, (1, 1, 1), 18, 51, pop=5)
    c.label("Boule de bowling 3D et jambes")
    c.add("sun", "light/directional", 0, 0, color=0xFFFFFF, intensity=1.3, location=v3(-4, 5, 9), castShadow=0)
    c.put("sun", "light")
    c.add("ball_tex", "texture/procedural", 0, 0, type="turbulence", colorA=0x1D4F94, colorB=0xA6DCF2, size="1024 × 1024", scale=4, seed=7)
    R_BALL = 1.25
    c.add("ball_s", "object/sphere", 0, 0, visible=1, location=v3(-9.5, -1.3, 1.0), rotation=v3(), scale=v3(2.5, 2.5, 2.5), color=0xFFFFFF, roughness=0.3, metalness=0.1, shadeless=1)
    c.wire("ball_tex", "texture", "ball_s", "texture")
    c.put("ball_s")
    t0, t1 = 52, 98
    xs = lambda t: -9.5 + (t - t0) / (t1 - t0) * 19.0
    c.key("ball_s", "location", [(t0, v3(-9.5, -1.3, 1.0), "hold"), (t1, v3(9.5, -1.3, 1.0), "linear")])
    c.key("ball_s", "scale", [(0, v3(0, 0, 0)), (t0, v3(2.5, 2.5, 2.5), "hold"), (t1 + 1, v3(0, 0, 0), "hold")])
    for i, (hx, hy) in enumerate([(-0.3, 0.45), (0.28, 0.5), (0.0, 0.0)]):
        c.add(f"hole{i}", "object/sphere", 0, 0, visible=1, location=v3(xs(t0) + hx, -1.3 + hy, 2.4), rotation=v3(), scale=v3(0.42, 0.42, 0.2), color=INK, shadeless=1)
        c.put(f"hole{i}")
        locs = []
        for t in range(t0, t1 + 1, 2):
            th = -(xs(t) + 9.5) / R_BALL
            locs.append((t, v3(xs(t) + hx * math.cos(th) - hy * math.sin(th), -1.3 + hx * math.sin(th) + hy * math.cos(th), 2.4), "linear"))
        c.key(f"hole{i}", "location", [locs[0][:2] + ("hold",)] + locs[1:])
        c.key(f"hole{i}", "scale", [(0, v3(0, 0, 0)), (t0, v3(0.42, 0.42, 0.2), "hold"), (t1 + 1, v3(0, 0, 0), "hold")])
    c.key("ball_s", "rotation", [(t0, v3(0, 0, 0)), (t1, v3(0, 0, -19.0 / R_BALL), "linear")])
    c.photo("legs", "17_legs_red_heels.png", 3.8, -0.4, 5.4, z=0.5, tone="ink", sticker=CREAM, thick=14)
    c.appear("legs", (5.4 * aspect("17_legs_red_heels.png"), 5.4, 1), 82, 111, pop=5, drift=0.03)
    c.move("legs", (9, -0.4, 0.5), (3.8, -0.4, 0.5), 82, dur=9)
    t = c.text("t_coll", "碰撞", -3.9, 1.5, 1.2, MUSTARD, z=4); c.appear(t, (1, 1, 1), 66, 111, pop=5)
    c.label("Explosion")
    c.burst("c_cr", 0, 0, 6.8, CREAM, z=-4, n=12, inner=0.55, jag=0.3, seed=81)
    c.burst("c_red", 0, 0, 5.2, CRIMSON, z=-3.8, n=10, inner=0.4, jag=0.35, seed=82)
    c.burst("c_gold", 0, 0, 3.4, MUSTARD, z=-3.6, n=8, inner=0.45, jag=0.35, seed=83)
    for k, d in enumerate(("c_cr", "c_red", "c_gold")):
        c.appear(d, (1, 1, 1), 110 + 2 * k, 171, pop=5); c.spin(d, 110, 171, 0.2 * k, 0.2 * k + (0.5 if k % 2 else -0.5))
    c.photo("joy", "18_man_arms_up_joy.png", -4.7, -0.2, 5.9, z=0.5, tone="ink", sticker=CREAM, thick=10)
    c.appear("joy", (5.9 * aspect("18_man_arms_up_joy.png"), 5.9, 1), 114, 171, pop=6)
    c.move("joy", (-4.7, -7, 0.5), (-4.7, -0.2, 0.5), 114, dur=8)
    c.photo("round", "07d_headshot.png", 4.4, -0.3, 4.4, z=0.5, tone="ink", sticker=CREAM, thick=12)
    c.appear("round", (4.4 * aspect("07d_headshot.png"), 4.4, 1), 124, 171, pop=6)
    c.move("round", (4.4, -7, 0.5), (4.4, -0.3, 0.5), 124, dur=8)
    c.label("Deux visages")
    c.burst("d_cr", -3.4, 0, 4.9, CREAM, z=-3, n=10, inner=0.45, jag=0.3, seed=91)
    c.burst("d_tl", 3.9, 0, 4.4, TEAL, z=-3, n=9, inner=0.45, jag=0.3, seed=92)
    c.appear("d_cr", (1, 1, 1), 170, 241, pop=5); c.appear("d_tl", (1, 1, 1), 174, 241, pop=5)
    c.spin("d_cr", 170, 241, 0, 0.3); c.spin("d_tl", 170, 241, 0, -0.3)
    c.photo("faceE", "07e_headshot.png", -3.4, -0.2, 5.5, z=0.5, tone="ink", sticker=CREAM, thick=12)
    c.appear("faceE", (5.5 * aspect("07e_headshot.png"), 5.5, 1), 170, 241, pop=5)
    c.photo("faceB", "07b_headshot.png", 3.9, -0.2, 5.3, z=0.5, tone="ink", sticker=CREAM, thick=12)
    c.appear("faceB", (5.3 * aspect("07b_headshot.png"), 5.3, 1), 178, 241, pop=5)
    t = c.text("t_rt", "实时", 0.2, -1.9, 0.8, CREAM, z=4); c.appear(t, (1, 1, 1), 192, 241, pop=5)
    return c


# --------------------------------------------------------------------------- 6. LE PODIUM ET LE TITRE
def scene6():
    c = Canvas(225, warp=[(0, 0), (71, 70), (100, 105), (210, 225)])
    c.setup(bg=INK, next_canvas=1, index=6)
    c.paper("bgd", INK, dark=True, z=-7)
    c.label("Podium")
    c.paper("bgr", CRIMSON, dark=True, z=-6); c.appear("bgr", (W * 1.15, H * 1.25, 1), 0, 71, pop=1)
    c.burst("p_tl", 0, 0.6, 7.0, TEAL, z=-4, n=11, inner=0.45, jag=0.3, seed=101)
    c.burst("p_gold", 0, 0.6, 5.2, MUSTARD, z=-3.8, n=9, inner=0.4, jag=0.3, seed=102)
    c.appear("p_tl", (1, 1, 1), 0, 71, pop=6); c.appear("p_gold", (1, 1, 1), 3, 71, pop=6)
    c.spin("p_tl", 0, 71, 0, 0.3); c.spin("p_gold", 3, 71, 0.2, -0.2)
    for i, (bx, by, rot) in enumerate([(-4.9, 2.1, 0.05), (0.0, 2.4, 0.0), (4.9, 2.1, -0.05)]):
        c.photo(f"banner{i}", "23_stamp_ink_texture.jpg", bx, by, 3.0, z=-1.0, tone="gold", sticker=None, halftone=3, rot=rot, wfac=0.55)
        c.appear(f"banner{i}", (3.0 * aspect("23_stamp_ink_texture.jpg") * 0.55, 3.0, 1), 4 + 3 * i, 71, pop=6)
        c.sway(f"banner{i}", 12, 71, 0.03, 28, phase=i, base=rot)
    c.poly("podium", [(-5.6, -2.55), (5.6, -2.55), (5.6, -4.5), (-5.6, -4.5)], JADE, 0, 0, 0.3)
    c.appear("podium", (1, 1, 1), 6, 71, pop=6)
    c.photo("lineup", "19_five_lineup.png", 0, -0.8, 3.7, z=0.5, tone="silhouette", sticker=None, halftone=0)
    c.appear("lineup", (3.7 * aspect("19_five_lineup.png"), 3.7, 1), 8, 71, pop=6)
    c.move("lineup", (0, -7, 0.5), (0, -0.8, 0.5), 8, dur=9)
    t = c.text("t_one", "1", 0, -3.5, 0.6, CREAM, z=4); c.appear(t, (1, 1, 1), 16, 71, pop=4)
    t = c.text("t_champ", "冠军", -5.0, -0.3, 1.2, CREAM, z=4); c.appear(t, (1, 1, 1), 22, 71, pop=5)
    for i in range(8):
        ang = -2.9 + i * 0.4
        c.line(f"pl{i}", 0, -2.6, 13 * math.cos(ang) * 1.2, -2.6 + 9 * math.sin(ang + 3.14159) * -1, 0.2, WHITE, z=-3.5)
        c.appear(f"pl{i}", (1, 1, 1), 2, 71, pop=3)
    c.label("Étincelles")
    for i, (sx, sy, col, tt) in enumerate([(-5.2, 1.5, CRIMSON, 74), (3.3, -1.8, TEAL, 79), (-1.2, 2.0, MUSTARD, 84), (5.6, 1.4, WHITE, 89), (-3.4, -1.4, JADE, 93)]):
        st = c.star(f"sparkB{i}", sx, sy, 0.7, col, z=4, points=4, inner=0.13, rot=0.2 * i)
        c.appear(st, (1, 1, 1), tt, 100, pop=4)
    c.label("Titre")
    c.poly("card", [(-6.6, 2.5), (-3.8, 2.75), (-0.4, 2.55), (3.1, 2.8), (6.3, 2.45), (6.7, 0.6), (6.45, -1.4), (6.8, -2.6), (3.4, -2.85), (0.2, -2.6),
                    (-3.2, -2.85), (-6.4, -2.7), (-6.7, -0.8), (-6.45, 1.0)], CREAM, 0, 0, -2.0)
    c.appear("card", (1, 1, 1), 98, 211, pop=6)
    c.poly("card_shadow", [(-6.2, 2.9), (-3.4, 3.1), (-0.2, 2.9), (3.3, 3.2), (6.7, 2.8), (7.0, 0.6), (6.8, -1.6), (7.1, -2.9), (3.4, -3.2), (0.2, -2.9),
                           (-3.2, -3.2), (-6.8, -3.0), (-7.1, -0.8), (-6.8, 1.0)], 0x2A2F31, 0, 0, -2.5)
    c.appear("card_shadow", (1, 1, 1), 98, 211, pop=6)
    t = c.text("t_sub", "节点动画工作室", -3.4, 1.85, 0.52, INK, z=1); c.appear(t, (1, 1, 1), 112, 211, pop=5)
    t = c.text("t_title", "TSUJI", 0, 0.45, 2.6, INK, z=1); c.appear(t, (1, 1, 1), 104, 211, pop=7)
    c.poly("bar", [(-3.9, -1.0), (3.9, -1.0), (3.9, -1.7), (-3.9, -1.7)], INK, 0, 0, -1.0); c.appear("bar", (1, 1, 1), 124, 211, pop=5)
    shapes = [("p0", 32, TEAL), ("p1", 3, MUSTARD), ("p2", 4, CRIMSON), ("p3", 6, JADE), ("p4", 5, CREAM)]
    for i, (nm, sides, col) in enumerate(shapes):
        c.add(nm, "object/polygon", 0, 0, sides=sides, radius=0.28, innerRadius=0, depth=0, faces=1, visible=1,
              location=v3(-3.0 + 1.5 * i, -1.35, 0.5), rotation=v3(0, 0, 0.3 * i), scale=v3(1, 1, 1), color=col, shadeless=1)
        c.put(nm); c.appear(nm, (1, 1, 1), 128 + 3 * i, 211, pop=5)
    t = c.text("t_tag", "告别时间轴，来玩吧。", 0, -2.3, 0.62, INK, z=1); c.appear(t, (1, 1, 1), 152, 211, pop=6)
    for i, (sx, sy, col, tt) in enumerate([(-6.0, 2.6, CRIMSON, 110), (5.4, 2.5, TEAL, 116), (-5.9, -2.4, MUSTARD, 122), (6.2, -2.2, JADE, 134), (-1.6, 2.9, PINK, 140), (2.7, -2.9, WHITE, 146)]):
        st = c.star(f"sparkC{i}", sx, sy, 0.62, col, z=4, points=4, inner=0.14, rot=0.2 * i)
        c.appear(st, (1, 1, 1), tt, 211, pop=4)
        c.key(st, "rotation", [(tt, v3(0, 0, 0)), (211, v3(0, 0, 1.6 * (1 if i % 2 else -1)), "linear")])
    return c


if __name__ == "__main__":
    only = sys.argv[1:] 
    scenes = [scene1(), scene2(), scene3(), scene4(), scene5(), scene6()]
    write_project("motion_title_sequence", scenes)
    build_font()
