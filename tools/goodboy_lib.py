"""Helpers for gen_goodboy_demo.py — a thin builder over the .tsuji JSON (see gen_joint_demos.py).

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
          "texture/procedural": 240, "lighting/environment": 220, "calibration/camera": 200, "transform": 150}
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
        if next_canvas:
            # Rising edge of (frame >= last frame) switches to the next canvas.
            self.add("g_frame", "time/frame")
            self.add("g_cmp", "logic/compare", op="greater_equal", a=0, b=self.frames - 1)
            self.add("g_go", "canvas/goto", canvas=next_canvas, trigger=0)
            self.wire("g_frame", "frame", "g_cmp", "a")
            self.wire("g_cmp", "out", "g_go", "trigger")

    # --- elements ----------------------------------------------------------------
    def appear(self, nid, base, t0, t1, pop=7, drift=0.0, zero=None):
        """Scale track: hidden before t0 and after t1, pops in with overshoot, optional slow push-in until t1."""
        z = zero or v3(0, 0, 0)
        sx, sy, sz = base
        keys = []
        if t0 > 0:
            keys.append((0, z))
        keys.append((t0, z, "hold"))
        keys.append((t0 + pop, v3(sx, sy, sz), "back"))
        if drift:
            keys.append((t1 - 1, v3(sx * (1 + drift), sy * (1 + drift), sz), "linear"))
        else:
            keys.append((t1 - 1, v3(sx, sy, sz), "hold"))
        keys.append((t1, z, "hold"))
        self.key(nid, "scale", keys)

    def move(self, nid, frm, to, t0, dur=10, ease="expo"):
        self.key(nid, "location", [(t0, v3(*frm), "hold"), (t0 + dur, v3(*to), ease)])

    def spin(self, nid, t0, t1, a0, a1, ease="linear"):
        self.key(nid, "rotation", [(t0, v3(0, 0, a0)), (t1, v3(0, 0, a1), ease)])

    def sway(self, nid, t0, t1, amp, period, phase=0.0, base=0.0):
        keys, t, i = [], t0, 0
        while t <= t1:
            keys.append((t, v3(0, 0, base + amp * (1 if (i + phase) % 2 == 0 else -1)), "smooth"))
            t += period / 2; i += 1
        self.key(nid, "rotation", keys)

    # --- builders ----------------------------------------------------------------
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
    def photo(self, key, file, x, y, h, z=0.5, tone="ink", sticker=CREAM, thick=8, halftone=3, rot=0.0, flip=False, mask=None, wfac=1.0):
        """Photo → Plane → Dual Tone → Halftone → Outline. Returns (plane id, final geometry id)."""
        t = self.TONES[tone]
        asp = aspect(file)
        self.add(f"{key}_img", "texture/image", 0, 0, filePath=ASSET + file, wrapS="clamp", wrapT="clamp")
        self.add(key, "texture/plane", 0, 0, visible=1, location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(h * asp * wfac * (-1 if flip else 1), h, 1),
                 transparent=True, alphaCutoff=0.01, doubleSided=True, keepAspect=False, shadeless=1)
        self.wire(f"{key}_img", "texture", key, "texture")
        if mask:
            self.wire(mask, "mask", key, "mask")
        prev = key
        self.add(f"{key}_dt", "modifier/duotone", 0, 0, shadowColor=t["shadow"], highlightColor=t["high"], balance=t["bal"], softness=t["soft"], amount=1.0)
        self.wire(prev, "geometry", f"{key}_dt", "geometry"); prev = f"{key}_dt"
        if halftone:
            self.add(f"{key}_ht", "modifier/halftone", 0, 0, shape="dot", space="screen", radius=halftone, screenAngle=15, scatter=0, amount=1.0, greyscale=0)
            self.wire(prev, "geometry", f"{key}_ht", "geometry"); prev = f"{key}_ht"
        if sticker is not None:
            self.add(f"{key}_ol", "modifier/outline", 0, 0, edgeColor=sticker, edgeThickness=thick, sharpness=1, outlineSide="outside",
                     edgeStrength=1, alphaThreshold=0.1, silhouette=False, alphaEdge=True)
            self.wire(prev, "geometry", f"{key}_ol", "geometry"); prev = f"{key}_ol"
        self.put(prev)
        return key

    @_builder
    def burst(self, key, x, y, r, color, z=-1.0, n=12, inner=0.45, jag=0.3, seed=1, rot=0.0):
        """A jagged printed-star burst: closed polyline filled flat."""
        rnd = random.Random(seed)
        pts = []
        for i in range(n * 2):
            a = i / (n * 2) * math.tau
            base = r if i % 2 == 0 else r * inner
            rr = base * (1 - jag + jag * 2 * rnd.random())
            pts.append(v3(math.cos(a) * rr, math.sin(a) * rr, 0))
        self.add(f"{key}_p", "curve/from_points", 0, 0, type="linear", closed=True, tension=0.5, sag=0, pointsList=pts,
                 location=v3(), rotation=v3(), scale=v3(1, 1, 1))
        self.add(key, "curve/fill", 0, 0, color=color, opacity=1, baseDrop=0, gradient=False, zOffset=0,
                 location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(1, 1, 1), shadeless=1)
        self.wire(f"{key}_p", "curve", key, "curve")
        self.put(key)
        return key

    @_builder
    def poly(self, key, pts, color, x=0, y=0, z=-1.0, rot=0.0):
        """Any closed flat polygon from (x, y) points."""
        self.add(f"{key}_p", "curve/from_points", 0, 0, type="linear", closed=True, tension=0.5, sag=0,
                 pointsList=[v3(px, py, 0) for px, py in pts], location=v3(), rotation=v3(), scale=v3(1, 1, 1))
        self.add(key, "curve/fill", 0, 0, color=color, opacity=1, baseDrop=0, gradient=False, zOffset=0,
                 location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(1, 1, 1), shadeless=1)
        self.wire(f"{key}_p", "curve", key, "curve")
        self.put(key)
        return key

    @_builder
    def star(self, key, x, y, r, color, z=3.0, points=4, inner=0.12, rot=0.0):
        """Sparkle: a thin n-pointed star."""
        pts = []
        for i in range(points * 2):
            a = i / (points * 2) * math.tau + math.pi / 2
            rr = r if i % 2 == 0 else r * inner
            pts.append((math.cos(a) * rr, math.sin(a) * rr))
        return self.poly(key, pts, color, x, y, z, rot)

    @_builder
    def text(self, key, s, x, y, units, color, z=3.0, rot=0.0):
        CHARS.update(s)
        self.add(key, "object/text", 0, 0, text=s, fontPreset="Helvetiker", fontPath=FONT, fontSize=units / TEXT_UNIT, depth=0.01,
                 location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(1, 1, 1), color=color, shadeless=1)
        self.put(key)
        return key

    @_builder
    def line(self, key, x0, y0, x1, y1, w, color, z=-0.5, taper=True):
        """A speed line: a thin flat quad/triangle from (x0, y0) to (x1, y1)."""
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / L * w / 2, dx / L * w / 2
        pts = [(x0 + nx, y0 + ny), (x1, y1), (x0 - nx, y0 - ny)] if taper else [(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)]
        return self.poly(key, pts, color, 0, 0, z)

    @_builder
    def bar(self, key, x, y, length, w, color, rot=0.0, z=0.0):
        """A flat coloured rectangle (a plane without a texture): moves reliably, unlike a Curve Fill."""
        self.add(key, "texture/plane", 0, 0, visible=1, location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(length, w, 1),
                 transparent=False, alphaCutoff=0.0, doubleSided=True, keepAspect=False, shadeless=1, color=color)
        self.put(key)
        return key

    @_builder
    def roto(self, key, pts, ref=None, feather=0.0, asp=1.0):
        """Roto Mask with one polygon layer; pts are (u, v) in 0..1."""
        layer = {"id": f"{key}_l", "name": "Torn paper", "mode": "add", "opacity": 1.0, "invert": False, "feather": feather,
                 "expansion": 0.0, "visible": True,
                 "points": [{"x": u, "y": v, "ix": 0.0, "iy": 0.0, "ox": 0.0, "oy": 0.0} for u, v in pts]}
        self.add(key, "mask/roto", 0, 0, masks=[layer], activeLayer=0, resolution="1024", aspect=asp, showFull=False)
        if ref:
            self.wire(ref, "texture", key, "reference")
        return key

    @_builder
    def paper(self, key, color=None, dark=True, z=-5.0, x=0, y=0, w=W * 1.15, h=H * 1.25, rot=0.0):
        """Textured paper background tinted to `color`."""
        f = "21_paper_dark_grain.jpg" if dark else "20_paper_cream.jpg"
        self.add(f"{key}_img", "texture/image", 0, 0, filePath=ASSET + f, wrapS="clamp", wrapT="clamp")
        self.add(key, "texture/plane", 0, 0, visible=1, location=v3(x, y, z), rotation=v3(0, 0, rot), scale=v3(w, h, 1),
                 transparent=False, alphaCutoff=0.0, doubleSided=True, keepAspect=False, shadeless=1)
        self.wire(f"{key}_img", "texture", key, "texture")
        last = key
        if color is not None:
            # Same flat-colour paper the reference prints on: dark grain → shadow tone, light grain → colour.
            self.add(f"{key}_dt", "modifier/duotone", 0, 0, shadowColor=_mix(color, 0x000000, 0.35), highlightColor=color,
                     balance=0.5 if dark else 0.55, softness=0.9, amount=1.0)
            self.wire(key, "geometry", f"{key}_dt", "geometry"); last = f"{key}_dt"
        self.put(last)
        return key


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
