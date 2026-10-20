# References: keeping a subject's design in a new pose (2026-10-19)

**Question.** How does Qwen Image 2.1 Turbo keep a subject's design from its reference art while giving it a new pose,
light and scene, without pasting the reference in or taking the whole reference as the canvas?

**Method.** About 110 renders on mlx-serve 26.10.2, mostly seed 7 at 1024x768, then seeds 11–13 and 21–24. Subjects: two
catalog ships (Dust Devil on a yard photo, Eviction Notice among asteroids) and two non-game photos. Each render scored
0–2 on design kept, re-posed, backdrop gone, scene obeyed, style, and not over-sharpened. The server's fields read from
its source (`src/gen.zig`, `src/qwen_image.zig`).

**The server.**
- `POST /v1/images/generations`, JSON; `model` is required. `mode: "edit"` takes references (`image`, plus up to 9
  `ref_images`), named in the prompt as `<image1>`, `<image2>`, …; the target always starts from noise.
  `mode: "variation"` is img2img and takes no references; the two do not combine.
- `steps` is ignored (the Turbo grid is 8). Guidance with a negative prompt costs 2x and changed neither pose nor
  copying. A low `ref_resolution` weakens identity, not the pose. After the prompt, `seed` matters most.
- 15–20 s at 1024x768 with one reference, 25–31 s with three.

**Findings.**
1. The pose must be stated in the subject's own parts relative to us, and contradict the reference's pose. "Three-quarter
   view" kept the reference pose 15/16; "dives straight at us nose-first, its bow pointing at the viewer" re-posed 6/6.
2. Camera first for unusual angles: "we look straight up from underneath at X: its flat underbelly fills the top half"
   6/6; "X, seen from directly below" 1/6.
3. Never name the reference's backdrop, even to exclude it: naming the shipyard as absent put it in the canopy.
4. Once the pose is forced, one design clause of 15–25 words keeps turrets, vents and markings; with a weak pose it pulls
   the reference pose back.
5. Whole-image copy is a per-seed lottery: 0/4 at 1024x768, 4/4 at 1152x864 on the same seeds. Size, aspect, guidance and
   crop only re-roll the noise. Budget 2–3 seeds.
6. A tight crop to the subject cuts carry-over and costs nothing. White ground, line drawings and big blank canvases buy
   nothing; a line drawing imposes its own flat medium.
7. A model-made three-view sheet re-poses easily but invents wings. A plain edit cannot rotate a subject.
8. A canvas plus a reference ("replace the freighter in `<image1>` with …") swaps nothing.
9. Several references compose, but only the most forcefully posed subject re-poses; the rest keep their reference poses.

**Verdict.** Edit mode, cropped one-subject art, a camera-first prompt with a part-based pose, 2–3 seeds.

**Kept:** the request shape (`imager.ts`), the crop (`crop.ts`), camera-first wording and part-based poses (`prompts.ts`).
**Dropped:** guidance and negatives, `ref_resolution`, three-view sheets, line drawings, canvas plus reference.
