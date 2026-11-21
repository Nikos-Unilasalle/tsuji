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
# Wind tunnel: TUNNEL_SLICES 2D lattice Boltzmann slices from TUNNEL_FROM to TUNNEL_TO (fractions of
# the span), all in the same wind: Re ≈ 2000 on the mean chord (a 1 cm chord at 3 m/s in air) and
# proportional to each local chord. Angle of attack in degrees.
TUNNEL_SLICES = 7
TUNNEL_FROM, TUNNEL_TO = 0.15, 0.85
TUNNEL_RE = 2000
TUNNEL_AOA = 5
# Cross-vein cell spacing over the wing: u = 0 root → 1 tip, v = 0 leading edge → 1 trailing edge.
# Leading edge ~6x looser than the trailing edge, a little denser toward the tip.
CELL_FORMULA = "s * (0.5 + 2.5 * (1 - v)) * (1.1 - 0.3 * u)"

REF_SPAN = 5.0

# Traced outline (cm at 5 cm span; y up = toward the leading edge).
NODUS_X = 2.335     # the nodus: notch in the leading edge where Sc meets the costa (~45 % of the span)
NODUS_NOTCH = 0.035 # depth of that notch (cm)
LE = [(0.0, 0.0), (0.464, 0.078), (1.425, 0.156), (NODUS_X - 0.12, 0.222), (NODUS_X, 0.237 - NODUS_NOTCH),
      (NODUS_X + 0.1, 0.258), (2.824, 0.352), (3.383, 0.467),
      (4.131, 0.539), (4.690, 0.522), (4.953, 0.335), (5.009, 0.209)]
TE = [(0.014, -0.168), (0.073, -0.349), (0.251, -0.503), (0.503, -0.642), (1.034, -0.788),
      (1.461, -0.858), (2.263, -0.768), (2.637, -0.729), (3.084, -0.656), (3.570, -0.486),
      (3.944, -0.338), (4.355, -0.170), (4.690, -0.059), (4.953, 0.073)]
OUTLINE = LE + TE[::-1]
LE_RUN = [p for p in LE if p[0] < 4.2]  # the leading edge while it still runs spanwise, before it rounds the apex


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
    ("Sc — sous-costale (finit au nodus)", -1, [(-0.05, 0.12), (0.8, 0.09), (1.6, 0.05), (2.3, 0.0), (2.36, -0.03)]),
    ("R1 — radiale 1 (jusqu'à l'apex)", +1, [(-0.05, 0.2), (0.8, 0.17), (1.6, 0.12), (2.4, 0.1), (3.3, 0.08), (4.0, 0.12), (4.6, 0.24), (4.9, 0.5), (5.03, 0.85)]),
    ("RP / R2 — radiale postérieure", -1, [(0.6, 0.27), (1.2, 0.24), (1.9, 0.2), (2.4, 0.18), (3.2, 0.19), (4.0, 0.27), (4.6, 0.48), (4.9, 0.85), (4.98, 1.03)]),
    ("IR2 — intercalaire radiale 2", +1, [(2.5, 0.26), (3.3, 0.31), (4.0, 0.43), (4.5, 0.66), (4.75, 1.03)]),
    ("R3 — radiale 3", -1, [(2.25, 0.22), (3.0, 0.34), (3.7, 0.5), (4.2, 0.76), (4.42, 1.03)]),
    ("IR3 — intercalaire radiale 3", +1, [(2.1, 0.32), (2.8, 0.45), (3.5, 0.66), (3.92, 1.03)]),
    ("R4 — radiale 4", -1, [(0.6, 0.32), (1.3, 0.34), (2.0, 0.42), (2.8, 0.6), (3.3, 0.85), (3.47, 1.03)]),
    ("MA — médiane antérieure", +1, [(0.6, 0.37), (1.3, 0.42), (2.0, 0.5), (2.7, 0.68), (3.17, 1.03)]),
    ("CuA — cubitale antérieure", -1, [(1.0, 0.6), (1.6, 0.67), (2.3, 0.8), (2.78, 1.03)]),
    ("A1 — anale", +1, [(0.03, 0.6), (0.4, 0.74), (0.8, 0.84), (1.2, 0.92), (1.6, 1.03)]),
]
COSTA = [(x, 0.012) for x in (0.0, 0.5, 1.0, 1.5, 2.0, 2.4, 2.9, 3.4, 3.9, 4.4, 4.8)]
PTEROSTIGMA = [(4.0, 0.025), (4.62, 0.045), (4.62, 0.19), (4.0, 0.11)]
# Nodus: the strong nodal cross vein from the costa notch through the end of Sc to R1, then the
# oblique subnodus from R1 to RP. Drawn thick, and walls of both Voronoi tiers.
NODUS = [(NODUS_X, 0.0), (NODUS_X + 0.015, 0.06), (NODUS_X + 0.03, 0.115)]
SUBNODUS = [(NODUS_X + 0.03, 0.115), (NODUS_X + 0.16, 0.2)]
NODUS_BROWN = 0x150E08

