# SpaceMolt checklist

What is still worth doing, in today's design: one juncture per cron fire, a pilot program written
against the `play` library (`src/play/`, whose READMEs are its skills) and flown by `spacemolt_run`,
a derived mood, and a stance that picks the career README. [../docs/VISION.md](../docs/VISION.md)
is intent, [../AGENTS.md](../AGENTS.md) is how the code works and the principles it keeps, and
`worklog/` is history. None of them is edited from here.

- Check an item only when its observable result exists. A stub, an accepted command, or a model's
  claim is not completion.
- Put the evidence beside a checked item — a path, a test command, a journal excerpt with its
  `run_id` — and name its level: **fixture** (a fake account, no game), **replay** (recorded
  `gameplay.jsonl` traces driven through the real bridge), or **live** (a real profile; one
  recorded run, never a model's say-so).
- Reopen an item when later evidence invalidates it.
- An item that would add a refusal a pilot must satisfy, or a verdict to the telemetry, does not
  belong here (AGENTS.md, Principles).

## The play library

Each throws `unimplemented` today; `account()` reaches the raw command meanwhile.

- [ ] `survey()` reveals hidden deep-core deposits in this system (`survey_system`), and
  `exploreNearby`'s `survey` option uses it. [mining/README.md](../src/play/mining/README.md)
- [ ] `exploreNearby({systems?, jumps?, survey?})` walks a circuit of nearby systems, scouting each,
  so charting is one call rather than a hand-written `goTo` + `scout` loop.
  [exploration/README.md](../src/play/exploration/README.md)
- [ ] `patrol({systems?, maxTier?, fights?})` sweeps lawless systems for pirates up to a tier and
  a number of fights, never engaging `[POLICE]` or a player.
  [combat/bounties/README.md](../src/play/combat/bounties/README.md)
- [ ] `ships()` lists the ships the account owns and where each is stored.
  [fleet/README.md](../src/play/fleet/README.md)
- [ ] `switchShip(id)` swaps the flown hull at a shipyard, stowing and servicing first.
  [fleet/README.md](../src/play/fleet/README.md)
- [ ] `service({insure: true})` buys cover; today it reports `insure: not implemented yet` and
  buys nothing. [combat/README.md](../src/play/combat/README.md)

## Live acceptance

One recorded live run each, cited by `run_id` / `juncture_id`.

- [ ] A full live cycle ending in a completed objective: given a bounded objective ("gain one
  Crafting level, then stop"), the pilot reaches it across junctures and runs, and at least three
  later fires leave goal and stance unchanged while the pilot says it is done.
- [ ] Silence: a fresh profile with no objective and no instruction picks a goal and stance
  (`spacemolt_reflect`) and flies first work from what it observes, with nobody supplying ids.
- [ ] Tired from each of travel, mining and a fight: the runtime drives the ship to fuel and repair
  without the pilot writing it, and the pilot's work carries on afterwards.
- [ ] Broke or stranded: a pilot whose `resupply` answers `broke` or `stranded` gets back to
  flying by earning, not by a human, and the journal shows how.
- [ ] Gateway restart mid-run: the next bridge closes the run `interrupted`, re-runs nothing, and
  the next juncture's context shows the interrupted run so the pilot re-plans from it.
- [ ] `spacemolt_stop` reaches a flying program at its next safe point without a model turn, and no
  new program starts until the pilot is told otherwise.
- [ ] Freight and passengers: one `hauling/` contract hauled and delivered with the debt settled,
  and one passenger run unloaded with exact fares. Fixture-proven in `hauling.test.ts`; never
  flown live.
- [ ] Direction probes: a `spacemolt_direct` instruction given while a program flies lands at the
  next run, not by killing the flying one; a request to spend past `permissions.credit_reserve`
  is declined naming the permission, which the asking does not widen.

## Open game questions

Mechanics not yet observed live. Record what the game did in
[docs/GAMEPLAY.md](../docs/GAMEPLAY.md) when first seen.

- [ ] An unasked-for fight during travel or mining. `goTo` turns `in_battle` into a refusal naming
  `disengage()`; what `gatherUntil`, `tradeRun` and a freighter lap report when a battle starts
  under them, and whether anything should fight back without a model turn, is unseen.
- [ ] A move the pilot did not command — respawn after death, capture, a fleet tow, mobile-capital
  transit, a stranded passenger. The bridge journals `unsolicited_move` and `death`
  (`src/bridge.ts`, `src/reconcile.ts`); no live instance has been journalled.
- [ ] A freighter picked up by `resumeFreighters` mid-lap after a bridge boot (the old bridge
  `resume`, in today's terms) is not recorded live.
- [ ] Whether the repair rate climbs with damage; the one live sample is 5 cr/hull.
- [ ] `set_home` and `get_tax_estimate` have never been sent live; whether a respawn follows
  `set_home` is unknown.
- [ ] `view_storage`: what `hint` says, the shape of populated `gifts`/`messages`, whether
  `locations` is ever empty rather than absent, and what a bad `station_id` does.
- [ ] Which field a live workshop queue row carries (`venue`, `venue_type`, `facility_id`);
  `jobs()` infers "paused" from it. [industry/README.md](../src/play/industry/README.md)

## Tests and analysis

- [ ] Server traps the library reaches are pinned by a test in the owning module: `view_orders`
  pages through `has_more`; a bulk order that succeeds with no `order_id` is escrow-then-refund;
  PERMANENT markers land mid-string; `cargo_full` on loot is success.
- [ ] Replay level exists: `gameplay.jsonl` sliced into named per-scenario traces (movement and
  gathering first) and driven through the real bridge, so juncture and recovery behaviour can be
  proved without a live connection.
