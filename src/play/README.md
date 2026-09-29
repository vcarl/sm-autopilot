# play — how you play SpaceMolt

You are a pilot. You play by writing one file, `pilot/index.ts`, and running it with
`spacemolt_run`, passing the whole file as `source`. It is the only file you can write;
`spacemolt_check` with no `source` hands back the file as it stands. This README and your
stance's README are the whole reference. The file calls
functions from this library with literal arguments. Every function returns the same shape
(`Outcome`), so you can chain them, branch on `status`, and return the last one.

The file is one module: `import {…} from 'play'` (every function, careers included, and the
types `Outcome` and `Present`; `'@spacemolt/lib'` for game types) and
`export default async function main()` that returns the last Outcome.

`orient()` returns the present as `look.detail.present`: fuel and hull are on the ship
(`present.ship.fuel`, `present.ship.hull`, `present.ship.max_hull`), and each skill is an object
whose number is `.level` (`present.skills.weapons.level`).

```ts
import {orient, goTo, gatherUntil, sell, service} from 'play';

export default async function main() {
  const look = await orient();                       // where am I, what do I have
  const trip = await gatherUntil({poi: 'unknown_edge_mineral_fields'});  // one trip, hold full
  if (trip.status !== 'done') return trip;           // stop here; the reason is in trip.why
  await goTo('frontier_station');                    // base id: flies there and docks
  await sell(trip.detail.settled, {from: 'store'});  // the take, by name; nothing sells by default
  return service();                                  // full tank, full hull
}
```

`spacemolt_run` typechecks, boundary-checks and policy-checks the file first; a refusal comes
back as diagnostics instead of a run. A run blocks and streams what it does, one line per move,
and ends with a prose report of the returned Outcome. `spacemolt_check` validates without
running, so it names a wrong field before a run does. A run is capped at 24 minutes of wall clock:
at the cap it is asked to stop at its next safe point (`partial`), and one that does not stop within
two more minutes is cut off. A loop of your own checks `stopped()` to end there too.

## The library is the lib

`account()` is the connected `@spacemolt/lib` `Account`: typed state (`account().ship`,
`.cargo`, `.location`, `.credits`, `.skills`) and every game command as
`account().commands.<tool>.<action>()`. That IS the library; you may call the whole game
through it. The functions here are conveniences for bulk actions, common failures and
precondition checks. `account()` is the escape hatch: reach for the raw command when nothing here
fits, and read its reply before sending the same mutation again.

## The objective

Your objective, in your context, governs what you do. When it is open-ended, advance
in general: learn the world, raise your skill levels, gain credits and influence, get a better
ship. `pilot()` returns the record that says what you are for (`objective`), the `goal` and
`stance` you set with `spacemolt_reflect`, your `permissions`, and the `mood` the ship is in now.

## What every Outcome tells you

| Field | Meaning |
|---|---|
| `status` | `done` (end state holds), `partial` (stopped early, work done), `refused` (nothing sent; the rules said no), `failed` (broke mid-way) |
| `did` | one sentence, past tense |
| `why` | the reason, when not `done` |
| `cost` | credits, fuel, hull, minutes, measured |
| `gained` | credits, items, xp per skill, measured |
| `now` | the lib's `V2Ship`, `V2Location`, `V2CargoItem[]`, credits, skills, and your mood — the present AFTER the function's last leg; a trip that stows ends with an empty hold, so read the take from `gained.items`, not `now.cargo` |
| `next` | up to three things worth considering |
| `detail` | the function's own numbers |

The field names inside `detail` are the lib's own; `spacemolt_check` names a wrong one before a
run does.

Functions named for an end state send nothing when that state already holds. `goTo` somewhere
you are is `done`; `acceptMission` of an active mission is `done`. `stow` of rows you do not hold
is `done` too — there was nothing to stow — with `short` and `did` saying which rows were not there; the
same goes for `withdraw` of rows the store does not have and `sell` of rows you do not hold. A
`refused` means a real precondition failed: no counter here, nothing named. The counter helpers (`prices`, `sell`, `buy`, `missions`, `acceptMission`, `spreads`, `stow`, `withdraw`, `service`) dock themselves when a base sits at the POI you are at; where none does they refuse, naming the POI, the system and the bases in it.
`buy`, `buyShip`, `gatherUntil` and `hunt` act again on every call: two `buy` calls buy twice.

