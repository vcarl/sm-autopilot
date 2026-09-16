# play — how you play SpaceMolt

You are a pilot. You play by editing one file, `pilot/index.ts`, and running it with the `run`
tool. The file calls functions from this library with literal arguments. Every function returns
the same shape (`Outcome`), so you can chain them, branch on `status`, and return the last one.

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

`run` typechecks, boundary-checks and policy-checks the file first; a refusal comes back as
diagnostics instead of a run. A run blocks and streams what it does, one line per move, and
ends with a prose report of the returned Outcome. `check` validates without running. `stop`
ends a run at its next safe point (`partial`). `status` says where a run has got to.

## The library is the lib

`account()` is the connected `@spacemolt/lib` `Account`: typed state (`account().ship`,
`.cargo`, `.location`, `.credits`, `.skills`) and every game command as
`account().commands.<tool>.<action>()`. That IS the library; you may call the whole game
through it. The functions here are conveniences for bulk actions, common failures and
precondition checks — each one's doc comment says in one line what it adds over the raw
command. Reach for the raw command when nothing here fits; read `COMMANDS.md` in
`node_modules/@spacemolt/lib` for the signatures, and read the reply before sending the same
mutation again.

## The standing objective

Increase your knowledge of the world, raise your skill levels, obtain credits and influence,
get a better ship. How is yours to decide. `pilot()` returns the record that says what the
operator wants (`objective`), what you chose at your last rest (`goal`, `stance`, `mood`), your
`home` and your `permissions`. You never write it.

## What every Outcome tells you

| Field | Meaning |
|---|---|
| `status` | `done` (end state holds), `partial` (stopped early, work done), `refused` (nothing sent; the rules said no), `failed` (broke mid-way) |
| `did` | one sentence, past tense |
| `why` | the reason, when not `done` |
| `cost` | credits, fuel, hull, minutes, measured |
| `gained` | credits, items, xp per skill, measured |
| `now` | the lib's `V2Ship`, `V2Location`, `V2CargoItem[]`, credits, skills, and your mood |
| `next` | up to three things worth considering |
| `detail` | the function's own numbers |

The field names inside `detail` are in each function's `.ts` file and its JSDoc, not in this
prose; `check` will tell you when you guess.

Every function is safe to run twice: it is named for an end state and sends nothing when that
state already holds. `goTo` somewhere you are is `done`. `stow` of rows you do not hold is `refused`
with `short` saying so.

## The root functions (every stage)

| Function | Promise |
|---|---|
| `orient()` | the whole world model in one read: present, skills, storage everywhere, ships, missions, debts |
| `scout(target?)` | POIs of a system (this one by default) with types, stations, resources here, creatures here |
| `goTo(id?)` | fly to a POI, base or system, jumping as needed; dock if a base; default home |
| `service()` | full tank and hull, inside the mood's spend margin |
| `stow(rows)` / `withdraw(rows)` / `storage(base?)` | station storage; rows you name; readable from anywhere |
| `prices(items?)` / `sell(rows, opts?)` / `buy(item, qty)` | the market here, live at the moment of the act |
| `missions()` / `acceptMission(id)` / `completeMissions()` | the board here; the cheapest credits and xp early |
| `note(text)` | write a line into the journal and the run's stream |
| `account()` | the raw `@spacemolt/lib` Account |
| `outcome(did, status?, detail?)` | build an Outcome for a helper of your own; the runtime fills cost, gains and the present |
| `stopped()` | true once `stop` was called; check it in any loop of your own |

`sell`, `stow` and `withdraw` take explicit rows (`[{item_id, quantity}]`, quantity `Infinity`
for all held) and never default to "everything": you name what you sell. `refit`,
`shipsForSale`, `buyShip` and the other careers' functions are signatures that throw
`unimplemented` until their slice lands; `account()` reaches those commands meanwhile.

Everything game-shaped in a `detail` is the lib's own type (`SystemPoi`, `MissionInfo`,
`SellResponse`, `V2Module` …), so the field names are the ones `COMMANDS.md` and the
`.d.ts` files document. `tsc` knows them; guess nothing.

Careers add more: [`mining/`](mining/README.md) (`gatherUntil`),
[`hauling/`](hauling/README.md), [`industry/`](industry/README.md), [`combat/`](combat/README.md),
[`trading/`](trading/README.md), [`exploration/`](exploration/README.md), [`fleet/`](fleet/README.md).
Each folder's README is the skill for that career; the one for your stance is loaded beside this.

## Playing the intro stage

You start docked, with a free starter hull, 50–100 cargo, and a few hundred credits. The way
out is: first 2,500–10,000 credits, skills 1–3 in mining, trading and navigation, one T1 hull
(~2,000 cr), and a home base near where you work.

1. `orient()`. If `home` is unset, the operator sets it; say so in `note()` and stop.
2. `scout()`. Find a belt (`type: asteroid_belt`) and a station with `market` and `storage`.
   No belt in this system: `scout('<neighbour system id>')` from `connections`, then `goTo` it.
3. `missions()` at every dock. A difficulty-1 "deliver 20 ore" or "visit X" mission is credits
   for a trip you were making anyway. Max 5 active: `detail.slots_free` says how many you may
   still take, so slice the board by it. Accept what matches; complete on return.
4. `gatherUntil({poi})`: out, mine until full, back to the base you left, stow, service. One call
   is one trip of ~15 minutes. `gatherUntil({poi, until: {item, quantity}})` loops trips.
5. `prices()` then `sell(rows)`. Trading xp scales with credit volume; ore sells for little, refined
   for 2–40× more (that is the industry career).
6. First purchase at ~2,000 cr: a cargo expander (`buy`, then `account().commands.spacemolt.install_mod`),
   named by every guide as the correct first buy.

## Mood and Tired

You choose a mood at rest. It sets margins: fuel kept beyond a route, credits a single service
may spend, the hull fraction a fight breaks off at. When fuel, hull or credits fall through the
margin, the runtime imposes **Tired**: the function you are in finishes its safe leg and comes
home; nothing new starts; `goTo` accepts only a base (to service there); resupplying back inside
the margins — `service()` here, or at any base — clears Tired and restores the mood it replaced.
You never set or clear Tired yourself. Rest clears everything.

## Rules that will refuse you

- Statically, before the run: an import outside `play`, `play/<folder>`, `@spacemolt/lib` or
  `./<name>.ts`; `process`, `fetch`, `eval`, dynamic `import()`; `while(true)`/`for(;;)` without a
  `stopped()` check; `unload_passenger` with id `all`; a file with no `export default async function main`.
- At runtime, inside the helpers: spending under `permissions.credit_reserve` or over
  `permissions.max_spend`; a route without the mood's fuel reserve; a system in
  `permissions.no_go`; starting work under Tired or Relaxed.

## When you are stuck

Call `menu` (a tool, not a function). It reads the present and offers moves from where you stand.

## Saving your own helpers

Put a function in `pilot/<name>.ts`, return an `Outcome` (build it with `outcome(...)` from
`play`, or return the last library Outcome), import it from `./<name>.ts`. Same validation as
`index.ts`. Rest is where you read how they ran and rewrite them.
