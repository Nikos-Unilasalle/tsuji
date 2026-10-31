"""mod2tsuji: a tracker module — ProTracker .mod (4 channels) or FastTracker II .xm — → a tsuji project of music nodes.

    python3 tools/mod2tsuji.py song.xm out.tsuji [--map map.json] [--title "Song"]

tsuji has no sampler, so the module's samples become FM voices and Drum Kit sounds; everything else — the notes, the
timing, the effects — is translated as closely as the music nodes allow. Both formats are read into one shape (a
song: an order list, patterns of rows of cells, instruments with their PCM) and converted from there:

  - timing: one step is the greatest common divisor of the speeds used, in ticks; a beat is 24 ticks (4 rows of 6),
    so speed 6 → 2 steps a row at 8 a beat, and a song changing speed every row (FastTracker's shuffle: 2, 3, 4…)
    gets one step per tick, 24 a beat, its groove intact. The song plays its order list once; Dxx (break) and Bxx
    (jump) are followed, a jump back ends it;
  - each channel × instrument is a track (a voice plays one sound); a note on a channel ends what its other tracks
    held, as a channel is monophonic. Key-off (XM), C00 and ECx end notes; a one-shot sample ends its note when it
    would run out;
  - pitch in semitones: ProTracker periods (C-2 at period 428 plays a sample at 8287 Hz) or XM notes with each
    sample's relative note and finetune (C-4 plays at 8363 Hz); the sound's own pitch is measured from its waveform
    (autocorrelation), so a note plays at the pitch the module played it;
  - 0xy (arpeggio) → the note with its +x and +y, on a track whose Arp runs at 1/64 triplet — one tick exactly — in
    played order; 1xx / 2xx (portamento; XM's linear table: xx/16 semitone a tick) and 3xx or the volume column's
    tone portamento → the pitch reached, glided to; Cxx and the volume column → velocity; EDx (note delay) → the
    note on its tick; 8xx and the volume column's panning → the track's pan (its average);
  - a drum loop (a sample of a whole beat, retriggered) is transcribed: its attacks found by band — low → kick,
    mid → snare, high → hat — and each struck on the Drum Kit at the loop's playback speed until the channel's next
    event, the hits that share a step joined with their own velocities (kick+hat@1,0.4), a late one moved by DLY.

The samples' roles are guessed from their names (bass, string, rhodes, guit, chip, snare, kick, hat, crash, loop…)
and their waveforms (noise, decay, length, the notes they play). A --map JSON replaces any of them, by instrument
number (a multi-sample XM instrument: "ins.sample"):

    {"7": {"kind": "fm", "preset": "Dub Bass", "voices": 1, "level": 0.8},
     "3": {"kind": "loop"},
     "14": {"kind": "drum", "drum": "snare"}}

Nothing of a module is kept in tsuji: this is a converter, the music stays its authors'. Check the module's rights
before sharing what it makes.
"""
import argparse
import json
import math
import struct
import sys
from collections import Counter, defaultdict

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAX_STEPS = 16384


def note_name(m: int) -> str:
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


# ── the common shape ──────────────────────────────────────────────────────

class Instrument:
    """One playable sound: its PCM (floats, −1…1), loop, volume, and how fast it plays at a pitch `s` (semitones)."""

    def __init__(self, name, pcm, loop, volume, base_rate, base_s):
        self.name = name
        self.pcm = pcm
        self.loop = loop
        self.volume = volume
        self.base_rate = base_rate
        self.base_s = base_s

    def rate(self, s: float) -> float:
        return self.base_rate * 2 ** ((s - self.base_s) / 12)


class Song:
    def __init__(self, fmt, title, channels, order, patterns, instruments, speed, bpm, linear, restart=0):
        self.fmt = fmt
        self.title = title
        self.channels = channels
        self.order = order
        # patterns[p][row][channel] = {"s": semitones | None | "off", "inst": int, "vol": 0–64 | None, "eff", "par",
        # "vpan": 0–255 | None, "vporta": speed | None}
        self.patterns = patterns
        self.instruments = instruments
        self.speed = speed
        self.bpm = bpm
        self.linear = linear


