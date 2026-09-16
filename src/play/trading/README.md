# trading — the Trader's evening

"I'll buy where it is cheap and sell where it is dear." The hard part is not the arithmetic.
It is that the game will not tell you what another station pays, so the first question a
loaded pilot has — *who buys this?* — has no direct answer. `spreads()` is that answer,
assembled from everything this pilot is allowed to know.

## Functions

| Function | Promise |
|---|---|
| `spreads(items?)` | the best buyer known for each thing you hold, anywhere, with the trip priced and netted |
| `tradeRun({item, sellAt, quantity?})` | buy here, fly, sell there; the realised net from the wallet |

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
| `faction ledger` | `spacemolt_intel/query_trade_intel` — other pilots' filed observations | `seen` carries `submitted_at_tick` |
| `remembered` | a book **this pilot** read at that base on an earlier visit | `seen` carries the timestamp |

The ledger needs a faction with a trade-intel facility; without one the command throws and
`spreads()` carries on with the other two, saying so in `did` and in `detail.sources`. The
memory is free and always there: every `book()` read — by `prices()`, `sell()`, `recipes()`,
`quote()` — writes that base's whole book to `markets.json` in the runtime dir, last 12 bases.
So the second visit knows what the first one saw, across runs and across restarts. It follows
that the way to *learn* a price is to go and stand in front of it: `goTo(base)` then
`prices()`, once, and that base is in the memory for good.

A remembered or filed price is a memory. The book may have moved. `tradeRun` re-reads at the
buy and `sell` re-reads at the sell, so nothing is sent against a stale number.

## What a row says

`net` is `best_buy × min(best_buy_qty, held)` less the fuel bill to get there, at **this**
base's `fuel_price_all_in`, from one `find_route` per far base. `held` is the hold plus this
base's store, because that is what you could put on the counter. Rows are sorted by `net`, so
a fat price four jumps out can rank below a thin one here — which is the comparison a loaded
pilot actually needs.

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

## Pitfalls

- A snapshot goes stale before arrival; we have watched a public market's supply vanish. The
  `source` and `seen` fields are there so you can weigh that before committing fuel.
- Sales tax is charged at buy time and netted from `gained.credits`.
- `net` prices the top buy level only. A load big enough to eat past it fetches less.
- Contraband: `get_empire_info` lists each empire's contraband; a customs scan seizes and
  fines. Neither function checks it yet — read the list before hauling something exotic.

## When to reconsider

- Two `tradeRun`s `partial` at `leg: 'flown'`: the far book is being drained by someone else.
  Change the pair.
- Trading is at 5+ and every spread is small: standing orders (`account().commands
  .spacemolt_market.create_buy_order`) earn the spread without flying; this library does
  not wrap them yet, and a raw order is a real escrow.
- Capital is growing faster than cargo: the hull is the limit. `shipsForSale()`.
