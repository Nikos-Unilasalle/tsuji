"""摇篮谣 (Yáolán Yáo, a Chinese lullaby) from a two-hand piano MIDI into tsuji — twice:

1. `music-local/yaolanyao.tsuji`, the transcription: the piano as written, nothing added.
   - The clock runs at 8 steps a beat (a 32nd note), so the 32nd-note run of bar 28 is on the grid; the triplet grace
     notes before a beat (the left thumb's pickups) come late in their step by `!DLYn`.
   - An Order List: one pattern per bar, a bar heard twice the same way (both hands) written once.
   - The ritenuto of bar 59 (one beat at half tempo) is that bar's own length: 40 steps instead of 32, its last beat
     stretched. The last bar is long enough for the fermata to ring.
   - The sustain pedal (left hand) lengthens the notes it holds. A track plays one note at a time, so each hand's notes
     go to as few tracks as hold them (oldest note given up first when there are not enough).
2. `demo_music_yaolanyao_arrangement.tsuji`, the demo: the same piano with an accompaniment grown around it by the music nodes:
   - the harmony, read off the left hand bar by bar, as one Progression (with the modal bridge: bVI bII bV);
   - a glass pad voice-led from it, a harp arpeggiating it, a low bowed bass on its roots;
   - a kalimba counter-melody by first-species Counterpoint under the tune when it sings high, and a celesta echoing the tune;
   - tubular bells on the bridge's chords, a whispered shaker at the climax;
   - Sections bring each in and out, so the lullaby stays light: the intro and the coda are almost the piano alone.

The MIDI is read without any library. Run:

    python3 tools/yaolanyao2tsuji.py yaolanyao_midi/yaolanyao_D_full.mid [out_dir]

The arrangement is written to public/demos/ (or out_dir); the plain transcription, kept as a reference, to
music-local/ (ignored by git).
"""
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── MIDI ─────────────────────────────────────────────────────────────────────


def _vlq(d, i):
    v = 0
    while True:
        b = d[i]
        i += 1
        v = (v << 7) | (b & 0x7F)
        if b < 0x80:
            return v, i


def read_midi(path):
    """→ (ticks per beat, tempo changes [(tick, bpm)], tracks [[(start, dur, note, vel)]], pedal [[(tick, down)]])."""
    d = Path(path).read_bytes()
    if d[:4] != b"MThd":
        sys.exit(f"{path}: not a MIDI file")
    _, ntr, div = struct.unpack(">HHH", d[8:14])
    i = 14
    tempos, tracks, pedals = [], [], []
    for _ in range(ntr):
        if d[i:i + 4] != b"MTrk":
            sys.exit(f"{path}: broken track header at byte {i} (was the file saved as text?)")
        ln = struct.unpack(">I", d[i + 4:i + 8])[0]
        j, end, i = i + 8, i + 8 + ln, i + 8 + ln
        tick, rs, on, notes, pedal = 0, None, {}, [], []
        while j < end:
            dt, j = _vlq(d, j)
            tick += dt
            st = d[j]
            if st == 0xFF:
                ty = d[j + 1]
                n, k = _vlq(d, j + 2)
                if ty == 0x51:
                    tempos.append((tick, 60e6 / int.from_bytes(d[k:k + n], "big")))
                j = k + n
                continue
            if st in (0xF0, 0xF7):
                n, k = _vlq(d, j + 1)
                j = k + n
                continue
            if st & 0x80:
                rs = st
                j += 1
            ty = rs & 0xF0
            if ty in (0xC0, 0xD0):
                j += 1
                continue
            a, b = d[j], d[j + 1]
            j += 2
            if ty == 0x90 and b > 0:
                on.setdefault(a, []).append((tick, b))
            elif ty in (0x80, 0x90):
                if on.get(a):
                    s, v = on[a].pop(0)
                    notes.append((s, tick - s, a, v))
            elif ty == 0xB0 and a == 64:
                pedal.append((tick, b >= 64))
        if notes:
            tracks.append(sorted(notes))
            pedals.append(pedal)
    return div, sorted(tempos), tracks, pedals


