# trading — the Trader's evening

"I'll buy where it is cheap and sell where it is dear." The hard part is not the arithmetic.
It is that the game will not tell you what another station pays, so the first question a
loaded pilot has — *who buys this?* — has no direct answer. `spreads()` is that answer,
assembled from everything this pilot is allowed to know.

## Functions

| Function | Promise |
|---|---|
| `buyers(items)` | who bids for each item named, held or not: the highest bids known anywhere (up to `BUYERS`, 3, an item) with `{base_id, best_buy, best_buy_qty, source, age, jumps}`. Works undocked, from memory, ages then counted from the newest book you hold at ten seconds a tick; docked it adds the live book here. No trip priced, nothing netted: `spreads()` does that for what you hold |
| `spreads(items?)` | the best buyers known for each thing you hold (up to `BUYERS`, 3, an item), anywhere, with the trip priced and netted, ranked as `routes()` ranks a one-stop route |
| `routes({items?, circuit?, maxStops?, maxLegJumps?, maxJumps?})` | every route known within the scope (by default up to 4 stops, 3 jumps a leg), planned from the hold you have, fuelled, and ranked by trust-weighted net per jump; each row carries the call to paste. With `circuit: {hold}`, every row is a closed lap for a freighter instead, past the rings a freighter drained within `REST_TICKS` |
| `tradeRun({stops})` | fly the stops in order; at each, sell what pays best there and fill the hold from the stop's `buy` items, re-planned against the live book. The realised net from the wallet |
| `scoutMarkets({jumps?, max?})` | fly to the nearest books nobody has read lately, up to `max` (3) hops within `jumps` (`SCOUT_JUMPS`, 4), and read, remember and file each one; the ground `routes()` plans over. Never buys or sells |

Root functions do the rest: `prices()` for the counter you are standing at, `sell()`/`buy()`
for one side only.

## Where a far price comes from

There is no cross-station market read in the lib. `view_market` and `analyze_market` both
answer "the station you are docked at"; `analyze_market`'s `insights` are prose lines
(`{category, item, item_id, message, priority}`), not prices. `view_orders({station_id})`
answers with **your own** orders, not the book. So `spreads()` uses three sources and weighs
every buyer in them, not only the highest `best_buy`:

| `source` | What it is | How stale |
|---|---|---|
| `here` | this base's live book | live, read this call |
| `faction ledger` | `spacemolt_intel/query_trade_intel` — other pilots' filed observations | `seen` is the age in ticks of `submitted_at_tick` |
| `remembered` | a book **this pilot** read at that base on an earlier visit | `seen` is the age in ticks of the book |

The ledger needs a faction with a trade-intel facility; with no faction it is not asked, without the facility the command throws, and
`spreads()` carries on with the other two, saying so in `did` and in `detail.sources`. The
ledger is read whole, by station, 20 stations a page and at most 4 pages a read; it is never
asked by item, because live an `item_id` filter answers nothing even for a filed item. A ledger
entry carries no system (`system_id` comes back empty), so the memory's system for that base
stands in. A base both remembered and on the ledger is read from the **fresher** copy only (a tie
goes to the ledger), whichever copy pays more: `spreads()`, `routes()`, `tradeRun` and `assign`
all see that one book. The
memory is free and always there: every `book()` read — by `prices()`, `sell()`, `recipes()`,
`quote()` — writes that base's whole book to `markets.json` in the runtime dir, kept for a day of ticks.
So the second visit knows what the first one saw, across runs and across restarts. It follows
that the way to *learn* a price is to go and stand in front of it: `goTo(base)` then
`prices()`, once, and that base is in the memory for good.

Filing to the ledger is automatic too: every `book()` read, and every freighter stop, submits that
base's priced book (`submit_trade_intel`) once per tick, so you never call it. A book over about
50 KB drops the connection, and a second filing for a base replaces the first, so a big book is
cut to its most tradeable rows (a bid and an ask first, then by value). A failed filing costs that
base that tick only, and is said once per process; without a faction ledger nothing files. What you and your faction filed comes back in `spreads()`
rows as `source: 'faction ledger'` with `seen` the age of its `submitted_at_tick`, and in `routes()`
legs as `source`/`age` the same way; a base read both ways ranks on the fresher of the two.

