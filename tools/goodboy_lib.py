"""Helpers for gen_goodboy_demo.py — a thin builder over the .tsuji JSON (see gen_joint_demos.py).

Each helper is a small recipe of Tsuji's own nodes (Texture to Plane → Dual Tone → Halftone → Outline → Appear; Curve from
Points → Curve to Line; Array; Pivot Transform + Oscillator; Wiggle; Grease Pencil…): the scene is made of the same nodes a
user would wire, not of a private engine.

World: the camera sees H=6 units vertically, W=14.34 horizontally (1912x800, 2.39:1). z orders layers:
background -5, bursts -2..-1, photos 0..1, text 2+. Keyframes are in frames at 30 fps.
"""
import json, math, os, random
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(ROOT, "motion_demo/assets")
# Files are named `assets/<file>`, relative to the project file (motion_demo/), which the desktop app resolves next to the
# project when it opens. GB_MODE=served writes `demos/goodboy/…` instead (a throw-away web test through a symlink in public/).
SERVED = os.environ.get("GB_MODE") == "served"
ASSET = "demos/goodboy/" if SERVED else "assets/"
FONT = ASSET + "noto_sans_sc_black.json"
MUSIC_FRAMES = [236, 279, 261, 279, 226, 225]   # scene lengths (frames at 30 fps): scene cuts land on bar lines of the music

# Palette (sampled from the reference, see motion_demo/STYLE.md)
INK, CREAM, TEAL, MUSTARD, CRIMSON, JADE, PINK = 0x121C1F, 0xDCD8C4, 0x2C85A5, 0xE8A91F, 0xC4123A, 0x15A864, 0xE0245E
WHITE = 0xF4F1E6

H = 6.0
W = H * 1912 / 800
FPS = 30
CAM_DIST = 40.0
CAM_FOV = math.degrees(2 * math.atan((H / 2) / CAM_DIST))   # ~8.6 deg: almost orthographic, still depth-sorted
CHARS = set()          # every character the demo prints; the font subset is built from it
TEXT_UNIT = 0.0143      # world units of glyph height per Text font-size px


def v3(x=0.0, y=0.0, z=0.0):
    return {"x": x, "y": y, "z": z}


def rgb(hexv):
    return {"r": ((hexv >> 16) & 255) / 255, "g": ((hexv >> 8) & 255) / 255, "b": (hexv & 255) / 255}


_sizes = {}
def aspect(file):
    if file not in _sizes:
        _sizes[file] = Image.open(os.path.join(ASSETS_DIR, file)).size
    w, h = _sizes[file]
    return w / h


def _builder(f):
    """A builder's nodes form one chain: the layout keeps them together in one row."""
    def wrapped(self, *a, **k):
        if not self._open:
            self._blk += 1
        self._open += 1
        try:
            return f(self, *a, **k)
        finally:
            self._open -= 1
    wrapped.__name__ = f.__name__
    wrapped.__doc__ = f.__doc__
    return wrapped


# Rough on-screen height of a node card (px), for laying the graph out without overlaps.
NODE_H = {"texture/image": 100, "texture/plane": 190, "modifier/duotone": 200, "modifier/halftone": 180, "modifier/outline": 260,
          "object/text": 280, "curve/from_points": 180, "curve/fill": 200, "curve/to_mesh": 240, "mask/roto": 100, "object/polygon": 290,
          "object/sphere": 290, "light/ambient": 100, "light/directional": 220, "sound/player": 180, "render": 140,
          "postprocess/film-texture": 180, "postprocess/film-grain": 160, "time/frame": 80, "logic/compare": 100, "canvas/goto": 100,
          "texture/procedural": 240, "lighting/environment": 220, "calibration/camera": 200, "transform": 150,
          "modifier/appear": 200, "modifier/super8": 200, "curve/to_line": 220, "curve/to_line_list": 220, "structure/array": 330,
          "structure/merge": 160, "animation/wiggle": 330, "animation/oscillator": 170, "transform/pivot": 190, "value/math": 100,
          "converter/value-to-vector": 90, "vector/compose": 130, "math/expression": 280, "curve/primitive": 200, "curve/array": 180,
          "curve/grease-pencil": 300, "physics/rolling": 140, "matrix/math": 120}
