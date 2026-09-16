# trading — the Trader's evening

"I'll buy where it is cheap and sell where it is dear." 3,000–8,000 cr per leg in the
intermediate stage, and trading xp scales with credit volume. The whole skill is not committing
capital to a price that has moved.

## Functions

| Function | Promise |
|---|---|
| `findSpread({stations?, items?})` | live spreads between here and nearby markets, with depth and fuel netted |
| `tradeRun({item, sellAt, quantity?})` | buy here, fly, sell there; re-reads the book at each act |

Root functions do the rest: `prices()` for what you hold, `sell()`/`buy()` for one side only.

## Worked example

```ts
import {orient, findSpread, tradeRun, note} from 'play';

export default async function main() {
  await orient();
  const s = await findSpread();
  const best = s.detail.spreads.filter(x => x.net > 500).sort((a, b) => b.net - a.net)[0];
  if (!best) { note('no spread over 500 net within a jump; walk a wider circuit'); return s; }
  return tradeRun({item: best.item_id, sellAt: best.sell_at.base_id});
}
```

## What a good spread looks like

- Depth on both ends: `best_sell_qty` here and `best_buy_qty` there both cover the quantity.
- `net` positive after fuel at the all-in price, not just `margin_each`.
- The sell station is not no-go and its `police_level` fits the mood.
- The purchase leaves the wallet above `credit_reserve` by a margin; a run that fails leaves
  goods, not credits.

## When to reconsider

- Two runs `partial` at `leg: 'flown'`: the far book is being drained by someone else. Change
  the pair.
- Trading is at 5+ and every spread is small: standing orders (`account().commands
  .spacemolt_market.create_buy_order`) earn the spread without flying; this library does
  not wrap them yet, and a raw order is a real escrow.
- Capital is growing faster than cargo: the hull is the limit. `shipsForSale()`.

## Pitfalls

- A snapshot goes stale before arrival; we have watched a public market's supply vanish.
  `tradeRun` re-reads at the buy and at the sell.
- Sales tax is charged at buy time and netted from `gained.credits`.
- Contraband: `get_empire_info` lists each empire's contraband; a customs scan seizes and
  fines. `tradeRun` checks the destination empire's list before buying.
