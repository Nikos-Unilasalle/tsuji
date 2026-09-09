/**
 * Catalog for the TopBar's Demos menu — small, single-purpose graphs that
 * each teach one node or one small combination, plus the handful of larger
 * showcase graphs kept from before. Grouped by category so the menu reads
 * like a table of contents, not a flat file list.
 *
 * Each `file` lives under public/demos/ — Vite copies public/ verbatim into
 * dist, so `fetch(\`/demos/${file}\`)` resolves the same way in the dev
 * server and in the built Tauri app (its webview loads the same bundled
 * index.html and assets). See demos.test.ts for the file-integrity check.
 */
export interface DemoEntry {
  file: string;
  label: string;
  description: string;
}

export interface DemoCategory {
  title: string;
  demos: DemoEntry[];
}

export const DEMO_CATALOG: DemoCategory[] = [
  {
    title: "Objects",
    demos: [
      {
        file: "demo_object_raccoon.tsuji",
        label: "Raccoon",
        description: "The built-in raccoon primitive, arrayed and tinted.",
      },
      {
        file: "demo_object_primitives.tsuji",
        label: "Primitives",
        description: "Cylinder, cone and disc merged into one object.",
      },
      {
        file: "demo_object_text.tsuji",
        label: "3D Text",
        description: "A frame-driven reveal: length, trim, random and case chained onto a Text object.",
      },
      {
        file: "demo_object_empty_lookat.tsuji",
        label: "Empty & Look At",
        description: "A cone aiming at an orbiting Empty.",
      },
    ],
  },
  {
    title: "Modifiers",
    demos: [
      {
        file: "demo_modifier_mesh_edit.tsuji",
        label: "Extrude & Delete",
        description: "Faces pushed out, and a shell opened then flipped.",
      },
      {
        file: "demo_modifier_extrude_tree.tsuji",
        label: "Extrude Tree",
        description: "A tube's top ring extruded over and over, tilting and tapering — a tree from one node.",
      },
      {
        file: "demo_modifier_boolean.tsuji",
        label: "Boolean",
        description: "A sphere subtracted from a box.",
      },
      {
        file: "demo_modifier_subdivide_shade.tsuji",
        label: "Subdivide & Shade",
        description: "Catmull-Clark subdivision then auto-smooth shading.",
      },
      {
        file: "demo_modifier_lattice.tsuji",
        label: "Lattice",
        description: "A cage twisting a box, driven by an oscillator.",
      },
      {
        file: "demo_modifier_clipping.tsuji",
        label: "Clip Box",
        description: "A sphere cut down to a box volume.",
      },
    ],
  },
  {
    title: "Transform & Structure",
    demos: [
      {
        file: "demo_transform_matrix.tsuji",
        label: "Parent & Matrix Mix",
        description: "A moon inheriting a planet's orbit, blended with a tilted one.",
      },
      {
        file: "demo_math_vectors.tsuji",
        label: "Vector Math",
        description: "Compose, add and decompose a position vector.",
      },
      {
        file: "demo_transform_basics.tsuji",
        label: "Geometry Transform",
        description: "Position, rotate and scale one object.",
      },
      {
        file: "demo_structure_array.tsuji",
        label: "Array Grid",
        description: "Repeat one object into a grid.",
      },
      {
        file: "demo_structure_hexaworld.tsuji",
        label: "Hexaworld",
        description: "Hex Grid + Sample Texture -> Set Instance Transform.",
      },
    ],
  },
  {
    title: "Time & Animation",
    demos: [
      {
        file: "demo_trail.tsuji",
        label: "Orbit Trails",
        description: "Planet and moon each leaving a tube along their path.",
      },
      {
        file: "demo_math_spring.tsuji",
        label: "Spring",
        description: "A square wave damped into overshoot and settle.",
      },
      {
        file: "demo_time_remap.tsuji",
        label: "Time Remap",
        description: "A looping remap of the clock driving rotation.",
      },
      {
        file: "demo_math_wiggle.tsuji",
        label: "Wiggle",
        description: "Layered noise on position, rotation and scale.",
      },
      {
        file: "demo_time_spin.tsuji",
        label: "Continuous Spin",
        description: "Time -> Value Math drives a steady rotation.",
      },
      {
        file: "demo_time_oscillator_bob.tsuji",
        label: "Oscillator Bob",
        description: "Oscillator drives a back-and-forth bob.",
      },
      {
        file: "demo_squash_stretch_bounce.tsuji",
        label: "Squash & Stretch",
        description: "A bobbing ball squashes and stretches with its own velocity.",
      },
      {
        file: "demo_delay.tsuji",
        label: "Matrix Delay",
        description: "A transform buffer delaying motion into echoes and trails.",
      },
    ],
  },
  {
    title: "List & Instancing",
    demos: [
      {
        file: "demo_list_basics.tsuji",
        label: "List Basics",
        description: "Generate, slice, length and get-item on one list.",
      },
      {
        file: "demo_list_vectors.tsuji",
        label: "Vector Lists",
        description: "Combine three number lists into vectors and back.",
      },
      {
        file: "demo_instancing_tools.tsuji",
        label: "Instancing Tools",
        description: "Get one instance, and read every instance position.",
      },
      {
        file: "demo_math_random.tsuji",
        label: "Random Field",
        description: "A random list driving each tower's height and colour.",
      },
      {
        file: "demo_list_instance_color.tsuji",
        label: "Color Palette per Instance",
        description: "Array + Color Palette List -> Set Instance Color.",
      },
    ],
  },
  {
    title: "Curves",
    demos: [
      {
        file: "demo_curve_follow_path.tsuji",
        label: "Follow Path",
        description: "A cone riding along a helix.",
      },
      {
        file: "demo_curve_deform.tsuji",
        label: "Curve Deform",
        description: "A cylinder bent along a wave curve.",
      },
      {
        file: "demo_curve_array.tsuji",
        label: "Curve Array",
        description: "One circle repeated into a stack of lines.",
      },
      {
        file: "demo_curve_primitive.tsuji",
        label: "Curve Primitive",
        description: "One node, a ready-made helix curve.",
      },
      {
        file: "demo_grease_pencil.tsuji",
        label: "Grease Pencil & Paint",
        description: "Hand-drawn strokes and painting directly onto 3D geometry.",
      },
    ],
  },
  {
    title: "Physics",
    demos: [
      {
        file: "demo_physics_rolling.tsuji",
        label: "Rolling Cube",
        description: "A square prism tumbling as it rolls — rotation coupled to its bob.",
      },
      {
        file: "demo_physics_scatter.tsuji",
        label: "Surface Scatter",
        description: "Sample points on a mesh, spawn objects on them.",
      },
      {
        file: "demo_physics_rigidbody.tsuji",
        label: "Rigid Bodies (Rapier)",
        description: "Crates and a ball dropped into a Rapier world: stacking, rolling and a ramp.",
      },
      {
        file: "demo_physics_character_rapier.tsuji",
        label: "Character on Rapier",
        description: "ZQSD and Space drive a capsule through a Rapier level: auto-step onto a kerb, a ramp, and crates it can shove.",
      },
      {
        file: "demo_physics_character.tsuji",
        label: "Capsule Character",
        description: "ZQSD and Space drive a kinematic capsule that walks the level, slides along walls and climbs a ramp.",
      },
      {
        file: "demo_physics_raycast.tsuji",
        label: "Raycast Hit Marker",
        description: "Raycast a sphere, place a marker at the hit point.",
      },
    ],
  },
  {
    title: "Lighting & Post-Processing",
    demos: [
      {
        file: "demo_lighting_probe.tsuji",
        label: "Light Probe",
        description: "Coloured walls bouncing onto a matte sphere.",
      },
      {
        file: "demo_post_kaleidoscope.tsuji",
        label: "Kaleidoscope",
        description: "Mirrored, pixelated and graded in one chain.",
      },
      {
        file: "demo_lighting_lights.tsuji",
        label: "Light Types",
        description: "Ambient, directional, spot and an orbiting point light.",
      },
      {
        file: "demo_post_stylize.tsuji",
        label: "Stylize Chain",
        description: "Vignette, RGB shift, grain and colour grading chained.",
      },
      {
        file: "demo_post_outline.tsuji",
        label: "Outline",
        description: "An outline pass tracing one object's edges.",
      },
      {
        file: "demo_lighting_environment.tsuji",
        label: "Environment Lighting",
        description: "Environment & HDRI feeding the Render node.",
      },
      {
        file: "demo_postprocess_bloom.tsuji",
        label: "Bloom",
        description: "An emissive sphere through the Bloom pass.",
      },
    ],
  },
  {
    title: "I/O",
    demos: [
      {
        file: "demo_logic_keyboard.tsuji",
        label: "Keyboard & Logic",
        description: "Space toggles a gate, swapping which object shows.",
      },
      {
        file: "demo_logic_compare.tsuji",
        label: "Compare & Envelope",
        description: "A rising edge firing an envelope and a pulse.",
      },
      {
        file: "demo_hud_text.tsuji",
        label: "HUD Text",
        description: "The clock formatted into a 2D overlay label.",
      },
      {
        file: "demo_sound_reactive.tsuji",
        label: "Sound Spectrum",
        description: "Mic spectrum driving a bar graph (enable the mic).",
      },
      {
        file: "demo_io_action_map.tsuji",
        label: "Action Map & Gamepad",
        description: "ZQSD, arrow keys and a gamepad stick folded into two named axes, integrated into a position that stays put when you let go.",
      },
      {
        file: "demo_io_mouse_pointer.tsuji",
        label: "Mouse Pointer",
        description: "Mouse node's 3D point placing a marker.",
      },
      {
        file: "demo_mouse_disc.tsuji",
        label: "Mouse Disc",
        description: "A disc gliding over the ground at y=0, with a checker cube rolling after it (Mouse -> Rolling) and a bloom pass.",
      },
      {
        file: "demo_mouse_halo.tsuji",
        label: "Mouse Proximity Halo",
        description: "Distances -> gradient color + height bump around the pointer.",
      },
    ],
  },
  {
    title: "Dataviz",
    demos: [
      {
        file: "demo_chart_bar.tsuji",
        label: "Bar Chart",
        description: "Random values as bars, with a matching axis.",
      },
      {
        file: "demo_chart_pie.tsuji",
        label: "Pie Chart",
        description: "A donut chart coloured from a palette.",
      },
      {
        file: "demo_chart_scatter.tsuji",
        label: "Scatter Plot",
        description: "Three number lists as a 3D point scatter.",
      },
      {
        file: "demo_chart_line.tsuji",
        label: "Line Graph",
        description: "A smoothed line graph with points.",
      },
      {
        file: "demo_points_roundtrip.tsuji",
        label: "Mesh to Points",
        description: "A mesh turned into points, wiggled, and rebuilt.",
      },
    ],
  },
  {
    title: "Particles",
    demos: [
      {
        file: "demo_particles_basic.tsuji",
        label: "Particles",
        description: "Emitter, simulation and point rendering.",
      },
      {
        file: "demo_particles_surface.tsuji",
        label: "Surface Emitter",
        description: "Particles off a mesh, pulled by a vortex, hitting a ground.",
      },
      {
        file: "demo_particles_trails.tsuji",
        label: "Trails & Web",
        description: "Particle history as trails, plus nearby-point links.",
      },
      {
        file: "demo_physics_fire_sim.tsuji",
        label: "Volumetric Fire Simulation",
        description: "3D Navier-Stokes fluid simulation with blackbody raymarching.",
      },
      {
        file: "demo_vegetation_tree_species.tsuji",
        label: "Tree Species",
        description: "The eight growth habits side by side: oak, clumped cherry, conifer, willow, birch, palm, bush and a bare winter tree.",
      },
      {
        file: "demo_vegetation_wind.tsuji",
        label: "Grass & Trees in the Wind",
        description: "One Wind Field driving grass and trees, plus an Interaction Map that flattens the grass in a moving object's wake.",
      },
    ],
  },
  {
    title: "Textures",
    demos: [
      {
        file: "demo_texture_procedural.tsuji",
        label: "Procedural Textures",
        description: "Two patterns mixed, transformed, and used as a normal map.",
      },
      {
        file: "demo_texture_to_geometry.tsuji",
        label: "Texture to Geometry",
        description: "A texture's pixels spawning objects.",
      },
      {
        file: "demo_texture_decal_wall.tsuji",
        label: "Decal Wall",
        description: "One graffiti painted across 27 separate cubes — the wall opens and the picture tears apart.",
      },
    ],
  },
  {
    title: "Math & Color",
    demos: [
      {
        file: "demo_math_ramp_color.tsuji",
        label: "Value to Colour",
        description: "An oscillator remapped and clamped into a colour mix.",
      },
      {
        file: "demo_math_proximity.tsuji",
        label: "Proximity",
        description: "A moving probe colouring the grid cells nearest it.",
      },
    ],
  },
  {
    title: "Showcases",
    demos: [
      {
        file: "spawn.tsuji",
        label: "Spawn on Surface",
        description: "Scatter objects across a surface.",
      },
      {
        file: "demo_raycast.tsuji",
        label: "Ray Burst",
        description: "A field of rays hitting a target mesh.",
      },
      {
        file: "demo_stagger_wave.tsuji",
        label: "Stagger Wave",
        description: "A staggered rise/pop/spin animation across a grid.",
      },
      {
        file: "demo_spiderweb.tsuji",
        label: "Spiderweb",
        description: "A larger, multi-system composition.",
      },
    ],
  },
];
