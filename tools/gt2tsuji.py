"""gt2tsuji: a GoatTracker 2 song (.sng, GTS3–GTS5: C64 SID music) → a tsuji project of music nodes.

    python3 tools/gt2tsuji.py song.sng out.tsuji [--synth sid|fm] [--title "Song"] [--subtune 1] [--master 0.8]

The song is played the way GoatTracker's playroutine plays it (gplay.c; read in fm1-sid's port, player/gt2.c), frame
by frame at 50 Hz, and written down as tsuji notes:

  - timing: a row lasts its tempo in frames (6 by default; Fxx sets it, for all channels or, from $80, for one; Exx
    is funktempo, two tempos in turn); one step is the greatest common divisor of the row lengths used, so a song at
    tempo 6 is 4 steps a beat at 125 BPM, frame for frame. Each channel plays its own order list (repeats and
    transposes followed) once;
  - each channel × instrument is a track; a note sounds until the channel's next note or key-off — less the
    instrument's gate timer (GoatTracker's hard restart lets the gate go that many frames early), which becomes the
    note's length (~). Tone portamento (3xx) is a glide (GLD) to the new note;
  - --synth sid (the default): each instrument a SID Voice, its ADSR as it is and its tables as macros, played frame
    by frame from the note-on until they repeat (that repeat is the macro's loop): the wave table → the wave macro
    (control bytes) and the arpeggio macro (relative notes; absolute ones as 128 + the note), the pulse table → the
    pulse macro, the filter table → the cutoff macro, with the filter's type and resonance, the speed table's
    vibrato → the pitch macro (cents). The filter is the chip's, shared by its three voices: here each instrument
    that sets it gets its own;
  - --synth fm: FM Voices and the Drum Kit instead, by each instrument's waveforms and name — an approximation, the
    SID's own sound is --synth sid's.

Ignored: pattern commands other than 3 (tone portamento), E (funktempo) and F (tempo) — 1/2 (portamento), 4
(vibrato), 5/6 (ADSR), 7–C (wave, tables, filter), D (master volume) are counted and reported.

Nothing of a song is kept in tsuji: this is a converter, the music stays its authors'.
"""
import argparse
import json
import math
import sys
from collections import Counter, defaultdict

FIRSTNOTE, LASTNOTE, REST, KEYOFF, KEYON, ENDPATT = 0x60, 0xBC, 0xBD, 0xBE, 0xBF, 0xFF
REPEAT, TRANSDOWN, TRANSUP, LOOPSONG = 0xD0, 0xE0, 0xF0, 0xFF
WTBL, PTBL, FTBL, STBL = range(4)
FRAME_HZ = 50
PAL_CLOCK = 985248
MAX_MACRO = 256
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_of(gt_note: int) -> int:
    """GoatTracker's note index (C-0 = 0) → MIDI (C-0 is MIDI 12)."""
    return 12 + gt_note


def note_name(m: int) -> str:
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def freq_reg(n: float) -> float:
    """The SID frequency register for GoatTracker note index n (C-0 = 16.35 Hz)."""
    return 16.3516 * 2 ** (n / 12) * 16777216 / PAL_CLOCK


