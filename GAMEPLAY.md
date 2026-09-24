# Observations from live Kvothe play

Observed September 8, 2026 using @spacemolt/lib 14.2.0. Recheck current game
state; these are learned mechanics and examples, not guaranteed opportunities.

## Freight

Accepting a shipment puts its package in personal storage at the origin station.
Inspect the shipment/package, withdraw `package:<id>`, and confirm it is aboard
before leaving. Delivery requires the carried package at the destination station.
The first accepted package occupied 100 cargo. Kvothe's Cargo Expander II increased
capacity from 75 to 125, making these jobs possible while retaining original assets.

The carrier profile is the authority for current liability and progression. At
probationary tier, observed limits were 25,000 liability per package and 50,000
total. Licensed tier required five successful deliveries and at least 250
delivered value. Liability exposure is not the same as a cash payment. Compare
reward against fuel, service costs, travel time, deadlines and failure debt.
Check eligibility before accepting, and keep enough cargo space.

One manual Node Alpha → Central Nexus shipment paid 148 credits. Another offer
at that time paid 1,295 for Node Alpha → Node Beta. Neither is a promise those
jobs remain available. Query the live board and carrier profile.

## Missions and markets

Supplied-cargo missions can earn money without buying inventory. Neural Matrix
Delivery supplied eight phase matrices for delivery to Sirius. Story payouts
helped fund equipment, but are finite. Synchrony Relay Run could not be repeated
even though its completion dialogue suggested more work.

Historical phase-matrix arbitrage was unavailable. A public market snapshot's
processed-null-matter supply disappeared before arrival. Use live orders,
including volume, before committing capital; guide prices are examples.

The Experiment's ordinary belt was depleted, and one survey found no hidden
deposits. Evaluate mining against current stock and installed equipment.
Kvothe's original mining laser remains in cargo after fitting the expansion;
it must be reinstalled before mining.

## Measurement

Real profit is realized wallet change after refueling and repairs. Preserve or
account for starting inventory, equipment, fuel and hull. Finite story rewards
prove progression; repeated profitable economic cycles prove sustainability.
End sessions docked and fueled when practical, with no unaccounted freight debt.

## Storage: what `view` returns

