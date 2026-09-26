# industry — the Industrialist's evening

"I'll turn what I have into something worth more." Refined goods sell for 2–40× the ore
(ore base value 4–1,200; refined 8–27,000). Crafting trains crafting; components and modules
train engineering too. This is the intermediate stage's margin without extra travel.

A bench escrows its inputs out of **this base's store** and delivers the output back into it.
So the store, not the hold, is what has to be stocked — `craft` stows what the hold carries
for you — and the store's own delta before and after is the only evidence the output arrived.

## Functions

| Function | Promise |
|---|---|
| `recipes(search?)` | what can be made here from hold + store, each one dry-run and priced, sorted by `margin` |
| `quote(recipe, qty?)` | one recipe's escrow, fee, ETA and margin; the inputs the store is short of; commits nothing |
| `craft(recipe, qty?, {preset})` | stow, quote, escrow, wait out the queue, confirm the outputs in the store |
| `facilities()`, `buildFacility`, `queueJob` | owning production (advanced): not built yet, and they throw `unimplemented`; `account()` reaches the commands |

All three are refused unless the ship is docked at a base whose services include `crafting`.
That refusal is itself the answer: the ore is at the wrong base.

## Worked example

```ts
import {orient, recipes, craft, prices, sell, note} from 'play';

export default async function main() {
  await orient();

  const list = await recipes();                       // docked at a workshop; reads only
  if (list.status !== 'done') return list;            // refused = no bench here
  const best = list.detail.recipes[0];                // already sorted by margin
  if (!best || (best.margin ?? 0) <= 0) {
    note('nothing here is worth crafting at this base\'s prices');
    return list;
  }

  const made = await craft(best.id, 10);              // stows, escrows, waits, confirms
  if (made.status !== 'done') return made;            // partial = still queued; call again

  await prices(made.detail.made.map(row => row.item_id));
  return sell(made.detail.made, {from: 'store'});     // sell only what was made, by name
}
```

## What each one answers

- `recipes()` walks the public catalog against hold + store, keeps only the recipes whose
  inputs are **fully** covered, dry-runs each one for its real labour and fee, and prices the
  output against one read of this base's book. `margin` is output value less `credits_total`,
  in credits. Twenty rows at most; `did` says how many covered recipes were cut.
- `quote(recipe, qty)` is the server's own dry run, whole: `cost` (inputs, labour, fee),
  `credits_total`, `est_completion_tick`, `have_inputs` / `have_credits` / `have_capacity` —
  plus `output_value`, `margin`, and `missing`, each short input with the local ask.
- `craft(recipe, qty)` checks in this order: docked at a workshop, the inputs in the store
  (stowing from the hold by name when they are aboard instead), the fee inside
  `credits − permissions.credit_reserve`. Then it commits, waits, and measures. It is
  idempotent: a job already queued here for this recipe **is** this job, so a re-run re-enters
  at the wait and escrows nothing twice.

## What a good craft looks like

- `margin > 0` at the base where you will sell, not just where you craft.
- Inputs are already in the store (mined last shift), so the craft costs only the fee.
- The fee leaves the wallet above `credit_reserve`.

## When to reconsider

- Every craft needs an input you buy at market. That is trading with extra steps.
- The workshop queue is long and `craft` keeps returning `partial`. Queue before a gather trip
  and call `craft` again after; it re-enters the wait.
- Crafting is at 5+ and you own no facility. Owning one earns passive corporation_management
  xp; the facility commands are on `account()`.

## Pitfalls

- `margin` values the output at the **top** buy level only (`best_buy × best_buy_qty`). A run
  big enough to eat past that level fetches less than the margin implies.
- Outputs go to the store at this base: `sell(rows, {from:'store'})` here, or `withdraw`
  before flying.
- The catalog is an HTTP read (`/api/catalog.json`), fetched once per process. If it is
  unreachable, `recipes` comes back `failed` and says so; `quote` and `craft` do not need it.
- `craft` waits ten minutes, then returns `partial` with the job. Nothing is lost: call it
  again with the same arguments.