class Song:
    def __init__(self, data: bytes):
        if data[:3] != b"GTS" or data[3:4] not in (b"3", b"4", b"5"):
            sys.exit("not a GoatTracker 2 song (GTS3–GTS5)")
        self.version = data[3] - ord("0")
        text = lambda a, b: data[a:b].split(b"\0")[0].decode("latin1").strip()
        self.name, self.author, self.copyright = text(4, 36), text(36, 68), text(68, 100)
        pos = 100
        n_songs = data[pos]
        pos += 1
        self.orders = []
        for _ in range(n_songs):
            chans = []
            for _c in range(3):
                n = data[pos] + 1
                pos += 1
                chans.append(list(data[pos:pos + n]))
                pos += n
            self.orders.append(chans)
        n_ins = data[pos]
        pos += 1
        self.instr = [None]
        for i in range(n_ins):
            r = data[pos + i * 25: pos + i * 25 + 25]
            self.instr.append({
                "ad": r[0], "sr": r[1], "ptr": [r[2], r[3], r[4], r[5]], "vibdelay": r[6], "gatetimer": r[7],
                "firstwave": r[8], "name": r[9:25].split(b"\0")[0].decode("latin1").strip(),
            })
        pos += n_ins * 25
        self.lt, self.rt = [], []
        for _t in range(4):
            n = data[pos]
            pos += 1
            self.lt.append(list(data[pos:pos + n]) + [0] * (255 - n))
            self.rt.append(list(data[pos + n:pos + 2 * n]) + [0] * (255 - n))
            pos += 2 * n
        n_patt = data[pos]
        pos += 1
        self.patterns = []
        for _p in range(n_patt):
            n = data[pos]
            pos += 1
            raw = data[pos:pos + n * 4]
            pos += n * 4
            rows = []
            for k in range(0, len(raw), 4):
                if raw[k] == ENDPATT:
                    break
                rows.append(tuple(raw[k:k + 4]))
            self.patterns.append(rows)
        # Older versions (gsong.c loadsong): the pulse speeds were halved, and the hard restart bits moved.
        if self.version < 4:
            for i in range(255):
                if self.lt[PTBL][i] < 0x80 and self.rt[PTBL][i]:
                    s = (self.rt[PTBL][i] - 256 if self.rt[PTBL][i] >= 128 else self.rt[PTBL][i]) * 2
                    self.rt[PTBL][i] = max(-128, min(127, s)) & 0xFF
        if self.version < 5:
            for ins in self.instr[1:]:
                if ins["firstwave"] >= 0x80:
                    ins["gatetimer"] |= 0x80
                    ins["firstwave"] &= 0x7F
                if not ins["firstwave"]:
                    ins["gatetimer"] |= 0x40

    def ins(self, i):
        return self.instr[i] if 0 < i < len(self.instr) else {"ad": 0, "sr": 0, "ptr": [0, 0, 0, 0], "vibdelay": 0, "gatetimer": 2, "firstwave": 9, "name": ""}


# ── The song in time ───────────────────────────────────────────────────────

def play(song: Song, subtune: int):
    """Each channel's rows in time: (frame, note | 'off' | None, instrument, command, data), and the song's frames.

    A row's length is its tempo, as the playroutine counts it (tick tempo..0: tempo + 1 frames); Fxx and Exx apply on
    their own row. Every channel plays its order list once."""
    order = song.orders[subtune]
    tempo = [5, 5, 5]  # TEMPO = 6 − 1
    funk = [8, 5]
    toggle = [0, 0, 0]
    events = [[], [], []]
    lengths = [0, 0, 0]
    # Each channel's rows in play order, with the transposition in force.
    streams = []
    for c in range(3):
        lst = order[c]
        rows = []
        i, trans = 0, 0
        while i < len(lst) and lst[i] != LOOPSONG:
            e = lst[i]
            if TRANSDOWN <= e < LOOPSONG:
                trans = e - TRANSUP
                i += 1
                continue
            rep = 1
            if REPEAT <= e < TRANSDOWN:
                rep = e - REPEAT + 1
                i += 1
                e = lst[i]
            for _r in range(rep):
                if e < len(song.patterns):
                    for row in song.patterns[e]:
                        rows.append((row, trans))
            i += 1
        streams.append(rows)
    # Rows advance together, frame by frame, so a tempo command on one channel is in force for all from its row.
    pos = [0, 0, 0]
    next_frame = [0, 0, 0]
    frame = 0
    instr = [1, 1, 1]
    while any(pos[c] < len(streams[c]) for c in range(3)):
        starting = [c for c in range(3) if pos[c] < len(streams[c]) and next_frame[c] == frame]
        # First every row starting now (a tempo command reaches the other channels' rows of the same frame)…
        for c in starting:
            (note, ins, cmd, data), trans = streams[c][pos[c]]
            pos[c] += 1
            if ins:
                instr[c] = ins
            if cmd == 0xF:
                t = data & 0x7F
                if t >= 3:
                    t -= 1
                if data >= 0x80:
                    tempo[c] = t
                else:
                    tempo = [t, t, t]
            elif cmd == 0xE:
                if data:
                    funk = [song.lt[STBL][data - 1] - 1, song.rt[STBL][data - 1] - 1]
                tempo = [0, 0, 0]
            if note <= LASTNOTE and note >= FIRSTNOTE:
                n = (note - FIRSTNOTE + trans) & 0x7F
                events[c].append((frame, n, instr[c], cmd, data))
            elif note == KEYOFF:
                events[c].append((frame, "off", instr[c], cmd, data))
            elif cmd:
                events[c].append((frame, None, instr[c], cmd, data))
        # …then how long each lasts.
        for c in starting:
            if tempo[c] >= 2:
                length = tempo[c] + 1
            else:
                length = funk[toggle[c]] + 1
                toggle[c] ^= 1
            next_frame[c] = frame + length
            lengths[c] = next_frame[c]
        frame = min([next_frame[c] for c in range(3) if pos[c] < len(streams[c])] or [frame + 1])
    return events, max(lengths)


