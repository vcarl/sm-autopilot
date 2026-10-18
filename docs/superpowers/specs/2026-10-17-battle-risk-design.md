# Battle risk: fight to win, run to live

Status: design, 2026-10-17. Decisions are marked **(user)** or **(controller's call)**. Line numbers are against `main` as of today.

## Intent

The pilot leaves winnable fights too early and doesn't press the fights it takes. The user has seen three failures: it stalls out trying to flee, it lost every arena match because it fled too early, and it doesn't close range to get the most damage in. The user's rule: **"It should run to save its life." Losing the ship is dying; hull damage short of that is acceptable (user).** Today a 5-20% hull scratch is enough to make the code leave.

Labour splits two ways **(user)**. The LLM pilot decides *whether* to start a fight, from a simple, honest record of recent results. The code handles *survival inside* the fight: when to stay, when to run, closing range, and reloading.

## Evidence (verified against the kvothe runtime, 2026-10-17)

- **Battle totals.** `battle_ended` across `~/.hermes/profiles/kvothe/spacemolt/runtime/gameplay*.jsonl`: 1304 victory, 634 stalemate, 2 interrupted (unique battle ids). There are six `player_died` push lines (10-09 ×4, 10-12, 10-15).
- **Recent stalemates are escapes.** `combat.json`, last 60 fights: 47 victories and 13 stalemates. Every stalemate happened under stance `fire` with our hull at 100→100. In each one the quarry was at 2-25% hull and stepped out one range band (inner→mid) on the last row. Those are escapes, not danger. The first two ticks of each sit at outer, which is unused range.
- **Who flees.** There are 146 `stance flee` break-offs:
  - 59 were the agent calling `disengage()`.
  - 22 were `onTick` returning `{disengage:true}`.
  - 42 were "hull under the line, and Tired".
  - 7 were the hull line alone.
  - About 16 were the run-end guard (`src/run.ts:244`).
  - Of the 49 code-initiated hull-line break-offs, **22 were against an enemy below 50% hull**.
- **Tired ratchet.** The floor is `resolveWalkAway(pilot().mood)` (`hunting.ts:691`). Crossing Focused's 0.90 line makes the mood Tired (`mood-policy.ts:41-55`), and Tired's line is 0.95. Live 10-18 02:26Z: "hull 70/80 under the Focused walk-away line 72", then "breaking off: hull 70 under the line 76, and Tired", with Veil-Ray at 55%.
- **Arena.** The record is 0-14, all from 10-10, 10-11 and 10-13, before `arena()` existed (commit e33a843a99, 2026-10-13 20:47Z). Most losses were the run-end guard fleeing (and forfeiting) a match the agent's script had just started (`run.ts:244`). The rest were hand-rolled agent loops: 20+ consecutive `advance` calls against a kiter, or `fire` re-sent every tick. No `arena()` match has run since.
- **Flee stall.** A cheap pass found no long in-code flee since 10-16: 138 of 146 flees ended within 3 status polls, and the longest took 4. The stall matches the mechanism documented at `hunting.ts:225-233`. On 10-15 and 10-16 a flee was followed by `brace`, which reset the flee counter, and 26 braced ticks never ended the battle. The first of those lost the ship. That code is gone, but two hazards remain:
  1. **Unbounded flee.** `breakOff` is `disengageEffect(Infinity)` (`hunting.ts:398`). A blocked flee (`flee_required` absent: intercepted, webbed, or disrupted) holds forever, dealing 0% and taking 100% of incoming damage.
  2. **Unpriced escape.** Fleeing costs full damage for the retreat to outer plus `flee_required` ticks. Neither is weighed today.

  The builder must still find the user's specific stall instance: a flee longer than 4 polls, a `flee N/blocked` line, or a flee ending in `player_died`.

## Goals

1. Zero ship losses.
2. Stay in fights we are winning; never break off from a mere scratch.
3. Close to the best range early and hold it.
4. Never fire from an empty or nearly empty magazine while ammo is in the hold.
5. Give the agent a short, honest record per enemy class, so its choice to engage is informed.

## Non-goals

- A predictive combat model. Risk is recent performance, nothing more **(user)**.
- Boarding or marines **(user)**. Fleet tactics. Multi-battle handling.
- Retuning fuel reserves or service spend in `mood-policy.ts`.
- New target filtering beyond the agent's explicit risk limit (D3). `decline()` (`hunting.ts:191-201`) is unchanged.

## Anti-goals

- **No arena branch (user).** The only input is whether losing the fight is fatal to the ship.
- No mood-based hull fraction gating a fight.
- No silent skips or refusals. Per AGENTS.md:11 ("Observe, don't gate"), a shortfall is reported, not enforced.
- No new config system. The danger line and its kin are constants with a `ponytail:` note.

## Constraints

- **Tick budget.** One mutation per ~10 s tick (`hunting.ts:114`). Reload, advance, stance, and focus compete for it. `tick_duration` isn't monotonic (`hunting.ts:450-458`); the poll is the round.
- **Reload cost.** Reloading discards the rounds still in the magazine (`ReloadResponse.rounds_discarded`, `wire.gen.ts:134`). `FittedModuleSnapshot.magazine_size` is published (`wire.gen.ts:91`).
- **Range data.** The server publishes `max_weapon_reach` and `zone_distance`. "Optimal range" is not published. Per-band accuracy is measured (`statsFor().accuracy`, `combat-memory.ts:179-215`).
- **Combat memory is small and keyed by name.** It keeps `CAP=60` fights in total (`combat-memory.ts:22`), so "last ~10 vs a class" is bounded by that, and a class fought rarely may age out. Records are keyed by opponent display name (`hunting.ts:793`). Each record has `ending` and `hull_pct_from`/`hull_pct_to`. Controller's call: retention changes from 60 fights total to the last 10 per class, so a rarely fought class keeps its record instead of being pushed out by common quarry.
- **Fight ceiling.** `FIGHT_CEILING_MS` (5 min, `hunting.ts:115`) ends unresolved fights.

## Decisions

**D1. Recent record per enemy class (user).** Build it from `combat.json`: the last ~10 fights against that class, using the same data `statsFor` (`combat-memory.ts:179`) reads today but only displays. Report:

- won / stalemate / lost counts;
- average and worst hull lost (percentage points, from `hull_pct_from − hull_pct_to`);
- `covers`: whether current hull minus that worst loss stays above the danger line.

A class never fought reads `unknown`, and the agent decides. Thin samples are flagged as they already are (`THIN=3`). Whether "class" means display name, species, or ship class is the builder's choice.

**D2. The in-fight rule (user).**

- **Danger line.** Flee only when hull falls below a fixed danger line: about 30% of max hull. The builder may tune it with evidence from the logs.
- **Enemy closer to dead.** Below the line, keep fighting if the enemy is closer to dead than we are (enemy hull% < ours).
- **Losing isn't fatal.** When losing doesn't destroy the ship (the arena), the danger line doesn't apply. The battle loop needs one input, "is loss fatal", in place of `floor:0` (`arena.ts:43`).
- **Survivable escape (controller's call).** If the line is crossed but the escape itself can't be survived (their recent damage per tick × (ticks to reach outer + `flee_required`) ≥ our hull), keep firing; it's the better chance.
- **Bounded flee (controller's call).** If `flee_required` reads blocked, or `flee_counter` doesn't advance for N polls, go back to `fire` and re-apply this rule. `breakOff` must be able to exit without the battle ending.
- **Tired and mood (user).** Tired no longer breaks off a fight in progress (`hunting.ts:448`, `466`). The mood walk-away fractions (`mood-policy.ts:19-26`) stop gating fights, including the hunt's between-fight check (`hunting.ts:765`). Tired may still stop a hunt from starting the next fight (`hunting.ts:807`).

**D3. Risk limit on `hunt()` (user).** The agent passes a risk limit. The hunt skips any target whose worst recent fight cost more hull than we have above the danger line, and names each skip in its result. Unknown classes are not skipped unless the agent's limit says so. The builder picks the parameter shape. Skips are reported with the same visibility as `decline` reasons, never silent.

**D4. `pursue`, default off (user).** Escapes are acceptable. `fight`/`hunt` take `pursue`. When it's on, the code chases an escaping quarry (advance on the first tick the range opens) while we're above the danger line. Today the chase waits a tick for `end.fled` (`hunting.ts:483`, `523`). With `pursue` off, an escape is a clean stalemate.

**D5. The run-end guard (user).** `run.ts:244` flees any battle the agent's script left live. It must not flee or forfeit a live arena match. Controller's call: hand any live battle to the battle loop under D2 instead of `disengage()`. Then `run.ts:234`'s arena carve-out collapses into "loss not fatal".

**D6. Close range proactively (controller's call).** Advance from the first tick, not only when `far>reach` (`hunting.ts:523`). Target the band with the best measured `at_them` accuracy; with no data, close as far as the zones allow. Keep the kiter evade rule (`hunting.ts:510`) and the single brace (`hunting.ts:517`). Brace must never follow flee.

**D7. Reload proactively (user: automate reloading).**

- **In fight.** Top up a weapon below a fraction of `magazine_size` during a lull (out of reach, or nothing else owed this tick), weighing the discarded rounds.
- **Before engaging.** `loadoutEffect` (`hunting.ts:166-185`) reloads any non-full magazine, not only empty ones.
- **Low hold ammo (controller's call).** This is information: a clause in the hunt's `did` and in the juncture. It is not a refusal. The existing refusal stays only for "no weapon can load at all".

**D8. Surface the read (controller's call).** Today the agent sees no prey. The juncture (`bridge.ts:409-421`) carries `threats`, which covers players and empire NPCs only (`threatsHere`, `menu.ts:298`, deliberately ignores pirates), plus `walk_away`. `combatLine` (`combat-memory.ts:221`) is written but nothing in production calls it. Surface D1 in three places:

1. **Juncture.** A `prey` block when undocked with creatures or pirates present: one line per legal candidate with the record, average and worst hull lost, `covers`, and low-ammo if any. Replace `walk_away` with the danger line.
2. **`TickView`.** Replace `floor` (`hunting.ts:84-85`) with the danger line and whether loss is fatal.
3. **`hunt()` results.** Each `Fight` carries the record it was chosen against, and skips are listed.

**D9. The agent's own exits stay its call (controller's call).** `onTick` `{disengage:true}` and explicit `disengage()` are still honoured. Better information (D8) is the fix for the 81 agent-chosen flees.

## Left to the builder

- The danger line's exact value, N for the bounded flee (D2), and the reload threshold. Evidence goes in the commit.
- The class key for the record, and the shape of `hunt`'s risk-limit parameter.
- How the juncture gets `prey`: the `get_nearby` read it already makes, or a cached look from `sighting-memory.ts`.
- Root-causing the user's flee stall, plus a regression fixture for it.

## Success criteria

- Zero ship losses over the next 100 fights.
- Break-offs against an enemy below 50% hull: from 22/49 to near zero.
- At least one arena challenge won (`arena_wins` > 0), with no arena-specific code.
- Nice-to-have, not a target: fewer stalemates (13/60 today), mainly via `pursue`.

## Test strategy

1. **Unit tests, record read (D1).** Mixed endings, worst vs average hull lost, `covers` either side of the line, an unknown class, a thin sample, and the 10-fight window.
2. **Unit tests, danger-line rule (D2).** Above the line stays. Below the line with the enemy lower stays. Below the line with the enemy higher flees. An unsurvivable escape keeps firing. Loss-not-fatal never flees. A blocked or stalled flee resumes `fire`. Tired mid-fight does not break off.
3. **Replay tests.** Use logged status sequences through `battleLoop` with `pace` and the fake `Game` (`combat.test.ts`):
   - the 10-18 02:26Z Tired break-off must stay in;
   - a Veil-Ray stalemate must chase only with `pursue`;
   - a run-end live battle must be fought, not fled;
   - a hunt with a risk limit must skip and report.
4. **Live acceptance.** An `arena()` run against First Blood (Ring Levy), plus a hunt session on kvothe, judged on the criteria above.