VEIN_BROWN = 0x2B2118
MEMBRANE = 0xDCE6EA
STIGMA = 0x3B2414

FLAT = [{"x": 0, "y": 1}, {"x": 1, "y": 1}]
TAPER = [{"x": 0, "y": 1}, {"x": 1, "y": 0.45}]

n, c = [], []


def frame(fid, title, x, y, w, h, color):
    n.append(node(fid, "utility/frame", x, y, title=title, color=color, width=w, height=h))


def curve(nid, name, px, py, pts, closed=False, ctype="catmull", sign=0.0, lift=0.0, chord=True):
    xy = [chordwise(x, f) for x, f in pts] if chord else pts
    # Previews hidden: the veins run past the margin on purpose, and the tubes draw them.
    # Select a curve node to edit its points in the viewport.
    n.append(node(nid, "curve/from_points", px, py, name=name, type=ctype, closed=closed, tension=0.5, visible=0,
                  pointsList=[place(x, y, sign, lift) for x, y in xy]))


# ---- Canvas: six frames, left to right, in the order the wing is built ---------------------------
# Measured node sizes (canvas units): Curve from Points 187x220, Group 162x(80-280), Poisson Disk
# 307x160, Voronoi 2D 472x400, Height from Lines 344x120, Profiled Tubes 204x280.
OX, TOP = -3700, -600   # left edge of the first frame, top of every frame
CX, CY = 215, 245       # curve grid pitch
frame("f_drawn", "1 · Anatomie dessinée — contour, costa, Sc, R1, nodus, ptérostigma (murs)",
      OX, TOP, 660, 1040, 0x8A6A3A)
frame("f_traced", "2 · Veines relevées (cachées) — guident l'étirement et la corrugation",
      OX + 700, TOP, 660, 1040, 0x6B7280)
frame("f_long", "3 · Nervures longitudinales — Voronoi lâche, étiré le long des veines",
      OX + 1400, TOP, 870, 500, 0x3B82F6)
frame("f_cells", "4 · Cellules + nervures transverses — Voronoi dense, panneau par panneau",
      OX + 1400, TOP + 540, 870, 500, 0x10B981)
frame("f_fold", "5 · Corrugation — crêtes (+) et vallées (−)", OX + 2310, TOP, 780, 820, 0xA855F7)
frame("f_tubes", "6 · Tubes (rayons en cm) et ptérostigma", OX + 3130, TOP, 500, 1240, 0xEF4444)
frame("f_tunnel", "7 · Soufflerie 2D — 7 coupes le long de l'envergure (bouton Compute)",
      OX + 1400, TOP + 1300, 870, 420, 0x0EA5E9)


def at(fx, col, row):
    return OX + fx + 30 + col * CX, TOP + 50 + row * CY