# ── Instruments as macros ──────────────────────────────────────────────────

def as_macro(values, loop):
    """Values a frame, and the frame the run repeats from (−1: it holds its last value) → macro text, with runs of a
    held value kept (each frame is a tick). Trailing repeats of the last value are dropped when it holds."""
    if not values:
        return ""
    if loop < 0:
        while len(values) > 1 and values[-1] == values[-2]:
            values = values[:-1]
    words = [str(v) for v in values]
    if loop >= 0:
        words.insert(loop, "|")
    return " ".join(words)


def wave_run(song: Song, ins: dict):
    """The wave table from a note-on, a frame at a time: (control byte, note offset or 128 + absolute MIDI note).
    Frame 0 is the instrument's first wave; the table starts on frame 1 (as the playroutine's note-on frame skips it)."""
    out = []
    wave = ins["firstwave"] if 0 < ins["firstwave"] < 0xFE else 0x41
    offset = 0
    out.append((wave, offset))
    ptr, wavetime = ins["ptr"][WTBL], 0
    seen = {}
    lt, rt = song.lt[WTBL], song.rt[WTBL]
    while len(out) < MAX_MACRO:
        state = (ptr, wavetime, wave, offset)
        if state in seen:
            return out, seen[state]
        seen[state] = len(out)
        if ptr:
            w, n = lt[ptr - 1], rt[ptr - 1]
            advance = True
            if w > 0x0F:
                if w < 0xE0:
                    wave = w
                elif w <= 0xEF:
                    wave = w & 0x0F
            elif wavetime != w:
                wavetime += 1
                advance = False
            if advance:
                wavetime = 0
                ptr += 1
                if ptr <= 255 and lt[ptr - 1] == 0xFF:
                    ptr = rt[ptr - 1]
                if not (0xF0 <= w <= 0xFE) and n != 0x80:
                    if n < 0x80:
                        offset = n if n < 0x60 else n - 0x80
                    else:
                        offset = 128 + midi_of(n & 0x7F)
        out.append((wave, offset))
    return out, -1


def pulse_run(song: Song, ins: dict, start: int = 0x800):
    """The pulse table from a note-on, a frame at a time: the width (12 bits)."""
    ptr = ins["ptr"][PTBL]
    if not ptr:
        return None, -1
    lt, rt = song.lt[PTBL], song.rt[PTBL]
    pulse, ptime = start, 0
    out, seen = [], {}
    while len(out) < MAX_MACRO:
        state = (ptr, ptime, pulse)
        if state in seen:
            return out, seen[state]
        seen[state] = len(out)
        if ptr and lt[ptr - 1] == 0xFF:
            ptr = rt[ptr - 1]
        if ptr:
            if not ptime:
                if lt[ptr - 1] >= 0x80:
                    pulse = ((lt[ptr - 1] & 0x0F) << 8) | rt[ptr - 1]
                    ptr += 1
                else:
                    ptime = lt[ptr - 1]
            if ptime:
                sp = rt[ptr - 1]
                pulse = (pulse + (sp if sp < 0x80 else sp - 0x100)) & 0xFFF
                ptime -= 1
                if not ptime:
                    ptr += 1
        out.append(pulse)
    return out, -1


