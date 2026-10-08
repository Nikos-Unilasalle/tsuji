#!/usr/bin/env python3
"""Generate public/demos/demo_showreel.tsuji — the Tsuji showreel for motion designers.

Six canvases, one chapter each, chained by Go To Canvas so the document plays
as one film: press Play on canvas 1 and it runs through all six, then loops.

  1 IGNITION    black    a vermilion sun rises, TSUJI lands letter by letter
  2 TYPE        red      words swap on the beat inside rings of type on a path
  3 PROCEDURAL  black    400 columns rippling from one Expression
  4 SIMULATION  bone     the title dropped into Rapier, then a rain of balls
  5 LOOK DEV    black    one object, eight looks, one per half bar
  6 INK         paper    辻 written stroke by stroke, the seal, the end card

Everything sits on one beat grid — 120 BPM at 30 fps: a beat is 15 frames, a
bar 60 — and every move is driven from the canvas's own timeline frame (the
Frame node, keyframes), never the free-running clock, so a chapter starts
from zero each time it is entered, scrubs exactly, and exports frame for
frame what Play shows. The cuts are designed as matches: the sun swallows
the frame into chapter 2's red, an ink iris closes into chapter 3's black,
white flashes into the bone and paper chapters, and the end fades to the
black the film opens on.

Art direction: ink black, bone white and one vermilion accent (the hanko
red of 辻), Anton for display type, Doto for the machine voice, a monospace
HUD naming the nodes on screen, grain over everything.

The calligraphy is KanjiVG stroke data (© Ulrich Apel, CC BY-SA 3.0), shared
with tools/gen_calligraphy.py; the file this writes carries it.

Run from the repo root: python3 tools/gen_showreel.py
"""
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public/demos/demo_showreel.tsuji")
# Optional: a dump of the node registry (type -> sockets) to check every wire
# against while authoring. Generation does not need it.
REGISTRY = os.path.join(ROOT, "scratch/registry.json")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_calligraphy import TSUJI, strokes_from_kanjivg  # noqa: E402

FPS = 30
BEAT = 15            # frames per beat at 120 BPM
BAR = 4 * BEAT       # 60 frames, 2 s

INK = 0x0B0B0E
BONE = 0xEDEAE2
VERMILION = 0xFF3B1F
EMBER = 0xFF7A3D
STEEL = 0x8A93A6
SMOKE = 0x2A2C33
DEG = math.pi / 180

# Arrival easings, and the one departure an animator reaches for most: a
# bezier ease-in (keyframes only carry the easing *into* them).
EASE_IN = ("bezier", [0.6, 0.0, 0.9, 0.35])
EASE_IO = ("bezier", [0.7, 0.0, 0.2, 1.0])


def v3(x=0.0, y=0.0, z=0.0):
    return {"x": x, "y": y, "z": z}


def ramp(*stops, interpolation="linear"):
    return {"stops": [{"position": p, "color": c} for p, c in stops], "interpolation": interpolation}


