# mining — the Prospector's evening

The evening you are having is "I'll fill the hold and bring it back." It trains mining, piloting
and navigation at once, and is the safest way to earn early. It is also the easiest evening to
stagnate in: the same belt, the same trip, forever.

## Functions

| Function | Promise |
|---|---|
| `gatherUntil({poi, base?, until?, maxTrips?, then?})` | one trip by default: out, hold full, back, stow, service; `maxTrips` alone makes that many trips; `until` loops trips (up to `maxTrips`, 6 by default) until the store holds enough; `then: 'sell'` sells each take |
| `survey()` | reveal this system's hidden POIs (deep-core deposits, wormholes): `detail.newly_revealed` and `already_revealed` (each with `resources` when listed), `faint_signatures` it could not resolve, and the `survey_power` and `anomaly_hint` your fit brought. Nothing new is still `done`, and the `did` names the power. A lost reply is `partial` and not re-sent |

`scout()` finds belts: a POI with `type: asteroid_belt` (or `ice_field`, `gas_cloud`). `prices()`
at a station says what each ore is worth before you choose one.

## Worked example

```ts
import {orient, scout, gatherUntil, sell, note} from 'play';

export default async function main() {
  await orient();
  const here = await scout();
  const belts = here.detail.pois.filter(p => p.type === 'asteroid_belt');
  if (!belts.length) { note('no belt in this system; scout a neighbour next'); return here; }

  // Three trips or until 200 aluminum_ore sit in the store, whichever first.
  const run = await gatherUntil({poi: belts[0].id, until: {item: 'aluminum_ore', quantity: 200}, maxTrips: 3});
  if (run.status === 'refused') return run;          // the reason says what would admit it

  // The trip stows, so `run.now.cargo` is empty: the take is `run.gained.items` (aboard) and `run.detail.settled` (in the store).
  note(`took ${run.gained.items.map(r => `${r.quantity} ${r.item_id}`).join(', ')}`);

  const cheap = run.detail.settled.filter(r => r.item_id !== 'aluminum_ore');
  return sell(cheap, {from: 'store'});                // the rest of the take, by name
}
```

## Early income

The way out: 2,500–10,000 credits, skills 1–3 in mining, trading and navigation, one T1 hull.

Read `missions()` at every dock. Iron Supply Run (mine 30 `iron_ore`, 1,500 cr) and Copper Requisition
(25 `copper_ore`, 1,800 cr) pay ten times the ore's worth, once each. At mining 5, Deep Core Prospecting
(20 `platinum_ore`, 5,000 cr, 10 `exotic_matter`) opens a chain paying 8,000, then 10,000 cr. The
wallet cap can cut any turn-in (`credits_shortfall`, see Missions).

First purchase at ~2,000 cr: `cargo_expander_ii`, if a utility slot is free (`buy`, then `refit`).

## Refining

The starter recipes need no skill: `basic_iron_smelting` (10 `iron_ore` → 1 `steel_plate`) and
`basic_copper_processing` (8 `copper_ore` → 1 `copper_wiring`). At base value both lose (50 cr of
iron makes an 18 cr plate): they train crafting, not profit. The facility recipes yield 4× as
much: `refine_steel` (5 → 2) and `process_copper_wiring` (4 → 2). Rent one: `at` is a facility id
from `facilities().detail.here`. `quote(recipe, qty, {at})` prices the `margin`; if it is negative, sell the ore.

## What a good trip looks like

- The belt is one hop or less from a station with `market` and `storage`. Fuel is the cost.
- The ore has a buyer. `iridium_ore` (base value 90) beats `aluminum_ore` (6) for the same hold.
- Your laser's power matches the deposit's `supported_power`. Deep-core deposits sit at hidden POIs
  (`survey()` reveals them) and need a `deep_core_extractor_*`; they never go too sparse. deep_core_mining
  (+5% deep-core yield a level) trains by mining at power 3+ or by deep surveys.
- The hold is empty when you leave, but for `service()`'s fuel cells. `gatherUntil` refuses a full hold.

## When to reconsider

- A trip yields the same ore your store already has 400 of. Sell it, refine it, or change belts.
- Yield per trip drops (`ended: 'depleted'`). Below a quarter of `max_remaining` a strong array loses
  its lock (`deposit_too_sparse`; `lock_minimum_stock` says how much it needs). Work another meanwhile.
- A site with several ores draws one each cycle, weight `richness × (1 + 0.1 × mining level × rank)`,
  rank 0 common to 4 legendary. Rare deposits are thin (richness ~9–17 against ~42), so skill trades
  tonnage for rarity. A fitted `filter_*` module drops its ore from the draw.
- Mining past 5 and flat credits per hour: the ceiling is cargo. An Archimedes (T1, 80, ~2,500 cr)
  barely beats a starter's ~70; an Excavation (T2, 200, ~8,000 cr) is the step. See `shipsForSale()`.

## Pitfalls

- A gather that comes back with `yield: []` is not evidence of a take; read `detail.ended`.
- A station POI or a base id as `poi` is a refusal, not a trip: the game refuses mining docked.
- Belts in police-0 systems have pirates. `scout` reports `police_level`.
- Tired mid-dig ends the mining leg, flies back, stows and services, then stops with
  `ended: 'tired'`. Resupplying clears it; the next `gatherUntil` continues.
- A trip cut off at the belt leaves its ore aboard. Re-run `gatherUntil` with the same arguments:
  it re-enters at the leg the live world implies, and the stow moves the earlier ore too.
