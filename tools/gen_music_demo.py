"""Writes public/demos/demo_music_pocket_star.tsuji — "Pocket Star", a Japanese Game Boy–style song in A major made as
procedurally as the music nodes allow, every part a Game Boy channel:

- one Progression for the whole song (the "royal road" IV–V–iii–vi in the chorus), voice-led, arpeggiated in
  sixteenths, its roots bounced in octaves on the wave channel;
- the verse and chorus melodies read off two function curves (Contour → Melody), ornamented, kept in the key, with a
  Chip Echo on a second pulse; a second-species Counterpoint under the chorus;
- a nearly locked Shift Register riff in the pre-chorus, two pulses phasing in the bridge, then a Markov chain that
  learned both melodies;
- the DMG kit on Euclidean rhythms; every part brought in and out by Sections; a Music Viewer in the Chip palette.

The curves' constants and the seeds were picked by search, scoring each candidate on how its notes sit on the chords
(chord tones on the beats, short passing notes between) — so the melodies are generated, and chosen to sing.

Run: python3 tools/gen_music_demo.py
"""
from pathlib import Path
import json
BARS = 44
def mask(*ranges):
    on = [False]*BARS
    for a, b in ranges:            # 1-based, inclusive
        for i in range(a-1, b): on[i] = True
    out, i = [], 0
    while i < BARS:
        j = i
        while j < BARS and on[j] == on[i]: j += 1
        out.append(('x' if on[i] else '.') + (f'*{j-i}' if j-i > 1 else ''))
        i = j
    return ' '.join(out)

nodes, conns, tracks = [], [], []
def node(id, ntype, x, y, **params):
    nodes.append({"id": id, "type": ntype, "position": {"x": x, "y": y}, "params": params}); return id
def wire(a, b, fs="sequence", ts="sequence"):
    conns.append({"id": f"c{len(conns)}", "fromNode": a, "fromSocket": fs, "toNode": b, "toSocket": ts})
def sec(id, src, x, y, name, ranges, restart=True, fs="sequence"):
    when = ", ".join(f"{a}–{b}" for a, b in ranges)
    node(id, "music/sections", x, y, name=f"{name} · bars {when}", bars=mask(*ranges), barLength=16, restart=restart)
    wire(src, id, fs); return id
def gb(id, x, y, src, name, preset, level, pan=0, fs="sequence", **extra):
    node(id, "music/gameboy", x, y, name=name, preset=preset, level=level, pan=pan, **extra)
    wire(src, id, fs); tracks.append(id); return id

X = [0, 260, 520, 780, 1040, 1300]
node("clock", "music/clock", -320, 700, bpm=152, swing=0, stepsPerBeat="4")

# ── Harmony: one progression for the whole song, in A major ──────────────────
FORM = [("Intro", 1, 4, "I vi IV V"),
        ("Verse", 5, 12, "I iii IV V I vi ii V"),
        ("Pre-chorus", 13, 16, "IV V iii vi"),
        ("Chorus", 17, 24, "IVmaj7 V7 iii7 vi7 IVmaj7 V7 I I"),
        ("Bridge", 25, 32, "vi IV I V vi IV ii V"),
        ("Chorus", 33, 40, "IVmaj7 V7 iii7 vi7 IVmaj7 V7 I I"),
        ("Outro", 41, 44, "IV V I:2")]
numerals = " ".join(f[3] for f in FORM)
y = 0
node("prog", "music/progression", X[0], y, name="ōdō shinkō — the royal road", root="A", mode="major", source="written", numerals=numerals,
     count=8, sevenths=False, tension=0.3, cadence=True, seed=0, chordLength=16, center=62, velocity=0.6)
wire("clock", "prog", "clock", "clock")
node("vl", "music/voice-leading", X[1], y, voices=3, low=57, high=76); wire("prog", "vl", "chords")
node("arp", "music/arp", X[2], y, on=True, mode="up", rate="1/16", triplet=False, octaves=1, gate=0.45, sync="grid"); wire("vl", "arp")
sec("sec_arp", "arp", X[3], y, "arpeggio", [(1, 44)], restart=False)
gb("arp_v", X[4], y, "sec_arp", "Arpeggio", "Pulse 12.5 · Thin", 0.16, -0.35)
# the bass bounces in octaves: the roots arpeggiated over two octaves, in eighths
node("bounce", "music/arp", X[2], y+160, on=True, mode="up", rate="1/8", triplet=False, octaves=2, gate=0.7, sync="grid"); wire("vl", "bounce", "bass")
sec("sec_bass", "bounce", X[3], y+160, "bass", [(1, 44)], restart=False)
gb("bass_v", X[4], y+160, "sec_bass", "Octave bass", "Wave · Bass", 0.3)

