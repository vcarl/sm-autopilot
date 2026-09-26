# fleet — more than one hull

Five different things get called "fleet". Keep them apart:

1. **Owning several ships** (this folder). One character flies one; the others are parked,
   safe from your death, and swapped at a shipyard. A fleet is a set of tools at chosen nodes:
   a hauler at the market hub, a miner at the belt, a fighter at home.
2. **`spacemolt_fleet`**: a party of separate players for coordinated travel and combat. Not
   wrapped here.
3. **Crew and marines**: a supply-chain problem from tier-2 scale-3 hulls up (`minimum_crew`
   50+). `buyShip` recruits to minimum; nothing else here manages crew yet.
4. **Alts**: several characters, each its own account, is the only way several ships fly at
   once. An alt with a mind of its own is a runtime of its own: one process, one `pilot.json`.
   An alt that only hauls is a **freighter** (below): it flies from *your* process, on its own
   account, repeating one circuit, with no pilot, no juncture and no `pilot.json`.
5. **Factions**: a shared garage and treasury. Advanced stage; not wrapped.

## Functions

| Function | Promise |
|---|---|
| `ships()` | **not built yet — it throws `unimplemented`.** `account().commands.spacemolt_ship.list_ships()` |
| `switchShip(id)` | **not built yet — it throws `unimplemented`.** `account().commands.spacemolt_ship.switch_ship({id})`, and stow and service by hand first |
| `assign(name, circuit, {float})` | hand a closed circuit to the freighter `name`, which flies it lap after lap on its own account, sends its profit home to you, and re-plans itself when the circuit drains |
| `reassign(name)` | by hand, put a parked freighter on the best circuit now: `routes({circuit: {hold}, ...circuit.scope})` for its hold and the scope its circuit was planned in, past the rings resting, then `assign` of the top row at its float |
| `recall(name)` | bring it home: it finishes the stop it is on (selling, but buying nothing), sends its profit, and parks docked with its cargo aboard |
| `recall(name, {after: 'lap'})` | stop it after the lap it is on: it finishes the lap, selling and buying as usual, and parks at the lap's last stop |
| `freighters()` | every freighter: state, lap, stop, wallet, what it has sent home, the last lap against the prediction, the cargo aboard at cost, a stop after the lap scheduled, its auto-reassigns, and why it parked or waits |

## Worked example

```ts
import {orient, ships, goTo, switchShip, gatherUntil} from 'play';

export default async function main() {
  await orient();
  const mine = await ships();
  const miner = mine.detail.parked.find(s => s.class_id === 'archimedes' && s.shipyard);
  if (!miner) return mine;                                   // nothing to switch to
  await goTo(miner.base_id);
  const sw = await switchShip(miner.ship_id);
  if (sw.status !== 'done') return sw;
  return gatherUntil({poi: 'unknown_edge_mineral_fields'});
}
```

## Freighters

A freighter is another account that does one thing: fly a closed circuit of 2 or more bases over
and over, selling and buying at each stop, and sending what it makes home to you. It is a script,
not a player. It has no mood, no juncture, no menu of its own, and it never asks you anything.
It runs inside your own process, so it flies while you do and while you rest.

**The hard rule: only a closed circuit.** A freighter repeats what it is given, so a path that does
not come back to where it started would strand it after one lap. `assign` refuses unless:
`circuit.closed` is `true`; there are 2+ different stops, each a base whose book you know — read
there yourself or filed on the faction ledger, as `routes()` reads them — with that base's
`system_id`; at least one stop buys; everything the circuit sells is bought
somewhere on it; and every hop, the last stop back to the first included, is on the map. Build one
with `routes({circuit: {hold}})` (see [trading](../trading/README.md)) rather than by hand: every
row it returns passes, and its `next` is the `assign(...)` call to paste.

**The money.** The freighter keeps `float` credits aboard to trade with, at most `FLOAT_MAX`
(30,000). At every stop, after it trades, everything above the float is deposited to you
(`storage.deposit` to your username). It never spends the last 2,000 credits on cargo, so it can
always buy fuel.

**Its login.** The operator puts the freighter account's credentials file at
`freighters/<name>.txt` in your runtime directory, as `Username: …` and `Password: …` lines. You
cannot read or write it; `assign` is refused until it is there. The account must not be flown by
anything else: a second login takes the session, and the freighter then parks for good.

