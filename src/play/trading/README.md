# trading — the Trader's evening

"I'll buy where it is cheap and sell where it is dear." The hard part is not the arithmetic.
It is that the game will not tell you what another station pays, so the first question a
loaded pilot has — *who buys this?* — has no direct answer. `spreads()` is that answer,
assembled from everything this pilot is allowed to know.

## Functions

| Function | Promise |
|---|---|
| `spreads(items?)` | the best buyer known for each thing you hold, anywhere, with the trip priced and netted |
| `routes({items?})` | every buy-at-A, sell-at-B trade known, and every known buyer for what is aboard, sized against both books and the hold, fuelled, and ranked by trust-weighted net per jump; each row carries the call to paste |
| `tradeRun({item, sellAt, quantity?, from?})` | get `item` sold at `sellAt`: carry what is aboard (`from: 'store'` withdraws what the hold fits from the store here first), or buy `quantity` here when none is aboard; fly; sell there. The realised net from the wallet |

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

A remembered or filed price is a memory. The book may have moved. `tradeRun` re-reads at the
buy and `sell` re-reads at the sell, so nothing is sent against a stale number.

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

## What a route says

`routes({items?})` answers `detail: {routes, sources}`. `items` narrows it to those item ids;
the default is every item on any book known. `sources` is as for `spreads()`. It reads only:
it computes, you choose. It is refused when not docked. Goods aboard are candidates in their own
right: their cost is sunk, so a full hold's best route may be carrying what it has. Goods in the
store here are not candidates yet.

Each row of `routes` is a `Route`:

| Field | What it is |
|---|---|
| `item_id` | the item |
| `buyAt`, `sellAt` | the base it is bought at and the base it is sold at; either may be this one. `buyAt` is `'held'` for goods already aboard: nothing is bought, `cost` and `sales_tax` are 0, and `buySource`/`buyAge` read `here`/0 |
| `buySource`, `sellSource` | where each end's price came from: `here`, `faction ledger` or `remembered` |
| `buyAge`, `sellAge` | each end's age in ticks; 0 for this base's live book |
| `quantity` | units worth moving: `buyAt`'s asks and `sellAt`'s bids walked level by level up to the free hold, stopped at the last unit whose bid still beats its ask plus tax. A deep book fills the hold; a thin one stops short. With the hold full, a buy is sized to the whole hold (what selling frees) and `why` says to sell first. For `'held'`, what is aboard, up to what `sellAt`'s bids take |
| `cost`, `revenue` | what those units cost at `buyAt` and fetch at `sellAt`, level by level |
| `sales_tax` | tax on the buy at this base's `sales_tax_rate_bps`; `null` when not known, which is always so for a far `buyAt` (the net is then untaxed and `why` says so) |
| `total_jumps` | jumps for the trip; `null` when a `find_route` failed |
| `fuel` | fuel units, `total_jumps × fuel_per_jump`; `null` when a `find_route` failed |
| `net` | `revenue − cost − sales_tax − fuel` at this base's `fuel_price_all_in`. Fuel is left out when it could not be priced |
| `confidence` | `0.5 ^ ((buyAge + sellAge) / 360)`: 1 for two live books, half for an hour of age |
| `score` | the rank: `confidence × net / max(1, total_jumps)`. 0 when the trip could not be priced |
| `next` | the call to paste: `tradeRun({item, sellAt, quantity})`, preceded by `goTo('<buyAt>') then` when `buyAt` is not here. For `'held'`: `tradeRun({item, sellAt})`, which carries what is aboard, or `sell([{item_id}])` when `sellAt` is here |
| `why` | what the row could not know or needs first: a failed route lookup, an unknown tax, a full hold. Absent when nothing is missing |

Only the top 5 candidates are priced with `find_route` (each is a game call), so at most 5 rows
come back, priced ones first. `find_route` answers only from where the ship is, so a trip from
here to a far `buyAt` and on to `sellAt` is quoted as there, back, and out again: an upper bound,
exact when either end is here. A route lookup that fails leaves its row in the list with a `why`
and makes the Outcome `partial`.

## What a run says

`tradeRun` answers `detail: Traded` = `{item_id, estimate, bought, carried, sold, net, leg}`.
`bought` is what it bought here (0 when it carried), `carried` is what was already aboard or
came out of the store, `estimate` is the buy preview (empty when nothing was bought), `sold` is
the lib's `SellResponse[]` from the far counter, `net` is sales less purchase less what the
flight took out of the wallet, and `leg` is how far it got: `bought`, `flown` or `sold`. Goods
already aboard are delivered rather than added to, so a second `tradeRun` after a `partial` at
`leg: 'bought'` finishes the first one. With `from: 'store'` and nothing stored or aboard it is
`done`: there was nothing to carry.

The menu offers `tradeRun({item, sellAt})` in every stance when something aboard, or with
`from: 'store'` stored here, has no bid here and a remembered book elsewhere bids for it. The
fuel to get there is not priced into that line.

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
import {orient, routes, goTo, tradeRun, note} from 'play';

export default async function main() {
  await orient();
  const look = await routes();                       // every known trade, sized, fuelled, ranked
  const best = look.detail.routes.find(row => row.total_jumps !== null && row.net > 0);
  if (!best) return look;
  note(`${best.quantity} ${best.item_id} ${best.buyAt}→${best.sellAt}: net ${best.net}, confidence ${best.confidence.toFixed(2)}`);
  if (best.buyAt !== 'held' && best.buyAt !== look.now.location.docked_at) {
    const there = await goTo(best.buyAt);            // buy where it is cheap
    if (there.status !== 'done') return there;
  }
  return tradeRun({item: best.item_id, sellAt: best.sellAt, quantity: best.quantity});
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
- Two `tradeRun`s `partial` at `leg: 'flown'`: the far book is being drained by someone else.
  Change the pair.
- Trading is at 5+ and every spread is small: standing orders (`account().commands
  .spacemolt_market.create_buy_order`) earn the spread without flying; this library does
  not wrap them yet, and a raw order is a real escrow.
- Capital is growing faster than cargo: the hull is the limit. `shipsForSale()`.