# ── Verse: a melody read off a curve, ornamented, kept in A major, echoed ───
y = 400
node("curve_v", "math/function-curve", X[0], y, mode="function", formula="sin(a*x) + b*sin(c*x + d)", a=1.5, b=0.5, c=5, d=2.4,
     **{"from": -4, "to": 4}, samples=200, yMin=-2, yMax=2, progress=1, width=3, visible=False)
node("contour_v", "music/contour", X[1], y, axis="y", steps=64, scale="major pentatonic", root="A", low=71, range=6, rhythm="change", invert=False, velocity=0.8, gate=0)
wire("curve_v", "contour_v", "curve", "curve"); wire("clock", "contour_v", "clock", "clock")
node("orn_v", "music/ornament", X[2], y, type="mordent", chance=0.2, minSteps=2, rate="1/32", up=2, down=1, seed=2); wire("contour_v", "orn_v")
node("scale_v", "music/scale", X[3], y, root="A", scale="major", snap="nearest", outside="snap", chords="keep"); wire("orn_v", "scale_v")
sec("sec_verse", "scale_v", X[4], y, "verse melody", [(5, 12)])
gb("verse_v", X[5], y, "sec_verse", "Verse lead", "Pulse 25 · Lead", 0.22, 0.1)
node("echo_v", "music/chip-echo", X[5], y+160, delay=3, level=0.4, transpose=0, detune=6); wire("sec_verse", "echo_v")
gb("verse_echo", X[5]+260, y+160, "echo_v", "Verse echo", "Pulse 12.5 · Thin", 0.11, 0.5, fs="echo")

# ── Pre-chorus: a shift register riff, nearly locked ────────────────────────
y = 760
node("sr", "music/shift-register", X[0], y, bits=8, change=0.02, density=0.6, length=64, scale="major pentatonic", root="A", low=69, range=7, gate=1, velocity=0.7, seed=179)
wire("clock", "sr", "clock", "clock")
sec("sec_sr", "sr", X[4], y, "riff", [(13, 16)])
gb("riff_v", X[5], y, "sec_sr", "Pre-chorus riff", "Pulse 50 · Lead", 0.17, -0.1)

# ── Chorus: the hook from a slower curve, an octave up, with a counterpoint duet ──
y = 960
node("curve_c", "math/function-curve", X[0], y, mode="function", formula="sin(a*x) + b*sin(c*x + d)", a=0.5, b=0.35, c=6, d=0,
     **{"from": -2.25, "to": 2.25}, samples=200, yMin=-2, yMax=2, progress=1, width=3, visible=False)
node("contour_c", "music/contour", X[1], y, axis="y", steps=64, scale="major pentatonic", root="A", low=66, range=5, rhythm="change", invert=False, velocity=0.85, gate=0)
wire("curve_c", "contour_c", "curve", "curve"); wire("clock", "contour_c", "clock", "clock")
node("orn_c", "music/ornament", X[2], y, type="grace below", chance=0.35, minSteps=4, rate="1/32", up=2, down=1, seed=5); wire("contour_c", "orn_c")
node("scale_c", "music/scale", X[3], y, root="A", scale="major", snap="nearest", outside="snap", chords="keep"); wire("orn_c", "scale_c")
CHORUS = [(17, 24), (33, 40)]
sec("sec_hook", "scale_c", X[4], y, "hook", CHORUS)
gb("hook_v", X[5], y, "sec_hook", "Chorus hook", "Macro · Vibrato Lead", 0.22, 0.05, transpose=12)
node("echo_c", "music/chip-echo", X[5], y+160, delay=3, level=0.4, transpose=0, detune=6); wire("sec_hook", "echo_c")
gb("hook_echo", X[5]+260, y+160, "echo_c", "Hook echo", "Pulse 12.5 · Thin", 0.1, 0.5, fs="echo", transpose=12)
node("cp", "music/counterpoint", X[2], y+320, species="2", position="below", scale="major", root="A", low=54, high=66, velocity=0.7, seed=42); wire("contour_c", "cp")
sec("sec_cp", "cp", X[4], y+320, "counter-voice", CHORUS)
gb("cp_v", X[5], y+320, "sec_cp", "Counter-voice", "Pulse 25 · Pluck", 0.15, -0.4, transpose=12)

