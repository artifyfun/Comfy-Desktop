---
name: debug-render
description: Debug a WRONG or imperfect render (not a hard error) by inspecting inputs and intermediate stages. Render one branch up to an output, add preview taps for latents/masks/preprocessor maps, localize the first bad stage, then fix. Use when a final image/video completes but looks wrong, such as artifacts, wrong subject/pose/composition/color, blur, a ControlNet/IPAdapter/mask/LoRA not taking, or a two-stage refiner or upscale degrading the result. For errors/OOM/missing nodes use the troubleshooting skill.
---

# Debugging wrong renders by partial execution

When a final asset looks wrong (not when it errors), don't re-roll the whole
graph and hope. Localize the fault. Render only as far as one stage and look at
what that stage actually produces. The wrong-looking output is downstream of a
*first* bad step. Find that step, fix it there, and everything after it follows.

ComfyUI natively supports partial execution: an output node plus everything
upstream of it renders; every other branch is skipped. In the frontend, select
the target output node and press **Ctrl+Enter** to queue just that branch (or
bypass/mute the other branches with Ctrl+M and run normally). Each probe is
fast and cheap, and the preview appears on the canvas when it lands.

## When to reach for this

- A final image/video is wrong: artifacts, wrong subject/pose/composition, off
  color, soft/blurry, melted hands, wrong style.
- A conditioner isn't "taking" (ControlNet, IPAdapter, a mask, an inpaint, a
  LoRA) and you can't tell if the *input* to it is wrong or the *node* is wrong.
- A multi-stage pipeline (base → refiner, txt2img → upscale, decode → post)
  degrades, and you need to see which stage introduces the problem.
- You only want to test one branch of a multi-output graph without paying for
  the others.

If instead the run fails (red error, OOM, missing node, black image from a
crash), use the troubleshooting skill. This skill is for outputs that
*complete* but look wrong.

## The one hard rule: partial runs target an OUTPUT node

ComfyUI can only run *to* an output node: SaveImage, PreviewImage, SaveVideo,
SaveAudio, etc. A bare KSampler / VAEDecode / preprocessor is not an output
node, so you can't target it directly. To inspect a point that isn't already an
output, add a preview tap there:

| You want to see… | Wire type | Tap to add | Wiring |
|---|---|---|---|
| An intermediate image (post-process, refiner stage, composite) | IMAGE | `PreviewImage` | image → `PreviewImage.images` |
| A latent (after a sampler, before/after upscale) | LATENT | `VAEDecode` → `PreviewImage` | latent → `VAEDecode.samples`; reuse the graph's VAE → `VAEDecode.vae`; then → `PreviewImage` |
| A mask (inpaint, segmentation, attention) | MASK | `MaskToImage` → `PreviewImage` | mask → `MaskToImage.mask` → `PreviewImage` |
| A ControlNet/preprocessor map (depth/pose/canny) | usually IMAGE already | `PreviewImage` | the preprocessor's IMAGE output → `PreviewImage.images` |
| The actual prompt/conditioning | CONDITIONING | (can't preview as an image) | inspect widget values / the text node feeding it instead |

Add the tap node (right-click canvas → Add Node), wire it, run to it, inspect,
then delete the tap when you're done (unless the user wants to keep it).

## The loop

1. **Read the graph.** Walk it (from the canvas or the workflow JSON). Note node
   ids, the output nodes (Save*/Preview*), and every node's mode. A node in
   `bypass`/`mute` on the path is OFF and is a top cause of wrong renders. Fix
   modes first before you blame anything else.
2. **Pick a probe point** roughly in the middle of the suspect chain (bisect).
3. **Get an output there.** Target an existing output node, or add a preview tap
   (table above).
4. **Run only that branch** (select the probe's output node → Ctrl+Enter, or
   bypass the rest).
5. **Look at the result.** Is *this* stage already wrong, or still fine?
   - Still fine: move the probe downstream; the fault is later.
   - Already wrong: move the probe upstream; the fault is earlier.
6. Repeat until you find the first stage whose output is bad. That node (or its
   inputs/widgets) is what to fix — widget value, mode, a rewire, or a different
   model. Then run-to-node there again to confirm the fix before running the
   full graph.
7. **Clean up** temporary preview taps and do a final full run to produce the
   real saved asset.

## Symptom → where to probe first

- **Whole image wrong subject/style.** Preview the conditioning's source (the
  text/prompt node, the sampler's positive input via a decode of its latent).
- **ControlNet ignored / wrong structure.** Preview the preprocessor map
  (the depth/pose/canny IMAGE going into the ControlNet). A blank or wrong map means
  the problem is the preprocessor or its input, not the sampler.
- **IPAdapter/reference not taking.** Preview the reference image after any
  resize/crop the IPAdapter chain applies.
- **Inpaint/outpaint bleeding.** `MaskToImage`-preview the mask actually reaching
  the sampler (mask misalignment is the usual culprit).
- **Refiner/upscale degrades it.** Preview the base latent (VAEDecode tap)
  *before* the refiner vs after. If the base is good and the result is bad, the
  refiner/upscale stage is at fault.
- **Right content, bad quality only.** The fault is late (sampler steps/cfg, VAE,
  post), so probe near the end first.

## Gotchas

- **Output-node only.** A partial run targeting a non-output node is rejected.
  Add a preview tap instead.
- **Modes matter.** A bypassed/muted node on the probed path silently changes what
  renders. Check modes in step 1.
- **Preview taps are not saves.** A `PreviewImage` shows on the canvas but saves
  nothing; "no saved output ran" is expected for a probe. Check the preview
  node's canvas thumbnail (or the temp output folder) rather than the saved
  files.
- **Shared queue.** Each partial run queues a real (small) job. Don't stack
  probes. Run one, read it, then the next.
- **Subgraphs.** Output nodes nested inside a subgraph may not be directly
  selectable as a run target from the root. Probe at the root graph: add the
  tap outside the subgraph, fed by an exposed output rail.

## Sources

- **Empirical:** probe-point recipes from observed wrong-render cases
  (imported from artokun/comfyui-mcp, MIT; tool-specific steps rewritten for
  plain ComfyUI usage).
