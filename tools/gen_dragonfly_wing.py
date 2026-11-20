#!/usr/bin/env python3
"""Generate demo_dragonfly_wing: a parametric dragonfly forewing (Anisoptera, Aeshnidae-like).

Outline and primary veins traced from the forewing of Wikimedia Commons'
"Dragonfly_wing_structure.png" (labelled C, Sc, R+M, Cu, A1, nodus, pterostigma, R1-R4, IR2, IR3,
MA, CuP), resampled to a 5 cm span.

Two tiers of veins, as on the real wing:

1. Thick veins — a loose Voronoi stretched along the flow of the main veins (Poisson Disk 2D +
   Voronoi 2D, Stretch Follows Guides). Its cells are the wing's long panels, its edges the thick
   veins that run, branch and merge from the base to the margin. The traced main veins (hidden)
   only steer the stretch and the corrugation; costa, Sc, R1 and the pterostigma are drawn, as walls.
2. Cross veins — a dense Voronoi inside each panel (Voronoi 2D, Regions; Hoffmann et al. 2018,
   PNAS 115:9905). Wall Rows lays rows of cells along each panel's border: narrow panels become
   ladders or grids, wide ones keep irregular cells, denser toward the trailing edge.

Corrugation: the thick veins take their height from the traced veins (ridges +, valleys -), then
Height from Lines folds the membrane and cross veins between them, fading toward the tip
(Jongerius & Lentink 2010, Exp. Mech.). Units: 1 scene unit = 1 cm.

Change the parameters below and re-run:  python3 tools/gen_dragonfly_wing.py
"""
import bisect, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_demos import node, wire, v3, write_demo  # noqa: E402

# ---- Parameters ------------------------------------------------------------------------------
SPAN = 5.0           # wing length, root to tip (cm); everything scales with it
CORRUGATION = 0.035  # ridge/valley height at the root (cm)
TIP_FADE = 0.75      # fraction of the corrugation lost at the tip
BASE_Y = 0.45        # wing held horizontal this high above the ground
CELL = 0.05          # cross-vein cell spacing s at mid-chord (cm)
VEIN_GAP = 0.12      # spacing of the thick vein network's seeds, across the flow (cm)
VEIN_STRETCH = 6.0   # how much longer than wide its panels are, along the flow of the traced veins

REF_SPAN = 5.0

# Traced outline (cm at 5 cm span; y up = toward the leading edge).
LE = [(0.0, 0.0), (0.464, 0.078), (1.425, 0.156), (2.335, 0.237), (2.824, 0.352), (3.383, 0.467),
      (4.131, 0.539), (4.690, 0.522), (4.953, 0.335), (5.009, 0.209)]
TE = [(0.014, -0.168), (0.073, -0.349), (0.251, -0.503), (0.503, -0.642), (1.034, -0.788),
      (1.461, -0.858), (2.263, -0.768), (2.637, -0.729), (3.084, -0.656), (3.570, -0.486),
      (3.944, -0.338), (4.355, -0.170), (4.690, -0.059), (4.953, 0.073)]
OUTLINE = LE + TE[::-1]
LE_RUN = LE[:8]  # the leading edge while it still runs spanwise, before it rounds the apex


def interp(pts, x):
    xs = [p[0] for p in pts]
    i = max(1, min(len(pts) - 1, bisect.bisect_left(xs, x)))
    (x0, y0), (x1, y1) = pts[i - 1], pts[i]
    t = (x - x0) / (x1 - x0) if x1 != x0 else 0
    return y0 + (y1 - y0) * t


def chordwise(x, f):
    """A point at span x, a fraction f of the way from the leading edge (0) to the trailing edge (1)."""
    le = interp(LE_RUN, min(x, LE_RUN[-1][0]))
    te = interp(TE, min(max(x, TE[0][0]), TE[-1][0]))
    return x, le + f * (te - le)


def place(x, y, sign=0.0, lift=0.0):
    """Traced cm → world. Wing in the XZ plane, height Y; X spans, Z runs leading (-) to trailing (+)."""
    u = x / REF_SPAN
    h = sign * CORRUGATION * (1 - TIP_FADE * max(0.0, min(1.0, u)))
    k = SPAN / REF_SPAN
    return v3(round(x * k - SPAN / 2, 5), round(BASE_Y + h + lift, 5), round(-(y + 0.1) * k, 5))


