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
