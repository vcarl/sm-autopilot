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
| `trace(itemOrRecipe, qty?)` | the whole tree `qty` takes, down to what is mined or bought, net of the hold and every store; each leaf's cheapest remembered ask; each facility-only step's stations known to rent one; the other recipes one level deep |
| `facilities()` | what you own everywhere, what is rentable here, what you could build here — reads only |
| `buildFacility(type)` | a facility of `type` owned at this station; idempotent |

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
- Crafting is at 5+ and you own no facility: see Owning a facility, below.

## Owning a facility

Not a separate specialty: the stage Industry grows into once a bench's margins are proven at
someone else's counter, so the pilot who already stands there keeps the fee instead of paying
it. A facility bills rent every cycle (100 ticks, ~17 min) from your wallet, everywhere it
stands, whether or not you are docked to see it. Fall behind past the game's own grace period
and the station repossesses it; a production facility repossessed is never returned.

```ts
import {facilities, buildFacility, note} from 'play';

export default async function main() {
  const f = await facilities();
  if (f.next.length) { note(f.next[0]!); return f; }        // runway under the grace period
  if (!f.detail.owned.length) return buildFacility('crew_bunk'); // quarters: the prerequisite
  return f;
}
```

- `facilities()` answers three things, each on its own: what you own everywhere, what is
  rentable at this station, and what you could build here. One the game refuses does not blank
  the others; `did` names which. `owned` carries `runway_cycles`: the wallet's credits over the
  TOTAL rent per cycle across every facility you own, because one wallet pays all of them. `next`
  warns when that runway is under the game's own `grace_cycles`. What is public here is also
  remembered, for `trace` and `catalog` to name later.
- `here` is this station's rentable facilities: yours, or public with a fee. A station's own
  counters (repair, market) carry no fee and are not public, so they never appear. `id` is what
  `craft`'s `at` option and the owner verbs below take.
- `buildFacility(type)` ends with the facility owned here, or refuses naming why: not docked,
  no such type, a build material short in this station's **store** (not the hold), or a price
  that would breach `credit_reserve`. Already owned here is `done` with nothing sent.

### The owner verbs

Not wrapped yet; reach them as raw commands, proven against the live game:

| Verb | What it does |
|---|---|
| `account().commands.spacemolt_facility.set_access({facility_id, access})` | `'private'` (the default on a new facility) or `'public'` — public is what makes it rentable |
| `account().commands.spacemolt_facility.set_output_price({facility_id, price})` | the price a renter's fee is computed from (fee = output price × outputs per run) |
| `account().commands.spacemolt_facility.job_add({facility_id, recipe_id, quantity})` | `quantity` counts **output items**, rounded up to whole runs — not runs themselves |
| `account().commands.spacemolt_facility.job_reorder({facility_id, job_id, position})` | move a queued job |
| `account().commands.spacemolt_facility.job_cancel({job_id})` | drop a queued job |
| `account().commands.spacemolt_facility.list_for_sale({facility_id, price})` | sell the facility itself; charges a **non-refundable** 1% listing fee up front |
| `account().commands.spacemolt_facility.cancel_listing({facility_id})` | pull it back off the market |

As owner you pay only labour on your own jobs; a renter pays labour plus the fee, and the fee
is yours, not a split.

### Owner pitfalls

- Build materials come out of **this station's storage**, never the hold — `buy(...,
  {deliverTo:'storage'})` or `stow(...)` them there first.
- A new facility is **private** by default. `set_access` it public before expecting any
  rental income at all.
- `list_for_sale`'s listing fee is charged whether or not the facility sells. Price it once
  you mean it.
- `job_list` only answers for a facility whose station you are docked at right now; asking it
  from elsewhere fails, which is why `facilities()` never calls it.
- Facility runs give **0 xp**, owned or rented: train crafting at the workshop. Building one
  grants corporation_management xp once; no passive accrual has been seen.
