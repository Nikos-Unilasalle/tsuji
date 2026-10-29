"""Tsuji Dub, the song of the Dub Dancer demo (tools/gen_music_dub_dancer.py imports it): a one-drop riddim in A minor.

Written after a reggae-on-a-tracker guide: the skank on the offbeats and the shuffle are the two pillars.

  - 75 BPM (reggae lives between 65 and 80), sixteenths, swing 0.4 (≈ 60 % shuffle) on the Clock;
  - drums, one drop: kick and rimshot only on beat 3 (line 08); hats loud on the beats, soft on the offbeats, with
    ghost notes; steppers (a kick on every beat, the snare still on 3) under the tune;
  - the skank on the offbeats, lines 02 06 10 14, a muted clav cut short (~0.3 of a step), doubled by the organ with
    its sixteenth "bubble" pickups;
  - the bass round and heavy (the Dub Bass preset, mono), legato, leaving the one empty, answering the kick on 3,
    sliding between notes (GLD);
  - bongos (toms tuned up) humanised with DLY: each hit a few sixty-fourths late;
  - dub: a snare and a skank chord thrown into the dotted-eighth ping-pong delay on chosen hits (tracks that play
    only those hits, with the delay send up), reverb on the snare, the skank, the melodica and the siren.

Sixteen bars, 256 steps, 51.2 s — the 1536 frames of the timeline at 30 fps, so song and timeline loop together.
Am7 Am7 Dm7 Dm7 | Am7 Am7 Em7 Dm7, twice:

  bars 1–2    drums and bass: the riddim
  bars 3–8    the skank and the organ; a siren at bar 4; throws; a tom fill into…
  bars 9–12   steppers, bongos, the melodica's tune
  bar 13      the drop: the bass steps out, the skank echoes
  bars 14–16  everyone back, the siren, the fill, round we go

It was a demo of its own; it lives on as Dub Dancer's soundtrack. This module only holds the song: TRACKS (each
track's pattern text, voice type and settings), OUT_PARAMS (Music Out's, the dub FX), BPM, SWING, BARS, STEPS, FRAMES.
"""
BARS = 16
STEPS = BARS * 16
BPM = 75
SWING = 0.4
FRAMES = STEPS * 15 * 30 // BPM  # 15 = 60 s / 4 sixteenths per beat

FORM = ["Am", "Am", "Dm", "Dm", "Am", "Am", "Em", "Dm"] * 2
THROW_BARS = {3, 7, 11, 15}  # bars 4, 8, 12, 16 (from 0)


def bar(words: str) -> list[str]:
    w = words.split()
    assert len(w) == 16, f"{len(w)} steps in: {words}"
    return w


def song(bars: list[list[str]]) -> str:
    assert len(bars) == BARS
    return " ".join(w for b in bars for w in b)


REST = bar(". " * 16)


# ── drums ─────────────────────────────────────────────────────────────────
def hats():
    # Loud on the beats, soft on the offbeats, a ghost before the next beat.
    w = ["."] * 16
    for i in (0, 4, 8, 12):
        w[i] = "hat@0.62"
    for i in (2, 6, 10, 14):
        w[i] = "hat@0.3"
    for i in (7, 15):
        w[i] = "hat@0.12"
    return w


def one_drop(open_hat=False, fill=False):
    w = hats()
    w[8] = "kick+snare+hat@0.9"  # the one drop: kick and rim on 3, nothing else
    if open_hat:
        w[14] = "openhat@0.35"
    if fill:
        w[12] = "tomhigh@0.75!RTG2"
        w[13] = "tomhigh@0.6"
        w[14] = "tomlow@0.8!RTG2"
        w[15] = "tomlow@0.7"
    return w


def steppers(fill=False):
    w = hats()
    for i in (0, 4, 12):
        w[i] = "kick+hat@0.75"
    w[8] = "kick+snare+hat@0.9"
    if fill:
        w[12] = "kick+tomhigh@0.75!RTG2"
        w[14] = "tomlow@0.8!RTG3"
        w[15] = "snare@0.6"
    return w


drums = [
    one_drop(), one_drop(open_hat=True), one_drop(), one_drop(),
    one_drop(), one_drop(open_hat=True), one_drop(), one_drop(fill=True),
    steppers(), steppers(), steppers(), steppers(),
    one_drop(), steppers(), steppers(), steppers(fill=True),
]

# The snare thrown into the echo: the one-drop rim doubled on a few bars, a ghost before the turn.
snare_throws = []
for i in range(BARS):
    if i in THROW_BARS or i == 12:
        snare_throws.append(bar(". . . . . . . . snare@0.8 . . . . . snare@0.35 ."))
    else:
        snare_throws.append(REST)

# Bongos (toms tuned up), humanised: every hit a little late, never twice the same.
BONGO = bar(". . . tomhigh@0.3!DLY2 . . tomlow@0.35!DLY1 tomhigh@0.25!DLY3 . . . tomhigh@0.3!DLY1 . . tomlow@0.4!DLY2 tomhigh@0.2!DLY3")
bongos = [REST] * 8 + [BONGO] * 4 + [REST] + [BONGO] * 3

