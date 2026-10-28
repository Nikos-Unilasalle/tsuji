"""Writes public/demos/demo_music_reggae.tsuji — "Tsuji Dub": a one-drop riddim in A minor, built from music nodes.

75 BPM, a touch of shuffle, sixteen bars of sixteenths: 256 steps, 51.2 s — the 1536 frames of the timeline at
30 fps, so song and timeline loop together. Am7 Am7 Dm7 Dm7 | Am7 Am7 Em7 Dm7, twice.

  bars 1–2    drums and bass alone: the riddim
  bars 3–4    the skank (offbeat guitar chords) and the organ bubble come in; a dub siren answers
  bars 5–8    the full riddim; the snare and the skank throw dub echoes; a tom fill into…
  bars 9–12   steppers (a kick on every beat) and the melodica's tune
  bar 13      the drop: the bass steps out, the skank echoes in the space
  bars 14–16  everyone back, the siren again, the fill, round we go

tsuji has no delay effect yet, so the echoes are written: the repeats of a hit three sixteenths later (a dotted
eighth), each one softer. Three spheres, red, gold and green, pulse with the drums, the skank and the bass.

Run: python3 tools/gen_music_reggae.py
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "demos" / "demo_music_reggae.tsuji"
BARS = 16
STEPS = BARS * 16
BPM = 75
FRAMES = STEPS * 15 * 30 // BPM  # 15 = 60 s / 4 sixteenths per beat

# The progression, bar by bar.
FORM = ["Am", "Am", "Dm", "Dm", "Am", "Am", "Em", "Dm"] * 2


def bar(words: str) -> list[str]:
    w = words.split()
    assert len(w) == 16, f"{len(w)} steps in: {words}"
    return w


def song(bars: list[list[str]]) -> str:
    assert len(bars) == BARS
    return " ".join(w for b in bars for w in b)


REST = bar(". " * 16)

# ── drums ─────────────────────────────────────────────────────────────────
def one_drop(open_hat=False, echo=False, fill=False):
    # Hats on the eighths, the offbeat ones a little louder; kick and rim together on beat 3 — the one drop.
    w = ["hat@0.4" if i % 4 == 0 else "hat@0.55" if i % 2 == 0 else "." for i in range(16)]
    w[8] = "kick+snare+hat@0.85"
    if open_hat:
        w[14] = "openhat@0.5"
    if echo:  # the rim thrown into the echo: a dotted eighth later, softer each time
        w[11] = "snare@0.35"
        w[14] = "snare+hat@0.2"
    if fill:
        w[12] = "tomhigh@0.8!RTG2"
        w[13] = "tomhigh@0.7"
        w[14] = "tomlow@0.85!RTG2"
        w[15] = "tomlow@0.75"
    return w


def steppers(fill=False):
    w = one_drop()
    for i in (0, 4, 12):
        w[i] = "kick+hat@0.8"
    if fill:
        w[12] = "kick+tomhigh@0.8!RTG2"
        w[14] = "tomlow@0.85!RTG3"
        w[15] = "clap@0.7"
    return w


drums = [
    one_drop(), one_drop(open_hat=True), one_drop(), one_drop(echo=True),
    one_drop(), one_drop(open_hat=True), one_drop(), one_drop(fill=True),
    steppers(), steppers(), steppers(), steppers(),
    one_drop(echo=True), steppers(), steppers(), steppers(fill=True),
]

# ── bass: deep, melodic, leaving the one ──────────────────────────────────
BASS = {
    "Am": [bar(". . A1@0.95~3 . . . C2~1 E2~2 . . A2~2 . G2~2 . E2~2 ."),
           bar(". . A1@0.95~3 . . . C2~1 D2~2 . . E2~3 . . . D2~1 C2~1")],
    "Dm": [bar(". . D2@0.95~3 . . . F2~1 A2~2 . . D2~2 . C2~2 . A1~2 ."),
           bar(". . D2@0.95~3 . . . F2~1 G2~2 . . A2~3 . . . G2~1 F2~1")],
    "Em": [bar(". . E2@0.95~3 . . . G2~1 B2~2 . . E2~2 . D2~2 . B1~2 ."),
           bar(". . E2@0.95~3 . . . G2~1 A2~2 . . B2~3 . . . A2~1 G2~1")],
}
bass = []
for i, ch in enumerate(FORM):
    if i == 12:  # the drop: one low note, then space
        bass.append(bar("A1@0.9~2 . . . . . . . . . . . . . . ."))
        continue
    bass.append(BASS[ch][i % 2])

# ── skank: the offbeat chords, short and sharp ────────────────────────────
VOICING = {"Am": "A3:min7", "Dm": "D3:min7/2", "Em": "E3:min7/2"}


def skank(ch, echo=False):
    c = VOICING[ch]
    w = ["."] * 16
    w[4] = f"{c}@0.85~1"
    w[12] = f"{c}@0.9~1"
    if echo:
        w[15] = f"{c}@0.4~1"
    return w


skanks = []
for i, ch in enumerate(FORM):
    if i < 2:
        skanks.append(REST)
    elif i == 12:  # the drop: the skank alone with its echoes
        w = skank(ch, echo=True)
        w[7] = f"{VOICING[ch]}@0.4~1"
        w[10] = f"{VOICING[ch]}@0.2~1"
        skanks.append(w)
    else:
        skanks.append(skank(ch, echo=i in (3, 7, 11, 15)))

# ── organ bubble: the eighth offbeats, the "and" of every beat ────────────
BUBBLE = {"Am": "A2:min7", "Dm": "D2:min7/2", "Em": "E2:min7/2"}


def bubble(ch):
    c = BUBBLE[ch]
    w = ["."] * 16
    for i, v in ((2, 0.4), (6, 0.55), (10, 0.4), (14, 0.55)):
        w[i] = f"{c}@{v}~1"
    return w


organ = [REST if i < 2 or i == 12 else bubble(ch) for i, ch in enumerate(FORM)]

# ── melodica: the tune, bars 9 to 16 ──────────────────────────────────────
TUNE = [
    bar("E5~3 . . D5~1 C5~2 . A4~6 . . . . . . . . ."),
    bar(". . C5~2 . D5~2 . E5~4 . . . G5~2 . E5~2 . . ."),
    bar("F5~4 . . . E5~2 . D5~2 . C5~2 . D5~6 . . . . ."),
    bar(". . . . A4~2 . C5~2 . D5~8!GLD4 . . . . . . ."),
    bar("E5~2 . G5~2 . A5~6 . . . . . G5~2 . E5~2 . . ."),
    bar("D5~2 . C5~2 . A4~4 . . . C5~2 . D5~2 . E5~2 . . ."),
    bar("B4~4 . . . D5~2 . E5~4 . . . G5~2 . E5~2 . . ."),
    bar("D5~3 . . C5~1 A4~12!GLD3 . . . . . . . . . . ."),
]
melodica = [REST] * 8 + TUNE

# ── dub siren: a slow wail, gliding up and down ───────────────────────────
WAIL = bar("A5@0.5~4 . . . E6@0.5~4!GLD40 . . . A5@0.5~4!GLD40 . . . E6@0.45~4!GLD40 . . .")
RISE = bar(". . . . . . . . A5@0.4~2 . C6@0.45~2!GLD20 . E6@0.5~2!GLD20 . A6@0.5~2!GLD30 .")
siren = [REST] * BARS
siren[3] = WAIL
siren[7] = RISE
siren[15] = WAIL

TRACKS = [
    # id, steps, voice node type, params
    ("drums", song(drums), "music/drum-kit", {"level": 0.85, "pan": 0, "tune": -2, "decay": 1.1}),
    ("bass", song(bass), "music/fm-voice", {"preset": "Felucca · BASS", "level": 1.0, "pan": 0}),
    ("skank", song(skanks), "music/fm-voice", {"preset": "SLOOP · CLAV", "level": 0.45, "pan": -0.35}),
    ("organ", song(organ), "music/fm-voice", {"preset": "Felucca · ORGAN", "level": 0.3, "pan": 0.35}),
    ("melodica", song(melodica), "music/fm-voice", {"preset": "Melodica", "level": 0.55, "pan": 0.1}),
    ("siren", song(siren), "music/fm-voice", {"preset": "Chip", "level": 0.18, "pan": 0.6, "voices": 1}),
]

nodes = [{"id": "clock", "type": "music/clock", "position": {"x": 40, "y": 420}, "params": {"bpm": BPM, "swing": 0.2, "stepsPerBeat": "4"}}]
links = []
for i, (tid, steps, vtype, params) in enumerate(TRACKS):
    y = 40 + i * 150
    nodes.append({"id": f"pat_{tid}", "type": "music/pattern", "position": {"x": 300, "y": y}, "params": {"steps": steps, "length": str(STEPS), "name": tid}})
    nodes.append({"id": f"voice_{tid}", "type": vtype, "position": {"x": 600, "y": y}, "params": params})
    links += [("clock", "clock", f"pat_{tid}", "clock"), (f"pat_{tid}", "sequence", f"voice_{tid}", "sequence"), (f"voice_{tid}", "track", "out", f"track{i}")]

nodes += [
    {"id": "out", "type": "music/out", "position": {"x": 900, "y": 420}, "params": {"master": 0.8, "startFrame": 0}},
    {"id": "env", "type": "lighting/environment", "position": {"x": 1900, "y": 560}, "params": {"color": 1315860, "intensity": 1, "background": 1, "ambientIntensity": 0.55, "sunIntensity": 1.3}},
    {"id": "render", "type": "render", "position": {"x": 900, "y": 720}, "params": {"frameCount": FRAMES, "fps": 30, "motionBlur": 0, "resolutionPreset": "16:9 (1920x1080)", "width": 1920, "height": 1080, "holdout": False}},
]

# Three spheres, red, gold and green, each breathing with one part.
SPHERES = [
    ("red", "pat_drums", 0xD7263D, 0x4C0519, -2.6, 0.25),
    ("gold", "pat_skank", 0xF4C430, 0x4A3405, 0.0, 0.18),
    ("green", "pat_bass", 0x2E8B57, 0x052E16, 2.6, 0.35),
]
for k, (name, src, color, glow, x, decay) in enumerate(SPHERES):
    y = 40 + k * 170
    nodes += [
        {"id": f"probe_{name}", "type": "music/note-probe", "position": {"x": 1160, "y": y}, "params": {"decay": decay}},
        {"id": f"pulse_{name}", "type": "math/expression", "position": {"x": 1380, "y": y}, "params": {"formula": "0.7 + 0.7 * x"}},
        {"id": f"vec_{name}", "type": "converter/value-to-vector", "position": {"x": 1580, "y": y}, "params": {}},
        {"id": f"xf_{name}", "type": "transform/matrix-transform", "position": {"x": 1760, "y": y}, "params": {"location": {"x": x, "y": 0, "z": 0}}},
        {"id": f"sphere_{name}", "type": "object/sphere", "position": {"x": 1960, "y": y}, "params": {"color": color, "emissive": glow, "emissiveIntensity": 1.0}},
    ]
    links += [
        (src, "sequence", f"probe_{name}", "music"),
        (f"probe_{name}", "envelope", f"pulse_{name}", "x"),
        (f"pulse_{name}", "value", f"vec_{name}", "value"),
        (f"vec_{name}", "vector", f"xf_{name}", "scale"),
        (f"xf_{name}", "matrix", f"sphere_{name}", "matrix"),
    ]

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
print(f"wrote {OUT} ({STEPS} steps at {BPM} BPM, {FRAMES} frames)")
