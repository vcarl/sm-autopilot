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
| `assign(name, circuit, {float})` | hand a closed circuit to the freighter `name`, which flies it lap after lap on its own account and sends its profit home to you |
| `recall(name)` | bring it home: it finishes the stop it is on, sends its profit, and parks docked with its cargo aboard |
| `freighters()` | every freighter: state, lap, stop, wallet, what it has sent home, the last lap against the prediction, and why it parked |

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

A freighter is another account that does one thing: fly a closed circuit of 2 or 3 bases over
and over, selling and buying at each stop, and sending what it makes home to you. It is a script,
not a player. It has no mood, no juncture, no menu of its own, and it never asks you anything.
It runs inside your own process, so it flies while you do and while you rest.

**The hard rule: only a closed circuit.** A freighter repeats what it is given, so a path that does
not come back to where it started would strand it after one lap. `assign` refuses unless:
`circuit.closed` is `true`; there are 2+ different stops, each a base you have read `prices()` at,
with that base's `system_id`; at least one stop buys; everything the circuit sells is bought
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
only at bids of at least its `min_price`, and nothing that is not listed; buy up to the `buy`
item's `qty`, counting what is already aboard, at asks of at most `max_price`, within the free
hold and the credits over the fuel money; then send home everything above the float. A stop the
connection drops on is done again a minute later. A sale or buy the game refuses is skipped;
three stops in a row with no trade park it. A route short of fuel, a blocked flight, or no credits
for fuel park it docked where it is. A parked freighter keeps its cargo aboard.

`assign` answers at once, with the freighter flying. It is refused while that name is flying:
`recall` it first. Re-assigning a parked one starts it again on the new circuit.

`freighters()` answers `detail.freighters`, one row each, and the menu carries the same rows as
`freighters`:

| Field | What it is |
|---|---|
| `name` | the name it was assigned under |
| `state` | `running`; `recalling` (finishing its stop); `parked` (stopped for good, `why` says why) |
| `lap` | laps completed since it was assigned |
| `stop` | the base it is at, or was last at |
| `credits` | its wallet there, after the deposit |
| `returned` | credits it has sent home to you, all told |
| `last_lap_net` | what the last whole lap made, deposits included, fuel and repairs out |
| `lap_net` | what `routes()` predicted a lap makes. A `last_lap_net` well under it, lap after lap, means the books have moved: recall it and assign the new top row |
| `why` | why it parked, or what fell short at the last stop |

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

## When this pays off

Not before a second hull is worth more than the fuel to reach it. Concretely: a hauler for
freight days and a miner for belt days, parked where each is used. Before that, one hull and
`refit` is the whole fleet.

## Room left for later

`park(shipId, baseId)` (fly a hull somewhere and leave it) and `garage()` (a faction's pooled
ships) are the next functions here; neither is needed in the first three stages.
