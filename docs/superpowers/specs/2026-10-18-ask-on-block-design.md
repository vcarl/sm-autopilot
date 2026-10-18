# Ask on block

## Intent

A base behavior that cannot meet its intention because of a **resource constraint** or **outdated data**
pauses the flight with `ask({question, choices})` instead of returning `refused`. Every choice is an
action the library carries out itself; `skip` (or `keep`, for a sale) returns exactly today's Outcome, so
a program that answers `skip` behaves as before apart from the pause.

## The nine situations

| # | call | block | choices (only those executable) | key |
|---|---|---|---|---|
| 1 | `sell` (hold) | no buyer here | `carry to <base>` (best remembered far bid, `bestFarBid`: bid, depth, age) · `keep` | `sell:<item>:no buyer` |
| 2 | `buy` | not on this market | `buy at <base>` (`cheapestAsk`) · `craft <item>` (hand recipe from the catalog, workshop here: `supply` + `craft`) · `skip` | `buy:<item>:not here` |
| 3 | `craft` | inputs short in store | `supply here for <bill> cr` (bill from the market's estimates, `ore_each` shown) · `mine <ores> and craft` (`trace` the short inputs, `gatherUntil` each ore at a belt known to give it, craft the intermediates deepest first) · `skip` | `craft:<recipe>:short` |
| 4 | `refit` | module not in hold or store | `buy <module> here` (estimate here) · `buy <module> at <base>` (`cheapestAsk`) · `craft <module>` · `skip` | `refit:<module>:not held` |
| 5 | `buy` | over `OVERPAY` × cheapest remembered ask elsewhere | `pay <cost> here` · `buy at <base>` (age shown) · `skip` | `buy:<item>:overpay` |
| 6 | `sell` | under caller `floor` | `sell at <bid> now` · `keep` | `sell:<item>:under floor` |
| 7 | `buy` | over caller `maxEach` | `pay <cost> here` · `skip` | `buy:<item>:maxEach` |
| 8 | `withdraw`, `sell({from:'store'})` | no room in the hold | `stow <item> to make room` (the biggest hold row not being withdrawn) · `skip` | `withdraw:<item>:no room`, `sell:<item>:no room` |
| 9 | `goTo` | not enough fuel | `refuel at <base> then go` (undocked at a POI with a base) · `skip` | `goTo:<target>:fuel` |

The question names the facts behind each choice in the library's terse voice; the choices carry the action.

## Stays a plain refusal

`completeMissions` with nothing completable, `acceptMission` not on the board, not docked, no rows named,
no such mission, game-side errors, the credit reserve, an unfittable module, a tank too small for the route.

## Guards

All live in one helper, `askOnBlock` (`src/play/runtime.ts`); every site hands it today's `Said` and its ways.

- **Only the pilot's own call asks** (`run.depth === 1`). The library's inner calls — `tradeRun`'s buys,
  `supply`'s buys, `refit`'s withdraw, and every action run on an answer — refuse as before. This is also the
  recursion guard: "go to the seller and buy there" runs that buy one level down, so it refuses plainly.
- **One ask per situation per flight.** The answer's way id is kept on the run under the key above; the same
  key again in the flight takes that way without pausing (or refuses, when it was `skip` or the way is gone).
  In memory only.
- **Ask unavailable → refuse as today:** a `spacemolt_query`, or a binding with no `onAsk` (nobody can answer).
- **`{ask: false}`** on the call → refuse as today. `refit` takes it on its change object.
- **No executable way → refuse as today**, no pause.
- **A stop while paused** fails the job with `Stopped`, so it ends `partial` as any stop does.

## Calls made

- Choices that need a far base go there with `goTo` and repeat the call there; nothing else is planned.
- `sell({from:'store'})` offers no carry (the goods are in the store, not the hold).
- One block asked about per call: the first row that has a way. The rest stay as today's Outcome says.
- `buy` "craft it" and `refit` "craft it" run `supply` then `craft` here; offered only at a workshop and only
  for a hand recipe. `refit` "buy here" reads the market's estimate first, so it is offered only when one is on sale.
- "Mine and craft" is offered only when every ore under the short inputs has a belt known to give it: one in
  this system's listing whose `resources` names it, or the POI the ship stands at. With no memory of belts
  beyond that, it is rarely offered today.
- `goTo`'s refuel is offered only undocked at a base's POI: docked, the trip already refuels before it flies.
- `make room` stows rather than sells: stowing is the one move every storage counter takes.