# Main veins in (span x, chord fraction f), traced. Sc and R1 are drawn; all of them steer the
# thick network's stretch and give the corrugation. Ends run past the margin (f > 1, x < 0) on
# purpose: Voronoi 2D cuts them at the outline. Sign: ridge (+) / valley (-), Riek & Kukalova-Peck,
# simplified.
VEINS = [
    ("Sc  (subcosta, ends at the nodus)", -1, [(-0.05, 0.12), (0.8, 0.09), (1.6, 0.05), (2.3, 0.0), (2.36, -0.03)]),
    ("R1  (to the apex)", +1, [(-0.05, 0.2), (0.8, 0.17), (1.6, 0.12), (2.4, 0.1), (3.3, 0.08), (4.0, 0.12), (4.6, 0.24), (4.9, 0.5), (5.03, 0.85)]),
    ("RP / R2", -1, [(0.6, 0.27), (1.2, 0.24), (1.9, 0.2), (2.4, 0.18), (3.2, 0.19), (4.0, 0.27), (4.6, 0.48), (4.9, 0.85), (4.98, 1.03)]),
    ("IR2", +1, [(2.5, 0.26), (3.3, 0.31), (4.0, 0.43), (4.5, 0.66), (4.75, 1.03)]),
    ("R3", -1, [(2.25, 0.22), (3.0, 0.34), (3.7, 0.5), (4.2, 0.76), (4.42, 1.03)]),
    ("IR3", +1, [(2.1, 0.32), (2.8, 0.45), (3.5, 0.66), (3.92, 1.03)]),
    ("R4", -1, [(0.6, 0.32), (1.3, 0.34), (2.0, 0.42), (2.8, 0.6), (3.3, 0.85), (3.47, 1.03)]),
    ("MA", +1, [(0.6, 0.37), (1.3, 0.42), (2.0, 0.5), (2.7, 0.68), (3.17, 1.03)]),
    ("CuA", -1, [(1.0, 0.6), (1.6, 0.67), (2.3, 0.8), (2.78, 1.03)]),
    ("A1  (anal)", +1, [(0.03, 0.6), (0.4, 0.74), (0.8, 0.84), (1.2, 0.92), (1.6, 1.03)]),
]
COSTA = [(x, 0.012) for x in (0.0, 0.5, 1.0, 1.5, 2.0, 2.4, 2.9, 3.4, 3.9, 4.4, 4.8)]
PTEROSTIGMA = [(4.0, 0.025), (4.62, 0.045), (4.62, 0.19), (4.0, 0.11)]

VEIN_BROWN = 0x2B2118
MEMBRANE = 0xDCE6EA
STIGMA = 0x3B2414

FLAT = [{"x": 0, "y": 1}, {"x": 1, "y": 1}]
TAPER = [{"x": 0, "y": 1}, {"x": 1, "y": 0.45}]

n, c = [], []


def curve(nid, px, py, pts, closed=False, ctype="catmull", sign=0.0, lift=0.0, chord=True):
    xy = [chordwise(x, f) for x, f in pts] if chord else pts
    # Previews hidden: the veins run past the margin on purpose, and the tubes draw them.
    # Select a curve node to edit its points in the viewport.
    n.append(node(nid, "curve/from_points", px, py, type=ctype, closed=closed, tension=0.5, visible=0,
                  pointsList=[place(x, y, sign, lift) for x, y in xy]))


# Column 1: outline, the drawn leading-edge veins (costa, Sc, R1, pterostigma), and the traced
# main veins — hidden, they only steer the generated network and its corrugation.
curve("outline", -1900, -300, OUTLINE, closed=True, chord=False)
curve("costa", -1900, -150, COSTA, sign=+1)
traced = []
for i, (_, sign, pts) in enumerate(VEINS):
    curve(f"vein_{i}", -1900, i * 110, pts, sign=sign)
    traced.append(f"vein_{i}")
curve("pterostigma", -1900, 1150, PTEROSTIGMA + PTEROSTIGMA[:1], ctype="linear", sign=+0.4)

n.append(node("leading", "list/group", -1600, 300))  # drawn veins: walls of the generated network
for i, w in enumerate(["vein_0", "vein_1", "pterostigma"]):
    c.append(wire(w, "curve", "leading", f"in{i}"))
n.append(node("flow", "list/group", -1600, 700))  # all traced veins + costa: direction and corrugation
for i, w in enumerate(traced + ["costa"]):
    c.append(wire(w, "curve", "flow", f"in{i}"))

# Column 2: the thick vein network — a loose Voronoi stretched along the flow of the traced veins
# (Stretch Follows Guides). Its cells are the wing's main panels, its edges the thick veins.
n.append(node("vein_seeds", "list/poisson-disk-2d", -1300, -300, plane="XZ", spacing=VEIN_GAP * SPAN / REF_SPAN,
              formula="s * (0.7 + 0.5 * v)", stretch=VEIN_STRETCH, stretchFollow=True, seed=11, maxPoints=2000))
