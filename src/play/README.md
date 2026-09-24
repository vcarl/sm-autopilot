# play — how you play SpaceMolt

You are a pilot. You play by writing one file, `pilot/index.ts`, and running it with
`spacemolt_run`, passing the whole file as `source`. It is the only file you can write, and you
cannot read files: this README and your stance's README are the whole reference. The file calls
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
running, so it names a wrong field before a run does. The operator can stop a run at its next
safe point (`partial`); a loop of your own checks `stopped()` to end there too.

## The library is the lib

`account()` is the connected `@spacemolt/lib` `Account`: typed state (`account().ship`,
`.cargo`, `.location`, `.credits`, `.skills`) and every game command as
`account().commands.<tool>.<action>()`. That IS the library; you may call the whole game
through it. The functions here are conveniences for bulk actions, common failures and
precondition checks. `account()` is the escape hatch: reach for the raw command when nothing here
fits, and read its reply before sending the same mutation again.

## The objective

The operator's objective, in your context, governs what you do. When it is open-ended, advance
in general: learn the world, raise your skill levels, gain credits and influence, get a better
ship. `pilot()` returns the record that says what the operator wants (`objective`), what you
chose at your last rest (`goal`, `stance`, `mood`) and your `permissions`. The
operator and your rest write it.

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
`refused` means a real precondition failed: not docked, no counter here, nothing named.
`buy`, `buyShip`, `gatherUntil` and `hunt` act again on every call: two `buy` calls buy twice.

## The root functions (every stage)

| Function | Promise |
|---|---|
| `orient()` | the whole world model in one read: present, skills, storage everywhere, ships, missions, debts |
| `scout(target?)` | POIs of a system (this one by default) with types, stations, resources here, creatures here |
| `goTo(id)` | fly to a POI, base or system, jumping as needed; dock if a base. Any of the three ids works, or a display name: a system id ends the trip anywhere in that system, a POI id at that POI, a base id docked at it — a guess that names a system with a single base goes to that base, and any other word that names nothing is `refused` with the nearest ids instead of being flown. On the way it flies through and completes any active distress mission whose system is on the route or one jump off it, when the detour stays inside a quarter of the route's length and the tank still covers the rest plus the reserve |
| `service()` | full tank and hull, inside the mood's spend margin |
| `stow(rows)` / `withdraw(rows)` / `storage(base?)` | station storage; rows you name (omit a row's `quantity` for all of it); readable from anywhere |
| `prices(items?)` / `sell(rows, opts?)` / `buy(item, qty)` | the market here, live at the moment of the act, and remembered for `spreads()`; `sell(rows, {from:'store'})` empties the store a hold-load at a time |
| `refit({install,remove})` / `shipsForSale(opts?)` / `buyShip(id, opts?)` | the hangar: modules on and off within the grid, the hulls for sale here, the next one |
| `missions()` / `acceptMission(id)` / `completeMissions()` / `abandonMission(id, opts?)` | the board here; the cheapest credits and xp early |
| `note(text)` | write a line into the journal and the run's stream |
| `account()` | the raw `@spacemolt/lib` Account |
| `outcome(did, status?, detail?)` | build an Outcome for a helper of your own; the runtime fills cost, gains and the present |
| `stopped()` | true once `stop` was called; check it in any loop of your own |

`sell`, `stow` and `withdraw` take explicit rows (`[{item_id, quantity}]`, and `{item_id}` with
no `quantity` for all of it — a non-finite `quantity` is refused) and never default to
"everything": you name what you sell. Some career functions are not built yet and throw
`unimplemented`: `survey`, `exploreNearby`, `facilities`, `buildFacility`, `queueJob`, `ships`,
`switchShip`. `account()` reaches those commands.

Everything game-shaped in a `detail` is the lib's own type (`SystemPoi`, `MissionInfo`,
`SellResponse`, `V2Module` …); `tsc` knows the field names.

Careers add more: [`mining/`](mining/README.md) (`gatherUntil`),
[`hauling/`](hauling/README.md), [`industry/`](industry/README.md), [`combat/`](combat/README.md) (`hunt`, `salvage`),
[`trading/`](trading/README.md) (`spreads`, `tradeRun`), [`exploration/`](exploration/README.md), [`fleet/`](fleet/README.md).
Each folder's README is the skill for that career; the one for your stance is loaded beside this.

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

You choose a mood at rest. It sets margins: fuel kept beyond a route, credits a single service
may spend, the hull fraction a fight breaks off at. When fuel, hull or credits fall through the
margin, the runtime imposes **Tired**: the function you are in finishes its safe leg and comes
to a base; nothing new starts; `goTo` accepts only a base (to service there); resupplying back inside
the margins — `service()` here, or at any base — clears Tired and restores the mood it replaced.
You never set or clear Tired yourself. Rest clears everything.

## Rules that will refuse you

- Statically, before the run: an import outside `play`, `play/<folder>` or `@spacemolt/lib`;
  `process`, `fetch`, `eval`, dynamic `import()`; `while(true)`/`for(;;)` without a
  `stopped()` check; `unload_passenger` with id `all`; a file with no `export default async function main`.
- At runtime, inside the helpers: spending under `permissions.credit_reserve`; a route
  without the mood's fuel reserve; starting work under Tired or Relaxed.

## When you are stuck

The menu comes to you at every juncture, as the suggested moves, headed by what is repeating
when the cycle repeats (three runs of the same call, two runs not `done`, a run that gained
nothing). Each move is a library call with literal arguments from the present, already passed
through the rules; paste it into `index.ts`. `not now` says what the rules refuse and why.

## Your own helpers

Define a helper as a function inside `pilot/index.ts`, beside `main`, and return an `Outcome`
from it (build one with `outcome(...)`, or return the last library Outcome). The file persists
between junctures, so a helper you wrote is there next time; rest is where you read how it ran
and rewrite it.