def filter_run(song: Song, ins: dict):
    """The filter table from a note-on: the cutoff a frame (11 bits), and the type and resonance it sets."""
    ptr = ins["ptr"][FTBL]
    if not ptr:
        return None, -1, 0, 0
    lt, rt = song.lt[FTBL], song.rt[FTBL]
    cutoff, ftime, ftype, ctrl = 0, 0, 0, 0
    out, seen = [], {}
    while len(out) < MAX_MACRO:
        state = (ptr, ftime, cutoff)
        if state in seen:
            return out, seen[state], ftype, ctrl
        seen[state] = len(out)
        if ptr and lt[ptr - 1] == 0xFF:
            ptr = rt[ptr - 1]
        if ptr:
            if not ftime:
                if lt[ptr - 1] >= 0x80:
                    ftype = lt[ptr - 1] & 0x70
                    ctrl = rt[ptr - 1]
                    ptr += 1
                    if lt[ptr - 1] == 0x00:
                        cutoff = rt[ptr - 1]
                        ptr += 1
                elif lt[ptr - 1]:
                    ftime = lt[ptr - 1]
                else:
                    cutoff = rt[ptr - 1]
                    ptr += 1
            if ftime:
                cutoff = (cutoff + rt[ptr - 1]) & 0xFF
                ftime -= 1
                if not ftime:
                    ptr += 1
        out.append(cutoff * 8)
    return out, -1, ftype, ctrl


def vibrato_run(song: Song, ins: dict, ref_note: int):
    """The instrument's vibrato (its speed table entry, after its delay), in cents, a frame at a time."""
    param = ins["ptr"][STBL]
    if not param or not ins["vibdelay"]:
        return None, -1
    cmp_, speed = song.lt[STBL][param - 1], song.rt[STBL][param - 1]
    f = freq_reg(ref_note)
    if cmp_ >= 0x80:
        cmp_ &= 0x7F
        speed = (freq_reg(ref_note + 1) - f) / 2 ** speed
    out = [0] * max(0, ins["vibdelay"] - 1)
    vibtime, off = 0, 0.0
    start = len(out)
    seen = {}
    while len(out) < MAX_MACRO:
        state = (vibtime, round(off, 3))
        if state in seen:
            return out, seen[state]
        seen[state] = len(out)
        if vibtime < 0x80 and vibtime > cmp_:
            vibtime ^= 0xFF
        vibtime = (vibtime + 2) & 0xFF
        off += -speed if vibtime & 1 else speed
        out.append(round(1200 * math.log2(max(1e-6, (f + off) / f))))
    return out, start


def sid_params(song: Song, ins: dict, ref_note: int) -> dict:
    waves, wloop = wave_run(song, ins)
    params = {
        "attack": ins["ad"] >> 4, "decay": ins["ad"] & 15, "sustain": ins["sr"] >> 4, "release": ins["sr"] & 15,
        "tickRate": "50", "volume": 15, "pwSpeed": 0,
    }
    # The waveform shown: the first with one (the first frame is often $09, gate and test bit: the hard restart).
    first = next((w for w, _ in waves if w & 0xF0), waves[0][0])
    for wid, bit in (("triangle", 0x10), ("saw", 0x20), ("pulse", 0x40), ("noise", 0x80), ("ring", 0x04), ("sync", 0x02)):
        params[wid] = bool(first & bit)
    params["macroWave"] = as_macro([format(w, "02X") for w, _ in waves], wloop)
    arps = [o for _, o in waves]
    params["macroArp"] = "" if all(a == 0 for a in arps) else as_macro(arps, wloop)
    pulses, ploop = pulse_run(song, ins)
    if pulses:
        params["pulseWidth"] = pulses[0]
        params["macroPulse"] = as_macro(pulses, ploop)
    else:
        params["pulseWidth"] = 0x800
        params["macroPulse"] = ""
    cutoffs, floop, ftype, ctrl = filter_run(song, ins)
    params["filter"] = bool(cutoffs) and bool(ctrl & 0x0F)
    if cutoffs:
        params.update({
            "cutoff": cutoffs[0], "macroCutoff": as_macro(cutoffs, floop), "resonance": ctrl >> 4,
            "lowPass": bool(ftype & 0x10), "bandPass": bool(ftype & 0x20), "highPass": bool(ftype & 0x40),
        })
    else:
        params["macroCutoff"] = ""
    vib, vloop = vibrato_run(song, ins, ref_note)
    params["macroPitch"] = as_macro(vib, vloop) if vib else ""
    # The ring and sync partners: the chip's neighbouring voice — here the voice's own oscillator, an octave and
    # a fifth for a ring, an octave up for a sync.
    params["ringRatio"] = 1.5
    params["syncRatio"] = 2
    return params


# ── FM: the nearest of tsuji's sounds ──────────────────────────────────────

