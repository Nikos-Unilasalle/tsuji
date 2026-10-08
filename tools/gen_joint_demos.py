#!/usr/bin/env python3
"""Generate the two joint demos: demo_physics_constraints and demo_physics_chain.

Standalone graphs (no shared setup), like demo_physics_rigidbody. A physics
demo may hold at most three Rigid Body nodes (rapier.test.ts), so bodies are
grouped through Merges: Constraint picks them out of the group by index.
"""
import json, math, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMOS = os.path.join(ROOT, "public/demos")


def v3(x=0.0, y=0.0, z=0.0):
    return {"x": x, "y": y, "z": z}


def node(nid, ntype, px, py, **params):
    return {"id": nid, "type": ntype, "position": {"x": px, "y": py}, "params": params}


def wire(a, sa, b, sb):
    return {"id": f"{a}.{sa}->{b}.{sb}", "fromNode": a, "fromSocket": sa, "toNode": b, "toSocket": sb}


def box(nid, px, py, loc, scale, color, rot=None, rough=0.8):
    return node(nid, "object/box", px, py, visible=1, location=v3(*loc), rotation=v3(*(rot or (0, 0, 0))),
                scale=v3(*scale), color=color, roughness=rough, metalness=0, opacity=1)


def sphere(nid, px, py, loc, scale, color):
    return node(nid, "object/sphere", px, py, visible=1, location=v3(*loc), rotation=v3(), scale=v3(*scale),
                color=color, roughness=0.4, metalness=0.1, opacity=1)


def cylinder(nid, px, py, loc, scale, color):
    return node(nid, "object/cylinder", px, py, visible=1, location=v3(*loc), rotation=v3(), scale=v3(*scale),
                color=color, roughness=0.5, metalness=0.2, opacity=1)


def merge(nid, px, py):
    return node(nid, "structure/merge", px, py, visible=1, location=v3(), rotation=v3(), scale=v3(1, 1, 1))


def body(nid, px, py, kind, **kw):
    base = dict(bodyType=kind, shape="box", split="per-child", mass=1, friction=0.8, restitution=0.05,
                linearDamping=0.05, angularDamping=0.1, gravityScale=1, ccd=False)
    base.update(kw)
    return node(nid, "physics/rigid-body", px, py, **base)


def world(nid, px, py):
    return node(nid, "physics/world", px, py, gravity=v3(0, -9.81, 0), timestep=1 / 60, maxSteps=4, paused=0, reset=0)


def lights(merge_id, y):
    """The two lights, and their (source) wires — the caller numbers the Merge inputs."""
    n = [
        node("amb_1", "light/ambient", 600, y, color=0x9FB0D0, intensity=0.55),
        node("sun_1", "light/directional", 600, y + 100, color=0xFFF5D0, intensity=1.7, location=v3(6, 10, 5), castShadow=1),
    ]
    c = [wire("amb_1", "light", merge_id, "in"), wire("sun_1", "light", merge_id, "in")]
    return n, c


def write(name, nodes, conns):
    canvas = {"nodes": nodes, "connections": conns, "keyframes": {}, "markers": [], "exposedParams": []}
    empty = lambda: {"nodes": [], "connections": [], "keyframes": {}, "markers": [], "exposedParams": []}
    path = os.path.join(DEMOS, f"demo_{name}.tsuji")
    with open(path, "w") as f:
        json.dump({"canvases": [canvas] + [empty() for _ in range(5)], "activeCanvas": 0}, f, indent=2)
        f.write("\n")
    print(f"wrote demo_{name}.tsuji ({len(nodes)} nodes)")


GROUND, STONE, WOOD, ROPE = 0x4A6B50, 0x7C7C86, 0xD9B38C, 0xB08D57
BLUE, PINK, WARM = 0x38BDF8, 0xEC4899, 0xFFDC6E


