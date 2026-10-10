#!/usr/bin/env python3
"""Generate public/demos/demo_material_palette_shade.tsuji — a hand-painted
countryside diorama built with Palette Shade.

Every family of objects (meadow, far ridge, foliage, trunks, walls, roof,
windows, pond, clouds) goes through its own Palette Shade with its own palette
and number of shades, so the whole scene reads like gouache flats instead of
smooth CG. One sun sweeps across the diorama on an Orbit: the light bands slide
over the hills, the trees and the house, while the shadows they throw on each
other — and the clouds' shadows drifting over the meadow — darken the finished
colours without ever being quantised into the palette.
"""
import json, math, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public/demos/demo_material_palette_shade.tsuji")

FPS = 30
FRAMES = 360  # 12 s: the sun crosses the sky once

nodes, conns = [], []


def v3(x=0.0, y=0.0, z=0.0):
    return {"x": round(x, 4), "y": round(y, 4), "z": round(z, 4)}


def node(nid, ntype, px, py, **params):
    nodes.append({"id": nid, "type": ntype, "position": {"x": px, "y": py}, "params": params})
    return nid


def wire(a, sa, b, sb):
    conns.append({"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb})


# ---------------------------------------------------------------- palettes

PALETTES = {
    # dark to light; Palette Shade sorts by luminance anyway, but this is the intent
    "meadow": [0x1d4a3c, 0x2f7a4a, 0x5fa655, 0x9fcf63, 0xe3ee94],
    "ridge": [0x35607a, 0x5f93a6, 0x95c2c4, 0xcfe6df],
    "foliage": [0x12372f, 0x24604a, 0x469158, 0x84c26b],
    "trunk": [0x38231a, 0x5c3b27, 0x8c5e3c],
    "walls": [0x9b7660, 0xd5ac86, 0xf3dcb4, 0xfff4dc],
    "roof": [0x5e2431, 0xa13f3a, 0xd8654a, 0xf59a68],
    "windows": [0xe9a63e, 0xffe08a, 0xfff6c9],
    "pond": [0x2a6a9c, 0x57a3cf, 0xaee0ee],
    "cloud": [0x9db2d8, 0xd3e0f4, 0xffffff],
}
# How many shades each family accepts (0 = the palette's own size). The
# foliage palette has 4 colours and is asked for 4; the pond lists 3 and is
# given exactly 3 — Steps is there to stretch or squeeze any of them.
STEPS = {k: 0 for k in PALETTES}
SOFTNESS = {k: 0.0 for k in PALETTES}
SOFTNESS["cloud"] = 0.18
SOFTNESS["ridge"] = 0.08


def palette_shade(key, px, py, source):
    """Palette List -> Palette Shade -> returns the shaded geometry node id."""
    pal = f"pal_{key}"
    cols = PALETTES[key]
    stops = [{"position": i / (len(cols) - 1), "color": c} for i, c in enumerate(cols)]
    node(pal, "list/color-palette", px, py, count=len(cols), ramp={"stops": stops, "interpolation": "linear"})
    sh = f"shade_{key}"
    node(sh, "material/palette-shade", px + 330, py, steps=STEPS[key], softness=SOFTNESS[key],
         sort=1, shadowStrength=0.85, bias=0, exposure=1, doubleSided=0)
    wire(pal, "list", sh, "palette")
    wire(source, "geometry", sh, "geometry")
    return sh


# ------------------------------------------------------------------ terrain

# (centre, size) of the squashed spheres that make the hills. A unit sphere is
# 1 wide, so scale is the full diameter on each axis.
NEAR = [
    ((0.0, -2.7, 0.0), (15.0, 6.0, 10.0)),
    ((5.5, -2.4, 3.0), (10.0, 5.0, 7.0)),
    ((-5.8, -2.5, 2.5), (9.0, 5.0, 6.0)),
]
FAR = [
    ((-4.0, -3.6, -8.0), (18.0, 9.0, 8.0)),
    ((8.0, -4.0, -10.0), (18.0, 10.0, 8.0)),
    ((-14.0, -3.0, -12.0), (14.0, 8.0, 8.0)),
]


def surf(x, z):
    """Height of the near hills' top surface at (x, z)."""
    best = -9.0
    for (cx, cy, cz), (sx, sy, sz) in NEAR:
        q = 1 - ((x - cx) / (sx / 2)) ** 2 - ((z - cz) / (sz / 2)) ** 2
        if q > 0:
            best = max(best, cy + (sy / 2) * math.sqrt(q))
    return best


# ------------------------------------------------------------------- build

COL = 330
X = {"obj": 0, "merge": 700, "pal": 1100, "out": 1900}
row = [0]


def next_row(step=190):
    y = row[0]
    row[0] += step
    return y


# --- meadow + far ridge
meadow_parts = []
for i, ((cx, cy, cz), (sx, sy, sz)) in enumerate(NEAR):
    nid = node(f"hill{i}", "object/sphere", X["obj"], next_row(), location=v3(cx, cy, cz), scale=v3(sx, sy, sz))
    meadow_parts.append(nid)
node("meadow", "structure/merge", X["merge"], 150)
for i, p in enumerate(meadow_parts):
    wire(p, "geometry", "meadow", f"in{i}")

ridge_parts = []
for i, ((cx, cy, cz), (sx, sy, sz)) in enumerate(FAR):
    nid = node(f"ridge{i}", "object/sphere", X["obj"], next_row(), location=v3(cx, cy, cz), scale=v3(sx, sy, sz))
    ridge_parts.append(nid)
node("ridge", "structure/merge", X["merge"], 650)
for i, p in enumerate(ridge_parts):
    wire(p, "geometry", "ridge", f"in{i}")

# --- house
hx, hz = -1.7, 0.3
hy = surf(hx, hz)
wall_w, wall_h, wall_d = 1.7, 1.1, 1.3
wall_cy = hy + wall_h / 2 - 0.12
wall_top = wall_cy + wall_h / 2
R = 1.0
roof_scale_y = 0.62
roof_cy = wall_top + 0.3 * R * roof_scale_y * 1.0 - 0.02
walls = [
    node("h_walls", "object/box", X["obj"], next_row(), location=v3(hx, wall_cy, hz), scale=v3(wall_w, wall_h, wall_d)),
    node("h_chimney", "object/box", X["obj"], next_row(), location=v3(hx + 0.55, wall_top + 0.55, hz - 0.25), scale=v3(0.22, 0.75, 0.22)),
]
node("walls_merge", "structure/merge", X["merge"], 1150)
for i, p in enumerate(walls):
    wire(p, "geometry", "walls_merge", f"in{i}")

node("h_roof", "object/polygon", X["obj"], next_row(), sides=3, radius=R, depth=wall_d + 0.35,
     location=v3(hx, roof_cy, hz), rotation=v3(0, 0, math.pi), scale=v3(1.12, roof_scale_y, 1))

glass = [
    node("h_door", "object/box", X["obj"], next_row(), location=v3(hx - 0.35, hy + 0.32, hz + wall_d / 2 + 0.01), scale=v3(0.3, 0.6, 0.05)),
    node("h_win_a", "object/box", X["obj"], next_row(), location=v3(hx + 0.3, hy + 0.58, hz + wall_d / 2 + 0.01), scale=v3(0.3, 0.3, 0.05)),
    node("h_win_b", "object/box", X["obj"], next_row(), location=v3(hx + wall_w / 2 + 0.01, hy + 0.58, hz + 0.1), scale=v3(0.05, 0.3, 0.3)),
]
node("windows_merge", "structure/merge", X["merge"], 1400)
for i, p in enumerate(glass):
    wire(p, "geometry", "windows_merge", f"in{i}")

# --- trees and bushes
TREES = [  # x, z, scale
    (-3.9, -0.6, 1.25),
    (-4.9, 1.5, 0.95),
    (1.9, -0.9, 1.1),
    (3.4, 1.9, 1.35),
    (6.0, 2.6, 1.0),
    (-7.2, 2.9, 1.15),
    (0.4, 3.2, 0.8),
    (7.6, 1.1, 0.9),
]
trunks, crowns = [], []
for i, (tx, tz, k) in enumerate(TREES):
    ty = surf(tx, tz) - 0.05
    trunks.append(node(f"t{i}_trunk", "object/cylinder", X["obj"], next_row(120),
                       location=v3(tx, ty + 0.55 * k, tz), scale=v3(0.2 * k, 1.1 * k, 0.2 * k)))
    for j, (ox, oy, oz, sx, sy, sz) in enumerate([
        (0.0, 1.25, 0.0, 1.15, 1.0, 1.15),
        (0.35, 1.85, 0.1, 0.85, 0.8, 0.85),
        (-0.3, 1.75, -0.2, 0.75, 0.7, 0.75),
    ]):
        crowns.append(node(f"t{i}_crown{j}", "object/sphere", X["obj"], next_row(120),
                           location=v3(tx + ox * k, ty + oy * k, tz + oz * k), scale=v3(sx * k, sy * k, sz * k)))
BUSHES = [(-2.9, 1.5, 0.55), (0.0, 1.9, 0.45), (2.6, 0.3, 0.5), (-0.5, -1.4, 0.6), (5.0, 0.9, 0.5), (-6.0, 1.0, 0.55)]
for i, (bx, bz, k) in enumerate(BUSHES):
    crowns.append(node(f"bush{i}", "object/sphere", X["obj"], next_row(120),
                       location=v3(bx, surf(bx, bz) + 0.02, bz), scale=v3(k * 1.5, k, k * 1.3)))
node("trunks_merge", "structure/merge", X["merge"], 1650)
for i, p in enumerate(trunks):
    wire(p, "geometry", "trunks_merge", f"in{i}")
node("crowns_merge", "structure/merge", X["merge"], 1900)
for i, p in enumerate(crowns):
    wire(p, "geometry", "crowns_merge", f"in{i}")

# --- pond
px_, pz_ = 0.9, 2.1
node("pond_disc", "object/sphere", X["obj"], next_row(), location=v3(px_, surf(px_, pz_) - 0.02, pz_), scale=v3(2.0, 0.16, 1.1))

# --- clouds: each its own cloud, drifting on its own orbit, casting shadows on the meadow
CLOUDS = [  # orbit phase (deg), radius, height, speed, puffs
    (200, 6.5, 2.9, 4.0, [(0, 0, 0, 1.3, 0.5, 0.8), (0.7, 0.1, 0.08, 0.9, 0.45, 0.7), (-0.7, 0.04, -0.08, 0.85, 0.4, 0.6)]),
    (330, 7.6, 3.2, 3.0, [(0, 0, 0, 1.6, 0.6, 0.9), (0.85, 0.12, 0.08, 1.05, 0.5, 0.75), (-0.9, 0.06, 0.0, 1.0, 0.45, 0.7), (0.15, 0.24, -0.15, 0.9, 0.45, 0.7)]),
    (95, 5.4, 2.6, 5.0, [(0, 0, 0, 1.1, 0.42, 0.6), (0.55, 0.08, 0.0, 0.7, 0.35, 0.5)]),
]
for i, (phase, rad, hgt, spd, puffs) in enumerate(CLOUDS):
    orb = node(f"c{i}_orbit", "transform/orbit", X["obj"] + 300, next_row(140), radius=rad, speed=spd, phase=phase, height=hgt)
    parts = [
        node(f"c{i}_puff{j}", "object/sphere", X["obj"], next_row(120),
             location=v3(ox, oy, oz), scale=v3(sx, sy, sz))
        for j, (ox, oy, oz, sx, sy, sz) in enumerate(puffs)
    ]
    cm = node(f"cloud{i}", "structure/merge", X["merge"], next_row(140))
    for j, p in enumerate(parts):
        wire(p, "geometry", cm, f"in{j}")
    wire(orb, "matrix", cm, "matrix")
node("clouds", "structure/merge", X["merge"] + 330, 2300)
for i in range(len(CLOUDS)):
    wire(f"cloud{i}", "geometry", "clouds", f"in{i}")

# --- palettes
shaded = {}
shaded["meadow"] = palette_shade("meadow", X["pal"], 0, "meadow")
shaded["ridge"] = palette_shade("ridge", X["pal"], 300, "ridge")
shaded["walls"] = palette_shade("walls", X["pal"], 600, "walls_merge")
shaded["roof"] = palette_shade("roof", X["pal"], 900, "h_roof")
shaded["windows"] = palette_shade("windows", X["pal"], 1200, "windows_merge")
shaded["trunk"] = palette_shade("trunk", X["pal"], 1500, "trunks_merge")
shaded["foliage"] = palette_shade("foliage", X["pal"], 1800, "crowns_merge")
shaded["pond"] = palette_shade("pond", X["pal"], 2100, "pond_disc")
shaded["cloud"] = palette_shade("cloud", X["pal"], 2400, "clouds")

# --- light: a low golden sun sweeping from front-left to front-right
node("sun_orbit", "transform/orbit", X["out"], 300, radius=8, speed=-8, phase=165, height=7.7)
node("sun", "light/directional", X["out"] + 330, 300, color=0xFFF0D2, intensity=0.75, castShadow=1,
     shadowSoftness=1.5, target=v3(0, 0, 0))
wire("sun_orbit", "matrix", "sun", "matrix")
node("sky", "lighting/environment", X["out"], 600, color=0xBFE0EE, intensity=0.0, background=1,
     ambientIntensity=0.15, sunIntensity=0)

# --- grade: a touch of bloom and a soft vignette
node("bloom", "postprocess/bloom", X["out"] + 330, 1250, strength=0.35, radius=0.6, threshold=0.9)
node("vignette", "postprocess/vignette", X["out"] + 660, 1250, offset=1.0, darkness=0.55)
node("grade", "postprocess/color-correction", X["out"] + 990, 1250, brightness=0.0, contrast=1.06, saturation=1.15)
wire("bloom", "effect", "vignette", "effect")
wire("vignette", "effect", "grade", "effect")

node("render", "render", X["out"] + 700, 800, frameCount=FRAMES, fps=FPS, motionBlur=0,
     resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
wire("sky", "environment", "render", "environment")
wire("grade", "effect", "render", "postprocess")


def empty():
    return {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []}


def main():
    canvas = {"nodes": nodes, "connections": conns, "keyframes": {}, "markers": [], "exposedParams": []}
    with open(OUT, "w") as f:
        json.dump({"canvases": [canvas] + [empty() for _ in range(5)], "activeCanvas": 0}, f, indent=2)
        f.write("\n")
    print(f"wrote {os.path.relpath(OUT, ROOT)} ({len(nodes)} nodes, {len(conns)} wires)")


if __name__ == "__main__":
    main()