A remembered or filed price is a memory. The book may have moved. `tradeRun` re-reads the book
at every stop and `sell` re-reads at the sell, so nothing is sent against a stale number.

`seen` is an **age in ticks**, measured against the `current_tick` on the live `view_market`
reply this same call read — so `0 ticks old` means read this tick, `40 ticks old` means the
bid is forty ticks of other pilots' trading away. Nothing refuses a price for being old: how
stale is too stale is your call, and the worst a bad call costs is a wasted trip. An entry
written before books carried a tick reads as **20 ticks old** — an assumption, not a
measurement, so treat a flat 20 as "unknown, probably stale".

## What a row says

`spreads()` answers `detail: {spreads, sources}`. Each row of `spreads` is one buyer for one item,
`{item_id, held, base_id, best_buy, best_buy_qty, source, seen, fuel, jumps, net, confidence, score}`.
`jumps` and `fuel` are priced as `routes()` prices a trip: jumps over the `get_map` links from each
base's system (the memory's, `places.json`, else one `find_route`, at most 5 a call), fuel per jump
from one quote (both 0 here). `net` is `best_buy × min(best_buy_qty, held)` less that fuel at
**this** base's `fuel_price_all_in`. `confidence` is `0.5 ^ (age / HALF_LIFE)`, 1 for a live book,
and rows rank by `score`, `max(confidence, 1/64) × net / max(1, jumps)` — the same rule as a
`routes()` row — keeping the best `BUYERS` (3) per item. So a bid of 15 on a book hours old, 15 jumps
out, ranks under a bid of 8 read a jump away, and both are listed. `held` is the hold plus this
base's store, because that is what you could put on the counter. A buyer whose base could not be
placed is not priced, and `did` names it.

## The model: a route is a list of stops

A route is an ordered list of stops, `[{at, buy?}, …]`, flown from where you are with the
hold you have. At every stop one rule decides two things. First, sell each held unit whose bid
here is at least the best bid for it at any later stop on the route, each weighed by how much its
book can be trusted. A unit is also never sold for under half the best trusted bid any base **off**
the route posts: 27 null_matter are not dumped at 1 cr while a remembered book elsewhere bids 445.
Then fill the room that frees, one unit at a time, with whichever of the stop's `buy` items earns
most on that unit — its best bid later on the route less its ask here plus tax — while that is above
0. So a stop takes several items when the best one runs thin: 10 gems while they are 10 deep at 100,
then ore for the rest of the hold. `routes()` offers every item a stop asks for that some known book
outbids; `tradeRun` offers the stop's `buy`, one item or a list. Both walk the books
level by level. The last stop has nothing after it, so it sells everything it bids for above that
floor; whatever is still aboard after it is `unsold` and is not counted. An `unsold` row kept for a
better bid off the route says where in its `why` (`node_alpha_processing_station bids 445, off this
route`); a `routes()` row for that base is how to take it there. A stop whose only sales would be
under that floor sells nothing, so `routes()` never keeps it as a stop that does something.

There is no special case for a full hold, an empty one or a mixed one. "Just sell what is aboard
over there" is the one-stop route `[{at: 'there'}]`, and "buy here, sell there" is
`[{at: 'here', buy: 'x'}, {at: 'there'}]`. `routes()` ranks routes with this rule and `tradeRun`
runs it, so what ranks is what runs.

## What a route says

`routes({items?})` answers `detail: {routes, sources}`. `items` narrows what is taken on at a
stop; goods aboard are always weighed. `sources` is as for `spreads()`. It reads only: it
computes, you choose. It is refused when not docked. Goods in the store here are not weighed; take
them with `from: 'store'` (below).

The search picks only the bases, in order; the rule above picks what each stop sells and takes on.
It grows routes one stop at a time, keeping the best 20 at each length, within the scope:

| Option | What it is |
|---|---|
| `maxStops` | stops in a route or a lap, 4 unless given, at most `MAX_STOPS` (10). A local cycle by default; a galaxy tour is a larger number |
| `maxLegJumps` | jumps in any one leg — from here to the first stop, stop to stop, and a lap's last stop home — 3 unless given |
| `maxJumps` | jumps all told: from here through every stop, or once round a lap. No cap unless given |