# ── ProTracker .mod ───────────────────────────────────────────────────────

PAL_C2_RATE = 7093789.2 / (2 * 428)  # 8287.14 Hz


def read_mod(data: bytes) -> Song:
    if data[1080:1084] not in (b"M.K.", b"M!K!", b"FLT4", b"4CHN"):
        sys.exit(f"not a 4-channel ProTracker module (tag {data[1080:1084]!r})")
    heads = []
    for i in range(31):
        h = 20 + i * 30
        name = data[h:h + 22].rstrip(b"\0").decode("latin1")
        length, _fine, vol, rs, rl = struct.unpack(">HbBHH", data[h + 22:h + 30])
        heads.append((name, length * 2, vol, rl * 2 > 2))
    song_len = data[950]
    order = list(data[952:952 + song_len])
    npat = max(data[952:952 + 128]) + 1
    o = 1084
    patterns = []
    for _ in range(npat):
        rows = []
        for _r in range(64):
            row = []
            for _c in range(4):
                b = data[o:o + 4]
                o += 4
                period = ((b[0] & 0x0F) << 8) | b[1]
                eff, par = b[2] & 0x0F, b[3]
                cell = {"s": 12 * math.log2(428 / period) + 60 if period else None, "inst": (b[0] & 0xF0) | (b[2] >> 4), "vol": None, "eff": eff, "par": par, "vpan": None, "vporta": None}
                if eff == 0xD:  # MOD break rows are decimal-coded
                    cell["par"] = (par >> 4) * 10 + (par & 0xF)
                row.append(cell)
            rows.append(row)
        patterns.append(rows)
    instruments = {}
    for i, (name, length, vol, loop) in enumerate(heads):
        raw = data[o:o + length]
        o += length
        if length:
            instruments[i + 1] = Instrument(name, [(b - 256 if b > 127 else b) / 128 for b in raw], loop, vol, PAL_C2_RATE, 60)
    return Song("mod", data[0:20].rstrip(b"\0").decode("latin1").strip(), 4, order, patterns, instruments, 6, 125, False)


# ── FastTracker II .xm ────────────────────────────────────────────────────