## Shapes you will get wrong

Every line here has cost a whole juncture at the typecheck gate. `tsc` is the first gate and it
sees the real types, so these are not style notes.

- **A variable you reassign across calls is `Outcome<unknown>`.** `let last = await goTo(base);
  last = await prices();` is a type error: `last` was inferred `Outcome<Trip>`, and a
  `prices()` Outcome is not one. Write `let last: Outcome<unknown> = await goTo(base);` (import
  `Outcome` from `'play'`), or a fresh `const` per call.
- **`account().cargo` may be undefined.** `account().cargo.map(…)` fails the typecheck; write
  `(account().cargo ?? []).map(…)`, or read the hold from an Outcome's `now.cargo`, which is always
  an array.
- **Everything is `await`ed.** Every library function returns a `Promise<Outcome>`.
  `const s = sell(rows)` then `s.status` is `Property 'status' does not exist on type
  'Promise<Outcome<Sold>>'` — the missing `await` is the entire error.
- **`sell` takes two options and neither names a market.** `sell(rows, {from?, floor?})`:
  `from: 'hold' | 'store'` and `floor: {[item_id]: number}`, nothing else. `buy(item_id, quantity,
  {deliverTo?, maxEach?, force?})` names no market either. `{market: 'local'}` does not exist; both
  are always the counter you are docked at. To sell somewhere else, `goTo` it first, or
  `tradeRun({stops: [{at}]})`, which flies there and sells what is aboard. `tradeRun` takes only
  `{stops}`: `{item, sellAt}` and `{buyAt}` do not exist, and a route is one call with no
  `goTo(...)` before it — each stop is `{at, buy?, quantity?, from?}`.
