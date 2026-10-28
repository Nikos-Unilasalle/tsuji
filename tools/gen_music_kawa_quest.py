"""Writes public/demos/demo_music_kawa_quest.tsuji: "KAWA QUEST", the demo song of the KAWA tracker, on tsuji's nodes.

Source (GPL-3.0-only, as tsuji): KAWA — Pocket Tracker for the M-VAVE FM-1, by Omnipotard —
https://github.com/guizmoh/Kawa-Tracker-Fm1, source/firmware/src/kawa_edit.c, prj_demo(). The song is transcribed
from there call for call: an overworld in C, a dungeon in A minor, the boss (breakcore), the victory — seven
patterns of two bars, most played twice, 120 BPM, six tracks.

What changes on the way, because tsuji does not have it (yet):
  - KAWA's chip engines: the pulse lead plays on the Chip FM preset, the wave bass on Felucca's BASS, the noise
    hats on the Drum Kit's hat; the kalimba is SLOOP's KALIMBA (KAWA's own FM sound is a 6-op DX7 patch);
  - the SNES kit's lanes map to the Drum Kit (1 kick, 2 kick, 3 snare, 4 clap, 5 hat, 6 open hat, 7/8 toms, 9 open
    hat for the crash, 15 clap);
  - the boss's chopped breakbeat (a sample) is rebuilt with the Drum Kit, each of the 16 slices a drum hit;
  - ARP x (chip arpeggio of a chord) becomes the chord itself (0 maj, 1 min, 8 dim); GLIDE v → GLD 2v; ROLL v →
    a ratchet of KAWA's count (2 3 4 6 8…, at most 8 here); vibrato, reverse, pitch and the live effects are left out.

The seven patterns are laid end to end in song order into one pattern per track (416 steps, 52 s), and the
timeline is 1560 frames at 30 fps: the song and the timeline loop together. A Note Probe on the lead makes the
sphere pulse.

Run: python3 tools/gen_music_kawa_quest.py
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "demos" / "demo_music_kawa_quest.tsuji"

NROW = 32
T1, T2, T3, T4, T5, T6 = range(6)
FX_ARP, FX_GLIDE, FX_VIB, FX_ROLL, FX_REV, FX_PITCH = "ARP", "GLIDE", "VIB", "ROLL", "REV", "PITCH"
ROLL_N = [2, 3, 4, 6, 8, 12, 16, 24, 32]
OFF = "off"

# pats[p][t][row] = None | {"note": int | "off", "vol": int, "fx": str | None, "fxv": int}
pats = [[[None] * NROW for _ in range(6)] for _ in range(7)]


def put(p, r, t, note, vol, fx=None, fxv=0):
    pats[p][t][r] = {"note": note, "vol": vol, "fx": fx, "fxv": fxv}


def lane(p, t, s, vol):
    """KAWA's lane(): one token a row — a note (C5, F#3), a number (a drum, a slice), '.' (empty), 'x' (OFF)."""
    letter = {"A": 9, "B": 11, "C": 0, "D": 2, "E": 4, "F": 5, "G": 7}
    for r, tok in enumerate(s.split()[:NROW]):
        if tok == ".":
            continue
        if tok == "x":
            put(p, r, t, OFF, 0)
        elif tok[0] in letter:
            n = letter[tok[0]]
            rest = tok[1:]
            if rest.startswith("#"):
                n += 1
                rest = rest[1:]
            n += (int(rest) + 1) * 12
            put(p, r, t, n, vol)
        else:
            put(p, r, t, int(tok), vol)


def fx_at(p, r, t, fx, v):
    c = pats[p][t][r]
    if c is None:
        c = pats[p][t][r] = {"note": None, "vol": 0, "fx": None, "fxv": 0}
    c["fx"], c["fxv"] = fx, v


