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

**Danger is your call.** The map publishes no police level for a system you have never stood in;
what it does name is the empire that claims it (or none), whether it is a stronghold, and how many
pilots are online there. Police, security and pirates are learned on arrival, kept in the runtime,
and shown in the juncture's moves when an objective sends you exploring. `exploreNearby` skips
nothing you do not name in `avoid`: read the facts and choose.

`scout(id)` reads one system (`detail.system.id` and `.name` either way; each `detail.connections` row says `visited`, so a loop can skip systems you have been to); `goTo(id)` flies there and docks if it is a base (or a system with
one base). A circuit of your own is those two in a loop, as below. (`survey()` in mining is not
built yet; `exploreNearby({survey:true})` is the way to a `survey_system` for now.)

**This is not `hunt({look})`, and the two are deliberately apart.** `exploreNearby` visits
**systems** you have never been to and reads each, and trains exploration by the
first visit. `hunt({look})` walks **POIs inside the system you are already in** and fights what it
finds. Reach for `exploreNearby` to learn the neighbourhood; reach for `hunt({look})`
when you know the neighbourhood and want the prey in it.

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
- Fuel out in a system with no station means a distress signal and an hour's wait. `goTo` refuses a
  hop the tank will not cover, and a hop that lands you under the mood's fuel reserve makes you
  Tired. Check every `hop.status` and `pilot().mood`, and stop on the first hop that is not `done`
  or leaves you Tired: that is the circuit turning back, and ignoring it is how a ship strands.
