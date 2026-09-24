# trading — the Trader's evening

"I'll buy where it is cheap and sell where it is dear." The hard part is not the arithmetic.
It is that the game will not tell you what another station pays, so the first question a
loaded pilot has — *who buys this?* — has no direct answer. `spreads()` is that answer,
assembled from everything this pilot is allowed to know.

## Functions

| Function | Promise |
|---|---|
| `spreads(items?)` | the best buyer known for each thing you hold, anywhere, with the trip priced and netted |
| `routes({items?})` | every route of up to 3 stops known, planned from the hold you have, fuelled, and ranked by trust-weighted net per jump; each row carries the call to paste |
| `tradeRun({stops})` | fly the stops in order; at each, sell what pays best there and take on the stop's `buy`, re-planned against the live book. The realised net from the wallet |

Root functions do the rest: `prices()` for the counter you are standing at, `sell()`/`buy()`
for one side only.

## Where a far price comes from

There is no cross-station market read in the lib. `view_market` and `analyze_market` both
answer "the station you are docked at"; `analyze_market`'s `insights` are prose lines
(`{category, item, item_id, message, priority}`), not prices. `view_orders({station_id})`
answers with **your own** orders, not the book. So `spreads()` uses three sources and takes
the best `best_buy` per item:

| `source` | What it is | How stale |
|---|---|---|
| `here` | this base's live book | live, read this call |
| `faction ledger` | `spacemolt_intel/query_trade_intel` — other pilots' filed observations | `seen` is the age in ticks of `submitted_at_tick` |
| `remembered` | a book **this pilot** read at that base on an earlier visit | `seen` is the age in ticks of the book |

The ledger needs a faction with a trade-intel facility; without one the command throws and
`spreads()` carries on with the other two, saying so in `did` and in `detail.sources`. The
memory is free and always there: every `book()` read — by `prices()`, `sell()`, `recipes()`,
`quote()` — writes that base's whole book to `markets.json` in the runtime dir, kept for a day of ticks.
So the second visit knows what the first one saw, across runs and across restarts. It follows
that the way to *learn* a price is to go and stand in front of it: `goTo(base)` then
`prices()`, once, and that base is in the memory for good.

A remembered or filed price is a memory. The book may have moved. `tradeRun` re-reads the book
at every stop and `sell` re-reads at the sell, so nothing is sent against a stale number.

`seen` is an **age in ticks**, measured against the `current_tick` on the live `view_market`
reply this same call read — so `0 ticks old` means read this tick, `40 ticks old` means the
bid is forty ticks of other pilots' trading away. Nothing refuses a price for being old: how
stale is too stale is your call, and the worst a bad call costs is a wasted trip. An entry
written before books carried a tick reads as **20 ticks old** — an assumption, not a
measurement, so treat a flat 20 as "unknown, probably stale".

## What a row says

`spreads()` answers `detail: {spreads, sources}`. Each row of `spreads` is `{item_id, held,
base_id, best_buy, best_buy_qty, source, seen, fuel, jumps, net}`: `fuel` and `jumps` are the
route quote to `base_id` (both 0 here). `net` is `best_buy × min(best_buy_qty, held)` less the fuel bill to get there, at **this**
base's `fuel_price_all_in`, from one `find_route` per far base. `held` is the hold plus this
base's store, because that is what you could put on the counter. Rows are sorted by `net`, so
a fat price four jumps out can rank below a thin one here — which is the comparison a loaded
pilot actually needs.

## The model: a route is a list of stops

A route is an ordered list of 1 to 3 stops, `[{at, buy?}, …]`, flown from where you are with the
hold you have. At every stop one rule decides two things. First, sell each held unit whose bid
here is at least the best bid for it at any later stop on the route, each weighed by how much its
book can be trusted. A unit is also never sold for under half the best trusted bid any base **off**
the route posts: 27 null_matter are not dumped at 1 cr while a remembered book elsewhere bids 445.
Then take the stop's `buy` item into the room that frees, one unit at a time,
while the unit's best bid later on the route beats its ask here plus tax. Both walk the books
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

The search grows routes one stop at a time, keeping the best 20 at each length, up to 3 stops. A
route is kept only when it pays and every stop on it sells or buys something. Jumps are counted
on the galaxy map (`get_map`, one call) between the systems of consecutive stops. The market
memory keeps each base's system. A base it has no system for (a ledger entry, an old memory) is
placed with one `find_route`, at most 5 a call. One `find_route` also prices a jump in fuel.

Each row of `routes` is a `Route`:

