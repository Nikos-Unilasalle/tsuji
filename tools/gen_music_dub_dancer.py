"""Writes public/demos/demo_music_dub_dancer.tsuji — step 7 of the music nodes: the music drives a whole scene.

The song is Tsuji Dub (tools/dub_song.py, imported as it is). On stage:

  - a dancer (rig/human → rig/biped-dance, the Sway groove) whose tempo is the Clock's: its BPM is wired from the
    Clock, and both count beats from the same playhead, so the body is on the beat by construction. Its energy
    swells with the drums (a Note Probe's envelope), and its choreography puts the poses on the song's moments:
    a wave with each dub siren, a cheer when the melodica comes in, the arms up through the drop;
  - three stage lights, red, gold and green, each struck by a part — the drums, the skank, the bass;
  - three orbs behind the dancer breathing with the same parts;
  - a camera circling the stage, a dark checker floor, bloom on the lights.

Everything is read from the sequences and the playhead, nothing is listened to: the picture is exactly in time with
the sound live, and in a video export (step 6) to the sample.

Run: python3 tools/gen_music_dub_dancer.py
"""
import json
import math
from pathlib import Path

import dub_song as song

OUT = Path(__file__).resolve().parent.parent / "public" / "demos" / "demo_music_dub_dancer.tsuji"
DANCE_DEMO = Path(__file__).resolve().parent.parent / "public" / "demos" / "demo_rig_biped_dance.tsuji"

V = lambda x, y, z: {"x": x, "y": y, "z": z}  # noqa: E731

nodes = []
links = []


def node(node_id, node_type, x, y, **params):
    nodes.append({"id": node_id, "type": node_type, "position": {"x": x, "y": y}, "params": params})


def wire(a, sa, b, sb):
    links.append((a, sa, b, sb))


# ── the band: Tsuji Dub's tracks as they are ──────────────────────────────
node("clock", "music/clock", 40, 460, bpm=song.BPM, swing=song.SWING, stepsPerBeat="4")
for i, (tid, steps, vtype, params) in enumerate(song.TRACKS):
    y = 40 + i * 150
    node(f"pat_{tid}", "music/pattern", 300, y, steps=steps, length=str(song.STEPS), name=tid)
    node(f"voice_{tid}", vtype, 600, y, **params)
    wire("clock", "clock", f"pat_{tid}", "clock")
    wire(f"pat_{tid}", "sequence", f"voice_{tid}", "sequence")
    wire(f"voice_{tid}", "track", "out", f"track{i}")
node("out", "music/out", 900, 460, **song.OUT_PARAMS)

# ── what the music says, as values ────────────────────────────────────────
for part, src, decay in (("drums", "pat_drums", 0.22), ("skank", "pat_skank", 0.16), ("bass", "pat_bass", 0.35)):
    node(f"probe_{part}", "music/note-probe", 1180, {"drums": 40, "skank": 200, "bass": 360}[part], decay=decay)
    wire(src, "sequence", f"probe_{part}", "music")

# ── the dancer, on the Clock's tempo ──────────────────────────────────────
dance = json.loads(DANCE_DEMO.read_text())["canvases"][0]
poses = {n["id"]: n for n in dance["nodes"] if n["type"] == "rig/biped-pose"}
node("human", "rig/human", 1180, 560)
for k, pid in enumerate(("cheer", "wave")):
    p = poses[pid]["params"]
    node(pid, "rig/biped-pose", 1440, 560 + k * 160, **p)
    wire("human", "geometry", pid, "skeleton")
# The song is 16 bars = 64 beats; the choreography loops with it.
BEAT = lambda bar: bar * 4  # noqa: E731  (bar counted from 0)
moves = [
    {"lane": 1, "start": BEAT(3) + 1, "length": 2, "mirror": False},   # the first siren: a wave
    {"lane": 1, "start": BEAT(7) + 2, "length": 2, "mirror": True},    # the siren rising, waving back
    {"lane": 0, "start": BEAT(8), "length": 3, "mirror": False},       # the melodica comes in: a cheer
    {"lane": 0, "start": BEAT(12), "length": 4, "mirror": True},       # the drop: arms up through it
    {"lane": 1, "start": BEAT(15) + 1, "length": 2, "mirror": False},  # the last siren
]
node("dance", "rig/biped-dance", 1700, 560, preset="sway", bpm=song.BPM, energy=0.9, groove=0.45, swing=song.SWING, loopBeats=song.BARS * 4, moves=moves)
wire("human", "geometry", "dance", "skeleton")
wire("cheer", "pose", "dance", "pose0")
wire("wave", "pose", "dance", "pose1")
wire("clock", "bpm", "dance", "bpm")
# Energy swells with the drums.
node("energy", "math/expression", 1440, 900, formula="0.75 + 0.45 * x")
wire("probe_drums", "envelope", "energy", "x")
wire("energy", "value", "dance", "energy")