def constraints_demo():
    # Pendulum arm: hinged at (-3, 6, -3), tilted 0.9 rad out of plumb.
    pivot = (-3.0, 6.0, -3.0)
    theta = 0.9
    arm_len = 3.0
    arm_c = (pivot[0] + arm_len / 2 * math.sin(theta), pivot[1] - arm_len / 2 * math.cos(theta), pivot[2])

    n = [
        world("world_1", 60, 60),
        box("ground_geo", 60, 200, (0, -0.5, 0), (24, 1, 24), GROUND, rough=0.9),
        box("post_geo", 60, 320, (-4, 1.1, 2), (0.2, 2.2, 0.2), STONE),
        box("rail_geo", 60, 440, (3, 0.35, -3), (5, 0.1, 0.1), STONE),
        merge("static_group", 340, 320),
        body("static_body", 600, 320, "fixed", shape="trimesh"),
        box("door_geo", 60, 600, (-3.05, 1.1, 2), (1.6, 2, 0.1), PINK),
        box("piston_geo", 60, 720, (3, 0.35, -3), (1.2, 0.6, 0.6), BLUE),
        box("crate_geo", 60, 840, (0, 0.4, 0), (0.8, 0.8, 0.8), WARM),
        box("arm_geo", 60, 960, arm_c, (0.12, arm_len, 0.12), WOOD, rot=(0, 0, theta)),
        merge("movers_group", 340, 780),
        body("movers_body", 600, 780, "dynamic", mass=2),
        node("osc_door", "animation/oscillator", 600, 520, type="sine", frequency=0.2, phase=0, amplitude=1.2, offset=0,
             curve="linear", curveStrength=1),
        node("osc_piston", "animation/oscillator", 600, 640, type="sine", frequency=0.25, phase=0, amplitude=1.5, offset=0,
             curve="linear", curveStrength=1),
        # Door: a hinge about Y on the post, held by a position motor that swings it open and shut.
        node("door_hinge", "physics/constraint", 900, 400, jointType="hinge", pairing="single", indexA=1, indexB=0,
             anchor=v3(-3.9, 1.1, 2), axis=v3(0, 1, 0), limits=True, angleMin=-1.75, angleMax=1.75,
             motor="position", target=0, motorStiffness=200, motorDamping=30, motorMaxForce=0),
        # Piston: slides along the rail, driven back and forth.
        node("piston_slider", "physics/constraint", 900, 600, jointType="slider", pairing="single", indexA=2, indexB=1,
             anchor=v3(3, 0.35, -3), axis=v3(1, 0, 0), limits=True, distanceMin=-1.8, distanceMax=1.8,
             motor="position", target=0, motorStiffness=300, motorDamping=40, motorMaxForce=0),
        # Crate on a spring from a point in the air (no Body A: that end is the world).
        node("crate_spring", "physics/constraint", 900, 800, jointType="spring", pairing="single", indexB=2,
             offsetA=v3(0, 5, 0), offsetB=v3(0, 0.4, 0), restLength=2.2, stiffness=80, damping=3),
        # Pendulum arm: a free hinge on a pivot in the air.
        node("arm_hinge", "physics/constraint", 900, 1000, jointType="hinge", pairing="single", indexB=3,
             anchor=v3(*pivot), axis=v3(0, 0, 1), limits=False, motor="off", collideConnected=False),
    ]
    ln, lc = lights("scene_merge", 1160)
    n += ln
    n += [merge("scene_merge", 1260, 520),
          node("render_1", "render", 1520, 520, frameCount=900, fps=60, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080)]
    c = [
        wire("ground_geo", "geometry", "static_group", "in0"),
        wire("post_geo", "geometry", "static_group", "in1"),
        wire("rail_geo", "geometry", "static_group", "in2"),
        wire("world_1", "world", "static_body", "world"),
        wire("static_group", "geometry", "static_body", "geometry"),
        wire("door_geo", "geometry", "movers_group", "in0"),
        wire("piston_geo", "geometry", "movers_group", "in1"),
        wire("crate_geo", "geometry", "movers_group", "in2"),
        wire("arm_geo", "geometry", "movers_group", "in3"),
        wire("world_1", "world", "movers_body", "world"),
        wire("movers_group", "geometry", "movers_body", "geometry"),
        wire("world_1", "world", "door_hinge", "world"),
        wire("static_body", "body", "door_hinge", "bodyA"),
        wire("movers_body", "body", "door_hinge", "bodyB"),
        wire("osc_door", "out", "door_hinge", "target"),
        wire("world_1", "world", "piston_slider", "world"),
        wire("static_body", "body", "piston_slider", "bodyA"),
        wire("movers_body", "body", "piston_slider", "bodyB"),
        wire("osc_piston", "out", "piston_slider", "target"),
        wire("world_1", "world", "crate_spring", "world"),
        wire("movers_body", "body", "crate_spring", "bodyB"),
        wire("world_1", "world", "arm_hinge", "world"),
        wire("movers_body", "body", "arm_hinge", "bodyB"),
        wire("static_body", "geometry", "scene_merge", "in0"),
        wire("movers_body", "geometry", "scene_merge", "in1"),
    ] + [wire(w["fromNode"], w["fromSocket"], "scene_merge", f"in{2 + i}") for i, w in enumerate(lc)]
    write("physics_constraints", n, c)