| Field | What it is |
|---|---|
| `legs` | one per stop, in order: `{at, source, age, sold, buy?, bought, cost, sales_tax}` (below) |
| `unsold` | `{item_id, quantity, why?}` rows still aboard after the last stop: nothing on the route bids for them, or a base off the route bids at least twice as much (named in `why`). Not in the net |
| `revenue` | every sale on the route, level by level |
| `cost` | every buy on the route, level by level (0 from the store) |
| `sales_tax` | the tax on the buys; `null` when a buying stop's rate is not known, which is so for every stop but the one you are docked at (the net is then untaxed and `why` says so) |
| `total_jumps` | jumps from here through every stop, on the map; `null` when a stop could not be placed |
| `fuel` | fuel units, `total_jumps × fuel_per_jump`; `null` when the trip is unpriced |
| `net` | `revenue − cost − sales_tax − fuel` at this base's `fuel_price_all_in`. Fuel is left out when it could not be priced |
| `confidence` | `0.5 ^ (sum of the stops' book ages / 360)`: 1 when every book is live, half for an hour of age |
| `score` | the rank: `confidence × net / max(1, total_jumps)`. 0 when the trip could not be priced |
| `next` | the call to paste: `tradeRun({stops: [...]})` for this route |
| `why` | what the row could not know: a stop with no route, an unknown tax. Absent when nothing is missing |

Each leg is:

| Field | What it is |
|---|---|
| `at` | the base |
| `source`, `age` | where its book came from (`here`, `faction ledger`, `remembered`) and its age in ticks; `here`/0 when live |
| `sold` | `{item_id, quantity, revenue}` per held item sold here |
| `buy`, `bought`, `cost` | the item taken on here, the units, and what they cost at the asks |
| `sales_tax` | tax on that buy; `null` when this stop's rate is not known |

At most 5 rows come back, priced ones first. A stop that could not be placed leaves its row in
the list with a `why`, a `score` of 0 and the Outcome `partial`.

## What a run says

`tradeRun({stops})` flies the stops in order. Each stop is `{at, buy?, quantity?, from?}`:

| Option | What it is |
|---|---|
| `at` | the base to stop at. `tradeRun` flies there itself; a stop you are docked at is not flown to |
| `buy` | the item to take on here, sized by the plan |
| `quantity` | a cap on `buy` |
| `from` | `'store'`: take `buy` out of this base's store, at no cost, instead of off the market |

At each stop it reads the live book, re-plans the rest of the route against it (later stops at
their best known books), and does the first leg of that plan: `sell`, then `buy` or `withdraw`.
A later stop with no known book may bid for anything, so goods are kept for it.

It answers `detail: Traded` = `{stops, unsold, net}`:

| Field | What it is |
|---|---|
| `stops` | one per stop reached: `{at, sold, bought, spent, why?}`. `sold` is the lib's `SellResponse[]` for this counter, `bought` the units taken on, `spent` their credits, and `why` what fell short here or why nothing was taken |
| `unsold` | `{item_id, quantity, why?}` rows aboard when the run ended. After the last stop, what no stop bought, or what a base off the route bids twice as much for (named in `why`) |
| `net` | sales, less purchases, less what the flights took out of the wallet |

It never throws. A flight that does not arrive is `partial`, with the stops done so far, and
`next` is the rest of the route. Re-running the same call starts again at the first stop and
re-plans from the hold you have. A load already aboard is carried on and is not bought twice. A
sale or buy the game refuses is `partial` too, and the run carries on to the next stop.

The menu offers `tradeRun({stops: [{at}]})` in every stance when something aboard has no bid here
and a remembered book elsewhere bids for it. For goods in the store here, it offers
`tradeRun({stops: [{at: here, buy, from: 'store'}, {at}]})`. The fuel to get there is not priced
into that line.

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
  const look = await routes();                       // every known route from this hold, ranked
  const best = look.detail.routes.find(row => row.total_jumps !== null && row.net > 0);
  if (!best) return look;
  note(`${best.legs.map(leg => leg.at).join(' → ')}: net ${best.net}, confidence ${best.confidence.toFixed(2)}`);
  return tradeRun({stops: best.legs.map(leg => leg.buy ? {at: leg.at, buy: leg.buy} : {at: leg.at})});
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
  twice: someone else is working it. It is contested; drop it and take the next row.
- Two `tradeRun`s that reach the far stop and still leave goods `unsold`: the far book is being
  drained by someone else.
  Change the pair.
- Trading is at 5+ and every spread is small: standing orders (`account().commands
  .spacemolt_market.create_buy_order`) earn the spread without flying; this library does
  not wrap them yet, and a raw order is a real escrow.
- Capital is growing faster than cargo: the hull is the limit. `shipsForSale()`.
