#!/usr/bin/env python3
"""Generate demo_sound_lipsync_morph: talk into the mic and a cartoon head mouths along.

Microphone → Lip Sync → (15 viseme weights) → Morph Targets ← glTF Model.

The head is public/demos/viseme_head.glb, built by tools/gen_viseme_head.mjs with the 15
viseme_* shape keys. Its path starts with `demos/`, which the app fetches itself on load
(see rehydrateFiles.isFetchablePath), so the model opens with the demo in the browser and
the desktop app alike.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_demos import node, wire, v3, write_demo  # noqa: E402

# Turned to face the viewport's default camera at (3, 3, 5): radians, like every stored rotation.
n = [
    node("mic", "sound/microphone", -1240, 120, enable=1, gain=1.6),
    node("lipsync", "sound/lipsync", -980, 120, attack=0.04, release=0.12),
    node("head", "object/gltf", -980, 420,
         filePath="demos/viseme_head.glb",
         location=v3(0, 0.55, 0), rotation=v3(-0.25, 0.54, 0), scale=v3(1, 1, 1),
         useOwnMaterials=1),
    node("morph", "object/morph-targets", -700, 260, strength=1),
]
c = [
    wire("mic", "audio", "lipsync", "audio"),
    wire("lipsync", "weights", "morph", "weights"),
    wire("head", "geometry", "morph", "geometry"),
]

if __name__ == "__main__":
    write_demo("sound_lipsync_morph", n, c)