NODE_STEP = 280         # horizontal distance between nodes of one chain (cards are ~170-240 px wide)
ROW_W = 3800            # a row of chains wraps beyond this width


class Canvas:
    def __init__(self, frames=240, warp=None):
        self.nodes, self.conns, self.kf, self.markers = [], [], {}, []
        self.frames = frames
        self.warp = warp or []          # [(authored frame, final frame)]: retimes the scene onto the music's beats
        self._n = 0
        self._blk, self._open, self._label = 0, 0, "Réglages et post"
        self.meta = {}                  # node id -> (label, block)

    # --- time --------------------------------------------------------------------
    def tw(self, t):
        """Authored frame -> final frame (piecewise linear through the warp points)."""
        w = self.warp
        if not w:
            return t
        if t <= w[0][0]:
            return w[0][1] + (t - w[0][0])
        for (a0, b0), (a1, b1) in zip(w, w[1:]):
            if t <= a1:
                return b0 + (t - a0) * (b1 - b0) / (a1 - a0)
        return w[-1][1] + (t - w[-1][0])

    # --- raw graph ---------------------------------------------------------------
    def uid(self, prefix):
        self._n += 1
        return f"{prefix}{self._n}"

    def label(self, name):
        """Shot title: the next elements are laid out together inside a Frame with this title."""
        self._label = name

    def block(self):
        c = self
        class _B:
            def __enter__(self_):
                c._blk += 1; c._open += 1
            def __exit__(self_, *a):
                c._open -= 1
        return _B()

    def add(self, nid, ntype, x=0, y=0, **params):
        if not self._open:
            self._blk += 1
        self.meta[nid] = (self._label, self._blk)
        self.nodes.append({"id": nid, "type": ntype, "position": {"x": x, "y": y}, "params": params})
        return nid

    def wire(self, a, sa, b, sb):
        self.conns.append({"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb})

    def key(self, nid, param, frames, ease=None):
        """frames: [(frame, value[, ease])] in authored frames; ease: smooth|linear|hold|expo|back|bounce|elastic."""
        if param == "location" and isinstance(frames[0][1], dict):
            # Whole-vector Location keyframes are not applied on Curve Fill nodes; per-axis ones are, everywhere.
            for ax in "xyz":
                self.key(nid, f"location.{ax}", [(f[0], f[1][ax]) + tuple(f[2:]) for f in frames], ease)
            return
        out = []
        for n, f in enumerate(frames):
            k = {"frame": int(round(self.tw(f[0]))), "value": f[1]}
            e = f[2] if len(f) > 2 else ease
            if n == 0:
                e = None        # the first key's easing would shape the whole first segment (see evaluate.resolveSegmentEasing)
            if e:
                k["easeIn"] = e
            out.append(k)
        self.kf.setdefault(nid, {})[param] = out

    def put(self, geo, sock="geometry"):
        """Nothing to do: an object on the canvas is rendered, no Merge needed. Kept so builders read the same."""

    def layout(self):
        """Give every node a position: one row per element chain, wrapped inside one titled Frame per shot."""
        by_id = {n["id"]: n for n in self.nodes}
        labels = []
        for nid, (lab, blk) in self.meta.items():
            if lab not in labels:
                labels.append(lab)
        y = 0
        frames = []
        for lab in labels:
            blocks = {}
            for nid, (l, b) in self.meta.items():
                if l == lab:
                    blocks.setdefault(b, []).append(nid)
            x0, cx, cy, row_h, max_x = 40, 40, 70, 0, 0
            for b, ids in blocks.items():
                w = len(ids) * NODE_STEP
                h = max(NODE_H.get(by_id[i]["type"], 300) for i in ids)
                if cx > x0 and cx + w > ROW_W:
                    cx, cy, row_h = x0, cy + row_h + 40, 0
                for k, i in enumerate(ids):
                    by_id[i]["position"] = {"x": cx + k * NODE_STEP, "y": y + cy}
                cx += w + 40
                row_h = max(row_h, h)
                max_x = max(max_x, cx)
            frames.append((lab, 0, y, max_x + 20, cy + row_h + 50))
            y += cy + row_h + 50 + 120
        pal = [0x3B82F6, 0x22C55E, 0xF59E0B, 0xEC4899, 0xA855F7, 0x14B8A6]
        for n, (lab, fx, fy, fw, fh) in enumerate(frames):
            self.nodes.insert(0, {"id": f"frame{n}", "type": "utility/frame", "position": {"x": fx, "y": fy},
                                  "params": {"title": lab, "color": pal[n % len(pal)], "width": fw, "height": fh}})

    def to_json(self):
        self.layout()
        return {"nodes": self.nodes, "connections": self.conns, "keyframes": self.kf, "markers": self.markers, "exposedParams": []}

    # --- scene plumbing ----------------------------------------------------------
    def setup(self, bg=INK, next_canvas=None, index=None):
        self.add("cam", "calibration/camera", active=True, mode="manual", projectionType="perspective",
                 location=v3(0, 0, CAM_DIST), rotation=v3(), useTarget=False, target=v3(), up=v3(0, 1, 0), fov=CAM_FOV)
        self.add("env", "lighting/environment", color=bg, intensity=1, background=1, blurriness=0, filePath="",
                 backgroundImagePath="", backgroundFit="cover", backgroundScale=v3(1, 1, 1))
        self.add("render", "render", frameCount=self.frames, fps=FPS, resolutionPreset="Custom", width=1912, height=800, timelineEnabled=True)
        self.add("amb", "light/ambient", color=0xFFFFFF, intensity=3.14)
        self.wire("env", "environment", "render", "environment")
        # Global post: printed-paper film look.
        self.add("fx_film", "postprocess/film-texture", grain=0.10, dust=0.30, scratches=0.22, blotches=0.18, rate=12, seed=3)
        self.add("fx_grain", "postprocess/film-grain", noiseIntensity=0.16, scanlinesIntensity=0, scanlinesCount=2048, grayscale=0)
        self.wire("fx_film", "effect", "fx_grain", "effect")
        self.wire("fx_grain", "effect", "render", "postprocess")
        # One soundtrack: this scene plays the part of it between its own start and end (Audio Player's Start / Stop in File).
        scene_start = sum(MUSIC_FRAMES[: (index or 1) - 1]) / FPS
        scene_end = sum(MUSIC_FRAMES[: (index or 1)]) / FPS
        self.add("music", "sound/player", filePath=ASSET + "music.m4a" if os.path.exists(os.path.join(ASSETS_DIR, "music.m4a")) else "",
                 loop=0, volume=1, playbackRate=1, startFrame=0, clipStart=round(scene_start, 4), clipEnd=round(scene_end, 4))
        # Time as the timeline's frame (not the wall clock), so Wiggle and Oscillator follow a scrub exactly as they follow
        # Play and an export. `stp` holds each value for two frames: motion on twos, the stop-motion boil of cut paper.
        self.add("t_frame", "time/frame")
        self.add("t_secs", "value/math", op="divide", a=0, b=FPS)
        self.add("t_steps", "math/expression", formula="floor(a / 2) / 12", a=0)
        self.wire("t_frame", "frame", "t_secs", "a")
        self.wire("t_frame", "frame", "t_steps", "a")
        if next_canvas:
            # Rising edge of (frame >= last frame) switches to the next canvas.
            self.add("g_frame", "time/frame")
            self.add("g_cmp", "logic/compare", op="greater_equal", a=0, b=self.frames - 1)
            self.add("g_go", "canvas/goto", canvas=next_canvas, trigger=0)
            self.wire("g_frame", "frame", "g_cmp", "a")
            self.wire("g_cmp", "out", "g_go", "trigger")

    # --- recipes: motion --------------------------------------------------------
    def _wm(self, matrix, target):
        """Wire a matrix source ("node", or "node:socket" for one whose Matrix output is not called `matrix`) into target."""
        node, _, sock = matrix.partition(":")
        self.wire(node, sock or "matrix", target, "matrix")

    @_builder
    def mul(self, key, a, b):
        """Matrix Math (multiply): two motions on one object, e.g. a slide and a wiggle. Returns "key:out"."""
        self.add(key, "matrix/math", op="multiply", factor=0.5)
        for src, sock in ((a, "a"), (b, "b")):
            node, _, out = src.partition(":")
            self.wire(node, out or "matrix", key, sock)
        return f"{key}:out"

    @_builder
    def reveal(self, src, t, pop=7, mode="both", over=1.2, lift=0.0, stagger=0.0, order="index", sock="geometry"):
        """An Appear node after `src`, shown from t[0] to t[1]: pops in (Overshoot, Lift, Stagger are the node's own),
        and is hidden again at t[1]. Progress is keyframed; the node does the easing. Returns the Appear node."""
        if t is None:
            return src
        t0, t1 = t
        ap = f"{src}_ap"
        self.add(ap, "modifier/appear", drive="progress", progress=1, mode=mode, overshoot=over, lift=lift, pivot="center",
                 stagger=stagger, order=order, seed=1, hideAtZero=1)
        self.wire(src, sock, ap, "geometry")
        keys = [(0, 0), (t0, 0, "hold")] if t0 > 0 else [(0, 0)]
        keys += [(t0 + pop, 1, "linear"), (t1, 0, "hold")]
        self.key(ap, "progress", keys)
        return ap

    def flicker(self, ap, frames):
        """Replaces an Appear's progress with explicit (frame, value) holds — a flash, a flicker."""
        self.key(ap, "progress", [(f, v, "hold") if n else (f, v) for n, (f, v) in enumerate(frames)])

    @_builder
    def wiggle(self, key, pos=(0.05, 0.04, 0.0), rot=1.2, speed=1.0, seed=1):
        """A Wiggle node on stepped time — its Matrix output goes into any object's Matrix input. Returns the key."""
        self.add(key, "animation/wiggle", speed=speed, amplitude=1, amplitudeVector=v3(*pos), rotationAmplitude=v3(0, 0, rot),
                 scaleAmplitude=v3(0, 0, 0), seed=seed, octaves=2)
        self.wire("t_steps", "value", key, "evolution")
        return key

    @_builder
    def mover(self, key, keys, rot=None):
        """A Compose Matrix whose Location is keyframed: wire its Matrix into everything that should travel together."""
        self.add(key, "transform", location=v3(), rotation=v3(0, 0, rot or 0), scale=v3(1, 1, 1))
        self.key(key, "location", keys)
        return key

    def slide(self, key, frm, t0, dur=9, ease="expo"):
        """A mover that brings things in from an offset (dx, dy) to where they are."""
        return self.mover(key, [(t0, v3(frm[0], frm[1], 0)), (t0 + dur, v3(0, 0, 0), ease)])

    @_builder
    def swing(self, key, px, py, amp, freq=0.8, phase=0.0):
        """A pendulum about the point (px, py): Oscillator → Compose Vector (Z) → Pivot Transform. Returns the Pivot node."""
        self.add(f"{key}_ph", "value/math", op="multiply", a=0, b=freq)
        self.add(f"{key}_pa", "value/math", op="add", a=0, b=phase)
        self.add(f"{key}_osc", "animation/oscillator", type="sine", frequency=1, phase=0, amplitude=amp, offset=0)
        self.add(f"{key}_vec", "vector/compose", x=0, y=0, z=0)
        self.add(key, "transform/pivot", pivot=v3(px, py, 0), location=v3(), rotation=v3(), scale=v3(1, 1, 1))
        self.wire("t_secs", "out", f"{key}_ph", "a")
        self.wire(f"{key}_ph", "out", f"{key}_pa", "a")
        self.wire(f"{key}_pa", "out", f"{key}_osc", "phase")
        self.wire(f"{key}_osc", "out", f"{key}_vec", "z")
        self.wire(f"{key}_vec", "out", key, "rotation")
        return key

    def spin(self, nid, t0, t1, a0, a1, ease="linear"):
        self.key(nid, "rotation", [(t0, v3(0, 0, a0)), (t1, v3(0, 0, a1), ease)])

    @_builder
    def group(self, key, members, matrix=None, sock="geometry"):
        """A Merge of `members` (node ids): the unit an Appear's Stagger spreads its pops across."""
        self.add(key, "structure/merge", visible=1, location=v3(), rotation=v3(), scale=v3(1, 1, 1))
        for i, m in enumerate(members):
            self.wire(m, sock, key, f"in{i}")
        if matrix:
            self._wm(matrix, key)
        return key

    # --- recipes: pictures ------------------------------------------------------
    TONES = {
        "ink":     dict(shadow=INK, high=CREAM, bal=0.12, soft=0.25),
        "inkwhite": dict(shadow=INK, high=WHITE, bal=0.12, soft=0.25),
        "gold":    dict(shadow=INK, high=MUSTARD, bal=0.08, soft=0.30),
        "jade":    dict(shadow=0x053A22, high=JADE, bal=0.05, soft=0.35),
        "crimson": dict(shadow=0x8E1230, high=0xF0224A, bal=0.0, soft=0.30),
        "teal":    dict(shadow=INK, high=TEAL, bal=0.10, soft=0.30),
        "silhouette": dict(shadow=INK, high=INK, bal=0.5, soft=0.1),
        "bluegold": dict(shadow=TEAL, high=MUSTARD, bal=0.22, soft=0.30),
    }

    @_builder
    def photo(self, key, file, x, y, h, z=0.5, tone="ink", sticker=CREAM, thick=8, halftone=3, rot=0.0, flip=False, mask=None,
              wfac=1.0, matrix=None, t=None, pop=7, extra=None, drift=0.0):
        """Image → Texture to Plane → Dual Tone → Halftone → Outline (→ Super 8) → Appear. Returns the last node."""
        tn = self.TONES[tone]
        asp = aspect(file)
        self.add(f"{key}_img", "texture/image", filePath=ASSET + file, wrapS="clamp", wrapT="clamp")
        self.add(key, "texture/plane", visible=1, location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(h * asp * wfac * (-1 if flip else 1), h, 1),
                 transparent=True, alphaCutoff=0.01, doubleSided=True, keepAspect=False, shadeless=1)
        self.wire(f"{key}_img", "texture", key, "texture")
        if mask:
            self.wire(mask, "mask", key, "mask")
        if matrix:
            self._wm(matrix, key)
        if drift and t:
            # a slow push-in over the shot
            self.key(key, "scale", [(t[0], v3(h * asp * wfac, h, 1)), (t[1], v3(h * asp * wfac * (1 + drift), h * (1 + drift), 1), "linear")])
        prev = key
        self.add(f"{key}_dt", "modifier/duotone", shadowColor=tn["shadow"], highlightColor=tn["high"], balance=tn["bal"], softness=tn["soft"], amount=1.0)
        self.wire(prev, "geometry", f"{key}_dt", "geometry"); prev = f"{key}_dt"
        if halftone:
            self.add(f"{key}_ht", "modifier/halftone", shape="dot", space="screen", radius=halftone, screenAngle=15, scatter=0, amount=1.0, greyscale=0)
            self.wire(prev, "geometry", f"{key}_ht", "geometry"); prev = f"{key}_ht"
        if sticker is not None:
            self.add(f"{key}_ol", "modifier/outline", edgeColor=sticker, edgeThickness=thick, sharpness=1, outlineSide="outside",
                     edgeStrength=1, alphaThreshold=0.1, silhouette=False, alphaEdge=True)
            self.wire(prev, "geometry", f"{key}_ol", "geometry"); prev = f"{key}_ol"
        if extra == "super8":
            self.add(f"{key}_s8", "modifier/super8", softness=0.6, flicker=0.18, weave=0.5, warmth=0.1, rate=12, seed=2)
            self.wire(prev, "geometry", f"{key}_s8", "geometry"); prev = f"{key}_s8"
        return self.reveal(prev, t, pop)

    @_builder
    def paper(self, key, color=None, dark=True, z=-5.0, x=0, y=0, w=W * 1.15, h=H * 1.25, rot=0.0, t=None):
        """Textured paper background tinted to `color` (Dual Tone: dark grain → shadow tone, light grain → colour)."""
        f = "21_paper_dark_grain.jpg" if dark else "20_paper_cream.jpg"
        self.add(f"{key}_img", "texture/image", filePath=ASSET + f, wrapS="clamp", wrapT="clamp")
        self.add(key, "texture/plane", visible=1, location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(w, h, 1),
                 transparent=False, alphaCutoff=0.0, doubleSided=True, keepAspect=False, shadeless=1)
        self.wire(f"{key}_img", "texture", key, "texture")
        last = key
        if color is not None:
            self.add(f"{key}_dt", "modifier/duotone", shadowColor=_mix(color, 0x000000, 0.35), highlightColor=color,
                     balance=0.5 if dark else 0.55, softness=0.9, amount=1.0)
            self.wire(key, "geometry", f"{key}_dt", "geometry"); last = f"{key}_dt"
        return self.reveal(last, t, pop=1, mode="pop", over=0.0)

    def roto(self, key, pts, ref=None, feather=0.0, asp=1.0):
        """Roto Mask with one polygon layer; pts are (u, v) in 0..1."""
        layer = {"id": f"{key}_l", "name": "Torn paper", "mode": "add", "opacity": 1.0, "invert": False, "feather": feather,
                 "expansion": 0.0, "visible": True,
                 "points": [{"x": u, "y": v, "ix": 0.0, "iy": 0.0, "ox": 0.0, "oy": 0.0} for u, v in pts]}
        self.add(key, "mask/roto", masks=[layer], activeLayer=0, resolution="1024", aspect=asp, showFull=False)
        if ref:
            self.wire(ref, "texture", key, "reference")
        return key

    # --- recipes: shapes and lines ---------------------------------------------
    @_builder
    def poly(self, key, pts, color, x=0, y=0, z=-1.0, rot=0.0, matrix=None, t=None, pop=7):
        """Curve from Points (closed, linear) → Curve Fill → Appear."""
        self.add(f"{key}_p", "curve/from_points", type="linear", closed=True, tension=0.5, sag=0,
                 pointsList=[v3(px, py, 0) for px, py in pts], location=v3(), rotation=v3(), scale=v3(1, 1, 1))
        self.add(key, "curve/fill", color=color, opacity=1, baseDrop=0, gradient=False, zOffset=0,
                 location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(1, 1, 1), shadeless=1)
        self.wire(f"{key}_p", "curve", key, "curve")
        if matrix:
            self._wm(matrix, key)
        return self.reveal(key, t, pop)

    def burst(self, key, x, y, r, color, z=-1.0, n=12, inner=0.45, jag=0.3, seed=1, rot=0.0, matrix=None, t=None, pop=7):
        """A jagged printed star."""
        rnd = random.Random(seed)
        pts = []
        for i in range(n * 2):
            a = i / (n * 2) * math.tau
            rr = (r if i % 2 == 0 else r * inner) * (1 - jag + jag * 2 * rnd.random())
            pts.append((math.cos(a) * rr, math.sin(a) * rr))
        return self.poly(key, pts, color, x, y, z, rot, matrix, t, pop)

    def star(self, key, x, y, r, color, z=3.0, points=4, inner=0.12, rot=0.0, matrix=None, t=None, pop=5):
        """A sparkle: a thin n-pointed star."""
        pts = []
        for i in range(points * 2):
            a = i / (points * 2) * math.tau + math.pi / 2
            rr = r if i % 2 == 0 else r * inner
            pts.append((math.cos(a) * rr, math.sin(a) * rr))
        return self.poly(key, pts, color, x, y, z, rot, matrix, t, pop)

    @_builder
    def text(self, key, s, x, y, units, color, z=3.0, rot=0.0, matrix=None, t=None, pop=6):
        CHARS.update(s)
        self.add(key, "object/text", text=s, fontPreset="Helvetiker", fontPath=FONT, fontSize=units / TEXT_UNIT, depth=0.01,
                 location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(1, 1, 1), color=color, shadeless=1)
        if matrix:
            self._wm(matrix, key)
        return self.reveal(key, t, pop)

    @_builder
    def line(self, key, pts, w, color, z=0.0, matrix=None, t=None, pop=4, x=0.0, y=0.0):
        """Curve from Points (open) → Curve to Line, drawn `w` world units wide."""
        self.add(f"{key}_p", "curve/from_points", type="linear", closed=False, tension=0.5, sag=0,
                 pointsList=[v3(px, py, 0) for px, py in pts], location=v3(), rotation=v3(), scale=v3(1, 1, 1))
        self.add(key, "curve/to_line", linewidth=w, worldUnits=True, color=color, shadeless=1, location=v3(x, y, z), rotation=v3(), scale=v3(1, 1, 1))
        self.wire(f"{key}_p", "curve", key, "curve")
        if matrix:
            self._wm(matrix, key)
        return self.reveal(key, t, pop)

    @_builder
    def rays(self, key, cx, cy, a0, spread, n, r0, r1, w, color, z=-1.0, t=None, pop=4):
        """One line, repeated around a point by Array (circular): a fan of speed lines from (cx, cy), starting at angle a0."""
        self.add(f"{key}_p", "curve/from_points", type="linear", closed=False, tension=0.5, sag=0,
                 pointsList=[v3(r0, 0, 0), v3(r1, 0, 0)], location=v3(), rotation=v3(), scale=v3(1, 1, 1))
        self.add(f"{key}_l", "curve/to_line", linewidth=w, worldUnits=True, color=color, shadeless=1, location=v3(), rotation=v3(), scale=v3(1, 1, 1))
        self.wire(f"{key}_p", "curve", f"{key}_l", "curve")
        self.add(f"{key}_pose", "transform", location=v3(cx, cy, z), rotation=v3(0, 0, a0), scale=v3(1, 1, 1))
        self.add(key, "structure/array", mode="circular", count=n, radius=0, plane="XY", totalAngle=spread, orient=True, visible=1)
        self.wire(f"{key}_l", "geometry", key, "geometry")
        self.wire(f"{key}_pose", "matrix", key, "matrix")
        return self.reveal(key, t, pop)

    @_builder
    def rings(self, key, cx, cy, r0, dr, n, w, color, z=-1.0, t=None, pop=6):
        """A circle, copied outward by Curve Array and drawn by Curves to Lines: concentric rings (a target)."""
        self.add(f"{key}_c", "curve/primitive", primitiveType="circle", radius=r0, location=v3(), scale=v3(1, 1, 1))
        self.add(f"{key}_a", "curve/array", count=n, spacing=dr, start=1, step=0)
        self.add(key, "curve/to_line_list", linewidth=w, worldUnits=True, color=color, shadeless=1,
                 location=v3(cx, cy, z), rotation=v3(-math.pi / 2, 0, 0), scale=v3(1, 1, 1))
        self.wire(f"{key}_c", "curve", f"{key}_a", "curve")
        self.wire(f"{key}_a", "curves", key, "curves")
        return self.reveal(key, t, pop)

    # --- recipes: drawn by hand (Grease Pencil) ---------------------------------
    def gp(self, key, frames, x=0.0, y=0.0, z=1.0, t=None, brush="marker_bold"):
        """A Grease Pencil node holding hand-drawn frames: [(frame, [stroke, ...])]. Shown from t[0] to t[1]."""
        fr = [{"frame": int(round(self.tw(f))), "strokes": strokes} for f, strokes in frames]
        self.add(key, "curve/grease-pencil", activeColor="#ffffff", brushSize=8, brushType=brush, smoothing=0.2, frames=fr,
                 visible=True, location=v3(x, y, z), rotation=v3(), scale=v3(1, 1, 1), onionSkin=False)
        if t is not None:
            self.key(key, "visible", [(0, 0), (t[0], 1, "hold"), (t[1], 0, "hold")] if t[0] > 0 else [(0, 1), (t[1], 0, "hold")])
        return key

    @staticmethod
    def stroke(pts, color, width=10, brush="marker_bold", taper=True):
        """One Grease Pencil stroke through (x, y) points; pressure swells in the middle and thins at both ends."""
        n = len(pts)
        out = []
        for i, (px, py) in enumerate(pts):
            u = i / max(1, n - 1)
            p = 0.25 + 0.75 * math.sin(math.pi * u) if taper else 0.8
            out.append({"x": px, "y": py, "z": 0.0, "pressure": round(p, 3)})
        return {"id": f"s{random.randint(0, 10**9)}", "points": out, "color": "#%06x" % color, "width": width, "brushType": brush, "fill": False}

    @classmethod
    def draw_on(cls, polylines, f0, f1, color, width=6, brush="ink_pen", steps=14):
        """Frames that draw `polylines` on, a little further each step — a hand-drawn reveal in one Grease Pencil node."""
        frames = []
        for k in range(1, steps + 1):
            p = k / steps
            strokes = []
            for pts in polylines:
                m = max(2, int(round(len(pts) * p)))
                cut = pts[:m]
                if m < len(pts) and len(pts) > 1:
                    frac = len(pts) * p - (m - 1)
                    (ax, ay), (bx, by) = pts[m - 1], pts[min(m, len(pts) - 1)]
                    cut = pts[:m - 1] + [(ax, ay), (ax + (bx - ax) * max(0.0, min(1.0, frac)), ay + (by - ay) * max(0.0, min(1.0, frac)))]
                strokes.append(cls.stroke(cut, color, width, brush, taper=False))
            frames.append((f0 + (f1 - f0) * (k - 1) / max(1, steps - 1), strokes))
        return frames


def _mix(a, b, t):
    ch = lambda sh: round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * t)
    return (ch(16) << 16) | (ch(8) << 8) | ch(0)


def write_project(name, canvases):
    canvases = list(canvases) + [Canvas(1) for _ in range(6 - len(canvases))]
    path = os.path.join(ROOT, "public/demos", f"demo_{name}.tsuji") if SERVED else os.path.join(ROOT, "motion_demo", f"{name}.tsuji")
    with open(path, "w") as f:
        json.dump({"canvases": [c.to_json() for c in canvases], "activeCanvas": 0}, f)
        f.write("\n")
    print(f"wrote {os.path.relpath(path, ROOT)} ({sum(len(c.nodes) for c in canvases)} nodes)")


def build_font():
    """Subset Noto Sans SC Black to exactly the characters printed (plus ASCII)."""
    import subprocess
    src = os.path.join(ROOT, "motion_demo/assets/fonts/NotoSansSC-Black.otf")
    out = os.path.join(ASSETS_DIR, "noto_sans_sc_black.json")
    subprocess.run(["node", os.path.join(ROOT, "scripts/convertFontSubset.mjs"), src, out, "".join(sorted(CHARS)), "Noto Sans SC Black"], check=True)
