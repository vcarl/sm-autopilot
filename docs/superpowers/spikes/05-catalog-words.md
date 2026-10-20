# The game's own words in the pictures (2026-10-19)

**Question.** Can the game's descriptions add SpaceMolt's flavour to the selfies without breaking subject recognition,
the framing, or a canopy that shows the flight?

**Method.** An inventory of `catalog.json` and six frame logs (Oct 18–19, about 500 MB), then 38 renders, 2 seeds each, on
4 runs, through `scripts/flight-prompt.ts --prompt-file` with each run's real references and seeds. Three shapings: (a)
the raw description, (b) its visual words extracted mechanically, (c) a hand-distilled phrase, short or long.

**Inventory.**
- Ships (370) and items (833) have descriptions, median 13 words, 2–4% visual; ship text is mostly function and removals,
  and every removed part named would be drawn.
- Systems (506) have text, mostly politics; the visual part is nearly always the sun.
- Stations have the best flavour in the game, but only 10 of 26 seen have text.
- Creatures, empires and non-station POIs have no text. Every POI has a `type`, and 519 of 544 a `class`; a sun's class is
  Morgan–Keenan (colour from the letter, size from the luminosity numeral).

**Findings.**
1. Raw text adds nothing or the wrong thing: trailing sentences were ignored 3/3; a station's "plaque" was drawn as a sheet
   of names in the cockpit.
2. Mechanical extraction is worse than nothing: lone adjectives vanish or attach to something new ("red, metal" drew a
   red-lit mining ship).
3. Hand phrases win, and the winning words are the light and the body behind the action. A sun by its class ("a swollen
   red supergiant sun") was the strongest flavour per word, and every system has one.
4. A colour word the art does not show repaints the subject ("rust-red" painted a grey ship red).
5. The pilot's own ship takes no words: any were drawn outside the canopy, both seeds.
6. Budgets: a subject's design clause 10–20 words; a setting 8–20 with no subject, 6 or fewer beside one.

**Verdict.** The spike recommended hand tables for POIs, stations and ships. Carl ruled server text only.

**Kept:** the Morgan–Keenan star table (`stars.ts`), the one authored exception; POI classes as the server sends them; no
words for our own ship; no colour beyond the art. **Dropped:** raw descriptions, an adjective extractor, hand-written
flavour tables for POIs, stations and pirate ships.