# ── Bridge: two pulses phasing, then a Markov chain that learned both melodies ──
y = 1500
node("phase_m", "music/pattern", X[0], y, steps="A5 E5 C#6 E5 B5 E5 A5 E5 F#5 E5 B5 E5", length="12"); wire("clock", "phase_m", "clock", "clock")
node("phase", "music/phase", X[1], y, mode="steps", loops=2, direction="ahead", drift=1); wire("phase_m", "phase")
sec("sec_pa", "phase", X[4], y, "phase A", [(25, 32)], fs="a")
sec("sec_pb", "phase", X[4], y+160, "phase B", [(25, 32)], fs="b")
gb("phase_a", X[5], y, "sec_pa", "Phase A", "Pulse 25 · Pluck", 0.11, -0.65)
gb("phase_b", X[5], y+160, "sec_pb", "Phase B", "Pulse 25 · Pluck", 0.11, 0.65)
node("markov", "music/markov", X[2], y+320, order=2, length=64, learn="both", novelty=0.25, seed=304)
wire("scale_v", "markov", "sequence", "source"); wire("scale_c", "markov", "sequence", "source2")
node("scale_m", "music/scale", X[3], y+320, root="A", scale="major", snap="nearest", outside="snap", chords="keep"); wire("markov", "scale_m")
sec("sec_mk", "scale_m", X[4], y+320, "markov", [(29, 32)])
gb("markov_v", X[5], y+320, "sec_mk", "Markov lead", "Pulse 50 · Lead", 0.18, 0.15)

# ── Drums: the DMG kit on Euclidean rhythms ──────────────────────────────────
y = 2100
for i, (id, notes, p, s, rot, vel, acc, ranges, name) in enumerate([
    ("kick", "kick", 3, 8, 0, 0.9, 0, [(5, 24), (29, 40)], "Kick"),
    ("snare", "snare", 2, 16, 4, 0.75, 0, [(13, 24), (33, 40)], "Snare"),
    ("hats", "hat", 7, 16, 1, 0.45, 0.65, [(1, 40)], "Hats")]):
    yy = y + i*160
    node(f"eu_{id}", "music/euclid", X[0], yy, pulses=p, steps=s, rotation=rot, notes=notes, gate=0, velocity=vel, accent=acc)
    wire("clock", f"eu_{id}", "clock", "input")
    sec(f"sec_{id}", f"eu_{id}", X[4], yy, id, ranges)
    gb(f"kit_{id}", X[5], yy, f"sec_{id}", name, "Kit · DMG Drums", 0.5)

# ── Out, the viewer, the render ─────────────────────────────────────────────
node("out", "music/out", 1900, 1100, master=0.8, startFrame=0)
for i, t in enumerate(tracks): wire(t, "out", "track", f"track{i}")
node("viewer", "music/viewer", 1900, 800, title="ポケットの星 · Pocket Star", show=True, style="galaxy", palette="chip", intensity=1.1, ahead=5, legend=True)
seconds = BARS * 16 / 4 / 152 * 60
node("env", "lighting/environment", 1900, 1400, color=0x0b1a10, intensity=1, background=1, ambientIntensity=0.6, sunIntensity=1.2)
node("render", "render", 1900, 1600, frameCount=int(round(seconds * 30)), fps=30, motionBlur=0, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
doc = {"canvases": [{"nodes": nodes, "connections": conns, "keyframes": {}, "markers": [], "exposedParams": []}], "activeCanvas": 0}
OUT = Path(__file__).resolve().parent.parent / "public" / "demos" / "demo_music_pocket_star.tsuji"
OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print(len(nodes), "nodes", len(tracks), "tracks", round(seconds, 1), "s")
