# Node catalogue reorganisation

Status: **done**. The rules for new nodes are in `NODE_AUTHORING.md` §3; the taxonomy itself is `src/shared/graph/categories.ts`.

## Why
Before this change there were 534 nodes in 29 alphabetical categories, and several of them were catch-alls:
- **Transform** held Extrude, Boolean, Subdivide and Delete.
- **Object** mixed primitives, importers, charts, metaballs, effects and morph targets.
- **Structure** held the Twist/Wave deformers next to Group and Render.

Related nodes were also spread out:
- the deformers sat in 5 categories;
- the selection nodes in 3;
- the scatter and point nodes in 4.

Twelve labels were shared by two nodes each, and a category (`post`) was empty. Three engine behaviours were also decided from a node's category, so moving a node between categories changed what it did.

## Decisions
- **Grouping:** 6 families in workflow order:
  - Geometry
  - Scene
  - Appearance
  - Animation & Simulation
  - Data
  - Interaction & Audio
- **Ordering:** within each family, categories and nodes are sorted alphabetically.
- **Merged categories:**
  - Mesh Tools went into Modeling.
  - Fluids went into Physics ("Physics & Fluids").
  - HUD went into Input ("Input & HUD").
  - Utility went into "Scene & Graph".
  - Compose and Converter became "Compose & Convert".
- **Stylize effects:** the six screen/object pairs (Dual Tone, Halftone, Film Texture, Super 8 Projector, Dry Brush, Outline) are now one node each, with an "Apply To: Screen / Object" choice.
  - The node keeps the post-process type id.
  - The object-only types stay registered but hidden, so old files still load.
- **Type ids:** unchanged, so saved projects load as before. Only `category` and nine labels changed:
  - Text 3D
  - Physics Spawner
  - Comment Frame
  - Texture Map Range, Bloom, Film Grain, Transform, Blur, Threshold and Invert (each now prefixed with "Texture")
- **Behaviour:** now set by explicit flags, `ownershipPassThrough` and `managedByViewport`. The music param-inputs rule now keys on the `music/` type prefix.
- **Search:** added synonyms in `nodes/nodeKeywords.ts` (Blender and Houdini names, former labels), used by both the palette filter and the node search.

## Palette
- A search field matches labels, type ids, category names and synonyms. The arrow keys and Enter pick a result without the mouse.
- Families appear as headings. Categories are collapsible rows with a colour swatch and a node count, plus "Expand all / Collapse all".
- A "Recent" section lists the last nodes added.
- A node is added by a click (at the spawn cursor), or by dragging it onto the canvas (where it is dropped).
- Open categories and recent nodes are remembered between sessions.

## Guarded by
`src/shared/graph/nodeCatalog.test.ts` checks that:
- every node has a known category, and no category is empty;
- categories are in alphabetical order within each family;
- no two offered nodes share a label;
- Blender and Houdini synonyms are found by search;
- no engine code tests a category;
- the merged effects switch sockets and evaluation, and draw the styled object rather than its source.