def read_xm(data: bytes) -> Song:
    if data[:17] != b"Extended Module: ":
        sys.exit("not an XM module")
    title = data[17:37].rstrip(b"\0 ").decode("latin1").strip()
    hsize = struct.unpack("<I", data[60:64])[0]
    song_len, restart, nch, npat, nins, flags, speed, bpm = struct.unpack("<8H", data[64:80])
    order = list(data[80:80 + song_len])
    o = 60 + hsize
    raw_patterns = []
    for _ in range(npat):
        hl, _pack, rows, size = struct.unpack("<IBHH", data[o:o + 9])
        pdata = data[o + hl:o + hl + size]
        o += hl + size
        grid, i = [], 0
        for _r in range(rows):
            row = []
            for _c in range(nch):
                if not pdata:
                    row.append((0, 0, 0, 0, 0))
                    continue
                b = pdata[i]
                if b & 0x80:
                    i += 1
                    vals = []
                    for bit in range(5):
                        if b & (1 << bit):
                            vals.append(pdata[i])
                            i += 1
                        else:
                            vals.append(0)
                    row.append(tuple(vals))
                else:
                    row.append(tuple(pdata[i:i + 5]))
                    i += 5
            grid.append(row)
        raw_patterns.append(grid)
    # Instruments: each sample of each becomes one Instrument, keyed "ins" (or "ins.k" past the first).
    instruments, keymaps = {}, {}
    for ins in range(1, nins + 1):
        isize = struct.unpack("<I", data[o:o + 4])[0]
        name = data[o + 4:o + 26].rstrip(b"\0 ").decode("latin1")
        ns = struct.unpack("<H", data[o + 27:o + 29])[0]
        shs = struct.unpack("<I", data[o + 29:o + 33])[0] if ns else 0
        keymap = list(data[o + 33:o + 33 + 96]) if ns else []
        so = o + isize
        heads = []
        for _s in range(ns):
            ln, _ls, ll, vol, fine, typ, _pan, rel = struct.unpack("<IIIBbBBb", data[so:so + 17])
            sname = data[so + 18:so + 40].rstrip(b"\0 ").decode("latin1")
            heads.append((ln, ll, vol, fine, typ, rel, sname))
            so += shs
        for k, (ln, ll, vol, fine, typ, rel, sname) in enumerate(heads):
            raw = data[so:so + ln]
            so += ln
            if typ & 16:
                vals = struct.unpack(f"<{ln // 2}h", raw[: ln // 2 * 2])
                acc, pcm = 0, []
                for v in vals:
                    acc = (acc + v) & 0xFFFF
                    pcm.append((acc - 65536 if acc > 32767 else acc) / 32768)
            else:
                acc, pcm = 0, []
                for v in raw:
                    acc = (acc + v) & 0xFF
                    pcm.append((acc - 256 if acc > 127 else acc) / 128)
            key = ins if k == 0 else f"{ins}.{k}"
            # C-4 plays the sample at 8363 Hz; its relative note and finetune move every note up by as much, so the
            # note that plays at 8363 Hz is C-4 minus them.
            instruments[key] = Instrument(f"{name} {sname}".strip(), pcm, (typ & 3) != 0 and ll > 2, vol, 8363, 48 - rel - fine / 128)
        keymaps[ins] = keymap
        o = so
    patterns = []
    for grid in raw_patterns:
        rows = []
        for row in grid:
            cells = []
            for (n, ins, vol, eff, par) in row:
                key = ins
                if ins and n and 0 < n < 97 and keymaps.get(ins) and keymaps[ins][n - 1]:
                    key = f"{ins}.{keymaps[ins][n - 1]}"
                cell = {"s": None, "inst": key if (ins and key in instruments) else (ins if ins else 0), "vol": None, "eff": eff, "par": par, "vpan": None, "vporta": None}
                if n == 97:
                    cell["s"] = "off"
                elif n:
                    cell["s"] = float(n - 1)  # the sample's transposition goes in through its rate
                if 0x10 <= vol <= 0x50:
                    cell["vol"] = vol - 0x10
                elif 0xC0 <= vol <= 0xCF:
                    cell["vpan"] = (vol & 0xF) * 17
                elif 0xF0 <= vol <= 0xFF:
                    cell["vporta"] = (vol & 0xF) * 16
                if eff == 0x14:  # Kxx: key off
                    cell["s"] = "off"
                cells.append(cell)
            rows.append(cells)
        patterns.append(rows)
    return Song("xm", title, nch, order, patterns, instruments, speed or 6, bpm or 125, bool(flags & 1), restart)


# ── what each instrument is ───────────────────────────────────────────────

def analyse(inst: Instrument, rate: float) -> dict:
    """Noise (zero crossings), decay, the waveform's cycle, and — for a long one-shot — the attacks, by band."""
    pcm = inst.pcm
    n = len(pcm)
    if n < 64:
        return {"zc": 0, "decay": 1, "cycle": 32, "hits": []}
    zc = sum(1 for a, b in zip(pcm, pcm[1:]) if (a < 0) != (b < 0)) / n
    q = max(1, n // 4)
    first = sum(abs(x) for x in pcm[:q]) / q
    last = sum(abs(x) for x in pcm[-q:]) / q
    start = min(n // 4, 2000)
    seg = pcm[start:start + 4096]
    best, lag = 0.0, 32
    for L in range(8, min(1200, len(seg) // 2)):
        c = sum(seg[j] * seg[j + L] for j in range(0, len(seg) - L, 3))
        if c > best:
            best, lag = c, L
    return {"zc": zc, "decay": last / max(1e-9, first), "cycle": lag, "hits": onsets(pcm, rate) if n / rate > 0.6 and not inst.loop else []}


def onsets(pcm, rate):
    """Attacks of a drum loop: (sample index, drum, velocity), found on three bands' envelopes."""
    def pole(hz):
        return 1 - math.exp(-2 * math.pi * hz / rate)

    lo_c, mid_lo_c, mid_hi_c, hi_c, env_c = pole(120), pole(300), pole(3000), pole(6000), pole(1 / 0.004)
    lo = mlo = mhi = hil = 0.0
    e = [0.0, 0.0, 0.0]
    hop = max(1, int(rate / 1000))  # an envelope point every millisecond
    envs = [[], [], []]
    for i, x in enumerate(pcm):
        lo += (x - lo) * lo_c
        mlo += (x - mlo) * mid_lo_c
        mhi += (x - mhi) * mid_hi_c
        hil += (x - hil) * hi_c
        bands = (lo, mhi - mlo, x - hil)
        for b in range(3):
            e[b] += (abs(bands[b]) - e[b]) * env_c
        if i % hop == 0:
            for b in range(3):
                envs[b].append(e[b])
    names = ("kick", "snare", "hat")
    hits = []
    for b in range(3):
        env = envs[b]
        peak = max(env) or 1
        last = -1000
        for k in range(20, len(env)):
            if env[k] > 0.22 * peak and env[k] > 1.8 * env[k - 20] and k - last > 70:
                top = max(env[k:k + 15])
                hits.append((k * hop, names[b], round(min(1.0, 0.35 + 0.65 * top / peak), 2)))
                last = k
    # A snare hit right on a kick is the kick's own body: keep the kick.
    kicks = [h[0] for h in hits if h[1] == "kick"]
    hits = [h for h in hits if not (h[1] == "snare" and any(abs(h[0] - k) < 0.03 * rate for k in kicks))]
    return sorted(hits)


NAME_ROLES = [
    (("kick", "bd", "bassdrum"), {"kind": "drum", "drum": "kick"}),
    (("snare", "sd", "clap"), {"kind": "drum", "drum": "snare"}),
    (("hat", "hh", "shaker"), {"kind": "drum", "drum": "hat"}),
    (("crash", "cymbal", "ride"), {"kind": "drum", "drum": "openhat"}),
    (("bass",), {"kind": "fm", "preset": "Felucca · BASS", "voices": 1}),
    (("rhodes", "piano", "e.p", "ep "), {"kind": "fm", "preset": "SLOOP · RHODES"}),
    (("string", "pad", "choir", "vox"), {"kind": "fm", "preset": "SLOOP · GLASS PAD"}),
    (("guit", "lead"), {"kind": "fm", "preset": "Lead"}),
    (("chip", "square"), {"kind": "fm", "preset": "Chip"}),
    (("organ",), {"kind": "fm", "preset": "Felucca · ORGAN"}),
    (("bell",), {"kind": "fm", "preset": "Bell"}),
]


def guess_role(inst: Instrument, a: dict, notes: Counter) -> dict:
    lname = inst.name.lower()
    # The name first: "disco.snare" is a snare, however many attacks its tail has.
    for words, role in NAME_ROLES:
        if any(w in lname for w in words):
            return dict(role)
    if len(a["hits"]) >= 4 and len(notes) <= 3:
        return {"kind": "loop"}
    if not inst.loop and a["decay"] < 0.35 and (len(notes) <= 3 or a["zc"] > 0.3):
        drum = "hat" if a["zc"] > 0.33 else "snare" if a["zc"] > 0.15 else "kick"
        return {"kind": "drum", "drum": drum}
    mean = sum(n * c for n, c in notes.items()) / max(1, sum(notes.values()))
    if mean < 50:
        return {"kind": "fm", "preset": "Felucca · BASS", "voices": 1}
    return {"kind": "fm", "preset": "Lead" if a["zc"] > 0.2 else "Chip"}


# ── the conversion ────────────────────────────────────────────────────────

def walk(song: Song):
    """The song's rows in play order: (position, pattern, row, speed at that row), following Dxx / Bxx."""
    speed = song.speed
    bpm = song.bpm
    pos, row = 0, 0
    seen = set()
    while pos < len(song.order):
        p = song.order[pos]
        if p >= len(song.patterns):
            pos += 1
            continue
        rows = song.patterns[p]
        jump = None
        while row < len(rows):
            if (pos, row) in seen:
                return
            seen.add((pos, row))
            for cell in rows[row]:
                if cell["eff"] == 0xF and cell["par"]:
                    if cell["par"] < 32:
                        speed = cell["par"]
                    else:
                        bpm = cell["par"]
            yield pos, p, row, speed, bpm
            for cell in rows[row]:
                if cell["eff"] == 0xD:
                    jump = (pos + 1, cell["par"])
                elif cell["eff"] == 0xB:
                    jump = (cell["par"], 0)
            if jump:
                break
            row += 1
        if jump:
            if jump[0] <= pos and jump[0] != pos + 1:
                return  # a jump back: the song loops from here — once is enough
            pos, row = jump
        else:
            pos, row = pos + 1, 0


def convert(song: Song, overrides: dict, title: str) -> dict:
    rows = list(walk(song))
    speeds = {r[3] for r in rows}
    bpm = rows[0][4] if rows else song.bpm
    unit = 0
    for s in speeds:
        unit = math.gcd(unit, s)
    unit = unit or 6
    steps_per_beat = 24 // unit if 24 % unit == 0 else 24
    step_ticks = 24 / steps_per_beat
    step_seconds = 60 / bpm / steps_per_beat

    # What each instrument plays, then what it is.
    used = defaultdict(Counter)
    last_inst = [0] * song.channels
    for _pos, p, r, _sp, _b in rows:
        for c, cell in enumerate(song.patterns[p][r]):
            if cell["inst"]:
                last_inst[c] = cell["inst"]
            if isinstance(cell["s"], float) and last_inst[c] in song.instruments:
                used[last_inst[c]][round(cell["s"])] += 1
    roles, pitch_of = {}, {}
    for key, notes in used.items():
        inst = song.instruments[key]
        common = notes.most_common(1)[0][0]
        a = analyse(inst, inst.rate(common))
        # The sounding pitch of semitone s: the playback rate over the waveform's cycle.
        pitch_of[key] = (lambda inst, cyc: (lambda s: 69 + 12 * math.log2(inst.rate(s) / cyc / 440)))(inst, a["cycle"])
        role = overrides.get(str(key)) or guess_role(inst, a, Counter({round(pitch_of[key](n)): c for n, c in notes.items()}))
        if role["kind"] == "loop":
            role = {**role, "hits": a["hits"] or onsets(inst.pcm, inst.rate(common))}
        roles[key] = role

    tracks = {}

    def track(key):
        if key not in tracks:
            c, inst, arp = key
            tracks[key] = {"words": {}, "hits": defaultdict(dict), "role": roles[inst], "arp": arp, "channel": c, "inst": inst, "pans": []}
        return tracks[key]

    def add_hit(t, at_step, drum, vel):
        step = int(at_step)
        frac = at_step - step
        cell = t["hits"][step]
        if drum not in cell or cell[drum][0] < vel:
            cell[drum] = (vel, frac)

    pans = [64 if song.fmt == "xm" else (0 if c % 4 in (0, 3) else 255) for c in range(song.channels)]
    state = [{"inst": 0, "s": 0.0, "key": None, "vel": 1.0, "arp": (0, 0), "loop": None} for _ in range(song.channels)]
    open_loops = []  # (track, start step, rate, hits, channel) — closed at the channel's next event

    def close_loop(c, at):
        for i, (t, start, rate, hits, ch) in enumerate(open_loops):
            if ch == c:
                for k, drum, vel in hits:
                    s = start + k / rate / step_seconds
                    if s >= at:
                        break
                    add_hit(t, s, drum, vel)
                del open_loops[i]
                return

    step = 0
    for _pos, p, r, speed, _b in rows:
        row_steps = max(1, round(speed / step_ticks))
        for c, cell in enumerate(song.patterns[p][r]):
            st = state[c]
            eff, par = cell["eff"], cell["par"]
            if cell["inst"]:
                st["inst"] = cell["inst"]
                if st["inst"] in song.instruments:
                    st["vel"] = song.instruments[st["inst"]].volume / 64
            if cell["vol"] is not None:
                st["vel"] = min(64, cell["vol"]) / 64
            if eff == 0xC:
                st["vel"] = min(64, par) / 64
            if eff == 0x8:
                pans[c] = par
            if cell["vpan"] is not None:
                pans[c] = cell["vpan"]
            inst = st["inst"]
            if not inst or inst not in roles:
                continue
            role = roles[inst]
            # A note delayed by EDx lands on its tick.
            at = step + ((par & 0xF) / step_ticks if eff == 0xE and (par >> 4) == 0xD else 0)
            if cell["s"] == "off" or (eff == 0xC and par == 0):
                close_loop(c, at)
                if st["key"]:
                    tracks[st["key"]]["words"][int(at)] = "off"
                    st["key"] = None
                st["arp"] = (0, 0)
                continue
            tone_porta = eff == 0x3 or cell["vporta"] is not None
            new_note = isinstance(cell["s"], float) and not tone_porta
            arp = (par >> 4, par & 0xF) if eff == 0 and par else (0, 0)
            pitch_change, glide_ticks = False, 0
            if new_note:
                st["s"] = cell["s"]
            elif eff in (0x1, 0x2) and par and st["key"]:
                ticks = speed - 1
                if song.linear:
                    delta = par / 16 * ticks
                else:
                    period = 428 * 2 ** (-(st["s"] - 60) / 12)
                    period2 = max(113.0, min(856.0, period + (-1 if eff == 0x1 else 1) * par * ticks))
                    delta = abs(12 * math.log2(period / period2))
                st["s"] += delta if eff == 0x1 else -delta
                pitch_change, glide_ticks = True, ticks
            elif tone_porta and isinstance(cell["s"], float) and st["key"]:
                spd = (cell["vporta"] or par or 16) / (16 if song.linear else 1)
                glide_ticks = max(1, round(abs(cell["s"] - st["s"]) / max(0.01, spd / (16 if not song.linear else 1))))
                st["s"] = cell["s"]
                pitch_change = True
            restrike = new_note or pitch_change or (arp != st["arp"] and st["key"]) or ((eff == 0xC or cell["vol"] is not None) and not isinstance(cell["s"], float) and st["key"])
            if not restrike:
                continue
            if role["kind"] == "loop":
                if new_note:
                    close_loop(c, at)
                    t = track((c, inst, False))
                    t["pans"].append(pans[c])
                    open_loops.append((t, at, song.instruments[inst].rate(st["s"]), role["hits"], c))
                    if st["key"] and st["key"] != (c, inst, False):
                        tracks[st["key"]]["words"].setdefault(int(at), "off")
                    st["key"] = (c, inst, False)
                continue
            close_loop(c, at)
            key = (c, inst, arp != (0, 0)) if role["kind"] == "fm" else (c, inst, False)
            if st["key"] and st["key"] != key:
                tracks[st["key"]]["words"].setdefault(int(at), "off")
            t = track(key)
            t["pans"].append(pans[c])
            if role["kind"] == "drum":
                if new_note:
                    add_hit(t, at, role["drum"], round(st["vel"], 2))
                st["key"], st["arp"] = key, (0, 0)
                continue
            midi = max(0, min(127, round(pitch_of[inst](st["s"]) + role.get("transpose", 0))))
            word = note_name(midi)
            adds = [min(127, midi + x) for x in arp if x]
            if adds:
                word += "+" + "+".join(note_name(n) for n in adds)
            word += f"@{round(st['vel'], 2)}"
            if pitch_change and glide_ticks:
                word += f"!GLD{max(1, round(glide_ticks * 60 / bpm / 24 * 100))}"
            elif eff == 0xE and (par >> 4) == 0xC:
                word += f"~{round(max(0.05, (par & 0xF) / step_ticks), 2)}"
            if new_note and not song.instruments[inst].loop:
                steps_long = len(song.instruments[inst].pcm) / song.instruments[inst].rate(st["s"]) / step_seconds
                if "~" not in word:
                    word += f"~{round(steps_long, 2)}"
            frac = at - int(at)
            if frac > 0.03 and "!" not in word:
                word += f"!DLY{min(15, round(frac * 16))}"
            t["words"][int(at)] = word
            st["key"], st["arp"] = key, arp
        step += row_steps
    for c in range(song.channels):
        close_loop(c, step)
    if step > MAX_STEPS:
        sys.exit(f"{step} steps: past tsuji's {MAX_STEPS} (a Pattern's longest)")
    # Drum hits into words: the hits of a step joined, each with its velocity; a late first hit by DLY.
    order_ = ["kick", "snare", "clap", "hat", "openhat", "tomlow", "tomhigh"]
    for t in tracks.values():
        for s, hits in t["hits"].items():
            drums = sorted(hits, key=order_.index)
            vels = [hits[d][0] for d in drums]
            word = "+".join(drums) + "@" + (str(vels[0]) if len(set(vels)) == 1 else ",".join(str(v) for v in vels))
            frac = hits[drums[0]][1]
            if frac > 0.03:
                word += f"!DLY{min(15, round(frac * 16))}"
            t["words"][s] = word
    return {
        "title": title or song.title or "module",
        "bpm": bpm,
        "steps_per_beat": steps_per_beat,
        "total_steps": step,
        "seconds": step * step_seconds,
        "tracks": tracks,
        "roles": roles,
        "names": {k: song.instruments[k].name for k in roles},
    }


def project(conv: dict, master: float = 0.8) -> dict:
    nodes, links = [], []

    def node(node_id, node_type, x, y, **params):
        nodes.append({"id": node_id, "type": node_type, "position": {"x": x, "y": y}, "params": params})

    node("clock", "music/clock", 40, 300, bpm=conv["bpm"], swing=0, stepsPerBeat=str(conv["steps_per_beat"]))
    lead_pattern = None
    keys = sorted(conv["tracks"], key=lambda k: (k[0], str(k[1]), k[2]))
    n_melodic = sum(1 for k in keys if conv["tracks"][k]["role"]["kind"] == "fm")
    for i, key in enumerate(keys):
        t = conv["tracks"][key]
        ch, inst, arp = key
        tid = f"ch{ch + 1}_i{str(inst).replace('.', '_')}" + ("_arp" if arp else "")
        y = 40 + i * 150
        words = [t["words"].get(k, ".") for k in range(conv["total_steps"])]
        if all(w in (".", "off") for w in words):
            continue
        node(f"pat_{tid}", "music/pattern", 300, y, steps=" ".join(words), length=str(conv["total_steps"]), name=tid)
        src = f"pat_{tid}"
        if arp:
            node(f"arp_{tid}", "music/arp", 560, y, on=True, mode="played", rate="1/64", triplet=True, octaves=1, gate=1, sync="retrigger")
            links.append((src, "sequence", f"arp_{tid}", "sequence"))
            src = f"arp_{tid}"
        role = t["role"]
        pan = role.get("pan", round((sum(t["pans"]) / len(t["pans"]) - 128) / 128 * 0.8, 2) if t["pans"] else 0)
        if role["kind"] in ("drum", "loop"):
            node(f"voice_{tid}", "music/drum-kit", 820, y, level=role.get("level", 0.75), pan=pan, reverbSend=role.get("reverbSend", 0.08))
        else:
            # Many channels add up: each a little lower the more there are.
            level = role.get("level", round(0.6 / max(1, n_melodic) ** 0.35, 2))
            params = {"preset": role["preset"], "level": level, "pan": pan, "reverbSend": role.get("reverbSend", 0.12), "voices": role.get("voices", 3)}
            node(f"voice_{tid}", "music/fm-voice", 820, y, **params)
            if lead_pattern is None:
                lead_pattern = f"pat_{tid}"
        links += [("clock", "clock", f"pat_{tid}", "clock"), (src, "sequence", f"voice_{tid}", "sequence"), (f"voice_{tid}", "track", "out", f"track{i}")]

    frames = math.ceil(conv["seconds"] * 30)
    node("out", "music/out", 1100, 300, master=master, startFrame=0, reverbSize=0.4, reverbLevel=0.35)
    node("probe", "music/note-probe", 1100, 40, decay=0.2)
    node("pulse", "math/expression", 1340, 40, formula="0.6 + 0.8 * x")
    node("vec", "converter/value-to-vector", 1560, 40)
    node("xf", "transform/matrix-transform", 1760, 40)
    node("orb", "object/sphere", 1960, 40, color=0x7DD3FC, emissive=0x0C4A6E, emissiveIntensity=1.2)
    node("env", "lighting/environment", 1960, 300, color=0x0B0B16, intensity=1, background=1, ambientIntensity=0.5, sunIntensity=1.0)
    node("render", "render", 1100, 600, frameCount=frames, fps=30, motionBlur=0, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
    if lead_pattern:
        links.append((lead_pattern, "sequence", "probe", "music"))
    links += [("probe", "envelope", "pulse", "x"), ("pulse", "value", "vec", "value"), ("vec", "vector", "xf", "scale"), ("xf", "matrix", "orb", "matrix"), ("env", "environment", "render", "environment")]
    # Socket numbers stay those of the tracks kept, in order.
    out_links = [l for l in links if l[2] == "out"]
    for k, l in enumerate(out_links):
        links[links.index(l)] = (l[0], l[1], "out", f"track{k}")
    return {
        "canvases": [{
            "nodes": nodes,
            "connections": [{"id": f"c{i}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb} for i, (a, sa, b, sb) in enumerate(links)],
            "keyframes": {}, "markers": [], "exposedParams": [],
        }],
        "activeCanvas": 0,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("module")
    ap.add_argument("out")
    ap.add_argument("--map", help="JSON file: instrument number → role")
    ap.add_argument("--title", default="")
    ap.add_argument("--master", type=float, default=0.8, help="Music Out's master level (lower it for a module with many channels)")
    args = ap.parse_args()
    data = open(args.module, "rb").read()
    song = read_xm(data) if data[:17] == b"Extended Module: " else read_mod(data)
    overrides = json.load(open(args.map)) if args.map else {}
    conv = convert(song, overrides, args.title)
    with open(args.out, "w") as f:
        json.dump(project(conv, args.master), f, indent=1)
        f.write("\n")
    print(f"{conv['title']} ({song.fmt}, {song.channels} channels): {conv['total_steps']} steps at {conv['bpm']} BPM ({conv['steps_per_beat']} a beat), {conv['seconds']:.1f} s, {len(conv['tracks'])} tracks")
    for key, role in sorted(conv["roles"].items(), key=lambda kv: str(kv[0])):
        shown = {k: v for k, v in role.items() if k != "hits"}
        if role["kind"] == "loop":
            shown["hits"] = f"{len(role['hits'])} ({Counter(h[1] for h in role['hits'])})"
        print(f"  {str(key):>5} {conv['names'][key]!r:32} → {shown}")


if __name__ == "__main__":
    main()
