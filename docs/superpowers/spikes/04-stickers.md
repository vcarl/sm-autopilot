# Pasted stickers: does the reference sentence matter? (2026-10-19)

**Question.** The round-5 selfies pasted each reference like a sticker: its pose, its light, often its background. Does
rewording only the sentence that maps references to subjects change that?

**Method.** Two of Kvothe's junctures (a Veil-Ray fight with loot; a sale), each on its own seed (`seedOf(run_id)`) with
the same references in the same order, one render per variant, 1024x768. Five variants of the one "Match …" sentence:
unchanged; "design references only, redraw each in this scene's light, angle and scale"; that plus "seen from a different
angle"; that plus "painted in the same ink and light"; and the design-references sentence moved to the start.

**Findings.**
- No wording unpasted anything. The ship and the ray kept their reference poses in every variant; the Cobble kept its
  photograph's dock.
- Moving the instruction to the front moved a subject a little, and the pilot's pose with it. The added clauses did
  nothing the first one had not.
- A composite reference (a creature portrait and a loot vial on one black image) came back as one sticker.
- One seed and one render a cell: differences between variants are not separated from noise.

**Verdict.** Wording is not the lever; what is sent is.

**Kept:** one-subject art, cropped. **Dropped:** composite references, reference-sentence tuning, any full-scene card as a
reference.
