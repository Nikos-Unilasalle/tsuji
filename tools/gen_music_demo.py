"""Writes public/demos/demo_music_band.tsuji: a whole band built from music nodes only.

Clock (120 BPM, a touch of swing) drives three patterns of 64 steps — four bars of sixteenths, 8 s, the 240 frames of
the timeline at 30 fps, so the song and the timeline loop together:

  chords  Cmaj7 – Am7 – Fmaj7 – G7, arpeggiated up and down over two octaves on the electric piano
  bass    the roots, gliding into each bar, with a ratchet before the turnaround
  drums   kick on the beats, snare on 2 and 4, hats in between, a clap fill at the end

A Note Probe reads the arpeggio and makes a sphere pulse with each note: its envelope, through an expression, scales
the sphere — the sound and the picture come from the same sequence, so they cannot drift apart.

Run: python3 tools/gen_music_demo.py
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "demos" / "demo_music_band.tsuji"


def bars(*cells: dict[int, str], length: int = 64) -> str:
    """{step: word} → one word per step, '.' for the empty ones."""
    words = ["."] * length
    for c in cells:
        for i, w in c.items():
            words[i] = w
    return " ".join(words)


chords = bars({0: "C4:maj7", 16: "A3:min7/1", 32: "F3:maj7/1", 48: "G3:7"})
bass = bars(
    {
        0: "C2@1", 10: "G2@0.6",
        16: "A1!GLD12", 26: "E2@0.6",
        32: "F1!GLD12", 42: "C2@0.6",
        48: "G1!GLD12", 60: "G1!RTG3", 63: "off",
    }
)
drums = {}
for bar in range(4):
    b = bar * 16
    for s in range(0, 16, 2):
        drums[b + s] = "hat@0.5"
    for s in (0, 4, 8, 12):
        drums[b + s] = "kick+hat@0.9" if s in (0, 8) else "snare+hat"
drums[3 * 16 + 14] = "clap"
drums[3 * 16 + 15] = "clap@0.7"
drums = bars(drums)

nodes = [
    {"id": "clock", "type": "music/clock", "position": {"x": 40, "y": 220}, "params": {"bpm": 120, "swing": 0.15, "stepsPerBeat": "4"}},
    {"id": "pat_chords", "type": "music/pattern", "position": {"x": 300, "y": 40}, "params": {"steps": chords, "length": "64"}},
    {"id": "arp", "type": "music/arp", "position": {"x": 560, "y": 40}, "params": {"on": True, "mode": "updown", "rate": "1/16", "octaves": 2, "gate": 0.6, "sync": "grid"}},
    {"id": "voice_keys", "type": "music/fm-voice", "position": {"x": 820, "y": 40}, "params": {"preset": "E. Piano", "level": 0.7, "pan": -0.3}},
    {"id": "pat_bass", "type": "music/pattern", "position": {"x": 300, "y": 260}, "params": {"steps": bass, "length": "64"}},
    {"id": "voice_bass", "type": "music/fm-voice", "position": {"x": 820, "y": 260}, "params": {"preset": "Bass", "level": 0.9, "pan": 0.1}},
    {"id": "pat_drums", "type": "music/pattern", "position": {"x": 300, "y": 480}, "params": {"steps": drums, "length": "64"}},
    {"id": "drums", "type": "music/drum-kit", "position": {"x": 820, "y": 480}, "params": {"level": 0.8}},
    {"id": "out", "type": "music/out", "position": {"x": 1100, "y": 240}, "params": {"master": 0.8, "startFrame": 0}},
    {"id": "probe", "type": "music/note-probe", "position": {"x": 1100, "y": 20}, "params": {"decay": 0.2}},
    {"id": "pulse", "type": "math/expression", "position": {"x": 1360, "y": 20}, "params": {"formula": "0.6 + 0.9 * x"}},
    {"id": "to_vec", "type": "converter/value-to-vector", "position": {"x": 1600, "y": 20}, "params": {}},
    {"id": "xform", "type": "transform/matrix-transform", "position": {"x": 1820, "y": 20}, "params": {}},
    {"id": "sphere", "type": "object/sphere", "position": {"x": 2060, "y": 20}, "params": {"color": 0xD946EF, "emissive": 0x3B0764, "emissiveIntensity": 1.0}},
    {"id": "env", "type": "lighting/environment", "position": {"x": 2060, "y": 300}, "params": {"color": 4147542, "intensity": 1, "background": 1, "ambientIntensity": 0.6, "sunIntensity": 1.2}},
    {"id": "render", "type": "render", "position": {"x": 1100, "y": 520}, "params": {"frameCount": 240, "fps": 30, "motionBlur": 0, "resolutionPreset": "16:9 (1920x1080)", "width": 1920, "height": 1080, "holdout": False}},
]


def wire(i: int, a: str, sa: str, b: str, sb: str) -> dict:
    return {"id": f"c{i}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb}


links = [
    ("clock", "clock", "pat_chords", "clock"),
    ("clock", "clock", "pat_bass", "clock"),
    ("clock", "clock", "pat_drums", "clock"),
    ("pat_chords", "sequence", "arp", "sequence"),
    ("arp", "sequence", "voice_keys", "sequence"),
    ("pat_bass", "sequence", "voice_bass", "sequence"),
    ("pat_drums", "sequence", "drums", "sequence"),
    ("voice_keys", "track", "out", "track0"),
    ("voice_bass", "track", "out", "track1"),
    ("drums", "track", "out", "track2"),
    ("arp", "sequence", "probe", "music"),
    ("probe", "envelope", "pulse", "x"),
    ("pulse", "value", "to_vec", "value"),
    ("to_vec", "vector", "xform", "scale"),
    ("xform", "matrix", "sphere", "matrix"),
]

project = {
    "canvases": [
        {
            "nodes": nodes,
            "connections": [wire(i, *l) for i, l in enumerate(links)],
            "keyframes": {},
            "markers": [],
            "exposedParams": [],
        }
    ],
    "activeCanvas": 0,
}

OUT.write_text(json.dumps(project, indent=2) + "\n")
print(f"wrote {OUT}")
