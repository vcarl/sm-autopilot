# industry/facilities — owning the bench

Not a separate specialty: the stage Industry grows into once a bench's margins are proven at
someone else's counter, so the pilot who already stands there keeps the fee instead of paying
it. A facility bills rent every cycle (100 ticks, ~17 min) from your wallet, everywhere it
stands, whether or not you are docked to see it. Fall behind past the game's own grace period
and the station repossesses it; a production facility repossessed is never returned.

| Function | Promise |
|---|---|
| `facilities()` | what you own everywhere, what is rentable here, what you could build here — reads only |
| `buildFacility(type)` | a facility of `type` owned at this station; idempotent |

## Worked example

```ts
import {facilities, buildFacility, note} from 'play';

export default async function main() {
  const f = await facilities();
  if (f.next.length) { note(f.next[0]!); return f; }        // runway under the grace period
  if (!f.detail.owned.length) return buildFacility('crew_bunk'); // quarters: the prerequisite
  return f;
}
```

## What each one answers

- `facilities()` reads `facility/owned` (everywhere you own one), `facility/list` (this
  station's), and `facility/types` for the production and personal categories (what you could
  build here). Each read is independent — one failing does not fail the others, and `did` names
  which. `owned` carries `runway_cycles`: the wallet's credits over the TOTAL rent per cycle
  across every facility you own, because one wallet pays all of them. `next` warns when that
  runway is under the game's own `grace_cycles`.
- `here` is this station's rentable facilities: yours, or public with a fee. A station's own
  counters (repair, market) carry no fee and are not public, so they never appear. `id` is what
  a bench's `at` option and the owner verbs below take.
- `buildFacility(type)` checks in order: already owned here (done, nothing sent); docked;
  the type exists; this station's **store** — not the hold — holds every build material; the
  price clears `credit_reserve`. It then commits `build` (production) or `personal_build`
  (`workshop_*`, `crew_bunk`, and other personal types — routed by the type's own `category`),
  and measures the result from a fresh `owned` read rather than trusting the commit's reply.

## The owner verbs

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

## Pitfalls

- Build materials come out of **this station's storage**, never the hold — `buy(...,
  {deliverTo:'storage'})` or `stow(...)` them there first; `buildFacility` refuses and names
  the shortfall rather than guessing what you meant to carry.
- A new facility is **private** by default. `set_access` it public before expecting any
  rental income at all.
- `list_for_sale`'s listing fee is charged whether or not the facility sells. Price it once
  you mean it.
- `job_list` only answers for a facility whose station you are docked at right now; asking it
  from elsewhere fails, which is why `facilities()` never calls it.
- Facility runs give **0 xp**, owned or rented: train crafting at the workshop. Building one
  grants corporation_management xp once; no passive accrual has been seen.