At each stop, in order: fly there and dock; refuel and repair; sell each `sell` item held, but
only at bids of at least its `min_price`; sell cargo it bought that the circuit never sells (left
from an old circuit, in `holding`), but only the units bid at or above what they cost a unit, so
never at a loss, the sale journalled and reported (`cleared 98 copper_piping at 36 (cost 29.6)`);
cargo it never bought, whose cost is unknown, is never sold; at a new circuit's first stop and at
every lap's last, stow whatever is still aboard that no stop on the circuit sells, bought or not, in
your storage at that station (`storage.deposit` with `target` your username), or in its own when
yours is refused, so every lap buys into the whole hold, journalled and reported
(`98 copper_piping (cost 2898) at nova_terra_central for <you>`) and kept in `stowed`; the circuit's
own cargo, left unsold under a floor, stays aboard; buy each of the `buys`
in turn, one command each, up to its `qty`, counting what is already aboard, at asks of at most its
`max_price`, within the free hold and the credits over the fuel money; then send home everything
above the float. A circuit assigned before `buys` has one `buy` a stop; it flies as it did, and a
freighter restarted on one picks it up where it was. A stop the
connection drops on is done again a minute later; the why it says then clears once the stop is reached.
A stop that fails 3 tries in a row (`STOP_TRIES`) is skipped for the lap as a stop with no trade,
the why saying so (`frontier_station: skipped this lap after 3 tries: …`), so no stop holds a
freighter forever. Each flight goes to the system `find_route` names for the base now, not the one
the circuit kept: a mobile station (a Mobile Capital) moves between systems, and one found moved,
or answering "not here right now", is recorded in `mobile.json` for the planner. A sale or buy the game refuses is skipped;
three stops in a row with no trade park it. When those stops traded nothing because the hold is
full of cargo the circuit never sells that no stop bid its cost for and both stores refused, the why
names that cargo (`hold full of 100 copper_wiring this circuit never sells, no stop on it bids at or
above its cost and storage refused it, so it cannot buy; …`) and the ring is not recorded as drained: its books
were never tried. Its host tries one re-plan (below) for a circuit that sells some of that cargo;
with none, it stays parked with that why, and you assign it a circuit that sells the cargo, or clear
the hold. A route short of fuel, a blocked flight, or no credits
for fuel park it docked where it is. Three laps in a row that net 0 or less park it at the lap's
last stop, the why naming the last lap against the prediction (`3 laps lost money: last -32 vs
predicted 521`); a lap that pays, however far under `lap_net`, flies on. What it stows counts at its
cost as sent home, never as a lap's loss. A parked freighter keeps its cargo aboard, and `freighters()` and the menu show the why.

**Rotation.** Parking on no trade or on losing laps means the ring's books ran dry, and it is
recorded as drained: `routes({circuit})` passes over it for `REST_TICKS` while the books refill
(see [trading](../trading/README.md)). The freighter then rotates itself: its host, in your process,
runs the planner `routes({circuit: {hold}, ...circuit.scope})` is, for its hold and the scope its
circuit was planned in, on the freighter's own connection from where it is docked, and installs the
top row at its float, exactly as `assign` would, and it flies on. `state` reads `waiting` while it
plans. Each auto-reassign is journalled, and counted in `reassigned` with the ring it went onto and
that ring's predicted `lap_net`.

When no circuit qualifies, it does not spin: it waits docked, `state: 'waiting'`, the `why` reading
`waiting for a circuit: <what routes said>`, and plans again every `REPLAN_TICKS` (90 ticks, a
quarter of `REST_TICKS`, about 15 minutes). Rings rest out and books refill, so it resumes on its own
once one pays. A waiting freighter waits on through a restart. It is never re-planned after a
`recall` or a stop after the lap: those are yours.

A hold full of cargo the circuit never sells, that storage refused, gets one re-plan too, taking the first row that sells
some of it. Circuits are planned for an empty hold, so there seldom is one; with none, it stays
parked with the blocking why and is not tried again. Preferring a ring through a base whose
remembered bid covers the cargo's cost, or planning the first lap from the cargo aboard, would clear
it; that is not built.

`reassign(name)` is the same rotation by hand, for a freighter that is parked. It runs `routes({circuit: {hold}, ...circuit.scope})` for that freighter's hold, in the
scope its circuit was planned in (`maxStops`, `maxLegJumps`, `maxJumps`; the defaults for a circuit
assigned before `scope`), and `assign`s it the
top row at the float it had. It is refused when no circuit pays (the `why` carries what `routes`
said, rings skipped included), when you are not docked (`routes` reads the book here), and
wherever `assign` refuses. Its cargo rides into the new circuit at its cost and is sold there if
the new circuit sells it; the rest is sold at the first stop if the bid covers its cost, else
stowed there for you, and the `why` says so (from `assign`, below).

`assign` answers at once, with the freighter flying. It is refused while that name is flying:
`recall` it first. Re-assigning a parked one starts it again on the new circuit, its `returned`
and `holding` kept. Cargo aboard that the new circuit never sells is never a refusal; the `why`
says what it is and what becomes of it: `carrying 100 copper_wiring the circuit never sells (100 of
100 hold); it's sold at the first stop if the bid there covers its cost, else stowed there for you,
so lap 1 buys into the whole 100`. Only a full hold of it that both stores refuse parks the
freighter, within three stops, as above.

