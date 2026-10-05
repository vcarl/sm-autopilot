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
with `routes({circuit: {hold}})` (see [Circuits](#circuits-a-lap-a-freighter-repeats)) rather than by hand: every
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
every lap's last, stow cargo still aboard that no stop on the circuit sells, bought or not, but only
until 40% of the hold is free (`FREE_HOLD`, 0.4): the cheapest a unit first (cargo it never bought
counts as 0), whole or part lots, to that free hold exactly, and nothing when it is already that free;
in your storage at that station (`storage.deposit` with `target` your username), or in its own when
yours is refused. The rest rides along in `holding` and is cleared at cost wherever a bid covers it,
at every stop; a big hauler still buys at a profit into 40% of its hold. Each stow is journalled and reported
(`98 copper_piping (cost 2898) at nova_terra_central for <you>`) and kept in `stowed`; the circuit's
own cargo, left unsold under a floor, stays aboard; buy each of the `buys`
in turn, one command each, up to its `qty`, counting what is already aboard, at asks of at most its
`max_price`, within the free hold and the credits over the fuel money; then send home everything
above the float. A circuit assigned before `buys` has one `buy` a stop; it flies as it did, and a
freighter restarted on one picks it up where it was. A stop the
connection drops on is done again a minute later; the why it says then clears once the stop is reached.
A dropped connection (closed socket, or a move whose result never came) is reconnected by the host
first: the lib's own reconnect if it is under way or back within a minute (never a second login on top
of it), else the old socket cut loose (its late close or 4001 is never taken for the new one's) and a
fresh socket and login forced, retried 1 s, 2 s, 4 s … up to 5 minutes apart until it holds. A drop is
never a try and never makes a stop dead; a loop that breaks on one is launched again a minute later,
and one broken by anything else every `REPLAN_TICKS`, its why saying so. Only a session taken by
another login parks it for good: the lib reports a 4001/4002 it will not reconnect through, and the
current connection then fails a status read too; if that read answers, it flies on.
A stop that fails 3 tries in a row (`STOP_TRIES`) is skipped for the lap as a stop with no trade,
the why saying so (`frontier_station: skipped this lap after 3 tries: …`), so no stop holds a
freighter forever. Each flight goes to the system `find_route` names for the base now, not the one
the circuit kept: a mobile station (a Mobile Capital) moves between systems, and one found moved,
or answering "not here right now", is recorded in `mobile.json` for the planner. A sale or buy the game refuses is skipped;
three stops in a row with no trade park it. When those stops traded nothing because cargo the
circuit never sells, that no stop bid its cost for and both stores refused, keeps the free hold under
40%, the why
names that cargo (`hold full of 100 copper_wiring this circuit never sells, no stop on it bids at or
above its cost and storage refused it, so it cannot buy; …`) and the ring is not recorded as drained: its books
were never tried. Its host tries one re-plan (below) for a circuit that sells some of that cargo;
with none, it stays parked with that why, and you assign it a circuit that sells the cargo, or clear
the hold. A route short of fuel, a blocked flight, or no credits
for fuel park it docked where it is. Three laps in a row that net 0 or less park it at the lap's
last stop, the why naming the last lap against the prediction (`3 laps lost money: last -32 vs
predicted 521`); a lap that pays, however far under `lap_net`, flies on. What it stows counts at its
cost as sent home, never as a lap's loss. A parked freighter keeps its cargo aboard, and `freighters()` and the menu show the why.

**Sized on fresh books.** A buy's `qty` and `max_price` are only its outer caps. At each stop,
after the sales, the clear and the stow, the freighter re-plans the rest of the ring with `plan`,
the one planner `routes()` ranks by: the live book here (its asks within each buy's caps), and
for every later stop, round the ring to this one, the freshest book its host knows (only what that
stop sells, bids at or above each `min_price`). Each buy then takes what those later stops absorb
above its cost plus tax, which may be less than `qty`, or nothing. A later stop's book older than
`STALE_TICKS` (180 ticks, 30 minutes) counts at half its depth; older than `IGNORE_TICKS` (1080
ticks, 3 hours), or not known at all, it justifies no buy for a sale there. A cut buy says why
(`sol_base: sized gem to 10 of 83, what the later stops take above cost: range_base's book is 0
ticks old`; `… range_base's book is 1081 ticks old, past 1080: no buy for a sale there`). A stop
that bought less for want of a book is a scouting stop, not a dead one: the lap visits the later
stop, reads and files its book, and the next lap buys on it. A freighter never buys off its circuit.

**Its host's books.** All your freighters fly in your one process, and share what they know. For
each base the host keeps the faction ledger's book (`query_trade_intel` by `base_id`, the whole
book in one call) or your market memory's, whichever is fresher, fetched at most once every
`BOOK_TTL_MS` (60,000 ms) for all of them, and the last live read any freighter made there, which
is always the freshest. Without a faction the ledger is skipped: the memory and the freighters' own
reads carry it, so the first lap on unknown books is a light one. A script reaches them through
`Freighter.market` (a `Market`): `book(base_id)` the freshest `Known` book (`{tick, items}`),
`saw(base_id, known)` a live read, `tick()` the latest tick read, `claimed(base_id, item_id)` the
units other freighters carry there, and `claim(rows)` its own `Claim`s (`{base_id, item_id,
quantity}`). A bare `lap` without `market` sizes by the circuit's caps alone.

**Claims.** Two freighters must not buy for the same bid. The host keeps a claim table by base and
item: after every stop, each freighter's cargo is claimed at the next stop round the ring that
sells it, so a buy claims its units and a sale, stow or clear there releases them. Sizing takes
the other freighters' claims off that stop's bids (`… 10 claimed by other freighters`). Claims live
in the process: on a restart each freighter's are rebuilt from its entry's `holding` and circuit
as its loop starts, and a loop that ends drops its own.

**Each lap is planned before it is flown.** At a lap's start, when every stop's book is younger
than `IGNORE_TICKS`, the host's books plan the lap two laps ahead from the cargo aboard (cargo the
circuit never sells left out: it is cleared or stowed). A plan at 0 or less parks it drained at
once, unflown (`lap planned at 0 on fresh books (two laps ahead); circuit drained`), and it
re-plans itself as below. The fuel is not in that plan; three losing laps remain the backstop.

**Rotation.** Parking on no trade or on losing laps means the ring's books ran dry, and it is
recorded as drained: `routes({circuit})` passes over it for `REST_TICKS` while the books refill
(see [trading](../trading/README.md)). The freighter then rotates itself: its host, in your process,
runs the planner `routes({circuit: {hold}, ...circuit.scope})` is, for its hold and the scope its
circuit was planned in, on the freighter's own connection from where it is docked, and installs the
top row at its float, exactly as `assign` would, and it flies on. `state` reads `waiting` while it
plans. Each auto-reassign is journalled, and counted in `reassigned` with the ring it went onto and
that ring's predicted `lap_net`. It passes over any ring another of your freighters is flying
(`state: 'running'`): two on one ring would split its bids.

When no circuit qualifies, it scouts: `state: 'scouting'`, one hop at a time to the nearest book
nobody has read lately within `SCOUT_JUMPS` (4), the same choice `scoutMarkets()` makes (see
[trading](../trading/README.md#scouting-reading-the-books-nobody-has)). At a base it docks, services,
reads the book, files it to the ledger and remembers it in your `world.db`, lists the system's
bases, and re-plans on what it read; a system never listed it flies to for its bases, then docks at
one. It never buys scouting; cargo aboard that it bought is sold where a bid covers its cost, and
credits over the float go home, as at any stop. A hop that fails three times (`STOP_TRIES`), or cannot be
flown (fuel, a blocked route), is skipped for this wait; each candidate is flown to once a wait. The
`why` reads `scouting <id> (<kind>, <n> jump(s) away); no circuit qualifies: <what routes said>`,
each hop is journalled, and `scouted` counts the books it read. There is no police gate on a hop:
the map carries no police level.

With nothing left to scout it waits docked (a system with no base in it flies back to the base it
last left first), `state: 'waiting'`, the `why` reading `waiting for a circuit: <what routes said>`,
and plans again every `REPLAN_TICKS` (90 ticks, a quarter of `REST_TICKS`, about 15 minutes). Rings
rest out and books refill, so it resumes on its own once one pays. A scouting or waiting freighter
carries on through a restart. A `recall` or a stop after the lap ends scouting after the hop it is
on, and it is never re-planned after either: those are yours.

A hold under 40% free for cargo the circuit never sells, that storage refused, gets one re-plan too, taking the first row that sells
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
stowed there for you down to 40% free, and the `why` says so (from `assign`, below).

`assign` answers at once, with the freighter flying. It is refused while that name is flying:
`recall` it first. Re-assigning a parked one starts it again on the new circuit, its `returned`
and `holding` kept. Cargo aboard that the new circuit never sells is never a refusal; the `why`
says what it is and what becomes of it: `carrying 100 copper_wiring the circuit never sells (100 of
100 hold); it's sold at the first stop if the bid there covers its cost, else stowed there for you
only down to 40% free; the rest rides along and sells at cost where a bid covers it`. A circuit whose every stop's book is older than `IGNORE_TICKS`
is assigned too, and the `why` says `every stop's book is older than 1080 ticks: the first lap buys
only what fresh books justify, a light scouting lap`. Only enough of it to keep the hold under 40% free, that both stores refuse, parks the
freighter, within three stops, as above.

**Recall.** `recall` parks it after the stop it is on, wherever on the circuit that is: it sells
there as usual but buys nothing more, so a recall never strands a fresh load bought for a circuit
it is leaving. Cargo bought before the recall stays aboard; a later `assign` says whether the new
circuit sells it.

**Stop after the lap.** `recall(name, {after: 'lap'})` schedules it to stop at the end of the lap
it is on: it flies the rest of the lap as usual, selling and buying, and parks at the lap's last
stop, `why` `stopped after its lap, as scheduled`. Until then its row carries `stop_after_lap: true`.
A freighter waiting for a circuit stops at once. A plain recall still stops it sooner, after the
stop it is on. Neither is followed by a re-plan, and `assign` or `reassign` clears the schedule.
Freighters earn by themselves, so stopping one is only for when you want it stopped.

`freighters()` answers `detail.freighters`, one row each, and the menu carries the same rows as
`freighters`:

| Field | What it is |
|---|---|
| `name` | the name it was assigned under |
| `state` | `running`; `scouting` (no circuit qualifies: flying to read the nearest unread books, re-planning after each); `waiting` (docked, planning its next circuit or waiting for one to qualify with nothing left to scout, `why` says which); `recalling` (finishing its stop); `parked` (stopped for good, `why` says why) |
| `lap` | laps completed since it was assigned |
| `stop` | the base it is at, or was last at |
| `credits` | its wallet there, after the deposit |
| `returned` | credits it has sent home to you, all told |
| `last_lap_net` | what the last whole lap made: the wallet's change, deposits included, fuel and repairs out, plus the change in `holding`. A load bought and still aboard counts at what it cost, so a lap whose sale did not happen reads its fuel, not the load. `holding` is checked against the hold when a lap starts: cargo sold by hand while it was parked drops out, never counted as a loss |
| `lap_net` | what `routes()` predicted a lap makes. A `last_lap_net` well under it, lap after lap, means the books have moved: recall it and assign the new top row. Three losing laps park it on their own, and it re-plans itself |
| `holding` | the cargo aboard that it bought, `{item: {quantity, cost}}`, `cost` what those units left the wallet for, tax included; a sale or a stow takes units off at their average cost. A parked freighter's `holding` is your capital tied up in its hold. It stays aboard, at its cost, when the freighter is assigned a new circuit, and is sold there if that circuit sells the item; if not, it is sold at cost or better at any stop, or stowed for you at the first stop and at each lap's last, but only down to 40% free. `assign` writes it as last reported, since the freighter's hold is read only by its own loop; the loop checks it against the hold as it starts, before stop 1, and reports it again, so cargo sold by hand while it was parked drops out at once |
| `approach` | `{jumps, credits}`: its last flight onto the circuit's first stop from wherever its loop started (after an assign, a reassign or a restart), fuel and repairs on arrival included. Never part of `last_lap_net`, and never a losing lap. Absent when it started docked at the first stop |
| `stop_after_lap` | `true` while it is scheduled to stop at the end of the lap it is on; absent otherwise |
| `reassigned` | `{count, ring, lap_net}`: how many times it has re-planned itself, and the ring it last went onto (its bases, as `drained.json` keys them) with the `lap_net` predicted for it. Absent until the first; kept across an `assign` |
| `stowed` | every stow, oldest first: `98 copper_piping (cost 2898) at nova_terra_central for <you>`, or `… in its own storage` when yours was refused. What it holds for you, and where; absent until the first; kept across an `assign`. `storage(base)` reads the store there |
| `scouted` | books it read scouting while it had no circuit, all told; absent until the first; kept across an `assign` |
| `why` | why it parked, where it scouts (`scouting …`), why it waits (`waiting for a circuit: …`), or what fell short at the last stop |

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

## Circuits: a lap a freighter repeats

A route need not come back to where it started; one handed to a freighter must, because the
freighter flies it again and again. `routes({circuit: {hold: 50}})` ranks those instead: every row
is a closed lap of 2 to `maxStops` different bases, planned for an **empty** hold of `hold` units
(what is aboard you now is ignored), with at least one buy. The lap is planned into the next one,
so the last stop takes on what the first stop outbids, and the way back pays too. `maxLegJumps`
counts the hop home, and `maxJumps` the whole lap.

A lap is planned three times over and the **middle** lap is the one read: the first starts empty,
and the last has nothing after it to carry for. The lap starts at its first buy, so lap one has
already traded on every book the middle lap reads. It is one plan over one set of books, so what
lap one took is gone for lap two, and the middle lap can sell more than it buys. A lap repeats only
what it both buys and sells, so each item counts `min(sold, bought)` units, sold at its best bids
and bought at its cheapest asks; an item sold with none bought on the lap is carry from lap one and
is not counted. One ring of bases is one row: its rotations rank as the best of them.

**A drained ring rests.** When a freighter parks because its circuit ran dry — three stops in a
row with no trade, or three laps that lost money — its ring of bases (the stops in order, any
rotation) and the game tick are written to `drained.json` in your runtime dir. For `REST_TICKS`
(360 ticks, about an hour; unmeasured, to be tuned once a drained book is watched refilling)
`routes({circuit})` does not plan that ring, and its `did` ends `skipped N ring(s) a freighter
drained within 360 ticks: <ring>; …`. NPC books refill slowly; two laps can empty one. The
freighter rotates itself: its host runs this same search for its hold and scope and flies the top
row, and with none it waits, re-planning every `REPLAN_TICKS` (see
[Freighters](#freighters)). `reassign(name)` runs it for a parked freighter by hand.

**One planner, two seats.** `routes()` is `search(seat, opts)` read through your runtime: your
connection, your live book (remembered and filed), your runtime dir. A freighter's host runs the
same `search` on the freighter's own seat: its connection for the live book where it is docked, the
tax, fuel price and map reads, `find_route` from where it is, and the faction ledger (it is a faction
member); your runtime dir's `world.db`, `places.json` and `drained.json` by path. It never touches
your play runtime, so a freighter re-plans while you fly, and yields to the event loop as yours does.
`search` is the host's, not a pilot call: it is not in `play`.

**A freighter trades by the same planner.** Its circuit's `qty` and `max_price` are caps, not
orders: at each stop it runs `plan` over the live book there and its host's freshest books of the
later stops (the ledger's, read by `base_id` and cached `BOOK_TTL_MS`, your memory's, or a
freighter's own live read), less what the other freighters carry there, a book past `STALE_TICKS`
at half its depth and one past `IGNORE_TICKS` at none, and buys what that plan says. Each lap is
planned first on the same books, and one planning at 0 or less parks drained. A ring ranked on a
17-hour-old book (`TRUST_FLOOR` keeps it in the running) is so flown light until its books are read
fresh (see [Freighters](#freighters)). `ledgerItems(entry)` is how a ledger entry
becomes book rows (`Listing`), for `farBooks` and the host alike.

A circuit row is a `Route` whose numbers are that middle lap's: `legs`, `revenue`, `cost`,
`sales_tax`; `net` is `lap_net`, `total_jumps` is `lap_jumps`, `score` is
`max(confidence, 1/64) × lap_net / max(1, lap_jumps)`, `unsold` is empty. A lap is kept only when every stop
on it trades, `lap_net` is positive and every hop, the last one home included, is on the map. Its
`next` is the call to paste, `assign('freighter', {…}, {float: 20000})` (see
[Freighters](#freighters)), and the lap itself is `circuit`:

| `Circuit` field | What it is |
|---|---|
| `closed` | always `true`: the last stop is followed by the first |
| `hold` | the hold the lap was planned for |
| `lap_jumps` | jumps round the whole lap, the hop from the last stop back to the first included |
| `lap_net` | the middle lap's revenue, less cost, tax and `lap_jumps` of fuel at this base's `fuel_price_all_in` |
| `stops` | in order: `{at, system_id, buys, sell}` |
| `stops[i].at`, `.system_id` | the base and its system |
| `stops[i].buys` | `[{item, qty, max_price}]`: take on up to `qty` units of each `item`, one buy each, at asks of at most `max_price`, the planned average ask plus 10%. A circuit written before `buys` has one `buy: {item, qty, max_price}` instead; it still flies, read as `buys: [buy]` |
| `stops[i].sell` | `[{item, min_price}]`: sell each held `item` at bids of at least `min_price`, the planned average bid less 10%. Nothing else is sold |
| `scope` | `{maxStops, maxLegJumps, maxJumps?}` the lap was planned within: a freighter's own re-plan, and `reassign`, plan the next circuit alike |

## When this pays off

Not before a second hull is worth more than the fuel to reach it. Concretely: a hauler for
freight days and a miner for belt days, parked where each is used. Before that, one hull and
`refit` is the whole fleet.

## Room left for later

`park(shipId, baseId)` (fly a hull somewhere and leave it) and `garage()` (a faction's pooled
ships) are the next functions here; neither is needed in the first three stages.