DRUM_NAMES = (("kick", "kick"), ("bd", "kick"), ("bass drum", "kick"), ("sner", "snare"), ("snare", "snare"), ("snr", "snare"),
              ("clap", "clap"), ("hat", "hat"), ("hh", "hat"), ("tom", "tomlow"), ("crash", "openhat"), ("cymb", "openhat"))


def fm_role(song: Song, ins: dict):
    """An instrument → ("drum", drum name) or ("fm", preset, voices)."""
    name = ins["name"].lower()
    waves, _ = wave_run(song, ins)
    kinds = Counter()
    for w, _o in waves[:12]:
        for bit, k in ((0x80, "noise"), (0x40, "pulse"), (0x20, "saw"), (0x10, "tri")):
            if w & bit:
                kinds[k] += 1
    for key, drum in DRUM_NAMES:
        if key in name:
            return ("drum", drum)
    if kinds["noise"] >= 3 and kinds["noise"] >= sum(kinds.values()) / 2:
        return ("drum", "hat" if (ins["ad"] & 15) < 6 else "snare")
    if "bass" in name or "base" in name:
        return ("fm", "Felucca · BASS", 1)
    if "flute" in name or (kinds["tri"] and not kinds["saw"] and not kinds["pulse"]):
        return ("fm", "Felucca · FLUTE", 1)
    if "chord" in name or "pad" in name or "string" in name or "violin" in name:
        return ("fm", "SLOOP · GLASS PAD", 1)
    if kinds["saw"]:
        return ("fm", "Lead", 1)
    return ("fm", "Chip", 1)


# ── The project ────────────────────────────────────────────────────────────

def compact(words):
    out, run = [], 0
    for w in words + [None]:
        if w == ".":
            run += 1
            continue
        if run:
            out.append(f".*{run}" if run >= 4 else " ".join(["."] * run))
            run = 0
        if w is not None:
            out.append(w)
    return " ".join(out) or "."