**Recall.** `recall` parks it after the stop it is on, wherever on the circuit that is: it sells
there as usual but buys nothing more, so a recall never strands a fresh load bought for a circuit
it is leaving. Cargo bought before the recall stays aboard; a later `assign` says whether the new
circuit sells it.

**Stop after the lap.** `recall(name, {after: 'lap'})` schedules it to stop at the end of the lap
it is on: it flies the rest of the lap as usual, selling and buying, and parks at the lap's last
stop, `why` `stopped after its lap, as scheduled`. Until then its row carries `stop_after_lap: true`.
A freighter waiting for a circuit stops at once. A plain recall still stops it sooner, after the
stop it is on. Neither is followed by a re-plan, and `assign` or `reassign` clears the schedule. The
menu keeps it as a `Not now` line while freighters fly: they earn by themselves, so stopping one is
only for when you want it stopped.

`freighters()` answers `detail.freighters`, one row each, and the menu carries the same rows as
`freighters`:

| Field | What it is |
|---|---|
| `name` | the name it was assigned under |
| `state` | `running`; `waiting` (docked, planning its next circuit or waiting for one to qualify, `why` says which); `recalling` (finishing its stop); `parked` (stopped for good, `why` says why) |
| `lap` | laps completed since it was assigned |
| `stop` | the base it is at, or was last at |
| `credits` | its wallet there, after the deposit |
| `returned` | credits it has sent home to you, all told |
| `last_lap_net` | what the last whole lap made: the wallet's change, deposits included, fuel and repairs out, plus the change in `holding`. A load bought and still aboard counts at what it cost, so a lap whose sale did not happen reads its fuel, not the load. `holding` is checked against the hold when a lap starts: cargo sold by hand while it was parked drops out, never counted as a loss |
| `lap_net` | what `routes()` predicted a lap makes. A `last_lap_net` well under it, lap after lap, means the books have moved: recall it and assign the new top row. Three losing laps park it on their own, and it re-plans itself |
| `holding` | the cargo aboard that it bought, `{item: {quantity, cost}}`, `cost` what those units left the wallet for, tax included; a sale or a stow takes units off at their average cost. A parked freighter's `holding` is your capital tied up in its hold. It stays aboard, at its cost, when the freighter is assigned a new circuit, and is sold there if that circuit sells the item; if not, it is sold at the first stop at cost or better, or stowed there for you. `assign` writes it as last reported, since the freighter's hold is read only by its own loop; the loop checks it against the hold as it starts, before stop 1, and reports it again, so cargo sold by hand while it was parked drops out at once |
| `approach` | `{jumps, credits}`: its last flight onto the circuit's first stop from wherever its loop started (after an assign, a reassign or a restart), fuel and repairs on arrival included. Never part of `last_lap_net`, and never a losing lap. Absent when it started docked at the first stop |
| `stop_after_lap` | `true` while it is scheduled to stop at the end of the lap it is on; absent otherwise |
| `reassigned` | `{count, ring, lap_net}`: how many times it has re-planned itself, and the ring it last went onto (its bases, as `drained.json` keys them) with the `lap_net` predicted for it. Absent until the first; kept across an `assign` |
| `stowed` | every stow, oldest first: `98 copper_piping (cost 2898) at nova_terra_central for <you>`, or `… in its own storage` when yours was refused. What it holds for you, and where; absent until the first; kept across an `assign`. `storage(base)` reads the store there; the menu offers it only while you are docked at that base |
| `why` | why it parked, why it waits (`waiting for a circuit: …`), or what fell short at the last stop |

```ts
import {orient, routes, assign, note} from 'play';

export default async function main() {
  await orient();
  const look = await routes({circuit: {hold: 50}});          // closed laps for a 50-unit hold
  const best = look.detail.routes[0];
  if (!best?.circuit) return look;                           // no lap pays over the books known
  note(`${best.circuit.stops.map(stop => stop.at).join(' → ')} → back: ${best.circuit.lap_net} cr a lap`);
  return assign('hauler', best.circuit, {float: 20000});     // freighters/hauler.txt must be there
}
```

```ts
import {freighters, recall} from 'play';

export default async function main() {
  const fleet = await freighters();
  const busy = fleet.detail.freighters.find(row => row.state === 'running' && !row.stop_after_lap);
  if (!busy) return fleet;
  return recall(busy.name, {after: 'lap'});                  // finishes the lap it is on, then parks
}
```

## When this pays off

Not before a second hull is worth more than the fuel to reach it. Concretely: a hauler for
freight days and a miner for belt days, parked where each is used. Before that, one hull and
`refit` is the whole fleet.

## Room left for later

`park(shipId, baseId)` (fly a hull somewhere and leave it) and `garage()` (a faction's pooled
ships) are the next functions here; neither is needed in the first three stages.