# ── bass: round, legato, the one left empty, answering the kick on 3 ─────
BASS = {
    "Am": [bar(". . A1@0.95 . C2@0.8 . . . E2@0.9 . E2@0.7 . G2@0.85!GLD5 . . ."),
           bar(". . A1@0.95 . C2@0.8 . . . E2@0.9 . D2@0.7!GLD4 . C2@0.85 . B1@0.6 .")],
    "Dm": [bar(". . D2@0.95 . F2@0.8 . . . A2@0.9 . A2@0.7 . C2@0.85!GLD5 . . ."),
           bar(". . D2@0.95 . F2@0.8 . . . A2@0.9 . G2@0.7!GLD4 . F2@0.85 . E2@0.6 .")],
    "Em": [bar(". . E2@0.95 . G2@0.8 . . . B2@0.9 . B2@0.7 . D2@0.85!GLD5 . . ."),
           bar(". . E2@0.95 . G2@0.8 . . . B2@0.9 . A2@0.7!GLD4 . G2@0.85 . E2@0.6 .")],
}
bass = []
for i, ch in enumerate(FORM):
    if i == 12:  # the drop: one low note, then space
        bass.append(bar(". . A1@0.9~2 . . . . . . . . . . . . ."))
    else:
        bass.append(BASS[ch][i % 2])

# ── skank: the offbeats, 02 06 10 14, cut short ───────────────────────────
VOICING = {"Am": "A3:min7", "Dm": "D3:min7/2", "Em": "E3:min7/2"}


def skank(ch, vel=0.8):
    c = VOICING[ch]
    w = ["."] * 16
    for i in (2, 6, 10, 14):
        w[i] = f"{c}@{vel}~0.3"
    return w


skanks = [REST if i < 2 else skank(ch, 0.55) if i == 12 else skank(ch) for i, ch in enumerate(FORM)]

# A skank chord thrown into the echo at the end of some bars.
skank_throws = []
for i, ch in enumerate(FORM):
    if i in THROW_BARS or i == 12:
        w = ["."] * 16
        w[14] = f"{VOICING[ch]}@0.85~0.3"
        if i == 12:
            w[6] = f"{VOICING[ch]}@0.7~0.3"
        skank_throws.append(w)
    else:
        skank_throws.append(REST)

# ── organ: the skank doubled, with the bubble's sixteenth pickups ────────
BUBBLE = {"Am": "A2:min7", "Dm": "D2:min7/2", "Em": "E2:min7/2"}


def bubble(ch):
    c = BUBBLE[ch]
    w = ["."] * 16
    for i in (2, 6, 10, 14):
        w[i] = f"{c}@0.5~0.6"
    for i in (3, 7, 11, 15):
        w[i] = f"{c}@0.22~0.3"
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

# ── dub siren ─────────────────────────────────────────────────────────────
WAIL = bar("A5@0.5~4 . . . E6@0.5~4!GLD40 . . . A5@0.5~4!GLD40 . . . E6@0.45~4!GLD40 . . .")
RISE = bar(". . . . . . . . A5@0.4~2 . C6@0.45~2!GLD20 . E6@0.5~2!GLD20 . A6@0.5~2!GLD30 .")
siren = [REST] * BARS
siren[3] = WAIL
siren[7] = RISE
siren[15] = WAIL

TRACKS = [
    # id, steps, voice node type, params
    ("drums", song(drums), "music/drum-kit", {"level": 0.85, "pan": 0, "tune": -2, "decay": 1.05, "reverbSend": 0.12}),
    ("bass", song(bass), "music/fm-voice", {"preset": "Dub Bass", "voices": 1, "level": 1.0, "pan": 0}),
    ("skank", song(skanks), "music/fm-voice", {"preset": "SLOOP · CLAV", "level": 0.5, "pan": -0.3, "reverbSend": 0.22}),
    ("organ", song(organ), "music/fm-voice", {"preset": "Felucca · ORGAN", "level": 0.26, "pan": 0.35, "reverbSend": 0.15}),
    ("bongos", song(bongos), "music/drum-kit", {"level": 0.45, "pan": 0.45, "tune": 14, "decay": 0.6, "reverbSend": 0.2}),
    ("snare_throw", song(snare_throws), "music/drum-kit", {"level": 0.35, "pan": 0, "tune": -2, "delaySend": 1, "reverbSend": 0.35}),
    ("skank_throw", song(skank_throws), "music/fm-voice", {"preset": "SLOOP · CLAV", "level": 0.3, "pan": 0.2, "delaySend": 1, "reverbSend": 0.3}),
    ("melodica", song(melodica), "music/fm-voice", {"preset": "Melodica", "level": 0.5, "pan": 0.1, "delaySend": 0.28, "reverbSend": 0.35}),
    ("siren", song(siren), "music/fm-voice", {"preset": "Chip", "level": 0.16, "pan": 0.6, "voices": 1, "delaySend": 0.6, "reverbSend": 0.4}),
]
OUT_PARAMS = {
    "master": 0.8,
    "startFrame": 0,
    "delayBeats": "0.75",
    "delayFeedback": 0.55,
    "delayTone": 0.4,
    "delayLevel": 0.75,
    "reverbSize": 0.55,
    "reverbDamp": 0.55,
    "reverbLevel": 0.45,
}
