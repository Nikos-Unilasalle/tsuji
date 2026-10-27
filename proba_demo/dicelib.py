"""Building blocks for the dice → bell curve demo (one canvas at a time)."""
import math


def V(x=0, y=0, z=0):
    return {"x": x, "y": y, "z": z}


def hexcolor(c):
    return c


class Canvas:
    """Collects nodes and wires; lays nodes out on the editor grid in columns."""

    def __init__(self):
        self.nodes, self.conns = [], []
        self.col, self.row = 0, 0

    # --- raw ------------------------------------------------------------------
    def node(self, nid, ntype, **params):
        gx, gy = -2400 + self.col * 260, -600 + self.row * 150
        self.row += 1
        if self.row > 14:
            self.row, self.col = 0, self.col + 1
        self.nodes.append({"id": nid, "type": ntype, "position": {"x": gx, "y": gy}, "params": params})
        return nid

    def section(self):
        """Starts a new editor column, so each part of the graph sits in its own band."""
        if self.row:
            self.row, self.col = 0, self.col + 1

    def wire(self, a, sa, b, sb):
        self.conns.append({"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb})

    def expr(self, nid, formula, **inputs):
        """An Expression; keyword args are either numbers (panel values) or (node, socket) wires."""
        params = dict(formula=formula, a=0, b=0, c=0, d=0, x=0, y=0, z=0)
        wires = {}
        for k, v in inputs.items():
            if isinstance(v, tuple):
                wires[k] = v
            else:
                params[k] = v
        self.node(nid, "math/expression", **params)
        for k, (src, sock) in wires.items():
            self.wire(src, sock, nid, k)
        return nid

    def set_end(self, seconds):
        """Length of the scene once it is known: the render's frame count and the fade to black."""
        for n in self.nodes:
            if n["id"] == "render":
                n["params"]["frameCount"] = int(round(seconds * 30))
            if n["id"] == "fade":
                n["params"]["a"] = seconds

    def out(self):
        return {"nodes": self.nodes, "connections": self.conns, "keyframes": {}, "markers": [], "exposedParams": []}

    # --- scene setting ----------------------------------------------------------
    def setting(self, seconds, cam_loc, cam_target, fov=30, cam_drift=None, bloom=0.4):
        """Night-blue backdrop, render settings, a perspective camera (optionally drifting), two lights, bloom."""
        self.section()
        self.node("env", "lighting/environment", color=0x0B1220, intensity=1, background=1, blurriness=0,
                  filePath="", backgroundImagePath="", backgroundFit="cover", backgroundScale=V(1, 1, 1),
                  backgroundOffset=V(), backgroundRotation=0, ambientIntensity=0.35, sunIntensity=0)
        self.node("render", "render", frameCount=int(round(seconds * 30)), fps=30, motionBlur=0,
                  resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
        self.wire("env", "environment", "render", "environment")
        # The floor fades into the night before its far edge shows.
        self.node("fog", "postprocess/fog", color=0x0B1220, mode="linear", density=0.02, near=16, far=34)
        self.node("bloom", "postprocess/bloom", strength=bloom, radius=0.45, threshold=0.95)
        self.wire("fog", "effect", "bloom", "effect")
        self.node("vignette", "postprocess/vignette", offset=1.0, darkness=1.15)
        self.wire("bloom", "effect", "vignette", "effect")
        self.wire("vignette", "effect", "render", "postprocess")
        self.node("cam", "calibration/camera", location=V(*cam_loc), rotation=V(), useTarget=True,
                  target=V(*cam_target), up=V(0, 1, 0), fov=fov, active=True, mode="manual",
                  projectionType="perspective")
        if cam_drift:
            # A slow push-in: the camera glides from cam_loc by cam_drift over the scene.
            dx, dy, dz = cam_drift
            q = f"(clamp(t/{seconds}, 0, 1)^2·(3 − 2 clamp(t/{seconds}, 0, 1)))"
            self.expr("camPath", f"(a + {dx}·{q}, b + {dy}·{q}, c + {dz}·{q})", a=cam_loc[0], b=cam_loc[1], c=cam_loc[2])
            self.wire("camPath", "vector", "cam", "location")
        # Fade from and to black: a black curtain just in front of the lens, facing it.
        fx, fy, fz = (cam_target[i] - cam_loc[i] for i in range(3))
        norm = math.sqrt(fx * fx + fy * fy + fz * fz)
        fx, fy, fz = fx / norm, fy / norm, fz / norm
        lens = "camPath" if cam_drift else None
        if lens:
            dx, dy, dz = cam_drift
            q = f"(clamp(t/{seconds}, 0, 1)^2·(3 − 2 clamp(t/{seconds}, 0, 1)))"
            self.expr("curtainAt", f"(a + {dx}·{q} + {0.5 * fx:.4f}, b + {dy}·{q} + {0.5 * fy:.4f}, "
                                   f"c + {dz}·{q} + {0.5 * fz:.4f})", a=cam_loc[0], b=cam_loc[1], c=cam_loc[2])
        self.expr("fade", "1 − clamp(t/0.7, 0, 1)·clamp((a − t)/0.6, 0, 1)", a=seconds)
        self.expr("fadeShown", "x > 0.004", x=("fade", "value"))
        self.node("curtainMat", "material/standard", color=0x000000, emissive=0, emissiveIntensity=0, shadeless=1,
                  roughness=1, metalness=0, wireframe=0, opacity=1, transmission=0, thickness=0)
        self.wire("fade", "value", "curtainMat", "opacity")
        self.node("curtainSheet", "object/plane", visible=1, location=V(), rotation=V(), scale=V(4, 4, 1), color=0)
        self.wire("curtainMat", "material", "curtainSheet", "material")
        self.expr("curtainTilt", f"({math.degrees(math.asin(fy)):.3f}, 0, 0)")
        if not lens:
            self.expr("curtainAt", f"({cam_loc[0] + 0.5 * fx:.4f}, {cam_loc[1] + 0.5 * fy:.4f}, {cam_loc[2] + 0.5 * fz:.4f})")
        self.node("curtain", "structure/instance-on-points", visible=1, scaleMin=1, scaleMax=1, rotationJitter=0,
                  axis="Y", randomFlip=False, seed=0)
        self.wire("curtainSheet", "geometry", "curtain", "geometry")
        self.wire("curtainAt", "list", "curtain", "points")
        self.wire("curtainTilt", "list", "curtain", "rotations")
        self.wire("fadeShown", "value", "curtain", "visible")
        self.node("key", "light/point", location=V(-5, 9, 7), rotation=V(), scale=V(1, 1, 1),
                  color=0xFFE7C2, intensity=85, distance=40, decay=1.4, castShadow=1)
        self.node("rim", "light/point", location=V(2, 8, -12), rotation=V(), scale=V(1, 1, 1),
                  color=0x7DD3FC, intensity=30, distance=40, decay=1.4, castShadow=0)
        self.node("floor", "object/plane", visible=1, location=V(0, 0, 0), rotation=V(-math.pi / 2, 0, 0),
                  scale=V(60, 60, 1), color=0x0F172A, emissive=0, emissiveIntensity=1, shadeless=0,
                  roughness=0.8, metalness=0.05, wireframe=0, opacity=1, transmission=0, thickness=0.5)

    # --- text -----------------------------------------------------------------
    def text(self, nid, at, txt, height, color=0xF1F5F9, show=None, hide=None, wire_text=None,
             emissive=0.0, font="Poppins"):
        """Flat text of the given letter height, centred on `at`; fades in at `show` and out at `hide` (seconds)."""
        self.node(nid, "object/text", visible=1, location=V(*at), rotation=V(), scale=V(1, 1, 1),
                  text=txt, fontPreset=font, fontSize=round(height / 0.015, 2), depth=0.001, faceCamera=False,
                  color=color, shadeless=1)
        if show is not None or hide is not None:
            a = show if show is not None else -1
            b = hide if hide is not None else 1e6
            self.expr(f"{nid}Fade", "clamp((t − a)/0.6, 0, 1)·clamp((b − t)/0.6, 0, 1)", a=a, b=b)
            self.node(f"{nid}Mat", "material/standard", color=color, emissive=color if emissive else 0,
                      emissiveIntensity=emissive, shadeless=1, roughness=1, metalness=0, wireframe=0,
                      opacity=1, transmission=0, thickness=0)
            self.wire(f"{nid}Fade", "value", f"{nid}Mat", "opacity")
            self.wire(f"{nid}Mat", "material", nid, "material")
            # Fully faded text is hidden too, so it never catches the bloom.
            self.wire(f"{nid}Fade", "value", nid, "visible")
        if wire_text:
            self.wire(wire_text[0], wire_text[1], nid, "text")
        return nid

    # --- the die ----------------------------------------------------------------
    def die_asset(self, p="die"):
        """A rounded white die with dark pips, 1 unit across, face 1 up, 2 on +X, 3 on +Z (opposites sum to 7)."""
        self.section()
        self.node(f"{p}Cube", "object/box", visible=1, location=V(), rotation=V(), scale=V(1, 1, 1),
                  color=0xF8FAFC, emissive=0, emissiveIntensity=1, shadeless=0, roughness=0.28, metalness=0.0,
                  wireframe=0, opacity=1, transmission=0, thickness=0.5)
        self.node(f"{p}Ball", "object/sphere", visible=1, location=V(), rotation=V(), scale=V(1.36, 1.36, 1.36),
                  color=0xF8FAFC, emissive=0, emissiveIntensity=1, shadeless=0, roughness=0.28, metalness=0.0,
                  wireframe=0, opacity=1, transmission=0, thickness=0.5)
        self.node(f"{p}Body", "modifier/boolean", operation="intersect")
        self.wire(f"{p}Cube", "geometry", f"{p}Body", "geometry")
        self.wire(f"{p}Ball", "geometry", f"{p}Body", "boolean")
        # 21 pips: index → face → spot on the face. Faces start at pip 0, 1, 3, 6, 10, 15.
        g, h = 0.25, 0.47
        face = "(x < 1 ? 1 : x < 3 ? 2 : x < 6 ? 3 : x < 10 ? 4 : x < 15 ? 5 : 6)"
        j = f"(x − (x < 1 ? 0 : x < 3 ? 1 : x < 6 ? 3 : x < 10 ? 6 : x < 15 ? 10 : 15))"
        px = (f"(x < 1 ? 0 : x < 3 ? {h} : x < 6 ? ({j} − 1)·{g} : x < 10 ? (2 mod({j}, 2) − 1)·{g} : "
              f"x < 15 ? −{h} : (2 mod({j}, 2) − 1)·{g})")
        py = (f"(x < 1 ? {h} : x < 3 ? (2 {j} − 1)·{g} : x < 6 ? ({j} − 1)·{g} : x < 10 ? (2 floor({j}/2) − 1)·{g} : "
              f"x < 15 ? ({j} < 4 ? (2 mod({j}, 2) − 1)·{g} : 0) : −{h})")
        pz = (f"(x < 1 ? 0 : x < 3 ? (2 {j} − 1)·{g} : x < 6 ? {h} : x < 10 ? −{h} : "
              f"x < 15 ? ({j} < 4 ? (2 floor({j}/2) − 1)·{g} : 0) : (floor({j}/2) − 1)·{g})")
        self.node(f"{p}PipIndex", "list/generate", count=21, start=0, step=1)
        self.expr(f"{p}PipSpots", f"({px}, {py}, {pz})", x=(f"{p}PipIndex", "list"))
        self.node(f"{p}Pip", "object/sphere", visible=1, location=V(), rotation=V(), scale=V(0.17, 0.17, 0.17),
                  color=0x111827, emissive=0, emissiveIntensity=1, shadeless=0, roughness=0.5, metalness=0.0,
                  wireframe=0, opacity=1, transmission=0, thickness=0.5)
        self.node(f"{p}Pips", "structure/instance-on-points", visible=1, scaleMin=1, scaleMax=1, rotationJitter=0,
                  axis="Y", randomFlip=False, seed=0)
        self.wire(f"{p}Pip", "geometry", f"{p}Pips", "geometry")
        self.wire(f"{p}PipSpots", "list", f"{p}Pips", "points")
        self.node(f"{p}Asset", "structure/merge")
        self.wire(f"{p}Body", "geometry", f"{p}Asset", "in0")
        self.wire(f"{p}Pips", "geometry", f"{p}Asset", "in1")
        return f"{p}Asset"


def rest_rotation(v, w):
    """Euler XYZ (degrees) that puts face `v` up with a yaw of `w` about the vertical (expression text)."""
    return (f"({v} == 6 ? 180 : {v} == 3 ? −90 : {v} == 4 ? 90 : 0)",
            f"(({v} == 3 || {v} == 4) ? 0 : {w})",
            f"({v} == 2 ? 90 : {v} == 5 ? −90 : ({v} == 3 || {v} == 4) ? {w} : 0)")


def ramp(*colors):
    """A colour ramp param through the given colours, evenly spaced."""
    n = len(colors) - 1
    return {"stops": [{"position": i / n, "color": c} for i, c in enumerate(colors)], "interpolation": "linear"}


def roll_engine(c, p, n_dice, start, slow, n_slow, fast, n_max, seed0):
    """Throws of `n_dice` dice: slow ones, then a montage up to `n_max`.

    φ counts throws: throw k is in the air for φ ∈ [k, k + 0.7) and lands at k + 0.7. Returns the
    node ids: thrown/landed/u/calm (values), now{i} (Get List Item: die i's current face, socket
    "val") and sums (Slice: the sum of every landed throw, socket "list").
    """
    c.section()
    t_fast = start + slow * n_slow
    c.expr(f"{p}Phase", f"min({n_max} − 0.001, t < a ? max(0, (t − c)/b) : {n_slow} + {n_max - n_slow}·min(1, (t − a)/d)^2.5)",
           a=t_fast, b=slow, c=start, d=fast)
    c.expr(f"{p}Thrown", f"min({n_max - 1}, floor(x))", x=(f"{p}Phase", "value"))
    c.expr(f"{p}Landed", f"min({n_max}, floor(x + 0.3))", x=(f"{p}Phase", "value"))
    c.expr(f"{p}U", "t < a ? 0.99 : x − floor(x)", x=(f"{p}Phase", "value"), a=start)
    c.expr(f"{p}Calm", "t < a ? 1 : max(0.12, 1 − (t − a)/1.2)", a=t_fast)
    c.expr(f"{p}DrawCount", "x + 1", x=(f"{p}Thrown", "value"))
    for i in range(n_dice):
        c.node(f"{p}Draw{i}", "list/random-list", count=1, algorithm="uniform", seed=seed0 + 7 * i, min=0, max=1)
        c.wire(f"{p}DrawCount", "value", f"{p}Draw{i}", "count")
        c.expr(f"{p}Faces{i}", "floor(6 x) + 1", x=(f"{p}Draw{i}", "list"))
        c.node(f"{p}Now{i}", "list/get-item", index=0)
        c.wire(f"{p}Faces{i}", "list", f"{p}Now{i}", "list")
        c.wire(f"{p}Thrown", "value", f"{p}Now{i}", "index")
    total = f"{p}Faces0"
    for i in range(1, n_dice):
        c.node(f"{p}Total{i}", "list/combine-math", op="add")
        c.wire(total, "list", f"{p}Total{i}", "a")
        c.wire(f"{p}Faces{i}", "list", f"{p}Total{i}", "b")
        total = f"{p}Total{i}"
    c.node(f"{p}Sums", "list/slice", start=0, count=0)
    c.wire(total, "list", f"{p}Sums", "list")
    c.wire(f"{p}Landed", "value", f"{p}Sums", "count")
    return t_fast


def place_dice(c, p, asset, spots, size=1.0):
    """One instanced die per (x, z) spot, tumbling with the engine `p` and resting on its drawn face."""
    c.section()
    q = f"min(x/0.7, 1)"
    for i, (x0, z0) in enumerate(spots):
        sway = 1 + 0.18 * ((i * 5) % 3)
        c.expr(f"{p}DiePos{i}",
               f"(a − {1.5 * size * sway:.3f} (1 − {q})·y, {0.5 * size} + {2.6 * size:.3f} (1 − {q})²·|cos(2.5π {q})|·y, "
               f"b + {0.35 * size * (1 if i % 2 else -1):.3f} (1 − {q})·y)",
               a=x0, b=z0, x=(f"{p}U", "value"), y=(f"{p}Calm", "value"))
        rx, ry, rz = rest_rotation("z", f"28 sin(12.9 c + {3.1 * i:.1f})")
        spin = f"(1 − {q})^3·y"
        k = (1, -1)[i % 2]
        c.expr(f"{p}DieRot{i}",
               f"({rx} + {640 * k} {spin}, {ry} + {420 + 40 * i} {spin}, {rz} + {530 * k} {spin})",
               x=(f"{p}U", "value"), y=(f"{p}Calm", "value"), z=(f"{p}Now{i}", "val"), c=(f"{p}Thrown", "value"))
        c.node(f"{p}Die{i}", "structure/instance-on-points", visible=1, scaleMin=size, scaleMax=size,
               rotationJitter=0, axis="Y", randomFlip=False, seed=0)
        c.wire(asset, "geometry", f"{p}Die{i}", "geometry")
        c.wire(f"{p}DiePos{i}", "list", f"{p}Die{i}", "points")
        c.wire(f"{p}DieRot{i}", "list", f"{p}Die{i}", "rotations")


def exact_pmf(k, s="x"):
    """Expression text for P(S = s) with S the sum of k fair dice, s an expression (inclusion–exclusion)."""
    terms = []
    for j in range(0, k + 1):
        n = f"({s} − {6 * j} − 1)"
        # C(n, k−1) = n! / ((k−1)! (n−k+1)!), only when s − 6j ≥ k; guarded so fact() never sees a negative.
        guard = f"({s} − {6 * j} >= {k})"
        safe = f"max({n}, {k - 1})"
        comb = f"fact({safe})/(fact({k - 1})·fact({safe} − {k - 1}))"
        coef = math.comb(k, j) * (-1) ** j
        terms.append(f"{coef}·{guard}·{comb}")
    return f"(({' + '.join(terms)}) / {6 ** k})"
