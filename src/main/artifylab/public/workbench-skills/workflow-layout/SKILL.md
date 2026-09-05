---
name: workflow-layout
description: Lay out and organize a ComfyUI workflow cleanly. Dependency-layered node placement with no overlaps, groups vs subgraphs, color-coding, and stage-aligned columns. Use when asked to tidy / clean up / organize / arrange a workflow, add groups or subgraphs, fix overlapping nodes, or build a workflow that should look good from the start.
---

# ComfyUI Workflow Layout & Organization

Turn a tangled graph into a clean left-to-right dataflow a human reads at a glance.
The golden rule: never lay out blind. Read the real node sizes and positions first
(from the workflow JSON or by inspecting the canvas), then compute positions from
them.

Two ways to apply a layout:

- **Edit the workflow JSON directly.** Every node carries `pos: [x, y]` and
  `size: [w, h]`; groups carry `bounding: [x, y, w, h]`. Writing positions into
  the JSON and reloading the workflow is the most reliable path and is fully
  scriptable.
- **Guide the user on canvas.** Give exact target coordinates or relative moves
  ("move the KSampler 400px right, below the second loader"); the user drags,
  groups (select nodes → right-click → Add Group / Ctrl+G), or converts stages
  to subgraphs (right-click → Convert to Subgraph).

## Reading the graph

Build a DAG from each input's `connected_from` / link list (ignore unconnected
widget inputs; only node→node edges matter). Note per node:

- `pos [x,y]` and `size [w,h]` (body only),
- the **true rendered footprint** = title bar + body. The title bar renders
  ~30px ABOVE `pos` and is NOT in `size[1]`, so stacking by `size[1]` overlaps
  every node by a header (the classic "headers eating the node above" bug).
  Budget `size[1] + ~30` for the header when stacking (a collapsed node is only
  the title height).
- mode badges: a `bypass`/`mute` node changes what the graph actually does —
  fix modes before layout so you don't tidy a graph that isn't running what it
  shows.

## The layout algorithm (dependency-layered, overlap-free)

1. Layer every node by longest path from a source:
   `layer(n) = 0` if it has no incoming node edges, else `1 + max(layer(of its sources))`.
   Layers become columns, left → right.
2. X by layer: `x = X0 + layer * COL_PITCH`, where `COL_PITCH ≈ widest node
   width in that column + ~80`.
3. Y by FULL height (this is what stops overlaps): stack a column top→down with
   `y[i+1] = y[i] + full_height[i] + ROW_GAP`. Never use a fixed row pitch.
   Tall nodes (KSampler, WanVideo Sampler, LoRA-select) are 480 to 600px and
   WILL overlap a 320 pitch.
4. Order within a column to cut wire crossings: place each node near the
   average Y of its connected nodes (a median/barycenter pass is plenty).

Reads-well constants: `COL_PITCH` 360 to 480, `ROW_GAP` 40. The header
allowance already accounts for the title bar, so don't add extra top headroom
per node; `ROW_GAP` is the clean gap you'll actually see.

## Subgraphs

A subgraph collapses a stage into one node with an input rail (left) and output
rail (right). Two rules:

- **Don't connect to a guessed boundary slot.** Interior nodes get onto the
  boundary by *exposing* their slots: in the frontend, wiring an interior node
  into the subgraph boundary creates/exposes the slot; in JSON, the subgraph
  node's inputs/outputs must match an interior node's slots exactly.
- **Rails don't follow the inner nodes.** If you move interior nodes, re-pin the
  input/output boundary slots to the node band: input rail near
  `minNodeX - 180`, output rail near `maxNodeX + 60`, both at the first row's Y.
  A stale rail leaves a huge wire gap (a common mistake).

Converting nodes to a subgraph preserves inner node ids; the subgraph node gets
a new id. Undo works as usual (Ctrl+Z).

## Groups vs subgraphs — choose deliberately

- Group (colored box): lightweight visual band; nodes stay in place and
  editable. Reach for this first, to label regions of a flat graph or band
  stage-columns at the root.
- Subgraph: collapses a stage into one node. Useful for large graphs, but it
  nests and hides nodes and adds boundary ports. Don't subgraph everything. A 2
  or 3 node stage rarely earns it, and over-subgraphing hurts readability and
  complicates packaging and handoff.
- Clean recipe: lay the flat graph out well → wrap only the complex stages in
  subgraphs → drop colored group bands around the columns at the root.

## Stage decomposition that fits most pipelines

`Loaders → Inputs → Preprocess (pose/controlnet/conditioning) → Embeds → Sample
→ Decode/Output`, one concern per column/stage, strictly left-to-right.

## Always leave inputs & outputs exposed

The nodes a user touches first, the input (Load Image / Load Video) and the
output (save / video-combine / preview), must stay expanded and visible so they
can jump straight in: drop in their media, hit run, watch the result. Collapse
the internal machinery (loaders, encoders, samplers) into chips to cut noise,
but never collapse the inputs or outputs. When they live inside subgraphs, keep
those subgraph nodes expanded, and consider promoting the one key widget
(prompt, seed) to the subgraph node so it's editable without drilling in
(recent frontends let you drag a widget onto the subgraph node).

> Heads-up: input/output preview nodes (`LoadImage`, `VHS_LoadVideo`,
> video-combine) report their full `size[1]` but render short until media loads.
> Size their group band to the `.size` (so it fits once filled), not to the
> empty-preview render.

## Gotchas

- **Save before relying on it.** Node positions, titles, and groups persist
  only once saved; a browser refresh reloads from the saved workflow (and
  re-binds nodes after installing packs).
- Moving nodes inside a subgraph leaves the rails behind. Always re-pin them
  (see above).
- Canvas edits never affect an in-flight render; but a ComfyUI restart clears
  the queue.
- **Image/video nodes under-report height.** `LoadImage`, `VHS_LoadVideo`,
  preview nodes return a tiny `size[1]` because the image/video preview height
  isn't in `.size`. Leave extra vertical room (≈250 to 300px) below them so the
  preview doesn't overlap the next node.
- Color-code by stage (e.g. all loaders `blue`, sampler `green`) and collapse
  rarely-touched loaders to cut visual noise. Cheap wins once the positions are
  right.
- Don't over-tidy a graph that's mid-build for the user. Confirm if a big reorg
  is wanted.

## Sources

- **Empirical:** spacing/grouping recipes from observed unreadable canvases
  (imported from artokun/comfyui-mcp, MIT; tool-specific steps rewritten for
  plain ComfyUI usage).