A bigger scope costs time, not game calls: the search plans about `maxStops × 20 × bases` routes on
the one map read, up to seconds for a 10-stop tour over a full memory. A base with no system known
can not be counted against a jump cap; its row says so, and the Outcome's `did` names every base
that could not be placed. A
route is kept only when it pays and every stop on it sells or buys something. Jumps are counted
on the galaxy map (`get_map`, one call) between the systems of consecutive stops. The market
memory keeps each base's system, and lends it to a ledger entry for the same base. A base it has
no system for (a ledger entry for a base never visited, an old memory) is placed with one `find_route`, at most 5 a call. One `find_route` also prices a jump in fuel.
Every place learned — a docked book read, a `find_route` here, a freighter arriving at a stop — is
kept in `places.json` in the runtime dir and read first, so a base is placed once, ever: each call
places up to 5 new bases, and the `did` says how many wait for a later call. A mobile station
moves: a base a freighter found away from its kept system is listed in `mobile.json`, and is
placed by a live `find_route` on every call, never from `places.json` or the memory.

Each row of `routes` is a `Route`:

| Field | What it is |
|---|---|
| `legs` | one per stop, in order: `{at, source, age, sold, buys, bought, cost, sales_tax}` (below) |
| `unsold` | `{item_id, quantity, why?}` rows still aboard after the last stop: nothing on the route bids for them, or a base off the route bids at least twice as much (named in `why`). Not in the net |
| `revenue` | every sale on the route, level by level |
| `cost` | every buy on the route, level by level (0 from the store) |
| `sales_tax` | the tax on the buys. Only the docked base's rate is readable, so a buy at a far stop is taxed at this base's rate and `why` says it is an estimate. `null` when no rate is readable here at all (the net is then untaxed and `why` says so) |
| `total_jumps` | jumps from here through every stop, on the map; `null` when a stop could not be placed |
| `fuel` | fuel units, `total_jumps × fuel_per_jump`; `null` when the trip is unpriced |
| `net` | `revenue − cost − sales_tax − fuel × fuel_price_all_in` at the base you call from. Fuel is left out when it could not be priced. `Traded.net` counts fuel the same way, so the two compare directly |
| `confidence` | `0.5 ^ (sum of the stops' book ages / 360)`: 1 when every book is live, half for an hour of age |
| `score` | the rank: `max(confidence, 1/64) × net / max(1, total_jumps)`. 0 when the trip could not be priced. Past six hours of summed book age the floor holds, so stale rows still rank by net per jump |
| `next` | the call to paste: `tradeRun({stops: [...]})` for this route |
| `why` | what the row could not know: a stop with no route, an unknown tax, a far stop's tax estimated at this base's rate. Absent when nothing is missing |

Each leg is:

| Field | What it is |
|---|---|
| `at` | the base |
| `source`, `age` | where its book came from (`here`, `faction ledger`, `remembered`) and its age in ticks; `here`/0 when live |
| `sold` | `{item_id, quantity, revenue}` per held item sold here |
| `buys` | `{item_id, quantity, cost}` per item taken on here, `cost` at the asks |
| `bought`, `cost` | the units taken on here, all told, and what they cost |
| `sales_tax` | tax on those buys, each floored as the game does, at this base's rate when the stop is far; `null` when no rate is known |

At most 5 rows come back, priced ones first. The Outcome's `did` names the best row in short —
a stop selling more than two kinds says `sell 499 of 10 kinds` — and its legs carry each sale. A stop that could not be placed leaves its row in
the list with a `why`, a `score` of 0 and the Outcome `partial`.

## Circuits: a lap a freighter repeats

A route need not come back to where it started; one handed to a freighter must, because the
freighter flies it again and again. `routes({circuit: {hold: 50}})` ranks those instead: every row
is a closed lap of 2 to `maxStops` different bases, planned for an **empty** hold of `hold` units
(what is aboard you now is ignored), with at least one buy. The lap is planned into the next one,
so the last stop takes on what the first stop outbids, and the way back pays too. `maxLegJumps`
counts the hop home, and `maxJumps` the whole lap.