n.append(node("veins", "curve/voronoi-2d", -1000, -300, plane="XZ", relax=1, stretch=VEIN_STRETCH, stretchFollow=True,
              fieldResolution=500, boundarySamples=240, wallSamples=96, visible=0))
c += [wire("outline", "curve", "vein_seeds", "boundary"),
      wire("flow", "list", "vein_seeds", "guides"),
      wire("outline", "curve", "veins", "boundary"),
      wire("vein_seeds", "points", "veins", "points"),
      wire("leading", "list", "veins", "walls"),
      wire("flow", "list", "veins", "guides")]

# Column 3: cross veins — a dense Voronoi inside each panel (Regions), denser toward the trailing
# edge (v → 1) and a little toward the tip (u → 1). Wall Rows: ladders / grids along the panel borders.
n.append(node("centres", "list/poisson-disk-2d", -1000, 100, plane="XZ", spacing=CELL * SPAN / REF_SPAN,
              formula="s * (1.8 - 1.1 * v) * (1.1 - 0.3 * u)", seed=7, maxPoints=8000))
n.append(node("cells", "curve/voronoi-2d", -700, 0, plane="XZ", relax=2, inset=0, wallSpacing=0, wallRows=2,
              boundarySamples=240, wallSamples=96,
              color=MEMBRANE, opacity=0.32, roughness=0.15, metalness=0.0, visible=1))
c += [wire("outline", "curve", "centres", "boundary"),
      wire("centres", "points", "cells", "points"),
      wire("veins", "cells", "cells", "regions")]

# Corrugation: the thick veins take their height from the traced veins (ridges +, valleys -), then
# everything else folds flat between the thick veins, the drawn veins and the costa.
n.append(node("fold_veins", "geometry/height-from-lines", -700, -400, plane="XZ", count=4, power=2, scale=1))
c += [wire("veins", "edges", "fold_veins", "points"), wire("flow", "list", "fold_veins", "guides")]
n.append(node("creases", "list/group", -400, -500))
c += [wire("fold_veins", "points", "creases", "in0"), wire("veins", "walls", "creases", "in1"), wire("costa", "curve", "creases", "in2")]
folds = {
    "fold_membrane": ("cells", "geometry", "geometry"),
    "fold_cross": ("cells", "edges", "points"),
    "fold_margin": ("veins", "outline", "points"),
}
for i, (fid, (src, out, into)) in enumerate(folds.items()):
    n.append(node(fid, "geometry/height-from-lines", -400, -250 + i * 200, plane="XZ", count=6, power=2, scale=1))
    c += [wire(src, out, fid, into), wire("creases", "list", fid, "guides")]
n.append(node("costa_list", "list/group", -700, 700))
n.append(node("fold_costa", "geometry/height-from-lines", -400, 700, plane="XZ", count=1, power=1, scale=1, curveSamples=96))
c += [wire("costa", "curve", "costa_list", "in0"),
      wire("costa_list", "list", "fold_costa", "points"),
      wire("costa_list", "list", "fold_costa", "guides")]

# Column 4: veins as tubes (radii in cm; measured order of magnitude, see docs/dragonfly-wing.md).
tube = dict(heightRatio=1, radialSegments=6, upright=True, patches=False, color=VEIN_BROWN, roughness=0.45, metalness=0.05)
tubes = [
    ("thick_veins", "fold_veins", "points", 0.0050, FLAT),
    ("leading_veins", "veins", "walls", 0.0065, TAPER),
    ("cross_veins", "fold_cross", "points", 0.0020, FLAT),
    ("margin_vein", "fold_margin", "points", 0.0035, FLAT),
    ("costa_vein", "fold_costa", "points", 0.0090, TAPER),
]
for i, (tid, src, out, radius, prof) in enumerate(tubes):
    n.append(node(tid, "curve/profiled-tubes", -100, -300 + i * 200, radius=radius, widthProfile=prof, heightProfile=prof, **tube))
    c.append(wire(src, out, tid, "pointLists"))

n.append(node("stigma_fill", "curve/fill", -100, 750, color=STIGMA, opacity=1))
c.append(wire("pterostigma", "curve", "stigma_fill", "curve"))

if __name__ == "__main__":
    write_demo("dragonfly_wing", n, c, setup_overrides={"object/plane": {"visible": 0}})