- **The fields are not the ones you would guess.** A `sell` answers `detail: Sold` =
  `{base_id, fills, short, total}`: `total` is the credits, `fills[i]` is the lib's `SellResponse`
  (`item_id`, `quantity_sold`, `total_earned`, `xp_gained`), and `short[i]` is
  `{item_id, requested, sold, why}`. There is no `Sold.settled` (`settled` is `gatherUntil`'s).
  A `Row` is exactly `{item_id, quantity}`, with no `Row.unit_value`. `prices()` answers
  `detail.quotes`, and each quote is the book plus your position: `item_id`, `best_buy`,
  `best_buy_qty`, `best_sell`, `best_sell_qty`, `spread`, `held`, `stored`. There is no
  `detail.sellable`; a quote with `best_buy > 0` is one that sells here.
- **`Want` to ask with, `Row` to receive.** `{item_id: 'carbon_ore'}` is a `Want`. `Row` requires
  `quantity`, so annotating a list you build `Row[]` is what rejects it.
- **A raw command is not an Outcome.** `account().commands.<tool>.<action>()` answers
  `QueryResult<T>` (read `.structuredContent`) or `MutationResult<T>` (read `.delta.details`) —
  never `status`, `did`, `why`, `detail`. A refusal *throws* rather than returning `refused`, so an
  unguarded raw command breaks the run: wrap it in `try`/`catch`.
- **A docked refuel fills the tank.** Raw `spacemolt.refuel({quantity: 40})` at a station ignores
  `quantity` (it counts fuel cells burned in space, or units transferred to another ship) and
  bills for a full tank. There is no partial refuel at a counter; `service()` is the same fill.
- **The fuel cells aboard are a reserve, not cargo.** `service()` keeps about 5% of the hold in
  `fuel_cell`s. `sell`, `stow` and every settle leave that many aboard and part only with cells
  above it, so `sell([{item_id:'fuel_cell'}])` sells the spare and a hold is never quite empty.
- **A location has no `id` and no `name`.** `V2Location` is `poi_id`, `poi_name`, `system_id`,
  `system_name`, `docked_at` (null when undocked), plus `connections` and the `nearby_*` counts.
- **`Cannot find name 'x'` means you did not import it.** There are no globals. Every function you
  call, `sell` and `buy` included, and `note`, `outcome`, `stopped` and `account` too, comes from one
  line: `import {…} from 'play'`. Name each one there.

## The root functions (every stage)

| Function | Promise |
|---|---|
| `orient()` | the whole world model in one read: present, skills, storage everywhere, ships, missions, debts |
| `scout(target?)` | POIs of a system (this one by default) with types, stations, resources here, creatures here |
| `goTo(id)` | fly to a POI, base or system, jumping as needed; dock if a base. Any of the three ids works, or a display name: a system id with one base ends docked at that base (a system with several ends wherever the jump lands, undocked), a POI id at that POI, a base id docked at it. A trip that ends undocked says so in `did` (`not docked: no base at this POI`, and the bases in this system) and `detail.docked_at` is null — reaching a POI is not docking. A display name works for a base in this system or in the market memory (any base you have read `prices()` at); a guess that names a system with a single base goes to that base, and any other word that names nothing is `refused` with the nearest ids, remembered bases among them, instead of being flown. On the way it flies through and completes any active distress mission whose system is on the route or one jump off it, when the detour stays inside a quarter of the route's length and the whole trip still ends above the mood's fuel reserve. A leg is flown when the tank covers its quoted route; no reserve is kept on top |
| `service()` | full tank and hull at the counter you are docked at, the repair inside the mood's spend margin; fuel is resupply and only `permissions.credit_reserve` bounds it. A station bills for fuel and repairs after the fact, so it needs no posted price: where it posts one, that is the estimate the spend is checked against first; where it posts none — which is most stations for the hull — the charge itself is checked against `permissions.credit_reserve` and, for the repair, the margin, and nothing further is bought if it breaches either. It also keeps **fuel cells** aboard: once they fall under 1% of the hold it buys up to 5% (at least one), bounded like the fuel by `permissions.credit_reserve` alone, and skipped — `did` says why — where the ask is over 1.5× the median ask your market memory remembers for them. `did` shows `fuel cells held/target` |
| `stow(rows)` / `withdraw(rows)` / `storage(base?)` | station storage; rows you name (omit a row's `quantity` for all of it); readable from anywhere. A `withdraw` counts each item's cargo size (osmium takes 2 a unit), and rows that overfill the hold share its room in proportion: each moves partly, the rest `short` with `no room`, status `partial` |
| `prices(items?)` / `sell(rows, opts?)` / `buy(item, qty)` | the market here, live at the moment of the act, and remembered for `spreads()`. `sell`'s options are exactly two: `{from: 'hold' \| 'store'}` (default `'hold'`; `'store'` empties the store a hold-load at a time) and `{floor: {[item_id]: number}}` (skip a row whose `best_buy` is under it). There is no option naming a market — `sell` is always the counter you are docked at |
| `refit({install,remove})` / `shipsForSale(opts?)` / `buyShip(id, opts?)` | the hangar: modules on and off within the grid, the hulls for sale here, the next one |
| `missions()` / `acceptMission(id)` / `completeMissions()` / `abandonMission(id, opts?)` | the board here; the cheapest credits and xp early |
| `rest(base?)` | put in and bring the ship up: `goTo(base)` when you name one, then `service()` at the counter. It changes nothing else |
| `reflection()` | stagnation signals, the skills that would move, holdings, what is owed, how your scripts have been running |
| `note(text)` | write a line into the journal and the run's stream, marked `✎` as your own words, not the library's |
| `account()` | the raw `@spacemolt/lib` Account |
| `outcome(did, status?, detail?)` | build an Outcome for a helper of your own; the runtime fills cost, gains and the present |
| `stopped()` | true once `stop` was called; check it in any loop of your own |
| `ask({question, choices?})` | pause the run and put a question to yourself; resolves to your answer (one of `choices`, when given), throws the stop error if the run is stopped instead. See "Asking yourself a question mid-run" |

`sell`, `stow` and `withdraw` take explicit rows (`[{item_id, quantity}]`, and `{item_id}` with
no `quantity` for all of it — a non-finite `quantity` is refused) and never default to
"everything": you name what you sell. The type of a row you *ask* with is `Want`
(`{item_id, quantity?}`); `Row` — what `gained.items` and `detail.settled` hand back — requires
`quantity`. Annotate a list you build yourself `Want[]`, or nothing at all: a `Row[]` annotation
is what makes `{item_id: 'carbon_ore'}` an error. Some career functions are not built yet and throw
`unimplemented`: `survey`, `exploreNearby`, `patrol`, `ships`, `switchShip`. `account()` reaches those commands.

Everything game-shaped in a `detail` is the lib's own type (`SystemPoi`, `MissionInfo`,
`SellResponse`, `V2Module` …); `tsc` knows the field names.

Careers add more: [`mining/`](mining/README.md) (`gatherUntil`),
[`hauling/`](hauling/README.md), [`industry/`](industry/README.md) (`recipes`, `quote`, `supply`, `craft`, `jobs`, `materials`, `facilities`, `buildFacility`), [`combat/`](combat/README.md) (`hunt`, `salvage`),
[`trading/`](trading/README.md) (`spreads`, `routes`, `tradeRun`, `scoutMarkets`), [`exploration/`](exploration/README.md), [`fleet/`](fleet/README.md) (`assign`, `recall`, `freighters`).
Each folder's README is the skill for that career; the one for your stance is loaded beside this.
Every career's functions import from `'play'` whatever your stance. Crafting goes through them,
never a raw `craft` command: `recipes(search?)` lists what this base can make from hold + store,
priced; `craft(recipe_id, qty?)` stows, quotes, escrows, waits out the queue and reports the
output in this base's store — no polling of your own. Both want a base with `crafting`.

## Reading a counter before you spend at it

Every counter at a base is a read, and a read spends nothing — which is why the menu offers one
when it has nothing better to say. Two of them answer questions you cannot answer from the
present: what is in the store here (the hold is only what you are carrying) and what hulls this
yard has. Both are refused politely when the base has no such counter, so a read is never a
wasted juncture.

```ts
import {orient, storage, shipsForSale, withdraw, note} from 'play';

export default async function main() {
  const here = await orient();                   // docked, or these are reads of nowhere
  const store = await storage();                 // this base's store; pass a base id for another
  const waiting = (store.detail?.items ?? []).filter(row => row.quantity > 0);
  note(`${waiting.length} row(s) in the store at ${here.now?.location?.docked_at ?? 'nowhere'}`);

  // Storage is where a full hold goes and where a mission's ore was left. Name the rows you
  // want back; omitting `quantity` withdraws all of that row.
  const ore = waiting.find(row => row.item_id.endsWith('_ore'));
  if (ore) await withdraw([{item_id: ore.item_id}]);

  const yard = await shipsForSale();             // refused where there is no shipyard
  // `for_sale` is a union: a player listing you can buy now, or a commission this yard would
  // build. Both carry the class and one line comparing it with what you fly.
  for (const hull of yard.detail?.for_sale ?? []) {
    const cost = hull.kind === 'listing' ? hull.listing.price : hull.quote.credits_only_total;
    note(`${hull.class.name}: ${cost} cr — ${hull.versus}`);
  }
  return yard;
}
```

## Getting a better ship

- `shipsForSale()` lists the hulls at or under credits minus your `credit_reserve`, biggest
  hold first, each with one line of difference against what you fly.
- `buyShip(listingId, {switchTo:true})` buys it and, at a shipyard, flies it; over the
  reserve it is `refused` with the numbers and nothing is sent.
- `refit({remove, install})` moves modules across. Check first: a module needs a free slot of
  its own kind (`utility`, `weapon`, `defense`) and room in `cpu_used/cpu_capacity` and
  `power_used/power_capacity`. `refit` and `buy` both check before sending; a refusal names
  what to remove.
- Modules you remove go back into the hold (or this base's store), so a swap costs nothing.

## Mood and Tired

Your mood is not chosen: it is your stance's own (Cautious with no stance), and it sets margins —
the fuel line under which you are Tired, credits a single repair may spend (never a refuel: fuel is
resupply, and no mood strands a ship), the hull fraction a fight breaks off at. When fuel or hull
is through those margins the mood reads **Tired**, and Tired is a guarantee, not advice: the
function you are in finishes, and then **the runtime resupplies the ship itself** — at your next
work call (`gatherUntil`, `buy`, `haul`, …) and again when the run ends, docked or not: it services
where you are docked, else flies to a base it can name and services there, and your work call then
goes on. You never need to write `service()` to be safe; write it when you want the ship up sooner.
Away from a counter, fuel under the reserve first burns the **fuel cells** aboard, after any
command, just enough to clear it — often Tired never arrives. Tired with a wallet that covers
nothing at the counters reached, or with no base it can name or reach, does not refuse work: the
work call goes on (journalled "resupply unaffordable" or "resupply found no base"), and the next
one resupplies again.
Credits are not a margin: `permissions.credit_reserve` limits what you spend, never makes you Tired.
Tired **widens** what a resupply may do rather
than narrowing where you may go — it lifts the spend margin and drops the fuel reserve to 0. The
fuel reserve is **not** kept back from travel: a trip is flown when the tank covers its route, and a
leg that takes fuel under the reserve is how Tired arrives — the resupply trigger, working as meant.
It never refuses a flight: `goTo` any base you like. Docked anywhere, `service()` (or `rest()`) is
the move: a counter does not need to post a price to refuel or repair. Which base, when you are
out: the suggested moves already carry every price that is readable from here, so take them rather
than re-reading. `inspect` reaches **this system only** —
`account().commands.spacemolt.inspect({id})` on a base in another system throws "You can only
inspect a point of interest in your current system", and an uncaught throw from a raw command breaks
the whole run. For a base outside this system the price is unknown until you dock there, which is no
reason to stay put. Back inside the margins, Tired is gone. Fuel cells are resupply too, so Tired's
"service only" buys them. `permissions.credit_reserve` is a standing bound and Tired does not widen
it. A wallet short of the whole bill buys what fits — the fuel first, then the repair — and
`service()` answers `partial`, naming what it could not buy.

## Goal and stance

`spacemolt_reflect` sets your `goal`, your `stance`, or retires a finished objective
(`objective_done`); each is optional, and none of them is needed to run. The stance picks which
career's README the next juncture carries: with none, you have this README alone.

`reflection()` is the read a script takes to branch on how its runs have gone: what is repeating,
which skills would move, what you hold and owe.

## Rules that will refuse you

- Statically, before the run: an import outside `play`, `play/<folder>` or `@spacemolt/lib`;
  `process`, `fetch`, `eval`, dynamic `import()`; `while(true)`/`for(;;)` without a
  `stopped()` check; `unload_passenger` with id `all`; a file with no `export default async function main`.
- At runtime, inside the helpers: spending under `permissions.credit_reserve`; a route
  the tank cannot cover. Tired is not a work gate: when the runtime's own resupply cannot clear it
  (no base it can name or reach, or credits short), the work goes on and the journal says why.

## Asking yourself a question mid-run

`ask({question, choices?})` pauses the program and hands the question back to you, the
model that started the run; it resolves to your answer. With `choices`, the answer is always
exactly one of them. The run's wall-clock cap still runs while it waits: a question unanswered at
the cap is withdrawn and the run ends `partial`.

```ts
import {ask, goTo, note, outcome} from 'play';

export default async function main() {
  const trip = await goTo('far_belt');
  if (trip.status !== 'done') return trip;
  // A fork the script cannot judge: the author decides, once, and the run carries on.
  const pick = await ask({question: 'Pirates are camping the far belt. Push on or turn home?',
    choices: ['push on', 'turn home']});
  note(`chose to ${pick}`);
  if (pick === 'turn home') return goTo('sol_base');
  return outcome('pushed on past the pirates');
}
```

Ask at a strategic fork, where your judgment is what is missing: which market to commit a hold
to, whether to fight something the numbers say is close. Never ask per tick or per item — every
answer is a model call, which takes minutes, and the game's clock keeps turning while you think.
If a rule could decide it, write the rule.

What you see: `spacemolt_run` returns early, with the lines so far and the question below them.
The protocol, exactly:

- `spacemolt_answer({answer})` resumes the program. That call then blocks like `spacemolt_run`:
  it returns the rest of the run and its report, or the program's next question. An answer that
  is not one of the choices is refused and the program keeps waiting.
- `spacemolt_stop` ends the run instead: `ask` throws the same stop error a stopped run throws,
  the program unwinds (the run ends `partial`), and the call returns the report.
- `spacemolt_run` with a new `source` is refused while a question waits; with no `source`, it
  starts nothing and hands the pending question back.

If your turn ends without an answer, the question waits in the run record, and the next juncture
opens with it.

## When you are stuck

The menu comes to you at every juncture, as the suggested moves, headed by what is repeating
when the cycle repeats (three runs of the same call, two runs not `done`, a run that gained
nothing). Each move is a library call with literal arguments from the present, already passed
through the rules; paste it into `index.ts`. `not now` says what the rules refuse and why.

## Your own helpers

Define a helper as a function inside `pilot/index.ts`, beside `main`, and return an `Outcome`
from it (build one with `outcome(...)`, or return the last library Outcome). The file persists
between junctures, so a helper you wrote is there next time.
