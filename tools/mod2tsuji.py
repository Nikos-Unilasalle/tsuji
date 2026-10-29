"""mod2tsuji: a ProTracker module (.mod, 4 channels, "M.K.") → a tsuji project made of music nodes.

    python3 tools/mod2tsuji.py song.mod out.tsuji [--map map.json] [--title "Song"]

tsuji has no sampler, so the module's samples become FM voices and Drum Kit sounds; everything else — the notes, the
timing, the effects — is translated as closely as the music nodes allow:

  - timing: the speeds used (Fxx < 32) set the step: one step is their greatest common divisor in ticks, a beat is
    24 ticks (ProTracker's 4 rows of 6), so speed 6 → 2 steps a row and speed 3 → 1 at 8 steps a beat. Fxx ≥ 32 is the
    BPM. The song plays its order list once, end to end, with Dxx (pattern break) honoured;
  - each channel × sample is a track, since a voice plays one sound; a note on a channel ends whatever the channel's
    other tracks were holding (an OFF there), as the channel is monophonic;
  - 0xy (arpeggio) → the note with its +x and +y added, on a track of its own whose Arp runs at 1/64 triplet — one
    tick exactly (a beat is 24 ticks) — in played order, retriggered with the note: the chip arpeggio;
  - 1xx / 2xx (portamento up / down) and 3xx (to a note) → the pitch reached, glided to (GLD over the row);
  - Cxx → the velocity (and a mid-note volume change re-strikes the note at the new level); C00 ends the note;
  - ECx → the note cut x ticks in; a sample that does not loop ends the note when it would run out;
  - the pitch: each sample's period is measured from its waveform (autocorrelation), so a note sounds at the pitch
    the sample played it at; ProTracker's C-2 at a sample of N bytes per cycle is 8287 / N Hz.

The samples' roles are guessed from their waveforms (noise, decay, length, the notes they play): kick, snare, hat,
open hat, or a melodic voice with an FM preset by register. A --map JSON overrides any of them:

    {"5": {"kind": "fm", "preset": "Chip", "transpose": 0, "level": 0.6, "pan": -0.2},
     "4": {"kind": "drum", "drum": "kick"}}

Nothing of a module is kept in tsuji: this is a converter, the music stays its authors'. Check the module's rights
before sharing what it makes.
"""
import argparse
import json
import math
import struct
import sys
from collections import Counter, defaultdict

PAL_CLOCK = 7093789.2
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
DRUM_NOTE = {"kick": 36, "snare": 38, "clap": 39, "hat": 42, "openhat": 46, "tomlow": 45, "tomhigh": 50}


def note_name(m: int) -> str:
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def period_to_midi(period: float, cycle: float) -> float:
    """The pitch a sample with `cycle` bytes per waveform cycle sounds at, played at this Amiga period."""
    hz = PAL_CLOCK / (2 * period) / cycle
    return 69 + 12 * math.log2(hz / 440)


class Module:
    def __init__(self, data: bytes):
        if data[1080:1084] not in (b"M.K.", b"M!K!", b"FLT4", b"4CHN"):
            sys.exit(f"not a 4-channel ProTracker module (tag {data[1080:1084]!r})")
        self.title = data[0:20].rstrip(b"\0").decode("latin1").strip()
        self.samples = []
        for i in range(31):
            h = 20 + i * 30
            name = data[h:h + 22].rstrip(b"\0").decode("latin1")
            length, _fine, vol, rs, rl = struct.unpack(">HbBHH", data[h + 22:h + 30])
            self.samples.append({"name": name, "length": length * 2, "volume": vol, "loop": rl * 2 > 2, "loopStart": rs * 2})
        song_len = data[950]
        self.order = list(data[952:952 + song_len])
        npat = max(data[952:952 + 128]) + 1
        o = 1084
        self.patterns = []
        for _ in range(npat):
            rows = []
            for _r in range(64):
                row = []
                for _c in range(4):
                    b = data[o:o + 4]
                    o += 4
                    row.append({"sample": (b[0] & 0xF0) | (b[2] >> 4), "period": ((b[0] & 0x0F) << 8) | b[1], "eff": b[2] & 0x0F, "par": b[3]})
                rows.append(row)
            self.patterns.append(rows)
        for s in self.samples:
            raw = data[o:o + s["length"]]
            o += s["length"]
            s["pcm"] = [b - 256 if b > 127 else b for b in raw]


