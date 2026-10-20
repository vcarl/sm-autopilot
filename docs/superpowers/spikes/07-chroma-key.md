# Chroma key instead of the black mask (2026-10-19)

**Question.** Does a key colour in the canopy, removed with a colour-difference matte, beat the two-pass spike's black
threshold, opening and flood fill?

**Method.** 29 renders on two framings, seeds 11 and 12, whole and cracked canopies. Round 1 (15): the framing reference's
canopy painted #00FF00 or #FF00FF, the prompt silent. Round 2 (14, Carl's variant): a black reference and a prompt asking
for a chroma-key screen. Keyed by `G-max(R,B)` (green) or `min(R,B)-G` (magenta), a soft ramp, and a 6 px despill ring.

**Findings.**
- A painted reference is ignored, 0/12, and painted plus prompted cancels the key, 0/2.
- A prompted key on a black reference keyed 12/12, cracked plates included, with no same-seed pair. Magenta was the
  flattest (keyness p5 up to 0.99) with the least spill, on only 2 renders.
- The screen lights the pilot: a coloured rim on the hair. Cracks come out dark on the key and read poorly over space,
  where the black plate's bright, screened cracks read well.
- A key does not let words drive the framing: words-only framing was the same off-look cockpit.

**Verdict.** The better matte ("the canopy glass is a flat chroma-key magenta screen, ready for compositing"), for a
pipeline that was then shelved.

**Kept:** nothing in code. **Dropped** with two-pass compositing.