# ── Time: ticks → steps, a slower beat stretched ─────────────────────────────

STEPS_PER_BEAT = 8


def make_warp(div, tempos):
    """Tick → grid position in steps. The song's tempo is its first; a stretch at another tempo is lengthened (or
    shortened) by the ratio, so a ritenuto becomes more steps, at the song's tempo."""
    base = tempos[0][1]
    pts = [(t, bpm) for t, bpm in tempos]
    step_ticks = div / STEPS_PER_BEAT

    def warp(tick):
        pos, last_t, last_bpm = 0.0, 0, base
        for t, bpm in pts:
            if t >= tick:
                break
            pos += (t - last_t) * base / last_bpm
            last_t, last_bpm = t, bpm
        pos += (tick - last_t) * base / last_bpm
        return pos / step_ticks

    return base, warp


# ── Notes → tracks ──────────────────────────────────────────────────────────


def apply_pedal(notes, pedal):
    """A note released while the pedal is down sounds on until the pedal comes up."""
    out = []
    for s, d, n, v in notes:
        e = s + d
        down = False
        for t, dn in pedal:
            if t > e:
                break
            down = dn
        if down:
            nxt = next((t for t, dn in pedal if t > e and not dn), None)
            if nxt is not None:
                e = nxt
        out.append((s, e - s, n, v))
    return out


def to_events(notes, warp):
    """→ [(start step, delay 0–15, length steps, note, velocity 0–1)] on the grid."""
    ev = []
    for s, d, n, v in notes:
        a, b = warp(s), warp(s + d)
        step = int(a + 1e-6)
        dly = round((a - step) * 16)
        if dly >= 16:
            step, dly = step + 1, 0
        ev.append((step, dly, round(b - a, 1), n, min(1.0, v / 70)))
    return sorted(ev, key=lambda e: (e[0], e[1], -e[3]))


def allocate(events, max_tracks):
    """Notes struck together with the same length make one cell (A4+F#5); each cell goes to the first track that is
    free (its note has ended), else the one whose note began longest ago. → per track, {step: word}."""
    groups = {}
    for st, dly, ln, n, v in events:
        groups.setdefault((st, dly, ln), []).append((n, v))
    tracks = [dict() for _ in range(max_tracks)]
    busy = [(-1.0, -1.0)] * max_tracks   # (end, start) of each track's note
    for (st, dly, ln) in sorted(groups, key=lambda k: (k[0], k[1], -max(n for n, _ in groups[k]))):
        g = sorted(groups[(st, dly, ln)], key=lambda x: -x[0])
        t0 = st + dly / 16
        free = [k for k in range(max_tracks) if busy[k][0] <= t0 + 0.05 and st not in tracks[k]]
        k = free[0] if free else min((k for k in range(max_tracks) if st not in tracks[k]), key=lambda k: busy[k][1])
        tracks[k][st] = word(g, ln, dly)
        busy[k] = (t0 + ln, t0)
    return [t for t in tracks if t]


NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def nn(m):
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def word(group, ln, dly):
    notes = "+".join(nn(n) for n, _ in group)
    vs = [round(v, 2) for _, v in group]
    vel = f"@{vs[0]}" if len(set(vs)) == 1 else "@" + ",".join(str(v) for v in vs)
    return f"{notes}{vel}~{ln:g}" + (f"!DLY{dly}" if dly else "")


def melody_line(events):
    """The tune alone: at each onset the highest note, skipping the inner voice under a held melody note."""
    line, end, top = [], -1.0, -1
    for st, dly, ln, n, v in sorted(events, key=lambda e: (e[0] + e[1] / 16, -e[3])):
        t = st + dly / 16
        if line and abs(line[-1][0] + line[-1][1] / 16 - t) < 1e-6:
            continue                                 # same onset: the highest came first
        if t < end - 0.5 and n < top:
            continue                                 # under a melody note still sounding
        line.append((st, dly, ln, n, v))
        end, top = t + ln, n
    return {st: word([(n, v)], ln, dly) for st, dly, ln, n, v in line}