A lap is planned three times over and the **middle** lap is the one read: the first starts empty,
and the last has nothing after it to carry for. The lap starts at its first buy, so lap one has
already traded on every book the middle lap reads. It is one plan over one set of books, so what
lap one took is gone for lap two, and the middle lap can sell more than it buys. A lap repeats only
what it both buys and sells, so each item counts `min(sold, bought)` units, sold at its best bids
and bought at its cheapest asks; an item sold with none bought on the lap is carry from lap one and
is not counted. One ring of bases is one row: its rotations rank as the best of them.

**A drained ring rests.** When a freighter parks because its circuit ran dry — three stops in a
row with no trade, or three laps that lost money — its ring of bases (the stops in order, any
rotation) and the game tick are written to `drained.json` in your runtime dir. For `REST_TICKS`
(360 ticks, about an hour; unmeasured, to be tuned once a drained book is watched refilling)
`routes({circuit})` does not plan that ring, and its `did` ends `skipped N ring(s) a freighter
drained within 360 ticks: <ring>; …`. NPC books refill slowly; two laps can empty one. The
freighter rotates itself: its host runs this same search for its hold and scope and flies the top
row, and with none it waits, re-planning every `REPLAN_TICKS` (see
[fleet](../fleet/README.md#freighters)). `reassign(name)` runs it for a parked freighter by hand.

**One planner, two seats.** `routes()` is `search(seat, opts)` read through your runtime: your
connection, your live book (remembered and filed), your runtime dir. A freighter's host runs the
same `search` on the freighter's own seat: its connection for the live book where it is docked, the
tax, fuel price and map reads, `find_route` from where it is, and the faction ledger (it is a faction
member); your runtime dir's `markets.json`, `places.json` and `drained.json` by path. It never touches
your play runtime, so a freighter re-plans while you fly, and yields to the event loop as yours does.
`search` is the host's, not a pilot call: it is not in `play`.

**A freighter trades by the same planner.** Its circuit's `qty` and `max_price` are caps, not
orders: at each stop it runs `plan` over the live book there and its host's freshest books of the
later stops (the ledger's, read by `base_id` and cached `BOOK_TTL_MS`, your memory's, or a
freighter's own live read), less what the other freighters carry there, a book past `STALE_TICKS`
at half its depth and one past `IGNORE_TICKS` at none, and buys what that plan says. Each lap is
planned first on the same books, and one planning at 0 or less parks drained. A ring ranked on a
17-hour-old book (`TRUST_FLOOR` keeps it in the running) is so flown light until its books are read
fresh (see [fleet](../fleet/README.md#freighters)). `ledgerItems(entry)` is how a ledger entry
becomes book rows (`Listing`), for `farBooks` and the host alike.

A circuit row is a `Route` whose numbers are that middle lap's: `legs`, `revenue`, `cost`,
`sales_tax`; `net` is `lap_net`, `total_jumps` is `lap_jumps`, `score` is
`max(confidence, 1/64) × lap_net / max(1, lap_jumps)`, `unsold` is empty. A lap is kept only when every stop
on it trades, `lap_net` is positive and every hop, the last one home included, is on the map. Its
`next` is the call to paste, `assign('freighter', {…}, {float: 20000})` (see
[fleet](../fleet/README.md#freighters)), and the lap itself is `circuit`:

| `Circuit` field | What it is |
|---|---|
| `closed` | always `true`: the last stop is followed by the first |
| `hold` | the hold the lap was planned for |
| `lap_jumps` | jumps round the whole lap, the hop from the last stop back to the first included |
| `lap_net` | the middle lap's revenue, less cost, tax and `lap_jumps` of fuel at this base's `fuel_price_all_in` |
| `stops` | in order: `{at, system_id, buys, sell}` |
| `stops[i].at`, `.system_id` | the base and its system |
| `stops[i].buys` | `[{item, qty, max_price}]`: take on up to `qty` units of each `item`, one buy each, at asks of at most `max_price`, the planned average ask plus 10%. A circuit written before `buys` has one `buy: {item, qty, max_price}` instead; it still flies, read as `buys: [buy]` |
| `stops[i].sell` | `[{item, min_price}]`: sell each held `item` at bids of at least `min_price`, the planned average bid less 10%. Nothing else is sold |
| `scope` | `{maxStops, maxLegJumps, maxJumps?}` the lap was planned within: a freighter's own re-plan, and `reassign`, plan the next circuit alike |

## What a run says

`tradeRun({stops})` flies the stops in order. Each stop is `{at, buy?, quantity?, from?}`:

| Option | What it is |
|---|---|
| `at` | the base to stop at. `tradeRun` flies there itself; a stop you are docked at is not flown to |
| `buy` | the item to take on here, or a list of them: the plan fills the hold from the list, unit by unit, whichever earns most, one `buy` each. A `routes()` row's `next` lists what its plan took |
| `quantity` | a cap on all of `buy` together |
| `from` | `'store'`: take `buy` out of this base's store, at no cost, instead of off the market |

At each stop it reads the live book, re-plans the rest of the route against it (later stops at
their best known books), and does the first leg of that plan: `sell`, then a `buy` or `withdraw` per item.
A later stop with no known book may bid for anything, so goods are kept for it.

It answers `detail: Traded` = `{stops, unsold, fuel, net}`:

| Field | What it is |
|---|---|
| `stops` | one per stop reached: `{at, sold, bought, spent, why?}`. `sold` is the lib's `SellResponse[]` for this counter, `bought` the units taken on, every item together, `spent` what left the wallet for them, sales tax included, and `why` what fell short here or why nothing was taken |
| `unsold` | `{item_id, quantity, why?}` rows aboard when the run ended. After the last stop, what no stop bought, or what a base off the route bids twice as much for (named in `why`) |
| `fuel` | fuel units the flights burned, measured from the tank |
| `net` | sales, less `spent` (tax included), less `fuel × fuel_price_all_in` at the first base the run was docked at. Fuel comes from the tank, not the wallet, so it is priced exactly as `Route.net` prices it: realised `net` against the `routes()` row's `net` is like against like |

It never throws. A flight that does not arrive is `partial`, with the stops done so far, and
`next` is the rest of the route. A `done` run's `next` is pasteable calls only: the same
`tradeRun(...)` again when the route bought something and netted a profit, and `routes()`, which
is all it offers after a route that only sold the hold. Re-running the same call starts again at the first stop and
re-plans from the hold you have. A load already aboard is carried on and is not bought twice. A
sale or buy the game refuses is `partial` too, and the run carries on to the next stop.

The menu offers `tradeRun({stops: [{at}]})` in every stance when something aboard has no bid here
and a remembered book elsewhere bids for it. For goods in the store here, it offers
`tradeRun({stops: [{at: here, buy, from: 'store'}, {at}]})`. The fuel to get there is not priced
into that line.

## Scouting: reading the books nobody has

A route is only ever planned over a book someone read, and the faction ledger covers about 15 of
the galaxy's ~79 stations. `get_map` lists systems, not their bases. A base id is learned from a
book, a `find_route`, the faction's intel map (`spacemolt_intel/query_intel`, each system with its
POIs and their `base_id`s, when your faction has one), or a `get_system` standing in its system,
which lists every POI there with its `base_id`. So scouting goes jump by jump where nothing else
knows.

`scoutMarkets({jumps?, max?})` answers `detail: {filed, explored, left}`:

| Option | What it is |
|---|---|
| `jumps` | how far to look, in jumps from the system you are in: `SCOUT_JUMPS` (4) unless given |
| `max` | hops to fly, all told: 3 unless given |

Each hop goes to the first candidate within `jumps`, chosen afresh after every hop:

1. a base known by id (in `places.json`, the intel map or a far book's system) with **no book** at all;
2. a system on the map whose bases were **never listed** (not in `explored.json`, no base of it
   placed, and some POI in it);
3. a base whose freshest book, ledger or memory, is older than `IGNORE_TICKS` (1080 ticks, three hours).

The first two rank together, nearer first and a base before a system; stale books come after. A base
is flown to with `goTo` and its book read as `prices()` reads one: remembered in `markets.json` and
filed to the ledger. After every hop the system's bases are listed (`get_system`) and kept in
`places.json`, and the system in `explored.json`, so a system flown to for its bases makes them the
next candidates, and a system with one base docks there on arrival. It never buys or sells.

| Field | What it is |
|---|---|
| `filed` | the bases whose book it read, in order |
| `explored` | `{system_id, bases}` for each system it flew to for its bases, and the base ids it listed |
| `left` | candidates still within `jumps` after the last hop; `next` says `scoutMarkets() again` while there are any |

A hop that does not arrive is skipped and said in `why`, and the call is `partial`; `refused` when
none arrived, when you are not docked (ages are read against a counter's tick), or in a mood that may
not start a job. With nothing to scout it is `done` and says so. The menu offers `scoutMarkets()` to a
docked Trader whenever a candidate lies within `SCOUT_JUMPS`, under the trades. A freighter with no
circuit that qualifies scouts by the same choice (see [fleet](../fleet/README.md#freighters)).

```ts
import {orient, scoutMarkets, routes} from 'play';

export default async function main() {
  await orient();
  const scouted = await scoutMarkets({jumps: 3, max: 2});   // the two nearest unread books, within 3 jumps
  if (!scouted.detail.filed.length) return scouted;
  return routes();                                          // planned over what was just read
}
```

## Worked example — the ore nobody here will buy

```ts
import {orient, spreads, goTo, sell, note} from 'play';

export default async function main() {
  await orient();
  const look = await spreads();                      // everything held, priced everywhere known
  const best = look.detail.spreads[0];
  if (!best) { note('no buyer known for anything aboard; fly somewhere new and prices() there'); return look; }
  if (best.base_id === look.now.location.docked_at)
    return sell([{item_id: best.item_id}]);          // the best counter is this one
  note(`${best.item_id}: ${best.best_buy} each at ${best.base_id} (${best.source}, ${best.seen}), net ${best.net}`);
  const trip = await goTo(best.base_id);
  if (trip.status !== 'done') return trip;
  return sell([{item_id: best.item_id}]);            // by name; the book is re-read here
}
```

## Worked example — the best trade known

```ts
import {orient, routes, tradeRun, note} from 'play';

export default async function main() {
  await orient();
  const look = await routes();                       // every known route from this hold, ranked; a tour: routes({maxStops: 8, maxLegJumps: 5})
  const best = look.detail.routes.find(row => row.total_jumps !== null && row.net > 0);
  if (!best) return look;
  note(`${best.legs.map(leg => leg.at).join(' → ')}: net ${best.net}, confidence ${best.confidence.toFixed(2)}`);
  return tradeRun({stops: best.legs.map(leg => ({at: leg.at, buy: leg.buys.map(row => row.item_id)}))});
}
```

## Pitfalls

- A snapshot goes stale before arrival; we have watched a public market's supply vanish. The
  `source` and `seen` fields are there so you can weigh that before committing fuel — a
  hundred-tick-old bid four jumps out is a guess, not a price.
- The memory drops a book **8640 ticks (a day)** after it was read, and holds at most 40 bases.
  Inside that window nothing is dropped for being stale; `seen` is how you see that.
- Sales tax is charged at buy time and netted from `gained.credits`.
- `spreads()`' `net` prices the top buy level only. A load big enough to eat past it fetches
  less. `routes()` walks the levels.
- Contraband: `get_empire_info` lists each empire's contraband; a customs scan seizes and
  fines. Neither function checks it yet — read the list before hauling something exotic.

## When to reconsider

- A route whose realised `net` (from `tradeRun`) comes in under the `net` `routes()` predicted,
  twice: someone else is working it. Both nets count tax and fuel the same way, so the gap is the
  books moving. It is contested; drop it and take the next row.
- Two `tradeRun`s that reach the far stop and still leave goods `unsold`: the far book is being
  drained by someone else.
  Change the pair.
- Trading is at 5+ and every spread is small: standing orders (`account().commands
  .spacemolt_market.create_buy_order`) earn the spread without flying; this library does
  not wrap them yet, and a raw order is a real escrow.
- Capital is growing faster than cargo: the hull is the limit. `shipsForSale()`.
