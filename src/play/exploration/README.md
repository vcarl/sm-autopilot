# exploration — the Scout's evening

"I'll go see what is out there." The first visit to a system is the only thing that trains
exploration; every belt, station and price you see feeds every other career's choices. This is 
the evening to have when the same belt is all you know.

## Functions

| Function | Promise |
|---|---|
| `exploreNearby({systems?, jumps?, survey?, avoid?})` | Visit up to `systems` (default 2) unvisited systems, each the nearest one left within `jumps` (default 3) of where the ship now is, and `scout()` each on arrival. `detail.visited` says per system what it found: stations, belts, POI count, police level, security status, pirates at the arrival point. `survey:true` also runs `survey_system` in each. `avoid` is system ids you will not go to or through. `detail.unvisited` is what is left in range, nearest first. Does not come home |

`exploreNearby` flies with `goTo`: a hop the tank will not cover is refused and ends the circuit
(`ended:'refused'`), and a hop that leaves you Tired ends it there (`ended:'tired'`). `ended:'none'`
is nothing unvisited within `jumps` — widen it.

**Danger is your call.** For a system you have never stood in, the map names the empire that
claims it (or none), whether it is a stronghold, and how many pilots are online there; police are
learned on arrival. `exploreNearby` skips nothing you do not name in `avoid`.

`scout(id)` reads one system (`detail.system.id` and `.name` either way; each `detail.connections` row says `visited`, so a loop can skip systems you have been to); `goTo(id)` flies there and docks if it is a base (or a system with
one base). A circuit of your own is those two in a loop, as below.

`survey()` reads hidden POIs in the system you stand in: what it revealed now, what was already
revealed to you, faint signatures it could not resolve, and the `survey_power` and `anomaly_hint`
your fit brought (**Ships and modules** below). A revealed POI is a place like any other: `goTo` it. `exploreNearby({survey:true})` surveys
each system it visits and keeps only the game's message.

```ts
import {survey, goTo} from 'play';

export default async function main() {
  const seen = await survey();
  const hole = seen.detail.newly_revealed.find(poi => poi.type.includes('wormhole'));
  return hole ? goTo(hole.id) : seen;    // at the mouth, get_poi names where it leads
}
```

## Worked example

```ts
import {orient, exploreNearby, goTo, missions, acceptMission, note} from 'play';

export default async function main() {
  const start = await orient();
  const home = start.detail.present.location.docked_at;   // where the circuit returns to

  const board = await missions();
  for (const m of board.detail.board.filter(m => m.fits === 'goTo').slice(0, board.detail.slots_free))
    await acceptMission(m.mission_id);                    // "visit N stations" pays for the trip

  // Three first visits, skipping a system you already know you do not want to fly through.
  const trip = await exploreNearby({systems: 3, avoid: ['the_badlands']});
  for (const row of trip.detail.visited)
    note(`${row.name}: ${row.stations.length} station(s), police ${row.police ?? '?'}, ${row.pirates ?? 0} pirates`);
  if (trip.detail.ended === 'tired') return trip;         // the circuit turned back; service next

  if (home) return goTo(home);
  return trip;
}
```

## Ships and modules

A jump takes 7 − speed ticks (at least 1). Survey power is the fitted survey scanners plus the
hull's built-in survey, +1% per `scanning` level. Flying a T2 hull needs `piloting` 10, a T3 needs 20.
Each empire builds its own; `shipsForSale()` lists what a yard sells.

| Hull | Empire | Tier | cr | Speed | Fuel | Cargo | Utility | For a scout |
|---|---|---|---|---|---|---|---|---|
| `lemma` | solarian | 1 | 2,400 | 5 | 170 | 25 | 3 | survey 15 built in, `ship_scanner_i` fitted, unarmed |
| `warranty_void` | outerrim | 1 | 2,000 | 5 | 220 | 40 | 2 | survey 8 built in, 25% less fuel, `afterburner_i` fitted |
| `qualia` | voidborn | 1 | 3,000 | 3 | 130 | 30 | 3 | survey 15 built in, `cloaking_device_i` fitted |
| `venture` | nebula | 1 | 2,800 | 3 | 180 | 80 | 2 | survey 10 built in |
| `prospectus` | nebula | 2 | 7,500 | 5 | 450 | 80 | 3 | `survey_scanner_i` fitted |
| `solarian_foundation` | solarian | 2 | 6,800 | 3 | 260 | 90 | 3 | 25% less fuel, `survey_scanner_i` fitted |
| `hypothesis` | solarian | 2 | 10,000 | 3 | 360 | 135 | 4 | `survey_scanner_i` fitted |
| `confluence` | voidborn | 2 | 11,000 | 3 | 360 | 120 | 4 | `survey_scanner_i` fitted |
| `perigee` | solarian | 3 | 42,000 | 2 | 620 | 270 | 6 | survey 30 built in, `anomaly_detector` fitted |

A starter hull has speed 1–2 and fuel 90–130. Every empire has a T3 explorer at 38,000–42,000 cr
with an `anomaly_detector` fitted.

| Module | cr | What it does |
|---|---|---|
| `survey_scanner_i` | 4,400 | survey 30. With no survey power and no anomaly detector, `survey()` is refused |
| `survey_scanner_ii` | 14,000 | survey 60, and rare ores |
| `anomaly_detector` | 20,000 | each `survey()` reveals this system's wormholes, and `anomaly_hint` points to one within 5 jumps. No ore on its own. CPU 15, power 25 |
| `afterburner_i` / `_ii` | 1,100 / 2,300 | +1 / +2 speed, at 25% / 60% more fuel a move |
| `fuel_optimizer` | 800 | 15% less fuel a move |
| `expanded_fuel_tank` | 950 | +100 fuel, −20 hull |

## What a safe circuit looks like

- Three unvisited systems on a loop that ends where it started, the whole loop above the mood's fuel reserve (under it is Tired, and the circuit ends).
- At least one station on the loop: a market to read, a board to accept from, fuel to buy.
- Police above 0 on the legs you already know (`scout()` names what was seen), and for the legs you do not, a mood that accepts not knowing.

## When to reconsider

- `ended` is `'none'`: nothing unvisited within `jumps`; widen it (`detail.unvisited` is what is left in range), or work from a station further out.
- A visited system had a rich belt and a station with storage: that is a base worth working from.

## Pitfalls

- A jump that reports failure has often succeeded. `goTo` reads before it trusts; do not
  re-send jumps by hand.
- In a circuit of your own, stop on the first `goTo` that is not `done` or leaves `pilot().mood`
  Tired: that is the circuit turning back, and ignoring it is how a ship strands.
