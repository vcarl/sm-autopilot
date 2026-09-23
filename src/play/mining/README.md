# mining — the Prospector's evening

The evening you are having is "I'll fill the hold and bring it back." It trains mining, piloting
and navigation at once, needs nothing but a laser and a belt, and is the safest way to earn
early. It is also the easiest evening to stagnate in: the same belt, the same trip, forever.

## Functions

| Function | Promise |
|---|---|
| `gatherUntil({poi, base?, until?, maxTrips?, then?})` | one trip by default: out, hold full, back, stow, service; `until` loops trips until the store holds enough; `then: 'sell'` sells each take |
| `survey()` | reveal hidden deep-core deposits (not built yet: `account().commands.spacemolt.survey_system()`) |

Use `scout()` from the root to find belts: a POI with `type: asteroid_belt` (or `ice_field`,
`gas_cloud`). Use `prices()` at a station to learn what each ore is worth before you choose a belt.

## Worked example

```ts
import {orient, scout, gatherUntil, prices, sell, note} from 'play';

export default async function main() {
  const look = await orient();
  const here = await scout();
  const belts = here.detail.pois.filter(p => p.type === 'asteroid_belt');
  if (!belts.length) { note('no belt in this system; scout a neighbour next'); return here; }

  // Three trips or until 200 aluminum_ore sit in the store, whichever first.
  const run = await gatherUntil({poi: belts[0].id, until: {item: 'aluminum_ore', quantity: 200}, maxTrips: 3});
  if (run.status === 'refused') return run;          // the reason says what would admit it

  // The trip stows at the base, so `run.now.cargo` is empty: the take is `run.gained.items`
  // (measured aboard) and `run.detail.settled` (what reached the store, ready to sell).
  note(`took ${run.gained.items.map(r => `${r.quantity} ${r.item_id}`).join(', ')}`);

  const worth = await prices();                       // what the take is worth here
  const cheap = run.detail.settled.filter(r => r.item_id !== 'aluminum_ore');
  return sell(cheap, {from: 'store'});                // the rest of the take, by name
}
```

## Playing the intro stage

You start docked, with a free starter hull, 50–100 cargo, and a few hundred credits. The way
out is: first 2,500–10,000 credits, skills 1–3 in mining, trading and navigation, one T1 hull
(~2,000 cr), and a home base near where you work.

1. `orient()`. If `home` is unset, the operator sets it; say so in `note()` and stop.
2. `scout()`. Find a belt (`type: asteroid_belt`) and a station with `market` and `storage`.
   No belt in this system: `scout('<neighbour system id>')` from `connections`, then `goTo` it.
3. `missions()` at every dock. A difficulty-1 "deliver 20 ore" or "visit X" mission is credits
   for a trip you were making anyway. Max 5 active: `detail.slots_free` says how many you may
   still take, so slice the board by it. Accept what matches; complete on return.
   `slots_free: 0` with nothing completable means a mission is stuck: each `detail.active` row
   carries its `progress` and a `stuck` reason (expired, destination elsewhere, goods you do not
   have), and `abandonMission('<id>')` drops one and frees the slot — it refuses a mission you
   could turn in here unless you pass `{force:true}`, and refuses an id that was never active
   (a placeholder id is not a success; already-gone ids stay `done`). `completeMissions()` first: it withdraws
   from the store here for a `deliver N of item` objective the store can cover.
4. `gatherUntil({poi})`: out, mine until full, back to the base you left, stow, service. One call
   is one trip of ~15 minutes. `gatherUntil({poi, until: {item, quantity}})` loops trips.
5. `prices()` then `sell(rows)`. Trading xp scales with credit volume; ore sells for little, refined
   for 2–40× more (that is the industry career).
6. First purchase at ~2,000 cr: a cargo expander (`buy`, then `refit({install:['cargo_expander_ii']})`),
   named by every guide as the correct first buy — it is only correct if a utility
   slot is free (the play README's "Getting a better ship").

## What a good trip looks like

- The belt is one hop or less from a station with `market` and `storage`. Fuel is the cost.
- The ore has a buyer. Iridium at 53 cr beats aluminum at 6 cr for the same hold.
- Your laser's power matches the deposit's `supported_power`; a deep-core deposit needs power
  3+, and mining one trains deep_core_mining, which is worth +5% yield per level.
- The hold is empty when you leave. `gatherUntil` refuses a full hold; `sell(rows)` or `stow(rows)` first.

## What you see while it runs

One line per leg (`goTo`, `mine`, `stow`, `service`) and, while mining, a yield line at least
every two minutes: ticks so far, hold used, what came aboard. A silent run is a bug.

## When to reconsider

- A trip yields the same ore your store already has 400 of. Sell it, refine it (industry), or
  change belts.
- Yield per trip drops: the site is depleting (`ended: 'depleted'`). Move on.
- The mining skill has passed 5 and the credits per hour are flat: the ceiling is the hull's
  cargo, not your skill. An Archimedes (T1 miner, 185 cargo, ~2,200 cr) or an Excavation
  (T2, 250 cargo, ~8,000 cr) via `account().commands.spacemolt_ship.browse_ships()`.
- Two shifts in a row were mining. Reflection should reach for something else.

## Pitfalls

- A gather that comes home with `yield: []` is not evidence of a take; read `detail.ended`.
- Mining while docked is refused by the game. `gatherUntil` flies first; a station POI or a
  base id as `poi` is a refusal, not a trip.
- Belts in police-0 systems have pirates. `scout` reports `police_level`.
- Tired mid-dig ends the mining leg, flies the return leg, stows and services, then stops with
  `ended: 'tired'`. Resupplying clears it; the next `gatherUntil` continues.
- A trip cut off out at the belt leaves its ore aboard. Re-run `gatherUntil` with the same
  arguments: it re-enters at the leg the live world implies, and the stow at the base moves
  every hold row the belt's own resources name — the earlier trip's ore included.