def convert(song: Song, subtune: int, synth: str, title: str, master: float):
    events, total = play(song, subtune)
    # The step: the greatest common divisor of every row's start (frames), so each lands on a step.
    unit = 0
    for c in range(3):
        for e in events[c]:
            unit = math.gcd(unit, e[0])
    unit = math.gcd(unit, total) or 6
    steps_per_beat = 24 // unit if 24 % unit == 0 else 24
    unit = 24 // steps_per_beat
    bpm = FRAME_HZ * 60 / 24  # 24 frames a beat: 125 BPM, the step `unit` frames
    n_steps = total // unit + 1
    if n_steps > 65536:
        sys.exit(f"{n_steps} steps: past tsuji's longest pattern")

    ignored = Counter()
    tracks = {}  # (channel, instrument) → step → word
    used_notes = defaultdict(Counter)
    for c in range(3):
        evs = events[c]
        last = None  # (track key, midi)
        for k, (frame, note, ins, cmd, data) in enumerate(evs):
            if cmd and cmd not in (3, 0xE, 0xF):
                ignored[f"{cmd:X}xx"] += 1
            if note is None:
                continue
            if note == "off":
                if last:
                    hr = song.ins(last[0][1])["gatetimer"] & 0x3F
                    tracks[last[0]].setdefault(max(0, (frame - hr)) // unit, "off")
                last = None
                continue
            m = midi_of(note)
            key = (c, ins)
            used_notes[ins][m] += 1
            toneporta = cmd == 3 and last is not None and last[0] == key
            # Its length: to the channel's next note or key-off, less the gate timer the hard restart takes.
            nxt = next((e for e in evs[k + 1:] if e[1] is not None), None)
            end = nxt[0] if nxt else total
            if nxt and nxt[1] != "off" and nxt[3] != 3:
                nins = song.ins(nxt[2])
                if not (nins["gatetimer"] & 0x40):
                    end -= nins["gatetimer"] & 0x3F
            elif nxt and nxt[1] == "off":
                end -= song.ins(ins)["gatetimer"] & 0x3F
            length = max(1, end - frame) / unit
            word = note_name(m)
            if toneporta:
                speed = song.rt[STBL][data - 1] if data else 0
                word += f"!GLD{max(1, min(50, round(speed and 6 or 1)))}"
            word += f"~{round(length, 2):g}"
            words = tracks.setdefault(key, {})
            words[frame // unit] = word
            # A note on another track of the channel ends this one (a voice of the chip plays one note).
            if last and last[0] != key:
                tracks[last[0]].setdefault(frame // unit, "off")
            last = (key, m)

    nodes, links = [], []

    def node(node_id, node_type, x, y, **params):
        nodes.append({"id": node_id, "type": node_type, "position": {"x": x, "y": y}, "params": params})

    node("clock", "music/clock", 40, 300, bpm=bpm, swing=0, stepsPerBeat=str(steps_per_beat))
    keys = sorted(tracks)
    lead = None
    for i, (c, ins_no) in enumerate(keys):
        ins = song.ins(ins_no)
        tid = f"ch{c + 1}_i{ins_no}"
        y = 40 + i * 150
        words = [tracks[(c, ins_no)].get(s, ".") for s in range(n_steps)]
        node(f"pat_{tid}", "music/pattern", 300, y, steps=compact(words), length=str(n_steps), name=f"{tid} {ins['name']}".strip())
        ref = used_notes[ins_no].most_common(1)[0][0] - 12 if used_notes[ins_no] else 48
        pan = [-0.35, 0, 0.35][c]
        if synth == "sid":
            node(f"voice_{tid}", "music/sid", 560, y, preset="Saw Lead", level=0.75, pan=pan, voices=1, transpose=0,
                 model="6581", reverbSend=0.08, **sid_params(song, ins, ref))
        else:
            role = fm_role(song, ins)
            if role[0] == "drum":
                drum = role[1]
                # The track's notes become that drum.
                tracks_words = [w if w in (".", "off") else drum + w[len(w.split("~")[0].split("!")[0]):] for w in words]
                nodes[-1]["params"]["steps"] = compact([w.split("~")[0] if w not in (".", "off") else w for w in tracks_words])
                node(f"voice_{tid}", "music/drum-kit", 560, y, level=0.8, pan=pan, reverbSend=0.06)
            else:
                node(f"voice_{tid}", "music/fm-voice", 560, y, preset=role[1], voices=role[2], level=0.55, pan=pan, reverbSend=0.12)
        if lead is None:
            lead = f"pat_{tid}"
        links += [("clock", "clock", f"pat_{tid}", "clock"), (f"pat_{tid}", "sequence", f"voice_{tid}", "sequence"), (f"voice_{tid}", "track", "out", f"track{i}")]

    seconds = total / FRAME_HZ
    node("out", "music/out", 820, 300, master=master, startFrame=0, reverbSize=0.35, reverbLevel=0.3, delayLevel=0.4)
    node("render", "render", 820, 600, frameCount=math.ceil(seconds * 30), fps=30, motionBlur=0, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
    proj = {
        "canvases": [{
            "nodes": nodes,
            "connections": [{"id": f"c{i}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb} for i, (a, sa, b, sb) in enumerate(links)],
            "keyframes": {}, "markers": [], "exposedParams": [],
        }],
        "activeCanvas": 0,
    }
    info = {
        "title": title or song.name, "steps": n_steps, "steps_per_beat": steps_per_beat, "seconds": seconds,
        "tracks": len(keys), "ignored": ignored, "instruments": {k[1]: song.ins(k[1])["name"] for k in keys},
    }
    return proj, info


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("song")
    ap.add_argument("out")
    ap.add_argument("--synth", choices=["sid", "fm"], default="sid")
    ap.add_argument("--title", default="")
    ap.add_argument("--subtune", type=int, default=1)
    ap.add_argument("--master", type=float, default=None, help="Music Out's master (default: 1.1 for sid, 0.8 for fm)")
    args = ap.parse_args()
    song = Song(open(args.song, "rb").read())
    sub = max(1, min(len(song.orders), args.subtune)) - 1
    master = args.master if args.master is not None else (1.1 if args.synth == "sid" else 0.8)
    proj, info = convert(song, sub, args.synth, args.title, master)
    with open(args.out, "w") as f:
        json.dump(proj, f, indent=1)
        f.write("\n")
    print(f"{info['title']} — {song.author} ({song.copyright}): {info['seconds']:.1f} s, {info['steps']} steps "
          f"({info['steps_per_beat']} a beat at 125 BPM), {info['tracks']} tracks, --synth {args.synth}")
    for k, name in sorted(info["instruments"].items()):
        print(f"  {k:>2} {name}")
    if info["ignored"]:
        print("  pattern commands not converted:", dict(info["ignored"]))


if __name__ == "__main__":
    main()
