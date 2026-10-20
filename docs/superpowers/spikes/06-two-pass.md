# Two passes, composited (2026-10-19)

**Question.** Draw the cockpit and pilot (a plate) and the view (the environment) separately, then composite the view into
the canopy, so that every picture is not one picture with a different window and the subject stops floating small in a
void?

**Method.** 58 renders, edit mode, 1024x768, mean 20.9 s, on five runs (a fight, trading, gas, mining, a mission).
- Environment pass: the subject's cropped art or a flat dark frame, no cockpit words.
- Per-pilot plates from five framing references (the style frame, its mirror, a blanked older render, a zoom-crop, a
  mirror of that), the canopy drawn as flat black; a cracked variant on the same seed.
- A threshold mask with an opening and flood fills, then the plate screened over the environment inside the glass (numpy,
  under 1 s).

**Findings.**
- Compositing fixes both problems: the subject fills the window, the view differs every run, the framing with the plate.
  No visible seams on whole canopies.
- Masks passed 19/21 first time. A cracked canopy cannot be masked by itself; the same seed and framing give a near
  pixel-identical cockpit, so it borrows the whole plate's mask.
- The framing comes from the reference, the pilot's look from the words: one shipped set of framings serves any pilot.
  Framing in words alone drew an off-look blue airliner cockpit.
- Any noun in the environment is drawn ("harvester" drew a farm harvester); without "lamplight" the view goes blue; a warm
  colour word repaints the subject.
- A harmonising edit over the composite over-sharpens and changes nothing about the light.
- The pilot's head occludes a centred subject on the close framings.

**Verdict.** It worked, at the cost of per-pilot plates, a mask and a compositor. Shelved for the
[loose one-pass prompt](08-loose.md), which needs none.

**Kept:** no viewer words in what fills the canopy; a flat frame when there is no subject art. **Dropped:** plates, masks,
compositing, the harmonising edit.