# Frames 1-2: outline, the drawn leading-edge veins (costa, Sc, R1, nodus, pterostigma), and the
# traced main veins — hidden, they only steer the generated network and its corrugation.
curve("outline", "Contour de l'aile", *at(0, 0, 0), OUTLINE, closed=True, chord=False)
curve("costa", "C — costa (bord d'attaque)", *at(0, 0, 1), COSTA, sign=+1)
curve("nodus", "Nodus — nervure nodale (C → Sc → R1)", *at(0, 1, 0), NODUS, ctype="linear")
curve("subnodus", "Subnodus (R1 → RP)", *at(0, 1, 1), SUBNODUS, ctype="linear")
curve("pterostigma", "Ptérostigma", *at(0, 1, 2), PTEROSTIGMA + PTEROSTIGMA[:1], ctype="linear", sign=+0.4)
traced = []
for i, (name, sign, pts) in enumerate(VEINS):
    # Sc and R1 are drawn (frame 1); the eight others are traced guides (frame 2, 2 columns).
    pos = at(0, 0, 2 + i) if i < 2 else at(700, (i - 2) // 4, (i - 2) % 4)
    curve(f"vein_{i}", name, *pos, pts, sign=sign)
    traced.append(f"vein_{i}")

n.append(node("leading", "list/group", OX + 30 + 2 * CX, TOP + 50, name="Murs : Sc, R1, nodus, ptérostigma"))
for i, w in enumerate(["vein_0", "vein_1", "nodus", "subnodus", "pterostigma"]):
    c.append(wire(w, "curve", "leading", f"in{i}"))
n.append(node("flow", "list/group", OX + 730 + 2 * CX, TOP + 50, name="Guides : écoulement + signes de corrugation"))
for i, w in enumerate(traced + ["costa"]):
    c.append(wire(w, "curve", "flow", f"in{i}"))

# Frame 2: the longitudinal (thick) vein network — a loose Voronoi stretched along the flow of the
# traced veins (Stretch Follows Guides). Its cells are the wing's main panels, its edges the thick veins.
lx = OX + 1430
n.append(node("vein_seeds", "list/poisson-disk-2d", lx, TOP + 50, name="Graines des nervures longitudinales",
              plane="XZ", spacing=VEIN_GAP * SPAN / REF_SPAN,
              formula="s * (0.7 + 0.5 * v)", stretch=VEIN_STRETCH, stretchFollow=True, seed=11, maxPoints=2000))
n.append(node("veins", "curve/voronoi-2d", lx + 340, TOP + 50, name="Nervures longitudinales (panneaux)",
              plane="XZ", relax=1, stretch=VEIN_STRETCH, stretchFollow=True,
              fieldResolution=500, boundarySamples=240, wallSamples=96, visible=0))
c += [wire("outline", "curve", "vein_seeds", "boundary"),
      wire("flow", "list", "vein_seeds", "guides"),
      wire("outline", "curve", "veins", "boundary"),
      wire("vein_seeds", "points", "veins", "points"),
      wire("leading", "list", "veins", "walls"),
      wire("flow", "list", "veins", "guides")]

# Frame 3: cells and cross veins — a dense Voronoi inside each panel (Regions). Spacing grows from
# the trailing edge (v = 1, dense) to the leading edge (v = 0, about 6x looser), a little toward the
# tip. Wall Rows: ladders / grids along the panel borders.
n.append(node("centres", "list/poisson-disk-2d", lx, TOP + 590, name="Centres des cellules (gradient de densité)",
              plane="XZ", spacing=CELL * SPAN / REF_SPAN,
              formula=CELL_FORMULA, seed=7, maxPoints=8000))
n.append(node("cells", "curve/voronoi-2d", lx + 340, TOP + 590, name="Cellules alaires (membrane)",
              plane="XZ", relax=2, inset=0, wallSpacing=0, wallRows=2,
              boundarySamples=240, wallSamples=96,
              color=MEMBRANE, opacity=0.32, roughness=0.15, metalness=0.0, visible=1))
c += [wire("outline", "curve", "centres", "boundary"),
      wire("centres", "points", "cells", "points"),
      wire("veins", "cells", "cells", "regions")]

# Frame 4: corrugation. The thick veins take their height from the traced veins (ridges +,
# valleys -), then everything else folds flat between the thick veins, the drawn veins and the costa.
fx = OX + 2340
n.append(node("fold_veins", "geometry/height-from-lines", fx, TOP + 50, name="Hauteur des nervures longitudinales",
              plane="XZ", count=4, power=2, scale=1))
c += [wire("veins", "edges", "fold_veins", "points"), wire("flow", "list", "fold_veins", "guides")]
n.append(node("creases", "list/group", fx, TOP + 200, name="Plis : nervures épaisses + C, Sc, R1"))
c += [wire("fold_veins", "points", "creases", "in0"), wire("veins", "walls", "creases", "in1"), wire("costa", "curve", "creases", "in2")]
n.append(node("nodal", "list/group", fx, TOP + 350, name="Nodus + subnodus"))
c += [wire("nodus", "curve", "nodal", "in0"), wire("subnodus", "curve", "nodal", "in1")]
folds = {
    "fold_membrane": ("cells", "geometry", "geometry", "Pli de la membrane"),
    "fold_cross": ("cells", "edges", "points", "Pli des nervures transverses"),
    "fold_margin": ("veins", "outline", "points", "Pli de la nervure marginale"),
    "fold_nodus": ("nodal", "list", "points", "Pli du nodus"),
}
for i, (fid, (src, out, into, name)) in enumerate(folds.items()):
    n.append(node(fid, "geometry/height-from-lines", fx + 370, TOP + 50 + i * 150, name=name,
                  plane="XZ", count=6, power=2, scale=1))
    c += [wire(src, out, fid, into), wire("creases", "list", fid, "guides")]
n.append(node("costa_list", "list/group", fx, TOP + 650, name="Costa"))
n.append(node("fold_costa", "geometry/height-from-lines", fx + 370, TOP + 650, name="Hauteur de la costa",
              plane="XZ", count=1, power=1, scale=1, curveSamples=96))
c += [wire("costa", "curve", "costa_list", "in0"),
      wire("costa_list", "list", "fold_costa", "points"),
      wire("costa_list", "list", "fold_costa", "guides")]

# Frame 5: veins as tubes (radii in cm; measured order of magnitude, see docs/dragonfly-wing.md).
tube = dict(heightRatio=1, radialSegments=6, upright=True, patches=False, color=VEIN_BROWN, roughness=0.45, metalness=0.05)
tubes = [
    ("thick_veins", "Tubes — nervures longitudinales", "fold_veins", "points", 0.0050, FLAT, {}),
    ("leading_veins", "Tubes — Sc, R1, ptérostigma", "veins", "walls", 0.0065, TAPER, {}),
    ("nodus_vein", "Tube — nodus", "fold_nodus", "points", 0.0120, FLAT, {"color": NODUS_BROWN}),
    ("cross_veins", "Tubes — nervures transverses", "fold_cross", "points", 0.0020, FLAT, {}),
    ("margin_vein", "Tube — nervure marginale", "fold_margin", "points", 0.0035, FLAT, {}),
    ("costa_vein", "Tube — costa", "fold_costa", "points", 0.0090, TAPER, {}),
]
for i, (tid, name, src, out, radius, prof, extra) in enumerate(tubes):
    n.append(node(tid, "curve/profiled-tubes", OX + 3160 + (i % 2) * 230, TOP + 50 + (i // 2) * 300, name=name,
                  radius=radius, widthProfile=prof, heightProfile=prof, **{**tube, **extra}))
    c.append(wire(src, out, tid, "pointLists"))

n.append(node("stigma_fill", "curve/fill", OX + 3160, TOP + 950, name="Ptérostigma (rempli)",
              color=STIGMA, opacity=1))
c.append(wire("pterostigma", "curve", "stigma_fill", "curve"))

# Frame 7: wind tunnel. The folded membrane and the veins are the obstacle; one node cuts them with
# TUNNEL_SLICES planes across the span and runs a 2D flow in each slice, drawn back in 3D (vorticity,
# streamlines, pressure bars, lift / drag arrows, and the spanwise lift curve joining the arrows).
n.append(node("tunnel_obstacle", "list/group", OX + 1430, TOP + 1350, name="Obstacle : membrane + nervures"))
for i, src in enumerate(["fold_membrane", "thick_veins", "leading_veins", "nodus_vein", "margin_vein", "costa_vein"]):
    c.append(wire(src, "geometry", "tunnel_obstacle", f"in{i}"))
n.append(node("tunnel", "physics/wind-tunnel-2d", OX + 1630, TOP + 1350,
              name=f"Soufflerie — {TUNNEL_SLICES} coupes, {int(TUNNEL_FROM * 100)} → {int(TUNNEL_TO * 100)} % de l'envergure",
              sliceAxis="X", sliceCount=TUNNEL_SLICES,
              stationFrom=round(TUNNEL_FROM * SPAN - SPAN / 2, 4), stationTo=round(TUNNEL_TO * SPAN - SPAN / 2, 4),
              flowAxis="+Z", angle=TUNNEL_AOA, reynolds=TUNNEL_RE, reynoldsMode="airspeed",
              cellsPerChord=64, opacity=0.75, calmOpacity=0, field="vorticity", range=12, streamlineCount=12))
c.append(wire("tunnel_obstacle", "list", "tunnel", "obstacle"))

if __name__ == "__main__":
    write_demo("dragonfly_wing", n, c, setup_overrides={"object/plane": {"visible": 0}})