def analyse(sample: dict) -> dict:
    """Noise (zero crossings), decay (first vs last quarter) and the waveform's cycle length."""
    pcm = sample["pcm"]
    if len(pcm) < 64:
        return {"zc": 0, "decay": 1, "cycle": 32}
    zc = sum(1 for a, b in zip(pcm, pcm[1:]) if (a < 0) != (b < 0)) / len(pcm)
    q = max(1, len(pcm) // 4)
    first = sum(abs(x) for x in pcm[:q]) / q
    last = sum(abs(x) for x in pcm[-q:]) / q
    start = min(len(pcm) // 4, 200)
    seg = pcm[start:start + 2048]
    best, lag = 0, 32
    for L in range(8, min(512, len(seg) // 2)):
        c = sum(seg[j] * seg[j + L] for j in range(0, len(seg) - L, 2))
        if c > best:
            best, lag = c, L
    return {"zc": zc, "decay": last / max(1e-9, first), "cycle": lag}


def guess_role(sample: dict, a: dict, notes: Counter) -> dict:
    """A drum for a short one-shot that falls away; a melodic voice otherwise, its preset by register."""
    one_shot = not sample["loop"]
    distinct = len(notes)
    if one_shot and a["decay"] < 0.35 and (distinct <= 3 or a["zc"] > 0.3):
        drum = "hat" if a["zc"] > 0.33 else "snare" if a["zc"] > 0.15 else "kick"
        if drum == "hat" and sample["length"] > 6000:
            drum = "openhat"
        return {"kind": "drum", "drum": drum}
    mean = sum(n * c for n, c in notes.items()) / max(1, sum(notes.values()))
    pitch = period_to_midi(428, a["cycle"]) - 60 + mean  # where it sounds, roughly
    if pitch < 50:
        return {"kind": "fm", "preset": "Felucca · BASS", "voices": 1}
    if a["zc"] > 0.2:
        return {"kind": "fm", "preset": "Lead"}
    return {"kind": "fm", "preset": "Chip"}


def gcd_all(values):
    g = 0
    for v in values:
        g = math.gcd(g, v)
    return g or 6


def convert(mod: Module, overrides: dict, title: str) -> dict:
    # The row grid: speeds and tempo as the song meets them.
    speeds, bpm = set(), 125
    speed = 6
    pos_rows = []  # (position, pattern, first row, speed at each row)
    for pos, p in enumerate(mod.order):
        start = 0
        for r in range(start, 64):
            for ch in mod.patterns[p][r]:
                if ch["eff"] == 0xF and ch["par"]:
                    if ch["par"] < 32:
                        speed = ch["par"]
                    elif pos == 0 and r == 0:
                        bpm = ch["par"]
            speeds.add(speed)
    unit = gcd_all(speeds)
    steps_per_beat = 24 // unit if 24 % unit == 0 else 4
    step_ticks = 24 / steps_per_beat
    step_seconds = 60 / bpm / steps_per_beat

    # Per-sample analysis and roles.
    used_notes = defaultdict(Counter)
    for p in set(mod.order):
        for row in mod.patterns[p]:
            for ch in row:
                if ch["sample"] and ch["period"]:
                    used_notes[ch["sample"]][ch["period"]] += 1
    roles, offsets = {}, {}
    for s_idx in used_notes:
        smp = mod.samples[s_idx - 1]
        a = analyse(smp)
        offsets[s_idx] = period_to_midi(428, a["cycle"]) - 60  # vs a period-only mapping where 428 → C4
        notes = Counter({round(12 * math.log2(428 / per)) + 60: c for per, c in used_notes[s_idx].items()})
        # A role given in the map replaces the guess, it does not patch it.
        roles[s_idx] = overrides.get(str(s_idx)) or guess_role(smp, a, notes)

    tracks = {}  # key → {"words": {step: word}, "role":…, "arp": bool, "channel": c}
    def track(ch, s_idx, arp):
        key = (ch, s_idx, arp)
        if key not in tracks:
            tracks[key] = {"words": {}, "role": roles[s_idx], "arp": arp, "channel": ch, "sample": s_idx}
        return tracks[key]

    # Walk the song.
    step = 0
    speed = 6
    state = [{"sample": 0, "period": 0.0, "key": None, "vel": 1.0, "arp": (0, 0)} for _ in range(4)]
    for pos, p in enumerate(mod.order):
        break_row = None
        for r in range(64):
            row = mod.patterns[p][r]
            for ch in row:
                if ch["eff"] == 0xF and 0 < ch["par"] < 32:
                    speed = ch["par"]
            row_steps = max(1, round(speed / step_ticks))
            for c, cell in enumerate(row):
                st = state[c]
                eff, par = cell["eff"], cell["par"]
                if cell["sample"]:
                    st["sample"] = cell["sample"]
                    st["vel"] = mod.samples[cell["sample"] - 1]["volume"] / 64
                if eff == 0xC:
                    st["vel"] = min(64, par) / 64
                if eff == 0xD:
                    break_row = par
                s_idx = st["sample"]
                if not s_idx or s_idx not in roles:
                    continue
                role = roles[s_idx]
                arp = (par >> 4, par & 0xF) if eff == 0 and par else (0, 0)
                new_note = cell["period"] > 0 and eff != 0x3
                pitch_change = False
                glide_rows = 0
                if new_note:
                    st["period"] = float(cell["period"])
                elif eff in (0x1, 0x2) and par and st["key"]:
                    st["period"] = max(113.0, min(856.0, st["period"] + (-1 if eff == 0x1 else 1) * par * (speed - 1)))
                    pitch_change, glide_rows = True, 1
                elif eff == 0x3 and cell["period"] and st["key"]:
                    target = float(cell["period"])
                    ticks = abs(target - st["period"]) / max(1, par or 1)
                    st["period"] = target
                    pitch_change, glide_rows = True, max(1, round(ticks / speed))
                restrike = (new_note or pitch_change or (arp != st["arp"] and st["key"]) or (eff == 0xC and not cell["period"] and st["key"]))
                if eff == 0xC and par == 0 and st["key"]:
                    tracks[st["key"]]["words"][step] = "off"
                    st["key"] = None
                    st["arp"] = (0, 0)
                    continue
                if not restrike:
                    continue
                key = (c, s_idx, arp != (0, 0)) if role["kind"] == "fm" else (c, s_idx, False)
                # A channel plays one sound: the track it leaves stops.
                if st["key"] and st["key"] != key:
                    tracks[st["key"]]["words"].setdefault(step, "off")
                t = track(*key)
                if role["kind"] == "drum":
                    if new_note:
                        t["words"][step] = f"{role['drum']}@{round(st['vel'], 2)}"
                    st["key"] = key
                    st["arp"] = (0, 0)
                    continue
                midi = round(12 * math.log2(428 / st["period"]) + 60 + offsets[s_idx] + role.get("transpose", 0))
                midi = max(0, min(127, midi))
                word = note_name(midi)
                adds = [midi + x for x in arp if x]
                if adds:
                    word += "+" + "+".join(note_name(min(127, n)) for n in adds)
                word += f"@{round(st['vel'], 2)}"
                if pitch_change and glide_rows:
                    word += f"!GLD{max(1, round(glide_rows * row_steps * step_seconds * 100))}"
                elif eff == 0xE and (par >> 4) == 0xC:
                    word += f"~{round(max(0.05, (par & 0xF) / step_ticks), 2)}"
                if new_note and not mod.samples[s_idx - 1]["loop"]:
                    # A one-shot runs out: at this pitch, how many steps does the sample last?
                    hz = PAL_CLOCK / (2 * st["period"])
                    steps_long = mod.samples[s_idx - 1]["length"] / hz / step_seconds
                    if "~" not in word:
                        word += f"~{round(steps_long, 2)}"
                t["words"][step] = word
                st["key"] = key
                st["arp"] = arp
            step += row_steps
            if break_row is not None:
                break
    total_steps = step
    seconds = total_steps * step_seconds
    return {
        "title": title or mod.title or "MOD",
        "bpm": bpm,
        "steps_per_beat": steps_per_beat,
        "total_steps": total_steps,
        "seconds": seconds,
        "tracks": tracks,
        "roles": roles,
    }


def project(conv: dict) -> dict:
    nodes, links = [], []

    def node(node_id, node_type, x, y, **params):
        nodes.append({"id": node_id, "type": node_type, "position": {"x": x, "y": y}, "params": params})

    node("clock", "music/clock", 40, 300, bpm=conv["bpm"], swing=0, stepsPerBeat=str(conv["steps_per_beat"]))
    pans = [-0.45, 0.45, 0.45, -0.45]  # Amiga stereo: channels 1 and 4 left, 2 and 3 right (softened)
    lead_pattern = None
    keys = sorted(conv["tracks"], key=lambda k: (k[0], k[1], k[2]))
    for i, key in enumerate(keys):
        t = conv["tracks"][key]
        ch, s_idx, arp = key
        tid = f"ch{ch + 1}_s{s_idx}" + ("_arp" if arp else "")
        y = 40 + i * 150
        words = [t["words"].get(k, ".") for k in range(conv["total_steps"])]
        node(f"pat_{tid}", "music/pattern", 300, y, steps=" ".join(words), length=str(conv["total_steps"]), name=tid)
        src = f"pat_{tid}"
        if arp:
            node(f"arp_{tid}", "music/arp", 560, y, on=True, mode="played", rate="1/64", triplet=True, octaves=1, gate=1, sync="retrigger")
            links.append((src, "sequence", f"arp_{tid}", "sequence"))
            src = f"arp_{tid}"
        role = t["role"]
        if role["kind"] == "drum":
            node(f"voice_{tid}", "music/drum-kit", 820, y, level=role.get("level", 0.8), pan=role.get("pan", pans[ch] * 0.5), reverbSend=role.get("reverbSend", 0.08))
        else:
            params = {"preset": role["preset"], "level": role.get("level", 0.55), "pan": role.get("pan", pans[ch]), "reverbSend": role.get("reverbSend", 0.12)}
            if "voices" in role:
                params["voices"] = role["voices"]
            node(f"voice_{tid}", "music/fm-voice", 820, y, **params)
            if lead_pattern is None or (not arp and ch == 0):
                lead_pattern = f"pat_{tid}"
        links += [("clock", "clock", f"pat_{tid}", "clock"), (src, "sequence", f"voice_{tid}", "sequence"), (f"voice_{tid}", "track", "out", f"track{i}")]

    frames = math.ceil(conv["seconds"] * 30)
    node("out", "music/out", 1100, 300, master=0.8, startFrame=0, reverbSize=0.35, reverbLevel=0.35)
    # Something on screen: an orb that breathes with the lead.
    node("probe", "music/note-probe", 1100, 40, decay=0.2)
    node("pulse", "math/expression", 1340, 40, formula="0.6 + 0.8 * x")
    node("vec", "converter/value-to-vector", 1560, 40)
    node("xf", "transform/matrix-transform", 1760, 40)
    node("orb", "object/sphere", 1960, 40, color=0x7DD3FC, emissive=0x0C4A6E, emissiveIntensity=1.2)
    node("env", "lighting/environment", 1960, 300, color=0x0B0B16, intensity=1, background=1, ambientIntensity=0.5, sunIntensity=1.0)
    node("render", "render", 1100, 600, frameCount=frames, fps=30, motionBlur=0, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080, holdout=False)
    if lead_pattern:
        links += [(lead_pattern, "sequence", "probe", "music")]
    links += [("probe", "envelope", "pulse", "x"), ("pulse", "value", "vec", "value"), ("vec", "vector", "xf", "scale"), ("xf", "matrix", "orb", "matrix"), ("env", "environment", "render", "environment")]
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
    ap.add_argument("mod")
    ap.add_argument("out")
    ap.add_argument("--map", help="JSON file: sample number → role overrides")
    ap.add_argument("--title", default="")
    args = ap.parse_args()
    mod = Module(open(args.mod, "rb").read())
    overrides = json.load(open(args.map)) if args.map else {}
    conv = convert(mod, overrides, args.title)
    with open(args.out, "w") as f:
        json.dump(project(conv), f, indent=1)
        f.write("\n")
    print(f"{conv['title']}: {conv['total_steps']} steps at {conv['bpm']} BPM ({conv['steps_per_beat']} a beat), {conv['seconds']:.1f} s, {len(conv['tracks'])} tracks")
    for s_idx, role in sorted(conv["roles"].items()):
        print(f"  sample {s_idx:2} → {role}")


if __name__ == "__main__":
    main()
