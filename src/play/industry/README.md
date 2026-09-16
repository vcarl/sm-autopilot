# industry — the Industrialist's evening

"I'll turn what I have into something worth more." Refined goods sell for 2–40× the ore
(ore base value 4–1,200; refined 8–27,000). Crafting trains crafting; components and modules
train engineering too. This is the intermediate stage's margin without extra travel.

## Functions

| Function | Promise |
|---|---|
| `recipes(search?)` | recipes ranked by margin at this base's prices and by inputs you already hold |
| `quote(recipe, qty?)` | dry-run: labour, fee, ETA, missing inputs; commits nothing |
| `craft(recipe, qty?, {preset})` | escrow, queue, wait, confirm outputs in the store |
| [`facilities/`](facilities/README.md) | owning production (advanced): build, queue jobs, rent out capacity |

## Worked example

```ts
import {orient, recipes, quote, withdraw, buy, craft, sell, note} from 'play';

export default async function main() {
  await orient();
  const list = await recipes('plate');                          // what can I make from ore I hold
  const best = list.detail.recipes.find(r => (r.margin ?? 0) > 0 && r.hand_craftable);
  if (!best) { note('no positive-margin recipe here; try a station with a workshop'); return list; }

  const q = await quote(best.id, 10);
  for (const gap of q.detail.missing) {                          // buy what the store lacks
    const b = await buy(gap.item_id, gap.quantity);
    if (b.status !== 'done') return b;
  }
  const made = await craft(best.id, 10);
  if (made.status !== 'done') return made;
  return sell(made.detail.made);                                 // sell only what was made
}
```

## What a good craft looks like

- `margin > 0` at the base where you will sell, not just where you craft.
- Inputs are already in the store (mined last shift), so the craft costs only the fee.
- The recipe is `hand_craftable` or a rentable facility is here; `craft` auto-routes.
- The fee leaves the wallet above `credit_reserve`.

## When to reconsider

- Every craft needs an input you buy at market. That is trading with extra steps.
- The workshop queue is long and `craft` keeps returning `partial`. Queue before a gather trip
  and collect after.
- Crafting is at 5+ and you own no facility. Owning one earns passive corporation_management
  xp; see `facilities/`.

## Pitfalls

- Do not re-issue a craft while one is queued; `craft` re-enters the wait for you.
- Outputs go to the store at this base; `sell` here or `withdraw` before flying.
- The catalog can 429; `recipes` retries once and then says so.