# ── the stage lights: red, gold and green, struck by the drums, the skank, the bass ──
LIGHTS = [
    ("drums", 0xFF3B4E, V(-3.2, 3.4, 2.2)),
    ("skank", 0xFFC93C, V(0.0, 4.2, -3.0)),
    ("bass", 0x3DDC84, V(3.2, 3.4, 2.2)),
]
for k, (part, color, loc) in enumerate(LIGHTS):
    y = 1000 + k * 160
    node(f"lamp_{part}", "math/expression", 1700, y, formula="18 + 90 * x")
    node(f"light_{part}", "light/point", 1960, y, location=loc, rotation=V(0, 0, 0), scale=V(1, 1, 1), color=color, intensity=40, distance=16, decay=2, castShadow=1 if part == "skank" else 0)
    wire(f"probe_{part}", "envelope", f"lamp_{part}", "x")
    wire(f"lamp_{part}", "value", f"light_{part}", "intensity")

# ── three orbs behind the dancer, breathing with the same parts ──────────
ORBS = [("drums", 0xD7263D, 0x5B0A1A, -2.4), ("skank", 0xF4C430, 0x5C4206, 0.0), ("bass", 0x2E8B57, 0x08361F, 2.4)]
for k, (part, color, glow, x) in enumerate(ORBS):
    y = 1500 + k * 170
    node(f"breath_{part}", "math/expression", 1440, y, formula="0.35 + 0.35 * x")
    node(f"bvec_{part}", "converter/value-to-vector", 1700, y)
    node(f"bxf_{part}", "transform/matrix-transform", 1960, y, location=V(x, 2.2, -3.2))
    node(f"orb_{part}", "object/sphere", 2200, y, color=color, emissive=glow, emissiveIntensity=2.2)
    wire(f"probe_{part}", "envelope", f"breath_{part}", "x")
    wire(f"breath_{part}", "value", f"bvec_{part}", "value")
    wire(f"bvec_{part}", "vector", f"bxf_{part}", "scale")
    wire(f"bxf_{part}", "matrix", f"orb_{part}", "matrix")

# ── the floor, the camera, the look ───────────────────────────────────────
node("floor_tex", "texture/procedural", 1960, 1980, type="checker", colorA=0x141414, colorB=0x1D3B2A, scale=10, seed=1, octaves=3, resolution=256, uvScaleX=1, uvScaleY=1, uvOffsetX=0, uvOffsetY=0)
node("floor", "object/plane", 2200, 1980, visible=1, location=V(0, 0, 0), rotation=V(math.pi / 2, 0, 0), scale=V(24, 24, 1))
wire("floor_tex", "texture", "floor", "texture")
node("orbit", "transform/orbit", 1960, 2160, radius=6.2, speed=9, phase=20, height=1.9)
node("camera", "calibration/camera", 2200, 2160, location=V(0, 1.9, 6.2), rotation=V(0, 0, 0), useTarget=True, target=V(0, 1.05, 0), up=V(0, 1, 0), fov=42, active=True, mode="manual", projectionType="perspective")
wire("orbit", "position", "camera", "location")
node("env", "lighting/environment", 2200, 2340, color=0x0B0B12, intensity=1, background=1, ambientIntensity=0.18, sunIntensity=0.35)
node("bloom", "postprocess/bloom", 2200, 2480, strength=0.55, radius=0.5, threshold=0.55)
node("render", "render", 2460, 2340, frameCount=song.FRAMES, fps=30, motionBlur=0, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
wire("env", "environment", "render", "environment")
wire("bloom", "effect", "render", "postprocess")

project = {
    "canvases": [
        {
            "nodes": nodes,
            "connections": [{"id": f"c{i}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb} for i, (a, sa, b, sb) in enumerate(links)],
            "keyframes": {},
            "markers": [],
            "exposedParams": [],
        }
    ],
    "activeCanvas": 0,
}

OUT.write_text(json.dumps(project, indent=2) + "\n")
print(f"wrote {OUT} ({len(nodes)} nodes, {song.FRAMES} frames)")