# ── prj_demo(), as in kawa_edit.c ─────────────────────────────────────────
# P1, P2: the overworld
lane(0, T1, "C5 . E5 G5 . E5 C6 . A5 . G5 . E5 . D5 . F5 . A5 . G5 E5 . C5 D5 . E5 . C5 . x .", 12)
lane(1, T1, "E5 . G5 A5 . G5 E5 . D5 . E5 D5 C5 . A4 . B4 . C5 D5 . E5 G5 . F5 . E5 D5 C5 . . x", 12)
lane(0, T3, "C3 . C4 . G3 . C4 . A2 . A3 . E3 . A3 . F2 . F3 . C3 . F3 . G2 . G3 . D3 . G3 .", 13)
lane(1, T3, "A2 . A3 . E3 . A3 . F2 . F3 . C3 . F3 . G2 . G3 . D3 . G3 . C3 . C4 . G3 . C4 .", 13)
CH = [[72, 69, 65, 67], [69, 65, 67, 72]]  # roots: C Am F G / Am F G C
MN = [[0, 1, 0, 0], [1, 0, 0, 0]]
for p in range(2):
    for r in range(0, 32, 8):
        put(p, r + 2, T2, CH[p][r // 8], 9, FX_ARP, MN[p][r // 8])
        put(p, r + 6, T2, CH[p][r // 8], 7, FX_ARP, MN[p][r // 8])
    lane(p, T4, ". . 96 . . . 96 96 . . 96 . . . 96 . . . 96 . . . 96 96 . . 96 . . 96 96 96", 9)
    lane(p, T5, "1 . . . 3 . . 1 1 . 1 . 3 . . . 1 . . . 3 . . 1 1 . 1 . 3 . 3 3", 13)
put(1, 4, T2, 96, 8)  # a counter-melody on the kalimba, between the chords
put(1, 12, T2, 100, 8)
put(1, 20, T2, 98, 8)
put(1, 28, T2, 103, 8)
fx_at(1, 28, T1, FX_VIB, 6)
fx_at(0, 6, T1, FX_GLIDE, 4)
# P3, P4: the dungeon (A minor, a 16th ostinato on the kalimba, drops of water)
lane(2, T2, "A4 E5 C5 E5 A4 E5 C5 E5 A#4 F5 D5 F5 A#4 F5 D5 F5 A4 E5 C5 E5 A4 E5 C5 E5 G#4 E5 B4 E5 G#4 E5 B4 E5", 8)
lane(3, T2, "D5 A5 F5 A5 D5 A5 F5 A5 A4 E5 C5 E5 A4 E5 C5 E5 A#4 F5 D5 F5 A#4 F5 D5 F5 G#4 E5 B4 E5 G#4 E5 B4 E5", 8)
lane(2, T3, "A2 . . . . . . . A#2 . . . . . . . A2 . . . . . . . E2 . . . . . . .", 12)
lane(3, T3, "D3 . . . . . . . A2 . . . . . . . A#2 . . . . . . . E2 . . . . . . .", 12)
lane(2, T1, ". . . . . . A6 x . . . . . . . . . . . . . . E6 x . . . . . . . .", 6)
lane(3, T1, "E5 . . . . . F5 . E5 . . . D5 . . . C5 . . . B4 . . . G#4 . . . . . x .", 11)
fx_at(3, 24, T1, FX_VIB, 7)
fx_at(3, 6, T1, FX_GLIDE, 6)
lane(2, T5, "1 . . . . . . . . . . . . . . . 1 . . . . . . . . . . . . . . .", 10)
lane(3, T5, "1 . . . . . . . 4 . 1 . . . . . 1 . . . . . . . 4 . 1 . . . 4 4", 11)
lane(3, T4, "96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 . 96 96", 5)
fx_at(3, 30, T5, FX_ROLL, 2)
# P5, P6: the boss (breakcore: the break chopped, kicks, a riff in harmonic minor)
lane(4, T6, "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 1 2 1 2 5 6 7 8 3 4 11 12 13 13 15 16", 13)
lane(5, T6, "1 2 5 6 3 4 7 7 9 10 13 14 11 12 16 16 1 . 1 2 5 5 7 8 9 9 11 12 13 14 15 16", 13)
fx_at(4, 29, T6, FX_ROLL, 1)
fx_at(4, 31, T6, FX_ROLL, 3)
fx_at(5, 8, T6, FX_REV, 0)
fx_at(5, 14, T6, FX_ROLL, 2)
fx_at(5, 20, T6, FX_PITCH, -5)
fx_at(5, 31, T6, FX_ROLL, 5)
lane(4, T5, "1 . . . 1 . . . 1 . . . 1 . 1 . 1 . . . 1 . . . 1 . . . 1 . 1 1", 15)
lane(5, T5, "1 . . 1 1 . . . 1 . . 1 1 . 1 . 1 . . 1 1 . . . 1 . 1 . 1 1 1 1", 15)
fx_at(5, 30, T5, FX_ROLL, 3)
lane(4, T3, "A2 . A2 A3 . A2 C3 . G2 . G2 G3 . G2 A#2 . F2 . F2 F3 . F2 A2 . E2 . E2 E3 . G#2 B2 .", 14)
lane(5, T3, "A2 . A2 A3 . A2 C3 . G2 . G2 G3 . G2 A#2 . F2 . F2 F3 . F2 A2 . E2 E3 E2 E3 G#2 G#3 B2 B3", 14)
lane(4, T1, "A5 . . C6 . . B5 . G#5 . A5 . E5 . . . F5 . . E5 . . D5 . C5 . . . B4 . G#4 .", 12)
lane(5, T1, "A5 . . . . . . . A#5 . . . . . . . A5 . . . . . . . G#5 . . . . . . .", 12)
fx_at(4, 24, T1, FX_GLIDE, 5)
fx_at(5, 0, T1, FX_ARP, 1)  # chip arpeggios: Am, Bb, Am, E dim
fx_at(5, 8, T1, FX_ARP, 0)
fx_at(5, 16, T1, FX_ARP, 1)
fx_at(5, 24, T1, FX_ARP, 8)
lane(4, T2, "A4 . . . . . . . G4 . . . . . . . F4 . . . . . . . E4 . . . . . . .", 7)
for r in range(0, 32, 8):
    fx_at(4, r, T2, FX_ARP, 0 if r else 1)  # Am G F E
lane(4, T4, " ".join(["96"] * 32), 6)
lane(5, T4, " ".join(["96"] * 32), 7)
fx_at(5, 15, T4, FX_ROLL, 2)
# P7: the victory
lane(6, T1, "G4 C5 E5 G5 C6 . . . . . . . A#5 . C6 . D6 . . . E6 . . . . . . . x . . .", 13)
fx_at(6, 4, T1, FX_VIB, 4)
fx_at(6, 20, T1, FX_VIB, 6)
lane(6, T2, "C5 . . . . . . . F4 . . . A#4 . . . C5 . . . . . . . C7 . G6 . E6 . C6 .", 8)
for r in (0, 8, 12, 16):
    fx_at(6, r, T2, FX_ARP, 0)
lane(6, T3, "C3 . C4 . C3 . C4 . F2 . F3 . A#2 . A#3 . C3 . . . . . . . . . . . x . . .", 13)
lane(6, T5, "9 . . . 3 . . . 1 . . . 3 . 3 3 9 . . . . . . . . . . . . . . .", 14)
fx_at(6, 15, T5, FX_ROLL, 3)
SONG = [(0, 2), (1, 2), (2, 2), (3, 2), (4, 2), (5, 2), (6, 1)]

# ── to tsuji's notation ───────────────────────────────────────────────────
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
CHORD_OF_ARP = {0: "maj", 1: "min", 8: "dim"}
SNES_KIT = {1: "kick", 2: "kick", 3: "snare", 4: "clap", 5: "hat", 6: "openhat", 7: "tomlow", 8: "tomhigh", 9: "openhat", 15: "clap"}
# The break's 16 slices as drum hits (a two-bar break read as kick / hat / snare).
BREAK = {1: "kick", 2: "hat", 3: "snare", 4: "hat", 5: "kick", 6: "kick", 7: "snare", 8: "hat",
         9: "kick", 10: "hat", 11: "snare", 12: "hat", 13: "kick", 14: "hat", 15: "snare", 16: "openhat"}


def note_word(t, n):
    if t == T4:
        return "hat"
    if t == T5:
        return SNES_KIT.get(n, "snare")
    if t == T6:
        return BREAK.get(n, "snare")
    return f"{NAMES[n % 12]}{n // 12 - 1}"


def track_words(t):
    words = []
    last = None
    for p, times in SONG:
        for _ in range(times):
            for c in pats[p][t]:
                if c is None:
                    words.append(".")
                    continue
                note = c["note"]
                if note is None:  # an effect on an empty cell: a roll strikes the last note again, the rest is dropped
                    if c["fx"] == FX_ROLL and last is not None:
                        note = last
                    else:
                        words.append(".")
                        continue
                if note == OFF:
                    words.append("off")
                    continue
                last = note
                w = note_word(t, note)
                if c["fx"] == FX_ARP and t not in (T4, T5, T6):
                    w += ":" + CHORD_OF_ARP.get(c["fxv"], "maj")
                vol = c["vol"] or 12
                w += f"@{round(min(1, vol / 15), 2)}"
                if c["fx"] == FX_GLIDE:
                    w += f"!GLD{2 * c['fxv']}"
                elif c["fx"] == FX_ROLL:
                    w += f"!RTG{min(8, ROLL_N[max(0, min(8, c['fxv']))])}"
                words.append(w)
    return " ".join(words)


LENGTH = sum(times for _, times in SONG) * NROW  # 416
assert all(len(track_words(t).split()) == LENGTH for t in range(6))

tracks = [
    # id, label, kind, preset / level, pan
    ("lead", T1, "fm", {"preset": "Chip", "level": 0.55, "pan": -0.15}),
    ("kalimba", T2, "fm", {"preset": "SLOOP · KALIMBA", "level": 0.7, "pan": 0.3}),
    ("bass", T3, "fm", {"preset": "Felucca · BASS", "level": 0.85, "pan": 0}),
    ("hats", T4, "drums", {"level": 0.45, "pan": 0.25, "decay": 0.8}),
    ("kit", T5, "drums", {"level": 0.85, "pan": 0}),
    ("break", T6, "drums", {"level": 0.7, "pan": -0.1, "tune": 2, "decay": 0.7}),
]

nodes = [
    {"id": "clock", "type": "music/clock", "position": {"x": 40, "y": 400}, "params": {"bpm": 120, "swing": 0, "stepsPerBeat": "4"}},
]
links = []
for i, (tid, t, kind, params) in enumerate(tracks):
    y = 40 + i * 150
    nodes.append({"id": f"pat_{tid}", "type": "music/pattern", "position": {"x": 300, "y": y}, "params": {"steps": track_words(t), "length": str(LENGTH), "name": tid}})
    nodes.append({"id": f"voice_{tid}", "type": "music/fm-voice" if kind == "fm" else "music/drum-kit", "position": {"x": 600, "y": y}, "params": params})
    links += [("clock", "clock", f"pat_{tid}", "clock"), (f"pat_{tid}", "sequence", f"voice_{tid}", "sequence"), (f"voice_{tid}", "track", "out", f"track{i}")]

nodes += [
    {"id": "out", "type": "music/out", "position": {"x": 900, "y": 360}, "params": {"master": 0.8, "startFrame": 0}},
    {"id": "probe", "type": "music/note-probe", "position": {"x": 900, "y": 40}, "params": {"decay": 0.15}},
    {"id": "pulse", "type": "math/expression", "position": {"x": 1160, "y": 40}, "params": {"formula": "0.6 + 0.9 * x"}},
    {"id": "to_vec", "type": "converter/value-to-vector", "position": {"x": 1400, "y": 40}, "params": {}},
    {"id": "xform", "type": "transform/matrix-transform", "position": {"x": 1620, "y": 40}, "params": {}},
    {"id": "sphere", "type": "object/sphere", "position": {"x": 1860, "y": 40}, "params": {"color": 0x38BDF8, "emissive": 0x0C4A6E, "emissiveIntensity": 1.0}},
    {"id": "env", "type": "lighting/environment", "position": {"x": 1860, "y": 320}, "params": {"color": 4147542, "intensity": 1, "background": 1, "ambientIntensity": 0.6, "sunIntensity": 1.2}},
    {"id": "render", "type": "render", "position": {"x": 900, "y": 700}, "params": {"frameCount": LENGTH * 30 // 8, "fps": 30, "motionBlur": 0, "resolutionPreset": "16:9 (1920x1080)", "width": 1920, "height": 1080, "holdout": False}},
]
links += [
    ("pat_lead", "sequence", "probe", "music"),
    ("probe", "envelope", "pulse", "x"),
    ("pulse", "value", "to_vec", "value"),
    ("to_vec", "vector", "xform", "scale"),
    ("xform", "matrix", "sphere", "matrix"),
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
print(f"wrote {OUT} ({LENGTH} steps, {LENGTH * 30 // 8} frames)")