def chain_demo():
    links_bridge, links_rope = 12, 8
    rope_start, rope_end = (0.0, 7.0, -4.0), (2.0, 4.0, -4.0)
    rope_len = math.dist(rope_start, rope_end)
    n = [
        world("world_1", 60, 60),
        box("ground_geo", 60, 200, (0, -0.5, 0), (24, 1, 24), GROUND, rough=0.9),
        box("pillar_l", 60, 320, (-3.5, 1.5, 0), (1, 3, 2.2), STONE),
        box("pillar_r", 60, 440, (3.5, 1.5, 0), (1, 3, 2.2), STONE),
        box("beam_geo", 60, 560, (0, 7.1, -4), (4, 0.2, 0.2), STONE),
        box("post_geo", 60, 680, (-2, 3.5, -4), (0.2, 7, 0.2), STONE),
        merge("static_group", 340, 440),
        body("static_body", 600, 440, "fixed", shape="trimesh"),
        # Bridge: planks hinged about Z, pinned to the pillars.
        node("bridge", "physics/chain", 340, 700, links=links_bridge, start=v3(-3, 3, 0), end=v3(3, 3, 0),
             linkShape="box", jointType="hinge", axis=v3(0, 0, 1), radius=0.05, width=1.8, mass=0.5,
             linearDamping=0.1, angularDamping=0.6, friction=0.8, restitution=0, selfCollide=False,
             pinStart=True, pinEnd=True, stretch=False, breakForce=0),
        box("plank_geo", 60, 800, (0, 0, 0), (1.8, 0.46, 0.1), WOOD),
        node("plank_array", "structure/array", 340, 860, visible=1, count=links_bridge, spacing=0.5, mode="line", gpuInstancing=False),
        node("planks", "structure/instance-transform", 600, 860, mode="absolute", pivot="shared", rotationMode="euler", alignAxis="Z"),
        # Rope: a ball-jointed chain from the beam, with a lantern on its end.
        node("rope", "physics/chain", 340, 1060, links=links_rope, start=v3(*rope_start), end=v3(*rope_end),
             linkShape="capsule", jointType="ball", radius=0.05, mass=0.15, linearDamping=0.05, angularDamping=0.3,
             friction=0.5, restitution=0, selfCollide=False, pinStart=True, pinEnd=False, stretch=True, breakForce=0),
        cylinder("link_geo", 60, 1020, (0, 0, 0), (0.1, 1, 0.1), ROPE),
        node("link_array", "structure/array", 340, 1160, visible=1, count=links_rope, spacing=0.5, mode="line", gpuInstancing=False),
        node("links", "structure/instance-transform", 600, 1160, mode="absolute", pivot="shared", rotationMode="euler", alignAxis="Z"),
        # Things that fall on the bridge, and the lantern, as one dynamic group.
        sphere("ball_geo", 60, 1300, (0, 0, 0), (0.9, 0.9, 0.9), PINK),
        node("ball_array", "structure/array", 340, 1300, visible=1, count=4, spacing=2.4, mode="line", axis="Y", gpuInstancing=False),
        sphere("lantern_geo", 60, 1420, (rope_end[0], rope_end[1] - 0.35, rope_end[2]), (0.7, 0.7, 0.7), WARM),
        merge("movers_group", 600, 1340),
        body("movers_body", 860, 1340, "dynamic", shape="auto", mass=3, friction=0.9, restitution=0.05),
        node("lantern_hook", "physics/constraint", 1120, 1100, jointType="ball", pairing="single", indexA=-1, indexB=4,
             anchor=v3(*rope_end), collideConnected=False),
    ]
    ln, lc = lights("scene_merge", 1500)
    n += ln
    n += [merge("scene_merge", 1200, 700),
          node("render_1", "render", 1460, 700, frameCount=900, fps=60, resolutionPreset="16:9 (1920x1080)", width=1920, height=1080)]
    c = [
        wire("ground_geo", "geometry", "static_group", "in0"),
        wire("pillar_l", "geometry", "static_group", "in1"),
        wire("pillar_r", "geometry", "static_group", "in2"),
        wire("beam_geo", "geometry", "static_group", "in3"),
        wire("post_geo", "geometry", "static_group", "in4"),
        wire("world_1", "world", "static_body", "world"),
        wire("static_group", "geometry", "static_body", "geometry"),
        wire("world_1", "world", "bridge", "world"),
        wire("plank_geo", "geometry", "plank_array", "geometry"),
        wire("plank_array", "geometry", "planks", "geometry"),
        wire("bridge", "matrices", "planks", "matrices"),
        wire("world_1", "world", "rope", "world"),
        wire("link_geo", "geometry", "link_array", "geometry"),
        wire("link_array", "geometry", "links", "geometry"),
        wire("rope", "matrices", "links", "matrices"),
        wire("ball_geo", "geometry", "ball_array", "geometry"),
        wire("ball_array", "geometry", "movers_group", "in0"),
        wire("lantern_geo", "geometry", "movers_group", "in1"),
        wire("world_1", "world", "movers_body", "world"),
        wire("movers_group", "geometry", "movers_body", "geometry"),
        wire("world_1", "world", "lantern_hook", "world"),
        wire("rope", "body", "lantern_hook", "bodyA"),
        wire("movers_body", "body", "lantern_hook", "bodyB"),
        wire("static_body", "geometry", "scene_merge", "in0"),
        wire("movers_body", "geometry", "scene_merge", "in1"),
        wire("planks", "geometry", "scene_merge", "in2"),
        wire("links", "geometry", "scene_merge", "in3"),
    ] + [wire(w["fromNode"], w["fromSocket"], "scene_merge", f"in{4 + i}") for i, w in enumerate(lc)]
    write("physics_chain", n, c)


if __name__ == "__main__":
    constraints_demo()
    chain_demo()