def compact(words):
    out, run = [], 0
    for w in words:
        if w == ".":
            run += 1
            continue
        if run:
            out += ["."] * run if run < 4 else [f".*{run}"]
            run = 0
        out.append(w)
    if run:
        out += ["."] * run if run < 4 else [f".*{run}"]
    return " ".join(out)


# ── The graph ───────────────────────────────────────────────────────────────


class Graph:
    def __init__(self):
        self.nodes, self.conns, self.tracks = [], [], []

    def node(self, id, ntype, x, y, **params):
        self.nodes.append({"id": id, "type": ntype, "position": {"x": x, "y": y}, "params": params})
        return id

    def wire(self, a, b, fs="sequence", ts="sequence"):
        self.conns.append({"id": f"c{len(self.conns)}", "fromNode": a, "fromSocket": fs, "toNode": b, "toSocket": ts})

    def voice(self, id, x, y, src, fs="sequence", **params):
        self.node(id, "music/fm-voice", x, y, **params)
        self.wire(src, id, fs)
        self.tracks.append(id)
        return id

    def doc(self):
        return {"canvases": [{"nodes": self.nodes, "connections": self.conns, "keyframes": {}, "markers": [], "exposedParams": []}], "activeCanvas": 0}


BAR = 4 * STEPS_PER_BEAT


