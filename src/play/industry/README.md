# industry — the Industrialist's evening

"I'll turn what I have into something worth more." Refined goods sell for 2–40× the ore
(ore base value 4–1,200; refined 8–27,000). Crafting at the workshop trains crafting;
components and modules train engineering too.

A bench escrows its inputs out of **this base's store** and delivers the output back into it.
So the store, not the hold, is what has to be stocked, and the store's own delta before and
after is the only evidence the output arrived.

## Functions

| Function | Promise |
|---|---|
| `recipes(search?)` | what can be made here from hold + store, each one dry-run and priced, sorted by `margin` |
| `quote(recipe, qty?, {at?})` | the venue, escrow, labour, fee, ETA and margin; each short input priced to buy and to sell; commits nothing |
| `supply(recipe, qty?, {at?, maxSpend?, maxEach?})` | this base's store holds every input: stowed from the hold, the rest bought here |
| `craft(recipe, qty?, {at?})` | stow, quote, escrow, wait out the queue, confirm the outputs in the store |
| `jobs()` | every job you have queued, anywhere, and which are paused; works undocked |
| `catalog({search?, category?, makes?, uses?})` | the catalog's recipes, printed as text: what makes an item, what an item goes into; twenty at a time |
| `trace(itemOrRecipe, qty?)` | the whole tree `qty` takes, down to what is mined or bought, net of the hold and every store; each leaf's cheapest remembered ask; the other recipes one level deep |
| [`facilities/`](facilities/README.md) | owning and renting production: `facilities().here` lists the facilities at this station |

## Planning a craft

```ts
import {catalog, trace, supply, craft} from 'play';

export default async function main() {
  await catalog({uses: 'iron_ore'});         // what your ore goes into
  await catalog({makes: 'hull_plating'});    // or: every way to make what sells
  await trace('hull_plating', 5);            // the tree, what you hold of it (hold + every store), the rest to mine or buy
  const stocked = await supply('forge_hull_plating', 5);  // docked at a bench: stock this store
  if (stocked.status !== 'done') return stocked;
  return craft('forge_hull_plating', 5);
}
```

`catalog` and `trace` read the catalog and what you remember, and send nothing: they work undocked,
with no bench, and from `spacemolt_query`. So do `recipes`, `quote` and `jobs` (a quote is a dry run).
`trace` picks one route per item: recipes whose leaves are mined or harvested over bought, hand-craftable
over facility-only, and the cheaper when remembered asks price both. The others are listed under
`Alternates`; `trace('<recipe id>')` follows one.

`quote`, `supply` and `craft` want the ship docked at a base whose services include
`crafting` (or at the named facility's base). That refusal is itself the answer: the ore is at
the wrong base.

## Where to craft

`at` picks the bench. Leave it out and the server chooses.

| `at` | Costs | Trains | While you fly |
|---|---|---|---|
| `'workshop'` | inputs only | crafting XP | pauses until you dock here again |
| a facility's id from `facilities().here` | inputs, labour and a fee | nothing | keeps running; also runs facility-only recipes, with better yields |
| your own facility's id | inputs and labour | nothing | keeps running |

`quote` says which bench it priced (`venue`, `venue_type`, `labor`, `fee`) before you commit.

## Mine or buy

Every row of `quote(...).detail.missing` carries both prices: `buy_each` is what one costs on
this market with the buy fee already in it; `sell_each` is what one of your own fetches here
instead. When `buy_each` is `null` this market does not sell it: mine it — `trace(item, n)`
names the raw leaves under it, how each is got, and where it was last seen for sale.

## Worked example

```ts
import {orient, quote, supply, craft, trace, note} from 'play';

export default async function main() {
  await orient();

  const q = await quote('refine_steel', 10, {at: 'workshop'});   // reads only
  if (q.status !== 'done') return q;
  if ((q.detail.margin ?? 0) <= 0) { note(q.did); return q; }

  for (const row of q.detail.missing) {
    if (row.buy_each === null) return trace(row.item_id, row.need - row.have); // mine it
    note(`${row.item_id}: buy ${row.buy_each} vs sell ${row.sell_each ?? 'no bid'}`);
  }

  const stocked = await supply('refine_steel', 10, {at: 'workshop', maxSpend: 500});
  if (stocked.status !== 'done') return stocked;

  return craft('refine_steel', 10, {at: 'workshop'});            // stay docked while it runs
}
```

## What each one answers

- `recipes()` walks the public catalog against hold + store, keeps only the recipes whose
  inputs are **fully** covered, dry-runs each one for its real labour and fee, and prices the
  output against one read of this base's book. Twenty rows at most; `did` says how many were cut.
- `quote(recipe, qty)` is the server's own dry run, whole, plus `produces_total` (what the whole
  order makes), `output_value`, `margin` (output value less `credits_total`), and `missing`.
- `supply(recipe, qty)` estimates the whole bill before it moves anything; over `maxSpend` it is
  refused with nothing bought. So is an input over 1.05 × the cheapest ask remembered at another
  base (`why` names it and its age): buy it there, or pass `maxEach` (per unit) to pay this one. What this market does not sell comes back in `short` with its
  `source`, and the status is `partial`. What your stores at other bases hold of an input it had to
  buy is named in `did` and `elsewhere`; nothing is fetched from them. A stocked store is `done` with nothing sent.
- `craft(recipe, qty)` commits, waits and measures. A job already queued here for the same
  recipe and the same number of runs **is** this job: a re-run re-enters the wait.
- `jobs()` marks a workshop job `paused` when the ship is not docked at its base.

## Pitfalls

- `qty` counts output items and rounds up to whole runs; `quote` says how many runs.
- Stay docked for a workshop job, or craft at a facility and fly.
- Facilities give no XP. Train crafting at the workshop.
- Buying costs about 2.5% over the book's price; `buy_each` already includes it.
- Silicon and iron are often not sold at all. Read `missing` and `trace` before committing.
- `margin` values the output at the **top** buy level only; a big order fetches less.
- Outputs go to the store at this base: `sell(rows, {from:'store'})` here, or `withdraw`
  before flying.
- `craft` waits ten minutes, then returns `partial` with the job. Call it again with the same
  arguments, or read `jobs()`.

## When to reconsider

- Every craft needs an input you buy at market: that is trading with extra steps.
- `margin > 0` only here: check `spreads()` for the output before crafting a lot of it.
- Crafting is at 5+ and you own no facility: see `facilities/`.
