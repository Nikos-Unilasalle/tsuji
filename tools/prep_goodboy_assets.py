#!/usr/bin/env python3
"""Prepare the generated photos for the Goodboy-style demo.

Reads the raw generations (cut-out PNGs with alpha, JPG scenes/textures), trims every
cut-out to its alpha bounding box (the generators leave a lot of empty canvas), splits the
headshot strip into one image per person, downsizes, and writes the result to
motion_demo/assets/ where the demo loads them from.

    python3 tools/prep_goodboy_assets.py [~/Desktop/motion/img]
"""
import os, sys, glob
from PIL import Image
import numpy as np

SRC = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/Desktop/motion/img")
DST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "motion_demo", "assets")
os.makedirs(DST, exist_ok=True)

CUT_MAX = 1100      # longest side of a cut-out after trimming
SCENE_MAX = 1920    # photo scenes
TEX_MAX = 1280      # paper / scratch textures


def fit(im, longest):
    w, h = im.size
    k = longest / max(w, h)
    return im if k >= 1 else im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)


def trim(im, pad=56, thresh=8):
    a = np.asarray(im.getchannel("A"))
    ys, xs = np.where(a > thresh)
    if not len(xs):
        return im
    return im.crop((max(0, xs.min() - pad), max(0, ys.min() - pad), min(im.width, xs.max() + pad + 1), min(im.height, ys.max() + pad + 1)))


def save_png(im, name):
    im.save(os.path.join(DST, name), optimize=True)
    print(f"{name:34s} {im.size}  {os.path.getsize(os.path.join(DST, name)) // 1024} KB")


def save_jpg(im, name, longest, q=86):
    im = fit(im.convert("RGB"), longest)
    im.save(os.path.join(DST, name), quality=q, optimize=True)
    print(f"{name:34s} {im.size}  {os.path.getsize(os.path.join(DST, name)) // 1024} KB")


for path in sorted(glob.glob(os.path.join(SRC, "*"))):
    base = os.path.basename(path)
    stem, ext = os.path.splitext(base)
    if ext.lower() not in (".png", ".jpg", ".jpeg"):
        continue
    im = Image.open(path)
    num = int(stem.split("_")[0].rstrip("abcde"))

    if ext.lower() == ".png":
        im = im.convert("RGBA")
        if stem.startswith("07"):
            # One strip with five people: split on the empty alpha columns between them.
            cols = np.asarray(im.getchannel("A")).max(axis=0) > 8
            runs, start = [], None
            for x, on in enumerate(cols):
                if on and start is None: start = x
                if not on and start is not None:
                    if x - start > 40: runs.append((start, x))
                    start = None
            if start is not None: runs.append((start, len(cols)))
            if len(runs) != 5:  # people touching: fall back to equal fifths
                runs = [(i * im.width // 5, (i + 1) * im.width // 5) for i in range(5)]
            for k, (x0, x1) in enumerate(runs):
                save_png(fit(trim(im.crop((x0, 0, x1, im.height))), CUT_MAX), f"07{'abcde'[k]}_headshot.png")
            continue
        save_png(fit(trim(im), CUT_MAX), base)
    else:
        save_jpg(im, base, TEX_MAX if num >= 20 else SCENE_MAX)

print("total KB:", sum(os.path.getsize(f) for f in glob.glob(os.path.join(DST, "*"))) // 1024)