class Scene:
    """One canvas: nodes, wires, keyframes and markers, laid out in columns."""

    _registry = None

    def __init__(self, name, frames):
        self.name = name
        self.frames = frames
        self.nodes = []
        self.conns = []
        self.keyframes = {}
        self.markers = []
        self.exposed = []
        self._col = {}
        self.post_tail = ("post_in", "effect")

    # -- building ---------------------------------------------------------
    def add(self, nid, ntype, col=0, **params):
        """A node in layout column `col` (0 = leftmost); rows stack per column."""
        self._check_type(ntype)
        row = self._col.get(col, 0)
        self._col[col] = row + 1
        full = f"{self.name}_{nid}"
        if any(n["id"] == full for n in self.nodes):
            raise KeyError(f"duplicate node id {full}")
        self.nodes.append({
            "id": full,
            "type": ntype,
            "position": {"x": -3000 + col * 340, "y": row * 300},
            "params": params,
        })
        return full

    def wire(self, a, sa, b, sb):
        a, b = self._full(a), self._full(b)
        self._check_socket(a, sa, "outputs")
        self._check_socket(b, sb, "inputs")
        self.conns.append({"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb})

    def key(self, nid, param, keys):
        """keys: (frame, value[, ease[, strength]]). The ease is the *arrival*
        easing of that keyframe (see evaluate.ts): expo/back/elastic/bounce
        settle onto it, hold snaps to it, ("bezier", [x1, y1, x2, y2]) is any
        curve — EASE_IN for a departure."""
        out = []
        for k in keys:
            entry = {"frame": int(k[0]), "value": k[1]}
            ease = k[2] if len(k) > 2 else None
            if isinstance(ease, tuple):
                entry["easeIn"] = ease[0]
                entry["easeBezier"] = ease[1]
            elif ease:
                entry["easeIn"] = ease
            if len(k) > 3 and k[3] is not None:
                entry["easeStrength"] = k[3]
            out.append(entry)
        out.sort(key=lambda e: e["frame"])
        # Nothing arrives at the first key, so it carries no easing: the
        # evaluator would otherwise shape the first segment with it (a hold
        # there freezes the whole first move) instead of the second key's.
        for k in ("easeIn", "easeStrength", "easeBezier"):
            out[0].pop(k, None)
        self.keyframes.setdefault(self._full(nid), {})[param] = out

    def marker(self, frame, label):
        self.markers.append({"frame": int(frame), "label": label})

    def graph(self):
        return {
            "nodes": self.nodes,
            "connections": self.conns,
            "keyframes": self.keyframes,
            "markers": sorted(self.markers, key=lambda m: m["frame"]),
            "exposedParams": self.exposed,
        }

    # -- validation -------------------------------------------------------
    def _full(self, nid):
        return nid if nid.startswith(self.name + "_") else f"{self.name}_{nid}"

    @classmethod
    def registry(cls):
        if cls._registry is None:
            cls._registry = json.load(open(REGISTRY)) if os.path.exists(REGISTRY) else {}
        return cls._registry

    def _check_type(self, ntype):
        reg = self.registry()
        if reg and ntype not in reg:
            raise KeyError(f"unknown node type {ntype}")

    def _check_socket(self, nid, socket, side):
        reg = self.registry()
        node = next((n for n in self.nodes if n["id"] == nid), None)
        if node is None:
            raise KeyError(f"wire to missing node {nid}")
        if not reg:
            return
        d = reg[node["type"]]
        if d["dynamicInputs" if side == "inputs" else "dynamicOutputs"]:
            return
        if socket not in [x[0] for x in d[side]]:
            raise KeyError(f"{node['type']} has no {side[:-1]} '{socket}' (has {[x[0] for x in d[side]]})")


# ---------------------------------------------------------------- shared rig

def rig(s, *, bg=INK, cam_loc=v3(0, 0, 10), cam_target=v3(0, 0, 0), fov=35, next_canvas=None,
        bloom=(0.55, 0.45, 0.9), grain=0.16, vignette=(1.0, 1.1), ambient=0.0, contrast=1.0):
    """Render, background, camera, the post stack, the chapter clock and the
    hand-off to the next canvas — the same skeleton under every chapter.

    Gives the chapter `frame` and `t` (seconds since the chapter began, read
    off the timeline frame) to drive things from, `cam`, and the post stack:
    effects added with post() run before the finishing passes."""
    s.add("render", "render", 13, frameCount=s.frames, fps=FPS, resolutionPreset="16:9 (1920x1080)",
          width=1920, height=1080, timelineEnabled=True, motionBlur=0)
    s.add("env", "lighting/environment", 12, color=bg, intensity=1, background=1, ambientIntensity=ambient, sunIntensity=0.0)
    s.wire("env", "environment", "render", "environment")

    s.add("frame", "time/frame", 0)
    s.add("t", "math/expression", 1, formula="x / 30")
    s.wire("frame", "frame", "t", "x")

    s.add("cam", "calibration/camera", 12, active=True, mode="manual", location=cam_loc, useTarget=True,
          target=cam_target, up=v3(0, 1, 0), fov=fov, projectionType="perspective")

    s.add("post_in", "postprocess/antialias", 10, enabled=1)
    s.add("bloom", "postprocess/bloom", 11, strength=bloom[0], radius=bloom[1], threshold=bloom[2])
    s.add("grade", "postprocess/color-correction", 11, brightness=0.0, contrast=contrast, saturation=1.0)
    s.add("chroma", "postprocess/rgb-shift", 11, amount=0.0, angle=0)
    s.add("grain", "postprocess/film-grain", 11, noiseIntensity=grain, scanlinesIntensity=0.0, scanlinesCount=2048, grayscale=0)
    # three's vignette pulls the edges toward grey (1 - darkness): at 1 or
    # more it only darkens, below 1 it would lift dark shapes near the edges.
    s.add("vig", "postprocess/vignette", 11, offset=vignette[0], darkness=vignette[1])
    s.wire("vig", "effect", "render", "postprocess")

    # Every cut lands with a chromatic kick that settles in a few frames.
    s.key("chroma", "amount", [(0, 0.014), (9, 0.0, "expo", 6)])

    if next_canvas is not None:
        s.add("end", "logic/compare", 1, op=">=", a=0, b=s.frames - 1)
        s.wire("frame", "frame", "end", "a")
        s.add("goto", "canvas/goto", 2, canvas=next_canvas, trigger=0)
        s.wire("end", "out", "goto", "trigger")


def post(s, nid, ntype, **params):
    """Appends an effect to the chapter's slot in the post stack."""
    s.add(nid, ntype, 10, **params)
    s.wire(s.post_tail[0], s.post_tail[1], nid, "effect")
    s.post_tail = (nid, "effect")


def close_post(s):
    """Wires the chapter's effects into the finishing passes."""
    s.wire(s.post_tail[0], s.post_tail[1], "bloom", "effect")
    s.wire("bloom", "effect", "grade", "effect")
    s.wire("grade", "effect", "chroma", "effect")
    s.wire("chroma", "effect", "grain", "effect")
    s.wire("grain", "effect", "vig", "effect")


def flash_out(s, frames=5, to=0.9):
    """The last frames blow out to white."""
    s.key("grade", "brightness", [(0, 0.0), (s.frames - frames, 0.0), (s.frames - 1, to, "linear")])


def flash_in(s, frm=0.85, frames=7):
    """Arriving from a white flash."""
    s.key("grade", "brightness", [(0, frm), (frames, 0.0, "expo", 6)])


def fade(s, keys):
    """Fades through black. Color Correction's Saturation multiplies the
    frame (0 = black); a negative Brightness would not work — it feeds a pow()."""
    s.key("grade", "saturation", keys)


def merge_all(s, ids, col=12):
    s.add("scene", "structure/merge", col)
    for i, nid in enumerate(ids):
        s.wire(nid, "geometry", "scene", f"in{i}")
    s.wire("scene", "geometry", "render", "geometry")


def mono_x(text, size, left=None, right=None):
    """HUD text is drawn centred on its x; place it by its left or right edge
    instead (monospace advance ≈ 0.6 em)."""
    w = 0.6 * size * len(text)
    return left + w / 2 if left is not None else 1920 - right - w / 2


def hud(s, nid, text, x, y, size=20, color=BONE, family="monospace", show=None, texts=None, **extra):
    """A HUD caption at (x, y) render pixels. `show`: [(frame, 0|1)] cuts
    visibility; `texts`: [(frame, str)] swaps the words on those frames."""
    params = dict(text=text, trigger=1, x=x, y=y, rotation=0, scale=1, visible=1, fontFamily=family,
                  fontSize=size, color=color, opacity=1, enterAnimation="none", exitAnimation="none",
                  durationIn=0.05, durationOut=0.05)
    params.update(extra)
    s.add(nid, "hub/text", 9, **params)
    if show:
        s.key(nid, "visible", [(f, v, "hold") for f, v in show])
    if texts:
        s.key(nid, "text", [(f, v, "hold") for f, v in texts])
    return nid


def chrome_hud(s, index, title, credit, color=BONE, dim=STEEL, show_from=0):
    """The only furniture a chapter wears: its index top left, and bottom
    right the nodes that are making what is on screen."""
    label = f"{index:02d} / {title}"
    hud(s, "h_chap", label, mono_x(label, 20, left=96), 84, size=20, color=color)
    hud(s, "h_nodes", credit, mono_x(credit, 18, right=96), 1000, size=18, color=dim,
        show=[(0, 0), (show_from, 1)] if show_from else None)


def text_in(s, nid, start, frames, window=0.45, ease="expo", strength=5):
    """Letters of a Text Animator arrive left to right: its Progress swept
    across an inverted smooth selector of width `window`."""
    s.add(nid + "_p", "math/expression", 4, formula="x", x=0)
    s.wire(nid + "_p", "value", nid, "progress")
    s.key(nid + "_p", "x", [(start, 0.0), (start + frames, 1.0 + window, ease, strength)])


# ------------------------------------------------------------- 1 · IGNITION

def chapter_ignition():
    """Black. A vermilion sun rises on the downbeat and the beats ring out of
    it; TSUJI lands letter by letter in front of it, the machine voice spells
    out what it is, the letters fly up and the sun swallows the frame — into
    chapter 2's red."""
    s = Scene("c1", 4 * BAR)
    rig(s, cam_loc=v3(0, 0.3, 16), cam_target=v3(0, 0.3, 0), fov=30, next_canvas=2)
    s.key("chroma", "amount", [(0, 0.0)])
    fade(s, [(0, 0.0), (10, 1.0, "expo", 5)])

    # Camera: one slow push across the chapter, snapping in as the type lands.
    s.key("cam", "location", [(0, v3(0, 0.3, 16)), (BAR, v3(0, 0.3, 14.5), "smooth"),
                              (BAR + 40, v3(0, 0.25, 11.2), "expo", 5), (3 * BAR + 30, v3(0, 0.2, 10.2), "smooth"),
                              (4 * BAR, v3(0, 0.2, 8.0), EASE_IN)])

    # The sun.
    s.add("sun", "object/disc", 5, radius=2.4, innerRadius=0, depth=0, location=v3(0, 0.55, -4), rotation=v3(0, 0, 0),
          scale=v3(0, 0, 0), color=VERMILION, emissive=VERMILION, emissiveIntensity=0.25, shadeless=1)
    # It throbs on every beat of bar 3 and swallows the frame on the way out.
    sun = [(0, v3(0, 0, 0)), (BEAT + 4, v3(1, 1, 1), "back", 1.4), (2 * BAR - 1, v3(1, 1, 1))]
    for b in range(4):
        f = 2 * BAR + b * BEAT
        g = 1.0 + 0.03 * b
        sun += [(f, v3(g + 0.07, g + 0.07, g + 0.07), "hold"), (f + 12, v3(g, g, g), "expo", 5)]
    sun += [(3 * BAR + 24, v3(1.12, 1.12, 1.12), "smooth"), (4 * BAR - 6, v3(9, 9, 9), EASE_IN)]
    s.key("sun", "scale", sun)
    s.key("sun", "location", [(0, v3(0, -1.6, -4)), (BEAT + 4, v3(0, 0.55, -4), "expo", 6)])

    # Rings breathing out of it on beats 2, 3 and 4 of the first bar.
    s.add("ring", "object/disc", 5, radius=2.6, innerRadius=2.55, depth=0, location=v3(0, 0.55, -4.05),
          rotation=v3(0, 0, 0), color=BONE, emissive=BONE, emissiveIntensity=0.3, shadeless=1, opacity=0.0, scale=v3(1, 1, 1))
    ring_s, ring_o = [], []
    for f in [BEAT, 2 * BEAT, 3 * BEAT] + [2 * BAR + b * BEAT for b in range(4)]:
        ring_s += [(f, v3(0.9, 0.9, 0.9), "hold"), (f + 14, v3(2.1, 2.1, 2.1), "expo", 5)]
        ring_o += [(f - 1, 0.0), (f, 0.85, "hold"), (f + 14, 0.0, "expo", 3)]
    s.key("ring", "scale", ring_s)
    s.key("ring", "opacity", ring_o)

    # TSUJI, one letter landing per eighth note from bar 2.
    s.add("title", "text/animator", 6, text="TSUJI", fontPreset="Anton", fontSize=150, depth=0.5, bevelEnabled=True,
          tracking=6, lineHeight=1.0, align="center", anchor="glyph_center", basedOn="characters",
          selectorShape="smooth", start=0, end=0.45, offset=-0.45, invert=True, randomize=False,
          positionDelta=[0, -2.4, 2.2], rotationDelta=[-80 * DEG, 0, 10 * DEG], scaleDelta=[0, 0, 0],
          location=v3(0, 0.3, 0), color=BONE, roughness=0.45, metalness=0.0, emissive=0x1C1A17, emissiveIntensity=1)
    text_in(s, "title", BAR, 36)
    # ... and leaving the way it came, upward, on the last bar.
    out = 3 * BAR + 15
    s.key("title", "positionDelta", [(out - 1, [0, -2.4, 2.2], "hold"), (out, [0, 3.2, -1.5], "hold")])
    s.key("title_p", "x", [(BAR, 0.0), (BAR + 36, 1.45, "expo", 5), (out, 1.45), (out + 26, 0.0, EASE_IN)])

    # The machine voice, typed on.
    s.add("tag", "text/animator", 6, text="NODE-BASED  MOTION  DESIGN", fontPreset="Doto", fontSize=15, depth=0.02,
          bevelEnabled=False, tracking=1.5, align="center", anchor="glyph_center", basedOn="characters",
          selectorShape="square", start=0, end=0, offset=-0.04, positionDelta=[0, 0, 0], rotationDelta=[0, 0, 0],
          scaleDelta=[0, 0, 0], location=v3(0, -1.78, 0.6), color=BONE, emissive=BONE, emissiveIntensity=0.35, shadeless=1)
    s.add("tag_p", "math/expression", 4, formula="x", x=0)
    s.wire("tag_p", "value", "tag", "progress")
    s.key("tag_p", "x", [(2 * BAR, 0.0), (2 * BAR + 26, 1.08, "linear"), (3 * BAR + 6, 1.08), (3 * BAR + 18, 0.0, "linear")])

    s.add("key", "light/directional", 7, location=v3(-4, 5, 9), target=v3(0, 0, 0), color=0xFFF4EA, intensity=2.4, castShadow=0)
    s.add("rim", "light/directional", 7, location=v3(4, -2, -6), target=v3(0, 0, 0), color=VERMILION, intensity=3.5, castShadow=0)

    chrome_hud(s, 1, "IGNITION", "text/animator  ·  range selector  ·  keyframes", show_from=BAR)
    close_post(s)
    merge_all(s, ["sun", "ring", "title", "tag"])
    s.marker(0, "sun")
    s.marker(BAR, "title")
    s.marker(2 * BAR, "tagline")
    s.marker(out, "exit")
    return s


# ----------------------------------------------------------------- 2 · TYPE

def chapter_type():
    """Red. One word per beat, then three rings of type spinning around it on
    crossed axes — text on a path, the rings a gyroscope — the camera rises
    and circles, the rings close, and an ink iris shuts the chapter into
    chapter 3's black."""
    s = Scene("c2", 4 * BAR)
    rig(s, bg=VERMILION, cam_loc=v3(0, 1.2, 12), cam_target=v3(0, 0.1, 0), fov=36, next_canvas=3,
        bloom=(0.2, 0.4, 0.96), grain=0.14, vignette=(0.7, 1.0))
    # Bar 1 sits right on the words, so each one fills the frame; the downbeat
    # of bar 2 pulls back to reveal the rings.
    s.key("cam", "location", [(0, v3(0, 0.1, 7.2)), (BAR - 1, v3(0, 0.1, 6.4), "linear"), (BAR + 20, v3(0, 0.6, 11.8), "expo", 6),
                              (2 * BAR, v3(-2.0, 3.6, 12.0), "expo", 4), (3 * BAR, v3(4.0, 2.4, 11.0), EASE_IO),
                              (3 * BAR + 40, v3(0.0, 1.0, 10.5), EASE_IO), (4 * BAR, v3(0.0, 0.6, 9.0), "smooth")])

    words = [(0, "TYPE"), (BEAT, "THAT"), (2 * BEAT, "MOVES"), (3 * BEAT, "ON BEAT."), (BAR, "KINETIC"),
             (3 * BAR, "ANY PATH.")]
    s.add("word", "text/animator", 6, text="TYPE", fontPreset="Anton", fontSize=100, depth=0.35, bevelEnabled=True,
          tracking=4, align="center", anchor="glyph_center", basedOn="characters", selectorShape="smooth",
          start=0, end=0.5, offset=-0.5, invert=True, positionDelta=[0, -1.0, 0.8], rotationDelta=[-90 * DEG, 0, 0],
          scaleDelta=[0, 0, 0], location=v3(0, 0.0, 0), color=INK, roughness=0.55, metalness=0.0)
    s.key("word", "text", [(f, w, "hold") for f, w in words])
    s.add("word_p", "math/expression", 4, formula="x", x=0)
    s.wire("word_p", "value", "word", "progress")
    keys = []
    for f, _ in words:
        if f > 0:
            keys.append((f - 1, 1.5))
        keys += [(f, 0.0, "hold"), (f + 10, 1.5, "expo", 5)]
    s.key("word_p", "x", keys)
    # A pop on every swap, and a collapse on the way out.
    pops = []
    for f, _ in words:
        if f > 0:
            pops.append((f - 1, v3(1, 1, 1)))
        pops += [(f, v3(1.16, 1.16, 1.16), "hold"), (f + 9, v3(1, 1, 1), "expo", 5)]
    pops += [(4 * BAR - 24, v3(1, 1, 1)), (4 * BAR - 10, v3(0.0, 0.0, 0.0), EASE_IN)]
    s.key("word", "scale", pops)

    rings = [
        # id, radius, tilt (x, z), text, font, size, colour, turns over the chapter, appears on
        ("ringA", 3.0, (0.42, 0.10), "KINETIC TYPE  /  ON ANY PATH  /  KINETIC TYPE  /  ON ANY PATH  /  ", "Anton", 40, BONE, 0.22, BAR),
        ("ringB", 3.6, (-0.30, -0.42), "RANGE SELECTOR · PER-GLYPH TRANSFORMS · TEXT ON PATH · RANGE SELECTOR · PER-GLYPH TRANSFORMS · TEXT ON PATH · ",
         "Nova Mono", 34, INK, -0.16, BAR + BEAT),
        ("ringC", 4.1, (0.12, 0.55), "TSUJI  /  TYPE IN MOTION  /  TSUJI  /  TYPE IN MOTION  /  TSUJI  /  TYPE IN MOTION  /  ", "Anton", 40, BONE, 0.12, BAR + 2 * BEAT),
    ]
    # The ring paths: 64 points round a circle, run clockwise seen from above
    # so the type on the near side faces the lens — one Expression over a
    # Generate List, into Curve from Points.
    s.add("ring_i", "list/generate", 3, count=64, start=0, step=1)
    for i, (rid, r, (tx, tz), text, font, size, color, turn, at) in enumerate(rings):
        s.add(rid + "_pts", "math/expression", 4, formula="(a*cos(-tau*x/64), 0, a*sin(-tau*x/64))", a=r)
        s.wire("ring_i", "list", rid + "_pts", "x")
        s.add(rid + "_path", "curve/from_points", 5, type="catmull", closed=1, tension=0.5, sag=0, visible=0)
        s.wire(rid + "_pts", "list", rid + "_path", "points")
        s.add(rid, "text/animator", 6, text=text, fontPreset=font, fontSize=size, depth=0.006,
              bevelEnabled=False, tracking=0, align="center", anchor="glyph_center", alignToPath=True, fitToCurve=True,
              pathOffset=0, positionDelta=[0, 0, 0], rotationDelta=[0, 0, 0], scaleDelta=[1, 1, 1],
              rotation=v3(tx, 0, tz), color=color, shadeless=1, scale=v3(0, 0, 0))
        s.wire(rid + "_path", "curve", rid, "curve")
        s.key(rid, "pathOffset", [(0, 0.0), (4 * BAR, turn, "linear")])
        out = 3 * BAR + 30 + 4 * i
        s.key(rid, "scale", [(at - 1, v3(0, 0, 0)), (at + 12, v3(1, 1, 1), "back", 1.5),
                             (out, v3(1, 1, 1)), (out + 14, v3(0, 0, 0), EASE_IN)])
    # Bar 3: the gyroscope opens up — every ring tips further off its axis.
    for rid, r, (tx, tz), *_ in rings:
        s.key(rid, "rotation", [(2 * BAR, v3(tx, 0, tz)), (2 * BAR + 24, v3(tx * 1.4, 0.35, tz * 1.3), "back", 1.2),
                                          (3 * BAR + 20, v3(tx * 1.4, 0.35, tz * 1.3)), (4 * BAR - 10, v3(tx, 0, tz), "smooth")])

    # The iris: an ink disc opening in front of the lens on the last beats.
    s.add("iris", "object/disc", 5, radius=1.0, innerRadius=0, depth=0, location=v3(0, 0.6, 6.0), rotation=v3(0, 0, 0),
          scale=v3(0, 0, 0), color=INK, shadeless=1)
    s.key("iris", "scale", [(4 * BAR - 13, v3(0, 0, 0)), (4 * BAR - 2, v3(4, 4, 4), EASE_IN)])

    s.add("key", "light/directional", 7, location=v3(-3, 6, 9), target=v3(0, 0, 0), color=0xFFFFFF, intensity=2.2, castShadow=0)
    s.add("fill", "light/directional", 7, location=v3(5, 1, 6), target=v3(0, 0, 0), color=0xFFD9C9, intensity=1.0, castShadow=0)

    chrome_hud(s, 2, "KINETIC TYPE", "curve/from-points  →  text/animator  ·  path offset", color=INK, dim=0x5A1408)
    close_post(s)
    merge_all(s, ["word", "ringA", "ringB", "ringC", "iris"])
    s.marker(0, "words")
    s.marker(BAR, "rings")
    s.marker(2 * BAR, "gyroscope")
    s.marker(3 * BAR, "any path")
    return s


# ----------------------------------------------------------- 3 · PROCEDURAL

def chapter_grid():
    """Black. 400 columns rise from the centre and ripple — heights from one
    Expression over each column's distance to two moving sources, colour from
    a ramp on the same heights — the bass hits the amplitude every beat of
    bar 3, and the field dissolves at random into a white flash."""
    s = Scene("c3", 4 * BAR)
    rig(s, cam_loc=v3(24, 26, 24), cam_target=v3(0, 0, 0), fov=20, next_canvas=4, bloom=(0.45, 0.5, 0.86), ambient=0.12)
    flash_out(s)
    s.key("cam", "location", [(0, v3(17, 30, 25)), (2 * BAR, v3(27, 21, 15), "smooth"), (3 * BAR, v3(25, 15, 10), EASE_IO),
                              (4 * BAR, v3(17, 11, 7), "smooth")])
    s.key("cam", "target", [(0, v3(0, 0, 0)), (3 * BAR, v3(0, 0.4, 0), "smooth"), (4 * BAR, v3(-0.5, 0.6, 0), "smooth")])

    s.add("column", "object/box", 3, scale=v3(0.5, 1, 0.5), color=BONE, roughness=0.42, metalness=0.05)
    s.add("grid", "structure/array", 4, mode="grid", plane="XZ", gridCols=20, gridRows=20, spacingX=0.6, spacingY=0.6,
          centerGrid=True, gpuInstancing=False)
    s.wire("column", "geometry", "grid", "geometry")

    # Two sources: the centre, and one that wanders in on bar 2.
    s.add("d1", "math/distances", 5, tx=0, ty=0, tz=0)
    s.wire("grid", "geometry", "d1", "instances")
    s.add("src2", "math/expression", 4, formula="(3.2 cos(0.7 t + 1), 0, 3.2 sin(0.7 t + 1))")
    s.wire("t", "value", "src2", "t")
    s.add("d2", "math/distances", 5)
    s.wire("grid", "geometry", "d2", "instances")
    s.wire("src2", "vector", "d2", "target")

    s.add("amp", "math/expression", 4, formula="x", x=1.0)
    amp = [(0, 1.0), (2 * BAR - 1, 1.0)]
    for b in range(4):  # bar 3: a kick on every beat
        f = 2 * BAR + b * BEAT
        amp += [(f, 2.1, "hold"), (f + 12, 1.0, "expo", 5)]
    amp += [(3 * BAR + 30, 1.0), (4 * BAR - 10, 0.0, "smooth")]
    s.key("amp", "x", amp)
    s.add("mix", "math/expression", 4, formula="x", x=0.0)
    s.key("mix", "x", [(BAR - 1, 0.0), (BAR + 20, 1.0, "expo", 4)])

    s.add("height", "math/expression", 6,
          formula="(0.12 + a*(0.5 + 0.5*sin(1.7*x - 4.6*t))*exp(-0.075*x) + b*0.85*(0.5 + 0.5*sin(2.3*y - 5.8*t))*exp(-0.11*y))"
                  " * clamp((10*t - x)*0.35, 0, 1)")
    s.wire("d1", "distances", "height", "x")
    s.wire("d2", "distances", "height", "y")
    s.wire("t", "value", "height", "t")
    s.wire("amp", "value", "height", "a")
    s.wire("mix", "value", "height", "b")

    # The dissolve: every column shrinks away, in random order, on the last bar.
    s.add("fade", "list/stagger", 5, spacing="total", total=1.1, duration=0.35, startAt=6.85, order="random", seed=7,
          ease="smooth", easeStrength=1, **{"from": 1.0, "to": 0.0})
    s.wire("t", "value", "fade", "time")
    s.wire("grid", "geometry", "fade", "source")
    s.add("sy", "math/expression", 7, formula="x*y")
    s.wire("height", "list", "sy", "x")
    s.wire("fade", "values", "sy", "y")
    s.add("py", "math/expression", 7, formula="x*0.5")
    s.wire("sy", "list", "py", "x")

    s.add("xform", "structure/instance-transform", 8, mode="relative", pivot="individual", index=-1)
    s.wire("grid", "geometry", "xform", "geometry")
    s.wire("sy", "list", "xform", "scaleY")
    s.wire("py", "list", "xform", "posY")
    s.wire("fade", "values", "xform", "scaleX")
    s.wire("fade", "values", "xform", "scaleZ")

    s.add("heat", "list/gradient", 7, radius=1.95, power=1.0,
          ramp=ramp((0.0, 0x17181D), (0.3, 0x3B3E48), (0.62, VERMILION), (0.85, EMBER), (1.0, 0xFFE3CC)))
    s.wire("height", "list", "heat", "values")
    s.add("tint", "structure/instance-color", 9, index=-1)
    s.wire("xform", "geometry", "tint", "geometry")
    s.wire("heat", "list", "tint", "colors")

    s.add("key", "light/directional", 7, location=v3(-9, 16, 5), target=v3(0, 0, 0), color=0xFFF1E4, intensity=2.6,
          castShadow=1, shadowSoftness=1)
    s.add("rim", "light/directional", 7, location=v3(10, 4, -12), target=v3(0, 0, 0), color=VERMILION, intensity=1.6, castShadow=0)

    chrome_hud(s, 3, "PROCEDURAL", "structure/array  →  math/expression  →  instance-transform")
    count = "400 INSTANCES   ·   1 EXPRESSION"
    hud(s, "h_count", count, 960, 940, size=26, color=BONE, show=[(0, 0), (BAR, 1), (4 * BAR - 20, 0)])
    close_post(s)
    merge_all(s, ["tint"])
    s.marker(0, "rise")
    s.marker(BAR, "second source")
    s.marker(2 * BAR, "kicks")
    s.marker(3 * BAR + 30, "dissolve")
    return s


# ----------------------------------------------------------- 4 · SIMULATION

def chapter_physics():
    """Bone. The title drops into a Rapier world and lands in a heap, then
    sixty vermilion balls rain on it and scatter the letters across the
    floor. Cut to black."""
    s = Scene("c4", 4 * BAR)
    rig(s, bg=BONE, cam_loc=v3(2, 5, 17), cam_target=v3(0, 2, 0), fov=30, next_canvas=5,
        bloom=(0.15, 0.3, 0.97), grain=0.12, vignette=(0.6, 1.0), ambient=0.75)
    flash_in(s)
    s.key("cam", "location", [(0, v3(1.0, 4.2, 17.5)), (BAR, v3(3.5, 3.4, 15.0), "smooth"), (2 * BAR, v3(6.0, 4.6, 12.5), EASE_IO),
                              (4 * BAR, v3(7.5, 5.5, 9.5), "smooth")])
    s.key("cam", "target", [(0, v3(0, 3.0, 0)), (BAR, v3(0, 1.2, 0), "smooth"), (2 * BAR, v3(0, 0.8, 0), "smooth"),
                            (4 * BAR, v3(0.5, 0.4, 0.5), "smooth")])

    # The world runs on the engine's own clock and is rebuilt on the chapter's
    # first frames, so every pass through the chapter drops the same way. (Not
    # clocked from the Frame node: between captured frames an export
    # evaluates the graph with no timeline frame, which would read as a rewind.)
    s.add("world", "physics/world", 3, gravity=v3(0, -9.81, 0), timestep=1 / 60, maxSteps=4, paused=0, reset=0)
    s.add("restart", "math/expression", 2, formula="x >= 0 && x < 2")
    s.wire("frame", "frame", "restart", "x")
    s.wire("restart", "value", "world", "reset")

    s.add("floor", "object/box", 4, location=v3(0, -0.25, 0), scale=v3(40, 0.5, 40), color=BONE, roughness=0.95, metalness=0)
    s.add("floor_body", "physics/rigid-body", 6, bodyType="fixed", shape="box", split="whole", friction=0.8, restitution=0.2)
    s.wire("world", "world", "floor_body", "world")
    s.wire("floor", "geometry", "floor_body", "geometry")

    s.add("letters", "text/animator", 4, text="TSUJI", fontPreset="Anton", fontSize=130, depth=0.7, bevelEnabled=True,
          tracking=10, align="center", anchor="glyph_center", basedOn="characters", selectorShape="linear",
          start=0, end=1, offset=0, randomize=True, randomSeed=5, positionDelta=[0, 3.0, 0],
          rotationDelta=[0.35, 0.25, 0.5], scaleDelta=[1, 1, 1], location=v3(0, 3.2, 0), color=INK, roughness=0.5)
    s.add("letter_bodies", "physics/rigid-body", 6, bodyType="dynamic", shape="hull", split="per-child", mass=1,
          friction=0.6, restitution=0.25, linearDamping=0.05, angularDamping=0.1, gravityScale=1, ccd=1)
    s.wire("world", "world", "letter_bodies", "world")
    s.wire("letters", "geometry", "letter_bodies", "geometry")

    s.add("ball", "object/sphere", 4, scale=v3(0.42, 0.42, 0.42), color=VERMILION, roughness=0.35, metalness=0.0,
          sphereType="uv", segments=24)
    s.add("rain", "structure/array", 5, mode="grid3d", countX=6, countY=5, countZ=2, spacingX=1.5, spacingY=1.9,
          spacingZ=1.6, spacingVariance=60, centerGrid=True, gpuInstancing=False)
    s.wire("ball", "geometry", "rain", "geometry")
    # Tipped over, so no ball falls straight onto the one below it.
    s.add("rain_up", "transform", 4, location=v3(0.2, 19, 0.3), rotation=v3(0.45, 0.4, 0.35), scale=v3(1, 1, 1),
          useLOCATION=True, useROTATION=True, useSCALE=True)
    s.add("rain_at", "structure/merge", 6)
    s.wire("rain", "geometry", "rain_at", "in0")
    s.wire("rain_up", "matrix", "rain_at", "matrix")
    s.add("ball_bodies", "physics/rigid-body", 7, bodyType="dynamic", shape="sphere", split="per-child", mass=0.6,
          friction=0.4, restitution=0.5, linearDamping=0.02, angularDamping=0.05, gravityScale=1, ccd=1)
    s.wire("world", "world", "ball_bodies", "world")
    s.wire("rain_at", "geometry", "ball_bodies", "geometry")

    # Bar 3: the wrecking ball. Dropped from 80 m it needs four seconds to
    # come down — timed by gravity alone to land on the downbeat.
    s.add("boulder", "object/sphere", 4, location=v3(-0.6, 80, 0.4), scale=v3(1.15, 1.15, 1.15), color=INK, roughness=0.3,
          metalness=0.0, sphereType="uv", segments=48)
    s.add("boulder_body", "physics/rigid-body", 7, bodyType="dynamic", shape="sphere", split="whole", mass=40,
          friction=0.5, restitution=0.15, linearDamping=0.0, angularDamping=0.1, gravityScale=1, ccd=1)
    s.wire("world", "world", "boulder_body", "world")
    s.wire("boulder", "geometry", "boulder_body", "geometry")

    s.add("sun", "light/directional", 8, location=v3(5, 12, 6), target=v3(0, 0, 0), color=0xFFF6EC, intensity=2.2,
          castShadow=1, shadowSoftness=1)

    chrome_hud(s, 4, "SIMULATION", "physics/world  ·  rigid-body  (Rapier)", color=INK, dim=0x7A7468)
    count = "66 RIGID BODIES   ·   ALL SIMULATED"
    hud(s, "h_count", count, 960, 940, size=26, color=INK, show=[(0, 0), (BAR, 1)])
    close_post(s)
    merge_all(s, ["floor_body", "letter_bodies", "ball_bodies", "boulder_body"])
    s.marker(0, "drop")
    s.marker(BAR - 6, "rain")
    s.marker(2 * BAR, "boulder")
    return s


# ------------------------------------------------------------- 5 · LOOK DEV

LOOKS = [
    # frame, HUD label, halftone, duotone (amount, shadow, highlight), pixel size, film grain, glitch, kaleidoscope
    (0, "material/iridescent", 0, (0, INK, BONE), 1, 0, 0, 0),
    (30, "postprocess/halftone", 1, (0, INK, BONE), 1, 0, 0, 0),
    (60, "postprocess/duotone", 0, (1, 0x14070A, VERMILION), 1, 0, 0, 0),
    (90, "postprocess/pixelate", 0, (0, INK, BONE), 14, 0, 0, 0),
    (120, "postprocess/kaleidoscope", 0, (0, INK, BONE), 1, 0, 0, 1),
    (150, "postprocess/glitch", 0, (0, INK, BONE), 1, 0, 1, 0),
    (180, "postprocess/film-texture", 0, (1, 0x1A120C, 0xF2D9B0), 1, 1, 0, 0),
    (210, "postprocess/duotone + halftone", 1, (1, INK, BONE), 1, 0, 0, 0),
]


def chapter_lookdev():
    """Black. One twisting, iridescent column with two moons — and a new look
    every two beats, each a post-process node named on screen: halftone,
    duotone, pixelate, kaleidoscope, glitch, film, print. White out."""
    s = Scene("c5", 4 * BAR)
    rig(s, cam_loc=v3(0, 0.6, 9.5), cam_target=v3(0, 0.25, 0), fov=34, next_canvas=6, bloom=(0.5, 0.5, 0.85))
    flash_out(s)
    s.key("cam", "location", [(0, v3(-1.0, 0.4, 10.5)), (2 * BAR, v3(1.2, 1.4, 9.0), "smooth"), (4 * BAR, v3(0.0, 0.2, 7.4), "smooth")])

    s.add("irid", "material/iridescent", 3, baseColor=0x101014, specularColor=0xFFFFFF, filmThickness=420, refractiveIndex=1.42,
          boost=1.25, roughness=0.18, rippleSpeed=0.6, rippleFrequency=5.0, rainbowMix=0.7)
    s.add("core", "object/box", 4, scale=v3(1.1, 2.9, 1.1), color=0xFFFFFF)
    s.wire("irid", "material", "core", "material")
    s.add("round", "modifier/subdivide", 5, mode="simple", levels=4)
    s.wire("core", "geometry", "round", "geometry")
    s.add("twist_amt", "math/expression", 4, formula="150*sin(0.75*t + 0.5)", x=0)
    s.wire("t", "value", "twist_amt", "t")
    s.add("twist", "geometry/twist-bend-taper", 6, twist=1.0, bend=0, taper=0, axis="y")
    s.wire("round", "geometry", "twist", "geometry")
    s.wire("twist_amt", "value", "twist", "twist")
    s.add("spin", "transform", 5, location=v3(0, 0, 0), rotation=v3(0.12, 0, 0.08), scale=v3(1, 1, 1),
          useLOCATION=True, useROTATION=True, useSCALE=True)
    s.key("spin", "rotation", [(0, v3(0.12, 0, 0.08)), (4 * BAR, v3(0.12, 2 * math.pi, 0.08), "linear")])
    s.add("smooth", "modifier/shade", 6, mode="auto", autoAngle=40)
    s.wire("twist", "geometry", "smooth", "geometry")
    s.add("hero", "structure/merge", 7)
    s.wire("smooth", "geometry", "hero", "in0")
    s.wire("spin", "matrix", "hero", "matrix")

    for i, (phase, r, tilt, size, color) in enumerate([(0.0, 2.7, 0.5, 0.55, VERMILION), (math.pi, 3.2, -0.4, 0.4, BONE)]):
        s.add(f"moon{i}_at", "math/expression", 4,
              formula=f"({r}*cos(1.4*t + {phase:.4f}), {tilt}*sin(1.4*t + {phase:.4f}), {r}*sin(1.4*t + {phase:.4f}))")
        s.wire("t", "value", f"moon{i}_at", "t")
        s.add(f"moon{i}_m", "transform", 5, location=v3(), rotation=v3(), scale=v3(size, size, size),
              useLOCATION=True, useROTATION=True, useSCALE=True)
        s.wire(f"moon{i}_at", "vector", f"moon{i}_m", "location")
        s.add(f"moon{i}", "object/sphere", 6, color=color, roughness=0.35, metalness=0.0, sphereType="uv", segments=48)
        s.wire(f"moon{i}_m", "matrix", f"moon{i}", "matrix")
    s.add("halo", "object/disc", 6, radius=3.3, innerRadius=3.26, depth=0, location=v3(0, 0, -2.5), rotation=v3(0, 0, 0),
          color=VERMILION, emissive=VERMILION, emissiveIntensity=0.6, shadeless=1)
    s.key("halo", "scale", [(0, v3(0.6, 0.6, 0.6)), (BEAT, v3(1, 1, 1), "back", 1.4)])

    s.add("key", "light/directional", 7, location=v3(-4, 6, 6), target=v3(0, 0, 0), color=0xFFFFFF, intensity=2.0, castShadow=0)

    # The looks: every pass sits in the stack all chapter long and is dialled
    # in and out with hold keys; the kaleidoscope, which has no neutral
    # setting, is switched in with a Logic Bridge.
    post(s, "halftone", "postprocess/halftone", radius=7, screenAngle=15, scatter=0, amount=0, shape="dot", greyscale=0)
    post(s, "duotone", "postprocess/duotone", shadowColor=INK, highlightColor=BONE, balance=0.5, softness=0.45, amount=0)
    post(s, "pixel", "postprocess/pixelate", pixelSize=1)
    post(s, "film", "postprocess/film-texture", grain=0, dust=0, scratches=0, blotches=0, rate=12, seed=3)
    post(s, "glitch", "postprocess/glitch", active=0, wild=1)
    s.add("kaleido", "postprocess/kaleidoscope", 10, sides=6, angle=0)
    s.wire("glitch", "effect", "kaleido", "effect")
    s.add("kaleido_on", "logic/bridge", 10, condition=0)
    s.wire("kaleido", "effect", "kaleido_on", "ifTrue")
    s.wire("glitch", "effect", "kaleido_on", "ifFalse")
    s.post_tail = ("kaleido_on", "out")
    s.key("kaleido", "angle", [(120, 0.0), (150, 60.0, "linear")])

    def holds(nid, param, values):
        s.key(nid, param, [(f, v, "hold") for f, v in values])

    holds("halftone", "amount", [(f, h) for f, _, h, *_ in LOOKS])
    holds("duotone", "amount", [(f, d[0]) for f, _, _, d, *_ in LOOKS])
    holds("duotone", "shadowColor", [(f, d[1]) for f, _, _, d, *_ in LOOKS])
    holds("duotone", "highlightColor", [(f, d[2]) for f, _, _, d, *_ in LOOKS])
    holds("pixel", "pixelSize", [(f, p) for f, _, _, _, p, *_ in LOOKS])
    for param, amount in (("grain", 0.35), ("dust", 0.5), ("scratches", 0.4), ("blotches", 0.3)):
        holds("film", param, [(f, amount * g) for f, _, _, _, _, g, *_ in LOOKS])
    # The glitch tears for half a beat, then the chroma split carries the look.
    holds("glitch", "active", [(f, gl) for f, _, _, _, _, _, gl, _ in LOOKS] + [(158, 0)])
    holds("kaleido_on", "condition", [(f, k) for f, *_, k in LOOKS])
    s.key("chroma", "amount", [(0, 0.014), (9, 0.0, "expo", 6), (149, 0.0), (150, 0.012, "hold"), (179, 0.012), (180, 0.0, "hold")])

    chrome_hud(s, 5, "LOOK DEV", "one scene  ·  eight looks  ·  every one real-time")
    hud(s, "h_look", LOOKS[0][1], 960, 948, size=30, color=BONE, texts=[(f, label) for f, label, *_ in LOOKS])
    idx = [(f, f"LOOK {i + 1:02d} / {len(LOOKS):02d}") for i, (f, *_) in enumerate(LOOKS)]
    hud(s, "h_idx", idx[0][1], 960, 905, size=18, color=STEEL, texts=idx)
    close_post(s)
    merge_all(s, ["hero", "moon0", "moon1", "halo"])
    for f, label, *_ in LOOKS:
        s.marker(f, label.split("/")[-1])
    return s


# ------------------------------------------------------------------ 6 · INK

def chapter_ink():
    """Paper. 辻 — tsuji, the crossroads — written stroke by stroke with a
    sumi brush, the vermilion seal stamped beside it, the name and the
    address; then the fade to black the film opens on."""
    s = Scene("c6", 5 * BAR)
    rig(s, bg=BONE, cam_loc=v3(0, 0, 40), cam_target=v3(0, 0, 0), fov=10, next_canvas=1,
        bloom=(0.1, 0.3, 0.98), grain=0.1, vignette=(0.55, 1.0), ambient=0.8, contrast=1.4)
    flash_in(s)
    fade(s, [(5 * BAR - 26, 1.0), (5 * BAR - 2, 0.0, "smooth")])
    # The character is written at the origin with the paper laid over its pen
    # strokes (they would show otherwise); the camera sits off to the right so
    # the page reads kanji left, name right.
    s.key("cam", "location", [(0, v3(2.5, 0.1, 36.5)), (5 * BAR, v3(2.9, 0, 33.5), "smooth")])
    s.key("cam", "target", [(0, v3(2.5, 0.1, 0)), (5 * BAR, v3(2.9, 0, 0), "smooth")])

    kanji_x = 0.0
    strokes = strokes_from_kanjivg(TSUJI, "showreel_tsuji")
    s.add("strokes", "curve/grease-pencil", 3, name="辻 — KanjiVG stroke order", activeColor="#111111", brushSize=4,
          brushType="ink_pen", onionSkin=False, visible=True, location=v3(), rotation=v3(), scale=v3(1, 1, 1),
          frames=[{"frame": 0, "strokes": strokes}])
    s.add("write", "curve/write-on", 4, timing="progress", progress=0, startTime=0, speed=2.4, pause=0.35, overlap=0.1,
          ease="brush")
    s.wire("strokes", "curves", "write", "curves")
    s.add("write_p", "math/expression", 3, formula="x", x=0)
    s.wire("write_p", "value", "write", "progress")
    s.key("write_p", "x", [(6, 0.0), (2 * BAR + 30, 1.0, "linear")])

    paper_hex = "#EDEAE2"
    s.add("brush", "texture/brush-canvas", 5, resolution="2048x2048", background=paper_hex, transparent=False,
          frameMode="fixed", frameCenter=v3(0, 0, 0), frameSize=6.4, frameMargin=0.1, seed=7, boil=0, brushScale=1,
          curvature=0.5, strokeEnabled=True, strokeBrush="sumi", strokeColor="#111111", strokeWeight=9,
          useStrokeColors=False, fillMode="none", hatchEnabled=False, field="none", fieldSpeed=0, wiggle=0)
    s.wire("write", "curves", "brush", "curves")
    s.add("wash_shape", "curve/stroke-outline", 4, width=0.042, minWidth=0.013, spread=0.038, usePressure=True, caps="round")
    s.wire("strokes", "curves", "wash_shape", "curves")
    s.add("wash_in", "list/map-range", 5, inMin=0, inMax=0.6, outMin=0, outMax=1, clamp=1, power=1)
    s.add("wash_spread", "list/map-range", 5, inMin=0, inMax=2.5, outMin=0.08, outMax=0.6, clamp=1, power=0.6)
    s.wire("write", "age", "wash_in", "list")
    s.wire("write", "age", "wash_spread", "list")
    s.add("wash_style", "curve/stroke-style", 6, opacity=1, weight=1, setBleed=False, bleed=0.3, setFillColor=False, fillColor=0x6B6B6B)
    s.wire("wash_shape", "curves", "wash_style", "curves")
    s.wire("wash_in", "list", "wash_style", "opacities")
    s.wire("wash_spread", "list", "wash_style", "bleeds")
    s.add("wash", "texture/brush-canvas", 6, resolution="512x512", background="#ffffff", transparent=False,
          frameMode="fixed", frameCenter=v3(0, 0, 0), frameSize=6.4, frameMargin=0.1, seed=3, boil=0, brushScale=1,
          curvature=0.5, strokeEnabled=False, strokeBrush="2B", strokeColor="#111111", strokeWeight=1,
          fillMode="watercolor", watercolorLook="custom", fillColor="#6a6a6a", fillOpacity=70, bleed=0.3,
          bleedDirection="out", bleedRandomDirection=True, bleedAngle=0, fillTexture=0.7, fillBorder=0.15,
          fillScatter=True, hatchEnabled=False, field="none", fieldSpeed=0, wiggle=0)
    s.wire("wash_style", "curves", "wash", "curves")
    s.add("ink_on_wash", "texture/mix", 7, blendMode="multiply", factor=1)
    s.wire("brush", "texture", "ink_on_wash", "textureA")
    s.wire("wash", "texture", "ink_on_wash", "textureB")
    s.add("paper", "object/plane", 8, visible=1, location=v3(kanji_x, 0, 0.05), rotation=v3(), scale=v3(6.4, 6.4, 1),
          color=0xFFFFFF, shadeless=1, roughness=1, metalness=0)
    s.wire("ink_on_wash", "texture", "paper", "texture")

    # The seal: stamped on the beat once the last stroke is down.
    stamp = 2 * BAR + 45
    s.add("seal", "object/box", 6, location=v3(kanji_x + 2.75, -2.05, 0.2), rotation=v3(0, 0, -4 * DEG),
          scale=v3(0, 0, 0), color=VERMILION, shadeless=1)
    s.key("seal", "scale", [(stamp - 1, v3(0, 0, 0)), (stamp, v3(1.25, 1.25, 0.05), "hold"), (stamp + 8, v3(0.8, 0.8, 0.05), "expo", 7)])
    s.add("seal_txt", "text/animator", 6, text="TSU\nJI", fontPreset="Anton", fontSize=17, depth=0.01, bevelEnabled=False,
          tracking=0, lineHeight=0.95, align="center", anchor="glyph_center", positionDelta=[0, 0, 0],
          rotationDelta=[0, 0, 0], scaleDelta=[1, 1, 1], location=v3(kanji_x + 2.75, -2.05, 0.3),
          rotation=v3(0, 0, -4 * DEG), scale=v3(0, 0, 0), color=BONE, shadeless=1)
    s.key("seal_txt", "scale", [(stamp - 1, v3(0, 0, 0)), (stamp, v3(1.55, 1.55, 1), "hold"), (stamp + 8, v3(1, 1, 1), "expo", 7)])

    # The name, the line, the address.
    s.add("name", "text/animator", 6, text="TSUJI", fontPreset="Anton", fontSize=100, depth=0.02, bevelEnabled=False,
          tracking=8, align="left", anchor="glyph_center", selectorShape="smooth", start=0, end=0.5, offset=-0.5,
          invert=True, positionDelta=[0, -0.6, 0], rotationDelta=[0, 0, 0], scaleDelta=[1, 0, 1],
          location=v3(3.75, 0.7, 0.2), color=INK, shadeless=1)
    text_in(s, "name", stamp + BEAT, 24, window=0.5)
    s.add("line", "text/animator", 6, text="MOTION DESIGN, WIRED.", fontPreset="Nova Mono", fontSize=17, depth=0.01,
          bevelEnabled=False, tracking=1, align="left", anchor="glyph_center", selectorShape="square", start=0, end=0,
          offset=-0.04, positionDelta=[0, 0, 0], rotationDelta=[0, 0, 0], scaleDelta=[0, 0, 0],
          location=v3(3.78, -0.36, 0.2), color=VERMILION, shadeless=1)
    s.add("line_p", "math/expression", 4, formula="x", x=0)
    s.wire("line_p", "value", "line", "progress")
    s.key("line_p", "x", [(stamp + 2 * BEAT, 0.0), (stamp + 2 * BEAT + 22, 1.08, "linear")])

    info = "real-time · web · macOS · windows · linux · open source"
    url = "nikos-unilasalle.github.io/tsuji"
    hud(s, "h_info", info, mono_x(info, 18, left=1138), 700, size=18, color=0x55524C, show=[(0, 0), (stamp + 3 * BEAT + 10, 1)])
    hud(s, "h_url", url, mono_x(url, 26, left=1138), 752, size=26, color=INK, show=[(0, 0), (stamp + 4 * BEAT, 1)])

    chrome_hud(s, 6, "INK", "grease-pencil  →  write-on  →  brush-canvas (sumi)", color=INK, dim=0x7A7468)
    credit = "辻 stroke data: KanjiVG © Ulrich Apel, CC BY-SA 3.0"
    hud(s, "h_credit", credit, mono_x(credit, 14, left=96), 1040, size=14, color=0x9A958A)
    close_post(s)
    merge_all(s, ["paper", "seal", "seal_txt", "name", "line"])
    s.marker(6, "brush")
    s.marker(stamp, "seal")
    s.marker(stamp + BEAT, "name")
    s.marker(5 * BAR - 26, "fade")
    return s


# ------------------------------------------------------------------ build

CHAPTERS = [chapter_ignition, chapter_type, chapter_grid, chapter_physics, chapter_lookdev, chapter_ink]


def build():
    chapters = [make() for make in CHAPTERS]
    with open(OUT, "w") as f:
        json.dump({"canvases": [c.graph() for c in chapters], "activeCanvas": 0}, f, indent=1, ensure_ascii=False)
        f.write("\n")
    total = sum(c.frames for c in chapters)
    for c in chapters:
        print(f"  {c.name}: {len(c.nodes):3d} nodes, {len(c.conns):3d} wires, {c.frames} frames")
    print(f"wrote {os.path.relpath(OUT, ROOT)} — {total} frames, {total / FPS:.0f} s")


if __name__ == "__main__":
    build()