def build(midi_path):
    div, tempos, tracks, pedals = read_midi(midi_path)
    bpm, warp = make_warp(div, tempos)
    # The hands: the higher track is the right hand. The pedal is the left hand's (the right's melody stays clear).
    rh_i = max(range(len(tracks)), key=lambda k: sum(n for _, _, n, _ in tracks[k]) / len(tracks[k]))
    lh_i = 1 - rh_i
    rh = to_events(tracks[rh_i], warp)
    lh = to_events(apply_pedal(tracks[lh_i], pedals[lh_i] or pedals[rh_i]), warp)
    end = max(st + dly / 16 + ln for st, dly, ln, *_ in rh + lh)
    # Bars: where each written bar falls on the grid (the ritenuto's bar is longer); the last one up to a whole number
    # of 32-step bars past the fermata, so Sections and the loop line up.
    bounds, k = [0], 1
    while bounds[-1] < end:
        bounds.append(round(warp(k * 4 * div)))
        k += 1
    total = -(-bounds[-1] // BAR) * BAR
    bounds[-1] = total
    return dict(bpm=round(bpm), rh=rh, lh=lh, bounds=bounds, total=total)


def piano(g, song, bank_x=300, voice_x=820, y0=0, rh_preset="SLOOP · FM GRAND", lh_preset="SLOOP · FM GRAND", level=1.0, rev=0.3):
    """The transcription: an Order List and one Pattern per track, each to an FM voice. → the melody-line node."""
    bounds, total = song["bounds"], song["total"]
    parts = [("RH", t) for t in allocate(song["rh"], 4)] + [("LH", t) for t in allocate(song["lh"], 4)]
    mel = melody_line(song["rh"])
    words_of = lambda cells: [cells.get(i, ".") for i in range(total)]
    all_words = [words_of(c) for _, c in parts]
    # Bars heard the same way in every track are one pattern.
    seen, order, sections, lengths = {}, [], [], {}
    for a, b in zip(bounds, bounds[1:]):
        key = tuple(tuple(w[a:b]) for w in all_words)
        if key not in seen:
            seen[key] = len(seen)
            lengths[seen[key]] = b - a
        order.append(seen[key])
    uniq = {v: k for k, v in seen.items()}
    g.node("clock", "music/clock", -300, y0 + 300, bpm=song["bpm"], swing=0, stepsPerBeat=str(STEPS_PER_BEAT))
    g.node("order", "music/order", -40, y0 + 300, order=" ".join(f"{n:02d}" for n in order), length=str(BAR),
           lengths=" ".join(str(lengths[n] if lengths[n] != BAR else 0) for n in range(len(uniq))))
    g.wire("clock", "order", "clock", "clock")
    counts = {"RH": 0, "LH": 0}
    for k, (hand, _) in enumerate(parts):
        counts[hand] += 1
        name = f"Piano {hand} {counts[hand]}"
        pid = f"pat_{hand.lower()}{counts[hand]}"
        y = y0 + k * 150
        bank = " | ".join(compact(list(uniq[n][k])) for n in range(len(uniq)))
        g.node(pid, "music/pattern", bank_x, y, name=name, steps=bank, length=str(BAR))
        g.wire("order", pid, "clock", "clock")
        rh_side = hand == "RH"
        g.voice(f"v_{hand.lower()}{counts[hand]}", voice_x, y, pid, name=name, preset=rh_preset if rh_side else lh_preset,
                level=round(level * (0.62 if rh_side else 0.42), 2), pan=0.12 if rh_side else -0.12, reverbSend=rev, voices=4)
    # The tune alone, one note at a time, as one long pattern: the cantus the generated parts listen to. Not heard.
    g.node("melody", "music/pattern", bank_x, y0 - 220, name="Melody line (the tune, not heard: feeds the arrangement)",
           steps=compact(words_of(mel)), length=str(total))
    g.wire("clock", "melody", "clock", "clock")
    return order, len(uniq)


def finish(g, song, title, out_path, master, palette, extra_fx=None):
    g.node("out", "music/out", 1500, 400, master=master, startFrame=0, reverbSize=0.82, reverbDamp=0.55, reverbLevel=0.5,
           delayBeats="0.75", delayFeedback=0.35, delayTone=0.35, delayLevel=0.4, **(extra_fx or {}))
    for i, t in enumerate(g.tracks):
        g.wire(t, "out", "track", f"track{i}")
    g.node("viewer", "music/viewer", 1500, 100, title=title, show=True, style="galaxy", palette=palette, intensity=0.7, ahead=6, legend=True)
    seconds = song["total"] / STEPS_PER_BEAT / song["bpm"] * 60
    g.node("env", "lighting/environment", 1500, 800, color=0x0D1020, intensity=1, background=1, ambientIntensity=0.5, sunIntensity=0.8)
    g.node("render", "render", 1500, 1000, frameCount=int(round(seconds * 30)), fps=30, motionBlur=0, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
    g.wire("env", "render", "environment", "environment")
    # A moon breathing with the tune (seen when the viewer is hidden).
    g.node("probe", "music/note-probe", 1800, 400, decay=0.6)
    g.wire("pat_rh1", "probe", "sequence", "music")
    g.node("pulse", "math/expression", 2040, 400, formula="0.8 + 0.35 * x")
    g.wire("probe", "pulse", "envelope", "x")
    g.node("to_vec", "converter/value-to-vector", 2280, 400)
    g.wire("pulse", "to_vec", "value", "value")
    g.node("xform", "transform/matrix-transform", 2520, 400)
    g.wire("to_vec", "xform", "vector", "scale")
    g.node("moon", "object/sphere", 2760, 400, color=0xF4EBD0, emissive=0x6B5B3A, emissiveIntensity=0.9)
    g.wire("xform", "moon", "matrix", "matrix")
    out_path.write_text(json.dumps(g.doc(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return seconds


# ── The arrangement ─────────────────────────────────────────────────────────

# The harmony, read off the left hand, one entry a bar (D major; :0.5 half a bar). Bar 59 is 1.25 bars long (the
# ritenuto), the last bar 2.75 (the fermata, rung out to a whole bar).
HARMONY = [
    "I", "vi", "IV:0.5 V:0.5", "I", "I",                                   # 1–5    intro
    "I", "vi", "IV", "V", "I", "vi", "IV", "V", "V7",                      # 6–14   the tune
    "I", "vi7", "IV", "V", "I", "vi7", "IV:0.5 V7:0.5", "I",               # 15–22  an octave up
    "I", "I", "vi", "IV:0.5 V7:0.5", "I", "I",                             # 23–28  its tail
    "bVImaj7", "bVImaj7", "bIImaj7", "bIImaj7", "bVmaj7", "bVmaj7", "V9", "V",   # 29–36  the bridge: Bb, Eb, Ab
    "I", "vi", "IV", "V", "I", "vi", "IV", "V7", "V7",                     # 37–45  the tune, harmonised
    "I", "vi", "IV", "V", "I", "vi", "IV:0.5 V:0.5", "I",                  # 46–53  high, the climax
    "I", "I", "vi", "IV:0.5 V7:0.5", "I", "IV:0.5 V7:0.75", "I",           # 54–60  coda
    "IV:0.5 I:2.25",                                                       # 61     plagal, and the fermata
]


def mask(n_bars, *ranges):
    on = [False] * n_bars
    for a, b in ranges:
        for i in range(a - 1, min(b, n_bars)):
            on[i] = True
    out, i = [], 0
    while i < n_bars:
        j = i
        while j < n_bars and on[j] == on[i]:
            j += 1
        out.append(("x" if on[i] else ".") + (f"*{j - i}" if j - i > 1 else ""))
        i = j
    return " ".join(out)


def arrangement(g, song):
    nb = song["total"] // BAR
    END = nb
    X = [300, 560, 820, 1080]
    y = 1500

    def sec(id, src, x, yy, name, ranges, restart=False, fs="sequence"):
        when = ", ".join(f"{a}–{min(b, 61)}" for a, b in ranges)
        g.node(id, "music/sections", x, yy, name=f"{name} · bars {when}", bars=mask(nb, *ranges), barLength=BAR, restart=restart)
        g.wire(src, id, fs)
        return id

    # Harmony: one progression, a bar a chord-length.
    g.node("prog", "music/progression", X[0], y, root="D", mode="major", source="written", numerals=" ".join(HARMONY),
           count=8, sevenths=False, tension=0.3, cadence=True, seed=0, chordLength=BAR, center=62, velocity=0.5)
    g.wire("clock", "prog", "clock", "clock")
    # Glass pad, voice-led, mid register; it breathes in with the tune and stays.
    g.node("vl_pad", "music/voice-leading", X[1], y, voices=4, low=57, high=74)
    g.wire("prog", "vl_pad", "chords")
    sec("sec_pad", "vl_pad", X[2], y, "pad", [(6, 13), (15, 53), (55, END)])
    g.voice("v_pad", X[3], y, "sec_pad", name="Glass pad", preset="SLOOP · GLASS PAD", level=0.06, pan=0, reverbSend=0.5, voices=8)
    # Low bowed bass on the roots: from the second verse; a drone under the bridge.
    sec("sec_bass", "vl_pad", X[2], y + 160, "bass", [(15, 22), (29, 36), (46, 53), (59, END)], fs="bass")
    g.voice("v_bass", X[3], y + 160, "sec_bass", name="Bowed bass", preset="Pad", level=0.2, pan=0, reverbSend=0.35, voices=2)
    # Harp: the chords arpeggiated in triplet eighths, up and down, high and open.
    g.node("vl_harp", "music/voice-leading", X[0], y + 320, voices=3, low=55, high=67)
    g.wire("prog", "vl_harp", "chords")
    g.node("arp_harp", "music/arp", X[1], y + 320, on=True, mode="updown", rate="1/8", triplet=True, octaves=2, gate=0.9, sync="grid")
    g.wire("vl_harp", "arp_harp")
    sec("sec_harp", "arp_harp", X[2], y + 320, "harp", [(15, 22), (46, 53)])
    g.voice("v_harp", X[3], y + 320, "sec_harp", name="Harp", preset="SLOOP · HARP", level=0.15, pan=-0.35, reverbSend=0.45, voices=6)

    # Under the tune when it sings high: a kalimba counter-melody, note against note, between the hands.
    g.node("cp", "music/counterpoint", X[1], y + 520, species="1", position="below", scale="major", root="D", low=62, high=76, velocity=0.5, seed=CP_SEED)
    # It is solved over its whole cantus at once, so it hears only the bars it plays in (the tune elsewhere goes
    # lower than it can sit under).
    sec("sec_cp", "melody", X[0], y + 520, "counter-melody", [(15, 21)])
    g.wire("sec_cp", "cp")
    g.voice("v_cp", X[3], y + 520, "cp", name="Kalimba", preset="SLOOP · KALIMBA", level=0.32, pan=0.4, reverbSend=0.45, voices=4)
    # A celesta answering the tune an octave up, a beat behind, in the first verse and the coda.
    g.node("echo", "music/chip-echo", X[1], y + 680, delay=STEPS_PER_BEAT * 2, level=0.5, transpose=12, detune=0)
    g.wire("melody", "echo")
    sec("sec_echo", "echo", X[2], y + 680, "celesta echo", [(6, 13), (37, 44), (55, 58)], fs="echo")
    g.voice("v_echo", X[3], y + 680, "sec_echo", name="Celesta", preset="SLOOP · CELESTA", level=0.26, pan=0.35, reverbSend=0.55, delaySend=0.15, voices=4)

    # The bridge: tubular bells on each chord's root, in the middle.
    g.node("vl_bell", "music/voice-leading", X[0], y + 860, voices=2, low=62, high=76)
    g.wire("prog", "vl_bell", "chords")
    sec("sec_bell", "vl_bell", X[2], y + 860, "bells", [(29, 36), (61, END)])
    g.voice("v_bell", X[3], y + 860, "sec_bell", name="Tubular bells", preset="SLOOP · TUBE BELL", level=0.13, pan=0.2, reverbSend=0.6, voices=4)
    # A whispered shaker at the climax: eighths, rocking (the first of each beat pair a touch louder).
    shaker = " ".join(["hat@0.34", ".", ".", ".", "hat@0.18", ".", ".", ".", "hat@0.26", ".", ".", ".", "hat@0.16", ".", ".", "."] * 2)
    g.node("shaker", "music/pattern", X[0], y + 1020, name="Shaker", steps=shaker, length=str(BAR))
    g.wire("clock", "shaker", "clock", "clock")
    sec("sec_shaker", "shaker", X[2], y + 1020, "shaker", [(46, 53)])
    g.node("kit", "music/drum-kit", X[3], y + 1020, name="Shaker", level=1.0, pan=0.25, tune=7, decay=0.5, reverbSend=0.3)
    g.wire("sec_shaker", "kit")
    g.tracks.append("kit")

CP_SEED = 179   # picked by search: the line whose notes sit best on the chords (70 % chord tones)


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "yaolanyao_midi" / "yaolanyao_D_full.mid"
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "public" / "demos"
    out_dir.mkdir(exist_ok=True)
    (ROOT / "music-local").mkdir(exist_ok=True)
    song = build(src)
    assert sum(float(w.split(":")[1]) if ":" in w else 1 for w in " ".join(HARMONY).split()) * BAR == song["total"], "harmony ≠ song length"

    g = Graph()
    order, n = piano(g, song)
    s = finish(g, song, "摇篮谣 · Yáolán Yáo", (ROOT / "music-local").resolve() / "yaolanyao.tsuji", master=1.7, palette="aurora")
    print(f"transcription: {len(g.tracks)} tracks, order of {len(order)} bars, {n} patterns, {s:.1f} s")

    g = Graph()
    piano(g, song, level=0.9, rev=0.35)
    arrangement(g, song)
    s = finish(g, song, "摇篮谣 · Yáolán Yáo — arrangement", out_dir / "demo_music_yaolanyao_arrangement.tsuji", master=1.6, palette="aurora")
    print(f"arrangement: {len(g.tracks)} tracks, {s:.1f} s")


if __name__ == "__main__":
    main()
