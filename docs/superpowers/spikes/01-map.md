# Map spike (2026-10-16)

**Question.** Can a faithful, detailed map of where Kvothe went and what it did there be drawn from the journal alone?

**Method.** A Pillow prototype over every rotated `gameplay*.jsonl` (2,606 runs). Each run is replayed from
`start_state.system` through its successful `jump`s, so commands, `trade` lines, `battle_ended` pushes, `death` and
`stranded` land on a system. Coordinates from the game's public `/api/map`; `sightings.json` mapped to systems through
the POIs learned on the replay, `places.json` and id prefixes. Scope: the last 28 runs (6 systems, 10 faint neighbours).
Forty runs pulled in a 30-jump march across the galaxy (32 systems), so 28 was the cut.

**Findings.**
- Real galaxy coordinates, glyphs with counts and labels on their own layer read well; about 1 s a render.
- The journal has no security tier for most systems (`systems.json` says `Lawless` throughout and lacks most visited
  ones), no fight win or loss (only victory or stalemate), and the galaxy map has no POIs.

**Verdict.** The reference for what "faithful and detailed" means in the
[activity map design](../specs/2026-10-16-activity-map-design.md).

**Kept:** the replay attribution, real coordinates, the separate label layer. **Dropped:** Pillow (the renderer is
TypeScript over `@resvg/resvg-wasm`) and the last-N-runs scope (now one juncture, its context muted).
