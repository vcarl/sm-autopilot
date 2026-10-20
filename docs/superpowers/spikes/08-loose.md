# The loose prompt (2026-10-19)

**Question.** Can one pass, with no style frame and no plates, draw the selfie, so pictures stop being the same picture?

**Method.** This spike kept no notes; this is from its prompts (`experiments/loose-spike/prompts.py`) and the camera
spike's account. Eight recipe9 runs (a fight, two mining, trading, gas, docked, travel, a mission), two variants, 3 seeds
each (48 renders), through `scripts/flight-prompt.ts --kind scene`, so only the subject's art (or the grey `NEUTRAL`
frame) was sent. One template, filled by hand per run:

```
{style}: from the pilot's seat of {own}[, {cockpit}], through {canopy} onto {onto}, {pilot}, small in the lower left
corner; {subject}, large and filling the canopy, {action}[, {setting}], under {sun}.
```

`loose` as written; `look` adds the cockpit in words, "a worn starship cockpit of brass and leather". The canopy is cracked
and webbed in a fight.

**Findings.** Words carry the cockpit and the palette without a style frame, and the subject fills the canopy. Two faults
remained for the [camera spike](09-cameras.md): with no clothes named, the pilot was drawn as an airline captain (white
shirt, stripes), and one seat camera gives every flight the same composition.

**Verdict.** The selfie is one loose pass.

**Kept:** the template, "large and filling the canopy", the brass-and-leather cockpit, the sun last. **Dropped:**
`style.jpg`, the mission's console marker and the console item (neither showed).
