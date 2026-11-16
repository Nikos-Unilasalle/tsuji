#!/usr/bin/env python3
import json

def make_project():
    nodes = []
    conns = []
    conn_id = 0

    def connect(from_node, from_socket, to_node, to_socket):
        nonlocal conn_id
        conn_id += 1
        conns.append({
            "id": f"c{conn_id}",
            "fromNode": from_node,
            "fromSocket": from_socket,
            "toNode": to_node,
            "toSocket": to_socket
        })

    # 1. Clock (90 BPM, gentle swing)
    nodes.append({
        "id": "clock",
        "type": "music/clock",
        "position": {"x": -400, "y": 400},
        "params": {"bpm": 90, "swing": 0.12, "stepsPerBeat": "4"}
    })

    # 2. Main Chord Pattern (F#m9 -> Dmaj7 -> Bm7 -> C#m7, 128 steps)
    # 120 BPM / 90 BPM notation in Tsuji: note:chord
    # F#3 = 54, D3 = 50, B2 = 47, C#3 = 49
    chord_steps = "F#3:min9 . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . " + \
                  "D3:maj7 . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . " + \
                  "B2:min7 . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . " + \
                  "C#3:min7 . . . . . . . . . . . . . . . . . . . . . . . . . . . . . ."
    nodes.append({
        "id": "chords",
        "type": "music/pattern",
        "position": {"x": 0, "y": 200},
        "params": {
            "steps": chord_steps,
            "length": "128",
            "name": "Chords (F#m9 - Dmaj7 - Bm7 - C#m7)"
        }
    })
    connect("clock", "clock", "chords", "clock")

    # 3. Voice leading on chords
    nodes.append({
        "id": "vl",
        "type": "music/voice-leading",
        "position": {"x": 250, "y": 200},
        "params": {"voices": 4, "low": 50, "high": 76}
    })
    connect("chords", "sequence", "vl", "sequence")

    # 4. Granular Voice ("The Nebula") - Ambient drone cloud
    # Plays the chords into a rich, living stochastic grain cloud with deep sub anchor
    nodes.append({
        "id": "gran_voice",
        "type": "music/granular-voice",
        "position": {"x": 600, "y": 50},
        "params": {
            "preset": "Abyssal Drone",
            "grainSource": "chirp",
            "density": 115,
            "grainSize": 0.13,
            "spray": 0.7,
            "pitchSpray": 28,
            "formantFreq": 450,
            "subLevel": 0.75,
            "filterType": "lowpass",
            "cutoff": 950,
            "resonance": 0.35,
            "filterEnv": 0.2,
            "attack": 0.8,
            "decay": 2.0,
            "sustain": 0.9,
            "release": 2.5,
            "level": 0.7,
            "pan": -0.2,
            "delaySend": 0.45,
            "reverbSend": 0.75
        }
    })
    connect("vl", "sequence", "gran_voice", "sequence")

    # 5. Wavetable Voice 1 ("Morphing Glass Pad") - Vowel & Formant swell
    nodes.append({
        "id": "wt_pad",
        "type": "music/wavetable-voice",
        "position": {"x": 600, "y": 250},
        "params": {
            "preset": "Celestial Pad",
            "table": "formant",
            "wtPos": 0.42,
            "sub": 0.25,
            "subOctave": "1",
            "unison": 5,
            "detune": 18,
            "filterType": "lowpass",
            "cutoff": 3200,
            "resonance": 0.25,
            "drive": 0.3,
            "filterEnv": 0.25,
            "attack": 0.9,
            "decay": 2.5,
            "sustain": 0.85,
            "release": 2.0,
            "level": 0.65,
            "pan": 0.3,
            "delaySend": 0.4,
            "reverbSend": 0.7
        }
    })
    connect("vl", "sequence", "wt_pad", "sequence")

    # 6. Bassline Pattern (Deep Reese / Shrub Sub)
    # F#1 (30), D1 (26), B0 (23), C#1 (25)
    bass_steps = "F#1 . . . . . . . . . . . F#1:gld12 . . . " + \
                 "D1 . . . . . . . . . . . D1:gld12 . . . " + \
                 "B0 . . . . . . . . . . . B0:gld12 . . . " + \
                 "C#1 . . . . . . . . . . . C#1:rtg2 . . off " + \
                 "F#1 . . . . . . . . . . . F#1:gld12 . . . " + \
                 "D1 . . . . . . . . . . . D1:gld12 . . . " + \
                 "B0 . . . . . . . . . . . B0:gld12 . . . " + \
                 "C#1 . . . . . . . . . . C#1 . E1 . off"
    nodes.append({
        "id": "bass_pat",
        "type": "music/pattern",
        "position": {"x": 0, "y": 500},
        "params": {
            "steps": bass_steps,
            "length": "128",
            "name": "Bassline (Sub Grooves)"
        }
    })
    connect("clock", "clock", "bass_pat", "clock")

    # 7. Wavetable Voice 2 ("The Tectonic Core") - Heavy Shrub Sub/Reese Bass
    nodes.append({
        "id": "wt_bass",
        "type": "music/wavetable-voice",
        "position": {"x": 600, "y": 500},
        "params": {
            "preset": "Reese Bass",
            "table": "sub_crush",
            "wtPos": 0.35,
            "sub": 0.85,
            "subOctave": "2",
            "unison": 3,
            "detune": 14,
            "filterType": "lowpass",
            "cutoff": 620,
            "resonance": 0.28,
            "drive": 1.25,
            "filterEnv": 0.18,
            "attack": 0.015,
            "decay": 0.6,
            "sustain": 0.9,
            "release": 0.25,
            "level": 0.95,
            "pan": 0.0,
            "delaySend": 0.1,
            "reverbSend": 0.2
        }
    })
    connect("bass_pat", "sequence", "wt_bass", "sequence")

    # 8. Arpeggiator on the chords
    nodes.append({
        "id": "arp",
        "type": "music/arp",
        "position": {"x": 350, "y": 750},
        "params": {
            "on": True,
            "mode": "updown",
            "rate": "1/8",
            "octaves": 2,
            "gate": 0.65
        }
    })
    connect("vl", "sequence", "arp", "sequence")

    # 9. FM Voice ("Electric Memory") - Crystalline bells/Rhodes
    nodes.append({
        "id": "fm_arp",
        "type": "music/fm-voice",
        "position": {"x": 600, "y": 750},
        "params": {
            "preset": "Bell",
            "level": 0.55,
            "pan": -0.35,
            "delaySend": 0.6,
            "reverbSend": 0.65,
            "voices": 6,
            "brightness": 1.1
        }
    })
    connect("arp", "sequence", "fm_arp", "sequence")

    # 10. Game Boy Voice ("The Digital Spark") - High starry whisper
    gb_steps = ". . C#5 . . . E5 . . F#5 . . . G#5 . " + \
               ". . . A5 . . . C#6 . . . B5 . . . " + \
               ". . F#5 . . . G#5 . . A5 . . . C#6 . " + \
               ". . . E6 . . . C#6 . . . G#5 . . off"
    nodes.append({
        "id": "gb_pat",
        "type": "music/pattern",
        "position": {"x": 0, "y": 950},
        "params": {
            "steps": gb_steps,
            "length": "64",
            "name": "Starlight Melodic Lead"
        }
    })
    connect("clock", "clock", "gb_pat", "clock")

    nodes.append({
        "id": "gb_lead",
        "type": "music/gameboy",
        "position": {"x": 600, "y": 950},
        "params": {
            "preset": "Wave · Sine",
            "channel": "wave",
            "volume": 12,
            "release": 0.35,
            "level": 0.45,
            "pan": 0.35,
            "delaySend": 0.55,
            "reverbSend": 0.7
        }
    })
    connect("gb_pat", "sequence", "gb_lead", "sequence")

    # 11. Drum Kit - Kick (Euclidean 3/16: floating syncopated downtempo)
    nodes.append({
        "id": "euclid_kick",
        "type": "music/euclid",
        "position": {"x": 0, "y": 1200},
        "params": {"hits": 3, "steps": 16, "rotate": 0, "word": "kick", "accent": "first"}
    })
    connect("clock", "clock", "euclid_kick", "input")

    nodes.append({
        "id": "kit_kick",
        "type": "music/drum-kit",
        "position": {"x": 600, "y": 1200},
        "params": {
            "tune": -2,
            "decay": 1.4,
            "level": 0.95,
            "pan": 0.0
        }
    })
    connect("euclid_kick", "sequence", "kit_kick", "sequence")

    # 12. Drum Kit - Snare / Clap (Backbeat on steps 4, 12)
    snare_steps = ". . . . clap . . . . . . . clap . . ."
    nodes.append({
        "id": "pat_snare",
        "type": "music/pattern",
        "position": {"x": 0, "y": 1400},
        "params": {"steps": snare_steps, "length": "16"}
    })
    connect("clock", "clock", "pat_snare", "clock")

    nodes.append({
        "id": "kit_snare",
        "type": "music/drum-kit",
        "position": {"x": 600, "y": 1400},
        "params": {
            "tune": 1,
            "decay": 1.2,
            "level": 0.85,
            "pan": 0.1,
            "delaySend": 0.25,
            "reverbSend": 0.5
        }
    })
    connect("pat_snare", "sequence", "kit_snare", "sequence")

    # 13. Drum Kit - Hi-hats (Euclidean 7/16: intricate polyrhythm)
    nodes.append({
        "id": "euclid_hat",
        "type": "music/euclid",
        "position": {"x": 0, "y": 1600},
        "params": {"hits": 7, "steps": 16, "rotate": 2, "word": "hat", "accent": "every"}
    })
    connect("clock", "clock", "euclid_hat", "input")

    nodes.append({
        "id": "kit_hat",
        "type": "music/drum-kit",
        "position": {"x": 600, "y": 1600},
        "params": {
            "tune": 3,
            "decay": 0.7,
            "level": 0.65,
            "pan": -0.2,
            "delaySend": 0.35,
            "reverbSend": 0.3
        }
    })
    connect("euclid_hat", "sequence", "kit_hat", "sequence")

    # 14. Music Out (Master & Dub sends)
    nodes.append({
        "id": "out",
        "type": "music/out",
        "position": {"x": 1050, "y": 600},
        "params": {
            "master": 0.85,
            "startFrame": 0,
            "delayBeats": "0.75",
            "delayFeedback": 0.52,
            "delayTone": 0.42,
            "delayLevel": 0.65,
            "reverbSize": 0.82,
            "reverbDamp": 0.45,
            "reverbLevel": 0.65
        }
    })
    # Connect all tracks to Music Out in growing sockets track0..track6
    connect("gran_voice", "track", "out", "track0")
    connect("wt_pad", "track", "out", "track1")
    connect("wt_bass", "track", "out", "track2")
    connect("fm_arp", "track", "out", "track3")
    connect("gb_lead", "track", "out", "track4")
    connect("kit_kick", "track", "out", "track5")
    connect("kit_snare", "track", "out", "track6")
    connect("kit_hat", "track", "out", "track7")

    # 15. 3D Visual Scene - Synesthetic space
    nodes.append({
        "id": "env",
        "type": "lighting/environment",
        "position": {"x": 1050, "y": 1100},
        "params": {
            "color": 0x0a0c16,
            "intensity": 1.2,
            "ambientIntensity": 0.5,
            "sunIntensity": 1.5
        }
    })

    nodes.append({
        "id": "render",
        "type": "render",
        "position": {"x": 1050, "y": 1300},
        "params": {
            "frameCount": 2400, # 80 seconds at 30 fps
            "fps": 30,
            "resolutionPreset": "16:9 (1920x1080)",
            "width": 1920,
            "height": 1080
        }
    })

    # Note probe listening to the kick sequence
    nodes.append({
        "id": "probe_kick",
        "type": "music/note-probe",
        "position": {"x": 1400, "y": 1100},
        "params": {"decay": 0.25}
    })
    connect("euclid_kick", "sequence", "probe_kick", "music")

    # Scale pulse expression: 1.0 + 0.45 * envelope
    nodes.append({
        "id": "pulse_expr",
        "type": "math/expression",
        "position": {"x": 1650, "y": 1100},
        "params": {"formula": "1.0 + 0.45 * x"}
    })
    connect("probe_kick", "envelope", "pulse_expr", "x")

    nodes.append({
        "id": "pulse_vec",
        "type": "converter/value-to-vector",
        "position": {"x": 1900, "y": 1100},
        "params": {}
    })
    connect("pulse_expr", "value", "pulse_vec", "value")

    nodes.append({
        "id": "xform",
        "type": "transform/matrix-transform",
        "position": {"x": 2150, "y": 1100},
        "params": {"rotationMode": "ZYX"}
    })
    connect("pulse_vec", "vector", "xform", "scale")

    # Central Sphere representing the pulsating Core
    nodes.append({
        "id": "core_sphere",
        "type": "object/sphere",
        "position": {"x": 2400, "y": 1100},
        "params": {
            "radius": 1.8,
            "color": 0x1e1b4b,
            "emissive": 0x4338ca,
            "emissiveIntensity": 1.2,
            "roughness": 0.2,
            "metalness": 0.8
        }
    })
    connect("xform", "matrix", "core_sphere", "matrix")

    project = {
        "canvases": [
            {
                "nodes": nodes,
                "connections": conns,
                "keyframes": {},
                "markers": [],
                "exposedParams": []
            },
            {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []},
            {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []},
            {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []},
            {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []},
            {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []}
        ],
        "activeCanvas": 0,
        "keyframeEasing": "arrival",
        "rotationModel": "modes"
    }
    return project

if __name__ == "__main__":
    p = make_project()
    with open("public/demos/demo_music_latent_bloom.tsuji", "w") as f:
        json.dump(p, f, indent=2)
    print("Created public/demos/demo_music_latent_bloom.tsuji with", len(p["canvases"][0]["nodes"]), "nodes and", len(p["canvases"][0]["connections"]), "connections.")