`spacemolt_storage.view({station_id?, target?})` is a query, not a mutation — the one storage
call that works at a distance. Documented (lib 14.2.0, `SpacemoltStorageViewData.station_id`):
"a station Base ID or station POI ID to view storage at without being docked... it applies to
a storage view (target=\"self\" or \"faction\"), not to a deposit or withdraw." Omit it to read
wherever the ship is docked now; name a base or station POI id to read holdings anywhere
without travelling. Deposit and withdraw still require presence — this is a look, not a reach.

`target` picks whose storage: `self` (default), `faction`, `faction:TAG`, an empire alias, a
player name/ID, or `station:<base-or-POI-ID>`. The pilot's own tool only ever asks for `self`.

Response (`ViewStorageResponse`), documented: `action:'view_storage'`, `base_id` (the base the
response describes), `items: CargoItem[]` (`item_id`, optional `name`, `quantity`, optional
`size`), `ships: StoredShip[]` (stored ship instances, not fitted modules), `locations:
StorageLocation[]`, `hint` (a string, content unobserved), and optional `gifts`/`messages`.
There is no top-level `base_name`; the `locations` index carries it.

`locations` is the useful part for "what do I have elsewhere": every base the account holds
anything at, each `{base_id, base_name, item_count, ship_count, system, system_name}`. One
`view` call at any nameable base therefore answers both "what's here" and "what's everywhere
else" — not just the named base's own contents.

Unknown until observed live: whether `locations` is ever empty rather than absent; what `hint`
actually says and when it changes; the shape of populated `gifts`/`messages`; whether a bad
`station_id` errors or falls back to self; the rate-limit tier for an off-base `view_storage`.

### Observed live

Observed 2026-09-15 on the kvothe pilot, through the `spacemolt_storage` tool from Discord and a juncture:

- Called undocked with no `station_id`: `ok`, `base_id` is the empty string, `items` empty, and `locations` lists every base with holdings (five bases, counts by item and ship). So the index is reachable from anywhere, even in space.
- Called docked with no `station_id`: the current base's items and the same `locations` index.
- `station_id` given as a station POI id (`mobile_capital`) resolved to its base (`frontier_station`, 188 items): a POI id is accepted as documented.
- `station_id` given as a base id in another system (`deep_range_outpost`, `first_step_memorial_station`, `sirius_observatory_station`) answered without travelling; shipping packages appear as items named `package:<hash>`.
- `locations` was present in every response; the empty-versus-absent case did not occur.
- `hint`, `gifts` and `messages` are dropped by the compact shape and were not inspected. A bad `station_id` was not tried. Rate limits were not hit across seven calls in nine seconds.

### Where it is shown

`where`: no. `where` answers what is true about place, for travel and docking; storage is a
fact about holdings, and a "storage here: N items" line would blur the one thing `where` is for.

Juncture's present: maybe, later. The present is deliberately small (N15), competing for the
same few lines VISION reserves for fuel/hull/credits. A single total-items-across-all-bases
line, shown only when nonzero, would fit; a per-base breakdown would not. Not first.

Reflection at rest: yes, and the primary consumer. VISION names "what it owns and owes" as a
direct input to reflection, the one juncture built to look across the whole account rather than
the present moment — the natural place to notice 400 idle ore sitting at a base never visited.

Menu rules (Industrialist mine-vs-use-storage): yes, as a bridge fact, not a rules concern. The
rules table decides admissibility from facts it is handed; whether inputs already sit in
storage belongs in `factsNow` (a cheap reuse of the same `view` call), never a rule reaching
into storage on its own.

Recommend wiring reflection first: it is the surface VISION already names as storage's
consumer, it is the lowest-traffic call site (once per rest, not per juncture), and it needs no
shape beyond what `storage.ts` already returns.

## `get_base`: what a station quotes

### Observed live

Observed 2026-09-14/15 at `unknown_edge_waystation`, `frontier_station` and (2026-09-08)
`first_step_memorial_station`. Fixtures: `proofs/fixtures/unknown-edge-game.json`,
`proofs/fixtures/c23-replay.json`.

- The reply is `structuredContent`, never a state delta: `{base, condition, construction,
  fuel_price, fuel_price_all_in, fuel_tax_per_unit, life_support, power, services}`.
- `services` is a flat array of strings, e.g. `["crafting","marine_training","market",
  "medical","missions","personnel","refuel","repair","shipyard","storage"]`. `storage` and
  `crafting` appearing there is what the menu turns into the Storage and Workshop counters.
- Fuel is quoted three ways: `fuel_price` (2), `fuel_tax_per_unit` (1) and `fuel_price_all_in`
  (3, the one to spend against).
- **No repair price is quoted anywhere in the reply.** `structuredContent.base` is the
  station's own hull/shield/armour/fuel stock — `{armor, description, empire, facilities,
  fuel, hull, id, max_fuel, max_hull, max_shield, name, poi_id, public_access, shield,
  weapon_dps, weapon_reach}` — and carries no per-hull cost under any name. Production reads
  `base.base.repair_price_per_hull` (`src/bridge.ts`, `src/servicing.ts`); live it is always
  `undefined`, so the hull half of a service quote has never been exercised against the real
  game. Every observed service quote happened to be at full hull, which hides it.
- `spacemolt/repair` was never sent in either journal. Its reply shape and its cost behaviour
  (whether the price climbs with damage) remain unobserved — a claim of "climbing cost" has no
  recorded evidence behind it.

## `refuel` and `mine`: the reply shapes

### Observed live

Observed 2026-09-14 at Unknown Edge. Fixture: `proofs/fixtures/unknown-edge-game.json`.

- `spacemolt/refuel` answers `{command:'refuel', tick, delta:{player, ship, cargo, details}}`
  with `details = {action:'refuel', source:'station', fuel, cost, market_cost, tax_amount}`.
  One observed fill: 21 units, cost 63 = market 42 + tax 21, against `fuel_price_all_in` 3.
- `spacemolt/mine` answers `{command:'mine', tick, delta:{ship, cargo, location, skills, queue}}`.
  There is **no** `delta.details` and no `structuredContent` — the `kind:'yield'` detail path
  in `measureMineYield` was never taken live; every real mine is measured from `delta.cargo`.
- `location.resources` in a mine or travel delta carries `{item_id, item_name, richness,
  remaining, supported_power}` per resource; `get_poi` adds `max_remaining` and
  `depletion_percent`.

## The bridge's own answers

### Observed live

Observed 2026-09-15 on the kvothe pilot. Fixtures: `proofs/fixtures/unknown-edge-bridge.json`,
`proofs/fixtures/bridge-events.json`.

- Mining while docked is refused by the game, and the run reports it verbatim:
  `mine failed: cannot mine: docked at unknown_edge_waystation`. Asking `gather` for a station
  POI is what produces it — the job travels nowhere, so it is still docked when it mines.
- A gather with a full hold still completes: all seven steps `done`, `yield []`, `sold []`,
  `held []`, and `cargo_free 0` in the next menu. A done gather is not evidence of a take.
- `gather` for an id the game does not know fails at the first step:
  `travel failed: Unknown destination: asteroid_belt`.
- `dock` refuses two ways, both `ok:true` with `docked:false`: `"Docked at X, not Y; undock
  before docking elsewhere"` and `"No station at this location"`.
- `rest` refuses two ways, both `ok:true` with `rested:false`: `"rest happens docked at a
  base; dock to end the shift"` and `"refuel and repair first — full tank and hull quoted at
  N credits, inside the <Mood> margin M"`. A successful rest answers
  `{rested:true, shift_ended:true, at_rest:true, cleared:{stance,mood,goal?}, serviced}`
  and writes a `rest` event, followed by a `reflection` event once the next shift is chosen.
- `where.docked_at` is an object `{base_id, name}`. Journal lines before 2026-09-15 11:09
  answer a bare string — the same journal holds both, so a replay must not assume one.
- In transit, `where` answers `poi:{id:''}` with no `name`, and `destination` carries only
  `poi` (the destination system id is unset on a same-system hop, so the key is absent).
- `resume` was never called and no `unsolicited_move` event was ever journalled; both remain
  live-only claims.
- `get_skills` (2026-09-08, `proofs/fixtures/c23-replay.json`) answers
  `structuredContent:{message:'Skills progress', skills:{...}}` where `skills` is a **map**
  keyed by skill id, each `{category, level, max_level, name, next_level_xp, xp}` — not an
  array. `spacemolt_shipping/profile` is recorded in the same fixture.
- `get_tax_estimate` and `set_home` appear in neither journal, and neither does a successful
  `repair`.
