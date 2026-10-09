#!/usr/bin/env python3
"""Generate demo_mask_roto: an image on a plane, cut by a Roto Mask drawn in UV."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_joint_demos import node, wire, v3, write, merge  # noqa: E402

KAPPA = 0.5522847498


def pt(x, y, ix=0.0, iy=0.0, ox=0.0, oy=0.0):
    return {"x": x, "y": y, "ix": ix, "iy": iy, "ox": ox, "oy": oy}


def ellipse(cx, cy, rx, ry):
    kx, ky = rx * KAPPA, ry * KAPPA
    return [pt(cx + rx, cy, 0, -ky, 0, ky), pt(cx, cy + ry, kx, 0, -kx, 0),
            pt(cx - rx, cy, 0, ky, 0, -ky), pt(cx, cy - ry, -kx, 0, kx, 0)]


def layer(lid, name, points, mode="add", feather=0.0, expansion=0.0, opacity=1.0):
    return {"id": lid, "name": name, "mode": mode, "opacity": opacity, "invert": False,
            "feather": feather, "expansion": expansion, "visible": True, "points": points}


masks = [
    layer("m_oval", "Oval", ellipse(0.5, 0.5, 0.42, 0.42), feather=0.06),
    layer("m_cut", "Cut-out", ellipse(0.5, 0.5, 0.17, 0.17), mode="subtract", feather=0.03),
]

n = [
    node("tex", "texture/procedural", 60, 120, type="gradient", colorA=0xFFB347, colorB=0x1B2A6B, size="1024 × 1024", scale=1, seed=1),
    node("backdrop_tex", "texture/procedural", 60, 360, type="checker", colorA=0x3B4252, colorB=0x2E3440, size="1024 × 1024", scale=10, seed=1),
    node("roto", "mask/roto", 360, 220, masks=masks, activeLayer=0, resolution="1024", aspect=1, showFull=False),
    node("plane", "texture/plane", 700, 120, visible=1, location=v3(0, 1.2, 0), rotation=v3(0, 0, 0), scale=v3(2.4, 2.4, 2.4),
         transparent=True, alphaCutoff=0.001, doubleSided=True, keepAspect=True, roughness=0.6, metalness=0.0),
    node("backdrop", "texture/plane", 700, 360, visible=1, location=v3(0, 1.2, -0.6), rotation=v3(0, 0, 0), scale=v3(5, 5, 5),
         transparent=False, doubleSided=True, keepAspect=True, roughness=0.9, metalness=0.0),
    # The same cut-out on a 3D object: Apply Mask puts the mask in the texture's alpha.
    node("cut", "texture/apply-mask", 360, 420),
    node("cube", "object/box", 700, 760, location=v3(3.4, 1.2, 0.3), rotation=v3(0.3, 0.6, 0), scale=v3(1.6, 1.6, 1.6),
         color=0xFFFFFF, roughness=0.5, metalness=0.0, opacity=1),
    node("amb", "light/ambient", 700, 560, color=0x9FB0D0, intensity=0.9),
    node("sun", "light/directional", 700, 660, color=0xFFF5D0, intensity=1.2, location=v3(3, 6, 6), castShadow=0),
    merge("scene", 1000, 360),
    node("render_1", "render", 1260, 360, frameCount=600, fps=60, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080),
]
c = [
    wire("tex", "texture", "plane", "texture"),
    wire("roto", "mask", "plane", "mask"),
    wire("backdrop_tex", "texture", "backdrop", "texture"),
    wire("tex", "texture", "cut", "texture"),
    wire("roto", "mask", "cut", "mask"),
    wire("cut", "texture", "cube", "texture"),
    wire("cube", "geometry", "scene", "in4"),
    wire("plane", "geometry", "scene", "in0"),
    wire("backdrop", "geometry", "scene", "in1"),
    wire("amb", "light", "scene", "in2"),
    wire("sun", "light", "scene", "in3"),
    wire("scene", "geometry", "render_1", "geometry"),
]
write("mask_roto", n, c)
